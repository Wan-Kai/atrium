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

**2026-10-14：M1.12 文件与更改完成，三方审查（Astra、Grok、Claude）后已合并回 `main`（M1.11 自用的改动一起合并）。右栏换成"文件""更改"两个标签（默认宽 320px），旧的改动面板删掉；查看标签（文件、改动）进标签栏、和会话一起数 ⌘1–9、⌘W 关；diff 和文件内容在 worker 里用 Shiki 上色；`list_dir`、`read_file` 和 material-icon-theme 的图标先前已提交。长内容按 64 行一组、`content-visibility: auto`，2 万行的 diff 折叠左栏、滚动每段 ≤ 4 毫秒，切换到改动标签约 60 毫秒（testing.md "性能预算"新加了切换和滚动两项）；改动标签离开时停掉文件头的闪动，否则动画留着整个标签不回收（泄漏测试查出来的）。三方审查的问题都修了：宿主一边，归档的会话不再起 pi，对话、工作区归档途中不起 pi、不新建会话，恢复工作区时放回这次归档记下的会话；压缩、分叉途中算忙；新建 worktree 的起点只收完整的 ref。界面一边，右栏有提交领先基线时也默认"更改"、打开着的面板守住默认；文件树只读展开且看得见的目录、先发的读不盖后读的；查看标签的滚动和换行按标签记，关掉就忘；从搜索、收件箱、"历史"点会话（哪怕是当前的）会把它显示出来；`/compact` 带上长粘贴和 `@` 文件，内置命令的失败只在发出它的会话里说；新建工作区发完整的 ref、界面显示短名，分支列表回来前不让发送；拖右栏只在松手时写存储；UI 只经 `@atrium/client` 拿协议的值（oxlint 守住）。单元、宿主、界面测试、相关端到端和 `pnpm check` 通过；变异分数 git 100%、host 99.98%、ui 99.47%。下一步回到 [M1.11](#m111-自用) 的自用。**

**2026-10-13：新建 M1.12 文件与更改，在 `m1.12-files-changes` 分支上（从 `m1.11-self-use` 分出，M1.11 的自用照常继续）。右栏照 Paseo 改成"文件""更改"两个标签，只放树；点文件在对话区的标签页里看内容或 diff。设计已定（原型 `files-changes-prototype.html` 的 A 版），先改 SPEC-0001、design-language、domain-model，再写代码。**

**2026-10-12：M1.11 自用进行中，到目前为止的改动经三方审查（Astra、Grok、Claude）后先合并回 `main`，里程碑没有结束（一周自用、新账户的首次启动检查还没做），之后继续在 `m1.11-self-use` 分支上。这一段做的：每个对话是一个独立的容器（[ADR-0007](adr/0007-each-chat-is-its-own-container.md)，索引升到 v2）；Fast 开关，哪些模型支持以 Codex 的模型列表为准、列表为空或查不到时按内置规则（[ADR-0008](adr/0008-atrium-own-pi-extension-for-fast.md)）；过程轨道，运行结束后折进轮的标题；发送的消息显示图片缩略图，宿主从 pi 的会话文件读回；worktree 工作区的归档与恢复（删目录、留分支，恢复前查分支还在、目录没被占用）；浏览器不内置，留在外部（[ADR-0009](adr/0009-browser-stays-external.md)）；另有图标换成 Hugeicons、回复排版、文件类型标志等界面调整。三方审查的问题都修了：归档停掉会话后再查一次、先记下归档再删目录、git 期限 10 分钟、退出时等归档做完；关标签丢草稿时与发消息和别的窗口打开的竞争；`fetch_image` 等条目读完；Fast 切换中途来了别的事件仍按宿主最后的结果。单元、宿主、界面、pi 测试和 `pnpm check` 通过，git、host、shared、pi 四组变异分数 100%；界面组这次没有重跑。**

**2026-10-11：M1.11 自用开始，在 `m1.11-self-use` 分支上。先补了自用要用的工具：Electron 主进程每分钟把各进程的内存和 CPU 交给宿主写进日志（原来只写在 testing.md 里，没有实现），`pnpm usage` 按宿主的每次运行汇总每小时的用量、标出最低值上涨的项；`pnpm package` 打包成本机用的 Atrium.app（只做 ad-hoc 签名，不公证），从程序坞打开，也用它做新账户的首次启动检查。定了标志：一只猫，用作应用图标和欢迎页的 logo。补了发送后的等待动画；新建会话改为先打开标签、pi 在后台启动，省掉第一条消息等 pi 启动的时间。设置里加了网络代理，交给 pi、安装和宿主自己的请求（原先宿主查最新版本不走代理）。记录在 [self-use.md](research/self-use.md)。**

**2026-10-11：M1.10 首次启动与设置完成，三方审查后已合并回 `main`。完成标准第一条“在一个没装 pi 的账户上走通”还没手动验证（自动化测试用的都是装好的 pi），挪到 M1.11 自用时做（2026-10-11 定）。登录经用户自己装的 pi：宿主用系统 Node 运行登录程序加载 pi 的包，pi 说的和问的广播给所有窗口，凭据只由 pi 读写（宿主不读 `auth.json`）；`check_setup` 报告 pi、Node、Homebrew、fd、登录和项目数；宿主装 pi（官方脚本）、用 Homebrew 装 Node、`pi update`（等运行中的会话结束，更新后停掉空闲会话的旧 pi），输出广播、不进日志；每天查一次 pi.dev 的最新版本；从 pi 历史发现项目；首次启动四屏（欢迎页、装 pi、登录、添加项目）和设置面板（外观与关于、模型与账户、项目的主干分支、pi）。三方审查（Astra、Grok、Claude）的 14 项都修了：凭据变化的 `credentials_changed` 事件，登录与退出排队，后连上的窗口补上最后一次登录和安装，pi 的文字截到 16 KiB，重新读登录 shell 后旧凭据照样脱敏，Homebrew 不在 PATH 时加到末尾，更新后停空闲会话时等启动中的 pi、跳过等回答的，已在项目里的目录算加好，模型目录关闭时等所有查询。端到端 32 个、泄漏与性能 5 个通过；五组变异分数都是 100%。已知问题：交给终端的端到端约 1/280 次接回后 pi 启动等了 30 秒，疑似上一次启动的 pi 留下 `auth.json` 的锁（pi 的锁 30 秒过期），未证实。下一步是 [M1.11](#m111-自用)。**

| 已完成 | 产出 |
|---|---|
| 产品定位与范围 | [README](../README.md)、[ADR-0001～0004](adr/) |
| 架构 | [ADR-0005](adr/0005-split-host-and-ui-pwa-first.md)（宿主与 UI 分离）、[ADR-0006](adr/0006-organize-sessions-by-workspace.md)（按工作区组织会话）、[架构总览](architecture/overview.md) |
| MVP 1 需求与方案 | [SPEC-0001](specs/0001-mvp1-single-session-chat.md)：侧栏、对话区、首次启动三块已定稿 |
| 领域模型 | [domain-model.md](architecture/domain-model.md) 第 3 版：经 Grok 4.7、GPT-6-Astra 两轮评审，并对照 Paseo 与 pi 源码 |
| 视觉规范 | [design-language.md](architecture/design-language.md) |
| 界面原型 | `prototype/ui` 分支（见下文"原型"） |
| M1.1 骨架 | monorepo 七个包、Electron 启动宿主、token 与 Origin 鉴权、日志与链路追踪、空白界面跟随系统外观；七层测试各有示例并验证过会失败；变异分数 100%（等价变异在代码里注明理由）。实现中改动的决定已写回 testing.md、coding-standards.md、observability.md、development.md：界面泄漏改用自写的脱离 DOM 分析、Stryker 改用命令运行器、Vitest 5 的基准 API、开发端口 5791 |
| M1.2 最窄链路 | `packages/pi`：PiProcess（LF 分帧、按 id 对应响应、按命令设期限、停止时清理整棵进程树，真实 pi 启停 200 次无泄漏）、找 pi 与版本检查、交给 pi 的环境去掉相对 `PATH` 和 Atrium/Electron 变量；宿主读取登录 shell 的完整环境、`pi.process`/`pi.rpc` span、环境里的凭据不进日志；`pnpm pi:try`；faux 模型、12 个 pi 契约场景与夹具（录制时归一化，回放替身与 PiProcess 语义一致）。决定写回 testing.md、security.md、overview.md、domain-model.md（决定 9） |
| M1.3 协议、客户端与流式显示 | `protocol`：信封、每条命令一条应答与错误码、握手与心跳、会话事件（`epoch + seq`、运行的 trace）与快照；宿主：命令分发与 `command <type>` span、心跳、背压、订阅表、pi 事件翻译、SessionController（运行、乐观消息对应、pi 拒绝的错误码）、新建对话；客户端：`createAtriumClient`（重连、心跳、宿主重启、每个会话的 SessionView）；界面：Streamdown 渲染、平滑揭示、滚动跟随、用户气泡与"进行中"、输入框、界面问题上报。决定写回 SPEC-0001"协议细节"、security.md（https 图片）、testing.md、observability.md、pi-internals.md |
| M1.4 对话记录与过程 | `pi`：条目映射为 LogEntry、按块位置的事件翻译、只读扫描会话目录；`protocol`：轮、步骤、提示条与轮级事件、`fetch_transcript`、`fetch_step`、`list_recent_sessions`、`open_session`；宿主：SessionLog 与 TranscriptProjection（实时与重建共用 TurnDraft，当场数据按轮记录并在重建时合并回去）、运行后重读条目、重建不一致时换 epoch、大内容按预览发送；客户端：按轮的 SessionView、分页与取回完整步骤；界面：过程折叠行、步骤与详情、diff、显示模式、改动汇总、提问导航条、长消息折叠、导出、最近会话。决定写回 SPEC-0001"对话记录"（插话的记录、重试与溢出、大内容、提示条位置）、domain-model §2、pi-internals、testing.md；TTFT、输出速度挪到状态栏（M1.8） |
| M1.5 项目、工作区与会话 | `protocol`：索引快照与列表命令、`prj_`/`wks_` id、新错误码；宿主：索引文件（原子写入、版本迁移、损坏恢复）、宿主锁（按进程启动时间判断存活、接管锁）、ProjectService、WorkspaceService（worktree 扫描、后台 fetch、聚焦后重算）、MergeInspector（`merge-tree` 模拟合并、按 worktree 缓存）、SessionCatalog（增量读会话目录、去重、草稿）、布局与偏好、按客户端顺序生效的标签命令、IndexFeed；`pi`：会话目录的位置与增量扫描；客户端：IndexView 与乐观更新；界面：侧栏、搜索、标签栏、"历史"、对话、改名与归档、外观切换、快捷键；桌面端：`atrium://` 协议、单实例。决定写回 SPEC-0001"项目、工作区与会话"、domain-model §1"索引的存储"与"已决定 10～15"、security.md、overview.md、testing.md（测试里的 git 带 `GIT_CEILING_DIRECTORIES`）、observability.md；收件箱挪到 M1.9 |
| M1.6 运行控制 | `protocol`：控制状态（排队、暂停原因、插话、停止中、重启中、对话框、失败）、`control_updated`、`prompt_handled`、九条运行控制命令、对话框结果和重启提示、`SessionSummary.failed`；`pi`：压缩、插话队列、对话框与通知、重试上限的事件翻译，pi 1.1.0 夹具；宿主：SessionController 的排队、插话、停止、对话框、崩溃重启与续做、"重试"，会话管理器的重启单飞、`resume_queue` 启动 pi，宿主提示在重建后保持位置和顺序；界面：胶囊条与排队面板、对话框卡片与倒计时、错误卡片、停止中的输入框、出错状态图标；测试：控制器定时器泄漏测试，变异测试的超时余量与重测办法。决定写回 SPEC-0001"运行控制"、domain-model 已决定 6、security.md（通知截断后写日志）、testing.md |
| M1.7 模型与输入框 | `protocol`：`list_models`、`set_model`、`set_thinking_level`、`model_updated`、`upload_attachment`、`search_files`、`list_commands`，带图片的 `prompt` 与 `steer`，工作区改动的 `watch_changes`、`watch_diff`、`changes_updated`、`diff_updated`；`pi`：按目录查询模型与命令、`fd` 的位置；宿主：模型列表缓存与上次的模型、附件存储（按连接限额、30 分钟过期）、`fd` 文件搜索、插话按队列增减计数并逐条发送、工作区改动（一次 git 运行读出状态、行数和补丁，文件监听与轮询）；客户端：模型、附件、文件搜索、工作区改动；界面：模型按钮与推理强度框、图片附件、`@` 与 `/` 菜单、长文本粘贴、拖入、↑ 历史、草稿、改动胶囊与右侧抽屉；测试：变异测试分组并重测存活的变异、git 场景模板。决定写回 SPEC-0001"模型与输入框""工作区改动""运行控制"、testing.md、pi-internals.md |
| M1.8 状态栏 | `protocol`：会话指标（允许未知）、快照的 `metrics`、`metrics_updated`、偏好的 `statusBar`；`pi`：条目里的四种 token 和推理 token、系统消息与压缩检查点的大小、系统提示词与工具定义的回放和估算、`get_session_stats` 的映射、`request_started` / `output_started` 事件，统计的契约夹具；宿主：每个会话的指标跟踪（读统计的时机、一次只读一次、按 `turn_start` 计时、从条目算推理与分段），偏好的 `statusBar`；客户端：会话视图的指标；界面：状态栏、悬停卡片、调节面板。决定写回 SPEC-0001"状态栏（M1.8）"、domain-model §3、pi-internals §2、design-language（上下文分段颜色）、testing.md（每次重测存活变异、Stryker 注释的位置） |
| M1.9 并行、同步与关注 | `protocol`：`index_changes`、`subscribe_index` 的游标、快照的原因，`SessionSummary` 的 `attention`、`asking`、`handedOff`，`clear_attention`、`hand_off`、`take_back` 与 `session_handed_off`；`pi`：OneShotPi（`-p` 模式、内容走标准输入、期限与中止时停掉进程树）；宿主：IndexFeed（逐项比较、合批、按客户端的布局、应答前先发）、关注状态与等待回答的时间、交给终端、TitleGenerator、草稿在第一轮时重扫、会话订阅计数、归档时丢掉 Controller、停止的等待不留在 pi 的退出上；客户端：IndexView 按变化应用、布局命令在途时保留选择；界面：状态图标与优先级、收件箱、清除关注、交接面板、宿主重启后重新打开；测试：并行、收件箱、交接、标题的端到端，会话的泄漏测试（宿主与界面），会话浸泡测试。决定写回 SPEC-0001"并行、同步与关注"（含先读到自己的写）、domain-model（归档丢掉 Controller）、pi-internals（一次性调用）、coding-standards（不拿长期 Promise 做 race）、testing.md（会话浸泡的采样） |
| M1.10 首次启动与设置 | `protocol`：`check_setup`、`login` / `answer_login` / `cancel_login` / `logout`、`install_pi` / `install_node` / `update_pi` / `cancel_install`、`check_pi_update`、`discover_projects`、`list_branches` / `set_main_branch`，`login_updated`、`install_updated`、`install_output`、`pi_latest`、`credentials_changed`，偏好的 `setupDone`、`titleModel`；`pi`：登录程序（系统 Node 加载用户装的 pi 的包）、找 Node、从会话文件头统计工作目录；宿主：SetupService、LoginService（排队、截断 pi 的文字、补给后连上的窗口）、InstallService（官方脚本、Homebrew、`pi update`，等会话结束、更新后停空闲会话的 pi）、pi 最新版本检查、项目发现、主干分支、标题模型；客户端：首次启动、登录、安装状态；界面：欢迎页与点阵按钮、首次启动三步、设置面板（外观与关于、模型与账户、项目、pi）。决定写回 SPEC-0001"首次启动""设置"、security.md（登录程序的例外、脱敏只增不减）、pi-internals（登录、`listAll`） |
| 工程约束 | 根目录 [AGENTS.md](../AGENTS.md)、[代码结构](architecture/overview.md#代码结构)、[编码规范](architecture/coding-standards.md)、[测试](architecture/testing.md)、[安全](architecture/security.md)、[日志与链路追踪](architecture/observability.md)、[开发环境与流程](development.md) |
| 源码调研 | [pi-internals.md](research/pi-internals.md)、[paseo-architecture.md](research/paseo-architecture.md)、[pi-extension-capabilities.md](research/pi-extension-capabilities.md) |

MVP 1 里还没设计、做到时先补设计的：

- 工作区、新会话、新对话的空状态（先用占位）。

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
| 命令和事件 | [SPEC-0001 · 接口与数据](specs/0001-mvp1-single-session-chat.md#接口与数据)，准绳是 `packages/protocol` 的 zod 定义 |
| pi 的会话格式、RPC、事件、队列、重试、认证 | [pi-internals.md](research/pi-internals.md) |
| 同类宿主怎么做、哪些坑已经被踩过 | [paseo-architecture.md](research/paseo-architecture.md) |
| extension 能做什么（MVP 2） | [pi-extension-capabilities.md](research/pi-extension-capabilities.md) |
| 前端用什么库、流式回复怎么渲染 | 本文"已定的关键决策"里的"前端技术栈"、[SPEC-0001 · 对话区](specs/0001-mvp1-single-session-chat.md#对话区)的"回复渲染"、[M1.3](#m13-协议客户端与流式显示-) |
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
- Atrium 不内置浏览器：agent 的浏览器操作在外部浏览器（默认 ego lite）里做，定制功能做成自己的浏览器插件（[ADR-0009](adr/0009-browser-stays-external.md)）。

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

- 视觉对齐 DeepSeek Harness，动效对齐 Apple 弹簧；图标 Hugeicons（2026-10-12 由 Phosphor 换成）；点阵是贯穿的视觉语言。
- 前端技术栈：
  - 框架与样式：React + Vite；Tailwind + shadcn/ui。design-language 的颜色、圆角映射到 shadcn 的 CSS 变量（Streamdown 也读这套变量）。
  - 图标：Hugeicons 免费版 stroke-rounded（`@hugeicons/core-free-icons` + `@hugeicons/react`，经 `packages/ui/src/design/icons.tsx` 取用；2026-10-12 由 Phosphor 换成）。动效不引入动画库，用 CSS `linear()` 弹簧曲线和少量手写弹簧（参数见 design-language "动效"）。
  - **流式回复渲染：Vercel 的 [Streamdown](https://github.com/vercel/streamdown)**（`streamdown`，调研时 2.7.0），插件 `@streamdown/code`（Shiki 高亮）、`@streamdown/math`（KaTeX）、`@streamdown/mermaid`、`@streamdown/cjk`。它负责补全没写完的语法、按块缓存；选型理由和对比见 [SPEC-0001 · 对话区](specs/0001-mvp1-single-session-chat.md#对话区)的"回复渲染"。
  - 流式节奏：宿主原样转发增量，客户端按积压量平滑揭示（约 150ms 追平，参考 Paseo 的 `text-reveal.ts`），再交给 Streamdown。
- 会话可在后台运行，多个同时跑；MVP 1 不做审批，不显示审批相关标签。

### 原型

- 位置：`prototype/ui` 分支的 `prototypes/` 目录（用完即弃，不进 `main`）。
- 定稿稿：
  - `app-prototype.html`：完整主界面（侧栏、标签栏、消息流、过程、输入框、模型与推理强度、状态栏）。
  - `onboarding-prototype.html`：首次启动（欢迎页、安装 pi、登录、添加项目）。
  - `files-changes-prototype.html`：M1.12 的右栏"文件""更改"和查看标签（定的是 A 版）。
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

目标：日常编码从 Codex 换到 Atrium。模型沿用 ChatGPT 订阅。浏览器操作不单独开发：用外部浏览器 ego lite，pi 按它的 skill 调 `ego-browser` 命令；或在 pi 的 `mcp.json` 里配置 chrome-devtools 或 Playwright 的 MCP server，从 MVP 1 起即可使用（[ADR-0009](adr/0009-browser-stays-external.md)）。

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

##### M1.2 最窄链路：宿主驱动 pi ✅

- **目标**：宿主启动 `pi --mode rpc`，发一条 prompt，在终端里打出流式文本，直到 `agent_settled`。
- **范围**：
  - ✅ 先验证 faux 模型：测试 extension 用 `pi.registerProvider()` 注册 pi-ai 的 `fauxProvider()`，在真实 RPC 进程里按脚本回复。已验证通过，实现在 `packages/testkit/src/faux/`（见 [testing.md · faux 模型](architecture/testing.md#faux-模型)）。
  - ✅ 第 3 层 pi 契约测试：逐条验证 pi-internals 里依赖的行为，并由它录制第 1 层的夹具（12 个场景，见 [testing.md · pi 夹具](architecture/testing.md#pi-夹具2026-10-05-定)；`pnpm fixtures:record` 重录）。
  - PiAdapter（自己实现，✅ `pi-process.ts`、`jsonl.ts`、`kill-tree.ts` 三个文件，去掉注释约 450 行）：直接启动 `pi --mode rpc`；严格按 LF 分帧（语义照搬 pi 的 `src/modes/rpc/jsonl.ts`，MIT，不用 `readline`；✅ 已实现于 `packages/pi/src/process/jsonl.ts`，改成每块只扫一次，16 MiB 的单行比 pi 的写法快约 60 倍）；按 `id` 对应乱序响应；按命令设超时（`compact` 不限时）；能发 `extension_ui_response`；stderr 只在内存留最近一段；退出时先关 stdin、再 SIGTERM，都不退才 SIGKILL：SIGKILL 前先按父进程关系找出 pi 的所有后代，连同它们各自的进程组一起杀，这一步失败时退而只杀 pi（pi 的 bash 工具子进程有自己的进程组，只杀 pi 的进程组会漏，见 [pi-internals](research/pi-internals.md) §3"退出"）；退出转成事件。类型用 `import type` 从固定版本的 `@earendil-works/pi-coding-agent` 取（开发依赖，不打进应用）。
  - ✅ 找到 pi：宿主启动后在后台读取登录 shell 的完整环境（从访达启动的 Electron 拿不到 shell 的 `PATH`、API Key、代理等），再在它的 `PATH` 上查找 pi（`packages/host/src/platform/login-shell.ts`、`packages/pi/src/locate/inspect.ts`）。node、npm、brew 的查找留到 M1.10 首次启动时做。
  - ✅ 版本检查：结果分为找不到、不能运行（带 pi 自己的报错）、版本过低、可用四种；提示升级的界面在 M1.10。最低版本先定为调研时的 1.0.1，pi-internals 里的结论都基于这个版本。
  - ✅ pi 的 stderr 按行记进日志（挂在 `pi.process` span 下），错误卡片"展开看原始报错"要用到；RPC 请求 id 由 span id 生成（`<span id>-<序号>`）。宿主侧的组装在 `platform/pi-deps.ts`（`PiDeps` 的实现）和 `sessions/traced-pi.ts`（`pi.process`、`pi.rpc` span）。
  - ✅ 目标里的"在终端里打出流式文本"：`pnpm pi:try "<提示词>"`（`packages/host/src/dev/try-pi.ts`）。
- **参考**：[SPEC-0001 · 首次启动](specs/0001-mvp1-single-session-chat.md#首次启动)的"第 1 步"（`PATH`）、[SPEC-0001 · 风险与待定问题](specs/0001-mvp1-single-session-chat.md#风险与待定问题)（版本兼容）、[pi-internals](research/pi-internals.md) §3 RPC 协议、pi 的 `packages/coding-agent/docs/rpc.md`、pi 的 `src/modes/rpc/rpc-client.ts`（只作对照，不直接用）、Paseo 的 `packages/server/src/server/agent/providers/jsonl-rpc-process.ts`。
- **完成标准**：适配器测试用录制的夹具跑通；分帧的属性测试通过；pi 契约测试全部通过；真实 pi 能完整跑完一轮；启动和停止 pi 200 次后没有残留进程、监听数回到基线；分帧吞吐有了基准基线。

##### M1.3 协议、客户端与流式显示 ✅

- **目标**：在 UI 里发消息，看到流式回复和推理过程。
- **范围**：
  - ✅ `protocol`：用 zod 定义 SPEC-0001 的命令和事件（先做本里程碑用到的），每条会话命令带 `sessionId + requestId + traceparent`，事件带 `epoch + seq` 和所属运行的 trace id。
  - ✅ 开工前先补齐协议细节，写进 SPEC-0001"接口与数据"（2026-10-04 架构审查后补全清单；2026-10-07 定稿，见 [SPEC-0001 · 协议细节](specs/0001-mvp1-single-session-chat.md#协议细节2026-10-07-定)；附件选了"客户端压缩 + 逐张上传"）：
    - 信封：所有命令都带 `requestId` 和 `traceparent`，会话命令再带 `sessionId`；放在 `protocol/src/envelope.ts`，客户端消息、宿主消息各是一个可辨识联合。
    - 应答：每条命令恰好一条应答，`{ ok: true, result? }` 或 `{ ok: false, error: { code, params? } }`，错误码是 protocol 里的枚举；未知或无效的消息也回带错误码的应答（届时把现在用日志"message ignored"计数的限流测试改成断言应答）。
    - 握手：welcome 带宿主实例 id（即列表同步的 generation），客户端重连时据此判断宿主是否重启过；心跳。
    - 事件：会话事件带 `sessionId + epoch + seq` 和所属运行的 trace id；列表事件带 `collection + generation + seq`。
    - 追踪：每条命令以自己的 `traceparent` 作父 span，再用 span link 指向连接的 trace，不挂在连接的长 trace 下面。
    - 附件：图片 base64 后通常超过单条 1 MiB 的上限，在单独上传、客户端先压缩、为附件放宽上限三者中定一个。
    - 订阅：SubscriptionRegistry 放 `sync/`（domain-model §6、§7）。
    - 发送端背压：发送前看 `bufferedAmount`，慢客户端不能让宿主内存无限增长。
    - 界面的错误和性能问题经一条上报消息回传宿主日志。
    - 重写已被取代的 `event-model.md`，或改为从 zod 定义生成。（定为改写成指向说明，不另列清单。）
  - ✅ 宿主侧：`server/connection.ts`（Connection：socket、clientId、send）和 `server/router.ts`（按 domain-model §8 的表分发命令，每条命令一个 `command <type>` span）从现在的 `ws-server.ts` 拆出来。
  - ✅ 客户端：`createAtriumClient` 作为唯一对外入口（clientId、connect、send、重连，拥有各个 store）；现在的 connection 降为内部模块，`buildHello`、`SocketLike` 不再导出。
  - ✅ `client`：WebSocket 连接、断线重连（本里程碑做了每个会话的 SessionView；列表和布局的 store 随 M1.5、M1.9）；状态用 Zustand vanilla store，按领域拆成列表、每个会话一个 SessionView（订阅时创建、退订时释放）、布局；流式增量只复制当前那条消息；对外只暴露 store 和命令方法。
  - ✅ SessionController + SessionRuntime 的最小形态：提交、流式事件翻译、`run_started / run_settled`。
  - ✅ UI：用户气泡、回复和推理过程、"进行中 · 12s"；滚动跟随（停在底部时跟随，往上翻停止跟随，出现"↓ 回到底部"）。
  - ✅ 流式渲染（选型见上文"前端技术栈"）：
    - 安装 `streamdown`、`@streamdown/code`、`@streamdown/math`、`@streamdown/mermaid`、`@streamdown/cjk`；引入 `streamdown/styles.css` 和 `katex/dist/katex.min.css`。
    - Tailwind 的 CSS 里为 `streamdown` 和每个已装插件加 `@source` 指向其 `dist/*.js`；monorepo 里依赖被提升到根目录 `node_modules`，路径按 CSS 文件位置数 `../`。
    - 用法：`<Streamdown plugins={{ code, math, mermaid, cjk }} isAnimating={正在流式}>{已揭示的文本}</Streamdown>`。回复和推理过程都用它渲染。
    - 平滑揭示放在 `client` 或 UI 的一个 hook 里：按积压量调节速度，约 150ms 追平；复制、选择、滚动都以完整文本为准。先不开 Streamdown 自带的 `animated`，避免和平滑揭示叠加。
    - 按 SPEC-0001"回复渲染"的范围配置：数学只认 `$$…$$` 和 `\(…\)`；KaTeX、Mermaid 第一次遇到时才加载；Shiki 主题跟随浅色 / 深色；用 `components` 覆盖 `a`（系统浏览器打开）和 `img`（`https` 远程图片直接显示，`http` 图片显示成链接；CSP 的 `img-src` 加上 `https:`，2026-10-07 定）；原始 HTML 不执行，按文本显示。
- **参考**：[domain-model](architecture/domain-model.md) §3 会话运行、§7 客户端与一致性、§8 协议与类的对应、[SPEC-0001 · 接口与数据、回复渲染](specs/0001-mvp1-single-session-chat.md#接口与数据)、[SPEC-0001 · 对话区](specs/0001-mvp1-single-session-chat.md#对话区)的"回复渲染"、[design-language](architecture/design-language.md) 的"动效""消息流"、[Streamdown 文档](https://streamdown.ai/docs)（含各插件的 `@source` 写法）、原型 `app-prototype.html`、Paseo 的 `packages/app/src/agent-stream/text-reveal.ts`。
- **完成标准**：`protocol` 的 schema 测试通过；一轮对话在 UI 里完整显示；准备一份覆盖"回复渲染"全部范围的 Markdown（表格、嵌套列表、代码块与 diff、中文加粗紧挨标点、块公式与行内公式、Mermaid、链接、远程图片、原始 HTML），按真实节奏分片流式输出，过程中不闪烁、不错乱，结束后与一次性渲染结果一致；50 tok/s 流式输出长 Markdown 期间满足性能预算（没有超过 50 毫秒的长任务，帧时间 p95 ≤ 16.7 毫秒）。

##### M1.4 对话记录与过程 ✅

- **目标**：历史会话能完整恢复，过程（工具、diff、推理）按规格显示。
- **范围**：
  - pi 包的 HistoryMapper 把 pi 条目转成 LogEntry；SessionLog：`get_entries(since)` + `leafId`，按条目树沿当前分支重建 TranscriptProjection（轮、步骤、系统事件）。
  - 过程折叠行、单行步骤列表、详情块；`bash` / `read` / `edit` / `write` / 其他工具；diff；显示模式（摘要 / 思考 / 详细，Ctrl+O）。
  - 每轮改动汇总（"已观测到的工具修改"口径）、回复下方信息行、提问导航条。
  - 用户消息超过约 12 行折叠；复制消息和回复（需求 14）；回复"···"里的"复制为 Markdown"、整个会话"导出为 Markdown"。
  - 打开会话先取最近 20 轮（订阅时的快照带上），翻到顶再按游标加载更早的（`fetch_transcript` 的 `before`）。协议见 [SPEC-0001 · 对话记录](specs/0001-mvp1-single-session-chat.md#对话记录m142026-10-08-定)。
  - 临时的"最近会话"列表（2026-10-08 定）：没有打开会话时列出 pi 会话目录里最近的会话，点一下打开；用到 M1.5 的 SessionFiles 的只读扫描，M1.5 的侧栏和"历史"做好后替换。
  - 历史会话的每轮用时由时间戳推算。（TTFT、输出速度只在状态栏显示，2026-10-08 定挪到 M1.6，和状态栏一起做；2026-10-09 状态栏单独成为 M1.8。）
  - 显示模式菜单和会话"···"（导出为 Markdown）的位置在 M1.5 的标签栏右端；M1.4 先放在对话区顶部右侧，标签栏做好后挪过去。
- **参考**：[pi-internals](research/pi-internals.md) §1 会话文件、§3 RPC 协议、[domain-model](architecture/domain-model.md) §2 会话历史、[SPEC-0001 · 对话区](specs/0001-mvp1-single-session-chat.md#对话区)、Paseo 的 `packages/server/src/server/agent/providers/pi/history-mapper.ts`、`tool-call-mapper.ts`（Paseo 用 `get_messages`，只借鉴映射，不照搬重建方式）。
- **完成标准**：用一个带压缩、带分叉的真实会话文件恢复，显示的历史与终端 pi 一致，压缩前的内容不丢；打开 1000 轮的会话到首屏满足预算；2000 轮重建有基准基线。

##### M1.5 项目、工作区与会话 ✅

- **目标**：侧栏按"项目 → 工作区"组织，标签页切换会话，能恢复历史会话和草稿。
- **范围**：
  - ✅ 开工前先定 `~/.atrium/` 的文件布局、格式版本与迁移、文件损坏时的恢复，写进领域模型；宿主单实例（第二次打开应用时聚焦已有窗口，避免两个宿主同时写索引）。2026-10-08 定，见 [domain-model §1 · 索引的存储](architecture/domain-model.md#索引的存储2026-10-08-定) 和"已决定 10～12"：按领域拆文件，损坏时挪开重来并提示；列表在 M1.5 每次推整份快照，增量留给 M1.9；终端里开的会话在窗口聚焦、运行结束时重扫发现。
  - IndexStore（`~/.atrium/`，原子写入）、ProjectService、WorkspaceService（`git worktree list`、分支、创建时间）、MergeInspector（未提交、↑N、无改动、已合并、已移除、无法判断）。
  - pi 包的 SessionFiles 扫描会话目录、解析文件头；宿主的 SessionCatalog 按 id 去重、报告冲突，按记录的容器或 `cwd` 归类；草稿会话；新建对话时立刻启动 pi，不等第一条消息（[领域模型 · 已决定 9](architecture/domain-model.md#已决定)）。
  - WorkspaceService 的后台 `git fetch`（窗口聚焦时、每隔几分钟）和聚焦后重算；git 低于 2.38 时只提示合并状态不可用。
  - 侧栏、搜索、标签栏、"历史"、对话（M1.11 起每个对话一个容器，ADR-0007）、命名与改名、归档、复制会话文件路径；侧栏底部的外观切换（跟随系统 / 浅色 / 深色）；空状态占位。收件箱挪到 M1.9（2026-10-08 定）。协议见 [SPEC-0001 · 项目、工作区与会话](specs/0001-mvp1-single-session-chat.md#项目工作区与会话m152026-10-08-定)。
  - 插话记录存进 `~/.atrium/turns/`（SPEC-0001"对话记录"），宿主重启后仍在。
  - 快捷键：⌘N 新建对话，⌘T 新建会话，⌘W 关闭标签，⌘1–9、⌘⇧[ / ⌘⇧] 切换标签。
- **参考**：[ADR-0006](adr/0006-organize-sessions-by-workspace.md)、[domain-model](architecture/domain-model.md) §1 项目、工作区、会话，§6 宿主的组件、[SPEC-0001 · 侧栏](specs/0001-mvp1-single-session-chat.md#侧栏)、[paseo-architecture](research/paseo-architecture.md) §1 数据与持久化、§6 git 状态。
- **完成标准**：添加几个真实项目（含 worktree、非 git 目录）后，侧栏信息和 `git` / pi 的实际情况一致；在终端里开的 pi 会话自动出现在对应工作区。

##### M1.6 运行控制 ✅

- **目标**：运行中能排队、插话、停止；出错能自动恢复；extension 的对话框能在 Atrium 里回答。
- **范围**（2026-10-09 把原来的 M1.6 拆成三个：运行控制、模型与输入框、状态栏，后面的里程碑顺延）：
  - 排队、插话、停止（2 秒确认与锁定；pi 一直不确认停下就一直等，2026-10-09 定）、压缩期间暂停出队、`handled` 处理、`queue_update` 确认插话送达。
  - 胶囊条里的"排队 N"（排队面板：编辑、删除、改为插话，停止后"继续发送"）和"N 条插话将在下一步前送达"。
  - 快捷键：回车发送 / 排队，⌘+回车插话，Esc 停止；中文输入法组字时回车不发送。
  - 对话框（PendingInteraction）：选择、确认、输入、编辑器四种卡片，带超时的显示倒计时，多个客户端同时回答只接受第一个。
  - 失败重试交给 pi（次数按 pi 的设置，界面显示"第 N / M 次"）与进程崩溃自动重启（3 次；重启计数在一次运行没有失败地结束后归零，2026-10-09 定）、"正在重试"和"进程已自动重启"提示、错误卡片与"重试"。
  - 出错状态在标签和侧栏一直显示到下一次运行开始；写进索引的关注状态和收件箱在 M1.9。
- **参考**：[domain-model](architecture/domain-model.md) §3 会话运行、[SPEC-0001 · 对话区](specs/0001-mvp1-single-session-chat.md#对话区)的"运行中输入""运行出错与停止"和[关键流程](specs/0001-mvp1-single-session-chat.md#关键流程)、[pi-internals](research/pi-internals.md) §2 运行时、§5 extension、[paseo-architecture](research/paseo-architecture.md) §2 生命周期（中断与锁定）、原型 `app-prototype.html`。
- **完成标准**：对照 SPEC-0001 需求 5、6、10 逐条验证；人为杀掉 pi 进程能自动恢复。

##### M1.7 模型与输入框 ✅

- **目标**：在输入框旁切换模型和推理强度；输入框里能贴图、引用文件、用命令。
- **范围**：
  - 模型与推理强度（PiCatalog，档位按模型）、点阵模型按钮与推理强度框；新会话默认用上一次的模型；⌘⇧I 模型菜单，⌘⇧E 推理强度菜单。
  - 输入框：图片附件（`upload_attachment`；当前模型不支持图片时提示）、`@` 引用文件（发送时只放路径，由 agent 自己读，2026-10-09 定）、`/` 命令、长文本粘贴、拖入、展开、↑ 历史、草稿、胶囊条里的工作区改动（2026-10-10 改为照抄 Paseo：工作区的 git 改动和右侧改动面板，取代"本会话改动"）。
  - 有余力再做（SPEC-0001 标为可选）：⌘F 会话内搜索、选中回复文字后"引用"。
  - 开工前已定（2026-10-10，见 SPEC-0001"模型与输入框"）：模型列表照 Paseo，按目录短启 pi 查询、缓存到点"刷新"；还没启动 pi 的会话输入 `/` 时启动它；↑ 历史取本会话的对话记录，草稿按会话存 localStorage；`@` 候选和 pi 的终端界面一样用 `fd`。
- **参考**：[domain-model](architecture/domain-model.md) §5 模型与设置、[SPEC-0001 · 对话区](specs/0001-mvp1-single-session-chat.md#对话区)的"输入框"、关键流程的"图片"、[协议细节](specs/0001-mvp1-single-session-chat.md#协议细节2026-10-07-定)的"附件"、[pi-internals](research/pi-internals.md) §4 模型与认证、原型 `app-prototype.html` 的 `effortBox`、`chipDots`。
- **完成标准**：对照 SPEC-0001 需求 3、7 逐条验证。

##### M1.8 状态栏 ✅

- **目标**：输入框下方随时看到上下文用量、缓存命中率、token 用量、输出速度，并能选择显示哪些。
- **范围**：
  - 状态栏注册表与四个分组（会话统计、Token 用量、上下文、费用）、悬停详情卡片、自定义入口（全局保存）。
  - `get_session_stats`、`metrics_updated`；上下文分段估算（系统提示词、工具定义、对话消息）。
  - 首 token 时间、输出速度、模型用时由宿主当场测得，宿主重启后显示"—"。
  - 开工前已定（2026-10-10，见 SPEC-0001"状态栏（M1.8）"）：轮、步照 pi 的统计按整个会话文件数（插话也算一轮）；pi 没有"请求已发出"的事件，首 token 时间从 `turn_start` 算起；推理 token、当前分支用量和上下文分段由宿主从条目算；显示哪些分组只记改过的，新分组照自己的默认。
- **参考**：[SPEC-0001 · 对话区](specs/0001-mvp1-single-session-chat.md#对话区)的"状态栏"、关键流程的"上下文分段"、[domain-model](architecture/domain-model.md) §3 指标的范围、§5 Preferences、[pi-internals](research/pi-internals.md) §2 统计。
- **完成标准**：对照 SPEC-0001 需求 9 逐条验证；数值与 pi 的 `get_session_stats` 一致。

##### M1.9 并行、同步与关注 ✅

- **目标**：多个会话同时跑，切走不中断；断线重连不丢不重；收件箱准确。
- **范围**：
  - 后台运行、关注状态（error / auth）与收件箱（2026-10-08 从 M1.5 挪来）、工作区与项目的状态汇总。
  - 列表同步（`generation + seq`，快照 / 增量）、会话订阅、对话记录按游标分页、重连流程、`clientMessageId` 对齐。
  - 自动生成标题（OneShotPi）、交给终端。
  - 开工前已定（2026-10-10，见 SPEC-0001"并行、同步与关注"）：列表增量由 IndexFeed 每批和上一批逐项比较得出，重连带游标；对话记录不按序号补拉，缺口就重拿快照；会话状态、收件箱和工作区汇总在界面从摘要派生，摘要的 `failed` 换成写进索引的 `attention`，加上 `asking`、`handedOff`；交给终端后记在索引里，点"在 Atrium 里继续"才重新启动 pi；宿主重启后界面对当前会话重新打开并订阅；标题用 `pi --mode json -p --no-session`，对话内容走标准输入。
- **参考**：[domain-model](architecture/domain-model.md) §4 状态的派生、§7 客户端与一致性、[paseo-architecture](research/paseo-architecture.md) §4 同步、§5 状态与关注、pi 实验版的 Chord 设计（[pi-internals](research/pi-internals.md) §6）。
- **完成标准**：三个会话同时运行时切换、断网再连、重启宿主，状态和对话都正确；SPEC-0001 需求 12 通过；打开关闭会话、订阅退订、连接断开、停止、崩溃重启各 200 次的泄漏测试通过；界面在会话间切换后没有多出脱离文档的 DOM 节点；30 分钟长时间运行通过。

##### M1.10 首次启动与设置 ✅

- **目标**：全新机器上从零走到第一次对话；SPEC-0001 里散落的设置项有地方改。
- **范围**：
  - 开工前先验证：宿主能否直接调用 pi-ai 的 OAuth 实现完成订阅登录（SPEC-0001 写着"实施时确认"，是本里程碑最大的风险）。
  - 首次启动：检查 pi / Node / fd（`@` 引用要用，M1.7 定）/ 登录 / 项目；一键安装和更新 pi（官方脚本、`pi update`、Homebrew 装 Node）；订阅登录（官方图标）与 API Key；从 pi 历史发现目录并添加；欢迎页（玻璃、点阵按钮、标题字体）。
  - 点阵图案的种子取本机安装 ID（存在 `~/.atrium/`），模型按钮拉满时的彩色点阵用同一个种子。
  - 字体子集和品牌图标打包进应用，不依赖网络。
  - 设置页（先设计，原型里只有入口）：外观；自动生成标题用的模型；项目的主干分支；pi 的版本与"更新 pi"（宿主每天查一次 npm，有会话在运行时等它们结束再更新）。
- **参考**：[SPEC-0001 · 首次启动](specs/0001-mvp1-single-session-chat.md#首次启动)、原型 `onboarding-prototype.html`、[design-language · 点阵、字体](architecture/design-language.md#点阵)、[pi-internals](research/pi-internals.md) §4 模型与认证、[domain-model](architecture/domain-model.md) §5 首次启动。
- **完成标准**：在一个没装 pi 的账户上走通；SPEC-0001 需求 13 通过；设置页里的每一项改完都生效。

##### M1.11 自用

- 用本机打包的 Atrium.app（`pnpm package`）或开发模式运行，连续一周用它完成真实的编码任务，至少 10 个会话。打包只给本机用：只做 ad-hoc 签名，不公证、不自动更新（2026-10-11 定，见 [overview.md · 桌面端怎么启动宿主](architecture/overview.md#桌面端怎么启动宿主)）。
- 每天看宿主日志里的资源计数和内存趋势；发现持续上涨就补一个能复现的泄漏测试再修。
- 记录 pi 比 Codex 明显不够用的地方，作为 H1 的结论，决定是否继续这条路线。
- 对照 SPEC-0001 的 14 条需求逐条过一遍。
- 在一个没装 pi 的 macOS 账户上从首次启动走到第一次对话（M1.10 完成标准第一条，合并时还没手动验证）。
- 以上都记在 [self-use.md](research/self-use.md)；每天的资源趋势用 `pnpm usage` 看（宿主每分钟记资源计数和内存，Electron 主进程每分钟把各进程的内存交给宿主记下）。
- 标志：一只猫，用作 Atrium.app 的图标和欢迎页的 logo 位（2026-10-11 定，见 [design-language · 标志](architecture/design-language.md#标志)）。
- 自用中补的：发送后到有内容之前显示眨眼的小猫和"进行中"（SPEC-0001"过程的呈现 · 等待回复"）；新建会话不等 pi 启动，宿主定 id、马上打开标签，pi 在后台用 `--session-id` 启动，空状态里一输入就新建（领域模型"已决定 9"，2026-10-11 改）。
- 网络代理：设置 · pi 里填代理地址和不走代理的列表，宿主把它放进交给 pi、登录、安装和更新的环境；宿主自己查最新版本、下载安装脚本也按环境里的代理走（SPEC-0001"设置 · pi"，2026-10-11 定）。
- 每个对话是一个独立的容器：和工作区一样能放多个会话、有自己的标签栏和"历史"，侧栏逐行列出对话、可以改名；不再把所有对话挤在一个标签栏里。索引的 `sessions.json`、`layouts.json` 升到 v2，新增 `chats.json`（[ADR-0007](adr/0007-each-chat-is-its-own-container.md)，2026-10-12 定）。
- Fast：输入框里模型按钮左边的 ⚡ 开关，只在支持的模型上显示，哪些模型支持问 Codex 的模型列表（查不到时按内置规则：ChatGPT 订阅的 GPT-5.5、5.6、6、6.1 系列）；每个会话一份，新会话沿用上一次的选择。由 Atrium 自带的 pi 扩展给请求加 `service_tier: "priority"`（[ADR-0008](adr/0008-atrium-own-pi-extension-for-fast.md)，2026-10-12 定）。
- 浏览器：不内置浏览器，agent 的浏览器操作放在外部的 ego lite，定制功能以后做成浏览器插件；对话和工作区里不放浏览器标签页（[ADR-0009](adr/0009-browser-stays-external.md)，2026-10-12 定）。

##### M1.12 文件与更改 ✅

- **目标**：右栏照 Paseo 改成"文件""更改"两个标签，只放树、不放 diff；点文件在对话区打开一个查看标签，看文件内容或 diff（2026-10-13 定）。
- **范围**：
  - 右栏：顶部"文件""更改"两个标签，"更改"后面带改了几个文件；默认打开"更改"，没有改动时打开"文件"。只放树，默认宽 320px、最窄 240px（原来 560 / 360），对话照旧最少留 440px；开关、拖动、动效不变。
  - 更改：比较范围（未提交 / 已提交）、合计、刷新照旧；改了的文件按目录排成树：目录在前、按名字排，只有一个子目录的目录连成一行，目录行带里面的合计，文件行带增删和状态图标；默认全部展开。
  - 文件：工作区的文件树，只列 git 管的文件和没被忽略的新文件（`.gitignore` 忽略的不列）；目录在前、按名字排，展开目录时才读；展开到哪按工作区记在本机；改过的文件带一个小圆点。
  - 查看标签：标签栏里一种新的标签，排在会话标签后面，切过去时占满对话区（输入框也让出去）。从树里单击打开的是预览标签（标题斜体，下一次单击别的文件把它换掉），双击才固定。只在界面里，不进宿主的布局，重启不保留。
    - 文件内容：只读，行号、语法高亮、换行开关；顶部是路径、大小、行数，有改动时有"查看改动"。图片显示图片，二进制和太大的文件只显示一行说明。
    - diff：一个共用的"改动"标签，所有文件连着、按更改树的顺序，点哪个文件滚到哪个；文件头吸顶、点它折叠；带语法高亮；全部折叠 / 展开、换行开关。行的样式同现在的面板。
  - 文件类型图标统一换成 material-icon-theme 的原版图标（MIT，VS Code、Paseo 用的那套），对话里的文件胶囊一起换（2026-10-13 定：用官方的，不自己画）。
  - 协议：列文件、读文件；diff 沿用 `watch_diff`。
  - 不做（Paseo 有的）：分支切换、新建 / 重命名 / 删除文件、右键菜单、并排 diff、忽略空白、diff 里的评论、编辑文件、文件树的排序切换。
- **参考**：原型 `files-changes-prototype.html`（A 版；B 分栏、C 浮层没选）、[paseo-architecture](research/paseo-architecture.md) §6.1、[SPEC-0001 · M1.12 的文件与更改](specs/0001-mvp1-single-session-chat.md#m112-的文件与更改协议版本-142026-10-13-定)（以及它沿用的"工作区改动"）、[design-language · 右栏、查看标签](architecture/design-language.md#右栏文件与更改)、[domain-model](architecture/domain-model.md)"已决定 19"、[security.md](architecture/security.md)"子进程与文件"。Paseo 的对应源码：`packages/app/src/components/file-explorer-pane.tsx`、`git/changed-files-tree.tsx`、`git/diff-tree.ts`、`panels/file-panel.tsx`、`workspace-tabs/open-beside.ts`。
- **完成标准**：SPEC-0001 里这一节的行为都有测试；约 2 万行的 diff 在查看标签里打开、滚动、切换标签不超过性能预算；查看标签反复开关的泄漏测试通过；大文件、二进制、图片、读不了的文件都有说法。

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
- 新建 worktree 工作区：由宿主创建 worktree，记下起点提交，会话在其中运行；工作区提供查看改动、合并、归档并清理 worktree 的入口（归档 2026-10-12 提前在 M1.11 做了，见 SPEC-0001"M1.11 的工作区归档"）；新会话时可选"当前工作区 / 新建 worktree"。
- 参考：[SPEC-0001 · worktree 合并状态](specs/0001-mvp1-single-session-chat.md#侧栏)、[paseo-architecture](research/paseo-architecture.md) §6 git 状态。

v0.1 不做：沙箱隔离、插件系统、会话树、agent 自扩展、对外分发的签名与公证（本机用的打包在 M1.11 做了）、空闲进程回收、编辑文件（M1.12 的文件区只读；外部改动的处理留到做编辑时设计）。

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
- 浏览器插件：ego lite 做不到的、或和 Atrium 相关的浏览器功能（例如把当前页面送进会话），自用中真遇到时再做；连宿主的鉴权、只操作"Atrium"标签组等规则见 [ADR-0009](adr/0009-browser-stays-external.md)。不内置浏览器（原先的"内嵌浏览器面板"，2026-10-12 改）
- 手机端：先做响应式 + PWA，远程访问走 Tailscale；原生 App 视需要再做（见 [ADR-0005](adr/0005-split-host-and-ui-pwa-first.md)）
- 空闲进程回收、文件区、forge（PR）状态
- SPEC-0001 里标为"以后"的：侧聊、agent 提出的任务建议卡片、全文搜索、置顶、一个目录多个工作区、把对话移到项目、收藏模型、语音输入、订阅额度显示、长会话虚拟列表、extension 单向通知的显示
