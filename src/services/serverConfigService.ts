import * as vscode from 'vscode';
import { CppConfigResponse, CppConfigResponse_Heuristic } from '../rpc/cursor-tab_pb';

/**
 * Cached server configuration from CppConfig response
 */
export interface CachedServerConfig {
  readonly fetchedAt: number;
  readonly aboveRadius?: number;
  readonly belowRadius?: number;
  readonly isOn?: boolean;
  readonly isGhostText?: boolean;
  readonly globalDebounceMs?: number;
  readonly clientDebounceMs?: number;
  readonly geoCppBackendUrl?: string;
  readonly cppUrl?: string;
  readonly heuristics: string[];
  readonly isFusedCursorPredictionModel?: boolean;
  readonly includeUnchangedLines?: boolean;
  readonly shouldFetchRvfText?: boolean;
  readonly allowsTabChunks?: boolean;
  readonly tabContextRefreshDebounceMs?: number;
  readonly tabContextRefreshEditorChangeDebounceMs?: number;
}

/**
 * Service to cache and display server configuration (CppConfig response)
 */
export class ServerConfigService implements vscode.Disposable {
  private static instance: ServerConfigService | undefined;
  
  private cachedConfig: CachedServerConfig | undefined;
  private readonly _onConfigUpdated = new vscode.EventEmitter<CachedServerConfig>();
  readonly onConfigUpdated = this._onConfigUpdated.event;

  private constructor() {}

  static getInstance(): ServerConfigService {
    if (!ServerConfigService.instance) {
      ServerConfigService.instance = new ServerConfigService();
    }
    return ServerConfigService.instance;
  }

  /**
   * Update cached config from CppConfigResponse
   */
  updateFromResponse(response: CppConfigResponse): void {
    this.cachedConfig = {
      fetchedAt: Date.now(),
      aboveRadius: response.aboveRadius,
      belowRadius: response.belowRadius,
      isOn: response.isOn,
      isGhostText: response.isGhostText,
      globalDebounceMs: response.globalDebounceDurationMillis,
      clientDebounceMs: response.clientDebounceDurationMillis,
      geoCppBackendUrl: response.geoCppBackendUrl,
      cppUrl: response.cppUrl,
      heuristics: response.heuristics.map(h => this.heuristicToString(h)),
      isFusedCursorPredictionModel: response.isFusedCursorPredictionModel,
      includeUnchangedLines: response.includeUnchangedLines,
      shouldFetchRvfText: response.shouldFetchRvfText,
      allowsTabChunks: response.allowsTabChunks,
      tabContextRefreshDebounceMs: response.tabContextRefreshDebounceMs,
      tabContextRefreshEditorChangeDebounceMs: response.tabContextRefreshEditorChangeDebounceMs,
    };
    this._onConfigUpdated.fire(this.cachedConfig);
  }

  /**
   * Get cached config (may be undefined if never fetched)
   */
  getCachedConfig(): CachedServerConfig | undefined {
    return this.cachedConfig;
  }

  /**
   * Check if config has been fetched
   */
  hasConfig(): boolean {
    return this.cachedConfig !== undefined;
  }

  /**
   * Get time since last fetch in seconds
   */
  getTimeSinceLastFetch(): number | undefined {
    if (!this.cachedConfig) {
      return undefined;
    }
    return Math.floor((Date.now() - this.cachedConfig.fetchedAt) / 1000);
  }

  /**
   * Format config for display in QuickPick or notification
   */
  formatForDisplay(): string[] {
    if (!this.cachedConfig) {
      return ['Server config not yet fetched'];
    }

    const lines: string[] = [];
    const cfg = this.cachedConfig;
    const timeSince = this.getTimeSinceLastFetch();
    
    lines.push(`--- Server Configuration ---`);
    lines.push(`Fetched: ${timeSince}s ago`);
    lines.push('');
    lines.push(`[Feature Flags]`);
    lines.push(`  Is On: ${cfg.isOn ?? 'N/A'}`);
    lines.push(`  Ghost Text: ${cfg.isGhostText ?? 'N/A'}`);
    lines.push(`  Fused Cursor Prediction: ${cfg.isFusedCursorPredictionModel ?? 'N/A'}`);
    lines.push(`  Allows Tab Chunks: ${cfg.allowsTabChunks ?? 'N/A'}`);
    lines.push('');
    lines.push(`[Context Settings]`);
    lines.push(`  Above Radius: ${cfg.aboveRadius ?? 'N/A'} lines`);
    lines.push(`  Below Radius: ${cfg.belowRadius ?? 'N/A'} lines`);
    lines.push(`  Include Unchanged Lines: ${cfg.includeUnchangedLines ?? 'N/A'}`);
    lines.push(`  Should Fetch RVF Text: ${cfg.shouldFetchRvfText ?? 'N/A'}`);
    lines.push('');
    lines.push(`[Timing]`);
    lines.push(`  Global Debounce: ${cfg.globalDebounceMs ?? 'N/A'}ms`);
    lines.push(`  Client Debounce: ${cfg.clientDebounceMs ?? 'N/A'}ms`);
    lines.push(`  Tab Refresh Debounce: ${cfg.tabContextRefreshDebounceMs ?? 'N/A'}ms`);
    lines.push(`  Tab Refresh Editor Change: ${cfg.tabContextRefreshEditorChangeDebounceMs ?? 'N/A'}ms`);
    lines.push('');
    lines.push(`[Endpoints]`);
    lines.push(`  GeoCpp URL: ${cfg.geoCppBackendUrl || 'N/A'}`);
    lines.push(`  Cpp URL: ${cfg.cppUrl || 'N/A'}`);
    lines.push('');
    lines.push(`[Heuristics] (${cfg.heuristics.length})`);
    if (cfg.heuristics.length > 0) {
      cfg.heuristics.forEach(h => lines.push(`  - ${h}`));
    } else {
      lines.push(`  (none enabled)`);
    }

    return lines;
  }

  /**
   * Show config in an output channel or info message
   */
  async showConfig(): Promise<void> {
    const lines = this.formatForDisplay();
    
    // Create or get output channel
    const channel = vscode.window.createOutputChannel('Cometix Tab - Server Config');
    channel.clear();
    lines.forEach(line => channel.appendLine(line));
    channel.show(true);
  }

  private heuristicToString(h: CppConfigResponse_Heuristic): string {
    switch (h) {
      case CppConfigResponse_Heuristic.LOTS_OF_ADDED_TEXT:
        return 'LOTS_OF_ADDED_TEXT';
      case CppConfigResponse_Heuristic.DUPLICATING_LINE_AFTER_SUGGESTION:
        return 'DUPLICATING_LINE_AFTER_SUGGESTION';
      case CppConfigResponse_Heuristic.DUPLICATING_MULTIPLE_LINES_AFTER_SUGGESTION:
        return 'DUPLICATING_MULTIPLE_LINES_AFTER_SUGGESTION';
      case CppConfigResponse_Heuristic.REVERTING_USER_CHANGE:
        return 'REVERTING_USER_CHANGE';
      case CppConfigResponse_Heuristic.OUTPUT_EXTENDS_BEYOND_RANGE_AND_IS_REPEATED:
        return 'OUTPUT_EXTENDS_BEYOND_RANGE_AND_IS_REPEATED';
      case CppConfigResponse_Heuristic.SUGGESTING_RECENTLY_REJECTED_EDIT:
        return 'SUGGESTING_RECENTLY_REJECTED_EDIT';
      default:
        return `UNKNOWN(${h})`;
    }
  }

  dispose(): void {
    this._onConfigUpdated.dispose();
    ServerConfigService.instance = undefined;
  }
}
