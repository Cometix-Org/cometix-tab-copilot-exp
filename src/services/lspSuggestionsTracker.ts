import * as vscode from 'vscode';
import { ILogger } from '../context/contracts';
import { LspSuggestionsContext, ParameterHintsContext } from '../context/types';

/**
 * Cached suggestions for a document
 */
interface DocumentSuggestions {
  suggestions: string[];
  timestamp: number;
}

const SUGGESTIONS_MAX_AGE_MS = 5000; // 5 seconds
const MAX_SUGGESTIONS_PER_DOC = 20;

/**
 * Tracks LSP completion suggestions and parameter hints.
 * Used to provide context about what the user is typing to CPP requests.
 */
export class LspSuggestionsTracker implements vscode.Disposable {
  private readonly documentSuggestions = new Map<string, DocumentSuggestions>();
  private readonly disposables: vscode.Disposable[] = [];

  /** Event emitter for when parameter hints change (signature help appears/changes) */
  private readonly _onParameterHintsChange = new vscode.EventEmitter<{
    document: vscode.TextDocument;
    position: vscode.Position;
  }>();
  readonly onParameterHintsChange = this._onParameterHintsChange.event;

  /** Event emitter for when LSP completions are available */
  private readonly _onCompletionsAvailable = new vscode.EventEmitter<{
    document: vscode.TextDocument;
    position: vscode.Position;
  }>();
  readonly onCompletionsAvailable = this._onCompletionsAvailable.event;

  private currentSignatureHelp: vscode.SignatureHelp | undefined;
  private lastCompletionTriggerTime = 0;
  private readonly completionTriggerDebounceMs = 300;

  constructor(private readonly logger: ILogger) {
    // Track completion item selections - this is triggered when user interacts with completion list
    // Unfortunately VS Code doesn't expose a direct way to track shown completions,
    // so we use the completion provider registration and track what completions are triggered
    
    // Track signature help and LSP completions by listening to document changes
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        this.checkForSignatureHelp(e);
        this.checkForCompletions(e);
      })
    );

    // Clean up old suggestions periodically
    const cleanupInterval = setInterval(() => {
      this.pruneOldSuggestions();
    }, 10000);

    this.disposables.push({
      dispose: () => clearInterval(cleanupInterval),
    });
  }

  /**
   * Check if signature help is available after a document change
   * Triggers ParameterHints event when signature help appears
   */
  private async checkForSignatureHelp(e: vscode.TextDocumentChangeEvent): Promise<void> {
    // Only check if we just typed a trigger character
    if (e.contentChanges.length === 0) {
      return;
    }

    const lastChange = e.contentChanges[e.contentChanges.length - 1];
    const insertedText = lastChange.text;
    
    // Check if we inserted a signature help trigger character
    if (!insertedText.endsWith('(') && !insertedText.endsWith(',')) {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== e.document) {
      return;
    }

    try {
      const position = editor.selection.active;
      const signatureHelp = await vscode.commands.executeCommand<vscode.SignatureHelp>(
        'vscode.executeSignatureHelpProvider',
        e.document.uri,
        position
      );

      if (signatureHelp && signatureHelp.signatures.length > 0) {
        // Check if this is new/different signature help
        const prevSig = this.currentSignatureHelp?.signatures[0]?.label;
        const newSig = signatureHelp.signatures[0]?.label;
        
        if (prevSig !== newSig) {
          this.logger.info(`[LspTracker] Parameter hints changed: ${newSig}`);
          this.currentSignatureHelp = signatureHelp;
          this._onParameterHintsChange.fire({ document: e.document, position });
        }
      } else if (this.currentSignatureHelp) {
        // Signature help disappeared
        this.currentSignatureHelp = undefined;
      }
    } catch {
      // Ignore errors - signature help may not be available
    }
  }

  /**
   * Check if LSP completions are available after a document change
   * Triggers LspSuggestions event when completions are detected
   */
  private async checkForCompletions(e: vscode.TextDocumentChangeEvent): Promise<void> {
    // Only check if we just typed a completion trigger character
    if (e.contentChanges.length === 0) {
      return;
    }

    const now = Date.now();
    if (now - this.lastCompletionTriggerTime < this.completionTriggerDebounceMs) {
      return;
    }

    const lastChange = e.contentChanges[e.contentChanges.length - 1];
    const insertedText = lastChange.text;
    
    // Check if we inserted a completion trigger character
    // Common triggers: `.` for member access, `:` for C++ scope, `>` for arrow operator
    const completionTriggers = ['.', ':', '>', '@', '#', '/', '"', "'", '<'];
    const lastChar = insertedText.slice(-1);
    if (!completionTriggers.includes(lastChar)) {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== e.document) {
      return;
    }

    try {
      const position = editor.selection.active;
      const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        e.document.uri,
        position
      );

      if (completions && completions.items.length > 0) {
        this.lastCompletionTriggerTime = now;
        
        // Record the suggestions for context
        const labels = completions.items
          .slice(0, MAX_SUGGESTIONS_PER_DOC)
          .map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
        this.recordSuggestions(e.document.uri.toString(), labels);
        
        this.logger.info(`[LspTracker] LSP completions available: ${completions.items.length} items`);
        this._onCompletionsAvailable.fire({ document: e.document, position });
      }
    } catch {
      // Ignore errors - completions may not be available
    }
  }

  dispose(): void {
    this._onParameterHintsChange.dispose();
    this._onCompletionsAvailable.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.documentSuggestions.clear();
  }

  /**
   * Record suggestions shown by completions (call this when completions are triggered)
   */
  recordSuggestions(documentUri: string, suggestions: string[]): void {
    const key = documentUri;
    const existing = this.documentSuggestions.get(key);
    
    const newSuggestions = suggestions.slice(0, MAX_SUGGESTIONS_PER_DOC);
    
    if (existing) {
      // Merge with existing, removing duplicates
      const merged = [...new Set([...newSuggestions, ...existing.suggestions])].slice(
        0,
        MAX_SUGGESTIONS_PER_DOC
      );
      this.documentSuggestions.set(key, {
        suggestions: merged,
        timestamp: Date.now(),
      });
    } else {
      this.documentSuggestions.set(key, {
        suggestions: newSuggestions,
        timestamp: Date.now(),
      });
    }

    this.logger.info(`[LspTracker] Recorded ${newSuggestions.length} suggestions for ${key}`);
  }

  /**
   * Record signature help being shown
   */
  recordSignatureHelp(signatureHelp: vscode.SignatureHelp | undefined): void {
    this.currentSignatureHelp = signatureHelp;
  }

  /**
   * Get relevant suggestions for a document
   */
  getRelevantSuggestions(documentUri: string): LspSuggestionsContext {
    const entry = this.documentSuggestions.get(documentUri);
    
    if (!entry || Date.now() - entry.timestamp > SUGGESTIONS_MAX_AGE_MS) {
      return { suggestions: [] };
    }

    return {
      suggestions: entry.suggestions.map((label) => ({ label })),
    };
  }

  /**
   * Get current parameter hints
   */
  getParameterHints(): ParameterHintsContext | undefined {
    if (!this.currentSignatureHelp || this.currentSignatureHelp.signatures.length === 0) {
      return undefined;
    }

    return {
      signatures: this.currentSignatureHelp.signatures.map((sig) => ({
        label: sig.label,
        documentation:
          typeof sig.documentation === 'string'
            ? sig.documentation
            : sig.documentation?.value,
        parameters: sig.parameters.map((param) => ({
          label: typeof param.label === 'string' ? param.label : param.label.join(''),
          documentation:
            typeof param.documentation === 'string'
              ? param.documentation
              : param.documentation?.value,
        })),
      })),
      activeSignature: this.currentSignatureHelp.activeSignature,
      activeParameter: this.currentSignatureHelp.activeParameter,
    };
  }

  /**
   * Clear suggestions for a document
   */
  clearSuggestions(documentUri: string): void {
    this.documentSuggestions.delete(documentUri);
  }

  /**
   * Clear parameter hints
   */
  clearParameterHints(): void {
    this.currentSignatureHelp = undefined;
  }

  /**
   * Remove old suggestion entries
   */
  private pruneOldSuggestions(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [key, entry] of this.documentSuggestions.entries()) {
      if (now - entry.timestamp > SUGGESTIONS_MAX_AGE_MS * 2) {
        toRemove.push(key);
      }
    }

    for (const key of toRemove) {
      this.documentSuggestions.delete(key);
    }
  }

  /**
   * Trigger completion provider to capture suggestions
   * This is a workaround since VS Code doesn't directly expose shown completions
   */
  async captureCompletionsAt(document: vscode.TextDocument, position: vscode.Position): Promise<void> {
    try {
      const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
        'vscode.executeCompletionItemProvider',
        document.uri,
        position
      );

      if (completions && completions.items.length > 0) {
        const labels = completions.items
          .slice(0, MAX_SUGGESTIONS_PER_DOC)
          .map((item) => (typeof item.label === 'string' ? item.label : item.label.label));
        this.recordSuggestions(document.uri.toString(), labels);
      }
    } catch (err) {
      // Ignore errors - completions may not be available
    }
  }
}
