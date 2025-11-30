import * as vscode from 'vscode';
import { ApiClient, ApiClientConfig } from '../api/apiClient';
import {
  RefreshTabContextRequest,
  RefreshTabContextResponse,
  StreamCppRequest,
  StreamNextCursorPredictionRequest,
  StreamNextCursorPredictionResponse,
  FSUploadFileRequest,
  FSUploadFileResponse,
  FSSyncFileRequest,
  FSSyncFileResponse,
} from '../rpc/cursor-tab_pb';
import { ILogger, IRpcClient } from '../context/contracts';

export class RpcClient implements vscode.Disposable, IRpcClient {
  private client: ApiClient;
  private readonly disposables: vscode.Disposable[] = [];

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
    
    // Let ApiClient handle endpoint resolution based on mode
    // Only pass override values if explicitly set
    const authToken = config.get<string>('authToken') ?? '';
    const clientKey = config.get<string>('clientKey') ?? '';

    const finalConfig: Partial<ApiClientConfig> = {
      authToken,
      clientKey,
    };

    this.logger.info(`Initialising Cursor RPC client with endpoint mode: ${config.get<string>('endpointMode') || 'auto'}`);
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
