# 任务图的执行方案（第一版）

- **状态**：2026-11-04 用户确认，已并入 [SPEC-0006](../specs/0006-tasks-and-task-graph.md)。本文保留为讨论记录（Q1–Q14 的编号出处），以后以 SPEC 为准。
- **日期**：2026-11-04
- **依据**：
  - 界面：`prototypes/agent-task-board-design.html`（第 5 版）
  - worktree 调研：`worktree-practices.md`
  - 子对话与扩展通道：SPEC-0002、ADR-0013
  - 问用户：SPEC-0003
  - pi 行为：`pi-internals.md`
- **v1 → v3**：v1、v2 是讨论稿。这一版把结论合成一份能照着实现的方案：补了模块划分、数据格式、调度算法、扩展工具、协议、错误码、实施顺序和测试。

## 0. 已定

**任务和对话**

- 任务只能从对话用 `/task` 创建，前面的对话就是草稿。这段对话成为"需求对话"，留在项目目录里，打开是纯对话，只多一行"已转为任务 X ›"。
- 每个任务有一个"任务对话"，从创建用到结束：改图、问进度、给节点带话。图只展示，点节点只描框高亮，点空白取消。
- 任务对话和节点对话只能从侧栏的"任务"入口进去，不进项目目录、不进侧栏，也没有任何任务标记。
- 一个任务只属于一个项目；不属于项目的对话也能转，那种任务不改代码。

**节点**

- 节点字段：做什么、怎样算完成、角色、模型、在哪里跑、输入。
- 节点默认用任务模型；任务模型默认是来源对话的模型。
- 引导词写死在代码里，agent 自己选。
- 交接摘要由节点自己写，用写死的提示词；插话不传给下游。
- 每个节点知道自己要做什么、下游要做什么，不提前做。
- 失败就停下：不重试、不设预算、不拦具体命令、不设额外介入点。

**图与调度**

- 汇合要全部通过；打回最多 2 次；没有条件边。
- **Q1**：怎样算完成，信节点自己的 `node_done`；验证交给图里的 `check` 节点，宿主不跑命令。
- **Q2**：加 `check` 角色：能跑任意命令，不能 `edit` / `write`，只给任务节点用。
- **Q3**：同一个 worktree 同时只跑一个 `work` 节点，并行的排队。
- **Q4**：一个节点失败，在跑的兄弟节点跑完手上这一轮再停。
- **Q5**：可写节点结束时提交一次，不推送。
- **Q6**：节点不能开子对话。
- **Q7**："验收合并"节点通过时，由宿主按合并流程合并。
- **Q8**：宿主重启时挂着的问题作废，节点重新起来后再问。
- **Q9**："由你来做"的节点只有"通过 / 打回到 X"两种结果。
- **Q10**：进度行很短、不调模型，进度以现查为准。

**worktree**

- worktree 要写才建，由调度器建。
- 起点固定成提交号。
- 用 `.worktreeinclude` 复制被忽略的文件。
- 建的时候不跑仓库的过滤器。
- 按路径拦截越出工作目录的写操作。
- 任务在用的 worktree 加锁。
- **Q11–Q13 按提议**（你没有反对，实施前再确认一次）：
  - 起点取来源目录的 HEAD；
  - `.worktreeinclude` 对所有 Atrium 新建的 worktree 都生效；
  - 路径隔离同样加给 SPEC-0002 的 `work` 子对话。
- **Q14**：要归档时直接问你，不自动归档、不静默保留。

**定时**

- 定时管理是任务区里的固定标签。
- 每次触发新建一个任务。
- 上一次还没结束就跳过这一次；Atrium 开着时错过了，醒来补一次。

## 1. 总体结构

```
 UI（ui/src/tasks/）          任务区：列表、定时、任务标签（图 + 任务对话）
   │ 协议（protocol/commands/tasks.ts、events/tasks.ts）
 宿主（host/src/tasks/）
   ├─ TaskService        对外的命令；读写任务记录；把操作变成事件交给调度器
   ├─ Scheduler          纯函数 step(状态, 事件) → (新状态, 动作[])
   ├─ TaskRunner         执行动作：起节点、停节点、写进度行、建 worktree、合并；结果再变成事件
   ├─ TaskStore          ~/.atrium/tasks/<id>/：task.json（当前状态快照）+ events.jsonl（只追加）
   ├─ ScheduleService    定时规则，按注入的 Clock 触发
   └─ GraphValidator     图的校验（纯函数）
 宿主已有的：SessionManager、AgentRelay（子对话的起停、送达、名额）、WorktreeCreator、
            WorkspaceArchiver、MergeInspector、git 队列
 pi 包（pi/src/task/）     任务扩展：节点工具、任务对话工具、路径隔离的 tool_call 钩子、
                          隐藏命令 /atrium-task 的参数；走 ADR-0013 的通道
```

依赖方向不变：`tasks/` 用 `sessions/`、`workspaces/`、`store/`、`platform/`，反过来不用；`pi/src/task/` 不 import 宿主，宿主需要的东西经通道问。

## 2. 数据

### 2.1 任务记录 `task.json`

```ts
type Task = {
  id: TaskId;                       // tsk_…
  name: string;
  projectId: ProjectId | null;      // null = 不属于项目
  workspaceId: WorkspaceId | null;  // 任务 worktree；建之前为 null
  sourceDir: string;                // 来源对话的目录：只读节点在 worktree 建好前在这里跑
  ownsWorkspace: boolean;           // worktree 是不是这个任务建的（决定归档时问不问、能不能删）
  baseCommit: string | null;        // 建 worktree 时的完整提交号
  model: { providerId; modelId; thinking };
  guide: { id: GuideId; version: number };
  summary: RequirementSummary;      // 目标、已定结论、约束、不做、未决问题、验收要点
  origin: { kind: "chat"; sessionId } | { kind: "schedule"; ruleId; firedAt };
  taskSessionId: SessionId;         // 任务对话
  graphs: GraphVersion[];           // 只增不改
  activeGraph: number;              // 当前生效的版本号
  pendingGraph: number | null;      // 启动后等你批准的新版本
  runs: NodeRun[];
  paused: boolean;
  cancelled: boolean;
  createdAt; startedAt | null; endedAt | null;
};

type GraphVersion = {
  version: number;
  nodes: Node[];
  edges: Edge[];
  author: "agent" | "user";
  note: string;
  createdAt;
  approvedAt: number | null;
};

type Node = {
  id: NodeId;                       // N1、N2…，跨版本认同一个节点
  name: string;
  kind: "agent" | "human";
  job: string;                      // 做什么
  done: string[];                   // 怎样算完成，逐条
  role?: "explore" | "work" | "check" | "advise";  // 只有 agent 节点有
  model?: { providerId; modelId; thinking? };       // 不填 = 继承任务模型
  place?: "workspace" | "readonly";                 // 不填 = 按角色：work、check → workspace，其余 readonly
  inputs?: NodeId[];                // 不填 = 所有直接上游
};

type Edge = { from: NodeId; to: NodeId; kind: "seq" | "back" };   // back 只能从 human 节点出

type NodeRun = {
  node: NodeId;
  attempt: number;                  // 第几次（打回、重跑都加一）
  graph: number;                    // 按哪个图版本跑的
  state: NodeState;
  sessionId: SessionId | null;      // human 节点为 null
  startedAt; endedAt | null;
  summary: string | null;           // 交接摘要
  failure: FailureReason | null;
  commit: string | null;            // 结束时的提交（可写节点有改动时）
  backFrom?: { node: NodeId; reason: string };     // 被打回时的来源和原因
  nudged: boolean;                  // 是否已经提醒过一次"还没调用 node_done"
};
```

### 2.2 事件 `events.jsonl`

每行一个事件：`{ seq, at, type, ...payload }`。调度器的输入就是这些事件；`task.json` 是按事件算出来的快照，写坏了可以从事件重放出来。事件类型：

- `created` / `graph_proposed` / `graph_approved` / `graph_rejected` / `started`
- `node_started` / `node_waiting` / `node_resumed` / `node_done` / `node_failed` / `node_stopped`
- `human_passed` / `human_sent_back`
- `rerun_requested` / `paused` / `resumed` / `cancelled`
- `workspace_created` / `merged` / `merge_failed`
- `archive_asked` / `archive_answered`
- `host_restarted`

事件里不放对话内容，只放 id、状态和你写的打回原因（这和交接摘要一样，属于任务数据，不是日志：observability 的"日志不记对话内容"管的是宿主日志，不管这里）。

### 2.3 定时规则 `~/.atrium/schedules.json`

```ts
type ScheduleRule = {
  id: RuleId;
  name: string;
  projectId: ProjectId;
  when: Cadence;                    // { every: "day", at: "02:00" } | { every: "week", day: 1, at: "10:00" } | …
  place: "new_worktree" | "local_readonly";
  summary: RequirementSummary;
  graph: Pick<GraphVersion, "nodes" | "edges">;
  model;
  paused: boolean;
  lastFiredAt: number | null;
  lastTaskId: TaskId | null;
  skipped: number;                  // 最近一次触发之后跳过了几次
};
```

## 3. 状态机

### 3.1 节点

```
pending ──上游全过──▶ ready ──起会话──▶ running ──node_done(ok)──▶ passed
                                      │  ▲                       │
                      ask_user / 申请改图 │  │ 你回答 / 你拒绝改图       │ 被打回
                                      ▼  │                       ▼
                                    waiting                   （新一条 NodeRun）pending
                                      │
   running ── 你停下 ──▶ stopped ── 你继续 ──▶ running
   running ── 失败（见下）──▶ failed ── 你点重跑 ──▶ running（同一个会话里接着跑，attempt 不变）
   pending ── 改图删掉 ──▶ skipped
```

human 节点：`pending → waiting`（到了就等你），`waiting → passed`（通过）；打回时它自己也回到 `pending`。

**失败**只有四种（`FailureReason`）：

| 原因 | 怎么判定 |
|---|---|
| `no_done` | 一轮结束（`agent_settled`）没调 `node_done`：先以 followUp 送一条提醒，`nudged = true`；再结束一轮仍没有 → 失败 |
| `crashed` | pi 进程崩溃且自动重启用完（沿用 SPEC-0001 的规则） |
| `model_error` | pi 的自动重试结束为失败（`auto_retry_end { success: false }`），或回复以错误结束、不再重试 |
| `gave_up` | 节点调 `node_done({ ok: false, reason })` |

### 3.2 任务

任务状态由节点状态推出，不另存（`paused`、`cancelled` 是标记）：

```
cancelled                                  → cancelled
有 failed / stopped，或 paused              → stopped
有 waiting（含 human 节点到了）             → waiting
没有 approvedAt 的初始图                    → designing
有 ready / running                         → running
所有没有出边的节点都 passed                  → done
```

列表分组：`designing`、`waiting`、`stopped` 进"待我介入"，`running` 进"运行中"，`done`、`cancelled` 进"已完成"。

## 4. 调度器

```ts
function step(task: Task, event: TaskEvent): { task: Task; actions: Action[] };

type Action =
  | { kind: "ensure_workspace" }                  // 建任务 worktree（已有则无动作）
  | { kind: "start_node"; node: NodeId; attempt: number }
  | { kind: "stop_node"; node: NodeId; when: "now" | "after_turn" }
  | { kind: "nudge_node"; node: NodeId }          // 提醒调用 node_done
  | { kind: "send_to_node"; node: NodeId; text: string }
  | { kind: "progress_line"; text: ProgressLine } // 写进任务对话，不调模型
  | { kind: "lock_workspace" } | { kind: "unlock_workspace" }
  | { kind: "commit_node"; node: NodeId }
  | { kind: "merge" }
  | { kind: "ask_archive" }
  | { kind: "notify"; attention: Attention };     // 进"等你处理"
```

`step` 是纯函数，不碰时间、不碰 IO（时间从事件里来）；TaskRunner 执行动作，结果再作为事件送回 `step`。这样调度逻辑整块能用表驱动测试和性质测试覆盖，变异测试也只针对它。

**每次 `step` 在应用完事件后都做一遍"推进"：**

1. 任务是 `cancelled` / `stopped` / `designing` → 不推进。
2. 按拓扑序找出所有"就绪"的节点：自己是 `pending`，所有顺序入边的上游都 `passed`。
3. human 节点就绪 → 直接 `waiting`，发 `notify`。
4. agent 节点就绪 → 进 `ready`。然后按拓扑序依次决定起哪些：
   - `place = workspace` 且任务还没有 worktree → 先 `ensure_workspace`，这个节点等 `workspace_created` 再起；
   - 是 `work` 且同一 worktree 已有 `work` 在跑 → 留在 `ready`（Q3）；
   - 名额：和 SPEC-0002 共用"每个父会话 6 个"的口径，这里的父会话是任务对话；满了留在 `ready`；
   - 其余 → `start_node`。
5. 没有出边的节点都 `passed` → `done`，发 `unlock_workspace`、`ask_archive`（任务建的 worktree，见 §6.5）。

**失败（Q4）**：一个节点 `failed` 时，在跑的兄弟节点收到 `stop_node(after_turn)`，它们这一轮结束（`agent_settled`）后进 `stopped`；不起新节点；任务进 `stopped`，发 `notify`。你点"重跑这个节点"只重跑失败的那个；被连带停下的兄弟节点在任务恢复推进时由 `step` 重新起（同一个会话里继续）。

**打回（Q9）**：你在 human 节点选"打回到 X"并写原因：

- X 和从 X 到这个 human 节点路径上的所有节点，各新开一条 NodeRun（`pending`，attempt + 1）；
- X 的那条带上 `backFrom`；
- human 节点自己也回到 `pending`；
- 同一条打回边已用 2 次的，界面上这个选项置灰，`human_sent_back` 应答 `task_back_limit`。

## 5. 一个 agent 节点怎么跑（TaskRunner）

### 5.1 起

- 会话：用 AgentRelay 起一个子对话，父会话是任务对话，`agent.role` 是节点角色，记录里另带 `task: { taskId, node, attempt }`。它不进项目目录、不进侧栏（SessionCatalog 按 `task` 字段排除），只在任务标签里出现。
- 目录：`place = workspace` → 任务 worktree；`readonly` → 任务 worktree，还没有 worktree 时用 `sourceDir`。
- 模型：节点指定的，否则任务模型；档位规则同 SPEC-0002。
- 工具：按角色的白名单。

  | 角色 | 工具 |
  |---|---|
  | `explore` / `advise` | 同 SPEC-0002 只读白名单 |
  | `check` | 只读白名单的工具，Bash 不作只读约束，可以跑测试和构建 |
  | `work` | 全部内置工具 |

  另外每个节点都加三个任务工具：`node_done`、`request_graph_change`、`ask_user`（SPEC-0003）。不给 `agent_*`（Q6）。
- 同一个节点被打回后的新 attempt 开**新会话**（干净的上下文，契约里带打回原因）；"重跑这个节点"在**原会话**里接着跑（追加一句"上次失败的原因：…，接着做"）。

### 5.2 第一条消息：契约

宿主拼好，作为第一条 `task` 消息发出，用 `<atrium-task-node>` 包住（同 SPEC-0002，不改系统提示词）：

```
你在任务「{任务名}」里负责节点 {id} · {名字}。

【任务目标】{需求摘要的目标与已定结论}
【整张图，你在这里】{按拓扑序列出全部节点：✓ 已通过 / ← 你 / 下一步 / 之后 / 由用户决定}
【你这一步要做的】{做什么}
【做到这样就算完成】{逐条}
【不归你做的】后面节点的事，不要提前做：
  - {每个下游节点：名字 · 做什么的第一句}
【输入】{inputs 里每个节点最新一次 passed 的交接摘要}
{第一个 work 节点、worktree 刚建：【环境】这是新建的 worktree，还没有装依赖，先按项目说明装好。}
{被打回：【上次被打回的原因】{原因}（来自 {节点}）}

做完单独调用 node_done，把交接摘要写进 summary：做了什么；产出在哪；「怎样算完成」逐条的结果；
留给下游、你没做的；风险和拿不准的地方。下一步是 {下游节点名}。
不做后面的事就完不成时，调用 request_graph_change；拿不准时用 ask_user 问用户，不要猜。
```

"不归你做的"和"整张图"由宿主从图里算，不让模型生成。

### 5.3 结束

`node_done({ ok, summary, reason? })`：

1. 扩展经通道把参数交给宿主，宿主校验：`ok: true` 时 `summary` 非空，`ok: false` 时 `reason` 非空。不通过时工具返回错误，模型改了再调。
2. 校验通过，工具结果带 `terminate: true`。同一批工具调用都 `terminate`，pi 才不再请求模型，所以说明里写"单独调用"；和别的工具同批调用时，宿主仍然受理，等这一轮自然结束。
3. 宿主等到 `agent_settled`，然后：
   - 可写节点：worktree 相对上次提交有改动 → `commit_node`（`git add -A && git commit -m "<任务名> · <节点名>：<摘要第一句>"`，不推送），提交号记进 NodeRun；没改动不提交；
   - 停掉 pi（SPEC-0002"做完一轮就停 pi"）；
   - 事件 `node_done` → `step`。

### 5.4 中途

| 发生了什么 | 处理 |
|---|---|
| `ask_user` | 走 SPEC-0003 的问题卡；节点 `waiting`；任务列表那一行能直接答；答了回 `running` |
| `request_graph_change({ reason, suggestion })` | 节点 `waiting`；任务对话里写一行"N2 申请改图：{reason}"，并以 steer 给任务对话的 agent 一条说明（这是唯一会唤醒任务对话模型的系统输入）；agent 出新图等你批准。你批准 → 新图生效，节点收到"图已改，按新的契约继续"和新的"不归你做的"；你拒绝 → 节点收到"不改图，按原来的做"继续 |
| 你在节点对话里插话、停这一轮 | 节点对话就是普通会话，照常可用；停下 → `stopped`，任务 `stopped` |
| 任务对话的 `task_send_to_node` | 走 SPEC-0002 的送达，在节点下一个轮次边界补进去 |
| 你暂停任务 | 在跑的节点 `stop_node(after_turn)`，`paused = true`；恢复时 `step` 重新推进 |

### 5.5 路径隔离（扩展的 `tool_call` 钩子）

对 `work`、`check` 节点和 SPEC-0002 的 `work` 子对话（Q13）生效，节点的"工作目录"就是它起的目录：

- `edit` / `write`：目标路径按真实路径解析（跟随符号链接）后不在工作目录里 → 拦下，理由"只能改 {工作目录} 里的文件"；
- `bash`：pi 的 bash 工作目录就是会话目录，不用查；命令文本里出现 `git -C <路径>`、`--git-dir`、`--work-tree`、`GIT_DIR=`、`GIT_WORK_TREE=`，且指向工作目录之外 → 拦下；
- 拦不住的（`cp`、`>` 重定向、脚本里的写入）不假装能拦，在 security.md 里写明。

只读角色本来就没有 `edit` / `write`，钩子只查 git 的那一条。

## 6. 工作区

### 6.1 什么时候建

`ensure_workspace`：

- 任务已有 `workspaceId` → 无动作；
- 来源对话在 worktree 里 → 创建任务时就记下这个工作区，`ownsWorkspace = false`，不走这里；
- 否则（项目本地目录）→ 新建，`ownsWorkspace = true`；
- 不属于项目的任务不会走到这里：GraphValidator 不允许出现 `place = workspace` 的节点。

### 6.2 怎么建（扩展 WorktreeCreator，和手动新建共用）

1. 起点：`git rev-parse --verify <sourceDir 的 HEAD>^{commit}` 得到完整提交号（Q11）。
2. 名字：沿用 BranchNamer，按任务名生成英文分支 `atrium/<名字>` 和中文别名。
3. `git -c filter.<每个已配置的过滤器>.smudge= -c filter.<…>.process= -c filter.<…>.required=false worktree add -b <分支> <目录> <提交号>`：仓库 `.git/config` 里配置的过滤器临时置空，LFS 文件留成指针。过滤器名字按 Claude Code 的规则检查：含 `=` 或换行的，或者有 `includeIf` 的，拒绝建，错误码 `worktree_filter_unsafe`。
4. 建完核对 `git -C <目录> rev-parse HEAD` 等于起点，不等 → `worktree_create_failed`，留下目录供检查。
5. `.worktreeinclude`：读项目根的这个文件（`.gitignore` 语法），对每个"匹配且被 git 忽略"（`git check-ignore`）的文件从 `sourceDir` 复制过去（复制，不软链；不跟随指向仓库外的链接）。对所有 Atrium 新建的 worktree 都生效（Q12）。
6. 登记工作区，记起点提交和"由任务 X 创建"；`workspace_created` → `step`。

失败（git 出错、目录占用、过滤器不安全）→ 等着建它的节点 `failed`，原因 `crashed` 之外另记 `workspace`，任务停下。

### 6.3 加锁

任务从 `started` 起对它用的 worktree 执行 `git worktree lock --reason "atrium task <taskId>"`（包括不是任务建的）；`done`、`cancelled` 时解锁。归档遇到锁着的应答 `workspace_in_task`，界面写"任务 X 正在用"。宿主启动时，原因是 `atrium task <id>`、但这个任务已经结束或不存在的锁，解掉。

### 6.4 合并（Q7）

"验收合并"是 human 节点，你点"通过"后由宿主合并，按 development.md 的标准流程：

1. 当场检查 worktree 干净；不干净先 `commit_node`。
2. 在主检出目录里 `git merge --no-ff <分支>`（主检出目录有未提交的改动 → 不合并，节点保持 `waiting`，提示"主目录有未提交的改动"）。
3. 冲突 → `git merge --abort`，节点 `failed`，原因写清冲突的文件，任务停下；你在任务对话里让 agent 处理（它可以改图加一个"解决冲突"的 `work` 节点）。
4. 成功 → `merged` 事件；不推送。

### 6.5 归档（Q14）

任务 `done`、`cancelled` 时，任务建的 worktree（`ownsWorkspace = true`）由 `ask_archive` 问你：

- 弹出的确认写清：worktree 名、是否已合并、有没有未提交的改动、相对起点有几个提交；选项"归档"和"先留着"。
- 选"归档"：走现有的 `archive_workspace`，它的检查（未提交、游离提交）照旧当场再做一遍。有未提交的改动时，归档按钮置灰，写"先提交或丢弃"。
- 选"先留着"：任务列表这一行写"worktree 还在"，可以之后再点归档。
- 不是任务建的 worktree，任务结束只解锁，不问、不删。

## 7. human 节点

- 没有会话。到了就 `waiting`，任务列表、"等你处理"各出现一条（"等你验收合并"）。
- 你看到：它的"做什么"、"怎样算完成"、直接上游的交接摘要、worktree 相对起点的改动统计（ChangesService）。
- 你的选择只有：**通过**；**打回到 {它有打回边的节点}**，要写原因。
- "确认初始图"不是节点，是开始页的"确认并启动"（`designing → running`）。

## 8. 改图

- 只有任务对话的 agent 能出新图（`task_propose_graph`）；节点用 `request_graph_change` 申请。
- GraphValidator 的校验（不通过，工具返回带原因的错误，agent 自己改）：
  - 顺序边无环；打回边只能从 human 节点指向它的上游；
  - 节点 id 唯一；agent 节点有 `job`、`done`、`role`；human 节点没有 `role`、`model`、`place`；
  - 至少一个没有入边的节点，至少一个没有出边的节点；
  - 不属于项目的任务没有 `work`、`check` 节点，也没有 `place = workspace`；
  - 启动后：已经有 NodeRun 的节点不能删；`running`、`waiting` 节点的定义不能改；
  - 节点数上限 20（防止生成失控）。
- `designing` 时直接生效（`approvedAt` 在"确认并启动"时写）；启动后进 `pendingGraph`，你批准才生效：`pending` 节点按新定义，删掉的 `pending` 节点 `skipped`，新加的按就绪规则推进。

## 9. 任务对话

- 一个普通的 pi 会话，目录是 `sourceDir`（不随 worktree 移动），角色 `explore` 的只读白名单，另加任务对话工具：

| 工具 | 做什么 |
|---|---|
| `task_read_source({ page? })` | 分页读来源对话（只读；创建时用） |
| `task_set_summary({ summary })` | 写需求摘要（`designing` 时；启动后改摘要算改图） |
| `task_status()` | 当前图、每个节点的状态与用时、任务状态、待批准的图 |
| `task_read_node({ id, what: "contract" \| "summary" \| "transcript" })` | 读某个节点的契约、交接摘要或对话全文（截断到 4000 字，分页） |
| `task_diff({ since?: NodeId })` | worktree 相对起点或某个节点结束时提交的改动（stat + diff，截断） |
| `task_propose_graph({ nodes, edges, note })` | 出新图，按 §8 生效或等批准 |
| `task_send_to_node({ id, text })` | 给在跑的节点补一句；不在跑的报错 |
| `task_set_schedule({ when, place })` | 把这个任务标成定时规则的模板（§11） |

- 进度行：节点开始、通过、失败、等你、worktree 建好、合并，宿主经 `/atrium-task progress` 让扩展 `sendMessage(…, { triggerTurn: false })` 写一条 `custom_message`（`customType: "atrium-task"`，`details.kind: "progress"`），带时间，不调模型。界面画成系统提示行。
- 它不能改节点状态：重跑、通过、打回、暂停、取消只在界面上。

## 10. /task 与创建

1. 来源对话里输 `/task [范围]`：这是 Atrium 的内置命令，宿主处理，不发给来源对话的模型。
2. 宿主建任务记录（`designing`），开任务对话：模型 = 来源对话当前的模型；第一条消息是 `<atrium-task-design>`，包括：
   - 来源对话的会话 id；
   - 范围；
   - 写死的四套引导词全文；
   - 指令：先 `task_read_source` 读来源对话，再 `task_set_summary`，按选定的引导词 `task_propose_graph`，最后用一两句话告诉用户选了哪套、图长什么样、还有什么未决问题。
3. 来源对话里写一行 `custom_message`（`details.kind: "converted"`，带任务 id），界面画成"已转为任务 X ›"。
4. 打开任务区的这个任务标签。
5. 你在任务对话里改；点"确认并启动"：GraphValidator 再校验一次 → `started` → `step`。

一个来源对话只对应一个任务：已经转过的再 `/task`，打开那个任务，不新建。

## 11. 定时（ScheduleService）

- 规则从对话 `/task` 时由 agent 判断出来：需求里说了"每天几点"，`task_set_schedule({ when, place })` 把任务标成"规则模板"；确认后存成 ScheduleRule，不立即跑（可以在定时标签里点"立即跑一次"）。
- 到点：`lastTaskId` 的任务没结束（不是 `done` / `cancelled`）→ `skipped + 1`；否则按规则新建 Task，`origin.kind = "schedule"`，跳过 `designing`，直接 `started`。`place = new_worktree` 时第一个节点开跑前建 worktree（同 §6）；`local_readonly` 的规则 GraphValidator 不许有 `work` 节点。
- 错过：宿主启动、系统唤醒（`powerMonitor` 由 desktop 经宿主入口转来）时，算每条规则"上次应触发时间 > lastFiredAt"，有就补跑一次。
- 时间经注入的 Clock；`Cadence` 的下次时间是纯函数，测试快进。

## 12. 宿主重启

1. 读每个没结束的任务的 `task.json`，和 `events.jsonl` 的末尾比对 `seq`，落后就从事件重放。
2. 给每个任务送 `host_restarted`：
   - `running` 节点 → 按 SPEC-0002 重新起它的会话，送一句"宿主重启了，继续你手上的事；做完调用 node_done"；起不来 → `failed(crashed)`；
   - `waiting` 且在等 `ask_user` 的节点：问题按 SPEC-0003 作废（Q8），节点回到 `running`，重起会话时送一句"刚才的问题作废了，需要的话再问"；
   - 在等改图批准的：`pendingGraph` 保留，节点仍 `waiting`。
3. 解掉已结束任务留下的锁（§6.3）。
4. 每个任务 `step` 一次。

## 13. 扩展与通道

- 任务扩展在 `packages/pi/src/task/`，由 `packages/pi/src/extension/atrium.ts` 注册，按启动参数 `--atrium-task=<base64url JSON>` 决定这个会话是节点、任务对话，还是都不是（都不是时什么也不注册）。
- 工具调用经 ADR-0013 的通道：扩展 `setStatus("atrium-task:<id>", JSON)` 发请求、挂着等；宿主用隐藏命令 `/atrium-task reply <id> <base64url>` 回答。宿主下发用 `/atrium-task progress|nudge|resume <参数>`。
- 参数和回答都经 zod 校验（schema 在 `packages/pi/src/task/schema.ts`）。宿主日志只记命令名和 id，不记参数。

## 14. 协议（给 UI）

- **命令**（`protocol/commands/tasks.ts`）：
  - `list_tasks`
  - `open_task(taskId)`：订阅这个任务的状态
  - `start_task`：确认并启动
  - `approve_graph` / `reject_graph`
  - `answer_human(taskId, node, { pass } | { backTo, reason })`
  - `rerun_node`
  - `pause_task` / `resume_task` / `cancel_task`
  - `answer_archive(taskId, "archive" | "keep")`
  - `list_schedules`
  - `pause_schedule` / `resume_schedule` / `run_schedule_now` / `delete_schedule`
  - `edit_schedule`：打开它的任务对话
- **事件**（`protocol/events/tasks.ts`）：
  - `tasks_updated`：列表，沿用 generation+seq 增量；
  - `task_updated`：单个任务的图、节点状态、待批准的图、归档提问；
  - `schedules_updated`。
- 任务对话和节点对话的内容走现有的会话订阅，不另开通道。
- 新协议版本号加一，手机端（remote-policy）第一版只读：能看列表和状态、能答 `ask_user`，不能启动、批准、合并。

## 15. 错误码

| 错误码 | 什么时候 |
|---|---|
| `task_not_found` | 任务 id 不存在 |
| `task_state_invalid` | 当前状态不允许这个操作（比如对 `running` 的任务点"确认并启动"） |
| `task_graph_invalid` | GraphValidator 不通过（参数带第一条原因的代码） |
| `task_back_limit` | 这条打回边已用 2 次 |
| `task_already_converted` | 来源对话已经转过（UI 据此打开已有任务） |
| `task_no_project_for_work` | 不属于项目的任务要放 `work` / `check` 节点 |
| `worktree_filter_unsafe` | 仓库的过滤器配置无法安全置空 |
| `workspace_in_task` | 归档或删除一个被任务锁着的 worktree |
| `merge_conflict` | 合并冲突（参数带冲突文件列表） |
| `merge_main_dirty` | 主检出目录有未提交的改动 |
| `schedule_not_found` | 规则不存在 |

## 16. 第一版不做

条件边；agent 节点之间打回；自动重试；预算与超时；拦具体命令（除 §5.5 的路径隔离）；"接着上游对话"起节点；同一任务多个 worktree 并行写；任务跨项目；节点开子对话；节点详情界面；引导词设置页与项目级引导词；`postCreate` 之类的项目安装命令；采用目录前核对 git 身份；自动推送、开 PR；手机端操作任务。

## 17. 实施顺序

每一步都能单独验收，前一步不依赖后一步。

1. **契约测试先行**（`packages/pi/src/contract/task.pi.test.ts`）：
   - `node_done` 带 `terminate` 后这一轮停在工具结果上、`agent_settled` 照常来；
   - 同批调用别的工具时不停；
   - `tool_call` 钩子按路径拦 `edit` / `write`。
2. **数据与调度**：`Task`、`GraphVersion` 等类型；GraphValidator；Scheduler 的 `step`；TaskStore 的事件日志与重放。全部纯函数和文件，不起 pi。
3. **worktree 的三件事**：
   - WorktreeCreator 固定起点并核对、置空过滤器、`.worktreeinclude`；
   - `git worktree lock` / `unlock` 和启动时的清锁；
   - 归档遇到锁的错误码。

   这一步同时改 SPEC-0001 的新建工作区。
4. **节点运行**：TaskRunner；任务扩展的 `node_done`、`request_graph_change`；契约拼装；`check` 角色；路径隔离钩子（含 SPEC-0002 的 `work` 子对话）；提交；失败的四种判定。
5. **任务对话与 /task**：任务对话的工具、进度行、`/task` 命令、需求摘要、写死的引导词。
6. **human 节点与合并、归档提问**。
7. **UI**：任务区（固定的"任务""定时"标签、任务标签的图和任务对话）、列表行内作答、"等你处理"接入。
8. **定时**：ScheduleService、定时标签。
9. **重启恢复**：§12 的全部流程，加泄漏测试。

## 18. 验证

- **Scheduler**：表驱动用例覆盖 §3、§4 每条转移；再加性质测试（随机图 + 随机事件序列）：
  - 不会同时有两个 `work` 在同一 worktree 跑；
  - `stopped` 的任务不起新节点；
  - 打回次数不超过 2；
  - 推出的任务状态和节点状态一致。

  `step` 进变异测试（核心模块，增量 ≥ 80%）。
- **GraphValidator**：每条规则一个通过用例、一个不通过用例。
- **TaskStore**：写到一半崩溃（截断的最后一行）能从事件重放；`task.json` 损坏能重建。
- **worktree**：用 testkit 的 `git.ts` 造场景：
  - 起点被移动后仍从原提交号建；
  - 仓库配了会写文件的 filter 时，worktree 里不执行它；
  - `.worktreeinclude` 只复制被忽略的匹配文件；
  - 锁住时归档报 `workspace_in_task`；
  - 重启后清掉已结束任务的锁。
- **宿主层**（faux 模型脚本）：
  - 一张三节点图从 `/task` 跑到 `done`；
  - 节点不调 `node_done` → 提醒一次 → 失败；
  - 兄弟节点跑完这一轮才停；
  - 打回后下游重置；
  - 改图批准后 `pending` 节点按新定义跑；
  - 宿主重启后 `running` 节点重新起来；
  - 合并冲突时节点失败、任务停下。
- **路径隔离**：真实 pi 加 faux 模型，`write ../outside.txt` 被拦，`write ./ok.txt` 通过；`git -C <主目录> commit` 被拦。
- **泄漏**：任务跑完、取消、宿主关闭后，没有残留的 pi 进程、监听和定时器（`pnpm test:leak`）。
- **端到端**：从对话 `/task`，确认启动，在列表里答一个多选，验收合并，归档时选"归档"。
- 每条新行为登记到 `docs/testing/coverage-map.md`。

## 19. 剩下的风险

- **`terminate` 的版本**：仓库依赖的 `pi-agent-core` 1.0.2 有；本机 pi 是 1.3.0，要在契约测试里实测，不同就以实测为准并更新 pi-internals。
- **名额**：任务对话做父会话，共用 SPEC-0002 的 6 个名额。一张图并行节点多时会排队；第一版接受。
- **合并在主检出目录里做**：如果你正在主目录里手动改东西，合并会被 `merge_main_dirty` 挡住。第一版接受，提示写清。
- **引导词写死**：效果全靠这四段说明，调优只能改代码发版；先接受，等用出经验再做设置页。
