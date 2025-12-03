import * as vscode from 'vscode';
import {
  StreamCppRequest,
  StreamCppRequest_ControlToken,
  StreamNextCursorPredictionRequest,
  CurrentFileInfo,
  CursorPosition,
  CursorRange,
  LinterErrors,
  StreamNextCursorPredictionRequest_FileVisibleRange,
  StreamNextCursorPredictionRequest_VisibleRange,
  FilesyncUpdateWithModelVersion,
  CppIntentInfo,
  AdditionalFile,
  LineRange,
  LspSuggestedItems,
  LspSuggestion,
  CppFileDiffHistory,
  CppParameterHint,
  CodeResult,
} from '../rpc/cursor-tab_pb';
import { IDocumentTracker } from './contracts';
import { TriggerSource, AdditionalFileInfo, LspSuggestionsContext, ParameterHintsContext } from './types';
import {
  truncateContentAroundCursor,
  calculateSHA256,
  shouldCalculateHash,
} from '../utils/contentProcessor';

export interface RequestContextOptions {
  readonly document: vscode.TextDocument;
  readonly position: vscode.Position;
  /** @deprecated Cursor uses fileDiffHistories instead, this is kept for compatibility */
  readonly diffHistory?: string[];
  readonly linterDiagnostics?: vscode.Diagnostic[];
  readonly visibleRanges?: vscode.Range[];
  /** @deprecated Cursor always sends empty array for filesyncUpdates in streamCpp */
  readonly filesyncUpdates?: FilesyncUpdateWithModelVersion[];
  readonly relyOnFileSync?: boolean;
  readonly fileVersion?: number;
  readonly contentsOverride?: string;
  readonly lineEnding?: string;
  // New fields for enhanced context (matching Cursor)
  readonly triggerSource?: TriggerSource;
  readonly additionalFiles?: AdditionalFileInfo[];
  readonly lspSuggestions?: LspSuggestionsContext;
  readonly enableMoreContext?: boolean;
  readonly isManualTrigger?: boolean;
  // Fields matching Cursor's getStream implementation
  readonly modelName?: string;
  readonly workspaceId?: string;
  readonly parameterHints?: ParameterHintsContext;
  readonly fileDiffHistories?: CppFileDiffHistory[];
  /** Code results fetched via RefreshTabContext */
  readonly codeResults?: CodeResult[];
  /** Time when the request started (performance.now() + performance.timeOrigin) */
  readonly startOfCpp?: number;
  /** Control token from persistent storage (for non-manual triggers) */
  readonly storedControlToken?: StreamCppRequest_ControlToken;
  /** Percentage (0-1) of requests that should include SHA256 hash */
  readonly checkFilesyncHashPercent?: number;
}

export function buildStreamRequest(
  tracker: IDocumentTracker,
  options: RequestContextOptions
): StreamCppRequest {
  const { currentFile, linterErrors } = buildFileInfo(options);

  // Build additional files from context
  const additionalFiles = buildAdditionalFiles(options.additionalFiles);

  // Build LSP suggestions
  const lspSuggestedItems = buildLspSuggestions(options.lspSuggestions);

  // Build parameter hints
  const parameterHints = buildParameterHints(options.parameterHints);

  // Build cpp intent info
  const cppIntentInfo = options.triggerSource
    ? new CppIntentInfo({ source: options.triggerSource })
    : undefined;

  // Control token: OP for manual trigger, otherwise read from storage
  // Matches Cursor's behavior: source === Ku.ManualTrigger ? Gie.OP : pb.applicationUserPersistentStorage.cppControlToken
  const controlToken = options.isManualTrigger
    ? StreamCppRequest_ControlToken.OP
    : options.storedControlToken;

  // Calculate timeSinceRequestStart like Cursor does
  const now = performance.now() + performance.timeOrigin;
  const timeSinceRequestStart = options.startOfCpp ? now - options.startOfCpp : 0;

  // Build request matching Cursor's getStream implementation exactly
  // Key insight: Cursor sends diffHistory as empty array, uses fileDiffHistories instead
  return new StreamCppRequest({
    // Core file info
    currentFile,
    linterErrors,
    
    // Diff history: Cursor sends empty diffHistory, uses fileDiffHistories
    diffHistory: [],  // Always empty in Cursor
    diffHistoryKeys: [],  // Always empty in Cursor
    fileDiffHistories: options.fileDiffHistories ?? [],
    mergedDiffHistories: [],  // Always empty in Cursor
    blockDiffPatches: [],  // Always empty in Cursor
    
    // Context items: Always empty in Cursor
    contextItems: [],
    lspContexts: [],  // Always empty in Cursor
    
    // Model and workspace
    modelName: options.modelName,
    workspaceId: options.workspaceId,
    
    // Additional context
    additionalFiles,
    parameterHints,
    lspSuggestedItems,
    enableMoreContext: options.enableMoreContext,
    codeResults: options.codeResults ?? [],
    
    // Intent and control
    cppIntentInfo,
    controlToken,
    
    // Timing
    timeSinceRequestStart,
    timeAtRequestSend: Date.now(),
    clientTime: Date.now(),
    clientTimezoneOffset: new Date().getTimezoneOffset(),
    
    // FileSync: Cursor always sends empty array in streamCpp
    filesyncUpdates: [],
  });
}

/**
 * Build AdditionalFile proto messages from context
 */
function buildAdditionalFiles(files?: AdditionalFileInfo[]): AdditionalFile[] {
  if (!files || files.length === 0) {
    return [];
  }

  return files.map((file) => {
    const visibleRanges = file.visibleRanges.map(
      (range) =>
        new LineRange({
          startLineNumber: range.startLineNumber,
          endLineNumberInclusive: range.endLineNumberInclusive,
        })
    );

    return new AdditionalFile({
      relativeWorkspacePath: file.relativeWorkspacePath,
      isOpen: file.isOpen,
      visibleRangeContent: file.visibleRangeContent,
      startLineNumberOneIndexed: file.startLineNumberOneIndexed,
      visibleRanges,
      lastViewedAt: file.lastViewedAt,
    });
  });
}

/**
 * Build LspSuggestedItems proto message from context
 */
function buildLspSuggestions(context?: LspSuggestionsContext): LspSuggestedItems | undefined {
  if (!context || context.suggestions.length === 0) {
    return undefined;
  }

  return new LspSuggestedItems({
    suggestions: context.suggestions.map((s) => new LspSuggestion({ label: s.label })),
  });
}

/**
 * Build CppParameterHint proto messages from context
 * Matching Cursor's Eb.getRelevantParameterHints() behavior:
 * - Filter signatures with label length < 5000
 * - Limit to 2 signatures
 * - Extract label and documentation
 */
function buildParameterHints(context?: ParameterHintsContext): CppParameterHint[] {
  if (!context || context.signatures.length === 0) {
    return [];
  }

  // Match Cursor's filtering: label < 5000 chars, max 2 signatures
  return context.signatures
    .filter((sig) => sig.label.length < 5000)
    .slice(0, 2)
    .map(
      (sig) =>
        new CppParameterHint({
          label: sig.label,
          documentation: sig.documentation,
        })
    );
}

export function buildPredictionRequest(
  tracker: IDocumentTracker,
  options: RequestContextOptions
): StreamNextCursorPredictionRequest {
  const { currentFile, linterErrors } = buildFileInfo(options);
  const diffHistory = options.diffHistory ?? tracker.getHistory(options.document.uri);

  const visibleRangeMessage = buildFileVisibleRange(options.document, options.visibleRanges ?? []);

  return new StreamNextCursorPredictionRequest({
    currentFile,
    diffHistory,
    linterErrors,
    fileSyncUpdates: options.filesyncUpdates ?? [],
    fileVisibleRanges: visibleRangeMessage ? [visibleRangeMessage] : [],
  });
}

export function buildFileInfo(options: RequestContextOptions): {
  currentFile: CurrentFileInfo;
  linterErrors?: LinterErrors;
} {
  const relativePath = vscode.workspace.asRelativePath(options.document.uri, false);
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(options.document.uri);
  const workspaceRootPath = workspaceFolder?.uri.fsPath ?? '';
  
  // Use 0-indexed cursor position (same as Cursor client)
  const cursorPosition = new CursorPosition({
    line: options.position.line,
    column: options.position.character,
  });

  // Build selection range from active editor if available; fallback to cursor position
  let selectionRange: CursorRange | undefined;
  try {
    const editor =
      vscode.window.activeTextEditor?.document === options.document
        ? vscode.window.activeTextEditor
        : vscode.window.visibleTextEditors.find((e) => e.document === options.document);
    const sel = editor?.selection;
    const start = sel?.start ?? options.position;
    const end = sel?.end ?? options.position;
    selectionRange = new CursorRange({
      startPosition: new CursorPosition({ line: start.line, column: start.character }),
      endPosition: new CursorPosition({ line: end.line, column: end.character }),
    });
  } catch {
    // ignore failures and leave selection undefined
  }
  const relyOnFileSync = options.relyOnFileSync ?? false;
  const lineEnding =
    options.lineEnding ??
    (options.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
  
  // Get raw content
  const rawContents = options.contentsOverride ?? options.document.getText();
  
  // Calculate SHA256 hash based on config
  // IMPORTANT: Always hash the ORIGINAL (raw) content, not truncated/empty content
  // This is used for filesync verification - server needs hash of full file content
  // Matches Cursor's rc() function:
  // - Always calculate if relyOnFileSync is true (for verification)
  // - Otherwise calculate based on checkFilesyncHashPercent probability
  let sha256Hash: string | undefined;
  if (shouldCalculateHash(relyOnFileSync, options.checkFilesyncHashPercent ?? 0)) {
    sha256Hash = calculateSHA256(rawContents);
  }
  
  // Apply content truncation when NOT relying on file sync
  // Matches Cursor's lc() function: truncate to 300 lines before/after cursor
  // When relyOnFileSync=true, contents is empty (server uses its synced version)
  let contents = '';
  let contentsStartAtLine = 0;
  
  if (!relyOnFileSync) {
    const truncationResult = truncateContentAroundCursor(
      rawContents,
      options.position.line,
      lineEnding
    );
    contents = truncationResult.contents;
    contentsStartAtLine = truncationResult.contentsStartAtLine;
  }

  const currentFile = new CurrentFileInfo({
    relativeWorkspacePath: relativePath,
    contents,
    cursorPosition,
    relyOnFilesync: relyOnFileSync,
    fileVersion: options.fileVersion ?? options.document.version,
    lineEnding,
    // SHA256 hash based on config
    sha256Hash,
    // Start line when content is truncated
    contentsStartAtLine,
    // Selection (range) info
    selection: selectionRange,
    // IMPORTANT: Cursor sends empty string for languageId
    // This is intentional - the server determines language from file extension
    languageId: '',
    // IMPORTANT: Cursor does NOT send totalNumberOfLines
    // We explicitly omit it (proto default is 0, but Cursor doesn't set it)
    // totalNumberOfLines is commented out to match Cursor behavior
    // workspaceRootPath is sent by Cursor
    workspaceRootPath,
  });

  return {
    currentFile,
    linterErrors: buildLinterErrors(options.linterDiagnostics ?? [], options.document),
  };
}

function buildLinterErrors(diagnostics: vscode.Diagnostic[], document?: vscode.TextDocument): LinterErrors | undefined {
  if (diagnostics.length === 0) {
    return undefined;
  }
  // Use 0-indexed positions (same as Cursor client)
  const entries = diagnostics.slice(0, 5).map((diag) => ({
    message: diag.message,
    range: {
      startPosition: new CursorPosition({ line: diag.range.start.line, column: diag.range.start.character }),
      endPosition: new CursorPosition({ line: diag.range.end.line, column: diag.range.end.character }),
    },
    source: diag.source ?? undefined,
    // Map VS Code severity to proto DiagnosticSeverity
    severity:
      diag.severity === vscode.DiagnosticSeverity.Error ? 1 :
      diag.severity === vscode.DiagnosticSeverity.Warning ? 2 :
      diag.severity === vscode.DiagnosticSeverity.Information ? 3 :
      diag.severity === vscode.DiagnosticSeverity.Hint ? 4 : undefined,
    relatedInformation: (diag.relatedInformation ?? []).map((ri) => ({
      message: ri.message,
      range: {
        startPosition: new CursorPosition({ line: ri.location.range.start.line, column: ri.location.range.start.character }),
        endPosition: new CursorPosition({ line: ri.location.range.end.line, column: ri.location.range.end.character }),
      },
    })),
  }));

  const rel = document ? vscode.workspace.asRelativePath(document.uri, false) : '';
  const contents = document ? document.getText() : '';
  return new LinterErrors({
    relativeWorkspacePath: rel,
    fileContents: contents,
    errors: entries,
  });
}

function buildFileVisibleRange(
  document: vscode.TextDocument,
  ranges: vscode.Range[]
): StreamNextCursorPredictionRequest_FileVisibleRange | undefined {
  if (!ranges.length) {
    return undefined;
  }

  const relative = vscode.workspace.asRelativePath(document.uri, false);
  // Use 0-indexed line numbers (same as Cursor client)
  return new StreamNextCursorPredictionRequest_FileVisibleRange({
    filename: relative,
    visibleRanges: ranges.map(
      (range) =>
        new StreamNextCursorPredictionRequest_VisibleRange({
          startLineNumberInclusive: range.start.line,
          endLineNumberExclusive: range.end.line + 1,
        })
    ),
  });
}
