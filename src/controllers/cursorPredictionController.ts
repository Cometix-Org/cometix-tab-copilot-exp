import * as vscode from 'vscode';
import { ConnectError, Code } from '@connectrpc/connect';
import {
  IRpcClient,
  IDocumentTracker,
  IConfigService,
  ILogger,
  ICursorPredictionController,
  IFileSyncCoordinator,
} from '../context/contracts';
import { buildPredictionRequest } from '../context/requestBuilder';
import { StreamNextCursorPredictionResponse } from '../rpc/cursor-tab_pb';

/**
 * Coordinates when and how cursor prediction RPCs are fired.
 * Triggered explicitly after an inline suggestion is accepted rather than on every cursor move.
 */
export class CursorPredictionController implements vscode.Disposable, ICursorPredictionController {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
    outline: '1px dashed var(--vscode-textLink-activeForeground)',
  });
  private readonly disposables: vscode.Disposable[] = [];
  private activeAbort: AbortController | undefined;

  constructor(
    private readonly tracker: IDocumentTracker,
    private readonly rpc: IRpcClient,
    private readonly config: IConfigService,
    private readonly logger: ILogger,
    private readonly fileSync: IFileSyncCoordinator
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => this.clearForDocument(event.document)),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.clearForDocument(editor.document);
        }
      })
    );
  }

  dispose(): void {
    this.decoration.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.activeAbort?.abort();
  }

  async handleSuggestionAccepted(editor: vscode.TextEditor): Promise<void> {
    if (!this.config.flags.enableCursorPrediction) {
      return;
    }
    await this.requestPrediction(editor);
  }

  clearForDocument(document: vscode.TextDocument): void {
    const editors = vscode.window.visibleTextEditors.filter((e) => e.document === document);
    for (const editor of editors) {
      editor.setDecorations(this.decoration, []);
    }
  }

  private async requestPrediction(editor: vscode.TextEditor): Promise<void> {
    const document = editor.document;
    const position = editor.selection.active;
    const syncPayload = this.fileSync.getSyncPayload(document);
    const request = buildPredictionRequest(this.tracker, {
      document,
      position,
      visibleRanges: Array.from(editor.visibleRanges),
      filesyncUpdates: syncPayload.updates,
      relyOnFileSync: syncPayload.relyOnFileSync,
      fileVersion: document.version,
      lineEnding: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
    });

    this.activeAbort?.abort();
    this.activeAbort = new AbortController();

    try {
      const stream = await this.rpc.streamNextCursorPrediction(request, this.activeAbort);
      for await (const chunk of stream) {
        const range = this.resolveRange(chunk, editor);
        if (range) {
          editor.setDecorations(this.decoration, [range]);
        }
        break;
      }
    } catch (error) {
      if (!this.isAbortError(error)) {
        this.logger.error('Cursor prediction failed', error);
      }
    }
  }

  private resolveRange(
    response: StreamNextCursorPredictionResponse,
    editor: vscode.TextEditor
  ): vscode.Range | null {
    if (!response.response) {
      return null;
    }
    if (response.response.case === 'lineNumber') {
      const line = Math.max(0, response.response.value - 1);
      if (line >= editor.document.lineCount) {
        return null;
      }
      return editor.document.lineAt(line).range;
    }
    if (response.response.case === 'text') {
      const line = editor.selection.active.line;
      const insertPos = new vscode.Position(line, editor.selection.active.character);
      return new vscode.Range(insertPos, insertPos);
    }
    return null;
  }

  private isAbortError(error: unknown): boolean {
    if (!error) {
      return false;
    }
    if (error instanceof ConnectError && error.code === Code.Canceled) {
      return true;
    }
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return true;
      }
      if (/operation was aborted/i.test(error.message)) {
        return true;
      }
    }
    return false;
  }
}
