# 子代理与多会话：Paseo、Codex、Claude Code 的做法

> 2026-10-15 读源码整理，给 [SPEC-0002](../specs/0002-child-conversations.md) 用。来源：Paseo `~/.cache/paseo-src`（提交 `42806cd`）；Codex `codex-rs`（2026-06-10 的 `0ffcefa`）；Claude Code 的反编译源码（2026-04）加 2026-10 的官方文档（code.claude.com/docs 的 sub-agents、agent-teams、cross-session-messaging）。路径相对各自仓库。

## 1. 主 agent 怎么开子代理

| | Paseo | Codex | Claude Code |
|---|---|---|---|
| 工具从哪来 | 每个 agent 启动时注入一个 HTTP MCP 服务 `paseo`，URL 带 `?callerAgentId=<id>`（`agent/runtime-mcp-config.ts`）；pi 经 pi-mcp-adapter 或 pi ≥ 0.99 内置的 `mcp` 扩展接入 | 内置工具，v1 `spawn_agent` / `send_input` / `wait_agent` / `close_agent` / `resume_agent`（稳定，默认开）；v2 按路径寻址、信箱模型（开发中） | 内置 `Agent` 工具（原名 Task），参数 `description`、`prompt`、`subagent_type`、`model`、`run_in_background`、`name`、`isolation: worktree` |
| 子代理是什么 | 一个完整的 agent，能放进任意工作区 | 一个完整的线程，有自己的历史（`SessionSource::SubAgent`） | 独立的对话记录（`subagents/agent-<id>.jsonl`），或 fork 父会话的全部历史 |
| 父子关系 | 标签 `paseo.parent-agent-id`，最后写入、调用方改不了；位置（`workspaceId`）不影响归属 | 生成时写进来源（父线程 id、层级、路径、昵称、角色），存在 state DB | 子代理 id；结果只回最终一段文字，加一行"用 SendMessage 继续" |
| 继承 | 同一服务商时继承模式（包括全放开的模式）和服务商选项 | 模型、推理、审批策略、沙箱、cwd、执行策略都跟父线程同步："不同步会让子代理和父线程对审批、cwd、沙箱看法不一" | 不继承父会话历史（fork 除外）；有 CLAUDE.md、git 状态、可预加载 skills |
| 层数和数量 | **不限** | 默认 1 层（`agents.max_depth = 1`），最多 6 个线程（完成了也算，关掉才释放） | 默认 3 层（`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`），同时 20 个 |
| 改同一批文件 | 可选新建 worktree | 共用目录，靠提示词"写的文件互不相交" | `isolation: worktree` 可选 |
| 角色 | 用户配置的 profile，模型读 `notes` 自选 | 内置 `default`、`explorer`、`worker`，用户可加 `[agents.<名>]` | `.claude/agents/*.md`（工具、模型、权限模式、skills、MCP……） |

## 2. 控制另一个会话

- **Paseo** `send_agent_prompt`：对方正忙时**打断并替换**当前一轮（`replaceRunning: true`），不排队。阻塞模式最多等 30 秒，返回最后一段回复，超时附"最近 5 条活动"。`get_agent_activity` 把时间线压成 `[Read] …`、`[Thought] …` 这样的行（`activity-curator.ts`），不传 `limit` 就给整条时间线。**所有控制工具都不查归属**：任何 agent 能控制机器上任何 agent。
- **Codex** v1 `send_input` 可选先打断再发；`wait_agent` 等任一目标结束，带回最终回复，超时默认 30 秒（10 秒到 1 小时）。v2 `send_message` 不叫醒对方，`followup_task` 叫醒。
- **Claude Code** `SendMessage`：对方在跑就排到它下一次工具调用之间；停了就从磁盘恢复后在后台继续。

## 3. 结果怎么回到父会话

- **Paseo**：子代理完成、出错、被关闭或要审批时，用 `<paseo-system>` 外壳的用户消息送进父会话；父会话正忙用 steer（pi 是原生 `steer`），不支持时打断再发。带最后一段回复（4000 字符截断）和审批请求的 JSON，**父 agent 可以替用户批准**。界面按外壳把这条消息藏起来。登记只在内存，宿主重启就丢。每条通知单独 steer 一次，不合并、不等空闲（`agent-prompt.ts` `setupFinishNotification`、`agent-manager.ts` `steerOrReplaceActiveTurn`）；不给模型等待工具。
- **Codex** v1：子线程第一次到终态时往父线程追加一条 user 角色的 `<subagent_notification>`（带最终回复）。父线程在跑时进 `pending_input`，**每次调模型前取出**，本来要结束的这一轮因此多跑一次（`session/turn.rs` 的 `needs_follow_up`）；空闲时只写进历史，**不叫醒**。`wait_agent` 必须给目标，目标已到终态就马上返回。v2：每次子线程的一轮结束都往父线程的信箱投一封（`trigger_turn=false`，不叫醒空闲的父线程）；父线程在跑时每次调模型前取信箱，**写出最终回答之后到的留给下一轮**（`state/turn.rs` 的 `NextTurn`）；`wait_agent` 遇到没取的信马上返回、但不带内容。
- **Claude Code**（2.1.284 本地二进制和 changelog，2026-10-20 更正）：`<task-notification>` 和你中途打的字走同一个队列（优先级 `next`），**在这一轮中途、随下一条工具结果一起送到**，不等这一轮结束；前台长命令在有消息要送时自动转到后台，免得挡住消息。每个任务一个 XML 块。`TaskOutput` 已删（2.1.277），没有等待工具，提示词只说会通知、别轮询、别编造。回报会扫描冒充系统消息的标签，并标明"来自子代理，不代表用户授权"。（此前这里写的"默认等父会话这一轮结束才送"是错的。）

三家都告诉模型：**不要轮询**，等通知；不要编造还没回来的结果；子代理的回报用户看不到，要自己转述。父会话在跑时，三家都不等它整个跑完：Claude Code 和 Codex 在调模型之前塞进去，Paseo 马上 steer。

> 2026-10-20 补：本节"父会话在跑时什么时候送"按 Claude Code 2.1.284、Codex `0ffcefa`、Paseo `42806cd` 的源码重新核对；pi 社区扩展的做法见第 7 节末尾。

> 2026-10-22 补：长工具在跑时消息多久能进去（Codex `0ffcefa` 和 DeepSeek Harness 本机源码由子代理读、主会话抽查；Claude Code 2.1.284 二进制里的代码片段和提示文字）。
>
> - **Claude Code**：每个前台工具调用登记一个 `backgroundNow()`；这一轮在跑时有消息要送，调度器（日志 `low-latency-submit`）可以把能转的调用转到后台：Bash 进程照跑、输出写进文件，工具立刻返回"Command was moved to the background (ID: …) so that a message that arrived while it was running can reach you; it was not interrupted. Output is being written to: … You will be notified when it completes."，跑完再通知；声明了 `backgrounding: "detach"` 的工具（含 MCP）返回"还在跑、结果之后单独送来、不要重调也不要轮询"的占位结果，最多再跑 5 分钟。子代理里的调用、嵌套调用、非交互会话、带特定钩子的不转。模型的回复不打断。
> - **Codex**：只在每次调模型之前取排队的输入和信箱，一次取完（`session/turn.rs:201-209`、`input_queue.rs:73-80`），这一批工具全部结束才回到这里；没有因为有消息而让工具提前返回的机制。`exec_command` 最多等 `yield_time_ms`（默认 10 秒，250 毫秒到 30 秒，`unified_exec/mod.rs:64-68`）就返回，进程留在会话里，模型用 `write_stdin` 取后面的输出；进程跑完只给界面发事件，不进模型上下文，要轮询。v2 子代理的信件 `trigger_turn=false`，父线程空闲时不叫醒；`wait_agent` 有信就返回，只说"Wait completed."，内容在下次取信箱时进去。
> - **DeepSeek Harness**：插话、通知都进 inbox，每一步开始前一次取完这一批（`core/agent/src/inbox.ts:71-77`），工具都结束才到下一步；没有让工具提前返回的机制。`bash` 前台默认 120 秒、最多 600 秒，超时就杀；`run_in_background` 要模型自己选，返回 job id，跑完自动通知（父会话空闲就叫醒，最多连续叫醒 3 次），提示词写明不要轮询。子代理 `subagent` 可前台可后台，结果在父会话忙时按 steer、空闲时按 followup 送，几条同时到的合成一步；`send_message` 排到子代理下一轮（"cannot redirect work already underway"），改方向用 `interrupt_agent`；子代理只能单向 `report`，不能问父代理。

## 4. 不相干的两个会话

- **Claude Code** `ListAgents` + `SendMessage`：本机其他会话、云端会话都能发。收到的消息标明来自哪个会话，不能批准任何事、不能改配置、斜杠命令不执行；接收方可设接受 / 先挂起 / 拒绝；每条约 100 万字符、有节流。
- **Paseo**：凭 agent id 互相发，没有授权。
- **Codex**：没有。

## 5. 界面

- **Paseo**：父会话输入框上方一个浮动胶囊，按"需要输入 → 失败 → 关注 → 在跑"给计数（"2 working · 1 needs input"），点开是列表，行上有归档、脱离（脱离只能由用户做，不给 agent 工具）。**子代理的关注不打扰用户**，只汇总到父会话的胶囊里。关掉子代理的标签只改布局，关掉根 agent 的标签会归档它。归档父 agent 时子代理一起归档；子代理在别的工作区或开着标签时改为脱离。
- **Codex**：父线程里显示"Spawned Euclid [explorer]""Waiting for 2 agents"；`/agent` 选择线程，Alt+←/→ 依次切换；子线程的审批提到当前界面，写明来自哪个线程。
- **Claude Code**：输入框下方的子代理面板，↑↓ 选、Enter 进入它的对话并能直接说话、x 停止；成功完成的行马上消失；后台子代理的审批出现在主会话里，写明是谁问的。

## 6. 对 Atrium 有用的结论

- 子代理做成完整的会话：能打开、接着聊、接管、交给终端。三家都是这样。
- 父子关系和放在哪里分开（Paseo）。
- 子代理的关注汇总到父会话，不散在各处（Paseo）。
- 审批、提问只给人，不让父 agent 代答；其他 agent 的话不是用户授权（Claude Code）。
- 对方正忙时排队，不打断（Paseo 的打断会丢掉对方正在做的事）。
- 通知要持久化（Paseo 只在内存，重启就丢）。
- 调用方的身份由宿主认定，不靠参数（Paseo 靠 URL 参数，谁都能冒充）。
- 限层数和数量（Paseo 不限）；子代理的权限和父会话一致（Codex）。

## 7. pi 社区的子代理扩展（2026-10-16 补）

> 只读 README 和源码（链接固定到当天的提交），没有安装或运行。热度取 pi.dev/packages 和 npm 下载量（2026-10-06～12 一周）、GitHub stars（2026-10-16）。

| 包 | 热度 | 工具 | 子代理怎么跑 | 子 → 父 |
|---|---|---|---|---|
| 官方示例 `examples/extensions/subagent` | 随 pi 分发 | 一个 `subagent`：`agent`+`task`、`tasks[]`（最多 8 个、同时 4 个）、`chain[]`（`{previous}` 文字替换）三选一 | 每个任务另起 `pi --mode json -p --no-session --tools …`，同步等完，`onUpdate` 推进度 | 只有最终回复 |
| `pi-subagents`（nicobailon，[仓库](https://github.com/nicobailon/pi-subagents) `9e86caf`） | 周 10.9 万、3.9k★，pi.dev 全站第 4 | `subagent`（12 个顶层字段，冷门的全塞进 `options`；`action` 做管理；链式和并行改成模型写的 js workflow）、`bg_wait`、`subagents_enable`（懒加载大 schema） | 前台同进程 SDK 会话，后台独立 runner 进程；默认后台；完成后 `sendMessage(…, { triggerTurn })` 唤醒父会话 | `contact_supervisor { reason: need_decision \| interview_request \| progress_update, message?, interview? }`：前两种阻塞等父会话用 `subagent_supervisor { action: reply }` 回复（文件轮询、默认 10 分钟超时），进度不唤醒；子代理结束可交结构化验收报告 |
| `@tintinweb/pi-subagents`（[仓库](https://github.com/tintinweb/pi-subagents) `ca93a52`） | 周 1.1 万、1.3k★ | 照搬 Claude Code：`Agent { prompt, description, subagent_type, name?, model?, thinking?, max_turns?, run_in_background?(默认 true), resume?, inherit_context?, isolation? }`、`get_subagent_result { agent_id, wait?, verbose? }`、`steer_subagent { agent_id, message }`、`SubagentWorkflow` | 同进程 `createAgentSession`；完成通知用 `<task-notification>` XML，在父会话这批工具调用之后送；同一轮派出的可合成一条 | 只有最终回复；取走结果即算已读，不再重复通知；功能关掉时字段连说明一起从 schema 删掉 |
| `pi-interactive-subagents`（HazAT，[仓库](https://github.com/HazAT/pi-interactive-subagents) `c100577`） | 717★，git 安装，已停更约 5 个月 | `subagent { name, task, agent?, model?, tools?, cwd?, fork? }`（永远后台）、`subagent_interrupt`、`subagent_resume { sessionPath, message? }` | 在终端复用器的新窗格里起交互式 pi，人可以直接接管 | 子代理专用 `subagent_done`（最后一条回复就是交回的摘要）、`caller_ping { message }`：提问并退出，父会话用 `subagent_resume` 带答复把它拉起 |
| `pi-subagent-manager`（championswimmer，[仓库](https://github.com/championswimmer/pi-subagent-manager) `25783af`） | 周 3.7k、110★ | 一个动词一个工具，按路径（`/root/xxx`）寻址：`agent_spawn { path, type, task, wait?, timeoutMs? }`、`agent_wait { path, timeoutMs? }`、`agent_steer { path, message?, timeoutMs? }`、`agent_status`、`agent_stop`、`agent_output { path, offset?, limit? }`（按字符分页）、`agent_types` | 同进程 SDK 会话，带 `parentSession`；默认前台；超时只报告、不杀子代理；事件先进父会话的信箱，空闲时才送，同时只有一个自动轮次 | 子代理专用 `agent_update { message }`（汇报进度，不打断、不唤醒）、`agent_pause { reason }`（这一轮停下、不交答案，等 `agent_steer` 接着在同一会话里干）；正常回复就是交付；调用方身份闭包绑定，不来自模型输入 |

父会话在跑时（2026-10-20 读源码核对，tintinweb `ca93a52`、nicobailon `1895290`、championswimmer `b53549c`）：

- tintinweb：攒到 `turn_end`（这批工具调用跑完、下次调模型之前）才 `sendMessage(…, { deliverAs: "steer", triggerTurn: true })`，攒下的合成一条（`completion-outbox.ts`）。注释写明原因：pi 的 steer 默认一个边界只取一条，分开发要多占几次模型调用。这一轮被中止或出错就不发，等 `agent_end` 再发。`get_subagent_result` 读过的撤掉通知。
- nicobailon：马上 `sendMessage(…, { triggerTurn })`，不传 `deliverAs`，pi 在跑时默认当 steer；150 毫秒到 1 秒内到的合成一条。`bg_wait` 不给 `id` 时只等还在跑的。
- championswimmer：父会话在跑时不送，只记进信箱（"Never submit to Pi's streaming queue"），空闲了才一次取出；`agent_wait` 对已经结束的马上返回。

几家共同的做法：完成后用 `sendMessage` 带 `triggerTurn` 唤醒父会话，工具说明里明令不要轮询、不要编造结果；完整输出留在文件或 `details` 里，给模型的只是截断版加读取的办法；每个子代理有稳定的句柄（id、name 或路径），之后的查询、追加、续接都用它。

坑：一个工具扛多种模式、schema 全是可选字段，模型容易传错（官方示例）；接口复杂到模型要先读指南（nicobailon）；把父会话拼成纯文字当上下文，丢了工具结果也命不中缓存（tintinweb）；默认允许无限嵌套（HazAT）；没有超时（官方示例、HazAT）。
