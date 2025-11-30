import * as vscode from 'vscode';
import {
  FilesyncUpdateWithModelVersion,
  FSUploadFileRequest,
  FSUploadFileResponse,
  FSSyncFileRequest,
  FSSyncFileResponse,
  RefreshTabContextRequest,
  RefreshTabContextResponse,
  StreamCppRequest,
  StreamCppResponse,
  StreamNextCursorPredictionRequest,
  StreamNextCursorPredictionResponse,
  StreamCppRequest_ControlToken,
} from '../rpc/cursor-tab_pb';
import { CursorFeatureFlags, DebugConfig } from './types';

export interface ILogger extends vscode.Disposable {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

export interface IConfigService extends vscode.Disposable {
  readonly flags: CursorFeatureFlags;
  readonly debug: DebugConfig;
  readonly onDidChange: vscode.Event<CursorFeatureFlags>;
}

export interface IDocumentTracker extends vscode.Disposable {
  getHistory(uri: vscode.Uri): string[];
  clear(uri: vscode.Uri): void;
}

export interface IRpcClient extends vscode.Disposable {
  // Start server-streaming Cpp request and buffer results internally (cursor-style)
  streamCpp(
    request: StreamCppRequest,
    options: { generateUuid: string; startOfCpp: number; abortController?: AbortController }
  ): Promise<void>;
  flushCpp(
    requestId: string
  ): Promise<
    | { type: 'success'; buffer: Array<string | any>; modelInfo?: any }
    | { type: 'failure'; reason: string }
  >;
  cancelCpp(requestId: string): void;
  getCppReport(): Promise<{ events: any[] }>;

  // Other RPCs
  streamNextCursorPrediction(
    request: StreamNextCursorPredictionRequest,
    abortController?: AbortController
  ): Promise<AsyncIterable<StreamNextCursorPredictionResponse>>;
  refreshTabContext(request: RefreshTabContextRequest): Promise<RefreshTabContextResponse>;
  uploadFile(request: FSUploadFileRequest): Promise<FSUploadFileResponse>;
  syncFile(request: FSSyncFileRequest): Promise<FSSyncFileResponse>;
}

export interface IFileSyncCoordinator extends vscode.Disposable {
  prepareDocument(document: vscode.TextDocument): Promise<void>;
  getSyncPayload(document: vscode.TextDocument): { relyOnFileSync: boolean; updates: FilesyncUpdateWithModelVersion[] };
  shouldRelyOnFileSync(document: vscode.TextDocument): boolean;
}

export interface ICursorPredictionController extends vscode.Disposable {
  handleSuggestionAccepted(editor: vscode.TextEditor): Promise<void>;
  clearForDocument(document: vscode.TextDocument): void;
  showPredictionAt(editor: vscode.TextEditor, line: number): void;
}

export interface IDebounceManager extends vscode.Disposable {
  runRequest(): {
    generationUUID: string;
    startTime: number;
    abortController: AbortController;
    requestIdsToCancel: string[];
  };
  shouldDebounce(requestId: string): Promise<boolean>;
  removeRequest(requestId: string): void;
  abortRequest(requestId: string): void;
  abortAll(): void;
  getRequestCount(): number;
  setDebounceDurations(options: {
    clientDebounceDuration?: number;
    totalDebounceDuration?: number;
    maxConcurrentStreams?: number;
  }): void;
}

export interface IRecentFilesTracker extends vscode.Disposable {
  getAdditionalFilesContext(
    currentUri: vscode.Uri,
    fetchContent?: boolean
  ): Promise<import('./types').AdditionalFileInfo[]>;
}

export interface ILspSuggestionsTracker extends vscode.Disposable {
  recordSuggestions(documentUri: string, suggestions: string[]): void;
  getRelevantSuggestions(documentUri: string): import('./types').LspSuggestionsContext;
  captureCompletionsAt(document: vscode.TextDocument, position: vscode.Position): Promise<void>;
}

export interface ITelemetryService extends vscode.Disposable {
  recordTriggerStart(requestId: string): void;
  recordTriggerEvent(
    document: vscode.TextDocument,
    requestId: string,
    position: vscode.Position,
    source: import('./types').TriggerSource
  ): void;
  recordSuggestionEvent(
    document: vscode.TextDocument,
    requestId: string,
    suggestionText: string
  ): void;
  recordAcceptEvent(document: vscode.TextDocument, requestId: string, acceptedLength: number): void;
  recordRejectEvent(document: vscode.TextDocument, requestId: string, reason?: string): void;
  recordPartialAcceptEvent(
    document: vscode.TextDocument,
    requestId: string,
    acceptedLength: number,
    kind: 'word' | 'line' | 'suggest' | 'unknown'
  ): void;
  recordGenerationFinished(requestId: string, success: boolean): void;
}

/**
 * Interface for workspace-level persistent storage
 * Mirrors Cursor's pb.workspaceUserPersistentStorage and pb.applicationUserPersistentStorage
 */
export interface IWorkspaceStorage extends vscode.Disposable {
  /**
   * Get the unique workspace ID for CPP requests
   * Generated once per workspace and persisted
   */
  getWorkspaceId(): string;

  /**
   * Get control token from application storage
   * Used for non-manual triggers
   */
  getControlToken(): StreamCppRequest_ControlToken | undefined;

  /**
   * Set control token in application storage
   */
  setControlToken(token: StreamCppRequest_ControlToken | undefined): Promise<void>;

  /**
   * Get checkFilesyncHashPercent from config
   */
  getCheckFilesyncHashPercent(): number;

  /**
   * Clear cached values
   */
  clearCache(): void;
}
