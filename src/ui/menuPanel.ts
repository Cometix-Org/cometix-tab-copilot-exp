import * as vscode from 'vscode';
import { SnoozeService } from '../services/snoozeService';
import { ServerConfigService } from '../services/serverConfigService';

interface QuickActionItem extends vscode.QuickPickItem {
  action: string;
  args?: any[];
}

interface StatusInfo {
  enabled: boolean;
  isSnoozing: boolean;
  snoozeRemaining: number;
  hasServerConfig: boolean;
  serverConfigAge?: number;
}

/**
 * Menu panel shown when clicking the status bar
 * Provides quick actions for Cometix Tab
 */
export class MenuPanel {
  private snoozeService: SnoozeService;
  private serverConfigService: ServerConfigService;

  constructor() {
    this.snoozeService = SnoozeService.getInstance();
    this.serverConfigService = ServerConfigService.getInstance();
  }

  /**
   * Show the menu panel as a QuickPick
   */
  async show(): Promise<void> {
    const statusInfo = this.getStatusInfo();
    const items = this.buildMenuItems(statusInfo);

    const quickPick = vscode.window.createQuickPick<QuickActionItem>();
    quickPick.items = items;
    quickPick.title = 'Cometix Tab';
    quickPick.placeholder = 'Select an action...';

    quickPick.onDidAccept(async () => {
      const selected = quickPick.selectedItems[0];
      if (selected) {
        quickPick.hide();
        await this.executeAction(selected.action, selected.args);
      }
    });

    quickPick.onDidHide(() => quickPick.dispose());
    quickPick.show();
  }

  private getStatusInfo(): StatusInfo {
    const config = vscode.workspace.getConfiguration('cometixTab');
    const enabled = config.get<boolean>('enabled', true);

    return {
      enabled,
      isSnoozing: this.snoozeService.isSnoozing(),
      snoozeRemaining: this.snoozeService.getRemainingMinutes(),
      hasServerConfig: this.serverConfigService.hasConfig(),
      serverConfigAge: this.serverConfigService.getTimeSinceLastFetch()
    };
  }

  private buildMenuItems(statusInfo: StatusInfo): QuickActionItem[] {
    const items: QuickActionItem[] = [];

    // Header - current status
    items.push({
      label: '$(info) Current Status',
      description: this.getStatusDescription(statusInfo),
      action: 'noop',
      kind: vscode.QuickPickItemKind.Separator
    } as any);

    // Toggle enabled
    const toggleIcon = statusInfo.enabled ? '$(circle-filled)' : '$(circle-outline)';
    const toggleText = statusInfo.enabled ? 'Disable Completions' : 'Enable Completions';
    items.push({
      label: `${toggleIcon} ${toggleText}`,
      description: statusInfo.enabled ? 'Turn off AI completions' : 'Turn on AI completions',
      action: 'toggleEnabled'
    });

    // Snooze controls
    if (statusInfo.isSnoozing) {
      items.push({
        label: '$(bell) Cancel Snooze',
        description: `${statusInfo.snoozeRemaining} minutes remaining`,
        action: 'cancelSnooze'
      });
    } else if (statusInfo.enabled) {
      items.push({
        label: '$(bell-slash) Snooze Completions',
        description: 'Temporarily pause completions',
        action: 'showSnoozePicker'
      });
    }

    // Separator
    items.push({
      label: '',
      kind: vscode.QuickPickItemKind.Separator
    } as any);

    // Server config
    if (statusInfo.hasServerConfig) {
      items.push({
        label: '$(server) View Server Configuration',
        description: `Fetched ${statusInfo.serverConfigAge}s ago`,
        action: 'showServerConfig'
      });
    } else {
      items.push({
        label: '$(server) Server Configuration',
        description: 'Not yet fetched',
        action: 'showServerConfig'
      });
    }

    // Endpoint settings
    items.push({
      label: '$(globe) Select Endpoint Mode',
      description: 'Change API endpoint',
      action: 'selectEndpointMode'
    });

    items.push({
      label: '$(location) Select Region',
      description: 'Change server region',
      action: 'selectRegion'
    });

    // Separator
    items.push({
      label: '',
      kind: vscode.QuickPickItemKind.Separator
    } as any);

    // Tools
    items.push({
      label: '$(settings-gear) Open Settings',
      description: 'Configure Cometix Tab',
      action: 'openSettings'
    });

    items.push({
      label: '$(output) Show Logs',
      description: 'View output logs',
      action: 'showLogs'
    });

    items.push({
      label: '$(refresh) Refresh Server Config',
      description: 'Fetch latest server configuration',
      action: 'refreshConfig'
    });

    return items;
  }

  private getStatusDescription(statusInfo: StatusInfo): string {
    if (!statusInfo.enabled) {
      return 'Disabled';
    }
    if (statusInfo.isSnoozing) {
      return `Snoozed (${statusInfo.snoozeRemaining}m remaining)`;
    }
    return 'Active';
  }

  private async executeAction(action: string, args?: any[]): Promise<void> {
    switch (action) {
      case 'noop':
        break;

      case 'toggleEnabled':
        await vscode.commands.executeCommand('cometix-tab.toggleEnabled');
        break;

      case 'cancelSnooze':
        await vscode.commands.executeCommand('cometix-tab.cancelSnooze');
        break;

      case 'showSnoozePicker':
        await vscode.commands.executeCommand('cometix-tab.showSnoozePicker');
        break;

      case 'showServerConfig':
        await vscode.commands.executeCommand('cometix-tab.showServerConfig');
        break;

      case 'selectEndpointMode':
        await vscode.commands.executeCommand('cometix-tab.selectEndpointMode');
        break;

      case 'selectRegion':
        await vscode.commands.executeCommand('cometix-tab.selectRegion');
        break;

      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'cometixTab');
        break;

      case 'showLogs':
        await vscode.commands.executeCommand('cometix-tab.showLogs');
        break;

      case 'refreshConfig':
        await vscode.commands.executeCommand('cometix-tab.refreshAutoEndpoint');
        break;

      default:
        console.warn(`Unknown menu action: ${action}`);
    }
  }
}

/**
 * Show snooze duration picker
 */
export async function showSnoozePicker(): Promise<void> {
  const snoozeService = SnoozeService.getInstance();
  
  const options = [
    { label: '$(clock) 5 minutes', minutes: 5 },
    { label: '$(clock) 15 minutes', minutes: 15 },
    { label: '$(clock) 30 minutes', minutes: 30 },
    { label: '$(clock) 1 hour', minutes: 60 },
    { label: '$(clock) 2 hours', minutes: 120 }
  ];

  const selected = await vscode.window.showQuickPick(options, {
    title: 'Snooze AI Completions',
    placeHolder: 'Select duration'
  });

  if (selected) {
    snoozeService.snooze(selected.minutes);
    vscode.window.showInformationMessage(`Cometix Tab: Snoozed for ${selected.minutes} minutes`);
  }
}
