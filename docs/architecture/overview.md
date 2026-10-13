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

2026-10-04 定，经 GPT-6-Astra 评审后调整。新增或挪动模块时先改这里。

```
atrium/
├── apps/
│   └── desktop/                    Electron 外壳：只负责启动宿主和开窗口
│       ├── src/main/               主进程：启动宿主、窗口、菜单、用系统浏览器开外链
│       ├── src/preload/            把宿主地址和 token 交给 UI
│       └── e2e/                    第 6 层端到端测试；heap.ts 取堆快照、比较脱离文档的 DOM 节点
├── packages/
│   ├── protocol/                   宿主和客户端之间的协议（zod），只放线上传输的东西
│   │   └── src/
│   │       ├── ids.ts              prj_ / wks_ / 会话 id 的品牌类型
│   │       ├── entities/           线上实体：项目、工作区、会话摘要，对话记录的轮、步骤、系统事件，
│   │       │                       待交互，指标，上下文分段
│   │       ├── commands/           按领域分文件：projects、workspaces、sessions、run、catalog、setup
│   │       ├── events/             同上
│   │       ├── sync.ts             generation+seq、epoch+seq、游标、快照或增量的信封
│   │       └── version.ts          协议版本，握手时用
│   ├── pi/                         pi 集成：pi 的格式和协议只出现在这里
│   │   ├── src/
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
│   │   │   ├── fast/               Fast：哪些模型支持的规则，和交给 pi 加载的扩展（ADR-0008）
│   │   │   └── locate/             找到 pi 和它用的 Node、检查版本；找到 `@` 用的 fd
│   │   ├── fixtures/               第 3 层录制的夹具，`pi-<版本>/<场景>.jsonl`
│   │   └── test/contract.ts        跑契约场景并录制或检查夹具（场景在 `src/contract/`）
│   ├── host/                       宿主：Atrium 自己的业务
│   │   ├── src/
│   │   │   ├── main.ts             startHost：组装依赖、启动；不依赖任何 Electron API
│   │   │   ├── entry.ts            进程入口：在 Electron 子进程里从 parentPort 收配置，或单独运行时读环境变量
│   │   │   ├── dev/                开发用命令：`pnpm pi:try`（用宿主的组件驱动真实 pi，终端里看流式输出）
│   │   │   ├── server/             WsServer、Connection、鉴权、命令路由、上传图片的暂存（按连接）
│   │   │   ├── store/              ~/.atrium：索引文件（原子写入、格式版本与迁移、损坏挪开）、各文件的格式、
│   │   │   │                       宿主单实例锁、偏好、插话记录
│   │   │   ├── projects/           ProjectService：项目与工作区的登记（projects.json）
│   │   │   ├── workspaces/         WorkspaceService（worktree 扫描、后台 fetch）、MergeInspector
│   │   │   ├── sessions/           SessionManager、SessionCatalog（按记录的容器或 cwd 归类）、布局、
│   │   │   │                       列表命令、SessionController、SessionRuntime、PromptQueue、
│   │   │   │                       PendingInteraction、Attention、计时与指标
│   │   │   ├── transcript/         SessionLog（日志条目树、叶子、当前分支）、TranscriptProjection
│   │   │   ├── status/             会话状态、工作区和项目的汇总（纯函数）
│   │   │   ├── sync/               订阅表、列表推送（M1.5 整份快照，M1.9 加 generation+seq 增量）
│   │   │   ├── setup/              Toolbox（找到的工具，可重新检测）、SetupService、安装和登录任务
│   │   │   ├── titles/             TitleGenerator：标题的提示词、截断和写回规则
│   │   │   ├── files/              FileSearch（`@` 引用的候选文件：调 fd，按 pi 终端界面的规则打分）
│   │   │   ├── changes/            ChangesService（工作区的 git 改动：胶囊上的合计、改动面板的 diff，监听有人看的工作区）
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
│   │       ├── tabs/               标签栏、历史和会话菜单
│   │       ├── chat/               对话区：消息流、过程、步骤、diff、Streamdown、平滑揭示、提问导航条、输入框
│   │       ├── test/               浏览器测试用的假客户端
│   │       └── 以后：status-bar/、interactions/、onboarding/、settings/
│   └── testkit/                    测试工具：不依赖任何内部包（最多依赖 protocol），只出现在 devDependencies
│       └── src/
│           ├── faux/               faux 模型：交给 pi 加载的 extension、回复脚本格式、启动参数
│           ├── pi-fixtures/        夹具的格式、规范化、录制、比较，以及回放夹具的 PiProcess 替身（按结构类型匹配 pi 包的接口，不 import 它）
│           ├── shared-executable.ts 测试用可执行文件按内容只写一份并预热（见 testing.md"测试里的可执行文件"）
│           ├── scripted-pi.ts      按脚本行为的 pi 可执行替身（乱序回应、崩溃、不理 SIGTERM、留下孙进程），pi 包和宿主的测试共用
│           ├── clock.ts            假时钟
│           ├── present.ts          测试里取必然存在的值，避免测试体里出现 `??`
│           ├── bench.ts            基准与本机基线比较
│           ├── temp-dir.ts         临时目录（以后扩展成临时 HOME、~/.atrium、pi 会话目录）
│           └── git.ts              造 git 场景：merge、squash、rebase、cherry-pick、worktree
├── scripts/                        开发辅助：dev.mjs、trace.mjs、lint/atrium-plugin.mjs（JSDoc 规则）；以后的录制夹具
├── docs/
└── 根目录配置：pnpm-workspace.yaml、tsconfig.base.json、vitest.config.ts、vitest.mutation.config.ts、
               stryker.config.mjs、.oxlintrc.json、.oxfmtrc.json、knip.json、lefthook.yml
```

MVP 2 的内置 pi extension 以后放在根目录的 `extensions/`，现在不建。M1.11 的 Fast 扩展不是插件（没有视图、不按 pi package 发布），它的规则宿主也要用，所以放在 `packages/pi/src/fast/`（ADR-0008）。

### 包之间的依赖

```
protocol  ←──  pi  ←──  host
    ↑
    └──────  client  ←──  ui
```

| 包 | 可以依赖 | 不允许 | 怎么强制 |
|---|---|---|---|
| protocol | zod | 任何内部包 | package.json 没声明，pnpm 就不让 import |
| pi | protocol（只用对话记录相关的实体，不碰命令和同步信封） | DOM、其他内部包 | 唯一能 import `@earendil-works/*` 的包，其他包由 oxlint `no-restricted-imports` 禁止（唯一例外见下文 testkit 的 faux extension） |
| host | protocol、pi | DOM、client（生产代码）、ui、Electron | tsconfig 的 `lib` 不含 DOM；oxlint 禁止 `packages/host/src` import `@atrium/client`（client 只作第 4 层测试的开发依赖） |
| client | protocol、zustand | DOM、React | tsconfig 不含 DOM，oxlint 禁止 import react |
| ui | client、protocol（只用类型） | host、pi | 没有声明依赖 |
| desktop | 不 import host 和 ui 的代码 | — | 只知道构建好的宿主入口路径，窗口经 `atrium://app/` 加载宿主提供的页面 |
| testkit | protocol | 其他内部包；被生产代码依赖 | 避免和被测包形成循环依赖；knip、oxlint 检查 |

- **faux extension 的例外**：`packages/testkit/src/faux/extension.ts` 可以 import `@earendil-works/pi-ai`。我们的代码从不加载它，它只作为文件路径交给 pi 进程（`--extension`），由 pi 自己加载执行，import 也由 pi 解析到它自带的 pi-ai；testkit 声明的同版本 pi-ai 开发依赖只用于类型检查。oxlint 只对这一个文件放开限制。放在 testkit 而不是 pi 包，是因为 pi 契约测试、宿主集成测试和端到端测试都要用它。

- **登录程序的例外**（2026-10-10 定）：`packages/pi/src/auth/` 里的登录程序由宿主交给系统 Node 运行，不被我们的进程加载。它按绝对路径 `import` 用户装的 pi 包（`dist/index.js`），用的是 pi 自带的依赖；只从 `@earendil-works/pi-coding-agent` 取类型（pi 包的开发依赖）。它只用 Node 能直接运行的写法（能被去掉的类型注解，不用 enum 等），因为系统 Node 直接运行源文件。

- **Atrium 自带的 pi 扩展**（2026-10-12 定，ADR-0008）：`packages/pi/src/fast/` 里的 Fast 扩展由 pi 加载（`--extension`），不被我们的进程加载。构建时连同它用到的规则打成一个文件 `fast-extension.mjs`，放在宿主旁边（和登录程序一样，所以应用不用 asar）；测试里直接加载源文件。它只从 `@earendil-works/pi-coding-agent` 取类型，运行时不 import pi 的任何东西。

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

### 宿主内部的依赖

只能从左往右依赖：

```
server → sessions → transcript、status、pi
                  → workspaces → projects
       → setup、titles、files
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

- 窗口：`titleBarStyle: "hiddenInset"`，`vibrancy: "sidebar"`、底色透明，侧栏透出 macOS 的侧栏材质；页面看到预加载脚本的桥（`window.atrium`）就把 `<html>` 标上 `data-material`，窗口底色和侧栏底色随之透明（[design-language · 阴影与材质](design-language.md#阴影与材质)，2026-10-13 定）。
- Electron 主进程用 `utilityProcess.fork` 启动宿主：宿主跑在 Electron 自带的 Node 里，用户不需要另装 Node 来跑宿主（pi 本身仍用系统里的 Node）。
- 宿主入口不依赖 Electron，`node packages/host/dist/main.js` 能单独运行，以后 PWA 和无界面运行都用它。
- 窗口从固定的来源 `atrium://app/` 加载界面（2026-10-08 定）：主进程用 `protocol.handle` 把这个协议的请求转给宿主的静态文件服务，只把内容安全策略换成允许连接宿主端口的版本；WebSocket 仍连宿主的随机端口，宿主的 `Origin` 白名单里加上 `atrium://app`。宿主端口每次启动都不同，直接加载 `http://127.0.0.1:<端口>` 时页面来源跟着变，`localStorage` 里的客户端 id、折叠状态、草稿重启后就丢了；固定来源让它们保留下来。开发时页面来自 Vite 的固定端口，不受影响。
- 打包时宿主打成单个文件放进应用资源目录，避免只声明为 peerDependency 的包在 `app.asar` 里找不到（Paseo 踩过）。
- 本机打包（2026-10-11 定）：`pnpm package` 用 `@electron/packager` 生成 `apps/desktop/out/Atrium-darwin-<架构>/Atrium.app`，不依赖仓库和本机的 Node，可以拷进"应用程序"、拷给同一台机器上的别的账户。应用目录 `Contents/Resources/app/` 里是主进程和预加载脚本（`dist/`）、宿主单文件和登录程序（`host/`）、界面（`ui/`），没有 `node_modules`；应用图标是 `apps/desktop/assets/icon.icns`（[design-language · 标志](design-language.md#标志)）；主进程按 `app.isPackaged` 在这里找宿主和界面，没打包时在仓库里找。不用 asar：登录程序由系统 Node 运行，读不了 asar，宿主的静态文件服务也按真实路径检查文件。只做 ad-hoc 签名（Apple Silicon 上的程序必须带签名才能运行），不公证：本机生成的文件没有隔离标记，Gatekeeper 不拦。开发版和打包版的应用名都是 Atrium，共用单实例锁和页面存储，同时只能开一个。

## 进程模型

- 宿主是独立的 Node 进程。桌面端由 Electron 启动宿主，宿主也可以脱离 Electron 单独运行。
- 每个会话对应一个 pi 子进程（RPC 模式），理由见 [ADR-0002](../adr/0002-connect-pi-via-rpc-subprocess.md)。多个会话可以并行运行。
- 会话属于工作区：工作区是本地项目目录或一个 git worktree，与目录一一对应；pi 子进程以工作区目录为工作目录。worktree 由宿主创建和清理。不绑定工作区的"对话"各有一个独立的空目录（`~/.atrium/chats/<id>/`）作为工作目录。
- pi 崩溃不影响宿主和 UI，适配器负责重启和报错。

## 网络与鉴权

- 监听地址可配置，默认只监听本机。
- 连接时校验 token。
- 远程访问（比如用手机访问）走 Tailscale 这类组网工具，不自建 relay。

## 数据归属

- **对话历史归 pi**：存在 pi 自己的会话文件里。
- **Atrium 只存索引**：项目、工作区、打开着的标签页、会话归档状态等元数据，不复制 transcript。
- **插件状态跟随会话分支**：见 [插件模型](plugin-model.md)。

## 边界

- UI 和客户端层**只依赖 Atrium 协议**，不直接依赖 pi 的类型。将来接入其他 harness 时，在 `pi` 包旁边新增一个适配器包，宿主改为依赖它；现在不为此预先定义通用接口。
- 将来做原生 App 时，复用 `protocol` 和 `client`，只重写 UI。
