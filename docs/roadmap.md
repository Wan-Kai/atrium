# 路线图

## 原则

- **用真实的日常任务驱动**：每个阶段都要产出自己真会用的东西。
- **有两个实现再抽象**：先写死，跑顺了再抽接口，用第二个实现验证。
- **不过早平台化**：插件系统、分享、多 harness 都往后放。
- **纵向做透**：优先做只有深入 pi 内部才能实现的功能（见 [ADR-0004](adr/0004-deep-pi-host-positioning.md)）。

## 阶段

### 0. 了解 pi（时限 1–2 周）

对照源码和资料（见 [research/references.md](research/references.md)），写几个小 extension：

1. **观察者**：订阅所有钩子，把事件和时间戳写进日志，看清一次 turn 的完整生命周期。它会成为阶段 4 loop devtools 的数据源。
2. **工具拦截**：在 `tool_call` 里阻止或改写调用，理解权限模型。
3. **上下文改写**：在 `context` 钩子里裁剪旧的 tool result，观察对模型表现的影响。
4. **一个日常工具**：用 `registerTool` 做一个自己会用的功能。

### 1. 基础对话

- monorepo 骨架：`protocol` / `client` / `host` / `ui` + Electron 外壳，先只做 macOS（见 [ADR-0005](adr/0005-split-host-and-ui-pwa-first.md)）
- pi RPC 适配器 + Atrium 事件模型
- 宿主 WebSocket 服务 + token 鉴权
- 流式输出、中断、会话列表

### 2. 第一个插件：todo（先写死）

覆盖插件的三个部分：工具（`todo_write`）、数据（跟随会话分支）、视图（桌面面板实时刷新）。

### 3. 抽出插件接口

从 todo 中抽出"extension + 视图"的插件接口，再用第二个插件验证。

### 4. 深度特性

Atrium 区别于宿主层方案的核心，按学习价值和实现难度排序：

1. **loop devtools**：把阶段 0 的观察者插件界面化，实时展示钩子事件流。
2. **上下文检查器**：基于 `context` 钩子，展示每轮实际发给模型的内容、token 分布和压缩时机，支持钉住或丢弃。
3. **工具调用拦截**：基于 `tool_call` 钩子，执行前查看、修改、拒绝参数。
4. **会话树**：可视化 pi 的分支会话，支持分叉、对比，插件状态跟随分支切换。

### 5. agent 自扩展

让 agent 按需求生成插件、热加载，出错后能自我修复。

### 6. 分享

通过 pi package 分发。评估第三方插件的沙箱、权限声明，以及 UI 部分是否向 MCP Apps 这类标准靠拢。

## 以后再说

- 接入其他 harness：Codex（`codex app-server`）、ACP 通用适配
- DeepSeek Harness：稳定后写桥接插件，与 pi 做横向对比
- 手机端：先做响应式 + PWA，远程访问走 Tailscale；原生 App 视需要再做（见 [ADR-0005](adr/0005-split-host-and-ui-pwa-first.md)）
