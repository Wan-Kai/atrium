# 架构总览

> 状态：初步设想，随实现调整。

## 分层

```
  Electron 桌面端          手机 / 浏览器（PWA）
  └── ui                   └── ui
         │                        │
         └──── WebSocket · Atrium 协议 · token 鉴权 ────┐
                                                        ▼
┌──────────────────────── 宿主（Node） ────────────────────────┐
│  WebSocket 服务 · 鉴权 · 会话索引 · 提供 ui 静态资源            │
│  Harness 适配器（目前只有 pi）                                 │
└───────────────────────────┬──────────────────────────────────┘
                            │ stdio · JSONL RPC
                 pi --mode rpc  +  extensions（插件逻辑）
```

| 层 | 职责 |
|---|---|
| UI | 窗口、会话列表、对话视图、插件视图的挂载；响应式布局，兼作 PWA |
| 客户端层 | WebSocket 连接、协议处理、状态管理，不依赖 DOM |
| 宿主 | WebSocket 服务、鉴权、会话索引；通过 Harness 适配器启动和监督 harness 进程，把 harness 的事件翻译成 Atrium 事件 |
| pi + extensions | agent loop、会话、工具、上下文管理，以及插件的逻辑部分 |

选择 pi 作为唯一内核的理由见 [ADR-0001](../adr/0001-use-pi-as-core.md)；宿主与 UI 分离、手机端路线见 [ADR-0005](../adr/0005-split-host-and-ui-pwa-first.md)。

## 代码结构

```
packages/
├── protocol/   # zod 定义的命令与事件
├── client/     # 客户端层，不依赖 DOM
├── host/       # 宿主
└── ui/         # React + Vite
apps/desktop/   # Electron 外壳：启动宿主，加载 ui
```

## 进程模型

- 宿主是独立的 Node 进程。桌面端由 Electron 启动宿主，宿主也可以脱离 Electron 单独运行。
- 每个会话对应一个 pi 子进程（RPC 模式），理由见 [ADR-0002](../adr/0002-connect-pi-via-rpc-subprocess.md)。
- pi 崩溃不影响宿主和 UI，适配器负责重启和报错。

## 网络与鉴权

- 监听地址可配置，默认只监听本机。
- 连接时校验 token。
- 远程访问（比如用手机访问）走 Tailscale 这类组网工具，不自建 relay。

## 数据归属

- **对话历史归 pi**：存在 pi 自己的会话文件里。
- **Atrium 只存索引**：会话列表、标题、对应的 pi session id 等元数据，不复制 transcript。
- **插件状态跟随会话分支**：见 [插件模型](plugin-model.md)。

## 边界

- UI 和客户端层**只依赖 Atrium 协议**，不直接依赖 pi 的类型。将来接入其他 harness 时，只需在宿主里新增一个适配器。
- 将来做原生 App 时，复用 `protocol` 和 `client`，只重写 UI。
