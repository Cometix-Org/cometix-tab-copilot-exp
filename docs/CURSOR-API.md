# Cursor API 接口详解

本文档详细介绍 Cometix Tab 如何与 Cursor 后端 API 进行通信。

## 概述

Cometix Tab 使用 Connect RPC 协议与 Cursor 的官方 API 服务器 (`api2.cursor.sh`) 通信。所有请求使用 Protobuf 序列化，通过 HTTP/1.1 传输。

## 基础配置

### API 基础 URL

```typescript
const DEFAULT_BASE_URL = 'https://api2.cursor.sh';
```

### 认证

所有 API 请求需要以下认证头：

| 请求头 | 说明 |
|--------|------|
| `Authorization` | Bearer Token，用户认证令牌 |
| `x-cursor-checksum` | 客户端校验和，基于 machineId 生成 |
| `x-client-key` | 客户端密钥，自动生成或用户配置 |
| `x-cursor-client-version` | 客户端版本号（当前: `1.5.5`） |
| `x-fs-client-key` | 文件同步客户端密钥 |
| `x-request-id` | 请求唯一标识符（UUID） |
| `x-cursor-timezone` | 客户端时区 |

---

## 端点列表

### AI 服务 (`aiserver.v1.AiService`)

| 端点 | 方法 | 说明 |
|------|------|------|
| `/aiserver.v1.AiService/StreamCpp` | 流式 | 核心代码补全接口 |
| `/aiserver.v1.AiService/StreamNextCursorPrediction` | 流式 | 光标预测接口（已废弃，使用融合模型） |
| `/aiserver.v1.AiService/RefreshTabContext` | 一元 | 刷新 Tab 上下文 |
| `/aiserver.v1.AiService/CppConfig` | 一元 | 获取 CPP 配置 |
| `/aiserver.v1.AiService/ShouldTurnOnCppOnboarding` | 一元 | 检查是否应开启 CPP 引导 |
| `/aiserver.v1.AiService/CppEditHistoryStatus` | 一元 | 编辑历史状态 |
| `/aiserver.v1.AiService/CppEditHistoryAppend` | 一元 | 追加编辑历史 |
| `/aiserver.v1.AiService/GetCppEditClassification` | 一元 | 获取编辑分类 |
| `/aiserver.v1.AiService/IsCursorPredictionEnabled` | 一元 | 检查光标预测是否启用 |

### CPP 服务 (`aiserver.v1.CppService`)

| 端点 | 方法 | 说明 |
|------|------|------|
| `/aiserver.v1.CppService/AvailableModels` | 一元 | 获取可用模型列表 |
| `/aiserver.v1.CppService/MarkCppForEval` | 一元 | 标记评估 |
| `/aiserver.v1.CppService/StreamHoldCpp` | 流式 | 保持 CPP 流 |
| `/aiserver.v1.CppService/RecordCppFate` | 一元 | 记录 CPP 结果 |
| `/aiserver.v1.CppService/AddTabRequestToEval` | 一元 | 添加评估请求 |

### 文件同步服务 (`filesync.v1.FileSyncService`)

| 端点 | 方法 | 说明 |
|------|------|------|
| `/filesync.v1.FileSyncService/FSUploadFile` | 一元 | 上传完整文件 |
| `/filesync.v1.FileSyncService/FSSyncFile` | 一元 | 增量同步文件 |
| `/filesync.v1.FileSyncService/FSIsEnabledForUser` | 一元 | 检查用户是否启用文件同步 |
| `/filesync.v1.FileSyncService/FSConfig` | 一元 | 获取文件同步配置 |
| `/filesync.v1.FileSyncService/FSGetFileContents` | 一元 | 获取文件内容 |
| `/filesync.v1.FileSyncService/FSGetMultiFileContents` | 一元 | 获取多个文件内容 |

### 光标预测服务 (`aiserver.v1.CursorPredictionService`)

| 端点 | 方法 | 说明 |
|------|------|------|
| `/aiserver.v1.CursorPredictionService/CursorPredictionConfig` | 一元 | 光标预测配置 |

---

## 核心接口详解

### StreamCpp - 代码补全

这是最核心的 API，用于获取代码补全建议。

#### 请求结构 (`StreamCppRequest`)

```typescript
interface StreamCppRequest {
  // 核心文件信息
  currentFile: CurrentFileInfo;        // 当前文件信息
  linterErrors?: LinterErrors;         // Linter 错误信息

  // Diff 历史（Cursor 发送空数组，使用 fileDiffHistories 代替）
  diffHistory: string[];               // 始终为空数组
  diffHistoryKeys: string[];           // 始终为空数组
  fileDiffHistories: CppFileDiffHistory[]; // 文件 diff 历史

  // 上下文项（Cursor 发送空数组）
  contextItems: [];                    // 始终为空数组
  lspContexts: [];                     // 始终为空数组

  // 模型和工作区
  modelName?: string;                  // 模型名称
  workspaceId?: string;                // 工作区唯一 ID

  // 额外上下文
  additionalFiles: AdditionalFile[];   // 最近查看的其他文件
  parameterHints: CppParameterHint[];  // 参数提示信息
  lspSuggestedItems?: LspSuggestedItems; // LSP 建议
  enableMoreContext?: boolean;         // 启用更多上下文

  // 意图和控制
  cppIntentInfo?: CppIntentInfo;       // 触发意图信息
  controlToken?: ControlToken;         // 控制令牌

  // 时间信息
  timeSinceRequestStart: number;       // 请求开始后经过的时间（毫秒）
  timeAtRequestSend: number;           // 发送请求的时间戳
  clientTime: number;                  // 客户端当前时间
  clientTimezoneOffset: number;        // 客户端时区偏移（分钟）

  // 文件同步（Cursor 始终发送空数组）
  filesyncUpdates: [];                 // 始终为空数组
}
```

#### CurrentFileInfo 结构

```typescript
interface CurrentFileInfo {
  relativeWorkspacePath: string;  // 相对工作区路径
  contents: string;               // 文件内容（当 relyOnFilesync=true 时为空）
  cursorPosition: CursorPosition; // 光标位置（0-索引）
  relyOnFilesync: boolean;        // 是否依赖文件同步
  fileVersion: number;            // 文件版本号
  lineEnding: string;             // 行结束符（'\n' 或 '\r\n'）
  sha256Hash?: string;            // 内容 SHA256 哈希（用于验证）
  contentsStartAtLine: number;    // 内容起始行（截断时使用）
  languageId: string;             // 始终为空字符串（服务器从扩展名推断）
  workspaceRootPath: string;      // 工作区根路径
}
```

#### CursorPosition 结构

```typescript
interface CursorPosition {
  line: number;      // 行号（0-索引）
  column: number;    // 列号（0-索引）
}
```

#### 响应结构 (`StreamCppResponse`)

流式响应，每个 chunk 可能包含以下字段：

```typescript
interface StreamCppResponseChunk {
  // 模型信息（通常在首个 chunk 返回）
  modelInfo?: {
    isFusedCursorPredictionModel: boolean;  // 是否融合光标预测
    isMultidiffModel: boolean;               // 是否支持多 diff
    modelName?: string;                      // 模型名称
  };

  // 编辑范围（使用 1-索引行号）
  rangeToReplace?: {
    startLineNumber: number;      // 起始行（1-索引）
    endLineNumberInclusive: number; // 结束行（包含，1-索引）
  };

  // 编辑内容
  text?: string;                  // 文本内容
  bindingId?: string;             // 绑定 ID（用于追踪多编辑）
  shouldRemoveLeadingEol?: boolean; // 是否移除前导换行符

  // 编辑边界标记
  beginEdit?: boolean;            // 编辑开始标记
  doneEdit?: boolean;             // 编辑结束标记
  doneStream?: boolean;           // 整个流结束标记

  // 光标预测目标（融合模型返回）
  cursorPredictionTarget?: {
    relativePath: string;         // 目标文件相对路径
    lineNumberOneIndexed: number; // 目标行号（1-索引）
    expectedContent?: string;     // 预期内容
    shouldRetriggerCpp?: boolean; // 是否重新触发补全
  };
}
```

#### 使用示例

```typescript
// 1. 构建请求
const request = buildStreamRequest(tracker, {
  document: vscode.document,
  position: vscode.position,
  linterDiagnostics: diagnostics,
  visibleRanges: visibleRanges,
  relyOnFileSync: true,
  fileVersion: document.version,
  triggerSource: TriggerSource.Typing,
  additionalFiles: additionalFilesContext,
});

// 2. 发起流式请求
await rpc.streamCpp(request, {
  generateUuid: requestId,
  startOfCpp: performance.now(),
  abortController: controller,
});

// 3. 轮询获取结果
const result = await rpc.flushCpp(requestId);
if (result.type === 'success') {
  for (const item of result.buffer) {
    // 处理每个 chunk
    if (item.text) {
      console.log('收到文本:', item.text);
    }
    if (item.doneStream) {
      console.log('流结束');
      break;
    }
  }
}
```

---

### FSUploadFile - 上传文件

用于将完整文件内容上传到 Cursor 后端。

#### 请求结构

```typescript
interface FSUploadFileRequest {
  uuid: string;                   // 文件唯一标识（通常使用文件 URI）
  relativeWorkspacePath: string;  // 相对工作区路径
  contents: string;               // 完整文件内容
  modelVersion: number;           // 版本号
  sha256Hash: string;             // 内容 SHA256 哈希
}
```

#### 响应结构

```typescript
interface FSUploadFileResponse {
  success: boolean;               // 是否成功
  errorMessage?: string;          // 错误信息
}
```

---

### FSSyncFile - 增量同步

用于增量更新已上传的文件。

#### 请求结构

```typescript
interface FSSyncFileRequest {
  uuid: string;                   // 文件唯一标识
  relativeWorkspacePath: string;  // 相对工作区路径
  modelVersion: number;           // 目标版本号
  filesyncUpdates: FilesyncUpdateWithModelVersion[];  // 增量更新列表
  sha256Hash: string;             // 更新后内容的哈希
}

interface FilesyncUpdateWithModelVersion {
  modelVersion: number;           // 此更新对应的版本
  expectedFileLength?: number;    // 更新后预期文件长度
  updates: SingleUpdateRequest[]; // 单个更新请求列表
}

interface SingleUpdateRequest {
  range: {
    startLineNumber: number;      // 起始行（1-索引）
    startColumn: number;          // 起始列（1-索引）
    endLineNumberInclusive: number; // 结束行（1-索引）
    endColumn: number;            // 结束列（1-索引）
  };
  replacedString: string;         // 替换的新内容
  changeLength: number;           // 原内容长度
}
```

---

## 触发源类型

`TriggerSource` 枚举定义了触发补全请求的来源：

```typescript
enum TriggerSource {
  Unknown = 'unknown',              // 未知来源
  LineChange = 'line_change',       // 行变更
  Typing = 'typing',                // 用户输入
  OptionHold = 'option_hold',       // Option 键按住
  LinterErrors = 'lint_errors',     // Linter 错误
  ParameterHints = 'parameter_hints', // 参数提示
  CursorPrediction = 'cursor_prediction', // 光标预测
  ManualTrigger = 'manual_trigger', // 手动触发
  EditorChange = 'editor_change',   // 编辑器变更
  LspSuggestions = 'lsp_suggestions', // LSP 建议
}
```

---

## 内容处理

### 内容截断

当 `relyOnFileSync=false` 时，文件内容会被截断以减少传输量：

```typescript
function truncateContentAroundCursor(
  content: string,
  cursorLine: number,
  lineEnding: string
): { contents: string; contentsStartAtLine: number } {
  const LINES_BEFORE = 300;  // 保留光标前 300 行
  const LINES_AFTER = 300;   // 保留光标后 300 行

  const lines = content.split(lineEnding);
  const startLine = Math.max(0, cursorLine - LINES_BEFORE);
  const endLine = Math.min(lines.length, cursorLine + LINES_AFTER);

  return {
    contents: lines.slice(startLine, endLine).join(lineEnding),
    contentsStartAtLine: startLine,
  };
}
```

### SHA256 哈希计算

用于验证文件同步一致性：

```typescript
import { createHash } from 'crypto';

function calculateSHA256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
```

---

## 错误处理

### 常见错误码

| 错误码 | 说明 | 处理方式 |
|--------|------|----------|
| `ENHANCE_YOUR_CALM` | 请求过于频繁 | 重新初始化客户端，等待后重试 |
| `UNAUTHENTICATED` | 认证失败 | 检查 authToken 是否有效 |
| `UNAVAILABLE` | 服务不可用 | 等待后重试 |
| `unimplemented` | 接口未实现 | 检查 API 版本兼容性 |
| `CANCELLED` | 请求被取消 | 正常流程，无需处理 |

### 重试机制

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  options: { retries: number; delayMs: number }
): Promise<T> {
  let lastError: Error | undefined;

  for (let i = 0; i <= options.retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (i < options.retries) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
    }
  }

  throw lastError;
}

// 使用示例
await withRetry(
  () => consumeStream(...),
  { retries: 2, delayMs: 150 }
);
```

---

## 客户端实现

### ApiClient

`ApiClient` 类封装了所有与 Cursor API 的通信：

```typescript
class ApiClient {
  // Connect RPC 客户端
  private aiClient: Client<typeof AiService>;
  private fileSyncClient: Client<typeof FileSyncService>;

  constructor(options: ApiClientOptions) {
    this.aiClient = createClient(AiService, createConnectTransport({
      baseUrl: options.baseUrl || DEFAULT_BASE_URL,
      httpVersion: '1.1',
    }));
  }

  // 流式 CPP 请求
  async streamCpp(
    request: StreamCppRequest,
    options: StreamOptions
  ): Promise<void>;

  // 轮询获取结果
  async flushCpp(requestId: string): Promise<FlushResult>;

  // 取消请求
  cancelCpp(requestId: string): void;

  // 文件操作
  async uploadFile(request: FSUploadFileRequest): Promise<FSUploadFileResponse>;
  async syncFile(request: FSSyncFileRequest): Promise<FSSyncFileResponse>;
}
```

### RpcClient

`RpcClient` 是 `ApiClient` 的包装，添加了日志记录和配置管理：

```typescript
class RpcClient implements IRpcClient {
  private client: ApiClient;

  constructor(private readonly logger: ILogger) {
    this.client = this.createClient();

    // 监听配置变化自动刷新客户端
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('cometixTab')) {
        this.logger.info('Configuration changed, refreshing client');
        this.client = this.createClient();
      }
    });
  }

  private createClient(): ApiClient {
    const config = vscode.workspace.getConfiguration('cometixTab');
    return new ApiClient({
      // baseUrl is resolved from endpointMode, officialRegion, customEndpoint
      authToken: config.get('authToken'),
      clientKey: config.get('clientKey'),
    });
  }
}
```

---

## 流式响应轮询机制

由于 Connect RPC 在 VS Code 扩展环境中的限制，使用轮询方式获取流式响应：

```typescript
async function* pollStream(
  rpc: IRpcClient,
  requestId: string,
  abortController: AbortController
): AsyncIterable<StreamCppResponseChunk> {
  const POLL_INTERVAL_MS = 5;
  const DONE_SENTINEL = Symbol('done');

  while (!abortController.signal.aborted) {
    const result = await rpc.flushCpp(requestId);

    if (result.type === 'failure') {
      throw new Error(result.reason);
    }

    for (const item of result.buffer) {
      if (item === DONE_SENTINEL) {
        return;
      }
      yield item;
    }

    // 短暂等待后继续轮询
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
```

---

## 请求头生成

### Checksum 生成

```typescript
import { createHash } from 'crypto';

function generateChecksum(machineId: string): string {
  const hash = createHash('sha256')
    .update(machineId)
    .digest('hex');
  return `${hash.slice(0, 8)}/${hash.slice(8, 16)}`;
}
```

### Client Key 生成

```typescript
import { randomUUID } from 'crypto';

function generateClientKey(): string {
  return randomUUID();
}
```