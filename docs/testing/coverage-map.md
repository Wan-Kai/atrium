# 测试追踪表

> 每条需求、关键流程、错误路径和安全要求，对应到证明它的测试。规则见 [testing.md](../architecture/testing.md#让覆盖面全)。
>
> 新增行为时在这里登记；一个里程碑完成前，它涉及的行都要有测试，并通过变异门槛。"待 M1.x"表示计划在该里程碑补上。

## SPEC-0001 需求

| # | 需求 | 测试 | 状态 |
|---|---|---|---|
| 1 | 侧栏按项目和工作区组织，显示运行、待处理、合并状态；标签页切换会话 | `apps/desktop/e2e/workspaces.spec.ts`；组件与宿主见"项目、工作区与会话（M1.5）"。待处理的状态随 M1.6、M1.9 | 部分覆盖 |
| 2 | 流式输出回复和推理过程 | `apps/desktop/e2e/chat.spec.ts`、`chat.perf.spec.ts`；组件与渲染见"协议、客户端与流式显示（M1.3）" | 已覆盖 |
| 3 | 粘贴或拖入截图随消息发出 | — | 待 M1.7 |
| 4 | 看到工具调用：命令和输出、读的文件、diff、写入的文件 | — | 待 M1.4 |
| 5 | 随时中断 | `apps/desktop/e2e/run-control.spec.ts`（停止后排队暂停，继续发送）；控制器与界面见"运行控制（M1.6）" | 已覆盖 |
| 6 | 运行中默认排队，可插话 | `apps/desktop/e2e/run-control.spec.ts`（回车排队、⌘回车插话、插话在下一步前送达）；见"运行控制（M1.6）" | 已覆盖 |
| 7 | 输入框旁切换模型和推理强度 | — | 待 M1.7 |
| 8 | 重启后恢复之前的会话 | `apps/desktop/e2e/history.spec.ts`（从 pi 的文件恢复）、`workspaces.spec.ts`（重启后标签页、当前标签和草稿还在）、`app.spec.ts`（页面存储跨重启） | 已覆盖 |
| 9 | 状态栏显示上下文、缓存、token、速度，可选择显示哪些 | — | 待 M1.8 |
| 10 | 在 Atrium 里回答 extension 的对话框 | `apps/desktop/e2e/run-control.spec.ts`（`/faux-confirm` 的卡片上作答）；见"运行控制（M1.6）" | 已覆盖 |
| 11 | 默认只突出回复，可切换显示模式 | — | 待 M1.4 |
| 12 | 会话在后台继续运行 | — | 待 M1.9 |
| 13 | 首次启动引导安装 pi、登录、添加项目 | — | 待 M1.10 |
| 14 | 复制消息或回复 | — | 待 M1.4 |

## 进程与连接（M1.1）

| 行为 | 测试 | 状态 |
|---|---|---|
| Electron 启动宿主，窗口打开宿主提供的界面 | `apps/desktop/e2e/app.spec.ts` "opens a window on the host-served UI…" | 已覆盖 |
| 宿主不依赖 Electron，能用 node 单独运行，SIGTERM 时写完日志再退出 | `apps/desktop/e2e/host-standalone.spec.ts` | 已覆盖 |
| 正确的 token 被接受，客户端进入"已连接" | `packages/host/src/server/ws-server.host.test.ts` "records the whole connection…"；`packages/client/src/connection.test.ts` | 已覆盖 |
| 与 hello 同一次读到的下一帧不丢 | ws-server.host.test.ts "treats a frame that arrives together with the hello…" | 已覆盖 |
| 宿主只监听 IPv4 回环 | ws-server.host.test.ts "listens on IPv4 loopback only"（断言实际绑定地址） | 已覆盖 |
| 端口被占用时启动失败，失败记录写进日志、资源释放 | ws-server.host.test.ts "fails to start when the port is already taken…" | 已覆盖 |
| 关闭宿主：所有连接断开；保持中的 HTTP 连接和只发了一半的升级请求都不拖住关闭 | ws-server.host.test.ts "host lifecycle" | 已覆盖 |
| 退出应用时等宿主写完日志 | `apps/desktop/e2e/shutdown.spec.ts`："waits for a host that is slow to exit…" 用 `e2e/slow-exit-host.cjs` 包住真实宿主、把退出推迟 1.5 秒，应用不等就留不下标记文件 | 已覆盖 |
| 同一客户端的标签命令按收到的顺序生效：索引里已有的会话不等第一次扫描就打开、切换立刻生效；还不认识的会话等扫描时关掉的标签不会再打开；一条失败不耽误下一条；关闭后排队的命令不再执行；新建会话在 pi 启动后打开成所在容器的激活标签，这期间换过位置就不切过去（2026-10-08 修，原来在机器繁忙时重启后 ⌘W 偶尔无效） | `packages/host/src/sessions/session-manager.test.ts` "closes a tab closed while its opening waited for the first scan…"、"opens a session the index knows…without waiting for the first scan"、"goes on with a client's next tab change after one that failed"、"does nothing more for a client's queued tab changes once it closes"、"opens a new session's tab where it belongs but leaves the client where it went…"；`layouts.test.ts`；`apps/desktop/e2e/workspaces.spec.ts` | 已覆盖 |
| 测试里的 git 不会穿过临时根目录、操作外面的仓库（`GIT_CEILING_DIRECTORIES`）（2026-10-08 修，变异测试时曾在 atrium 自己的仓库里切分支、建分支和 worktree） | `packages/testkit/src/git.test.ts` | 已覆盖 |
| 宿主关闭时日志按写入的顺序落盘，最后一行是 "host stopped"；有写入正在进行时也一样；测试读日志前等全部落盘；写日志出错时不再一直等：等落盘的报错，关闭的直接关掉文件（2026-10-08 修，原来在机器繁忙时偶尔乱序） | `packages/host/src/platform/logger.test.ts` "drainLogFile"、"closeLogFile"（占满线程池，让一次写入一定还在进行；把流指向没打开的描述符，让写入一定失败）；`apps/desktop/e2e/shutdown.spec.ts` | 已覆盖 |
| 宿主启动中途收到退出：不在退出后报"已就绪" | `packages/host/src/electron-port.test.ts` "does not report ready, and closes the host, when shutdown arrives while it is still starting"（启动和退出由测试控制） | 已覆盖 |
| 重新连接时关闭旧连接，旧连接晚到的事件不改写新状态 | connection.test.ts "closes the previous socket on reconnect…" | 已覆盖 |
| 界面跟随系统外观 | `packages/ui/src/design/appearance.browser.test.ts`；e2e "follows the system appearance" | 已覆盖 |
| 连接状态的全部文案，包括启动中、桥接失败 | `packages/ui/src/app/connection-status.browser.test.tsx` | 已覆盖 |

## pi 链路（M1.2）

| 行为 | 测试 | 状态 |
|---|---|---|
| faux 模型在真实 pi 进程里按脚本流式输出推理和文本，以 `agent_settled` 结束 | `packages/testkit/src/faux/faux.pi.test.ts` "streams scripted thinking and text…" | 已覆盖 |
| faux 的工具调用由 pi 真实执行（`stopReason: "toolUse"`），结果进入下一轮 | faux.pi.test.ts "lets pi really run a scripted tool call…" | 已覆盖 |
| faux 的错误回复、放慢后中途中断 | faux.pi.test.ts "ends a reply scripted as an error…"、"can be interrupted mid-stream…" | 已覆盖 |
| faux 下 pi 的配置目录在测试目录里，不碰用户的 `~/.pi` | faux.pi.test.ts "keeps pi's agent directory inside the test directory…" | 已覆盖 |
| 同一脚本每次输出相同（夹具可复现） | faux.pi.test.ts "prints the same records on every run…" | 已覆盖 |
| 分帧只认 LF：U+2028/2029 和行内 CR 不断行，去掉一个结尾 CR，跨块的行和多字节字符能拼回，流结束时交出最后半行 | `packages/pi/src/process/jsonl.test.ts`；任意切块都能读回全部记录：`jsonl.prop.test.ts` | 已覆盖 |
| 按 id 对应乱序响应；失败响应带 pi 的错误文字；没有 id、对不上 id 的响应只记日志 | `packages/pi/src/process/pi-process.test.ts` "matches responses to requests by id…"、"rejects with pi's error text…"、"logs a response without an id…"、"gives up at the deadline…drops the late response" | 已覆盖 |
| 按命令设期限（`compact`、`bash` 不限时，调用方可改），期限走注入的时钟；`AbortSignal` 能取消，已取消的不发出 | pi-process.test.ts "waits for $type without a deadline"、"lets the caller lift or shorten a deadline"、"aborts a request through its signal…" | 已覆盖 |
| 事件按序交给所有监听者，一个监听者抛错不影响其他；退订生效；非 JSON、没有 type 的行只记长度 | pi-process.test.ts "events" 一组 | 已覆盖 |
| 能发 `extension_ui_response` | pi-process.test.ts "sends extension dialog answers to pi" | 已覆盖 |
| stderr 按行进日志，内存只留最后 8 KiB；不换行的输出按 16 KiB 分段记，多字节字符跨块不乱码 | pi-process.test.ts "logs stderr line by line…"、"logs output without line breaks in bounded pieces…" | 已覆盖 |
| 交给 pi 的环境不含 `ATRIUM_`、`ELECTRON_` 变量，`PATH` 去掉相对项 | `packages/pi/src/env/pi-env.test.ts`；pi-process.test.ts "never passes Atrium's or Electron's variables or relative PATH entries to pi"；inspect.test.ts "never gives pi --version a relative PATH entry…" | 已覆盖 |
| pi 不再读 stdin 时，等待中的请求（含不限时的）以 `exited` 失败并停止 pi | pi-process.test.ts "fails waiting requests, untimed ones included, and stops pi when it stops reading stdin" | 已覆盖 |
| pi 崩溃：退出码、stderr 尾部、等待中的请求失败；启动不了时报告原因 | pi-process.test.ts "reports a crash…"、"reports a pi that cannot be started" | 已覆盖 |
| 停止：先关 stdin，再 SIGTERM，最后连同脱离进程组的孙进程一起杀；停止后到达的响应被丢弃；停止完成时不留定时器；孙进程占着管道也能结束；杀进程树失败（如 `ps` 不能运行）时退而只杀 pi，停止仍能完成；强杀永不触及自己的进程组和 0、1 号进程组 | pi-process.test.ts "stop" 一组；`kill-tree.test.ts` | 已覆盖 |
| 真实 pi 跑完一轮；bash 工具运行中停止，不留子进程 | `pi-process.pi.test.ts` | 已覆盖 |
| 读登录 shell 的完整环境：交互式配置生效；值里的换行、等号完整保留；shell 自己的变量不要；token 和 Atrium、Electron 的变量不进入结果；rc 打印的横幅和回显不干扰；交互式卡住时退到登录 shell 并杀掉它启动的进程；都失败、启动不了、不支持的 shell 时沿用宿主环境（去掉这两类变量）；可中途取消；`.zshrc` 留下占着输出的后台任务时立即返回；超时时连另一个进程组里的后代一起杀，读不了进程表时退而杀 shell 的进程组；sh、dash、ksh 同样支持；shell 带着终端会有的基本变量启动；不给 shell 输入可等；shell 退出后才到的收尾标记照样等到；结束后不留定时器和 abort 监听 | `packages/host/src/platform/login-shell.test.ts` | 已覆盖 |
| 找 pi 并检查版本：找不到、可用、版本过低、不能运行（带 pi 的报错，没有报错时说明是退出码、信号还是超时）、输出没有版本；用找到的 PATH 运行 `pi --version`；不在相对路径和空项里找 pi，跳过名为 `pi` 的目录；启动不了（如解释器不存在）时给出系统的报错；`pi --version` 的期限走注入的时钟，超时或取消时用 SIGKILL 杀掉（忽略 SIGTERM 的也不留下），答复后取消期限、移除 abort 监听 | `packages/pi/src/locate/inspect.test.ts`、`locate.test.ts`；真实 pi：`locate.pi.test.ts` | 已覆盖 |
| 宿主启动后在后台读环境、找 pi，结果写日志但不写环境内容（`.zshrc` 里的 Key 不进日志）；关闭宿主时中止查找、不留 shell；`close()` 重复调用只关一次；工具环境里的凭据从日志里抹掉；查找意外失败时宿主照常运行、只是没有 pi | `packages/host/src/tools.host.test.ts` | 已覆盖 |
| `PiDeps` 的宿主实现：请求 id 取自当前 span 并编号；pi 的定时器计入宿主的定时器计数；日志按级别写、带当前 span | `packages/host/src/platform/pi-deps.test.ts` | 已覆盖 |
| pi 的启动、stderr、退出日志挂在 `pi.process` span 下；崩溃时 span 标为错误，宿主停止时为正常；每条命令一个 `pi.rpc` span，挂在调用方 span 下，请求 id 由它派生；命令失败时 span 标为错误 | `packages/host/src/sessions/traced-pi.test.ts` | 已覆盖 |
| `pnpm pi:try`：参数解析；事件渲染；找不到 pi 时退出码 1；真实 pi 流式打出回复，整次运行在一条 trace 里；模型回复失败时退出码 1，重试后成功时退出码 0；环境（含登录 shell 里的）中的凭据不进日志；中断时停掉 pi、退出码 130 | `packages/host/src/dev/try-pi.test.ts`、`try-pi.pi.test.ts` | 已覆盖 |
| pi 契约：一轮完整运行、工具调用、运行中排队与 `queue_update`、命令被处理掉、`clear_queue` + `abort`、会话文件延迟写出、`get_entries` 全量与增量和未知游标、自动重试与不可重试错误、对话框往返、压缩期间发消息报错、退出码 | `packages/pi/src/contract/*.pi.test.ts`（12 个场景，同时检查夹具） | 已覆盖 |
| 夹具：规范化（时间、度量、路径、UUID、只在固定键下识别的条目 id 及其引用，以及已认出的条目 id 在其他文字里的出现）、比较时只忽略系统消息的文字、录制顺序、文件格式；每个夹具按原样回放；回放替身的对上检查、错误详情、崩溃后和停止后的请求、`stop()` 丢弃迟到的响应并按夹具结束、对话框 | `packages/testkit/src/pi-fixtures/*.test.ts`、`packages/pi/src/contract/replay.test.ts` | 已覆盖 |
| faux：回复可以等测试放行，中断会结束等待；`/faux-noop`、`/faux-confirm` | `packages/testkit/src/faux/faux.pi.test.ts` | 已覆盖 |

## 协议、客户端与流式显示（M1.3）

| 行为 | 测试 | 状态 |
|---|---|---|
| 协议 schema：每条命令和事件按线上的 JSON 形态通过校验；未知命令和无效消息分开，能读出 `requestId` 就带上；字段越界、多余字段、错误的 traceparent 和 trace id 被拒；错误码、停止原因、运行结果、退出原因的每个取值 | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| `welcome` 带心跳间隔和每次启动都不同的宿主实例 id | ws-server.host.test.ts "welcomes with the heartbeat and an instance id…" | 已覆盖 |
| 每条命令一条应答：结果、`CommandError` 的错误码和参数、其他异常一律 `internal_error`（只记日志，不发原文）、未知和无效消息带能读出的 `requestId`；`ping` 和界面问题上报由 router 直接处理 | `packages/host/src/server/router.test.ts`；ws-server.host.test.ts 的限流、"answers only the first of two hellos" | 已覆盖 |
| 命令 span 以命令的 `traceparent` 为父，link 到连接的 `ws.connect` | router.test.ts "answers ping in a command span…"；`packages/host/src/chat.host.test.ts` | 已覆盖 |
| 心跳：宿主按注入的时钟 ping，到下一次还没 pong 的客户端被终止，正常的继续 | ws-server.host.test.ts "pings clients on the injected clock…" | 已覆盖 |
| 发送端背压：积压超过上限以 4507 关闭，之后不再发送 | `packages/host/src/server/connection.test.ts` | 已覆盖 |
| 订阅：整组替换，只对新加入的会话发快照；只把会话事件发给它的订阅者；断开时清掉 | `packages/host/src/sync/subscriptions.test.ts`；session-manager.test.ts | 已覆盖 |
| 事件翻译：真实 pi 输出（推理、文字、出错重试、中断）翻译成带自己 id 的消息和增量；工具调用先不显示且不占位；漏掉开头的块也有序号；停止原因的映射；用户消息的文字 | `packages/pi/src/events/translate.test.ts` | M1.4 改为按轮，见"对话记录（M1.4）" |
| 会话控制器：一次运行从 `agent_start` 到 `agent_settled`，带 `prompt` 的 trace；事件按序编号；用户消息带对应 `prompt` 的 `requestId`（`handled` 的跳过）；快照含流式中的消息和运行；运行结果；pi 崩溃时运行失败并报告退出，之后的 `prompt` 被拒 | `packages/host/src/sessions/session-controller.test.ts`（含夹具回放） | 已覆盖 |
| 新建对话：在 `chats/` 下建目录、在里面启动 pi、用 pi 报告的会话 id；pi 没找到、不可用或启动即退出时 `pi_unavailable`；未知会话 `session_not_found`；宿主关闭时停掉所有 pi | `packages/host/src/sessions/session-manager.test.ts` | 已覆盖 |
| 一轮对话经 WebSocket：新建、订阅得到快照、发消息得到按序编号的流式事件；两个客户端订阅同一会话收到同样的事件；真实客户端从新建到看到回复替换掉乐观显示的消息 | `packages/host/src/chat.host.test.ts` | 已覆盖 |
| 客户端连接：握手、只认真的 welcome、拒绝原因且不重试、主动断开不重试、替换连接时忽略旧 socket、断线按退避重连（最后一档重复，连上后归零）、可关闭重连、心跳 ping 到下一次没应答就断开 | `packages/client/src/atrium-client.test.ts` | 已覆盖 |
| 客户端命令：每条新的请求 id 和 trace；结果按 schema 校验；错误应答变成 `CommandError`；没有连接或断线时 `ConnectionLostError`、不重发；上报截断到 4 KB | atrium-client.test.ts | 已覆盖 |
| 会话视图：订阅时创建、退订时释放；快照整体替换；事件按序应用，缺口、重复、换代都重新取快照；流式只复制改动的那一块；乐观显示的消息在确认、失败、被 extension 处理时移除；重连后重新订阅 | `packages/client/src/session-view.test.ts`、atrium-client.test.ts | M1.4 改为按轮，见"对话记录（M1.4）" |
| 回复渲染：GFM（表格、嵌套与任务列表、删除线）、中文标点旁的加粗、`$$…$$` 与 `\(…\)` 公式而不认单个 `$`、Shiki 高亮与 diff、Mermaid、链接交给系统浏览器且不弹确认、`https` 图片直接显示而 `http` 图片变成链接、原始 HTML 按文字显示且不执行 | `packages/ui/src/chat/markdown.browser.test.tsx`、`markdown-transforms.test.ts` | 已覆盖 |
| 覆盖"回复渲染"全部范围的样例按真实节奏分片流式渲染，每一步都不出错，结束后与一次性渲染逐字节一致 | `packages/ui/src/chat/streaming.browser.test.tsx`（样例 `reply-showcase.md`） | 已覆盖 |
| 平滑揭示：只放慢增长部分；每帧按积压量揭示、约 150 毫秒的时间常数；长时间停顿也只算 250 毫秒；不切断字形，未到齐的字符等到齐；结束时一次显示完 | `packages/ui/src/chat/text-reveal.test.ts`；基准 `text-reveal.bench.ts` | 已覆盖 |
| 滚动跟随：停在底部时跟随；往上翻停止跟随并出现"回到底部"，有新内容时带圆点；点了回到底部并恢复跟随 | `packages/ui/src/chat/follow-bottom.test.ts`、`chat.browser.test.tsx` | 已覆盖 |
| 对话区：用户气泡（乐观显示的没有时间）、推理过程运行时展开结束后折叠、回复出错和已停止的标注、"进行中 · 12s"、各部分的顺序；输入框回车发送、Shift+回车换行、输入法组字时不发送；第一次发送时新建对话并订阅；发送失败的原因 | `packages/ui/src/chat/chat.browser.test.tsx` | M1.4 改为按轮，见"对话记录（M1.4）" |
| 在真实应用里发消息，推理和流式回复显示出来，运行结束后推理折叠成"思考了 N 秒"，没有残留的计时和乐观显示 | `apps/desktop/e2e/chat.spec.ts` | 已覆盖 |
| 客户端订阅和退订 1000 个会话后视图全部释放，并能被回收 | `packages/client/src/atrium-client.leak.test.ts` | 已覆盖 |
| pi 拒绝消息时的错误码：运行中或压缩中回 `session_busy`，其他拒绝回 `pi_rejected`（带 pi 原文），退出或停止回 `pi_unavailable/exited`，不回应回 `unresponsive`；回显先到、失败后到时不删别的 prompt 的位置；`prompt` 不设期限 | `packages/host/src/sessions/session-controller.test.ts`；`packages/pi/src/process/rejections.test.ts` | 已覆盖 |
| 新建对话：pi 报不出会话 id 时停掉它；管理器关闭后才建好的对话停掉自己的 pi | `packages/host/src/sessions/session-manager.test.ts` | 已覆盖 |
| 快照带 `exited`；客户端发现宿主重启后把旧会话标为已失效、保留已显示的消息、不再订阅；同一宿主重连照常订阅 | session-view.test.ts、atrium-client.test.ts | 已覆盖 |
| 心跳没应答时立刻放弃连接：等待中的命令失败、开始重连，晚到的关闭事件不重复处理；已连接时再次连接让旧命令失败；等待重连时断开变成"已断开" | atrium-client.test.ts | 已覆盖 |
| 对话界面：运行中不能发送；连按两次只建一个对话；会话已退出或已失效时下一条消息新建对话；新错误码的文字 | `packages/ui/src/chat/chat.browser.test.tsx` | 已覆盖 |
| 滚动跟随不被自己滚动的那次事件打断，即使其间内容又长高了 | follow-bottom.test.ts | 已覆盖 |
| 流式渲染走真实路径：经消息列表和平滑揭示流式显示，每一步文字只增不减，结束后在别处重新挂载，与直接渲染已完成的回复一致 | `packages/ui/src/chat/streaming.browser.test.tsx` | 已覆盖 |
| 界面的未捕获错误、未处理的 Promise 拒绝和长任务上报给宿主，每类每 10 秒最多一次，卸载后停止 | `packages/ui/src/app/issue-reporting.browser.test.ts` | 已覆盖 |
| 50 tok/s 流式输出长 Markdown 时没有超过 50 毫秒的长任务，帧时间 p95 ≤ 16.7 毫秒 | `apps/desktop/e2e/chat.perf.spec.ts` | 已覆盖 |

## 对话记录（M1.4）

| 行为 | 测试 | 状态 |
|---|---|---|
| pi 契约：一份会话历史含推理、bash/write/edit/read 工具（一次回复一个调用，pi 并行执行同一回复里的调用，事件顺序不定）、出错重试（错误回复和移除它的 `context_edit`）、手动压缩（切开一轮）、`/faux-navigate` 回到早先的条目再分支；13 路并发两轮都与夹具一致 | `packages/pi/src/contract/history.pi.test.ts`（夹具 `history.jsonl`） | 已覆盖 |
| 事件翻译：真实 pi 输出翻译成按块位置的推理、文字、完整的工具调用、工具的实时输出、结果、自动重试和压缩结束；漏掉开头的块先补开头；重复的开头只报一次；部分参数和其他更新不报；没有时间的消息用翻译器的时钟；嵌套工具调用的输出不报 | `packages/pi/src/events/translate.test.ts` | 已覆盖 |
| 条目映射：真实会话的每个条目变成 Atrium 的形状（用户、助手的推理/文字/工具调用、工具结果、压缩、重试移除、其他条目只留树中位置）；消息按自己的时间，其他条目按条目时间，读不出时为 0；流式中和延迟的停止原因算正常停止；用量只留输入输出；用户消息的图片数；替换而不是移除的 `context_edit`、`!bash` 消息不显示 | `packages/pi/src/history/log-entry.test.ts` | 已覆盖 |
| 工具详情：bash 的命令、read 的路径和范围（非整数不算）、edit 的展示 diff 和增删行数（运行中没有 diff）、write 的内容只来自参数；`file_path` 旧名；字段缺失和其他工具没有详情；内容块的文字拼接和图片计数 | `packages/pi/src/history/tools.test.ts` | 已覆盖 |
| 协议：轮、步骤（每种）、工具详情（每种）、提示条、轮级事件、带 `items` 和 `hasOlder` 的快照、`fetch_transcript` 及其结果和上限、`transcript_changed`；越界和未知取值被拒 | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| 规则：块对应的步骤和位置 id；输出按 UTF-8 字节截到 16 KB，bash 留结尾、其他留开头、不切开字符；实时输出与结果（详情按结果重算）；结束时运行中的工具改为未完成；结果按最后一条回复（完成、停止、出错带原文，工具调用后或没有回复算停止）；改动汇总（编辑累计、写入后不计行数、只算成功的、按首次出现排序）；用量相加 | `packages/host/src/transcript/rules.test.ts` | 已覆盖 |
| SessionLog：沿 pi 报告的叶子走出当前分支，其他分支不算；新条目；叶子可以不随新条目移动；缺父和环处停止；清空 | `packages/host/src/transcript/session-log.test.ts` | 已覆盖 |
| 重建：真实会话两个分支的完整结果（工具、重试、轮间压缩、分支）；插话规则；重试按 pi 的计法编号，每轮重新计；没有失败的被移除回复不算重试；轮中的压缩放在轮后、轮前的就地；回复前的孤立消息和不认识的工具结果跳过；按最后一条回复结束；用时由时间戳推算、用量相加；当场看到的轮用实时 id、`clientMessageId` 和计时 | `packages/host/src/transcript/projection.test.ts` | 已覆盖 |
| 对话记录：跟着真实会话实时构建，每次运行后用条目重建都与推过的一致，压缩后只追加提示条，换分支后报告变化；第一轮按块逐步推出的事件；按宿主时钟计时轮和推理；插话不占 `prompt` 的 id；非插话的用户消息结束上一轮；结束时未完成的工具；没有轮时忽略事件；重建不一致时报告变化；实时的轮从末尾对应到新条目；重置后重读；快照取最近 20 轮及其后的提示条；按条目往前分页 | `packages/host/src/transcript/session-transcript.test.ts` | 已覆盖 |
| 会话控制器：真实会话回放，四次运行都在同一 epoch，压缩后推 `notice_added`，换分支后 epoch 加一并推快照；`get_entries` 的游标；分页和过期 epoch、未知条目回 `transcript_changed`；运行中的轮在快照里；开始时用给定的条目；运行结果按最后一轮；崩溃时先结束轮；一次只读一页、期间再要求就再读一次；读的期间开始运行就等运行结束；运行中和退出后不读；未知游标时全部重读；其他失败上报并等下次；没有变化不推 | `packages/host/src/sessions/session-controller.test.ts` | 已覆盖 |
| 会话管理器：新建时读一次条目；运行后再读与推过的一致，不多推事件；`fetch_transcript` 交给会话；scripted pi 按次序回答同一命令（`sequence`） | `packages/host/src/sessions/session-manager.test.ts`、`chat.host.test.ts`、`server/router.test.ts` | 已覆盖 |
| 客户端会话视图：轮的开始、步骤增加、增量、更新、结束、提示条；只复制改动的轮和步骤；找最后一个同 id 的轮；新 epoch 的快照整体替换；对不上的步骤事件重新取快照；更早的页放在前面，过期 epoch 或已不在最前的丢弃 | `packages/client/src/session-view.test.ts` | 已覆盖 |
| 客户端分页：一次只取一页，同时的请求共用一次；不在观察、加载中、已失效或没有更早的不取；`transcript_changed` 时重新取快照，其他失败往上抛 | `packages/client/src/atrium-client.test.ts` | 已覆盖 |
| 界面的轮：过程折叠成标题行（"已完成，用时 · 读了 · 跑了 · 改了 · N 条命令失败"），折叠时插话仍可见；只有推理时显示"思考了 N 秒"或"思考过程"；没有过程时没有标题行；点击步骤展开详情（命令输出、截断说明、带行号和增删竖条的 diff）；显示模式（摘要、思考、详细）与切换；运行中展开、正在进行的步骤转圈并实时显示；已停止、出错（可展开原始报错）；信息行（复制、"···"复制为 Markdown、改动胶囊展开文件和 diff、用量、结束时间）；菜单按 Esc 和点击外部关闭；提示条展开压缩摘要 | `packages/ui/src/chat/turn.browser.test.tsx`；纯函数：`turn-layout.test.ts` | 已覆盖 |
| 会话文件与打开会话：M1.4 的"最近会话"列表在 M1.5 由侧栏和"历史"取代，读取和打开的测试见"项目、工作区与会话（M1.5）" | — | 已取代 |
| 用 pi 写的真实会话文件恢复：工具、重试、压缩在当前分支上，另一个分支不显示，提示条在它所在的轮之后，过程标题行的统计；接着发消息照常运行 | `apps/desktop/e2e/history.spec.ts` | 已覆盖 |
| 审查后补上（2026-10-08）：当场看到的轮和插话按记录重建（停在工具结果之后的下一轮仍是新的一轮）；上下文溢出的恢复不算重试；空报错按 pi 写 "Unknown error"；任何位置新增的提示条都推 `notice_added` 并带插入位置；pi 崩溃中断的一轮为 `failed`；长文字以预览发送、标 `partial`，`fetch_step` 取回完整步骤，快照和分页按 4 MB 装；`write` 的内容只发一份；打开目录已不存在的会话回 `session_cwd_missing`；刷新失败的日志只记命令和原因；扫描会话目录只认 LF、可随关闭中止；界面的时间经注入的时钟；导出遇到重建时报错而不是导出一部分 | `packages/host/src/transcript/*.test.ts`、`sessions/*.test.ts`、`packages/client/src/*.test.ts`、`packages/pi/src/sessions/session-files.test.ts`、`packages/ui/src/chat/*.test.ts(x)` | 已覆盖 |
| 同一回复里的并行工具调用：只由手写的条目和事件覆盖（重建、实时），录制的场景每次回复只调一个工具，因为 pi 并行执行时事件顺序不定 | `projection.test.ts`、`session-transcript.test.ts`、`translate.test.ts` | 部分覆盖 |
| 打开 1000 轮的会话到首屏 ≤ 500 毫秒（中位数，实测约 25 毫秒；第一次打开含启动 pi 约 1 秒） | `apps/desktop/e2e/history.perf.spec.ts` | 已覆盖 |
| 2000 轮会话的对话记录重建（基准，本机中位约 2.4 毫秒） | `packages/host/src/transcript/rebuild.bench.ts` | 已覆盖 |
| 对话区：轮、提示条、待确认的消息、运行状态的顺序；运行的计时在轮里；滚到顶加载更早的，且阅读位置不动；提问导航条跳转；长消息折叠与展开；Ctrl+O 和菜单切换显示模式；导出会话时取完所有页 | `packages/ui/src/chat/chat.browser.test.tsx`、`packages/ui/src/app/workbench.browser.test.tsx`、`packages/ui/src/tabs/session-menus.test.ts` | 已覆盖 |

## 项目、工作区与会话（M1.5）

| 行为 | 测试 | 状态 |
|---|---|---|
| 索引文件：原子写入、权限 0600；版本逐级升级并留 `.v<N>.bak`；新版本拒绝且不改文件；不是 JSON、版本无效、格式不符、缺少升级步骤时挪成 `.corrupt-<时间>.json` 并从空开始；保留不认识的字段；写入期间的多次保存只写最新的一次；写入失败不留临时文件、之后还能再写；缺文件不算损坏 | `packages/host/src/store/index-file.test.ts` | 已覆盖 |
| 宿主单实例：锁文件记进程号和启动时间；活着的宿主占着就拒绝；进程已不在、早于开机、内容损坏或形状不对时接管；只删自己的锁；同一家目录第二个宿主启动失败、第一个关掉后能启动；启动失败也释放锁 | `packages/host/src/store/host-lock.test.ts`、`server/ws-server.host.test.ts` | 已覆盖 |
| 应用单实例：同一家目录第二次打开时退出并让第一个窗口回到前面；设了 `ATRIUM_HOME` 时 Electron 的数据跟着它 | `apps/desktop/e2e/app.spec.ts` | 已覆盖 |
| 损坏的索引文件在列表里报告一次、界面提示到关掉为止；新版本格式拒绝启动、改回后能启动；偏好和每个客户端的布局跨重启保留 | `packages/host/src/index.host.test.ts`、`packages/ui/src/app/workbench.browser.test.tsx` | 已覆盖 |
| git 调用：用工具环境、关可选锁、不弹提示、固定语言；最多同时 4 个、其余排队；按注入的时钟超时（默认 30 秒）；取消；起不来时报 `spawn` 并释放名额；非零退出是结果不是错误 | `packages/host/src/platform/git.test.ts` | 已覆盖 |
| 合并状态（真实 git）：目录没了是已移除；Atrium 建的、没提交的是无改动；有提交是 `pending` 并数出 ↑N；merge、快进、squash（主干之后又改了别处）、cherry-pick 都算已合并；主干回滚了改动、冲突算 `pending`；外部 worktree 按 reflog 区分无改动和已合并（含 amend、只快进到主干）；没有分支或 reflog 时无法判断；没有主干时无法判断但仍报未提交；git 低于 2.38 不模拟合并；git 出错；同样的提交只判断一次，`git status` 每次都跑，知道是否未提交时可以跳过 | `packages/host/src/workspaces/merge-inspector.test.ts`、`worktree-list.test.ts` | 已覆盖 |
| 项目登记：真实路径；不存在或不是目录报 `path_not_found`；已是项目、已是某个项目的 worktree（含反过来）报 `project_exists`；仓库的子目录、没有 git 或 git 出错时当普通目录；重名加序号；同时添加同一目录只成功一个；移除只删索引；改名与重名；工作区改名和清除；只为已登记的项目记新 worktree | `packages/host/src/projects/project-service.test.ts` | 已覆盖 |
| 工作区扫描：本地工作区和各 worktree（记成外部）、分支、detached 的短提交、创建时间；目录没了和被 prune 后是已移除；普通目录、仓库子目录、没有 git 时没有分支和合并状态；没有 `origin/HEAD` 时无法判断，项目设了主干就按它；运行结束后重扫、没变化不通知；每 5 分钟和窗口聚焦（至少隔一分钟）fetch，之后不跑 `git status`；没有 `origin` 的跳过，普通目录不 fetch 它所在的仓库，目录名以空格结尾的仓库照常 fetch，fetch 失败记日志；新加的项目立刻扫描；git 出错时保留上次的结果并按原因记日志；关闭后停掉定时器 | `packages/host/src/workspaces/workspace-service.test.ts` | 已覆盖 |
| 会话文件：真实文件的会话 id、工作目录、会话名（最新的 `session_info`，去空白，空的清除）、第一条带文字的提问；不是会话的文件、坏链接、目录、其他文件、缺的和锁住的目录都跳过；只按 LF 分行；跨块的大文件；文件只增长时只读新增部分，没变的不重读，变小或没变长却改过的从头读；写了一半的行和文件头等写完；文件没了忘掉，同一路径的新文件整个读；只清理扫描的那个目录；可中止；不留打开的文件；会话目录按 pi 的顺序、目录名按 pi 的规则 | `packages/pi/src/sessions/session-files.test.ts` | 已覆盖 |
| 会话目录：只读已登记容器对应的目录并核对 `cwd`；Atrium 建的会话按记录的容器，容器不在了按目录；草稿在文件出现前列出，出现后不再是草稿；文件没了是 `missing`；丢弃草稿；归档（终端会话也记下）；每个对话目录都归"对话"，新对话不等扫描；同一会话多个文件取最新并记日志；pi 全放一个目录时也能分开；不知道目录时只列记录；只在变化时通知、扫描期间的请求合并；关闭后停止 | `packages/host/src/sessions/session-catalog.test.ts`；兜底标题：`prompt-line.test.ts` | 已覆盖 |
| 布局：每个客户端分开；打开的标签按顺序、激活、切换容器；关掉激活的标签时右边的、再左边的接上；各客户端关掉某会话的标签；去掉消失的容器；只留最近的 10 个客户端 | `packages/host/src/sessions/layouts.test.ts`；客户端的即时更新：`packages/client/src/index-view.test.ts` | 已覆盖 |
| 会话管理器：新建对话（自己的目录）和工作区会话都立刻启动 pi、记成草稿、打开成标签；pi 不可用时不留目录；打开终端会话用 `--session`、同时只启动一个、退出后在新 epoch 重启并给订阅者快照；目录没了、文件没了时报错不启动；重启后的草稿不启动，第一条消息时用 `--session-id`；没发过消息的草稿关掉最后一个标签时丢弃（对话的空目录一并删、有文件的留下），发过消息的保留；归档停掉 pi 并关掉各处标签；改名先启动 pi；项目移除时停掉其中的会话；运行状态进列表、运行结束重扫；插话记录读入和写回，读写失败只记日志 | `packages/host/src/sessions/session-manager.test.ts` | 已覆盖 |
| 插话记录：存进 `turns/<会话 id>.json`，每个条目只记一次；不适合做文件名的 id 只放内存；损坏时重来；重建时按记录把工具结果之后的消息当新的一轮，没有记录时按位置推断 | `packages/host/src/store/turn-starts.test.ts`、`transcript/projection.test.ts`、`session-transcript.test.ts` | 已覆盖 |
| 列表推送：订阅时马上给自己客户端的快照；一段时间内的变化合并成一份推给所有订阅者；断开后不再推；关闭时丢掉待推的 | `packages/host/src/sync/index-feed.test.ts`、`subscriptions.test.ts` | 已覆盖 |
| 协议与路由：新命令、快照的每种取值和越界、新错误码；路由把布局类命令连同客户端交给会话层，列表命令交给索引命令 | `packages/protocol/src/envelope.test.ts`、`packages/host/src/server/router.test.ts` | 已覆盖 |
| 客户端：每次连上都订阅列表；第一份快照前为空，之后只收同一宿主更新的快照；开标签、关标签、切容器、改偏好立刻反映；各命令的字段和结果 | `packages/client/src/atrium-client.test.ts`、`index-view.test.ts` | 已覆盖 |
| 宿主层：添加项目后推来工作区、合并状态，聚焦后出现终端会话，worktree 不能再登记成项目；偏好和布局跨重启；损坏重置；新版本拒绝启动 | `packages/host/src/index.host.test.ts` | 已覆盖 |
| 侧栏：工作区按本地、新到旧、已收尾排序，合并标签、运行状态、本地的提示；点击切换；项目折叠后显示待合并数和运行状态并记住；添加项目（取消不添加）、已存在时说明是哪个项目；搜索工作区和会话（不分大小写，结果保留到关闭）、没有匹配；最近 5 个对话和"全部 N 个对话"；工作区和项目改名、移除项目；外观三档切换并通知窗口 | `packages/ui/src/app/workbench.browser.test.tsx`；纯函数：`packages/ui/src/sidebar/names.test.ts` | 已覆盖 |
| 标签栏与对话区：当前容器的标签、激活、切换、关闭；"历史"按新到旧、标出已打开、不含归档；"+"新建；会话"···"改名、归档、复制路径（草稿不可复制）；快捷键 ⌘N、⌘T（不在任何容器时新建对话）、⌘W、⌘1–9、⌘⇧[ ]；窗口聚焦通知宿主；空状态说明会话建在哪里；第一条消息在当前位置新建会话并等它建好；退出或丢失的会话先重新打开再发 | `packages/ui/src/app/workbench.browser.test.tsx`、`packages/ui/src/chat/chat.browser.test.tsx` | 已覆盖 |
| 审查后补上（2026-10-08）：pi 没在跑的会话可以先订阅、启动后补快照，消息会先启动它，启动失败时标签还在；重启后的当前标签能显示对话；第一次扫描完成前不把会话当作文件不见了，丢弃草稿前再扫一次、启动中和发送中的不丢；草稿不能改名；正在新建的会话按容器分开；移除项目先停掉其中的会话；`atrium://` 的其他主机不能导航过去；宿主锁按进程启动时间认持有者、接管时只有一个能成、残留的接管锁也能接管；git 去掉 PATH 里的相对项、超时结束整个进程组、输出过大放弃；合并判定按工作区和分支缓存、不缓存失败；git 一时读不了仓库时保留上次结果；选中 worktree 时登记它的主仓库；添加项目串行；写入失败期间保存的内容照样写出；列表推送关闭后不再挂定时器；"状态未知"标签 | `session-manager.test.ts`、`index-commands.test.ts`、`session-catalog.test.ts`、`host-lock.test.ts`、`git.test.ts`、`merge-inspector.test.ts`、`workspace-service.test.ts`、`project-service.test.ts`、`index-file.test.ts`、`index-feed.test.ts`、`chat.browser.test.tsx`、`workbench.browser.test.tsx`、`app.spec.ts`、`workspaces.spec.ts` | 已覆盖 |
| 端到端：真实 git 项目的 worktree 和普通目录在侧栏里和 git 一致，worktree 里提交后聚焦显示 ↑1，终端里开的会话聚焦后出现在对应工作区的"历史"；新建会话成标签，重启后标签、当前标签和草稿还在，⌘W 丢弃空草稿；从侧栏和"历史"打开 pi 的会话文件 | `apps/desktop/e2e/workspaces.spec.ts`、`history.spec.ts`、`history.perf.spec.ts` | 已覆盖 |
| 变异测试补测（2026-10-09，M1.6 时重测超时的变异后发现）：项目路径与 git 目录分开的仓库、只问所选目录；未知项目的移除不改动任何东西、改名；版本低于 1、没有升级步骤的旧版本挪开；每种文件缺字段时重置并记下挪到哪里；插话记录的单字符 id、已知条目不重写；合并判定的提交来源（含 `git am`、`git pull` 的合并，2026-10-09 补上）、版本号、只问给出的主分支、失败不缓存；worktree 列表的分支前缀、最后一条记录；会话文件的头部、`session_info` 的名字、读不了的文件下次从头读；工作区服务：公共目录名以空格结尾、只扫描新加的项目、裸仓库、被锁定且目录没了的 worktree、fetch 后的未提交状态、关闭时停止、fetch 的期限、日志 | `project-service.test.ts`、`index-commands.test.ts`、`index-file.test.ts`、`index-schema.test.ts`、`load-index.test.ts`、`turn-starts.test.ts`、`merge-inspector.test.ts`、`worktree-list.test.ts`、`packages/pi/src/sessions/session-files.test.ts`、`workspace-service.test.ts` | 已覆盖 |

## 运行控制（M1.6）

| 行为 | 测试 | 状态 |
|---|---|---|
| 协议：控制状态、`control_updated`、`prompt_handled`、九条新命令及其应答（`prompt` 的 `queued` 带 `itemId`、`stop` 的 `confirmed`）、三个新错误码；对话框回答只能是值、确认或取消之一；自动发出的标记和重启提示 | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| pi 的事件翻译：压缩开始、插话队列（每次完整，只取插话）、四种对话框（超时为 0 或没有即不限时）、通知及其级别；重试带 pi 的上限；终端专用的请求不翻译 | `packages/pi/src/events/translate.test.ts` | 已覆盖 |
| pi 契约（1.1.0）：运行中插话在 `queue_update` 里列出，工具这一批跑完后送达再清空；空闲时插话只进 pi 的队列、不开始运行 | `packages/pi/src/contract/steer.pi.test.ts` | 已覆盖 |
| 排队：运行或压缩期间的消息进宿主排队，运行结束、`handled` 后、压缩结束后逐条发出；编辑、删除、清空；不认识的项应答 `queue_item_not_found`；出队的那条被拒绝时先放回最前、后面的不抢先：pi 忙就等它自己的运行结束，pi 退出就交给重启后由排队发出（只发一次），其他拒绝暂停 | `packages/host/src/sessions/session-controller.test.ts` "queueing messages" | 已覆盖 |
| 插话：运行中交给 pi，发出前先记下，`queue_update` 先到也对得上，送达后应答才到也不残留；按 `queue_update` 的文字确认送达；没有运行时（空闲、消息发送中）按消息走、该排队就排队；被扩展处理时去掉待发副本；排队项改为插话，失败时放回原处 | session-controller.test.ts "steering" | 已覆盖 |
| 停止：暂停排队，pi 退回的插话放回最前，`abort`；2 秒内确认即结束，否则保持"停止中"、拒收消息和继续发送，直到 pi 确认或退出；空闲时直接确认；pi 已应答、`agent_start` 未到时也中止；`abort` 失败不算确认，等到 pi 退出；停止后空闲时新消息直接发出，排队仍暂停 | session-controller.test.ts "stopping" | 已覆盖 |
| 对话框：保留到回答，只收第一个、类型要对得上；到期移除；pi 退出时作废；结束时在对话记录里留一行（回答、取消、超时、作废），运行中结束的跟在这一轮后面、重建后仍在；通知截断到 4 KB 写日志，带原长度 | session-controller.test.ts "answering dialogs" | 已覆盖 |
| 崩溃：重启 pi（新 epoch 快照 + "进程已自动重启"提示），pi 没收下的消息重发，收下了就补发"系统自动发出"的续做；未送达的插话回到排队；连续 3 次失败后出错；运行正常结束后计数归零；宿主要求的停止不重启；pi 应答后、`agent_start` 前崩溃也重发；重发时 pi 又走了，被打断的那条留给下一次重启；停止后崩溃不发出，没收下的那条进暂停的排队；重启中消息排队、停止让它和被打断的那条留在暂停的排队；另一处启动换上的 pi 直接用；停止的运行也让计数归零；"重试"续做失败的一轮、或重发重启用尽时丢失的消息（收下了就补发续做），启动失败时保留失败状态，启动期间算作重启中、再点重试不起作用、关闭会话停掉新 pi；续做的那一轮记为自动发出 | session-controller.test.ts "after pi crashes"、"retrying"；`session-manager.test.ts`（崩溃后用会话文件重启、用尽后列为出错；继续发送时启动放弃重启的 pi；重启中发消息或打开会话不另起 pi；重启中归档或关闭宿主不再启动；启动时开启自动重试） | 已覆盖 |
| 对话记录：自动发出的标记当场和重建后都在，记进 `turns/`；重启提示在重建后回到它跟着的那一项后面；重试步骤带 pi 的上限，重建后保留 | `packages/host/src/transcript/session-transcript.test.ts`、`store/turn-starts.test.ts` | 已覆盖 |
| 客户端：控制状态、`prompt_handled` 去掉待发副本；排队或被插话收下的消息去掉待发副本；运行控制命令的字段与结果 | `packages/client/src/session-view.test.ts`、`atrium-client.test.ts` | 已覆盖 |
| 界面：运行中回车排队、⌘回车插话、Esc 和按钮停止，停止中按钮不可用；胶囊条（排队、已暂停与继续发送、编辑删除插话清空、待送达插话数）；四种对话框卡片与倒计时；连续崩溃的错误卡片；最后一轮失败时的"重试"，重启中不给；重启提示、对话框结果提示与"系统自动发出"；停止中输入框保留文字、不发送；重试显示"第 N / M 次"或"第 N 次"；出错的会话在标签、工作区上显示"出错"，高于运行中 | `packages/ui/src/chat/run-control.browser.test.tsx`、`chat.browser.test.tsx`、`turn-layout.test.ts`、`app/workbench.browser.test.tsx` | 已覆盖 |
| 杀掉 pi 后自动恢复（端到端） | `apps/desktop/e2e/run-control.spec.ts` | 已覆盖 |
| 测试工具：faux 写下 pi 的进程号；夹具把工具耗时规范化为 0 | `packages/testkit/src/faux/faux.pi.test.ts`、`pi-fixtures/normalize.test.ts` | 已覆盖 |

## 安全（security.md）

| 要求 | 测试 | 状态 |
|---|---|---|
| 错误 token 被拒绝（4401），日志里没有真 token；同源页面也必须带对 token | ws-server.host.test.ts "rejects a wrong token…"、"lets a page served by the host itself connect, but still requires the token" | 已覆盖 |
| 外来 Origin 在升级时被拒（403） | ws-server.host.test.ts "refuses a browser from a foreign origin…" | 已覆盖 |
| 只认第一条 hello；格式错误、版本不符、超时各有关闭码 | ws-server.host.test.ts "closes the socket on …"、"drops a client that never says hello…"、"answers only the first of two hellos" | 已覆盖 |
| 连接数、消息速率、字节速率、单条大小的上限 | ws-server.host.test.ts "disconnects a client that sends more than 200 messages…"、"…more than 8 MiB…"、"closes a connection that sends a message over 1 MiB…"、"refuses connections beyond 32 at once" | 已覆盖 |
| token 强度（单独运行与 Electron 两条路径） | `packages/host/src/server/auth.test.ts`；host-standalone.spec.ts "refuses a weak token…" | 已覆盖 |
| 渲染进程拿不到 Node，桥上只有 bootstrap、选择文件夹、窗口外观 | e2e "gives the page no Node access and only the bridge…" | 已覆盖 |
| 窗口页面从固定的 `atrium://app` 加载，CSP 只多允许连宿主端口，存储跨重启保留 | e2e "opens a window on the host's UI at a fixed origin…"、"keeps the page's storage across a restart…" | 已覆盖 |
| git 的输出、fetch 失败的原文不进日志，只记命令和原因；索引文件损坏只记文件名 | `workspace-service.test.ts` "logs a scan git could not run by its reason…"、"skips projects without an origin and logs a fetch that fails"；`index.host.test.ts` | 已覆盖 |
| 不能导航到别的源、不能开新窗口，链接交给系统浏览器 | e2e "keeps the page on its own origin…"（目标服务器零请求，`shell.openExternal` 被调用） | 已覆盖 |
| 宿主页面带 CSP、nosniff；开发页面也带 CSP | ws-server.host.test.ts "serves the UI with the full content security policy…"；`apps/desktop/e2e/dev.spec.ts` | 已覆盖 |
| 静态文件不越出 UI 目录：路径穿越、符号链接 | `packages/host/src/server/static-files.test.ts`；ws-server.host.test.ts "does not follow a symlink out of the UI directory…" | 已覆盖 |
| 读不了的文件、中途断开的下载不让宿主崩溃 | ws-server.host.test.ts "answers 404 for a file it cannot read…"、"survives a client that disconnects…" | 已覆盖 |
| 日志脱敏：凭据键、已知秘密、格式化参数、`Error`、子 logger 绑定 | `packages/host/src/platform/logger.test.ts`、`redact.test.ts`、`redact.prop.test.ts`；e2e "…never logs the token" | 已覆盖 |
| pi 的环境里名字像凭据的变量值加入脱敏列表，pi 在 stderr 回显也不进日志 | redact.test.ts "picks the values of credential-like variables…"；tools.host.test.ts "scrubs credentials from the tool environment…"；try-pi.test.ts "keeps credentials from the environment out of its log…" | 已覆盖 |
| pi 从 `auth.json` 读的 Key 被 pi 回显时不进日志（已知缺口，见 security.md"凭据与日志"） | — | 待 M1.10 |
| 新建的 `~/.atrium` 权限 0700、日志 0600；已有目录不改权限 | `packages/host/src/platform/home.test.ts`；`logger.test.ts` "creates log files readable only by their owner, rotated ones included" | 已覆盖 |
| 索引文件 0600、`turns/` 目录 0700；插话记录的文件名只用 pi 形状的会话 id | `packages/host/src/store/index-file.test.ts`、`turn-starts.test.ts` | 已覆盖 |

## 日志与链路追踪（observability.md）

| 要求 | 测试 | 状态 |
|---|---|---|
| traceparent 的生成、格式化、解析 | `packages/protocol/src/trace.test.ts`、`trace.prop.test.ts` | 已覆盖 |
| 宿主 span 挂在客户端的 trace 下，日志带 trace_id | ws-server.host.test.ts "records the whole connection…"；e2e "records the connection under one trace id…" | 已覆盖 |
| 日志磁盘上最多保留 5 个（含之前运行的）；`current.log` 是普通文件时能自愈；日志流出错不崩溃 | logger.test.ts "openLogFile" | 已覆盖 |
| 未结束的 span 计入资源计数 | `packages/host/src/server/connections.leak.test.ts` | 已覆盖 |
| `pnpm trace` 打印链路，跳过不完整的行 | `scripts/trace.test.ts`（跨轮转文件、别的 trace、半行、无记录、用法错误） | 已覆盖 |

## 资源与性能（testing.md）

| 要求 | 测试 | 状态 |
|---|---|---|
| 200 次连接（每次都订阅索引）、50 次拒绝后资源计数和 Node 真实定时器都回到基线；常驻的只有资源报告和后台 fetch 两个定时器，git 进程为 0 | connections.leak.test.ts | 已覆盖 |
| 真实 pi 启动、停止 200 次后，资源计数、定时器、子进程、管道句柄都回到基线，每个 pi 进程及其进程组都已消失 | `packages/pi/src/process/pi-process.leak.test.ts` | 已覆盖 |
| 会话控制器 200 轮对话框（回答、取消、超时、作废）、停止（立即确认、超时后确认）、崩溃重启后，没有待触发的定时器，旧 pi 上没有留下监听 | `packages/host/src/sessions/session-controller.leak.test.ts` | 已覆盖 |
| 测试失败、超时或被杀时不留临时目录 | 根目录 `test-temp-root.ts`（Vitest、Playwright 全局初始化）；验证方法见 testing.md"临时文件与残留进程" | 已覆盖 |
| 定时器计数与释放 | `packages/host/src/platform/clock.test.ts` | 已覆盖 |
| 外观来回切换不留下脱离的 DOM | `apps/desktop/e2e/appearance.leak.spec.ts`。这个测试看不到事件监听器泄漏；外观监听器的移除由 appearance.browser.test.ts 断言 | 已覆盖 |
| 启动到连上宿主 ≤ 2 秒 | `apps/desktop/e2e/startup.perf.spec.ts` | 已覆盖 |
| 长时间运行：资源回到基线，内存增长每次 < 1KB | `packages/host/test/soak/connections.soak.test.ts` | 已覆盖 |
| 热路径基准 | `packages/protocol/src/trace.bench.ts`（traceparent 解析）；`packages/pi/src/process/jsonl.bench.ts`（分帧：大量小记录、16 MiB 单行，后者能抓住每块重扫整个缓冲的退化） | 已覆盖 |
