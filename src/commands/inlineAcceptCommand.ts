import * as vscode from 'vscode';
import { Logger } from '../services/logger';
import { CursorStateMachine } from '../services/cursorStateMachine';

/**
 * Register the inline accept command.
 * This command is called by VS Code when user accepts an inline completion.
 * The command arguments come from item.command set in the InlineCompletionProvider.
 */
export function registerInlineAcceptCommand(
  stateMachine: CursorStateMachine,
  logger: Logger,
  subscriptions: vscode.Disposable[],
): void {
  const command = vscode.commands.registerCommand(
    'cometix-tab.inlineAccept',
    async (
      requestId?: string,
      bindingId?: string,
      nextEditActionId?: string,
      acceptedLength?: number
    ) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      try {
        // Handle accept with telemetry and next action triggering
        await stateMachine.handleAccept(editor, requestId, bindingId, acceptedLength);
        
        // If there's a next edit, trigger inline completion to show it
        // Note: displayNextActionIfAvailable in handleAccept also handles this,
        // but we keep this as a fallback for explicit nextEditActionId
        if (nextEditActionId) {
          logger.info(`[InlineAccept] 🔄 Next edit hint: ${nextEditActionId}`);
        }
      } catch (error) {
        logger.error('Failed to handle inline accept', error);
      }
    }
  );
  subscriptions.push(command);
}
