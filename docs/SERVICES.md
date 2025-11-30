# 依赖注入服务详解

本文档详细介绍 Cometix Tab 中各个服务的职责、实现和使用方式。

## 服务概览

| 服务名称 | 接口 | 职责 |
|----------|------|------|
| `logger` | `ILogger` | 日志记录 |
| `config` | `IConfigService` | 配置管理 |
| `tracker` | `IDocumentTracker` | 文档历史追踪 |
| `rpcClient` | `IRpcClient` | RPC 通信 |
| `fileSync` | `IFileSyncCoordinator` | 文件同步协调 |
| `fileSyncUpdates` | - | 增量更新存储 |
| `debounceManager` | `IDebounceManager` | 请求防抖 |
| `recentFilesTracker` | `IRecentFilesTracker` | 最近文件追踪 |
| `telemetryService` | `ITelemetryService` | 遥测数据收集 |
| `lspSuggestionsTracker` | `ILspSuggestionsTracker` | LSP 建议追踪 |
| `workspaceStorage` | `IWorkspaceStorage` | 工作区持久存储 |
| `cursorStateMachine` | - | 核心状态机 |
| `cursorPrediction` | `ICursorPredictionController` | 光标预测控制 |
| `productJsonPatcher` | - | Proposed API 配置工具 |

---

## 核心服务

### 日志服务 (Logger)

**文件**: `services/logger.ts`

**接口**:
```typescript
interface ILogger extends vscode.Disposable {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}
```

**职责**:
- 输出调试和运行时日志
- 记录 RPC 请求和响应
- 错误追踪

**使用示例**:
```typescript
logger.info('[Cpp] Starting request');
logger.warn('Configuration missing');
logger.error('Request failed', error);
```

---

### 配置服务 (ConfigService)

**文件**: `services/configService.ts`

**接口**:
```typescript
interface IConfigService extends vscode.Disposable {
  readonly flags: CursorFeatureFlags;
  readonly debug: DebugConfig;
  readonly onDidChange: vscode.Event<CursorFeatureFlags>;
}
```

**配置项**:

#### 功能开关 (`CursorFeatureFlags`)

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enableInlineSuggestions` | boolean | true | 启用内联建议 |
| `enableCursorPrediction` | boolean | true | 启用光标预测 |
| `enableDiagnosticsHints` | boolean | false | 启用诊断提示（实验性） |
| `excludedLanguages` | string[] | [] | 禁用建议的语言列表 |
| `enableAdditionalFilesContext` | boolean | true | 包含最近文件上下文 |
| `cppTriggerInComments` | boolean | true | 在注释中触发建议 |

#### 调试配置 (`DebugConfig`)

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `debug.enabled` | boolean | true | 启用调试日志 |
| `debug.logStream` | boolean | true | 记录流式响应 |
| `debug.logEditCombine` | boolean | true | 记录编辑合并过程 |
| `debug.logFileSync` | boolean | true | 记录文件同步操作 |
| `debug.logRpc` | boolean | true | 记录 RPC 请求/响应 |
| `debug.verbosePayloads` | boolean | false | 记录完整载荷（可能很大） |

#### 连接配置

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `endpointMode` | string | "auto" | 端点模式：official/auto/custom |
| `officialRegion` | string | "default" | 官方端点区域 |
| `customEndpoint` | string | "" | 自定义端点 URL |
| `authToken` | string | "" | 认证令牌 |
| `clientKey` | string | "" | 客户端密钥（自动生成） |

**实现细节**:
```typescript
class ConfigService implements IConfigService {
  constructor() {
    // 监听配置变化
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('cometixTab')) {
        this.current = this.readConfig();
        this.emitter.fire(this.current);
      }
    });
  }
}
```

---

### RPC 客户端 (RpcClient)

**文件**: `services/rpcClient.ts`

**接口**:
```typescript
interface IRpcClient extends vscode.Disposable {
  // 流式代码补全
  streamCpp(request: StreamCppRequest, options: StreamOptions): Promise<void>;
  flushCpp(requestId: string): Promise<FlushResult>;
  cancelCpp(requestId: string): void;
  getCppReport(): Promise<{ events: any[] }>;
  
  // 光标预测（已废弃）
  streamNextCursorPrediction(
    request: StreamNextCursorPredictionRequest,
    abortController?: AbortController
  ): Promise<AsyncIterable<StreamNextCursorPredictionResponse>>;
  
  // Tab 上下文
  refreshTabContext(request: RefreshTabContextRequest): Promise<RefreshTabContextResponse>;
  
  // 文件同步
  uploadFile(request: FSUploadFileRequest): Promise<FSUploadFileResponse>;
  syncFile(request: FSSyncFileRequest): Promise<FSSyncFileResponse>;
}
```

**职责**:
- 封装底层 `ApiClient`
- 配置变化时自动重建客户端
- 添加日志记录

**依赖**: `ILogger`

**实现细节**:
```typescript
class RpcClient implements IRpcClient {
  private client: ApiClient;

  constructor(private readonly logger: ILogger) {
    this.client = this.createClient();
    
    // 监听配置变化
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

### 文件同步协调器 (FileSyncCoordinator)

**文件**: `services/fileSyncCoordinator.ts`

**接口**:
```typescript
interface IFileSyncCoordinator extends vscode.Disposable {
  prepareDocument(document: TextDocument): Promise<void>;
  getSyncPayload(document: TextDocument): { 
    relyOnFileSync: boolean; 
    updates: FilesyncUpdateWithModelVersion[] 
  };
  shouldRelyOnFileSync(document: TextDocument): boolean;
}
```

**职责**:
- 追踪文件版本状态
- 管理增量同步
- 决定何时使用文件同步 vs 发送完整内容

**关键常量**:
```typescript
const MAX_VERSION_LAG = 10;     // 允许的最大版本滞后
const MAX_VERSION_DRIFT = 100;  // 触发全量上传的版本漂移
const SUCCESS_THRESHOLD = 2;    // 启用 relyOnFileSync 的成功次数阈值
const SYNC_DEBOUNCE_MS = 250;   // 同步防抖时间
```

**工作流程**:

```
文档变更
    │
    ├──→ FilesyncUpdatesStore.记录更新
    │
    └──→ 250ms 防抖
            │
            ▼
     prepareDocument()
            │
            ├── 首次同步 ──→ FSUploadFile（全量上传）
            │
            ├── 版本漂移过大 ──→ FSUploadFile（全量上传）
            │
            └── 正常同步 ──→ FSSyncFile（增量更新）
```

**依赖**: `IRpcClient`, `ILogger`, `FilesyncUpdatesStore`

---

### 防抖管理器 (DebounceManager)

**文件**: `services/debounceManager.ts`

**接口**:
```typescript
interface IDebounceManager extends vscode.Disposable {
  runRequest(): RunRequestResult;
  shouldDebounce(requestId: string): Promise<boolean>;
  removeRequest(requestId: string): void;
  abortRequest(requestId: string): void;
  abortAll(): void;
  getRequestCount(): number;
  setDebounceDurations(options: DebounceDurationOptions): void;
}

interface RunRequestResult {
  generationUUID: string;
  startTime: number;
  abortController: AbortController;
  requestIdsToCancel: string[];
}
```

**职责**:
- 防止过于频繁的请求
- 管理并发流数量限制
- 取消被取代的请求

**关键常量**（模仿 Cursor）:
```typescript
const CLIENT_DEBOUNCE_DURATION = 25;  // 客户端防抖窗口（ms）
const TOTAL_DEBOUNCE_DURATION = 60;   // 总防抖窗口（ms）
const MAX_CONCURRENT_STREAMS = 6;     // 最大并发流数量
```

**工作流程**:
```typescript
// 1. 创建新请求
const { generationUUID, abortController, requestIdsToCancel } = debounceManager.runRequest();

// 2. 取消被取代的请求
for (const id of requestIdsToCancel) {
  cancelStream(id);
}

// 3. 检查是否应该跳过
if (await debounceManager.shouldDebounce(generationUUID)) {
  return null; // 跳过此请求
}

// 4. 执行请求...

// 5. 清理
debounceManager.removeRequest(generationUUID);
```

**依赖**: `ILogger`

---

### 最近文件追踪器 (RecentFilesTracker)

**文件**: `services/recentFilesTracker.ts`

**接口**:
```typescript
interface IRecentFilesTracker extends vscode.Disposable {
  getAdditionalFilesContext(
    currentUri: vscode.Uri,
    fetchContent?: boolean
  ): Promise<AdditionalFileInfo[]>;
}
```

**职责**:
- 追踪最近查看的文件
- 记录可见范围
- 提供额外上下文给补全请求

**关键常量**:
```typescript
const MAX_FILE_AGE_MS = 60000;    // 60 秒后清除
const MAX_TRACKED_FILES = 20;     // 最多追踪 20 个文件
const MAX_LINE_LENGTH = 512;      // 截断过长的行
```

**返回数据结构**:
```typescript
interface AdditionalFileInfo {
  relativeWorkspacePath: string;  // 相对路径
  visibleRangeContent: string[];  // 可见范围内容
  startLineNumberOneIndexed: number[];  // 起始行号（1-索引）
  visibleRanges: Array<{
    startLineNumber: number;
    endLineNumberInclusive: number;
  }>;
  isOpen: boolean;                // 是否当前打开
  lastViewedAt?: number;          // 最后查看时间
}
```

**依赖**: `ILogger`

---

### LSP 建议追踪器 (LspSuggestionsTracker)

**文件**: `services/lspSuggestionsTracker.ts`

**接口**:
```typescript
interface ILspSuggestionsTracker extends vscode.Disposable {
  recordSuggestions(documentUri: string, suggestions: string[]): void;
  getRelevantSuggestions(documentUri: string): LspSuggestionsContext;
  captureCompletionsAt(document: TextDocument, position: Position): Promise<void>;
}
```

**职责**:
- 追踪 LSP 提供的代码补全建议
- 将 LSP 上下文提供给 Cursor API
- 增强补全质量

**依赖**: `ILogger`

---

### 遥测服务 (TelemetryService)

**文件**: `services/telemetryService.ts`

**接口**:
```typescript
interface ITelemetryService extends vscode.Disposable {
  recordTriggerStart(requestId: string): void;
  recordTriggerEvent(
    document: TextDocument,
    requestId: string,
    position: Position,
    source: TriggerSource
  ): void;
  recordSuggestionEvent(
    document: TextDocument,
    requestId: string,
    suggestionText: string
  ): void;
  recordAcceptEvent(document: TextDocument, requestId: string, acceptedLength: number): void;
  recordRejectEvent(document: TextDocument, requestId: string, reason?: string): void;
  recordPartialAcceptEvent(
    document: TextDocument,
    requestId: string,
    acceptedLength: number,
    kind: 'word' | 'line' | 'suggest' | 'unknown'
  ): void;
  recordGenerationFinished(requestId: string, success: boolean): void;
}
```

**职责**:
- 记录补全触发事件
- 记录接受/拒绝事件
- 计算性能指标

**依赖**: `ILogger`

---

### 工作区存储 (WorkspaceStorage)

**文件**: `services/workspaceStorage.ts`

**接口**:
```typescript
interface IWorkspaceStorage extends vscode.Disposable {
  getWorkspaceId(): string;
  getControlToken(): StreamCppRequest_ControlToken | undefined;
  setControlToken(token: StreamCppRequest_ControlToken | undefined): Promise<void>;
  getCheckFilesyncHashPercent(): number;
  clearCache(): void;
}
```

**职责**:
- 持久化工作区唯一 ID
- 管理控制令牌
- 存储配置参数

**依赖**: `vscode.ExtensionContext`

---

### 光标预测控制器 (CursorPredictionController)

**文件**: `controllers/cursorPredictionController.ts`

**接口**:
```typescript
interface ICursorPredictionController extends vscode.Disposable {
  handleSuggestionAccepted(editor: TextEditor): Promise<void>;
  clearForDocument(document: TextDocument): void;
  showPredictionAt(editor: TextEditor, line: number): void;
}
```

**职责**:
- 显示光标预测装饰
- 管理预测生命周期

**注意**: 
独立的 `StreamNextCursorPrediction` RPC 已废弃。光标预测现在通过融合模型在 `StreamCppResponse.cursorPredictionTarget` 中返回。

**依赖**: `IDocumentTracker`, `IRpcClient`, `IConfigService`, `ILogger`, `IFileSyncCoordinator`

---

### Product.json 修补器 (ProductJsonPatcher)

**文件**: `services/productJsonPatcher.ts`

**导出函数**:
```typescript
// 启动时检查并提示用户启用 Proposed API
function checkAndPromptProposedApiOnStartup(
  context: vscode.ExtensionContext,
  extensionId: string,
  proposals: string[],
  logger: ILogger
): Promise<void>;

// 检查 API 提案是否已启用
function checkApiProposals(
  extensionId: string,
  proposals: string[]
): Promise<{ ok: boolean; path?: string; reason?: string }>;

// 重置忽略状态
function resetIgnoreProposalCheck(
  context: vscode.ExtensionContext
): Promise<void>;
```

**职责**:
- 启动时检测 VS Code Proposed API 是否已启用
- 自动修改 `product.json` 启用所需 API 提案
- 支持普通权限和管理员权限两种修改方式
- 管理用户的「不再提示」偏好设置

**工作流程**:

```
扩展激活
    │
    ├── 检查用户是否选择「不再提示」──→ 跳过检查
    │
    └── checkApiProposals()
            │
            ├── 已启用 ──→ 返回（无需操作）
            │
            └── 未启用 ──→ 显示提示对话框
                    │
                    ├── 「启用（需要管理员权限）」
                    │       │
                    │       ├── tryNormalPatch() ──→ 成功 ──→ 显示重启按钮
                    │       │
                    │       └── 权限不足 ──→ tryElevatedPatch()
                    │               │
                    │               └── 使用 sudo-prompt 提权 ──→ 显示重启按钮
                    │
                    ├── 「稍后提醒」──→ 下次启动再提示
                    │
                    └── 「不再提示」──→ 保存偏好，不再提示
```

**product.json 修改位置**:
```typescript
// 候选路径（按优先级）
const candidates = [
  path.join(appRoot, 'product.json'),
  path.join(appRoot, 'resources', 'app', 'product.json'),
  path.join(path.dirname(appRoot), 'resources', 'app', 'product.json'),
];
```

**修改内容**:
```json
{
  "extensionEnabledApiProposals": {
    "Haleclipse.cometix-tab": ["inlineCompletionsAdditions"]
  }
}
```

**依赖**: `ILogger`, `vscode.ExtensionContext`, `@vscode/sudo-prompt`

**相关命令**: `cometix-tab.enableProposedApi`

---

## 服务依赖图

```
                          ┌─────────────────┐
                          │ ExtensionContext│
                          └────────┬────────┘
                                   │
                          ┌────────▼────────┐
                          │ ServiceContainer │
                          └────────┬────────┘
                                   │
           ┌───────────────────────┼───────────────────────┐
           │                       │                       │
           ▼                       ▼                       ▼
    ┌──────────┐           ┌──────────────┐         ┌──────────┐
    │  Logger  │◄──────────│  RpcClient   │────────►│  Config  │
    └──────────┘           └──────┬───────┘         └──────────┘
           ▲                      │                       ▲
           │                      │                       │
           │         ┌────────────┼────────────┐         │
           │         │            │            │         │
           │         ▼            ▼            ▼         │
           │  ┌──────────┐ ┌───────────┐ ┌───────────┐  │
           └──│ FileSync │ │ Debounce  │ │RecentFiles│──┘
              └────┬─────┘ │ Manager   │ │ Tracker   │
                   │       └─────┬─────┘ └─────┬─────┘
                   │             │             │
                   └─────────────┼─────────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │   CursorStateMachine   │◄─── Telemetry
                    │                        │◄─── LspTracker
                    │                        │◄─── WorkspaceStorage
                    └────────────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │CursorPredictionController│
                    └────────────────────────┘
```

---

## 服务注册顺序

在 `extension.ts` 中，服务按以下顺序注册：

```typescript
// 1. 基础服务（无依赖）
container.registerSingleton('logger', () => new Logger());
container.registerSingleton('tracker', () => new DocumentTracker());
container.registerSingleton('config', () => new ConfigService());

// 2. RPC 客户端（依赖 Logger）
container.registerSingleton('rpcClient', (c) => 
  new RpcClient(c.resolve('logger'))
);

// 3. 文件同步（依赖 RpcClient, Logger）
container.registerSingleton('fileSyncUpdates', (c) => 
  new FilesyncUpdatesStore(c.resolve('logger'))
);
container.registerSingleton('fileSync', (c) => 
  new FileSyncCoordinator(
    c.resolve('rpcClient'),
    c.resolve('logger'),
    c.resolve('fileSyncUpdates')
  )
);

// 4. 增强服务
container.registerSingleton('debounceManager', (c) => 
  new DebounceManager(c.resolve('logger'))
);
container.registerSingleton('recentFilesTracker', (c) => 
  new RecentFilesTracker(c.resolve('logger'))
);
container.registerSingleton('telemetryService', (c) => 
  new TelemetryService(c.resolve('logger'))
);
container.registerSingleton('lspSuggestionsTracker', (c) => 
  new LspSuggestionsTracker(c.resolve('logger'))
);
container.registerSingleton('workspaceStorage', () => 
  new WorkspaceStorage(context)
);

// 5. 核心状态机（依赖多个服务）
container.registerSingleton('cursorStateMachine', (c) =>
  new CursorStateMachine(
    c.resolve('tracker'),
    c.resolve('rpcClient'),
    c.resolve('logger'),
    c.resolve('config'),
    c.resolve('fileSync'),
    c.resolve('cursorPrediction'),
    c.resolve('debounceManager'),
    c.resolve('recentFilesTracker'),
    c.resolve('telemetryService'),
    c.resolve('lspSuggestionsTracker'),
    c.resolve('workspaceStorage')
  )
);

// 6. 光标预测控制器
container.registerSingleton('cursorPrediction', (c) =>
  new CursorPredictionController(
    c.resolve('tracker'),
    c.resolve('rpcClient'),
    c.resolve('config'),
    c.resolve('logger'),
    c.resolve('fileSync')
  )
);
```

---

## 创建新服务指南

### 1. 定义接口

在 `context/contracts.ts` 添加接口：

```typescript
export interface IMyService extends vscode.Disposable {
  doSomething(): Promise<void>;
}
```

### 2. 实现服务

在 `services/myService.ts` 创建实现：

```typescript
import * as vscode from 'vscode';
import { IMyService, ILogger } from '../context/contracts';

export class MyService implements IMyService {
  constructor(private readonly logger: ILogger) {}

  async doSomething(): Promise<void> {
    this.logger.info('Doing something');
  }

  dispose(): void {
    // 清理资源
  }
}
```

### 3. 注册服务

在 `extension.ts` 注册：

```typescript
container.registerSingleton('myService', (c) => 
  new MyService(c.resolve('logger'))
);
```

### 4. 使用服务

在需要的地方解析服务：

```typescript
const myService = container.resolve<IMyService>('myService');
await myService.doSomething();
```
