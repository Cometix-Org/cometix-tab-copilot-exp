export interface CursorFeatureFlags {
  readonly enableInlineSuggestions: boolean;
  readonly enableCursorPrediction: boolean;
  readonly enableDiagnosticsHints: boolean;
  readonly excludedLanguages: string[];
}
