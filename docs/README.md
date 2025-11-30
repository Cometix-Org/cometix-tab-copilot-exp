# Cometix Tab 文档

欢迎阅读 Cometix Tab 的技术文档。本文档详细介绍了该 VS Code 扩展如何将 Cursor 的智能代码补全功能带入 VS Code 编辑器。

## 文档目录

| 文档 | 描述 |
|------|------|
| [CURSOR-API.md](./CURSOR-API.md) | Cursor API 接口详解，包括所有 RPC 端点和协议说明 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 系统架构概览，模块划分和数据流向 |
| [SERVICES.md](./SERVICES.md) | 依赖注入服务详解，各个 Service 的职责和实现 |
| [COMPLETION-FLOW.md](./COMPLETION-FLOW.md) | 代码补全流程详解，从触发到显示的完整流程 |

## 项目概述

Cometix Tab 是一个 VS Code 扩展，通过调用 Cursor 的后端 API，为 VS Code 提供以下功能：

### 核心功能

1. **内联代码建议 (Inline Suggestions)**
   - 基于上下文的智能代码补全
   - 支持多行代码编辑 (Multidiff)
   - 实时流式响应

2. **光标预测 (Cursor Prediction)**
   - 预测用户下一步编辑位置
   - 支持同文件和跨文件预测
   - 融合模型 (Fused Model) 支持

3. **文件同步 (FileSync)**
   - 与 Cursor 后端同步文件状态
   - 增量更新优化
   - 自动版本管理

## 技术栈

- **语言**: TypeScript
- **运行环境**: VS Code Extension Host
- **通信协议**: Connect RPC (基于 Protobuf)
- **依赖管理**: pnpm

## 快速链接

- [配置选项](./SERVICES.md#配置服务-configservice)
- [API 端点列表](./CURSOR-API.md#端点列表)
- [状态机工作原理](./COMPLETION-FLOW.md#状态机)
