import * as vscode from 'vscode';

/**
 * Debug log categories - each can be enabled/disabled independently
 */
export enum DebugCategory {
  /** File synchronization operations */
  FileSync = 'fileSync',
  /** Stream processing and chunks */
  Stream = 'stream',
  /** Edit combination and range calculation */
  EditCombine = 'editCombine',
  /** RPC requests and responses */
  Rpc = 'rpc',
  /** Debounce and request management */
  Debounce = 'debounce',
  /** Telemetry events */
  Telemetry = 'telemetry',
  /** Inline completion provider */
  Provider = 'provider',
  /** Document tracking and diff history */
  DocTracker = 'docTracker',
}

export interface DebugLoggerConfig {
  /** Master switch for all debug logging */
  enabled: boolean;
  /** Per-category enable/disable */
  categories: Partial<Record<DebugCategory, boolean>>;
  /** Log full content of large payloads (can be verbose) */
  verbosePayloads: boolean;
  /** Maximum length for truncated payloads */
  maxPayloadLength: number;
}

const DEFAULT_CONFIG: DebugLoggerConfig = {
  enabled: true,
  categories: {
    [DebugCategory.FileSync]: true,
    [DebugCategory.Stream]: true,
    [DebugCategory.EditCombine]: true,
    [DebugCategory.Rpc]: true,
    [DebugCategory.Debounce]: true,
    [DebugCategory.Telemetry]: true,
    [DebugCategory.Provider]: false,
    [DebugCategory.DocTracker]: false,
  },
  verbosePayloads: false,
  maxPayloadLength: 500,
};

export class DebugLogger {
  private static instance: DebugLogger | undefined;
  private config: DebugLoggerConfig;
  private outputChannel: vscode.OutputChannel | undefined;

  private constructor(private readonly baseLogger: { info: (msg: string) => void; error: (msg: string) => void }) {
    this.config = { ...DEFAULT_CONFIG };
  }

  static getInstance(baseLogger?: { info: (msg: string) => void; error: (msg: string) => void }): DebugLogger {
    if (!DebugLogger.instance) {
      if (!baseLogger) {
        throw new Error('DebugLogger must be initialized with a base logger');
      }
      DebugLogger.instance = new DebugLogger(baseLogger);
    }
    return DebugLogger.instance;
  }

  /**
   * Create a dedicated output channel for verbose debug logs
   */
  createOutputChannel(): vscode.OutputChannel {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel('Cometix Tab Debug', { log: true });
    }
    return this.outputChannel;
  }

  /**
   * Update debug configuration
   */
  configure(config: Partial<DebugLoggerConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.categories) {
      this.config.categories = { ...this.config.categories, ...config.categories };
    }
  }

  /**
   * Enable/disable a specific category
   */
  setCategory(category: DebugCategory, enabled: boolean): void {
    this.config.categories[category] = enabled;
  }

  /**
   * Check if a category is enabled
   */
  isCategoryEnabled(category: DebugCategory): boolean {
    return this.config.enabled && (this.config.categories[category] ?? false);
  }

  /**
   * Log a debug message for a specific category
   */
  log(category: DebugCategory, message: string, data?: any): void {
    if (!this.isCategoryEnabled(category)) {
      return;
    }

    const prefix = `[DEBUG:${category}]`;
    let fullMessage = `${prefix} ${message}`;

    if (data !== undefined) {
      const dataStr = this.formatData(data);
      fullMessage += ` ${dataStr}`;
    }

    this.baseLogger.info(fullMessage);

    // Also log to dedicated output channel if available
    if (this.outputChannel && this.config.verbosePayloads) {
      this.outputChannel.appendLine(fullMessage);
    }
  }

  /**
   * Log an error for a specific category
   */
  error(category: DebugCategory, message: string, error?: any): void {
    if (!this.config.enabled) {
      return;
    }

    const prefix = `[DEBUG:${category}:ERROR]`;
    let fullMessage = `${prefix} ${message}`;

    if (error !== undefined) {
      fullMessage += ` :: ${error?.message ?? String(error)}`;
    }

    this.baseLogger.error(fullMessage);
  }

  /**
   * Format data for logging, respecting verbosity settings
   */
  private formatData(data: any): string {
    try {
      const jsonStr = JSON.stringify(data);
      if (this.config.verbosePayloads || jsonStr.length <= this.config.maxPayloadLength) {
        return jsonStr;
      }
      return jsonStr.slice(0, this.config.maxPayloadLength) + '...[truncated]';
    } catch {
      return String(data);
    }
  }

  /**
   * Log stream chunk with detailed info
   */
  logStreamChunk(chunkIndex: number, chunk: any, requestId: string): void {
    if (!this.isCategoryEnabled(DebugCategory.Stream)) {
      return;
    }

    const chunkType = this.getChunkType(chunk);
    const summary = this.summarizeChunk(chunk);
    
    this.log(DebugCategory.Stream, 
      `Chunk #${chunkIndex} [${requestId.slice(0, 8)}] type=${chunkType}`,
      summary
    );
  }

  private getChunkType(chunk: any): string {
    if (chunk.rangeToReplace) return 'rangeToReplace';
    if (chunk.text) return 'text';
    if (chunk.beginEdit) return 'beginEdit';
    if (chunk.doneEdit) return 'doneEdit';
    if (chunk.cursorPredictionTarget) return 'cursorPrediction';
    return 'unknown';
  }

  private summarizeChunk(chunk: any): any {
    const summary: any = {};
    
    if (chunk.rangeToReplace) {
      summary.range = `L${chunk.rangeToReplace.startLineNumber}-${chunk.rangeToReplace.endLineNumberInclusive}`;
    }
    if (chunk.text !== undefined) {
      const textPreview = chunk.text.length > 50 
        ? chunk.text.slice(0, 50) + '...' 
        : chunk.text;
      summary.text = textPreview.replace(/\n/g, '\\n');
      summary.textLen = chunk.text.length;
    }
    if (chunk.bindingId) {
      summary.bindingId = chunk.bindingId.slice(0, 16) + '...';
    }
    if (chunk.shouldRemoveLeadingEol) {
      summary.trimLeading = true;
    }
    if (chunk.beginEdit) summary.beginEdit = true;
    if (chunk.doneEdit) summary.doneEdit = true;
    
    return summary;
  }

  /**
   * Log edit combination details
   */
  logEditCombination(
    edits: Array<{ range: { startLineNumber: number; endLineNumberInclusive: number }; text: string }>,
    originalLines: string[],
    combinedText: string,
    finalRange: { startLine: number; endLine: number }
  ): void {
    if (!this.isCategoryEnabled(DebugCategory.EditCombine)) {
      return;
    }

    this.log(DebugCategory.EditCombine, `Combining ${edits.length} edits:`);
    
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];
      const textPreview = edit.text.length > 80 
        ? edit.text.slice(0, 80) + '...' 
        : edit.text;
      this.log(DebugCategory.EditCombine, 
        `  Edit ${i + 1}: L${edit.range.startLineNumber}-${edit.range.endLineNumberInclusive} -> "${textPreview.replace(/\n/g, '\\n')}"`
      );
    }

    this.log(DebugCategory.EditCombine, 
      `Original lines (${originalLines.length}): ${originalLines.map((l, i) => `\n    ${finalRange.startLine + i}: ${l.slice(0, 60)}`).join('')}`
    );
    
    this.log(DebugCategory.EditCombine,
      `Combined result (${combinedText.length} chars): range L${finalRange.startLine}-${finalRange.endLine}`
    );
  }

  /**
   * Log document context for completion request
   */
  logCompletionContext(
    document: vscode.TextDocument,
    position: vscode.Position,
    surroundingLines: number = 3
  ): void {
    if (!this.isCategoryEnabled(DebugCategory.Provider)) {
      return;
    }

    const startLine = Math.max(0, position.line - surroundingLines);
    const endLine = Math.min(document.lineCount - 1, position.line + surroundingLines);
    
    const lines: string[] = [];
    for (let i = startLine; i <= endLine; i++) {
      const line = document.lineAt(i);
      const prefix = i === position.line ? '>>>' : '   ';
      const cursor = i === position.line 
        ? `${' '.repeat(position.character)}^` 
        : '';
      lines.push(`${prefix} ${i + 1}: ${line.text}`);
      if (cursor) {
        lines.push(`    ${cursor}`);
      }
    }

    this.log(DebugCategory.Provider, 
      `Completion context at ${document.fileName}:${position.line + 1}:${position.character + 1}:\n${lines.join('\n')}`
    );
  }
}

// Export singleton accessor
export function getDebugLogger(): DebugLogger {
  return DebugLogger.getInstance();
}
