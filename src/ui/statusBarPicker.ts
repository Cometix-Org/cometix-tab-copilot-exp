import * as vscode from 'vscode';
import { TelemetryService, SessionStatistics } from '../services/telemetryService';
import { EndpointManager, ResolvedEndpoint } from '../services/endpointManager';
import { SnoozeService } from '../services/snoozeService';
import { TriggerSource } from '../context/types';

/**
 * Quick pick item with action
 */
interface StatusPickerItem extends vscode.QuickPickItem {
  action?: string;
  args?: any[];
}

/**
 * Commands for the status picker
 */
const CMD_TOGGLE_ENABLED = 'cometix-tab.toggleEnabled';
const CMD_SHOW_LOGS = 'cometix-tab.showLogs';
const CMD_OPEN_SETTINGS = 'workbench.action.openSettings';
const CMD_SELECT_ENDPOINT = 'cometix-tab.selectEndpointMode';
const CMD_SELECT_REGION = 'cometix-tab.selectRegion';
const CMD_SNOOZE = 'cometix-tab.showSnoozePicker';
const CMD_CANCEL_SNOOZE = 'cometix-tab.cancelSnooze';
const CMD_RESET_STATS = 'cometix-tab.resetStatistics';

/**
 * Status bar picker menu - similar to Copilot's CopilotStatusBarPickMenu
 * Shows statistics and quick actions when clicking the status bar
 */
export class StatusBarPicker implements vscode.Disposable {
  private telemetryService: TelemetryService | undefined;
  private endpointManager: EndpointManager | undefined;
  private snoozeService: SnoozeService;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.snoozeService = SnoozeService.getInstance();
  }

  /**
   * Set telemetry service for statistics
   */
  setTelemetryService(telemetryService: TelemetryService): void {
    this.telemetryService = telemetryService;
  }

  /**
   * Set endpoint manager for endpoint info
   */
  setEndpointManager(endpointManager: EndpointManager): void {
    this.endpointManager = endpointManager;
  }

  /**
   * Show the status picker menu
   */
  async show(): Promise<void> {
    const items = this.buildMenuItems();

    const quickPick = vscode.window.createQuickPick<StatusPickerItem>();
    quickPick.items = items;
    quickPick.title = 'Cometix Tab Status';
    quickPick.placeholder = 'Select an action or view statistics...';
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;

    quickPick.onDidAccept(async () => {
      const selected = quickPick.selectedItems[0];
      if (selected?.action) {
        quickPick.hide();
        await this.executeAction(selected.action, selected.args);
      }
    });

    quickPick.onDidHide(() => quickPick.dispose());
    quickPick.show();
  }

  /**
   * Build menu items with statistics and actions
   */
  private buildMenuItems(): StatusPickerItem[] {
    const items: StatusPickerItem[] = [];
    const config = vscode.workspace.getConfiguration('cometixTab');
    const enabled = config.get<boolean>('enabled', true);

    // === Status Section ===
    items.push(this.newStatusItem(enabled));

    // === Statistics Section ===
    items.push({
      label: 'Session Statistics',
      kind: vscode.QuickPickItemKind.Separator
    });

    const stats = this.telemetryService?.getStatistics();
    if (stats) {
      items.push(...this.buildStatisticsItems(stats));
    } else {
      items.push({
        label: '$(info) No statistics available',
        description: 'Start using completions to see stats'
      });
    }

    // === Trigger Sources Section ===
    if (stats && Object.keys(stats.triggersBySource).length > 0) {
      items.push({
        label: 'Triggers by Source',
        kind: vscode.QuickPickItemKind.Separator
      });
      items.push(...this.buildTriggerSourceItems(stats.triggersBySource));
    }

    // === Endpoint Section ===
    items.push({
      label: 'Connection',
      kind: vscode.QuickPickItemKind.Separator
    });
    items.push(...this.buildEndpointItems());

    // === Actions Section ===
    items.push({
      label: 'Actions',
      kind: vscode.QuickPickItemKind.Separator
    });
    items.push(...this.buildActionItems(enabled));

    return items;
  }

  /**
   * Build the status item showing current state
   */
  private newStatusItem(enabled: boolean): StatusPickerItem {
    let statusText: string;
    let statusIcon: string;

    if (!enabled) {
      statusText = 'Disabled';
      statusIcon = '$(circle-slash)';
    } else if (this.snoozeService.isSnoozing()) {
      const remaining = this.snoozeService.getRemainingMinutes();
      statusText = `Snoozed (${remaining}m remaining)`;
      statusIcon = '$(bell-slash)';
    } else {
      statusText = 'Ready';
      statusIcon = '$(sparkle)';
    }

    return {
      label: `${statusIcon} Status: ${statusText}`,
      description: enabled ? 'Click to toggle' : 'Click to enable',
      action: CMD_TOGGLE_ENABLED
    };
  }

  /**
   * Build statistics display items
   */
  private buildStatisticsItems(stats: SessionStatistics): StatusPickerItem[] {
    const items: StatusPickerItem[] = [];

    // Session duration
    const sessionDuration = this.formatDuration(Date.now() - stats.sessionStartTime);
    items.push({
      label: '$(clock) Session Duration',
      description: sessionDuration
    });

    // Completions summary
    items.push({
      label: '$(code) Completions Shown',
      description: `${stats.suggestionCount} total`
    });

    // Accept/Reject stats
    const acceptRate = stats.suggestionCount > 0
      ? Math.round(stats.acceptRate * 100)
      : 0;
    items.push({
      label: '$(check) Accepted',
      description: `${stats.acceptCount} (${acceptRate}% rate)`
    });

    items.push({
      label: '$(x) Rejected',
      description: `${stats.rejectCount}`
    });

    if (stats.partialAcceptCount > 0) {
      items.push({
        label: '$(checklist) Partial Accepts',
        description: `${stats.partialAcceptCount}`
      });
    }

    // Characters accepted
    if (stats.totalCharsAccepted > 0) {
      items.push({
        label: '$(text-size) Characters Accepted',
        description: this.formatNumber(stats.totalCharsAccepted)
      });
    }

    // Cursor jumps
    if (stats.cursorJumpCount > 0) {
      items.push({
        label: '$(arrow-right) Cursor Jumps',
        description: `${stats.cursorJumpCount}`
      });
    }

    // Files synced
    if (stats.filesSyncedCount > 0) {
      items.push({
        label: '$(cloud-upload) Files Synced',
        description: `${stats.filesSyncedCount}`
      });
    }

    // Average generation time
    if (stats.avgGenerationTimeMs > 0) {
      items.push({
        label: '$(dashboard) Avg Generation Time',
        description: `${stats.avgGenerationTimeMs}ms`
      });
    }

    return items;
  }

  /**
   * Build trigger source breakdown items
   */
  private buildTriggerSourceItems(triggersBySource: Record<string, number>): StatusPickerItem[] {
    const items: StatusPickerItem[] = [];

    // Sort by count descending
    const sorted = Object.entries(triggersBySource)
      .sort(([, a], [, b]) => b - a);

    for (const [source, count] of sorted) {
      const icon = this.getSourceIcon(source as TriggerSource);
      const label = this.formatSourceName(source);
      items.push({
        label: `${icon} ${label}`,
        description: `${count} triggers`
      });
    }

    return items;
  }

  /**
   * Build endpoint information items
   */
  private buildEndpointItems(): StatusPickerItem[] {
    const items: StatusPickerItem[] = [];

    if (this.endpointManager) {
      const info = this.endpointManager.getEndpointInfo();

      items.push({
        label: '$(globe) Endpoint Mode',
        description: info.modeLabel,
        action: CMD_SELECT_ENDPOINT
      });

      try {
        const hostname = new URL(info.currentEndpoint).hostname;
        items.push({
          label: '$(server) Current Server',
          description: hostname
        });
      } catch {
        items.push({
          label: '$(server) Current Server',
          description: info.currentEndpoint
        });
      }

      if (info.regionLabel) {
        items.push({
          label: '$(location) Region',
          description: info.regionLabel,
          action: CMD_SELECT_REGION
        });
      }

      if (info.isAutoDetected) {
        items.push({
          label: '$(info) Auto-detected',
          description: 'Server provided optimal endpoint'
        });
      }
    } else {
      items.push({
        label: '$(warning) Endpoint not configured',
        description: 'Click to configure',
        action: CMD_SELECT_ENDPOINT
      });
    }

    return items;
  }

  /**
   * Build action items
   */
  private buildActionItems(enabled: boolean): StatusPickerItem[] {
    const items: StatusPickerItem[] = [];

    // Toggle enabled
    items.push({
      label: enabled ? '$(circle-slash) Disable Completions' : '$(circle-filled) Enable Completions',
      description: enabled ? 'Turn off AI completions' : 'Turn on AI completions',
      action: CMD_TOGGLE_ENABLED
    });

    // Snooze
    if (enabled) {
      if (this.snoozeService.isSnoozing()) {
        items.push({
          label: '$(bell) Cancel Snooze',
          description: `${this.snoozeService.getRemainingMinutes()}m remaining`,
          action: CMD_CANCEL_SNOOZE
        });
      } else {
        items.push({
          label: '$(bell-slash) Snooze Completions',
          description: 'Temporarily pause',
          action: CMD_SNOOZE
        });
      }
    }

    // Reset statistics
    items.push({
      label: '$(refresh) Reset Statistics',
      description: 'Clear session stats',
      action: CMD_RESET_STATS
    });

    // Show logs
    items.push({
      label: '$(output) Show Logs',
      description: 'View output logs',
      action: CMD_SHOW_LOGS
    });

    // Open settings
    items.push({
      label: '$(settings-gear) Open Settings',
      description: 'Configure Cometix Tab',
      action: CMD_OPEN_SETTINGS,
      args: ['cometixTab']
    });

    return items;
  }

  /**
   * Execute selected action
   */
  private async executeAction(action: string, args?: any[]): Promise<void> {
    switch (action) {
      case CMD_RESET_STATS:
        this.telemetryService?.resetStatistics();
        vscode.window.showInformationMessage('Cometix Tab: Statistics reset');
        break;

      default:
        if (args && args.length > 0) {
          await vscode.commands.executeCommand(action, ...args);
        } else {
          await vscode.commands.executeCommand(action);
        }
        break;
    }
  }

  /**
   * Get icon for trigger source
   */
  private getSourceIcon(source: TriggerSource | string): string {
    const icons: Record<string, string> = {
      [TriggerSource.Unknown]: '$(question)',
      [TriggerSource.LineChange]: '$(edit)',
      [TriggerSource.Typing]: '$(keyboard)',
      [TriggerSource.OptionHold]: '$(key)',
      [TriggerSource.LinterErrors]: '$(error)',
      [TriggerSource.ParameterHints]: '$(symbol-parameter)',
      [TriggerSource.CursorPrediction]: '$(arrow-right)',
      [TriggerSource.ManualTrigger]: '$(play)',
      [TriggerSource.EditorChange]: '$(window)',
      [TriggerSource.LspSuggestions]: '$(symbol-method)',
    };
    return icons[source] || '$(circle-outline)';
  }

  /**
   * Format trigger source name for display
   */
  private formatSourceName(source: string): string {
    // Convert camelCase/PascalCase to readable text
    return source
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, str => str.toUpperCase())
      .trim();
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
   * Format large numbers with commas
   */
  private formatNumber(num: number): string {
    return num.toLocaleString();
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
