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
  // Trigger source for telemetry
  readonly triggerSource?: TriggerSource;
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
  // Track current active request per document to ignore stale responses (like Cursor's this.db pattern)
  private currentRequestByDocument = new Map<string, string>();
  
  /** Model info from last successful response */
  private currentModelInfo: ModelInfo = DEFAULT_MODEL_INFO;
  
  /** Heuristics service for validation and cursor prediction suppression */
  private readonly heuristics: CppHeuristicsService;
  
  /** Inline edit triggerer for auto-triggering suggestions */
  private readonly inlineEditTriggerer: InlineEditTriggerer;

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
  ) {
    this.flags = config.flags;
    config.onDidChange((next) => (this.flags = next));
    
    // Initialize heuristics service
    this.heuristics = new CppHeuristicsService(logger);
    
    // Initialize inline edit triggerer
    this.inlineEditTriggerer = new InlineEditTriggerer(logger);
    
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
    this.pendingNextAction = undefined;
    this.heuristics.dispose();
    this.inlineEditTriggerer.dispose();
  }

  async requestSuggestion(ctx: SuggestionContext): Promise<SuggestionResult | null> {
    if (!this.flags.enableInlineSuggestions || !this.isEligible(ctx)) {
      return null;
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
    const docKey = ctx.document.uri.toString();
    const prevRequestId = this.currentRequestByDocument.get(docKey);
    if (prevRequestId && prevRequestId !== requestId) {
      this.cancelStream(prevRequestId);
    }
    this.currentRequestByDocument.set(docKey, requestId);

    // Record telemetry for trigger
    const triggerSource = ctx.triggerSource ?? TriggerSource.Unknown;
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
              isManualTrigger: triggerSource === TriggerSource.ManualTrigger,
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
        this.logger.info(`[Cpp] Request ${requestId.slice(0, 8)} superseded by ${currentRequest?.slice(0, 8)}, discarding result`);
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
      // Clean up current request tracking if this is still the current request
      if (this.currentRequestByDocument.get(docKey) === requestId) {
        this.currentRequestByDocument.delete(docKey);
      }
    }
  }

  async handleAccept(editor: vscode.TextEditor, requestId?: string, bindingId?: string): Promise<void> {
    const resolvedRequestId = this.resolveRequestId(bindingId, requestId, editor.document.uri);
    if (!resolvedRequestId) {
      return;
    }
    this.lastAcceptedRequestId = resolvedRequestId;
    
    // Record this acceptance for cursor prediction suppression
    this.heuristics.recordAcceptedSuggestion(editor.document.uri, editor.selection.active);
    
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
          if (abortController.signal.aborted) break;
          
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
    if (!id) return false;
    const session = this.followups.get(id);
    return session !== undefined && session.queue.length > 0;
  }

  /**
   * Get the number of pending follow-up edits
   */
  getFollowupCount(requestId?: string): number {
    const id = requestId ?? this.lastAcceptedRequestId;
    if (!id) return 0;
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
    // kind: Word (1), Line (2), Suggest (3), or Unknown (0)
    // This can be used for telemetry or adjusting followup behavior
    if (info) {
      this.logger.info(
        `[Cpp] Partial accept: requestId=${resolvedRequestId}, ` +
        `kind=${vscode.PartialAcceptTriggerKind[info.kind]}, ` +
        `acceptedLength=${info.acceptedLength}`
      );
    }
  }

  handleCompletionEnd(
    requestId: string,
    bindingId: string | undefined,
    reason: vscode.InlineCompletionEndOfLifeReason
  ): void {
    if (reason.kind === vscode.InlineCompletionEndOfLifeReasonKind.Rejected || reason.kind === vscode.InlineCompletionEndOfLifeReasonKind.Ignored) {
      // Record rejection for InlineEditTriggerer cooldown
      this.recordRejection();
      this.cleanupRequest(requestId, bindingId);
    }
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
      
      if (ctx.token.isCancellationRequested) {
        abortController.abort();
        return [];
      }
      
      // Handle beginEdit: signals start of a new edit, reset state
      if (chunk.beginEdit) {
        this.logger.info(`[Cpp] beginEdit received, current edits=${edits.length}`);
        // Don't flush here - state should already be reset from previous doneEdit
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
            kind: vscode.InlineCompletionDisplayLocationKind.Code,
          };
          this.logger.info(`[Cpp] ✅ CursorPrediction displayLocation created (SAME_FILE, Code kind): line ${line + 1}`);
        } else if (!isSameFile) {
          // Cross-file prediction - show Label displayLocation
          displayLocation = {
            range: new vscode.Range(ctx.position, ctx.position),
            label: `Go to ${chunk.cursorPredictionTarget.relativePath}:${line + 1}`,
            kind: vscode.InlineCompletionDisplayLocationKind.Label,
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
    }
    // Final flush for any remaining edit
    if (range) {
      flushEdit();
    }
    
    this.logger.info(`[Cpp] Stream finished: ${chunkCount} chunks processed, ${edits.length} edits collected`);
    
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
    
    // For multidiff: combine all edits into a single suggestion
    // Sort edits by start line number
    const sortedEdits = [...edits].sort((a, b) => a.range.startLineNumber - b.range.startLineNumber);
    
    // Calculate the combined range (min start to max end)
    const minStartLine = Math.min(...sortedEdits.map(e => e.range.startLineNumber));
    const maxEndLine = Math.max(...sortedEdits.map(e => e.range.endLineNumberInclusive));
    
    // Build combined text by applying edits to original document content
    const combinedText = this.combineEdits(ctx.document, sortedEdits, minStartLine, maxEndLine);
    
    const combinedRange = {
      startLineNumber: minStartLine,
      endLineNumberInclusive: maxEndLine,
    } as LineRange;
    
    const fullVsRange = this.toVsRange(ctx.document, combinedRange);
    const originalText = ctx.document.getText(fullVsRange);
    
    // For single-line edits, compute minimal diff from cursor position
    // VS Code InlineCompletion works best when range starts at/after cursor
    let vsRange = fullVsRange;
    let suggestionText = combinedText;
    
    if (fullVsRange.isSingleLine && ctx.position.line === fullVsRange.start.line) {
      const cursorCol = ctx.position.character;
      
      // Find common prefix length (up to cursor position)
      let commonPrefixLen = 0;
      const maxPrefix = Math.min(cursorCol, originalText.length, combinedText.length);
      while (commonPrefixLen < maxPrefix && originalText[commonPrefixLen] === combinedText[commonPrefixLen]) {
        commonPrefixLen++;
      }
      
      // Find common suffix length
      let commonSuffixLen = 0;
      const maxSuffix = Math.min(originalText.length - commonPrefixLen, combinedText.length - commonPrefixLen);
      while (commonSuffixLen < maxSuffix && 
             originalText[originalText.length - 1 - commonSuffixLen] === combinedText[combinedText.length - 1 - commonSuffixLen]) {
        commonSuffixLen++;
      }
      
      // Extract the minimal change
      const replaceStart = commonPrefixLen;
      const replaceEnd = originalText.length - commonSuffixLen;
      const insertStart = commonPrefixLen;
      const insertEnd = combinedText.length - commonSuffixLen;
      
      this.logger.info(`[Cpp] Minimal diff: prefix=${commonPrefixLen}, suffix=${commonSuffixLen}, cursor=${cursorCol}`);
      this.logger.info(`[Cpp]   Original[${replaceStart}:${replaceEnd}]="${originalText.slice(replaceStart, replaceEnd)}"`);
      this.logger.info(`[Cpp]   Insert[${insertStart}:${insertEnd}]="${combinedText.slice(insertStart, insertEnd)}"`);
      
      // If the change starts at or after cursor, use minimal range
      // Otherwise, fall back to replacing from cursor to end
      if (replaceStart >= cursorCol - 1) {
        // Minimal change is at/after cursor - use it
        vsRange = new vscode.Range(
          fullVsRange.start.line, replaceStart,
          fullVsRange.start.line, replaceEnd
        );
        suggestionText = combinedText.slice(insertStart, insertEnd);
      } else {
        // Change starts before cursor - replace from cursor to end
        vsRange = new vscode.Range(
          fullVsRange.start.line, cursorCol,
          fullVsRange.end.line, fullVsRange.end.character
        );
        suggestionText = combinedText.slice(cursorCol);
      }
      
      this.logger.info(`[Cpp] Adjusted range: (${vsRange.start.line},${vsRange.start.character})-(${vsRange.end.line},${vsRange.end.character}), text="${suggestionText}"`);
    }
    
    // Determine if this is an inline edit or a simple inline completion
    // Use inline completion (not edit) when:
    // 1. Single line edit on the cursor's line
    // 2. The original text is a "subword" of the new text (i.e., we're only adding characters)
    // This matches VS Code Copilot's isInlineSuggestion logic
    const isMultiLine = fullVsRange.start.line !== fullVsRange.end.line;
    const isSameLine = fullVsRange.start.line === ctx.position.line;
    const isInlineSuggestion = !isMultiLine && isSameLine && this.isSubword(originalText, combinedText);
    const isInlineEdit = !isInlineSuggestion && originalText !== combinedText;
    
    // CRITICAL: showRange must include the cursor position for VS Code to show the completion
    // Extend the range to include cursor line if needed
    let showRange: vscode.Range | undefined;
    if (isInlineEdit) {
      const cursorLine = ctx.position.line;
      const startLine = Math.min(fullVsRange.start.line, cursorLine);
      const endLine = Math.max(fullVsRange.end.line, cursorLine);
      
      // If cursor is on a different line, extend showRange to include it
      if (startLine !== fullVsRange.start.line || endLine !== fullVsRange.end.line) {
        const startChar = startLine === fullVsRange.start.line ? fullVsRange.start.character : 0;
        const endChar = endLine === fullVsRange.end.line 
          ? fullVsRange.end.character 
          : ctx.document.lineAt(endLine).range.end.character;
        showRange = new vscode.Range(startLine, startChar, endLine, endChar);
        this.logger.info(`[Cpp] Extended showRange to include cursor: (${startLine},${startChar})-(${endLine},${endChar})`);
      } else {
        showRange = fullVsRange;
      }
    }
    
    this.logger.info(`[Cpp] isInlineSuggestion=${isInlineSuggestion}, isInlineEdit=${isInlineEdit}, original="${originalText}", combined="${combinedText}"`);
    
    const suggestion: RawSuggestion = {
      text: suggestionText,
      range: vsRange,
      bindingId: sortedEdits[0]?.bindingId,
      lineRange: combinedRange,
      displayLocation,
      isInlineEdit,
      showRange,
      cursorPredictionTarget,
    };
    
    this.logger.info(`[Cpp] Combined ${edits.length} edits into suggestion: lines ${minStartLine}-${maxEndLine}, ${suggestionText.length} chars`);
    
    // Log cursor prediction info if present
    if (cursorPredictionTarget) {
      this.logger.info(`[Cpp] 📍 Suggestion includes CursorPrediction: ${cursorPredictionTarget.relativePath}:${cursorPredictionTarget.lineNumberOneIndexed}`);
    }
    if (displayLocation) {
      this.logger.info(`[Cpp] 📍 Suggestion includes displayLocation: kind=${displayLocation.kind}, label="${displayLocation.label}"`);
    }
    
    // Apply isValidCppCase heuristics (like Cursor's validation)
    const validation = this.heuristics.isValidCppCase(
      ctx.document,
      minStartLine,
      maxEndLine,
      combinedText
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
    if (cursorPredictionTarget) {
      const suppressResult = this.shouldSuppressCursorPrediction(cursorPredictionTarget, ctx.position);
      if (suppressResult) {
        this.logger.info(`[Cpp] 📍 Cursor prediction suppressed, keeping only code edit`);
        // Return suggestion without cursor prediction
        return [{
          ...suggestion,
          cursorPredictionTarget: undefined,
          displayLocation: undefined,
        }];
      }
    }
    
    return [suggestion];
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
      if (abortController.signal.aborted) return;
      const res = await rpc.flushCpp(requestId);
      if (res.type === 'failure') throw new Error(res.reason);
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
      if (done) return;
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
    // Size limit to avoid performance issues
    const sizeLimit = 800_000;
    if (ctx.document.getText().length > sizeLimit) {
      return false;
    }
    // Like Cursor, skip completions in comment areas
    // (except for CursorPrediction source which Cursor allows)
    if (this.isInCommentArea(ctx.document, ctx.position)) {
      this.logger.info(`[Cpp] Skipping completion - cursor is in comment area at line ${ctx.position.line + 1}`);
      return false;
    }
    return true;
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
      const abort = this.activeStreams.get(oldest);
      if (abort) {
        abort.abort();
      }
      this.activeStreams.delete(oldest);
      this.logger.warn(`Too many concurrent streams, aborted ${oldest}`);
    }
  }

  private unregisterStream(requestId: string): void {
    const controller = this.activeStreams.get(requestId);
    if (controller) {
      controller.abort();
      this.activeStreams.delete(requestId);
    }
  }

  private cancelStream(requestId: string): void {
    const controller = this.activeStreams.get(requestId);
    if (controller) {
      controller.abort();
      this.rpc.cancelCpp(requestId);
      this.logger.info(`[Cpp] Cancelled stream ${requestId.slice(0, 8)}`);
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
   */
  private toVsRange(document: vscode.TextDocument, lineRange: LineRange): vscode.Range {
    // Convert 1-indexed to 0-indexed
    const startLine = Math.max(0, lineRange.startLineNumber - 1);
    const endLine = Math.min(document.lineCount - 1, lineRange.endLineNumberInclusive - 1);
    const startChar = 0;
    const endChar = document.lineAt(endLine).range.end.character;
    
    this.logger.info(`[Cpp] toVsRange: server L${lineRange.startLineNumber}-${lineRange.endLineNumberInclusive} (1-indexed) -> vscode L${startLine}-${endLine}:${endChar} (0-indexed)`);
    
    return new vscode.Range(new vscode.Position(startLine, startChar), new vscode.Position(endLine, endChar));
  }

  private getApplicableRange(document: vscode.TextDocument, suggestion: RawSuggestion): vscode.Range {
    if (suggestion.lineRange) {
      return this.toVsRange(document, suggestion.lineRange);
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
