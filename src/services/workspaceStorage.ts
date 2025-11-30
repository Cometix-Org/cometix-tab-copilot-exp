import * as vscode from 'vscode';
import { generateRandomIdSuffix } from '../utils/contentProcessor';
import { StreamCppRequest_ControlToken } from '../rpc/cursor-tab_pb';

/**
 * Storage keys for workspace-level persistence
 */
const WORKSPACE_STORAGE_KEYS = {
  UNIQUE_CPP_WORKSPACE_ID: 'uniqueCppWorkspaceId',
} as const;

/**
 * Storage keys for application-level persistence
 */
const GLOBAL_STORAGE_KEYS = {
  CPP_CONTROL_TOKEN: 'cppControlToken',
  CPP_CONFIG: 'cppConfig',
} as const;

/**
 * CppConfig structure matching Cursor's config
 */
export interface CppConfig {
  checkFilesyncHashPercent?: number;
  enableFilesyncDebounceSkipping?: boolean;
  enableRvfTracking?: boolean;
  shouldFetchRvfText?: boolean;
  // ... other config fields as needed
}

/**
 * Service for managing persistent storage for CPP-related data
 * Mirrors Cursor's pb.workspaceUserPersistentStorage and pb.applicationUserPersistentStorage
 */
export class WorkspaceStorage implements vscode.Disposable {
  private readonly workspaceState: vscode.Memento;
  private readonly globalState: vscode.Memento;
  private cachedWorkspaceId: string | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.workspaceState = context.workspaceState;
    this.globalState = context.globalState;
  }

  /**
   * Get or generate the unique workspace ID for CPP requests
   * Matches Cursor's getWorkspaceId() behavior:
   * - Stored in workspaceUserPersistentStorage.uniqueCppWorkspaceId
   * - Generated once and reused for the workspace
   * - Format: {randomId}-{version}
   */
  getWorkspaceId(): string {
    // Return cached value if available
    if (this.cachedWorkspaceId) {
      return this.cachedWorkspaceId;
    }

    // Try to get from workspace storage
    let workspaceId = this.workspaceState.get<string>(WORKSPACE_STORAGE_KEYS.UNIQUE_CPP_WORKSPACE_ID);

    if (!workspaceId) {
      // Generate new ID matching Cursor's format
      workspaceId = generateRandomIdSuffix();
      // Store for future use
      this.workspaceState.update(WORKSPACE_STORAGE_KEYS.UNIQUE_CPP_WORKSPACE_ID, workspaceId);
    }

    // Cache the result
    // Cursor appends a version suffix (tGo = "git30_000_bounded_auto")
    const VERSION_SUFFIX = 'git30_000_bounded_auto';
    this.cachedWorkspaceId = `${workspaceId}-${VERSION_SUFFIX}`;
    
    return this.cachedWorkspaceId;
  }

  /**
   * Get the control token from application storage
   * Matches Cursor's pb.applicationUserPersistentStorage.cppControlToken
   * 
   * @returns Control token or undefined if not set
   */
  getControlToken(): StreamCppRequest_ControlToken | undefined {
    const tokenValue = this.globalState.get<number>(GLOBAL_STORAGE_KEYS.CPP_CONTROL_TOKEN);
    if (tokenValue === undefined || tokenValue === null) {
      return undefined;
    }
    
    // Map stored value to ControlToken enum
    switch (tokenValue) {
      case 1:
        return StreamCppRequest_ControlToken.QUIET;
      case 2:
        return StreamCppRequest_ControlToken.LOUD;
      case 3:
        return StreamCppRequest_ControlToken.OP;
      default:
        return undefined;
    }
  }

  /**
   * Set the control token in application storage
   * @param token Control token value
   */
  async setControlToken(token: StreamCppRequest_ControlToken | undefined): Promise<void> {
    if (token === undefined) {
      await this.globalState.update(GLOBAL_STORAGE_KEYS.CPP_CONTROL_TOKEN, undefined);
    } else {
      await this.globalState.update(GLOBAL_STORAGE_KEYS.CPP_CONTROL_TOKEN, token);
    }
  }

  /**
   * Get CPP config from application storage
   */
  getCppConfig(): CppConfig | undefined {
    return this.globalState.get<CppConfig>(GLOBAL_STORAGE_KEYS.CPP_CONFIG);
  }

  /**
   * Set CPP config in application storage
   * @param config CppConfig object
   */
  async setCppConfig(config: CppConfig): Promise<void> {
    await this.globalState.update(GLOBAL_STORAGE_KEYS.CPP_CONFIG, config);
  }

  /**
   * Get checkFilesyncHashPercent from config
   * @returns Hash percentage (0-1), defaults to 0
   */
  getCheckFilesyncHashPercent(): number {
    return this.getCppConfig()?.checkFilesyncHashPercent ?? 0;
  }

  /**
   * Clear cached values (e.g., when workspace changes)
   */
  clearCache(): void {
    this.cachedWorkspaceId = null;
  }

  dispose(): void {
    this.clearCache();
  }
}
