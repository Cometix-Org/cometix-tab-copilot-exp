import * as vscode from 'vscode';
import { SnoozeService } from '../services/snoozeService';
import { ServerConfigService } from '../services/serverConfigService';

export enum StatusBarState {
  Idle = 'idle',
  Working = 'working',
  Error = 'error',
  Disabled = 'disabled',
  Snoozing = 'snoozing'
}

interface StatusBarConfig {
  text: string;
  icon: string;
  color?: vscode.ThemeColor;
  tooltip: string;
}

/**
 * Status bar item for Cometix Tab
 * Shows current state and provides quick access to menu
 */
export class StatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private currentState: StatusBarState = StatusBarState.Idle;
  private snoozeService: SnoozeService;
  private serverConfigService: ServerConfigService;

  constructor() {
    this.snoozeService = SnoozeService.getInstance();
    this.serverConfigService = ServerConfigService.getInstance();

    // Create status bar item (right side, priority 100)
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );

    // Click opens the menu
    this.statusBarItem.command = 'cometix-tab.showStatusMenu';

    // Listen for state changes
    this.registerListeners();

    // Initial update
    this.updateStatus();

    // Show the status bar
    this.statusBarItem.show();
  }

  private registerListeners(): void {
    // Listen for snooze changes
    this.disposables.push(
      this.snoozeService.onSnoozeChanged(() => {
        this.updateStatus();
      })
    );

    // Listen for config changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('cometixTab')) {
          this.updateStatus();
        }
      })
    );

    // Listen for server config updates
    this.disposables.push(
      this.serverConfigService.onConfigUpdated(() => {
        this.updateStatus();
      })
    );
  }

  /**
   * Set the current state
   */
  setState(state: StatusBarState): void {
    this.currentState = state;
    this.updateStatus();
  }

  /**
   * Update status bar display based on current state
   */
  private updateStatus(): void {
    const config = this.getStatusConfig();
    
    this.statusBarItem.text = `${config.icon} ${config.text}`;
    this.statusBarItem.tooltip = config.tooltip;
    
    if (config.color) {
      this.statusBarItem.backgroundColor = config.color;
    } else {
      this.statusBarItem.backgroundColor = undefined;
    }
  }

  private getStatusConfig(): StatusBarConfig {
    const vscodeConfig = vscode.workspace.getConfiguration('cometixTab');
    const enabled = vscodeConfig.get<boolean>('enabled', true);

    // Check if disabled
    if (!enabled) {
      return {
        icon: '$(circle-slash)',
        text: 'Cometix',
        tooltip: 'Cometix Tab: Disabled (click to enable)',
        color: new vscode.ThemeColor('statusBarItem.warningBackground')
      };
    }

    // Check if snoozing
    if (this.snoozeService.isSnoozing()) {
      const remaining = this.snoozeService.getRemainingMinutes();
      return {
        icon: '$(bell-slash)',
        text: `Cometix (${remaining}m)`,
        tooltip: `Cometix Tab: Snoozed for ${remaining} more minutes`,
        color: new vscode.ThemeColor('statusBarItem.warningBackground')
      };
    }

    // Check current state
    switch (this.currentState) {
      case StatusBarState.Working:
        return {
          icon: '$(loading~spin)',
          text: 'Cometix',
          tooltip: 'Cometix Tab: Generating completion...'
        };

      case StatusBarState.Error:
        return {
          icon: '$(error)',
          text: 'Cometix',
          tooltip: 'Cometix Tab: Error occurred (click to view)',
          color: new vscode.ThemeColor('statusBarItem.errorBackground')
        };

      case StatusBarState.Idle:
      default:
        // Show server config status in tooltip if available
        const serverConfig = this.serverConfigService.getCachedConfig();
        let tooltip = 'Cometix Tab: Ready';
        if (serverConfig) {
          const timeSince = this.serverConfigService.getTimeSinceLastFetch();
          tooltip += ` | Server config: ${timeSince}s ago`;
          if (serverConfig.geoCppBackendUrl) {
            tooltip += ` | Endpoint: ${new URL(serverConfig.geoCppBackendUrl).hostname}`;
          }
        }
        return {
          icon: '$(sparkle)',
          text: 'Cometix',
          tooltip
        };
    }
  }

  dispose(): void {
    this.statusBarItem.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
