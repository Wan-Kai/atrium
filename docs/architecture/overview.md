# 架构总览

> 状态：初步设想，随实现调整。

## 分层

```
  Electron 桌面端                 iOS App（SwiftUI）
  └── ui                          └── 由 protocol 生成的类型
         │                                │
         │ 本机 WebSocket · token          │ Noise IK 端到端加密
         │                                ▼
         │                        relay（用户的 VPS，只转发密文）
         │                                ▲
         │  Atrium 协议                    │ 宿主主动出站连接
         ▼                                │
┌──────────────────────── 宿主（Node） ────────────────────────┐
│  WebSocket 服务 · 鉴权 · 会话索引 · 提供 ui 静态资源            │
│  Harness 适配器（目前只有 pi）                                 │
└───────────────────────────┬──────────────────────────────────┘
                            │ stdio · JSONL RPC
                 pi --mode rpc  +  extensions（插件逻辑）
```

| 层 | 职责 |
|---|---|
| UI | 窗口、会话列表、对话视图、插件视图的挂载（桌面端；手机端是另写的 SwiftUI App，见 ADR-0015） |
| 客户端层 | WebSocket 连接、协议处理、状态管理，不依赖 DOM |
| 宿主 | WebSocket 服务、鉴权、会话索引；通过 Harness 适配器启动和监督 harness 进程，把 harness 的事件翻译成 Atrium 事件 |
| pi + extensions | agent loop、会话、工具、上下文管理，以及插件的逻辑部分 |

选择 pi 作为唯一内核的理由见 [ADR-0001](../adr/0001-use-pi-as-core.md)；宿主与 UI 分离见 [ADR-0005](../adr/0005-split-host-and-ui-pwa-first.md)；手机端是 SwiftUI 原生 App（[ADR-0015](../adr/0015-native-ios-app-in-swiftui.md)），经自建 relay 加 Noise 端到端加密连回宿主（[ADR-0016](../adr/0016-remote-access-through-own-relay-with-noise.md)），2026-10-24 定；`apps/ios` 在 MP1 补进下文的代码结构（2026-10-25），`apps/relay` 在 MP2 补。

## 代码结构

2026-10-04 定，经 GPT-6-Astra 评审后调整。新增或挪动模块时先改这里。

```
atrium/
├── apps/
│   ├── desktop/                    Electron 外壳：只负责启动宿主和开窗口
│   │   ├── src/main/               主进程：启动宿主、窗口、菜单、用系统浏览器开外链；visual-sandbox 是交互演示的协议、CSP、
│   │   │                           按 frame 和站点过滤请求、截图（SPEC-0007，MV1）
│   │   ├── src/preload/            把宿主地址和 token 交给 UI
│   │   └── e2e/                    第 6 层端到端测试；heap.ts 取堆快照、比较脱离文档的 DOM 节点
│   ├── ios/                        手机端（SwiftUI，ADR-0015，MP1 起）
│   │   ├── .swift-format           swift-format 的配置（coding-standards"Swift（手机端）"）
│   │   ├── AtriumKit/              SwiftPM 包：全部逻辑和界面，逻辑 target 能在 macOS 上 `swift test`
│   │   │   ├── Sources/
│   │   │   │   ├── AtriumProtocol/ 协议类型：Generated/ 由 `pnpm protocol:swift` 生成、不手改；JSONValue、Nullable 等手写的编解码支持
│   │   │   │   ├── AtriumNoise/    Noise 握手、CipherState、分帧（MP0 起）
│   │   │   │   ├── AtriumRemote/   relay 连接、心跳、重连、前后台（actor，MP4）
│   │   │   │   ├── AtriumSync/     列表和会话的状态：快照、续传、"发送中"和回执（MP4）
│   │   │   │   ├── AtriumRender/   流式 Markdown、代码高亮、diff（MP5、MP6）
│   │   │   │   └── AtriumUI/       SwiftUI 界面（默认 @MainActor）
│   │   │   └── Tests/<模块>Tests/  Swift Testing；AtriumProtocolTests/Fixtures/ 是往返测试的夹具，由 envelope.test.ts 写出
│   │   ├── Atrium/                 App 本体：只做组装（@main、注入依赖）
│   │   ├── AtriumUITests/          XCUITest，在模拟器上跑
│   │   ├── Config/                 xcconfig：工程共用、App、UI 测试各一份，构建设置都写在这里
│   │   └── Atrium.xcodeproj/       手写维护的 Xcode 工程（见下文"iOS 工程"）
│   └── relay/                      手机端的 relay（SPEC-0005，2026-10-25 MP2）：跑在用户的 VPS 上，只转发字节
│       ├── src/                    relay.ts 线路协议；config 和 hosts 读写配置与宿主表；cli 命令行；
│       │                           daily-log 按天的日志；clock、resources 同宿主的做法（不 import 宿主）
│       ├── deploy/                 nginx 的 location 片段、compose.yaml、systemd unit
│       └── Dockerfile              多阶段：构建单文件 relay.cjs，运行时用官方 node 镜像、非 root
├── packages/
│   ├── protocol/                   宿主和客户端之间的协议（zod），只放线上传输的东西
│   │   └── src/
│   │       ├── ids.ts              prj_ / wks_ / 会话 id 的品牌类型
│   │       ├── entities/           线上实体：项目、工作区、会话摘要，对话记录的轮、步骤、系统事件，
│   │       │                       待交互，指标，上下文分段
│   │       ├── commands/           按领域分文件：projects、workspaces、sessions、run、catalog、setup、tasks（SPEC-0006）
│   │       ├── events/             同上
│   │       ├── sync.ts             generation+seq、epoch+seq、游标、快照或增量的信封
│   │       ├── json-schema.ts      按导出名登记全部 schema，导出 JSON Schema（`pnpm protocol:swift` 用，ADR-0015）
│   │       └── version.ts          协议版本，握手时用
│   ├── remote-crypto/              独立 Noise IK/IKpsk2、分帧、SecureChannel；只有加密原语依赖，Clock 是结构接口
│   ├── pi/                         pi 集成：pi 的格式和协议只出现在这里
│   │   ├── src/
│   │   │   ├── config/             普通配置的 pi 语法校验，以及与 pi 共用的 settings 文件锁（proper-lockfile）
│   │   │   ├── process/            PiProcess：启动、LF 分帧、请求对应、超时、stderr、进程组
│   │   │   ├── rpc/                命令封装：prompt、steer、abort、get_entries……
│   │   │   ├── translate/          EventTranslator：pi 实时事件 → Atrium 事件（纯函数）
│   │   │   ├── history/            pi 条目 → 日志条目 LogEntry（纯函数；LogEntry 类型定义在这里）
│   │   │   ├── sessions/           扫描会话文件、解析文件头、记录大小和修改时间（不做归类）
│   │   │   ├── context/            ContextEstimator：按 pi 的语义回放系统消息和检查点，只返回各分段的 token 数
│   │   │   ├── catalog/            PiCatalog：短启 pi 查模型并按目录缓存、推理档位、`/` 命令的映射
│   │   │   ├── oneshot/            OneShotPi：`pi --mode json -p --no-session` 的调用和输出解析
│   │   │   ├── auth/               登录：系统 Node 运行的登录程序（加载用户装的 pi 的 ModelRuntime）
│   │   │   │                       和宿主这边的调用（登录状态、OAuth、API Key、退出）
│   │   │   ├── edit/               停止消息编辑：受保护的同会话无摘要导航、失败恢复与隐藏命令编码
│   │   │   ├── fast/               Fast：哪些模型支持的规则，和交给 pi 加载的扩展（ADR-0008）
│   │   │   ├── task/               任务扩展（SPEC-0006）：节点工具 node_done / request_graph_change、任务对话的工具、路径隔离的 tool_call 钩子、
│   │   │   │                       隐藏命令 `/atrium-task` 的参数和 schema；走 ADR-0013 的通道
│   │   │   ├── agent/              子对话：隐藏命令 `/atrium-agent` 的参数、给模型的说明，扩展的这一部分（SPEC-0002、ADR-0013）
│   │   │   ├── stats/              会话统计；UsageReader 增量读会话文件里的用量（子对话的"含子对话"，SPEC-0002）
│   │   │   ├── visuals/            交互演示（SPEC-0007）：`--atrium-visuals` 参数、系统提示里的说明、外壳可用的图标名单
│   │   │   └── locate/             找到 pi 和它用的 Node、检查版本；找到 `@` 用的 fd
│   │   ├── fixtures/               第 3 层录制的夹具，`pi-<版本>/<场景>.jsonl`
│   │   └── test/contract.ts        跑契约场景并录制或检查夹具（场景在 `src/contract/`）
│   ├── host/                       宿主：Atrium 自己的业务
│   │   ├── src/
│   │   │   ├── main.ts             startHost：组装依赖、启动；不依赖任何 Electron API
│   │   │   ├── entry.ts            进程入口：在 Electron 子进程里从 parentPort 收配置，或单独运行时读环境变量
│   │   │   ├── dev/                开发用命令：`pnpm pi:try`（用宿主的组件驱动真实 pi，终端里看流式输出）
│   │   │   ├── server/             WsServer、ClientTransport、Connection、鉴权、命令路由、上传图片的暂存（按连接）；remote-policy 穷举手机命令和事件
│   │   │   ├── remote/             RemoteService、relay 控制/数据连接、连接证据采集、配对状态机及候选活动投影、设备、保险箱端口；通过注入 accept/send 接服务器
│   │   │   ├── store/              ~/.atrium：索引文件（原子写入、格式版本与迁移、损坏挪开）、各文件的格式、
│   │   │   │                       宿主单实例锁、偏好、插话记录
│   │   │   ├── projects/           ProjectService：项目与工作区的登记（projects.json）
│   │   │   ├── workspaces/         WorkspaceService（worktree 扫描、后台 fetch）、MergeInspector
│   │   │   ├── sessions/           SessionManager、SessionCatalog（按记录的容器或 cwd 归类）、布局、
│   │   │   │                       列表命令、SessionController、SessionRuntime、PromptQueue、
│   │   │   │                       PendingInteraction、Attention、计时与指标；子对话的树（child-tree）
│   │   │   │                       和用量合计（children-usage，SPEC-0002）；stopped-edit 负责停止消息编辑的分支事务和恢复；
│   │   │   │                       reply-translation 管理按连接归属的临时翻译与取消，不写会话
│   │   │   ├── study/              学习方向（SPEC-0008，ML1）：扫描和监听学习目录（Directions）、起名、建方向目录、
│   │   │   │                       方向的命令（新建、归档、恢复，经 SessionManager 建会话、停 pi）；
│   │   │   │                       进度（ML2）：progress（读 `.atrium-study.json`）、progress-file（排队、原子写）、
│   │   │   │                       progress-rules（工具、手动标记、下一步，纯函数）、study-tools（答扩展的 `study_*` 工具）
│   │   │   ├── transcript/         SessionLog（日志条目树、叶子、当前分支）、TranscriptProjection
│   │   │   ├── status/             会话状态、工作区和项目的汇总（纯函数）
│   │   │   ├── sync/               订阅表、列表推送（M1.5 整份快照，M1.9 加 generation+seq 增量）
│   │   │   ├── setup/              Toolbox（找到的工具，可重新检测）、SetupService、安装和登录任务；PiConfig（固定白名单的普通配置读取、版本检查与原子保存）
│   │   │   ├── titles/             TitleGenerator：标题的提示词、截断和写回规则
│   │   │   ├── files/              FileSearch（`@` 引用的候选文件：调 fd，按 pi 终端界面的规则打分）；WorkspaceFiles（M1.12：右栏文件树的目录内容、查看标签的文件内容，只读工作区里的、不跟随链接）
│   │   │   ├── tasks/              任务（SPEC-0006）：TaskService、Scheduler（纯函数 step）、TaskRunner、TaskStore（事件日志与重放）、
│   │   │   │                       GraphValidator、ScheduleService；用 sessions/、workspaces/、store/、platform/，反过来不用
│   │   │   ├── reviews/            ReviewHub（ADR-0018）：按会话汇总各来源的待审核、校验裁决的形状、只认第一个裁决、转交给来源的 provider；不知道任务或 agent。任务关卡的 provider 在 `tasks/task-reviews.ts`
│   │   │   ├── changes/            ChangesService（工作区的 git 改动：胶囊上的合计、右栏"更改"和"改动"标签的 diff，监听有人看的工作区）
│   │   │   ├── visuals/            交互演示（SPEC-0007，MV1）：演示目录里的路径校验、令牌、外壳和 CSP、按目录监视、
│   │   │   │                       回传的限速；`/visual/<令牌>/…` 由 server 的 HTTP 处理转来
│   │   │   └── platform/           登录 shell 的环境、Clock、日志、子进程工具、git 调用（并发上限 4）
│   │   └── test/harness.ts         第 4 层测试用的宿主：起真实宿主，用 client 连上去
│   ├── client/                     客户端层：不依赖 DOM，也不依赖 React
│   │   └── src/
│   │       ├── connection/         WebSocket、握手、心跳、重连
│   │       ├── stores/             IndexView、SessionView、布局（zustand/vanilla；布局镜像宿主上按客户端记录的标签页）
│   │       ├── sync/               应用快照和增量、补缺口、epoch 变化时整段替换、clientMessageId 对齐（纯函数）
│   │       ├── selectors/          收件箱等派生数据
│   │       └── index.ts            AtriumClient：对外只暴露 store 和命令方法
│   ├── ui/                         React 界面（功能目录直接放在 src 下，2026-10-08 按实际结构改）
│   │   └── src/
│   │       ├── app/                根组件、工作台（侧栏 + 标签栏 + 对话区）、全局快捷键、连接状态
│   │       ├── state/              把 client 的 store 包成 hooks；ViewState（折叠、草稿，存 localStorage；图片只在内存）
│   │       ├── design/             设计变量（CSS）、外观、弹簧曲线、点阵、图标封装、字体、服务商官方图标（brand/）
│   │       ├── sidebar/            侧栏、搜索、项目与工作区、对话分区（收件箱在 M1.9）
│   │       ├── study/              学习模式（SPEC-0008）：学习首页、新建方向页、方向主页标签和主页
│   │       ├── tabs/               标签栏、历史和会话菜单
│   │       ├── tasks/              任务区（SPEC-0006）：固定的"任务""定时"标签、任务列表、任务标签（图 + 任务对话）
│   │       ├── children/           子对话：子对话条、面包屑、开子对话的对话框和它们的规则（SPEC-0002）
│   │       ├── chat/               对话区：消息流、过程、步骤、diff、Streamdown、平滑揭示、提问导航条、输入框；PlantUML 的有界本地 worker、工作区回复图片和全屏预览；受控文件引用与有界 JSON/CSV 查看（2026-10-20）；reply-translation 的临时回复译文；visual-card 交互演示的卡片（iframe、外壳消息、离开视口卸载和截图，SPEC-0007）
│   │       ├── test/               浏览器测试用的假客户端
│   │       └── 以后：status-bar/、interactions/、onboarding/、settings/
│   └── testkit/                    测试工具：不依赖任何内部包（最多依赖 protocol），只出现在 devDependencies
│       └── src/
│           ├── faux/               faux 模型：交给 pi 加载的 extension、回复脚本格式、启动参数
│           ├── pi-fixtures/        夹具的格式、规范化、录制、比较，以及回放夹具的 PiProcess 替身（按结构类型匹配 pi 包的接口，不 import 它）
│           ├── shared-executable.ts 测试用可执行文件按内容只写一份并预热（见 testing.md"测试里的可执行文件"）
│           ├── scripted-pi.ts      按脚本行为的 pi 可执行替身（乱序回应、崩溃、不理 SIGTERM、留下孙进程），pi 包和宿主的测试共用
│           ├── clock.ts            假时钟；浏览器测试经 `@atrium/testkit/clock` 取用，不加载含 Node 依赖的总入口（2026-10-20）
│           ├── present.ts          测试里取必然存在的值，避免测试体里出现 `??`
│           ├── bench.ts            基准与本机基线比较
│           ├── temp-dir.ts         临时目录（以后扩展成临时 HOME、~/.atrium、pi 会话目录）
│           └── git.ts              造 git 场景：merge、squash、rebase、cherry-pick、worktree
├── scripts/                        开发辅助：dev.mjs、trace.mjs、lint/atrium-plugin.mjs（JSDoc 规则）；ios.mjs（Swift 的检查、测试、构建、装到真机）、
│                                   swift-lint.mjs（Swift 的文档注释等检查）、swift-codegen.mjs 和 protocol-swift.mjs（`pnpm protocol:swift`）
├── docs/
└── 根目录配置：pnpm-workspace.yaml、tsconfig.base.json、vitest.config.ts、vitest.mutation.config.ts、
               stryker.config.mjs、.oxlintrc.json、.oxfmtrc.json、knip.json、lefthook.yml
```

MVP 2 的内置 pi extension 以后放在根目录的 `extensions/`，现在不建。M1.11 的 Fast 扩展不是插件（没有视图、不按 pi package 发布），它的规则宿主也要用，所以放在 `packages/pi/src/fast/`（ADR-0008）。

2026-10-21 回复图表 B 细化：`chat/plantuml-theme.ts` 只给 worker 生成本地默认皮肤行，原始代码仍由展示/复制组件保管，输出继续经过原尺寸/UTF-8 字节校验并只作 Blob 图片。`chat/mermaid-zoom.tsx` 是锁定 Streamdown 版本的窄 DOM 适配：库只公开 `panZoom` 开关、没有控制器/比例回调，所以由 B 工具条激活当前内联图的原生按钮，并用一个可回收 MutationObserver 读取其真实 transform/disabled；不另写缩放算法、不移动第三方 React 的节点或改 SVG。选择器仅限当前图，排除 body 全屏 portal；真实渲染、Tab 顺序、滚轮、边界、换源/主题、缩放尺寸与回收测试守住此版本契约。

2026-11-04 Markdown 预览合并前发现 Mermaid 11.17.2 的共用布局渲染器只在下一次布局前清空节点、边标签、分组缓存，模块级 Map 因而留住已移除的绘图 DOM。用户选择先修复再合并：用 `patches/mermaid@11.17.2.patch` 和 pnpm 的 `patchedDependencies` 固定局部修复，在共用布局函数的 `finally` 清理同一组缓存，成功和异常都释放；不升级依赖、不在 UI 导入 Mermaid 私有路径，也不改变 SVG、交互和按需加载。补丁适用于应用所用 ESM 入口的共用布局实现；升级 Mermaid 时重新核对补丁和真实绘图/泄漏测试，不把其他图种的资源回收一并视为已证明。

2026-10-26 桌面浮层边界修复：`ui/src/design/floating-layer.ts` 仅负责锚点浮层的视口几何、manual popover top layer 与观察/监听的释放，不拥有业务开关、焦点策略或内容。各组件保留打开/关闭与理想尺寸；top layer 保持 DOM 归属，解决滚动、filter/transform 祖先裁剪而不改变父面板的外点判断。居中对话框用自身 CSS 限宽限高，不接入这个锚点模块。行为见 SPEC-0001“桌面浮层的窗口边界”、design-language“浮层边界”；决策比较和入口盘点见 `research/popup-bounds.md`。

### 包之间的依赖

```
protocol  ←──  pi  ←──  host
    ↑
    └──────  client  ←──  ui
```

| 包 | 可以依赖 | 不允许 | 怎么强制 |
|---|---|---|---|
| protocol | zod | 任何内部包 | package.json 没声明，pnpm 就不让 import |
| pi | protocol（只用对话记录相关的实体，不碰命令和同步信封） | DOM、其他内部包 | 唯一能 import `@earendil-works/*` 的包，其他包由 oxlint `no-restricted-imports` 禁止（例外见下文 testkit 的两个 faux extension） |
| remote-crypto | 精确版本的 @noble/ciphers、@noble/curves、@noble/hashes | 任何内部生产包、Electron、网络 | 时间通过结构接口注入；向量、互通夹具与变异测试 |
| host | protocol、pi、remote-crypto | DOM、client（生产代码）、ui、Electron | tsconfig 的 `lib` 不含 DOM；oxlint 禁止 `packages/host/src` import `@atrium/client`（client 只作第 4 层测试的开发依赖） |
| client | protocol、zustand | DOM、React | tsconfig 不含 DOM，oxlint 禁止 import react |
| ui | client、protocol（只用类型） | host、pi | 没有声明依赖；oxlint 只许生产代码 `import type` protocol，要用的值（`CommandError`、`isChatId` 等）由 client 转出（测试不限） |
| desktop | 不 import host 和 ui 的代码 | — | 只知道构建好的宿主入口路径，窗口经 `atrium://app/` 加载宿主提供的页面 |
| relay | ws、zod | 任何内部包（testkit 只作开发依赖，测试里用假时钟） | package.json 没声明；它部署在另一台机器上，Clock 和资源计数各写一份小的，不从宿主拿 |
| testkit | protocol | 其他内部包；被生产代码依赖 | 避免和被测包形成循环依赖；knip、oxlint 检查 |

- **RelayLink 的公开回调所有权**：`onState` 是同步公开回调，允许在终态通知中调用 `retryNow()` 或 `stop()`。旧连接尝试只能结算进入该终态时已有的等待者；回调中新建的 retry 必须等新连接的 ready/失败，不能被旧结果结算。回调已经启动新代或停止后，旧 close 不能再挂自动重试 timer；正常自动 backoff 保持。旧 live check 的迟到结果不覆盖停止后或新代的诊断，不额外发布通知。此约束来自真实 socket 的模块公开边界复现，不表示当前 Electron UI 已复现该重入路径。
- **MP3a 远程边界**：`server/transport.ts`、`server/router.ts` 声明传输和管理命令接口；`remote/` 只依赖这些类型，不 import 服务器实现；`main.ts` 注入 `RunningServer.accept`、订阅表的定向发送、Clock、资源计数和 VaultPort。服务器不 import `remote/`，继续共用会话/工作区服务。主进程 `main/vault.ts` 只处理固定 vault 文件的加解密与有版本的 IPC，不 import 宿主代码。独立宿主不触碰 safeStorage，未启用时不自动读保险箱（显式配置、测试、重置除外）。
- **回复翻译的边界（M1.11 自用后补充）**：`sessions/reply-translation.ts` 只管理按连接归属的一次性翻译及取消，不控制原会话运行；`SessionManager.replyTranslationSource` 同步提取当前分支已结束轮的正文和当前模型，`main.ts` 注入偏好语言及 pi 一次性调用。服务不依赖 server，router 传连接 id，WebSocket 断开和宿主关闭调用取消；无翻译索引或历史字段。UI 的 `chat/reply-translation.tsx` 只在回复组件内存中保存结果，客户端等待之前的取消清理后再发送新请求，不跨重连补发；设置只写 `translationLanguage`。
- **交互演示（SPEC-0007，MV1，2026-11-05）**：宿主 `visuals/` 只依赖 `sync`/`store`/`platform` 和 pi 包的名单；它要的会话工作目录、演示目录、按插话发消息都由 `main.ts` 注入（`visualsDirFor(sessionId)` 由会话所在的容器决定，现在只有默认的 `~/.atrium/visuals/<会话 id>/`，ML4 给学习方向换成方向目录下的 `visuals/`）。server 的 HTTP 处理只把 `/visual/` 开头的请求交给它。桌面端 `main/visual-sandbox.ts` 是纯函数（CSP、按站点检查地址），`main.ts` 把它接到 `protocol.handle`、`webRequest.onBeforeRequest` 和截图 IPC 上。界面 `chat/visual-card.tsx` 经 `VisualsContext` 拿到 resolve、发消息、截图的能力，`Markdown` 只把 `visual` 代码块交给它；Hugeicons 的 SVG 在宿主里按名单生成，界面不往 iframe 里送图标。
- **文件 Markdown 预览（2026-11-04）**：`files/markdown-file-preview.tsx` 只组装已有的 `chat/Markdown`、受控图片读取和文件打开能力；相对引用以文档目录为基准，安全检查和渲染仍由既有组件负责。`FileViewer` 拥有显示切换，模式和两套纵向滚动位置只存窗口的 `ViewerPlace`，不新增宿主协议或依赖。
- **回复增强的 UI 内部边界（2026-10-20）**：`chat/file-opener.ts` 只声明当前工作区的惰性打开能力，供工具胶囊与 Markdown 引用共同使用；不从 Markdown 反向 import 步骤组件。文件路径的工作区校验与打开仍由 ConversationArea 组装；`state/workspace-views.ts` 保存窗口内的一次性行范围导航，FileViewer 在读取和恢复滚动后按实际行元素消费，不增加宿主命令或持久索引字段。JSON 使用精确锁定的 `jsonc-parser@3.3.1` 的 scanner/AST（严格 JSON，不接受注释），通过源码位置展示数值和属性，CSV 用受限状态机；两者都不引入脚本执行或网络能力。
- **faux extension 的例外**：`packages/testkit/src/faux/extension.ts` 可以 import `@earendil-works/pi-ai`。我们的代码从不加载它，它只作为文件路径交给 pi 进程（`--extension`），由 pi 自己加载执行，import 也由 pi 解析到它自带的 pi-ai；testkit 声明的同版本 pi-ai 开发依赖只用于类型检查。oxlint 只对这一个文件放开限制。放在 testkit 而不是 pi 包，是因为 pi 契约测试、宿主集成测试和端到端测试都要用它。
- 同理，`packages/testkit/src/faux/readme-extension.ts`（README 截图用，`pnpm readme:shots`，见 development.md"命令"）在一个 pi 里用真实的服务商名注册几个 faux 服务商，同样只作为文件路径交给 pi、由 pi 自己加载，oxlint 对它也放开（2026-10-20 截图脚本收进仓库时加）。

- **登录程序的例外**（2026-10-10 定）：`packages/pi/src/auth/` 里的登录程序由宿主交给系统 Node 运行，不被我们的进程加载。它按绝对路径 `import` 用户装的 pi 包（`dist/index.js`），用的是 pi 自带的依赖；只从 `@earendil-works/pi-coding-agent` 取类型（pi 包的开发依赖）。它只用 Node 能直接运行的写法（能被去掉的类型注解，不用 enum 等），因为系统 Node 直接运行源文件。

- **Atrium 自带的 pi 扩展**（2026-10-12 定，ADR-0008；2026-10-15 加套餐用量，ADR-0010）：`packages/pi/src/extension/atrium.ts` 是入口，注册 `packages/pi/src/fast/` 的 Fast、`packages/pi/src/plan/` 的套餐用量、`packages/pi/src/agent/` 的子对话工具、`packages/pi/src/task/` 的任务工具与路径隔离钩子（SPEC-0006）、`packages/pi/src/edit/` 的停止消息编辑隐藏命令、`packages/pi/src/search/` 的联网搜索与抓取（ADR-0014）、`packages/pi/src/visuals/` 在系统提示里加的交互演示说明（SPEC-0007，分段 `atrium_visuals`）和 `packages/pi/src/study/` 的学习模式工具（SPEC-0008）；由 pi 加载（`--extension`），不被我们的进程加载。构建时连同它用到的规则打成一个文件 `atrium-extension.mjs`（原名 `fast-extension.mjs`），放在宿主旁边（和登录程序一样，所以应用不用 asar）；测试里直接加载源文件。它只从 `@earendil-works/pi-coding-agent` 取类型，运行时不 import pi 的任何东西。

- **pi 包的边界**：怎么调 pi、pi 的事件和条目长什么样、pi 的回放语义，都在 pi 包里；Atrium 的业务规则（会话归哪个容器、标题怎么起、上下文分段怎么展示）在 host。pi 包对外输出两类东西：协议里的对话记录实体，以及它自己定义的 LogEntry（只在宿主内部用，不上线）。
- **线上实体与宿主内部模型分开**：SessionRuntime 等运行时模型在 host 里，快照和事件由 SessionController 映射成 protocol 的实体。
- **pi 包拿到宿主基础设施的方式：注入，不 import。** pi 包需要时钟、资源计数、日志和请求 id，这些都在 host 的 `platform/`，而 pi 包不能依赖 host。做法同 testkit 的假时钟：pi 包自己定义窄接口，host 的 `main.ts` 组装时传进去，结构类型匹配即可。

  ```ts
  /** pi 包对宿主的全部要求；host 在 main.ts 里提供。 */
  interface PiDeps {
    clock: { now(): number; setTimeout(callback: () => void, ms: number): () => void };
    /** 计一个打开的资源（进程、监听），返回只生效一次的释放函数。 */
    track(kind: string): () => void;
    /** 结构化日志；host 传入的实现会自动带上当前 trace id。 */
    log: Record<"debug" | "info" | "warn" | "error", (fields: object, message: string) => void>;
    /** 下一条 RPC 命令的 id；host 用当前 span id 生成，pi 响应会原样带回。 */
    nextRequestId(): string;
    /** 启动 pi 用的环境变量：登录 shell 的完整环境，去掉 Atrium 和 Electron 自己的变量。 */
    env: Readonly<Record<string, string>>;
  }
  ```

  pi 包不 import OpenTelemetry、pino 或 host 的任何模块；它自己管 pi 子进程的进程组和退出清理。测试时由测试自己构造 `PiDeps`（例如注入 `FakeClock`、计数的 `track`）；要代替整个 pi 进程时，用 testkit 的 `replayPi` 回放夹具。

### iOS 工程（2026-10-25 定，MP1）

- **模块之间的依赖**只能按下图的方向，由 `Package.swift` 里每个 target 声明的依赖强制（`swift build` 带 `--explicit-target-dependency-import-check error`，没声明的 import 编译失败）：

  ```
  AtriumProtocol  ←──  AtriumSync  ←──┐
        ↑   ↑                          │
        │   └──  AtriumRender  ←───────┼──  AtriumUI  ←──  App
        └──────  AtriumRemote  ←───────┘
                      ↓
                 AtriumNoise
  ```

  `AtriumProtocol`、`AtriumNoise` 不依赖任何内部模块；`AtriumSync` 只认协议类型，不知道连接（收到的消息由 App 组装时从 `AtriumRemote` 交给它）；只有 `AtriumUI` 和 App 碰 SwiftUI。
- **Xcode 工程文件**：`apps/ios/Atrium.xcodeproj` 提交进仓库、手写维护，不用 XcodeGen 或 Tuist。比较过的做法：

  | 做法 | 好处 | 代价 |
  |---|---|---|
  | 手写 `.xcodeproj`，用 Xcode 16 起的文件夹同步（`PBXFileSystemSynchronizedRootGroup`），设置写在 xcconfig（采用） | 加删文件不改工程文件，`project.pbxproj` 只在加 target、改依赖时才动，合并冲突的主要来源没了；设置是纯文本、能审查；不加工具；Xcode 直接打开 | 加 target 时要改 `project.pbxproj`（Xcode 里改或手改），它的 diff 不好读 |
  | XcodeGen：`project.yml` 生成，`.xcodeproj` 不提交 | 工程完全由一份 YAML 描述，最好审查 | 多一个 Homebrew 工具和版本；每次 checkout 后要先生成才能打开、构建；Xcode 里改的设置会被下次生成冲掉 |
  | Tuist：Swift 写的 `Project.swift` | 类型检查的工程描述，模块化强 | 更重的工具链和缓存，对一个 App 加一个本地包来说过度 |

  逻辑都在 `AtriumKit` 这个 SwiftPM 包里（`Package.swift` 是纯文本），App 只引用它的 `AtriumUI` 产品，所以工程文件本身很少变。以后要加通知扩展、小组件这类 target 而且变得频繁时，再考虑 XcodeGen。
- **签名**：免费账号（Personal Team，团队 `QGZ4G5UJ65`），自动签名，bundle id `site.ktoon.atrium`，最低 iOS 26，只支持 iPhone、竖屏（`Config/*.xcconfig`）。`pnpm ios:build` 带 `-allowProvisioningUpdates`，描述文件由 Xcode 用已登录的账号生成，7 天到期。

### 宿主内部的依赖

只能从左往右依赖：

```
server → study → sessions → transcript、status、pi
              → workspaces（起名用 branch-namer 的 cleanBranchName）
         sessions → workspaces → projects
       → setup、titles、files、visuals
       → reviews（sessions 读它汇总的待审核，server 转交裁决；tasks 实现它的 provider，反过来它不依赖 tasks）
各业务模块 → sync、store、platform（这三个不依赖任何业务模块）
main.ts 负责组装全部
```

- 业务模块不依赖 `server/`，通过 `sync/` 的集合发布变化，不直接碰 WebSocket。
- 子进程：
  - Atrium 自己的 Node 程序（例如测试或脚本里再起一个宿主）用 `process.execPath` 启动，不通过 `npx` 或 `.bin` 里的脚本。
  - pi 不适用这条：宿主跑在 Electron 里时，`process.execPath` 是 Electron 本身。pi 用 `findPi` 找到的绝对路径直接启动，环境变量里的 PATH 取自登录 shell，不经过 shell 或 npx。
  - 宿主自己起的子进程走 `platform/` 的工具；pi 子进程由 pi 包管理（见上文"pi 包拿到宿主基础设施的方式"）。退出时都要清理到所有后代进程，不能只杀直接子进程（Paseo 踩过这个坑）。pi 的 bash 工具子进程各有自己的进程组，只杀 pi 的进程组会漏掉它们，做法见 roadmap M1.2。
- 这些方向由 oxlint 的 `no-restricted-imports` 按目录检查（`.oxlintrc.json`）：业务模块不能 import `server/`；`sync/`、`store/`、`platform/` 不能 import 任何业务模块或 `server/`；`packages/host/src` 不能 import `@atrium/client`（client 只给第 4 层测试用）。

### 桌面端怎么启动宿主

- 窗口：`titleBarStyle: "hiddenInset"`，红绿灯 `trafficLightPosition: { x: 12, y: 17 }`：14pt 的按钮中心离窗口顶部 24pt，和标签、侧栏开关对齐（2026-10-13 定；系统默认的位置中心在 18pt，高出 6pt）；`vibrancy: "sidebar"`、底色透明，侧栏透出 macOS 的侧栏材质；页面看到预加载脚本的桥（`window.atrium`）就把 `<html>` 标上 `data-material`，窗口底色和侧栏底色随之透明（[design-language · 阴影与材质](design-language.md#阴影与材质)，2026-10-13 定）。
- Electron 主进程用 `utilityProcess.fork` 启动宿主：宿主跑在 Electron 自带的 Node 里，用户不需要另装 Node 来跑宿主（pi 本身仍用系统里的 Node）。
- 宿主入口不依赖 Electron，`node packages/host/dist/main.js` 能单独运行，以后无界面运行用它。
- 窗口从固定的来源 `atrium://app/` 加载界面（2026-10-08 定）：主进程用 `protocol.handle` 把这个协议的请求转给宿主的静态文件服务，只把内容安全策略换成允许连接宿主端口的版本；WebSocket 仍连宿主的随机端口，宿主的 `Origin` 白名单里加上 `atrium://app`。宿主端口每次启动都不同，直接加载 `http://127.0.0.1:<端口>` 时页面来源跟着变，`localStorage` 里的客户端 id、折叠状态、草稿重启后就丢了；固定来源让它们保留下来。开发时页面来自 Vite 的固定端口，不受影响。
- 打包时宿主打成单个文件放进应用资源目录，避免只声明为 peerDependency 的包在 `app.asar` 里找不到（Paseo 踩过）。
- 本机打包（2026-10-11 定）：`pnpm package` 用 `@electron/packager` 生成 `apps/desktop/out/Atrium-darwin-<架构>/Atrium.app`，不依赖仓库和本机的 Node，可以拷进"应用程序"、拷给同一台机器上的别的账户。应用目录 `Contents/Resources/app/` 里是主进程和预加载脚本（`dist/`）、宿主单文件和登录程序（`host/`）、界面（`ui/`），没有 `node_modules`；应用图标是 `apps/desktop/assets/icon.icns`（[design-language · 标志](design-language.md#标志)）；主进程按 `app.isPackaged` 在这里找宿主和界面，没打包时在仓库里找。不用 asar：登录程序由系统 Node 运行，读不了 asar，宿主的静态文件服务也按真实路径检查文件。签名（Apple Silicon 上的程序必须带签名才能运行）用 `ATRIUM_CODESIGN_IDENTITY` 指定的证书，不设时退到 ad-hoc（2026-11-03 改）：签名决定 macOS 认不认得「同一个 app」，ad-hoc 的 requirement 是二进制的 cdhash、每打一次包就变，系统授过的「文稿」等权限随每次换装作废；证书签名的 requirement 是 bundle id 加证书，一次授权跨重装有效。都不公证：本机生成的文件没有隔离标记，Gatekeeper 不拦。开发版和打包版的应用名都是 Atrium，共用单实例锁和页面存储，同时只能开一个。

## 进程模型

- 宿主是独立的 Node 进程。桌面端由 Electron 启动宿主，宿主也可以脱离 Electron 单独运行。
- 每个会话对应一个 pi 子进程（RPC 模式），理由见 [ADR-0002](../adr/0002-connect-pi-via-rpc-subprocess.md)。多个会话可以并行运行。
- 会话属于工作区：工作区是本地项目目录或一个 git worktree，与目录一一对应；pi 子进程以工作区目录为工作目录。worktree 由宿主创建和清理。不绑定工作区的"对话"各有一个独立的空目录（`~/.atrium/chats/<id>/`）作为工作目录。
- pi 崩溃不影响宿主和 UI，适配器负责重启和报错。

## 网络与鉴权

- 监听地址可配置，默认只监听本机。
- 连接时校验 token。
- 远程访问（手机）经用户自己的 relay：宿主主动出站连接，宿主仍只监听本机；手机和宿主之间用 Noise IK 端到端加密，经 Noise 认证的已配对设备算已鉴权，不用 token（[ADR-0016](../adr/0016-remote-access-through-own-relay-with-noise.md)，2026-10-24 定；原先定的是 Tailscale、不自建 relay）。

## 数据归属

- **对话历史归 pi**：存在 pi 自己的会话文件里。
- **Atrium 只存索引**：项目、工作区、打开着的标签页、会话归档状态等元数据，不复制 transcript。
- **插件状态跟随会话分支**：见 [插件模型](plugin-model.md)。

## 边界

- UI 和客户端层**只依赖 Atrium 协议**，不直接依赖 pi 的类型。将来接入其他 harness 时，在 `pi` 包旁边新增一个适配器包，宿主改为依赖它；现在不为此预先定义通用接口。
- 手机端的 SwiftUI App 不复用 `client` 和 `ui`；协议只在 `protocol` 里定义，Swift 的类型由它导出的 JSON Schema 生成（[ADR-0015](../adr/0015-native-ios-app-in-swiftui.md)，2026-10-24 定；原先设想原生 App 复用 `protocol` 和 `client`、只重写 UI）。

### MP4 手机记录写入权威（2026-10-26 审查后补）

App 只组装一个共享 `HostStore` 引用；配对投影、新 sheet 和 `RemoteConnection` 均注入该实例，不能各建 wrapper 后各自加锁却访问同一 service。HostStore 是进程内记录版本和同步钥匙串写入的唯一权威，host/pending 独立换代，旧异步任务凭原 claim 才能确认或清理；锁内没有 await/UI 回调。设备密钥首次创建同样串行，生产钥匙串工作从非 MainActor 执行。

`storageIssue` 是独立的最新状态，不是无界事件日志：认证撤销决定网络状态，存储失败决定本地记录是否仍需清理，两者不混为成功。受控重试只保留当前内存操作，不引入持久队列或改动钥匙串格式。详细条件和重启限制见 SPEC-0005「MP4 审查后补：手机记录写入所有权与失败恢复」。
