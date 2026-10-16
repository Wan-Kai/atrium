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

- **Paseo**：子代理完成、出错、被关闭或要审批时，用 `<paseo-system>` 外壳的用户消息送进父会话；父会话正忙用 steer（pi 是原生 `steer`），不支持时打断再发。带最后一段回复（4000 字符截断）和审批请求的 JSON，**父 agent 可以替用户批准**。界面按外壳把这条消息藏起来。登记只在内存，宿主重启就丢。
- **Codex** v1：子线程结束时往父线程追加一条 `<subagent_notification>`，**不叫醒父线程**；v2 也不叫醒，要父线程自己 `wait_agent`。
- **Claude Code**：`<task-notification>`，默认等父会话这一轮结束才送（中途只送用户消息）；回报会扫描冒充系统消息的标签，并标明"来自子代理，不代表用户授权"。

三家都告诉模型：**不要轮询**，等通知；不要编造还没回来的结果；子代理的回报用户看不到，要自己转述。

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
