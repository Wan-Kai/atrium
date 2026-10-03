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

**2026-10-04：MVP 1 的设计已完成，还没有代码。下一步是 [M1.1](#m11-骨架)。**

| 已完成 | 产出 |
|---|---|
| 产品定位与范围 | [README](../README.md)、[ADR-0001～0004](adr/) |
| 架构 | [ADR-0005](adr/0005-split-host-and-ui-pwa-first.md)（宿主与 UI 分离）、[ADR-0006](adr/0006-organize-sessions-by-workspace.md)（按工作区组织会话）、[架构总览](architecture/overview.md) |
| MVP 1 需求与方案 | [SPEC-0001](specs/0001-mvp1-single-session-chat.md)：侧栏、对话区、首次启动三块已定稿 |
| 领域模型 | [domain-model.md](architecture/domain-model.md) 第 3 版：经 Grok 4.7、GPT-6-Astra 两轮评审，并对照 Paseo 与 pi 源码 |
| 视觉规范 | [design-language.md](architecture/design-language.md) |
| 界面原型 | `prototype/ui` 分支（见下文"原型"） |
| 源码调研 | [pi-internals.md](research/pi-internals.md)、[paseo-architecture.md](research/paseo-architecture.md)、[pi-extension-capabilities.md](research/pi-extension-capabilities.md) |

## 开工前必读

### 文档地图

| 要回答的问题 | 读哪里 |
|---|---|
| 做什么、不做什么、每个界面细节 | [SPEC-0001](specs/0001-mvp1-single-session-chat.md) |
| 有哪些对象、谁拥有谁、状态怎么派生、怎么同步 | [domain-model.md](architecture/domain-model.md) |
| 命令和事件 | [SPEC-0001 · 接口与数据](specs/0001-mvp1-single-session-chat.md#接口与数据)（[event-model.md](architecture/event-model.md) 已被取代） |
| pi 的会话格式、RPC、事件、队列、重试、认证 | [pi-internals.md](research/pi-internals.md) |
| 同类宿主怎么做、哪些坑已经被踩过 | [paseo-architecture.md](research/paseo-architecture.md) |
| extension 能做什么（MVP 2） | [pi-extension-capabilities.md](research/pi-extension-capabilities.md) |
| 颜色、字体、圆角、图标、点阵、动效 | [design-language.md](architecture/design-language.md) |
| 某个决定为什么这样定 | [ADR](adr/) |

### 已定的关键决策

架构：

- pi 是唯一内核，以 `pi --mode rpc` 子进程接入，**一个会话一个进程**，不用 `switch_session`（[ADR-0001](adr/0001-use-pi-as-core.md)、[ADR-0002](adr/0002-connect-pi-via-rpc-subprocess.md)）。
- 宿主（Node）与 UI 分离，WebSocket + token；TypeScript monorepo：`protocol` / `client`（无 DOM）/ `host` / `ui`（React + Vite）+ `apps/desktop`（Electron），先只做 macOS（[ADR-0005](adr/0005-split-host-and-ui-pwa-first.md)）。
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
- 回复渲染用 Streamdown（GFM、Shiki、KaTeX、Mermaid、CJK 插件按需加载）。
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

- 作者身份：`Ktoon <daodi154@gmail.com>`（仓库本地 git 配置）。
- 提交信息用英文、祈使句，正文说明改了什么、为什么；只在明确要求时推送。

## 阶段

### 0. 了解 pi（时限 1–2 周，可与 MVP 1 并行）

对照源码和资料（见 [research/references.md](research/references.md)），写几个小 extension：

1. **观察者**：订阅所有钩子，把事件和时间戳写进日志，看清一次 turn 的完整生命周期。它会成为阶段 4 loop devtools 的数据源。
2. **工具拦截**：在 `tool_call` 里阻止或改写调用，理解权限模型。
3. **上下文改写**：在 `context` 钩子里裁剪旧的 tool result，观察对模型表现的影响。
4. **一个日常工具**：用 `registerTool` 做一个自己会用的功能。

### 1. v0.1：替代 Codex 做日常编码

目标：日常编码从 Codex 换到 Atrium。模型沿用 ChatGPT 订阅。浏览器操作不单独开发：在 pi 的 `mcp.json` 里配置 chrome-devtools 或 Playwright 的 MCP server，从 MVP 1 起即可使用。

#### MVP 1：纯对话

范围见 [SPEC-0001](specs/0001-mvp1-single-session-chat.md)。按下面的里程碑做，每个做完都能跑、能验证。

##### M1.1 骨架

- **目标**：`pnpm dev` 打开一个 Electron 窗口，显示宿主提供的空白 UI，UI 用 token 连上宿主的 WebSocket。
- **范围**：
  - pnpm workspaces：`packages/protocol`、`client`、`host`、`ui`，`apps/desktop`。
  - Electron 主进程启动宿主（Node 子进程），随机端口 + 随机 token，preload 传给 UI。
  - UI：React + Vite + Tailwind + shadcn；把 design-language 的变量落成 CSS 变量（浅色 / 深色 / 跟随系统）。
  - 定下 SPEC-0001"风险与待定问题"里的工程选型：pi 适配器用 pi 自带的 `RpcClient` 还是自己写、`client` 的状态管理库。
- **参考**：[ADR-0005](adr/0005-split-host-and-ui-pwa-first.md)、[SPEC-0001 · 进程与启动、各包职责](specs/0001-mvp1-single-session-chat.md#进程与启动)、[design-language · 颜色](architecture/design-language.md#颜色)。
- **完成标准**：窗口能打开；token 错误时连接被拒；切换系统外观界面跟着变。

##### M1.2 最窄链路：宿主驱动 pi

- **目标**：宿主启动 `pi --mode rpc`，发一条 prompt，在终端里打出流式文本，直到 `agent_settled`。
- **范围**：
  - PiAdapter：严格按 LF 分帧的 JSONL（不用 `readline`）、按 `id` 对应乱序响应、超时、SIGTERM → SIGKILL 进程树、退出转成事件。
  - 录制几段真实的 pi 输出作为测试夹具（流式、工具调用、中断、退出）。
- **参考**：[pi-internals](research/pi-internals.md) §3 RPC 协议、pi 的 `packages/coding-agent/docs/rpc.md`、Paseo 的 `packages/server/src/server/agent/providers/jsonl-rpc-process.ts`。
- **完成标准**：适配器测试用录制的夹具跑通；真实 pi 能完整跑完一轮。

##### M1.3 协议、客户端与流式显示

- **目标**：在 UI 里发消息，看到流式回复和推理过程。
- **范围**：
  - `protocol`：用 zod 定义 SPEC-0001 的命令和事件（先做本里程碑用到的），每条会话命令带 `sessionId + requestId`，事件带 `epoch + seq`。
  - `client`：WebSocket 连接、断线重连、按 `sessionId` 维护 SessionView。
  - SessionController + SessionRuntime 的最小形态：提交、流式事件翻译、`run_started / run_settled`。
  - UI：用户气泡、回复（Streamdown）、平滑流式揭示、"进行中 · 12s"。
- **参考**：[domain-model](architecture/domain-model.md) §3 会话运行、§7 客户端与一致性、§8 协议与类的对应、[SPEC-0001 · 接口与数据、回复渲染](specs/0001-mvp1-single-session-chat.md#接口与数据)、原型 `app-prototype.html`、Paseo 的 `packages/app/src/agent-stream/text-reveal.ts`。
- **完成标准**：`protocol` 的 schema 测试通过；一轮对话在 UI 里完整显示。

##### M1.4 对话记录与过程

- **目标**：历史会话能完整恢复，过程（工具、diff、推理）按规格显示。
- **范围**：
  - SessionLog：`get_entries(since)` + `leafId`，按条目树沿当前分支重建 TranscriptProjection（轮、步骤、系统事件）。
  - 过程折叠行、单行步骤列表、详情块；`bash` / `read` / `edit` / `write` / 其他工具；diff；显示模式（摘要 / 思考 / 详细，Ctrl+O）。
  - 每轮改动汇总（"已观测到的工具修改"口径）、回复下方信息行、提问导航条。
- **参考**：[pi-internals](research/pi-internals.md) §1 会话文件、§3 RPC 协议、[domain-model](architecture/domain-model.md) §2 会话历史、[SPEC-0001 · 对话区](specs/0001-mvp1-single-session-chat.md#对话区)、Paseo 的 `packages/server/src/server/agent/providers/pi/history-mapper.ts`、`tool-call-mapper.ts`（Paseo 用 `get_messages`，只借鉴映射，不照搬重建方式）。
- **完成标准**：用一个带压缩、带分叉的真实会话文件恢复，显示的历史与终端 pi 一致，压缩前的内容不丢。

##### M1.5 项目、工作区与会话

- **目标**：侧栏按"项目 → 工作区"组织，标签页切换会话，能恢复历史会话和草稿。
- **范围**：
  - IndexStore（`~/.atrium/`，原子写入）、ProjectService、WorkspaceService（`git worktree list`、分支、创建时间）、MergeInspector（未提交、↑N、无改动、已合并、已移除、无法判断）。
  - SessionCatalog：扫描 pi 会话目录，按 id 去重、报告冲突，按记录的容器或 `cwd` 归类；草稿会话。
  - 侧栏、收件箱、搜索、标签栏、"历史"、对话（ChatSpace）、命名与改名、归档。
- **参考**：[ADR-0006](adr/0006-organize-sessions-by-workspace.md)、[domain-model](architecture/domain-model.md) §1 项目、工作区、会话，§6 宿主的组件、[SPEC-0001 · 侧栏](specs/0001-mvp1-single-session-chat.md#侧栏)、[paseo-architecture](research/paseo-architecture.md) §1 数据与持久化、§6 git 状态。
- **完成标准**：添加几个真实项目（含 worktree、非 git 目录）后，侧栏信息和 `git` / pi 的实际情况一致；在终端里开的 pi 会话自动出现在对应工作区。

##### M1.6 运行控制与输入

- **目标**：日常对话需要的控制都能用。
- **范围**：
  - 排队、插话、停止（2 秒确认与锁定）、压缩期间暂停出队、`handled` 处理、`queue_update` 确认插话送达。
  - 模型与推理强度（PiCatalog，档位按模型）、点阵模型按钮与推理强度框。
  - 输入框：图片、`@` 引用文件、`/` 命令、长文本粘贴、拖入、展开、↑ 历史、草稿、中文输入法回车。
  - 对话框（PendingInteraction）、状态栏（注册表、自定义入口、上下文分段估算）。
  - 失败重试与进程崩溃自动重启（各 3 次）、错误卡片。
- **参考**：[domain-model](architecture/domain-model.md) §3 会话运行、§5 模型与设置、[SPEC-0001 · 关键流程、输入框、状态栏](specs/0001-mvp1-single-session-chat.md#关键流程)、[pi-internals](research/pi-internals.md) §2 运行时、§4 模型与认证、§5 extension、[paseo-architecture](research/paseo-architecture.md) §2 生命周期（中断与锁定）、原型 `app-prototype.html`。
- **完成标准**：对照 SPEC-0001 需求 5～7、9～11 逐条验证；人为杀掉 pi 进程能自动恢复。

##### M1.7 并行、同步与关注

- **目标**：多个会话同时跑，切走不中断；断线重连不丢不重；收件箱准确。
- **范围**：
  - 后台运行、关注状态（error / auth）与收件箱、工作区与项目的状态汇总。
  - 列表同步（`generation + seq`，快照 / 增量）、会话订阅、对话记录按游标分页、重连流程、`clientMessageId` 对齐。
  - 自动生成标题（OneShotPi）、交给终端。
- **参考**：[domain-model](architecture/domain-model.md) §4 状态的派生、§7 客户端与一致性、[paseo-architecture](research/paseo-architecture.md) §4 同步、§5 状态与关注、pi 实验版的 Chord 设计（[pi-internals](research/pi-internals.md) §6）。
- **完成标准**：三个会话同时运行时切换、断网再连、重启宿主，状态和对话都正确；SPEC-0001 需求 12 通过。

##### M1.8 首次启动

- **目标**：全新机器上从零走到第一次对话。
- **范围**：检查 pi / Node / 登录 / 项目；一键安装和更新 pi（官方脚本、`pi update --self`、Homebrew 装 Node）；订阅登录（官方图标）与 API Key；从 pi 历史发现目录并添加；欢迎页（玻璃、点阵按钮、标题字体）。
- **参考**：[SPEC-0001 · 首次启动](specs/0001-mvp1-single-session-chat.md#首次启动)、原型 `onboarding-prototype.html`、[design-language · 点阵、字体](architecture/design-language.md#点阵)、[pi-internals](research/pi-internals.md) §4 模型与认证、[domain-model](architecture/domain-model.md) §5 首次启动。
- **完成标准**：在一个没装 pi 的账户上走通；SPEC-0001 需求 13 通过。

##### M1.9 自用

- 连续一周用它完成真实的编码任务，至少 10 个会话。
- 记录 pi 比 Codex 明显不够用的地方，作为 H1 的结论，决定是否继续这条路线。
- 对照 SPEC-0001 的 14 条需求逐条过一遍。

#### MVP 2：看得见内部

开工前写 SPEC-0002。

- 宿主注入内置 extension：放在 `extensions/` 下，按 pi package 组织，可以在终端 pi 里单独测试。
- extension → 宿主通道：先用"通知加标记"（参考 [paseo-architecture](research/paseo-architecture.md) §3 pi 的接入）；不在 Atrium 宿主下运行时自动降级。
- 审批：基于 `tool_call` 钩子，规则对齐 Codex（只读操作自动放行，写入和执行需要确认）；复用 PendingInteraction，状态"待审批"已在侧栏预留；输入框加审批模式选择器（⌘⇧M）。
- 上下文检查器（基础版）：每次实际发给模型的内容和 token 分布，由 extension 捕获（`before_provider_request` / `context`），不从状态栏的估算升级。
- 检查器作为单个会话内部的"对话 / 轨迹"视图切换接入（参考 DeepSeek Harness），和会话标签页不冲突。
- 参考：[pi-extension-capabilities.md](research/pi-extension-capabilities.md)、[pi-internals](research/pi-internals.md) §5 extension、[plugin-model.md](architecture/plugin-model.md)。

#### 并行与 worktree

- 完成或等待处理时发系统通知；"已完成未读"状态（关注原因 `finished`）。
- 新建 worktree 工作区：由宿主创建 worktree，会话在其中运行；工作区提供查看改动、合并、归档并清理 worktree 的入口。
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
4. **会话树**：可视化 pi 的分支会话，支持分叉、对比，插件状态跟随分支切换。领域模型已按树建模（SessionLog），不用重来。

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
- 空闲进程回收、文件区、forge（PR）状态
