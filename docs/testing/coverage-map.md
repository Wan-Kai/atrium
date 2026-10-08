# 测试追踪表

> 每条需求、关键流程、错误路径和安全要求，对应到证明它的测试。规则见 [testing.md](../architecture/testing.md#让覆盖面全)。
>
> 新增行为时在这里登记；一个里程碑完成前，它涉及的行都要有测试，并通过变异门槛。"待 M1.x"表示计划在该里程碑补上。

## SPEC-0001 需求

| # | 需求 | 测试 | 状态 |
|---|---|---|---|
| 1 | 侧栏按项目和工作区组织，显示运行、待处理、合并状态；标签页切换会话 | — | 待 M1.5 |
| 2 | 流式输出回复和推理过程 | `apps/desktop/e2e/chat.spec.ts`、`chat.perf.spec.ts`；组件与渲染见"协议、客户端与流式显示（M1.3）" | 已覆盖 |
| 3 | 粘贴或拖入截图随消息发出 | — | 待 M1.6 |
| 4 | 看到工具调用：命令和输出、读的文件、diff、写入的文件 | — | 待 M1.4 |
| 5 | 随时中断 | — | 待 M1.6 |
| 6 | 运行中默认排队，可插话 | — | 待 M1.6 |
| 7 | 输入框旁切换模型和推理强度 | — | 待 M1.6 |
| 8 | 重启后恢复之前的会话 | — | 待 M1.4、M1.5 |
| 9 | 状态栏显示上下文、缓存、token、速度，可选择显示哪些 | — | 待 M1.6 |
| 10 | 在 Atrium 里回答 extension 的对话框 | — | 待 M1.6 |
| 11 | 默认只突出回复，可切换显示模式 | — | 待 M1.4 |
| 12 | 会话在后台继续运行 | — | 待 M1.7 |
| 13 | 首次启动引导安装 pi、登录、添加项目 | — | 待 M1.8 |
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
| 事件翻译：真实 pi 输出（推理、文字、出错重试、中断）翻译成带自己 id 的消息和增量；工具调用先不显示且不占位；漏掉开头的块也有序号；停止原因的映射；用户消息的文字 | `packages/pi/src/events/translate.test.ts` | 已覆盖 |
| 会话控制器：一次运行从 `agent_start` 到 `agent_settled`，带 `prompt` 的 trace；事件按序编号；用户消息带对应 `prompt` 的 `requestId`（`handled` 的跳过）；快照含流式中的消息和运行；运行结果；pi 崩溃时运行失败并报告退出，之后的 `prompt` 被拒 | `packages/host/src/sessions/session-controller.test.ts`（含夹具回放） | 已覆盖 |
| 新建对话：在 `chats/` 下建目录、在里面启动 pi、用 pi 报告的会话 id；pi 没找到、不可用或启动即退出时 `pi_unavailable`；未知会话 `session_not_found`；宿主关闭时停掉所有 pi | `packages/host/src/sessions/session-manager.test.ts` | 已覆盖 |
| 一轮对话经 WebSocket：新建、订阅得到快照、发消息得到按序编号的流式事件；两个客户端订阅同一会话收到同样的事件；真实客户端从新建到看到回复替换掉乐观显示的消息 | `packages/host/src/chat.host.test.ts` | 已覆盖 |
| 客户端连接：握手、只认真的 welcome、拒绝原因且不重试、主动断开不重试、替换连接时忽略旧 socket、断线按退避重连（最后一档重复，连上后归零）、可关闭重连、心跳 ping 到下一次没应答就断开 | `packages/client/src/atrium-client.test.ts` | 已覆盖 |
| 客户端命令：每条新的请求 id 和 trace；结果按 schema 校验；错误应答变成 `CommandError`；没有连接或断线时 `ConnectionLostError`、不重发；上报截断到 4 KB | atrium-client.test.ts | 已覆盖 |
| 会话视图：订阅时创建、退订时释放；快照整体替换；事件按序应用，缺口、重复、换代都重新取快照；流式只复制改动的那一块；乐观显示的消息在确认、失败、被 extension 处理时移除；重连后重新订阅 | `packages/client/src/session-view.test.ts`、atrium-client.test.ts | 已覆盖 |
| 回复渲染：GFM（表格、嵌套与任务列表、删除线）、中文标点旁的加粗、`$$…$$` 与 `\(…\)` 公式而不认单个 `$`、Shiki 高亮与 diff、Mermaid、链接交给系统浏览器且不弹确认、`https` 图片直接显示而 `http` 图片变成链接、原始 HTML 按文字显示且不执行 | `packages/ui/src/chat/markdown.browser.test.tsx`、`markdown-transforms.test.ts` | 已覆盖 |
| 覆盖"回复渲染"全部范围的样例按真实节奏分片流式渲染，每一步都不出错，结束后与一次性渲染逐字节一致 | `packages/ui/src/chat/streaming.browser.test.tsx`（样例 `reply-showcase.md`） | 已覆盖 |
| 平滑揭示：只放慢增长部分；每帧按积压量揭示、约 150 毫秒的时间常数；长时间停顿也只算 250 毫秒；不切断字形，未到齐的字符等到齐；结束时一次显示完 | `packages/ui/src/chat/text-reveal.test.ts`；基准 `text-reveal.bench.ts` | 已覆盖 |
| 滚动跟随：停在底部时跟随；往上翻停止跟随并出现"回到底部"，有新内容时带圆点；点了回到底部并恢复跟随 | `packages/ui/src/chat/follow-bottom.test.ts`、`chat.browser.test.tsx` | 已覆盖 |
| 对话区：用户气泡（乐观显示的没有时间）、推理过程运行时展开结束后折叠、回复出错和已停止的标注、"进行中 · 12s"、各部分的顺序；输入框回车发送、Shift+回车换行、输入法组字时不发送；第一次发送时新建对话并订阅；发送失败的原因 | `packages/ui/src/chat/chat.browser.test.tsx` | 已覆盖 |
| 推理折叠后显示"思考了 N 秒"、显示模式切换 | — | 待 M1.4 |
| 在真实应用里发消息，推理和流式回复显示出来，运行结束后没有残留的计时和乐观显示 | `apps/desktop/e2e/chat.spec.ts` | 已覆盖 |
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
| pi 契约：一份会话历史含推理、bash/write/edit/read 工具、出错重试（错误回复和移除它的 `context_edit`）、手动压缩（切开一轮）、`/faux-navigate` 回到早先的条目再分支 | `packages/pi/src/contract/history.pi.test.ts`（夹具 `history.jsonl`） | 已覆盖 |
| 条目映射：真实会话的每个条目变成 Atrium 的形状（用户、助手的推理/文字/工具调用、工具结果、压缩、重试移除、其他条目只留树中位置）；消息按自己的时间，其他条目按条目时间，读不出时为 0；流式中和延迟的停止原因算正常停止；用量只留输入输出；用户消息的图片数；替换而不是移除的 `context_edit`、`!bash` 消息不显示 | `packages/pi/src/history/log-entry.test.ts` | 已覆盖 |
| 工具详情：bash 的命令、read 的路径和范围（非整数不算）、edit 的展示 diff 和增删行数（运行中没有 diff）、write 的内容只来自参数；`file_path` 旧名；字段缺失和其他工具没有详情；内容块的文字拼接和图片计数 | `packages/pi/src/history/tools.test.ts` | 已覆盖 |

## 安全（security.md）

| 要求 | 测试 | 状态 |
|---|---|---|
| 错误 token 被拒绝（4401），日志里没有真 token；同源页面也必须带对 token | ws-server.host.test.ts "rejects a wrong token…"、"lets a page served by the host itself connect, but still requires the token" | 已覆盖 |
| 外来 Origin 在升级时被拒（403） | ws-server.host.test.ts "refuses a browser from a foreign origin…" | 已覆盖 |
| 只认第一条 hello；格式错误、版本不符、超时各有关闭码 | ws-server.host.test.ts "closes the socket on …"、"drops a client that never says hello…"、"answers only the first of two hellos" | 已覆盖 |
| 连接数、消息速率、字节速率、单条大小的上限 | ws-server.host.test.ts "disconnects a client that sends more than 200 messages…"、"…more than 8 MiB…"、"closes a connection that sends a message over 1 MiB…"、"refuses connections beyond 32 at once" | 已覆盖 |
| token 强度（单独运行与 Electron 两条路径） | `packages/host/src/server/auth.test.ts`；host-standalone.spec.ts "refuses a weak token…" | 已覆盖 |
| 渲染进程拿不到 Node，只有 bootstrap 桥 | e2e "gives the page no Node access…" | 已覆盖 |
| 不能导航到别的源、不能开新窗口，链接交给系统浏览器 | e2e "keeps the page on its own origin…"（目标服务器零请求，`shell.openExternal` 被调用） | 已覆盖 |
| 宿主页面带 CSP、nosniff；开发页面也带 CSP | ws-server.host.test.ts "serves the UI with the full content security policy…"；`apps/desktop/e2e/dev.spec.ts` | 已覆盖 |
| 静态文件不越出 UI 目录：路径穿越、符号链接 | `packages/host/src/server/static-files.test.ts`；ws-server.host.test.ts "does not follow a symlink out of the UI directory…" | 已覆盖 |
| 读不了的文件、中途断开的下载不让宿主崩溃 | ws-server.host.test.ts "answers 404 for a file it cannot read…"、"survives a client that disconnects…" | 已覆盖 |
| 日志脱敏：凭据键、已知秘密、格式化参数、`Error`、子 logger 绑定 | `packages/host/src/platform/logger.test.ts`、`redact.test.ts`、`redact.prop.test.ts`；e2e "…never logs the token" | 已覆盖 |
| pi 的环境里名字像凭据的变量值加入脱敏列表，pi 在 stderr 回显也不进日志 | redact.test.ts "picks the values of credential-like variables…"；tools.host.test.ts "scrubs credentials from the tool environment…"；try-pi.test.ts "keeps credentials from the environment out of its log…" | 已覆盖 |
| pi 从 `auth.json` 读的 Key 被 pi 回显时不进日志（已知缺口，见 security.md"凭据与日志"） | — | 待 M1.8 |
| 新建的 `~/.atrium` 权限 0700、日志 0600；已有目录不改权限 | `packages/host/src/platform/home.test.ts`；`logger.test.ts` "creates log files readable only by their owner, rotated ones included" | 已覆盖 |

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
| 200 次连接、50 次拒绝后资源计数和 Node 真实定时器都回到基线 | connections.leak.test.ts | 已覆盖 |
| 真实 pi 启动、停止 200 次后，资源计数、定时器、子进程、管道句柄都回到基线，每个 pi 进程及其进程组都已消失 | `packages/pi/src/process/pi-process.leak.test.ts` | 已覆盖 |
| 测试失败、超时或被杀时不留临时目录 | 根目录 `test-temp-root.ts`（Vitest、Playwright 全局初始化）；验证方法见 testing.md"临时文件与残留进程" | 已覆盖 |
| 定时器计数与释放 | `packages/host/src/platform/clock.test.ts` | 已覆盖 |
| 外观来回切换不留下脱离的 DOM | `apps/desktop/e2e/appearance.leak.spec.ts`。这个测试看不到事件监听器泄漏；外观监听器的移除由 appearance.browser.test.ts 断言 | 已覆盖 |
| 启动到连上宿主 ≤ 2 秒 | `apps/desktop/e2e/startup.perf.spec.ts` | 已覆盖 |
| 长时间运行：资源回到基线，内存增长每次 < 1KB | `packages/host/test/soak/connections.soak.test.ts` | 已覆盖 |
| 热路径基准 | `packages/protocol/src/trace.bench.ts`（traceparent 解析）；`packages/pi/src/process/jsonl.bench.ts`（分帧：大量小记录、16 MiB 单行，后者能抓住每块重扫整个缓冲的退化） | 已覆盖 |
