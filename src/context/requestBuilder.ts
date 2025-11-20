import * as vscode from 'vscode';
import {
  StreamCppRequest,
  StreamNextCursorPredictionRequest,
  CurrentFileInfo,
  CursorPosition,
  LinterErrors,
  StreamNextCursorPredictionRequest_FileVisibleRange,
  StreamNextCursorPredictionRequest_VisibleRange,
  FilesyncUpdateWithModelVersion,
} from '../rpc/cursor-tab_pb';
import { DocumentTracker } from '../services/documentTracker';

export interface RequestContextOptions {
  readonly document: vscode.TextDocument;
  readonly position: vscode.Position;
  readonly diffHistory?: string[];
  readonly linterDiagnostics?: vscode.Diagnostic[];
  readonly visibleRanges?: vscode.Range[];
  readonly filesyncUpdates?: FilesyncUpdateWithModelVersion[];
}

export function buildStreamRequest(
  tracker: DocumentTracker,
  options: RequestContextOptions
): StreamCppRequest {
  const { currentFile, linterErrors } = buildFileInfo(options);
  const diffHistory = options.diffHistory ?? tracker.getHistory(options.document.uri);

  return new StreamCppRequest({
    currentFile,
    diffHistory,
    linterErrors,
    timeSinceRequestStart: 0,
    timeAtRequestSend: Date.now(),
    contextItems: [],
    filesyncUpdates: options.filesyncUpdates ?? [],
  });
}

export function buildPredictionRequest(
  tracker: DocumentTracker,
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
  const cursorPosition = new CursorPosition({
    line: options.position.line + 1,
    column: options.position.character + 1,
  });

  const currentFile = new CurrentFileInfo({
    relativeWorkspacePath: relativePath,
    contents: options.document.getText(),
    cursorPosition,
    relyOnFilesync: false,
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
  const entries = diagnostics.slice(0, 5).map((diag) => ({
    message: diag.message,
    range: {
      startPosition: new CursorPosition({ line: diag.range.start.line + 1, column: diag.range.start.character + 1 }),
      endPosition: new CursorPosition({ line: diag.range.end.line + 1, column: diag.range.end.character + 1 }),
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
  return new StreamNextCursorPredictionRequest_FileVisibleRange({
    filename: relative,
    visibleRanges: ranges.map(
      (range) =>
        new StreamNextCursorPredictionRequest_VisibleRange({
          startLineNumberInclusive: range.start.line + 1,
          endLineNumberExclusive: range.end.line + 2,
        })
    ),
  });
}
