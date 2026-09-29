# ADR-0005：宿主与 UI 分离、经 WebSocket 通信，手机端先走 PWA

- **状态**：已接受
- **日期**：2026-09-29
- **相关**：[ADR-0002](0002-connect-pi-via-rpc-subprocess.md)、[ADR-0003](0003-plugin-as-pi-package.md)、[ADR-0004](0004-deep-pi-host-positioning.md)、[架构总览](../architecture/overview.md)

## 背景

阶段 1 要定下技术栈。约束和驱动因素：

- pi 属于 Node / TypeScript 生态，接入方式是启动 `pi --mode rpc` 子进程（ADR-0002），宿主需要 Node 运行时。
- 深度特性是 Atrium 的核心（ADR-0004），它们依赖 DOM 生态：会话树、事件流要用 React Flow，查看上下文和工具参数要用 CodeMirror，界面组件用 shadcn。
- 插件视图用 React 写，由宿主按约定动态加载（ADR-0003）。
- 希望以后能在手机上使用。手机上的场景主要是看进度、批准工具调用、快速回复一句、看一眼 todo；会话树、上下文检查器这类深度功能主要在桌面上用。

## 决策

**1. 宿主与 UI 分离。** 宿主是独立的 Node 进程，负责 pi 适配器和 WebSocket 服务。UI 只通过 WebSocket 和 Atrium 协议与宿主通信。手机端只是多一个连接宿主的客户端。

**2. 采用 TypeScript monorepo：**

```
packages/
├── protocol/   # zod 定义的命令与事件，宿主和客户端共用
├── client/     # 连接 + 协议处理 + 状态管理，不依赖 DOM
├── host/       # pi 适配器 + WebSocket 服务 + 鉴权
└── ui/         # React + Vite，响应式，兼作 PWA
apps/desktop/   # Electron 外壳
```

- `client` 不碰 DOM，浏览器、Electron、React Native 都能复用（参照 Paseo 的 `@getpaseo/client`）。
- 宿主直接提供 `ui` 的静态资源，手机浏览器访问后"添加到主屏幕"即可当 PWA 使用。

**3. 宿主从第一天起就做鉴权。** 监听地址可配置，默认只监听本机；连接时校验 token。远程访问借助 Tailscale 这类组网工具，不像 Paseo 那样自建 relay 和端到端加密。

**4. 手机端先走 PWA。** 以后确有需要，再用 Expo / React Native 做一个精简版原生 App，复用 `protocol` 和 `client`，不追求和桌面端功能对等。插件视图在原生 App 里通过 WebView 加载，或者由插件声明"不支持手机端"。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| 宿主内嵌在 Electron 主进程，UI 走 IPC | 少一层网络和鉴权 | 手机和浏览器接不进来，以后要多端时得重新拆分 |
| Tauri 外壳 | 安装包小，内存占用低 | 宿主需要 Node，只能以 sidecar 形式附带 Node 运行时；要同时维护 Rust 和 TypeScript |
| 手机端：以后单独做原生 App（Expo / RN） | 推送、后台运行等原生能力完整 | 要单独写一套 UI。作为后续路线保留，现在不做 |
| 手机端：像 Paseo 一样一开始就全用 RN | 一套代码覆盖所有端 | 失去 DOM 生态，React Flow、shadcn、CodeMirror 用不上或很别扭。这对以手机端为核心卖点的 Paseo 是对的，对 Atrium 则会拖累深度特性 |
| 宿主 + UI 分离，手机端先 PWA（采用） | 几乎不增加技术栈；多端只是多一个客户端；深度特性保留完整的 DOM 生态 | 多一层 WebSocket；PWA 原生能力有限 |

## 后果

- 正面：支持多端不需要改架构；`client` 层以后可以直接用在原生 App 里；宿主可以脱离 Electron 独立运行，调试和测试更方便。
- 负面 / 代价：
  - 多一层 WebSocket 通信和序列化，鉴权从第一天起就要维护。
  - PWA 的原生能力有限：推送需要先添加到主屏幕，也不能在后台运行。
  - 插件视图绑定在 React DOM 上，将来的原生 App 只能用 WebView 显示，或者直接不支持。
- 什么情况下应重新评估：PWA 不够用时（比如需要可靠的推送或后台运行），启动原生 App；Electron 的体积或内存成为实际问题时，重新比较外壳方案。
