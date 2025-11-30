# Cometix Tab

[![VS Code](https://img.shields.io/badge/VS%20Code-1.103.1+-blue.svg)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9+-blue.svg)](https://www.typescriptlang.org/)

Cometix Tab 是一个 VS Code 扩展，将 Cursor 编辑器的智能代码补全功能带入 VS Code。通过调用 Cursor 的后端 API，为您提供强大的 AI 辅助编程体验。

## 功能特性

### 智能内联建议 (Inline Suggestions)

- **实时代码补全**：基于上下文的智能代码建议
- **多行编辑支持 (Multidiff)**：一次建议可包含多处编辑
- **流式响应**：实时显示建议，无需等待完整响应
- **智能防抖**：避免频繁请求，优化性能

### 光标预测 (Cursor Prediction)

- **下一编辑位置预测**：智能预测您接下来要编辑的位置
- **同文件预测**：在当前文件内预测下一个编辑点
- **跨文件预测**：预测可能需要编辑的其他文件
- **融合模型支持**：预测信息与补全建议一同返回

### 文件同步 (FileSync)

- **增量同步**：仅同步变更部分，减少传输量
- **自动版本管理**：追踪文件版本，确保一致性
- **智能回退**：版本漂移过大时自动全量同步

### Proposed API 自动配置

- **启动检测**：自动检测 VS Code Proposed API 是否已启用
- **权限提升**：支持管理员权限修改 product.json
- **一键配置**：无需手动编辑配置文件

## 安装

### 前置要求

- VS Code 1.103.1 或更高版本
- Node.js 18+ (开发时需要)
- 有效的 Cursor 账户和认证令牌

### 从源码安装

```bash
# 克隆仓库
git clone https://github.com/your-repo/cometix-tab.git
cd cometix-tab

# 安装依赖
pnpm install

# 编译
pnpm run compile

# 在 VS Code 中按 F5 启动调试
```

### 从 VSIX 安装

```bash
# 打包
pnpm run package

# 在 VS Code 中安装
code --install-extension cometix-tab-0.0.1.vsix
```

## 配置

在 VS Code 设置中配置 Cometix Tab：

### 必需配置

| 配置项 | 说明 |
|--------|------|
| `cometixTab.authToken` | Cursor 认证令牌（必需） |

### 功能开关

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `cometixTab.enableInlineSuggestions` | `true` | 启用内联代码建议 |
| `cometixTab.enableCursorPrediction` | `true` | 启用光标位置预测 |
| `cometixTab.enableAdditionalFilesContext` | `true` | 在请求中包含最近查看的文件上下文 |
| `cometixTab.cppTriggerInComments` | `true` | 在注释中触发建议 |
| `cometixTab.excludedLanguages` | `[]` | 禁用建议的语言列表 |

### 高级配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `cometixTab.serverUrl` | `""` | 自定义 API URL（留空使用官方） |
| `cometixTab.clientKey` | `""` | 客户端密钥（留空自动生成） |

### 调试配置

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `cometixTab.debug.enabled` | `true` | 启用调试日志 |
| `cometixTab.debug.logStream` | `true` | 记录流式响应 |
| `cometixTab.debug.logRpc` | `true` | 记录 RPC 请求/响应 |
| `cometixTab.debug.verbosePayloads` | `false` | 记录完整载荷 |

## 使用方法

### 获取代码建议

1. 在编辑器中正常输入代码
2. 等待灰色虚拟文本出现（代码建议）
3. 按 `Tab` 接受建议

### 使用光标预测

1. 接受代码建议后，注意编辑器中的预测装饰
2. 光标预测会显示在下一个可能的编辑位置
3. 接受后会自动跳转到预测位置并触发新的建议

### 命令

| 命令 | 说明 |
|------|------|
| `Cursor Tab: Accept Inline Suggestion` | 接受当前内联建议 |
| `Cursor Tab: Apply Next Edit` | 应用队列中的下一个编辑 |
| `Cursor Tab: Go To Cursor Prediction` | 跳转到预测的光标位置 |
| `Cometix Tab: Enable Proposed API` | 启用 VS Code Proposed API |

## 技术文档

详细的技术文档位于 `docs/` 目录：

- [文档首页](./docs/README.md) - 文档导航
- [Cursor API 详解](./docs/CURSOR-API.md) - API 接口和协议说明
- [系统架构](./docs/ARCHITECTURE.md) - 模块划分和数据流
- [服务详解](./docs/SERVICES.md) - 依赖注入服务说明
- [补全流程](./docs/COMPLETION-FLOW.md) - 代码补全完整流程

## Proposed API 配置

Cometix Tab 使用 VS Code 的 Proposed API (`inlineCompletionsAdditions`) 来提供完整功能。

### 自动配置

首次启动时，扩展会自动检测并提示您启用 Proposed API：

1. 弹出提示框询问是否启用
2. 选择「启用（需要管理员权限）」
3. 在系统对话框中确认权限请求
4. 重启 VS Code 生效

### 手动配置

如果您选择了「不再提示」，可以通过命令重新触发：

1. 按 `Ctrl+Shift+P` 打开命令面板
2. 搜索并执行 `Cometix Tab: Enable Proposed API`

## 开发

### 项目结构

```
src/
├── api/          # API 客户端
├── commands/     # VS Code 命令
├── container/    # 依赖注入容器
├── context/      # 上下文和请求构建
├── controllers/  # 控制器
├── providers/    # VS Code Provider
├── rpc/          # Protobuf 定义
├── services/     # 核心服务
├── utils/        # 工具函数
└── extension.ts  # 扩展入口
```

### 常用脚本

```bash
# 编译
pnpm run compile

# 监视模式
pnpm run watch

# 类型检查
pnpm run check-types

# 代码检查
pnpm run lint

# 运行测试
pnpm run test

# 打包
pnpm run package
```

## 依赖

- `@bufbuild/protobuf` - Protobuf 序列化
- `@connectrpc/connect` - Connect RPC 客户端
- `@connectrpc/connect-node` - Node.js 传输层
- `@vscode/sudo-prompt` - 权限提升支持

## 许可证

MIT

## 致谢

~~本项目基于对 Haleclipse 的开发~~（逃），感谢 Cometix Space 的大家支持