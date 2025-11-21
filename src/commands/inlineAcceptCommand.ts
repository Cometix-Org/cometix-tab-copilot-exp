import * as vscode from 'vscode';
import { Logger } from '../services/logger';
import { CursorStateMachine } from '../services/cursorStateMachine';

export function registerInlineAcceptCommand(
  stateMachine: CursorStateMachine,
  logger: Logger,
  subscriptions: vscode.Disposable[],
): void {
  const command = vscode.commands.registerCommand(
    'cometix-tab.inlineAccept',
    async (requestId?: string, bindingId?: string) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      try {
        await stateMachine.handleAccept(editor, requestId, bindingId);
      } catch (error) {
        logger.error('Failed to handle inline accept', error);
      }
    }
  );
  subscriptions.push(command);
}
