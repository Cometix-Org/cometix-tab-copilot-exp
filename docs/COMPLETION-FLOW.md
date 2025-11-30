# 代码补全流程详解

本文档详细介绍 Cometix Tab 代码补全功能的完整流程，从触发到显示的每一个步骤。

## 流程概览

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              补全触发                                        │
│  用户输入 / 手动触发 / 光标移动                                               │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        InlineCompletionProvider                             │
│  provideInlineCompletionItems(document, position, context, token)           │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          CursorStateMachine                                 │
│                         requestSuggestion(ctx)                              │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ 1. 检查启用状态和资格                                                 │   │
│  │ 2. 检查建议缓存                                                       │   │
│  │ 3. 防抖检查和请求管理                                                 │   │
│  │ 4. 准备文件同步                                                       │   │
│  │ 5. 收集上下文（诊断、可见范围、额外文件等）                              │   │
│  │ 6. 构建请求                                                           │   │
│  │ 7. 发起流式请求                                                       │   │
│  │ 8. 消费响应流                                                         │   │
│  │ 9. 处理多编辑合并                                                     │   │
│  │ 10. 应用启发式验证                                                    │   │
│  │ 11. 处理光标预测                                                      │   │
│  │ 12. 返回 SuggestionResult                                             │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     构建 InlineCompletionItem                               │
│  • 设置 insertText 和 range                                                 │
│  • 配置 displayLocation（用于光标预测）                                      │
│  • 设置 isInlineEdit（多行编辑标记）                                         │
│  • 附加接受命令                                                              │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          VS Code 显示                                       │
│  灰色虚拟文本 / 内联编辑预览                                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 详细步骤

### 步骤 1: 触发补全

补全可以通过以下方式触发：

| 触发方式 | TriggerSource | 说明 |
|----------|---------------|------|
| 用户输入 | `Typing` | 每次按键后触发 |
| 手动触发 | `ManualTrigger` | 用户执行触发命令 |
| 行变更 | `LineChange` | 切换到新行时 |
| LSP 建议 | `LspSuggestions` | 有 LSP 补全建议时 |
| Linter 错误 | `LinterErrors` | 检测到诊断错误时 |
| 参数提示 | `ParameterHints` | 函数参数提示时 |
| 光标预测 | `CursorPrediction` | 接受预测后重新触发 |
| 编辑器变更 | `EditorChange` | 切换编辑器时 |

**VS Code 调用**:
```typescript
// VS Code 自动调用
provider.provideInlineCompletionItems(document, position, context, token);
```

---

### 步骤 2: 资格检查

在 `requestSuggestion` 方法中首先进行资格检查：

```typescript
async requestSuggestion(ctx: SuggestionContext): Promise<SuggestionResult | null> {
  // 检查是否启用
  if (!this.flags.enableInlineSuggestions) {
    return null;
  }
  
  // 检查资格
  if (!this.isEligible(ctx)) {
    return null;
  }
  
  // ...
}

private isEligible(ctx: SuggestionContext): boolean {
  // 取消令牌检查
  if (ctx.token.isCancellationRequested) {
    return false;
  }
  
  // 排除语言检查
  if (this.flags.excludedLanguages.includes(ctx.document.languageId)) {
    return false;
  }
  
  // 选区检查（有选中文本时不触发）
  const editor = vscode.window.activeTextEditor;
  if (editor && !editor.selection.isEmpty) {
    return false;
  }
  
  // 文件大小限制（避免性能问题）
  if (ctx.document.getText().length > 800_000) {
    return false;
  }
  
  // 注释区域检查
  if (this.isInCommentArea(ctx.document, ctx.position)) {
    return false;
  }
  
  return true;
}
```

---

### 步骤 3: 缓存检查

检查是否有缓存的建议可用（防止请求被取消时丢失建议）：

```typescript
// 模仿 Cursor 的 this.O.popCacheHit 模式
const cachedSuggestion = this.popCachedSuggestion(
  ctx.document.uri.toString(),
  ctx.document.version
);
if (cachedSuggestion) {
  this.logger.info('[Cpp] Using cached suggestion');
  return cachedSuggestion;
}
```

---

### 步骤 4: 防抖和请求管理

使用 `DebounceManager` 管理请求：

```typescript
let requestId: string;
let abortController: AbortController;

if (this.debounceManager) {
  const runResult = this.debounceManager.runRequest();
  requestId = runResult.generationUUID;
  abortController = runResult.abortController;
  
  // 取消被取代的请求
  for (const cancelId of runResult.requestIdsToCancel) {
    this.cancelStream(cancelId);
  }
  
  // 检查是否应该防抖（跳过）
  if (await this.debounceManager.shouldDebounce(requestId)) {
    return null;
  }
}

// 注册流
this.registerStream(requestId, abortController);

// 取消同一文档的旧请求
const docKey = ctx.document.uri.toString();
const prevRequestId = this.currentRequestByDocument.get(docKey);
if (prevRequestId && prevRequestId !== requestId) {
  this.cancelStream(prevRequestId);
}
this.currentRequestByDocument.set(docKey, requestId);
```

---

### 步骤 5: 准备文件同步

确保文件已同步到 Cursor 后端：

```typescript
// 准备文件同步
await this.fileSync.prepareDocument(ctx.document);

// 获取同步状态
const syncPayload = this.fileSync.getSyncPayload(ctx.document);

this.logger.info(
  `[Cpp] Request ${requestId.slice(0, 8)} ` +
  `relyOnFileSync=${syncPayload.relyOnFileSync}, ` +
  `updates=${syncPayload.updates.length}`
);
```

**同步策略**:
- 如果 `relyOnFileSync=true`：发送空内容，依赖服务器端已同步的版本
- 如果 `relyOnFileSync=false`：发送截断的文件内容（光标前后各 300 行）

---

### 步骤 6: 收集上下文

收集补全请求所需的各种上下文：

```typescript
// 诊断信息（Linter 错误）
const diagnostics = vscode.languages.getDiagnostics(ctx.document.uri);

// 可见范围
const visibleRanges = Array.from(
  vscode.window.visibleTextEditors
    .find((e) => e.document === ctx.document)
    ?.visibleRanges ?? []
);

// 额外文件上下文
const additionalFiles = this.flags.enableAdditionalFilesContext 
  && this.recentFilesTracker
  ? await this.recentFilesTracker.getAdditionalFilesContext(ctx.document.uri)
  : undefined;

// LSP 建议
const lspSuggestions = this.lspSuggestionsTracker
  ? this.lspSuggestionsTracker.getRelevantSuggestions(ctx.document.uri.toString())
  : undefined;
```

---

### 步骤 7: 构建请求

使用 `requestBuilder` 构建 `StreamCppRequest`：

```typescript
const request = buildStreamRequest(this.tracker, {
  document: ctx.document,
  position: ctx.position,
  linterDiagnostics: diagnostics,
  visibleRanges,
  filesyncUpdates: syncPayload.updates,
  relyOnFileSync: syncPayload.relyOnFileSync,
  fileVersion: ctx.document.version,
  lineEnding: ctx.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
  triggerSource,
  additionalFiles,
  lspSuggestions,
  enableMoreContext: this.flags.enableAdditionalFilesContext,
  isManualTrigger: triggerSource === TriggerSource.ManualTrigger,
  workspaceId: this.workspaceStorage?.getWorkspaceId(),
  storedControlToken: this.workspaceStorage?.getControlToken(),
  checkFilesyncHashPercent: this.workspaceStorage?.getCheckFilesyncHashPercent() ?? 0,
});
```

---

### 步骤 8: 发起流式请求

通过 RPC 客户端发起请求：

```typescript
// 开始流式请求
await this.rpc.streamCpp(request, {
  generateUuid: requestId,
  startOfCpp: Date.now(),
  abortController,
});

// 开始轮询消费流
const chunks = await this.consumeStream(request, ctx, abortController, requestId);
```

---

### 步骤 9: 消费响应流

轮询获取流式响应并解析：

```typescript
private async *streamCpp(
  abortController: AbortController,
  rpc: IRpcClient,
  requestId: string
): AsyncIterable<StreamChunk> {
  let done = false;
  
  for (;;) {
    if (abortController.signal.aborted) return;
    
    // 轮询获取缓冲区数据
    const res = await rpc.flushCpp(requestId);
    if (res.type === 'failure') throw new Error(res.reason);
    
    // 处理模型信息
    if (res.modelInfo) {
      this.currentModelInfo = res.modelInfo;
      yield { modelInfo: res.modelInfo };
    }
    
    // 处理缓冲区项
    for (const item of res.buffer) {
      if (item === DONE_SENTINEL) {
        done = true;
        break;
      }
      
      if (typeof item === 'string') {
        yield { text: item };
      } else if (item.case === 'rangeToReplace') {
        yield {
          rangeToReplace: item.rangeToReplaceOneIndexed,
          bindingId: item.bindingId,
          shouldRemoveLeadingEol: item.shouldRemoveLeadingEol,
        };
      } else if (item.case === 'beginEdit') {
        yield { beginEdit: true };
      } else if (item.case === 'doneEdit') {
        yield { doneEdit: true };
      } else if (item.case === 'cursorPredictionTarget') {
        yield { cursorPredictionTarget: item.cursorPredictionTarget };
      }
    }
    
    if (done) return;
    
    // 短暂等待后继续轮询
    await new Promise((l) => setTimeout(l, 5));
  }
}
```

---

### 步骤 10: 处理多编辑合并

当服务器返回多个编辑时，合并为单个建议：

```typescript
private async consumeStream(...) {
  const edits: EditPart[] = [];
  let buffer = '';
  let range: LineRange | undefined;
  
  for await (const chunk of stream) {
    // 处理 beginEdit：开始新编辑
    if (chunk.beginEdit) {
      continue;
    }
    
    // 累积文本
    buffer += chunk.text ?? '';
    
    // 更新范围
    if (chunk.rangeToReplace) {
      range = chunk.rangeToReplace;
    }
    
    // 处理 doneEdit：完成当前编辑
    if (chunk.doneEdit) {
      if (range) {
        edits.push({
          range: {
            startLineNumber: range.startLineNumber,
            endLineNumberInclusive: range.endLineNumberInclusive,
          },
          text: buffer,
          bindingId: chunk.bindingId,
        });
      }
      buffer = '';
      range = undefined;
    }
  }
  
  // 合并多个编辑
  if (edits.length > 0) {
    const sortedEdits = [...edits].sort(
      (a, b) => a.range.startLineNumber - b.range.startLineNumber
    );
    const combinedText = this.combineEdits(document, sortedEdits, minLine, maxLine);
    // ...
  }
}
```

**合并算法**:

```typescript
private combineEdits(
  document: TextDocument,
  edits: EditPart[],
  startLine: number,
  endLine: number
): string {
  // 获取原始行（转换 1-索引到 0-索引）
  const lines: string[] = [];
  for (let i = startLine - 1; i <= endLine - 1; i++) {
    lines.push(document.lineAt(i).text);
  }
  
  // 逆序应用编辑（保持行号有效）
  for (const edit of edits.reverse()) {
    const editStartIdx = edit.range.startLineNumber - startLine;
    const editEndIdx = edit.range.endLineNumberInclusive - startLine;
    const editLines = edit.text.split('\n');
    
    // 删除旧行，插入新行
    lines.splice(editStartIdx, editEndIdx - editStartIdx + 1, ...editLines);
  }
  
  return lines.join('\n');
}
```

---

### 步骤 11: 启发式验证

应用启发式规则验证建议有效性：

```typescript
const validation = this.heuristics.isValidCppCase(
  ctx.document,
  minStartLine,
  maxEndLine,
  combinedText
);

if (!validation.valid) {
  this.logger.info(`[Cpp] Suggestion rejected: ${validation.invalidReason}`);
  
  // 如果有光标预测，尝试显示跳转提示
  if (cursorPredictionTarget && displayLocation) {
    return [{
      text: '',
      range: new vscode.Range(ctx.position, ctx.position),
      displayLocation,
      cursorPredictionTarget,
      isCursorJumpHint: true,
    }];
  }
  
  return [];
}
```

**常见验证规则**:
- 建议不应与原文完全相同
- 建议不应为空
- 范围应有效
- 光标预测不应太近

---

### 步骤 12: 处理光标预测

如果响应包含光标预测目标：

```typescript
if (chunk.cursorPredictionTarget?.lineNumberOneIndexed) {
  cursorPredictionTarget = {
    relativePath: chunk.cursorPredictionTarget.relativePath,
    lineNumberOneIndexed: chunk.cursorPredictionTarget.lineNumberOneIndexed,
    expectedContent: chunk.cursorPredictionTarget.expectedContent,
    shouldRetriggerCpp: chunk.cursorPredictionTarget.shouldRetriggerCpp,
  };
  
  const isSameFile = relativePath === cursorPredictionTarget.relativePath;
  const targetLine = cursorPredictionTarget.lineNumberOneIndexed - 1;
  
  if (isSameFile && targetLine < document.lineCount) {
    // 同文件预测：显示 Code 类型位置
    displayLocation = {
      range: document.lineAt(targetLine).range,
      label: 'Next Edit Location',
      kind: vscode.InlineCompletionDisplayLocationKind.Code,
    };
  } else if (!isSameFile) {
    // 跨文件预测：显示 Label 类型
    displayLocation = {
      range: new vscode.Range(position, position),
      label: `Go to ${cursorPredictionTarget.relativePath}:${targetLine + 1}`,
      kind: vscode.InlineCompletionDisplayLocationKind.Label,
    };
  }
}
```

---

### 步骤 13: 构建返回结果

根据处理结果构建 `SuggestionResult`：

```typescript
const suggestion: RawSuggestion = {
  text: suggestionText,
  range: vsRange,
  bindingId: sortedEdits[0]?.bindingId,
  lineRange: combinedRange,
  displayLocation,
  isInlineEdit,
  showRange,
  cursorPredictionTarget,
};

// 如果有后续编辑，注册到队列
if (rest.length > 0) {
  this.followups.set(requestId, { document: ctx.document.uri, queue: rest });
  this.registerNextAction(nextActionId, { action: 'nextEdit' }, requestId);
}

// 如果有光标预测但无后续编辑
if (!rest.length && cursorPredictionTarget) {
  this.registerNextAction(
    nextActionId,
    { action: 'fusedCursorPrediction', target: cursorPredictionTarget },
    requestId
  );
}

return { ...suggestion, requestId };
```

---

### 步骤 14: 构建 InlineCompletionItem

`InlineCompletionProvider` 将 `SuggestionResult` 转换为 VS Code API：

```typescript
async provideInlineCompletionItems(...): Promise<InlineCompletionList | null> {
  const suggestion = await this.stateMachine.requestSuggestion(suggestionContext);
  if (!suggestion) return null;

  const item = new vscode.InlineCompletionItem(suggestion.text, suggestion.range);
  
  // 光标跳转提示
  if (suggestion.isCursorJumpHint && suggestion.cursorPredictionTarget) {
    item.command = {
      title: 'Go To Predicted Location',
      command: 'cometix-tab.goToCursorPrediction',
      arguments: [suggestion.cursorPredictionTarget],
    };
  } else {
    item.command = {
      title: 'Cursor Tab Accept',
      command: 'cometix-tab.inlineAccept',
      arguments: [suggestion.requestId, suggestion.bindingId],
    };
  }
  
  // Proposed API 设置
  item.completeBracketPairs = false;
  item.correlationId = suggestion.requestId;
  
  if (suggestion.displayLocation) {
    item.displayLocation = suggestion.displayLocation;
  }
  
  if (suggestion.showRange) {
    item.showRange = suggestion.showRange;
  }
  
  if (suggestion.isInlineEdit) {
    item.isInlineEdit = true;
    item.showInlineEditMenu = true;
  }
  
  const list = new vscode.InlineCompletionList([item]);
  list.enableForwardStability = true;
  
  return list;
}
```

---

## 接受建议流程

当用户接受建议时：

```
用户按 Tab / 点击接受
         │
         ▼
┌─────────────────────────────────────┐
│  cometix-tab.inlineAccept 命令      │
│  (requestId, bindingId)             │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│    CursorStateMachine               │
│    handleAccept(editor, requestId)  │
├─────────────────────────────────────┤
│ 1. 解析 requestId                   │
│ 2. 记录接受（用于启发式）            │
│ 3. 通知光标预测控制器                │
│ 4. 显示下一步动作（如果有）          │
│ 5. 清理已完成的请求                  │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│  displayNextActionIfAvailable       │
├─────────────────────────────────────┤
│ • 检查 nextActionCache              │
│ • 如果是 fusedCursorPrediction：    │
│   → 执行 goToCursorPrediction       │
│ • 如果是 nextEdit：                 │
│   → 触发 inlineSuggest.trigger      │
│ • 如果有 followups 队列：           │
│   → 触发下一个建议                   │
└─────────────────────────────────────┘
```

---

## 多编辑（Multidiff）流程

当服务器返回多个连续编辑时：

```
StreamCppResponse 包含多个编辑
         │
         ▼
┌─────────────────────────────────────┐
│ 第一个编辑 → 立即返回给用户          │
│ 后续编辑 → 存入 followups 队列       │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│ 注册 nextAction: { action: 'nextEdit' }│
└────────────────┬────────────────────┘
                 │
         用户接受第一个编辑
                 │
                 ▼
┌─────────────────────────────────────┐
│ displayNextActionIfAvailable        │
│ → 发现 nextEdit action              │
│ → 触发 editor.action.inlineSuggest.trigger │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│ 新的 provideInlineCompletionItems   │
│ → 从 followups 队列取出下一个编辑   │
│ → 显示给用户                         │
└─────────────────────────────────────┘
                 │
            循环直到队列为空
```

---

## 光标预测流程

### 融合模型（Fused Model）

当前 Cursor 使用融合模型，光标预测作为 `StreamCppResponse` 的一部分返回：

```
StreamCppResponse
         │
         ├── text + rangeToReplace（代码编辑）
         │
         └── cursorPredictionTarget（预测目标）
                 │
                 ▼
┌─────────────────────────────────────┐
│ 根据预测目标构建 displayLocation    │
│                                     │
│ 同文件：                             │
│   kind: Code                        │
│   range: 目标行范围                  │
│                                     │
│ 跨文件：                             │
│   kind: Label                       │
│   label: "Go to file:line"          │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│ InlineCompletionItem.displayLocation│
│ → VS Code 显示预测位置装饰          │
└─────────────────────────────────────┘
                 │
         用户接受建议
                 │
                 ▼
┌─────────────────────────────────────┐
│ 执行 goToCursorPrediction 命令      │
│ → 导航到预测位置                     │
│ → 如果 shouldRetriggerCpp：         │
│   → 触发新的补全请求                 │
└─────────────────────────────────────┘
```

### 独立光标预测（已废弃）

独立的 `StreamNextCursorPrediction` RPC 已不再使用，服务器返回 "unimplemented"。

---

## 错误处理

### 请求失败

```typescript
try {
  const chunks = await withRetry(
    () => this.consumeStream(...),
    { retries: 2, delayMs: 150 }
  );
} catch (error) {
  this.logger.error(`[Cpp] Request ${requestId} failed: ${error.message}`);
  this.telemetryService?.recordGenerationFinished(requestId, false);
  return null; // 不抛出错误，避免破坏补全流程
}
```

### 请求被取代

```typescript
// 检查请求是否仍然是当前请求
const currentRequest = this.currentRequestByDocument.get(docKey);
if (currentRequest !== requestId) {
  // 缓存结果而非丢弃
  this.addToSuggestionCache(suggestion, documentUri, documentVersion);
  return null;
}
```

### 流超时

```typescript
if (performance.now() - startTime > 10000) {
  this.streams = this.streams.filter((t) => t.generationUUID !== requestId);
  return { type: 'failure', reason: 'stream took too long' };
}
```

---

## 性能优化

### 防抖

- 客户端防抖：25ms
- 总防抖窗口：60ms
- 最大并发流：6 个

### 文件同步

- 增量更新减少传输量
- 成功阈值后启用 `relyOnFileSync`
- 内容截断（光标前后各 300 行）

### 缓存

- 建议缓存防止丢失
- 最多缓存 5 个建议
- 版本差异容忍度 1

### 请求取消

- 新请求自动取消旧请求
- 超时自动取消
- 用户取消（取消令牌）
