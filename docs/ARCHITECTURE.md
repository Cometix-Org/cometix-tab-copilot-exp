# 系统架构

本文档详细介绍 Cometix Tab 的整体架构设计、模块划分和数据流向。

## 架构概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                           VS Code 编辑器                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────┐    ┌─────────────────────────────────────┐ │
│  │    用户交互层        │    │           事件监听层                 │ │
│  │                     │    │                                     │ │
│  │  • 内联建议显示       │    │  • onDidChangeTextDocument         │ │
│  │  • 光标预测装饰       │    │  • onDidChangeVisibleTextEditors   │ │
│  │  • 命令触发          │    │  • onDidChangeTextEditorSelection  │ │
│  └──────────┬──────────┘    └──────────────┬──────────────────────┘ │
│             │                              │                        │
│             ▼                              ▼                        │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                     Provider 层                                │  │
│  │                                                               │  │
│  │   InlineCompletionProvider                                    │  │
│  │   • 实现 vscode.InlineCompletionItemProvider                  │  │
│  │   • 转换 SuggestionResult → InlineCompletionItem              │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│                              ▼                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                     Service 层                                 │  │
│  │                                                               │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │              CursorStateMachine（核心状态机）             │  │  │
│  │  │                                                         │  │  │
│  │  │  • 管理补全请求生命周期                                   │  │  │
│  │  │  • 处理流式响应                                          │  │  │
│  │  │  • 协调多编辑（Multidiff）                               │  │  │
│  │  │  • 管理光标预测                                          │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  │                              │                                │  │
│  │       ┌──────────────────────┼──────────────────────┐         │  │
│  │       ▼                      ▼                      ▼         │  │
│  │  ┌──────────┐    ┌───────────────────┐    ┌──────────────┐   │  │
│  │  │FileSync  │    │  DebounceManager  │    │RecentFiles   │   │  │
│  │  │Coordinator│   │                   │    │Tracker       │   │  │
│  │  └──────────┘    └───────────────────┘    └──────────────┘   │  │
│  │                                                               │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│                              ▼                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                     RPC 通信层                                  │  │
│  │                                                               │  │
│  │   RpcClient → ApiClient → Connect RPC → api2.cursor.sh       │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## 目录结构

```
src/
├── api/                      # API 客户端层
│   ├── apiClient.ts          # 核心 API 客户端实现
│   └── endpoints.ts          # 端点定义
│
├── commands/                 # VS Code 命令
│   ├── inlineAcceptCommand.ts    # 接受建议命令
│   ├── nextEditCommand.ts        # 应用下一个编辑命令
│   └── cursorPredictionCommand.ts # 光标预测导航命令
│
├── container/                # 依赖注入容器
│   └── serviceContainer.ts   # 服务容器实现
│
├── context/                  # 上下文构建
│   ├── contracts.ts          # 服务接口定义
│   ├── requestBuilder.ts     # 请求构建器
│   └── types.ts              # 类型定义
│
├── controllers/              # 控制器
│   └── cursorPredictionController.ts # 光标预测控制器
│
├── providers/                # VS Code Provider
│   └── inlineCompletionProvider.ts # 内联补全 Provider
│
├── rpc/                      # RPC 协议定义
│   ├── cursor-tab_pb.ts      # Protobuf 消息定义（生成）
│   └── cursor-tab_connect.ts # Connect RPC 服务定义（生成）
│
├── services/                 # 核心服务
│   ├── configService.ts      # 配置服务
│   ├── cppHeuristics.ts      # CPP 启发式规则
│   ├── cursorStateMachine.ts # 核心状态机
│   ├── debounceManager.ts    # 防抖管理器
│   ├── debugLogger.ts        # 调试日志
│   ├── documentTracker.ts    # 文档追踪器
│   ├── fileSyncCoordinator.ts # 文件同步协调器
│   ├── filesyncUpdatesStore.ts # 文件同步更新存储
│   ├── inlineEditTriggerer.ts # 内联编辑触发器
│   ├── logger.ts             # 日志服务
│   ├── lspSuggestionsTracker.ts # LSP 建议追踪器
│   ├── recentFilesTracker.ts # 最近文件追踪器
│   ├── retry.ts              # 重试工具
│   ├── rpcClient.ts          # RPC 客户端包装
│   ├── telemetryService.ts   # 遥测服务
│   └── workspaceStorage.ts   # 工作区存储
│
├── utils/                    # 工具函数
│   ├── checksum.ts           # 校验和生成
│   └── contentProcessor.ts   # 内容处理（截断、哈希等）
│
└── extension.ts              # 扩展入口点
```

## 模块详解

### 1. 扩展入口 (`extension.ts`)

扩展的激活入口，负责：
- 初始化 `ServiceContainer`
- 注册所有服务
- 注册 Provider 和命令

```typescript
export function activate(context: vscode.ExtensionContext) {
  const container = new ServiceContainer(context);
  
  // 注册基础服务
  container.registerSingleton('logger', () => new Logger());
  container.registerSingleton('config', () => new ConfigService());
  container.registerSingleton('rpcClient', (c) => new RpcClient(c.resolve('logger')));
  
  // 注册功能服务
  container.registerSingleton('fileSync', (c) => new FileSyncCoordinator(...));
  container.registerSingleton('cursorStateMachine', (c) => new CursorStateMachine(...));
  
  // 注册 Provider 和命令
  registerInlineCompletionProvider(stateMachine, logger, context.subscriptions);
  registerInlineAcceptCommand(stateMachine, logger, context.subscriptions);
}
```

### 2. 依赖注入容器 (`ServiceContainer`)

轻量级 DI 容器，支持：
- **延迟实例化**: 服务仅在首次使用时创建
- **单例模式**: 每个服务只有一个实例
- **自动销毁**: 实现 `Disposable` 接口的服务会自动注册到扩展上下文

```typescript
class ServiceContainer {
  registerSingleton<T>(key: string, factory: ServiceFactory<T>): void;
  resolve<T>(key: string): T;
}
```

### 3. 核心状态机 (`CursorStateMachine`)

管理代码补全的完整生命周期：

#### 状态管理
```typescript
class CursorStateMachine {
  // 活跃的流式请求
  private readonly activeStreams = new Map<string, AbortController>();
  
  // 绑定 ID 缓存（用于追踪多编辑）
  private readonly bindingCache = new Map<string, BindingEntry>();
  
  // 后续编辑队列
  private readonly followups = new Map<string, FollowupSession>();
  
  // 下一步动作缓存（光标预测、多编辑）
  private readonly nextActionCache = new Map<string, NextActionEntry>();
  
  // 建议缓存（防止请求被取消时丢失建议）
  private readonly suggestionCache: CachedSuggestion[] = [];
}
```

#### 核心方法
```typescript
// 请求补全建议
async requestSuggestion(ctx: SuggestionContext): Promise<SuggestionResult | null>;

// 处理接受建议
async handleAccept(editor: TextEditor, requestId?: string, bindingId?: string): Promise<void>;

// 应用下一个编辑
async applyNextEdit(editor: TextEditor, requestId?: string, bindingId?: string): Promise<boolean>;

// 处理部分接受
async handlePartialAccept(editor: TextEditor, requestId?: string, bindingId?: string, info?: PartialAcceptInfo): Promise<void>;
```

### 4. Provider 层 (`InlineCompletionProvider`)

实现 VS Code 的 `InlineCompletionItemProvider` 接口：

```typescript
class CursorInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  // 提供内联补全项
  async provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    context: InlineCompletionContext,
    token: CancellationToken
  ): Promise<InlineCompletionList | null>;
  
  // 处理显示事件
  handleDidShowCompletionItem(item: InlineCompletionItem, text: string): void;
  
  // 处理部分接受
  handleDidPartiallyAcceptCompletionItem(item: InlineCompletionItem, info: PartialAcceptInfo): void;
  
  // 处理生命周期结束
  handleEndOfLifetime(item: InlineCompletionItem, reason: InlineCompletionEndOfLifeReason): void;
}
```

### 5. 请求构建 (`requestBuilder.ts`)

负责构建发送给 Cursor API 的请求：

```typescript
function buildStreamRequest(
  tracker: IDocumentTracker,
  options: RequestContextOptions
): StreamCppRequest {
  // 构建当前文件信息
  const { currentFile, linterErrors } = buildFileInfo(options);
  
  // 构建额外上下文
  const additionalFiles = buildAdditionalFiles(options.additionalFiles);
  const lspSuggestedItems = buildLspSuggestions(options.lspSuggestions);
  const parameterHints = buildParameterHints(options.parameterHints);
  
  return new StreamCppRequest({
    currentFile,
    linterErrors,
    additionalFiles,
    lspSuggestedItems,
    parameterHints,
    // ...其他字段
  });
}
```

## 数据流

### 补全请求流程

```
用户输入/触发
     │
     ▼
┌─────────────────────────────┐
│  InlineCompletionProvider   │
│  provideInlineCompletionItems│
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│    CursorStateMachine       │
│    requestSuggestion        │
├─────────────────────────────┤
│ 1. 检查缓存                  │
│ 2. 防抖检查                  │
│ 3. 准备文件同步              │
│ 4. 收集上下文                │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│      requestBuilder         │
│    buildStreamRequest       │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│        RpcClient            │
│        streamCpp            │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│        ApiClient            │
│     Connect RPC 请求         │
└──────────────┬──────────────┘
               │
               ▼
         api2.cursor.sh
               │
               ▼
      流式响应 chunks
               │
               ▼
┌─────────────────────────────┐
│    CursorStateMachine       │
│      consumeStream          │
├─────────────────────────────┤
│ 1. 解析 chunks              │
│ 2. 组合多编辑                │
│ 3. 验证启发式规则            │
│ 4. 构建 SuggestionResult    │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  InlineCompletionProvider   │
│    构建 InlineCompletionItem │
└──────────────┬──────────────┘
               │
               ▼
         VS Code 显示
```

### 文件同步流程

```
文档变更事件
     │
     ▼
┌─────────────────────────────┐
│   FileSyncCoordinator       │
│   onDocumentChanged         │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│   FilesyncUpdatesStore      │
│   记录增量更新               │
└──────────────┬──────────────┘
               │
        (250ms 防抖)
               │
               ▼
┌─────────────────────────────┐
│   prepareDocument           │
├─────────────────────────────┤
│ 首次上传？ ───是──→ FSUploadFile │
│     │                       │
│    否                       │
│     │                       │
│ 版本漂移过大？ ─是─→ 全量上传  │
│     │                       │
│    否                       │
│     │                       │
│     └────→ FSSyncFile       │
└─────────────────────────────┘
```

## 关键设计决策

### 1. 流式响应轮询

由于浏览器环境限制，使用轮询而非 WebSocket：

```typescript
async *streamCpp(abortController, rpc, requestId) {
  for (;;) {
    const res = await rpc.flushCpp(requestId);
    if (res.type === 'failure') throw new Error(res.reason);
    for (const item of res.buffer) {
      if (item === DONE_SENTINEL) return;
      yield item;
    }
    await new Promise((l) => setTimeout(l, 5));
  }
}
```

### 2. 建议缓存

防止请求被取消时丢失建议（模仿 Cursor 的 `this.O` 缓存）：

```typescript
// 请求被取代时，缓存结果而非丢弃
if (currentRequest !== requestId) {
  this.addToSuggestionCache(suggestion, documentUri, documentVersion);
  return null;
}

// 新请求先检查缓存
const cached = this.popCachedSuggestion(documentUri, documentVersion);
if (cached) return cached;
```

### 3. 多编辑合并

将服务器返回的多个编辑合并为单个建议：

```typescript
private combineEdits(
  document: TextDocument,
  edits: EditPart[],
  startLine: number,
  endLine: number
): string {
  // 获取原始行
  const lines = getOriginalLines(document, startLine, endLine);
  
  // 逆序应用编辑（保持行号有效）
  for (const edit of edits.reverse()) {
    applyEdit(lines, edit);
  }
  
  return lines.join('\n');
}
```

### 4. 1-索引 vs 0-索引

服务器使用 1-索引行号，VS Code 使用 0-索引：

```typescript
// 服务器 → VS Code
const vsLine = serverLine - 1;

// VS Code → 服务器
const serverLine = vsLine + 1;
```

## 扩展点

### 添加新服务

1. 在 `context/contracts.ts` 定义接口
2. 在 `services/` 目录实现服务
3. 在 `extension.ts` 注册到容器

### 添加新命令

1. 在 `commands/` 目录创建命令文件
2. 在 `package.json` 声明命令
3. 在 `extension.ts` 注册命令

### 添加新配置

1. 在 `package.json` 的 `contributes.configuration` 添加配置项
2. 在 `context/types.ts` 添加类型
3. 在 `services/configService.ts` 读取配置
