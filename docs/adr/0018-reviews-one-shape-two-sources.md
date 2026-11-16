# ADR-0018：审核用一个形状，分"宿主关卡"和"agent 请求"两种来源

- **状态**：已接受（2026-11-06 用户同意）
- **日期**：2026-11-06
- **相关**：[SPEC-0006](../specs/0006-tasks-and-task-graph.md)"界面 › 审核卡片"、[SPEC-0003](../specs/0003-agent-asks-user.md)（提问卡片）、[ADR-0013](0013-agent-channel-status-and-hidden-command.md)（扩展与宿主的通道）、[pi-internals](../research/pi-internals.md)（`custom_message` 进上下文）、[security.md](../architecture/security.md)

## 背景

任务里有四处要你下裁决：批准改图、human 节点的通过 / 打回、合并被挡住后重试、归档提问。2026-11-06 用户定：它们都做成输入框上方的同一张"审核"卡片，和提问卡片共用外壳；以后普通对话里 agent 在推送、提交这类动作前也用它请你看。

这几处的来源本质不同：

- **任务的四处是宿主的流程写死的关卡**。要不要审核、审什么、裁决之后做什么，都由宿主的代码决定（调度器的状态），不经模型；状态落在 `task.json` / `events.jsonl`，宿主重启后还在。
- **普通对话里的审核是 agent 在对话里发起的**：模型在一轮中途调一个工具，等你的裁决，裁决作为工具结果交回模型，同 `ask_user`。它活在这次工具调用里，pi 退出就没了；审什么、说什么都是模型写的。

用户要求：技术上要通用，但不能把两种来源混成一种——"agent 的审核是对话式的，系统审核是工具硬编码上的（虽然最终也会体现在对话里）"。

## 决策

1. **一个协议形状，挂在会话上**。审核卡片显示在某个会话的输入框上方（任务的审核挂在任务对话上），所以待审核的东西放进这个会话的控制状态：`Control.reviews: PendingReview[]`，和 `Control.question` 并列；界面把两者按出现先后合成胶囊（SPEC-0006"几张同时在"）。作答统一走一个命令 `answer_review(sessionId, reviewId, verdict)`。

   ```ts
   PendingReview = {
     id; openedAt;
     source: { kind: "gate"; gate: GateKind }        // 宿主关卡：task_graph | task_human | task_archive | 以后的固定关卡
           | { kind: "agent"; toolCallId };           // agent 请求（以后的 request_review）
     subject: { code; params } | { text };            // 关卡发代码和参数，界面写字；agent 的是模型写的原文
     evidence: Evidence[];                            // facts | changes | graph_diff | summary（| preview，以后）
     problem: { code; params; files? } | null;        // 上次执行没成功：如 merge_blocked 的原因
     actions: Action[];                               // { id, reason: none|optional|required, targets?, remaining?, recommended }
   }
   Verdict = { action; target?; reason? }
   ```

2. **宿主里一个 ReviewHub，来源各自实现 provider**。Hub 只做通用的事：按会话汇总各 provider 的待审核、推 `control_updated`、校验裁决的形状（动作存在、必填的原因有、目标在列表里）、同一审核只认第一个裁决（其余应答 `review_closed`），然后把裁决交给那个 provider。provider 决定其余一切：

   | | 宿主关卡（gate provider） | agent 请求（agent provider，以后） |
   |---|---|---|
   | 待审核从哪来 | 从宿主的持久状态**算出来**，不另存：任务 provider 看调度器状态（`waiting(human)`、`merge_blocked`、`pendingGraph`、`Task.archive = asked`） | 扩展经 ADR-0013 的通道发 `call`（`op: "request_review"`），宿主放进控制状态 |
   | 寿命 | 跟着持久状态：宿主重启后重新算出来，卡片还在 | 跟着工具调用：pi 退出、宿主重启就作废，同 `ask_user` |
   | 裁决交给谁 | provider 调对应的业务命令（任务：`answer_human` / `approve_graph` / `reject_graph` / `answer_archive`），由宿主**执行**；你不通过，动作就不发生 | 宿主用隐藏命令 `reply` 交回扩展，成为工具结果交给模型；宿主**不强制**，模型照不照做是模型的事 |
   | 证据 | 宿主现算：git 状态、改动统计、图的差异，可以带好 / 注意 / 危险的状态 | 模型写的标题和摘要只当引用（`summary`，标"agent 说"），**不能**出现在 `facts` 里、不带状态；改动统计仍由宿主按会话目录现算，不用模型报的数 |
   | 输入框发消息 | 照常发给这个会话（任务对话），审核不动 | 代替裁决（"直接回复"，同 SPEC-0003），先插话再 `reply` |
   | 对话里的记录 | 裁决生效后宿主写一条 `custom_message`（`customType: "atrium-review"`，`display: true`，`triggerTurn: false`，`details` 存当时的证据快照）：界面画成过程轨道上的一步，模型下一次请求能看到（`custom_message` 进上下文） | 就是那次工具调用和结果（`details` 存裁决和证据快照），界面画成过程轨道上的一步，同 `ask_user` |

   这一行"对话里的记录"就是"系统审核最终也体现在对话里"：两种来源在记录里长得一样，但关卡的记录是宿主写的事后通知，agent 的记录是对话本身的一部分。

3. **任务的业务命令保留**。`answer_human`、`approve_graph`、`answer_archive` 等仍是宿主的 API：任务列表的行内处理、`pnpm task:try` 直接调它们；`answer_review` 只是卡片的统一入口，经任务 provider 转过去，两条路做同一件事、同一套状态检查。

4. **文字**：关卡的 `subject`、`facts`、`problem`、按钮全是代码加参数，界面按种类写字（宿主不产出给人看的文字）；agent 来源的文字是模型的原文，按 SPEC-0003 预览的规则原样显示、限长、转义，不当网页内容插进页面。

5. **手机**：任务关卡的 `answer_review` 照 T5 的规则是 `local_only`；agent 请求在手机上能不能答，随它的 SPEC 定（`ask_user` 现在手机能答）。

6. **分步做**：T7/T8 做协议形状、ReviewHub、任务 provider 和界面组件；agent provider、`request_review` 工具和"某个工具执行前要审核"的固定关卡另开 SPEC，任务做完后做。做的时候只加 provider，不动协议形状和组件。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| 甲（选定）：一个形状，Hub + 两种 provider | 界面一个组件；以后加来源只加 provider；可信度和执行方在 provider 里分开 | 多一层 Hub；任务的状态要再投影一次成 `PendingReview` |
| 乙：任务的卡片直接读 `task_updated` 里的 `TaskView` 自己画，以后 agent 审核另做 | 现在少写一层 | 两套卡片逻辑；普通对话要用时重做；SPEC-0006 定的"通用"落空 |
| 丙：把审核做成 `ask_user` 的一种题型（选项 = 通过 / 打回） | 复用最多 | 提问的答案只是信息，表达不了"宿主执行"和"证据由宿主算"；关卡不在工具调用里，没有 pi 那一端可回 |
| 丁：关卡也走工具调用（宿主让任务对话的模型调一个审核工具来"发起"） | 两种来源都在对话里、形状完全一样 | 关卡的发起依赖模型听话，宿主重启后工具调用作废、关卡丢失；正是用户说的不该混的那种 |

## 后果

- 正面：任务的四处卡片和以后普通对话的审核是同一个组件、同一个命令；关卡的裁决一定由宿主执行，模型绕不过；agent 写的话不会冒充宿主的事实。
- 负面 / 代价：控制状态多一个字段，协议号加一；任务 provider 要在调度器每次变化后重算待审核；关卡的记录是宿主事后写进会话文件的 `custom_message`，会话文件不再全是模型和你写的。
- 什么情况下应重新评估：出现第三种来源（比如别的用户、别的设备发起的审核）；或者关卡要在没有会话的地方显示（目前都挂在某个会话上，任务列表的行内处理直接调业务命令）。
