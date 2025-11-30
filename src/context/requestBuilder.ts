import * as vscode from 'vscode';
import {
  StreamCppRequest,
  StreamCppRequest_ControlToken,
  StreamNextCursorPredictionRequest,
  CurrentFileInfo,
  CursorPosition,
  LinterErrors,
  StreamNextCursorPredictionRequest_FileVisibleRange,
  StreamNextCursorPredictionRequest_VisibleRange,
  FilesyncUpdateWithModelVersion,
  CppIntentInfo,
  AdditionalFile,
  LineRange,
  LspSuggestedItems,
  LspSuggestion,
} from '../rpc/cursor-tab_pb';
import { IDocumentTracker } from './contracts';
import { TriggerSource, AdditionalFileInfo, LspSuggestionsContext } from './types';

export interface RequestContextOptions {
  readonly document: vscode.TextDocument;
  readonly position: vscode.Position;
  readonly diffHistory?: string[];
  readonly linterDiagnostics?: vscode.Diagnostic[];
  readonly visibleRanges?: vscode.Range[];
  readonly filesyncUpdates?: FilesyncUpdateWithModelVersion[];
  readonly relyOnFileSync?: boolean;
  readonly fileVersion?: number;
  readonly contentsOverride?: string;
  readonly lineEnding?: string;
  // New fields for enhanced context
  readonly triggerSource?: TriggerSource;
  readonly additionalFiles?: AdditionalFileInfo[];
  readonly lspSuggestions?: LspSuggestionsContext;
  readonly enableMoreContext?: boolean;
  readonly isManualTrigger?: boolean;
}

export function buildStreamRequest(
  tracker: IDocumentTracker,
  options: RequestContextOptions
): StreamCppRequest {
  const { currentFile, linterErrors } = buildFileInfo(options);
  const diffHistory = options.diffHistory ?? tracker.getHistory(options.document.uri);

  // Build additional files from context
  const additionalFiles = buildAdditionalFiles(options.additionalFiles);

  // Build LSP suggestions
  const lspSuggestedItems = buildLspSuggestions(options.lspSuggestions);

  // Build cpp intent info
  const cppIntentInfo = options.triggerSource
    ? new CppIntentInfo({ source: options.triggerSource })
    : undefined;

  // Control token: OP for manual trigger, undefined otherwise
  const controlToken = options.isManualTrigger
    ? StreamCppRequest_ControlToken.OP
    : undefined;

  return new StreamCppRequest({
    currentFile,
    diffHistory,
    linterErrors,
    timeSinceRequestStart: 0,
    timeAtRequestSend: Date.now(),
    contextItems: [],
    filesyncUpdates: options.filesyncUpdates ?? [],
    // New fields
    cppIntentInfo,
    additionalFiles,
    lspSuggestedItems,
    enableMoreContext: options.enableMoreContext,
    controlToken,
    clientTime: Date.now(),
    clientTimezoneOffset: new Date().getTimezoneOffset(),
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

function buildFileInfo(options: RequestContextOptions): {
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
  const relyOnFileSync = options.relyOnFileSync ?? false;
  const lineEnding =
    options.lineEnding ??
    (options.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
  const contents =
    options.contentsOverride ?? options.document.getText();
  const currentFile = new CurrentFileInfo({
    relativeWorkspacePath: relativePath,
    contents: relyOnFileSync ? '' : contents,
    cursorPosition,
    relyOnFilesync: relyOnFileSync,
    fileVersion: options.fileVersion ?? options.document.version,
    lineEnding,
    // Additional fields matching Cursor client
    languageId: options.document.languageId,
    totalNumberOfLines: options.document.lineCount,
    workspaceRootPath,
  });

  return {
    currentFile,
    linterErrors: buildLinterErrors(options.linterDiagnostics ?? []),
  };
}

function buildLinterErrors(diagnostics: vscode.Diagnostic[]): LinterErrors | undefined {
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
  }));
  return new LinterErrors({ errors: entries });
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
