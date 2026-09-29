# 架构总览

> 状态：初步设想，随实现调整。

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

| 层 | 职责 |
|---|---|
| UI 外壳 | 窗口、会话列表、对话视图、插件视图的挂载 |
| Harness 适配器 | 启动和监督 harness 进程，把 harness 的事件翻译成 Atrium 事件 |
| pi + extensions | agent loop、会话、工具、上下文管理，以及插件的逻辑部分 |

选择 pi 作为唯一内核的理由见 [ADR-0001](../adr/0001-use-pi-as-core.md)。

## 进程模型

- 每个会话对应一个 pi 子进程（RPC 模式），理由见 [ADR-0002](../adr/0002-connect-pi-via-rpc-subprocess.md)。
- pi 崩溃不影响桌面端，适配器负责重启和报错。

## 数据归属

- **对话历史归 pi**：存在 pi 自己的会话文件里。
- **Atrium 只存索引**：会话列表、标题、对应的 pi session id 等元数据，不复制 transcript。
- **插件状态跟随会话分支**：见 [插件模型](plugin-model.md)。

## 边界

桌面端**只依赖 Atrium 事件模型**，不直接依赖 pi 的类型。将来接入其他 harness 时，只需新增一个适配器。
