import * as vscode from 'vscode';
import {
  IRpcClient,
  IDocumentTracker,
  IConfigService,
  ILogger,
  ICursorPredictionController,
  IFileSyncCoordinator,
} from '../context/contracts';

/**
 * Coordinates cursor prediction display.
 * 
 * NOTE: The standalone StreamNextCursorPrediction RPC is not implemented on Cursor's server.
 * Cursor prediction now works through the FUSED model - cursor prediction info is returned
 * as part of StreamCppResponse.cursorPredictionTarget, which is handled in cursorStateMachine.ts.
 * 
 * This controller now only manages the decoration display for cursor prediction hints
 * that come through the fused model.
 */
export class CursorPredictionController implements vscode.Disposable, ICursorPredictionController {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
    outline: '1px dashed var(--vscode-textLink-activeForeground)',
  });
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly _tracker: IDocumentTracker,
    private readonly _rpc: IRpcClient,
    private readonly _config: IConfigService,
    private readonly _logger: ILogger,
    private readonly _fileSync: IFileSyncCoordinator
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
  }

  /**
   * Called after a suggestion is accepted.
   * NOTE: The standalone StreamNextCursorPrediction RPC is NOT implemented.
   * Cursor prediction is now handled via the fused model in StreamCppResponse.cursorPredictionTarget.
   */
  async handleSuggestionAccepted(_editor: vscode.TextEditor): Promise<void> {
    // The standalone StreamNextCursorPrediction RPC returns "unimplemented".
    // Cursor prediction is handled via the fused model (cursorPredictionTarget in StreamCppResponse)
    // which is processed in cursorStateMachine.ts and displayed via InlineCompletionItem.displayLocation.
    // This method is kept for interface compatibility but does nothing.
  }

  clearForDocument(document: vscode.TextDocument): void {
    const editors = vscode.window.visibleTextEditors.filter((e) => e.document === document);
    for (const editor of editors) {
      editor.setDecorations(this.decoration, []);
    }
  }

  /**
   * Show a cursor prediction decoration at the specified line.
   * Can be called externally when fused cursor prediction is received.
   */
  showPredictionAt(editor: vscode.TextEditor, line: number): void {
    if (line < 0 || line >= editor.document.lineCount) {
      return;
    }
    const range = editor.document.lineAt(line).range;
    editor.setDecorations(this.decoration, [range]);
  }

}
