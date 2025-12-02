import * as vscode from 'vscode';
import { CursorStateMachine, SuggestionContext } from '../services/cursorStateMachine';
import { ILogger } from '../context/contracts';

export class CursorInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly listRequestIds = new WeakMap<vscode.InlineCompletionList, { requestId: string; bindingId?: string }>();
  
  // Proposed API: onDidChange event emitter for provider updates
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly stateMachine: CursorStateMachine,
    private readonly logger: ILogger
  ) {
    // Listen for cached suggestions and trigger refresh
    // This ensures VS Code re-requests completions when a superseded request's result is cached
    this.stateMachine.onSuggestionCached(() => {
      this.logger.info('[InlineCompletion] Cached suggestion available, triggering refresh');
      this._onDidChange.fire();
    });
  }

  /**
   * Trigger a refresh of inline completions
   */
  triggerRefresh(): void {
    this._onDidChange.fire();
  }

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
      // Proposed API: pass timing info from context
      requestIssuedDateTime: context.requestIssuedDateTime,
      earliestShownDateTime: context.earliestShownDateTime,
      // Proposed API: userPrompt - optional user instruction for the completion
      userPrompt: context.userPrompt,
      // VS Code triggerKind: Invoke (0) = manual trigger, Automatic (1) = while typing
      triggerKind: context.triggerKind,
    };
    const suggestion = await this.stateMachine.requestSuggestion(suggestionContext);
    if (!suggestion) {
      return null;
    }

    const item = new vscode.InlineCompletionItem(suggestion.text, suggestion.range);
    
    // For cursor jump hints (no actual edit, just prediction), add navigation command
    if (suggestion.isCursorJumpHint && suggestion.cursorPredictionTarget) {
      item.command = {
        title: 'Go To Predicted Location',
        command: 'cometix-tab.goToCursorPrediction',
        arguments: [suggestion.cursorPredictionTarget],
      };
    } else {
      // Pass nextEditActionId and acceptedLength for telemetry and follow-up handling
      item.command = {
        title: 'Cursor Tab Accept',
        command: 'cometix-tab.inlineAccept',
        arguments: [
          suggestion.requestId,
          suggestion.bindingId,
          suggestion.nextEditActionId,
          suggestion.text.length,  // acceptedLength for telemetry
        ],
      };
    }
    
    // Log if there's a next edit available
    if (suggestion.nextEditActionId) {
      this.logger.info(`[InlineCompletion] 🔄 Next edit available: actionId=${suggestion.nextEditActionId}`);
    }
    
    // Proposed API additions
    // NOTE: completeBracketPairs=true causes VS Code to filter out closing brackets from ghost text
    // This results in only showing `;` instead of `});` - so we disable it
    item.completeBracketPairs = false;
    item.correlationId = suggestion.requestId; // For telemetry tracking
    
    if (suggestion.displayLocation) {
      item.displayLocation = suggestion.displayLocation;
    }
    
    // Proposed API: showRange - specifies when the edit can be shown based on cursor position
    // If not set, defaults to the insert range. Set this for inline edits to allow showing
    // the suggestion when cursor is anywhere in the affected range.
    let showRange: vscode.Range | undefined;
    if (suggestion.showRange) {
      showRange = suggestion.showRange;
      item.showRange = showRange;
    } else if (suggestion.isInlineEdit) {
      // For inline edits, default showRange to the suggestion range
      showRange = suggestion.range;
      item.showRange = showRange;
    }
    
    // Mark as inline edit if it spans multiple lines or replaces content
    // Cursor jump hints are NOT inline edits - they're just navigation hints
    if (suggestion.isInlineEdit && !suggestion.isCursorJumpHint) {
      item.isInlineEdit = true;
      item.showInlineEditMenu = true;
    }
    
    // Log exact InlineCompletionItem properties being returned to VS Code
    const rangeStr = `(${suggestion.range.start.line},${suggestion.range.start.character})-(${suggestion.range.end.line},${suggestion.range.end.character})`;
    const showRangeStr = showRange ? `(${showRange.start.line},${showRange.start.character})-(${showRange.end.line},${showRange.end.character})` : 'undefined';
    const textPreview = suggestion.text.length > 100 
      ? suggestion.text.slice(0, 100).replace(/\n/g, '\\n') + '...' 
      : suggestion.text.replace(/\n/g, '\\n');
    const displayLocationStr = suggestion.displayLocation 
      ? `kind=${suggestion.displayLocation.kind}, label="${suggestion.displayLocation.label}"` 
      : 'undefined';
    
    this.logger.info(`[InlineCompletion] Returning to VS Code:`);
    this.logger.info(`[InlineCompletion]   insertText: "${textPreview}" (${suggestion.text.length} chars)`);
    this.logger.info(`[InlineCompletion]   range: ${rangeStr}`);
    this.logger.info(`[InlineCompletion]   showRange: ${showRangeStr}`);
    this.logger.info(`[InlineCompletion]   isInlineEdit: ${suggestion.isInlineEdit ?? false}`);
    this.logger.info(`[InlineCompletion]   isCursorJumpHint: ${suggestion.isCursorJumpHint ?? false}`);
    this.logger.info(`[InlineCompletion]   displayLocation: ${displayLocationStr}`);
    this.logger.info(`[InlineCompletion]   completeBracketPairs: false`);
    this.logger.info(`[InlineCompletion]   cursor position: (${position.line},${position.character})`);
    
    // Log the original document text at the range
    const originalText = document.getText(suggestion.range);
    this.logger.info(`[InlineCompletion]   original text at range: "${originalText.replace(/\n/g, '\\n')}"`);
    
    const list = new vscode.InlineCompletionList([item]);
    // Proposed API: enable forward stability for consistent suggestions while typing
    list.enableForwardStability = true;
    
    // Proposed API: list.commands - commands shown in the inline completion widget
    // This can be used to show feedback buttons or actions
    list.commands = [
      {
        command: {
          title: 'Accept Next Edit',
          command: 'cometix-tab.applyNextEdit',
          arguments: [suggestion.requestId, suggestion.bindingId],
        },
        icon: new vscode.ThemeIcon('arrow-right'),
      },
    ];
    
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
  logger: ILogger,
  subscriptions: vscode.Disposable[]
): CursorInlineCompletionProvider {
  const provider = new CursorInlineCompletionProvider(stateMachine, logger);
  
  // Proposed API: Use full InlineCompletionItemProviderMetadata
  const metadata: vscode.InlineCompletionItemProviderMetadata = {
    displayName: 'Cometix Tab',
    // Set debounce to 0 for consistent timing (like copilot does)
    debounceDelayMs: 0,
    // GroupId for the yieldTo mechanism
    groupId: 'cometix-tab',
    // Don't yield to other providers - we want our completions shown
    yieldTo: undefined,
    // Don't exclude any providers
    excludes: undefined,
  };
  
  const registration = vscode.languages.registerInlineCompletionItemProvider(
    { pattern: '**' },
    provider,
    metadata
  );
  subscriptions.push(registration);
  return provider;
}
