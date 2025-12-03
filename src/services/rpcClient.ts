import * as vscode from 'vscode';
import { ApiClient, ApiClientConfig } from '../api/apiClient';
import {
  RefreshTabContextRequest,
  RefreshTabContextResponse,
  StreamCppRequest,
  StreamNextCursorPredictionRequest,
  StreamNextCursorPredictionResponse,
  CursorPredictionConfigRequest,
  CursorPredictionConfigResponse,
  RecordCppFateRequest,
  RecordCppFateResponse,
  CppAppendRequest,
  CppAppendResponse,
  EditHistoryAppendChangesRequest,
  EditHistoryAppendChangesResponse,
  FSUploadFileRequest,
  FSUploadFileResponse,
  FSSyncFileRequest,
  FSSyncFileResponse,
} from '../rpc/cursor-tab_pb';
import { ILogger, IRpcClient } from '../context/contracts';
import { EndpointManager } from './endpointManager';

export class RpcClient implements vscode.Disposable, IRpcClient {
  private client: ApiClient;
  private readonly disposables: vscode.Disposable[] = [];
  private endpointManager: EndpointManager | undefined;

  constructor(private readonly logger: ILogger) {
    this.client = this.createClient();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('cometixTab')) {
          this.logger.info('Configuration changed, refreshing Cursor client');
          this.client = this.createClient();
        }
      })
    );
  }

  /**
   * Set the EndpointManager instance for endpoint resolution
   * This should be called after construction to inject the dependency
   */
  setEndpointManager(manager: EndpointManager): void {
    this.endpointManager = manager;
    // Subscribe to endpoint changes
    this.disposables.push(
      manager.onEndpointChanged(() => {
        this.logger.info('Endpoint changed, refreshing Cursor client');
        this.client = this.createClient();
      })
    );
    // Recreate client with proper endpoints
    this.client = this.createClient();
  }

  async streamCpp(
    request: StreamCppRequest,
    options: { generateUuid: string; startOfCpp: number; abortController?: AbortController }
  ): Promise<void> {
    this.logger.info(`[rpc] StreamCpp request start: ${this.stringifyPayload(request)}`);
    await this.client.streamCpp(request, options as any);
  }

  async flushCpp(requestId: string): Promise<
    | { type: 'success'; buffer: Array<string | any>; modelInfo?: any }
    | { type: 'failure'; reason: string }
  > {
    return this.client.flushCpp(requestId as any);
  }

  cancelCpp(requestId: string): void {
    this.client.cancelCpp(requestId);
  }

  async getCppReport(): Promise<{ events: any[] }> {
    return this.client.getCppReport();
  }

  async streamNextCursorPrediction(
    request: StreamNextCursorPredictionRequest,
    abortController?: AbortController
  ): Promise<AsyncIterable<StreamNextCursorPredictionResponse>> {
    this.logger.info(`[rpc] StreamNextCursorPrediction request: ${this.stringifyPayload(request)}`);
    const iterable = await this.client.streamNextCursorPrediction(request, abortController);
    return this.logStream('StreamNextCursorPrediction', iterable);
  }

  async refreshTabContext(request: RefreshTabContextRequest): Promise<RefreshTabContextResponse> {
    this.logger.info(`[rpc] RefreshTabContext request: ${this.stringifyPayload(request)}`);
    const response = await this.client.refreshTabContext(request);
    this.logger.info(`[rpc] RefreshTabContext response: ${this.stringifyPayload(response)}`);
    return response;
  }

  async uploadFile(request: FSUploadFileRequest): Promise<FSUploadFileResponse> {
    this.logger.info(`[rpc] FSUploadFile request: ${this.stringifyPayload(request)}`);
    const response = await this.client.uploadFile(request);
    this.logger.info(`[rpc] FSUploadFile response: ${this.stringifyPayload(response)}`);
    return response;
  }

  async syncFile(request: FSSyncFileRequest): Promise<FSSyncFileResponse> {
    this.logger.info(`[rpc] FSSyncFile request: ${this.stringifyPayload(request)}`);
    const response = await this.client.syncFile(request);
    this.logger.info(`[rpc] FSSyncFile response: ${this.stringifyPayload(response)}`);
    return response;
  }

  async getCppConfig(): Promise<any> {
    this.logger.info('[rpc] CppConfig request');
    const response = await this.client.getCppConfig();
    this.logger.info(`[rpc] CppConfig response: ${this.stringifyPayload(response)}`);
    return response;
  }

  async cursorPredictionConfig(_request?: CursorPredictionConfigRequest): Promise<CursorPredictionConfigResponse> {
    this.logger.info('[rpc] CursorPredictionConfig request');
    const response = await (this.client as any).cursorPredictionConfig();
    this.logger.info(`[rpc] CursorPredictionConfig response: ${this.stringifyPayload(response)}`);
    return response as CursorPredictionConfigResponse;
  }

  async recordCppFate(request: RecordCppFateRequest): Promise<RecordCppFateResponse> {
    this.logger.info(`[rpc] RecordCppFate request: ${this.stringifyPayload(request)}`);
    const response = await (this.client as any).recordCppFate(request);
    this.logger.info(`[rpc] RecordCppFate response: ${this.stringifyPayload(response)}`);
    return response as RecordCppFateResponse;
  }

  async cppAppend(request: CppAppendRequest): Promise<CppAppendResponse> {
    this.logger.info(`[rpc] CppAppend request`);
    const response = await (this.client as any).cppAppend(request);
    return response as CppAppendResponse;
  }

  async cppEditHistoryAppend(request: EditHistoryAppendChangesRequest): Promise<EditHistoryAppendChangesResponse> {
    this.logger.info(`[rpc] CppEditHistoryAppend request`);
    const response = await (this.client as any).cppEditHistoryAppend(request);
    return response as EditHistoryAppendChangesResponse;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  /**
   * Refresh the API client with current configuration
   * Called when endpoint settings change
   */
  refreshClient(): void {
    this.logger.info('Refreshing Cursor RPC client due to configuration change');
    this.client = this.createClient();
  }

  private createClient(): ApiClient {
    const config = vscode.workspace.getConfiguration('cometixTab');
    const authToken = config.get<string>('authToken') ?? '';
    const clientKey = config.get<string>('clientKey') ?? '';

    // Get endpoints from EndpointManager if available
    let baseUrl: string | undefined;
    let geoCppUrl: string | undefined;
    
    if (this.endpointManager) {
      const resolved = this.endpointManager.resolveEndpoint();
      baseUrl = resolved.baseUrl;
      geoCppUrl = resolved.geoCppUrl;
      this.logger.info(`Initialising Cursor RPC client: mode=${resolved.mode}, baseUrl=${baseUrl}, geoCppUrl=${geoCppUrl}`);
    } else {
      this.logger.info('Initialising Cursor RPC client without EndpointManager (using defaults)');
    }

    const finalConfig: Partial<ApiClientConfig> = {
      baseUrl,
      geoCppUrl,
      authToken,
      clientKey,
    };

    return new ApiClient(finalConfig);
  }

  private stringifyPayload(value: unknown): string {
    try {
      if (value && typeof (value as any).toJson === 'function') {
        return JSON.stringify((value as any).toJson());
      }
      return JSON.stringify(value);
    } catch {
      return '<unserializable>';
    }
  }

  private async *logStream<T extends { toJson?: () => unknown }>(
    name: string,
    source: AsyncIterable<T>,
  ): AsyncIterable<T> {
    let index = 0;
    for await (const item of source) {
      index += 1;
      this.logger.info(`[rpc] ${name} response #${index}: ${this.stringifyPayload(item)}`);
      yield item;
    }
  }
}
