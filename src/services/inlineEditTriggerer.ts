import * as vscode from 'vscode';
import { ILogger } from '../context/contracts';
import { TriggerSource } from '../context/types';

/**
 * Configuration for inline edit triggering
 */
export interface InlineEditTriggererConfig {
  /** Time window after a change during which cursor movement can trigger suggestion (ms) */
  triggerAfterChangeWindowMs: number;
  /** Cooldown on same line after triggering (ms) */
  sameLineCooldownMs: number;
  /** Cooldown after rejection (ms) */
  rejectionCooldownMs: number;
  /** Whether to enable auto-triggering on document switch */
  triggerOnDocumentSwitch: boolean;
  /** Seconds after last edit when document switch can trigger */
  documentSwitchTriggerAfterSeconds: number;
  /** Debounce time for rapid selection changes (ms) */
  selectionChangeDebounceMs: number;
  /** Debounce time for typing-triggered suggestions (ms) */
  typingDebounceMs: number;
}

const DEFAULT_CONFIG: InlineEditTriggererConfig = {
  triggerAfterChangeWindowMs: 10_000, // 10 seconds like Cursor
  sameLineCooldownMs: 5_000, // 5 seconds
  rejectionCooldownMs: 5_000, // 5 seconds
  triggerOnDocumentSwitch: true,
  documentSwitchTriggerAfterSeconds: 10,
  selectionChangeDebounceMs: 150,
  typingDebounceMs: 75,
};

/**
 * Tracks the last change for a document
 */
interface DocumentChangeInfo {
  lastEditedTimestamp: number;
  lineNumberTriggers: Map<number, number>;
  document: vscode.TextDocument;
  consecutiveSelectionChanges: number;
  debounceTimeout?: NodeJS.Timeout;
}

/**
 * InlineEditTriggerer - Automatically triggers inline suggestions based on cursor movement and edits
 * Similar to vscode-copilot-chat's InlineEditTriggerer
 */
export class InlineEditTriggerer implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly documentChanges = new Map<string, DocumentChangeInfo>();
  
  private config: InlineEditTriggererConfig;
  private lastDocWithSelectionUri: string | undefined;
  private lastEditTimestamp: number | undefined;
  private lastTriggerTime = 0;
  private lastRejectionTime = 0;
  private enabled = true;

  /** Event emitter for when trigger should fire */
  private readonly _onTrigger = new vscode.EventEmitter<{
    document: vscode.TextDocument;
    position: vscode.Position;
    triggerSource: TriggerSource;
  }>();
  readonly onTrigger = this._onTrigger.event;

  constructor(
    private readonly logger: ILogger,
    config?: Partial<InlineEditTriggererConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.registerListeners();
  }

  dispose(): void {
    // Clear all debounce timeouts
    for (const info of this.documentChanges.values()) {
      if (info.debounceTimeout) {
        clearTimeout(info.debounceTimeout);
      }
    }
    this.documentChanges.clear();
    this._onTrigger.dispose();
    this.disposables.forEach(d => d.dispose());
  }

  /**
   * Enable or disable the triggerer
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<InlineEditTriggererConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Record when a suggestion was triggered (for cooldown calculation)
   */
  recordTrigger(): void {
    this.lastTriggerTime = Date.now();
  }

  /**
   * Record when a suggestion was rejected (for cooldown)
   */
  recordRejection(): void {
    this.lastRejectionTime = Date.now();
  }

  private registerListeners(): void {
    // Document change listener
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => this.onDocumentChange(e))
    );
    
    // Selection change listener
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(e => this.onSelectionChange(e))
    );
    
    // Active editor change listener
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(e => this.onActiveEditorChange(e))
    );
  }

  private shouldIgnoreDocument(doc: vscode.TextDocument): boolean {
    // Ignore output pane and other non-file documents (best-effort for diff/peek)
    const s = doc.uri.scheme;
    if (s === 'file' || s === 'untitled') {
      return false;
    }
    const ignoredSchemes = new Set([
      'output',
      'debug',
      'git',
      'vscode-userdata',
      'vscode-notebook-cell',
      'vscode-bulk-edit',
      'walkThroughSnippet',
    ]);
    return ignoredSchemes.has(s);
  }

  private onDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    if (!this.enabled || this.shouldIgnoreDocument(e.document)) {
      return;
    }

    // Ignore undo/redo
    if (e.reason === vscode.TextDocumentChangeReason.Undo || 
        e.reason === vscode.TextDocumentChangeReason.Redo) {
      return;
    }

    this.lastEditTimestamp = Date.now();
    const docKey = e.document.uri.toString();
    
    // Clear existing debounce timeout
    const existing = this.documentChanges.get(docKey);
    if (existing?.debounceTimeout) {
      clearTimeout(existing.debounceTimeout);
    }

    this.documentChanges.set(docKey, {
      lastEditedTimestamp: Date.now(),
      lineNumberTriggers: existing?.lineNumberTriggers ?? new Map(),
      document: e.document,
      consecutiveSelectionChanges: 0,
    });

    // Typing trigger: if active editor matches and selection is a caret, debounce and trigger
    const active = vscode.window.activeTextEditor;
    if (active?.document === e.document && active.selection?.isEmpty) {
      // Capture cursor position immediately before timeout is scheduled
      const cursorPosition = active.selection.start;
      const current = this.documentChanges.get(docKey)!;
      if (current.debounceTimeout) {
        clearTimeout(current.debounceTimeout);
      }
      current.debounceTimeout = setTimeout(() => {
        this.logger.info(`[InlineEditTriggerer] Triggering on typing`);
        this.triggerSuggestion(e.document, cursorPosition, TriggerSource.Typing);
      }, this.config.typingDebounceMs);
    }
  }

  private onSelectionChange(e: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.enabled || this.shouldIgnoreDocument(e.textEditor.document)) {
      return;
    }

    const isSameDoc = this.lastDocWithSelectionUri === e.textEditor.document.uri.toString();
    this.lastDocWithSelectionUri = e.textEditor.document.uri.toString();

    // Ignore multi-selection
    if (e.selections.length !== 1) {
      return;
    }

    // Ignore non-empty selection (user is selecting text)
    if (!e.selections[0].isEmpty) {
      return;
    }

    const now = Date.now();
    const docKey = e.textEditor.document.uri.toString();
    const changeInfo = this.documentChanges.get(docKey);

    // Check rejection cooldown
    if (now - this.lastRejectionTime < this.config.rejectionCooldownMs) {
      // User is moving cursor within cooldown after rejection; skip triggering but keep edit tracking
      this.logger.info(`[InlineEditTriggerer] LineChange skipped: in rejection cooldown (${now - this.lastRejectionTime}ms < ${this.config.rejectionCooldownMs}ms)`);
      return;
    }

    // If no recent edit for this document, try document switch trigger
    if (!changeInfo) {
      this.logger.info(`[InlineEditTriggerer] LineChange skipped: no recent edit for document`);
      this.maybeTriggerOnDocumentSwitch(e, isSameDoc);
      return;
    }

    const timeSinceEdit = now - changeInfo.lastEditedTimestamp;

    // Check if within the trigger window after a change
    if (timeSinceEdit >= this.config.triggerAfterChangeWindowMs) {
      this.logger.info(`[InlineEditTriggerer] LineChange skipped: outside trigger window (${timeSinceEdit}ms > ${this.config.triggerAfterChangeWindowMs}ms)`);
      this.maybeTriggerOnDocumentSwitch(e, isSameDoc);
      return;
    }

    // Check if we've triggered recently
    const timeSinceTrigger = now - this.lastTriggerTime;
    if (timeSinceTrigger >= this.config.triggerAfterChangeWindowMs) {
      // Haven't triggered recently - might be a non-typing cursor move
      this.logger.info(`[InlineEditTriggerer] LineChange skipped: no recent trigger (${timeSinceTrigger}ms > ${this.config.triggerAfterChangeWindowMs}ms)`);
      this.maybeTriggerOnDocumentSwitch(e, isSameDoc);
      return;
    }

    const selectionLine = e.selections[0].start.line;

    // Check same-line cooldown
    const lastTriggerForLine = changeInfo.lineNumberTriggers.get(selectionLine);
    if (lastTriggerForLine !== undefined && now - lastTriggerForLine < this.config.sameLineCooldownMs) {
      this.logger.info(`[InlineEditTriggerer] LineChange skipped: same-line cooldown (${now - lastTriggerForLine}ms < ${this.config.sameLineCooldownMs}ms)`);
      return;
    }

    // Clean up old line triggers if too many
    if (changeInfo.lineNumberTriggers.size > 100) {
      for (const [line, timestamp] of changeInfo.lineNumberTriggers.entries()) {
        if (now - timestamp > this.config.triggerAfterChangeWindowMs) {
          changeInfo.lineNumberTriggers.delete(line);
        }
      }
    }

    // Record this line trigger
    changeInfo.lineNumberTriggers.set(selectionLine, now);
    changeInfo.consecutiveSelectionChanges++;

    // Debounce rapid selection changes
    const N_ALLOWED_IMMEDIATE = 2; // First is from edit, second is user intentional movement
    if (changeInfo.consecutiveSelectionChanges < N_ALLOWED_IMMEDIATE) {
      this.logger.info(`[InlineEditTriggerer] Triggering on line change (immediate, consecutive=${changeInfo.consecutiveSelectionChanges})`);
      this.triggerSuggestion(e.textEditor.document, e.selections[0].start, TriggerSource.LineChange);
    } else {
      // Debounce
      if (changeInfo.debounceTimeout) {
        clearTimeout(changeInfo.debounceTimeout);
      }
      changeInfo.debounceTimeout = setTimeout(() => {
        this.logger.info(`[InlineEditTriggerer] Triggering on line change (debounced)`);
        this.triggerSuggestion(e.textEditor.document, e.selections[0].start, TriggerSource.LineChange);
      }, this.config.selectionChangeDebounceMs);
    }
  }

  private onActiveEditorChange(editor: vscode.TextEditor | undefined): void {
    if (!this.enabled || !editor || this.shouldIgnoreDocument(editor.document)) {
      return;
    }
    
    // Trigger on editor switch (Cursor's Ku.EditorChange)
    const now = Date.now();
    const timeSinceLastTrigger = now - this.lastTriggerTime;
    
    // Only trigger if we haven't triggered recently
    if (timeSinceLastTrigger > this.config.sameLineCooldownMs) {
      this.logger.info('[InlineEditTriggerer] Triggering on editor change');
      this.triggerSuggestion(editor.document, editor.selection.active, TriggerSource.EditorChange);
    }
  }

  private maybeTriggerOnDocumentSwitch(
    e: vscode.TextEditorSelectionChangeEvent,
    isSameDoc: boolean
  ): void {
    if (!this.config.triggerOnDocumentSwitch) {
      return;
    }

    if (isSameDoc) {
      return;
    }

    if (this.lastEditTimestamp === undefined) {
      return;
    }

    const timeSinceLastEdit = Date.now() - this.lastEditTimestamp;
    if (timeSinceLastEdit > this.config.documentSwitchTriggerAfterSeconds * 1000) {
      return;
    }

    // Mark as touched so future cursor moves can trigger
    const docKey = e.textEditor.document.uri.toString();
    const selectionLine = e.selections[0].start.line;
    
    const newInfo: DocumentChangeInfo = {
      lastEditedTimestamp: this.lastEditTimestamp,
      lineNumberTriggers: new Map([[selectionLine, Date.now()]]),
      document: e.textEditor.document,
      consecutiveSelectionChanges: 0,
    };
    this.documentChanges.set(docKey, newInfo);

    this.logger.info('[InlineEditTriggerer] Triggering on document switch');
    this.triggerSuggestion(e.textEditor.document, e.selections[0].start, TriggerSource.EditorChange);
  }

  private triggerSuggestion(
    document: vscode.TextDocument,
    position: vscode.Position,
    triggerSource: TriggerSource
  ): void {
    this.logger.info(`[InlineEditTriggerer] triggerSuggestion: source=${triggerSource}, line=${position.line}, col=${position.character}`);
    this.recordTrigger();
    this._onTrigger.fire({ document, position, triggerSource });
    
    // Also trigger VS Code's inline suggestion
    void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
  }

  /**
   * Manually trigger a suggestion with a specific source
   * Used by external components (e.g., DiagnosticsTracker)
   */
  manualTrigger(
    document: vscode.TextDocument,
    position: vscode.Position,
    triggerSource: TriggerSource
  ): void {
    if (!this.enabled || this.shouldIgnoreDocument(document)) {
      return;
    }
    this.triggerSuggestion(document, position, triggerSource);
  }
}