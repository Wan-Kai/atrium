# 路线图

## 原则

- **用真实的日常任务驱动**：每个阶段都要产出自己真会用的东西。
- **有两个实现再抽象**：先写死，跑顺了再抽接口，用第二个实现验证。
- **不过早平台化**：插件系统、分享、多 harness 都往后放。
- **纵向做透**：优先做只有深入 pi 内部才能实现的功能（见 [ADR-0004](adr/0004-deep-pi-host-positioning.md)）。

## 阶段

### 0. 了解 pi（时限 1–2 周，可与 MVP 1 并行）

对照源码和资料（见 [research/references.md](research/references.md)），写几个小 extension：

1. **观察者**：订阅所有钩子，把事件和时间戳写进日志，看清一次 turn 的完整生命周期。它会成为阶段 4 loop devtools 的数据源。
2. **工具拦截**：在 `tool_call` 里阻止或改写调用，理解权限模型。
3. **上下文改写**：在 `context` 钩子里裁剪旧的 tool result，观察对模型表现的影响。
4. **一个日常工具**：用 `registerTool` 做一个自己会用的功能。

### 1. v0.1：替代 Codex 做日常编码

目标：日常编码从 Codex 换到 Atrium。模型沿用 ChatGPT 订阅（pi 的 `/login` 选 OpenAI Codex）。浏览器操作不单独开发：在 pi 的 `mcp.json` 里配置 chrome-devtools 或 Playwright 的 MCP server，从 MVP 1 起即可使用。

按下面的顺序做，每一步做完都能用：

1. **MVP 1：纯对话**（见 [SPEC-0001](specs/0001-mvp1-single-session-chat.md)）
   - monorepo 骨架：`protocol` / `client` / `host` / `ui` + Electron 外壳，先只做 macOS（见 [ADR-0005](adr/0005-split-host-and-ui-pwa-first.md)）
   - pi RPC 适配器 + Atrium 事件模型；宿主 WebSocket 服务 + token 鉴权
   - 流式输出、推理过程、中断；按项目和工作区组织会话，能恢复历史会话；会话可以在后台运行，多个同时跑
   - 首次启动引导：安装 pi、登录模型、添加项目
   - 图片输入、工具调用展示（文件改动显示为 diff）、切换模型和推理强度
   - 不涉及任何 extension；也不做审批，沿用 pi 的默认行为（工具调用直接执行）
2. **MVP 2：看得见内部**
   - 宿主注入内置 extension：放在 `extensions/` 下，按 pi package 组织，可以在终端 pi 里单独测试
   - 审批：基于 `tool_call` 钩子，规则对齐 Codex（只读操作自动放行，写入和执行需要确认）
   - 上下文检查器（基础版）：每轮实际发给模型的内容和 token 分布
   - 检查器作为单个会话内部的"对话 / 轨迹"视图切换接入（参考 DeepSeek Harness），和会话标签页不冲突
   - 输入框加审批模式选择器（MVP 1 不显示审批相关的标签）
   - extension → 宿主通道：先用"通知加标记"（参考 Paseo）；不在 Atrium 宿主下运行时自动降级
3. **并行与 worktree**
   - 完成或等待处理时发系统通知；"已完成未读"状态
   - 新建 worktree 工作区：由宿主创建 worktree，会话在其中运行；工作区提供查看改动、合并、归档并清理 worktree 的入口

不做：沙箱隔离、插件系统、会话树、agent 自扩展、打包签名。

成功标准：连续两周把 Atrium 当作日常编码的主力工具；至少有一次通过上下文检查器发现问题，并用 extension 修好。

### 2. 第一个插件：todo（先写死）

覆盖插件的三个部分：工具（`todo_write`）、数据（跟随会话分支）、视图（桌面面板实时刷新）。

### 3. 抽出插件接口

从 todo 中抽出"extension + 视图"的插件接口，再用第二个插件验证。

### 4. 深度特性

Atrium 区别于宿主层方案的核心，按学习价值和实现难度排序：

1. **loop devtools**：把阶段 0 的观察者插件界面化，实时展示钩子事件流。
2. **上下文检查器（完整版）**：在 v0.1 基础版之上，展示压缩时机，支持钉住或丢弃。
3. **工具调用拦截**：在 v0.1 审批之上，支持执行前修改参数。
4. **会话树**：可视化 pi 的分支会话，支持分叉、对比，插件状态跟随分支切换。

### 5. agent 自扩展

让 agent 按需求生成插件、热加载，出错后能自我修复。

### 6. 分享

通过 pi package 分发。评估第三方插件的沙箱、权限声明，以及 UI 部分是否向 MCP Apps 这类标准靠拢。

## 以后再说

- 接入其他 harness：Codex（`codex app-server`）、ACP 通用适配
- DeepSeek Harness：稳定后写桥接插件，与 pi 做横向对比
- 沙箱隔离：v0.1 只靠审批，以后评估容器方案（pi 官方的建议）
- 内嵌浏览器面板：用 Electron 内嵌浏览器，作为工具提供给 agent，替代 v0.1 的 MCP 方案
- 手机端：先做响应式 + PWA，远程访问走 Tailscale；原生 App 视需要再做（见 [ADR-0005](adr/0005-split-host-and-ui-pwa-first.md)）
