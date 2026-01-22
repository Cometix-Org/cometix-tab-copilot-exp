import * as vscode from 'vscode';
import { Logger } from './logger';
import { EndpointMode, OfficialRegion } from '../api/endpoints';

// ==================== Official Cursor Endpoint URLs (Hardcoded) ====================
/**
 * Based on cursor source analysis:
 * - api2: General backend (HTTP/1.1) - for RefreshTabContext, etc.
 * - api4: Default for CppConfig and GeoCpp (HTTP/2)
 * - gcpp: Regional endpoints for code completion (HTTP/2)
 */
export const OFFICIAL_ENDPOINTS = {
  /** General backend - HTTP/1.1, RefreshTabContext, general API */
  api2: 'https://api2.cursor.sh',
  
  /** Default CppConfig/GeoCpp endpoint - HTTP/2 */
  api4: 'https://api4.cursor.sh',
  
  /** Geographic CPP endpoints - regional code completion (HTTP/2) */
  gcpp: {
    /** Default - uses api4 (same as cursor default) */
    default: 'https://api4.cursor.sh',
    /** United States */
    us: 'https://us.gcpp.cursor.sh',
    /** Europe */
    eu: 'https://eu.gcpp.cursor.sh',
    /** Asia Pacific */
    asia: 'https://asia.gcpp.cursor.sh',
  },
} as const;

/**
 * Region display names for UI
 */
export const REGION_DISPLAY_NAMES: Record<OfficialRegion, string> = {
  default: 'Default (api4.cursor.sh)',
  us: 'United States (us.gcpp.cursor.sh)',
  eu: 'Europe (eu.gcpp.cursor.sh)',
  asia: 'Asia Pacific (asia.gcpp.cursor.sh)',
};

// ==================== Helper Functions ====================
function getRegionEndpoint(region: OfficialRegion): string {
  return OFFICIAL_ENDPOINTS.gcpp[region];
}

function detectRegionFromUrl(url: string): OfficialRegion | null {
  if (url === OFFICIAL_ENDPOINTS.gcpp.us) {return 'us';}
  if (url === OFFICIAL_ENDPOINTS.gcpp.eu) {return 'eu';}
  if (url === OFFICIAL_ENDPOINTS.gcpp.asia) {return 'asia';}
  if (url === OFFICIAL_ENDPOINTS.api4 || url === OFFICIAL_ENDPOINTS.api2) {return 'default';}
  return null;
}

// ==================== Types ====================
/**
 * Endpoint configuration resolved for use
 * 
 * Two types of endpoints:
 * - baseUrl: General API endpoint (HTTP/1.1) - for CppConfig, RefreshTabContext, FileSync, etc.
 * - geoCppUrl: Completion API endpoint - for StreamCpp (can be gcpp regional or same as baseUrl)
 */
export interface ResolvedEndpoint {
  /** General API endpoint (HTTP/1.1) - CppConfig, RefreshTabContext, FileSync */
  baseUrl: string;
  /** Completion API endpoint - StreamCpp (can be regional gcpp or same as baseUrl) */
  geoCppUrl: string;
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
  private static readonly CONFIG_DEBOUNCE_MS = 300;

  private readonly _onEndpointChanged = new vscode.EventEmitter<ResolvedEndpoint>();
  public readonly onEndpointChanged = this._onEndpointChanged.event;

  private disposables: vscode.Disposable[] = [];
  private globalState: vscode.Memento;
  private notifyTimer: NodeJS.Timeout | undefined;

  // Cached auto-detected endpoint from server
  private cachedAutoEndpoint: string | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.globalState = context.globalState;

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
          this.scheduleNotifyEndpointChanged();
        }
      })
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this._onEndpointChanged.dispose();
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = undefined;
    }
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
   * 
   * Logic:
   * 1. If customEndpoint is set → always use custom mode
   * 2. If customEndpoint is not set → use endpointMode (official or auto)
   */
  resolveEndpoint(): ResolvedEndpoint {
    // Priority: custom endpoint takes precedence if set
    const customUrl = this.getCustomEndpoint();
    if (customUrl) {
      return this.resolveCustomEndpoint();
    }
    
    // No custom URL set, use official/auto based on endpointMode
    const mode = this.getEndpointMode();
    switch (mode) {
      case 'official':
        return this.resolveOfficialEndpoint();
      case 'auto':
      default:
        return this.resolveAutoEndpoint();
    }
  }

  private resolveOfficialEndpoint(): ResolvedEndpoint {
    const region = this.getOfficialRegion();
    const geoCppUrl = getRegionEndpoint(region);
    
    this.log(`Official endpoint resolved: region=${region}, baseUrl=${OFFICIAL_ENDPOINTS.api2}, geoCppUrl=${geoCppUrl}`);
    
    return {
      baseUrl: OFFICIAL_ENDPOINTS.api2,
      geoCppUrl,
      mode: 'official',
      region,
    };
  }

  private resolveAutoEndpoint(): ResolvedEndpoint {
    // Use cached auto-detected endpoint if available, otherwise default to api4
    // (api4 is cursor's default for CppConfig and GeoCpp)
    const geoCppUrl = this.cachedAutoEndpoint || OFFICIAL_ENDPOINTS.api4;
    
    this.log(`Auto endpoint resolved: baseUrl=${OFFICIAL_ENDPOINTS.api2}, geoCppUrl=${geoCppUrl} (cached=${!!this.cachedAutoEndpoint})`);
    
    return {
      baseUrl: OFFICIAL_ENDPOINTS.api2,
      geoCppUrl,
      mode: 'auto',
      autoDetectedUrl: this.cachedAutoEndpoint,
    };
  }

  private resolveCustomEndpoint(): ResolvedEndpoint {
    const customUrl = this.getCustomEndpoint();
    
    if (!customUrl) {
      // No custom URL set - use default endpoints but preserve 'custom' mode
      // so the UI correctly shows user is in custom mode (just unconfigured)
      this.log('Custom endpoint not set, using defaults with custom mode');
      return {
        baseUrl: OFFICIAL_ENDPOINTS.api2,
        geoCppUrl: OFFICIAL_ENDPOINTS.api4,
        mode: 'custom',
        customUrl: undefined,
      };
    }

    // Normalize URL (remove trailing slash)
    const normalizedUrl = customUrl.replace(/\/$/, '');
    
    // For custom endpoints, use the same URL for both baseUrl and geoCppUrl
    // Custom URL fully overrides both general API and completion API
    this.log(`Custom endpoint resolved: baseUrl=${normalizedUrl}, geoCppUrl=${normalizedUrl}`);

    return {
      baseUrl: normalizedUrl,
      geoCppUrl: normalizedUrl,
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

  private scheduleNotifyEndpointChanged(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
    }
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined;
      this.notifyEndpointChanged();
    }, EndpointManager.CONFIG_DEBOUNCE_MS);
  }

  private log(message: string): void {
    const ts = new Date().toISOString();
    Logger.getSharedChannel().appendLine(`[${ts}] [EndpointManager] ${message}`);
  }
}
