import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { getOrGenerateClientKey } from '../utils/checksum';
import { DEFAULT_BASE_URL, EndpointKey, getEndpointUrl } from './endpoints';
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
  baseUrl?: string;
  authToken: string;
  clientKey: string;
}

export class ApiClient {
  private config: ApiClientConfig;
  private static channel: vscode.OutputChannel | undefined;
  private aiClient: AiClient | null = null;
  private fileSyncClient: FileSyncClient | null = null;
  private readonly fsClientKey: string;

  constructor(config?: Partial<ApiClientConfig>) {
    this.config = this.loadConfig(config);
    this.fsClientKey = randomBytes(32).toString('hex');
    if (!ApiClient.channel) {
      ApiClient.channel = vscode.window.createOutputChannel('CometixTab', { log: true });
    }
    this.initializeClients();
  }

  private loadConfig(override?: Partial<ApiClientConfig>): ApiClientConfig {
    const vscodeConfig = vscode.workspace.getConfiguration('cometixTab');

    const customBaseUrl = override?.baseUrl || vscodeConfig.get<string>('serverUrl');

    // 智能URL检测：如果用户没有设置自定义URL，或者当前URL不是官方域名，使用默认官方URL
    let baseUrl: string;
    if (!customBaseUrl || customBaseUrl.trim() === '') {
      baseUrl = DEFAULT_BASE_URL;
    } else {
      const isOfficialUrl = customBaseUrl.includes('api2.cursor.sh') || customBaseUrl.includes('cursor.sh');
      baseUrl = isOfficialUrl ? customBaseUrl : DEFAULT_BASE_URL;
    }

    // 如果没有客户端密钥，自动生成一个
    let clientKey = override?.clientKey || vscodeConfig.get<string>('clientKey') || '';
    if (!clientKey || clientKey.trim() === '') {
      clientKey = getOrGenerateClientKey();
      // 保存生成的客户端密钥到配置中
      vscodeConfig.update('clientKey', clientKey, vscode.ConfigurationTarget.Global);
    }

    return {
      baseUrl,
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
          // 添加认证头部
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
          
          // 添加追踪头部
          const rid = cryptoRandomUUIDSafe();
          req.header.set('x-request-id', rid);
          req.header.set('x-amzn-trace-id', `Root=${rid}`);
          try {
            const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            req.header.set('x-cursor-timezone', tz);
          } catch { }

          // 日志记录
          await this.logConnectRequest(req);
          
          try {
            const result = await next(req);
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

  // Fetch 请求上下文（用于错误时输出）
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
      const mask = (v: string) => (typeof v === 'string' && v.length > 12) ? `${v.slice(0, 6)}…${v.slice(-4)}` : '***';
      if (safeHeaders['Authorization']) {
        safeHeaders['Authorization'] = mask(safeHeaders['Authorization']);
      }
      if (safeHeaders['x-client-key']) {
        safeHeaders['x-client-key'] = mask(safeHeaders['x-client-key']);
      }
      if (safeHeaders['x-cursor-checksum']) {
        safeHeaders['x-cursor-checksum'] = mask(safeHeaders['x-cursor-checksum']);
      }

      // 生成请求体字符串
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

      // 保存请求上下文供错误时使用
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
      
      // 成功响应只输出简要信息
      if (status >= 200 && status < 300) {
        ApiClient.channel?.appendLine(`[${ts}] ✓ ${kind} → ${status}`);
        this.lastFetchContext = null;
        return;
      }
      
      // 错误响应输出完整信息
      ApiClient.channel?.appendLine('');
      ApiClient.channel?.appendLine(`[${ts}] ❌ ${kind} FAILED`);
      ApiClient.channel?.appendLine(`[${ts}] Response Status: ${status}`);
      
      // 输出完整的请求信息
      if (this.lastFetchContext) {
        ApiClient.channel?.appendLine(`[${ts}] Request URL: ${this.lastFetchContext.url}`);
        ApiClient.channel?.appendLine(`[${ts}] Request Headers: ${JSON.stringify(this.lastFetchContext.headers)}`);
        ApiClient.channel?.appendLine(`[${ts}] Request Body: ${this.lastFetchContext.body}`);
      }
      
      // 输出响应头
      const responseHeaders: Record<string, string> = {};
      headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      ApiClient.channel?.appendLine(`[${ts}] Response Headers: ${JSON.stringify(responseHeaders)}`);

      // 输出响应体（如果有）
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
              ApiClient.channel?.appendLine(`[${ts}] Response Body (proto->json): ${JSON.stringify(jsonObj)}`);
            }
          } catch (e) {
            ApiClient.channel?.appendLine(`[${ts}] Response Body (proto decode failed): ${String(e)}`);
          }
        } else if (typeof body === 'object') {
          try {
            ApiClient.channel?.appendLine(`[${ts}] Response Body (json): ${JSON.stringify(body)}`);
          } catch {
            ApiClient.channel?.appendLine(`[${ts}] Response Body: <unserializable object>`);
          }
        } else if (typeof body === 'string') {
          try {
            const obj = JSON.parse(body);
            ApiClient.channel?.appendLine(`[${ts}] Response Body (json): ${JSON.stringify(obj)}`);
          } catch {
            const preview = body.length > 500 ? body.substring(0, 500) + '...' : body;
            ApiClient.channel?.appendLine(`[${ts}] Response Body (string): ${preview}`);
          }
        }
      } else {
        ApiClient.channel?.appendLine(`[${ts}] Response Body: <none>`);
      }
      
      ApiClient.channel?.appendLine('');
      this.lastFetchContext = null;
    } catch {
      // never throw on logging
    }
  }

  async streamCpp(request: StreamCppRequest, abortController?: AbortController): Promise<AsyncIterable<StreamCppResponse>> {
    if (!this.aiClient) {
      throw new Error('AI client is not initialized');
    }

    const stream = this.aiClient.streamCpp(request, { signal: abortController?.signal }) as unknown as AsyncIterable<StreamCppResponse>;
    return stream;
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

  async getAvailableModels(): Promise<any> {
    const url = this.getUrl('availableModels');
    const headers = this.getHeaders();
    await this.logRequest('getAvailableModels', url, headers, undefined);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: new Uint8Array()
    });

    if (!response.ok) {
      await this.logResponse('getAvailableModels', url, response.status, response.headers, null, false);
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const jsonResponse = await response.json();
    await this.logResponse('getAvailableModels', url, response.status, response.headers, jsonResponse, false);
    return jsonResponse;
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

  // Helper: 将 ReadableStream 转换为 AsyncIterable
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

  // Connect RPC 请求日志（仅保存上下文，不立即输出）
  private async logConnectRequest(req: any) {
    try {
      const ts = new Date().toISOString();
      const url = req.url || 'unknown';
      
      // 收集头部
      const headers: Record<string, string> = {};
      req.header.forEach((value: string, key: string) => {
        headers[key] = value;
      });

      // 掩码敏感信息
      const safeHeaders = { ...headers };
      const mask = (v: string) => (typeof v === 'string' && v.length > 12) ? `${v.slice(0, 6)}…${v.slice(-4)}` : '***';
      if (safeHeaders['authorization']) {
        safeHeaders['authorization'] = mask(safeHeaders['authorization']);
      }
      if (safeHeaders['x-cursor-checksum']) {
        safeHeaders['x-cursor-checksum'] = mask(safeHeaders['x-cursor-checksum']);
      }

      // 记录请求体
      let bodyStr = '<none>';
      if (req.message) {
        try {
          bodyStr = serializeMessage(req.message);
        } catch {
          bodyStr = '<protobuf message>';
        }
      }

      // 保存请求上下文供错误时使用
      this.lastRequestContext = {
        url,
        headers: safeHeaders,
        body: bodyStr,
        timestamp: ts
      };
    } catch {
      // 日志记录失败不应影响请求
    }
  }

  // Connect RPC 响应日志（成功时输出详细上下文）
  private async logConnectResponse(req: any, res: any) {
    try {
      const ts = new Date().toISOString();
      const url = req.url || 'unknown';
      const method = url.split('/').pop() || 'unknown';

      const status = typeof res?.status === 'number' ? res.status : 200;
      const responseBody = safeSerialize(res?.message ?? res);

      ApiClient.channel?.appendLine(`[${ts}] ✓ ${method} → ${status} OK`);
      if (this.lastRequestContext) {
        ApiClient.channel?.appendLine(`[${ts}]   Request URL: ${this.lastRequestContext.url}`);
        ApiClient.channel?.appendLine(`[${ts}]   Request Headers: ${JSON.stringify(this.lastRequestContext.headers)}`);
        ApiClient.channel?.appendLine(`[${ts}]   Request Body (proto->json): ${this.lastRequestContext.body}`);
      } else {
        ApiClient.channel?.appendLine(`[${ts}]   Request context unavailable (possibly streaming body)`);
      }
      ApiClient.channel?.appendLine(`[${ts}]   Response Body (proto->json): ${responseBody}`);

      // 清除请求上下文
      this.lastRequestContext = null;
    } catch {
      // 日志记录失败不应影响响应
    }
  }

  // Connect RPC 错误日志（输出完整的请求上下文）
  private async logConnectError(req: any, error: any) {
    try {
      const ts = new Date().toISOString();
      const url = req.url || 'unknown';
      const method = url.split('/').pop() || 'unknown';
      
      // 输出错误标题
      ApiClient.channel?.appendLine('');
      ApiClient.channel?.appendLine(`[${ts}] ❌ ${method} FAILED`);
      ApiClient.channel?.appendLine(`[${ts}] Error: ${error.message || String(error)}`);
      if (error.code) {
        ApiClient.channel?.appendLine(`[${ts}] Error Code: ${error.code}`);
      }
      
      // 输出完整的请求信息
      if (this.lastRequestContext) {
        ApiClient.channel?.appendLine(`[${ts}] Request URL: ${this.lastRequestContext.url}`);
        ApiClient.channel?.appendLine(`[${ts}] Request Headers: ${JSON.stringify(this.lastRequestContext.headers)}`);
        ApiClient.channel?.appendLine(`[${ts}] Request Body (proto->json): ${this.lastRequestContext.body}`);
      }
      
      ApiClient.channel?.appendLine('');
      
      // 清除请求上下文
      this.lastRequestContext = null;
    } catch {
      // 日志记录失败不应影响错误处理
    }
  }

  getEndpointInfo(): { baseUrl: string; isDefaultUrl: boolean } {
    const isDefaultUrl = this.config.baseUrl === DEFAULT_BASE_URL;
    return {
      baseUrl: this.config.baseUrl!,
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

    if (this.config.baseUrl) {
      const isOfficialUrl = this.config.baseUrl.includes('api2.cursor.sh') ||
        this.config.baseUrl.includes('cursor.sh');

      if (!isOfficialUrl) {
        issues.push('Endpoint URL does not appear to be the official Cursor API');
      }
    }

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
