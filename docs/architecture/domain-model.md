# 领域模型

> 状态：草案（第 3 版），覆盖 MVP 1（[SPEC-0001](../specs/0001-mvp1-single-session-chat.md)）涉及的全部概念。第 1 版经 Grok 4.7 与 GPT-6-Astra 两轮评审后重写；第 3 版又对照了 Paseo（`42806cd`）的实现和 pi 1.0.1（`4c6fb7c`）的源码，借鉴 Paseo 的 id、关注状态和同步设计。实施时以代码为准，字段随实现补全；概念或关系变了先改本文。

本文回答三个问题：Atrium 里有哪些"东西"、它们之间是什么关系；每样东西的数据以谁为准；多个会话、多个客户端、进程崩溃时状态怎样保持一致。

## 数据归属

| 归属 | 存在哪里 | 谁写 | 例子 |
|---|---|---|---|
| **pi** | `~/.pi/agent/sessions/` 下的会话文件、`~/.pi/agent/auth.json` | pi | 会话条目（对话、工具结果、系统消息、压缩检查点）、会话名、凭据 |
| **Atrium 索引** | `~/.atrium/`（宿主持有，文件布局见 §1"索引的存储"） | 宿主 | 项目和工作区登记、Atrium 建的会话属于哪个容器、工作区别名与起点提交、归档、关注状态、每个客户端的布局、偏好、插话记录 |
| **运行时** | 宿主内存 | 宿主 | pi 进程、排队、待交互请求、运行状态、当场计时、合并状态缓存 |
| **扫描结果** | 宿主内存（可随时重算） | 宿主 | 分支名、是否 git 仓库、worktree 创建时间、会话文件位置、第一条用户消息 |
| **视图** | 各客户端自己 | UI | 展开的过程、滚动位置、草稿 |

原则：

- 对话内容只在 pi 里有一份（[ADR-0006](../adr/0006-organize-sessions-by-workspace.md)）。能从 pi 或 git 推出来的，Atrium 只缓存，不写进索引。
- 每个字段只有一个可写来源。外观、状态栏分组是全局偏好；标签页、当前容器是某个客户端的布局；两者不混放。
- 只在宿主内存里的东西（排队、待交互请求、当场计时）宿主重启后丢失，界面显示"未知"或"—"，不假装恢复。

## 1. 项目、工作区、会话

```mermaid
classDiagram
    direction LR
    class Project {
      <<索引>>
      id  prj_随机
      path
      displayName
      mainBranchOverride?
    }
    class Workspace {
      <<索引 + 扫描>>
      id  wks_随机
      kind: local | worktree
      dir
      alias?
      baseCommit?
      external: bool
      archived?  归档时间、分支、提交，和一起归档的会话（M1.11；会话 2026-10-14 加，早先的没有）
      branch?  [扫描]
      createdAt  [扫描]
      name()  alias 或 branch 或目录名
    }
    class Chat {
      <<索引 + 扫描>>
      id  cht_目录名
      dir  ~/.atrium/chats/<目录名>  [扫描]
      alias?
      archived?  at + sessions + first，M1.11
      firstSessionId?  [扫描]
      name()  alias 或第一个会话的标题
    }
    class SessionContainer {
      <<interface>>
      id
      listSessions()
      dirForNewSession()
    }
    class Session {
      <<pi + 索引>>
      id  pi 的会话 id
      containerId?  [索引] Atrium 建的会话
      file?
      persistence: draft | persisted | missing
      cwd  文件头记录
      piName?
      firstPrompt?  [扫描]
      updatedAt
      archived: bool
      title()  piName 或兜底标题
    }
    class MergeState {
      <<运行时缓存>>
      dirty: bool
      ahead: int
      verdict: noChange | pending | merged | removed | unknown
      reason?
      observedAt
    }
    class ClientLayout {
      <<索引，按客户端>>
      clientId
      containerId
      openTabs: SessionId[]
      activeTab?
    }

    Project "1" *-- "1..*" Workspace : 登记记录，恰好一个 local
    SessionContainer <|.. Workspace
    SessionContainer <|.. Chat
    SessionContainer "1" -- "0..*" Session : 记录的容器，否则按 cwd
    Workspace "1" -- "0..1" MergeState : 仅 worktree
    ClientLayout "0..*" --> "1" SessionContainer
```

- **Project**、**Workspace** 的 id 是随机生成的不透明 id（`prj_…`、`wks_…`，参照 Paseo），路径只是一个可变字段，不当 id 用。
- **Project** 拥有的是登记记录：从侧栏移除项目只删 `~/.atrium/` 里的记录，不碰磁盘。路径规范化后唯一，已经是某个项目的 worktree 的目录不能再登记成项目。主干分支只存用户的覆盖值，显示时取 `mainBranchOverride ?? origin/HEAD`。
- **Workspace** 与目录一一对应。每个项目恰好一个 `local`（`dir == Project.path`），其余是 `worktree`。分支、创建时间是扫描结果，不进索引。
- **Chat** 是不绑定项目的"对话"，和工作区并列的容器，一个对话一个目录 `~/.atrium/chats/<目录名>/`，只是没有 git（[ADR-0007](../adr/0007-each-chat-is-its-own-container.md)，2026-10-12 改，取代原来全局一个的 ChatSpace）：
  - id 是 `cht_<目录名>`。目录由 Atrium 新建、名字随机（UUID），和会话 id 无关；宿主扫描 `~/.atrium/chats/` 的子目录得到对话列表，名字不合 id 格式的目录不算。用户删掉目录，对话就没了。
  - 对话里可以有多个会话，都以对话的目录为工作目录。终端里在对话目录开的 pi 会话按 `cwd` 归到这个对话。
  - `alias` 是自定义名称，存在 `chats.json`；`firstSessionId` 是对话里没归档的会话中最早建的一个（按索引记录的创建时间，没有记录的按文件修改时间），名称由界面按 `alias ?? 第一个会话的标题` 得出。
  - 所有会话都归档了的对话不在侧栏列出。
  - 归档对话（M1.11，2026-10-12 加）：`chats.json` 里记下归档时间、这次归档了哪些会话和当时的第一个会话（`archived: { at, sessions, first }`），恢复时只放回这些会话；协议里的对话只带 `archivedAt`。归档后对话里没有没归档的会话，`firstSessionId` 就用记下的 `first`，名称和归档前一样。
- **SessionContainer** 只表达"会话放在哪、怎么列、新会话在哪个目录建"。工作区和对话都对其中所有会话给同一个目录；新建对话时新建一个目录。标签页不在接口上，在 **ClientLayout**。
- **Session** 是逻辑会话，以 pi 的会话 id 为主键，文件路径只是可更新的定位：
  - `draft`：pi 已分配 id，但还没有用户消息，文件尚未写出；只能由宿主记住，扫描找不到。
  - `persisted`：文件存在。
  - `missing`：索引里有，扫描不到文件（被删除或移走）。
  - **归属**：Atrium 自己建的会话，创建时把所属容器记进索引（`containerId`），以后以它为准（参照 Paseo：创建时写定，不再推断）。终端里 pi 开的、Atrium 没见过的会话，才按文件头里的 `cwd` 归到对应目录的容器。这样既保留"终端会话自动归位"，以后"把对话移到项目"也只需改记录。
  - pi 恢复会话时用的是文件头里的 `cwd`；工作区目录被移走或删除时，恢复报"目录不存在"，不悄悄换目录。
  - 扫描到两个文件带同一个 id 时报告冲突，不自动合并。
- **MergeState** 由 MergeInspector 计算。`unknown` 带原因：git 低于 2.38、主干引用缺失、查询失败、外部 worktree 起点无法判断。合并判定按"分支提交 + 主干提交"缓存；`dirty` 和目录是否存在每次单独刷新。界面映射：`dirty` 优先显示"未提交"，否则 `verdict` 为 `pending` 且 `ahead > 0` 显示 `↑N`（squash 合并后分支仍比主干多提交，但已判定为已合并，不显示 `↑N`），再看 `verdict`。

### 索引的存储（2026-10-08 定）

索引按领域拆成几个 JSON 文件，写得频繁的（布局）和重要的（项目）分开，坏一个不影响别的：

```
~/.atrium/                    目录 0700，文件 0600（security.md）
├── host.lock                 宿主单实例锁：{ pid, startedAt }
├── projects.json             项目与工作区登记
├── chats.json                对话的自定义名称（2026-10-12 加）、归档（M1.11，v2）
├── sessions.json             Atrium 记录的会话：所属容器、工作目录、草稿、归档、关注状态、已交给终端（M1.9）、Fast（M1.11）
├── layouts.json              按客户端的布局：每个容器打开的标签页、当前标签；只留最近用过的 10 个客户端
├── preferences.json          全局偏好：外观、状态栏、网络代理……
├── turns/<会话 id>.json      插话记录：宿主当场看到的用户消息开启了新一轮还是插话（SPEC-0001"对话记录"）；
│                             随会话变长，单独放，不拖累其他文件
├── chats/<目录名>/           每个对话的工作目录，对话 id 由目录名得出
└── logs/
```

- **写入**：先写同目录下的临时文件并 fsync，再 rename 覆盖，最后 fsync 目录。同一个文件的写入串行；写入期间又有变化，当前这次写完后用最新内容再写一次，不排长队。
- **格式版本**：每个文件顶层带 `version`。只新增可选字段时不升版本（参照 Paseo）；读文件时保留不认识的字段，写回时原样带上，降级再升级不丢数据。
  - 版本比当前程序旧：先把原文件复制成 `<名字>.v<旧版本>.bak`，按迁移函数逐级升级，再写回。
  - 版本比当前程序新（装回了旧版 Atrium）：宿主拒绝启动，日志和标准错误里写明哪个文件、哪个版本。不降级改写，避免丢掉新版本的数据。v0.1 不发布安装包，这种情况只在开发时出现；界面上的提示等 M1.10 的启动检查再做。
- **损坏**：文件不是合法 JSON 或不符合格式时，改名为 `<名字>.corrupt-<时间>` 保留（不删），日志记一条（只记文件名和原因，不记内容），这个文件按空的重新开始，界面提示一次哪类数据被重置。原子写入下损坏基本只来自手改；丢了也能恢复：项目可以从 pi 历史重新发现，会话归属退回按 `cwd`，插话记录退回推断。缺失的文件按空的处理，不算损坏。
- **v2 迁移（2026-10-12，ADR-0007）**：`sessions.json` v1 → v2 把 `containerId` 为 `chats` 的记录改成它工作目录对应的对话 id（`cht_<目录名>`）；`layouts.json` v1 → v2 按迁移后的会话记录，把 `chats` 下打开着的标签页分到各自的对话，当前标签跟着去，别的对话以它的第一个标签为当前（2026-10-12 审查后补：不然点进去是空白），位置在 `chats` 的客户端换到当前标签所在的对话（没有当前标签就为空），找不到记录的标签去掉。所以先加载 `sessions.json` 再加载 `layouts.json`。
- **单实例**：Electron 用 `requestSingleInstanceLock`，第二次打开应用时聚焦已有窗口。宿主自己再拿 `host.lock`（独占创建）：锁被一个活着的宿主占着，宿主报错退出；记录的进程已经不在、或者那个进程号现在属于启动时间不同的另一个进程（进程号被复用，2026-10-08 审查后补），接管这把锁。接管先拿一把短暂的 `host.lock.takeover`（同样独占创建），拿到后再看一遍持有者，两个宿主同时接管同一把过期锁时只有一个能成。宿主也能单独运行，所以 Electron 的锁不够。宿主退出时只删内容仍是自己写的那把锁。设了 `ATRIUM_HOME`（测试、开发时的第二份）时，Electron 的用户数据目录改到 `$ATRIUM_HOME/electron`：单实例按 Atrium 的家目录区分，测试不会被正在用的 Atrium 挡住，页面存储也互不影响。
- **草稿会话的 id**：由宿主新建时生成，pi 用 `pi --session-id <id>` 启动，从此用这个 id（"已决定 9"）。草稿只在索引里，宿主重启后第一次发消息时同样用 `--session-id` 启动，沿用原来的 id（pi-internals §1）。草稿不能改名：pi 在第一条消息前不写文件，名字没有地方存（2026-10-08 定）。
- **插话记录的版本**：`turns/<会话 id>.json` 的版本比程序新时，这个会话照常打开，插话按位置推断，记录只读不写，日志记一条（2026-10-08 定）；不因为一个会话的附属文件拒绝启动整个宿主。
- **第一次扫描之前**：宿主刚启动、会话目录还没扫过时，不把记录里有、但还没找到文件的会话当成"文件不见了"，也不把它当空草稿丢弃。

## 2. 会话历史：条目、分支与对话记录

pi 的会话文件是一棵树：每个条目有 `id` 和 `parentId`，当前所在位置由 `leafId` 指出，分叉会产生新的分支。

```mermaid
classDiagram
    direction TB
    class SessionEntry {
      <<pi>>
      id  8 位十六进制，仅文件内唯一
      parentId?
      type
      timestamp
    }
    class LogEntry {
      <<pi 包输出，Atrium 形状>>
      key  会话 id + 条目 id
      parentId?
      kind
      timestamp
    }
    class SessionLog {
      <<宿主缓存>>
      entries: Map
      leafId
      cursor  最后收到的条目
      currentBranch()
    }
    class TranscriptProjection {
      <<派生>>
      items: TranscriptItem[]
      sourceEntryIds
    }
    class ContextBreakdown {
      <<派生，估算>>
      total?
      system?
      tools?
      messages?
      estimated: bool
    }
    class TranscriptItem {
      <<interface>>
    }
    class Turn {
      id
      user: UserMessage
      steps: Step[]
      reply?
      outcome: running | done | stopped | failed
      startedAt?
      duration?
    }
    class Notice {
      kind: compacted | extension
      raw?
    }
    class Step {
      <<interface>>
      status
    }
    class ThinkingStep
    class TextStep
    class ToolStep {
      tool
      callId
      args
      result?
      details?
    }
    class SteerStep
    class RetryStep {
      attempt
      error
    }
    class InteractionStep {
      interactionId
      question
      answer?
    }

    SessionEntry ..> LogEntry : pi 包 history 转换
    SessionLog "1" *-- "0..*" LogEntry
    SessionLog ..> TranscriptProjection : 按当前分支重建
    SessionLog ..> ContextBreakdown : 回放系统消息与检查点
    TranscriptProjection "1" *-- "0..*" TranscriptItem
    TranscriptItem <|.. Turn
    TranscriptItem <|.. Notice
    Turn "1" *-- "0..*" Step
    Step <|.. ThinkingStep
    Step <|.. TextStep
    Step <|.. ToolStep
    Step <|.. SteerStep
    Step <|.. RetryStep
    Step <|.. InteractionStep
```

- **LogEntry** 是 pi 包把 pi 条目转换后的形状（`packages/pi/src/history/`），保留 `id / parentId` 的树结构，宿主之后只处理它，不碰 pi 的原始格式；它只在宿主内部用，不进协议。系统消息（提示词分段、工具增减）和压缩检查点也转成对应的 LogEntry，供 ContextEstimator 回放。
- **SessionLog** 是宿主对日志条目的缓存，用 `get_entries(since)` 增量获取。它同时记两样东西：条目游标，以及当前分支叶子。`get_entries` 返回空时 `leafId` 仍可能变化，所以两者分开维护。
  - 条目 id 只在一个文件内唯一（克隆出的会话沿用原 id），跨会话一律用"会话 id + 条目 id"作键。
  - pi 不保存叶子，加载时取文件最后一条为叶子。
  - 切换模型、压缩、标签等写入的条目**不会发事件**。所以在 `agent_settled`、`compaction_end`、以及宿主自己发出的 `set_model` 等命令之后，主动再取一次 `get_entries(since)`，不只靠实时事件。
- **不用 `get_messages` 恢复历史**：它返回的是送给模型的上下文，压缩、上下文编辑之后旧消息可能已被摘要替换，会丢掉完整的对话、工具步骤和改动。
- **TranscriptProjection** 是给对话区看的投影：沿当前分支把条目组织成 Atrium 的"轮"。注意 pi 的 turn 是"一次助手响应及其工具执行"，比 Atrium 的一轮小；Atrium 的一轮 = 一条用户消息到下一条用户消息之间的全部内容。MVP 1 不展示会话树，但底层按树建模，以后加会话树、分叉不用重来。
- **ContextBreakdown** 给状态栏用，是估算值：总量来自 `get_session_stats().contextUsage`（可能为空或是估算）；系统提示词和工具定义沿当前分支回放系统消息与压缩检查点得出；没有系统消息的旧会话只显示总量。MVP 2 的上下文检查器要的是"每次实际发出的请求"，另由 extension 捕获，不从这里升级。
- **Notice** 里 `extension` 类型保留无法识别的 extension 通知原文，MVP 1 只记录不显示，MVP 2 的"带标记的通知"从这里接入。
- 自动重试发生在一轮中间，用 **RetryStep** 显示"正在重试（第 N / 3 次）"，不拆开这一轮；**Notice** 用来显示压缩和"进程已自动重启"（M1.6）。
- **InteractionStep** 只是对话记录里"问题 → 回答"的展示，活着的请求见下一节的 PendingInteraction。pi 不把对话框写进会话文件，所以这一步只在宿主存活期间存在。
- **ToolStep** 各自带状态，同一批里的工具调用可以并行，不假设前一个结束后一个才开始。
- **改动汇总**不建类，语义是"已观测到的工具修改"：`edit` 有 diff，显示增删行；`write` 显示写入内容（取自调用参数，pi 的结果里没有），增删行未知时不显示数字；通过 bash 等其他方式的改动统计不到。多次编辑同一文件是累计编辑量，不是净改动。
- **重建时要注意的条目**（2026-10-08 按 pi 1.0.2 源码核实）：
  - 切换模型和推理强度、标签、会话名、缓存预热的用量、extension 状态、上下文编辑都在父子链上，也会移动叶子；重建时跳过，不当成轮的边界。系统消息是 `message` 条目，同样不进轮。
  - 失败后被重试的回复：出错的助手消息后面跟着一条 `context_edit`（`replacement` 为空）把它从上下文里去掉，重试的回复挂在这条编辑下面。在它之后加一个 RetryStep（"正在重试"），它已输出的部分（通常没有）照常是步骤，不作为回复。上下文溢出的恢复不同：pi 屏蔽失败的回复（和它的工具结果）后紧接着写压缩条目，再重试，不发自动重试事件，所以这种情况只有压缩提示条，没有 RetryStep。
  - 压缩条目排在它总结的条目之后，链条不断，压缩前的条目照常重建，压缩处显示提示条；`firstKeptEntryId` 可能落在一轮中间。
  - 插话和追加消息在文件里都是普通的用户消息，没有任何标记。宿主当场看到的用户消息记下"开启新的一轮"还是"插话"，重建以记录为准（随轮的当场数据存放，M1.5 起持久化）；没有记录的，紧跟在工具结果之后、下一次模型回复之前的算插话（SteerStep），其余开始新的一轮。运行停在工具结果上（工具要求结束本轮、pi 崩溃）时这条推断会把下一轮并进来，只影响没有记录的历史。
  - 用 skill 开头的消息，pi 存成 `<skill name="…" location="…">正文</skill>` 加参数。pi 包认出这个格式，用户消息记成"skill 名 + 参数"（`command`），正文不进对话记录；认不出的照原文。模板在 pi 里就展开了，存的是全文，不认（M1.11，SPEC-0001"M1.11 的 `/` 命令"）。
  - 工具结果按调用 id 配对，不按位置；一轮结束后仍没有结果的工具调用显示为"未完成"。
  - 可能有多个根（`branch_summary` 的父为空）；叶子用 `get_entries` 返回的 `leafId`，不用最后一条。会话被 fork 或 clone 成新文件时，缓存全部作废。
  - 实时事件不带条目 id。轮在实时时由宿主编号，运行结束后按顺序对应到新的用户消息条目并沿用实时编号，见 SPEC-0001"对话记录"。

## 3. 会话运行：控制器、运行状态、排队、待交互

```mermaid
classDiagram
    direction TB
    class SessionManager {
      open() create() find()
      closeTab() handOff() takeBack() archive()
    }
    class SessionController {
      submit() steer() stop()
      resume() clearQueue()
      answer() setModel()
      snapshot()
    }
    class SessionRuntime {
      <<状态>>
      processEpoch
      seq
      lifecycle: initializing | idle | running | error | closed
      stopping: bool
      attention?: Attention
      restartAttempts
      model: ModelRef
      thinking
    }
    class PiAdapter {
      <<pi 集成>>
      spawn() send() kill()
    }
    class PiProcess {
      pid
      epoch
      lastUsedAt
    }
    class PromptQueue {
      items: QueuedPrompt[]
      paused: bool
    }
    class QueuedPrompt {
      id
      text
      attachments
      mode: prompt | steer
      submission: waiting | sent | started | queuedInPi | handled | delivered | failed
    }
    class PendingInteraction {
      id
      processEpoch
      kind: select | confirm | input | editor
      question
      options?
      deadline?
      state: pending | answered | timedOut | stale
      answeredBy?
    }
    class Attention {
      <<索引>>
      reason: error | auth | finished
      detail?
      at
      cleared: bool
    }
    class LiveTiming {
      <<宿主观测>>
      ttftAverage?
      lastTps?
      modelTime
    }
    class PiStats {
      <<来自 pi>>
      turns
      steps
      fileUsage
      cost
      contextUsage?
    }
    class EntryUsage {
      <<宿主从条目算>>
      branchUsage
      reasoning?
      systemTokens?
      toolTokens?
    }

    SessionManager "1" *-- "0..*" SessionController
    SessionController "0..1" --> "1" Session
    SessionController "1" *-- "1" SessionRuntime
    SessionController "1" *-- "1" PiAdapter
    PiAdapter "1" *-- "0..1" PiProcess
    SessionRuntime "1" *-- "1" PromptQueue
    PromptQueue "1" *-- "0..*" QueuedPrompt
    SessionRuntime "1" *-- "0..*" PendingInteraction
    SessionRuntime "1" *-- "1" SessionLog
    SessionRuntime "1" *-- "1" LiveTiming
    SessionRuntime "1" *-- "1" PiStats
    SessionRuntime "1" *-- "1" EntryUsage
    SessionRuntime "1" o-- "0..1" Attention
```

**职责**

- **SessionController** 管行为，是一个会话唯一的协调者；**SessionRuntime** 是它唯一持有的状态，不是第二个管理者。排队、待交互、条目缓存、指标都在 Runtime 里；进程句柄在 PiAdapter 里。一个会话最多一个 Controller。
- **Controller 跨过 pi 的重启**（2026-10-09 定，M1.6）：一个会话从第一次启动 pi 起只有一个 Controller；pi 退出后再启动（崩溃自动重启、重新打开、"重试"）时，Controller 换上新进程（`processEpoch + 1`，推新的快照），排队、重启计数、连续失败留在 Runtime 里，不随进程丢失。M1.5 及以前是每个进程一个 Controller。
- **SessionManager** 负责 Controller 的创建、查找，以及几种"离开"动作。
- **生命周期**沿用 Paseo 的划分：`initializing`（进程启动中）、`idle`、`running`（从提交到 `agent_settled`，含自动重试和压缩）、`error`（进程异常退出或运行失败）、`closed`（有记录、没有进程，比如宿主重启后还没打开过）。
- **MVP 1 不回收空闲进程**（与 Paseo 一致）：会话一旦打开，pi 进程就常驻，直到归档、交给终端、宿主退出或进程崩溃。以后会话多了再加回收。

**几种"离开"分开命名**

| 动作 | 做什么 | 不做什么 |
|---|---|---|
| 关闭标签 `closeTab` | 只改这个客户端的 ClientLayout | 不停运行、不动排队和进程 |
| 停止 `stop` | 宿主先暂停出队，再对 pi `clear_queue` → `abort`；排队保留并暂停。`abort` 2 秒内没确认停下，就保持 `stopping`，拒绝新的提交、切换模型等写操作，直到确认或进程退出（参照 Paseo，避免状态分裂） | 不关进程 |
| 归档 `archive` | 记归档标记，关掉进程，丢掉 Controller（工作区或项目移除时，其中的会话也一样丢掉 Controller） | 不删 pi 的会话文件 |
| 打开 `open` | 对 `closed` 的会话以 `--session` 启动进程（`processEpoch + 1`），重建 SessionLog | 不自动重放结果未知的上一条输入 |
| 交给终端 `handOff` | 停止接受这个会话的写命令，关掉进程（进入 `closed`），在索引里记下交接（宿主重启后仍在），给出 `pi --session <文件>`；回来时由用户点"在 Atrium 里继续"（`takeBack`）重新打开，切到标签不自动启动 pi（2026-10-10 定） | Atrium 与终端不同时写同一个会话；运行中、排队里还有消息时不交接 |

**排队与提交**

- 发出一条输入后，pi 的回应有三种：`started`（启动了运行）、`queued`（运行中被 pi 排进去）、`handled`（被 extension 命令或输入处理器消费，没有运行）。`handled` 视为这条输入已完成，可以出队下一条，不等 `agent_settled`。
- `agent_settled` 只表示"不会再自动继续"，本轮是成功、失败还是被停止，看实际事件单独判断。
- 停止和 `agent_settled` 触发的出队由 Controller 串行处理，避免停止的同时又发出下一条。
- pi 的 `clear_queue` 只清 pi 自己的队列，宿主的排队由 `clearQueue` / `resume` 单独操作。
- 正在压缩时 pi 的 `prompt` 会直接报错：压缩期间出队暂停，等 `compaction_end` 后再发。
- pi 的 `queue_update` 每次带完整的 pi 内部队列（已调用 `steer` 还没送达的插话），宿主用它确认插话是否送达。
- 提交状态的命名对齐 pi 实验版服务端的设计：排队中 → 已发出 → 已放入 / 被处理 → 完成 / 失败；`requestId` 用来去重。

**待交互请求**

- extension 的对话框（`extension_ui_request`）可能出现在一次运行之外，所以由 Runtime 持有，不挂在某一轮上；对话记录里的 InteractionStep 只是展示。
- 进程退出时，旧请求一律标记为 `stale`。多个客户端同时回答，只接受第一次有效提交，其余收到"已被回答"。
- MVP 1 只保证宿主存活期间保留"问题 → 回答"；要跨重启保留，需要写入 pi 的条目，以后再说。

**进程崩溃**

统一处理：排队暂停（已调用 `steer` 但未确认送达的插话退回排队），待交互请求作废，发 `session_exited`；然后按"已决定 6"自动重启，最多连续 3 次；一次运行正常结束（`agent_settled` 且没有失败）后连续计数归零（2026-10-09 定）。3 次都失败才进入 `error`、设上关注状态（原因 `error`）。

**指标的范围**

- **PiStats** 来自 `get_session_stats`，统计的是整个会话文件（含其他分支和压缩消耗），与当前分支上各轮相加不等；上下文用量可能为空或是估算。界面上区分"本会话累计"和"当前分支"，未知值显示"—"。
- **LiveTiming** 是宿主当场测的（TTFT、输出速度、模型用时），宿主存活期间保留，重启后显示"—"。从历史时间戳推算的每轮用时是近似值。
- **EntryUsage** 是宿主从条目算的：当前分支的用量、推理 token（pi 的统计没有）、上下文里系统提示词和工具定义的估算（SPEC-0001"状态栏（M1.8）"）。
- 状态栏的"轮""步"按整个会话文件数，照 pi 的 `userMessages`、`toolCalls`（插话也算一轮）；"步"只数工具调用（2026-10-10 定）。

## 4. 状态的派生

```mermaid
classDiagram
    direction LR
    class SessionStatus {
      <<派生>>
      approval | answer | auth | error | running | idle
    }
    class Attention {
      <<索引>>
      reason: error | auth | finished
      detail?
      at
      cleared: bool
    }
    class InboxEntry {
      <<派生>>
      session
      container
      status
      since
    }
    class WorkspaceSummary {
      <<派生>>
      topStatus
      merge
    }
    class ProjectSummary {
      <<派生>>
      topStatus
      pendingWorktrees
    }
    SessionRuntime ..> SessionStatus
    Attention ..> SessionStatus
    SessionStatus ..> InboxEntry
    Attention ..> InboxEntry : 未清除的才进收件箱
    SessionStatus ..> WorkspaceSummary
    WorkspaceSummary ..> ProjectSummary
```

- **Attention（关注状态）** 参照 Paseo 的设计，持久化在索引里，按"边沿"设上：运行失败（pi 的重试用尽）或连续崩溃用尽时设 `error`，失败原文像认证问题时设 `auth`，以后"不在看时跑完"设 `finished`（即已完成未读）；下一次运行开始时去掉。某个客户端显示该会话时把 `error` 标为已清除；`auth` 看了不算，要等下一次运行开始。下一次事件会重新设上，旧的清除不会吞掉新的失败。打开会话、恢复进程不改它（SPEC-0001"并行、同步与关注"）。
- **SessionStatus** 按优先级取第一个成立的：待审批（MVP 2）、待回答（有 `pending` 的 PendingInteraction，只在内存）、待授权（关注原因为 `auth`）、出错（关注原因为 `error`，直到下一次运行开始，不论是否已清除）、运行中、空闲。
- **出错图标与收件箱分开**：出错图标看"上一次运行是否失败"，一直显示到下一次运行；收件箱只收关注状态未清除的会话，以及正在等回答的会话。
- **InboxEntry** 带上所在容器，界面才能显示"项目 · 工作区"或"对话 · 对话名"。
- **工作区汇总**由界面从会话摘要算出：取工作区内没归档的会话状态的最高优先级（参照 Paseo 的 `deriveAgentStateBucket`）。2026-10-10 改，原先打算由宿主计算：客户端本来就有全部摘要，算法只有一处；SessionStatus、InboxEntry、ProjectSummary 同样在界面派生。
- **会话标题** `piName ?? 第一条用户消息的第一行`；**工作区名** `alias ?? branch ?? 目录名`；**对话名** `alias ?? 第一个会话的标题`，第一个会话还是草稿时为"新对话"。

## 5. 模型、设置与首次启动

```mermaid
classDiagram
    direction LR
    class ModelRef {
      providerId
      modelId
    }
    class Provider {
      <<pi>>
      id
      name
      authMethods: oauth, apiKey
      credential: none | present | invalid
    }
    class Model {
      <<pi>>
      ref: ModelRef
      contextWindow
      maxOutput
      supportsImage
      thinkingLevels: string[]
      fast?: speed, moreUsage
    }
    class PiCatalog {
      <<宿主，不隶属会话>>
      providers()
      models(dir)
    }
    class Preferences {
      <<索引，全局>>
      setupDone
      appearance
      statusBar: StatusGroupId[]
      lastModel: ModelRef?
      thinkingByModel
      lastFast
      titleModel: ModelRef?
    }
    class StatusGroup {
      <<注册表>>
      id
      name
      defaultVisible
      summary(stats)
      detail(stats)
    }
    class SetupState {
      <<运行时>>
      pi: missing | broken | outdated | ready
      piLatest: version?
      node: missing | outdated | ready
      homebrew: bool
      fd: bool
      login: unavailable | providers
      projects: count
    }
    class InstallJob {
      kind: pi | update | node
      state: waiting | running | ok | failed | cancelled
      output
    }
    class LoginJob {
      providerId
      method: oauth | apiKey
      state: running | ok | failed | cancelled
      authUrl?
      deviceCode?
      questions
    }
    PiCatalog ..> Provider
    PiCatalog ..> Model
    Provider "1" -- "0..*" Model
    Model ..> ModelRef
    Preferences ..> StatusGroup
    SetupState ..> InstallJob
    SetupState ..> LoginJob
```

- **ModelRef** 用"服务商 + 模型 id"联合标识。推理档位是字符串列表，来自 pi 对该模型的能力查询（pi 的档位包括 off / minimal / low / medium / high / xhigh / max，具体有哪些由模型决定），推理强度框按实际档位数画格子。
- **Provider** 区分"支持哪些登录方式"和"当前凭据状态"，有凭据不等于登录有效。
- **PiCatalog** 不依赖任何会话进程：空工作区、首次启动、模型按钮都要用。照 Paseo 的做法，按目录短启一个 pi 查 `get_available_models` 和 `get_state`，结果按目录缓存在内存里，只有"刷新"才重查；推理档位按模型元数据算出（SPEC-0001"模型与输入框"，2026-10-10 定）。`/` 命令不归它：每个会话问自己的 pi，没启动就启动（2026-10-10 定，原先打算按目录短启 pi 查询）。
- **Preferences** 的 `lastModel` 和 `thinkingByModel`（推理强度按模型各记一份）在任何会话里换模型或推理强度时更新；新会话启动 pi 后由宿主用 `set_model`、`set_thinking_level` 设上，不用 `--model` 启动（pi 解析不出 `--model` 会直接退出）。
- **Fast**（M1.11，ADR-0008）：开关属于会话，记在会话的记录里（`fast`），Runtime 里也有一份，随快照发出；`lastFast` 在任何会话里开关时更新，没有记录的会话按它取。模型支不支持 Fast 是 Model 的 `fast`（速度倍数和是否多耗额度，不支持为空），取自 Codex 的模型列表，查不到时按 `packages/pi` 的内置规则。开关经 Atrium 自带的 pi 扩展生效，pi 每次启动后由宿主补发。
- **没有可用模型时 pi 的 RPC 模式照常启动**，只是模型是占位的 `unknown/unknown`、`prompt` 报错（2026-10-10 实测，原先以为会直接退出），登录状态不适合靠 RPC 查：首次启动用 `pi auth check --json`，或在锁下读 `~/.pi/agent/auth.json`。RPC 也没有登录命令，登录由宿主用系统 Node 运行 `packages/pi` 的登录程序，它加载用户装的 pi 包里的 `ModelRuntime` 完成（2026-10-10 验证并定，SPEC-0001"第 2 步"）；登录状态也由它一次查齐，不必按服务商逐个运行 `pi auth check`。
- **LoginJob**、**InstallJob** 是可查询、可取消的任务。LoginJob 运行中可能同时有授权地址、设备码和 pi 正在问的问题（`questions`：输入框、密码框、选择框或粘贴回调地址，文字是 pi 的原文）；有授权地址时同时等本机回调和用户粘贴的回调地址，哪个先到用哪个，另一个由 pi 撤回。更新 pi 时 InstallJob 先处于 `waiting`，等 SessionManager 报告没有会话在运行再开始。

## 6. 宿主的组件

```mermaid
classDiagram
    direction TB
    class WsServer {
      auth(token)
      route(command)
    }
    class SubscriptionRegistry {
      <<sync/>>
      subscribe(connectionId, sessionIds)
      viewers(sessionId)
    }
    class Connection {
      clientId
      viewing: SessionId[]
      subscriptions
    }
    class IndexStore
    class ProjectService {
      list() add() remove() rename()
    }
    class WorkspaceService {
      scan() rename() archive()
      scheduleFetch() onWindowFocus()
    }
    class MergeInspector {
      inspect(workspace)
    }
    class SessionManager
    class SessionController
    class FileSearch {
      search(dir, query)
    }
    class ChangesService {
      watchChanges(connection, workspaceIds)
      watchDiff(connection, target)
    }
    class SetupService {
      check() install() update()
      login() setApiKey() cancel()
    }
    class TitleGenerator {
      generate(sessionId)
    }
    class BranchNamer {
      name(projectId, text, model)
    }
    class PiIntegration {
      <<模块>>
      PiAdapter
      EventTranslator
      HistoryMapper
      SessionFiles
      PiCatalog
      ContextEstimator
      OneShotPi
    }
    class SessionCatalog {
      scan() classify()
    }

    WsServer "1" *-- "0..*" Connection
    WsServer --> ProjectService
    WsServer --> WorkspaceService
    WsServer --> SessionManager
    WsServer --> FileSearch
    WsServer --> ChangesService
    ChangesService --> WorkspaceService
    WsServer --> SetupService
    SessionManager ..> SubscriptionRegistry : 谁在看哪个会话
    Connection ..> SubscriptionRegistry : 登记订阅
    SessionManager *-- SessionController
    SessionManager --> SessionCatalog
    SessionCatalog --> PiIntegration : SessionFiles
    SessionCatalog --> IndexStore : 记录的容器
    SessionController --> PiIntegration : PiAdapter、EventTranslator
    SessionController ..> TitleGenerator : 第一轮结束后
    TitleGenerator --> PiIntegration : OneShotPi
    WsServer --> BranchNamer
    BranchNamer --> PiIntegration : OneShotPi
    SetupService --> PiIntegration : PiCatalog
    SetupService ..> SessionManager : 更新前确认无运行
    WorkspaceService --> MergeInspector
    ProjectService --> IndexStore
    WorkspaceService --> IndexStore
    SessionManager --> IndexStore
```

- **PiIntegration** 是一个模块，不是一个类：PiAdapter（RPC 进程，自己实现，不用 pi 自带的 `RpcClient`，理由见 SPEC-0001"风险与待定问题"；按 id 对应请求和响应，pi 并发处理每行命令、响应可能乱序；一个会话固定一个进程，不用 `switch_session` 换会话，因为换完不发任何事件）、EventTranslator（纯函数，pi 事件 → Atrium 事件）、HistoryMapper（纯函数，pi 条目 → LogEntry）、SessionFiles（只读扫描会话目录、解析文件头、记录文件大小和修改时间，发现已写出的会话和历史工作目录，不做归类）、PiCatalog、ContextEstimator（按 pi 的语义回放系统消息和检查点，只返回各分段的 token 数，ContextBreakdown 由 SessionController 组装）、OneShotPi（`pi --mode json -p --no-session` 的调用和输出解析）。pi 的格式和协议细节只出现在这个模块里，对外只给 Atrium 类型。它是独立的 `packages/pi`，见 [架构总览 · 代码结构](overview.md#代码结构)。
- **SessionCatalog** 在宿主里：用 SessionFiles 的扫描结果，按索引里记录的容器、或文件头的 `cwd` 把会话归到容器，按 id 去重并报告冲突。归类是 Atrium 的业务规则，所以不放进 pi 包。
- **Connection** 属于 `server/`，持有一个客户端的 socket、clientId 和发送方法。客户端订阅了哪些会话（打开着或可见的）记在 `sync/` 的 **SubscriptionRegistry**，以不透明的 connectionId 作键：业务模块（SessionManager）通过它知道"谁在看哪个会话"，又不必依赖 `server/`（overview.md，"宿主内部的依赖"）。宿主只给订阅者推送对话记录的增量（参照 Paseo）；客户端打开会话时清除它的关注状态。
- **TitleGenerator** 负责标题的提示词、截断和写回规则，调 OneShotPi 单独起一次性进程，不借正在运行的会话。
- **BranchNamer**（`workspaces/`，2026-10-14 加）按新建工作区页的第一条消息给新 worktree 起分支名：选模型同 TitleGenerator（再退到 pi 的默认模型），调 OneShotPi，整理成 `atrium/<名字>`，避开已有的分支和 worktree 目录（SPEC-0001"AI 起分支名"）。它不知道 OneShotPi 和偏好在哪，由 `main.ts` 注入。
- **WorkspaceService** 负责调度后台 `git fetch` 和窗口聚焦后的重算；**MergeInspector** 只做判定。`git merge-tree --write-tree` 不改工作区和 index，但会创建 git 对象，所以它"不改工作区"，不是"只读"。
- **FileSearch** 在会话的工作目录里调 `fd`，参数和排序照 pi 的终端界面，git 仓库和普通目录一样（2026-10-10 定，原先打算 git 仓库用 `git ls-files`、其他目录自己遍历）。
- **ChangesService**（`changes/`）给有连接在看的工作区算 git 改动：胶囊上的合计和改动面板的逐文件 diff，照抄 Paseo（SPEC-0001"工作区改动"，2026-10-10 定）。它按连接记下谁在看哪些工作区、谁开着哪个面板，只为有人看的工作区监听文件，没人看了就停；git 命令走 WorkspaceService 用的同一个 GitRunner（同时最多 4 个）。主干按"已决定 15"：项目设置（ProjectService）或 `origin/HEAD`；和 WorkspaceService 不同的是，`origin` 上没有主干时退到本地主干（照 Paseo）。后台 fetch 和运行结束时 WorkspaceService 的变化也让它重算。
- 指标的计时和汇总是 SessionController 内部的事，不单独成服务。

## 7. 客户端与一致性

```mermaid
classDiagram
    direction LR
    class AtriumClient {
      <<packages/client，无 DOM>>
      clientId
      connect(token)
      send(command)
      reconnect()
    }
    class IndexView {
      projects
      containers
      sessions
      statuses
      layout
    }
    class SessionView {
      sessionId
      epoch
      seq
      transcript
      execution
      queue
      interactions
      stats
    }
    class ViewState {
      <<packages/ui，存 localStorage>>
      expandedTurns
      drafts
      scroll
    }
    AtriumClient "1" *-- "1" IndexView
    AtriumClient "1" *-- "0..*" SessionView : 按 sessionId
    ViewState ..> SessionView
```

**命令与事件的身份**

- 每条会话命令带 `sessionId` 和客户端生成的 `requestId`，宿主据此路由和去重；连接上没有隐式的"当前会话"。
- 每条会话事件带 `sessionId`、`epoch`（进程代次）、`seq`（会话内单调递增）；消息和工具事件再带各自的 id。

**全局列表的同步**（参照 Paseo 的 DirectorySyncService）

- 项目、工作区、会话摘要三个集合，各带 `generation`（宿主进程每次启动生成一个）和单调递增的 `seq`。
- 客户端带上自己的游标 `{generation, afterSeq}` 请求；宿主按情况返回 `snapshot`（附原因：无游标、generation 变了、游标过期、增量太大）或 `changes`（含删除）。之后用 `upsert / remove` 推送变化。
- 变化由 IndexFeed 比较得出（2026-10-10 定，M1.9）：每批重新算出整份列表，和上一批按 id 逐项比较；宿主记住每一项最后改动时的 `seq` 和最近 1000 次删除，重连时据此回增量。业务模块只说"有变化"，不必各自报告改了什么。

**对话记录的同步**（参照 Paseo 的 timeline 同步和 pi 实验版的 ReplicatedState）

- 每个会话的对话记录在宿主内存里，带 `epoch`（进程代次，重建时变）和 `seq`（逐条递增）。
- 客户端只订阅打开着或可见的会话；宿主只给订阅者推实时增量。
- 拉取按游标分页：快照带最近 20 轮（打开会话时），`before` 往上翻时加载更早的。`epoch` 变了或中间有缺口，重新订阅拿一份新的快照。不做按 `seq` 往后补拉（原先打算的 `after`，2026-10-10 定不做）：宿主不留事件历史，补拉和重拿快照代价相当。
- 快照由 SessionController 从同一份 Runtime 状态生成，带 `epoch + seq`，包含流式中的消息、工具状态、排队、待交互、指标；关注状态在列表的会话摘要里。客户端只应用之后的事件。
- 宿主重启后（`hostInstanceId` 变了）客户端对当前会话重新 `open_session` 并订阅；宿主内存里的排队、待交互、当场计时随旧宿主丢失。
- 用户刚发的消息先在本地乐观显示，带 `clientMessageId`（即 `requestId`）；宿主确认后的正式消息带同一个 id，用来对上，不重复显示。
- 断线不重发结果未知的写命令；重连后重新拿游标对齐即可，不需要持久化的事件总线。

**客户端的状态**：IndexView、每个 SessionView 和布局各是一个 Zustand vanilla store（`zustand/vanilla`，不依赖 DOM），SessionView 在订阅时创建、退订时释放；UI 通过选择器订阅，不直接碰 WebSocket。

**ViewState** 在 `packages/ui/src/state/`，保存草稿、展开的过程、滚动位置，存 localStorage；右栏选的标签、文件树展开了哪些、更改树和"改动"标签收起了哪些也在这里（M1.12）。查看标签只在内存里（"已决定 19"）。client 的布局 store 只镜像宿主上按客户端记录的标签页和当前容器。

**多客户端**

会话、排队、运行状态、待交互由宿主统一，广播给所有连接；布局按 `clientId` 分开存，一个客户端关标签不影响别人；草稿、滚动、展开状态只在客户端本地。

## 8. 协议与类的对应

| 命令 | 落到 |
|---|---|
| `list_projects` / `add_project` / `remove_project` / `rename_project` | ProjectService |
| `list_workspaces` / `rename_workspace` / `window_focused` | WorkspaceService |
| `archive_workspace` / `restore_workspace` | WorkspaceArchiver（git 的部分）→ SessionManager（停 pi、归档会话）→ ProjectService（记录）（M1.11） |
| `list_bases` / `create_workspace` | WorktreeCreator（git 的部分，和 WorkspaceArchiver 排同一个队）→ ProjectService（记录，带起点提交）→ WorkspaceService（重扫）（M1.11） |
| `rename_chat` | ChatRecords（`chats.json`） |
| `archive_chat` / `restore_chat` | SessionManager（停 pi、归档或放回会话）→ ChatRecords（记录）（M1.11） |
| `list_sessions` / `list_chats` / `create_session` / `create_chat` / `open_session` / `close_tab` / `archive_session` / `rename_session` / `hand_off` / `take_back` / `clear_attention` | SessionManager |
| `subscribe_index(cursor?)` | IndexFeed |
| `subscribe_sessions(ids)` / `fetch_transcript(sessionId, direction, cursor, limit)` | SessionManager → SessionController |
| `prompt` / `steer` / `stop` / `resume_queue` / `clear_queue` / `update_queued` / `remove_queued` / `steer_queued` / `answer_interaction` / `set_model` / `set_thinking_level` | SessionController |
| `list_models(workspaceId \| null)` | PiCatalog |
| `list_commands(sessionId)` | SessionController |
| `search_files(sessionId, query)` | FileSearch |
| `watch_changes(workspaceIds)` / `watch_diff(target)` | ChangesService |
| `compact_session` / `export_session` | SessionController：调会话自己的 pi 的 `compact`（只在空闲时）、`export_html`（运行中也行）（M1.11） |
| `fork_session` | SessionManager → SessionForker：由轮找到下一轮开头的用户消息条目，另起临时 pi 做 pi 的 `fork`（最后一轮用 `clone`）、设上界面给的名字，读出新会话后停掉它，复制轮的记录，重扫容器并打开新会话（M1.11） |
| `fetch_image(sessionId, turnId, index)` | SessionManager → SessionController 找出轮的用户消息条目，pi 包的 SessionFiles 从会话文件里读出图片（M1.11） |
| `upload_attachment` | AttachmentStore：按客户端暂存压缩后的图片，被 `prompt` / `steer` 用掉或连接断开时释放（M1.7） |
| `ping` / `report_client_issue` | Router 直接处理：应答心跳；把界面的问题写进日志 |
| `check_setup` / `install_*` / `update_pi` / `cancel_install` / `login` / `cancel_login` / `set_api_key` | SetupService |

| 事件 | 来源 |
|---|---|
| `index_snapshot` / `index_changes`（带 `generation + seq`） | IndexFeed，内容来自 ProjectService、WorkspaceService、SessionManager |
| `session_snapshot` / `message_*` / `tool_*` / `run_started` / `run_settled` / `interaction_*` / `notice` / `session_exited` | SessionController（经 EventTranslator） |
| `session_changed_externally` | SessionCatalog：预留，文件被外部改过 |
| `changes_updated` / `diff_updated`（整份最新状态，不带序号） | ChangesService |
| `queue_updated` / `metrics_updated` | SessionController |
| `install_*` / `login_*` | SetupService |

## 已决定

1. **对话不算工作区，但和工作区一样是容器**：每个对话一个目录、可以有多个会话，通过 SessionContainer 与工作区统一选择、列表和新建入口；没有 git（2026-10-12 改，[ADR-0007](../adr/0007-each-chat-is-its-own-container.md)；原先所有对话在一个全局的 ChatSpace 里）。
2. **会话主键用 pi 的会话 id**，文件路径是可更新的定位；草稿会话也有 id；同 id 多文件报冲突。
3. **MVP 1 不回收空闲进程**：打开过的会话进程常驻到归档、交给终端或宿主退出；排队、关注状态、当场计时随 Runtime 一直在。宿主重启后会话是 `closed`，打开时重建，当场计时显示"—"。
4. **标签页不跨客户端同步**：布局按 `clientId + containerId` 存在索引里。
5. **会话归属**：Atrium 建的会话创建时记下所属容器；Atrium 没见过的会话按文件头的 `cwd` 归类。
6. **失败重试 3 次再告诉用户**：模型调用的可重试错误交给 pi 自带的重试（宿主确保开启，次数沿用 pi 的设置，默认 3）；进程崩溃由 SessionController 自动重启，最多连续 3 次，崩溃前那条输入没写进会话就重新提交，已写进就补发一条"继续"；认证失败、目录不存在不重试。3 次都失败才设关注状态、显示错误卡片，卡片上的"重试"按同样规则再来一轮。Runtime 里加 `restartAttempts` 计数，一轮结束且没有失败（完成或被停止）后清零（2026-10-09 改）。模型重试的次数沿用 pi 的设置（默认 3），宿主只确保开启（2026-10-09 定，RPC 改不了次数）。
7. **草稿会话保留**：草稿会话记在索引里，宿主重启后恢复成空标签，第一次发消息时才启动进程。
8. **对话目录不自动清理**：`~/.atrium/chats/` 下的目录由用户自己删。
9. **新对话一打开就启动 pi**（2026-10-05 定，实施在 M1.5、M1.6）：用户新建对话时，宿主立刻为它启动 pi 进程，不等第一条消息发出，启动时间（实测热启动约 0.22 秒、冷启动约 0.37 秒）藏在用户打字的时间里。只对用户主动新建的对话这样做；宿主重启后恢复的草稿标签仍按"已决定 7"在第一次发消息时才启动，避免一次起很多进程。不预先常驻空闲的 pi 进程，也不把登录 shell 的环境缓存到磁盘（环境里可能有 API Key，见 security.md）。
   新建时不等 pi 启动（2026-10-11 改）：宿主自己生成会话 id（UUID，符合 pi 对 `--session-id` 的要求，pi-internals §1），记成草稿、打开标签、马上应答，再在后台用 `pi --session-id <id>` 启动，和恢复的草稿走同一条路。第一条消息、`/` 和打开这个会话都等这同一次启动；后台启动失败只记一条日志，打开会话、发消息或 `/` 时再启动一次，失败显示在会话里。空状态里一开始输入就新建会话（SPEC-0001"标签页"），启动时间藏在打字里。
10. **索引按领域拆文件，损坏时挪开重来**（2026-10-08 定）：见 §1"索引的存储"。宿主单实例：Electron 的单实例锁加宿主自己的 `host.lock`。
11. **M1.5 的列表每次推整份快照**（2026-10-08 定）：索引或扫描结果有变化时合并一下，推一份完整的列表（信封里先带上 `generation + seq`，但总是快照）；M1.9 再加增量和游标，界面不用改。
12. **终端里开的会话在窗口聚焦、运行结束时重扫发现**（2026-10-08 定）：不常驻监听 pi 的会话目录，和合并状态"不持续监听文件"一致；扫描按文件大小和修改时间缓存，只重读变化的文件。
13. **没发过消息就关掉的草稿丢弃**（2026-10-08 定）：停掉 pi、删掉索引记录，"历史"里不堆积空会话。它是对话里唯一的会话时，对话的空目录一并删掉（只删空的），对话随之消失；对话里还有别的会话（含归档的）时目录留着（2026-10-12 补）。
14. **工作区里新建会话也立刻启动 pi**（2026-10-08 定）：和"已决定 9"的新对话一样。
15. **主干只认覆盖值或 `origin/HEAD`**（2026-10-08 定）：都没有时合并状态为 `unknown`（主干引用缺失），不猜本地的 main / master。
16. **交给终端后点了才继续**（2026-10-10 定）：交接记在索引里，宿主重启后仍在；切到标签不自动启动 pi，用户点"在 Atrium 里继续"才重新加载。pi 没有跨进程的写锁，两边同时写会悄悄分叉。
17. **会话状态、收件箱、工作区汇总在界面派生**（2026-10-10 定）：宿主只在会话摘要里给出运行、关注状态、待回答、已交接，界面按 §4 的优先级算。
18. **对话记录不按序号补拉**（2026-10-10 定）：缺口或 `epoch` 变了就重拿快照。
19. **查看标签只在界面里**（M1.12，2026-10-13 定）：看文件、看 diff 的查看标签和会话标签排在同一个标签栏里，但不是会话，不进 ClientLayout：按容器记在这个窗口的界面状态里，不发给宿主，别的窗口看不到，刷新、重启后没有了。会话标签仍只由宿主的布局决定；界面把两者按顺序合在一起显示，⌘W、⌘1–9 等快捷键一起算（SPEC-0001"M1.12 的文件与更改"）。它只是看一眼的东西，记进宿主要升布局的版本、要处理文件不在了的情况，得不偿失（Paseo 把它们记在客户端本地）。

## 待定

- [ ] **外部改动的处理**：会话文件被终端 pi 改过时怎么提示、怎么合并，还没定（M1.12 的文件区只读，没有碰到这个问题）。现在只预留口子：SessionCatalog 记录每个文件最后一次读到的大小和修改时间，发现变化时发 `session_changed_externally`，界面暂不处理。
