import * as vscode from 'vscode';
import {
  EndpointMode,
  OfficialRegion,
  OFFICIAL_ENDPOINTS,
  REGION_DISPLAY_NAMES,
  DEFAULT_BASE_URL,
  DEFAULT_GEOCPP_URL,
  DEFAULT_CPP_CONFIG_URL,
  getRegionEndpoint,
  isOfficialEndpoint,
  detectRegionFromUrl,
  normalizeToApi2,
} from '../api/endpoints';

/**
 * Endpoint configuration resolved for use
 */
export interface ResolvedEndpoint {
  /** The main base URL for API requests (HTTP/1.1 - api2 format) */
  baseUrl: string;
  /** The GeoCpp URL for code completion streaming (may be HTTP/2) */
  geoCppUrl: string;
  /** The CppConfig URL for fetching server configuration */
  cppConfigUrl: string;
  /** The mode that was used to resolve this endpoint */
  mode: EndpointMode;
  /** If official mode, the selected region */
  region?: OfficialRegion;
  /** If auto mode, the server-provided URL */
  autoDetectedUrl?: string;
  /** If custom mode, the user-provided URL */
  customUrl?: string;
}

/**
 * EndpointManager handles endpoint selection logic based on user configuration.
 * It supports three modes:
 * 1. Official - Manual region selection (US, EU, Asia, Default)
 * 2. Auto - Server-provided optimal endpoint via CppConfig response
 * 3. Custom - User-provided endpoint URL
 */
export class EndpointManager implements vscode.Disposable {
  private static readonly CONFIG_SECTION = 'cometixTab';
  private static readonly STORAGE_KEY_AUTO_ENDPOINT = 'autoDetectedGeoCppUrl';

  private readonly _onEndpointChanged = new vscode.EventEmitter<ResolvedEndpoint>();
  public readonly onEndpointChanged = this._onEndpointChanged.event;

  private disposables: vscode.Disposable[] = [];
  private globalState: vscode.Memento;
  private outputChannel: vscode.OutputChannel;

  // Cached auto-detected endpoint from server
  private cachedAutoEndpoint: string | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.globalState = context.globalState;
    this.outputChannel = vscode.window.createOutputChannel('CometixTab Endpoint', { log: true });

    // Load cached auto-detected endpoint
    this.cachedAutoEndpoint = this.globalState.get<string>(EndpointManager.STORAGE_KEY_AUTO_ENDPOINT);

    // Listen for configuration changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration(`${EndpointManager.CONFIG_SECTION}.endpointMode`) ||
          e.affectsConfiguration(`${EndpointManager.CONFIG_SECTION}.officialRegion`) ||
          e.affectsConfiguration(`${EndpointManager.CONFIG_SECTION}.customEndpoint`)
        ) {
          this.notifyEndpointChanged();
        }
      })
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this._onEndpointChanged.dispose();
    this.outputChannel.dispose();
  }

  /**
   * Get the current endpoint mode from configuration
   */
  getEndpointMode(): EndpointMode {
    const config = vscode.workspace.getConfiguration(EndpointManager.CONFIG_SECTION);
    const mode = config.get<string>('endpointMode') || 'auto';
    
    // Validate mode
    if (mode === 'official' || mode === 'auto' || mode === 'custom') {
      return mode;
    }
    return 'auto';
  }

  /**
   * Get the selected region for official mode
   */
  getOfficialRegion(): OfficialRegion {
    const config = vscode.workspace.getConfiguration(EndpointManager.CONFIG_SECTION);
    const region = config.get<string>('officialRegion') || 'default';
    
    if (region === 'default' || region === 'us' || region === 'eu' || region === 'asia') {
      return region;
    }
    return 'default';
  }

  /**
   * Get the custom endpoint URL
   */
  getCustomEndpoint(): string {
    const config = vscode.workspace.getConfiguration(EndpointManager.CONFIG_SECTION);
    const customEndpoint = config.get<string>('customEndpoint') || '';
    return customEndpoint.trim();
  }

  /**
   * Resolve the endpoint configuration based on current settings
   */
  resolveEndpoint(): ResolvedEndpoint {
    const mode = this.getEndpointMode();
    
    switch (mode) {
      case 'official':
        return this.resolveOfficialEndpoint();
      case 'auto':
        return this.resolveAutoEndpoint();
      case 'custom':
        return this.resolveCustomEndpoint();
      default:
        return this.resolveAutoEndpoint();
    }
  }

  private resolveOfficialEndpoint(): ResolvedEndpoint {
    const region = this.getOfficialRegion();
    const geoCppUrl = getRegionEndpoint(region);
    
    this.log(`Official endpoint resolved: region=${region}, geoCppUrl=${geoCppUrl}`);
    
    return {
      baseUrl: OFFICIAL_ENDPOINTS.api2,
      geoCppUrl,
      cppConfigUrl: DEFAULT_CPP_CONFIG_URL,
      mode: 'official',
      region,
    };
  }

  private resolveAutoEndpoint(): ResolvedEndpoint {
    // Use cached auto-detected endpoint if available, otherwise default
    const geoCppUrl = this.cachedAutoEndpoint || DEFAULT_GEOCPP_URL;
    
    this.log(`Auto endpoint resolved: geoCppUrl=${geoCppUrl} (cached=${!!this.cachedAutoEndpoint})`);
    
    return {
      baseUrl: OFFICIAL_ENDPOINTS.api2,
      geoCppUrl,
      cppConfigUrl: DEFAULT_CPP_CONFIG_URL,
      mode: 'auto',
      autoDetectedUrl: this.cachedAutoEndpoint,
    };
  }

  private resolveCustomEndpoint(): ResolvedEndpoint {
    const customUrl = this.getCustomEndpoint();
    
    if (!customUrl) {
      this.log('Custom endpoint not set, falling back to default');
      return this.resolveAutoEndpoint();
    }

    // Normalize URL
    const normalizedUrl = customUrl.replace(/\/$/, '');
    
    // For custom endpoints, use the same URL for all purposes
    // unless it's an official endpoint, then we can optimize
    let baseUrl = normalizedUrl;
    let geoCppUrl = normalizedUrl;
    let cppConfigUrl = normalizedUrl;
    
    if (isOfficialEndpoint(normalizedUrl)) {
      // If user provided an official URL, normalize for HTTP version compatibility
      baseUrl = normalizeToApi2(normalizedUrl);
      geoCppUrl = normalizedUrl;
      cppConfigUrl = DEFAULT_CPP_CONFIG_URL;
    }

    this.log(`Custom endpoint resolved: baseUrl=${baseUrl}, geoCppUrl=${geoCppUrl}`);

    return {
      baseUrl,
      geoCppUrl,
      cppConfigUrl,
      mode: 'custom',
      customUrl: normalizedUrl,
    };
  }

  /**
   * Update the auto-detected endpoint from CppConfig response
   * This should be called when receiving a CppConfigResponse from the server
   */
  async updateAutoDetectedEndpoint(geoCppBackendUrl: string): Promise<void> {
    if (!geoCppBackendUrl || geoCppBackendUrl.trim() === '') {
      return;
    }

    const normalizedUrl = geoCppBackendUrl.trim();
    
    // Validate it's a reasonable URL
    if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
      this.log(`Invalid auto-detected URL ignored: ${normalizedUrl}`);
      return;
    }

    // Only update if changed
    if (this.cachedAutoEndpoint !== normalizedUrl) {
      this.cachedAutoEndpoint = normalizedUrl;
      await this.globalState.update(EndpointManager.STORAGE_KEY_AUTO_ENDPOINT, normalizedUrl);
      
      this.log(`Auto-detected endpoint updated: ${normalizedUrl}`);
      
      // If in auto mode, notify of endpoint change
      if (this.getEndpointMode() === 'auto') {
        this.notifyEndpointChanged();
      }
    }
  }

  /**
   * Clear the cached auto-detected endpoint
   */
  async clearAutoDetectedEndpoint(): Promise<void> {
    this.cachedAutoEndpoint = undefined;
    await this.globalState.update(EndpointManager.STORAGE_KEY_AUTO_ENDPOINT, undefined);
    this.log('Auto-detected endpoint cleared');
    
    if (this.getEndpointMode() === 'auto') {
      this.notifyEndpointChanged();
    }
  }

  /**
   * Set the endpoint mode
   */
  async setEndpointMode(mode: EndpointMode): Promise<void> {
    const config = vscode.workspace.getConfiguration(EndpointManager.CONFIG_SECTION);
    await config.update('endpointMode', mode, vscode.ConfigurationTarget.Global);
    this.log(`Endpoint mode set to: ${mode}`);
  }

  /**
   * Set the official region
   */
  async setOfficialRegion(region: OfficialRegion): Promise<void> {
    const config = vscode.workspace.getConfiguration(EndpointManager.CONFIG_SECTION);
    await config.update('officialRegion', region, vscode.ConfigurationTarget.Global);
    this.log(`Official region set to: ${region}`);
  }

  /**
   * Set the custom endpoint
   */
  async setCustomEndpoint(url: string): Promise<void> {
    const config = vscode.workspace.getConfiguration(EndpointManager.CONFIG_SECTION);
    await config.update('customEndpoint', url, vscode.ConfigurationTarget.Global);
    this.log(`Custom endpoint set to: ${url}`);
  }

  /**
   * Get endpoint information for display
   */
  getEndpointInfo(): {
    mode: EndpointMode;
    modeLabel: string;
    currentEndpoint: string;
    region?: OfficialRegion;
    regionLabel?: string;
    isAutoDetected: boolean;
    autoDetectedFrom?: string;
  } {
    const resolved = this.resolveEndpoint();
    const modeLabels: Record<EndpointMode, string> = {
      official: 'Official (Manual Region)',
      auto: 'Automatic',
      custom: 'Custom',
    };

    return {
      mode: resolved.mode,
      modeLabel: modeLabels[resolved.mode],
      currentEndpoint: resolved.geoCppUrl,
      region: resolved.region,
      regionLabel: resolved.region ? REGION_DISPLAY_NAMES[resolved.region] : undefined,
      isAutoDetected: resolved.mode === 'auto' && !!resolved.autoDetectedUrl,
      autoDetectedFrom: resolved.autoDetectedUrl,
    };
  }

  /**
   * Get all available regions with their display names
   */
  getAvailableRegions(): Array<{ value: OfficialRegion; label: string; url: string }> {
    return [
      { value: 'default', label: REGION_DISPLAY_NAMES.default, url: OFFICIAL_ENDPOINTS.gcpp.default },
      { value: 'us', label: REGION_DISPLAY_NAMES.us, url: OFFICIAL_ENDPOINTS.gcpp.us },
      { value: 'eu', label: REGION_DISPLAY_NAMES.eu, url: OFFICIAL_ENDPOINTS.gcpp.eu },
      { value: 'asia', label: REGION_DISPLAY_NAMES.asia, url: OFFICIAL_ENDPOINTS.gcpp.asia },
    ];
  }

  private notifyEndpointChanged(): void {
    const resolved = this.resolveEndpoint();
    this._onEndpointChanged.fire(resolved);
  }

  private log(message: string): void {
    const ts = new Date().toISOString();
    this.outputChannel.appendLine(`[${ts}] [EndpointManager] ${message}`);
  }
}
