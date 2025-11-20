import * as vscode from 'vscode';
import { RpcClient } from '../services/rpcClient';
import { DocumentTracker } from '../services/documentTracker';
import { ConfigService } from '../services/configService';
import { Logger } from '../services/logger';
import { buildPredictionRequest } from '../context/requestBuilder';
import { StreamNextCursorPredictionResponse } from '../rpc/cursor-tab_pb';

export class CursorPredictionController implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
    outline: '1px dashed var(--vscode-textLink-activeForeground)',
  });
  private readonly disposables: vscode.Disposable[] = [];
  private pendingTimeout: NodeJS.Timeout | undefined;
  private activeAbort: AbortController | undefined;

  constructor(
    private readonly tracker: DocumentTracker,
    private readonly rpc: RpcClient,
    private readonly config: ConfigService,
    private readonly logger: Logger
  ) {
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((event) => this.schedulePrediction(event.textEditor)),
      vscode.window.onDidChangeActiveTextEditor((editor) => editor && this.schedulePrediction(editor))
    );
  }

  dispose(): void {
    this.decoration.dispose();
    this.disposables.forEach((d) => d.dispose());
    if (this.pendingTimeout) {
      clearTimeout(this.pendingTimeout);
    }
    this.activeAbort?.abort();
  }

  private schedulePrediction(editor?: vscode.TextEditor): void {
    if (!editor || !this.config.flags.enableCursorPrediction) {
      return;
    }
    if (this.pendingTimeout) {
      clearTimeout(this.pendingTimeout);
    }
    this.pendingTimeout = setTimeout(() => this.requestPrediction(editor), 200);
  }

  private async requestPrediction(editor: vscode.TextEditor): Promise<void> {
    if (!this.config.flags.enableCursorPrediction) {
      return;
    }
    const document = editor.document;
    const position = editor.selection.active;
    const request = buildPredictionRequest(this.tracker, {
      document,
      position,
      visibleRanges: Array.from(editor.visibleRanges),
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
      if ((error as Error).name !== 'AbortError') {
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
}
