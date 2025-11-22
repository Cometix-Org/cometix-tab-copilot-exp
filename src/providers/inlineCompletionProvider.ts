import * as vscode from 'vscode';
import { CursorStateMachine, SuggestionContext } from '../services/cursorStateMachine';

export class CursorInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly listRequestIds = new WeakMap<vscode.InlineCompletionList, { requestId: string; bindingId?: string }>();

  constructor(private readonly stateMachine: CursorStateMachine) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | vscode.InlineCompletionItem[] | null | undefined> {
    const suggestionContext: SuggestionContext = {
      document,
      position,
      token,
      requestUuid: context.requestUuid,
    };
    const suggestion = await this.stateMachine.requestSuggestion(suggestionContext);
    if (!suggestion) {
      return null;
    }

    const item = new vscode.InlineCompletionItem(suggestion.text, suggestion.range);
    item.command = {
      title: 'Cursor Tab Accept',
      command: 'cometix-tab.inlineAccept',
      arguments: [suggestion.requestId, suggestion.bindingId],
    };
    if (suggestion.displayLocation) {
      item.displayLocation = suggestion.displayLocation;
    }
    const list = new vscode.InlineCompletionList([item]);
    this.listRequestIds.set(list, { requestId: suggestion.requestId, bindingId: suggestion.bindingId });
    return list;
  }

  handleDidShowCompletionItem(completionItem: vscode.InlineCompletionItem, _updatedInsertText: string): void {
    // No-op placeholder: could be extended to send telemetry or notify backend.
    const { requestId, bindingId } = this.getSuggestionIdentifiers(completionItem);
    if (requestId || bindingId) {
      this.stateMachine.handleShown(requestId, bindingId);
    }
  }

  // inlineCompletionsAdditions: handle partial accept callbacks to keep Cursor state in sync with VS Code.
  handleDidPartiallyAcceptCompletionItem(
    completionItem: vscode.InlineCompletionItem,
    info: vscode.PartialAcceptInfo
  ): void;
  handleDidPartiallyAcceptCompletionItem(
    completionItem: vscode.InlineCompletionItem,
    acceptedLength: number
  ): void;
  handleDidPartiallyAcceptCompletionItem(
    completionItem: vscode.InlineCompletionItem,
    infoOrLength: vscode.PartialAcceptInfo | number
  ): void {
    if (typeof infoOrLength === 'number') {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const { requestId, bindingId } = this.getSuggestionIdentifiers(completionItem);
    if (!requestId && !bindingId) {
      return;
    }
    void this.stateMachine.handlePartialAccept(editor, requestId, bindingId, infoOrLength);
  }

  handleEndOfLifetime(
    completionItem: vscode.InlineCompletionItem,
    reason: vscode.InlineCompletionEndOfLifeReason
  ): void {
    const { requestId, bindingId } = this.getSuggestionIdentifiers(completionItem);
    if (!requestId) {
      return;
    }
    this.stateMachine.handleCompletionEnd(requestId, bindingId, reason);
  }

  handleListEndOfLifetime(
    list: vscode.InlineCompletionList,
    reason: vscode.InlineCompletionsDisposeReason
  ): void {
    const ids = this.listRequestIds.get(list);
    if (!ids) {
      return;
    }
    this.stateMachine.handleListEnd(ids.requestId, ids.bindingId, reason);
  }

  private getSuggestionIdentifiers(
    completionItem: vscode.InlineCompletionItem
  ): { requestId?: string; bindingId?: string } {
    const args = completionItem.command?.arguments ?? [];
    const [requestId, bindingId] = args;
    return {
      requestId: typeof requestId === 'string' ? requestId : undefined,
      bindingId: typeof bindingId === 'string' ? bindingId : undefined,
    };
  }
}

export function registerInlineCompletionProvider(
  stateMachine: CursorStateMachine,
  subscriptions: vscode.Disposable[]
): void {
  const provider = new CursorInlineCompletionProvider(stateMachine);
  const registration = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: '**' },
    provider,
    { displayName: 'Cometix Tab Inline Completions' }
  );
  subscriptions.push(registration);
}
