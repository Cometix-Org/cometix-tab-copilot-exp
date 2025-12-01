import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { getOrGenerateClientKey } from '../utils/checksum';
import { Logger } from '../services/logger';
import { OFFICIAL_ENDPOINTS } from '../services/endpointManager';
import { EndpointKey, getEndpointUrl } from './endpoints';
import { 
  StreamCppRequest, 
  StreamCppResponse,
  StreamNextCursorPredictionRequest,
  StreamNextCursorPredictionResponse,
  RefreshTabContextRequest, 
  RefreshTabContextResponse,
  FSUploadFileRequest, 
  FSUploadFileResponse,
  FSSyncFileRequest,
  FSSyncFileResponse 
} from '../rpc/cursor-tab_pb';
import { createClient } from '@connectrpc/connect';
import type { Client } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { AiService, FileSyncService } from '../rpc/cursor-tab_connect';

type AiClient = Client<typeof AiService>;
type FileSyncClient = Client<typeof FileSyncService>;

export interface ApiClientConfig {
  /** General API endpoint (HTTP/1.1) - for CppConfig, RefreshTabContext, FileSync */
  baseUrl: string;
  /** Completion API endpoint - for StreamCpp (can be regional gcpp or same as baseUrl) */
  geoCppUrl: string;
  /** Auth token for API requests */
  authToken: string;
  /** Client key for API requests */
  clientKey: string;
}

export class ApiClient {
  private config: ApiClientConfig;
  private aiClient: AiClient | null = null;
  private fileSyncClient: FileSyncClient | null = null;
  private readonly fsClientKey: string;
  private readonly requestContextMap: WeakMap<any, { url: string; headers: Record<string, string>; body: string; timestamp: string } > = new WeakMap();
  // cursor-style streaming state
  private streams: Array<{
    generationUUID: string;
    abortController: AbortController;
    startTime: number;
    modelInfo?: any;
    buffer: Array<string | any>;
  }> = [];
  private succeeded: string[] = [];
  private readonly DONE_SENTINEL = 'm4CoTMbqtR9vV1zd';
  private cppEvents: Array<any> = [];
  // Store preflight proto->json bodies by request id for formal logging
  private pendingRequestBodiesById: Map<string, unknown> = new Map();

  constructor(config?: Partial<ApiClientConfig>) {
    this.config = this.loadConfig(config);
    this.fsClientKey = randomBytes(32).toString('hex');
    this.initializeClients();
  }

  /** Get the shared output channel */
  private get channel(): vscode.OutputChannel {
    return Logger.getSharedChannel();
  }

  private loadConfig(override?: Partial<ApiClientConfig>): ApiClientConfig {
    const vscodeConfig = vscode.workspace.getConfiguration('cometixTab');

    // baseUrl and geoCppUrl should be provided by the caller (via EndpointManager)
    // Fall back to default api2 if not provided
    const baseUrl = override?.baseUrl?.trim() || OFFICIAL_ENDPOINTS.api2;
    const geoCppUrl = override?.geoCppUrl?.trim() || baseUrl;

    // Auto-generate client key if not provided
    let clientKey = override?.clientKey || vscodeConfig.get<string>('clientKey') || '';
    if (!clientKey || clientKey.trim() === '') {
      clientKey = getOrGenerateClientKey();
      // Save auto-generated client key to global config
      vscodeConfig.update('clientKey', clientKey, vscode.ConfigurationTarget.Global);
    }

    this.channel?.appendLine(`[config] ApiClient initialized: baseUrl=${baseUrl}, geoCppUrl=${geoCppUrl}`);

    return {
      baseUrl,
      geoCppUrl,
      authToken: override?.authToken || vscodeConfig.get<string>('authToken') || '',
      clientKey
    };
  }

  private initializeClients() {
    const transport = createConnectTransport({
      baseUrl: this.config.baseUrl!,
      httpVersion: '1.1',
      interceptors: [
        (next: any) => async (req: any) => {
          // 濞ｈ�濮炵拋銈堢槈婢舵挳鍎?
          if (this.config.authToken) {
            req.header.set('Authorization', `Bearer ${this.config.authToken}`);
          }
          const checksum = buildCursorChecksum(vscode.env.machineId);
          if (checksum) {
            req.header.set('x-cursor-checksum', checksum);
          }
          if (this.config.clientKey) {
            req.header.set('x-client-key', this.config.clientKey);
          }
          req.header.set('x-cursor-client-version', '1.5.5');
          req.header.set('x-fs-client-key', this.fsClientKey);
          
          // 濞ｈ�濮炴潻鍊熼嚋婢舵挳鍎?
          const rid = cryptoRandomUUIDSafe();
          req.header.set('x-request-id', rid);
          req.header.set('x-amzn-trace-id', `Root=${rid}`);
          try {
            const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            req.header.set('x-cursor-timezone', tz);
          } catch { }

          // 閺冦儱绻旂拋鏉跨秿
          await this.logConnectRequest(req);
          
          try {
            const result = await next(req);
            // 濞翠礁绱￠崫宥呯安閿涙艾瀵樼憗鍛�簰鐠佹澘缍嶅В蹇庨嚋閸掑棛澧?
            if (isAsyncIterable(result)) {
              return this.wrapStreamingResponseWithLogging(req, result);
            }
            await this.logConnectResponse(req, result);
            return result;
          } catch (error) {
            await this.logConnectError(req, error);
            throw error;
          }
        }
      ]
    });

    this.aiClient = createClient(AiService, transport);
    this.fileSyncClient = createClient(FileSyncService, transport);
  }

  updateConfig(newConfig: Partial<ApiClientConfig>) {
    this.config = { ...this.config, ...newConfig };
    this.initializeClients();
  }

  private getUrl(endpoint: EndpointKey): string {
    return getEndpointUrl(this.config.baseUrl!, endpoint);
  }

  private getHeaders(contentType = 'application/json'): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'User-Agent': 'connectrpc/1.6.1'
    };

    if (this.config.authToken) {
      headers['Authorization'] = `Bearer ${this.config.authToken}`;
    }

    const checksum = buildCursorChecksum(vscode.env.machineId);
    if (checksum) {
      headers['x-cursor-checksum'] = checksum;
    }
    if (this.config.clientKey) {
      headers['x-client-key'] = this.config.clientKey;
    }
    headers['x-cursor-client-version'] = '1.5.5';
    headers['x-fs-client-key'] = this.fsClientKey;

    // Common tracing / ghost headers
    const rid = cryptoRandomUUIDSafe();
    headers['x-request-id'] = rid;
    headers['x-amzn-trace-id'] = `Root=${rid}`;
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      headers['x-cursor-timezone'] = tz;
    } catch { }

    return headers;
  }

  // Fetch 鐠囬攱鐪版稉濠佺瑓閺傚浄绱欓悽銊ょ艾闁挎瑨顕ら弮鎯扮翻閸戠尨绱?
  private lastFetchContext: {
    kind: string;
    url: string;
    headers: Record<string, string>;
    body: string;
    timestamp: string;
  } | null = null;

  private async logRequest(kind: string, url: string, headers: Record<string, string>, body: any) {
    try {
      const ts = new Date().toISOString();
      // Shallow clone and mask sensitive headers
      const safeHeaders: Record<string, string> = { ...headers };
      const mask = (v: string) => (typeof v === 'string' && v.length > 12) ? `${v.slice(0, 6)}...${v.slice(-4)}` : '***';
      if (safeHeaders['Authorization']) {
        safeHeaders['Authorization'] = mask(safeHeaders['Authorization']);
      }
      if (safeHeaders['x-client-key']) {
        safeHeaders['x-client-key'] = mask(safeHeaders['x-client-key']);
      }
      if (safeHeaders['x-cursor-checksum']) {
        safeHeaders['x-cursor-checksum'] = mask(safeHeaders['x-cursor-checksum']);
      }

      // 閻㈢喐鍨氱拠閿嬬湴娴ｆ挸鐡х粭锔胯�
      let bodyStr = '<none>';
      
      if (body !== null && body !== undefined) {
        const contentType = (headers['Content-Type'] || headers['content-type'] || '').toLowerCase();
        const isProto = contentType.includes('application/proto');

        if ((body instanceof Uint8Array || ArrayBuffer.isView(body)) && isProto) {
          const bytes = body as Uint8Array;
          try {
            let jsonObj: any | undefined;
            switch (kind) {
              case 'streamCpp':
                jsonObj = protoToJson(StreamCppRequest.fromBinary(bytes));
                break;
              case 'refreshTabContext':
                jsonObj = protoToJson(RefreshTabContextRequest.fromBinary(bytes));
                break;
              case 'uploadFile':
                jsonObj = protoToJson(FSUploadFileRequest.fromBinary(bytes));
                break;
              case 'syncFile':
                jsonObj = protoToJson(FSSyncFileRequest.fromBinary(bytes));
                break;
            }
            if (jsonObj !== undefined) {
              bodyStr = JSON.stringify(jsonObj);
            }
          } catch {
            const previewLen = Math.min(bytes.byteLength, 256);
            const preview = Buffer.from(bytes.slice(0, previewLen)).toString('base64');
            bodyStr = `<binary: ${bytes.byteLength}b, preview=${preview.slice(0, 50)}...>`;
          }
        } else if (typeof body === 'string') {
          try {
            const obj = JSON.parse(body);
            bodyStr = JSON.stringify(obj);
          } catch {
            bodyStr = body;
          }
        } else {
          try {
            bodyStr = JSON.stringify(body);
          } catch {
            bodyStr = '<unserializable>';
          }
        }
      }

      // 娣囨繂鐡ㄧ拠閿嬬湴娑撳﹣绗呴弬鍥︾返闁挎瑨顕ら弮鏈靛▏??
      this.lastFetchContext = {
        kind,
        url,
        headers: safeHeaders,
        body: bodyStr,
        timestamp: ts
      };
    } catch {
      // never throw on logging
    }
  }

  private async logResponse(
    kind: string, 
    url: string, 
    status: number, 
    headers: Headers, 
    body: any,
    isProto: boolean
  ) {
    try {
      const ts = new Date().toISOString();
      
      // 閹存劕濮涢崫宥呯安閸欘亣绶�崙铏圭暆鐟曚椒淇??
      if (status >= 200 && status < 300) {
        this.channel?.appendLine(`[${ts}] ??${kind} ??${status}`);
        this.lastFetchContext = null;
        return;
      }
      
      // 闁挎瑨顕ら崫宥呯安鏉堟挸鍤�€瑰本鏆ｆ穱鈩冧紖
      this.channel?.appendLine('');
      this.channel?.appendLine(`[${ts}] ??${kind} FAILED`);
      this.channel?.appendLine(`[${ts}] Response Status: ${status}`);
      
      // 鏉堟挸鍤�€瑰本鏆ｉ惃鍕�嚞濮瑰倷淇??
      if (this.lastFetchContext) {
        this.channel?.appendLine(`[${ts}] Request URL: ${this.lastFetchContext.url}`);
        this.channel?.appendLine(`[${ts}] Request Headers: ${JSON.stringify(this.lastFetchContext.headers)}`);
        this.channel?.appendLine(`[${ts}] Request Body: ${this.lastFetchContext.body}`);
      }
      
      // 鏉堟挸鍤�崫宥呯安??
      const responseHeaders: Record<string, string> = {};
      headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      this.channel?.appendLine(`[${ts}] Response Headers: ${JSON.stringify(responseHeaders)}`);

      // 鏉堟挸鍤�崫宥呯安娴ｆ搫绱欐俊鍌涚亯閺堝�绱?
      if (body !== null && body !== undefined) {
        if ((body instanceof Uint8Array || ArrayBuffer.isView(body)) && isProto) {
          const bytes = body as Uint8Array;
          try {
            let jsonObj: any | undefined;
            switch (kind) {
              case 'refreshTabContext':
                jsonObj = protoToJson(RefreshTabContextResponse.fromBinary(bytes));
                break;
              case 'uploadFile':
                jsonObj = protoToJson(FSUploadFileResponse.fromBinary(bytes));
                break;
              case 'syncFile':
                jsonObj = protoToJson(FSSyncFileResponse.fromBinary(bytes));
                break;
            }
            if (jsonObj !== undefined) {
              this.channel?.appendLine(`[${ts}] Response Body (proto->json): ${JSON.stringify(jsonObj)}`);
            }
          } catch (e) {
            this.channel?.appendLine(`[${ts}] Response Body (proto decode failed): ${String(e)}`);
          }
        } else if (typeof body === 'object') {
          try {
            this.channel?.appendLine(`[${ts}] Response Body (json): ${JSON.stringify(body)}`);
          } catch {
            this.channel?.appendLine(`[${ts}] Response Body: <unserializable object>`);
          }
        } else if (typeof body === 'string') {
          try {
            const obj = JSON.parse(body);
            this.channel?.appendLine(`[${ts}] Response Body (json): ${JSON.stringify(obj)}`);
          } catch {
            const preview = body.length > 500 ? body.substring(0, 500) + '...' : body;
            this.channel?.appendLine(`[${ts}] Response Body (string): ${preview}`);
          }
        }
      } else {
        this.channel?.appendLine(`[${ts}] Response Body: <none>`);
      }
      
      this.channel?.appendLine('');
      this.lastFetchContext = null;
    } catch {
      // never throw on logging
    }
  }

  // Start a cursor-style streaming session and buffer results for polling
  async streamCpp(
    request: StreamCppRequest,
    options: { generateUuid: string; startOfCpp: number; abortController?: AbortController }
  ): Promise<void> {
    if (!this.aiClient) {
      throw new Error('AI client is not initialized');
    }
    const startTs = Date.now();
    const controller = options.abortController ?? new AbortController();
    let aborted = false;
    controller.signal.addEventListener('abort', () => {
      aborted = true;
    });
    this.streams.push({
      generationUUID: options.generateUuid,
      abortController: controller,
      startTime: performance.now?.() ?? 0,
      modelInfo: undefined,
      buffer: [],
    });

    try {
      // Enrich request to mirror cursor fields
      const isDebug = (this.config.baseUrl?.includes('localhost') || this.config.baseUrl?.includes('lclhst.build')) ?? false;
      // Ensure we carry over all fields from the original message
      const enriched = StreamCppRequest.fromJson({
        ...(typeof (request as any).toJson === 'function' ? (request as any).toJson() : {}),
        giveDebugOutput: isDebug,
        isDebug,
        supportsCpt: true,
        supportsCrlfCpt: true,
        workspaceId: (request as any)?.workspaceId ?? '',
        timeSinceRequestStart: Math.max(0, Date.now() - options.startOfCpp),
        timeAtRequestSend: Date.now(),
        clientTimezoneOffset: new Date().getTimezoneOffset(),
        contextItems: (request as any)?.contextItems ?? [],
        filesyncUpdates: (request as any)?.filesyncUpdates ?? [],
      });

      // Emit explicit log of the proto->json body to the channel
      try {
        const json = enriched.toJson();
        this.pendingRequestBodiesById.set(options.generateUuid, json);
        const ts = new Date().toISOString();
        this.channel?.appendLine(`[${ts}] StreamCpp (preflight) Request Body (proto->json): ${JSON.stringify(json)}`);
      } catch {}

      const iterable = (await this.aiClient.streamCpp(enriched, {
        signal: controller.signal,
        headers: { 'x-request-id': options.generateUuid },
      })) as unknown as AsyncIterable<StreamCppResponse>;

      (async () => {
        try {
          let chunkIndex = 0;
          for await (const chunk of iterable) {
            chunkIndex++;
            
            const s = this.streams.find((x) => x.generationUUID === options.generateUuid);
            if (!s) {
              aborted = true;
              break;
            }
            // Map incoming chunk fields into buffer entries, mirroring cursor semantics
            const anyChunk: any = chunk as any;
            
            // Detailed logging for debugging proto parsing issues
            try {
              const chunkFields: string[] = [];
              if (anyChunk.modelInfo) {chunkFields.push('modelInfo');}
              if (anyChunk.rangeToReplace) {
                const rtr = anyChunk.rangeToReplace;
                chunkFields.push(`range:L${rtr.startLineNumber}-${rtr.endLineNumberInclusive}`);
              }
              if (typeof anyChunk.text === 'string') {
                chunkFields.push(`text(${anyChunk.text.length}chars)`);
              }
              if (anyChunk.beginEdit) {chunkFields.push('beginEdit');}
              if (anyChunk.doneEdit) {chunkFields.push('doneEdit');}
              if (anyChunk.doneStream) {chunkFields.push('doneStream');}
              if (anyChunk.cursorPredictionTarget) {chunkFields.push('cursorPredictionTarget');}
              if (anyChunk.bindingId) {chunkFields.push(`bindingId:${anyChunk.bindingId}`);}
              
              this.channel?.appendLine(
                `[api] StreamCpp chunk #${chunkIndex} for ${options.generateUuid.slice(0,8)}: [${chunkFields.join(', ')}]`
              );
              
              // Log full text content for text chunks (important for debugging)
              if (typeof anyChunk.text === 'string' && anyChunk.text.length > 0) {
                // Log text in chunks if very long
                const textPreview = anyChunk.text.length > 200 
                  ? `${anyChunk.text.slice(0, 100)}...${anyChunk.text.slice(-100)}`
                  : anyChunk.text;
                this.channel?.appendLine(
                  `[api] StreamCpp chunk #${chunkIndex} TEXT FULL (${anyChunk.text.length} chars): "${textPreview.replace(/\n/g, '\\n')}"`
                );
              }
            } catch {}
            
            if (anyChunk.modelInfo) {
              s.modelInfo = anyChunk.modelInfo;
            }
            if (anyChunk.rangeToReplace) {
              // Extract LineRange fields properly from proto message
              const rtr = anyChunk.rangeToReplace;
              s.buffer.push({
                case: 'rangeToReplace',
                rangeToReplaceOneIndexed: {
                  startLineNumber: rtr.startLineNumber,
                  endLineNumberInclusive: rtr.endLineNumberInclusive,
                  shouldRemoveLeadingEol: anyChunk.shouldRemoveLeadingEol ?? false,
                },
                bindingId: anyChunk.bindingId,
              });
            }
            if (typeof anyChunk.text === 'string' && anyChunk.text.length > 0) {
              s.buffer.push(anyChunk.text as string);
            }
            if (anyChunk.cursorPredictionTarget) {
              const cpt = anyChunk.cursorPredictionTarget;
              this.channel?.appendLine(
                `[api] ⭐⭐⭐ CURSOR_PREDICTION_TARGET RECEIVED ⭐⭐⭐`
              );
              this.channel?.appendLine(
                `[api] 📍 CursorPrediction: path="${cpt.relativePath}", line=${cpt.lineNumberOneIndexed}, retrigger=${cpt.shouldRetriggerCpp}, expectedContent="${(cpt.expectedContent || '').slice(0, 50)}"`
              );
              s.buffer.push({
                case: 'cursorPredictionTarget',
                cursorPredictionTarget: anyChunk.cursorPredictionTarget,
                bindingId: anyChunk.bindingId,
              });
            }
            if (anyChunk.beginEdit) {
              s.buffer.push({ case: 'beginEdit', beginEdit: true });
            }
            if (anyChunk.doneEdit) {
              s.buffer.push({ case: 'doneEdit', doneEdit: true });
            }
            if (anyChunk.doneStream) {
              // end of stream signalled by server
              s.buffer.push(this.DONE_SENTINEL);
              break;
            }
          }
          this.channel?.appendLine(
            `[api] StreamCpp stream completed for ${options.generateUuid.slice(0,8)}: ${chunkIndex} chunks received`
          );
        } catch (innerErr: any) {
          // Log the error for debugging
          this.channel?.appendLine(
            `[api] StreamCpp stream error for ${options.generateUuid}: ${innerErr?.message ?? String(innerErr)}`
          );
          const s = this.streams.find((x) => x.generationUUID === options.generateUuid);
          if (s) {
            // Store error info for flushCpp to report
            (s as any).streamError = innerErr?.message ?? String(innerErr);
          }
        } finally {
          // Mark completion
          const s = this.streams.find((x) => x.generationUUID === options.generateUuid);
          if (s && !s.buffer.includes(this.DONE_SENTINEL)) {
            s.buffer.push(this.DONE_SENTINEL);
          }
          this.succeeded.push(options.generateUuid);
          this.succeeded = this.succeeded.slice(-20);
          // add minimal event
          this.cppEvents.unshift({
            requestId: options.generateUuid,
            timestamp: startTs,
            modelName: (request as any)?.modelName ?? 'unspecified',
            metrics: {},
          });
          if (this.cppEvents.length > 20) {this.cppEvents = this.cppEvents.slice(0, 20);}
        }
      })();
    } catch (e: any) {
      // Refresh on enhance calm like cursor
      if (e?.message && String(e.message).includes('ENHANCE_YOUR_CALM')) {
        this.channel?.appendLine(`[api] Refreshing client due to ENHANCE_YOUR_CALM for ${options.generateUuid}`);
        this.initializeClients();
      }
      this.channel?.appendLine(`[api] Error starting streamCpp: ${e?.message ?? String(e)}`);
    }
  }

  cancelCpp(requestId: string): void {
    this.streams.find((t) => t.generationUUID === requestId)?.abortController.abort();
    this.streams = this.streams.filter((t) => t.generationUUID !== requestId);
    // GC old streams
    this.streams = this.streams.filter((e) => (performance.now?.() ?? 0) - e.startTime < 8000);
  }

  flushCpp(requestId: string):
    Promise<{ type: 'success'; buffer: Array<string | any>; modelInfo?: any } | { type: 'failure'; reason: string }>
  {
    const s = this.streams.find((t) => t.generationUUID === requestId);
    if (!s) {
      if (this.succeeded.includes(requestId)) {
        return Promise.resolve({ type: 'success', buffer: [this.DONE_SENTINEL], modelInfo: undefined });
      }
      return Promise.resolve({ type: 'failure', reason: 'stream not found' });
    }
    // Check for stream error
    const streamError = (s as any).streamError;
    if (streamError) {
      this.streams = this.streams.filter((t) => t.generationUUID !== requestId);
      return Promise.resolve({ type: 'failure', reason: `stream error: ${streamError}` });
    }
    if ((performance.now?.() ?? 0) - (s.startTime ?? 0) > 10000) {
      this.streams = this.streams.filter((t) => t.generationUUID !== requestId);
      return Promise.resolve({ type: 'failure', reason: 'stream took too long' });
    }
    const buff = s.buffer;
    s.buffer = [];
    if (this.succeeded.includes(requestId)) {
      this.streams = this.streams.filter((t) => t.generationUUID !== requestId);
    }
    return Promise.resolve({ type: 'success', buffer: buff, modelInfo: s.modelInfo });
  }

  async getCppReport(): Promise<{ events: any[] }> {
    return { events: [...this.cppEvents].sort((a, b) => b.timestamp - a.timestamp) };
  }

  async streamNextCursorPrediction(
    request: StreamNextCursorPredictionRequest,
    abortController?: AbortController
  ): Promise<AsyncIterable<StreamNextCursorPredictionResponse>> {
    if (!this.aiClient) {
      throw new Error('AI client is not initialized');
    }

    const stream = this.aiClient.streamNextCursorPrediction(request, { signal: abortController?.signal }) as unknown as AsyncIterable<StreamNextCursorPredictionResponse>;
    return stream;
  }

  async refreshTabContext(request: RefreshTabContextRequest): Promise<RefreshTabContextResponse> {
    if (!this.aiClient) {
      throw new Error('AI client is not initialized');
    }

    const response = (await this.aiClient.refreshTabContext(request)) as unknown as RefreshTabContextResponse;
    return response;
  }

  async getCppConfig(): Promise<any> {
    if (!this.aiClient) {
      throw new Error('AI client is not initialized');
    }

    const { CppConfigRequest } = await import('../rpc/cursor-tab_pb.js');
    const request = new CppConfigRequest({});
    return await this.aiClient.cppConfig(request);
  }

  async uploadFile(request: FSUploadFileRequest): Promise<FSUploadFileResponse> {
    if (!this.fileSyncClient) {
      throw new Error('File sync client is not initialized');
    }

    const response = (await this.fileSyncClient.fSUploadFile(request)) as unknown as FSUploadFileResponse;
    return response;
  }

  async syncFile(request: FSSyncFileRequest): Promise<FSSyncFileResponse> {
    if (!this.fileSyncClient) {
      throw new Error('File sync client is not initialized');
    }

    const response = (await this.fileSyncClient.fSSyncFile(request)) as unknown as FSSyncFileResponse;
    return response;
  }

  // Helper: ??ReadableStream 鏉烆剚宕??AsyncIterable
  private async *streamToAsyncIterable<T>(
    stream: ReadableStream<Uint8Array>,
    factory: (json: unknown) => T
  ): AsyncIterable<T> {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const text = new TextDecoder().decode(value);
        const json = JSON.parse(text);
        yield factory(json);
      }
    } finally {
      reader.releaseLock();
    }
  }
  private lastRequestContext: {
    url: string;
    headers: Record<string, string>;
    body: string;
    timestamp: string;
  } | null = null;

  // Connect RPC 鐠囬攱鐪伴弮銉ョ箶閿涘牅绮庢穱婵嗙摠娑撳﹣绗呴弬鍥风礉娑撳秶鐝涢崡瀹犵翻閸戠尨绱?
  private async logConnectRequest(req: any) {
    try {
      const ts = new Date().toISOString();
      const url = req.url || 'unknown';
      
      // 閺€鍫曟肠婢舵挳鍎?
      const headers: Record<string, string> = {};
      req.header.forEach((value: string, key: string) => {
        headers[key] = value;
      });

      // 閹衡晝鐖滈弫蹇斿妳娣団剝浼?
      const safeHeaders = { ...headers };
      const mask = (v: string) => (typeof v === 'string' && v.length > 12) ? `${v.slice(0, 6)}...${v.slice(-4)}` : '***';
      if (safeHeaders['authorization']) {
        safeHeaders['authorization'] = mask(safeHeaders['authorization']);
      }
      if (safeHeaders['x-cursor-checksum']) {
        safeHeaders['x-cursor-checksum'] = mask(safeHeaders['x-cursor-checksum']);
      }

      // 鐠佹澘缍嶇拠閿嬬湴??
      let bodyStr = '<none>';
      if (req.message) {
        try {
          bodyStr = serializeMessage(req.message);
        } catch {
          bodyStr = '<protobuf message>';
        }
      }

      // 娣囨繂鐡ㄧ拠閿嬬湴娑撳﹣绗呴弬鍥风礄閹稿�顕�Ч鍌濈�闊�亷绱?
      this.requestContextMap.set(req, {
        url,
        headers: safeHeaders,
        body: bodyStr,
        timestamp: ts,
      });
    } catch {
      // 閺冦儱绻旂拋鏉跨秿婢惰精瑙︽稉宥呯安瑜板崬鎼风拠閿嬬湴
    }
  }

  // Connect RPC 閸濆秴绨查弮銉ョ箶閿涘牊鍨氶崝鐔告�鏉堟挸鍤�拠锔剧矎娑撳﹣绗呴弬鍥风礆
  private async logConnectResponse(req: any, res: any) {
    try {
      const ts = new Date().toISOString();
      const url = req.url || 'unknown';
      const method = url.split('/').pop() || 'unknown';

      const status = typeof res?.status === 'number' ? res.status : 200;
      const responseBody = safeSerialize(res?.message ?? res);

      this.channel?.appendLine(`[${ts}] ${method} -> ${status} OK`);
      const ctx = this.requestContextMap.get(req);
      if (ctx) {
        this.channel?.appendLine(`[${ts}]   Request URL: ${ctx.url}`);
        this.channel?.appendLine(`[${ts}]   Request Headers: ${JSON.stringify(ctx.headers)}`);
        this.channel?.appendLine(`[${ts}]   Request Body (proto->json): ${ctx.body}`);
      } else {
        const reason = getMissingContextReason(req, res);
        this.channel?.appendLine(`[${ts}]   Request context unavailable: ${reason}`);
      }
      this.channel?.appendLine(`[${ts}]   Response Body (proto->json): ${responseBody}`);

      // 濞撳懘娅庣拠閿嬬湴娑撳﹣绗呴弬?
      this.requestContextMap.delete(req);
    } catch {
      // 閺冦儱绻旂拋鏉跨秿婢惰精瑙︽稉宥呯安瑜板崬鎼烽崫宥呯安
    }
  }

  // Connect RPC 濞翠礁绱￠崫宥呯安閺冦儱绻旈敍鍫濐嚠濮ｅ繋閲滈崚鍡欏�鏉堟挸鍤�敍?
    // Connect RPC streaming logging (per chunk)
  private wrapStreamingResponseWithLogging<T>(req: any, source: AsyncIterable<T>): AsyncIterable<T> {
    const url = req.url || 'unknown';
    const method = url.split('/').pop() || 'unknown';
    const startTs = new Date().toISOString();

    // stream start
    this.channel?.appendLine(`[${startTs}] ${method} -> 200 OK (stream started)`);
    const startCtx = this.requestContextMap.get(req);
    if (startCtx) {
      this.channel?.appendLine(`[${startTs}]   Request URL: ${startCtx.url}`);
      this.channel?.appendLine(`[${startTs}]   Request Headers: ${JSON.stringify(startCtx.headers)}`);
      this.channel?.appendLine(`[${startTs}]   Request Body (proto->json): ${startCtx.body}`);
    } else {
      const reason = getMissingContextReason(req, undefined);
      this.channel?.appendLine(`[${startTs}]   Request context unavailable: ${reason}`);
    }
    this.requestContextMap.delete(req);

    const self = this;
    async function* generator() {
      let index = 0;
      try {
        for await (const chunk of source as AsyncIterable<any>) {
          index += 1;
          const ts = new Date().toISOString();
          const body = safeSerialize((chunk as any)?.message ?? chunk);
          self.channel?.appendLine(`[${ts}]   Stream chunk #${index} (proto->json): ${body}`);
          yield chunk as T;
        }
        const endTs = new Date().toISOString();
        self.channel?.appendLine(`[${endTs}] ${method} stream completed (${index} chunk${index === 1 ? '' : 's'})`);
      } catch (err) {
        const ts = new Date().toISOString();
        self.channel?.appendLine(`[${ts}] ${method} stream error: ${err instanceof Error ? err.message : String(err)}`);
        await self.logConnectError(req, err);
        throw err;
      }
    }

    return generator();
  }
    // Connect RPC 错误日志（输出完整的请求上下文）
  private async logConnectError(req: any, error: any) {
    try {
      const ts = new Date().toISOString();
      const url = req.url || 'unknown';
      const method = url.split('/').pop() || 'unknown';

      this.channel?.appendLine('');
      this.channel?.appendLine(`[${ts}] ${method} FAILED`);
      this.channel?.appendLine(`[${ts}] Error: ${error?.message || String(error)}`);
      if ((error as any)?.code) {
        this.channel?.appendLine(`[${ts}] Error Code: ${(error as any).code}`);
      }

      // 输出完整的请求信息
      const errCtx = this.requestContextMap.get(req);
      if (errCtx) {
        this.channel?.appendLine(`[${ts}] Request URL: ${errCtx.url}`);
        this.channel?.appendLine(`[${ts}] Request Headers: ${JSON.stringify(errCtx.headers)}`);
        this.channel?.appendLine(`[${ts}] Request Body (proto->json): ${errCtx.body}`);
      }

      this.channel?.appendLine('');
      this.requestContextMap.delete(req);
    } catch {
      // 日志记录失败不应影响错误处理
    }
  }
  getEndpointInfo(): { baseUrl: string; geoCppUrl: string; isDefaultUrl: boolean } {
    const isDefaultUrl = this.config.baseUrl === OFFICIAL_ENDPOINTS.api2;
    return {
      baseUrl: this.config.baseUrl,
      geoCppUrl: this.config.geoCppUrl,
      isDefaultUrl
    };
  }

  validateConfiguration(): { isValid: boolean; issues: string[] } {
    const issues: string[] = [];

    if (!this.config.baseUrl) {
      issues.push('Base URL is not set');
    }

    if (!this.config.authToken) {
      issues.push('Auth token is not set');
    }

    if (!this.config.clientKey) {
      issues.push('Client key is not set');
    }

    // 允许用户使用自定义 URL，不再强制检查是否为官方 URL

    return {
      isValid: issues.length === 0,
      issues
    };
  }
}

function cryptoRandomUUIDSafe(): string {
  if (typeof (globalThis as any).crypto?.randomUUID === 'function') {
    return (globalThis as any).crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

function protoToJson(message: unknown): unknown {
  if (message && typeof (message as any).toJson === 'function') {
    return (message as any).toJson();
  }
  return undefined;
}

function serializeMessage(message: unknown): string {
  const payload = protoToJson(message);
  if (payload !== undefined) {
    return JSON.stringify(payload);
  }
  return JSON.stringify(message);
}

function safeSerialize(value: unknown, maxLength = 4000): string {
  try {
    const text = serializeMessage(value);
    if (text.length > maxLength) {
      return `${text.slice(0, maxLength)}...`;
    }
    return text;
  } catch {
    return '<unserializable>';
  }
}
function getMissingContextReason(this: any, req: any, res: any): string {
  try {
    if (isAsyncIterable(res)) {
      return 'server-streaming response; context logged at stream start';
    }
    if (req?.body && typeof req.body.getReader === 'function') {
      return 'streaming request body (ReadableStream)';
    }
    if (!req?.message && !req?.body) {
      return 'transport did not expose request message/body';
    }
    return 'request serialization skipped or failed';
  } catch {
    return 'unknown transport condition';
  }
}
function isAsyncIterable(value: any): value is AsyncIterable<unknown> {
  try {
    return value !== null && typeof value[Symbol.asyncIterator] === 'function';
  } catch {
    return false;
  }
}

// Build the Cursor-style checksum header: obfuscated timestamp + machineId
function buildCursorChecksum(machineId: string | undefined): string | undefined {
  if (!machineId) {
    return undefined;
  }
  try {
    const ts = Math.floor(Date.now() / 1e6); // matches official client
    const buf = new Uint8Array([
      (ts >> 40) & 255,
      (ts >> 32) & 255,
      (ts >> 24) & 255,
      (ts >> 16) & 255,
      (ts >> 8) & 255,
      ts & 255
    ]);
    let seed = 165;
    for (let i = 0; i < buf.length; i++) {
      buf[i] = (buf[i] ^ seed) + (i % 256);
      seed = buf[i];
    }
    const encoded = Buffer.from(buf).toString('base64').replace(/=+$/, '');
    return `${encoded}${machineId}`;
  } catch {
    return undefined;
  }
}