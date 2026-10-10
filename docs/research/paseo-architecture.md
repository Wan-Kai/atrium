# Paseo 的架构（实现参考）

> 基于 [getpaseo/paseo](https://github.com/getpaseo/paseo) 提交 `42806cd`，2026-10 读源码整理。路径相对 `packages/`。Paseo 自己的 `docs/data-model.md`、`agent-lifecycle.md`、`timeline-sync.md`、`architecture.md` 与代码一致，可直接读。
>
> 本地源码：`~/.cache/paseo-src`（`git clone --depth 1 https://github.com/getpaseo/paseo`）。

Paseo 是"宿主横向接多个 agent"的方案（Claude Code、Codex、pi 等），和 Atrium 定位不同，但宿主层的很多问题是一样的。Atrium 领域模型里参照 Paseo 的地方，见 [domain-model.md](../architecture/domain-model.md)。

## 1. 数据与持久化

- **没有数据库**：Zod 校验的 JSON 文件，写入用"临时文件 + rename"保证原子性，无迁移框架（新字段可选 + 默认值）。
  ```
  ~/.paseo/agents/{cwd 净化后}/{agentId}.json   每个 agent 一个
  ~/.paseo/projects/projects.json               项目登记
  ~/.paseo/projects/workspaces.json             工作区登记
  ~/.paseo/schedules/{id}.json
  ~/.paseo/worktrees/...                        Paseo 自己建的 worktree
  ```
- **对话记录不存**：只在 daemon 内存里，每次恢复时从 provider 的历史重建（"provider history is the durable transcript authority"）。
- **Project**（`server/src/server/workspace-registry.ts`）：`projectId = prj_<16hex>`（不透明），`rootPath`（只做词法规范化，不 realpath），`kind: git | non_git`，`projectKey`（跨主机分组，优先用 git remote），`displayName`、`customName`、`archivedAt`（软删除）。
- **Workspace**：`workspaceId = wks_<16hex>`，`projectId`（成员关系固定，不迁移），`cwd`，`kind: local_checkout | worktree | directory`，`branch`、`worktreeRoot`、`mainRepoRoot`、`baseBranch`、`isPaseoOwnedWorktree`、`archivedAt`、`pinnedAt`、`labels`。**多个工作区可以共用一个 cwd**：由目录决定的状态（git、diff、PR）按 `(serverId, cwd)` 存，工作区自己的状态（草稿、附件）按 `workspaceId` 存。
- **Agent**（存储：`server/agent/agent-storage.ts`；运行时：`agent-manager.ts` 的 `ManagedAgent`）：`id`（UUID）、`provider`、`cwd`、`workspaceId`（**创建时写定，是归属的唯一来源，运行时从不按 cwd 推断**）、`title`、`labels`、`lastStatus`、`config`（模型、模式、推理、MCP…）、`persistence {provider, sessionId, nativeHandle?, metadata?}`（pi 的 `nativeHandle` 就是会话文件路径）、`requiresAttention`、`attentionReason: finished | error | permission`、`attentionTimestamp`、`archivedAt`。
- **对话记录行**（`agent-sdk-types.ts`、`agent-timeline-store*.ts`）：`{seq, timestamp, item, turnId?, providerMessageId?}`；item 有 user_message / assistant_message / reasoning / tool_call（`detail` 归一化成 shell、read、edit、write、search…）/ todo / error / notification / compaction。**没有持久化的 Turn 实体**，turn 只是行上的 `turnId`。内存里按 agent 存 `{epoch, projection, minSeq, nextSeq}`，`TimelineProjection` 把流式片段合并成展示条目。
- **待批准请求**只在内存（`pendingPermissions: Map`），运行失败或取消时自动拒绝；只持久化 `attentionReason: permission`。

## 2. agent 生命周期（`server/agent/agent-manager.ts`、`agent-loading.ts`、`agent-prompt.ts`）

- **provider 接口**：
  ```ts
  interface AgentSession {
    startTurn(prompt, opts): Promise<{turnId}>;      // 立即返回，事件走 subscribe
    steerActiveTurn?(prompt, {expectedTurnId}): Promise<{status: "accepted" | "unavailable"}>;
    subscribe(cb): () => void;
    streamHistory(): AsyncGenerator<AgentStreamEvent>; // 从 provider 重建历史
    getPendingPermissions(); respondToPermission(id, resp);
    describePersistence(): AgentPersistenceHandle | null;
    interrupt(): Promise<void>;   // 幂等；确认上一轮不会再跑才 resolve
    close(): Promise<void>;       // 释放运行时，保留原生会话
    setModel / setThinkingOption / listCommands / ...
  }
  ```
- **生命周期**：`initializing | idle | running | error | closed`（`closed` = 有记录没有运行时，可恢复）；归档与之正交（`archivedAt`）。
- **懒恢复**：daemon 重启后所有 agent 都是 `closed`；打开或发消息时 `ensureAgentLoaded`（并发去重）→ 用持久化句柄恢复 → `streamHistory()` 重建内存时间线。
- **不回收空闲进程**：空闲 agent 一直常驻，只在归档、重载、替换、工作区拆除、daemon 退出时关闭。pi 是每个 agent 一个常驻子进程，另有短时的探测进程（模型目录、MCP 检测）。
- **串行化**：按 agent 的 `runLifecycleMutation`（恢复、归档）、`runForegroundMutation`（插话、取消），以及按顺序处理 provider 事件的 promise 链。
- **发消息**（`startAgentRun`）：provider 能直接处理的命令（pi 的 `/compact`）不分配 turn；`activeTurnBehavior: interrupt | steer`，默认中断后替换；已有运行时 `streamAgent` 拒绝。**后续消息的排队在客户端**（`app/src/stores/session-store.ts`），daemon 没有队列。
- **中断**：`session.interrupt()` 最多等 2 秒；确认后即使没收到终止事件也结算本轮。**没确认或超时，就保持运行中，替换、重载、回退、停止都失败**，避免状态分裂。
- **崩溃**：运行中进程退出 → `turn_failed`、进入 `error`、加一条 `[System Error]`、自动拒绝待批准请求。（pi 在两轮之间退出时 Paseo 不报告，下一次发消息才失败。）

## 3. pi 的接入（`server/src/server/agent/providers/pi/`）

- 文件：`agent.ts`（`PiRpcAgentClient` / `PiRpcAgentSession`）、`cli-runtime.ts`、`runtime.ts`（启动参数）、`history-mapper.ts`、`tool-call-mapper.ts`、`session-descriptor.ts`（可导入会话列表）、`rewind.ts`、`usage-poller.ts`、`extensions/`（pi-subagents、pi-ask-user、pi-mcp-adapter 等的适配）。
- 启动：`pi --mode rpc [--model p/id] [--thinking lvl] [--session <file> | --no-session] [--mcp-config tmp] --extension <临时 paseo-integration.mjs>`。进程由 `providers/jsonl-rpc-process.ts` 管理：按 id 对应请求，默认超时 30 秒，退出时 SIGTERM 再 SIGKILL 整个进程树，退出转成合成的 `process_exit` 事件。
- 用到的命令：`prompt`、`steer`、`clear_queue` + `abort`（中断）、`get_state`、`get_messages`、`get_available_models`、`set_model`、`set_thinking_level`、`get_session_stats`（轮询用量）、`get_commands`、`compact`、`set_auto_compaction`、`extension_ui_response`。
- **模型列表**（2026-10-10 读，`agent.ts` 的 `fetchCatalog`、`server/agent/provider-snapshot-manager.ts`）：
  - 短启一个探测用的 `pi --mode rpc`（不带其他参数），调 `get_available_models` 和 `get_state`，`get_state` 的模型标为默认，查完就停。工作区用工作区目录，设置页用家目录。从不借正在运行的 agent 的 pi。
  - 缓存在 daemon 内存里，pi 按目录分开（Claude、Codex 共用一份），没有期限、不落盘、没有定时器。daemon 启动时不查；第一次请求某个目录时预热，App 打开工作区时预取。同一目录同时只查一次。
  - 只有明确的"刷新"、服务商配置变化、诊断会强制重查；打开模型选择器只重新拉一次快照，不重查。重查期间旧结果照常给出，失败时换成错误状态、旧列表丢掉。整个刷新期限 120 秒。
  - pi 退出（如没有凭据）时，这个服务商的状态是 `error`，带 pi 的 stderr；找不到 pi 是 `unavailable`。
  - 推理档位按模型元数据（`reasoning`、`thinkingLevelMap`）从固定的七档里筛出，默认 `medium`，不调 `get_available_thinking_levels`。
  - 上一次的模型和推理强度记在客户端（全局、按服务商，推理强度按模型各记一份），新 agent 用 `--model p/id --thinking lvl` 启动；记住的模型已不在列表里时照样传给 pi。中途换模型调 `set_model` / `set_thinking_level`，再 `get_state` 读回。
  - `/` 命令每次都问运行中的 pi 的 `get_commands`，不缓存；草稿 agent 短启一个完整的 pi 去查。`@` 引用用 daemon 自己遍历目录（遵守 gitignore），不经过 pi。
- 事件映射（`agent.ts` 的 `handleSessionEvent`）：第一个 `turn_start` → `turn_started`（每个 Paseo turn 只一次）；`text_delta` / `thinking_delta` → 助手消息 / 推理；`tool_execution_*` → tool_call；`compaction_*` → compaction；`auto_retry_start` → error 条目；`agent_settled` → `turn_completed`，或最后一条助手消息带错误时 `turn_failed`。**一个 Paseo turn = 一次 `prompt` RPC**，turnId 由 Paseo 生成。
- **历史重建用 `get_messages`**（加上下面的条目捕获），不读主会话文件，也不用 `get_entries`。Atrium 改用 `get_entries` 沿当前分支重建，见 [pi-internals.md](pi-internals.md)。
- **"通知加标记"的旁路**：Paseo 注入一个临时 extension，用 `ctx.ui.notify("<MARKER> " + JSON)` 把 RPC 里拿不到的信息送回宿主（宿主收到的是 `extension_ui_request {method: "notify"}`）：
  - `PASEO_ENTRY_CAPTURE`：条目 id（回退目标）和上下文条目；
  - `PASEO_SUBMITTED_USER_ENTRY`：刚提交的用户消息对应的条目 id，用来把本地乐观消息的 `clientMessageId` 和正式条目对上；
  - `PASEO_COMMAND_RESULT`：反向调用的结果。宿主通过发 `/paseo_capture_entries`、`/paseo_tree` 这类 extension 命令反向调用，按 `requestId` 对应，超时 30 秒。
  - 这条通道就是 Atrium MVP 2 计划采用的 extension → 宿主通道。
- 对话框：`select / input / editor / confirm` 映射成 `kind: "question"` 的待批准请求；拒绝回 `cancelled`。

## 4. 客户端与服务端的同步（`server/directory-sync/`、`client/src/connection/`、`app/src/timeline/`）

- 单条 WebSocket，握手 `hello {clientId, clientType, protocolVersion, capabilities}`；应用层 10 秒心跳；每个 socket 8 MiB 上限，超了直接断开。
- **列表同步**（`DirectorySyncService`）：项目、工作区、agent 各是一个带 `generation`（每个 daemon 进程一个 UUID）和递增 `seq` 的集合。请求带 `{generation, afterSeq}`，响应 `mode: snapshot | changes`（snapshot 带原因：无游标 / generation 变了 / 游标过期 / 增量太大），之后推 `upsert | remove`。订阅 id 由服务端分配，重连后重新订阅。
- **对话记录同步**：实时推 `agent_stream {agentId, event, seq?, epoch?}`，**只推给订阅了该 agent 的客户端**（打开着或可见的）。权威拉取 `fetch_agent_timeline_request {agentId, direction: tail | before | after, cursor: {epoch, seq}, limit}`，默认一页 200 条；响应带 `epoch, reset, staleCursor, gap, window, hasOlder, hasNewer`。epoch 在 daemon 重启、强制重建、回退时变化。
- **客户端算法**（`viewed-timeline-sync.ts`、`timeline-sync-plan.ts`）：发现序号缺口就往后翻页补齐；打开时拉最近一页，往上滚再拉更早的；epoch 变或中间缺口就整段替换；失败退避重试（1 秒到 30 秒）；本地乐观消息用 `clientMessageId` 和正式消息对上。
- **多客户端**：agent 状态广播给所有连接；标签、布局、草稿、排队、本地缓存都在客户端。服务端只记每个客户端打开的标签（label `paseo.open-agent-tab.<clientId>`）和在线心跳。

## 5. 状态与关注

- **关注**：`{requiresAttention, attentionReason: finished | error | permission, attentionTimestamp}`，按边沿设上（running → idle 设 finished，进入 error 设 error，第一个待批准请求设 permission）；客户端看过后 `workspace.clear_attention.request` 清除；恢复 agent 不改它。
- **侧栏分档**（`protocol/src/agent-state-bucket.ts`）：有待批准 → `needs_input`；出错 → `failed`；运行中 → `running`；需关注 → `attention`；否则 `done`。工作区状态由服务端汇总（`server/workspace-directory.ts`），取最高优先级。没有单独的"收件箱"实体。

## 6. git 状态（`server/workspace-git-service.ts`）

- 按 cwd 缓存快照：文件监听（防抖 1 秒）+ 轮询；每 3 分钟后台 `git fetch`；PR 状态每 20 / 120 秒轮询（GitHub、GitLab、Gitea）。
- 快照：`isGit, currentBranch, isDirty, baseRef, aheadBehind, ahead/behindOfOrigin, diffStat` 和 forge 的 PR 信息（是否合并、检查状态、评审结论）。
- "已合并"不单独存，始终是 forge 的实时数据；开启设置后，PR 合并时自动归档工作区。worktree 在最后一个引用它的工作区归档后才删除。

### 6.1 工作区改动：输入框上方的 +N −M 与 Changes 面板（2026-10-10 读，Atrium 照抄）

- **数据来源是 git，不是 agent 的工具调用**：按工作区（cwd）统计，不分 agent，用户自己的改动也算；和对话记录加载了多少无关。Codex 的 `turn_diff` 事件直接丢掉。时间线里只有 tool call 分组的"edited N files"，没有行数，和面板没有关联。
- **胶囊上的数字**（`server/src/utils/checkout-git.ts` 的 `getCheckoutShortstatUncached`）：`merge-base HEAD <比较基准>`，再 `git diff --shortstat <merge-base>`（工作树对 merge-base：已提交、暂存、未暂存都算）加上未跟踪文件的行数。比较基准（`resolveShortstatComparisonRef`）：当前分支不是主干时，用 `origin/<主干>`（有的话）否则本地 `<主干>`；在主干上时用 `origin/<当前分支>`，没有就不显示（有未提交改动也不显示）；HEAD 分离、空仓库、非 git 都不显示。主干：`symbolic-ref refs/remotes/origin/HEAD`，失败时找本地 `main`、`master`。
- **未跟踪文件的行数**（`countUntrackedAdditions`）：`ls-files --others --exclude-standard` 的前 500 个，跳过大于 1 MB 的和二进制（前 16 KB 有 0 字节，或控制字符超过 30%），按 `\n` 数行（结尾换行不另算一行）。
- **刷新**（`workspace-git-service.ts`）：只给有界面在看的工作区监听。工作树用 `fs.watch` 递归监听（macOS），忽略 `.git` 和被 git 忽略的目录（`ls-files -o -i --directory --exclude-standard`，`.gitignore` 变了重算）；另监听 git 的元数据目录（忽略 `hooks/` `logs/` `objects/` 和 `*.lock`）。1 秒尾随防抖；同一个快照不重复推送（JSON 指纹）。监听出错时降级轮询：5 秒起，没变化就翻倍到 60 秒；30 秒·2^n（最多 5 分钟）后重试监听。每 3 分钟后台 `fetch origin --prune`，远端引用动了才重算。agent 跑了 `git push`、`git fetch`、`gh pr …` 之后强制刷新。缓存 15 秒，同一目录的并发请求合并。
- **面板**（`checkout-diff-manager.ts`、`app/src/git/`）：订阅 `(cwd, mode)`，150 毫秒防抖，结果不变不推。两种模式：未提交 = HEAD 对工作树（含暂存）加未跟踪文件；已提交 = `merge-base..HEAD`（只有提交）。所以胶囊和面板的合计可能对不上（Paseo 自己也这样）。默认模式：有未提交改动时"未提交"，否则"已提交"；手动选择只在"是否有未提交改动"不变时有效，翻转后回到默认。每个文件：路径、旧路径、新增 / 删除、增删行数、hunk（`@@` 头和 add / remove / context 行），以及 `binary` / `too_large` 状态。单文件 diff 超过 1 MB、累计超过 2 MB 之后的文件记为 `too_large`（保留行数）；整个结果超过约 23 MB 时整体显示"改动太大"。
- **界面**：胶囊 `+1.2k -34`（数字用紧凑格式，0/0、非 git 时不显示），点开 Changes 视图。头部：模式菜单（"Uncommitted / Committed"，后者说明"<分支> -> <主干>"）、合计、刷新、选项（分栏、隐藏空白、换行等）。正文依次判断：检查中、出错、不是 git 仓库、加载中、改动太大、没有改动（附"看未提交的 / 看已提交的"按钮）。文件头：文件名加灰色目录、+/−、新增 / 删除 / 修改图标，点击折叠；二进制和过大的文件显示一行占位。点文件列表里的文件滚到它的 diff；不跳到对话里的哪一轮。
- **已知问题**：重命名文件的单文件 diff 只用新路径做 pathspec，可能显示成整文件新增；累计到 2 MB 之后的未跟踪文件会从列表里消失；只有 diff 订阅、没有工作区订阅时，外部提交可能不刷新"未提交"面板。Atrium 照抄时避开这三处。
