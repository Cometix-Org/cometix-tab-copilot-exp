import * as vscode from 'vscode';
import { 
  EndpointManager, 
  REGION_DISPLAY_NAMES, 
  OFFICIAL_ENDPOINTS 
} from '../services/endpointManager';
import { EndpointMode, OfficialRegion } from '../api/endpoints';

/**
 * Register all endpoint-related commands
 */
export function registerEndpointCommands(
  context: vscode.ExtensionContext,
  endpointManager: EndpointManager,
  refreshClient: () => void
): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  // Command: Select Endpoint Mode
  disposables.push(
    vscode.commands.registerCommand('cometix-tab.selectEndpointMode', async () => {
      const currentMode = endpointManager.getEndpointMode();
      
      const items: vscode.QuickPickItem[] = [
        {
          label: '$(globe) Official',
          description: 'Use official Cursor endpoints with manual region selection',
          detail: currentMode === 'official' ? '$(check) Currently selected' : undefined,
          picked: currentMode === 'official',
        },
        {
          label: '$(sync) Automatic',
          description: 'Automatically select the best endpoint via server response',
          detail: currentMode === 'auto' ? '$(check) Currently selected' : undefined,
          picked: currentMode === 'auto',
        },
        {
          label: '$(pencil) Custom',
          description: 'Use a custom user-provided endpoint URL',
          detail: currentMode === 'custom' ? '$(check) Currently selected' : undefined,
          picked: currentMode === 'custom',
        },
      ];

      const selected = await vscode.window.showQuickPick(items, {
        title: 'Select Endpoint Mode',
        placeHolder: 'Choose how to select the API endpoint',
      });

      if (!selected) {
        return;
      }

      let newMode: EndpointMode;
      if (selected.label.includes('Official')) {
        newMode = 'official';
      } else if (selected.label.includes('Automatic')) {
        newMode = 'auto';
      } else {
        newMode = 'custom';
      }

      await endpointManager.setEndpointMode(newMode);
      
      // If switching to custom mode, prompt for URL if not set
      if (newMode === 'custom' && !endpointManager.getCustomEndpoint()) {
        const url = await vscode.window.showInputBox({
          title: 'Enter Custom Endpoint URL',
          prompt: 'Enter the base URL for your custom API endpoint',
          placeHolder: 'https://your-server.example.com',
          validateInput: (value) => {
            if (!value.trim()) {
              return 'URL cannot be empty';
            }
            if (!value.startsWith('http://') && !value.startsWith('https://')) {
              return 'URL must start with http:// or https://';
            }
            return null;
          },
        });
        
        if (url) {
          await endpointManager.setCustomEndpoint(url);
        }
      }

      // If switching to official mode, prompt for region selection
      if (newMode === 'official') {
        await vscode.commands.executeCommand('cometix-tab.selectRegion');
      }

      refreshClient();
      vscode.window.showInformationMessage(`Endpoint mode changed to: ${newMode}`);
    })
  );

  // Command: Select Server Region
  disposables.push(
    vscode.commands.registerCommand('cometix-tab.selectRegion', async () => {
      const currentRegion = endpointManager.getOfficialRegion();
      const regions = endpointManager.getAvailableRegions();

      const items: vscode.QuickPickItem[] = regions.map((r) => ({
        label: r.value === currentRegion ? `$(check) ${r.label}` : r.label,
        description: r.url,
        detail: r.value === currentRegion ? 'Currently selected' : undefined,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        title: 'Select Server Region',
        placeHolder: 'Choose the region closest to you for best performance',
      });

      if (!selected) {
        return;
      }

      // Extract region from selection
      const selectedRegion = regions.find((r) => 
        selected.label.includes(r.label) || selected.description === r.url
      );

      if (selectedRegion) {
        await endpointManager.setOfficialRegion(selectedRegion.value);
        
        // Also set endpoint mode to official if not already
        if (endpointManager.getEndpointMode() !== 'official') {
          await endpointManager.setEndpointMode('official');
        }
        
        refreshClient();
        vscode.window.showInformationMessage(`Server region changed to: ${selectedRegion.label}`);
      }
    })
  );

  // Command: Show Current Endpoint Info
  disposables.push(
    vscode.commands.registerCommand('cometix-tab.showEndpointInfo', async () => {
      const info = endpointManager.getEndpointInfo();
      
      const lines: string[] = [
        `**Endpoint Mode:** ${info.modeLabel}`,
        `**Current Endpoint:** ${info.currentEndpoint}`,
      ];

      if (info.region) {
        lines.push(`**Region:** ${info.regionLabel}`);
      }

      if (info.isAutoDetected) {
        lines.push(`**Auto-Detected:** Yes (from server response)`);
      }

      const message = lines.join('\n');

      const action = await vscode.window.showInformationMessage(
        `Cometix Tab Endpoint Configuration`,
        { modal: false, detail: message },
        'Change Mode',
        'Change Region',
        'Copy Endpoint'
      );

      if (action === 'Change Mode') {
        await vscode.commands.executeCommand('cometix-tab.selectEndpointMode');
      } else if (action === 'Change Region') {
        await vscode.commands.executeCommand('cometix-tab.selectRegion');
      } else if (action === 'Copy Endpoint') {
        await vscode.env.clipboard.writeText(info.currentEndpoint);
        vscode.window.showInformationMessage('Endpoint URL copied to clipboard');
      }
    })
  );

  // Command: Refresh Auto-Selected Endpoint
  disposables.push(
    vscode.commands.registerCommand('cometix-tab.refreshAutoEndpoint', async () => {
      const mode = endpointManager.getEndpointMode();
      
      if (mode !== 'auto') {
        const switchToAuto = await vscode.window.showWarningMessage(
          'Auto endpoint refresh is only available in "Automatic" mode. Switch to automatic mode?',
          'Switch to Auto',
          'Cancel'
        );
        
        if (switchToAuto === 'Switch to Auto') {
          await endpointManager.setEndpointMode('auto');
        } else {
          return;
        }
      }

      // Clear cached endpoint to force refresh
      await endpointManager.clearAutoDetectedEndpoint();
      refreshClient();
      
      vscode.window.showInformationMessage(
        'Auto-detected endpoint cleared. The best endpoint will be selected on next request.'
      );
    })
  );

  return disposables;
}
