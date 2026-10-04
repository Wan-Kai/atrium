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
│   │   │   ├── catalog/            PiCatalog：模型、推理档位、`/` 命令
│   │   │   ├── oneshot/            OneShotPi：`pi --mode json -p --no-session` 的调用和输出解析
│   │   │   ├── auth/               登录状态检查、OAuth、API Key
│   │   │   └── locate/             找到 pi、检查版本
│   │   └── fixtures/               第 3 层录制的夹具，标注 pi 版本
│   ├── host/                       宿主：Atrium 自己的业务
│   │   ├── src/
│   │   │   ├── main.ts             startHost：组装依赖、启动；不依赖任何 Electron API
│   │   │   ├── entry.ts            进程入口：在 Electron 子进程里从 parentPort 收配置，或单独运行时读环境变量
│   │   │   ├── server/             WsServer、Connection、鉴权、命令路由
│   │   │   ├── store/              IndexStore：~/.atrium 读写、原子写入、格式版本
│   │   │   ├── projects/           ProjectService
│   │   │   ├── workspaces/         WorkspaceService、MergeInspector、git 调用（并发上限 4）
│   │   │   ├── sessions/           SessionManager、SessionCatalog（按记录的容器或 cwd 归类）、
│   │   │   │                       SessionController、SessionRuntime、PromptQueue、PendingInteraction、
│   │   │   │                       Attention、计时与指标
│   │   │   ├── transcript/         SessionLog（日志条目树、叶子、当前分支）、TranscriptProjection
│   │   │   ├── status/             会话状态、工作区和项目的汇总（纯函数）
│   │   │   ├── sync/               列表集合（generation+seq）、对话记录分页（epoch+seq）
│   │   │   ├── setup/              SetupService、安装和登录任务
│   │   │   ├── titles/             TitleGenerator：标题的提示词、截断和写回规则
│   │   │   ├── files/              FileSearch（`@` 引用的候选文件）
│   │   │   └── platform/           登录 shell 的 PATH、Clock、日志、子进程工具
│   │   └── test/harness.ts         第 4 层测试用的宿主：起真实宿主，用 client 连上去
│   ├── client/                     客户端层：不依赖 DOM，也不依赖 React
│   │   └── src/
│   │       ├── connection/         WebSocket、握手、心跳、重连
│   │       ├── stores/             IndexView、SessionView、布局（zustand/vanilla；布局镜像宿主上按客户端记录的标签页）
│   │       ├── sync/               应用快照和增量、补缺口、epoch 变化时整段替换、clientMessageId 对齐（纯函数）
│   │       ├── selectors/          收件箱等派生数据
│   │       └── index.ts            AtriumClient：对外只暴露 store 和命令方法
│   ├── ui/                         React 界面
│   │   └── src/
│   │       ├── app/                根组件、整体布局、首次启动和主界面的切换、全局快捷键
│   │       ├── state/              把 client 的 store 包成 hooks；ViewState（草稿、展开、滚动，存 localStorage）
│   │       ├── design/             设计变量（CSS）、弹簧曲线、点阵、图标封装、字体
│   │       ├── components/ui/      shadcn 生成的基础组件
│   │       └── features/
│   │           ├── sidebar/        侧栏、收件箱、搜索、项目与工作区
│   │           ├── tabs/           标签栏、历史
│   │           ├── transcript/     消息流、过程、步骤、diff、Streamdown、平滑揭示、提问导航条
│   │           ├── composer/       输入框、胶囊条、@ 和 /、模型与推理强度
│   │           ├── status-bar/     状态栏、分组注册表、自定义面板
│   │           ├── interactions/   extension 对话框卡片
│   │           ├── onboarding/     首次启动
│   │           └── settings/       设置页
│   └── testkit/                    测试工具：不依赖任何内部包（最多依赖 protocol），只出现在 devDependencies
│       └── src/
│           ├── faux/               faux 模型：交给 pi 加载的 extension、回复脚本格式、启动参数
│           ├── fake-pi/            回放夹具的 PiProcess 替身（按结构类型匹配 pi 包的接口，不 import 它）
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

MVP 2 的内置 pi extension 以后放在根目录的 `extensions/`，现在不建。

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
| desktop | 不 import host 和 ui 的代码 | — | 只知道构建好的宿主入口路径，窗口加载宿主提供的页面 |
| testkit | protocol | 其他内部包；被生产代码依赖 | 避免和被测包形成循环依赖；knip、oxlint 检查 |

- **faux extension 的例外**：`packages/testkit/src/faux/extension.ts` 可以 import `@earendil-works/pi-ai`。我们的代码从不加载它，它只作为文件路径交给 pi 进程（`--extension`），由 pi 自己加载执行，import 也由 pi 解析到它自带的 pi-ai；testkit 声明的同版本 pi-ai 开发依赖只用于类型检查。oxlint 只对这一个文件放开限制。放在 testkit 而不是 pi 包，是因为 pi 契约测试、宿主集成测试和端到端测试都要用它。

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
    /** 启动 pi 用的环境变量，其中 PATH 来自登录 shell。 */
    env: Readonly<Record<string, string>>;
  }
  ```

  pi 包不 import OpenTelemetry、pino 或 host 的任何模块；它自己管 pi 子进程的进程组和退出清理。测试时 testkit 提供同形状的假实现。

### 宿主内部的依赖

只能从左往右依赖：

```
server → sessions → transcript、status、pi
       → workspaces、projects、setup、titles、files
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

- Electron 主进程用 `utilityProcess.fork` 启动宿主：宿主跑在 Electron 自带的 Node 里，用户不需要另装 Node 来跑宿主（pi 本身仍用系统里的 Node）。
- 宿主入口不依赖 Electron，`node packages/host/dist/main.js` 能单独运行，以后 PWA 和无界面运行都用它。
- 打包时宿主打成单个文件放进应用资源目录，避免只声明为 peerDependency 的包在 `app.asar` 里找不到（Paseo 踩过）。打包在 v0.1 之后，这里先定方向。

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
