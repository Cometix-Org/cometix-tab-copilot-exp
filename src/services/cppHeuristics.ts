import * as vscode from 'vscode';
import { ILogger } from '../context/contracts';

/**
 * Heuristic types that can be enabled/disabled via config
 * Similar to Cursor's n5 enum
 */
export enum CppHeuristicType {
  /** Check if suggestion duplicates the line after the suggestion range */
  DUPLICATING_LINE_AFTER_SUGGESTION = 'duplicating_line_after_suggestion',
  /** Check if suggestion is reverting a recent user change */
  REVERTING_USER_CHANGE = 'reverting_user_change',
  /** Check if output extends beyond range and is all repeated content */
  OUTPUT_EXTENDS_BEYOND_RANGE_AND_IS_REPEATED = 'output_extends_beyond_range_and_is_repeated',
}

/**
 * Result of isValidCppCase check
 */
export interface CppValidationResult {
  valid: boolean;
  /** If invalid, whether it's because the change is a no-op */
  isInvalidBecauseNoOp?: boolean;
  /** The potentially modified output text */
  modelOutputText: string;
  /** Reason for invalidity (for logging) */
  invalidReason?: string;
}

/**
 * Configuration for CPP heuristics
 */
export interface CppHeuristicsConfig {
  /** Max file size in characters (default 1M like Cursor's HJo) */
  maxFileSize: number;
  /** Whether to show whitespace-only changes */
  showWhitespaceOnlyChanges: boolean;
  /** Enabled heuristic checks */
  enabledHeuristics: CppHeuristicType[];
  /** Min line distance for cursor prediction suppression */
  cursorPredictionMinLineDistance: number;
}

const DEFAULT_CONFIG: CppHeuristicsConfig = {
  maxFileSize: 1_000_000, // 1M characters like Cursor
  showWhitespaceOnlyChanges: false,
  enabledHeuristics: [
    CppHeuristicType.DUPLICATING_LINE_AFTER_SUGGESTION,
    CppHeuristicType.OUTPUT_EXTENDS_BEYOND_RANGE_AND_IS_REPEATED,
  ],
  cursorPredictionMinLineDistance: 5,
};

/**
 * Info about a recently accepted suggestion for cursor prediction suppression
 */
export interface AcceptedSuggestionInfo {
  readonly uri: vscode.Uri;
  readonly position: vscode.Position;
  readonly timestamp: number;
}

/**
 * CPP Heuristics service - implements Cursor's isValidCppCase and cursor prediction suppression logic
 */
export class CppHeuristicsService implements vscode.Disposable {
  private config: CppHeuristicsConfig;
  
  /** Recently accepted suggestions for cursor prediction suppression */
  private readonly recentlyAcceptedSuggestions: AcceptedSuggestionInfo[] = [];
  private readonly MAX_RECENT_SUGGESTIONS = 10;
  private readonly SUGGESTION_EXPIRY_MS = 30_000; // 30 seconds
  
  /** Whether the last cursor movement was caused by a cursor prediction */
  private lastCursorMoveWasPrediction = false;

  constructor(
    private readonly logger: ILogger,
    config?: Partial<CppHeuristicsConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  dispose(): void {
    this.recentlyAcceptedSuggestions.length = 0;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<CppHeuristicsConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Check if a CPP suggestion is valid (not a no-op, not whitespace-only, etc.)
   * Similar to Cursor's isValidCppCase
   */
  isValidCppCase(
    document: vscode.TextDocument,
    startLineNumber: number,
    endLineNumberInclusive: number,
    modelOutputText: string
  ): CppValidationResult {
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const documentText = document.getText();
    
    // 1. Skip check if file is very large (like Cursor's HJo check)
    if (documentText.length >= this.config.maxFileSize) {
      return { valid: true, modelOutputText };
    }
    
    // 2. Check if it's a no-op (suggestion equals original text)
    const originalRange = new vscode.Range(
      new vscode.Position(startLineNumber - 1, 0),
      new vscode.Position(endLineNumberInclusive - 1, document.lineAt(endLineNumberInclusive - 1).text.length)
    );
    const originalText = document.getText(originalRange);
    
    const isNoOp = this.checkIsNoOp(originalText, modelOutputText, eol);
    if (isNoOp) {
      this.logger.info('[CppHeuristics] Invalid: is NoOp (output equals input)');
      return { valid: false, isInvalidBecauseNoOp: true, modelOutputText, invalidReason: 'noOp' };
    }
    
    // 3. Check for whitespace-only changes
    if (!this.config.showWhitespaceOnlyChanges) {
      const isWhitespaceOnly = this.checkIsWhitespaceOnlyChange(originalText, modelOutputText, eol);
      if (isWhitespaceOnly) {
        this.logger.info('[CppHeuristics] Invalid: whitespace-only changes (showWhitespaceOnlyChanges=false)');
        return { valid: false, isInvalidBecauseNoOp: false, modelOutputText, invalidReason: 'whitespaceOnly' };
      }
    }
    
    const outputLines = modelOutputText.split(eol);
    const documentLines = documentText.split(eol);
    
    // 4. Check for duplicating line after suggestion
    if (
      this.config.enabledHeuristics.includes(CppHeuristicType.DUPLICATING_LINE_AFTER_SUGGESTION) &&
      outputLines.length >= 2
    ) {
      const lastOutputLine = outputLines[outputLines.length - 1];
      const lineAfterSuggestion = documentLines[endLineNumberInclusive]; // 0-indexed, so endLineNumberInclusive is the next line
      
      if (
        lineAfterSuggestion !== undefined &&
        lastOutputLine !== undefined &&
        lastOutputLine.trim() !== '' &&
        lineAfterSuggestion.trim() !== '' &&
        lastOutputLine === lineAfterSuggestion &&
        lastOutputLine.trim() !== '}' &&
        lineAfterSuggestion.trim() !== ']'
      ) {
        this.logger.info('[CppHeuristics] Invalid: duplicating line after suggestion range');
        return { valid: false, isInvalidBecauseNoOp: false, modelOutputText, invalidReason: 'duplicatingLine' };
      }
    }
    
    // 5. Check for output extending beyond range but being all same content
    if (
      this.config.enabledHeuristics.includes(CppHeuristicType.OUTPUT_EXTENDS_BEYOND_RANGE_AND_IS_REPEATED) &&
      outputLines.length > 1
    ) {
      const comparisonLines = documentLines.slice(startLineNumber - 1);
      let allSame = true;
      
      for (let i = 0; i < outputLines.length; i++) {
        // Skip empty last line check
        if (i === outputLines.length - 1 && outputLines[i] === '') continue;
        
        if (outputLines[i] === undefined || comparisonLines[i] === undefined) {
          allSame = false;
          break;
        }
        if (outputLines[i].trim() !== comparisonLines[i].trim()) {
          allSame = false;
          break;
        }
      }
      
      if (allSame) {
        this.logger.info('[CppHeuristics] Invalid: output extends beyond range but is all same content');
        return { valid: false, isInvalidBecauseNoOp: false, modelOutputText, invalidReason: 'repeatedContent' };
      }
    }
    
    return { valid: true, modelOutputText };
  }

  /**
   * Check if output equals input (no-op)
   */
  private checkIsNoOp(originalText: string, outputText: string, _eol: string): boolean {
    // Simple check: if trimmed versions are equal
    return originalText.trim() === outputText.trim();
  }

  /**
   * Check if all changes are whitespace-only
   */
  private checkIsWhitespaceOnlyChange(originalText: string, outputText: string, _eol: string): boolean {
    // Compare non-whitespace characters
    const originalNonWs = originalText.replace(/\s/g, '');
    const outputNonWs = outputText.replace(/\s/g, '');
    return originalNonWs === outputNonWs && originalText !== outputText;
  }

  // ============================================
  // Cursor Prediction Suppression Logic
  // ============================================

  /**
   * Check if cursor prediction is too close to current cursor position
   * Similar to Cursor's isFusedCursorPredictionTooCloseToCursor
   */
  isCursorPredictionTooCloseToCursor(
    predictionLineOneIndexed: number,
    cursorPosition: vscode.Position
  ): boolean {
    const distance = Math.abs(predictionLineOneIndexed - (cursorPosition.line + 1));
    return distance < this.config.cursorPredictionMinLineDistance;
  }

  /**
   * Check if cursor prediction is too close to a recently accepted suggestion
   * Similar to Cursor's isFusedCursorPredictionTooCloseToPreviouslyAcceptedSuggestion
   */
  isCursorPredictionTooCloseToRecentlyAccepted(
    predictionLineOneIndexed: number,
    predictionRelativePath: string
  ): boolean {
    this.pruneExpiredSuggestions();
    
    return this.recentlyAcceptedSuggestions.some((accepted) => {
      const lineDistance = Math.abs(accepted.position.line + 1 - predictionLineOneIndexed);
      const pathMatches = accepted.uri.path.includes(predictionRelativePath);
      return lineDistance < this.config.cursorPredictionMinLineDistance && pathMatches;
    });
  }

  /**
   * Check if last cursor movement was caused by cursor prediction
   * Used to prevent rapid consecutive predictions
   */
  wasLastCursorMovePrediction(): boolean {
    return this.lastCursorMoveWasPrediction;
  }

  /**
   * Mark that a cursor prediction caused the current cursor movement
   */
  markCursorMoveAsPrediction(): void {
    this.lastCursorMoveWasPrediction = true;
  }

  /**
   * Clear the prediction cursor move flag (call on normal user cursor movement)
   */
  clearPredictionCursorMoveFlag(): void {
    this.lastCursorMoveWasPrediction = false;
  }

  /**
   * Record an accepted suggestion for cursor prediction suppression
   */
  recordAcceptedSuggestion(uri: vscode.Uri, position: vscode.Position): void {
    this.pruneExpiredSuggestions();
    
    this.recentlyAcceptedSuggestions.push({
      uri,
      position,
      timestamp: Date.now(),
    });
    
    // Keep only recent suggestions
    while (this.recentlyAcceptedSuggestions.length > this.MAX_RECENT_SUGGESTIONS) {
      this.recentlyAcceptedSuggestions.shift();
    }
  }

  /**
   * Remove expired suggestions from the list
   */
  private pruneExpiredSuggestions(): void {
    const now = Date.now();
    const cutoff = now - this.SUGGESTION_EXPIRY_MS;
    
    while (
      this.recentlyAcceptedSuggestions.length > 0 &&
      this.recentlyAcceptedSuggestions[0].timestamp < cutoff
    ) {
      this.recentlyAcceptedSuggestions.shift();
    }
  }

  /**
   * Check all cursor prediction suppression conditions
   * Returns true if the prediction should be suppressed
   */
  shouldSuppressCursorPrediction(
    predictionLineOneIndexed: number,
    predictionRelativePath: string,
    cursorPosition: vscode.Position
  ): { suppress: boolean; reason?: string } {
    // 1. Check if last move was a prediction
    if (this.wasLastCursorMovePrediction()) {
      this.logger.info('[CppHeuristics] Suppressing cursor prediction: last cursor move was a prediction');
      return { suppress: true, reason: 'lastMoveWasPrediction' };
    }
    
    // 2. Check if too close to recently accepted
    if (this.isCursorPredictionTooCloseToRecentlyAccepted(predictionLineOneIndexed, predictionRelativePath)) {
      this.logger.info('[CppHeuristics] Suppressing cursor prediction: too close to recently accepted suggestion');
      return { suppress: true, reason: 'tooCloseToAccepted' };
    }
    
    // 3. Check if too close to cursor
    if (this.isCursorPredictionTooCloseToCursor(predictionLineOneIndexed, cursorPosition)) {
      this.logger.info('[CppHeuristics] Suppressing cursor prediction: too close to cursor');
      return { suppress: true, reason: 'tooCloseToCursor' };
    }
    
    return { suppress: false };
  }
}
