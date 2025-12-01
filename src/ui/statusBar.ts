import * as vscode from 'vscode';
import { SnoozeService } from '../services/snoozeService';
import { ServerConfigService } from '../services/serverConfigService';
import { TelemetryService, SessionStatistics } from '../services/telemetryService';
import { EndpointManager, ResolvedEndpoint } from '../services/endpointManager';

/**
 * Status bar state enum
 */
export enum StatusBarState {
  Idle = 'idle',
  Working = 'working',
  Error = 'error',
  Disabled = 'disabled',
  Snoozing = 'snoozing'
}

/**
 * Icons for status bar (similar to Copilot's Icon enum)
 */
export enum StatusIcon {
  Logo = '$(sparkle)',
  Working = '$(loading~spin)',
  Warning = '$(warning)',
  Error = '$(error)',
  Disabled = '$(circle-slash)',
  Snoozing = '$(bell-slash)',
}

/**
 * Status bar item for Cometix Tab
 * Uses StatusBarItem with MarkdownString tooltip for rich hover panel
 * The tooltip stays visible when mouse moves over it
 */
export class StatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private currentState: StatusBarState = StatusBarState.Idle;
  private snoozeService: SnoozeService;
  private serverConfigService: ServerConfigService;
  private telemetryService: TelemetryService | undefined;
  private endpointManager: EndpointManager | undefined;
  private lastStats: SessionStatistics | undefined;
  private lastEndpoint: ResolvedEndpoint | undefined;

  constructor() {
    this.snoozeService = SnoozeService.getInstance();
    this.serverConfigService = ServerConfigService.getInstance();

    // Create status bar item with rich MarkdownString tooltip
    this.statusBarItem = vscode.window.createStatusBarItem(
      'cometix-tab.status',
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.name = 'Cometix Tab';

    // Click opens the statistics menu
    this.statusBarItem.command = 'cometix-tab.showStatusMenu';

    // Listen for state changes
    this.registerListeners();

    // Initial update
    this.updateStatusIndicator();

    // Show the status bar
    this.statusBarItem.show();
  }

  /**
   * Set telemetry service for statistics display
   */
  setTelemetryService(telemetryService: TelemetryService): void {
    this.telemetryService = telemetryService;
    this.lastStats = telemetryService.getStatistics();
    
    this.disposables.push(
      telemetryService.onStatsChanged((stats) => {
        this.lastStats = stats;
        this.updateStatusIndicator();
      })
    );
    
    this.updateStatusIndicator();
  }

  /**
   * Set endpoint manager for endpoint display
   */
  setEndpointManager(endpointManager: EndpointManager): void {
    this.endpointManager = endpointManager;
    this.lastEndpoint = endpointManager.resolveEndpoint();
    
    this.disposables.push(
      endpointManager.onEndpointChanged((endpoint) => {
        this.lastEndpoint = endpoint;
        this.updateStatusIndicator();
      })
    );
    
    this.updateStatusIndicator();
  }

  private registerListeners(): void {
    // Listen for snooze changes
    this.disposables.push(
      this.snoozeService.onSnoozeChanged(() => {
        this.updateStatusIndicator();
      })
    );

    // Listen for config changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('cometixTab')) {
          this.updateStatusIndicator();
        }
      })
    );

    // Listen for server config updates
    this.disposables.push(
      this.serverConfigService.onConfigUpdated(() => {
        this.updateStatusIndicator();
      })
    );

    // Listen for active editor changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.updateStatusIndicator();
      })
    );
  }

  /**
   * Set the current state
   */
  setState(state: StatusBarState): void {
    this.currentState = state;
    this.updateStatusIndicator();
  }

  /**
   * Update status bar display based on current state
   */
  private updateStatusIndicator(): void {
    const vscodeConfig = vscode.workspace.getConfiguration('cometixTab');
    const enabled = vscodeConfig.get<boolean>('enabled', true);

    // Set context for menus
    void vscode.commands.executeCommand('setContext', 'cometix-tab.enabled', enabled);

    // Determine status and update display
    if (!enabled) {
      this.statusBarItem.text = `${StatusIcon.Disabled} Cometix`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.statusBarItem.command = 'cometix-tab.toggleEnabled';
    } else if (this.snoozeService.isSnoozing()) {
      const remaining = this.snoozeService.getRemainingMinutes();
      this.statusBarItem.text = `${StatusIcon.Snoozing} Cometix (${remaining}m)`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.statusBarItem.command = 'cometix-tab.cancelSnooze';
    } else {
      switch (this.currentState) {
        case StatusBarState.Working:
          this.statusBarItem.text = `${StatusIcon.Working} Cometix`;
          this.statusBarItem.backgroundColor = undefined;
          break;

        case StatusBarState.Error:
          this.statusBarItem.text = `${StatusIcon.Error} Cometix`;
          this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
          this.statusBarItem.command = 'cometix-tab.showLogs';
          break;

        case StatusBarState.Idle:
        default:
          this.statusBarItem.text = `${StatusIcon.Logo} Cometix`;
          this.statusBarItem.backgroundColor = undefined;
          this.statusBarItem.command = 'cometix-tab.showStatusMenu';
          break;
      }
    }

    // Update the rich tooltip
    this.statusBarItem.tooltip = this.buildRichTooltip(enabled);
  }

  /**
   * Build rich MarkdownString tooltip with statistics and quick actions
   * This tooltip stays visible when mouse hovers over it
   */
  private buildRichTooltip(enabled: boolean): vscode.MarkdownString {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true; // Allow command links
    md.supportHtml = true;

    // Header with status
    const statusIcon = this.getStatusIcon(enabled);
    const statusText = this.getStatusText(enabled);
    md.appendMarkdown(`### ${statusIcon} Cometix Tab\n\n`);
    md.appendMarkdown(`**Status:** ${statusText}\n\n`);

    // Statistics section
    if (this.lastStats) {
      md.appendMarkdown(`---\n\n`);
      md.appendMarkdown(`#### $(dashboard) Session Statistics\n\n`);
      
      const sessionDuration = this.formatDuration(Date.now() - this.lastStats.sessionStartTime);
      md.appendMarkdown(`$(clock) **Session Duration:** ${sessionDuration}\n\n`);
      
      md.appendMarkdown(`$(code) **Completions Shown:** ${this.lastStats.suggestionCount} total\n\n`);
      
      const acceptRate = this.lastStats.suggestionCount > 0
        ? Math.round(this.lastStats.acceptRate * 100)
        : 0;
      md.appendMarkdown(`$(check) **Accepted:** ${this.lastStats.acceptCount} (${acceptRate}% rate)\n\n`);
      
      md.appendMarkdown(`$(x) **Rejected:** ${this.lastStats.rejectCount}\n\n`);
      
      if (this.lastStats.partialAcceptCount > 0) {
        md.appendMarkdown(`$(checklist) **Partial Accepts:** ${this.lastStats.partialAcceptCount}\n\n`);
      }
      
      if (this.lastStats.totalCharsAccepted > 0) {
        md.appendMarkdown(`$(text-size) **Characters Accepted:** ${this.lastStats.totalCharsAccepted.toLocaleString()}\n\n`);
      }
      
      if (this.lastStats.cursorJumpCount > 0) {
        md.appendMarkdown(`$(arrow-right) **Cursor Jumps:** ${this.lastStats.cursorJumpCount}\n\n`);
      }

      if (this.lastStats.avgGenerationTimeMs > 0) {
        md.appendMarkdown(`$(watch) **Avg Generation Time:** ${this.lastStats.avgGenerationTimeMs}ms\n\n`);
      }
    }

    // Endpoint section
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`#### $(globe) Connection\n\n`);
    
    // Always get fresh endpoint from endpointManager to avoid stale cache
    const currentEndpoint = this.endpointManager?.resolveEndpoint() ?? this.lastEndpoint;
    if (currentEndpoint) {
      const modeLabels: Record<string, string> = {
        official: 'Official',
        auto: 'Automatic',
        custom: 'Custom',
      };
      md.appendMarkdown(`$(plug) **Endpoint Mode:** ${modeLabels[currentEndpoint.mode] || currentEndpoint.mode}\n\n`);
      
      try {
        const hostname = new URL(currentEndpoint.geoCppUrl).hostname;
        md.appendMarkdown(`$(server) **Current Server:** ${hostname}\n\n`);
      } catch {
        md.appendMarkdown(`$(server) **Current Server:** ${currentEndpoint.geoCppUrl}\n\n`);
      }
    }

    // Quick actions section
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`#### $(zap) Quick Actions\n\n`);
    
    if (enabled) {
      md.appendMarkdown(`[$(circle-slash) Disable Completions](command:cometix-tab.toggleEnabled)\n\n`);
      if (!this.snoozeService.isSnoozing()) {
        md.appendMarkdown(`[$(bell-slash) Snooze Completions](command:cometix-tab.showSnoozePicker)\n\n`);
      } else {
        md.appendMarkdown(`[$(bell) Cancel Snooze](command:cometix-tab.cancelSnooze)\n\n`);
      }
    } else {
      md.appendMarkdown(`[$(circle-filled) Enable Completions](command:cometix-tab.toggleEnabled)\n\n`);
    }
    
    md.appendMarkdown(`[$(refresh) Reset Statistics](command:cometix-tab.resetStatistics)\n\n`);
    md.appendMarkdown(`[$(output) Show Logs](command:cometix-tab.showLogs)\n\n`);
    md.appendMarkdown(`[$(settings-gear) Open Settings](command:workbench.action.openSettings?%22cometixTab%22)\n\n`);

    return md;
  }

  /**
   * Get status icon based on current state
   */
  private getStatusIcon(enabled: boolean): string {
    if (!enabled) return '$(circle-slash)';
    if (this.snoozeService.isSnoozing()) return '$(bell-slash)';
    switch (this.currentState) {
      case StatusBarState.Working: return '$(loading~spin)';
      case StatusBarState.Error: return '$(error)';
      default: return '$(sparkle)';
    }
  }

  /**
   * Get status text based on current state
   */
  private getStatusText(enabled: boolean): string {
    if (!enabled) return 'Disabled';
    if (this.snoozeService.isSnoozing()) {
      return `Snoozed (${this.snoozeService.getRemainingMinutes()}m remaining)`;
    }
    switch (this.currentState) {
      case StatusBarState.Working: return 'Generating...';
      case StatusBarState.Error: return 'Error occurred';
      default: return 'Ready';
    }
  }

  /**
   * Format duration in human readable format
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Get current statistics for the picker
   */
  getStatistics(): SessionStatistics | undefined {
    return this.lastStats;
  }

  /**
   * Get current endpoint for the picker
   */
  getEndpoint(): ResolvedEndpoint | undefined {
    // Return fresh endpoint from manager to avoid stale cache
    return this.endpointManager?.resolveEndpoint() ?? this.lastEndpoint;
  }

  dispose(): void {
    this.statusBarItem.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
