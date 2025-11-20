import * as vscode from 'vscode';
import { ApiClient, ApiClientConfig } from '../api/apiClient';
import { EndpointType } from '../api/endpoints';
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
import { Logger } from './logger';

export class RpcClient implements vscode.Disposable {
  private client: ApiClient;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly logger: Logger) {
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
    return this.client.streamCpp(request, abortController);
  }

  async streamNextCursorPrediction(
    request: StreamNextCursorPredictionRequest,
    abortController?: AbortController
  ): Promise<AsyncIterable<StreamNextCursorPredictionResponse>> {
    return this.client.streamNextCursorPrediction(request, abortController);
  }

  async refreshTabContext(request: RefreshTabContextRequest): Promise<RefreshTabContextResponse> {
    return this.client.refreshTabContext(request);
  }

  async uploadFile(request: FSUploadFileRequest): Promise<FSUploadFileResponse> {
    return this.client.uploadFile(request);
  }

  async syncFile(request: FSSyncFileRequest): Promise<FSSyncFileResponse> {
    return this.client.syncFile(request);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  private createClient(): ApiClient {
    const config = vscode.workspace.getConfiguration('cometixTab');
    const endpointType = (config.get<string>('endpointType') ?? 'official') as EndpointType;
    const baseUrl = config.get<string>('serverUrl') ?? undefined;
    const authToken = config.get<string>('authToken') ?? '';
    const clientKey = config.get<string>('clientKey') ?? '';

    const finalConfig: ApiClientConfig = {
      endpointType,
      baseUrl,
      authToken,
      clientKey,
    };

    this.logger.info(`Initialising Cursor RPC client for endpoint "${endpointType}"`);
    return new ApiClient(finalConfig);
  }
}
