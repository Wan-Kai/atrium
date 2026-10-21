# pi 内部机制（实现参考）

> 基于 pi 1.0.1，提交 [`4c6fb7c`](https://github.com/earendil-works/pi/commit/4c6fb7cfe8c538a668726f6f8b3554098c39faee)，2026-10 读源码整理。路径相对 `packages/coding-agent/`，另有注明的除外。pi 迭代很快，实现前先确认版本；对不上时以源码为准。
>
> 本地源码：`~/.cache/pi-src`（`git clone --depth 1 https://github.com/earendil-works/pi`）。

**版本**：本机 pi 2026-10-08 升到 1.1.0。和 1.0.2 相比，Atrium 依赖的 `prompt`、`steer`、`abort`、`clear_queue`、`queue_update`、RPC 模式本身逐字相同（2026-10-09 对照两版的 `agent-session.js`、`rpc-mode.js`）；输出多了两个字段：`agent_settled` 带 `aborted`（这次运行是否被停止），工具结果的消息、条目和 `tool_execution_end` 带 `durationMs`（工具执行时长）。契约测试在 1.1.0 上全部通过，夹具见 testing.md"pi 夹具"。

Atrium 用的是 pi 的**稳定模型**：`pi --mode rpc` + JSONL 会话文件。pi 仓库里另有一套实验性的多客户端服务端（第 6 节），存储不兼容，不直接用，只借鉴设计。

## 1. 会话文件（`src/core/session-manager.ts`）

**位置与 id**

- 路径：`~/.pi/agent/sessions/--<cwd，去掉开头分隔符，/ \ : 换成 ->--/<ISO 时间，: 和 . 换成 ->_<sessionId>.jsonl`。可用 `--session-dir`、`PI_CODING_AGENT_SESSION_DIR` 或设置 `sessionDir` 覆盖。
- 会话 id：`uuidv7()`，或 `--session-id` 指定（`/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/`）。
- **延迟写盘**：直到内存里出现 user 或 assistant 消息才用 `openSync(path, "wx")` 创建文件，之后每条 `appendFileSync`。写盘在 `AgentSession._handleAgentEvent` 里紧跟着把 `message_end` 发给监听者（RPC 模式由此输出事件行），同一个同步段里完成，所以宿主读到用户消息的 `message_end` 时文件已经在了（1.0.2 `agent-session.js`，2026-10-10 核实）。所以 `get_state.sessionFile` 可能指向还不存在的文件；打开就关的会话不留文件；未写盘的会话不能 fork / clone。
- `--no-session` 用内存会话，不写盘（适合标题生成这类一次性调用）。

**文件头**（第一行，不在树里）

```ts
interface SessionHeader { type: "session"; version?: number; id: string; timestamp: string; cwd: string; parentSession?: string }
// CURRENT_SESSION_VERSION = 3；v1/v2 读入时迁移并重写文件
```

- `cwd`：恢复时用它作为工作目录；目录不存在抛 `MissingSessionCwdError`（`src/core/session-cwd.ts`）。
- `parentSession`：fork / clone 来源文件的绝对路径。

**条目**

```ts
interface SessionEntryBase { type: string; id: string; parentId: string | null; timestamp: string }
```

- 条目 id 是 8 位十六进制（`randomUUID().slice(0,8)`），**只在单个文件内唯一**；clone 出的新文件沿用原 id。跨会话要用"会话 id + 条目 id"。
- 类型：`message`（role：system / user / assistant / toolResult / bashExecution / custom）、`thinking_level_change`、`model_change`、`usage`、`compaction`（`summary`、`firstKeptEntryId`、`tokensBefore`、`systemMessage?` 完整检查点）、`branch_summary`、`custom`（extension 状态，不进上下文）、`custom_message`（进上下文）、`context_edit`（`targetId` + 替换或省略）、`label`、`session_info`（`name`，最新的一条生效）。
- 系统消息：role 为 system 的 message，带 `sections`（按名字的补丁）、`toolsAdded` / `toolsRemoved`；第一次请求写完整的，之后写增量。上下文分段估算就靠回放这些。
- assistant 消息带 `provider`、`model`、`usage`、`stopReason`（stop / length / toolUse / error / aborted / deferred）、`thinkingLevel?`。

**树与叶子**

- 每次追加都挂在当前 `leafId` 下并移动叶子。`branch(id)` 移叶子；`branchWithSummary` 移叶子并追加 `branch_summary`；`resetLeaf()` 让下一条成为新的根。
- **叶子不存盘**：加载时取文件最后一条为叶子。
- 上下文构建：`buildContextEntries`（路径 + 最近的压缩）→ `buildSessionProjection`（应用 context_edit）→ `buildSessionContext`。这就是 `get_messages` 返回的东西，**不是完整历史**。
- 列表：`SessionManager.list / listAll` 返回 `SessionInfo {path, id, cwd, name?, parentSessionPath?, created, modified, messageCount, firstMessage}`，但**不是 RPC 命令**，宿主要自己扫目录。`listAll` 列会话文件夹时目录和符号链接都算（`entry.isDirectory() || entry.isSymbolicLink()`，1.0.2 源码）。

**fork / clone**（`src/core/agent-session-runtime.ts`）

- RPC `fork {entryId}`：必须是 user 消息，新文件包含到它的父条目为止，返回该消息文本。`clone`：复制整条当前路径。新会话 id、新文件，`parentSession` 指向原文件。
  - 应答：`fork` 是 `{text, cancelled}`，`clone` 是 `{cancelled}`；extension 在 `session_before_fork` 里取消时 `cancelled: true`，不换会话。RPC 的 `fork` 没有 `position`，固定从这条消息之前截断，所以复制到最后一条只能用 `clone`（它内部是 `position: "at"` 的 fork）。
  - 新文件写在原会话的会话目录里，有对话就立刻写盘；条目 id 不变（label 重新生成），原文件不动（契约 `fork-clone`，pi 1.1.0，2026-10-13 核实）。
- 所有"换会话"操作（new / switch / fork / import）都会拆掉当前运行时重建，**RPC 不发任何"会话已切换"事件**，要重新 `get_state`。Atrium 因此一个会话固定一个进程，不用 `switch_session`。
- **新会话的 `cwd`**（2026-10-16 读仓库依赖的 1.0.2，SPEC-0002 用）：RPC `fork` / `clone` 重新读源文件头的 `cwd` 写进新文件头，没有参数能换目录。CLI `pi --fork <文件>`（`SessionManager.forkFrom`）以 pi 进程所在目录为新文件头的 `cwd`，复制源文件的全部条目（含废弃分支），不能选分叉点；不能和 `--session`、`-c`、`-r`、`--no-session` 同用。`--session <文件>` 用文件头的 `cwd`，pi 不 `chdir`；文件头的目录不存在时 RPC 模式退出。`--session` 给 id 而会话在别的项目时会在 stdin 上问要不要分叉过来，会卡住 RPC，所以总给路径。`--fork` 写的新文件头 `parentSession` 是源文件的路径；`--session-dir` 决定 RPC `fork` / `clone` 把新文件写到哪（SPEC-0002 用它把中间文件放进宿主的临时目录）；`--fork` 可以和 `--session-id` 同用，id 由调用方先定。

**同会话导航与停止消息编辑**（2026-10-20，本机 pi 1.3.0）

- RPC 没有 `navigate_tree` 或 `replace_message` 写命令；扩展命令上下文的 `ctx.navigateTree(id, { summarize: false })` 在 RPC 下可用（`dist/modes/rpc/rpc-mode.js:233–248`）。导航 user 会将叶子移到其 parent，旧分支留在原文件；无摘要导航不调用摘要模型，废弃的误发文字也不会通过摘要带进新上下文。
- `AgentSession.navigateTree` 先检查 target 是否就是当前 leaf，命中时直接 no-op，再处理 user → parent（`dist/core/agent-session.js:3232–3243,3338–3344`）。所以“发出就停止、user 自身还是 leaf”不能直接导航该 user。Atrium 扩展先追加不进模型上下文的 custom anchor，再导航 user；失败恢复导航非 user 的 anchor，并追加 custom restored 条目使恢复分支落盘。根 user 的 parent 可以为 null，契约覆盖。
- 仅导航只改内存，重开文件仍选文件末条目；新 user 或恢复 marker 的追加才固定重启后的分支。导航取消 / 命令 handler 抛错仍可能收到 `handled`，须核对实际 leaf，不把命令应答当成功。
- **写盘失败的区别**：1.3.0 `SessionManager._appendEntry` 先改 fileEntries、byId 和 leaf，再同步 appendFileSync。ENOSPC / EIO 可留下“内存里有、文件里没有”的条目；`message_end` 回显和 `get_entries` 也不是独立的持久化证明。Atrium 编辑事务从 pi 实际 sessionFile 读文件，确认所有内存 id 都已在文件中；不一致立即停 pi，避免后继引用不存在的父条目。`prompt` 的 started 是 preflight 成功，不等同 user 已落盘；编辑成功还要确认磁盘新路径有 fresh user 且排除原 user。这里保证普通进程重启语义，不声称 pi 具备 fsync / 掉电事务。
- 契约 `packages/pi/src/contract/edit.pi.test.ts` 的 `edit-aborted`、`edit-root-restore`、`edit-image-only`、`edit-cancel`、`edit-navigation-error` 在真实 pi + faux 验证：aborted 尾、user 即 leaf、null parent、纯图片、旧分支从新模型上下文排除、原图保留、取消与异常、恢复与新提交分支的重启落点。五份夹具仅录到 `pi-1.3.0/`，其余旧场景尚缺 1.3.0 夹具，不将全量 `test:pi` 记为通过。宿主的仅内存条目故障用独立磁盘边界回归覆盖，没有声称真实打满磁盘做过 ENOSPC 实验。
- **审查后的恢复确认**（2026-10-21）：回退 / 恢复都会让宿主换 epoch，所以失败后不能原样重试旧目标。只在同一最后 stopped 目标已恢复且 pi 仍活着时，用该次错误应答给出新的精确 epoch；pi 已停止则重新 attach 又会换 epoch，只提示复制后重开，不把旧确认当作可直接重试。恢复中 get_entries / 再次文件读取失败也应停止并发布最近成功读过的磁盘页，没有证明时不发布虚构页。
- **后改思考档位的分支边界，本版保留原生行为**（2026-10-21，仅源码核对，未新增专项真实重开契约）：1.3.0 `AgentSession.setThinkingLevel` 只在运行时档位变化时追加 `thinking_level_change`；`navigateTree` 只刷新消息投影与工具，当前运行时档位不随之变回旧值。`_recordSelection` 补写的是模型选择，不是思考档位。因此停止后改的档位若位于旧 user 后面，编辑重分支可能留下更早的 thinking 记录；新一轮仍用当前运行时档位，但 `createAgentSession`（`dist/core/sdk.js`）重开时优先取新分支 thinking 记录，没有记录才用默认值。用户已选择 A：本版将此作为已知限制记录后合并，不额外适配保留后改档位，也不把原生行为默默改成另一种设置策略；需要时在重开后重新选择。

## 2. 运行时（`src/core/agent-session.ts`，`packages/agent/src/agent.ts`）

**turn 与 run**

- pi 的 turn = 一次助手响应 + 它的工具调用：`turn_start … turn_end`。
- 底层 run：`agent_start … agent_end {messages, willRetry}`。
- 会话级运行：一次 prompt 可能产生多组 `agent_start / agent_end`（重试、压缩、排队消息），**恰好一次 `agent_settled`**。用 `agent_settled` 判断"不会再自动继续"；整个过程 `isStreaming` 为真。

**`prompt` 的三种结果**（`PromptDisposition`）

1. extension 的 `/命令` 立即执行（运行中也可以）→ `handled`
2. 正在压缩 → **抛错**（RPC 返回 error）
3. `input` 处理器消费了输入 → `handled`
4. 运行中：必须带 `streamingBehavior`（steer / followUp），进入 pi 的队列 → `queued`；不带就**抛错**："Agent is already processing. Specify streamingBehavior…"（1.0.2 `agent-session.js`）。压缩中的错误文字是 "Cannot submit a prompt while compaction is in progress…"。宿主按这两段文字的开头认出"忙"（`packages/pi/src/process/rejections.ts`），回 `session_busy`。
5. 否则校验模型和认证，必要时先压缩，触发 `before_agent_start` → `started`

RPC 在预检完成时就返回结果，不等运行结束；预检可能包括自动压缩，所以宿主的 `prompt` 请求不设期限。`steer` / `follow_up` 返回 `handled | queued`，不接受 extension 命令。

**队列**

- steer：当前这批工具调用执行完、下次请求模型之前送达；followUp：agent 本要停下时才送达。模式 `all | one-at-a-time`，默认后者。
- 写进会话文件的插话、追加消息和普通提问一样，都是 `{role: "user", content, timestamp}`，没有标记（1.0.2 `agent-session.js` `_queueSteer`），文件里分不出来。
- 一次运行可能停在工具结果上：一批工具调用都返回 `terminate` 时，agent 循环不再请求模型（`agent-loop.js` `shouldTerminateToolBatch`）。
- 上下文溢出：pi 用 `context_edit`（`replacement` 为空）屏蔽失败的回复和它的工具结果，紧接着写压缩条目，再重试；不发 `auto_retry_start`（`agent-session.js` `_omitRecoveryAttempt`）。可重试错误的 `auto_retry_start.errorMessage` 是 `errorMessage || "Unknown error"`。
- `queue_update {steering, followUp}` **每次带完整队列**；`clear_queue` 清空并返回两队内容。
- 队列里是**展开后的文字**：`steer` 先过 extension 的输入处理（异步，并发的 `steer` 可能因此换了进队顺序），再展开 skill 和提示词模板，然后才进队（1.0.2 `agent-session.js` 的 `_queueUserInput`）。送达时按 `message_start` 的文字在 `_steeringMessages` 里找并移走；**文字为空（只有图片）时不找**，这一项永远留在队列里，之后每次 `queue_update` 和 `clear_queue` 都还有它（1.0.2、1.1.0，2026-10-10 核实）。每次增删各发一次 `queue_update`，不会合并；`steer` 先把文字放进队列、发出 `queue_update`，然后才应答（1.0.2 `_queueSteer`，2026-10-10 核实），所以宿主收到应答时，这条插话一定已经列出过。
- pi 按文本匹配来移除已送达的队列项（不稳）。

**重试**

- 可重试的助手错误（过载、限流、5xx；不含上下文超长）：发 `auto_retry_start {attempt, maxAttempts, delayMs, errorMessage}`，写一条省略失败尝试的 `context_edit`，退避后 `continue()`；成功或用尽发 `auto_retry_end {success, finalError?}`。`abort_retry` 可取消。
- 设置：`retry.maxRetries` 默认 **3**，`retry.baseDelayMs` 默认 2000（`docs/settings.md`）；RPC `set_auto_retry {enabled}`。
- 上下文超长：省略失败尝试，以 `overflow` 原因压缩后重试一次。
- 手动压缩（RPC `compact`）先 `abort()` 掉进行中的运行，再发 `compaction_start {reason: "manual"}`；成败都会发 `compaction_end`。可压缩的内容不足时报错 `Nothing to compact (session too small)`，当前分支最后一条已经是压缩条目时报错 `Already compacted`，extension 取消时报 `Compaction cancelled`（1.0.2 `agent-session.js` `compact`，2026-10-13 核实；宿主按开头认出前两种，见 `packages/pi/src/process/rejections.ts`）；保留多少不压缩由设置 `compaction.keepRecentTokens`（默认 20000）决定。返回的 `summary` 不只是模型的原话：pi 会加上自己的框架，例如没有更早历史时的 `No prior history.`，以及切开一轮时的 `**Turn Context (split turn):**` 段（2026-10-06 在 pi 1.0.2 上由契约测试 `compaction` 观察到）。
- 自动压缩发生在哪（1.1.0 `agent-session.js`，2026-10-20 核实，契约测试 `compaction-run` 录了前两种）：
  - **一次 agent 循环结束后**（`_handlePostAgentRun` → `_checkCompaction(最后一条助手消息)`）：在 `agent_end` 之后、`agent_settled` 之前，阈值（`threshold`）或溢出（`overflow`）。最后一条回复正常结束（`stop`）时只压缩不重试，压缩条目落在这一轮最后一条回复之后、下一条用户消息之前，和下一种在文件里分不出来。
  - **一次运行里下一次请求模型之前**（`prepareNextTurnWithContext` → `_compactBeforeNextAssistantResponse`，按投影估算是否过阈值，`threshold`）：在上一个 pi turn 的 `turn_end`（工具结果之后）和下一个 `turn_start` 之间，条目落在工具结果之后、下一条助手消息之前。虚拟模型在 `prepareRequest` 里按路由到的模型再查一次。
  - **新消息开始前**（`prompt` 预检里 `_checkCompaction(上一条助手消息)`）：在用户消息写入之前，条目落在上一轮之后、新的用户消息之前；这时 `agent_start` 还没发。
  - 上下文溢出的恢复：失败的回复（`stopReason: "error"`）和它的工具结果先被 `context_edit` 屏蔽，再压缩（`willRetry: true`），然后重试那次回复；第二次溢出不再压缩，直接发一条没有 `compaction_start` 的 `compaction_end`（`result` 为空，`errorMessage` 是 "Context overflow recovery failed after one compact-and-retry attempt…"）。
- 事件：`compaction_start {reason}`；`compaction_end {reason, result?, aborted, willRetry, errorMessage?}`，`result` 是 `{summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter, usage?, details?}`，只在写了条目时有；被中止（`aborted: true`）时没有 `errorMessage`，失败时是 "Auto-compaction failed: …" 或 "Context overflow recovery failed: …"。`result` 的 `summary`、`firstKeptEntryId`、`tokensBefore` 和写进文件的压缩条目相同；条目没有原因、没有压缩后的 token 数，`estimatedTokensAfter`（压缩后投影的字符数 ÷ 4 估算）只在事件里。
- 压缩条目：`{type: "compaction", summary, firstKeptEntryId, tokensBefore, details?, usage?, fromHook?, systemMessage?}`，`parentId` 是压缩时的叶子；压缩用的模型调用（摘要、切开一轮时再加一次）不写成消息条目，用量记在条目的 `usage`。

**中断**：`abort()` 依次中止重试、压缩、分支摘要和 agent，**等真正空闲后才返回**。不清队列，要先 `clear_queue`。

**统计**（`get_session_stats` → `SessionStats`）

```ts
{ sessionFile?, sessionId, userMessages, assistantMessages, toolCalls, toolResults, totalMessages,
  tokens: { input, output, cacheRead, cacheWrite, total }, cost,
  contextUsage?: { tokens: number | null, contextWindow: number, percent: number | null } }
```

- 用量和费用统计**整个文件**（含废弃分支、压缩消耗）。
- `contextUsage` 是当前分支的估算；压缩后到下一次助手回复前为 null；没有模型时缺省。
- 1.1.0 的 `getSessionStats`（2026-10-10 读源码）：`userMessages` 数所有 `role: "user"` 的消息（插话也是），`toolCalls` 数助手消息里的工具调用；用量累加 `usage` 条目、带用量的压缩和分支摘要条目、带用量的工具结果、助手消息。`total` = 四项之和；没有推理 token 这一项。`contextUsage` 在模型没有上下文窗口时也缺省。
- `usage.reasoning`（推理 token）只有部分服务商报告，是 `output` 的一部分；不报告的服务商留空。
- 计时：每次请求前 pi 发 `turn_start`，然后准备请求（可能先压缩）再发出；服务商的响应头回来后才发助手消息的 `message_start`（pi-ai 的 Anthropic 实现在拿到响应后才 push `start`；其他服务商没逐个核对），之后是 `message_update` 增量和 `message_end`。所以没有"请求已发出"的事件，测首 token 时间只能从 `turn_start` 算起。
- 系统消息（1.1.0）：pi 把提示词和工具集写成 `role: "system"` 的消息，`content` 是提示词正文，`sections` 是按名字的分段（之后的系统消息按名字改，`null` 是删除），`toolsAdded` / `toolsRemoved` 增删工具声明；压缩条目的 `systemMessage` 是完整的检查点。pi-ai 的 `getCurrentSystemMessage` 按顺序回放这些消息；`estimateTokens` 按字符数 ÷ 4 估算，工具按声明的 JSON 长度。分段由 `buildSystemPromptSections`（`system-prompt.ts`）按序生成：`preamble`（固定开场，或 SYSTEM.md 取代它，取代时没有 `tools`、`rules`、`docs`）、`tools`（工具的一句话说明）、`rules`、`docs`、`addendum`（APPEND_SYSTEM.md）、`project_context`（"Project-specific instructions and guidelines:" 加每个文件一块 `<project_instructions path="…">…</project_instructions>`，全局目录的在前，再从上级目录往下）、`skills`（`<available_skills>` 里每个 skill 一块 `<skill><name>…</name><description>…</description><location>…</location></skill>`，名字经 XML 转义）、`cwd`，以及扩展经 `before_agent_start` 加的分段（内置 MCP 扩展加 `mcp_servers`）；除 `preamble` 外都包在 `<名字>…</名字>` 里。内置工具是 `read`、`bash`、`powershell`、`edit`、`write`、`grep`、`find`、`ls`，MCP 工具名是 `mcp__<服务器>__<工具>`，`codemode`、`tool_search` 来自内置扩展。扩展的 `before_agent_start` 若直接返回 `systemPrompt`，发出去的是它，会话文件里记的仍是分段；被 `prepareLoadout` 隐藏的工具仍在 `toolsAdded` 里——这两种情况从会话文件估不准（2026-10-15 核实，1.1.0 与 1.2.0 相同）。自动压缩在 `contextTokens > contextWindow − reserveTokens` 时触发（`compaction.enabled` 默认开、`reserveTokens` 默认 16384，`compaction.modelOverrides["服务商/模型"]` 可覆盖；`keepRecentTokens` 不参与触发），RPC 只给得出 `get_state.autoCompactionEnabled`。

## 3. RPC 协议（`src/modes/rpc/rpc-types.ts`、`rpc-mode.ts`；`docs/rpc.md`、`docs/rpc-commands.md`、`docs/json.md`）

**传输**：严格以 LF 分隔的 JSONL。pi 的文档说不要用 Node 的 `readline`，因为它会在 U+2028/2029 处断行；2026-10-08 在 Node 22.19 上实测 `readline` 只在 LF、CR、CRLF 处断行，这条警告对 Node 22 不成立，但它仍会把单独的 CR 当成行尾，和 pi 的分帧不同，所以照样用只认 LF 的分帧。stdout 只有协议，诊断走 stderr。关闭 stdin 即优雅退出。

**响应**：`{id?, type: "response", command, success, data? | error}`。**每行命令并发处理，响应可能乱序，按 `id` 对应。** `prompt` 在预检后返回，其他命令完成后返回。

**常用命令**

| 命令 | 返回 |
|---|---|
| `prompt {message, images?, streamingBehavior?}` | `{disposition}` |
| `steer` / `follow_up {message, images?}` | `{disposition: handled \| queued}` |
| `abort` / `clear_queue` | — / `{steering, followUp}` |
| `get_state` | `{model?, thinkingLevel, isStreaming, isCompacting, steeringMode, followUpMode, sessionFile?, sessionId, sessionName?, autoCompactionEnabled, messageCount, pendingMessageCount}` |
| `set_model {provider, modelId}` | 完整 `Model`；必须是有认证的可用模型 |
| `get_available_models` / `get_available_thinking_levels` | `{models}` / `{levels}` |
| `set_thinking_level {level}` | 按模型能力截断 |
| `compact {customInstructions?}` | `CompactionResult` |
| `set_auto_compaction` / `set_auto_retry` / `abort_retry` | — |
| `bash {command}` | `BashResult`，流式 `bash_execution_update` |
| `get_session_stats` | 见上 |
| `get_entries {since?}` | `{entries, leafId}`：按追加顺序，不含文件头；`since` 是排他游标，未知 id 报错；**包含废弃分支和压缩前历史** |
| `get_tree` | `{tree, leafId}` |
| `get_messages` | 当前分支**投影后的上下文**（压缩后旧消息已被摘要替换） |
| `set_session_name {name}` | 写 `session_info`，发 `session_info_changed` |
| `export_html {outputPath?}` | `{path}`：把当前会话写成一个独立的 HTML 页面（含条目、系统提示词和工具说明）。不给 `outputPath` 时写到 pi 的当前目录（`pi-session-<会话文件名>.html`）；给了就写到那里，不建上级目录。会话文件还没写出来时报错 `Nothing to export yet - start a conversation first`（1.1.0，契约测试 `export-html`，2026-10-13） |
| `get_commands` | `{commands: [{name, description?, source: extension \| prompt \| skill, sourceInfo}]}` |
| `fork {entryId}` / `clone` / `new_session` / `switch_session` | 换会话（见第 1 节） |

**`get_commands`**（2026-10-10 核实）：依次是 extension 命令、提示词模板、skill（`skill:<名字>`），不去重。extension 命令要加载 extension 才有（内置的 `/mcp` 等也在）；模板和 skill 来自全局目录（`~/.pi/agent/prompts`、`skills`，`~/.agents/skills`）和项目目录（`.pi/prompts`、`.pi/skills`、各级 `.agents/skills`，项目目录要先被信任）。`prompt` 以 `/名字` 开头时：是 extension 命令就直接执行（应答 `handled`），是 skill 或模板就展开，其他原样发给模型。终端界面的内置命令（`/model`、`/compact`、`/login` 等）只在终端界面里处理，RPC 里会被当成普通文字。`steer` 遇到 extension 命令会报错。

**`@` 文件**（终端界面，2026-10-10 核实，`packages/tui/src/autocomplete.ts`）：用 `fd` 找候选（`--type f --type d --follow --hidden --exclude .git --max-results 100`，先搜一层再递归，按匹配程度排序取前 20）；`fd` 先找 `~/.pi/agent/bin/fd`，再找 `PATH`，没有就从 GitHub 下载，离线时找不到就没有候选。选中后插入 `@相对路径 `，目录插入 `@目录/`，有空白时加引号 `@"路径"`。**发送时 pi 不展开 `@路径`**（终端界面和 RPC 都不），模型自己用工具去读；只有命令行参数里的 `@文件` 会展开（RPC 模式拒绝这种参数）。

**↑ 历史**（终端界面）：只在内存里，最多 100 条，是这个进程发过的消息加上载入过的会话里的用户消息，不落盘；没有草稿保存。

**图片**：`images` 是 `{ type: "image", data（base64，不带 data: 前缀）, mimeType }`。png、jpeg、gif、webp 原样收下，其他格式转成 png；默认自动缩到 2000×2000 以内、base64 不超过 4.5 MB，缩过的在文字后附一句原始尺寸；转不了或缩不下时丢掉图片、在文字里加一句说明，不报错。模型不支持图片时，图片换成占位文字。处理后的图片作为 `{type: "image", data, mimeType}` 留在用户消息的 `content` 里，随消息写进会话文件；会话文件在第一条用户消息追加时写出（`SessionManager._persist`，有了对话才建文件），所以消息一发出，文件里就有这张图（1.0.2 源码核实，2026-10-12）。

**RPC 里没有的**：会话列表、登录 / 登出、设置、标签、会话内树导航、reload。

**事件**

- 所有 `AgentSessionEvent`：`agent_start/end`、`agent_settled`、`turn_start/end`、`message_start/update/end`、`tool_execution_start/update/end`（嵌套调用带 `parentToolCallId`，id 形如 `<parent>/<n>`）、`queue_update`、`compaction_start/end {reason: manual | threshold | overflow}`、`entry_appended`、`session_info_changed`、`thinking_level_changed`、`auto_retry_start/end`、`bash_execution_update`，以及 RPC 专有的 `extension_error`。
- `message_update` 只带增量（`text_*`、`thinking_*`、`toolcall_*`、`done`、`error`），以 `message_end.message` 为准。
- **不发事件的条目**：`model_change`（RPC 里根本没有"模型已切换"事件）、压缩和分支摘要条目、标签、bash 消息；`entry_appended` 只覆盖少数写入：extension 的 `appendEntry`、缓存预热的 `usage` 条目、虚拟模型的 `custom` 条目、extension 边界草稿、重试和上下文溢出时去掉失败回复的 `context_edit`（2026-10-08 核实）。所以镜像条目要在 `agent_settled`、`compaction_end` 和自己的 `set_model` 等命令之后再调一次 `get_entries {since}`。

**并发与锁**

- **会话文件没有锁**：两个进程打开同一文件会各自在自己的叶子后追加，文件里交错成多条分支，互相看不到。只有首次创建用 `wx` 互斥。**宿主必须保证一个会话文件只有一个 pi 进程。**
- `proper-lockfile` 不仅用于 `auth.json`、模型存储、包管理和实验性服务端：2026-10-20 对照已装 pi 的 `dist/core/settings-manager.js`，`FileSettingsStorage.withLock` 对全局和项目 `settings.json` 也用 `lockSync(path, { realpath: false })`，锁目录为 `<文件>.lock`（默认 stale 10 秒、更新 5 秒）；存在的文件先持锁再读、合并修改、同步写文件，最后释放。文件不存在时，pi 先以 `undefined` 调用转换函数计算新内容，再在写入前取锁，不会在锁内重新读取；因此与 pi 同时首次创建时，pi 自身这段锁前计算仍可能覆盖其他写入者。Atrium 的普通配置编辑也必须在同一把锁内重新检查版本并替换 settings，不能只检查锁目录是否存在；这能协调已有文件的 pi 写入，不能修正上述 pi 的首次创建行为。
- 普通配置语法（2026-10-20 对照已装 pi 的 `dist/core/model-config.js`、`dist/utils/json.js` 与 `settings-manager.js`）：models 在 `JSON.parse` 前剥离开头 BOM、`//` 行注释和尾逗号（字符串内容不剥离，不额外支持块注释）；settings 剥离 BOM 后严格 JSON，只有原始内容为零字节时按空对象处理（不是任意空白）。Atrium 保存时只用解析结果验证对象形状，仍写原文，不运行其中的命令。

**退出**（2026-10-04 在 pi 1.0.2 上实测）：bash 工具的子进程用 `detached: true` 启动，各有自己的进程组，pi 记录它们的 pid。关闭 stdin（退出码 0）或 SIGTERM（143）时，pi 会先杀掉这些子进程再退出，约 0.3 秒。SIGKILL 时 pi 来不及清理，子进程被过继给 1 号进程继续运行，杀 pi 的进程组也够不到它们。所以强杀前要趁 pi 还活着按父进程关系找出后代，连同它们的进程组一起杀。

**启动**：没有可用模型（没有凭据）时 RPC 模式**照常启动，不退出**（2026-10-10 在 1.1.0 上实测，原先记的"直接报错退出"不对）：`get_state` 的模型是 pi-agent-core 的占位模型（`provider`、`id`、`api` 都是 `unknown`，档位 `off`），`get_available_models` 为空，`prompt` 报错 "No API key found for the selected model."。模型目录在后台刷新，最多 15 秒。

**一次性调用**（`src/modes/print-mode.ts`、`json-event.ts`、`main.ts`，2026-10-10 按 `4c6fb7c` 核实，自动生成标题用）：`pi --mode json -p --no-session` 先输出会话头一行，之后每个会话事件一行 JSON（形状和 RPC 的事件相同，`message_update` 去掉了累积的 `partial`）。标准输入不是终端时，pi 读完整个标准输入作为第一条消息（参数里的消息接在后面），所以对话内容可以不放进参数。助手消息的结果看 `message_end` 里 `role: "assistant"` 的 `stopReason`（`error` / `aborted` 时 `errorMessage` 是原文）；`text` 模式出错时退出码为 1。`--no-tools` 关掉所有工具，`--system-prompt` 换掉默认的编程提示词，`--model <服务商>/<模型>` 解析不出时 pi 直接退出。认证问题的原文常见 `No API key found for …`（没有凭据，后面附"Use /login …"）、`OAuth refresh failed for …`（OAuth 刷新失败）、服务商的 401 / `unauthorized` / `invalid_api_key`，部分服务商写"Run `/login …` to sign in again"。

**限制工具**（2026-10-16 读 1.0.2）：`--tools a,b` 白名单、`--exclude-tools a,b` 黑名单、`--no-builtin-tools`、`--no-tools`，内置和扩展的工具都算（用白名单时扩展的工具也得写上）。这是硬限制：不在白名单或在黑名单里的工具在注册表这一层就去掉，扩展的 `setActiveTools`、`executeTool` 也拿不到。扩展的 `pi.setActiveTools` / `getActiveTools` 只管声明给模型的工具（加载期不能调，下一次请求生效），工具变化写成系统消息的 `toolsAdded` / `toolsRemoved`，但进程重启后不从会话文件恢复。内置工具名：`read`、`bash`、`powershell`、`edit`、`write`、`grep`、`find`、`ls`。


## 4. 模型、认证（`packages/ai/src/types.ts`、`src/core/model-runtime.ts`、`src/core/auth-storage.ts`）

- `Model`：`id, name, api, provider, baseUrl, input: ("text" | "image")[], cost {input, output, cacheRead, cacheWrite}（美元 / 百万 token）, reasoning, thinkingLevelMap?, contextWindow, maxTokens, …`。
- 身份是 `provider + modelId`。
- 推理档位：`off | minimal | low | medium | high | xhigh | max`（`packages/agent/src/types.ts`）；每个模型支持的由 `getSupportedThinkingLevels(model)` 决定，不支持推理的只有 `off`。
- 凭据：`~/.pi/agent/auth.json`，用 `proper-lockfile` 加锁；`{type: "api_key", key?, env?}` 或 `{type: "oauth", refresh, access, expires, …}`，每个服务商一条。环境变量里的 key 也认。
- **模型列表**（2026-10-10 核实，1.1.0 的 `dist` 与源码一致）：
  - 只有 RPC 的 `get_available_models` 能拿到机器可读的列表，返回完整的 `Model`，只含有凭据的服务商的对话模型。`pi --list-models` 只打印文本表格，没有 `--json`。
  - 模型目录缓存在 `~/.pi/agent/models-store.json`（按服务商，带 ETag）。RPC 模式启动时不联网、只读缓存，会话建好后在后台从 `pi.dev` 刷新（距上次不到 4 小时就跳过，最多 15 秒，出错不报）。目录变化不发任何事件。
  - `get_available_thinking_levels` 只回答当前模型。任意模型的档位由 pi-ai 的纯函数 `getSupportedThinkingLevels(model)` 按 `reasoning`、`thinkingLevelMap` 算出（`packages/ai/src/models.ts`）。
  - RPC 的 `set_model`、`set_thinking_level` **不写 pi 的设置**（只有终端界面选模型时选"保存"才写 `defaultProvider` / `defaultModel` / `defaultThinkingLevel`），也不发事件；档位真的变了才发 `thinking_level_changed`。`set_model` 找不到模型时应答错误。
  - 新进程的模型：`--model`（可带 `--provider`、`:档位` 后缀）> 已有会话里最后的 `model_change` > 设置里的默认模型 > 第一个可用模型。**`--model` 解析不出时 pi 报错退出（退出码 1）**。档位：`--thinking` > 会话里的记录 > 设置 > `medium`，再截到模型支持的范围。
- **登录只有终端界面的 `/login`，没有 RPC 命令。** 查状态可用 `pi auth check --provider X --json`（必须带 `--provider` 或 `--model`，一次查一家）。宿主可以在锁下写 `auth.json`，或在启动 pi 前设环境变量；OAuth 流程由 `ModelRuntime.login(providerId, type, interaction)` 实现。
- **从外部调用 pi 的登录**（2026-10-10 实测，pi 1.1.0）：
  - `@earendil-works/pi-coding-agent` 的包入口公开导出 `ModelRuntime`。`ModelRuntime.create({ authPath })` 之后，`login(providerId, "oauth" | "api_key", interaction, { getDeviceId })` 走的就是 `/login` 的同一套流程，凭据在锁下写进 `auth.json`。另有 `checkAuth`、`listCredentials`、`logout`、`getProviders()`（每家的 `auth.oauth` 带 `name`、`isSubscription`、`loginLabel`）。`@earendil-works/pi-ai` 的 `./oauth` 导出只有类型，各家的 OAuth 实现不在它的公开导出里，所以要经过 `ModelRuntime`。
  - 安装好的 pi 是个普通的 npm 包：npm 全局安装在 `<prefix>/lib/node_modules/@earendil-works/pi-coding-agent`，官方脚本新装的在 `~/.pi/agent/install/…/node_modules/` 下（`managed-install.json` 标记），`pi` 命令是指向包里 `dist/bundle/cli.js` 的符号链接。包里同时有不打包的 `dist/index.js` 和它的 `node_modules`，用系统 Node 直接 `import` 就能用，版本和用户的 pi 一致。
  - 1.1.0 带 OAuth 的服务商：`anthropic`、`openai`（"Sign in with ChatGPT"，需要 `getDeviceId` 给出 UUID，否则直接失败）、`openai-codex`（标为 legacy）、`github-copilot`、`kimi-coding`、`xai`、`openrouter`、`meta`、`radius`（要先配网关）。共 43 家服务商，42 家能用 API Key 登录。
  - 交互全部经 `interaction`：先 `prompt({ type: "select" })` 选登录方式（如 `browser` / `copy_code` / `device_code`），然后 `notify({ type: "auth_url", url })`，同时 `prompt({ type: "manual_code" })` 等用户粘贴回调地址，与本地回调服务（Anthropic `localhost:53692`、OpenAI `localhost:1455`）竞速；`github-copilot` 先问企业域名（`text`）；也有 `device_code`、`progress`、`info` 事件。pi 自己不打开浏览器，由调用方打开 `auth_url`。
  - `interaction.signal` 中止后 `login` 以 `AbortError` 拒绝，回调端口立即释放；`state` 不对的回调得到 400，流程继续等。
  - 终端里的 pi 用 `SettingsManager.getOrCreateDeviceId()`（`~/.pi/agent/settings.json` 的 `deviceId`，没有就生成 UUID）作为 `getDeviceId`。
  - `ModelRuntime.create` 在 `auth.json` 不存在时写一个 `{}`。
- **新版本检查**（1.1.0 bundle 的 `getLatestPiRelease`，2026-10-11 核实）：pi 请求 `https://pi.dev/api/latest-version`（`accept: application/json`，10 秒为限），应答形如 `{"ok":true,"version":"1.1.0","packageName":"@earendil-works/pi-coding-agent"}`，可能带 `note`；`version` 不是非空字符串时当作没查到。环境变量 `PI_OFFLINE` 设了就不查。另有 `https://pi.dev/api/installer/releases`（`PI_INSTALLER_API_BASE`）给安装脚本和托管安装用。
- **经 Claude Code 的模型**（pi-claude-bridge 0.9.3、Claude Code 2.1.301，2026-10-16 实测）：pi 的 `anthropic` 订阅登录直接拿 OAuth token 发请求，Anthropic 自 2026-04-04 起把这类第三方请求算到额外用量（extra usage）；经 Agent SDK 和 `claude -p` 的请求仍算在订阅额度里。社区扩展 pi-claude-bridge（`pi install npm:pi-claude-bridge`，配置 `~/.pi/agent/claude-bridge.json`）注册服务商 `claude-bridge`，模型取自 pi-ai 的 Anthropic 目录，请求经 Agent SDK 交给本机的 `claude`，用 Claude Code 自己的登录。loop、工具、压缩、会话树仍是 pi 的：Claude Code 以 `tools: []` 启动，pi 的工具作为进程内 MCP 服务器交给它（模型看到的名字是 `mcp__custom-tools__<工具>`），调用时挂起、交回 pi 执行，再按 `tool_use` id 把结果交回去。
  - 系统提示词：Claude Code 的 `claude_code` 预设（去掉 git 说明）在前，后面依次接 pi 的记忆文件、Skills、自定义开场、`addendum` 的正文（不带 pi 存的 `<addendum>` 外框）和扩展加的分段（`prompt-capture.ts` 的 `projectCapture`）；pi 默认的开场、`tools`、`rules`、`docs`、`cwd` 不发。Skills 只在 pi 开了 `read` 工具时发。系统消息的 `content` 不转发，pi 1.1.0 写进会话的 `content` 总是空的。仍含 pi 内置提示词的请求，扩展拒绝发送（Anthropic 会按提示词把它算成额外用量）。实测发出的请求：预设正文约 13,700 字符，Claude Code 另在第一条用户消息里放环境、模型、账户和日期的提醒约 1,600 字符。量法：起一个只把请求体写到文件的本地转发代理，`ANTHROPIC_BASE_URL` 指向它跑一轮，看 `system` 里 `<project_context>` 之前的长度和第一条用户消息里的 `<system-reminder>`。
  - 会话：同一个 pi 进程里连续的轮接着用同一个 Claude Code 会话，缓存命中；和 pi 的历史对不上时（停止、压缩、分叉、出错、pi 重新启动、中途换成它）从 pi 的历史重写 Claude Code 的会话，下一轮重新写缓存。
  - 用量：Claude Code 的 `rate_limit_event` 经 `after_provider_response` 报成 `anthropic-ratelimit-unified-*` 响应头，并用 `notify` 发"Claude rate limit warning"；`isUsingOverage` 为假表示算在订阅额度里。助手消息的 `cost` 为 0。
  - RPC 模式下的提示、工具、插话、停止和停止后的下一轮都正常。在 bash 工具执行中停止时，最后一条助手消息的 `stopReason` 是 `error`、"This operation was aborted"，pi 自带的 OpenAI 兼容服务商（`sankuai-openai`）实测相同；其他时机停止未测（pi-ai 的服务商在请求途中被中止时报 `aborted`）。

## 5. extension 与宿主相关的部分（`src/core/extensions/types.ts`、`docs/rpc-extension-ui.md`）

- **对话框**：`extension_ui_request {id, method}`，`select {title, options, timeout?}`、`confirm {title, message, timeout?}`、`input {title, placeholder?, timeout?}`、`editor {title, prefill?}`；回 `extension_ui_response {id, value} | {id, confirmed} | {id, cancelled: true}`。超时在 pi 侧按默认值结束，迟到的回答被忽略。**不写进会话文件。**
  - 补充（2026-10-16 读 1.0.2）：不给 `timeout` 也不给 `signal` 时 pi 一直等；`editor` 不收这两个参数；超时或中止时 pi 按默认值结束，不告诉宿主；工具里的 `signal` 不会自动传给对话框，没绑 `signal` 时 RPC `abort` 一直等它、不应答。stdin 的每一行并发处理，挂着的对话框不挡别的命令和事件流。RPC 下 `ctx.hasUI` 为真。
- **单向通知**：`notify {message, notifyType?}`、`setStatus`、`setWidget`、`setTitle`、`set_editor_text`。RPC 模式下 `custom()` 等终端专用方法不起作用。
- **写会话**：`pi.appendEntry(customType, data)` 写 `custom` 条目并发 `entry_appended`；`pi.sendMessage` 写 `custom_message`（可 `triggerTurn`、`deliverAs: steer | followUp | nextTurn`）。
  - `sendMessage` 补充（2026-10-16 读 1.0.2）：运行中、`triggerTurn` 不是 `false` 时（不写选项也算）默认按 steer 在下一个轮次边界送到，`deliverAs: "followUp"` 进 followUp 队列；这种消息不出现在 `queue_update` 里，`clear_queue` 会清掉它。空闲且 `triggerTurn: true` 时直接开一次运行，绕过 `prompt()`，不触发 `input`、`before_agent_start`。`nextTurn` 要到下一次 `prompt` 才发出和写盘。模型看到的是一条 user 消息（`content`），`details`、`display` 不给模型；RPC 事件是 `message_start` / `message_end`（`role: "custom"`），不发 `entry_appended`。运行中发 `/扩展命令` 也立即执行；扩展工具的 `execute` 可以一直等，pi 不设超时，RPC `abort` 中止传给它的 `signal`。
- **可挂的钩子**（部分）：`session_start`、`session_before_switch/fork/compact`（可取消）、`input`、`before_agent_start`、`agent_before_settle`、`turn_end`、`message_end`、`context`、`before_provider_request`、`tool_call`（改参数或 `{block, reason}`）、`tool_result`。只有 `AgentSessionEvent` 那一部分会出现在 RPC 的 stdout。
- **审批**（MVP 2）：做成 extension，在 `tool_call` 里调 `ctx.ui.confirm`，宿主收到的就是一个对话框请求。
- **改请求与服务档**（1.0.2、1.1.0，2026-10-12 实测，ADR-0008）：pi-ai 的 `openai-codex-responses`、`openai-responses` 接受 `serviceTier` 并写成请求里的 `service_tier`，但 pi-coding-agent 的设置和 RPC 都不传它；只能靠扩展的 `before_provider_request`：处理函数拿到 `{payload}` 和 `ctx`（`ctx.model` 是当前模型），返回非 `undefined` 的值就替换请求，多个扩展依次处理，抛错只发 `extension_error`、请求照发。另有 `after_provider_response {status, headers}`、`provider_stream_event`（原始流事件）和 `before_provider_headers`。pi-ai 计价按 `resolveCodexServiceTier(回复的服务档, pi 自己请求的服务档)`：回复是 `default` 而 pi 请求过 priority 或 flex 时按请求的算；priority 对 `gpt-5.5` 乘 2.5、其他乘 2，flex 乘 0.5。扩展加的 priority 不算"pi 请求的"，所以按标准价。
- **Codex 回复里的服务档**（2026-10-12 用真实 pi 实测 gpt-5.5、gpt-6.1-sol）：不管请求带不带 `service_tier: "priority"`，`response.created` / `in_progress` 里是 `auto`，`response.completed` 里是 `default`；响应头里也没有服务档。看不出 Fast 生效没有。`gpt-5.3-codex-spark` 在 ChatGPT 账户下直接 400（"not supported when using Codex with a ChatGPT account"），与服务档无关。
- **Codex 的模型列表**（2026-10-12 实测）：`GET <baseUrl>/codex/models?client_version=<版本>`，`baseUrl` 即 `openai-codex` 模型的 `https://chatgpt.com/backend-api`；请求头 `Authorization: Bearer <access token>`、`chatgpt-account-id`（取自 token 的 JWT 声明 `https://api.openai.com/auth`.`chatgpt_account_id`）、`originator`，和 pi 发 Codex 请求时一样。应答 `{models: [...]}`，每个模型有 `slug`、`visibility`（`list` / `hide`）、`service_tiers: [{id, name, description}]`（如 `{id: "priority", name: "Fast", description: "2x speed, increased usage"}`）、旧字段 `additional_speed_tiers: ["fast"]`、`default_service_tier` 等。列出哪些模型取决于 `client_version`：`0.130.0` 只给 2 个，`1.0.0` 和 Atrium 用的 `99.0.0` 都给 10 个（`99.0.0` 时还有 `gpt-reserve`、`codex-auto-review`）；响应头带 `etag`，Codex 回复的头里也有 `x-models-etag`。实测账户上 GPT-5.5、5.6（sol / terra / luna）、6（sol / astra / luna）、6.1-sol 都有 priority：6.1-sol 和 6-astra 是"2x speed, increased usage"，6-sol 和 6-luna 是"1.5x speed"，其余"1.5x speed, increased usage"。
- **扩展里的凭据和网络**：`ctx.modelRegistry.getApiKeyAndHeaders(model)` 返回 `{ok, apiKey, headers}`，OAuth 服务商的 `apiKey` 是（必要时先刷新过的）access token；`ctx.modelRegistry.find(provider, id)`、`getAvailable()` 可找模型。pi 启动时用自己的 undici 替换全局 `fetch`，带上设置和环境里的代理（`core/http-dispatcher.js`），扩展里的 `fetch` 同样走代理。
- **`setStatus` 经 RPC**：`ctx.ui.setStatus(key, text)` 在 RPC 下发出 `extension_ui_request {id, method: "setStatus", statusKey, statusText}`，单向，不等回答；扩展命令的处理函数第二个参数 `ctx` 就有 `ui`。
- **`--extension <路径>`**：加载指定文件（TypeScript 也行），`--no-extensions` 时也照样加载；可以多次给。扩展里 import 的 `@earendil-works/*` 解析到 pi 自己带的那份。扩展用 `registerProvider` 注册已有的服务商名（如 `openai-codex`）会替换它的模型和调用，测试靠这个让假模型冒充 Codex。
- **扩展命令经 `prompt`**：`/名字 参数` 立即执行处理函数，应答 `{disposition: "handled"}`，不发 `agent_start` 等事件、不写会话文件；命令不存在时同样的文字会当普通消息发给模型，所以宿主发内部命令前要先在 `get_commands` 里确认它在。
- **SPEC-0002 契约测试实测**（2026-10-17，本机 1.1.0，`packages/pi/src/contract/subagent.pi.test.ts`，用只在测试里的探针扩展 `packages/pi/test/subagent-probe.ts`）：上面读源码得出的都成立。
  - 通道"乙"走得通：工具里 `setStatus("atrium-probe:<id>", JSON)` 发出请求、挂着等；运行中宿主发 `/probe-reply <id> <base64url>`，应答 `handled`，工具拿到回答、这一轮接着跑；命令不进会话文件、模型看不到，也不另开一次运行。
  - 空闲时 `sendMessage(…, {triggerTurn: true, deliverAs: "steer"})` 开一次运行，模型看到一条 user 消息；`custom_message` 的 `message_end` 之后、助手回复之前，会话目录里还没有文件；回复后文件依次是 `session`、`model_change`、`thinking_level_change`、系统消息（`message`，`role: "system"`）、`custom_message`、助手消息。
  - 运行中同样的调用不出现在 `queue_update` 里，在这一批工具跑完后送到，还是同一次运行（只有一个 `agent_start`）；送到之前 `clear_queue` 能清掉它，应答 `{steering: [], followUp: []}`（不列出它）。
  - `--tools read,ls,probe_ask` 只声明这三个，扩展的工具也要写上才有；`--exclude-tools bash,probe_branch` 去掉这两个；去掉的工具模型调了得到报错的工具结果 `Tool bash not found`，命令没执行。1.1.0 的工具声明在系统消息的 `toolsAdded` / `toolsRemoved` 里，请求的 `tools` 是空的。
  - `tool_call` 钩子返回 `{block: true, reason}`：工具不执行，模型得到 `isError: true`、正文就是 `reason` 的工具结果。
  - 工具 `execute` 里 `SessionManager.open(ctx.sessionManager.getSessionFile(), 别的目录).createBranchedSession(ctx.sessionManager.getLeafId())`：分支写在给的目录，头部 `cwd` 是父会话的目录、`parentSession` 是父会话文件，条目是父会话到发出这次调用的那条助手消息为止（含，`stopReason: "toolUse"`），id 不变；父会话照常跑完。
  - 在另一个目录 `pi --mode rpc --session-dir <目录> --fork <分支文件> --session-id <uuid>`：应答第一条 `get_state` 时文件已经写出，`sessionId` 和头部 `id` 是给的 uuid，头部 `cwd` 是新目录，条目 id 和分支相同。之后送一条自定义消息，模型收到的消息停在那条助手消息的两个工具调用上，紧接着就是这条 user 消息；用这个 pi 自带的 pi-ai `transformMessages` 处理后，两个调用各补一条 `No result provided`，在 user 消息之前（faux 不跑 `transformMessages`，测试直接调本机 pi 带的那份）。
  - 第一步用到的（2026-10-17，`packages/pi/src/contract/agent-note.pi.test.ts`）：空闲时扩展的命令里 `pi.sendMessage({customType: "atrium-agent", content, display: true, details}, {triggerTurn: false})` 立即写进会话文件（文件已经在的时候），发 `message_end`、不开运行，下一次请求里模型看到它（作为一条 user 消息）。RPC 的 `fork` 在加了 `--session-dir <目录>` 的临时 pi 里把新文件写进那个目录。`--fork <中间文件>` 起的子对话，会话头的 `parentSession` 指向那个中间文件，宿主随后就删掉了它；Atrium 的父子关系只看自己的索引，不读 `parentSession`。
  - 没有测：`codemode` 的嵌套调用经过 `tool_call` 钩子（读源码成立，没跑）。
  - 提示缓存（2026-10-18，真实 pi 1.1.0、ChatGPT 订阅的 GPT-5.6 Sol，经 Atrium 开带上下文的子对话，只读了会话文件里的用量）：父会话发出 `agent_spawn` 的那次请求 `input` 8869、`cacheRead` 0，它的下一次请求 `cacheRead` 8704；子对话的第一次请求 `input` 9529、`cacheRead` 0，没命中。pi-ai 的 `openai-codex-responses` 把 `prompt_cache_key` 设成 `options.sessionId`（会话 id，`cacheRetention: "none"` 时不带），OpenAI 按这个键分缓存，换了会话就命不中，和前缀是否相同无关。子对话的会话里，分叉点之后还多一条系统消息（声明 `report_progress`、`ask_parent`）。同日试过让扩展在 `before_provider_request` 里把 `prompt_cache_key` 换成父会话的 id 再测（没用，已撤掉），Codex 的子对话第一次请求仍是 `cacheRead` 0（`input` 9528）：Codex 的请求头另带 `session-id`、`x-client-request-id`（websocket 也是）为会话 id，是在 provider 里、`before_provider_headers` 钩子之后才设的，扩展改不了；看来 Codex 按这个头分缓存。经 pi-claude-bridge 的 Claude Sonnet 5.5：父会话的下一次请求 `cacheRead` 15906，子对话第一次请求 `cacheRead` 0、`cacheWrite` 8268（父会话第一次是 15906），bridge 给子对话拼的提示和父会话不同，前缀不一样，也命不中。Grok 4.7（xAI 订阅）和 DeepSeek V4.1 Flash 这次登录已失效，没测成。另外 ChatGPT 账户下 `gpt-5.5` 现在直接报"not supported when using Codex with a ChatGPT account"。
  - 第二步用到的（2026-10-18，`packages/pi/src/contract/agent-tools.pi.test.ts` 的 `agent-call`、`agent-task`、`agent-guard`）：Atrium 扩展的工具在状态行上问宿主、运行中的隐藏命令答它，模型读到结果；`registerFlag` 注册的 `--atrium-agent=<值>` 要写成一个带 `=` 的参数（值以 `-` 开头时分开写会被当成另一个参数）；空闲时 `deliver` 发的自定义消息开一次运行；`tool_call` 钩子拦下的调用模型得到理由。
  - 工具参数的校验（读 pi-ai 1.0.2 的 `utils/validation.js` 的 `validateToolArguments`，2026-10-18）：工具不是 TypeBox 而是普通 JSON Schema 时照样校验。在 `execute` 和 `tool_call` 钩子拿到参数之前，pi 先复制一份，去掉非必填、schema 不收 `null` 的字段上的 `null`（`normalizeOptionalNulls`），再按 schema 转类型（`Value.Convert` 加自己的一层：`"5"` 转成数字、`"true"` 转成布尔、数字转成字符串、必填的 `null` 转成 `0` / `""` / `false`），校验不过就抛错、不执行。所以 `execute` 拿到的参数一定符合声明的 schema（必填的都在、`additionalProperties: false` 时没有多余的键）；但会话文件里助手消息的 `toolCall.arguments` 是模型写的原样，和钩子拿到的不一定相同，Atrium 比较两者时把 `null` 字段当作没有、数字和布尔按文字比。
- **回复里的订阅用量**（2026-10-17 实测，ADR-0012）：扩展在 `after_provider_response {status, headers}` 里能读到回复的响应头，`ctx.model` 是当前模型。pi 用 Anthropic 订阅登录时回复带 `anthropic-ratelimit-unified-*`；pi-claude-bridge 0.9.3 把 Claude Code 的 SDK `rate_limit_event`（`rate_limit_info.unifiedWindows`，Agent SDK 的类型里没写）还原成同一组头交给 pi，每次请求的第一条回复前到：`-status`（`allowed` 等）、`-reset`、`-representative-claim`（如 `five_hour`）、`-overage-status`、`-5h-utilization` / `-7d-utilization`（0–1 的小数，如 `0.05`）、`-5h-reset` / `-7d-reset`（Unix 秒）。pi 1.1 新的 `openai` 订阅登录（"Sign in with ChatGPT"，`dynamic_agent_client`，令牌 resource `https://api.openai.com/v1`、权限 `chatgpt.tokens.use.direct`，pi 直接请求 `api.openai.com/v1`）查不到用量：`chatgpt.com/backend-api/wham/usage` 回 401 `no_matching_rule`，`/v1/responses` 不带 `x-codex-*`，OpenAI 说目前不支持。

## 6. 实验性多客户端服务端（`packages/server`、`client`、`protocol`、`durable`、`chord`）

只借鉴设计，不直接用：需要 `PI_EXPERIMENTAL=1 pi server`，不在 npm 包里，存储是 SQLite（`~/.pi/server/<id>/session.sqlite`），id 是数字，分叉 = 复制成新会话，和 JSONL 会话不兼容。

值得借鉴的：

- **拓扑**：协调进程负责路由；每个会话一个 worker 进程，用 `proper-lockfile` 锁会话目录，是唯一写者；多个客户端可以挂到同一个会话。
- **路由围栏**：挂接后服务端分配 `attachmentId`，迟到的旧路由帧被拒绝。
- **同步引擎 Chord 的 `ReplicatedState`**：生产者每次 `change()` 产生一个原子版本；订阅时先原子地拿一份完整快照，缓冲之后的更新，再流式推送带序号的增量批次（`r / s / d / p / m / a / t` 操作）；不允许缺口，积压超过 100 条就发 `{type: "reset", snapshot}`；断线后副本变为未就绪，重新拉取。
- **提交状态**：`queued → placed {entry} → done {entry, answer} | unanswered {reason}`，可带 `requestId` 去重；`AgentController.prompt` 返回 `operationId`，`waitForPrompt(operationId)` 等结果。
- **实时状态文档 `pi.live`**：`run`（运行中才存在）、`generation {attempt, message, retry?}`、`tools: [{callId, name, status: pending | running | done, output?, details?}]`、`compactions`。Atrium 的 SessionRuntime 可以参照这个形状。
