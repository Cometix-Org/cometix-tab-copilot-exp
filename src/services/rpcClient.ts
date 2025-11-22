import * as vscode from 'vscode';
import { ApiClient, ApiClientConfig } from '../api/apiClient';
import {
  RefreshTabContextRequest,
  RefreshTabContextResponse,
  StreamCppRequest,
  StreamCppResponse,
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

  async streamCpp(request: StreamCppRequest, abortController?: AbortController): Promise<AsyncIterable<StreamCppResponse>> {
    this.logger.info(`[rpc] StreamCpp request: ${this.stringifyPayload(request)}`);
    const iterable = await this.client.streamCpp(request, abortController);
    return this.logStream('StreamCpp', iterable);
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

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  private createClient(): ApiClient {
    const config = vscode.workspace.getConfiguration('cometixTab');
    const rawBaseUrl = config.get<string>('serverUrl') ?? '';
    const baseUrl = rawBaseUrl.trim().length > 0 ? rawBaseUrl.trim() : undefined;
    const authToken = config.get<string>('authToken') ?? '';
    const clientKey = config.get<string>('clientKey') ?? '';

    const finalConfig: Partial<ApiClientConfig> = {
      baseUrl,
      authToken,
      clientKey,
    };

    const endpointLabel = baseUrl ?? 'default official endpoint';
    this.logger.info(`Initialising Cursor RPC client for ${endpointLabel}`);
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
