# 任务看板与图状态机（Agent Task Board & Graph State Machine）调研

> 2026-10-28 整理（结合 X 社区讨论与 `deepseek/deepseek-flash` 子代理对 20+ 编码/后台 Agent 平台的文档与实现调研）。

## 背景与核心问题

在 Atrium 中管理**定时任务（Cron / Routines）**、**零碎任务（Ad-hoc Tasks）**与**复杂 Agent 任务**时，传统 Trello/Jira 式的扁平看板（`Todo → In Progress → Review → Done`）存在明显缺陷：

1. **控制权频繁往返**：Agent 任务不是单向流水线，而是人机交替拍板（初始计划/图确认、设计原型选择、运行中改图确认、最终代码验收）。
2. **内部拓扑是有向图 + 状态机**：一个任务往往包含多阶段节点（调研、设计、实现、并行三方审查、验收）以及验证失败时的回退边（Rollback）。
3. **动态改图需要人工确认**：运行过程中若 Agent 发现原定图结构走不通（需新增节点、拆分节点或改变依赖边），不能黑盒自改，必须向用户展示改图变更并经确认后才继续。

## 用户确认的核心设计原则（2026-10-28 定）

1. **所有任务先进入「待我介入」环节**：下发任务后（或生成初始执行图后），统一先放入独立的「待我介入」操作区，由用户确认后再正式进入后续运转。
2. **列表极简，点开再看详情与图**：任务列表不强行塞入微缩拓扑图，只清晰展示三项核心信息：**当前在哪个节点**、**运行了多久**、**是否被阻塞（及阻塞原因）**；点击任务后再展开完整的有向图、节点状态机与门禁详情。
3. **待我介入有独立操作区**：集中处理初始图确认、设计拍板、运行中改图确认（Graph Diff Gate）与最终验收。
4. **运行中图结构变化必须找用户确认**：同节点内的正常状态流转自动推进；一旦涉及新增/删除/拆分节点或修改边，挂起并请求用户确认。

---

## 一、业界平台对比

### 1. 待我介入的独立操作区（Needs You / Triage / Attention）

| 平台 | 抽取方式 | 卡片上下文 | 快捷动作 |
|---|---|---|---|
| **Komodor Attention** | 独立 Operator Inbox，按决策类型拆成 `Awaiting approval` / `Awaiting selection` / `Needs attention` | 被守门规则拦下的动作、待选分支、停下的 run；决定可附 note 写进证据链 | Approve / Refuse / 选分支 / 打开调查 |
| **Linear Agents** | Agent Session 状态 `awaitingInput`；`elicitation` activity | 问题正文 + 会话上下文；新委派默认留在 Triage 等人确认 | 直接回复或选建议项；30 分钟无响应标 stale |
| **OpenAI Codex App** | 侧栏 **Triage** 收件箱 | 自动化（Automations）运行发现的问题或待审改动 | 打开、归档；无异常发现时自动归档 |
| **Devin** | 侧栏通知 + Slack 建议答案按钮 | 当前卡点、建议选项、`Wait for my approval` 开关 | 点选即答；支持改计划后继续 |
| **Plannotator（pi 扩展）** | 独立计划审阅面板 | 计划全文、行级 Diff（绿增/红删/黄改）、版本浏览器 | Approve / Send Feedback / Approve with notes；审阅期间不占着进程 |

### 2. 下发任务与定时触发（Dispatch & Routines）

- **初始确认门禁**：Devin、Factory Missions、Jules、Claude Code Plan Mode、Manus 均采用“下发目标 → 产出初始计划/阶段图 → 进待确认区等人拍板 → 正式执行”的二段式流程。
- **定时任务（Cron / Subscriptions）**：
  - **Codex Automations**：配置 Cron 与工作区策略（本地或新 worktree），每次触发生成独立运行；无异常静默归档，有产出或异常推入 Triage（待我介入）。
  - **Paseo Schedules**：宿主持有 `ScheduleStore`（`~/.paseo/schedules/<id>.json`），支持发往已有会话或每次新建会话（支持 `archiveOnFinish`）。

### 3. 图 + 状态机运转（Graph + State Machine）

- **三层状态模型**：
  1. **任务级状态**：处于「待我介入」、「运转中」或「已完成/归档」。
  2. **图与版本（`graphVersion`）**：由节点（Node）和有向边（顺序边、并行 Fan-out/Join 边、失败回退 Rollback 边）组成。
  3. **节点级状态机**：`pending`（待上游） → `running`（运行中，计耗时） → `blocked_on_human`（阻塞等人工确认） / `passed`（通过） / `failed`（失败触发回退或升级）。
- **节点与 Atrium 原语的映射**：图中的节点天然对应主会话的一个阶段，或 `agent_spawn` 派出的后台子对话（`explore` / `work` / `advise`）。

### 4. 运行中动态改图确认（Dynamic Graph Mutation Gate）

- **现状**：LangGraph 支持 `interrupt(payload)` 挂起等待人工 `Command(resume=...)`，Plannotator 支持计划修订的行级 Diff 审批并要求“实质变化后旧批准作废，绑定新版本重新审批”，Conductor 实验项目采用 `plan-hash` 绑定批准。
- **Atrium 的图变更门禁设计**：
  - **触发条件**：仅对**结构性变更**（新增/删除/拆分节点、改依赖边、改验收标准）触发门禁拦截；节点内部正常状态更新不打扰用户。
  - **呈现方式**：在「待我介入」区高亮标识“申请改图”，点开详情后在有向图上对比展示原节点与拟新增/修改节点（`+ 新增` / `~ 拆分` / `- 移除`），以及 Agent 给出的改图原因。
  - **版本绑定**：用户点击「批准改图」后，`graphVersion` 递增（如 `v1 → v2`），状态机按新拓扑继续流转；点击「拒绝（按原图跑）」则丢弃提案并可附带一句指导说明。
