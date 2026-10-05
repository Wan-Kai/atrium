# 路线图

> 本文是实现阶段的入口。上下文丢失（换人、换会话、对话被压缩）后，先读"当前状态"和"开工前必读"，再看当前里程碑的"参考"一栏。
>
> 引用写作"§N"时指该文档的第 N 节（二级标题前的编号）。
>
> 维护约定：每完成一个里程碑，更新"当前状态"并在里程碑标题后标 ✅；新增的关键决策写进"已定的关键决策"，并链到出处。

## 原则

- **用真实的日常任务驱动**：每个阶段都要产出自己真会用的东西。
- **有两个实现再抽象**：先写死，跑顺了再抽接口，用第二个实现验证。
- **不过早平台化**：插件系统、分享、多 harness 都往后放。
- **纵向做透**：优先做只有深入 pi 内部才能实现的功能（见 [ADR-0004](adr/0004-deep-pi-host-positioning.md)）。
- **以文档为准**：实现前先读对应的规格、领域模型和调研笔记；实现和文档不一致时，先改文档再改代码。

## 当前状态

**2026-10-04：M1.1 骨架完成，经三方审查（code-review、Grok 4.7、GPT-6-Astra）修复后合并进 `main`。正在做 [M1.2](#m12-最窄链路宿主驱动-pi)（分支 `m1.2-pi-link`）：已完成 faux 模型、LF 分帧、PiProcess（启动、请求对应、期限、停止时清理整棵进程树，真实 pi 启停 200 次无泄漏）；读取登录 shell 的环境与 pi 版本检查、宿主组装（stderr 挂在 `pi.process` span 下、请求 id 来自 span）、`pnpm pi:try` 在终端里流式打出回复、pi 契约测试与夹具（12 个场景，回放替身）；接下来是 M1.2 收尾：补 M1.1 留下的"部分"项、全量变异测试、三方审查、合并。**

| 已完成 | 产出 |
|---|---|
| 产品定位与范围 | [README](../README.md)、[ADR-0001～0004](adr/) |
| 架构 | [ADR-0005](adr/0005-split-host-and-ui-pwa-first.md)（宿主与 UI 分离）、[ADR-0006](adr/0006-organize-sessions-by-workspace.md)（按工作区组织会话）、[架构总览](architecture/overview.md) |
| MVP 1 需求与方案 | [SPEC-0001](specs/0001-mvp1-single-session-chat.md)：侧栏、对话区、首次启动三块已定稿 |
| 领域模型 | [domain-model.md](architecture/domain-model.md) 第 3 版：经 Grok 4.7、GPT-6-Astra 两轮评审，并对照 Paseo 与 pi 源码 |
| 视觉规范 | [design-language.md](architecture/design-language.md) |
| 界面原型 | `prototype/ui` 分支（见下文"原型"） |
| M1.1 骨架 | monorepo 七个包、Electron 启动宿主、token 与 Origin 鉴权、日志与链路追踪、空白界面跟随系统外观；七层测试各有示例并验证过会失败；变异分数 100%（等价变异在代码里注明理由）。实现中改动的决定已写回 testing.md、coding-standards.md、observability.md、development.md：界面泄漏改用自写的脱离 DOM 分析、Stryker 改用命令运行器、Vitest 5 的基准 API、开发端口 5791 |
| 工程约束 | 根目录 [AGENTS.md](../AGENTS.md)、[代码结构](architecture/overview.md#代码结构)、[编码规范](architecture/coding-standards.md)、[测试](architecture/testing.md)、[安全](architecture/security.md)、[日志与链路追踪](architecture/observability.md)、[开发环境与流程](development.md) |
| 源码调研 | [pi-internals.md](research/pi-internals.md)、[paseo-architecture.md](research/paseo-architecture.md)、[pi-extension-capabilities.md](research/pi-extension-capabilities.md) |

MVP 1 里还没设计、做到时先补设计的：

- logo，以及工作区、新会话、新对话的空状态（先用占位）。
- 设置页：原型里只有入口。SPEC-0001 里散落的设置项见 [M1.8](#m18-首次启动与设置)。

## 开工前必读

### 文档地图

| 要回答的问题 | 读哪里 |
|---|---|
| 做什么、不做什么、每个界面细节 | [SPEC-0001](specs/0001-mvp1-single-session-chat.md) |
| 有哪些对象、谁拥有谁、状态怎么派生、怎么同步 | [domain-model.md](architecture/domain-model.md) |
| 代码放在哪、包之间怎么依赖 | [overview.md · 代码结构](architecture/overview.md#代码结构) |
| 每次都要遵守的规则、完成标准 | 根目录 [AGENTS.md](../AGENTS.md) |
| 怎么写代码（JSDoc、错误、异步、多语言、无障碍） | [coding-standards.md](architecture/coding-standards.md) |
| 安全底线 | [security.md](architecture/security.md) |
| 日志和链路追踪 | [observability.md](architecture/observability.md) |
| 版本要求、分支、提交 | [development.md](development.md) |
| 命令和事件 | [SPEC-0001 · 接口与数据](specs/0001-mvp1-single-session-chat.md#接口与数据)（[event-model.md](architecture/event-model.md) 已被取代） |
| pi 的会话格式、RPC、事件、队列、重试、认证 | [pi-internals.md](research/pi-internals.md) |
| 同类宿主怎么做、哪些坑已经被踩过 | [paseo-architecture.md](research/paseo-architecture.md) |
| extension 能做什么（MVP 2） | [pi-extension-capabilities.md](research/pi-extension-capabilities.md) |
| 前端用什么库、流式回复怎么渲染 | 本文"已定的关键决策"里的"前端技术栈"、[SPEC-0001 · 对话区](specs/0001-mvp1-single-session-chat.md#对话区)的"回复渲染"、[M1.3](#m13-协议客户端与流式显示) |
| 怎么测、用什么检查代码 | [testing.md](architecture/testing.md) |
| 颜色、字体、圆角、图标、点阵、动效 | [design-language.md](architecture/design-language.md) |
| 某个决定为什么这样定 | [ADR](adr/) |

### 已定的关键决策

架构：

- pi 是唯一内核，以 `pi --mode rpc` 子进程接入，**一个会话一个进程**，不用 `switch_session`（[ADR-0001](adr/0001-use-pi-as-core.md)、[ADR-0002](adr/0002-connect-pi-via-rpc-subprocess.md)）。
- 宿主（Node）与 UI 分离，WebSocket + token；TypeScript monorepo（pnpm workspaces）：`protocol` / `client`（无 DOM）/ `host` / `ui`（React + Vite）+ `apps/desktop`（Electron），先只做 macOS（[ADR-0005](adr/0005-split-host-and-ui-pwa-first.md)）。
- pi 适配器**自己实现，不用 pi 自带的 `RpcClient`**：它回答不了 extension 对话框，启动方式、超时都写死（理由见 [SPEC-0001 · 风险与待定问题](specs/0001-mvp1-single-session-chat.md#风险与待定问题)）。
- `client` 的状态用 **Zustand**（`zustand/vanilla`），按领域拆 store，UI 用选择器订阅。
- 工程约束：[coding-standards.md](architecture/coding-standards.md)（每个函数和组件写 JSDoc：what、why、副作用）、[security.md](architecture/security.md)、[observability.md](architecture/observability.md)（OpenTelemetry 追踪 + pino 日志，全链路 trace id）。MVP 只做中文，宿主只发错误码不发文案。
- 测试与代码质量（[testing.md](architecture/testing.md)）：Vitest 5（含浏览器模式）、Playwright 驱动 Electron、fast-check、Stryker 变异测试（核心模块 ≥ 80%）、泄漏测试（资源计数回到基线；界面比较脱离文档的 DOM 节点）、性能预算、长时间运行；oxlint（类型感知）+ oxfmt + TypeScript 7 + knip + lefthook。能用真的就用真的，模型用 pi 的 faux，时间用假时钟。
- 项目 → 工作区 → 会话；工作区与目录一一对应；另有不绑定项目的"对话"（[ADR-0006](adr/0006-organize-sessions-by-workspace.md)）。

数据与运行（细节见 [domain-model.md](architecture/domain-model.md)）：

- 对话内容只在 pi 的会话文件里；Atrium 的索引在 `~/.atrium/`，只存登记、归属、别名、归档、关注状态、布局、偏好。
- 项目、工作区用随机 id（`prj_…`、`wks_…`）；会话用 pi 的会话 id；条目用"会话 id + 条目 id"。
- Atrium 建的会话创建时记下所属容器；没见过的会话按文件头 `cwd` 归类。
- **历史用 `get_entries` 沿当前分支重建，不用 `get_messages`**；在 `agent_settled`、`compaction_end` 和自己的命令之后再同步一次条目。
- 生命周期 `initializing / idle / running / error / closed`；**MVP 1 不回收空闲进程**。
- 排队在宿主；`prompt` 可能 `handled`（不运行）；压缩期间暂停出队；停止 = 暂停出队 → `clear_queue` → `abort`，2 秒没确认就锁住写操作。
- 失败重试 3 次再告诉用户：模型错误交给 pi 自带重试（`retry.maxRetries = 3`），进程崩溃由宿主自动重启最多 3 次。
- 关注状态（error / auth / finished）持久化，打开即清除；出错图标保留到下一次运行。
- 同步：列表带 `generation + seq`；对话记录带 `epoch + seq`，只推给订阅者，按游标分页；所有会话命令带 `sessionId + requestId`。
- 登录状态不靠 RPC 查（没有可用模型时 RPC 模式直接退出），用 `pi auth check --json` 或读 `auth.json`。
- 草稿会话重启后恢复；对话目录不自动清理；外部改动只预留 `session_changed_externally`。

界面（细节见 [SPEC-0001](specs/0001-mvp1-single-session-chat.md) 和 [design-language.md](architecture/design-language.md)）：

- 视觉对齐 DeepSeek Harness，动效对齐 Apple 弹簧；图标 Phosphor；点阵是贯穿的视觉语言。
- 前端技术栈：
  - 框架与样式：React + Vite；Tailwind + shadcn/ui。design-language 的颜色、圆角映射到 shadcn 的 CSS 变量（Streamdown 也读这套变量）。
  - 图标：Phosphor（`@phosphor-icons/react`）。动效不引入动画库，用 CSS `linear()` 弹簧曲线和少量手写弹簧（参数见 design-language "动效"）。
  - **流式回复渲染：Vercel 的 [Streamdown](https://github.com/vercel/streamdown)**（`streamdown`，调研时 2.7.0），插件 `@streamdown/code`（Shiki 高亮）、`@streamdown/math`（KaTeX）、`@streamdown/mermaid`、`@streamdown/cjk`。它负责补全没写完的语法、按块缓存；选型理由和对比见 [SPEC-0001 · 对话区](specs/0001-mvp1-single-session-chat.md#对话区)的"回复渲染"。
  - 流式节奏：宿主原样转发增量，客户端按积压量平滑揭示（约 150ms 追平，参考 Paseo 的 `text-reveal.ts`），再交给 Streamdown。
- 会话可在后台运行，多个同时跑；MVP 1 不做审批，不显示审批相关标签。

### 原型

- 位置：`prototype/ui` 分支的 `prototypes/` 目录（用完即弃，不进 `main`）。
- 定稿稿：
  - `app-prototype.html`：完整主界面（侧栏、标签栏、消息流、过程、输入框、模型与推理强度、状态栏）。
  - `onboarding-prototype.html`：首次启动（欢迎页、安装 pi、登录、添加项目）。
  - `brand/`（官方品牌图标，来源见 `brand/SOURCES.md`）、`fonts/`（标题字体子集）。
- 过程稿（只作参考）：`sidebar-prototype.html`、`conversation-prototype.html`、`icons-prototype.html`、`tags-prototype.html`、`fonts-prototype.html`、`cta-prototype.html`、`effort-prototype.html`、`effort-chip-prototype.html`。
- 本地预览：
  ```sh
  git worktree add ~/.cache/atrium-proto-wt prototype/ui   # 已存在则跳过
  cd ~/.cache/atrium-proto-wt/prototypes && python3 -m http.server 8765 --bind 127.0.0.1
  # 打开 http://127.0.0.1:8765/app-prototype.html
  ```
- 原型里的数值（颜色、尺寸、弹簧参数、点阵算法）可以直接搬到实现里；点阵和推理强度框的实现在 `app-prototype.html` 的 `dotField`、`effortBox`、`chipDots`，"开始设置"按钮的扫光在 `onboarding-prototype.html` 的 `dotCta`。

### 本地参考源码

- pi：`~/.cache/pi-src`（`git clone --depth 1 https://github.com/earendil-works/pi`，调研时为 `4c6fb7c`）。
- Paseo：`~/.cache/paseo-src`（`git clone --depth 1 https://github.com/getpaseo/paseo`，调研时为 `42806cd`）。
- 不在时重新克隆；实现前对照当前 pi 版本复核 [pi-internals.md](research/pi-internals.md) 里的结论。

### 提交约定

见 [development.md](development.md)：每个里程碑一个分支，完成后本地合并回 `main`；作者 `Ktoon <daodi154@gmail.com>`；提交信息英文祈使句；只在明确要求时推送。

## 阶段

### 0. 了解 pi（时限 1–2 周，可与 MVP 1 并行）

对照源码和资料（见 [research/references.md](research/references.md)），写几个小 extension：

1. **观察者**：订阅所有钩子，把事件和时间戳写进日志，看清一次 turn 的完整生命周期。它会成为阶段 4 loop devtools 的数据源。
2. **工具拦截**：在 `tool_call` 里阻止或改写调用，理解权限模型。
3. **上下文改写**：在 `context` 钩子里裁剪旧的 tool result，观察对模型表现的影响。
4. **一个日常工具**：用 `registerTool` 做一个自己会用的功能。

### 1. v0.1：替代 Codex 做日常编码

分三步：第 1 步 MVP 1、第 2 步 MVP 2、第 3 步并行与 worktree（其他文档里的"阶段 1 第 N 步"指这里）。

目标：日常编码从 Codex 换到 Atrium。模型沿用 ChatGPT 订阅。浏览器操作不单独开发：在 pi 的 `mcp.json` 里配置 chrome-devtools 或 Playwright 的 MCP server，从 MVP 1 起即可使用。

#### MVP 1：纯对话

范围见 [SPEC-0001](specs/0001-mvp1-single-session-chat.md)。按下面的里程碑做，每个做完都能跑、能验证。

每个里程碑的完成标准都隐含一条：[追踪表](architecture/testing.md#让覆盖面全)里这个里程碑涉及的行都有测试，`pnpm check` 通过，核心模块的变异分数不低于 80%（见 [testing.md](architecture/testing.md)）。

##### M1.1 骨架 ✅

- **目标**：`pnpm dev` 打开一个 Electron 窗口，显示宿主提供的空白 UI，UI 用 token 连上宿主的 WebSocket。
- **范围**：
  - pnpm workspaces，目录和依赖规则按 [overview.md · 代码结构](architecture/overview.md#代码结构)：`packages/protocol`、`pi`、`host`、`client`、`ui`、`testkit`，`apps/desktop`；依赖规则用 package.json、tsconfig 的 `lib` 和 oxlint 强制。
  - Electron 主进程用 `utilityProcess.fork` 启动宿主，随机端口 + 随机 token，preload 传给 UI；宿主入口不依赖 Electron，能用 `node` 单独运行。
  - 按 [security.md](architecture/security.md) 落实：token 不进 URL、校验 Origin、Electron 的隔离和导航限制、CSP。
  - 按 [observability.md](architecture/observability.md) 搭好追踪和日志：OpenTelemetry + 本地 JSONL 导出、pino、脱敏、轮转、`pnpm trace`；hello 带 `traceparent`（通用命令信封挪到 M1.3，M1.1 完成时没有做）。
  - JSDoc 检查：本地 oxlint 插件的 `atrium/require-jsdoc`，要求第一句、`@remarks`、`@sideEffects`。
  - 在 [development.md](development.md) 里记下固定的 Electron、pnpm 版本和最低 macOS 版本。
  - UI：React + Vite + Tailwind + shadcn；把 design-language 的变量落成 CSS 变量（浅色 / 深色 / 跟随系统）。
  - 搭好测试与代码质量工具（[testing.md](architecture/testing.md)）：Vitest 各层配置与文件后缀、Playwright + Electron、fast-check、Stryker、oxlint（类型感知 + vitest 规则）、oxfmt、TypeScript 7、knip、lefthook，以及 `pnpm test*` / `pnpm check` 命令。
  - 建立追踪表 `docs/testing/coverage-map.md`，先填 SPEC-0001 的需求和关键流程。
  - 宿主 `platform/` 的资源计数（PiProcess、SessionController、监听、订阅、定时器、子进程），泄漏测试和日志共用；`pnpm test:leak` / `test:perf` / `bench` / `test:soak` 的骨架。
- **参考**：[ADR-0005](adr/0005-split-host-and-ui-pwa-first.md)、[SPEC-0001 · 进程与启动、各包职责](specs/0001-mvp1-single-session-chat.md#进程与启动)、[design-language · 颜色](architecture/design-language.md#颜色)。
- **完成标准**：窗口能打开；token 错误、来源不对时连接被拒；渲染进程拿不到 Node；一次连接在日志里能按 trace id 串起来；日志里搜不到 token；切换系统外观界面跟着变；`pnpm check` 通过；每一层各有一个能跑的示例测试，并确认它在实现被破坏时会失败；一次变异测试能跑完并出报告。

##### M1.2 最窄链路：宿主驱动 pi

- **目标**：宿主启动 `pi --mode rpc`，发一条 prompt，在终端里打出流式文本，直到 `agent_settled`。
- **范围**：
  - ✅ 先验证 faux 模型：测试 extension 用 `pi.registerProvider()` 注册 pi-ai 的 `fauxProvider()`，在真实 RPC 进程里按脚本回复。已验证通过，实现在 `packages/testkit/src/faux/`（见 [testing.md · faux 模型](architecture/testing.md#faux-模型)）。
  - ✅ 第 3 层 pi 契约测试：逐条验证 pi-internals 里依赖的行为，并由它录制第 1 层的夹具（12 个场景，见 [testing.md · pi 夹具](architecture/testing.md#pi-夹具2026-10-05-定)；`pnpm fixtures:record` 重录）。
  - PiAdapter（自己实现，约 300 行）：直接启动 `pi --mode rpc`；严格按 LF 分帧（语义照搬 pi 的 `src/modes/rpc/jsonl.ts`，MIT，不用 `readline`；✅ 已实现于 `packages/pi/src/process/jsonl.ts`，改成每块只扫一次，16 MiB 的单行比 pi 的写法快约 60 倍）；按 `id` 对应乱序响应；按命令设超时（`compact` 不限时）；能发 `extension_ui_response`；stderr 只在内存留最近一段；退出时先关 stdin、再 SIGTERM，都不退才 SIGKILL：SIGKILL 前先按父进程关系找出 pi 的所有后代，连同它们各自的进程组一起杀，这一步失败时退而只杀 pi（pi 的 bash 工具子进程有自己的进程组，只杀 pi 的进程组会漏，见 [pi-internals](research/pi-internals.md) §3"退出"）；退出转成事件。类型用 `import type` 从固定版本的 `@earendil-works/pi-coding-agent` 取（开发依赖，不打进应用）。
  - ✅ 找到 pi：宿主启动后在后台读取登录 shell 的完整环境（从访达启动的 Electron 拿不到 shell 的 `PATH`、API Key、代理等），再在它的 `PATH` 上查找 pi（`packages/host/src/platform/login-shell.ts`、`packages/pi/src/locate/inspect.ts`）。node、npm、brew 的查找留到 M1.8 首次启动时做。
  - ✅ 版本检查：结果分为找不到、不能运行（带 pi 自己的报错）、版本过低、可用四种；提示升级的界面在 M1.8。最低版本先定为调研时的 1.0.1，pi-internals 里的结论都基于这个版本。
  - ✅ pi 的 stderr 按行记进日志（挂在 `pi.process` span 下），错误卡片"展开看原始报错"要用到；RPC 请求 id 由 span id 生成（`<span id>-<序号>`）。宿主侧的组装在 `platform/pi-deps.ts`（`PiDeps` 的实现）和 `sessions/traced-pi.ts`（`pi.process`、`pi.rpc` span）。
  - ✅ 目标里的"在终端里打出流式文本"：`pnpm pi:try "<提示词>"`（`packages/host/src/dev/try-pi.ts`）。
- **参考**：[SPEC-0001 · 首次启动](specs/0001-mvp1-single-session-chat.md#首次启动)的"第 1 步"（`PATH`）、[SPEC-0001 · 风险与待定问题](specs/0001-mvp1-single-session-chat.md#风险与待定问题)（版本兼容）、[pi-internals](research/pi-internals.md) §3 RPC 协议、pi 的 `packages/coding-agent/docs/rpc.md`、pi 的 `src/modes/rpc/rpc-client.ts`（只作对照，不直接用）、Paseo 的 `packages/server/src/server/agent/providers/jsonl-rpc-process.ts`。
- **完成标准**：适配器测试用录制的夹具跑通；分帧的属性测试通过；pi 契约测试全部通过；真实 pi 能完整跑完一轮；启动和停止 pi 200 次后没有残留进程、监听数回到基线；分帧吞吐有了基准基线。

##### M1.3 协议、客户端与流式显示

- **目标**：在 UI 里发消息，看到流式回复和推理过程。
- **范围**：
  - `protocol`：用 zod 定义 SPEC-0001 的命令和事件（先做本里程碑用到的），每条会话命令带 `sessionId + requestId + traceparent`，事件带 `epoch + seq` 和所属运行的 trace id。
  - 开工前先补齐协议细节，写进 SPEC-0001"接口与数据"（2026-10-04 架构审查后补全清单）：
    - 信封：所有命令都带 `requestId` 和 `traceparent`，会话命令再带 `sessionId`；放在 `protocol/src/envelope.ts`，客户端消息、宿主消息各是一个可辨识联合。
    - 应答：每条命令恰好一条应答，`{ ok: true, result? }` 或 `{ ok: false, error: { code, params? } }`，错误码是 protocol 里的枚举；未知或无效的消息也回带错误码的应答（届时把现在用日志"message ignored"计数的限流测试改成断言应答）。
    - 握手：welcome 带宿主实例 id（即列表同步的 generation），客户端重连时据此判断宿主是否重启过；心跳。
    - 事件：会话事件带 `sessionId + epoch + seq` 和所属运行的 trace id；列表事件带 `collection + generation + seq`。
    - 追踪：每条命令以自己的 `traceparent` 作父 span，再用 span link 指向连接的 trace，不挂在连接的长 trace 下面。
    - 附件：图片 base64 后通常超过单条 1 MiB 的上限，在单独上传、客户端先压缩、为附件放宽上限三者中定一个。
    - 订阅：SubscriptionRegistry 放 `sync/`（domain-model §6、§7）。
    - 发送端背压：发送前看 `bufferedAmount`，慢客户端不能让宿主内存无限增长。
    - 界面的错误和性能问题经一条上报消息回传宿主日志。
    - 重写已被取代的 `event-model.md`，或改为从 zod 定义生成。
  - 宿主侧：`server/connection.ts`（Connection：socket、clientId、send）和 `server/router.ts`（按 domain-model §8 的表分发命令，每条命令一个 `command <type>` span）从现在的 `ws-server.ts` 拆出来。
  - 客户端：`createAtriumClient` 作为唯一对外入口（clientId、connect、send、重连，拥有各个 store）；现在的 connection 降为内部模块，`buildHello`、`SocketLike` 不再导出。
  - `client`：WebSocket 连接、断线重连；状态用 Zustand vanilla store，按领域拆成列表、每个会话一个 SessionView（订阅时创建、退订时释放）、布局；流式增量只复制当前那条消息；对外只暴露 store 和命令方法。
  - SessionController + SessionRuntime 的最小形态：提交、流式事件翻译、`run_started / run_settled`。
  - UI：用户气泡、回复和推理过程、"进行中 · 12s"；滚动跟随（停在底部时跟随，往上翻停止跟随，出现"↓ 回到底部"）。
  - 流式渲染（选型见上文"前端技术栈"）：
    - 安装 `streamdown`、`@streamdown/code`、`@streamdown/math`、`@streamdown/mermaid`、`@streamdown/cjk`；引入 `streamdown/styles.css` 和 `katex/dist/katex.min.css`。
    - Tailwind 的 CSS 里为 `streamdown` 和每个已装插件加 `@source` 指向其 `dist/*.js`；monorepo 里依赖被提升到根目录 `node_modules`，路径按 CSS 文件位置数 `../`。
    - 用法：`<Streamdown plugins={{ code, math, mermaid, cjk }} isAnimating={正在流式}>{已揭示的文本}</Streamdown>`。回复和推理过程都用它渲染。
    - 平滑揭示放在 `client` 或 UI 的一个 hook 里：按积压量调节速度，约 150ms 追平；复制、选择、滚动都以完整文本为准。先不开 Streamdown 自带的 `animated`，避免和平滑揭示叠加。
    - 按 SPEC-0001"回复渲染"的范围配置：数学只认 `$$…$$` 和 `\(…\)`；KaTeX、Mermaid 第一次遇到时才加载；Shiki 主题跟随浅色 / 深色；用 `components` 覆盖 `a`（系统浏览器打开）和 `img`（远程图片点击后才加载）；原始 HTML 不执行。
- **参考**：[domain-model](architecture/domain-model.md) §3 会话运行、§7 客户端与一致性、§8 协议与类的对应、[SPEC-0001 · 接口与数据、回复渲染](specs/0001-mvp1-single-session-chat.md#接口与数据)、[SPEC-0001 · 对话区](specs/0001-mvp1-single-session-chat.md#对话区)的"回复渲染"、[design-language](architecture/design-language.md) 的"动效""消息流"、[Streamdown 文档](https://streamdown.ai/docs)（含各插件的 `@source` 写法）、原型 `app-prototype.html`、Paseo 的 `packages/app/src/agent-stream/text-reveal.ts`。
- **完成标准**：`protocol` 的 schema 测试通过；一轮对话在 UI 里完整显示；准备一份覆盖"回复渲染"全部范围的 Markdown（表格、嵌套列表、代码块与 diff、中文加粗紧挨标点、块公式与行内公式、Mermaid、链接、远程图片、原始 HTML），按真实节奏分片流式输出，过程中不闪烁、不错乱，结束后与一次性渲染结果一致；50 tok/s 流式输出长 Markdown 期间满足性能预算（没有超过 50 毫秒的长任务，帧时间 p95 ≤ 16.7 毫秒）。

##### M1.4 对话记录与过程

- **目标**：历史会话能完整恢复，过程（工具、diff、推理）按规格显示。
- **范围**：
  - pi 包的 HistoryMapper 把 pi 条目转成 LogEntry；SessionLog：`get_entries(since)` + `leafId`，按条目树沿当前分支重建 TranscriptProjection（轮、步骤、系统事件）。
  - 过程折叠行、单行步骤列表、详情块；`bash` / `read` / `edit` / `write` / 其他工具；diff；显示模式（摘要 / 思考 / 详细，Ctrl+O）。
  - 每轮改动汇总（"已观测到的工具修改"口径）、回复下方信息行、提问导航条。
  - 用户消息超过约 12 行折叠；复制消息和回复（需求 14）；回复"···"里的"复制为 Markdown"、整个会话"导出为 Markdown"。
  - 打开会话先取最近 20 轮（`fetch_transcript` 的 `tail`），翻到顶再按游标加载更早的（`before`）。
  - 历史会话的每轮用时由时间戳推算；TTFT、输出速度宿主重启后显示"—"。
- **参考**：[pi-internals](research/pi-internals.md) §1 会话文件、§3 RPC 协议、[domain-model](architecture/domain-model.md) §2 会话历史、[SPEC-0001 · 对话区](specs/0001-mvp1-single-session-chat.md#对话区)、Paseo 的 `packages/server/src/server/agent/providers/pi/history-mapper.ts`、`tool-call-mapper.ts`（Paseo 用 `get_messages`，只借鉴映射，不照搬重建方式）。
- **完成标准**：用一个带压缩、带分叉的真实会话文件恢复，显示的历史与终端 pi 一致，压缩前的内容不丢；打开 1000 轮的会话到首屏满足预算；2000 轮重建有基准基线。

##### M1.5 项目、工作区与会话

- **目标**：侧栏按"项目 → 工作区"组织，标签页切换会话，能恢复历史会话和草稿。
- **范围**：
  - 开工前先定 `~/.atrium/` 的文件布局、格式版本与迁移、文件损坏时的恢复，写进领域模型；宿主单实例（第二次打开应用时聚焦已有窗口，避免两个宿主同时写索引）。
  - IndexStore（`~/.atrium/`，原子写入）、ProjectService、WorkspaceService（`git worktree list`、分支、创建时间）、MergeInspector（未提交、↑N、无改动、已合并、已移除、无法判断）。
  - pi 包的 SessionFiles 扫描会话目录、解析文件头；宿主的 SessionCatalog 按 id 去重、报告冲突，按记录的容器或 `cwd` 归类；草稿会话；新建对话时立刻启动 pi，不等第一条消息（[领域模型 · 已决定 9](architecture/domain-model.md#已决定)）。
  - WorkspaceService 的后台 `git fetch`（窗口聚焦时、每隔几分钟）和聚焦后重算；git 低于 2.38 时只提示合并状态不可用。
  - 侧栏、收件箱、搜索、标签栏、"历史"、对话（ChatSpace）、命名与改名、归档、复制会话文件路径；侧栏底部的外观切换（跟随系统 / 浅色 / 深色）；空状态占位。
  - 快捷键：⌘N 新建对话，⌘T 新建会话，⌘W 关闭标签，⌘1–9、⌘⇧[ / ⌘⇧] 切换标签。
- **参考**：[ADR-0006](adr/0006-organize-sessions-by-workspace.md)、[domain-model](architecture/domain-model.md) §1 项目、工作区、会话，§6 宿主的组件、[SPEC-0001 · 侧栏](specs/0001-mvp1-single-session-chat.md#侧栏)、[paseo-architecture](research/paseo-architecture.md) §1 数据与持久化、§6 git 状态。
- **完成标准**：添加几个真实项目（含 worktree、非 git 目录）后，侧栏信息和 `git` / pi 的实际情况一致；在终端里开的 pi 会话自动出现在对应工作区。

##### M1.6 运行控制与输入

- **目标**：日常对话需要的控制都能用。
- **范围**：
  - 排队、插话、停止（2 秒确认与锁定）、压缩期间暂停出队、`handled` 处理、`queue_update` 确认插话送达。
  - 模型与推理强度（PiCatalog，档位按模型）、点阵模型按钮与推理强度框。
  - 输入框：图片（当前模型不支持图片时提示）、`@` 引用文件、`/` 命令、长文本粘贴、拖入、展开、↑ 历史、草稿、中文输入法回车、胶囊条（排队、插话、本会话改动）。
  - 快捷键：回车发送 / 排队，⌘+回车插话，Esc 停止，⌘⇧I 模型菜单，⌘⇧E 推理强度菜单。
  - 对话框（PendingInteraction）、状态栏（注册表、自定义入口、上下文分段估算）。
  - 失败重试与进程崩溃自动重启（各 3 次）、错误卡片。
  - 有余力再做（SPEC-0001 标为可选）：⌘F 会话内搜索、选中回复文字后"引用"。
- **参考**：[domain-model](architecture/domain-model.md) §3 会话运行、§5 模型与设置、[SPEC-0001 · 关键流程、输入框、状态栏](specs/0001-mvp1-single-session-chat.md#关键流程)、[pi-internals](research/pi-internals.md) §2 运行时、§4 模型与认证、§5 extension、[paseo-architecture](research/paseo-architecture.md) §2 生命周期（中断与锁定）、原型 `app-prototype.html`。
- **完成标准**：对照 SPEC-0001 需求 5～7、9～11 逐条验证；人为杀掉 pi 进程能自动恢复。

##### M1.7 并行、同步与关注

- **目标**：多个会话同时跑，切走不中断；断线重连不丢不重；收件箱准确。
- **范围**：
  - 后台运行、关注状态（error / auth）与收件箱、工作区与项目的状态汇总。
  - 列表同步（`generation + seq`，快照 / 增量）、会话订阅、对话记录按游标分页、重连流程、`clientMessageId` 对齐。
  - 自动生成标题（OneShotPi）、交给终端。
- **参考**：[domain-model](architecture/domain-model.md) §4 状态的派生、§7 客户端与一致性、[paseo-architecture](research/paseo-architecture.md) §4 同步、§5 状态与关注、pi 实验版的 Chord 设计（[pi-internals](research/pi-internals.md) §6）。
- **完成标准**：三个会话同时运行时切换、断网再连、重启宿主，状态和对话都正确；SPEC-0001 需求 12 通过；打开关闭会话、订阅退订、连接断开、停止、崩溃重启各 200 次的泄漏测试通过；界面在会话间切换后没有多出脱离文档的 DOM 节点；30 分钟长时间运行通过。

##### M1.8 首次启动与设置

- **目标**：全新机器上从零走到第一次对话；SPEC-0001 里散落的设置项有地方改。
- **范围**：
  - 开工前先验证：宿主能否直接调用 pi-ai 的 OAuth 实现完成订阅登录（SPEC-0001 写着"实施时确认"，是本里程碑最大的风险）。
  - 首次启动：检查 pi / Node / 登录 / 项目；一键安装和更新 pi（官方脚本、`pi update --self`、Homebrew 装 Node）；订阅登录（官方图标）与 API Key；从 pi 历史发现目录并添加；欢迎页（玻璃、点阵按钮、标题字体）。
  - 点阵图案的种子取本机安装 ID（存在 `~/.atrium/`），模型按钮拉满时的彩色点阵用同一个种子。
  - 字体子集和品牌图标打包进应用，不依赖网络。
  - 设置页（先设计，原型里只有入口）：外观；自动生成标题用的模型；项目的主干分支；pi 的版本与"更新 pi"（宿主每天查一次 npm，有会话在运行时等它们结束再更新）。
- **参考**：[SPEC-0001 · 首次启动](specs/0001-mvp1-single-session-chat.md#首次启动)、原型 `onboarding-prototype.html`、[design-language · 点阵、字体](architecture/design-language.md#点阵)、[pi-internals](research/pi-internals.md) §4 模型与认证、[domain-model](architecture/domain-model.md) §5 首次启动。
- **完成标准**：在一个没装 pi 的账户上走通；SPEC-0001 需求 13 通过；设置页里的每一项改完都生效。

##### M1.9 自用

- 用开发模式运行（v0.1 不打包签名），连续一周用它完成真实的编码任务，至少 10 个会话。
- 每天看宿主日志里的资源计数和内存趋势；发现持续上涨就补一个能复现的泄漏测试再修。
- 记录 pi 比 Codex 明显不够用的地方，作为 H1 的结论，决定是否继续这条路线。
- 对照 SPEC-0001 的 14 条需求逐条过一遍。

#### MVP 2：看得见内部

开工前写 SPEC-0002。

- 宿主注入内置 extension：放在 `extensions/` 下，按 pi package 组织，可以在终端 pi 里单独测试。
- extension → 宿主通道：先用"通知加标记"（参考 [paseo-architecture](research/paseo-architecture.md) §3 pi 的接入）；不在 Atrium 宿主下运行时自动降级。
- 审批：基于 `tool_call` 钩子，规则对齐 Codex（只读操作自动放行，写入和执行需要确认）；复用 PendingInteraction，状态"待审批"已在侧栏预留；输入框加审批模式选择器（⌘⇧M）。
- 上下文检查器（基础版）：每次实际发给模型的内容和 token 分布，由 extension 捕获（`before_provider_request` / `context`），不从状态栏的估算升级。
- 检查器作为单个会话内部的"对话 / 轨迹"视图切换接入（参考 DeepSeek Harness），和会话标签页不冲突。
- 检查点与回滚文件：每轮开始前快照，和审批一起做（SPEC-0001 "对话记录的其他设计"）。
- 参考：[pi-extension-capabilities.md](research/pi-extension-capabilities.md)、[pi-internals](research/pi-internals.md) §5 extension、[plugin-model.md](architecture/plugin-model.md)。

#### 并行与 worktree

- 完成或等待处理时发系统通知；"已完成未读"状态（关注原因 `finished`）。
- 新建 worktree 工作区：由宿主创建 worktree，记下起点提交，会话在其中运行；工作区提供查看改动、合并、归档并清理 worktree 的入口；新会话时可选"当前工作区 / 新建 worktree"。
- 参考：[SPEC-0001 · worktree 合并状态](specs/0001-mvp1-single-session-chat.md#侧栏)、[paseo-architecture](research/paseo-architecture.md) §6 git 状态。

v0.1 不做：沙箱隔离、插件系统、会话树、agent 自扩展、打包签名、空闲进程回收、文件区（外部改动的处理留到文件区设计）。

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
4. **会话树**：可视化 pi 的分支会话，支持分叉、对比，插件状态跟随分支切换；用户消息的编辑和重发、从某一轮分叉也在这里做。领域模型已按树建模（SessionLog），不用重来。

### 5. agent 自扩展

让 agent 按需求生成插件、热加载，出错后能自我修复。

### 6. 分享

通过 pi package 分发。评估第三方插件的沙箱、权限声明，以及 UI 部分是否向 MCP Apps 这类标准靠拢。

开源发布前要核对：汇文明朝体等"免费商用"字体的许可、各家品牌图标的使用规范、打包签名与自动更新。

## 以后再说

- 接入其他 harness：Codex（`codex app-server`）、ACP 通用适配
- DeepSeek Harness：稳定后写桥接插件，与 pi 做横向对比
- 沙箱隔离：v0.1 只靠审批，以后评估容器方案（pi 官方的建议）
- 内嵌浏览器面板：用 Electron 内嵌浏览器，作为工具提供给 agent，替代 v0.1 的 MCP 方案
- 手机端：先做响应式 + PWA，远程访问走 Tailscale；原生 App 视需要再做（见 [ADR-0005](adr/0005-split-host-and-ui-pwa-first.md)）
- 空闲进程回收、文件区、forge（PR）状态
- SPEC-0001 里标为"以后"的：侧聊、agent 提出的任务建议卡片、全文搜索、置顶、一个目录多个工作区、把对话移到项目、收藏模型、语音输入、订阅额度显示、长会话虚拟列表、extension 单向通知的显示
