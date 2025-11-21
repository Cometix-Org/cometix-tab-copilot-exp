import * as vscode from 'vscode';
import { CursorStateMachine, SuggestionContext } from '../services/cursorStateMachine';

export class CursorInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  constructor(private readonly stateMachine: CursorStateMachine) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | vscode.InlineCompletionItem[] | null | undefined> {
    const context: SuggestionContext = { document, position, token };
    const suggestion = await this.stateMachine.requestSuggestion(context);
    if (!suggestion) {
      return null;
    }

    const item = new vscode.InlineCompletionItem(suggestion.text, suggestion.range);
    item.command = {
      title: 'Cursor Tab Accept',
      command: 'cometix-tab.inlineAccept',
      arguments: [suggestion.requestId, suggestion.bindingId],
    };
    return [item];
  }
}

export function registerInlineCompletionProvider(
  stateMachine: CursorStateMachine,
  subscriptions: vscode.Disposable[]
): void {
  const provider = new CursorInlineCompletionProvider(stateMachine);
  const registration = vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider);
  subscriptions.push(registration);
}
