export interface CursorFeatureFlags {
  /** Master switch - disables all functionality when false */
  readonly enabled: boolean;
  readonly enableInlineSuggestions: boolean;
  readonly enableCursorPrediction: boolean;
  readonly enableDiagnosticsHints: boolean;
  readonly excludedLanguages: string[];
  readonly enableAdditionalFilesContext: boolean;
  readonly cppTriggerInComments: boolean;
}

/**
 * Debug logging configuration
 */
export interface DebugConfig {
  readonly enabled: boolean;
  readonly logStream: boolean;
  readonly logEditCombine: boolean;
  readonly logFileSync: boolean;
  readonly logRpc: boolean;
  readonly verbosePayloads: boolean;
}

/**
 * Trigger source for CPP (Cursor++) suggestions.
 * Mirrors Cursor's Ku enum for tracking what triggered a completion request.
 */
export enum TriggerSource {
  Unknown = 'unknown',
  LineChange = 'line_change',
  Typing = 'typing',
  OptionHold = 'option_hold',
  LinterErrors = 'lint_errors',
  ParameterHints = 'parameter_hints',
  CursorPrediction = 'cursor_prediction',
  ManualTrigger = 'manual_trigger',
  EditorChange = 'editor_change',
  LspSuggestions = 'lsp_suggestions',
}

/**
 * Intent info sent with CPP requests
 */
export interface CppIntentInfo {
  source: TriggerSource;
}

/**
 * Additional file context for CPP requests
 */
export interface AdditionalFileInfo {
  relativeWorkspacePath: string;
  visibleRangeContent: string[];
  startLineNumberOneIndexed: number[];
  visibleRanges: Array<{
    startLineNumber: number;
    endLineNumberInclusive: number;
  }>;
  isOpen: boolean;
  lastViewedAt?: number;
}

/**
 * LSP suggestion item
 */
export interface LspSuggestionItem {
  label: string;
}

/**
 * LSP suggestions context
 */
export interface LspSuggestionsContext {
  suggestions: LspSuggestionItem[];
}

/**
 * Parameter hints context
 */
export interface ParameterHintsContext {
  signatures: Array<{
    label: string;
    documentation?: string;
    parameters: Array<{
      label: string;
      documentation?: string;
    }>;
  }>;
  activeSignature?: number;
  activeParameter?: number;
}
