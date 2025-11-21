import * as vscode from 'vscode';
import { CursorStateMachine } from '../services/cursorStateMachine';
import { Logger } from '../services/logger';

export function registerNextEditCommand(
  stateMachine: CursorStateMachine,
  logger: Logger,
  subscriptions: vscode.Disposable[],
): void {
  const command = vscode.commands.registerCommand('cometix-tab.applyNextEdit', async (requestId?: string, bindingId?: string) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    try {
      const applied = await stateMachine.applyNextEdit(editor, requestId, bindingId);
      if (!applied) {
        logger.info('No queued Cursor Tab follow-up edits to apply');
      }
    } catch (error) {
      logger.error('Failed to apply next edit', error);
    }
  });
  subscriptions.push(command);
}
