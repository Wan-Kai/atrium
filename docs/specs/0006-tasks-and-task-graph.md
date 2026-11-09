# SPEC-0006：任务与任务图

- **状态**：已确认（2026-11-04 用户确认执行方案）
- **创建**：2026-11-04
- **更新**：2026-11-04（同日按外部审查修订：节点会话与 SPEC-0002 分开、`held` 与 `stopped` 分开、提醒改用 `triggerTurn`、路径隔离按 pi 的解析规则、建 worktree 关掉钩子、合并前的检查、动作幂等）；2026-11-05（T6：任务对话的工具、`/task`、引导词，见“T6 定下的细节”和附录）；2026-11-06（T8a：审核的协议与宿主、`answer_review`、裁决的记录，见“T8a 定下的细节”）
- **相关**：
  - 子对话与扩展通道：SPEC-0002、ADR-0013
  - 问用户：SPEC-0003
  - 审核卡片的技术形状：ADR-0017
  - 新建与归档工作区：SPEC-0001
  - 设计稿：`prototypes/agent-task-board-design.html`（第 5 版）
  - 调研：`docs/research/agent-task-board.md`、`worktree-practices.md`、`task-graph-execution.md`

## 背景与目标

复杂的开发任务现在靠你在一个对话里一步步盯着 agent 做：调研、实现、破坏检查、三方审查、验收合并。你得记住做到哪一步，下一步也得你来开。子对话（SPEC-0002）解决了"分出去做"，但没有解决"按步骤推进"和"每一步只做自己的事"。

这份 spec 加一个**任务**：先把讨论清楚的需求转成一张图，每个节点是一个只做自己那一步的 agent（或者一个由你来做的确认），由宿主按图推进。完成后应达到：

- 在对话里讨论清楚，输 `/task` 就有了一张可以改的初始图，确认就开始跑。
- 每个节点知道整张图、知道下游要做什么，不会顺手把验证的活也干了。
- 只在需要你的时候找你：回答问题、批准改图、失败了怎么办、验收合并。
- 任何时候都能在任务对话里问"到哪一步了、改了什么"。
- 改代码的节点在自己的 worktree 里，写不到别处；结束时问你要不要归档。
- 能定时触发，比如每天凌晨跑一次全量变异测试。

## 非目标

条件边；agent 节点之间打回；自动重试；预算与超时；拦具体命令（除 "路径隔离（扩展的 `tool_call` 钩子）" 的路径隔离）；"接着上游对话"起节点；同一任务多个 worktree 并行写；任务跨项目；节点开子对话；节点详情界面；引导词设置页与项目级引导词；`postCreate` 之类的项目安装命令；采用目录前核对 git 身份；自动推送、开 PR；手机端操作任务。

## 需求

1. 当我在一个对话里把需求讨论清楚了，我希望输 `/task` 就转成任务，自动整理需求摘要、生成初始图，以便不用重新描述一遍。
2. 当初始图不合适，我希望在任务对话里用一句话让 agent 改，图跟着变，以便不用学一个节点编辑器。
3. 当我确认启动后，我希望宿主按图推进、并行的节点同时跑，以便我不用盯着开下一步。
4. 当一个节点在做的时候，我希望它只做自己那一步、知道下游会做什么，以便实现节点不会把验证也做了、审查节点不会审查自己。
5. 当节点有问题要问我、要改图、失败了或到了验收，我希望任务出现在"待我介入"里，能在列表里直接答，以便不用翻进每个任务去找。
6. 当任务在跑，我希望在任务对话里随时问进度和改动，以便不用打开每个节点的对话去拼。
7. 当我想插话或停下某个节点，我希望在它的对话里直接做，以便细的控制不挤在任务界面里。
8. 当节点要改代码，我希望它在任务自己的 worktree 里改、写不到主目录，结束时问我要不要归档，以便不会弄乱手上的工作。
9. 当一件事要每天跑，我希望在对话里说清时间就能变成定时规则，触发出来的每次都是一个任务，以便有异常时像普通任务一样处理。
10. 当宿主重启，我希望任务从停下的地方接着跑，以便长任务不怕中断。

## 方案设计

### 界面

原型见设计稿第 5 版。界面只是任务数据的展示，所有修改都经任务对话或少数几个按钮。

- **入口**：侧栏只有一个"任务"入口，在搜索下面，带"待我介入"的数字。点它，主区换成任务区，任务区有自己的标签栏，和对话的标签不混：
  - 最左两个固定标签"任务"（列表）和"定时"（规则管理），没有关闭按钮；
  - 后面每个打开的任务一个标签，关掉不影响任务继续跑。
- **侧栏和项目目录**：不加任何任务标记。需求对话照常在项目目录里，打开是纯对话，只多一行"已转为任务 X ›"。任务对话和节点对话不进项目目录、不进侧栏。
- **任务列表**：纯列表，按待我介入 → 运行中 → 已完成动态排序。
  - 每行写：名字、"项目 · worktree"（不属于项目的写"对话"）、当前节点、最后活动、状态；
  - 一次展开一行：单选、多选、开放提问、改图批准、归档提问、失败后"重跑这个节点"在行内处理，确认初始图和验收（human 节点的通过 / 打回 / 合并）只给"打开任务"；一行有几张卡片时和任务对话里的 `ControlCards` 一样排成胶囊，一次展开一张；
  - 定时触发的任务名字是"规则名 · 日期"，图标用时钟，和普通任务混排；
  - 已完成只显示最近 7 天、最多 5 条，其余收进"显示全部"；
  - 右上角按项目筛选，多一项"不属于项目"。
- **定时标签**：一条规则一行：名字、项目、每次在哪跑、时间（用好懂的话写，不写 cron）、下次触发、上次结果，以及"立即跑一次 / 暂停 / 恢复 / 修改 / 删除"。没有"新建"：规则从对话 `/task` 来；"修改"打开这条规则的任务对话。
- **任务标签**：创建和运行用同一个布局：
  - 左边是图，每个节点写名字、角色、位置、模型（单独指定的模型写成蓝字），状态用图标表示（未开始、运转中、等你、通过、失败）。点节点只描框高亮，点空白取消；悬停浮出"做什么"和"怎样算完成"。
  - 右边一直是任务对话。每轮改图后，改过的节点描虚线蓝框，新加的标"新"。
  - 任务栏：任务名、项目 · worktree、需求对话的链接、任务模型（只显示，改在对话里说）。按钮：创建时是"放弃任务""确认并启动"，运行时是"暂停任务""取消任务"。
  - 等你批准的改图、human 节点的"通过 / 打回到 X"、归档提问，都以卡片显示在任务对话的底部、输入框上方（任务**列表**里只有改图、归档和节点提问就地作答，human 验收只给"打开任务"）。
- **审核卡片（通用，2026-11-06 用户定）**：等你批准的改图、human 节点的"通过 / 打回到 X"、合并被挡住、归档提问，都是同一个"审核"卡片，放在任务对话底部、输入框上方。它和 SPEC-0003 的提问卡片共用一个外壳（位置、顶上一行、底部按钮、键盘、多张卡片的排法、没提交的输入暂存），内容分两种：提问是"在几个选项里挑"，答案作为信息交回 agent；审核是"对一样已有的东西下裁决"。以后普通对话里也用它（见下面"来源"），所以组件和协议按通用的形状做，T7/T8 先只接任务这一个来源。
  - **组成**，从上到下：
    1. 顶上一行：来源 · 审核什么（如"任务 · N4 验收合并"）；
    2. 证据：几种固定区块按需组合，T7/T8 先做四种：事实（图标加一句话，带好 / 注意 / 危险的状态）、改动（几个文件、加减多少行，点开是改动面板）、图的改动（加、删、改了哪些节点，点开在图上看）、摘要（上游节点或 agent 写的话，默认折叠）；等宽原文的预览等普通对话需要时再加；
    3. 问题提示：上次执行没成功时一条橙色带写原因（如"合并被挡住：2 个文件冲突"，下面列文件）。合并被挡住不是另一种卡片，是同一张卡片的"执行失败"状态，主按钮从"通过"换成"重试"；
    4. 裁决按钮：每个按钮自带要不要原因（不要 / 可选 / 必填）、能指向哪些目标（如"打回到 N2"，多条打回边时可选）、是否推荐（宿主按事实定默认按钮，如没合并的 worktree 默认"先留着"）。要原因时在卡片里展开输入框，不借用下面的输入框；
    5. 结束后卡片收起，过程轨道上留一步（"你通过了 · 图 v3""你打回到 N2：……"），点开看当时的证据，同提问的记录。
  - **输入框**：卡片开着时在输入框发消息算"直接回复"，同 SPEC-0003：agent 发起的审核，这条消息代替裁决交给 agent；任务发起的审核，消息发给任务对话，卡片不动。
  - **几张卡片同时在**（如一个提问加一个审核）：一次只展开一张，其余在顶上一行排成胶囊标签，点了切换；按出现先后排。
  - **来源**：审核由谁发起决定内容可不可信、裁决由谁执行，卡片顶上一行写明来源：
    - **宿主发起（关卡）**：任务的流程（human 节点、批准改图、归档），以后还有"某个工具或命令执行前要审核"这类固定关卡。事实由宿主现算（git 状态、改动统计），可以带状态；裁决由宿主执行，你不通过动作就不发生，模型绕不过去。
    - **agent 发起**（以后的 `request_review` 工具，普通对话里在不可逆或代价大的动作前用）：标题、摘要是模型写的，只按原文显示成引用、标明"agent 说"，不能带状态标记（免得 agent 写一句"测试已通过 ✓"冒充事实）；改动统计仍由宿主现算，不用 agent 报的数。裁决作为工具结果交回 agent，宿主不强制，按钮的说法不暗示有保证。工具和固定关卡另开 SPEC，任务做完后再做。
  - 你看到的文字由界面按"种类 + 参数"写，宿主只发代码和参数。
  - **技术上怎么通用**见 [ADR-0017](../adr/0017-reviews-one-shape-two-sources.md)：一个协议形状 `PendingReview` 挂在会话的控制状态上，宿主的 ReviewHub 汇总、校验、转交，来源各自实现 provider。任务的关卡从调度器的持久状态算出来、由宿主执行、裁决后写一条 `custom_message` 进任务对话；agent 的审核是对话里的一次工具调用，裁决作为工具结果交回模型。
- **任务对话的进度和记录折叠**（2026-11-06 用户定）：进度行（节点开始、通过、失败、等你、合并）和审核的记录都是过程轨道上的一步，两次对话（你的消息、agent 的回复）之间的连成一段，和普通对话的过程一样：正在发生的那段展开，之前的收成一行灰色摘要（"› 任务进度 · 3 个节点通过 · 你批准了图 v2 · 10:02–10:44"），点开再展开。样式同 design-language"过程轨道"。
- **"等你处理"**：任务要你介入的事也进侧栏底部的收件箱，一条写"任务名 · 在等什么"，点了打开任务标签。节点的提问点了直接打开那个节点的对话。
- **搜索**：任务内部的对话也搜得到，结果前面写"任务名 · N2"，点了打开任务标签再打开那个对话。
- **节点对话**：开始过的节点，点任务对话里它的进度行，在任务区开一个标签（任务标签右边，2026-11-06 TP 用户再次确认，设计稿第 8 屏 A）：标签前面一个拐角箭头和节点 id，表示它属于左边那个任务，关掉任务标签时一起关；它就是一个普通会话，全宽显示，能插话、停这一轮。图上点节点不切换视图。

### 已定的取舍

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
- 怎样算完成，信节点自己的 `node_done`；验证交给图里的 `check` 节点，宿主不跑命令。
- 加 `check` 角色：能跑任意命令，不能 `edit` / `write`，只给任务节点用。
- `work` 节点独占它的 worktree：它在跑时同一个 worktree 里没有别的节点在跑，并行的排队（2026-11-04 审查后从"同时只跑一个 `work`"收紧）。
- 一个节点失败，在跑的兄弟节点跑完手上这一轮再停。
- 可写节点结束时提交一次，不推送。
- 节点不能开子对话。
- "验收合并"节点通过时，由宿主按合并流程合并。
- 宿主重启时挂着的问题作废，节点重新起来后再问。
- 节点对话可以用 `ask_user`（SPEC-0003 的例外）。
- "由你来做"的节点只有"通过 / 打回到 X"两种结果。
- 进度行很短、不调模型，进度以现查为准。

**worktree**

- worktree 要写才建，由调度器建。
- 起点固定成提交号。
- 用 `.worktreeinclude` 复制被忽略的文件。
- 建的时候不跑仓库的过滤器、钩子和 fsmonitor。
- 按路径拦截越出工作目录的写操作。
- 任务在用的 worktree 加锁。
- 2026-11-04 随方案一起确认：
  - 起点取来源目录的 HEAD；
  - `.worktreeinclude` 对所有 Atrium 新建的 worktree 都生效；
  - 路径隔离同样加给 SPEC-0002 的 `work` 子对话。
- 要归档时直接问你，不自动归档、不静默保留。

**定时**

- 定时管理是任务区里的固定标签。
- 每次触发新建一个任务。
- 上一次还没结束就跳过这一次；Atrium 开着时错过了，醒来补一次。

### 总体结构

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

### 状态机

#### 节点的当前状态从哪里来

- 每个节点的当前状态取 `runs` 里这个节点**最新的一条** NodeRun（`attempt` 最大的）；还没有 NodeRun 的节点就是 `pending`。
- NodeRun 在节点第一次就绪时创建：agent 节点进 `running`，human 节点进 `waiting`。
- 打回时，被重置的节点里**已经有 NodeRun、且当前不是 `pending`** 的，各新开一条 `pending`，`attempt + 1`；从没开始过的保持没有 NodeRun。
- 作废（`void`）的 NodeRun 仍然是最新那条，读作 `pending`；上游都通过后新开一条，`attempt` 不变。不能跳过它去取更早的一条，否则更早的 `passed` 会复活。
- 节点相关的事件都带 `attempt`：打回后旧会话迟到的事件按 `attempt` 对不上丢掉。
- 重跑失败的节点用原来那条，`attempt` 不变，会话也不变。

#### 节点

```
pending ──上游全过──▶ running ──node_done 结算通过──▶ passed ──被打回──▶（新一条）pending
            │             │ ▲
            │  ask_user / │ │ 你回答 / 改图批准或拒绝
            │  申请改图    ▼ │
            │           waiting
            │             
   running ──任务暂停、兄弟失败（这一轮跑完）──▶ held ──任务恢复推进──▶ running
   running ──你在节点对话里停下──▶ stopped ──你在节点对话里发消息或点"继续"──▶ running
   running ──失败（见下）──▶ failed ──你点"重跑这个节点"──▶ running（同一会话，attempt 不变）
```

- **`held` 和 `stopped` 分开**：
  - `held` 是调度器连带挂起的（任务暂停、兄弟节点失败），任务一恢复推进就自动接着跑；
  - `stopped` 是你亲手停的，只有你让它继续它才继续。
- **`waitingFor`**：`waiting` 的 NodeRun 记下在等什么：
  - `question`：`ask_user`；
  - `graph_change`：申请了改图；
  - `human`：human 节点到了；
  - `merge_blocked`：验收合并被挡住，原因见"合并"。
- **几处边界**（2026-11-04 T3 实现时补）：
  - 任务被挡住（有 `failed`、`stopped` 或 `paused`）时 `waiting(question)` 的节点不停；你回答后它跑完这一轮再进 `held`；
  - 改图批准或拒绝时任务被挡住：申请改图的节点进 `held`，任务恢复时再接着跑；
  - 你亲手停的节点不挡申请改图的节点继续，但任务在 `stopped` 时不起新节点；
  - 暂停期间"重跑这个节点"不生效；
  - 取消任务：`running` 和 `waiting(question)` 的节点立即停下（`stop_node(now)`），节点状态保留原样；
  - 任务到了 `done` / `cancelled` 或被放弃后，之后的事件一律忽略；没有例外。可写节点的 `node_done` 生效后它还是 `running`，带 `commitPending`，提交落定（`committed` 或 `commit_checked`）才 `passed`，所以最后一个可写节点的提交在任务 `done` 之前（2026-11-05 审查后改：原先 `passed` 与 `commit_node` 同一步发出，提交失败时后继已经起了、任务已经结束）。
- **human 节点**：
  - 到了就 `waiting`（`waitingFor: "human"`），你点"通过"后 `passed`；
  - 打回时它自己也新开一条 `pending`；
  - 它没有 `failed`。

**失败**有六种（`FailureReason`）：

| 原因 | 怎么判定 |
|---|---|
| `no_done` | 一轮正常结束（`agent_settled`，不是被停下、不是出错）时，这一轮没有结算出 `node_done`，节点也不在 `waiting`：第一次由宿主发 `/atrium-task nudge`，扩展 `sendMessage(…, { triggerTurn: true })` 开新的一轮提醒它，`nudged = true`；再一轮正常结束仍没有 → 失败。不用 followUp：pi 空闲时 followUp 只进队列、不开新的一轮 |
| `crashed` | pi 进程崩溃且自动重启用完（沿用 SPEC-0001 的规则），或者会话起不来 |
| `model_error` | pi 的自动重试结束为失败（`auto_retry_end { success: false }`），或回复以错误结束、不再重试 |
| `gave_up` | 节点的 `node_done({ ok: false, reason })` 结算生效 |
| `workspace` | 这个节点要用的任务 worktree 建不出来（git 出错、目录占用、配置不安全） |
| `commit` | 可写节点的 `node_done` 已生效，但宿主在它的 worktree 里 `git add` / `git commit` 失败（残留的 `index.lock`、worktree 的顶层目录不是它自己等）。节点 `failed`、`commitPending` 保持，任务 `stopped`，后继不起、任务不结束。你点"重跑"时只重试这一次提交（同一 attempt、不开新会话）：成功则记 `committed`，节点 `passed`，图照常往下走；再失败仍是 `failed(commit)`（2026-11-05 用户确认）。协议包里没有这个枚举的镜像，T5 做协议时再加 |

#### 任务

任务状态由节点状态推出，不另存（`paused`、`cancelled` 是标记）：

```
cancelled                                        → cancelled
没有 approvedAt 的初始图                          → designing
有 failed / stopped，或 paused                    → stopped
有 waiting                                        → waiting
有 running / held                                 → running
所有没有出边的节点都 passed                        → done
其余（已启动，节点都在等 worktree 或名额）          → running
```

"没有出边""没有入边"都只看顺序边，不看打回边。

`held` 不让任务停下：只有失败、你亲手停的节点、暂停标记会。列表分组："designing"、"waiting"、"stopped"进"待我介入"，"running"进"运行中"，"done"、"cancelled"进"已完成"。

### 调度器

```ts
function step(task: Task, event: TaskEvent): { task: Task; actions: Action[] };

type Action =
  | { kind: "ensure_workspace" }                  // 建任务 worktree
  | { kind: "start_node"; node: NodeId; attempt: number }
  | { kind: "resume_node"; node: NodeId; text: string }    // 在原会话里接着跑（重跑、held 恢复、改图结果）
  | { kind: "stop_node"; node: NodeId; when: "now" | "after_turn" }
  | { kind: "nudge_node"; node: NodeId }          // 提醒调用 node_done
  | { kind: "progress_line"; text: ProgressLine } // 写进任务对话，不调模型
  | { kind: "wake_task_conversation"; text: string }      // 只用于 request_graph_change
  | { kind: "lock_workspace" } | { kind: "unlock_workspace" }
  | { kind: "commit_node"; node: NodeId; attempt: number }
  | { kind: "merge"; node: NodeId }
  | { kind: "ask_archive" }
  | { kind: "notify"; attention: Attention };     // 进"等你处理"
```

`step` 是纯函数，不碰时间、不碰 IO（时间从事件里来）；TaskRunner 执行动作，结果再作为事件送回 `step`。这样调度逻辑整块能用表驱动测试和性质测试覆盖，变异测试也只针对它。

**发出动作时，状态当场变**，不等结果事件，防止下一个事件进来时重复发：

- 发 `start_node` 的同时，节点的新 NodeRun 已经是 `running`（会话还在起）；起不来由 TaskRunner 回 `node_failed(crashed)`。
- 发 `ensure_workspace` 的同时，`workspaceState` 从 `"none"` 变成 `"creating"`；`"creating"` 时不再发。
- 发 `merge` 的同时，NodeRun 记 `merging: true`；结果回来前不接受第二次"通过"。

TaskService 对每个任务一个串行队列：一个事件的 `step` 和它产生的动作派发完，才处理下一个事件。

**动作要幂等**（崩溃时可能动作做完了、事件还没写进 `events.jsonl`，重放后会再发一次）：

| 动作 | 怎么认出"已经做过" |
|---|---|
| `ensure_workspace` | 任务目录的 `workspace.json` 已记着这个任务建的工作区 → 直接回 `workspace_created`。建之前先在 `workspace.json` 写下“计划”（分支、目录、起点提交），崩溃后只认和计划一模一样的 worktree，登记并接回；认不出就另建，绝不接手别人的（T9，见“T9 定下的细节”） |
| `start_node` | 索引里已有 `task: { taskId, node, attempt }` 相同的会话 → 接回它，不新开 |
| `commit_node` | worktree 的 HEAD 已经是带 `Atrium-Task: <taskId>/<node>/<attempt>` 尾注的提交 → 记下它，不再提交。"提交过了没有" 看 `NodeRun.commitPending`：调度器在 `node_settled` 发 `commit_node` 的同一步把它置真，`committed`（有提交）或 `commit_checked`（查过，没有改动要提交）把它清掉并让节点 `passed`，`commit_failed` 让节点 `failed(commit)`、标记保留。`host_restarted` 对每个 `commitPending` 且 `running` 的节点重发 `commit_node`，只提交这一个 run，不会把别的节点的改动记在它名下 |
| 节点的第一条消息（契约） | `NodeRun.contractSent`：`node_started` 之后、`sessions.prompt(契约)` 返回后记 `contract_sent`。没有这个标记的节点（prompt 抛错后重跑、或宿主恰好死在两者之间）再被叫起来时，发的是契约，不是"接着做" / "宿主重启了"。prompt 其实已送达、`contract_sent` 还没写时宿主崩溃：T9 起先读会话文件，第一条用户消息已经是契约就补记 `contract_sent`，再发"宿主重启了"，不发第二份契约 |
| `merge` | MergeInspector 判定分支已合并 → 直接回 `merged` |
| `lock_workspace` / `unlock_workspace` | `git worktree list --porcelain` 看当前锁的原因 |
| `progress_line` | 扩展按行的 id 去重 |

**每次 `step` 在应用完事件后都做一遍"推进"：**

1. 任务是 `cancelled`、`designing`、`stopped` → 不推进。
2. 先恢复：所有 `held` 的节点 → `resume_node`（"刚才任务暂停了，接着做"），回到 `running`。
3. 按拓扑序找出所有"就绪"的节点：当前是 `pending`，所有顺序入边的上游当前都 `passed`。
4. human 节点就绪 → 新开 NodeRun，`waiting`（`waitingFor: "human"`），发 `notify`。
5. agent 节点就绪，按拓扑序逐个决定能不能起：
   - `place = workspace` 而任务还没有 worktree（`workspaceState = "none"`）→ 发 `ensure_workspace`，这个节点留在 `pending`，等 `workspace_created`；
   - 要在任务 worktree 里跑（`place = workspace`，或者 `readonly` 但 worktree 已经建好）：
     - **`work` 节点独占 worktree**：worktree 里有任何别的 agent 节点在 `running` / `waiting`，`work` 节点就留在 `pending`；NodeRun 不记在哪个目录跑，所以按任务里所有在跑的 agent 节点算（包括 worktree 建好前在来源目录里跑的只读节点），human 节点不算；
     - 有 `work` 节点在 worktree 里，别的节点也留在 `pending`；
     - 非 `work` 节点之间可以并行；
   - 名额：同一个任务里同时 `running` 或 `waiting` 的 agent 节点最多 6 个（和 SPEC-0002 同一个数，单独计；`waiting` 也算，否则回答问题后会超）；满了留在 `pending`；
   - 其余 → `start_node`。
6. 没有出边的节点都 `passed` → `done`，发 `unlock_workspace`、`ask_archive`（任务建的 worktree，见"归档"）。

**失败**：一个节点 `failed` 时：

- 在跑的兄弟节点收到 `stop_node(after_turn)`，这一轮结束（`agent_settled`）后进 `held`；
- 任务进 `stopped`，不起新节点，发 `notify`。

你点"重跑这个节点"：失败的节点 `resume_node`（"上次失败的原因：…，接着做"）回到 `running`；原因是 `commit` 的（`commitPending` 还在）不 `resume_node`，改发 `commit_node`，只重试提交；任务不再有 `failed`，下一次推进时 `held` 的兄弟节点自动接着跑。

**暂停和恢复**：

- 暂停：`paused = true`，在跑的节点 `stop_node(after_turn)`，这一轮结束后进 `held`；
- 恢复：`paused = false`，推进时 `held` 的节点自动接着跑。
- 你亲手停下的 `stopped` 节点不随恢复自动跑。

**打回**：你在 human 节点选"打回到 X"并写原因：

- 重置的范围是**从 X 出发、沿顺序边能到达的所有节点**（包括这个 human 节点和旁支），不只是 X 到 human 节点的那条路径；
- 其中正在 `running` / `waiting` / `held` 的先 `stop_node(now)`；
- 每个被重置的节点各新开一条 `pending`，`attempt + 1`；X 的那条带上 `backFrom`；
- 下游节点读输入时只认上游**最新一次** `passed`，所以被重置的旁支不会拿旧的交接摘要往下传；
- 同一条打回边已用 2 次的，界面上这个选项置灰，`answer_human` 应答 `task_back_limit`。

### 一个 agent 节点怎么跑（TaskRunner）

#### 起

- **节点对话和任务对话不是 SPEC-0002 的 agent 子对话**。会话记录里带的是 `task: { taskId, role: "conversation" | "node", node?, attempt? }`，没有 `agent` 字段。SessionManager 为它们走单独的启动路径，只借用 SPEC-0002 的两样东西：
  - 起停 pi 的方式（含"做完一轮就停 pi"）；
  - 送达机制（`task_send_to_node` 用它，在轮次边界补进去）。
- 不用 SPEC-0002 的部分：
  - 不给父会话自动回报（没有 `<atrium-agent-report>`），节点结束只经调度器写进度行；
  - 不受"每个父会话 6 个"名额管，名额由调度器自己算；
  - 宿主重启后不按 SPEC-0002 暂停送达（`held = "restart"`），恢复由"宿主重启"一节负责；
  - 没有 `ask_parent`、`report_progress`、`agent_*`。

  `agent-launch.ts`、`agent-relay.ts` 和扩展里凡是判断 `isAgentChild` 的地方，都要把 `task` 会话排除在外。
- 节点对话可以用 `ask_user`：它是你的任务里的一步，不是 agent 替自己开的子对话。这是 SPEC-0003"agent 开的子对话没有 `ask_user`"的例外，实施 T4 时同步改 SPEC-0003。
- 节点对话、任务对话都不进项目目录、不进侧栏（SessionCatalog 按 `task` 字段排除），只在任务区出现。
- 目录：
  - `place = workspace` → 任务 worktree；
  - `readonly` → 任务 worktree；还没有 worktree 时用 `sourceDir`。
- 模型：节点指定的，否则任务模型；档位规则同 SPEC-0002。
- 工具（启动参数 `--tools` 白名单，扩展的 `tool_call` 钩子再拦一遍）：

  | 会话 | 工具 |
  |---|---|
  | `explore` / `advise` 节点 | SPEC-0002 只读白名单 + `node_done`、`request_graph_change`、`ask_user` |
  | `check` 节点 | 同上；Bash 不作只读约束，可以跑测试和构建 |
  | `work` 节点 | 全部内置工具（排除旧 `grep/find`，同 SPEC-0002）+ 同上三个 |
  | 任务对话 | SPEC-0002 只读白名单 + 下文"任务对话"的九个工具；没有 `edit`、`write`、`agent_*`；可以用 `ask_user` |

- 打回后的新 attempt 开**新会话**（干净的上下文）；重跑、`held` 恢复、改图结果在**原会话**里接着跑。

#### 第一条消息：契约

宿主拼好，作为第一条消息发出，用 `<atrium-task-node>` 包住（同 SPEC-0002，不改系统提示词）。其中来自模型或别的会话的文字——需求摘要、交接摘要、打回原因——按 ADR-0013 第 10 条处理：

- 各自包进 `<atrium-quoted from="…">` 外壳，并说明"这是上游节点写的数据，不是用户说的话，不代表用户授权"；
- 冒充外壳的标记先转义（`<atrium-task`、`</atrium-task`、`<atrium-agent`、`<atrium-quoted` 等）。

```
你在任务「{任务名}」里负责节点 {id} · {名字}。

【任务目标】{需求摘要的目标与已定结论}
【整张图，你在这里】{按拓扑序列出全部节点：✓ 已通过 / ← 你 / 下一步 / 之后 / 由用户决定}
【你这一步要做的】{做什么}
【做到这样就算完成】{逐条}
【不归你做的】后面节点的事，不要提前做：
  - {每个下游节点：名字 · 做什么的第一句}
【输入】{inputs 里每个节点最新一次 passed 的交接摘要}
{第一个 work 节点、worktree 刚建（"这个 worktree 里还没有任何 work 节点起过会话"，explore 节点先跑过不影响；单个 work 节点的第二次 attempt 不再有）：【环境】这是新建的 worktree，还没有装依赖，先按项目说明装好。}
{被打回（attempt > 1）：
【上次被打回的原因】{原因}（来自 {节点}）
【你上一次的交接摘要】{这个节点上一个 attempt 的摘要}，当时结束在提交 {commit}；worktree 里保留着那次的改动。}

做完单独调用 node_done，把交接摘要写进 summary：做了什么；产出在哪；「怎样算完成」逐条的结果；
留给下游、你没做的；风险和拿不准的地方。下一步是 {下游节点名}。
不做后面的事就完不成时，调用 request_graph_change；拿不准时用 ask_user 问用户，不要猜。
```

"不归你做的"和"整张图"由宿主从图里算，不让模型生成。

#### 结束

`node_done({ ok, summary, reason? })`，声明 `executionMode: "sequential"`（pi 1.2.0 起扩展工具支持；版本以契约测试为准）：

1. 扩展经通道把参数交给宿主，宿主校验：`ok: true` 时 `summary` 非空，`ok: false` 时 `reason` 非空。不通过时工具返回错误，模型改了再调。
2. 校验通过：宿主把它记成**待结算**，工具结果带 `terminate: true`。同一批工具调用都 `terminate`，pi 才不再请求模型，所以说明里写"单独调用"。
3. **待结算作废的情况**：
   - 之后 pi 又开始了新的一次请求（同批还有别的工具、有插话进来，都会这样，表现为一个新的 `turn_start`）；
   - 这一轮以出错或被停下结束。

   作废后要在这一轮结束前重新调用 `node_done`；没有的话按 `no_done` 处理。
4. 这一轮正常结束（`agent_settled`）时，最后一个待结算的 `node_done` 生效：
   - 可写节点：发 `commit_node`，节点此时仍是 `running`（`commitPending`），提交落定才 `passed`（见"动作要幂等"）；宿主先停掉它的 pi 再提交，这时它再调 `node_done` 一律 `task_caller_invalid`；没改动不提交。提交信息是 `"<任务名> · <节点名>：<摘要第一句>"`，加尾注 `Atrium-Task: <taskId>/<node>/<attempt>`，用 `git add -A`，不推送。
   - 停掉 pi（"做完一轮就停 pi"）；
   - 事件 `node_done` → `step`。

#### 中途

| 发生了什么 | 处理 |
|---|---|
| `ask_user` | 走 SPEC-0003 的问题卡；节点 `waiting`（`question`）；任务列表那一行能直接答；答了回 `running` |
| `request_graph_change({ reason, suggestion })` | 工具结果带 `terminate: true`（同 `node_done`，单独调用），这一轮结束时**不提醒、不提交**，停掉 pi，节点 `waiting`（`graph_change`）。任务对话里写一行"N2 申请改图：{reason}"，并 `wake_task_conversation` 给它的 agent 一条说明（这是唯一会唤醒任务对话模型的系统输入）；agent 出新图等你批准。你批准 → 新图生效，节点 `resume_node`："图已改，下面是新的契约"，附新的"不归你做的"；你拒绝 → `resume_node`："不改图，按原来的做" |
| 你在节点对话里插话 | 节点对话就是普通会话，照常可用；插话会让一个待结算的 `node_done` 作废（见上） |
| 你在节点对话里停下这一轮 | 节点 `stopped`，任务 `stopped`；你在节点对话里再发消息或点"继续"→ `running` |
| 任务对话的 `task_send_to_node` | 同插话，走送达机制，在节点下一个轮次边界补进去 |
| 你暂停任务 | 见"调度器 · 暂停和恢复" |

#### 路径隔离（扩展的 `tool_call` 钩子）

对 `work`、`check` 节点和 SPEC-0002 的 `work` 子对话生效，节点的"工作目录"就是它起的目录。

**`edit` / `write` 的判断，三步**：

1. **按 pi 自己的规则算出目标路径**，和 pi 内置工具用的 `resolveToCwd` 完全一致：
   - 去掉开头的 `@`、展开 `~` / `~/`、把 `file://` 转成路径、把 Unicode 空格换成普通空格；
   - 相对路径按工作目录解析。

   规则写在 `packages/pi/src/task/` 里，契约测试逐条对照 pi 的行为（pi 升级改了规则，契约测试会失败）。
2. **求真实路径**：
   - 目标存在：`realpath` 它（是符号链接就解析到它指向的地方）；
   - 目标不存在：从它往上找最深的、存在的祖先，`realpath` 祖先再拼上不存在的后缀；
   - 悬空的符号链接当作"指向它的目标"，按目标判断。
3. **判定**：
   - 真实路径必须在 `realpath(工作目录)` 之下；
   - 相对工作目录的第一段不能是 `.git`（worktree 里的 `.git` 文件指向主仓库，改了它就能把之后的 git 操作引到别处）。

   不满足就拦下，理由写"只能改 {工作目录} 里的文件"。`.git` 不分大小写（macOS 的卷不分）；真实路径算不出来（链接成环、没有权限）当越界。

**`bash`**（T4 做；T2 只做了 `edit` / `write`）：pi 的 bash 工作目录就是会话目录。命令文本里出现以下任一项、且指向工作目录之外，就拦下：

- `git -C <路径>`、`--git-dir`、`--work-tree`；
- `GIT_DIR=`、`GIT_WORK_TREE=`；
- 改 git 的工作树：`git config core.worktree`、`extensions.worktreeConfig`、`-c core.worktree=…`、`--config-env=core.worktree=…`、`GIT_CONFIG_KEY_n=core.worktree`、`GIT_CONFIG_PARAMETERS`，以及 `git config` 的 `--file` / `-f` 指向工作目录之外、`--global` / `--system` / `--blob`（2026-11-05 审查后补）；
- 看不准就拦：`$'…'`、`$"…"`、`${X:-…}` 这类参数展开、`$@`、`$1`；`builtin cd`、`command cd`、`if cd …; then git …`、`{ cd …; git …; }`、`false && cd …` 这类 `cd` 要么算作 `cd`、要么算作"可能没发生"，git 在任何一个可能的目录里越界都拦；`( … )`、`$( … )` 里的 `cd` 不带出来；读标准输入的 shell（`bash <<< '…'`、`echo '…' | sh`、`sh -s`、不带脚本的 `bash`）一律拦，带脚本文件或 `-c` 文本的照旧（文件内容看不见，见 security.md）。

**拦不住的**：`cp`、`>` 重定向、脚本里的写入。不假装能拦，在 security.md 里写明。只读角色本来就没有 `edit` / `write`，钩子只查 git 的那一条。

### 工作区

#### 什么时候建

`ensure_workspace`：

- 来源对话在 worktree 里：创建任务时就记下这个工作区，`ownsWorkspace = false`，`workspaceState = "ready"`，不会发这个动作；
- 来源对话在项目本地目录：第一次有节点需要时新建，`ownsWorkspace = true`；
- 不属于项目的任务不会走到这里：GraphValidator 不允许 `place = workspace` 的节点。

#### 怎么建（扩展 WorktreeCreator，和手动新建、子对话共用）

1. **起点**：`git rev-parse --verify <sourceDir 的 HEAD>^{commit}` 得到完整提交号。
2. **名字**：沿用 BranchNamer，按任务名生成英文分支 `atrium/<名字>` 和中文别名。
3. **检查仓库配置**：`git config --local --name-only --list` 和 `git config --worktree --name-only --list`（只在开了 `extensions.worktreeConfig` 时查，没开时 git 会报错）。遇到下面任一项，拒绝建，错误码 `worktree_config_unsafe`（`params.reason`：`include` / `filter_name`）：
   - `include.path`、`includeIf.*`；
   - 过滤器名字含 `=` 或换行。
4. **建，同时关掉会执行命令的配置**：

   ```
   git -c core.hooksPath=/dev/null -c core.fsmonitor=false
       -c filter.<git config --list 里每个过滤器，含全局和系统>.smudge= -c filter.<…>.clean= -c filter.<…>.process= -c filter.<…>.required=false
       worktree add -b <分支> -- <目录> <提交号>
   ```

   - 关掉钩子：`git worktree add` 会跑 `post-checkout` 钩子，而 `.git/hooks` 是共享的，agent 能写进去；
   - 关掉 fsmonitor 和过滤器：它们同样是会执行的命令；
   - LFS 文件留成指针；
   - 实测（git 2.50.1，T1）：仓库的 `post-checkout`、`core.fsmonitor`、smudge / clean / process 过滤器、只在全局配置里的过滤器都不执行；`.gitattributes` 里引用但没配置命令的过滤器名本来就不执行。
5. **核对**：建完 `git -C <目录> rev-parse HEAD` 等于起点；不等 → `worktree_create_failed`（`params.reason: "head_mismatch"`），留下目录供检查，不登记。
6. **`.worktreeinclude`**：读来源目录（手动新建是项目目录，子对话和任务是父工作区的目录）的这个文件（`.gitignore` 语法；本身是符号链接当作没有），对每个"匹配且被 git 忽略"（`git check-ignore`）的文件复制过去：
   - 只复制普通文件（`O_NOFOLLOW` 打开，不跟随链接），跳过 `.git` 和 `node_modules`；
   - 用复制，不用软链；
   - 单个文件超过 10 MiB 跳过；总量上限 64 MiB、500 个文件，放不下的那个跳过，后面更小的照样复制；
   - 复制失败不让新建失败；
   - 跳过的只记一条不带路径的 warn 日志。
7. **登记**：登记工作区，记起点提交；"由任务 X 创建"记在任务目录的 `workspace.json`（不在工作区索引，2026-11-05 定）；`workspace_created` → `step`。

失败 → 等着它的节点 `failed(workspace)`，任务停下。

第 3、4 步对所有 Atrium 新建的 worktree 都生效，不只任务的，归档后恢复（`restore_workspace`）也用同样的参数：**现在的"新建工作区"同样会跑 `post-checkout` 钩子和过滤器，是已有的安全问题**，实施 T1 时一起修，并改 SPEC-0001。

#### 宿主自己跑的 git

`commit_node` 和合并时宿主自己跑的 `git commit` / `git merge`，同样走 `workspaces/safe-git.ts` 的 `runSafeGit`（钩子、fsmonitor、过滤器都关掉，不查 include）：

- 理由：agent 能在共享的 `.git/hooks` 里放钩子，宿主执行它就等于替它越权；
- 代价：项目自己的提交钩子（如 lefthook）在宿主的提交上不跑。验证本来就是 `check` 节点的事，接受这个代价；
- 2026-11-05 审查后补：宿主自己的 git 还带 `log.showSignature=false`、`merge.verifySignatures=false`、`commit.gpgsign=false`（不跑仓库配置的 `gpg.program`）；`git diff --cached --quiet` 带 `--no-ext-diff --no-textconv`（不跑 `diff.external`、`diff.<名字>.textconv`；`-c diff.external=` 清不掉，git 会报"cannot run"）；只有退出码 1 算"有暂存"，其余非零都是出错；
- 提交的每条 git 命令都带 `--work-tree=<节点 worktree>`，并先查 `git rev-parse --show-toplevel`（不带 pin）是否就是这个目录，不是就拒绝（节点可以用 `extensions.worktreeConfig` + `core.worktree` 把 git 引去别处）；
- **合并驱动（T5，2026-11-05 评估并关掉）**：`merge.<名字>.driver` 的命令会在合并 `.gitattributes` 里写了 `merge=<名字>` 的文件时执行，配置和属性文件 agent 都能写，所以宿主的合并不能跑它。做法同过滤器：枚举 `git config --list`（含全局和系统）里所有 `merge.<名字>.driver`，每个加 `-c merge.<名字>.driver=`。实测（git 2.50.1）：驱动命令清空后 git 报 "cannot run : No such file or directory"，那个文件按**冲突**处理（走下面"合并"第 4 步的 `merge --abort` 和 `merge_conflict`），不会被"悄悄解决"；清成 `true` 之类反而会让 agent 之外的命令悄悄把文件合成"我方"，所以不用。名字里含 `=` 或换行的驱动 `-c` 带不了，同过滤器：拒绝，`worktree_config_unsafe`（`params.reason: "driver_name"`）。代价：用户自己在全局配了合并驱动（比如 mergiraf）的文件，在宿主的合并里也会变成冲突，由你在 worktree 里自己合并后再通过。
- **`diff.<名字>.textconv`、`diff.external`（T5 评估，不用关）**：实测 `git merge`（带 diffstat）和 `git merge-tree` 都不跑它们；宿主自己的 `git diff` 本来就带 `--no-ext-diff --no-textconv`。合并另带 `--no-stat --no-edit`，不出 diffstat、不开编辑器。
- **MergeInspector 里的 `git merge-tree --write-tree`（T5 发现的原有问题）**：它在 SPEC-0001 的每次工作区扫描里跑，会执行配置里的合并驱动，agent 写一个就能让宿主在后台扫描时执行它的命令（还会让两边都改了的文件被判成 `merged`）。T5 起它也走 `runSafeGit`。同一类的还有扫描里直接跑的 `git status` / `git rev-list` 等没有带安全参数，会跑 `core.fsmonitor` 和过滤器——这是 T1 没覆盖到的原有缺口，不在 T5 里改，记在风险里。
- **合并的目录核对（T5）**：合并和合并前后的每条 git 命令都带 `--work-tree=<目录>`，并且在合并前先查任务 worktree 和主检出目录的 `git rev-parse --show-toplevel`（不带 pin）就是这个目录；不是（节点用 `extensions.worktreeConfig` + `core.worktree` 把 git 引去别处）→ `merge_blocked`（原因 `merge_git_failed`），什么也不合。
- **合并的是提交，不是分支名（T5）**：宿主合并任务 worktree 当前的 `HEAD` 提交号（正是检查过的那一个），提交信息写 `Merge branch '<分支>'`，不依赖名字解析（agent 能建同名的 tag；实测 git 2.50.1 的 `merge` 仍选分支，但不靠这个）。

#### 加锁

- 任务从 `started` 起，对它用的 worktree 执行 `git worktree lock --reason "atrium task <taskId> home <家目录的哈希>"`（哈希是 `ATRIUM_HOME` 路径的 SHA-256 前 12 位十六进制，记下是哪个 Atrium 家目录加的锁），不是任务建的也加；`done`、`cancelled` 时解锁。旧写法 `atrium task <taskId>`（没有家目录那一段）照旧认得，但认不出是哪个家目录的。
- 归档遇到锁着的应答 `workspace_in_task`，界面写"任务 X 正在用"。新旧两种写法都算任务的锁。
- 宿主启动时**只**解同时满足这几条的锁（2026-11-09 用户定，见"T9 / T10 审查后用户定"）：原因是新写法、家目录的哈希就是本机这个家目录的，且任务在本机已结束（`done` / `cancelled`）或目录不存在。别的家目录的锁、旧写法认不出归属的锁、任务目录在但读不出来的锁，一概留着。

#### 合并

- **谁会触发**：human 节点带 `merge: true` 才会在"通过"时合并。
- **GraphValidator 的限制**：
  - 只有没有顺序出边的 human 节点能带它；
  - 任务没有 worktree 时（只读任务、不属于项目的任务）不能带它；
  - 中间的人工确认节点不带它，"通过"就只是通过。

你在 `merge: true` 的节点点"通过"，宿主按 development.md 的标准流程：

1. **任务 worktree 必须干净**：不干净（含未跟踪的文件）→ 不合并，不替你 `git add`，节点 `waiting`（`merge_blocked`，原因 `merge_worktree_dirty`）。
2. **已经合并过的直接算合并了**（T5 排在这里）：MergeInspector 判这个分支是 `merged`（分支在主干历史里，或它的改动已经在主干里）或 `noChange`（任务什么也没改）→ 直接 `merged`，不再合并、不再查主检出目录。这是"动作要幂等"：合并做完、`merged` 事件还没写进日志时宿主崩溃，重放后再发一次 `merge`。
3. **主检出目录必须干净，并且在主干上**。主干的名字同 MergeInspector：项目的覆盖值或 `origin/HEAD`（取 `origin/` 后面的分支名）。不满足 → 不合并，节点 `waiting`（`merge_blocked`，原因 `merge_main_dirty` 或 `merge_main_not_trunk`）；先查干净再查在不在主干。项目没有主干（没有 `origin`、也没设覆盖值）时一律 `merge_main_not_trunk`：宿主不往一个说不清是不是主干的分支里合。
4. **合并**：在主检出目录 `git merge --no-ff --no-edit --no-stat -m "Merge branch '<分支>'" -- <任务 worktree 当前的提交号>`（带上面"宿主自己跑的 git"的参数；仓库没配作者时用 `Atrium <atrium@localhost>`）。合并本身和它之后的收尾不被"关宿主"的取消打断（合到一半关了宿主，比多等几秒更糟）；合并有 5 分钟的上限。
5. **冲突**：先 `git merge --abort`，再确认主检出目录回到合并前的提交、而且干净。冲突的文件取自合并中途的未合并条目（最多记 50 个），记在这条 NodeRun 的 `blockedFiles` 里。
   - 节点 `waiting`（`merge_blocked`，原因 `merge_conflict`，带冲突文件列表），**不进 `failed`**，任务是"等你"而不是"停下"；
   - 你在任务对话里让 agent 处理：它可以改图，加一个在 worktree 里 `git merge <主干>` 并解决冲突的 `work` 节点，放在这个 human 节点前面；
   - 批准后，这个 human 节点有了没通过的上游，按"改图"的规则回到 `pending`，等新节点通过后再到。
   - `merge --abort` 失败、或主目录没回到原样 → 不再碰它，节点保持 `merge_blocked`（原因 `merge_abort_failed`），提示你手动检查主目录。
6. **git 自己出错**（T5）：合并没开始就被 git 拒绝（比如两边没有共同历史）、任务 worktree 在游离的 HEAD 上、主检出目录或 worktree 的顶层目录不对、git 列不出配置——主检出目录回到原样的 → `merge_blocked`（原因 `merge_git_failed`），什么也没动；没回到原样的 → `merge_abort_failed`。合并的动作自己抛错（任务没有 worktree、没有 git）也记成 `merge_git_failed`，节点不会一直停在 `merging`。
7. **成功**：`merged` 事件，节点 `passed`；不推送。

被挡住时，你在主目录处理完（提交、切回主干），在任务列表或任务标签里再点一次"通过"重试。

#### 归档

任务 `done`、`cancelled` 时，任务建的 worktree（`ownsWorkspace = true`）由 `ask_archive` 问你：

- 弹出的确认写清：worktree 名、是否已合并、有没有未提交的改动、相对起点有几个提交；选项"归档"和"先留着"。
- 选"归档"：走现有的 `archive_workspace`，它的检查（未提交、游离提交）照旧当场再做一遍。有未提交的改动时，归档按钮置灰，写"先提交或丢弃"。
- 选"先留着"：任务列表这一行写"worktree 还在"，可以之后再点归档。
- 不是任务建的 worktree，任务结束只解锁，不问、不删。
- **提问存在 `task.json` 里（T5 定）**：`Task.archive` 是 `asked` / `archived` / `kept`；任务结束（`done` 或 `cancelled`）的那一步，调度器在发 `ask_archive` 的同时把它置成 `asked`，所以重启后问题还在；没有 `ask_archive` 的任务（借来的 worktree、没建过 worktree）没有这个字段。回答是事件 `archive_answered { answer }`：这是任务结束后调度器**唯一还收**的事件（`step` 在结束的检查之前处理它）。`asked` → `kept` / `archived`；`kept` 之后还能答"归档"→ `archived`；别的组合忽略。
- **"归档"先做、后记**：`answer_archive("archive")` 先走现有的 `archive_workspace`（同样的检查，`workspace_dirty`、`workspace_unsaved_commits` 等照样原样报给界面），成功后才记 `archive_answered`，所以被拒绝时问题还开着。worktree 已经被别处归档的，`archive_workspace` 本来就当没事。
- **问题里显示的事实**不存、问的时候现算（`TaskView.archiveFacts`，`asked` 和 `kept` 时才算）：worktree 的名字（别名，没有就用目录名）、是否已合并（MergeInspector 的 `merged` 或 `noChange` 算"已合并"，`pending` 算"没合并"，其余是"不知道"）、有没有未提交的改动、相对 `baseCommit` 有几个提交。算的时候的 git 走 `runSafeGit`。

### human 节点

- 没有会话。到了就 `waiting`，任务列表、"等你处理"各出现一条（"等你验收合并"）。
- 你看到：它的"做什么"、"怎样算完成"、直接上游的交接摘要、worktree 相对起点的改动统计（ChangesService）。
  - T5 里 `TaskView` 带前三样（`job`、`done`、每个节点的 `summary`，直接上游从 `edges` 里取）、任务的 `workspaceId` 和每条打回边已用几次（`sendBack`）。改动统计不重复做一份：界面对任务的 `workspaceId` 用现成的 `watch_changes` 就有（胶囊和改动面板），T7 接上；`pnpm task:try` 自己用 `git diff --shortstat <baseCommit>` 打出来。
- 你的选择只有：**通过**（带 `merge: true` 的会合并，见"合并"）；**打回到 {它有打回边的节点}**，要写原因。
- "确认初始图"不是节点，是开始页的"确认并启动"（`designing → running`）。

### 改图

- 只有任务对话的 agent 能出新图（`task_propose_graph`）；节点用 `request_graph_change` 申请。
- GraphValidator 的校验（不通过，工具返回带原因的错误，agent 自己改）：
  - **结构**：
    - 顺序边无环；打回边只能从 human 节点指向它的上游；
    - 节点 id 唯一，且只含 ASCII 字母、数字、`_`、`-`，首字符是字母或数字，最长 32（`bad_node_id`）：id 会进契约、会话名和提交尾注，带标签或换行的 id 能冒充宿主的话（契约里所有写 id 的地方另外也都转义）；
    - 至少一个没有入边的节点，至少一个没有出边的节点；
    - 节点数上限 20（防止生成失控）。
  - **字段**：
    - agent 节点有 `job`、`done`、`role`；
    - human 节点没有 `role`、`model`、`place`；
    - `merge: true` 只在没有顺序出边的 human 节点上，且任务能有 worktree。
  - **不属于项目的任务**：没有 `work`、`check` 节点，也没有 `place = workspace`。
  - **启动后**：
    - 有 NodeRun 的节点不能删，它的字段也不能改；当前是 `pending` 的（比如被打回后新开的）不算，可以改；
    - 连到"当前 `running` / `waiting` / `held` / `stopped` / `passed` 的节点"的入边不能改。`passed` 也锁：否则终点节点通过后再给它加上游，任务会按"终点都通过"提前算 `done`；
    - 例外：`waiting` 的 human 节点（不在合并中）可以加上游，用于合并冲突后插入解决冲突的节点，见下面"批准后"；
    - 没有 NodeRun 的节点、指向它们的边随便改、删。
- **生效时机**：`designing` 时直接生效（`approvedAt` 在"确认并启动"时写）；启动后进 `pendingGraph`，你批准才生效。
- **批准后**：
  - 删掉的节点从新版本里消失（旧版本里还在）；
  - 当前 `waiting` 的 human 节点如果多了没通过的上游（比如合并冲突后插进来的节点）→ 回到 `pending`：它当前这条 NodeRun 记为作废，等上游通过后新开一条；
  - 其余按就绪规则推进。

### 任务对话

- 一个普通的 pi 会话，目录是 `sourceDir`（不随 worktree 移动），工具见"起"的表格。任务对话的九个工具：

| 工具 | 做什么 |
|---|---|
| `task_read_source({ page? })` | 分页读来源对话（只读；创建时用） |
| `task_set_summary({ summary })` | 写需求摘要（`designing` 时；启动后改摘要算改图；T6 起 `summary` 是六个字段的对象，启动后一律拒绝，见“T6 定下的细节”） |
| `task_set_meta({ name?, model? })` | 改任务名、任务模型（任务模型只影响还没开始的、继承任务模型的节点） |
| `task_status()` | 当前图、每个节点的状态与用时、任务状态、待批准的图 |
| `task_read_node({ id, what: "contract" \| "summary" \| "transcript" })` | 读某个节点的契约、交接摘要或对话全文（截断到 4000 字，分页） |
| `task_diff({ since?: NodeId })` | worktree 相对起点或某个节点结束时提交的改动（stat + diff，截断） |
| `task_propose_graph({ nodes, edges, note })` | 出新图，按"改图"生效或等批准 |
| `task_send_to_node({ id, text })` | 给在跑的节点补一句；不在跑的报错 |
| `task_set_schedule({ when, place })` | 把这个任务标成定时规则的模板（"定时"） |

- **进度行**：
  - 什么时候写：节点开始、通过、失败、等你，worktree 建好，合并；
  - 怎么写：宿主经 `/atrium-task progress` 让扩展 `sendMessage(…, { triggerTurn: false })` 写一条 `custom_message`（`customType: "atrium-task"`，`details.kind: "progress"`，带行 id 去重），带时间，不调模型；
  - 界面画成系统提示行。
- 它不能改节点状态：重跑、通过、打回、暂停、取消只在界面上。

### /task 与创建

1. 来源对话里输 `/task [范围]`：这是 Atrium 的内置命令，界面拦下后调 `create_task(sessionId, scope?)`，不发给来源对话的模型。
2. 宿主建任务记录（`designing`），开任务对话：模型 = 来源对话当前的模型；第一条消息是 `<atrium-task-design>`，包括：
   - 来源对话的会话 id；
   - 范围；
   - 写死的四套引导词全文；
   - 指令：先 `task_read_source` 读来源对话，再 `task_set_summary`，按选定的引导词 `task_propose_graph`，最后用一两句话告诉用户选了哪套、图长什么样、还有什么未决问题。

   范围和来源对话的文字同样按"契约"一节的规则包外壳、转义。
3. 来源对话里写一行 `custom_message`（`details.kind: "converted"`，带任务 id），界面画成"已转为任务 X ›"。
4. 打开任务区的这个任务标签。
5. 你在任务对话里改；点"确认并启动"：GraphValidator 再校验一次 → `started` → `step`。

**一个来源对话只对应一个任务**：已经转过的再 `/task`，`create_task` 应答 `task_already_converted`（带任务 id），界面打开那个任务。

**放弃任务**（`designing` 时的"放弃任务"）：

- 删掉任务记录，归档任务对话；
- 来源对话里"已转为任务"那一行改成"任务已放弃"；
- 之后可以重新 `/task`。

启动后只能"取消任务"，取消的任务留在已完成里，来源对话仍然对应它。

### 定时（ScheduleService）

- **怎么来**：从对话 `/task` 时由 agent 判断。需求里说了"每天几点"，agent 调 `task_set_schedule({ when, place })`，任务记下 `scheduleDraft`，这时它是一个"规则模板"，开始页的按钮写"确认并保存规则"。
  - 确认后存成 ScheduleRule：`taskSessionId` 指向这个模板的任务对话，之后在定时标签点"修改"就打开它；
  - 模板任务本身不进任务列表，也不跑；
  - 不立即跑，可以在定时标签点"立即跑一次"。
  - **改规则的时间或频率**，从改的那一刻起算：`lastFiredAt` 记成保存的时间（取它和原值里晚的），改之前的时间点不补，保存本身也从不当场触发（2026-11-09 用户定）。
- **到点**：
  - 这条规则的上一个任务没结束（不是 `done` / `cancelled`）→ `skipped + 1`，`lastFiredAt` 照样推进到这次的触发时间。"上一个任务"包括"立即跑一次"建的（它算规则最近的任务，在它结束前下一个到点的时间点照样跳过），也包括磁盘上 `origin.ruleId` 是这条规则、还没结束、但 `lastTaskId` 没来得及存的任务（崩在中间）；
  - 否则按规则新建 Task：`origin.kind = "schedule"`，跳过 `designing`，直接 `started`；
  - `place = new_worktree` 时，第一个要 worktree 的节点开跑前建（同"工作区"）；`local_readonly` 的规则，GraphValidator 不许有 `work` 节点。
  - `lastTaskId` 指向的任务被删了，当作已结束。
- **pi 没准备好**（没装或版本不对）：到点时不触发，也**不用掉这个时间点**（`lastFiredAt` 不动），记一条 warn（只有代码和参数，一次不装好只记一次）。之后 pi 好了的那次启动按"错过补一次"补跑一次；定时标签不为此加状态（2026-11-09 用户定）。
- **规则文件读不出来**（不是 JSON 或版本不认得）：确认、暂停、恢复、删除、修改、立即跑一次都答 `schedule_file_unreadable`，内存里不装任何规则、不挂定时器、文件原样不动；定时标签用这条错误代替规则列表（2026-11-09 用户定）。
- **错过**：宿主启动、系统唤醒（`powerMonitor` 由 desktop 经宿主入口转来）时，对每条规则算"按 `max(lastFiredAt, createdAt)` 之后应该触发的最近一次"；它早于现在，就补跑一次（错过多次也只补一次），然后 `lastFiredAt` 记成这次应该触发的时间。刚建的规则不会补跑建之前的时间点。
- **时间**：
  - 按本机时区的钟点算；
  - 夏令时：拨快那天不存在的钟点，顺延到之后第一个存在的分钟；拨慢那天重复的钟点只触发一次；
  - 系统时间被往回拨：不补、不重复，等下一个时间点。
- 时间经注入的 Clock；`Cadence` 的下次时间是纯函数，测试快进。

### 宿主重启

1. 宿主启动、找到 pi 之后，对磁盘上每个已启动、没结束的任务做一次 `recover`（`recoverAll`，见“T9 定下的细节”）。每个任务先读 `task.json`，和 `events.jsonl` 的末尾比对 `seq`，落后就从事件重放（取用任务时 `TaskStore` 已做）。
2. TaskRunner 先读会话文件：待结算的 `node_done` 那一轮已经结束的，先送 `node_settled`（`step` 是纯函数，读不了会话文件）。再给每个任务送 `host_restarted`。调度器按 `waitingFor` 和状态区分：
   - **`running`**：pi 已经不在。如果有待结算的 `node_done` 且它那一轮已经结束（会话文件里能看到 `terminate` 的工具结果是最后一条）→ 先由 TaskRunner 送 `node_settled` 结算；否则 `resume_node`："宿主重启了。先看一下你已经做了什么（会话记录和 worktree 的改动），再接着做；做完调用 node_done"。起不来 → `failed(crashed)`。
   - **`waiting`（`question`）**：问题按 SPEC-0003 作废，节点 `resume_node`："刚才的问题作废了，需要的话再问"。
   - **`waiting`（`graph_change`）**：保持等待。`pendingGraph` 已有就继续等你批准；还没有（任务对话的 agent 没来得及出图）→ 再 `wake_task_conversation` 一次，带着落盘的理由和建议。
   - **`waiting`（`human` / `merge_blocked`）**：不动。
   - **`running` 且 `commitPending`**：不 `resume_node`，重发 `commit_node`（只这一个 run；认出已做的提交见"动作要幂等"）。
   - **`held`**：任务不在 `stopped` 时，推进里自动恢复；**`stopped`**：不动。
   - **`merging: true` 的节点**：按"动作要幂等"先查分支有没有合并，再决定 `merged` 还是回到 `merge_blocked`。
3. 解掉已结束任务留下的锁（"加锁"）：已 `done` 或 `cancelled` 的任务，TaskRunner 在 `recover` 里再 `unlock_workspace` 一次（幂等）；启动时另扫一遍各项目的仓库，只解"加锁"里列的那几条都成立的锁（本机家目录加的、任务已结束或目录不存在）。没结束的任务重新 `lock_workspace`（幂等，补上 `workspace_created` 之后、加锁之前崩溃的那一下）。
4. 每个任务 `step` 一次。

## 接口与数据

### 数据

#### 任务记录 `task.json`

```ts
type Task = {
  id: TaskId;                       // tsk_…
  name: string;
  projectId: ProjectId | null;      // null = 不属于项目
  workspaceId: WorkspaceId | null;  // 任务用的工作区
  workspaceState: "none" | "creating" | "ready";
  sourceDir: string;                // 来源对话的目录：只读节点在 worktree 建好前在这里跑
  ownsWorkspace: boolean;           // worktree 是不是这个任务建的（决定归档时问不问、能不能删）
  baseCommit: string | null;        // 建 worktree 时的完整提交号
  model: { providerId; modelId; thinking };
  guide: { id: GuideId; version: number };
  summary: RequirementSummary;      // 目标、已定结论、约束、不做、未决问题、验收要点
  origin: { kind: "chat"; sessionId } | { kind: "schedule"; ruleId; firedAt };
  scheduleDraft: { when: Cadence; place: SchedulePlace } | null;  // 规则模板才有
  taskSessionId: SessionId;         // 任务对话
  graphs: GraphVersion[];           // 只增不改
  activeGraph: number;              // 当前生效的版本号
  pendingGraph: number | null;      // 启动后等你批准的新版本
  runs: NodeRun[];
  paused: boolean;
  cancelled: boolean;
  createdAt; startedAt | null; endedAt | null;
  archive?: "asked" | "archived" | "kept";  // 归档提问（T5）：任务结束且 ownsWorkspace 时置 asked，回答后改
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
  merge?: true;                     // 只在没有顺序出边的 human 节点上："通过"时合并
};

type Edge = { from: NodeId; to: NodeId; kind: "seq" | "back" };   // back 只能从 human 节点出

type NodeState = "pending" | "running" | "waiting" | "held" | "stopped" | "passed" | "failed";

type NodeRun = {
  node: NodeId;
  attempt: number;                  // 第几次：只有打回加一；重跑沿用原来的
  graph: number;                    // 按哪个图版本开始的
  state: NodeState;
  waitingFor: "question" | "graph_change" | "human" | "merge_blocked" | null;
  blocked: MergeBlockReason | null; // merge_worktree_dirty | merge_main_dirty | merge_main_not_trunk | merge_conflict | merge_abort_failed | merge_git_failed
  sessionId: SessionId | null;      // human 节点为 null
  startedAt; endedAt | null;
  startCommit: string | null;       // 节点开始时 worktree 的 HEAD（判断它有没有改动）
  pendingDone: { ok: boolean; summary?: string; reason?: string } | null;  // 待结算的 node_done
  summary: string | null;           // 交接摘要
  failure: FailureReason | null;    // no_done | crashed | model_error | gave_up | workspace | commit
  commit: string | null;            // 结束时的提交（可写节点有改动时）
  backFrom?: { node: NodeId; reason: string };     // 被打回时的来源和原因
  void?: true;                      // 改图后作废（human 节点多了上游）
  merging?: true;
  nudged: boolean;                  // 是否已经提醒过一次"还没调用 node_done"
  blockedFiles?: string[];          // merge_conflict 时冲突的文件（最多 50 个，T5）
  commitPending?: true;             // node_done 生效、提交还没落定（committed / commit_checked 清掉；commit 失败时保留）
  contractSent?: true;              // 契约已交给节点的 pi
  graphRequest?: { reason: string; suggestion: string }; // waiting(graph_change) 时节点写的理由和建议（T9 落盘），等待结束就清掉
};
```

#### 事件 `events.jsonl`

每行一个事件：`{ seq, at, type, ...payload }`，载荷以 `packages/host/src/tasks/types.ts` 的 zod 定义为准；节点相关的带 `attempt`。`task.json` 外面包一层 `{ version, seq, task }`，重启时用 `seq` 比对。调度器的输入就是这些事件；`task.json` 是按事件算出来的快照，写坏了可以从事件重放出来。事件类型：

- `created` / `graph_proposed` / `graph_approved` / `graph_rejected` / `started` / `abandoned`
- `meta_changed`：任务名、任务模型
- `node_started` / `node_waiting`（`graph_change` 的带 `request: { reason, suggestion }`）/ `node_resumed` / `node_done_pending` / `node_done_void` / `node_settled` / `node_failed` / `node_stopped` / `node_held`
- `human_passed` / `human_sent_back`
- `rerun_requested` / `paused` / `resumed` / `cancelled`
- `workspace_creating` / `workspace_created` / `workspace_failed`
- `committed` / `commit_checked` / `commit_failed` / `contract_sent` / `merge_started` / `merged` / `merge_blocked`
- `archive_asked` / `archive_answered`
- `host_restarted`

事件里不放对话内容，只放 id、状态和你写的打回原因。交接摘要和打回原因一样，属于任务数据，不是日志：observability 的"日志不记对话内容"管的是宿主日志，不管这里。

#### 定时规则 `~/.atrium/schedules.json`

```ts
type SchedulePlace = "new_worktree" | "local_readonly";

type ScheduleRule = {
  id: RuleId;
  name: string;
  projectId: ProjectId;
  when: Cadence;                    // { every: "day", at: "02:00" } | { every: "week", day: 1, at: "10:00" } | …（本机时区）
  place: SchedulePlace;
  summary: RequirementSummary;
  graph: Pick<GraphVersion, "nodes" | "edges">;
  model;
  templateTaskId: TaskId;           // 规则模板的任务
  taskSessionId: SessionId;         // 模板的任务对话："修改"打开它
  paused: boolean;
  createdAt: number;
  lastFiredAt: number | null;       // 最近一次应该触发的时间（跳过也推进）
  lastTaskId: TaskId | null;
  skipped: number;                  // 最近一次真正新建任务之后跳过了几次
};
```

### 扩展与通道

- 任务扩展在 `packages/pi/src/task/`，由 `packages/pi/src/extension/atrium.ts` 注册。它按启动参数 `--atrium-task=<base64url JSON>` 决定这个会话是节点、任务对话，还是都不是（都不是时不注册工具，只注册隐藏命令里的 `mark`，T6 起）。参数只说会话的种类和角色，不用来认身份。
- 工具调用经 ADR-0013 的通道：
  - 扩展 `setStatus("atrium-task:<id>", JSON)` 发请求、挂着等；
  - 宿主用隐藏命令 `/atrium-task reply <id> <base64url>` 回答；
  - 宿主下发用 `/atrium-task progress|nudge|resume <参数>`。
- **调用方由宿主认定**：宿主按收到请求的 pi 进程查出它是哪个会话（同 SPEC-0002），再查会话记录的 `task` 字段，绝不采信参数里的身份。
  - `task_*` 只接受 `role: "conversation"` 且是这个任务的 `taskSessionId` 的会话；
  - `node_done`、`request_graph_change` 只接受这个节点最新一条 NodeRun 的 `sessionId`，且节点在 `running`。
  - 不符的应答 `task_caller_invalid`，不执行。
- 参数和回答都经 zod 校验（schema 在 `packages/pi/src/task/schema.ts`）。宿主日志只记命令名和 id，不记参数。
- **T4a 定下的细节**（2026-11-05，接口以 `packages/pi/src/task/schema.ts` 为准）：
  - 请求 `{ v: 1, id, kind: "call", op, args }`，`id` 是工具调用 id；工具被停下时扩展发 `{ kind: "note", op: "cancel" }`，宿主丢掉这次调用、不回答；同一个 id 只认第一次回答；
  - 通道错误码在 `task_caller_invalid` 之外加 `task_args_invalid`（`params.field`）、`task_bad_request`、`task_failed`；`task_text_too_long` 由扩展自己回；长度上限沿用 SPEC-0002 的数（交接摘要 32 000、原因 4 000）；
  - `node_done({ ok: true })` 要非空的交接摘要、`ok: false` 要非空的原因，由宿主核对；
  - `nudge` 的提醒文字由扩展写；`resume` 的文字由宿主给（`kind`：`continue` / `restarted` / `graph_changed` / `graph_rejected` / `wake`），扩展套上 `<atrium-task-resume>` 外壳；`nudge` / `resume` / `progress` 都按 `id` 去重（进程内和会话文件里），只在 pi 空闲时下发；
  - **待结算由宿主按 pi 的事件判定**，扩展不额外上报：宿主回答 ok 时记为待结算；之后的 `turn_start` 作废；`agent_end` 的最后一条助手消息 `stopReason: "error"` 作废；`agent_settled` 带 `aborted: true` 作废（停下时 pi 也会补一个 `turn_start` 和 error，要先看 `aborted`）；`agent_settled` 时还在就结算，没有且不是停下或出错 → `no_done`；
  - 节点的 `--tools` 白名单要带 `node_done`、`request_graph_change`、`ask_user`；节点不带 `--atrium-agent`；扩展的 `tool_call` 钩子按角色再查一遍；
  - 路径隔离和 git 拦截对四种角色的节点都默认打开（只读角色也能在 bash 里 `git -C`），`--atrium-task` 里 `isolated: false` 才关。
- **T4b 定下的细节**（2026-11-05，宿主侧，代码在 `packages/host/src/tasks/`）：
  - 只提交 `role = work` 的节点；`check` 等节点留下的改动不提交，由后面 work 节点的 `git add -A` 一起带走；
  - "没改动不提交"按 `git add -A` 之后暂存区是否为空判断；节点自己提交过、树是干净的 → 不提交，也不发 `committed`；
  - `stop_node(after_turn)` 时 pi 恰好空闲 → 立即 `node_held`；但宿主刚发出 prompt / nudge / resume、`agent_start` 还没到的 15 秒内算"还没开始的一轮"，要等这一轮；被要求 hold 的节点这一轮里 `node_done` 已生效 → 照常通过，不进 `held`（调度器也忽略带着待结算 `node_done` 的 `node_held`）；
  - 判定（judge）和 `stop_node` 读状态都在任务队列里，按到达顺序；调用方校验、记 `node_done_pending`、judge 记账是同一个队列步骤，所以"回答问题后立刻 `node_done`"不会读到过时状态；扩展撤回（`note`）的调用不记；
  - 同一批里 `node_done` 之后又 `request_graph_change`：`node_done` 作废（`node_done_void`），改图申请生效；待结算的 `node_done` 在节点停下后继续、被放行（`held`→`running`）、新一次 pi 启动时都清掉；
  - 你停下的节点（`stopped`）在它的对话里又开始一次运行（发消息 / "继续"）→ 先记 `node_resumed` 再接受它的调用；
  - pi 在一轮中间崩溃、被会话控制器成功重启：控制器只会重发用户的消息，不会重发宿主的契约 / nudge / resume，新 pi 会空转。宿主看到新一次 pi 启动时那一轮还在走（或刚发出）且不是宿主自己停的，就作废这一轮的 `node_done`，再给节点发"宿主重启了"那条 `resume`（契约没送到过就发契约）；
  - `crashed` 的去重按次：重跑、放行或 pi 重新启动、控制状态里的失败消失后，下一次失败会再报；
  - 关宿主时先取消在途的会话请求（`prompt` / `command` 带 `AbortSignal`）再等队列排空；结束了的任务的节点上下文随任务释放；
  - 带 `task` 字段的会话（节点、任务对话）绝不用 agent 的启动参数（全工具、无隔离）：没有角色的节点、还没有启动路径的任务对话，启动时直接报错；
  - 任务 worktree 的标记 `workspace.json` 指向的工作区没有 base commit 时报错，不再另建一个；`createFrom` 带取消信号，已取消就不建、也不记 `workspace_created`；
  - `crashed` = 会话起不来，或控制器重启 3 次都失败（沿用 SPEC-0001）；`model_error` = pi 不再重试的出错，重试成功不算；
  - 批准改图后的 `resume` 文字只带新图和新的"不归你做的"，不重发本节点的"做什么 / 怎样算完成"；
  - 契约的"任务目标"只放目标和已定结论；节点名和"做什么"只转义，需求摘要、交接摘要、打回原因才包 `<atrium-quoted>`；
  - `request_graph_change` 的理由和建议随 `node_waiting` 事件落盘（`NodeRun.graphRequest`，T9），重启后的唤醒带着它们；
  - 来源对话在目录里找不到时，退回按 `sourceDir` 找所在的工作区。
- `/atrium-task` 和别的 `/atrium-` 隐藏命令一样受 `command_reserved` 保护：你打的、粘贴的以它开头的消息不发给 pi。

### 协议（给 UI）

- **T5 做了什么、没做什么**（2026-11-05，协议号 29 → 30；合回 `main` 时取当时的下一个号）：下面的命令里，T5 只加宿主这一侧已经有的：`list_tasks`、`open_task`、`answer_human`、`rerun_node`、`continue_node`、`pause_task`、`resume_task`、`cancel_task`、`answer_archive`，事件 `tasks_updated`、`task_updated`。`create_task`、`start_task`、`abandon_task`、`approve_graph` / `reject_graph` 属于 T6（任务对话和改图），`list_schedules` 等属于 T10，到时再加（T10 已加，见“T10 定下的细节”）。代码在 `packages/protocol/src/tasks.ts`（数据）和 `commands.ts`（命令）；仓库里协议文件是平的，不分 `commands/`、`events/` 目录。
- **命令**（`protocol/commands/tasks.ts`）：
  - 任务：
    - `create_task(sessionId, scope?)`：`/task` 走它
    - `list_tasks`
    - `open_task(taskId)`：订阅这个任务的状态
    - `start_task`：确认并启动；规则模板是确认并保存规则
    - `abandon_task`：`designing` 时放弃
    - `approve_graph` / `reject_graph`
    - `answer_human(taskId, node, { pass } | { backTo, reason })`：`merge_blocked` 时再点 `pass` 就是重试合并
    - `rerun_node` / `continue_node`（继续你停下的节点）
    - `pause_task` / `resume_task` / `cancel_task`
    - `answer_archive(taskId, "archive" | "keep")`
  - 定时：
    - `list_schedules`
    - `pause_schedule` / `resume_schedule` / `run_schedule_now` / `delete_schedule`
    - `edit_schedule`：打开它的任务对话
- **事件**（`protocol/events/tasks.ts`）：
  - `tasks_updated`：列表，沿用 generation+seq 增量；
  - `task_updated`：单个任务的图、节点状态（含 `waitingFor`、`blocked`）、待批准的图、归档提问；
  - `schedules_updated`。
- 任务对话和节点对话的内容走现有的会话订阅，不另开通道。
- 新协议版本号加一。手机端（remote-policy）第一版只读：能看列表和状态、能答 `ask_user`，不能启动、批准、合并。
- **T5 定下的协议细节**：
  - `list_tasks({ watch? })`：答 `TaskSummary[]`；`watch: true` 让这条连接收 `tasks_updated`，`false` 取消。`tasks_updated { seq, tasks }` 每次发**整张列表**（不做增量，任务少时够用；`seq` 是宿主发的次数，客户端丢掉比自己手里小的）。列表包含磁盘上还没被取用的任务（读它们的文件，不启动任何东西；重启后把在跑的任务接起来是宿主启动时的 `recoverAll`，T9）。
  - `open_task({ taskId })`：答 `TaskView`（摘要加当前生效的图、每个节点最新一条 NodeRun 的状态、`waitingFor`、`blocked` 和 `blockedFiles`、失败原因、交接摘要、会话 id、打回边用了几次、`pendingGraph` 是否有、归档提问和它的事实）；这条连接之后收这个任务的 `task_updated`（也是整张），再打开别的任务就换成那个；连接断开自动取消。
  - `answer_human(taskId, node, answer)` 的 `answer` 是 `{ kind: "pass" }` 或 `{ kind: "send_back", backTo, reason }`（协议生成 Swift 的联合要有一个判别字段，所以不写成 SPEC 原来的 `{ pass }` / `{ backTo, reason }`）。
  - 手机：`list_tasks`、`open_task` 和两个事件可以，其余 `local_only`。
  - 协议里的枚举（节点状态、失败原因含 `commit`、`merge_blocked` 的原因含 `merge_git_failed`、`waitingFor`、任务状态）是宿主类型的镜像，宿主的单元测试比对两边。
  - 列表行的 `attention`：`failed` > `merge_blocked` > `human` > `question` > `graph_change`，都不是则 `null`（T5 自己定的，分组仍按 `status`）。

- **T6 做了什么**（2026-11-05，协议号 30 → 31；合回 `main` 时取当时的下一个号并重新生成 Swift 投影）：命令 `create_task`（答 `{ taskId }`）、`start_task`、`abandon_task`、`approve_graph`、`reject_graph`，全是 `local_only`（手机只读）；错误码 `task_graph_invalid`（`params.code`、`params.node`）、`task_already_converted`（`params.taskId`）、`task_no_project_for_work` 进协议。`TaskView` 没加字段（需求摘要、来源会话 id、引导词给界面用，T7 再加）。`start_task` 在规则模板上是“确认并保存规则”属 T10。

### 错误码

| 错误码 | 什么时候 |
|---|---|
| `task_not_found` | 任务 id 不存在 |
| `task_state_invalid` | 当前状态不允许这个操作（比如对 `running` 的任务点"确认并启动"、对启动后的任务"放弃"） |
| `task_graph_invalid` | GraphValidator 不通过（参数带第一条原因的代码） |
| `task_back_limit` | 这条打回边已用 2 次 |
| `task_read_only` | 这个任务是 `ATRIUM_FOLLOW_TASKS` 只读跟着的（别的进程在写它的目录），任何改动它的命令都被拒绝（T7.1；界面说法见"T7.1 定下的细节"） |
| `task_already_converted` | 来源对话已经转过（带任务 id，UI 据此打开已有任务） |
| `task_no_project_for_work` | 不属于项目的任务要放 `work` / `check` 节点 |
| `task_caller_invalid` | 工具调用的会话不是这个工具该来的会话 |
| `worktree_config_unsafe` | 仓库配置里有 `include` / `includeIf` 或不安全的过滤器名（`params.reason`：`include` / `filter_name`） |
| `workspace_in_task` | 归档或删除一个被任务锁着的 worktree（`params.taskId`）；只认锁的原因正好是 `atrium task <id>` 的，你自己加的锁照旧报 `worktree_remove_failed` |
| `review_closed` | 这条审核已经没有了：别处先答了，或状态已经往前走了（带 `reviewId`；T8a，界面说法"这条审核已经处理过了"） |
| `review_invalid` | 裁决和审核对不上（`params.field`：`action` 没有这个按钮、`target` 缺了或不在按钮列的目标里、`reason` 必填的没写或不收原因的写了；T8a，界面说法"这个裁决不合这条审核，刷新后再试"） |
| `schedule_not_found` | 规则不存在（或确认保存规则时，规则或它的模板在排队等待的时候被删了） |
| `schedule_file_unreadable` | `schedules.json` 读不出来（不是 JSON、版本不认得），所以确认、暂停、恢复、删除、修改、立即跑一次都不做，也不覆盖这个文件；界面说法「定时规则文件读不出来，没有保存」（2026-11-09 用户定） |

T5 把 `task_not_found`、`task_state_invalid`、`task_back_limit` 放进了协议（`packages/protocol/src/errors.ts`），T6 加了 `task_graph_invalid`、`task_already_converted`、`task_no_project_for_work`；`task_caller_invalid` 只在扩展通道里（工具调用的应答），不是命令的错误；`schedule_not_found` 随 T10。`task_state_invalid` 在 T5 里是：对不在等的 human 节点答、对没失败的节点"重跑"、对没停下的节点"继续"、暂停已暂停的、恢复没暂停的、取消没启动或已结束的、对已结束的任务答 human、回答不存在的打回边、对没有开着的归档提问答归档。`worktree_config_unsafe` 的 `params.reason` 多一个 `driver_name`。界面的说法留给 T7（现在没有界面用到这些码，加了没人调的导出会被 knip 拦）：`task_not_found` →"这个任务已经不在了"；`task_state_invalid` →"任务的状态变了，刷新后再试"；`task_back_limit` →"这条打回边已经用了两次"；`merge_git_failed` →"git 出错了，没有合并，主目录没动"。

合并被挡住不是命令的错误，是节点的 `blocked` 原因：

- `merge_worktree_dirty`
- `merge_main_dirty`
- `merge_main_not_trunk`
- `merge_conflict`（带冲突文件列表）
- `merge_abort_failed`

### T5 定下的细节

2026-11-05，T5（human 节点与合并）实现时定下，上面各节已写进去的不重复，这里列全：

- **合并的检查顺序**：任务 worktree 干净 → 分支已合并（`merged` / `noChange`）直接记 `merged` → 主检出目录干净 → 主检出目录在主干上 → 合并。"已合并"排在查主检出目录之前，是为了崩溃重放（合并做完、`merged` 没写进日志）时不被"主目录现在脏了 / 切走了"拦住。代价：什么也没改的任务（`noChange`）在主目录脏着时也直接算合并了——本来就没有东西可合。
- **`merge_git_failed`** 是 T5 加的第六个合并原因（SPEC 原来五个）：git 自己出错、worktree 在游离 HEAD 上、两个目录的顶层不对、合并被 git 拒绝（没有共同历史）。没有主干（没有 `origin`、没设覆盖值）一律 `merge_main_not_trunk`。没有 `origin` 的本地仓库因此合并不了；MergeInspector 对它们也只能给 `unknown`。
- **合并的是提交**，信息 `Merge branch '<分支>'`；`--no-stat --no-edit`；冲突的文件取自未合并条目，记在 NodeRun 的 `blockedFiles`（最多 50 个，`merge_blocked` 事件带 `files`）。
- **合并驱动**清空（冲突，不跑）；`textconv` / `external` 不用关；`merge-tree` 收进 `runSafeGit`；详见"宿主自己跑的 git"。
- **归档提问**存在 `Task.archive`；`archive_answered` 是任务结束后唯一还收的事件；先归档后记；事实现算。详见"归档"。
- **命令的状态检查在 `TaskService`**：`answer_human` 要求节点是 human、在等（`human` 或 `merge_blocked`）、不在 `merging`、任务没结束；打回要求有这条打回边，已用 2 次 → `task_back_limit`；`rerun_node` 要求节点 `failed`、任务没暂停没结束；`continue_node` 要求 `stopped`；`pause_task` 要求已启动、没暂停、没结束、不在 `designing`；`resume_task` 要求已暂停；`cancel_task` 要求已启动、没结束。都不符 → `task_state_invalid`，什么也不记。调度器对不符的事件本来也忽略，这里的检查是为了给界面一个错误码。
- **`continue_node` 就是在节点自己的对话里发一条"继续"**（`CONTINUE_NODE`，和你亲手在那里发消息一样）：节点上的那次运行开始，宿主据此记 `node_resumed`；不另设事件。节点的会话没起着时先 `open`。
- **`list_tasks` 读磁盘上还没取用的任务**（只读文件，不 `recover`）；重启后把在跑的任务接起来是 T9（宿主启动时的 `recoverAll`）。T5 到 T9 之间重启宿主，在跑的任务会出现在列表里，但不会接着跑。
- **`tasks_updated` 每次发整张列表，`task_updated` 发整个任务**；一条连接一次只开一个任务。推送在任务的每个事件之后、按事件顺序、一个一个算（归档事实要跑 git）；算不出来的只记日志，不拦下一个。
- **`notify` 仍只记调试日志**（界面 T7 的事）；`progress_line` 和 `wake_task_conversation` 在 T6 接上了（见“T6 定下的细节”）。`attention` 是列表行自己从节点状态算的，不依赖 `notify`。
- **`pnpm task:try`**：有 stdin 时，human 节点等你时打出它的做什么 / 怎样算完成 / 上游摘要 / `git diff --shortstat` / 合并被挡的原因和文件 / 选项，读一行回答（`p` 通过；`b <节点> [原因]` 打回，没写原因就再问；`q` 退出）；合并被挡后同样的提示，再 `p` 就是重试；任务结束时问归档（`a` / `k` / `q`），归档被拒（未提交的改动）会说明并再问。没有 stdin（读到末尾）就和以前一样停在 human 节点。示例图 `packages/host/examples/explore-work-check-merge.json`（explore → work → check → human(`merge`)，human ⇢ work）。
- **没做 / 留给后面**：`TaskView` 不带改动统计（界面用 `watch_changes`，T7）；没有 `notify` 的界面（T7）；`task_graph_invalid` 等 T6 的命令和错误码；界面的说法（T7）。（重启后的接续和 `request_graph_change` 的理由落盘，T9 已做。）

### T6 定下的细节

2026-11-05，T6（任务对话与 `/task`）实现时定下。SPEC 原文没答的，都取保守的一边。

**任务对话的工具**

- **八个，不是九个**（T10 已加第九个，见“T10 定下的细节”）：`task_set_schedule` 不注册。它的消费者是定时（T10）：现在注册了，任务对话会向用户许诺一条不会有人跑的规则，`scheduleDraft` 也没有“确认并保存规则”可接。T10 一起加（含事件和按钮）。表里保留这一行。
- **选引导词**：`task_propose_graph` 多一个可选的 `guide`（`feature` / `fix` / `scheduled_fix` / `research`）。设计中提交时，宿主把 `{ id, version }` 记进 `task.guide`（事件 `graph_proposed` 带 `guide`）；启动后提的图忽略它；一直不填，`guide` 保持 `{ id: "default", version: 1 }`，意思是“还没选”。没放进 `task_set_meta`：提图是必经的一步，不会忘。
- **`task_set_summary`**：`summary` 是对象，六个字段：`goal`（必填）、`decisions`、`constraints`、`nonGoals`、`openQuestions`、`acceptance`（各至多 50 条、每条至多 2 000 字），整体替换（事件 `summary_set`）。启动后一律 `task_state_invalid`：SPEC 原文是“启动后改摘要算改图”，但摘要不是图，批准流程里没有它的位置；保守做法是启动后不开这个口子，要改的话提新图，在 `note` 里说明。
- **`task_set_meta`**：名字至多 200 字、去首尾空白；`model` 不写 `thinking` 就沿用任务现在的档位；至少要给 `name` 或 `model` 之一（`task_args_invalid`，`field: "name"`）。宿主**不核对模型是否存在**（那要问模型清单，T6 不加端口）：写错的模型会让还没开始的节点 `failed(crashed)`，见风险。
- **读工具**：
  - 分页，每页 12 000 字符，`page` 从 1 起，超出末页 `task_args_invalid`（`field: "page"`）；
  - 内容是别的会话或节点写的，宿主把每页包进 `<atrium-quoted from="来源对话 | N2 · 名字 | worktree diff">`，先转义冒充外壳的标记（ADR-0013 第 10 条）；
  - `task_read_source` 读来源对话当前所在的分支（从最后一条沿父节点往根走），只含用户和助手的话（不含思考、工具），压缩过的显示摘要；
  - `task_read_node` 的 `contract` 是节点现在会（或已经）收到的契约（只给 agent 节点，human 节点 `task_args_invalid`）；`summary` 是最新一条 NodeRun 的交接摘要；`transcript` 带工具调用（参数截 300 字）和结果（截 800 字）；只认当前生效的图里的节点；
  - `task_diff` 是 worktree 相对起点（或 `since` 节点最新一条 NodeRun 的提交）的 `git diff --stat --patch`，走 `runSafeGit`（关掉钩子、过滤器、外部 diff、textconv）并钉死 `--work-tree`，超过 20 000 字截断；`since` 的节点没有提交 → `task_args_invalid`（`field: "since"`）；没有 worktree 或起点 → `task_state_invalid`；
  - `task_status` 给 JSON：任务状态、模型、引导词、生效的图和每个节点的状态、待批准的图（整份）；不含节点写的交接摘要和理由（那些经 `task_read_node` 读，带外壳）。
- **读不受限、改受限**：任务结束（`done` / `cancelled`）后 `task_set_summary`、`task_set_meta`、`task_propose_graph`、`task_send_to_node` 都是 `task_state_invalid`；`task_status`、`task_read_*`、`task_diff` 一直能用，任务对话可以回答“到哪一步了、结果如何”。
- **`task_send_to_node`**：节点最新一条 NodeRun 在 `running`、有会话、不在等提交才行，否则 `task_state_invalid`；节点 id 不在生效的图里 → `task_args_invalid`（`field: "id"`）。发出的是 `<atrium-task-note from="任务对话">` 包着的话（说明这不是用户直接说的，做不做以契约为准），用 `prompt` 加 `streamingBehavior: "steer"`：pi 在跑就排到下一个轮次边界，空闲就开新的一轮。它和用户插话一样会让待结算的 `node_done` 作废。
- **`task_propose_graph` 的校验**：节点和边先用宿主自己的 schema 读（多余字段、类型不对 → `task_args_invalid`，`field: "nodes"` / `"edges"`），再过 GraphValidator（启动后带上任务）；第一条问题 → `task_graph_invalid`（`params.code`、`params.node`）。`no_project_for_work` 在通道里也报成 `task_graph_invalid`；`start_task` 里才用 `task_no_project_for_work`。
- **调用方**：任务对话的请求在任务队列里按事件的顺序处理（`TaskRunner.handleConversationRequest`）。`task_*` 只认记录里 `role: "conversation"`、且正是这个任务 `taskSessionId` 的会话（`checkConversationCall`）；节点的会话发 `task_*`、任务对话发 `node_done` / `request_graph_change`，一律 `task_caller_invalid`，什么也不执行。节点的 pi 本来就没注册 `task_*` 工具（扩展按启动参数），宿主的核对是第二道。
- **启动**：`--tools` 是 SPEC-0002 的只读白名单（`read, bash, ffgrep, fffind, ls`）+ 八个工具 + `ask_user`；扩展的 `tool_call` 钩子再拦一遍（`edit`、`write`、`agent_*`、`node_done` 被拦）。不加路径隔离和 git 拦截（它没有 `edit` / `write`）；它的 `bash` 在 `sourceDir`（项目的主检出目录）里，信任度同 SPEC-0002 的 `explore` 子对话。模型 = 来源对话当前的模型（运行着的 pi 的，否则会话文件里最后记的）。

**进度行与唤醒**

- 进度行是 `/atrium-task progress`，多两个可选字段：`what`（调度器的 `ProgressLine.kind`，如 `node_started`）和 `node`，写进 `details`，让界面（T7）自己拼话；正文是英文一行 `Atrium task event: node_started N2`（宿主不产出给用户看的文字；任务对话的模型也读得到，不调模型）。行 id 是调度器给的（事件 `seq` 加行号），扩展按 id 去重，重放不写两次。
- 写进度行和唤醒走每个任务自己的一条链（`TaskEntry.lines`），不占任务队列：打开任务对话的 pi 要几秒，不能拖住调度。宿主关闭时在途的命令被取消，不记失败。任务的 `taskSessionId` 不是宿主起的任务对话（手工造的任务、`task:try`）就什么也不写。
- **唤醒**（`wake_task_conversation`）是 `/atrium-task resume`（`kind: "wake"`，命令 id `w<seq>`）：事件给的话，加上每个正在 `waiting(graph_change)` 的节点的理由和建议（节点写的，包 `<atrium-quoted from="N2 · 名字">`，建议截 12 000 字，来自 `NodeRun.graphRequest`），加一句指示（先 `task_status`，再 `task_propose_graph`；新图要等批准；说一两句）。理由和建议随 `node_waiting` 落盘（T9 起），宿主重启后的再唤醒同样带着它们。
- 批准或拒绝改图后，任务对话不会收到专门的消息（调度器没有这个动作）；它用 `task_status` 看；节点按 T4 收到 `resume`。

**`/task` 与创建**

- 命令：`create_task(sessionId, scope?)`。一次只处理一个（串行），所以同一对话的两个 `/task` 不会都过检查。顺序：
  1. 已经有任务（含 `done`、`cancelled`、已启动的）→ `task_already_converted`（`params.taskId`）。放弃的不算：放弃后记录就删了，崩溃留下的半删记录（`cancelled` 且没启动）不列出、也不挡重新 `/task`；
  2. 来源对话不存在、已归档、是任务的会话 → `session_not_found`；还没有模型（一次都没跑过的草稿）→ `task_state_invalid`；
  3. 起任务对话（目录 `sourceDir` = 来源对话的目录，模型同来源，记录 `task: { role: "conversation", startOn }`），再写 `created`：`designing`、没有图（`graphs: []`、`activeGraph: 0`）、引导词“还没选”、任务名先取来源对话的名字（截 120 字，没有则空，设计消息要求任务对话用 `task_set_meta` 起名）；
  4. 发 `<atrium-task-design>`（正文见附录）；发不出去就把任务撤回（按放弃的做法）并把错误抛给调用方，不留一个没人交代的任务对话；
  5. 来源对话写 `converted` 行；写失败只记日志，任务照样在。
- 来源对话在 worktree 里：借用它，`ownsWorkspace = false`、`workspaceState = "ready"`、`workspaceId` = 它，`baseCommit` 取工作区记的（没有就 `null`）；在项目本地目录：第一个要 worktree 的节点开跑前建；不属于项目（聊天）：`projectId = null`。
- **来源对话的行**用 `/atrium-task mark`（`converted` / `abandoned`，命令 id `m.<任务 id>.<状态>`）。来源对话是普通会话、没有任务标记，所以 `mark` 是所有会话都收的一个动作（扩展不再对“都不是”的会话什么都不注册：工具仍不注册，命令注册，除 `mark` 外的动作对它们无效）。会话文件只增不改，所以“改成任务已放弃”是**再写一行**，界面（T7/T8）按任务 id 取最后一行；`details: { kind: "converted", taskId, state }`，正文是一句英文，说明这是 Atrium 的记号。这些行在对话记录里怎么画是 T7 的事（T6 不改 `toLogEntry`）。
- **放弃**（`abandon_task`）：只在 `designing` 且未取消，否则 `task_state_invalid`。顺序：`abandoned` 事件 → 运行器放手（等队列清完）→ 删任务目录 → 归档任务对话（停 pi、标记归档）→ 来源对话写 `abandoned` 行。
- **启动**（`start_task`）：要 `designing` 且有生效的图（没有图 → `task_state_invalid`）；再过一次 GraphValidator（不属于项目则 `projectless`）：第一条问题是 `no_project_for_work` → `task_no_project_for_work`，其他 → `task_graph_invalid`（`params.code`、`params.node`）。
- **批准 / 拒绝**（`approve_graph` / `reject_graph`）：要已启动、没结束、有待批准的图，否则 `task_state_invalid`。批准前用任务现在的状态再校验一次待批准的图（`started: task`），不通过 → `task_graph_invalid`，用户可以拒绝让节点按原图做。“等着的 human 节点多了没通过的上游就回到 `pending`”是调度器 T3 已做的（`onGraphApproved`），T6 的主机层测试覆盖了批准后接着跑。

**`pnpm task:design`**

- `pnpm task:design --from <会话 id> [--scope <文字>] [--model <provider/model[:thinking]>] [--home <目录>] [--sessions <目录>] [--cwd <目录>] [--timeout <秒>] [--keep]`：用真实模型对一段已有对话跑任务对话的设计那一轮，打印需求摘要、初始图、选了哪套引导词、任务对话最后对用户说的话，以及几条提醒（实现节点后面没有 `check` 节点、图没有 human 节点）。不启动任务。
- **怎么保证不碰真实对话**：它只读两样——`--sessions`（默认 pi 自己的会话目录）里那一个会话文件，和（`--home` 默认 `~/.atrium`）；把那个文件**复制**进一个新建的临时目录，在那里起一个自己的宿主（自己的 Atrium home、自己的 pi 会话目录）并对**副本**跑 `createFromChat`，所以 `converted` 行写进副本；真实的 home 和会话目录从不传给宿主。每次先后各算一次原文件的内容哈希和修改时间并打印，不一致就退出码 1；临时目录在真实的 home 或会话目录里就拒绝运行。设计这一轮用的是对话的目录（或 `--cwd`）当工作目录，工具只读，但 `bash` 不受只读约束；想完全不碰仓库，用 `--cwd` 指一份仓库的副本。`--model` 只换任务对话用的模型（默认同来源对话）；`--timeout`（默认 300 秒）从任务建好算起，等宿主认出副本另有 120 秒。
- 退出码：0 提出了图，1 没有图或出错或原文件变了，2 用法错，130 被打断。

**没做、留给后面**：`task_set_schedule` 与 `scheduleDraft`（T10）；`TaskView` 的摘要、引导词、来源会话字段和“已转为任务”“进度行”在对话记录里的画法（T7）；核对任务和节点的模型是否存在；`/task` 在输入框里的拦截（T8）。

### T7 定下的细节

2026-11-06，T7（任务区只读）实现时定下。T7 只读：不发任何任务命令，没有任务对话的输入框，没有放弃、确认并启动、暂停、取消按钮。

**协议**（号 31 → 32；合回 `main` 时取当时的下一个号并重新生成 Swift 投影）

- `TaskSummary` 加三个字段：`current`（`{ id, name, state }`，图里最该点出来的节点：失败 → 停下 → 等你 → 运转中，同级取图里靠前的；没有则 `null`）、`activeAt`（节点最后一次开始或结束的时间，没有则任务启动或创建的时间，列表的"最后活动"）、`scheduled`（是否定时触发，T10 之前恒为 `false`，来源记录是 `schedule` 的任务除外）。
- `TaskView` 加 `model`（任务模型，任务栏显示）和 `sourceSessionId`（需求对话，任务栏的"需求对话 ›"；定时触发的任务为 `null`）；`TaskNode` 加 `model`（节点单独指定的模型，没有则 `null`，图上显示继承还是单独指定）。T6 留下的"需求摘要、引导词"仍不给界面：任务对话里的摘要卡片（设计稿第 4 屏）不在 T7 做，见"没做"。
- `Notice` 加两种：`task_progress`（`what`、`node`，任务对话里宿主写的进度行）和 `task_mark`（`taskId`、`state`，需求对话里的"已转为任务 / 任务已放弃"）。宿主的对话记录投影把 `atrium-task` 的 `progress` / `converted` 两种自定义消息投影成它们，两条线之间（和"note"一样）：`nudge` / `resume` 是起一轮的消息，仍然什么也不画。
- **进度行要实时到**：pi 写下进度行时，翻译层发 `task_line_added`，会话控制器据此重读文件（同 `atrium-agent` 的 `note_added`），所以进度行在任务对话里随节点推进一条条出现；没有这条，只有下一次重建才看得到（真实宿主测试 `board.host.test.ts` 见过失败：任务跑完 60 秒也没有一行）。
- 手机端（Swift）的 `Notice` 多两种，只在摘要里写"任务进度""任务"，不画；`TaskSummary` 等照生成的投影。

**客户端**（`packages/client`）

- `client.tasks`：任务列表的 store，`watchTasks(true)` 发 `list_tasks({ watch: true })`，`tasks_updated` 整张替换；`seq` 比手里小的丢掉；每次（重）连接，宿主的计数重新从 0 数，所以视图的也重来，再要一次列表；答案晚于同一次请求之后的推送时不盖掉推送。主窗口开着就一直 watch（侧栏的"任务"数字随时要）。
- `client.task(id)` / `client.openTask(id)`：宿主一条连接一次只开一个任务，所以只有顶上那个任务标签挂着；`task_not_found` 记成 `missing`（保留上次的任务），其他失败记成 `failed`；重连后再开。

**界面**

- **入口**：侧栏搜索下面的"任务"，数字是"待我介入"组的任务数（`designing`、`waiting`、`stopped`，也就是列表第一组），为 0 时不显示。点它，主区换成任务区（会话的标签栏和对话区都不挂着），点侧栏里任何工作区、对话、项目的"+"、⌘N、⌘T 都离开任务区；任务区开着时 ⌘W、⌘1–9 等标签快捷键不动。
- **标签**：固定的"任务""定时"没有关闭按钮；任务标签的前面是运行中的点阵涡旋（运行中）、橙色的"等你"图标（要你介入）、红色感叹号（失败），都不是则是任务的种类图标；关掉标签不影响任务。标签只在窗口的生命期里记着，不存盘。
- **列表**：分组、排序、已完成的 7 天 / 5 条加"显示全部"、项目筛选（含"不属于项目"）按设计稿第 2 屏和上面"界面"的写法（逻辑在 `task-list-model.ts`，有单元测试）；"待我介入"组里按紧迫程度排：失败、合并被挡住、human、提问、改图、已停下 / 暂停、设计中，同级按最后活动。T7 的行不展开作答，点一行打开任务标签（悬停出"打开任务"）。"项目 · worktree"：对话里的任务写"对话 · 不属于项目"；定时的写"项目 · 定时 · worktree"；有项目但还没有 worktree 的只写项目。每半分钟刷新一次"N 分钟前"。
- **文字**（宿主只发代码，界面写）：状态——设计中"等你确认初始图"、失败"N4b 失败 · 已停下"、合并被挡住"合并被挡住"、human"等你验收"、提问"等你回答"、改图"等你批准改图"、暂停"已暂停"、你停下的节点"N2 已停下"、运行中"运转中"、完成"已完成"、取消"已取消"；节点状态按设计稿图例（未开始、运转中、等你、通过、已挂起、你停下的、失败任务停下）；失败原因（`failure`）六种、合并被挡住的原因六种的说法见 `task-words.ts`（合并原因按设计稿第 7 屏）；错误码的说法 `task_not_found` "这个任务已经不在了"、`task_state_invalid` "任务的状态变了，刷新后再试"、`task_back_limit` "这条打回边已经用了两次"、`merge_git_failed` "git 出错了，没有合并，主目录没动"，其余已知的码和不认识的码各有一句。这些说法在 T7 里只有 `task_not_found` 有地方显示（打不开任务时），其余随 T8 的按钮用上。
- **任务标签**：任务栏（名字、状态、项目 · worktree、"需求对话 ›"、任务模型只显示）；左边图、右边任务对话，各占约一半。**按钮一律不画**（不画灰的），T8 加上放弃 / 确认并启动 / 暂停 / 取消。图：自上而下分层，同一层并排，顺序线用柔和曲线加箭头，打回边是左边的橙色虚线环加"打回"字（`graph-layout.ts`，纯函数，有单元测试）；节点卡片（144×62，整张图缩放到放得下图区，最小 0.7 倍）写状态图标、id、名字，角色 · 位置，模型（单独指定蓝字，继承灰字写"继承 · 模型"，human 节点不写）；点节点描蓝框（`aria-pressed`）、点空白取消、悬停浮出"做什么""怎样算完成"和失败 / 等待 / 合并被挡的原因，human 节点在等你时加"改动 +N −M"（`watch_changes` 对 `TaskView.workspaceId`，只有 human 节点在等时才订，离开标签就退订）；图上方一行图例和"图 vN"，下方一行状态图例。**改过的节点描虚线蓝框、新加的标"新"没做**：宿主没有给界面前一版的图（`TaskView` 只有生效的一版），要做需要协议多给一个"相对上一版改了哪些节点"，留给 T8（那时批准改图的卡片也要它）。
- **任务对话（只读）**：任务对话不进目录和侧栏，所以不能 `open_session`（会把它开成会话的标签）；界面用 `client.watch([taskSessionId])` 经现成的会话订阅看，不挂输入框。宿主给任务对话的第一条消息是长长的设计指示（四套引导词全文），界面把它缩成一行"（设计任务的指示：整理需求摘要，选引导词，画初始图）"，那一轮和 agent 的动作照旧。**已知限制**（T8b 起已解决：pi 没在跑时窗格调 `open_task_session`；T9 核对了宿主重启后同样可用）：任务对话的 pi 没在跑时（任务结束后、宿主重启后）订阅不到快照，窗格停在"正在读取任务对话…"；`resume` / `nudge` 起的轮没有开头，agent 的回复并进上一轮。
- **进度和记录的折叠**：进度行（`task_progress`）两次对话之间连成一段，一段是一组：最后一组展开，是过程轨道上的步骤（节点开始 / 通过是灰点，失败是红 ×，等你是橙点，右边写时间 `HH:MM`），前面的组收成一行灰字"› 任务进度 · 3 个节点通过 · 10:02–10:44"，点开再展开、再点收起；用户点过之后，后来的行不改变他的选择，没点过的跟着"是不是最后一组"走（新的一组出现时，上一组自己收起）。进度行的文字：`N2 核心实现与自检 开始 / 通过 / 失败 / 等你`，`workspace_ready` "工作区准备好了"，`merged` "合并完成，任务完成"，不认识的 `what` 写"N2 有新进展"。审核的记录（"你通过了 · 图 v3"等）和卡片一样是 T8，那时并进同一组。
- **需求对话里的一行**：`task_mark` 画成居中的灰字"已转为任务「名字」· 状态 · 打开 ›"（设计稿第 1 屏），"打开"打开任务标签；会话文件只增不改，同一个任务有两条时只画最后一条：放弃了画"任务已放弃"（任务的记录已删，没有名字可写）；任务不在列表里（还没读到）画"已转为任务"，不带链接。
- **新增的视觉规则**写在 design-language.md"任务区"。

**任务做完之前在 Atrium 里看着它跑（`pnpm task:try` 与 Atrium 同时开着）**

见 [development.md · task:try 与 Atrium](../development.md#task-try-与-atrium-t7-定)。结论：**任何时候都不能有两个宿主管同一个 Atrium home**；评估了三个办法（A 当客户端连开着的宿主、B 只读地跟着任务目录、C 共用 home），**都没在 T7 里做，等用户选**，建议 B；现在能做的是跑完之后看（task:try 退出后用同一个 home 起 Atrium）。

**2026-11-06 用户定**：边跑 `task:try` 边在 Atrium 里看选 B（开发时只读跟随 task:try 的任务目录，见 development.md"task:try 与 Atrium"，作为 T7.1 补做）；human 节点的改动统计放在节点悬停卡里；"项目 · worktree"的写法（有项目没 worktree 只写项目名，定时写"项目 · 定时 · worktree"）照现在的做；改过节点的虚线框和需求摘要卡片放 T8。

**没做、留给后面**：行内作答、任务栏的按钮、任务对话的输入框、审核卡片和记录（T8）；改过的节点标蓝框和"新"（要协议给前一版，T8）；需求摘要卡片（设计稿第 4 屏，要把摘要给界面，T8）；定时标签的内容（T10）；节点对话标签（T8）。

### T7.1 定下的细节

2026-11-06，T7.1（开发时在 Atrium 里跟着 `pnpm task:try` 的运行）实现时定下。用户选的办法 B，评估见 [development.md · task:try 与 Atrium](../development.md#task-try-与-atrium-t7-定)。

**开关**：环境变量 `ATRIUM_FOLLOW_TASKS=<task:try 的 home>/tasks`，只给开发用。

- 打包版忽略它，机制是**读的人不同**：桌面端主进程只在 `!app.isPackaged` 时读这个变量，经和 token 同一条的 `config` 消息交给宿主进程（`followTasks`）；Electron 里的宿主不自己读环境，所以打包版的环境里有这个变量也没用。单独运行的宿主（`entry.ts` 的 `runStandalone`，只在开发和测试里用）直接读。纯函数 `followTasksFor(env, packaged)` 有单元测试；`ATRIUM_FOLLOW_TASKS` 登记在 security.md 的环境变量表里。
- 目录不存在或读不了：日志一条 warn（`task follow unavailable`，只带错误码，不带路径），之后每 5 秒试一次（先开 Atrium、后跑 task:try 时目录还没有），出现了就开始跟；不崩。
- 目录和 Atrium 自己的任务目录是同一个（符号链接解析后相同）：拒绝跟，一条 warn。这正是"两个宿主管同一个 home"，禁止。

**纯读的重放**（`tasks/task-reader.ts`）：`openTaskStore` 打开时会截掉半行、补换行、重写 `task.json`，对另一个进程正在追加的目录就是写。读者只读 `events.jsonl`，用同一个 `parseEvents`（半行的尾巴丢掉不写、中间坏行照旧报 `TaskStoreCorruptError`）和同一个 `replayEvents`（归约器不复制）；**不读 `task.json`**（它可能比事件慢一拍，事件才是真相），不写、不改、不 `chmod`。半行读到时忽略，写完整了下一次扫描就读到。读不出的任务（中间坏行、`seq` 跳号）记一条 warn（同一原因只记一次），保留上次读到的状态。测试证明"不写"：跟随期间目录里每个文件的内容哈希和 mtime 都没变，包括写者留下半行时。

**跟随**（`tasks/task-follower.ts`）：

- 机制沿用 `changes/changes-service.ts` 的：递归 `fs.watch`（`watchDirectory`）加轮询兜底。有变化的通知（去抖 100ms）、watch 失败时（改为每秒轮询）、或 watch 开着时每 3 秒一次的兜底（递归 FSEvents 可能晚启动或漏一个通知），扫描目录：新出现的任务目录、`events.jsonl` 的大小或 mtime 变了的任务重读。没有变化的任务不重读。
- 读到新事件就当作任务的一次更新：每个有变化的任务**每次扫描推一次**（`onEvent(task, 最后一个事件, [])`，动作恒为空），`list_tasks` / `tasks_updated` / `open_task` / `task_updated` 与自己的任务一模一样，T7 的界面不为此加路径。第一次扫描不推（还没有人在看）。目录里任务整个消失（task:try 的 home 被删）：从列表里拿掉，推一次。
- 计时器（去抖、轮询、重试、兜底各一个，同一类同时最多一个）经注入的 `Clock` 和资源计数（`timer`）；watch 的句柄计数 `task.follow.watch`；宿主关闭时全部释放（泄漏测试）。

**严格只读**（`withFollowedTasks` 包在 `TaskService` 外面，`main.ts` 接线）：

- 所有改任务的命令对一个被跟着的任务都答 **`task_read_only`**（新码，`answer_human`、`rerun_node`、`continue_node`、`pause` / `resume` / `cancel`、`start` / `abandon`、`approve_graph` / `reject_graph`、`answer_archive`，以及 `submit` / `recover`）。`task_state_invalid` 的界面说法是"任务的状态变了，刷新后再试"，会让人去重试一个永远不会成功的操作，所以另立一个码。
- 调度器、运行器、会话都不碰它：被跟着的任务从不 `attach` 到 `TaskRunner`，不起 pi，不建 worktree，不提交、不合并、不弹归档提问。测试里用资源计数（`pi.process`）和任务目录的哈希证明。
- `view()` 不跑 git（`archiveFacts` 恒为 `null`），`sourceSessionId` 恒为 `null`（需求对话在 task:try 的 home 里，任务栏的"需求对话 ›"不显示，免得点到一个打不开的链接）。
- **id 冲突**：被跟着的目录里的 id 和 Atrium 自己的任务（已取用的或磁盘上已有的目录）同名时，**自己的赢**，被跟着的那个不显示，记一条 warn；这在实际中不会发生（task:try 的 id 由图文件和仓库路径算出，自己的是随机的），但命令的路由不能因此有歧义。
- 被跟着的任务引用的项目和 worktree 是 task:try 的 home 里的，Atrium 的索引里没有：任务栏和列表里"项目 · worktree"读不到项目名，照 T7 的现成写法只写"项目"；human 节点的"改动 +N −M"悬停统计不出现（`watch_changes` 对一个 Atrium 不认识的 worktree 什么也不给）。真实运行里看过（2026-11-06，`deepseek/deepseek-flash`，截图在验收报告里）。这两处 T7.1 不改，要认得 task:try 的项目得另做。

**协议**（号 32 → 33；合回 `main` 时取当时的下一个号并重新生成 Swift 投影）：`TaskView` 加 `followed: boolean`（是不是被只读跟着的）。`TaskSummary` 不加。新的错误码 `task_read_only`，界面的说法"这个任务是别的进程在跑的，Atrium 里只能看"（`task-words.ts`；T8 的按钮对被跟着的任务不画，所以这句只在别的客户端或脚本发了命令时用得上）。

**任务对话窗格**：被跟着的任务的会话文件在 task:try 的会话目录里，不在 Atrium 的，T7.1 不读。窗格不再停在"正在读取任务对话…"，改写两行（`role="status"`，`--fs-meta`，第一行 `--text-2`、第二行 `--text-dim`）："这个任务是别的进程在跑的，Atrium 只读它的图和节点状态。" / "任务对话和各节点的对话不在 Atrium 里，这里看不到。" 标题"任务对话"不变，没有输入框（T7 本来就没有）。

**没做**：读 task:try 的会话文件（要先定会话文件的目录怎么告诉宿主，会碰到 pi 会话目录的读权限）；把被跟着的任务标成"只读"的标签（任务栏上多一个小标签，建议但没做，等用户定）；跟随多个目录。

### T8a 定下的细节

**2026-11-06 用户定**：初始图的"确认并启动"仍是开始页的按钮，不做成审核卡片（审核卡片只管启动后的改图）；不收原因的按钮带了原因判 `review_invalid`；合并多次被挡只在最后成功那次写记录；合并被挡后再答算同一张卡的重试，不算第二个裁决。

2026-11-06，T8a（交互任务区的协议与宿主这一半）实现时定下。T8b（界面）建在它上面。协议号 33 → 34；合回 `main` 时取当时的下一个号并重新生成 Swift 投影。形状照 [ADR-0017](../adr/0017-reviews-one-shape-two-sources.md)，只做任务这一个来源（宿主关卡）；agent 来源的 provider、`request_review` 工具和"某个工具执行前要审核"的固定关卡另开 SPEC。

**协议**（`packages/protocol/src/reviews.ts`）

- `PendingReview { id, openedAt, source, subject, evidence[], problem, actions[] }` 挂在 `Control.reviews`（和 `question` 并列，最多 16 条，先出现的在前）。`source` 是 `{ kind: "gate", gate }` 或 `{ kind: "agent", toolCallId }`（形状有了，T8a 不产出）；`GateKind` = `task_graph | task_human | task_archive`。
- **合并被挡住不是另一道关卡**：它是 `task_human` 那张审核的 `problem`（`{ code: 合并原因, params: {}, files? }`），同一个审核 id；这时主按钮 `pass` 换成 `retry`（都调 `answer_human` 的 `pass`），`send_back` 照旧。这是 ADR"同一张卡片的执行失败状态"的直接做法，业务命令本来也是一个。
- `subject` 关卡是 `{ code, params }`：`task_graph_change`（`taskId`、`version`）、`task_human_node`（`taskId`、`node`、`merge`）、`task_archive`（`taskId`）；agent 来源是 `{ text }`（模型原文）。
- `Evidence` 四种：`facts`（`{ code, params, status: ok|warn|danger }`，码：`worktree_clean` / `worktree_dirty` / `worktree_merged` / `worktree_not_merged` / `worktree_merge_unknown`，都带 `name`；`commits_ahead` 带 `count`）、`changes`（`workspaceId`、文件数、加、减，界面用 `workspaceId` 打开改动面板）、`graph_diff`（`from`、`to`、`added`、`removed`、`changed`）、`summary`（`by: { kind: "node", node } | { kind: "agent" }`，`text`）。`summary` 是别人写的话，按引用显示，**不带状态**；agent 来源的审核不能出现 `facts`（ADR 第 2 条的可信度规则，协议形状允许，provider 负责不发）。
- `ReviewAction { id, reason: none|optional|required, targets[], recommended }`。ADR 写的 `targets?` / `remaining?` 这里做成 `targets: { id, remaining }[]`（空数组 = 不用选目标），`remaining` 跟着每个目标，因为一个 human 节点可以有几条打回边、每条各用了几次；用完的目标（`remaining: 0`）仍列出，界面置灰，宿主照旧拒绝（`task_back_limit`）。按钮 id：`approve`、`reject`（`task_graph`）；`pass`、`retry`、`send_back`（`task_human`）；`archive`、`keep`（`task_archive`）。
- `Verdict { action, target?, reason? }`，命令 `answer_review(sessionId, reviewId, verdict)`，答 `{}`。`local_only`（任务关卡手机不能答；手机能解码 `Control.reviews`、`TaskView.reviews` 和 `review` 记录并忽略，iOS 的 `Notice` 加了一个"审核"灰行，没有别的界面）。
- 错误码两个：`review_closed`（`reviewId`）、`review_invalid`（`field`）。校验失败的、不在的审核**不执行任何东西**。其余沿用业务命令的码（`task_back_limit`、`task_graph_invalid`、`workspace_dirty`、`task_state_invalid`…）。
- `Notice` 加 `review`：`{ review: ReviewRecord, timestamp }`，`ReviewRecord` = `{ source, subject, evidence（当时的快照）, verdict }`，界面画成过程轨道上的一步（T8b）。
- `TaskView` 加四个字段：`reviews`（同样的审核，见下）、`pending`（等批准的那版图整份：节点只含计划、不含运行状态，加 `note`、`author`、对生效图的 `diff`；"点开在图上看"用它）、`graphDiff`（生效的这版相对上一个生效过的版本改了哪些：`from`、`added`、`removed`、`changed`；第一版是 `null`；虚线蓝框和"新"用它）、`requirements`（需求摘要，T6 的六个字段，模型写的话，界面按引用显示）。
- 新命令 `open_task_session(taskId, sessionId)`（`local_only`）：见下"节点对话"。

**宿主**

- **ReviewHub**（`packages/host/src/reviews/review-hub.ts`，新的业务模块 `reviews/`，只依赖 protocol 和 platform；`sessions/` 和 `server/` 用它，`tasks/` 实现它的 provider）：按会话汇总各 provider 的待审核（先出现的在前），保存最近一次算的结果给 `Control` 同步读，变了通知监听者（会话控制器据此发 `control_updated`）；`answer` 在这个会话的队列里一件一件做：重算一遍 → 找不到这条审核 `review_closed` → 校验形状（按钮存在；目标：按钮有目标就必须是其中一个、没有就不能给；原因：必填的要有非空白字、不收的不能写、可选的随意）`review_invalid` → 交给 provider。同一会话的裁决排队，所以**第一个裁决赢，其余应答 `review_closed`**。一条审核在"还挂着"时（合并又被挡）再答，是对同一张卡片的又一次重试，不算"第二个裁决"。
- **任务 provider**（`tasks/task-reviews.ts`）：待审核**从调度器的持久状态现算，不另存**（`reviewsOf(task, 工作区的事实)` 是纯函数），所以宿主重启后一样。`pendingGraph` → `task_graph`（只在任务启动后；设计中的图直接生效，"确认并启动"仍是开始页的按钮，不是审核）；每个 `waiting(human)` 或 `waiting(merge_blocked)` 且没作废、不在合并中的 human 节点 → `task_human`（id 带第几次，打回再回来是新的一条）；`Task.archive = asked` → `task_archive`（回答"留着"之后不再是审核，业务命令 `answer_archive` 仍能再答"归档"）。**挂在任务对话的会话上**。证据全是宿主现算：human 节点和归档题的 git 事实和改动统计（同归档题原有的 `facts`，改动统计用 `changesSince`），上游节点的交接摘要，改图的差异和 agent 写的说明。`recommended`：human 节点的 `pass` / `retry` 在工作区干净时推荐；归档只在"已合并且干净"时推荐 `archive`，否则 `keep`（SPEC"没合并的 worktree 默认先留着"）；改图的 `approve` 推荐。
- **裁决走现有业务命令**：`approve` / `reject` → `approve_graph` / `reject_graph`；`pass`、`retry` → `answer_human` 的 `pass`；`send_back` → `answer_human` 的 `send_back`（`backTo` = `target`）；`archive` / `keep` → `answer_archive`。列表行内处理和 `answer_review` 是两个入口、同一套状态检查（`task_state_invalid`、`task_back_limit`、`workspace_dirty`、`task_graph_invalid` 照旧）。
- **`TaskView.reviews` 和 `Control.reviews` 是同一份**：任务对话的 pi 没在跑时（宿主重启后、任务结束后）会话没有控制器，订阅不到 `Control`，而列表的行要在不开任务对话时就看到审核，所以 `open_task` 的 `TaskView` 也带上。会话的 pi 起来后（发一条消息就起）控制器从 ReviewHub 读到同样的审核，`control_updated` 照常推。这是对 ADR 的补充，不改它的形状。
- **裁决的记录**：审核**不在了**（裁决生效）之后，宿主让任务对话的 pi 写一条 `custom_message`——`/atrium-task review`（命令 id `review:<审核 id>`，同一条只写一次），扩展写成 `customType: "atrium-review"`、`display: true`、`triggerTurn: false`、`details = { v: 1, kind: "review", id, at, review: { source, subject, evidence（快照，别人写的文字截到 8000 字）, verdict } }`；正文是一行英文（`Atrium review: the user decided task_human_node taskId=… node=H merge=false: send_back N1. The user's reason: …`），**模型下一次请求能看到**（`custom_message` 进上下文；真实宿主测试看到了）。走和进度行同一条链（`TaskEntry.lines`），所以排在它前面的进度行后面。合并又被挡的那次 `pass` 审核还在，不写记录；最后合并成功那次写一条 `retry`（或 `pass`）。会话文件被翻译成 `Notice.review`，实时到（`task_line_added` 重读文件）。
- **任务对话收消息**：现有的 `prompt` / `steer` / `stop` 对任务对话的会话 id 直接可用（真实宿主测试：审核开着时发一条消息，模型收到、审核不动）。**不要对它用 `open_session`**：那会在项目的容器里给它开一个标签。界面用 `watch` 看它，`prompt` / `steer` 发消息。"卡片开着时输入框发消息"对任务发起的审核就是这条，卡片不动。
- **节点对话**：`watch([节点会话 id])` 加现有的 `prompt` / `steer` / `stop` / `answer_question` 按会话 id 都可用，不开标签（真实宿主测试：节点用 `ask_user` 提问，只 `watch` 它的客户端看到 `control.question`，`answer_question` 后节点继续；任务和节点的会话不进 `client.index` 的会话列表）。pi 没在跑的会话（已通过的节点、宿主重启后）订阅不到快照，所以加 `open_task_session(taskId, sessionId)`：核对会话是这个任务的对话或节点（否则 `session_not_found`；被跟着的任务 `task_read_only`），只起它的 pi，**不开标签**；客户端先 `watch` 再调它，快照随后到。起一个已通过节点的 pi 不改任务状态（真实宿主测试：没有新事件）。
- **`/task`**：宿主这一半 T6 已完整（`create_task`、`task_already_converted`、来源对话的"已转为任务"行）。`/task` 由输入框拦下再调 `create_task`，不发给模型，是 T8b 的界面工作，宿主不拦文字：发给宿主的 `/task` 当普通文字交给 pi。客户端（`packages/client`）补了任务命令的方法：`createTask`、`startTask`、`abandonTask`、`approveGraph`、`rejectGraph`、`answerHuman`、`rerunNode`、`continueNode`、`pauseTask`、`resumeTask`、`cancelTask`、`answerArchive`、`openTaskSession`、`answerReview`。
- **被跟着的任务（T7.1）**：不产生审核（`reviews: []`，`Control` 里也没有，它的会话不在这个宿主里）；对它的会话发 `answer_review` 应答 `review_closed`（没有这条审核），什么也不写。界面对被跟着的任务本来就不画按钮（`task_read_only` 的说法给别的客户端和脚本）。
- **列表行内作答**：不需要新协议。一次展开一行 = 一条连接一次开一个任务（`open_task`）：`TaskView.reviews` 给改图、归档的卡片（human 验收不在行内作答，见下"T8 审查后用户定"）；节点的提问在节点的会话里（`TaskView.nodes[].sessionId` 加 `watch`，`answer_question`）。确认初始图和验收仍只给"打开任务"。
- **没做**：设计中的初始图的"确认并启动"不是审核（SPEC"human 节点"的原话）；agent provider、`request_review`、固定关卡；"等你处理"收件箱的任务条目和搜索（界面按 `TaskSummary.attention` 和 `current` 自己做）。

### T8b 定下的细节

2026-11-06，T8b（交互任务区的界面）实现时定下。协议没有改（号仍是 34）：T8a 给的东西够用。视觉规则写在 [design-language.md · 任务区](../architecture/design-language.md)。

**共用的外壳与审核卡片**

- 提问卡片和审核卡片共用 `chat/card-shell.tsx`（`CardShell`、按钮和按键提示的样式、多张时的胶囊标签 `CardTabs`），提问卡片的测试原样通过。审核卡片 `chat/review-card.tsx` 只读 `PendingReview`，不知道任务；文字和链接经 `ReviewEnvContext`（`chat/review-env.ts`）从外面给：任务的"代码 → 说法"都在 `tasks/review-words.ts`，以后 agent 来源的审核换一份说法就能用同一张卡片。
- 几张卡片同时在（`ControlCards`）：提问和审核合成一排胶囊，按出现先后（提问 `askedAt`、审核 `openedAt`）排，一次展开一张；打开的那张在被裁决或结束后，换成排在最前的。
- 按钮：推荐的排最前；需要原因或目标的按钮按下去展开表单，不需要的直接发裁决；`remaining: 0` 的目标置灰（"已用完"），只剩一个能选的自动选上；必填原因要有非空白字才能确定；原因可选的（"不批准"）随意。没提交的内容按"会话 + 审核 id"留在页面里，裁决成功后清掉。裁决失败时（`review_closed`、`review_invalid`、`task_back_limit`、`workspace_dirty`、`task_state_invalid`……）在卡片里写原因，卡片不收，可以再按；一次只发一个裁决，等答复期间再按不发。
- agent 来源的审核（形状有、provider 还没有）：即使协议里带了 `facts` 也不画（可信度规则放在卡片里再保一道），摘要写"agent 说"、按文字显示。
- 过程轨道上的审核记录：`Notice.review` 和 `task_progress` 同组折叠（`arrangeRows`）；"你批准了图 v2""你没有批准图 v2：原因""你通过了 N4""你打回到 N2：原因""你选了归档 / 先留着"；点开是当时的证据快照和你写的原因；折叠的一行把每个裁决写进去。T8a 留的占位文字（`审核 · <动作>`）换成同一套说法。

**任务对话与节点对话**

- 任务对话窗格（`TaskConversation`）加了输入框、`ControlCards`（提问和审核）、需求摘要卡片（`TaskView.requirements`，模型写的话按文字显示，全空不画）。发消息是 `prompt` / `steer` / `stop`，对象是任务对话的会话 id，从不 `open_session`；审核开着时发消息也是 `prompt`，卡片不动（ADR-0017）。
- pi 没在跑的会话（宿主重启后、任务结束后、已通过的节点）：`watch` 之后如果视图仍是"正在读取"，调 `open_task_session`（发消息前也核一次）；这解决了 T7 记下的"任务结束后窗格停在正在读取"。
- 节点对话标签（设计稿第 8 屏 A）：任务区的标签 id 是 `<任务 id>#<节点 id>`，紧跟在它任务的标签（和它已有的节点标签）后面，关任务时一起关，单关回到任务；打开方式：图上节点的悬停卡里"打开节点对话 ›"，任务对话里已开始节点的进度行（按下），列表行里"到 N2 的对话里讨论 ›"，收件箱里节点提问的那一条。内容是同一个对话窗格全宽，没开始的节点写"还没开始，没有对话可看"。被只读跟着的任务没有节点对话。
- 任务栏按钮：设计中"放弃任务""确认并启动"（图还没画时后者灰）；运行中 / 等你"暂停任务"（暂停后"继续"）和"取消任务"；你停下的任务只有"取消任务"；完成和取消的没有；回答"先留着"之后（`archive = kept`）有"归档 worktree"兜底；被跟着的任务一个都没有。放弃和取消原地问一句再做（"确定 / 不了"，Esc 是不了），不弹对话框。

**改过的节点与提议的图**

- `TaskView.graphDiff` 给当前图的"新"和虚线框；卡片的"在图上看"把图换成 `TaskView.pending` 的那一版（**已在图里的节点保持当前状态，只有新节点是未开始**，去掉的节点写在横幅里，2026-11-08 用户定），标记用 `pending.diff`，横幅上有"回到当前图"。

**列表、收件箱、`/task`**

- 列表行：按一下展开（一次一行），再按收起，"打开任务"在展开的内容里（T7 的"按一下就打开"改了）。展开时对这个任务 `open_task`：改图、归档的审核直接用卡片，经 `answer_review`（会话 id 用任务对话的，宿主的 ReviewHub 不需要会话在跑）；提问的节点用 `watch` 看它的会话，用 `answer_question` 答，旁边有"到 N2 的对话里讨论 ›"；失败的节点有"重跑这个节点"；设计中的初始图和 human 验收（通过 / 打回 / 合并）行内都只给"打开任务"，在任务标签里作答（**2026-11-08 改：原先 human 的审核也在行内出卡片，见"T8 审查后用户定"**）。
- "等你处理"：`TaskSummary.attention` 或设计中的任务（和侧栏"任务"的数字同一组）各占一行，写"任务名"和"N2 在问 / 等你验收 / …"，按紧迫程度和会话混排；点了打开任务标签，提问的直接打开那个节点的对话。
- `/task` 是内置命令（`name: task`，参数是范围，运行中不能用、没有第一条消息前不能用），由输入框拦下调 `create_task`，不发给模型；成功后打开任务标签；失败写在输入框上面（`task_already_converted` 等）。命令列表里写"把这段对话转成任务"。
- "查看改动"离开任务区，选中那个 worktree 并打开右栏。

**没做、留给后面**

- agent 来源的审核（provider、`request_review`、固定关卡）；定时标签的内容；搜索里任务内部对话的结果（T10/T11）。

### T8 审查后用户定

2026-11-08，T8 三方审查（Codex gpt-6-astra、Grok grok-4.7、Claude）之后。协议号 34 → 35（用户定："不批准"的原因可选这一条算协议改动）；线上的字段没有变，`reason` 的值 `optional` 本来就有，所以只是宿主给出的内容和上限变了；合回 `main` 时取当时的下一个号并重新生成 Swift 投影（已跑 `pnpm protocol:swift`，夹具和 `RoundTripTests` 的版本号跟着改）。

**用户定的四件事**

1. **任务列表里只有三种就地作答的卡片**：节点提问、改图批准、归档。human 节点的验收（通过 / 打回 / 合并，包括合并被挡后的重试）**不在列表行里出卡片**，行内只给"打开任务"，在任务标签里作答。一行有几张卡片时，和任务对话里的 `ControlCards` 一样排成胶囊，一次展开一张。上面几处互相矛盾的句子已改。
2. **"在图上看"（提议的图）**：已经在图里的节点**保持当前状态**，只有新加的节点是未开始，去掉的节点写在横幅里。原先"节点都是未开始"的写法作废（代码和测试本来就是这样做的）。
3. **改图批准的"不批准…"收一个可选的原因**：宿主给 `reject` 的 `reason` 是 `optional`；界面点了展开原因框，可以留空直接确定；原因进裁决记录（"你没有批准图 v2：<原因>"）和任务对话 pi 读到的那一行（`The user's reason: …`），所以模型能看到。不写原因时记录是"你没有批准图 v2"，和从前一样。
4. **手机（远程客户端）和任务 / 节点会话**：可以做对话的事——`prompt`、`steer`、`stop`、`answer_question`；不可以做审核和任务的事——`answer_review`、`open_task_session`，以及开始 / 暂停 / 继续 / 取消 / 放弃 / 批准 / 打回 / 重跑 / 继续节点 / 回答归档等任务命令，都是 `local_only`。手机对 pi 没在跑的任务会话发 `prompt` 时，宿主按 `prompt` 一贯的做法启动它的 pi（`ensureRunning`），不需要也不借用 `open_task_session`，所以不给手机增加任何任务命令的权限（真实宿主测试：手机连接对没在跑的任务对话发 `prompt`，pi 起来、消息被收到；`answer_review`、`open_task_session` 仍是 `local_only`）。安全面见 [security.md](../architecture/security.md)。

**宿主**

- **任务和节点的会话不能变成普通标签**：`open_session`、`rename_session`、`archive_session` 对目录项带 `task` 的会话，**对所有客户端**一律答 `session_not_found`（和"不存在"同一个码，不暴露它存在）。任务自己放手这些会话走任务服务内部的 `retire`，不经这三个命令。
- **裁决只对看过的那一版图有效**：`task_graph` 审核的裁决带着审核时的版本号，任务自己的队列里核对 `pendingGraph` 还是这一版，不是就答 `review_closed`、不执行（审核和裁决之间来了新提案，不会批准没看过的图）。
- **协议的上限由提供者守**：human 审核的证据最多 8 条——事实和改动最多 2 条，上游摘要最多 6 条（图顺序，多出的不给）；`reviewsOf` 最多返回 16 条，先出现的在前；ReviewHub 对每个会话的审核再按 16 条截一道（保险，不改变提供者的结果）。客户端因此不会再因为超限静默丢掉 `open_task`、`task_updated`、`control_updated`。
- **卡片上的事实不会陈旧**：每次对一个任务 `open_task`（任务标签、列表行展开、节点标签都会发），宿主让 ReviewHub 在后台重算它任务对话的审核（`refresh`），变了就推 `control_updated`，所以 human 节点等待期间工作区被改了，下次打开或切回任务就是新的计数。没有去听工作区变化（会给每个等待中的任务多开一个监听），也没有在每次读 `Control` 时重算（`Control` 一有变化就重建，会让每次增量都跑一遍 git）。
- **合并中途关闭**：`answerHuman` 返回时节点还在 `merging`（宿主正在关闭）不写"通过"记录，只有最后成功的那次写。
- **ReviewHub 不无限增长**：空闲的队列（`lanes`）立刻丢；`known` 只给"有审核的"或"有控制器在读的"会话留，控制器放掉时（`dropController`）调 `forget`，没有审核了也没人读就丢；用 `review.session` 资源计数，泄漏测试看它回到 0。路由没有请求的取消信号（`router.ts` 的 `run` 不带 `AbortSignal`），所以 `decide` 用的还是 ReviewHub 的关闭信号，没有传请求的。
- **被跟着的任务**：列表行不对别的进程的节点会话 `watch`，也没有节点对话的链接。
- **`/task` 对已转为任务的对话**：按错误表，`task_already_converted` 的 `params.taskId` 就是那个任务，界面直接打开它的标签。
- **错误码的说法**与上面错误表逐字一致：`review_closed` "这条审核已经处理过了"，`review_invalid` "这个裁决不合这条审核，刷新后再试"。

**界面**

- **暂停的任务**：宿主对暂停的任务给 `status: stopped` 加 `paused: true`（没有 `running` 加 `paused` 这种状态），任务栏看 `paused` 显示"继续"和"取消任务"；只有"你停下的"（`stopped` 而没暂停）才只有"取消任务"。
- **没提交的审核输入**：只在**已读到**的 `Control`（`ready`）里这条审核不见了才丢；"正在读取"时的空列表不算。
- **发不出的消息放回输入框**：`open_task_session`、`prompt`、`steer` 被拒时，文字放回输入框，和普通对话一样。
- **宿主重启**：打开着的任务 / 节点对话在宿主换了之后重新 `watch`，视图读不到时再 `open_task_session`，和普通会话的标签一样。
- **审核记录**：展开的记录显示当时证据的快照，**没有按钮**（没有"查看改动"、"在图上看"）；"在图上看"带版本；`looking` 在 `pending` 没了或版本变了时复位。看着 v3 时来了 v4：**换成 v4 的图，横幅换成 v4**（不静默停在 v3，也不跳回当前图）。
- **按钮**：裁决成功后卡片在审核离开 props 之前一直是禁用的；"正在提交"的锁按"会话 + 审核 id"记，切胶囊不会解锁。
- **没有推荐的按钮时**：不把第一个按钮画成蓝色推荐按钮；蓝色只给 `recommended`（[design-language.md](../architecture/design-language.md)）。
- **watch 的释放**：列表行和任务 / 节点对话卸载时释放自己的 `watch`，但不清掉接手的新所有者的 watch。
- **收件箱的任务行**：点了和会话行一样先 `leave()` 并关掉打开的页面，再打开任务区。

### T9 定下的细节

2026-11-09，T9（宿主重启）实现时定下。协议没有改（号仍是 35）：宿主启动时自己接回任务，界面照旧经 `watch` 和 `open_task_session` 看。

**启动**

- `TaskService.recoverAll(signal)` 只管自己的任务（`ATRIUM_FOLLOW_TASKS` 跟着的任务不进它，也不会被写）。`startHost` 在**找到 pi、状态是 `ready` 之后**调用一次，后台跑，宿主关闭时取消，关闭时等它收尾。pi 没装好（`missing`、版本不对）→ 记一条 warn（只有代码）、不接任务：节点要的是 pi，这时硬接会把每个节点都判成 `crashed`。任务留在磁盘上原样不动，装好 pi 后重启 Atrium 才接。`HostConfig.recoverTasks: false` 关掉它（`pnpm task:try` 自己管那一个任务，用）。
- 顺序：先解掉过期的锁（正在跟着别人的任务时不做：别的进程的任务对这个宿主是“不存在”，会被误解锁），再按任务建立的顺序逐个 `recover`；一个任务接不回来只记 warn，不挡后面的。设计中的任务（还没 `started`）、被放弃的任务不动。
- `recover` 的步骤（一个任务的队列里）：
  1. 结束了的：`done` 或 `cancelled` 的任务有 worktree 就再解一次锁，然后结束；
  2. 没结束的：有 worktree 就再加一次锁（幂等）；
  3. `workspaceState` 是 `creating` → 再发 `ensure_workspace`（认回崩溃时建了一半的 worktree，见下）；
  4. `running` 而没有会话的节点 → `start_node`（T4 已有，认回已记的会话）；
  5. 有待结算的 `node_done`（`pendingDone`）、不在 `commitPending` 的 `running` 节点：读它的会话文件，**最后一条是 `node_done` 的成功工具结果**（`terminate` 的那一条；失败的结果 `isError`、没有它）→ 先送 `node_settled`，让节点走正常的结算（可写的发 `commit_node`）；
  6. 送 `host_restarted`。
- 节点的契约在会话文件里：`contractSent` 没记、但会话文件第一条用户消息已经是契约（`<atrium-task-node>` 开头）→ 补记 `contract_sent`，再发 `resume_node` 该发的话（“宿主重启了”）；文件里没有（pi 还没写就死了）→ 照旧发契约。这关掉了“prompt 已送达、`contract_sent` 还没写”的窄缺口。
- 恢复时自己起的节点（上游刚结算，它的后继当场起来）已经收到了契约，`host_restarted` 对它不再发“宿主重启了”（runner 给每个任务记着这个进程里对话过的节点会话，`recover` 把其中的节点放进事件的 `live`，调度器不管它们；见“T9 / T10 审查后用户定”）；会话文件里已有契约、`contract_sent` 没记的节点才需要这句。
- 问题作废（任务被暂停或有节点失败时，节点只是 `held`，这两句记在节点上，等真的恢复时再说，见“T9 / T10 审查后用户定”）：重启后会话的 pi 是新的，没有“正在问”的状态；`host_restarted` 让 `waiting(question)` 的节点回 `running`，`resume_node` 带“刚才的问题作废了，需要的话再问”，节点愿意的话会再问一次（新的问题卡，不是旧的）。

**`ensure_workspace` 的崩溃窗口**

- 谁会留下没人认的 worktree：`git worktree add` 做完、`workspace.json` 还没写（中间还隔着“登记工作区”）时宿主死了。
- 做法是**先写计划**：`createFrom` 选定分支和目录、确认它们空着之后、`git worktree add` 之前，调用 `onPlanned`，任务目录的 `workspace.json` 写成 `{ "planned": { "source", "branch", "dir", "start" } }`（`source` 是来源工作区，`start` 是起点提交）；建完、登记完再改写成 `{ "workspaceId" }`。两种形状互斥（`workspaceId` 在先）。
- 宿主重启后 `ensure` 看到只有计划：让 `WorktreeCreator.adopt` 核对，**全部成立才认**——
  - 目录是 `git worktree list` 里的一个 worktree，目录正是计划的目录，检出的分支正是计划的分支；
  - HEAD 正是 `start`（没有任何提交），`git status --porcelain` 为空（半截检出、被改过的都不认）；
  - 没被锁成别人的（锁的原因不是 `atrium task <本任务>` 就不认）。
  认了之后：没有这个目录的工作区记录就登记（`addWorktree`，起点提交 `start`），再把 `.worktreeinclude` 复制一遍（上次可能做了一半），写 `{ workspaceId }`，回 `workspace_created`。
- 任何一条对不上（目录是别的东西、分支被别人用了、有了提交）→ **不认**，按平常新建；分支或目录已被占就走已有的 `-2`、`-3`… 避让，所以不会卡死。留下的东西不删（那可能是用户的）。绝不接手不是本任务计划建的 worktree。
- 计划里的分支和目录是计划时刻空着的；之后同名同目录同起点又空的 worktree 只可能是宿主建的或有人刻意仿造，仿造的要同时伪造分支、目录、起点、干净状态，且只在宿主崩溃的那一个窗口里有用，这个风险接受（安全面见 security.md：不执行 worktree 里的任何东西，adopt 只用 `runSafeGit` 读状态）。

**`request_graph_change` 的理由和建议落盘**

- `node_waiting` 事件加可选的 `request: { reason, suggestion }`（只有 `waitingFor: "graph_change"` 才带），`NodeRun.graphRequest` 存着，等待结束（图被批准 / 拒绝、节点被放走）就清掉。长度是通道本来的上限（理由 4 000、建议 32 000 字）；唤醒时照旧包 `<atrium-quoted>`，建议截 12 000 字。快照因此多出最多约 36 000 字，只在等待期间。
- `wakeConversation` 从 `NodeRun.graphRequest` 读，不再读内存里的 `NodeContext.graphRequest`，所以重启后的再唤醒和第一次一样完整。`TaskView` 不带这个字段（协议不变）。

**任务对话接回**

- 不需要新协议。普通会话 pi 没在跑时也是 `watch` 订阅不到快照、要 `open_session` 或发消息才起 pi；任务对话的对应物是 T8a 的 `open_task_session`，T8b 的窗格在“正在读取”时就调它。T9 的宿主层测试核对了宿主重启后这条路走得通：重新 `watch`、`open_task_session`，快照带着重启前的对话。`resume` / `nudge` / 进度行 / 唤醒本来就在需要时起对话的 pi。
- 启动时不预先起任务对话的 pi（没人看就不占进程）。

**动作幂等的补充**

- `lock_workspace` 在 `recover` 里对没结束的任务再做一次；`unlock_workspace` 对 `cancelled` 的任务也做（原先只有 `done`）。
- 归档：`answerArchive("archive")` 在工作区已归档时不报错（`archiving.archive` 本来就幂等），所以“归档做完了、`archive_answered` 没记”重启后再答一次就行；不自动代答。
- `propose_graph`：事件写下了就有 `pendingGraph`，重启不再唤醒；没写下，重启后的唤醒只会让任务对话再出一次，不会有两版待批准的图（`graph_proposed` 本来就是“第二个替换第一个”）。

**“每个动作做完、事件没写”的崩溃测试**

- 做法：真宿主、真 git、真 pi 跑 faux 模型，把任务跑到该动作的结果刚记完，宿主关掉，把 `events.jsonl` 截到该事件之前（相当于动作做完、事件没写进去时死掉），重新启动（启动时自己 `recoverAll`），断言没有重复。覆盖：建 worktree（`workspace_created` 丢了）、起节点（`node_started` 丢了）、契约（`contract_sent` 丢了）、提交（`committed` 丢了）、合并（`merged` 丢了）、归档（`archive_answered` 丢了）、提问（问题开着时宿主死了）、提改图（`graph_proposed` 在 / 不在）。表驱动，见 `packages/host/src/tasks/t9.host.test.ts`。

**没做、留给后面**

- pi 没装好时启动不接任务，装好后要重启（不监听 pi 状态变化）。
- `request_graph_change` 已被宿主接受、但 `node_waiting` 还没记时宿主死了：节点按“宿主重启了”重新跑，会再申请一次（理由没丢，因为还没存）。
- 归档做完而 `archive_answered` 没记：不自动补记（用户可以再答一次）。
- 同一个工作区里 `workspace_created` 记了、`lock_workspace` 没做的窗口由 `recover` 补上；`progress_line` 靠扩展按行 id 去重（T6 已有）。

### T10 定下的细节

2026-11-09，T10（定时）实现时定下。SPEC 原文没答的，都取保守的一边；界面说法和取舍的七点已由用户定（见下面"2026-11-09 用户定"）。

**时间与触发**（`packages/host/src/tasks/cadence.ts`、`schedule-service.ts`）

- **`Cadence` 多一种**：`{ every: "interval", minutes }`（1 到 1440 分钟），从规则创建的时刻起每隔这么久一次（"每 5 分钟跑一次调研"要它）。`day` / `week` 的 `at` 是 `H:MM` 或 `HH:MM`，24 小时；`week` 的 `day` 0 是周日。定义在 `packages/protocol/src/schedule-cadence.ts`，宿主、扩展、界面共用。
- **时区**：`createScheduleService` 收一个 IANA 时区名，默认本机的；测试给任意时区。钟点用这个时区的挂钟算；`interval` 是绝对分钟，不受夏令时影响。夏令时按 SPEC：拨快那天不存在的钟点，在钟跳过去的那一分钟（第一个存在的分钟）触发一次；拨慢那天重复的钟点只在第一次出现时触发。
- **一个定时器**：规则里只要有一条没暂停，就挂一个经 `trackedTimeout` 记数的定时器，睡到下一个触发时间，最久睡 60 秒（`HEARTBEAT_MS`），醒来用 `Clock.now()` 问"从上次触发到现在有没有该触发的"。所以"错过"、"Mac 睡醒"、"系统时间被拨动"是同一个问题的同一个答案，不用分支；SPEC 说的 `powerMonitor` 转发因此没做（睡醒后最多 60 秒内补上）。全暂停、全删除、宿主关闭后没有定时器。
- **错过补一次**：规则的"起点"是 `max(lastFiredAt, createdAt)`；起点之后、现在之前该触发的最近一次，就是这次触发的时间，错过多次只补它，`lastFiredAt` 记成它。宿主启动时（找到 pi 之后，已启动的任务接起来之后）问一次，之后每次定时器醒来问一次。
- **上一次没结束就跳过**：`lastTaskId` 的任务状态不是 `done` / `cancelled`（含等你处理、停下、暂停）就 `skipped + 1`，`lastFiredAt` 照样推进；任务已不在磁盘上算结束。补一次和跳过可以同时发生：错过了三天、上一次还在跑，结果是 `skipped` 加一、不新建任务。
- **系统时间往回拨**：`lastFiredAt` 在"现在"之后时没有"起点之后、现在之前"的触发，所以不补；已触发过的时间点回来也不重复（它不在起点之后）；等下一个时间点。
- **先记时间再建任务**：触发时先把 `lastFiredAt` 写盘，再建任务，再写 `lastTaskId`。崩在中间会少一次，不会多一次；崩在"任务已启动、`lastTaskId` 还没写"时，下一次触发和启动时都按 `origin.ruleId` 在磁盘上找这条规则的任务（见"T9 / T10 审查后用户定"）。任务建不出来（pi 起不来、容器没了、图不合规）只记一条 warn，这次触发算用掉了，下一个时间点再试，不在每个心跳重试。
- **立即跑一次**：不管上一次在做什么都新建一个任务，不动规则的 `lastFiredAt`，把 `lastTaskId` 指向它、`skipped` 清零。它算规则最近的任务：它没结束时，下一个到点的时间点照"上一次没结束就跳过"跳过（2026-11-09 用户定）。
- **暂停与恢复**：暂停期间到点的不补；恢复时 `lastFiredAt` 取 `max(原值, 现在)`。
- **规则文件** `<home>/schedules.json`：`{ v: 1, rules }`，经 `writeAtomically` 整份重写。规则比 SPEC 多三个字段：`containerId`（模板对话所在的容器，触发出来的任务对话放进它）、`sourceDir`（模板的目录，即每个任务的 `sourceDir`）、其余同 SPEC。读不懂的单条规则原样保留在文件里（以后的 Atrium 写的不被丢）；整个文件不是规则文件（不是 JSON、版本不对）：不装任何规则、不写回、不挂定时器，所有改规则的命令答 `schedule_file_unreadable`，定时标签显示这条错误（见"T9 / T10 审查后用户定"），直到用户处理这个文件、重启 Atrium。
- **没有项目的对话不能定时**：`task_set_schedule` 对 `projectId: null` 的任务答 `task_state_invalid`，规则的 `projectId` 因此一定有。
- **跟随开发版任务目录时**（`ATRIUM_FOLLOW_TASKS`）、`pnpm task:try`（`recoverTasks: false`）不建 ScheduleService：不读规则、不触发；定时命令一律 `task_read_only`，`list_schedules` 答空。

**规则从对话来**

- **`task_set_schedule({ when, place })`** 现在注册，任务对话共九个工具。只在任务还在 `designing` 时可用，已启动、已结束、取消、没有项目都是 `task_state_invalid`；`when` / `place` 经 zod 校验，错的参数是 `task_bad_request`；`place` 是 `local_readonly` 而生效的图里有 `work` 节点是 `task_graph_invalid`（`readonly_rule_has_work`）；再调一次替换。事件 `schedule_set`，任务记录的 `scheduleDraft` 就是它。有 `scheduleDraft` 的任务是"规则模板"：之后 `task_propose_graph`、`start_task` 的校验都按 `place` 判断是否只读规则。
- **模板不进任务列表**：`list_tasks` / `tasks_updated` 过滤掉有 `scheduleDraft` 的任务；"修改"按 id 打开它。模板不运行，不参与"等你处理"。
- **"确认并保存规则"就是开始页的"确认并启动"按钮换了字**（SPEC 原文：开始页的按钮写"确认并保存规则"），不是 ADR-0017 的关卡：它是用户对图本身的确认，不是对某个已有东西的裁决。命令仍是 `start_task`：对模板，宿主再校验一次图，然后保存规则（新规则，或这个模板已有规则时改规则），任务本身仍是 `designing`，什么也不启动。`TaskView.scheduleDraft`（`{ when, place, saved }`，非模板为 `null`）让界面把按钮写成"确认并保存规则"；`saved` 为真时不再给"放弃任务"，因为模板随规则走：对已存规则的模板 `abandon_task` 是 `task_state_invalid`，删除规则（`delete_schedule`）才会带走它（删它的目录、归档它的任务对话）。
- **模板被删**（目录没了）：规则照旧触发，它自己存着摘要、图和模型；`edit_schedule` 答 `task_not_found`。
- **每次触发出一个普通任务**：`TaskService.createScheduled`：开自己的任务对话（容器、目录取规则的，模型取规则的；不发设计消息，没有东西要设计），记录 `origin: { kind: "schedule", ruleId, firedAt }`，摘要和图取规则的，再记 `started`；图按规则的 `place` 再校验一次，失败不留半成品（撤回记录、删目录、归档任务对话）。名字"规则名 · 11 月 9 日"（触发时刻在本机时区的日期）；一天触发多次的 `interval` 规则再加时间，"规则名 · 11 月 9 日 14:05"（**待确认**：SPEC 只写"规则名 · 日期"，每 5 分钟一次的规则会撞名；2026-11-09 用户定，保持）。`TaskSummary.scheduled` 因此为真，列表里图标是时钟、位置行写"项目 · 定时 · worktree"（T7 已做）。
- **设计消息**多一步：需求里说了按时间重复，就用 `task_set_schedule`（SPEC-0006 附录第 5 条）；引导词文字没改，版本不变。

**协议**（35 → 36，Swift 投影已重新生成）

- 命令：`list_schedules({ watch? })`（答 `{ schedules }`）、`pause_schedule`、`resume_schedule`、`run_schedule_now`（答 `{ taskId }`）、`delete_schedule`、`edit_schedule`（答模板的 `{ taskId }`，并先起它的任务对话的 pi）；参数是 `scheduleId`。事件 `schedules_updated { seq, schedules }`，整份、`seq` 规则同 `tasks_updated`。全是 `local_only`，事件不推给手机（SPEC 的手机只读只含任务列表、任务和两个事件）。错误码 `schedule_not_found`（`params.scheduleId`）；对已暂停的暂停、没暂停的恢复是 `task_state_invalid`。
- `ScheduleSummary`：`id`、`name`、`projectId`、`place`、`when`、`paused`、`nextAt`（暂停为 `null`）、`last`（`{ taskId, status, failed }`，上一次的任务；没有或已不在为 `null`）、`skipped`、`templateTaskId`、`createdAt`。宿主只给状态和时间，说法在界面。
- 客户端：`client.schedules`（`{ status, schedules, seq }`）、`watchSchedules(on)`、`pauseSchedule` 等。规则或"上次的任务"变了都会推；模板的"已保存"变了，推一次 `task_updated`。
- 界面说法：`schedule_not_found` →"这条规则已经不在了"。

**定时标签**（设计稿第 3 屏）

- 一条规则一行：时钟图标、名字、第二行"项目 · 每次新建 worktree / 只读，在本地目录跑"（有跳过时加" · 跳过 N 次 · 上次还在跑"）、时间、"下次 …"、上次结果，以及动作。没暂停的：立即跑一次、暂停、修改；暂停的：恢复、修改、删除（设计稿只在暂停行放"删除"，所以先暂停再删）。"删除"点下去，"删除这条规则？确定 / 不了"出现在这一行下面单独的一行（同一张行卡片里，不挤名字那一列），键盘和焦点同任务栏的（焦点在"确定"，Esc 回去）。"修改"打开模板的任务标签，那里按钮写"确认并保存规则"。没有"新建"。
- **说法（2026-11-09 用户定，保持）**：设计稿给了"每天凌晨 2:00""每天早上 9:00""每周一 10:00""下次 今晚 2:00""下次 明早 9:00"、结果栏"上次失败""这次在跑""已暂停""—"。没有给的，先这样写：下午、晚上和中午（"每天下午 2:30"、"每天中午 12:15"、"每天晚上 9:05"，12 小时写法加时段词）；每周不加时段词（照"每周一 10:00"）；间隔"每 5 分钟""每小时""每 2 小时"；"下次"写"下次 今天 14:05 / 明天 2:00 / 11 月 12 日 2:00"，不照设计稿的"今晚""明早"；结果栏"这次在等你""这次停下了""上次完成""上次取消了"。全在 `packages/ui/src/tasks/schedule-words.ts`，一处改。
- 空状态沿用 T7 的说法。

**2026-11-09 用户定**（T10 的七处界面取舍）：

1. 间隔写"每 5 分钟""每小时""每 2 小时""每 90 分钟"：保持。
2. 钟点的时段词（凌晨、早上、中午、下午、晚上，12 小时写法加分钟）；每周不加时段词（照"每周一 10:00"）：保持。
3. "下次"写"下次 今天 14:05 / 明天 2:00 / 11 月 12 日 2:00"，不用"今晚""明早"：保持。
4. 结果栏除设计稿的"上次失败""这次在跑""已暂停""—"外，另加"这次在等你""这次停下了""上次完成""上次取消了"：保持。
5. 间隔规则一天触发多次，任务名加时间"规则名 · 11 月 9 日 14:05"：保持。
6. **改了**：删除的确认"删除这条规则？确定 / 不了"放在这一行下面单独的一行，仍在同一张行卡片里，名字那一列的宽度不变；键盘和焦点照旧（浏览器测试断言名字格的宽度在确认出现前后不变）。删除只在暂停的行出现，照设计稿。
7. 规则没起名时显示"（还没起名）"：保持。

**没做**：`powerMonitor` 转发（见上，心跳覆盖）；规则的"最近几次"历史；改规则的名字（跟模板任务名走，在任务对话里改）。（规则文件损坏时的界面提示原先没做，审查后补上了。）

### T9 / T10 审查后用户定

2026-11-09，T9、T10 做完后三家审查（见 coverage-map 里的"T9 / T10 审查修复"）找到的问题。下面六条是用户定的；其后是没有设计问题、直接照办的修复和选定的做法。

**用户定的六条**

1. **过期的锁**。锁的原因记下是哪个 Atrium 家目录加的：`atrium task <任务 id> home <ATRIUM_HOME 路径的 SHA-256 前 12 位十六进制>`。旧写法 `atrium task <任务 id>` 照旧认得（归档遇到它仍答 `workspace_in_task`），但认不出归属。宿主启动时**只解**：新写法、家目录哈希是本机的、任务已 `done` / `cancelled` 或任务目录不存在。留着不解的：别的家目录的锁、旧写法的锁、任务目录在但读不出来的锁（`events.jsonl` 坏了之类，它可能还在跑）。实现：`TaskService.recoverAll` 先读目录，把"目录在的任务 id"交给 `TaskRunner.clearStaleLocks`；runner 里有记录的任务看 `endedAt`，没记录的任务看它的目录在不在。
2. **改规则的时间或频率**从保存的那一刻起算：`confirm` 对已存的规则把 `lastFiredAt` 记成 `max(原值, 现在)`；`interval` 规则的格子从 `max(lastFiredAt, createdAt)` 起数（原先从 `createdAt` 起），所以改过或恢复过的间隔规则从那一刻起重新数。保存从不当场触发。
3. **pi 没准备好**（没装、版本不对）：到点不触发、不用掉时间点（`lastFiredAt` 不动）、记一条 warn（`schedule trigger waits for pi`，只有规则 id，一次没好只记一次，好了再重置）。`ScheduleService` 收一个 `ready()`，`main.ts` 用和 `recoverAll` 同一个 `piReady`；等 pi 的时候定时器按心跳（60 秒）醒来再问，不会 1 毫秒一转。下次启动 pi 好了，按"错过补一次"补跑一次。定时标签不加状态。
4. **规则文件读不出来**：`schedule_file_unreadable`（新错误码，协议号 36 → 37）。确认、暂停、恢复、删除、修改、立即跑一次、`list_schedules` 都答它；不往内存里装任何规则、不挂定时器、不碰文件。定时标签把这条错误的话「定时规则文件读不出来，没有保存」放在规则列表的位置（`watchSchedules` 被拒时的通用做法：显示错误的说法，不再停在"正在读取定时规则…"）。"确认并保存规则"同样答这条码，按钮旁显示同一句话，模板留在任务列表里。
5. **模板**：有 `scheduleDraft` 的任务在规则真的存下来之前留在任务列表里（可以放弃，可以在它的标签里改），存下来之后才隐藏。`createTaskCommands` 的"列不列"改看 `saved(taskId)`；保存规则、删规则都会让宿主刷新一次列表。
6. **立即跑一次和下一个时间点**：立即跑一次建的任务算规则的"上一个任务"（`lastTaskId` 指向它），它没结束时，下一个到点的时间点被跳过（`skipped + 1`，`lastFiredAt` 照样推进）。立即跑一次本身不看上一个任务有没有结束。

**没有设计问题的修复，选定的做法**

*定时与崩溃窗口*

- **崩在 `started` 之后、`lastTaskId` 存下之前**：`ScheduleTasks` 多一个 `ofRule(ruleId)`（`TaskService` 读磁盘上 `origin.ruleId` 等于它的任务）。"上一个任务没结束"同时看 `lastTaskId` 的任务和 `ofRule` 里任何一个没结束的任务；`start()` 先把 `lastTaskId` 对账（这条规则触发时间最晚的任务，晚于 `lastTaskId` 的任务就取代它），写盘后再问有没有到点的。
- **崩在 `createScheduled` 里**：选"重启时补上"，不选"当场撤回"（当场撤回本身也可能崩）。触发出来的任务跳过 `designing`，所以磁盘上 `origin.kind = "schedule"` 而没有 `startedAt` 的任务只会是崩溃留下的：`recoverAll` 对它送 `started` 再 `recover`（图在任务记录里）。会话已建、任务记录还没写的：`recoverAll` 开头清掉"任务目录不存在、也不是此刻正在建"的任务对话（`TaskSessions.conversations()` 列未归档的任务对话；`TaskService` 记着正在建的任务 id），不留孤儿对话。
- **崩在规则 `save` 与 `discardTemplate` 之间**：`remove` 改成**先删模板、再存规则**。崩在中间留下的是"规则还在、模板没了"（SPEC 本来就有这个状态：规则照旧触发，"修改"答 `task_not_found`，再删一次就好），不会留下隐藏的孤儿模板；又因为模板只在规则存下来时才隐藏（上面第 5 条），模板删不掉时它显示在任务列表里，用户可以放弃。
- **删与确认的竞争**：`confirm` 在排队执行时重新取模板（`lookup`），模板没了就答 `schedule_not_found`；调用时规则已存在、执行时却不在了，同样答 `schedule_not_found`。不会用过期的模板对象把删掉的规则建回来。
- **`start()` 之前不挂定时器**：`ScheduleService` 记一个 `started`；恢复期间的命令可以改规则、写盘，但不 `arm`。
- **关闭时不死锁**：`main.ts` 关闭时先把两个服务都发出关闭（`schedules.close()` 和 `tasks.close()` 一起开始，再一起等），触发里的建任务才不会等一个只有 `tasks.close()` 才会取消的提示；`createScheduled` 每一步之后再看一次 `signal`。
- **`pnpm task:try`**：只 `recover` 它自己的那个任务，`staleLocks: false`（它的家目录不是宿主的家目录，不去扫别人的锁）。

*T9 重启*

- **暂停或有节点失败的任务**：重启时 `running` 的节点变 `held`、`waiting(question)` 的节点变 `held` 时，在节点上记 `afterRestart`（`cutOff`：这一轮被重启打断；`questionVoid`：问题作废了）。以后这个节点真的被放回去的时候（`advance` 里的 `resume_node`），话是 `RESUME_HELD` 加上这两句（"宿主重启了。先看…"、"刚才的问题作废了，需要的话再问"），说完就清掉。任务一直停着就不发。已经是 `held` 的节点保持原样。
- **`host_restarted` 的次序**：选"这个进程已经对话过的节点就不管"，不选"recover 排上队之前不收命令"（后者要让窗口等 pi 好）。`TaskRunner` 给每个任务记 `spoken`（这个进程里发过契约、续作、继续、催促的会话），`recover` 在送 `host_restarted` 前把其中还在 `running` 的节点放进事件的 `live`，调度器对 `live` 里的节点什么也不做（用户先回答了的问题不作废、自己进程里起的轮次不被告知"宿主重启了"）。这也取代了原来的 `freshlyStarted`，那个集合只在 `resume_node` 里删，会一直长；`spoken` 在任务里，用完（`recover` 里）就删，任务 `detach` 时一起丢。
- **唤醒任务对话**：一次 `host_restarted` 只唤醒一次，不是每个等改图的节点一次（唤醒的话本来就列出所有等改图的节点）。
- **唤醒的长度**：整条命令（所有节点的理由和建议，加上引用的包装、转义）编码后要小于扩展的 32 000 字上限。预算按整条算：先按每个申请平分建议的字数，不够就逐级减半，最后只留"节点 X 申请改图（理由和建议太长，已省略；用 task_status 看现状）"这样的一行并带明确的截断标记，永远不会被扩展拒收。
- **`endedOnNodeDone`**：最后一条助手消息里的每个工具调用都要有结果（不止 `node_done`），才算那一轮在 `node_done` 上结束；有调用没结果说明这一轮被打断了。

*工作区认回（security.md）*

- `copyWorktreeInclude` 的 `git ls-files` / `git check-ignore`、`adopt` 里的 `git worktree list` / `rev-parse`、`repositoryOf` 都走 `runSafeGit`（钩子、fsmonitor、过滤器关掉）。
- **身份核对**：`adopt` 在计划的目录里自己问 `git rev-parse --git-common-dir` / `--show-toplevel`，`--git-common-dir` 必须就是来源仓库的，toplevel 必须就是计划的目录；分支、HEAD 也在目录里问一遍，不只信来源仓库里的登记。`status --porcelain` 带 `--work-tree=<已核对的目录>`，和提交一样不被 `core.worktree` 引走。
- **复制是原子的**：每个文件先写到 worktree 旁边的临时目录（`<worktree>.atrium-include`，同一个文件系统），再 `link` 到目标（目标已有就不覆盖，用户的文件不动），最后删临时文件；崩溃留下的临时目录在下次复制开头清掉。目标要么没有、要么是完整的。

*界面*

- **跟随模式**：SPEC 没有定时标签在跟随开发版任务目录时的说法；要先定说法再做（见"风险与待定问题"）。
- **`ruleSubWords`**：只有上一次真的还在（`running`，或 `waiting` 等你）时才写"上次还在跑"；失败、停下、设计中、已不在时只写"跳过 N 次"。
- **午夜与中午**：每天的 12 小时写法里午夜是"凌晨 12:00"，中午是"中午 12:00"；测试里原来的 `0:00` 改掉。每周的钟点照设计稿用 24 小时（"每周一 0:00"）；"下次 …"也是 24 小时（"明天 0:00"）。
- **焦点**：关掉删除的确认（Esc 或"不了"）后，焦点回到"删除"。
- **时区**（已核对）：宿主只发 `nextAt`（绝对时刻），界面只负责把它写成"今天 / 明天 / 日期 + 钟点"，用窗口所在的时区。桌面端的宿主是 Electron 主进程 `utilityProcess.fork` 出来的，没改环境变量，和窗口同一台机器、同一个用户会话，时区同源；规则里的钟点（"每天凌晨 2:00"）按宿主时区算，也按这个写。宿主启动时读一次时区，运行中改系统时区要重启才跟上（窗口会先跟上，这段时间里"下次"按新时区写、触发还按旧的）；这是已知的小缺口，不为它加机制。

*测试*

- 保留"动作做完、事件没写"的重放表，另加动作中途被打断的确定的断点（复制到一半、`git worktree add` 被杀、提示已被 pi 收下而会话文件没写、定时的各个崩溃窗口），以及一个真的子进程 `kill -9` 的测试（`t910.crash.host.test.ts`）。

## 备选方案

- **单独的任务台、首页列表、新建任务入口和草稿**（设计稿第 1、2 版）：入口多、和对话重复；改成只从对话 `/task` 创建，前面的对话就是草稿。
- **节点配置页**（第 2 版）：字段多、学习成本高；改成全部在任务对话里说，图只展示。
- **任务和对话混在一起**：节点对话放进 worktree 的标签组、侧栏加任务标记（第 3、4 版）。项目目录会被节点对话挤满；改成两个入口、两种视图。
- **模板**：用写死的"引导词"代替固定模板，agent 按需求挑一套再改；以后再做设置页。
- **宿主跑"怎样算完成"里的命令**：要解析命令、管超时和环境，第一版把验证交给图里的 `check` 节点。
- **节点对话直接当 SPEC-0002 的 agent 子对话**：现有实现会禁掉 `ask_user`、放开 `agent_*`，还会把每次结束回报给任务对话、重启时暂停送达，和任务的规则处处冲突；改成单独的 `task` 会话，只借用起停 pi 和送达。
- **用 followUp 提醒没调 `node_done` 的节点**：pi 空闲时 followUp 只进队列、不开新的一轮，节点会卡住；改用 `sendMessage(…, { triggerTurn: true })`。
- **节点自己调 `EnterWorktree` 进 worktree**（Claude Code、`@tylerho/pi-worktree`）：pi 不能中途换目录，要代理工具；由调度器决定建不建、把节点的 pi 直接起在 worktree 里更简单。
- **按路径改道**（`@rezamonangg/pi-worktree`）：pi 停在原目录、工具改到别处，`pwd` 和状态栏对不上，弃用。
- **自动重试、预算、超时**：第一版失败就停下找你，简单可预期；用出经验再加。
- **agent 节点之间打回**：两个 agent 容易互相踢；只让 human 节点打回。

## 风险与待定问题

- [x] **界面设计稿**：TP 2026-11-06 定稿（设计稿第 6 版第 6–8 屏：审核卡片、进度折叠、节点对话标签 A）。
- [ ] **pi 的版本**：
  - T0 已实测（2026-11-04，`packages/pi/src/contract/task.pi.test.ts`）：`terminate`、两种唤醒、`sequential`、`resolveToCwd`、`tool_call` 钩子能拦 `edit` / `write`，在 1.0.2、1.3.0、1.5.0 上都和本 SPEC 的假设一致；
  - 钩子拿到的是原样路径，路径隔离要自己先按 `resolveToCwd` 的规则解析（已写进 pi-internals）；
  - 以后升级 pi 时先跑这组测试。
- [ ] **名额**：同一个任务里最多 6 个节点同时跑；加上 `work` 独占 worktree，图里改代码的节点实际是一个一个跑。第一版接受。
- [ ] **合并在主检出目录里做**：你正在主目录里手动改东西、或者切在别的分支上时，合并会被挡住。第一版接受，提示写清。
- [ ] **扫描里直接跑的 git 没带安全参数**（T5 发现，原有问题）：工作区扫描（SPEC-0001）里的 `git status` 等在 agent 的 worktree 里直接跑，会执行 `core.fsmonitor` 和过滤器的 clean 命令。T1 只管了新建和恢复 worktree，T5 只把 MergeInspector 的 `merge-tree` 收进了 `runSafeGit`。需要一并改成安全的，单独排。
- [ ] **全局合并驱动在宿主的合并里变成冲突**（T5）：见"宿主自己跑的 git"。
- [ ] **宿主自己的提交不跑项目的钩子**：为了不执行 agent 放进 `.git/hooks` 的东西。lefthook 之类的检查要靠 `check` 节点。
- [ ] **路径隔离不是沙箱**：`cp`、重定向、脚本里的写入拦不住。
- [ ] **跟随开发版任务目录时的定时标签**（T9 / T10 审查，待用户定说法）：这时宿主不建 `ScheduleService`，`list_schedules` 答空，标签显示的是「还没有定时规则」的空状态，会让人以为是没建规则。需要一句话告诉用户这里不跑定时规则。建议：「这是在跟着别的进程的任务，定时规则不在这里运行」，协议上给 `list_schedules` 的答复加 `followed`（又一次协议号变动）。说法定下前不做。
- [ ] **引导词写死**：效果全靠这四段说明，调优只能改代码发版；先接受，等用出经验再做设置页。
- [ ] **引导词的效果**（T6）：四段话全靠它们让任务对话拆出合理的图；定稿前要用真实对话反复试（`pnpm task:design`），改了文字就加版本号。小改动倾向于选 `feature` 而不是 `fix`（`fix` 偏“一个已知的小问题”），定时修复的图是固定的、没有条件分支，所以没坏的那天也会走到最后一个 human 节点。
- [ ] **模型不核对**（T6）：`task_set_meta` 写了不存在的模型，宿主不拦，还没开始的节点会 `failed(crashed)`；以后有模型清单的端口再核对。
- [ ] **任务对话的 `bash` 在主检出目录**（T6）：它是只读角色，但 `bash` 本身不受限，同 SPEC-0002 的 `explore` 子对话；见 security.md。

## 实施计划

拆成 T0–T11 和 TP，每步都能单独验收、单独合回 `main`；每步的范围、完成标准和"你来验收"见 [路线图 · 任务与任务图](../roadmap.md#任务与任务图spec-0006)。顺序：

1. **T0 pi 契约**：`node_done` 的 `terminate`、两种唤醒、`sequential`、`resolveToCwd`、`tool_call` 钩子，在 1.0.2 和 1.3.0 上实测。
2. **T1 worktree 加固**、**T2 路径隔离**、**T3 任务核心**：三步互不依赖，可以并行。
   - T1、T2 先修现有功能（新建工作区跑钩子、`work` 子对话写到外面），同时改 SPEC-0001、SPEC-0002；
   - T3 全是纯函数和文件，带 `pnpm task:replay`。
3. **T4 节点运行**：`task` 会话、TaskRunner、任务扩展、契约、提交、五种失败，带 `pnpm task:try`；同时改 SPEC-0003。
4. **T5 human 节点与合并**：打回、合并与 `merge_blocked`、归档提问、协议。
5. **T6 任务对话与 /task**：带 `pnpm task:design`，用真实对话调引导词。
6. **TP 补原型**：随时可做，T7 前定稿。
7. **T7 任务区（只读）**、**T8 任务区（交互）**：T8 起才在输入框注册 `/task`。
8. **T9 宿主重启**：放在定时前面，定时补触发要靠它。
9. **T10 定时**、**T11 自用**。

## 验证

- **Scheduler**：表驱动用例覆盖"状态机"、"调度器"每条转移，包括审查提出的几种情形：
  - 兄弟失败后重跑，`held` 的兄弟自动接着跑；
  - 暂停后恢复；
  - 合并冲突后改图加节点，human 节点回到 `pending`，新节点跑完再到；
  - 打回时旁支一起重置；
  - 一个节点 `running`、另一个 `waiting` 时第三个失败；
  - `stopped` 期间批准改图。

  再加性质测试（随机图 + 随机事件序列，包括同一事件重复送两次）：
  - 同一个 worktree 里 `work` 节点在跑时没有别的节点在跑；
  - `stopped` 的任务不起新节点；
  - 打回次数不超过 2；
  - 同一个节点同一个 attempt 不会被 `start_node` 两次，`ensure_workspace` 在 `creating` 时不重复发；
  - 推出的任务状态和节点状态一致；
  - 任何状态下都存在一个能让任务继续或结束的操作（不卡死）。

  `step` 进变异测试（核心模块，增量 ≥ 80%）。
- **GraphValidator**：每条规则一个通过用例、一个不通过用例。
- **TaskStore**：
  - 写到一半崩溃（截断的最后一行）能从事件重放；
  - `task.json` 损坏能重建；
  - 重放后重新执行的动作按"动作要幂等"一节认出已做过的。
- **worktree**：用 testkit 的 `git.ts` 造场景：
  - 起点被移动后仍从原提交号建；
  - 仓库配了会写文件的 filter、`post-checkout` 钩子、`core.fsmonitor` 时，建 worktree 都不执行它们；
  - 有 `include.path` / `includeIf` 时拒绝建；
  - `.worktreeinclude` 只复制被忽略的匹配文件，超过上限的跳过；
  - 锁住时归档报 `workspace_in_task`；
  - 重启后清掉已结束任务的锁。
- **宿主层**（faux 模型脚本）：
  - 一张三节点图从 `/task` 跑到 `done`；
  - 节点不调 `node_done` → 开新的一轮提醒 → 再不调则失败；
  - `node_done` 和别的工具同批、`node_done` 之后插话，待结算都作废；
  - 兄弟节点跑完这一轮进 `held`，重跑后自动接着跑；
  - 打回后旁支和下游都重置，X 的契约里有上一次的交接摘要；
  - `request_graph_change` 之后这一轮结束不提醒、不提交，批准后接着跑；
  - 节点用 `ask_user` 能问到你；节点调 `task_propose_graph` 被拒（`task_caller_invalid`）；
  - 宿主重启后 `running` 节点接着跑、待结算的 `node_done` 照常结算；
  - 主目录不在主干、有未提交改动、合并冲突时都不合并，节点 `merge_blocked`，处理后再点"通过"能合并；
  - 放弃任务后来源对话能重新 `/task`。
- **路径隔离**（真实 pi 加 faux 模型）：
  - 被拦：`write ../outside.txt`、`write @/tmp/x`、`write ~/x`、`write file:///tmp/x`、经指向外部的目录链接写新文件、`write .git/config`；T4 补 `git -C <主目录> commit`；
  - 放行：`write ./ok.txt`。
- **泄漏**：任务跑完、取消、宿主关闭后，没有残留的 pi 进程、监听和定时器（`pnpm test:leak`）。
- **端到端**：从对话 `/task`，确认启动，在列表里答一个多选，验收合并，归档时选"归档"。
- 每条新行为登记到 `docs/testing/coverage-map.md`。

## 附录：引导词（T6）

四套引导词和任务对话的第一条消息写死在代码里（`packages/host/src/tasks/guides.ts`、`design.ts`），这里是全文，验收时照这里调：改了文字就同时改代码，并把对应引导词的 `version` 加一（任务记着自己用的是哪个版本）。每套是写给任务对话 agent 的一段话，定了常用的节点顺序和每个节点的默认角色、默认位置；agent 按需求选一套（提图时 `guide` 填 id）、按需增减。共同的底线：**实现的节点不验证自己**，验证一定是单独的 `check` 节点，审查是单独的 `advise` 节点。

### 第一条消息（`<atrium-task-design>`）

```
<atrium-task-design>
用户把一段需求对话转成了任务。你是这个任务的任务对话：先整理需求，再按下面的引导词设计任务图，之后用户会在这里和你商量怎么改图。
【来源对话】{会话 id}（用 task_read_source 读）
【范围】{用户在 /task 后写的范围，包 <atrium-quoted>；没写则“用户没有限定范围，整段对话都算。”}
【项目】{属于项目 / 不属于项目的说明}

【你要做的】
1. 用 task_read_source 读来源对话，分页读到最后一页。
2. 用 task_set_summary 写需求摘要：目标、已定结论、约束、不做、未决问题、验收要点。只写对话里说过的；没定的放进未决问题，不要替用户定。范围里限定了的，只整理范围内的。
3. 用 task_set_meta 给任务起一个简短的名字（几个字到一句话，说清做什么）。
4. 从下面四套引导词里选最合适的一套，按它拆图，用 task_propose_graph 提交（guide 填它的 id）。图被拒绝时会带原因，改了再提交。
5. 需求里说了要按时间重复做（每天几点、每周几、每隔几分钟）的，用 task_set_schedule 记下时间和地点（new_worktree：每次新建 worktree；local_readonly：在项目目录里只读地跑，图里不能有 work 节点）。这时任务是一条定时规则的模板：用户确认后保存规则，不会马上运行，之后每到时间会照这份摘要和图新建一个任务。不属于项目的对话不能定时。
6. 最后用一两句话告诉用户：选了哪套引导词、图长什么样、还有什么未决问题。不要启动任务：启动（定时规则是保存）由用户确认。
拿不准的地方用 ask_user 问用户，不要猜。

【图的规则】
节点：id 用 N1、N2……（只含字母、数字、_、-，最长 32）；kind 是 agent（模型做）或 human（用户做）。
agent 节点要有 name、job（做什么）、done（怎样算完成，逐条）、role；human 节点只有 name、job、done，没有 role、model、place。
role：explore 和 advise 只读（读代码、跑只读命令），check 能跑任意命令但不能改文件，work 能改文件，在任务自己的 worktree 里。
place：work 和 check 默认 workspace（任务的 worktree），explore 和 advise 默认 readonly；一般不用写。
边：seq 是先后顺序，不能成环；back 只能从 human 节点指回它上游的节点，表示用户可以打回到那里。
至少一个起点和一个终点；节点不超过 20 个；model、inputs 不用写，除非有理由。
实现的节点不验证自己：验证一定放进单独的 check 节点，审查放进单独的 advise 节点。
每个节点的 job 只写它自己这一步，后面节点的事不要写进去；done 要让别人能核对。
merge=true 只能放在没有后继的 human 节点上，且任务要有 worktree。

【四套引导词】
{下面四段}
</atrium-task-design>
```

### feature · Agent 特性

```
【引导词 feature · Agent 特性】适用：要加或改一个功能，会动代码，值得走完整流程。
节点顺序（按需求增减，但实现与验证一定分开）：
1. 调研（explore，place=readonly）：读相关代码和文档，列出要改的文件、要遵守的约定、风险。小需求可以省略。
2. 设计（advise，place=readonly）：需求里有看得见的界面改动、或有多个可行方案时加。给出方案和取舍，不写代码。
3. 方案确认（human）：设计节点给出多个方案、要用户选时加；它的打回边（back）指向设计节点。
4. 实现（work，place=workspace）：先写会失败的测试，再实现到测试通过。它不做最终验证。
5. 检查（check，place=workspace）：跑测试、类型检查、代码检查，必要时跑破坏检查；只读代码，不改。必须是单独的节点，不能由实现节点代做。
6. 审查（advise，place=readonly）：读 diff，对照需求逐条找问题；可以拆成几个并行的审查节点，各看一个角度。
7. 验收合并（human，merge=true）：最后一个节点，只有它能带 merge；它的打回边指向实现节点。
```

### fix · 零碎修复

```
【引导词 fix · 零碎修复】适用：一个小问题，改动范围明确，不需要设计。
节点顺序：
1. 复现（explore，place=readonly）：找到问题所在，写下复现步骤和可疑的位置。
2. 修复（work，place=workspace）：先写一个能复现问题的测试，让它先失败，再改到通过。
3. 检查（check，place=workspace）：跑相关测试和项目的检查；只读代码，不改。必须是单独的节点，不能由修复节点代做。
4. 验收合并（human，merge=true）：最后一个节点；它的打回边指向修复节点。
```

### scheduled_fix · 定时修复

```
【引导词 scheduled_fix · 定时修复】适用：每隔一段时间自动跑一遍的检查与修复，多数时候什么都没坏。
节点顺序：
1. 探查（check，place=workspace）：运行约定的检查命令，把失败的项和原因写进交接摘要；全部通过就写“无异常”。
2. 修复（work，place=workspace）：只修探查节点报告的失败；探查写了“无异常”就什么都不改，直接 node_done，摘要写“无需修复”。
3. 检查（check，place=workspace）：再跑同样的检查，确认失败项都好了；没有改动就写“无改动”。必须是单独的节点。
4. 验收合并（human，merge=true）：最后一个节点，它的 done 里写明“没有改动时点通过即可，不会合并任何东西”；它的打回边指向修复节点。
图是固定的，没有条件分支，所以没坏的那一天也会走到最后一个节点；写 done 时把这一点说清楚。
```

### research · 调研报告

```
【引导词 research · 调研报告】适用：要弄清一件事、比较方案、出一份报告，不改代码。
节点顺序：
1. 调查（explore 或 advise，place=readonly）：把问题按方面拆成几个并行的节点（如代码现状、文档、已有做法），各管一个方面，互相不依赖。
2. 汇总（advise，place=readonly）：读所有调查节点的交接摘要，写出结论、依据、没弄清的地方；报告就写在它的交接摘要里。
3. 确认（human）：用户读报告；它没有 merge，打回边指向汇总节点。
不要 work 节点和 check 节点，也不要 place=workspace：这类任务不建 worktree，不属于项目的对话也能用。
```
