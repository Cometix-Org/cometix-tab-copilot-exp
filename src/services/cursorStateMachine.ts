import * as vscode from 'vscode';
import { LineRange } from '../rpc/cursor-tab_pb';
import { withRetry } from './retry';
import { RpcClient } from './rpcClient';
import { DocumentTracker } from './documentTracker';
import { Logger } from './logger';
import { ConfigService, CursorFeatureFlags } from './configService';
import { FileSyncCoordinator } from './fileSyncCoordinator';
import { buildStreamRequest } from '../context/requestBuilder';

export interface SuggestionContext {
  readonly document: vscode.TextDocument;
  readonly position: vscode.Position;
  readonly token: vscode.CancellationToken;
}

export interface SuggestionResult {
  readonly text: string;
  readonly range: vscode.Range;
  readonly requestId: string;
  readonly bindingId?: string;
  readonly lineRange?: LineRange;
}

interface RawSuggestion extends Omit<SuggestionResult, 'requestId'> {}

interface FollowupSession {
  readonly document: vscode.Uri;
  readonly queue: RawSuggestion[];
}

interface BindingEntry {
  readonly requestId: string;
  readonly document: vscode.Uri;
}

const MAX_CONCURRENT_STREAMS = 2;

export class CursorStateMachine implements vscode.Disposable {
  private readonly activeStreams = new Map<string, AbortController>();
  private readonly bindingCache = new Map<string, BindingEntry>();
  private readonly requestBindings = new Map<string, Set<string>>();
  private readonly followups = new Map<string, FollowupSession>();
  private requestSeed = 0;
  private flags: CursorFeatureFlags;
  private lastAcceptedRequestId: string | undefined;

  constructor(
    private readonly tracker: DocumentTracker,
    private readonly rpc: RpcClient,
    private readonly logger: Logger,
    private readonly config: ConfigService,
    private readonly fileSync: FileSyncCoordinator,
  ) {
    this.flags = config.flags;
    config.onDidChange((next) => (this.flags = next));
  }

  dispose(): void {
    for (const controller of this.activeStreams.values()) {
      controller.abort();
    }
    this.activeStreams.clear();
    this.followups.clear();
  }

  async requestSuggestion(ctx: SuggestionContext): Promise<SuggestionResult | null> {
    if (!this.flags.enableInlineSuggestions || !this.isEligible(ctx)) {
      return null;
    }

    await this.fileSync.prepareDocument(ctx.document);

    const diagnostics = vscode.languages.getDiagnostics(ctx.document.uri);
    const visibleRanges = Array.from(
      vscode.window.visibleTextEditors.find((editor) => editor.document === ctx.document)?.visibleRanges ?? [],
    );

    const abortController = new AbortController();
    const requestId = `req-${Date.now()}-${this.requestSeed++}`;
    this.registerStream(requestId, abortController);

    const syncPayload = this.fileSync.getSyncPayload(ctx.document);

    try {
      const chunks = await withRetry(
        () =>
          this.consumeStream(
            buildStreamRequest(this.tracker, {
              document: ctx.document,
              position: ctx.position,
              linterDiagnostics: diagnostics,
              visibleRanges,
              filesyncUpdates: syncPayload.updates,
              relyOnFileSync: syncPayload.relyOnFileSync,
              fileVersion: ctx.document.version,
              lineEnding: ctx.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
            }),
            ctx,
            abortController
          ),
        { retries: 2, delayMs: 150 },
      );
      if (chunks.length === 0) {
        return null;
      }
      const [first, ...rest] = chunks;
      if (rest.length) {
        this.followups.set(requestId, { document: ctx.document.uri, queue: rest });
      }
      if (first.bindingId) {
        this.rememberBinding(first.bindingId, requestId, ctx.document.uri);
      }
      return { ...first, requestId };
    } finally {
      this.unregisterStream(requestId);
    }
  }

  async handleAccept(editor: vscode.TextEditor, requestId?: string, bindingId?: string): Promise<void> {
    const resolvedRequestId = this.resolveRequestId(bindingId, requestId, editor.document.uri);
    if (!resolvedRequestId) {
      return;
    }
    this.lastAcceptedRequestId = resolvedRequestId;
    const session = this.followups.get(resolvedRequestId);
    if (session && !session.queue.length) {
      this.followups.delete(resolvedRequestId);
      if (bindingId) {
        this.bindingCache.delete(bindingId);
      }
      this.forgetBindingsForRequest(resolvedRequestId);
    }
  }

  async applyNextEdit(
    editor: vscode.TextEditor,
    requestId?: string,
    bindingId?: string
  ): Promise<boolean> {
    const candidateRequestId = requestId ?? this.lastAcceptedRequestId;
    const targetRequestId = this.resolveRequestId(bindingId, candidateRequestId, editor.document.uri);
    if (!targetRequestId) {
      return false;
    }
    const session = this.followups.get(targetRequestId);
    if (!session || session.document.toString() !== editor.document.uri.toString()) {
      return false;
    }
    const next = session.queue.shift();
    if (!next) {
      this.followups.delete(targetRequestId);
      return false;
    }
    const targetRange = this.getApplicableRange(editor.document, next);
    await editor.edit((builder) => builder.replace(targetRange, next.text));
    if (!session.queue.length) {
      this.followups.delete(targetRequestId);
      if (bindingId) {
        this.bindingCache.delete(bindingId);
      }
      this.forgetBindingsForRequest(targetRequestId);
    }
    return true;
  }

  private async consumeStream(
    request: Parameters<RpcClient['streamCpp']>[0],
    ctx: SuggestionContext,
    abortController: AbortController,
  ): Promise<RawSuggestion[]> {
    const stream = await this.rpc.streamCpp(request, abortController);
    const results: RawSuggestion[] = [];
    let buffer = '';
    let range: LineRange | undefined;
    let bindingId: string | undefined;
    let shouldTrimLeading = false;

    const flush = () => {
      if (!range || !buffer) {
        buffer = '';
        return;
      }
      const text = shouldTrimLeading ? buffer.replace(/^\r?\n/, '') : buffer;
      if (!text) {
        buffer = '';
        return;
      }
      const suggestion = {
        text,
        range: this.toVsRange(ctx.document, range),
        bindingId,
        lineRange: range,
      };
      results.push(suggestion);
      buffer = '';
      shouldTrimLeading = false;
    };

    for await (const chunk of stream) {
      if (ctx.token.isCancellationRequested) {
        abortController.abort();
        return [];
      }
      buffer += chunk.text ?? '';
      if (chunk.rangeToReplace) {
        range = chunk.rangeToReplace;
      }
      if (chunk.bindingId) {
        bindingId = chunk.bindingId;
      }
      if (chunk.shouldRemoveLeadingEol) {
        shouldTrimLeading = true;
      }
      if (chunk.cursorPredictionTarget?.shouldRetriggerCpp) {
        void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
      }
      if (chunk.beginEdit && results.length > 0) {
        flush();
      }
      if (chunk.doneEdit) {
        flush();
      }
    }
    flush();
    return results;
  }

  private isEligible(ctx: SuggestionContext): boolean {
    if (ctx.token.isCancellationRequested) {
      return false;
    }
    if (this.flags.excludedLanguages.includes(ctx.document.languageId)) {
      return false;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor && !editor.selection.isEmpty) {
      return false;
    }
    const line = ctx.document.lineAt(ctx.position.line);
    const trimmed = line?.text.trim() ?? '';
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) {
      return false;
    }
    const sizeLimit = 800_000;
    if (ctx.document.getText().length > sizeLimit) {
      return false;
    }
    return true;
  }

  private registerStream(requestId: string, controller: AbortController): void {
    this.activeStreams.set(requestId, controller);
    if (this.activeStreams.size > MAX_CONCURRENT_STREAMS) {
      const [oldest] = this.activeStreams.keys();
      const abort = this.activeStreams.get(oldest);
      if (abort) {
        abort.abort();
      }
      this.activeStreams.delete(oldest);
      this.logger.warn(`Too many concurrent streams, aborted ${oldest}`);
    }
  }

  private unregisterStream(requestId: string): void {
    const controller = this.activeStreams.get(requestId);
    if (controller) {
      controller.abort();
      this.activeStreams.delete(requestId);
    }
  }

  private toVsRange(document: vscode.TextDocument, lineRange: LineRange): vscode.Range {
    const startLine = Math.max(0, lineRange.startLineNumber - 1);
    const endLine = Math.min(document.lineCount - 1, lineRange.endLineNumberInclusive - 1);
    const startChar = 0;
    const endChar = document.lineAt(endLine).range.end.character;
    return new vscode.Range(new vscode.Position(startLine, startChar), new vscode.Position(endLine, endChar));
  }

  private getApplicableRange(document: vscode.TextDocument, suggestion: RawSuggestion): vscode.Range {
    if (suggestion.lineRange) {
      return this.toVsRange(document, suggestion.lineRange);
    }
    return suggestion.range;
  }

  private rememberBinding(bindingId: string, requestId: string, document: vscode.Uri): void {
    this.bindingCache.set(bindingId, { requestId, document });
    const bindings = this.requestBindings.get(requestId) ?? new Set<string>();
    bindings.add(bindingId);
    this.requestBindings.set(requestId, bindings);
  }

  private resolveRequestId(
    bindingId?: string,
    fallback?: string,
    document?: vscode.Uri
  ): string | undefined {
    if (bindingId) {
      const entry = this.bindingCache.get(bindingId);
      if (entry && (!document || entry.document.toString() === document.toString())) {
        return entry.requestId;
      }
    }
    return fallback;
  }

  private forgetBindingsForRequest(requestId: string): void {
    const bindings = this.requestBindings.get(requestId);
    if (bindings) {
      for (const bindingId of bindings) {
        this.bindingCache.delete(bindingId);
      }
      this.requestBindings.delete(requestId);
    }
  }
}
