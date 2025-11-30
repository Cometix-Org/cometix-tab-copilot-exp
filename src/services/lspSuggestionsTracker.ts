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
  private currentSignatureHelp: vscode.SignatureHelp | undefined;

  constructor(private readonly logger: ILogger) {
    // Track completion item selections - this is triggered when user interacts with completion list
    // Unfortunately VS Code doesn't expose a direct way to track shown completions,
    // so we use the completion provider registration and track what completions are triggered
    
    // Track signature help
    this.disposables.push(
      vscode.languages.registerSignatureHelpProvider(
        { pattern: '**' },
        {
          provideSignatureHelp: (doc, pos, token, context) => {
            // This is just to observe - we don't provide our own signature help
            // Return undefined to let other providers handle it
            return undefined;
          },
        },
        '(', ','
      )
    );

    // Clean up old suggestions periodically
    const cleanupInterval = setInterval(() => {
      this.pruneOldSuggestions();
    }, 10000);

    this.disposables.push({
      dispose: () => clearInterval(cleanupInterval),
    });
  }

  dispose(): void {
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
