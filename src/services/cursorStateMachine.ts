import * as vscode from 'vscode';
import { LineRange } from '../rpc/cursor-tab_pb';
import { withRetry } from './retry';
import { buildStreamRequest } from '../context/requestBuilder';
import {
  IDocumentTracker,
  IRpcClient,
  ILogger,
  IConfigService,
  IFileSyncCoordinator,
  ICursorPredictionController,
  IDebounceManager,
  IRecentFilesTracker,
  ITelemetryService,
  ILspSuggestionsTracker,
  IWorkspaceStorage,
} from '../context/contracts';
import { CursorFeatureFlags, TriggerSource } from '../context/types';
import { CursorPredictionController } from '../controllers/cursorPredictionController';
import { CppHeuristicsService, CppValidationResult } from './cppHeuristics';
import { InlineEditTriggerer } from './inlineEditTriggerer';

export interface SuggestionContext {
  readonly document: vscode.TextDocument;
  readonly position: vscode.Position;
  readonly token: vscode.CancellationToken;
  readonly requestUuid?: string;
  // Proposed API timing fields
  readonly requestIssuedDateTime?: number;
  readonly earliestShownDateTime?: number;
  // Proposed API: userPrompt from context (optional user instruction)
  readonly userPrompt?: string;
  // Trigger source for telemetry - derived from VS Code InlineCompletionTriggerKind
  readonly triggerSource?: TriggerSource;
  // VS Code's InlineCompletionTriggerKind - Invoke (0) = manual, Automatic (1) = while typing
  readonly triggerKind?: vscode.InlineCompletionTriggerKind;
}

export interface SuggestionResult {
  readonly text: string;
  readonly range: vscode.Range;
  readonly requestId: string;
  readonly bindingId?: string;
  readonly lineRange?: LineRange;
  readonly displayLocation?: vscode.InlineCompletionDisplayLocation;
  // True if this is a multi-line edit that replaces existing content
  readonly isInlineEdit?: boolean;
  // Proposed API: showRange - cursor position range for when the suggestion can be displayed
  readonly showRange?: vscode.Range;
  // For cross-file cursor prediction, contains the target file info
  readonly cursorPredictionTarget?: CursorPredictionTargetInfo;
  // If true, this suggestion is just a cursor jump hint (no actual code edit)
  readonly isCursorJumpHint?: boolean;
  // If set, indicates there's a next edit to show after this one is accepted
  readonly nextEditActionId?: string;
}

export interface CursorPredictionTargetInfo {
  readonly relativePath: string;
  readonly lineNumberOneIndexed: number;
  readonly expectedContent?: string;
  readonly shouldRetriggerCpp?: boolean;
}

interface RawSuggestion extends Omit<SuggestionResult, 'requestId'> {}

/**
 * Cursor prediction modes - similar to vscode-copilot's NextCursorLinePrediction
 */
export enum CursorPredictionMode {
  /** Just show the prediction location, user can jump */
  Jump = 'jump',
  /** Show prediction only when there's also an edit */
  OnlyWithEdit = 'onlyWithEdit',
  /** Show a label for the prediction location */
  LabelOnlyWithEdit = 'labelOnlyWithEdit',
}

/**
 * Model info returned from server - similar to Cursor's ModelInfo
 */
export interface ModelInfo {
  readonly isFusedCursorPredictionModel: boolean;
  readonly isMultidiffModel: boolean;
  readonly modelName?: string;
}

const DEFAULT_MODEL_INFO: ModelInfo = {
  isFusedCursorPredictionModel: true,
  isMultidiffModel: true,
};

interface FollowupSession {
  readonly document: vscode.Uri;
  readonly queue: RawSuggestion[];
  /** Document version when followups were cached - used to detect stale cache */
  documentVersion?: number;
}

/**
 * Cached suggestion entry - similar to Cursor's this.O cache
 * Used to cache suggestions when they can't be displayed immediately
 */
interface CachedSuggestion {
  readonly suggestion: SuggestionResult;
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly timestamp: number;
}

interface BindingEntry {
  readonly requestId: string;
  readonly document: vscode.Uri;
}

/**
 * Next action types - similar to Cursor's eb cache
 * Stores what to do when a suggestion is accepted
 */
type NextActionType = 
  | { action: 'nextEdit' }
  | { action: 'fusedCursorPrediction'; target: CursorPredictionTargetInfo };

interface NextActionEntry {
  readonly type: NextActionType;
  readonly requestId: string;
  readonly originalText?: string;
  readonly replaceText?: string;
}

// Fallback max streams - also handled by DebounceManager with same default
// Cursor uses 6 concurrent streams (jc = 6)
const MAX_CONCURRENT_STREAMS = 6;

export class CursorStateMachine implements vscode.Disposable {
  private readonly activeStreams = new Map<string, AbortController>();
  private readonly bindingCache = new Map<string, BindingEntry>();
  private readonly requestBindings = new Map<string, Set<string>>();
  private readonly followups = new Map<string, FollowupSession>();
  /** Next action cache - similar to Cursor's eb cache for tracking what to do after accept */
  private readonly nextActionCache = new Map<string, NextActionEntry>();
  /** Suggestion cache - similar to Cursor's this.O cache for storing suggestions when they can't be displayed immediately */
  private readonly suggestionCache: CachedSuggestion[] = [];
  private readonly maxCachedSuggestions = 5;
  /** Pending next action when cache miss occurs */
  private pendingNextAction?: {
    uri: vscode.Uri;
    nextActionId: string;
    oldText: string;
    newText: string;
  };
  private requestSeed = 0;
  private flags: CursorFeatureFlags;
  private lastAcceptedRequestId: string | undefined;
  /** Track requestIds that were accepted via item.command to avoid duplicate telemetry */
  private readonly acceptedViaCommand = new Set<string>();
  
  /** Track requestIds that were superseded by newer requests (should complete but cache results) */
  private readonly supersededRequests = new Set<string>();
  // Track current active request per document to ignore stale responses (like Cursor's this.db pattern)
  private currentRequestByDocument = new Map<string, string>();
  
  /** Model info from last successful response */
  private currentModelInfo: ModelInfo = DEFAULT_MODEL_INFO;
  
  /** Heuristics service for validation and cursor prediction suppression */
  private readonly heuristics: CppHeuristicsService;
  
  /** Inline edit triggerer for auto-triggering suggestions */
  private readonly inlineEditTriggerer: InlineEditTriggerer;
  
  /** Pending trigger source from InlineEditTriggerer - used when VS Code calls provideInlineCompletionItems */
  private pendingTriggerSource?: TriggerSource;
  private pendingTriggerTimestamp = 0;
  private readonly pendingTriggerMaxAgeMs = 500; // Max age for pending trigger
  
  /** Event emitter for notifying provider when cached suggestions are available */
  private readonly _onSuggestionCached = new vscode.EventEmitter<void>();
  readonly onSuggestionCached = this._onSuggestionCached.event;

  constructor(
    private readonly tracker: IDocumentTracker,
    private readonly rpc: IRpcClient,
    private readonly logger: ILogger,
    private readonly config: IConfigService,
    private readonly fileSync: IFileSyncCoordinator,
    private readonly cursorPrediction: ICursorPredictionController,
    // New services for enhanced functionality
    private readonly debounceManager?: IDebounceManager,
    private readonly recentFilesTracker?: IRecentFilesTracker,
    private readonly telemetryService?: ITelemetryService,
    private readonly lspSuggestionsTracker?: ILspSuggestionsTracker,
    // Workspace storage for persisting workspaceId and controlToken
    private readonly workspaceStorage?: IWorkspaceStorage,
  ) {
    this.flags = config.flags;
    config.onDidChange((next) => (this.flags = next));
    
    // Initialize heuristics service
    this.heuristics = new CppHeuristicsService(logger);
    
    // Initialize inline edit triggerer
    this.inlineEditTriggerer = new InlineEditTriggerer(logger);
    
    // Wire up InlineEditTriggerer to store pending trigger source
    this.inlineEditTriggerer.onTrigger(({ triggerSource }) => {
      this.pendingTriggerSource = triggerSource;
      this.pendingTriggerTimestamp = Date.now();
    });
    
    // Listen to cursor movement to clear prediction flag
    vscode.window.onDidChangeTextEditorSelection(() => {
      this.heuristics.clearPredictionCursorMoveFlag();
    });
  }

  dispose(): void {
    for (const controller of this.activeStreams.values()) {
      controller.abort();
    }
    this.activeStreams.clear();
    this.followups.clear();
    this.nextActionCache.clear();
    this.currentRequestByDocument.clear();
    this.supersededRequests.clear();
    this.acceptedViaCommand.clear();
    this.pendingNextAction = undefined;
    this.heuristics.dispose();
    this.inlineEditTriggerer.dispose();
    this.suggestionCache.length = 0;
    this._onSuggestionCached.dispose();
  }

  /**
   * Add a suggestion to the cache - similar to Cursor's this.O.addSuggestion
   */
  private addToSuggestionCache(
    suggestion: SuggestionResult,
    documentUri: string,
    documentVersion: number
  ): void {
    this.suggestionCache.push({
      suggestion,
      documentUri,
      documentVersion,
      timestamp: Date.now(),
    });
    
    // Keep cache size bounded
    while (this.suggestionCache.length > this.maxCachedSuggestions) {
      this.suggestionCache.shift();
    }
    
    this.logger.info(`[Cpp] Added suggestion to cache (size: ${this.suggestionCache.length})`);
    
    // Notify provider that a cached suggestion is available
    // This triggers VS Code to re-request completions, which will hit the cache
    this._onSuggestionCached.fire();
  }

  /**
   * Try to get a cached suggestion for the document - similar to Cursor's this.O.popCacheHit
   * Returns the most recent matching suggestion and removes it from cache
   */
  private popCachedSuggestion(documentUri: string, documentVersion: number): SuggestionResult | null {
    // Find most recent matching suggestion (same document, version not too old)
    // Allow version difference of 3 to handle rapid edits and linter triggers
    const maxVersionDiff = 3;
    for (let i = this.suggestionCache.length - 1; i >= 0; i--) {
      const cached = this.suggestionCache[i];
      const versionDiff = documentVersion - cached.documentVersion;
      if (cached.documentUri === documentUri && versionDiff <= maxVersionDiff && versionDiff >= 0) {
        // Remove from cache
        this.suggestionCache.splice(i, 1);
        this.logger.info(`[Cpp] ✅ Cache hit! Using cached suggestion (versionDiff=${versionDiff}, cache size: ${this.suggestionCache.length})`);
        return cached.suggestion;
      }
    }
    // Log cache miss details for debugging
    if (this.suggestionCache.length > 0) {
      const matching = this.suggestionCache.filter(c => c.documentUri === documentUri);
      if (matching.length > 0) {
        this.logger.info(`[Cpp] ❌ Cache miss: found ${matching.length} cached for doc but version mismatch (current=${documentVersion}, cached=${matching.map(c => c.documentVersion).join(',')})`);
      }
    }
    return null;
  }

  /**
   * Clear cached suggestions for a document (e.g., when document changes significantly)
   */
  private clearSuggestionCache(documentUri?: string): void {
    if (documentUri) {
      const before = this.suggestionCache.length;
      this.suggestionCache.splice(0, this.suggestionCache.length, 
        ...this.suggestionCache.filter(c => c.documentUri !== documentUri));
      if (before !== this.suggestionCache.length) {
        this.logger.info(`[Cpp] Cleared ${before - this.suggestionCache.length} cached suggestion(s) for ${documentUri}`);
      }
    } else {
      this.suggestionCache.length = 0;
    }
  }

  async requestSuggestion(ctx: SuggestionContext): Promise<SuggestionResult | null> {
    if (!this.flags.enableInlineSuggestions || !this.isEligible(ctx)) {
      return null;
    }

    const docKey = ctx.document.uri.toString();
    
    // PRIORITY 1: Check for cached followup edits from previous multidiff stream
    // Followup edits take priority because they are the "next edit" the user expects after accepting
    // This must be checked BEFORE suggestion cache to avoid superseded requests stealing the slot
    const followupSession = this.followups.get(docKey);
    if (followupSession && followupSession.queue.length > 0) {
      // IMPORTANT: Invalidate cached followups if document version changed
      // The cached line numbers are based on the original document and become stale after ANY edit
      const versionDiff = ctx.document.version - (followupSession.documentVersion ?? 0);
      
      // Only use followup when document hasn't changed much (versionDiff <= 1)
      // After accepting an edit, version increases by 1, so we allow that
      if (versionDiff > 1) {
        this.logger.info(`[Cpp] 📦 Clearing stale followup cache (versionDiff=${versionDiff}, cached=${followupSession.queue.length})`);
        this.followups.delete(docKey);
        // Also clear suggestion cache for this document since followups are stale
        this.clearSuggestionCache(docKey);
      } else {
        const nextEdit = followupSession.queue.shift();
        if (nextEdit) {
          this.logger.info(`[Cpp] 📦 Using cached followup edit (${followupSession.queue.length} remaining, versionDiff=${versionDiff})`);
          
          // Clear suggestion cache to avoid stale suggestions being used after followup
          this.clearSuggestionCache(docKey);
          
          // IMPORTANT: Clear ALL remaining followups after using one
          // Because once this edit is accepted, the document structure changes
          // and the remaining cached line numbers become invalid
          this.logger.info(`[Cpp] 📦 Clearing remaining ${followupSession.queue.length} followups (line numbers will be stale after accept)`);
          this.followups.delete(docKey);
          
          // Generate a request ID for this cached edit
          const cachedRequestId = `cached-${Date.now()}-${this.requestSeed++}`;
          
          return {
            ...nextEdit,
            requestId: cachedRequestId,
            // No nextEditActionId - we're clearing the cache, so no more cached followups
            // A new request will be needed for subsequent edits
          };
        }
      }
    }
    
    // PRIORITY 2: Check suggestion cache - for superseded requests that completed
    // This is checked AFTER followup cache to ensure next edits take priority
    const cachedSuggestion = this.popCachedSuggestion(docKey, ctx.document.version);
    if (cachedSuggestion) {
      this.logger.info(`[Cpp] Using cached suggestion instead of making new request`);
      return cachedSuggestion;
    }

    // Use debounce manager if available
    let requestId: string;
    let abortController: AbortController;
    
    if (this.debounceManager) {
      const runResult = this.debounceManager.runRequest();
      requestId = runResult.generationUUID;
      abortController = runResult.abortController;
      
      // Cancel superseded requests
      for (const cancelId of runResult.requestIdsToCancel) {
        this.cancelStream(cancelId);
      }
      
      // Check if this request should be debounced
      if (await this.debounceManager.shouldDebounce(requestId)) {
        this.logger.info(`[Cpp] Request ${requestId.slice(0, 8)} debounced`);
        return null;
      }
    } else {
      abortController = new AbortController();
      requestId = ctx.requestUuid ?? `req-${Date.now()}-${this.requestSeed++}`;
    }
    
    this.registerStream(requestId, abortController);

    // Cancel previous request for same document and track current request
    // This follows Cursor's pattern of tracking this.db to ignore stale responses
    const prevRequestId = this.currentRequestByDocument.get(docKey);
    if (prevRequestId && prevRequestId !== requestId) {
      this.cancelStream(prevRequestId);
    }
    this.currentRequestByDocument.set(docKey, requestId);

    // Derive trigger source from VS Code's triggerKind if not explicitly provided
    const triggerSource = this.getTriggerSource(ctx);
    const isManualTrigger = triggerSource === TriggerSource.ManualTrigger;
    
    // Record telemetry for trigger
    this.telemetryService?.recordTriggerStart(requestId);
    this.telemetryService?.recordTriggerEvent(ctx.document, requestId, ctx.position, triggerSource);

    const diagnostics = vscode.languages.getDiagnostics(ctx.document.uri);
    const visibleRanges = Array.from(
      vscode.window.visibleTextEditors.find((editor) => editor.document === ctx.document)?.visibleRanges ?? [],
    );

    // Ensure document is synced before requesting completions
    await this.fileSync.prepareDocument(ctx.document);
    
    const syncPayload = this.fileSync.getSyncPayload(ctx.document);
    
    // Log sync state for debugging
    this.logger.info(`[Cpp] Request ${requestId.slice(0, 8)} relyOnFileSync=${syncPayload.relyOnFileSync}, updates=${syncPayload.updates.length}`);

    // Collect additional files context if enabled
    const additionalFiles = this.flags.enableAdditionalFilesContext && this.recentFilesTracker
      ? await this.recentFilesTracker.getAdditionalFilesContext(ctx.document.uri)
      : undefined;

    // Collect LSP suggestions
    const lspSuggestions = this.lspSuggestionsTracker
      ? this.lspSuggestionsTracker.getRelevantSuggestions(ctx.document.uri.toString())
      : undefined;

    // Get configured model
    const configuredModel = vscode.workspace.getConfiguration('cometixTab').get<string>('model', 'auto');

    try {
      const chunks = await withRetry(
        () =>
          this.consumeStream(
            buildStreamRequest(this.tracker, {
              document: ctx.document,
              position: ctx.position,
              linterDiagnostics: diagnostics,
              visibleRanges,
              filesyncUpdates: syncPayload.updates,
              relyOnFileSync: syncPayload.relyOnFileSync,
              fileVersion: ctx.document.version,
              lineEnding: ctx.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
              // New enhanced context fields
              triggerSource,
              additionalFiles,
              lspSuggestions,
              enableMoreContext: this.flags.enableAdditionalFilesContext,
              isManualTrigger,
              // Model selection from config
              modelName: configuredModel,
              // Workspace storage fields - matching Cursor's behavior
              workspaceId: this.workspaceStorage?.getWorkspaceId(),
              storedControlToken: this.workspaceStorage?.getControlToken(),
              checkFilesyncHashPercent: this.workspaceStorage?.getCheckFilesyncHashPercent() ?? 0,
            }),
            ctx,
            abortController,
            requestId
          ),
        { retries: 2, delayMs: 150 },
      );
      
      this.telemetryService?.recordGenerationFinished(requestId, chunks.length > 0);
      
      // Check if this request is still current (not superseded by a newer request)
      const currentRequest = this.currentRequestByDocument.get(docKey);
      if (currentRequest !== requestId) {
        // Instead of discarding, cache the result like Cursor does (this.O.addSuggestion pattern)
        // The next request will check the cache first
        this.logger.info(`[Cpp] Request ${requestId.slice(0, 8)} superseded by ${currentRequest?.slice(0, 8)}, caching result instead of discarding`);
        
        if (chunks.length > 0) {
          const [first, ...rest] = chunks;
          const suggestion: SuggestionResult = { ...first, requestId };
          this.addToSuggestionCache(suggestion, ctx.document.uri.toString(), ctx.document.version);
          
          // Also handle followups if any
          if (rest.length) {
            this.followups.set(requestId, { document: ctx.document.uri, queue: rest });
          }
        }
        return null;
      }
      
      if (chunks.length === 0) {
        return null;
      }
      const [first, ...rest] = chunks;
      if (rest.length) {
        this.followups.set(requestId, { document: ctx.document.uri, queue: rest });
        // Register a next action for multidiff - similar to Cursor's pc() function
        // This ensures displayNextActionIfAvailable knows there are more edits
        const nextActionId = first.bindingId ?? requestId;
        this.registerNextAction(
          nextActionId,
          { action: 'nextEdit' },
          requestId,
          first.text,
          rest[0]?.text
        );
        this.logger.info(`[Cpp] Registered nextEdit action for multidiff: ${rest.length} more edits queued`);
      }
      // Register fused cursor prediction if present and no followups
      if (!rest.length && first.cursorPredictionTarget) {
        const nextActionId = first.bindingId ?? requestId;
        this.registerNextAction(
          nextActionId,
          { action: 'fusedCursorPrediction', target: first.cursorPredictionTarget },
          requestId
        );
        this.logger.info(`[Cpp] Registered fusedCursorPrediction action: ${first.cursorPredictionTarget.relativePath}:${first.cursorPredictionTarget.lineNumberOneIndexed}`);
      }
      if (first.bindingId) {
        this.rememberBinding(first.bindingId, requestId, ctx.document.uri);
      }
      
      // Record suggestion shown
      this.telemetryService?.recordSuggestionEvent(ctx.document, requestId, first.text);
      
      return { ...first, requestId };
    } catch (error: any) {
      this.logger.error(`[Cpp] Request ${requestId.slice(0, 8)} failed: ${error?.message ?? String(error)}`);
      this.telemetryService?.recordGenerationFinished(requestId, false);
      return null; // Return null instead of throwing to avoid breaking the completion flow
    } finally {
      this.unregisterStream(requestId);
      this.debounceManager?.removeRequest(requestId);
      this.supersededRequests.delete(requestId);  // Clean up superseded tracking
      // Clean up current request tracking if this is still the current request
      if (this.currentRequestByDocument.get(docKey) === requestId) {
        this.currentRequestByDocument.delete(docKey);
      }
    }
  }

  async handleAccept(
    editor: vscode.TextEditor,
    requestId?: string,
    bindingId?: string,
    acceptedLength?: number
  ): Promise<void> {
    const resolvedRequestId = this.resolveRequestId(bindingId, requestId, editor.document.uri);
    if (!resolvedRequestId) {
      return;
    }
    this.lastAcceptedRequestId = resolvedRequestId;
    
    // Mark as handled via command to avoid duplicate telemetry in handleCompletionEnd
    this.acceptedViaCommand.add(resolvedRequestId);
    
    // Record this acceptance for cursor prediction suppression
    this.heuristics.recordAcceptedSuggestion(editor.document.uri, editor.selection.active);
    
    // Record accept telemetry
    this.telemetryService?.recordAcceptEvent(
      editor.document,
      resolvedRequestId,
      acceptedLength ?? 0
    );
    
    void this.cursorPrediction.handleSuggestionAccepted(editor);
    
    // Check for next action and auto-trigger if available (similar to Cursor's displayNextActionIfAvailable)
    await this.displayNextActionIfAvailable(editor, resolvedRequestId, bindingId);
    
    this.cleanupIfFinished(resolvedRequestId, bindingId);
  }

  /**
   * Display next action if available - similar to Cursor's displayNextActionIfAvailable
   * This is the key mechanism for auto-triggering follow-up edits
   */
  private async displayNextActionIfAvailable(
    editor: vscode.TextEditor,
    requestId: string,
    bindingId?: string
  ): Promise<void> {
    // First check the nextActionCache for a registered next action
    const nextActionId = bindingId ?? requestId;
    const nextAction = this.nextActionCache.get(nextActionId);
    
    if (nextAction) {
      this.logger.info(`[Cpp] displayNextActionIfAvailable: found cached action "${nextAction.type.action}" for ${nextActionId}`);
      
      if (nextAction.type.action === 'fusedCursorPrediction') {
        // Handle fused cursor prediction - navigate to predicted location
        const target = nextAction.type.target;
        this.logger.info(`[Cpp] Executing fused cursor prediction: ${target.relativePath}:${target.lineNumberOneIndexed}`);
        void vscode.commands.executeCommand('cometix-tab.goToCursorPrediction', target);
        this.nextActionCache.delete(nextActionId);
        return;
      } else if (nextAction.type.action === 'nextEdit') {
        // Trigger next edit via inline suggestion
        this.logger.info(`[Cpp] Auto-triggering next edit for requestId=${requestId}`);
        this.nextActionCache.delete(nextActionId);
        // Small delay to let editor settle after accepting the previous suggestion
        setTimeout(() => {
          void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
        }, 50);
        return;
      }
    }
    
    // Fallback: check if there are follow-up edits in the queue
    const session = this.followups.get(requestId);
    if (session && session.queue.length > 0) {
      this.logger.info(`[Cpp] displayNextActionIfAvailable: found ${session.queue.length} follow-up edits in queue, auto-triggering`);
      // Register this as a nextEdit action so the next request knows to consume from queue
      this.nextActionCache.set(requestId, {
        type: { action: 'nextEdit' },
        requestId,
      });
      // Trigger inline suggestion to show the next edit
      setTimeout(() => {
        void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
      }, 50);
      return;
    }
    
    // If not using fused cursor prediction model, try standalone StreamNextCursorPrediction
    if (!this.currentModelInfo.isFusedCursorPredictionModel && this.flags.enableCursorPrediction) {
      this.logger.info(`[Cpp] displayNextActionIfAvailable: no cached action, trying standalone cursor prediction (non-fused model)`);
      void this.tryStandaloneCursorPrediction(editor);
      return;
    }
    
    this.logger.info(`[Cpp] displayNextActionIfAvailable: no next action found for ${nextActionId}`);
  }

  /**
   * Try to get cursor prediction via standalone StreamNextCursorPrediction RPC
   * This is used when the model is not a fused cursor prediction model
   */
  private async tryStandaloneCursorPrediction(editor: vscode.TextEditor): Promise<void> {
    try {
      const document = editor.document;
      const position = editor.selection.active;
      
      // Build the request for standalone cursor prediction
      const request = {
        currentFile: {
          contents: document.getText(),
          relativePath: vscode.workspace.asRelativePath(document.uri, false),
          languageId: document.languageId,
          cursorOffset: document.offsetAt(position),
        },
        // Could add diffHistory, modelName, etc. here
      };
      
      const abortController = new AbortController();
      
      // Set a timeout to abort if it takes too long
      const timeoutId = setTimeout(() => abortController.abort(), 5000);
      
      try {
        const stream = await this.rpc.streamNextCursorPrediction(request as any, abortController);
        
        let predictedLineNumber: number | undefined;
        let predictedFileName: string | undefined;
        
        for await (const response of stream) {
          if (abortController.signal.aborted) {break;}
          
          const resp = response.response;
          if (resp.case === 'lineNumber') {
            predictedLineNumber = resp.value;
          } else if (resp.case === 'fileName') {
            predictedFileName = resp.value;
          } else if (resp.case === 'isNotInRange') {
            this.logger.info(`[Cpp] Standalone cursor prediction: isNotInRange, skipping`);
            return;
          }
        }
        
        clearTimeout(timeoutId);
        
        if (predictedLineNumber !== undefined) {
          const relativePath = predictedFileName ?? vscode.workspace.asRelativePath(document.uri, false);
          const target: CursorPredictionTargetInfo = {
            relativePath,
            lineNumberOneIndexed: predictedLineNumber,
            shouldRetriggerCpp: true,
          };
          
          // Check if we should suppress this prediction
          if (!this.shouldSuppressCursorPrediction(target, position)) {
            this.logger.info(`[Cpp] Standalone cursor prediction: showing prediction at ${relativePath}:${predictedLineNumber}`);
            
            // Mark that this cursor move will be from prediction
            this.heuristics.markCursorMoveAsPrediction();
            
            void vscode.commands.executeCommand('cometix-tab.goToCursorPrediction', target);
          }
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      this.logger.info(`[Cpp] Standalone cursor prediction failed: ${error}`);
    }
  }

  /**
   * Register a next action for a given bindingId/requestId
   * Called when streaming detects multidiff or fused cursor prediction
   */
  registerNextAction(
    nextActionId: string,
    type: NextActionType,
    requestId: string,
    originalText?: string,
    replaceText?: string
  ): void {
    this.logger.info(`[Cpp] Registering next action: id=${nextActionId}, action=${type.action}`);
    this.nextActionCache.set(nextActionId, {
      type,
      requestId,
      originalText,
      replaceText,
    });
    
    // Check if there was a pending action waiting for this registration
    if (this.pendingNextAction?.nextActionId === nextActionId) {
      this.logger.info(`[Cpp] Resolving pending next action for ${nextActionId}`);
      this.pendingNextAction = undefined;
    }
  }

  /**
   * Check if there are pending follow-up edits for a request
   */
  hasFollowups(requestId?: string): boolean {
    const id = requestId ?? this.lastAcceptedRequestId;
    if (!id) {return false;}
    const session = this.followups.get(id);
    return session !== undefined && session.queue.length > 0;
  }

  /**
   * Get the number of pending follow-up edits
   */
  getFollowupCount(requestId?: string): number {
    const id = requestId ?? this.lastAcceptedRequestId;
    if (!id) {return 0;}
    const session = this.followups.get(id);
    return session?.queue.length ?? 0;
  }

  /**
   * Get current model info
   */
  getModelInfo(): ModelInfo {
    return this.currentModelInfo;
  }

  /**
   * Check if current model supports multidiff
   */
  isMultidiffEnabled(): boolean {
    return this.currentModelInfo.isMultidiffModel;
  }

  /**
   * Check if current model uses fused cursor prediction
   */
  isFusedCursorPredictionEnabled(): boolean {
    return this.currentModelInfo.isFusedCursorPredictionModel;
  }

  /**
   * Get the inline edit triggerer for external use
   */
  getInlineEditTriggerer(): InlineEditTriggerer {
    return this.inlineEditTriggerer;
  }

  /**
   * Record a rejection for cooldown purposes
   */
  recordRejection(): void {
    this.inlineEditTriggerer.recordRejection();
  }

  async handlePartialAccept(
    editor: vscode.TextEditor,
    requestId?: string,
    bindingId?: string,
    info?: vscode.PartialAcceptInfo
  ): Promise<void> {
    const resolvedRequestId = this.resolveRequestId(bindingId, requestId, editor.document.uri);
    if (!resolvedRequestId) {
      return;
    }
    this.lastAcceptedRequestId = resolvedRequestId;
    
    // Proposed API: PartialAcceptInfo contains kind and acceptedLength
    // kind: Word (0), Line (1), Suggest (2), or Unknown (3)
    if (info) {
      const kindStr = this.getPartialAcceptKindString(info.kind);
      
      // Record telemetry for partial accept
      this.telemetryService?.recordPartialAcceptEvent(
        editor.document,
        resolvedRequestId,
        info.acceptedLength,
        kindStr
      );
      
      this.logger.info(
        `[Cpp] Partial accept: requestId=${resolvedRequestId}, ` +
        `kind=${kindStr}, acceptedLength=${info.acceptedLength}`
      );
    }
  }

  /**
   * Convert VS Code PartialAcceptTriggerKind to string for telemetry
   */
  private getPartialAcceptKindString(kind: vscode.PartialAcceptTriggerKind): 'word' | 'line' | 'suggest' | 'unknown' {
    switch (kind) {
      case vscode.PartialAcceptTriggerKind.Word: return 'word';
      case vscode.PartialAcceptTriggerKind.Line: return 'line';
      case vscode.PartialAcceptTriggerKind.Suggest: return 'suggest';
      default: return 'unknown';
    }
  }

  handleCompletionEnd(
    requestId: string,
    bindingId: string | undefined,
    reason: vscode.InlineCompletionEndOfLifeReason
  ): void {
    const editor = vscode.window.activeTextEditor;
    
    switch (reason.kind) {
      case vscode.InlineCompletionEndOfLifeReasonKind.Accepted:
        // User accepted the completion
        // Note: handleAccept is called via item.command before this callback
        // So we only do lightweight cleanup here, avoiding duplicate logic
        this.lastAcceptedRequestId = requestId;
        
        // Record telemetry for acceptance (if not already done by handleAccept)
        // The item.command callback handles the main accept logic including next edit triggering
        if (editor && !this.acceptedViaCommand.has(requestId)) {
          // Fallback: if somehow accepted without command, record it
          this.telemetryService?.recordAcceptEvent(editor.document, requestId, 0);
        }
        this.acceptedViaCommand.delete(requestId);
        this.cleanupRequest(requestId, bindingId);
        break;
        
      case vscode.InlineCompletionEndOfLifeReasonKind.Rejected:
        // User explicitly rejected (e.g., pressed Escape)
        this.recordRejection();
        if (editor) {
          this.telemetryService?.recordRejectEvent(editor.document, requestId, 'explicit_reject');
        }
        this.cleanupRequest(requestId, bindingId);
        break;
        
      case vscode.InlineCompletionEndOfLifeReasonKind.Ignored:
        // Completion was ignored (e.g., new request, typing disagreed)
        this.recordRejection();
        if (editor) {
          // Distinguish between different ignore reasons for telemetry
          const ignoreReason = (reason as any).userTypingDisagreed ? 'typing_disagreed' : 
                               (reason as any).supersededBy ? 'superseded' : 'ignored';
          this.telemetryService?.recordRejectEvent(editor.document, requestId, ignoreReason);
        }
        this.cleanupRequest(requestId, bindingId);
        break;
    }
  }

  /**
   * Trigger a new completion with CursorPrediction source after user accepts a completion.
   * This matches Cursor's behavior of automatically triggering a new request after acceptance.
   */
  private triggerCursorPrediction(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    
    this.logger.info('[Cpp] Triggering CursorPrediction after acceptance');
    this.inlineEditTriggerer.manualTrigger(
      editor.document,
      editor.selection.active,
      TriggerSource.CursorPrediction
    );
  }

  handleListEnd(
    requestId: string,
    bindingId: string | undefined,
    _reason: vscode.InlineCompletionsDisposeReason
  ): void {
    this.cleanupRequest(requestId, bindingId);
  }

  handleShown(_requestId?: string, _bindingId?: string): void {
    // Placeholder for telemetry/hints; currently no-op.
  }

  async applyNextEdit(
    editor: vscode.TextEditor,
    requestId?: string,
    bindingId?: string
  ): Promise<boolean> {
    const candidateRequestId = requestId ?? this.lastAcceptedRequestId;
    const targetRequestId = this.resolveRequestId(bindingId, candidateRequestId, editor.document.uri);
    if (!targetRequestId) {
      return false;
    }
    const session = this.followups.get(targetRequestId);
    if (!session || session.document.toString() !== editor.document.uri.toString()) {
      return false;
    }
    const next = session.queue.shift();
    if (!next) {
      this.followups.delete(targetRequestId);
      return false;
    }
    const targetRange = this.getApplicableRange(editor.document, next);
    await editor.edit((builder) => builder.replace(targetRange, next.text));
    if (!session.queue.length) {
      this.followups.delete(targetRequestId);
      if (bindingId) {
        this.bindingCache.delete(bindingId);
      }
      this.forgetBindingsForRequest(targetRequestId);
    }
    return true;
  }

  private async consumeStream(
    request: Parameters<IRpcClient['streamCpp']>[0],
    ctx: SuggestionContext,
    abortController: AbortController,
    requestId: string,
  ): Promise<RawSuggestion[]> {
    // Start cursor-style streaming and then poll via flushCpp
    const startOfCpp = Date.now();
    await this.rpc.streamCpp(request, { generateUuid: requestId, startOfCpp, abortController });
    const stream = this.streamCpp(abortController, this.rpc, requestId);
    
    // Collect individual edits from stream
    interface EditPart {
      range: { startLineNumber: number; endLineNumberInclusive: number };
      text: string;
      bindingId?: string;
      shouldTrimLeading: boolean;
    }
    const edits: EditPart[] = [];
    let buffer = '';
    let range: LineRange | undefined;
    let bindingId: string | undefined;
    let shouldTrimLeading = false;
    let displayLocation: vscode.InlineCompletionDisplayLocation | undefined;
    let cursorPredictionTarget: CursorPredictionTargetInfo | undefined;

    const resetEditState = () => {
      buffer = '';
      range = undefined;
      bindingId = undefined;
      shouldTrimLeading = false;
    };

    const flushEdit = () => {
      if (!range) {
        buffer = '';
        return;
      }
      const text = shouldTrimLeading ? buffer.replace(/^\r?\n/, '') : buffer;
      // Log edit details for debugging
      this.logger.info(`[Cpp] Flushing edit: L${range.startLineNumber}-${range.endLineNumberInclusive}, text="${text.slice(0, 80).replace(/\n/g, '\\n')}${text.length > 80 ? '...' : ''}" (${text.length} chars, trimLeading=${shouldTrimLeading})`);
      edits.push({ range: { startLineNumber: range.startLineNumber, endLineNumberInclusive: range.endLineNumberInclusive }, text, bindingId, shouldTrimLeading });
      resetEditState();
    };

    let chunkCount = 0;
    let hasNextEdit = false;  // Flag to indicate there are more edits in the stream
    let nextEditActionId: string | undefined;  // ID for triggering next edit
    
    for await (const chunk of stream as AsyncIterable<any>) {
      chunkCount++;
      
      // Detailed chunk logging
      const chunkType = chunk.rangeToReplace ? 'range' : chunk.text ? 'text' : chunk.beginEdit ? 'beginEdit' : chunk.doneEdit ? 'doneEdit' : chunk.cursorPredictionTarget ? 'cursorPred' : 'other';
      const chunkSummary = chunk.rangeToReplace 
        ? `L${chunk.rangeToReplace.startLineNumber}-${chunk.rangeToReplace.endLineNumberInclusive}`
        : chunk.text 
        ? `"${chunk.text.slice(0, 50).replace(/\n/g, '\\n')}${chunk.text.length > 50 ? '...' : ''}"`
        : '';
      this.logger.info(`[Cpp] Chunk #${chunkCount} [${chunkType}]: ${chunkSummary}`);
      
      // Only abort on hard user cancellation (e.g., Escape key)
      // Don't abort if just superseded by new request - let it complete and cache
      if (ctx.token.isCancellationRequested && !this.supersededRequests.has(requestId)) {
        this.logger.info(`[Cpp] User cancelled request ${requestId.slice(0, 8)}, aborting`);
        abortController.abort();
        return [];
      }
      
      // Handle beginEdit: signals start of a new edit
      // Continue reading the entire stream but track that there are more edits
      if (chunk.beginEdit) {
        this.logger.info(`[Cpp] beginEdit received, current edits=${edits.length}`);
        if (edits.length > 0) {
          // We already have one edit, mark that there's a next edit
          // But DON'T break - continue reading to cache all edits
          hasNextEdit = true;
          nextEditActionId = `${requestId}-next`;
          this.logger.info(`[Cpp] 🔄 NEXT_EDIT detected! Continuing to read stream to cache all edits`);
        }
        continue;
      }
      
      // Accumulate text
      buffer += chunk.text ?? '';
      
      // Update range (1-indexed from server)
      if (chunk.rangeToReplace) {
        range = chunk.rangeToReplace;
        this.logger.info(`[Cpp] Range set: L${chunk.rangeToReplace.startLineNumber}-${chunk.rangeToReplace.endLineNumberInclusive} (1-indexed)`);
      }
      if (chunk.bindingId) {
        bindingId = chunk.bindingId;
      }
      if (chunk.shouldRemoveLeadingEol) {
        shouldTrimLeading = true;
      }
      
      // Handle cursor prediction target
      if (chunk.cursorPredictionTarget?.lineNumberOneIndexed && chunk.cursorPredictionTarget.relativePath) {
        this.logger.info(`[Cpp] ⭐⭐⭐ CURSOR_PREDICTION_TARGET PROCESSING ⭐⭐⭐`);
        this.logger.info(`[Cpp] 📍 CursorPrediction raw: path="${chunk.cursorPredictionTarget.relativePath}", line=${chunk.cursorPredictionTarget.lineNumberOneIndexed}`);
        this.logger.info(`[Cpp] 📍 CursorPrediction extra: retrigger=${chunk.cursorPredictionTarget.shouldRetriggerCpp}, expectedContent="${(chunk.cursorPredictionTarget.expectedContent || '').slice(0, 80)}"`);
        
        cursorPredictionTarget = {
          relativePath: chunk.cursorPredictionTarget.relativePath,
          lineNumberOneIndexed: chunk.cursorPredictionTarget.lineNumberOneIndexed,
          expectedContent: chunk.cursorPredictionTarget.expectedContent,
          shouldRetriggerCpp: chunk.cursorPredictionTarget.shouldRetriggerCpp,
        };
        
        const relative = vscode.workspace.asRelativePath(ctx.document.uri, false);
        const isSameFile = relative === chunk.cursorPredictionTarget.relativePath;
        const line = Math.max(0, chunk.cursorPredictionTarget.lineNumberOneIndexed - 1);
        
        this.logger.info(`[Cpp] 📍 CursorPrediction context: currentFile="${relative}", isSameFile=${isSameFile}, targetLine=${line + 1}`);
        
        if (isSameFile && line < ctx.document.lineCount) {
          // Same file prediction - show Code displayLocation
          const lineRange = ctx.document.lineAt(line).range;
          displayLocation = {
            range: lineRange,
            label: 'Next Edit Location',
            kind: vscode.InlineCompletionDisplayLocationKind?.Code ?? 0,  // 0 = Code kind
          };
          this.logger.info(`[Cpp] ✅ CursorPrediction displayLocation created (SAME_FILE, Code kind): line ${line + 1}`);
        } else if (!isSameFile) {
          // Cross-file prediction - show Label displayLocation
          displayLocation = {
            range: new vscode.Range(ctx.position, ctx.position),
            label: `Go to ${chunk.cursorPredictionTarget.relativePath}:${line + 1}`,
            kind: vscode.InlineCompletionDisplayLocationKind?.Label ?? 1,  // 1 = Label kind
          };
          this.logger.info(`[Cpp] ✅ CursorPrediction displayLocation created (CROSS_FILE, Label kind): ${chunk.cursorPredictionTarget.relativePath}:${line + 1}`);
        } else {
          this.logger.info(`[Cpp] ⚠️ CursorPrediction: line ${line + 1} out of range (docLines=${ctx.document.lineCount}), skipping displayLocation`);
        }
        
        // Handle retrigger
        if (chunk.cursorPredictionTarget.shouldRetriggerCpp) {
          this.logger.info(`[Cpp] 🔄 CursorPrediction: triggering retrigger for next suggestion`);
          void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
        }
      }
      
      // Handle doneEdit: flush current edit and reset state
      if (chunk.doneEdit) {
        flushEdit();
      }
      
      // Log progress for debugging
      this.logger.info(`[Cpp] ✓ Chunk #${chunkCount} processed, continuing loop`);
    }
    // Final flush for any remaining edit
    if (range) {
      flushEdit();
    }
    
    this.logger.info(`[Cpp] Stream finished: ${chunkCount} chunks processed, ${edits.length} edits collected, hasNextEdit=${hasNextEdit}`);
    
    // Handle case where there's no edit but there is a cursor prediction (jump hint)
    if (edits.length === 0) {
      if (cursorPredictionTarget && displayLocation) {
        // Create a cursor jump hint suggestion with no actual text change
        const jumpHint: RawSuggestion = {
          text: '',
          range: new vscode.Range(ctx.position, ctx.position),
          displayLocation,
          cursorPredictionTarget,
          isCursorJumpHint: true,
          isInlineEdit: false,
        };
        this.logger.info(`[Cpp] 🎯 JUMP_HINT CREATED (no code edit, just cursor prediction)`);
        this.logger.info(`[Cpp] 🎯 JumpHint target: ${cursorPredictionTarget.relativePath}:${cursorPredictionTarget.lineNumberOneIndexed}`);
        this.logger.info(`[Cpp] 🎯 JumpHint displayLocation: kind=${displayLocation.kind}, label="${displayLocation.label}"`);
        return [jumpHint];
      }
      this.logger.info(`[Cpp] ❌ No edits and no cursor prediction, returning empty`);
      return [];
    }
    
    // SIMPLIFIED: Use only the first edit directly (like vscode-copilot-chat approach)
    // No more combineEdits - if there are more edits, they will be shown via nextAction
    const firstEdit = edits[0];
    const suggestionText = firstEdit.text;
    
    // Convert 1-indexed server range to 0-indexed VS Code range
    // VS Code Range API automatically handles out-of-bounds values
    const startLine = Math.max(0, firstEdit.range.startLineNumber - 1);
    const endLine = Math.max(startLine, firstEdit.range.endLineNumberInclusive - 1);
    
    // Use Number.MAX_SAFE_INTEGER for column - VS Code will auto-clamp to line end
    const vsRange = new vscode.Range(startLine, 0, endLine, Number.MAX_SAFE_INTEGER);
    const originalText = ctx.document.getText(vsRange);
    
    this.logger.info(`[Cpp] Using edit directly: server L${firstEdit.range.startLineNumber}-${firstEdit.range.endLineNumberInclusive} -> vscode L${startLine}-${endLine}, text="${suggestionText.slice(0, 50)}${suggestionText.length > 50 ? '...' : ''}"`);
    
    // Determine if this is an inline edit or a simple inline completion
    // Use inline completion (not edit) when:
    // 1. Single line edit on the cursor's line
    // 2. The original text is a "subword" of the new text (i.e., we're only adding characters)
    // This matches VS Code Copilot's isInlineSuggestion logic
    const isMultiLine = vsRange.start.line !== vsRange.end.line;
    const isSameLine = vsRange.start.line === ctx.position.line;
    const isInlineSuggestion = !isMultiLine && isSameLine && this.isSubword(originalText, suggestionText);
    const isInlineEdit = !isInlineSuggestion && originalText !== suggestionText;
    
    // CRITICAL: showRange must include the cursor position for VS Code to show the completion
    // Extend the range to include cursor line if needed
    let showRange: vscode.Range | undefined;
    if (isInlineEdit) {
      const cursorLine = ctx.position.line;
      const startLine = Math.min(vsRange.start.line, cursorLine);
      const endLine = Math.max(vsRange.end.line, cursorLine);
      
      // If cursor is on a different line, extend showRange to include it
      if (startLine !== vsRange.start.line || endLine !== vsRange.end.line) {
        const startChar = startLine === vsRange.start.line ? vsRange.start.character : 0;
        const endChar = endLine === vsRange.end.line 
          ? vsRange.end.character 
          : ctx.document.lineAt(endLine).range.end.character;
        showRange = new vscode.Range(startLine, startChar, endLine, endChar);
        this.logger.info(`[Cpp] Extended showRange to include cursor: (${startLine},${startChar})-(${endLine},${endChar})`);
      } else {
        showRange = vsRange;
      }
    }
    
    this.logger.info(`[Cpp] isInlineSuggestion=${isInlineSuggestion}, isInlineEdit=${isInlineEdit}, original="${originalText}", text="${suggestionText}"`);
    
    // If there's a next edit, add displayLocation to show "Next edit available" label
    let finalDisplayLocation = displayLocation;
    if (hasNextEdit && !displayLocation) {
      finalDisplayLocation = {
        range: new vscode.Range(ctx.position, ctx.position),
        label: 'Next edit available (Tab to apply, then Tab again)',
        kind: vscode.InlineCompletionDisplayLocationKind?.Label ?? 1,  // 1 = Label kind
      };
      this.logger.info(`[Cpp] 🔄 Added nextEdit displayLocation hint`);
    }
    
    const suggestion: RawSuggestion = {
      text: suggestionText,
      range: vsRange,
      bindingId: firstEdit.bindingId,
      lineRange: firstEdit.range as LineRange,
      displayLocation: finalDisplayLocation,
      isInlineEdit,
      showRange,
      cursorPredictionTarget,
      nextEditActionId,  // Pass the nextAction ID for triggering next edit on accept
    };
    
    this.logger.info(`[Cpp] Created suggestion from first edit: lines ${firstEdit.range.startLineNumber}-${firstEdit.range.endLineNumberInclusive}, ${suggestionText.length} chars, hasNextEdit=${hasNextEdit}`);
    
    // Log cursor prediction info if present
    if (cursorPredictionTarget) {
      this.logger.info(`[Cpp] 📍 Suggestion includes CursorPrediction: ${cursorPredictionTarget.relativePath}:${cursorPredictionTarget.lineNumberOneIndexed}`);
    }
    if (finalDisplayLocation) {
      this.logger.info(`[Cpp] 📍 Suggestion includes displayLocation: kind=${finalDisplayLocation.kind}, label="${finalDisplayLocation.label}"`);
    }
    
    // Apply isValidCppCase heuristics (like Cursor's validation)
    const validation = this.heuristics.isValidCppCase(
      ctx.document,
      firstEdit.range.startLineNumber,
      firstEdit.range.endLineNumberInclusive,
      suggestionText
    );
    
    if (!validation.valid) {
      this.logger.info(`[Cpp] ❌ Suggestion rejected by heuristics: ${validation.invalidReason}`);
      
      // If rejected but we have a cursor prediction, try to show just the prediction
      // This matches Cursor's behavior of showing cursor prediction when edit is invalid
      if (cursorPredictionTarget && displayLocation && !this.shouldSuppressCursorPrediction(cursorPredictionTarget, ctx.position)) {
        this.logger.info(`[Cpp] 🎯 Falling back to cursor prediction only (edit was invalid)`);
        const jumpHint: RawSuggestion = {
          text: '',
          range: new vscode.Range(ctx.position, ctx.position),
          displayLocation,
          cursorPredictionTarget,
          isCursorJumpHint: true,
          isInlineEdit: false,
        };
        return [jumpHint];
      }
      
      return [];
    }
    
    // Apply cursor prediction suppression if present
    // Note: We don't return early here - we need to continue to cache followup edits
    let finalSuggestion = suggestion;
    if (cursorPredictionTarget) {
      const suppressResult = this.shouldSuppressCursorPrediction(cursorPredictionTarget, ctx.position);
      if (suppressResult) {
        this.logger.info(`[Cpp] 📍 Cursor prediction suppressed, keeping only code edit`);
        // Modify suggestion to remove cursor prediction, but don't return yet
        finalSuggestion = {
          ...suggestion,
          cursorPredictionTarget: undefined,
          displayLocation: undefined,
        };
      }
    }
    
    // If there are more edits, cache them in followups for the next request
    // This ensures that even if this request is cancelled, the next request can use the cached edits
    if (edits.length > 1) {
      const followupEdits: RawSuggestion[] = [];
      for (let i = 1; i < edits.length; i++) {
        const edit = edits[i];
        // Convert 1-indexed to 0-indexed, VS Code auto-clamps out-of-bounds
        const editStartLine = Math.max(0, edit.range.startLineNumber - 1);
        const editEndLine = Math.max(editStartLine, edit.range.endLineNumberInclusive - 1);
        const editVsRange = new vscode.Range(editStartLine, 0, editEndLine, Number.MAX_SAFE_INTEGER);
        
        followupEdits.push({
          text: edit.text,
          range: editVsRange,
          bindingId: edit.bindingId,
          lineRange: edit.range as LineRange,
          isInlineEdit: true,
        });
      }
      
      // Store in followups cache - keyed by document URI so it persists across requests
      const docKey = ctx.document.uri.toString();
      this.followups.set(docKey, {
        document: ctx.document.uri,
        queue: followupEdits,
        documentVersion: ctx.document.version,  // Track version to detect stale cache
      });
      
      // Also set up nextAction cache
      if (nextEditActionId) {
        this.nextActionCache.set(nextEditActionId, {
          type: { action: 'nextEdit' },
          requestId: requestId,
        });
      }
      
      this.logger.info(`[Cpp] 📦 Cached ${followupEdits.length} followup edits for document ${docKey}`);
    }
    
    return [finalSuggestion];
  }
  
  /**
   * Check if cursor prediction should be suppressed
   * Similar to Cursor's isFusedCursorPredictionTooClose* functions
   */
  private shouldSuppressCursorPrediction(
    target: CursorPredictionTargetInfo,
    cursorPosition: vscode.Position
  ): boolean {
    const { suppress, reason } = this.heuristics.shouldSuppressCursorPrediction(
      target.lineNumberOneIndexed,
      target.relativePath,
      cursorPosition
    );
    if (suppress) {
      this.logger.info(`[Cpp] Cursor prediction suppressed: ${reason}`);
    }
    return suppress;
  }
  
  /**
   * Combine multiple edits into a single text by applying them to the original document.
   * Edits should be sorted by start line number.
   * 
   * Note: Server uses 1-indexed line numbers, VS Code uses 0-indexed.
   * startLine and endLine are 1-indexed (from server).
   */
  private combineEdits(
    document: vscode.TextDocument,
    edits: Array<{ range: { startLineNumber: number; endLineNumberInclusive: number }; text: string }>,
    startLine: number,
    endLine: number
  ): string {
    // Log original document context
    this.logger.info(`[Cpp] combineEdits: range L${startLine}-${endLine} (1-indexed), ${edits.length} edits`);
    
    // Get original lines (convert 1-indexed to 0-indexed)
    const lines: string[] = [];
    for (let i = startLine - 1; i <= endLine - 1 && i < document.lineCount; i++) {
      lines.push(document.lineAt(i).text);
    }
    
    this.logger.info(`[Cpp] Original lines (${lines.length}):`);
    lines.forEach((line, idx) => {
      this.logger.info(`[Cpp]   L${startLine + idx}: "${line.slice(0, 60)}${line.length > 60 ? '...' : ''}"`);
    });
    
    // Apply edits in reverse order to preserve line numbers
    // Each edit's range is 1-indexed, we need to convert to array index
    const reversedEdits = [...edits].reverse();
    for (const edit of reversedEdits) {
      // Convert 1-indexed line numbers to array indices relative to our lines array
      const editStartIdx = edit.range.startLineNumber - startLine;
      const editEndIdx = edit.range.endLineNumberInclusive - startLine;
      const editLines = edit.text ? edit.text.split('\n') : [''];
      
      this.logger.info(`[Cpp] Applying edit: serverRange L${edit.range.startLineNumber}-${edit.range.endLineNumberInclusive} -> arrayIdx ${editStartIdx}-${editEndIdx}, delete ${editEndIdx - editStartIdx + 1} lines, insert ${editLines.length} lines`);
      this.logger.info(`[Cpp]   Insert text: "${editLines.map(l => l.slice(0, 40)).join('\\n')}"`);
      
      // Remove old lines and insert new ones
      const deleteCount = editEndIdx - editStartIdx + 1;
      lines.splice(editStartIdx, deleteCount, ...editLines);
      
      this.logger.info(`[Cpp]   Lines after edit: ${lines.length}`);
    }
    
    const result = lines.join('\n');
    this.logger.info(`[Cpp] Combined result (${result.length} chars):\n${result.slice(0, 200)}${result.length > 200 ? '...' : ''}`);
    
    return result;
  }

  // Mirror cursor/workbench polling pattern for streamCpp via flushCpp
  private async *streamCpp(
    abortController: AbortController,
    rpc: IRpcClient,
    requestId: string,
  ): AsyncIterable<{
    text?: string;
    rangeToReplace?: LineRange;
    bindingId?: string;
    shouldRemoveLeadingEol?: boolean;
    beginEdit?: boolean;
    doneEdit?: boolean;
    cursorPredictionTarget?: any;
    modelInfo?: ModelInfo;
  }> {
    let seenModelInfo = false;
    let done = false;
    for (;;) {
      if (abortController.signal.aborted) {return;}
      const res = await rpc.flushCpp(requestId);
      if (res.type === 'failure') {throw new Error(res.reason);}
      if (!seenModelInfo && res.modelInfo !== undefined) {
        seenModelInfo = true;
        // Extract and store model info - similar to Cursor's oc() function
        const modelInfo: ModelInfo = {
          isFusedCursorPredictionModel: res.modelInfo.isFusedCursorPredictionModel ?? DEFAULT_MODEL_INFO.isFusedCursorPredictionModel,
          isMultidiffModel: res.modelInfo.isMultidiffModel ?? DEFAULT_MODEL_INFO.isMultidiffModel,
          modelName: res.modelInfo.modelName,
        };
        this.currentModelInfo = modelInfo;
        this.logger.info(`[Cpp] ModelInfo received: isFused=${modelInfo.isFusedCursorPredictionModel}, isMultidiff=${modelInfo.isMultidiffModel}, modelName=${modelInfo.modelName ?? 'unknown'}`);
        yield { modelInfo };
      }
      const items = res.buffer;
      // Only log when we actually receive items to reduce noise
      if (items.length > 0) {
        this.logger.info(`[Cpp] flushCpp returned ${items.length} items`);
      }
      for (const item of items) {
        if (item === 'm4CoTMbqtR9vV1zd') {
          done = true;
          break;
        }
        if (typeof item === 'string') {
          // Log each text item with full length info
          this.logger.info(`[Cpp] Buffer text item: ${item.length} chars, content="${item.slice(0, 80).replace(/\n/g, '\\n')}${item.length > 80 ? '...' : ''}"`);
          yield { text: item };
        } else if (item.case === 'rangeToReplace') {
          const rr = item.rangeToReplaceOneIndexed;
          yield {
            rangeToReplace: {
              startLineNumber: rr.startLineNumber,
              endLineNumberInclusive: rr.endLineNumberInclusive,
            } as LineRange,
            bindingId: item.bindingId,
            shouldRemoveLeadingEol: rr.shouldRemoveLeadingEol ?? false,
          };
        } else if (item.case === 'doneEdit') {
          yield { doneEdit: true };
        } else if (item.case === 'beginEdit') {
          yield { beginEdit: true };
        } else if (item.case === 'cursorPredictionTarget') {
          yield { cursorPredictionTarget: item.cursorPredictionTarget, bindingId: item.bindingId };
        } else {
          throw new Error('Unknown flushCppResponse: ' + JSON.stringify(item));
        }
      }
      if (done) {return;}
      await new Promise((l) => setTimeout(l, 5));
    }
  }

  private isEligible(ctx: SuggestionContext): boolean {
    if (ctx.token.isCancellationRequested) {
      return false;
    }
    if (this.flags.excludedLanguages.includes(ctx.document.languageId)) {
      return false;
    }
    const editor = vscode.window.activeTextEditor;
    // Block if user has an active selection (not just a cursor)
    if (editor && !editor.selection.isEmpty) {
      return false;
    }
    // Size limit to avoid performance issues (matches Cursor's behavior)
    const sizeLimit = 800_000;
    if (ctx.document.getText().length > sizeLimit) {
      this.logger.info(`[Cpp] Skipping completion - file too large (${ctx.document.getText().length} > ${sizeLimit})`);
      return false;
    }
    
    // Check for comment areas - respecting cppTriggerInComments config
    // Manual triggers (Invoke) always bypass comment check (like Cursor)
    const isManualTrigger = ctx.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
    const allowCommentsCompletion = this.flags.cppTriggerInComments || isManualTrigger;
    
    if (!allowCommentsCompletion && this.isInCommentArea(ctx.document, ctx.position)) {
      this.logger.info(`[Cpp] Skipping completion - cursor is in comment area at line ${ctx.position.line + 1} (cppTriggerInComments=${this.flags.cppTriggerInComments})`);
      return false;
    }
    return true;
  }
  
  /**
   * Derive TriggerSource from VS Code's InlineCompletionTriggerKind
   * Maps: Invoke → ManualTrigger, Automatic → Typing
   * Also checks for pending trigger source from InlineEditTriggerer
   */
  private getTriggerSource(ctx: SuggestionContext): TriggerSource {
    // First check if explicit trigger source was provided
    if (ctx.triggerSource) {
      return ctx.triggerSource;
    }
    
    // Check for pending trigger from InlineEditTriggerer (e.g., LinterErrors, ParameterHints)
    if (this.pendingTriggerSource && 
        Date.now() - this.pendingTriggerTimestamp < this.pendingTriggerMaxAgeMs) {
      const source = this.pendingTriggerSource;
      // Clear pending trigger after use
      this.pendingTriggerSource = undefined;
      return source;
    }
    
    // Fallback to VS Code's triggerKind
    if (ctx.triggerKind === vscode.InlineCompletionTriggerKind.Invoke) {
      return TriggerSource.ManualTrigger;
    }
    // Default to Typing for Automatic triggers
    return TriggerSource.Typing;
  }

  /**
   * Check if the position is inside a comment.
   * Uses simple heuristics to detect common comment patterns.
   * 
   * Like Cursor, this prevents triggering completions in comment areas
   * (unless the source is CursorPrediction, which we don't support yet).
   */
  private isInCommentArea(document: vscode.TextDocument, position: vscode.Position): boolean {
    const line = document.lineAt(position.line);
    const lineText = line.text;
    const charBefore = lineText.substring(0, position.character);
    
    // Check for single-line comment patterns
    // Most languages: //
    // Python, Shell, etc: #
    // SQL: --
    const singleLineCommentPatterns = ['//', '#', '--'];
    for (const pattern of singleLineCommentPatterns) {
      const commentStart = lineText.indexOf(pattern);
      if (commentStart !== -1 && commentStart < position.character) {
        // Position is after comment start
        return true;
      }
    }
    
    // Check for multi-line comment patterns
    // Look for /* that isn't closed before position
    const blockCommentStart = lineText.lastIndexOf('/*', position.character);
    if (blockCommentStart !== -1) {
      const blockCommentEnd = lineText.indexOf('*/', blockCommentStart + 2);
      if (blockCommentEnd === -1 || blockCommentEnd >= position.character) {
        // We're inside a block comment
        return true;
      }
    }
    
    // Simple heuristic: if line starts with * after whitespace, likely in block comment
    if (/^\s*\*(?!\/)/.test(lineText) && !lineText.includes('*/')) {
      return true;
    }
    
    // Check for HTML-style comments
    const htmlCommentStart = charBefore.lastIndexOf('<!--');
    if (htmlCommentStart !== -1) {
      const htmlCommentEnd = charBefore.indexOf('-->', htmlCommentStart + 4);
      if (htmlCommentEnd === -1) {
        return true;
      }
    }
    
    return false;
  }

  private registerStream(requestId: string, controller: AbortController): void {
    this.activeStreams.set(requestId, controller);
    if (this.activeStreams.size > MAX_CONCURRENT_STREAMS) {
      const [oldest] = this.activeStreams.keys();
      // Use soft cancel instead of hard abort - let it complete and cache results
      this.supersededRequests.add(oldest);
      this.logger.info(`[Cpp] Too many streams (>${MAX_CONCURRENT_STREAMS}), marking ${oldest.slice(0, 8)} as superseded`);
      // Note: Don't abort or delete - let it finish processing naturally
    }
  }

  private unregisterStream(requestId: string): void {
    // Just remove from tracking - don't abort since stream completed naturally
    this.activeStreams.delete(requestId);
  }

  private cancelStream(requestId: string): void {
    const controller = this.activeStreams.get(requestId);
    if (controller) {
      // Mark as superseded instead of immediately aborting
      // This allows the stream to complete processing and cache results
      this.supersededRequests.add(requestId);
      this.logger.info(`[Cpp] Marked stream ${requestId.slice(0, 8)} as superseded (will cache result)`);
      // Note: We don't abort or cancelCpp here - let the stream complete
    }
  }
  
  /** Hard cancel a stream (used for user-initiated cancellation like Escape) */
  private hardCancelStream(requestId: string): void {
    const controller = this.activeStreams.get(requestId);
    if (controller) {
      controller.abort();
      this.rpc.cancelCpp(requestId);
      this.supersededRequests.delete(requestId);
      this.logger.info(`[Cpp] Hard cancelled stream ${requestId.slice(0, 8)}`);
    }
  }

  /**
   * Check if string `a` is a subword of string `b`.
   * A is a subword of B if A can be obtained by removing characters from B.
   * This is used to determine if a completion is a simple insertion (inline suggestion)
   * vs a replacement (inline edit).
   * 
   * Examples:
   * - isSubword("    }", "    });") = true (remove ");" to get "    }")
   * - isSubword("foo", "foobar") = true
   * - isSubword("foo", "bar") = false
   */
  private isSubword(a: string, b: string): boolean {
    let aIdx = 0;
    let bIdx = 0;
    while (aIdx < a.length) {
      if (bIdx >= b.length) {
        return false;
      }
      if (a[aIdx] === b[bIdx]) {
        aIdx++;
      }
      bIdx++;
    }
    return true;
  }

  /**
   * Convert server's 1-indexed LineRange to VS Code's 0-indexed Range.
   * Server: startLineNumber=89 means line 89 (1-indexed)
   * VS Code: line 88 (0-indexed)
   * VS Code Range API automatically clamps out-of-bounds values.
   */
  private toVsRange(lineRange: LineRange): vscode.Range {
    const startLine = Math.max(0, lineRange.startLineNumber - 1);
    const endLine = Math.max(startLine, lineRange.endLineNumberInclusive - 1);
    // Use MAX_SAFE_INTEGER for column - VS Code auto-clamps to line end
    return new vscode.Range(startLine, 0, endLine, Number.MAX_SAFE_INTEGER);
  }

  private getApplicableRange(document: vscode.TextDocument, suggestion: RawSuggestion): vscode.Range {
    if (suggestion.lineRange) {
      return this.toVsRange(suggestion.lineRange);
    }
    return suggestion.range;
  }

  private rememberBinding(bindingId: string, requestId: string, document: vscode.Uri): void {
    this.bindingCache.set(bindingId, { requestId, document });
    const bindings = this.requestBindings.get(requestId) ?? new Set<string>();
    bindings.add(bindingId);
    this.requestBindings.set(requestId, bindings);
  }

  private resolveRequestId(
    bindingId?: string,
    fallback?: string,
    document?: vscode.Uri
  ): string | undefined {
    if (bindingId) {
      const entry = this.bindingCache.get(bindingId);
      if (entry && (!document || entry.document.toString() === document.toString())) {
        return entry.requestId;
      }
    }
    return fallback;
  }

  private forgetBindingsForRequest(requestId: string): void {
    const bindings = this.requestBindings.get(requestId);
    if (bindings) {
      for (const bindingId of bindings) {
        this.bindingCache.delete(bindingId);
      }
      this.requestBindings.delete(requestId);
    }
  }

  private cleanupIfFinished(requestId: string, bindingId?: string): void {
    const session = this.followups.get(requestId);
    if (session && session.queue.length > 0) {
      return;
    }
    this.cleanupRequest(requestId, bindingId);
  }

  private cleanupRequest(requestId: string, bindingId?: string): void {
    this.followups.delete(requestId);
    // Clean up next action cache entries for this request
    this.nextActionCache.delete(requestId);
    if (bindingId) {
      this.bindingCache.delete(bindingId);
      this.nextActionCache.delete(bindingId);
    }
    this.forgetBindingsForRequest(requestId);
  }
}
