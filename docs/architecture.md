# 架构

> 状态：初步设想，随实现调整。

## 选型：基于 pi，而不是多 harness 抽象

考虑过两个方案：

| | A：双层抽象（类似 Paseo） | B：基于 pi（当前选择） |
|---|---|---|
| 做法 | 底层适配多个 harness，顶层基于抽象设计插件 | pi 作为唯一内核，桌面插件就是 pi 插件 |
| 插件能力 | 只有公共子集：MCP 注入工具 + 观察事件 | 整个 agent loop：`context`、`tool_call`、分支状态、续跑 |
| 工作量 | 每个 harness 一个适配器 + 抽象层 | 只接 pi |
| 学习收获 | 偏集成与抽象设计 | 偏 agent 内部机制 |
| 分享 | 分发、安装、版本自建 | pi package 现成（`pi install`、gallery） |
| 风险 | 抽象过早，公共子集很薄 | 绑定 pi，pi 迭代快 |

选择 B 的理由：目标是以练代学、日常能用、个人使用，B 在每一项上都更合适。

**何时重新考虑 A**：确实需要接入 Codex / Claude Code / DeepSeek Harness 时。为此在桌面端和 pi 之间保留一层适配器（见下）。

## 分层

```
┌─────────────────── Atrium 桌面端 ───────────────────┐
│  UI 外壳 · 会话列表 · 插件视图注册表                   │
│                    ▲                                │
│                    │ Atrium 事件（自有模型）           │
│  Harness 适配器（目前只有 pi）                         │
└────────────────────┬────────────────────────────────┘
                     │ stdio · JSONL RPC
          pi --mode rpc  +  extensions（插件逻辑）
```

- pi 以子进程运行（RPC 模式），崩溃不影响桌面端，便于同时管理多个会话。
- 桌面端**不直接依赖 pi 的事件类型**，由适配器翻译成 Atrium 事件。
- 对话历史由 pi 管理。Atrium 只存自己的索引 + pi 的 session id，不复制一份 transcript。

## 事件模型（草案）

从桌面端到 harness 的命令：

- `prompt(text, attachments?)`
- `interrupt()`
- `close()`

从 harness 到桌面端的事件：

- `turn_started`
- `text_delta` / `reasoning_delta`
- `tool_started` / `tool_finished`（携带结构化 `details`，供插件视图渲染）
- `turn_settled`：agent 不会再自动继续
- `error`

先只做这些，权限确认、模式切换等以后再加。参照对象：Paseo 的 `AgentSession` 接口、pi 的 RPC 协议。

## 插件模型

一个 Atrium 插件分两半，打包在同一个 pi package 里：

- **逻辑**：一个 pi extension，负责注册工具、处理钩子、产出结构化数据（tool result 的 `details` 或自定义 entry）。
- **视图**：一个桌面端组件，按插件名或数据类型注册渲染器，负责把数据画出来。

```json
{
  "name": "@ktoon/atrium-todo",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./extension/index.ts"] },
  "atrium": { "views": ["./view/index.tsx"] }
}
```

pi 忽略 `atrium` 字段，桌面端读取它来加载视图。

### 约束

- **UI 不能依赖 `ctx.ui.custom()`**：RPC 模式只转发对话框和通知，不转发自定义终端组件。extension 只产出数据，渲染交给桌面端。
- **状态跟随会话分支**：状态放在 tool result 的 `details` 里，在 `session_start` / `session_tree` 时沿 `ctx.sessionManager.getBranch()` 重建（参考 pi 官方 `examples/extensions/todo.ts`）。
- **生命周期**：工厂函数里不启动进程和定时器，在 `session_start` 启动、在 `session_shutdown` 幂等清理。
- **依赖**：`@earendil-works/pi-*` 和 `typebox` 放进 `peerDependencies`（`"*"`），不要打包。

## 安全

extension 跑在 pi 进程里，拥有和 pi 相同的系统权限。第三方插件安装前要看源码；将来开放分享时，需要重新评估沙箱和权限声明。
