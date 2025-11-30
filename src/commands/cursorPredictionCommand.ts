import * as vscode from 'vscode';
import { Logger } from '../services/logger';
import { CursorPredictionTargetInfo } from '../services/cursorStateMachine';

/**
 * Register the cursor prediction navigation command.
 * This command is used to navigate to the predicted cursor location,
 * especially for cross-file predictions.
 */
export function registerCursorPredictionCommand(
  logger: Logger,
  subscriptions: vscode.Disposable[],
): void {
  const command = vscode.commands.registerCommand(
    'cometix-tab.goToCursorPrediction',
    async (target: CursorPredictionTargetInfo) => {
      if (!target || !target.relativePath || !target.lineNumberOneIndexed) {
        logger.warn('[CursorPrediction] Invalid prediction target');
        return;
      }

      logger.info(
        `[CursorPrediction] Navigating to ${target.relativePath}:${target.lineNumberOneIndexed}`
      );

      try {
        // Find the target file in the workspace
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
          logger.warn('[CursorPrediction] No workspace folder found');
          return;
        }

        // Try to find the file
        const files = await vscode.workspace.findFiles(
          `**/${target.relativePath}`,
          '**/node_modules/**',
          1
        );

        let targetUri: vscode.Uri | undefined;
        
        if (files.length > 0) {
          targetUri = files[0];
        } else {
          // Try constructing the URI directly from the workspace root
          const workspaceRoot = workspaceFolders[0].uri;
          targetUri = vscode.Uri.joinPath(workspaceRoot, target.relativePath);
          
          // Check if file exists
          try {
            await vscode.workspace.fs.stat(targetUri);
          } catch {
            logger.warn(`[CursorPrediction] File not found: ${target.relativePath}`);
            vscode.window.showWarningMessage(`File not found: ${target.relativePath}`);
            return;
          }
        }

        // Open the document
        const document = await vscode.workspace.openTextDocument(targetUri);
        
        // Show the document and navigate to the line
        const lineNumber = Math.max(0, target.lineNumberOneIndexed - 1);
        const lineRange = lineNumber < document.lineCount 
          ? document.lineAt(lineNumber).range
          : new vscode.Range(lineNumber, 0, lineNumber, 0);
        
        const editor = await vscode.window.showTextDocument(document, {
          selection: lineRange,
          preserveFocus: false,
        });

        // Reveal the line in the center of the editor
        editor.revealRange(lineRange, vscode.TextEditorRevealType.InCenter);

        logger.info(
          `[CursorPrediction] Successfully navigated to ${target.relativePath}:${target.lineNumberOneIndexed}`
        );

        // If retrigger is requested, trigger inline suggestions after navigation
        if (target.shouldRetriggerCpp) {
          // Small delay to let the editor settle
          setTimeout(() => {
            void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
          }, 100);
        }
      } catch (error) {
        logger.error('[CursorPrediction] Navigation failed', error);
        vscode.window.showErrorMessage(
          `Failed to navigate to ${target.relativePath}: ${error}`
        );
      }
    }
  );

  subscriptions.push(command);
}
