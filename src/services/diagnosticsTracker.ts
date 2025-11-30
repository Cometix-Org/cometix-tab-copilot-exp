import * as vscode from 'vscode';
import { ILogger } from '../context/contracts';

/**
 * Cached diagnostics for a document
 */
interface DocumentDiagnostics {
  errors: vscode.Diagnostic[];
  warnings: vscode.Diagnostic[];
  timestamp: number;
}

/**
 * DiagnosticsTracker - Monitors diagnostic changes to trigger completions on linter errors.
 * Maps to Cursor's Ku.LinterErrors trigger source.
 */
export class DiagnosticsTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly documentDiagnostics = new Map<string, DocumentDiagnostics>();
  
  /** Event emitter for when new errors appear that should trigger completion */
  private readonly _onNewErrors = new vscode.EventEmitter<{
    document: vscode.TextDocument;
    position: vscode.Position;
    errors: vscode.Diagnostic[];
  }>();
  readonly onNewErrors = this._onNewErrors.event;

  constructor(private readonly logger: ILogger) {
    this.registerListeners();
  }

  dispose(): void {
    this._onNewErrors.dispose();
    this.disposables.forEach(d => d.dispose());
    this.documentDiagnostics.clear();
  }

  private registerListeners(): void {
    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics(e => this.onDiagnosticsChange(e))
    );
  }

  private onDiagnosticsChange(e: vscode.DiagnosticChangeEvent): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const activeUri = editor.document.uri.toString();
    
    // Check if the active document's diagnostics changed
    const affectedUri = e.uris.find(uri => uri.toString() === activeUri);
    if (!affectedUri) {
      return;
    }

    const diagnostics = vscode.languages.getDiagnostics(affectedUri);
    const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
    const warnings = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Warning);

    const key = affectedUri.toString();
    const previous = this.documentDiagnostics.get(key);

    // Update stored diagnostics
    this.documentDiagnostics.set(key, {
      errors,
      warnings,
      timestamp: Date.now(),
    });

    // Detect new errors (not present before)
    const newErrors = this.findNewErrors(previous?.errors ?? [], errors);
    
    if (newErrors.length > 0) {
      this.logger.info(`[DiagnosticsTracker] ${newErrors.length} new error(s) detected`);
      
      // Find the first new error near cursor, or the first error overall
      const cursorPosition = editor.selection.active;
      const nearbyError = this.findNearestError(newErrors, cursorPosition);
      const triggerPosition = nearbyError?.range.start ?? cursorPosition;
      
      this._onNewErrors.fire({
        document: editor.document,
        position: triggerPosition,
        errors: newErrors,
      });
    }
  }

  /**
   * Find errors that are new (not in previous set)
   */
  private findNewErrors(
    previous: vscode.Diagnostic[],
    current: vscode.Diagnostic[]
  ): vscode.Diagnostic[] {
    return current.filter(curr => {
      return !previous.some(prev => 
        prev.message === curr.message &&
        prev.range.start.line === curr.range.start.line &&
        prev.range.start.character === curr.range.start.character
      );
    });
  }

  /**
   * Find the error nearest to the cursor position
   */
  private findNearestError(
    errors: vscode.Diagnostic[],
    cursorPosition: vscode.Position
  ): vscode.Diagnostic | undefined {
    if (errors.length === 0) {
      return undefined;
    }

    let nearest = errors[0];
    let minDistance = this.lineDistance(errors[0].range.start, cursorPosition);

    for (const error of errors) {
      const distance = this.lineDistance(error.range.start, cursorPosition);
      if (distance < minDistance) {
        minDistance = distance;
        nearest = error;
      }
    }

    return nearest;
  }

  private lineDistance(pos1: vscode.Position, pos2: vscode.Position): number {
    return Math.abs(pos1.line - pos2.line);
  }

  /**
   * Get current errors for a document (for request building)
   */
  getErrors(documentUri: string): vscode.Diagnostic[] {
    const entry = this.documentDiagnostics.get(documentUri);
    return entry?.errors ?? [];
  }

  /**
   * Get current warnings for a document
   */
  getWarnings(documentUri: string): vscode.Diagnostic[] {
    const entry = this.documentDiagnostics.get(documentUri);
    return entry?.warnings ?? [];
  }

  /**
   * Check if document has recent errors (within last N seconds)
   */
  hasRecentErrors(documentUri: string, maxAgeMs = 5000): boolean {
    const entry = this.documentDiagnostics.get(documentUri);
    if (!entry) {
      return false;
    }
    return entry.errors.length > 0 && (Date.now() - entry.timestamp) < maxAgeMs;
  }
}
