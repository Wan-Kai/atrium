# 测试追踪表

> 每条需求、关键流程、错误路径和安全要求，对应到证明它的测试。规则见 [testing.md](../architecture/testing.md#让覆盖面全)。
>
> 新增行为时在这里登记；一个里程碑完成前，它涉及的行都要有测试，并通过变异门槛。"待 M1.x"表示计划在该里程碑补上。

## SPEC-0001 需求

| # | 需求 | 测试 | 状态 |
|---|---|---|---|
| 1 | 侧栏按项目和工作区组织，显示运行、待处理、合并状态；标签页切换会话 | `apps/desktop/e2e/workspaces.spec.ts`；组件与宿主见"项目、工作区与会话（M1.5）"。待处理的状态随 M1.6、M1.9 | 部分覆盖 |
| 2 | 流式输出回复和推理过程 | `apps/desktop/e2e/chat.spec.ts`、`chat.perf.spec.ts`；组件与渲染见"协议、客户端与流式显示（M1.3）" | 已覆盖 |
| 3 | 粘贴或拖入截图随消息发出 | 组件与宿主见"模型与输入框（M1.7）"的图片两行（压缩、上传、暂存、带图片发出、过期重传）；端到端没有：Playwright 造不出系统剪贴板里的图片 | 部分覆盖 |
| 4 | 看到工具调用：命令和输出、读的文件、diff、写入的文件 | — | 待 M1.4 |
| 5 | 随时中断 | `apps/desktop/e2e/run-control.spec.ts`（停止后排队暂停，继续发送）；控制器与界面见"运行控制（M1.6）" | 已覆盖 |
| 6 | 运行中默认排队，可插话 | `apps/desktop/e2e/run-control.spec.ts`（回车排队、⌘回车插话、插话在下一步前送达）；见"运行控制（M1.6）" | 已覆盖 |
| 7 | 输入框旁切换模型和推理强度 | `apps/desktop/e2e/models.spec.ts`（换模型、⌘⇧E 调推理强度到最高、新对话沿用上一次的模型和档位）；组件与宿主见"模型与输入框（M1.7）" | 已覆盖 |
| 8 | 重启后恢复之前的会话 | `apps/desktop/e2e/history.spec.ts`（从 pi 的文件恢复）、`workspaces.spec.ts`（重启后标签页、当前标签和草稿还在）、`app.spec.ts`（页面存储跨重启） | 已覆盖 |
| 9 | 状态栏显示上下文、缓存、token、速度，可选择显示哪些 | `apps/desktop/e2e/status-bar.spec.ts`（真实宿主和 pi 下回复后显示轮、步、token、上下文，悬停看分段，打开费用后新对话也显示）；组件与宿主见"状态栏（M1.8）" | 已覆盖 |
| 10 | 在 Atrium 里回答 extension 的对话框 | `apps/desktop/e2e/run-control.spec.ts`（`/faux-confirm` 的卡片上作答）；见"运行控制（M1.6）" | 已覆盖 |
| 11 | 默认只突出回复，点开过程看每一步（2026-10-12 去掉显示模式的切换） | `packages/ui/src/chat/turn.browser.test.tsx`（跑完的轮折叠进标题行、点开看每一步）；`packages/ui/src/app/workbench.browser.test.tsx` "has no display mode to switch" | 已覆盖 |
| 12 | 会话在后台继续运行 | `apps/desktop/e2e/parallel.spec.ts`（三个会话同时运行，切走、断网时照常跑完，宿主重启后状态和对话记录正确）；宿主见"并行、同步与关注（M1.9）" | 已覆盖 |
| 13 | 首次启动引导安装 pi、登录、添加项目 | `apps/desktop/e2e/first-launch.spec.ts`（新的数据目录从欢迎页走到工作台）；组件与宿主见"首次启动与设置（M1.10）"。在没装 pi 的账户上走一遍要手动做，挪到 M1.11 | 部分覆盖 |
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
| 本机打包的 Atrium.app 不靠仓库运行：签名有效，宿主、登录程序和界面都在应用目录里，应用图标是 `assets/icon.icns`（猫），窗口照常连上宿主，退出时日志写完（2026-10-11 定） | `apps/desktop/e2e/package.spec.ts`（`pnpm test:package`） | 已覆盖 |
| 退出应用时等宿主写完日志 | `apps/desktop/e2e/shutdown.spec.ts`："waits for a host that is slow to exit…" 用 `e2e/slow-exit-host.cjs` 包住真实宿主、把退出推迟 1.5 秒，应用不等就留不下标记文件 | 已覆盖 |
| 同一客户端的标签命令按收到的顺序生效：索引里已有的会话不等第一次扫描就打开、切换立刻生效；还不认识的会话等扫描时关掉的标签不会再打开；一条失败不耽误下一条；关闭后排队的命令不再执行；新建会话在 pi 启动后打开成所在容器的激活标签，这期间换过位置就不切过去（2026-10-08 修，原来在机器繁忙时重启后 ⌘W 偶尔无效） | `packages/host/src/sessions/session-manager.test.ts` "closes a tab closed while its opening waited for the first scan…"、"opens a session the index knows…without waiting for the first scan"、"goes on with a client's next tab change after one that failed"、"does nothing more for a client's queued tab changes once it closes"、"opens a new session's tab where it belongs but leaves the client where it went…"；`layouts.test.ts`；`apps/desktop/e2e/workspaces.spec.ts` | 已覆盖 |
| 测试里的 git 不会穿过临时根目录、操作外面的仓库（`GIT_CEILING_DIRECTORIES`）（2026-10-08 修，变异测试时曾在 atrium 自己的仓库里切分支、建分支和 worktree） | `packages/testkit/src/git.test.ts` | 已覆盖 |
| 宿主关闭时日志按写入的顺序落盘，最后一行是 "host stopped"；有写入正在进行时也一样；测试读日志前等全部落盘；写日志出错时不再一直等：等落盘的报错，关闭的直接关掉文件（2026-10-08 修，原来在机器繁忙时偶尔乱序） | `packages/host/src/platform/logger.test.ts` "drainLogFile"、"closeLogFile"（占满线程池，让一次写入一定还在进行；把流指向没打开的描述符，让写入一定失败）；`apps/desktop/e2e/shutdown.spec.ts` | 已覆盖 |
| 宿主启动中途收到退出：不在退出后报"已就绪" | `packages/host/src/electron-port.test.ts` "does not report ready or take app metrics, and closes the host, when shutdown arrives while it is still starting"（启动和退出由测试控制） | 已覆盖 |
| 重新连接时关闭旧连接，旧连接晚到的事件不改写新状态 | connection.test.ts "closes the previous socket on reconnect…" | 已覆盖 |
| 界面跟随系统外观 | `packages/ui/src/design/appearance.browser.test.ts`；e2e "follows the system appearance" | 已覆盖 |
| 图标：统一从 `design/icons.tsx` 取 Hugeicons，线宽 1.75，加粗的按各自的宽度（勾 2.25，更多、上箭头 2.5），实心的填色并保留轮廓，不给尺寸时跟随文字；Meta 标借 Tabler 的形状；侧栏领先数和已合并用图标不用字符（2026-10-12） | `packages/ui/src/design/icons.browser.test.tsx`、`app/workbench.browser.test.tsx` "lists a project's workspaces" | 已覆盖 |
| 连接状态的全部文案，包括启动中、桥接失败；连上后只留给读屏、不占位置，没连上时主窗口底部一行（2026-10-12） | `packages/ui/src/app/connection-status.browser.test.tsx`、`workbench.browser.test.tsx` "connection line" | 已覆盖 |

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
| 回复渲染：排得紧凑（行高 1.55、块之间 12px、列表项上下 2px，圆点在第一行中线）、GFM（表格、嵌套与任务列表、删除线）、无序列表的圆点自己画（5px、靠近文字，折行和文字对齐，有序列表不变，任务列表只有勾选框）、中文标点旁的加粗、`$$…$$` 与 `\(…\)` 公式而不认单个 `$`、Shiki 高亮与 diff、Mermaid、链接交给系统浏览器且不弹确认、`https` 图片直接显示而 `http` 图片变成链接、原始 HTML 按文字显示且不执行 | `packages/ui/src/chat/markdown.browser.test.tsx`、`markdown-transforms.test.ts` | 已覆盖 |
| 覆盖"回复渲染"全部范围的样例按真实节奏分片流式渲染，每一步都不出错，结束后与一次性渲染逐字节一致 | `packages/ui/src/chat/streaming.browser.test.tsx`（样例 `reply-showcase.md`） | 已覆盖 |
| 平滑揭示：只放慢增长部分；每帧按积压量揭示、约 150 毫秒的时间常数；长时间停顿也只算 250 毫秒；不切断字形，未到齐的字符等到齐；结束时一次显示完 | `packages/ui/src/chat/text-reveal.test.ts`；基准 `text-reveal.bench.ts` | 已覆盖 |
| 滚动跟随：停在底部时跟随；往上翻停止跟随并出现"回到底部"，有新内容时带圆点；点了回到底部并恢复跟随；下方变高（输入框、卡片）时仍在底部；最后一轮的过程展开、步骤详情打开、过程折叠时每一帧都在底部；不在底部时这些都不移动视窗 | `packages/ui/src/chat/follow-bottom.test.ts`、`chat.browser.test.tsx` | 已覆盖 |
| 对话区：用户气泡（乐观显示的没有时间）、推理过程运行时展开结束后折叠、回复出错和已停止的标注、"进行中 · 12s"、各部分的顺序；输入框回车发送、Shift+回车换行、输入法组字时不发送；第一次发送时新建对话并订阅；发送失败的原因 | `packages/ui/src/chat/chat.browser.test.tsx` | M1.4 改为按轮，见"对话记录（M1.4）" |
| 等待回复（2026-10-11 定）：空闲时发出消息起显示"进行中"行（宿主开始运行前不带计时），运行中发的进排队、不显示；这一轮还没有可显示的东西时这一行留在轮里，回复出来后去掉，没东西就停止的轮不显示；行首是眨眼的小猫（装饰，不进无障碍树） | `packages/ui/src/chat/chat.browser.test.tsx` "run line"、"counts the run's time" | 已覆盖 |
| 在真实应用里发消息，推理和流式回复显示出来，运行结束后推理折叠成"思考了 N 秒"，没有残留的计时和乐观显示 | `apps/desktop/e2e/chat.spec.ts` | 已覆盖 |
| 客户端订阅和退订 1000 个会话后视图全部释放，并能被回收 | `packages/client/src/atrium-client.leak.test.ts` | 已覆盖 |
| pi 拒绝消息时的错误码：运行中或压缩中回 `session_busy`，其他拒绝回 `pi_rejected`（带 pi 原文），退出或停止回 `pi_unavailable/exited`，不回应回 `unresponsive`；回显先到、失败后到时不删别的 prompt 的位置；`prompt` 不设期限 | `packages/host/src/sessions/session-controller.test.ts`；`packages/pi/src/process/rejections.test.ts` | 已覆盖 |
| 新建对话：pi 报不出会话 id 时停掉它；管理器关闭后才建好的对话停掉自己的 pi | `packages/host/src/sessions/session-manager.test.ts` | 已覆盖 |
| 快照带 `exited`；客户端发现宿主重启后把旧会话标为已失效、保留已显示的消息、不再订阅；同一宿主重连照常订阅 | session-view.test.ts、atrium-client.test.ts | 已覆盖 |
| 心跳没应答时立刻放弃连接：等待中的命令失败、开始重连，晚到的关闭事件不重复处理；已连接时再次连接让旧命令失败；等待重连时断开变成"已断开" | atrium-client.test.ts | 已覆盖 |
| 对话界面：运行中不能发送；连按两次只建一个对话；会话已退出或已失效时下一条消息新建对话；新错误码的文字 | `packages/ui/src/chat/chat.browser.test.tsx` | 已覆盖 |
| 滚动跟随不被自己滚动的那次事件打断，即使其间内容又长高了 | follow-bottom.test.ts | 已覆盖 |
| 滚动跟随不被浏览器的滚动锚定打断：上方和下方在两帧之间都变高时仍在底部；运行中过程逐步变长时每一帧都在底部 | `chat.browser.test.tsx` "…between frames"、"…process grows step by step" | 已覆盖 |
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
| 界面的轮：过程折叠成标题行（"已完成，用时 · 读了 · 跑了 · 改了 · N 条命令没走通"，展开时只有"已完成，用时 N"），折叠时插话仍可见；只有推理时显示"思考了 N 秒"或"思考过程"；没有过程时没有标题行；点击步骤展开详情（命令输出、截断说明、带行号和增删竖条的 diff）；运行中展开、正在进行的步骤转圈并实时显示；已停止、出错（可展开原始报错）；信息行（复制回复的 Markdown 原文，只有这一个复制按钮；改动胶囊展开文件和 diff、用量、结束时间）；小菜单按钮选中、Esc（不传给外层）和点击外部关闭（`menu-button.browser.test.tsx`）；提示条展开压缩摘要 | `packages/ui/src/chat/turn.browser.test.tsx`；纯函数：`turn-layout.test.ts` | 已覆盖 |
| 过程轨道（2026-10-12）：标题和各行文字从 30px 起，主线节点在 10.5px、支线节点在 19.5px；节点（做完的圆点、探索的放大镜、进行中、走不通的支线、汇入的插话）；跑完后轨道停在最后一步，下面没有竖线，没有完成行，停止、出错只在标题行写；工具的动词随状态（正在运行 / 运行了 …）、编辑的文件胶囊带增删行数、悬停看全路径、文件胶囊前是类型图标和类型的颜色（认不出的是通用文件图标，`--text-muted`）；探索行"探索了代码库 · 读了 N 个文件，搜索了 M 次"，读过的文件胶囊最多 5 个加"+N 个"；没有内容的推理（空的或全是空白，模型藏起了推理）和空的文字步骤不是按钮、任何模式和运行中都没有详情块；当场跑完的轮停 1 秒再平滑折叠（`after` 定时器，点标题行或卸载时取消），摘要淡入；折叠和展开的时长（高度 0.4 秒，各行 0.22 / 0.26 秒、依次晚 14ms，摘要晚 0.16 秒淡入 0.26 秒）；展开从高度 0 长出来，折叠从当前高度收起；减弱动态效果时直接切换；运行中新到的步骤播放进场，已有的不播 | `packages/ui/src/chat/turn.browser.test.tsx`；纯函数（`describeStep`、`describeExplore`、`exploredFiles`）：`turn-layout.test.ts`；文件类型（按文件名、扩展名、不分大小写、认不出时）：`file-kind.test.ts`；端到端：`apps/desktop/e2e/chat.spec.ts`（跑完后自动折叠） | 已覆盖 |
| 会话文件与打开会话：M1.4 的"最近会话"列表在 M1.5 由侧栏和"历史"取代，读取和打开的测试见"项目、工作区与会话（M1.5）" | — | 已取代 |
| 用 pi 写的真实会话文件恢复：工具、重试、压缩在当前分支上，另一个分支不显示，提示条在它所在的轮之后，过程标题行的统计；接着发消息照常运行 | `apps/desktop/e2e/history.spec.ts` | 已覆盖 |
| 审查后补上（2026-10-08）：当场看到的轮和插话按记录重建（停在工具结果之后的下一轮仍是新的一轮）；上下文溢出的恢复不算重试；空报错按 pi 写 "Unknown error"；任何位置新增的提示条都推 `notice_added` 并带插入位置；pi 崩溃中断的一轮为 `failed`；长文字以预览发送、标 `partial`，`fetch_step` 取回完整步骤，快照和分页按 4 MB 装；`write` 的内容只发一份；打开目录已不存在的会话回 `session_cwd_missing`；刷新失败的日志只记命令和原因；扫描会话目录只认 LF、可随关闭中止；界面的时间经注入的时钟；导出遇到重建时报错而不是导出一部分 | `packages/host/src/transcript/*.test.ts`、`sessions/*.test.ts`、`packages/client/src/*.test.ts`、`packages/pi/src/sessions/session-files.test.ts`、`packages/ui/src/chat/*.test.ts(x)` | 已覆盖 |
| 同一回复里的并行工具调用：只由手写的条目和事件覆盖（重建、实时），录制的场景每次回复只调一个工具，因为 pi 并行执行时事件顺序不定 | `projection.test.ts`、`session-transcript.test.ts`、`translate.test.ts` | 部分覆盖 |
| 打开 1000 轮的会话到首屏 ≤ 500 毫秒（中位数，实测约 25 毫秒；第一次打开含启动 pi 约 1 秒） | `apps/desktop/e2e/history.perf.spec.ts` | 已覆盖 |
| 2000 轮会话的对话记录重建（基准，本机中位约 2.4 毫秒） | `packages/host/src/transcript/rebuild.bench.ts` | 已覆盖 |
| 对话区：轮、提示条、待确认的消息、运行状态的顺序；运行的计时在轮里；滚到顶加载更早的，且阅读位置不动；提问导航条跳转；长消息折叠与展开；导出会话时取完所有页 | `packages/ui/src/chat/chat.browser.test.tsx`、`packages/ui/src/app/workbench.browser.test.tsx`、`packages/ui/src/tabs/session-menus.test.ts` | 已覆盖 |

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
| 会话目录：只读已登记容器对应的目录并核对 `cwd`；Atrium 建的会话按记录的容器，容器不在了按目录；草稿在文件出现前列出，出现后不再是草稿；文件没了是 `missing`；丢弃草稿；归档（终端会话也记下）；每个对话目录是一个对话（2026-10-12 改，见"每个对话是一个容器"），新对话不等扫描；同一会话多个文件取最新并记日志；pi 全放一个目录时也能分开；不知道目录时只列记录；只在变化时通知、扫描期间的请求合并；关闭后停止 | `packages/host/src/sessions/session-catalog.test.ts`；兜底标题：`prompt-line.test.ts` | 已覆盖 |
| 布局：每个客户端分开；打开的标签按顺序、激活、切换容器；关掉激活的标签时右边的、再左边的接上；各客户端关掉某会话的标签；去掉消失的容器；只留最近的 10 个客户端 | `packages/host/src/sessions/layouts.test.ts`；客户端的即时更新：`packages/client/src/index-view.test.ts` | 已覆盖 |
| 会话管理器：新建对话（自己的目录）和工作区会话由宿主定 id、记成草稿、打开成标签后马上应答，pi 在后台用 `--session-id` 启动（2026-10-11 改），会话 id 不随 pi 的报告变；打开新建的草稿等这次启动、失败时报错，pi 不可用时新建照样成功、记日志，打开或第一条消息再启动；启动中关掉的空草稿照样丢弃并停掉 pi；关闭时启动到一半的会话不留 Controller，关闭后新建的不向 pi 发命令；打开终端会话用 `--session`、同时只启动一个、退出后在新 epoch 重启并给订阅者快照；目录没了、文件没了时报错不启动；重启后的草稿不启动，第一条消息时用 `--session-id`；没发过消息的草稿关掉最后一个标签时丢弃（对话的空目录一并删、有文件的留下），发过消息的保留；归档停掉 pi、关掉各处标签并丢掉 Controller（资源计数 `session.controller` 归零）；改名先启动 pi；项目移除时停掉其中的会话并丢掉它们的 Controller；运行状态进列表、运行结束重扫，草稿在 pi 报告第一轮时就重扫、运行中已能找到文件；插话记录读入和写回，读写失败只记日志 | `packages/host/src/sessions/session-manager.test.ts` | 已覆盖 |
| 插话记录：存进 `turns/<会话 id>.json`，每个条目只记一次；不适合做文件名的 id 只放内存；损坏时重来；重建时按记录把工具结果之后的消息当新的一轮，没有记录时按位置推断 | `packages/host/src/store/turn-starts.test.ts`、`transcript/projection.test.ts`、`session-transcript.test.ts` | 已覆盖 |
| 列表推送：订阅时马上给自己客户端的快照；一段时间内的变化合并成一份推给所有订阅者；断开后不再推；关闭时丢掉待推的 | `packages/host/src/sync/index-feed.test.ts`、`subscriptions.test.ts` | 已覆盖 |
| 协议与路由：新命令、快照的每种取值和越界、新错误码；路由把布局类命令连同客户端交给会话层，列表命令交给索引命令 | `packages/protocol/src/envelope.test.ts`、`packages/host/src/server/router.test.ts` | 已覆盖 |
| 客户端：每次连上都订阅列表；第一份快照前为空，之后只收同一宿主更新的快照；开标签、关标签、切容器、改偏好立刻反映；各命令的字段和结果 | `packages/client/src/atrium-client.test.ts`、`index-view.test.ts` | 已覆盖 |
| 宿主层：添加项目后推来工作区、合并状态，聚焦后出现终端会话，worktree 不能再登记成项目；偏好和布局跨重启；损坏重置；新版本拒绝启动 | `packages/host/src/index.host.test.ts` | 已覆盖 |
| 侧栏：工作区按本地、新到旧、已收尾排序，合并标签、运行状态、本地的提示；点击切换；项目折叠后显示待合并数和运行状态并记住；添加项目（取消不添加）、已存在时说明是哪个项目；搜索工作区和会话（不分大小写，结果保留到关闭）、没有匹配；对话行见"每个对话是一个容器"；工作区和项目改名、移除项目；外观三档切换并通知窗口 | `packages/ui/src/app/workbench.browser.test.tsx`；纯函数：`packages/ui/src/sidebar/names.test.ts` | 已覆盖 |
| 标签栏与对话区：当前容器的标签、激活、切换、关闭；"历史"按新到旧、标出已打开、不含归档；"+"新建；会话"···"改名、归档、复制路径（草稿不可复制）；快捷键 ⌘N、⌘T（不在任何容器时新建对话）、⌘W、⌘1–9、⌘⇧[ ]；窗口聚焦通知宿主；空状态说明会话建在哪里；空状态里一输入就在当前位置新建会话（只建一次，失败显示在输入框上方），第一条消息等它建好；退出或丢失的会话先重新打开再发 | `packages/ui/src/app/workbench.browser.test.tsx`、`packages/ui/src/chat/chat.browser.test.tsx` | 已覆盖 |
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
| 停止：暂停排队，pi 退回的插话放回最前，`abort`；2 秒内确认即结束，否则保持"停止中"、拒收消息和继续发送，直到 pi 确认或退出；空闲时直接确认；pi 已应答、`agent_start` 未到时也中止；`abort` 失败不算确认，等到 pi 退出；停止后空闲时新消息直接发出，排队仍暂停；反复停止同一个 pi 的运行，不在它的退出上留下等待 | session-controller.test.ts "stopping" | 已覆盖 |
| 对话框：保留到回答，只收第一个、类型要对得上；到期移除；pi 退出时作废；结束时在对话记录里留一行（回答、取消、超时、作废），运行中结束的跟在这一轮后面、重建后仍在；通知截断到 4 KB 写日志，带原长度 | session-controller.test.ts "answering dialogs" | 已覆盖 |
| 崩溃：重启 pi（新 epoch 快照 + "进程已自动重启"提示），pi 没收下的消息重发，收下了就补发"系统自动发出"的续做；未送达的插话回到排队；连续 3 次失败后出错；运行正常结束后计数归零；宿主要求的停止不重启；pi 应答后、`agent_start` 前崩溃也重发；重发时 pi 又走了，被打断的那条留给下一次重启；停止后崩溃不发出，没收下的那条进暂停的排队；重启中消息排队、停止让它和被打断的那条留在暂停的排队；另一处启动换上的 pi 直接用；停止的运行也让计数归零；"重试"续做失败的一轮、或重发重启用尽时丢失的消息（收下了就补发续做），启动失败时保留失败状态，启动期间算作重启中、再点重试不起作用、关闭会话停掉新 pi；续做的那一轮记为自动发出 | session-controller.test.ts "after pi crashes"、"retrying"；`session-manager.test.ts`（崩溃后用会话文件重启、用尽后列为出错；继续发送时启动放弃重启的 pi；重启中发消息或打开会话不另起 pi；重启中归档或关闭宿主不再启动；启动时开启自动重试） | 已覆盖 |
| 对话记录：自动发出的标记当场和重建后都在，记进 `turns/`；重启提示在重建后回到它跟着的那一项后面；重试步骤带 pi 的上限，重建后保留 | `packages/host/src/transcript/session-transcript.test.ts`、`store/turn-starts.test.ts` | 已覆盖 |
| 客户端：控制状态、`prompt_handled` 去掉待发副本；排队或被插话收下的消息去掉待发副本；运行控制命令的字段与结果 | `packages/client/src/session-view.test.ts`、`atrium-client.test.ts` | 已覆盖 |
| 界面：运行中回车排队、⌘回车插话、Esc 和按钮停止，这句提示在输入框的占位文字里（停止中是"正在停止…"），输入框下面没有提示行，停止中按钮不可用；胶囊条（排队、已暂停与继续发送、编辑删除插话清空、待送达插话数）；四种对话框卡片与倒计时；连续崩溃的错误卡片；最后一轮失败时的"重试"，重启中不给；重启提示、对话框结果提示与"系统自动发出"；停止中输入框保留文字、不发送；重试显示"第 N / M 次"或"第 N 次"；出错的会话在标签、工作区上显示"出错"，高于运行中 | `packages/ui/src/chat/run-control.browser.test.tsx`、`chat.browser.test.tsx`、`turn-layout.test.ts`、`app/workbench.browser.test.tsx` | 已覆盖 |
| 杀掉 pi 后自动恢复（端到端） | `apps/desktop/e2e/run-control.spec.ts` | 已覆盖 |
| 测试工具：faux 写下 pi 的进程号；夹具把工具耗时规范化为 0 | `packages/testkit/src/faux/faux.pi.test.ts`、`pi-fixtures/normalize.test.ts` | 已覆盖 |

## 模型与输入框（M1.7）

| 行为 | 测试 | 状态 |
|---|---|---|
| 协议：推理档位、模型、目录里的模型、会话的模型；`list_models`、`set_model`、`set_thinking_level` 及其应答；快照的 `model`、`model_updated`；`models_unavailable`；偏好的 `lastModel`、`thinkingByModel` | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| 推理档位按模型元数据算出（照抄 pi-ai 的规则），模型的基本数据，pi 的占位模型算作没有模型 | `packages/pi/src/catalog/models.test.ts` | 已覆盖 |
| 短启 pi 查模型：不带会话、在指定目录、查完停掉；默认模型必须在列表里；pi 退出带 stderr、中止时停掉 pi、中止在先不启动 | `packages/pi/src/catalog/query.test.ts`；真实 pi：`query.pi.test.ts`（faux 的模型与默认、没有凭据时列表为空） | 已覆盖 |
| 模型目录：按目录缓存、同一目录同时只查一次、刷新重查（期间的请求共用）、失败丢掉旧答案、120 秒期限、关闭时中止并等待 | `packages/pi/src/catalog/model-catalog.test.ts` | 已覆盖 |
| pi 契约（1.1.0）：模型列表、换模型和推理强度、换到不支持推理的模型时档位降到 off、未知模型被拒绝、档位规则与 pi 一致 | `packages/pi/src/contract/models.pi.test.ts` | 已覆盖 |
| 事件翻译：`thinking_level_changed` | `packages/pi/src/events/translate.test.ts` | 已覆盖 |
| 控制器：快照带模型，换模型和推理强度后读回、只在变化时发 `model_updated`、报告选择、再读条目；pi 拒绝时原样转出、什么也不变；停止中和退出后拒绝；跟随 pi 自己改档位；重启后换成新 pi 的模型 | `packages/host/src/sessions/session-controller.test.ts` "model" | 已覆盖 |
| 会话管理器：新会话先设上一次的模型和档位再读会话；没记住档位、没选过模型、记住的模型已不在（只记命令和原因）时的处理；从文件打开的会话不设；转发换模型和推理强度；未知会话 | `packages/host/src/sessions/session-manager.test.ts` "models" | 已覆盖 |
| `list_models`：工作区在其目录、对话在 `~/.atrium`；未知工作区；pi 失败给 `models_unavailable` 带最后 4 KB；其他失败原样转出；路由 | `packages/host/src/sessions/model-lister.test.ts`、`index-commands.test.ts`、`server/router.test.ts` | 已覆盖 |
| 偏好：记住上一次的模型和每个模型的档位，新会话用它们，第 1 版文件升级 | `packages/host/src/store/preferences.test.ts`、`load-index.test.ts` | 已覆盖 |
| 客户端：快照和 `model_updated` 的模型；容器的模型列表（加载中保留旧列表、失败带错误）；换模型和推理强度先在视图里生效，被拒绝时放回、宿主报告过的不动 | `packages/client/src/session-view.test.ts`、`atrium-client.test.ts` "models" | 已覆盖 |
| 测试工具：faux 可加模型（名字、推理、图片、档位表）；脚本化的 pi 可把收到的命令写到 stderr；faux 的确定性测试把工具耗时规范化 | `packages/testkit/src/faux/faux.pi.test.ts`（修了 pi 1.1.0 的 `durationMs` 让它时有时无失败的问题） | 已覆盖 |
| 界面：模型按钮（服务商图标、模型名、档位字、拉满时发光，没有模型时"选择模型"）；面板（按服务商分组、基础数据、当前模型打勾、点选即关、刷新、加载中保留旧列表、失败可展开原始报错并重试、没有可用模型的提示）；推理强度框（档位名、"3 / 4"、说明、每档 56px、拖动吸附、点格子跳档、方向键、到头不动、外部改档跟随、聚焦）；⌘⇧I / ⌘⇧E；停止中不能用；空状态显示上一次的模型、选模型时先建会话；被拒绝时说明原因 | `packages/ui/src/chat/model-picker.browser.test.tsx`、`effort-box.browser.test.tsx`、`chat.browser.test.tsx` "model button"；逻辑：`model-choice.test.ts` | 已覆盖 |
| 点阵：覆盖度、档位越高越密、拉满变彩色、同种子同图案、扫光、深浅色、扫光节奏 | `packages/ui/src/design/dots.browser.test.ts` | 已覆盖 |
| 协议：`list_commands`、`search_files` 及其应答，`fd_missing` | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| `/` 命令：pi 契约（1.1.0：extension 命令、pi 自带的 `/llama` `/mcp`、模板、skill 的顺序；模板发出时展开；插话不收 extension 命令）；映射；控制器和会话管理器（草稿先启动 pi）；路由；客户端 | `packages/pi/src/contract/commands.pi.test.ts`、`catalog/commands.test.ts`、`session-controller.test.ts` "commands"、`session-manager.test.ts` "commands"、`router.test.ts`、`atrium-client.test.ts` | 已覆盖 |
| `@` 文件：找 fd（pi 的目录优先、`PI_CODING_AGENT_DIR`、PATH 上 fd 再 fdfind、跳过不能运行的）；打分、排序、子目录范围、不出工作目录、fd 参数（字面匹配）、解析输出；真实 fd（先一层再递归、隐藏文件、`.ignore`、不含 `.git`、特殊字符、取消和 5 秒期限时停掉 fd）；同一会话的新查询取消旧的；没有 fd 时 `fd_missing` | `packages/pi/src/locate/fd.test.ts`、`packages/host/src/files/fd-query.test.ts`、`file-search.host.test.ts`、`session-manager.test.ts` "file search" | 已覆盖 |
| 输入框：`/` 列表（过滤、方向键、回车或 Tab 选中、Esc 关闭、只在开头、读不到时提示）；`@` 列表（变成小胶囊、Tab 进入目录、带空格的路径加引号、去掉胶囊、fd 缺失提示、邮箱不算、中文后面的 `@` 算）；长粘贴收成胶囊；↑↓ 历史（到最早时加载更早的）；草稿按会话存取、发送后清掉；展开；"+" 菜单；提示文字；按钮能按时光标是小手，不能按时是默认光标；对话区接上命令、文件、历史和草稿，空状态先建会话 | `packages/ui/src/chat/composer.browser.test.tsx`、`chat.browser.test.tsx` "composer"；逻辑：`composer-text.test.ts` | 已覆盖 |
| 草稿：按会话存取、清空即删、存不下时只留在内存、坏数据当没有；归档的会话、运行中从列表消失的会话清掉草稿，新宿主的第一份列表不清 | `packages/ui/src/state/drafts.test.ts`、`app/workbench.browser.test.tsx` "drafts" | 已覆盖 |
| 图片：协议（`upload_attachment`、`attachmentIds` 最多 20 张、只有图片时文字可为空、什么都没有不行、排队项的图片数、两个错误码）；宿主暂存（按连接、32 MiB / 20 张、全部在才取、30 分钟释放、断开和关闭时释放）；路由取出图片交给会话；控制器带图片发出、排队、插话、停止退回、崩溃重发；客户端上传、带图片发送、待发副本带图片数 | `packages/protocol/src/envelope.test.ts`、`packages/host/src/server/attachments.test.ts`、`router.test.ts` "attachments"、`session-controller.test.ts` "images"、`packages/client/src/atrium-client.test.ts` "images" | 已覆盖 |
| 消息图片缩略图（M1.11）：pi 包按条目 id 从会话文件读出用户消息的第几张图（只数图片块、只认四种格式、不是用户消息或没有数据时没有、还没写完的行不算、跨块的长行、读不了的文件、取消、关文件）；协议 `fetch_image`（最多第 20 张、应答只收四种格式且不为空、`image_unavailable`）；宿主由轮找到条目（读出的轮、当场看到并绑定后的轮，运行中没绑定的和没有的轮没有）、从目录登记的文件里读、没有文件或没有这张图时 `image_unavailable`、路由转交；客户端取图、按消息留着最近 50 条发出消息的预览、没发出去的不留；界面：这里发出的消息用留着的预览、其他按轮逐张取、取不到显示"图片不可用"、待发和加载中是灰框、轮结束后再取一次、64px 正方形裁切填满并换行、在气泡上方，页面留着最近 100 张取过的图（跨会话分开）、取不到的不留；端到端：真实 app 贴图发送后显示缩略图，重启后从 pi 的会话文件取回 | `packages/pi/src/sessions/session-files.test.ts` "readUserImage"、`packages/protocol/src/envelope.test.ts`、`packages/host/src/transcript/session-transcript.test.ts` "finds the entry"、`session-manager.test.ts` "message images"、`router.test.ts`、`packages/client/src/atrium-client.test.ts` "message images"、"latest 50"、`packages/ui/src/chat/message-images.browser.test.tsx`、`chat.browser.test.tsx` "shows each turn's images"、"shows the images of a message it sent"、`apps/desktop/e2e/images.spec.ts` | 已覆盖 |
| 图片：压缩（WebP、长边 2048、放进一条消息、先降质量再缩小、很小的图照原样、放不下时拒绝、不是图片时报错）；输入框（粘贴、"+"菜单、拖入、上传完才能发、只有图片也能发、模型不支持时不添加、换到不支持的模型时提示但照发、上传失败的说明、移除、切标签保留）；拖入的其他文件按工作区目录变成引用；对话区上传、过期时重传一次再发、模型不支持时拒绝；排队面板显示图片数 | `packages/ui/src/chat/images.browser.test.ts`、`composer.browser.test.tsx` "images"、`chat.browser.test.tsx` "images"、`run-control.browser.test.tsx` | 已覆盖 |
| 工作区改动（照抄 Paseo，取代本会话改动）· 协议：`watch_changes`、`watch_diff`、`changes_updated`、`diff_updated`（文件、hunk、行、状态、二进制和过大） | `packages/protocol/src/envelope.test.ts` "changes" | 已覆盖 |
| 工作区改动 · git：胶囊的数字（工作树对 merge-base，加未跟踪文件的行数，跳过二进制、过大、链接和被忽略的；比较基准：主干上用 `origin/<分支>`、分支上用 `origin/<主干>` 或本地主干、项目自己的主干；没有基准、HEAD 分离、非 git 时不显示）；面板的 diff（未提交 = HEAD 对工作树加未跟踪文件，已提交 = merge-base..HEAD；编辑、删除、重命名带旧路径、二进制、链接；单文件和累计上限保留行数；整个 diff 过大；还没有提交的仓库；非 git）；监听的根目录和被忽略的目录；输出解析；git 执行器的输出上限 | `packages/host/src/changes/checkout.host.test.ts`、`diff-text.test.ts`、`platform/git.test.ts` "too large" | 已覆盖 |
| 工作区改动 · 服务：只给有人看的工作区算和监听；文件变化 1 秒后重算、面板 150 毫秒；同样的结果不重发、新连接照样收到；`.git` 里只认 HEAD、index、refs，不认锁文件，被忽略目录不算，`.gitignore` 变了重读；linked worktree 的 git 目录；按需重算；未知工作区；没人看时停止监听、计时器和资源归零；git 失败只记命令和原因；监听坏了改为轮询（5 秒起翻倍到 60 秒，有变化回 5 秒），30 秒后重试监听，成功后停止轮询；路由、断开时清理；真实宿主、真实 git 和文件监听下数字和面板随文件变化 | `packages/host/src/changes/changes-service.test.ts`、`server/router.test.ts` "changes"、`changes.host.test.ts` | 已覆盖 |
| 工作区改动 · 客户端与界面：每个工作区的改动、面板只收自己目标的结果、刷新时保留已显示的文件、重连后重发；胶囊（紧凑数字、没有改动时不显示、对话不看）、右侧抽屉（默认模式、切换、"有没有未提交"变了回到默认、文件列表与跳转、折叠、hunk 与行号、重命名、二进制、过大、没有改动时去另一模式、不是 git、读不到、太大、刷新、Esc 和关闭、换容器时收起）；端到端：真实宿主里改文件后胶囊和面板 | `packages/client/src/atrium-client.test.ts` "workspace changes"、`packages/ui/src/chat/changes.test.ts`、`changes-panel.browser.test.tsx`、`chat.browser.test.tsx` "workspace changes"、`apps/desktop/e2e/changes.spec.ts` | 已覆盖 |
| 第二轮审查后修复（2026-10-10）· 插话按 pi 队列的增减条数对应（不按文字），skill 展开后照样跟得上，收回时按发出时的文字；同一会话的插话逐条发；轮到时已在停止的不发、应答 `session_stopping`；只有图片的插话带"（见图片）"；换模型被 pi 接受但读回失败时照样成功、取条目后再读；同一张上传不被两条消息同时用；工作区改动：一次 git 运行拿到状态、行数和补丁，文件与链接互换算一个文件，按面板顺序扣大小额度，大于 1 MB 的未跟踪文件只数行，读不了的未跟踪文件跳过，git 读失败显示"读不到改动"，ref 用完整名，`diff.suppressBlankEmpty` 下的空行；服务：一开始建不起监听也轮询，恢复时立刻又失败的照样轮询（按轮次），监听建好后再算一次，收尾时补上漏掉的请求，没有 git 时给结果，胶囊读失败不影响面板；界面：重新上传逐张、仍失败时放回带新上传，带引号的 `@` 不越过别的词，菜单开着时 Esc 只关菜单，空状态也有胶囊，切走容器后不再往转交的会话送字；拖入时只按文件条目对应目录（浏览器测试造不出目录条目，未单独测） | `session-controller.test.ts` "counts pi's steers"、"expanded"、"one at a time"、"placeholder"、"once a stop began"、"could not be read back"；`attachments.test.ts` "one message at a time"；`checkout.host.test.ts` "link"、"cannot read"、"damaged index"、"allowance"、"full name"、"staged"；`diff-text.test.ts` "parseDiffOutput"、"suppressBlankEmpty"；`changes-service.test.ts` "without git"、"cannot be set up"、"fails at once"、"owed"；`chat.browser.test.tsx` "one at a time"、"empty state too"、"forgets the session"；`changes-panel.browser.test.tsx` "only the menu"；`composer-text.test.ts` "past other words" | 已覆盖 |
| `/` 命令端到端：输入时列出 pi 的命令，回车选中，完整的命令回车直接发出，extension 命令处理后没有运行 | `apps/desktop/e2e/models.spec.ts` | 已覆盖 |
| 空状态输入 `/` 建会话后，打的字、图片转到新会话的输入框并获得焦点；模型列表在连上后才请求、重连后再请求；列表还没东西可选时回车照常发送 | `packages/ui/src/chat/chat.browser.test.tsx` "before it is connected"、"handing the first words"；`composer.browser.test.tsx` | 已覆盖 |
| 审查后修复（2026-10-10）· 宿主：`@` 的查询词放在 `--` 之后，`--search-path=…` 这类查询搜不出工作目录外的东西，以 `-` 开头的名字找得到（fd 输出的 `./` 去掉）；含 NUL 的查询什么也不找、不占 fd 进程计数；停止时 pi 先发的空队列更新不丢插话，同文字的插话按"pi 从队头送达"配对图片，还在途中的插话等它到了再收回；会话拒绝的消息不释放它的图片；一次上传 20 张图不触发限流（每秒 32 MiB）；重启用尽后再启动、还没写出文件的会话重启时用它原来的模型；换模型后读回失败按 pi 的错误应答 | `file-search.host.test.ts` "looks like an fd option"、"cannot be given"；`fd-query.test.ts` "./"；`session-controller.test.ts` "share a text"、"on its way"、"read back"、"latest steer"；`attachments.test.ts` "fails"；`chat.host.test.ts` "whole allowance"；`ws-server.host.test.ts` "32 MiB"；`session-manager.test.ts` "model it had" | 已覆盖 |
| 审查后修复（2026-10-10）· pi 包与客户端：过长的命令描述和模型名截断，名字或 id 过长的整条不列；中止测试等 pi 收到命令再中止，不靠计时；两次换模型重叠且都失败时回到宿主最后报告的模型 | `catalog/commands.test.ts`、`catalog/models.test.ts` "too long"；`query.test.ts` "aborted while it reads"；`atrium-client.test.ts` "goes back" | 已覆盖 |
| 审查后修复（2026-10-10）· 界面：草稿以页面内存为准、同步写进 localStorage，写不下时留在内存并删掉旧的、存储被别处改了时重读；上传在输入框离开后完成也记进草稿；压缩中的图片显示占位、不能发送；发送失败时消息和图片回到空的输入框；空状态转交后继续打的字记在新会话、新会话先显示也能收到转交，新会话的输入框只抢一次焦点；⌘⇧I 打开模型面板后的 Esc 只关面板；新查询没回来时不选旧结果；有小胶囊或图片时 ↑ 不调历史；↑ 历史含插话；带空格的目录 Tab 进入时加引号继续找；拖入的目录带 `/` | `state/drafts.test.ts`；`composer.browser.test.tsx` "went away"、"compressed"、"model panel"、"query before"、"capsule"；`chat.browser.test.tsx` "old failure"、"before it shows"、"before its creation is answered"；`composer-text.test.ts` "quoted"、"space"、"steers"、"droppedReference"（拖入目录的判断取自拖放条目，浏览器测试造不出目录条目，只测了路径规则） | 已覆盖 |
| 变异测试补测（2026-10-10）· 插话：pi 的队列多几项就只列出几条、还在等轮到的不算，运行结束后才轮到的作为消息发出，停止收回后重新跟上 pi 的队列，pi 从别处拿到的文字照原样还回、不带图片；没人等模型列表时换模型只读回一次；上传：单个连接的数量上限，消息在途中过期的上传照样能用，断开只清自己的；`@` 的绝对路径即使工作目录里有同名目录也不搜；连接关闭时工作区改动的监听归零；客户端：第三次换模型叠上来时回到宿主的模型，宿主接受的那次算作回退的目标，别的工作区或面板关着时的 diff 不收，面板换工作区或换模式后不显示旧的文件；id 过长的模型不列、没有默认；草稿：恢复不覆盖已有的文字、粘贴、文件或图片，只有图片的草稿也转交，别处改了存储后跟上，存不下的草稿比之后的存储优先，一个监听停了别的照常，换图片只通知所在的草稿；diff 解析：多位数的计数、只在行首切分、像 hunk 头的行、二进制判断的边界、CRLF，按额度给行数的边界和顺序；git：origin/HEAD 没了时比 origin 的同名分支，在主干上而 origin 没有主干时不显示基准（不拿主干和自己比），已跟踪的二进制文件改了显示为二进制，没有共同历史时什么也不显示，只有删除，未跟踪文件只数前 500 个，已提交模式不含未跟踪文件，缺对象时"读不到改动"，预先取消，大文件数行；服务：重复显示不重发、集合变大时原来的照常收，首次结果前不再显示的连接不发，面板还开着时最后一个看数字的离开也继续监听，没人看后再显示时重新开始监听，看的工作区不见了时什么也不做，按模式各发各的、新开的面板收到没收过的，换模式不重新监听、换工作区放掉旧的，断开放掉面板的工作区，关掉的面板不影响别人再看，面板 150 毫秒只算 diff，diff 失败记日志接着算下一个模式，顶层 `.gitignore` 变了照新列表忽略，读的途中放掉的工作区不再排计时、不记日志、不建监听，不在仓库里时不监听，一次只跑一个查看，关闭时停掉一切并等查看结束、之后什么都不做，重试监听 30 秒、60 秒翻倍，不再是仓库时继续重试，轮询时面板的 diff 也更新，git 主动停下不记日志，非 Error 记为 unknown；真实 `fs.watch` 递归报告深处的路径、停止后放掉、监听不了时返回后报错 | `session-controller.test.ts` "as pi's queue grew by"、"after the run ended"、"took the steers back"、"without images"、"nobody listening"；`attachments.test.ts` "count alone"、"on its way"；`file-search.host.test.ts` "though the directory has one"；`ws-server.host.test.ts` "a connection closing"；`atrium-client.test.ts` "a third change"、"the model to go back to"、"another workspace's diff"、"moves to another in the same mode"、"switches to the other"；`query.test.ts` "too long"；`drafts.test.ts`；`diff-text.test.ts` "weighFiles"、"isLikelyBinary"、"at a header's start"、"more than one digit"；`checkout.host.test.ts` "rather than comparing main with itself"、"tracked binary file"、"origin's own branch"、"no history in common"、"lines removed alone"、"first 500"、"among a branch's commits"、"object gone"、"called off"、"a chunk at a time"；`changes-service.test.ts` "who is shown what"、"the panel's targets"、"the ignored directories"、"looks"、"closing"、"watching again"；`watch-directory.host.test.ts` | 已覆盖 |

## 状态栏（M1.8）

| 行为 | 测试 | 状态 |
|---|---|---|
| 协议：会话指标（轮、步、token、费用、推理、当前分支、上下文、计时，允许未知）、快照的 `metrics`、`metrics_updated`、偏好的 `statusBar` 与 `set_preferences` | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| pi：条目里助手消息的四种 token 和推理 token、系统消息的大小（正文、分段、增减的工具）、压缩条目的系统提示词检查点；系统提示词和工具定义的回放与估算和 pi-ai 的 `getCurrentSystemMessage`、pi 的 `estimateTokens` 一致（含录制的会话）；`get_session_stats` 的映射（没有模型、压缩后、窗口为 0、异常数值）；契约：真实 pi 的统计按整个文件数，和条目相加一致；事件翻译的 `request_started`、`output_started`；夹具把统计里的 token、费用、百分比归一化 | `history/log-entry.test.ts`、`history/system-prompt.test.ts`、`stats/session-stats.test.ts`、`contract/stats.pi.test.ts`、`events/translate.test.ts`、`testkit/src/pi-fixtures/normalize.test.ts` | 已覆盖 |
| 宿主：读统计的时机（pi 启动、每条回复、压缩、运行结束、换模型）、一次只读一次、读失败保留旧值只记原因（pi 退出不记）、关闭后不再发布；从 `turn_start` 计时：首 token 平均、模型用时（含失败）、最近一次的输出速度、请求里的压缩不算、pi 换掉时丢掉未完成的计时；条目算出整个文件的推理 token、当前分支的 token 和上下文分段；起始条目不发布；控制器接上后快照带指标、变化推 `metrics_updated`、崩溃后读新 pi；偏好保存改过的分组、整份替换、旧文件和非法 id | `sessions/session-metrics.test.ts`、`session-controller.test.ts` "status bar figures"、`session-manager.test.ts`、`store/preferences.test.ts`、`server/router.test.ts`、`chat.host.test.ts`、`transcript/session-log.test.ts`、`session-transcript.test.ts` "entries" | 已覆盖 |
| 客户端：快照和 `metrics_updated` 的指标、`statusBar` 整份替换 | `packages/client/src/session-view.test.ts` "status bar figures"、`index-view.test.ts` | 已覆盖 |
| 界面：数字格式（K、M、千分位、秒、tok/s、≈ $）、缓存命中、上下文比例与 70%/85% 变色、分段（不小于 0）、分组注册表与默认、只记与默认不同的选择；状态栏默认三组、按选择显示、未知显示"—"、悬停卡片（鼠标移开就收起，点过之后也收起，键盘聚焦时弹出；会话统计、Token 用量含推理与当前分支、上下文分段、没有窗口和刚压缩、费用）、调节面板（预览、开关、恢复默认、Esc 和点外面关闭、Esc 不传给输入框）；对话区里显示会话的指标、空状态不显示、选择发给宿主；状态栏高 28px、离输入框 4px、离底边 8px，输入框文字离卡片左边和上边 20px，空状态和会话里输入框位置一致（2026-10-12） | `packages/ui/src/chat/status-figures.test.ts`、`status-bar.browser.test.tsx`、`chat.browser.test.tsx` "status bar" | 已覆盖 |

## 并行、同步与关注（M1.9）

| 行为 | 测试 | 状态 |
|---|---|---|
| 列表同步 · 宿主：整份列表按 id 比出变化，每批变化取下一个 `seq`、各客户端共用；30 毫秒内的变化合成一批；布局只发给自己、不占 `seq`；带游标订阅时补发游标之后的变化（布局和偏好整份），别的宿主、早于记住的删除、比游标落后超过 200 项、游标超前时发快照并写明原因；断开的连接不再发，关闭后不再推 | `packages/host/src/sync/index-feed.test.ts`、`sessions/index-commands.test.ts` | 已覆盖 |
| 列表同步 · 客户端：快照整份收下，变化只在同一 generation 上应用（原位替换、新的放末尾）；重连时带上自己的游标订阅 | `packages/client/src/index-view.test.ts`、`atrium-client.test.ts` | 已覆盖 |
| 先读到自己的写：宿主应答一个连接的命令前先把等着发给它的列表变化发出去（解析不了的消息不算）；客户端改布局的命令（打开、关标签、选容器）没应答前保留自己选的布局，全部应答后换成宿主最新的布局，失败的命令也就此回退 | `sync/index-feed.test.ts` "flushed"、`sessions/index-commands.test.ts` "IndexCommands.answering"、`server/router.test.ts` "before answering any of its commands"、`atrium-client.test.ts` "keeps the tab chosen while a layout the host made before reaches it" | 已覆盖 |
| 关注 · 宿主：运行失败（轮次自己失败、有错误原文）标"出错"，像凭据问题的标"待授权"；崩溃重启用尽也标；一次运行只标一次；下次运行开始时去掉；看过只清"出错"，标记写进索引、重启后还在；等待回答的时间在对话框出现时记、没有对话框或 pi 退出时去掉 | `session-manager.test.ts` "SessionManager attention (M1.9)"、`session-catalog.test.ts`（标记）、`server/router.test.ts` | 已覆盖 |
| 关注 · 界面：状态优先级（待回答 > 待授权 > 出错 > 运行中）和图标；工作区状态不算归档的；收件箱跨项目汇总、按优先级再按时间排、最多显示 5 条可展开；显示出错的会话时（窗口有焦点或获得焦点）发 `clear_attention` | `packages/ui/src/sidebar/status.test.ts`、`workbench.browser.test.tsx` "status"、"inbox"、"attention and hand-off" | 已覆盖 |
| 交给终端 · 宿主：草稿、忙（运行、提交、停止、重启、排队里还有消息）、不认识的会话被拒；标记写进索引后停掉 pi、应答文件；之后打开不启动 pi，会启动或写 pi 的命令应答 `session_handed_off`；重启后标记还在；`take_back` 去掉标记并在新 epoch 启动 pi | `session-manager.test.ts` "SessionManager handing off (M1.9)"（含排队、消息在途、重启中）、`server/router.test.ts` | 已覆盖 |
| 交给终端 · 客户端与界面：`hand_off`、`take_back`、`clear_attention` 命令；菜单项（草稿、运行中置灰），复制 `pi --session '<文件>'`（单引号转义），失败提示；交接后的面板（再复制、"在 Atrium 里继续"） | `atrium-client.test.ts`、`packages/ui/src/tabs/hand-off.test.ts`、`workbench.browser.test.tsx` "attention and hand-off" | 已覆盖 |
| 宿主重启后（`hostInstanceId` 变了）界面重新打开、重新订阅正在显示的会话 | `chat.browser.test.tsx` "ConversationArea after the host restarted" | 已覆盖 |
| OneShotPi：`--mode json -p --no-session --no-tools --thinking off --model … --system-prompt …`，内容从标准输入给；取最后一条回复的文字；回复出错或中止、退出码非 0、没有回复或没有文字、超时（停掉整棵进程树，读不到进程树时只杀 pi）、中止都算失败，只记原因；中止在先时不启动；契约：真实 pi 的 print 模式 | `packages/pi/src/oneshot/oneshot.test.ts`、`oneshot.pi.test.ts` | 已覆盖 |
| faux 模型在 `-p` 下用脚本的 `title` 回答，没写时回错误，不写 `pi.pid` | `packages/testkit/src/faux/faux.pi.test.ts` "print mode" | 已覆盖 |
| 自动标题：输入（用户消息最多 1200、总共 2000，按字符截）、整理（第一行、成对引号、末尾标点、50 个字符、整理后为空算失败）、第一轮的文字和回复的最后一段；一个会话同时只生成一个，失败只记原因、下次运行结束再试，写不进去只记原因，关闭时取消；宿主：运行结束重扫后、会话已写出文件、没名字、有模型时在会话目录用会话的模型调用，经会话自己的 pi 写回；生成期间有了名字或交给终端时丢弃；关闭时停掉一次性的 pi；控制器给出从头开始的全部条目 | `packages/host/src/sessions/titles.test.ts`、`session-manager.test.ts` "SessionManager titles (M1.9)"、`session-controller.test.ts` "beyond what a snapshot holds" | 已覆盖 |
| 端到端：三个会话并行，切换标签、断网重连、宿主重启后状态和对话记录正确；后台出错进收件箱，点开后切到它、收件箱清掉、标签上的图标还在；交给终端（复制的命令和面板上的一样，重启后面板还在，接回后能继续对话）；第一次运行结束后用模型起名，标签和历史里都显示 | `apps/desktop/e2e/parallel.spec.ts`、`inbox.spec.ts`、`hand-off.spec.ts`、`chat.spec.ts` "names a chat with the model" | 已覆盖 |
| 泄漏 · 宿主：真实宿主、真实客户端和脚本 pi 下，新建再关掉对话、订阅再退订运行中的会话、订阅着列表和运行中的会话时连接直接断掉、发消息再停止，各 200 次后资源计数（含新加的会话订阅数 `sync.subscription`）、Node 的定时器、管道、套接字、子进程都回到基线；崩溃重启 200 次见会话控制器的泄漏测试 | `packages/host/src/sessions.leak.test.ts`、`sessions/session-controller.leak.test.ts`、`sync/subscriptions.test.ts` | 已覆盖 |
| 泄漏 · 界面：在三个带 Markdown 和代码块回复的会话之间来回切换 15 轮，不留脱离的 DOM | `apps/desktop/e2e/sessions.leak.spec.ts` | 已覆盖 |
| 浸泡：真实宿主和 faux pi，三个对话每轮同时运行，一个中途停止、一个每轮被杀掉 pi（按精确 pid）后自动重启续做、一个跑完，每轮运行中断开连接再换新连接，每 30 轮归档换新；每轮核对三者的结果，结束时资源计数、子进程回到基线，每轮堆增长 < 1KB | `packages/host/test/soak/sessions.soak.test.ts` | 已覆盖 |
| 变异测试补测（2026-10-10，M1.9）· OneShotPi：最后一行没有换行也读到，跳过不是助手 `message_end` 的记录（缺 `message`、为 null 或字符串、用户消息、`message_update`），没有内容的回复算没有回复；stderr 再多也读掉；pi 没读内容就退出算 `exited`；pi 起的进程攥着管道时 pi 退出 1 秒后照样应答；结束后不留定时器、不再理会中止；错误名。列表同步：删除也算进变化数，变化数正好到上限时仍发变化；`flush` 只发给那个连接，没有待发的变化时不重建列表；项目、工作区按 id 区分。客户端：列表到达前选的容器在应答后保留；失败的命令回到宿主的布局，不被别的宿主的变化带偏。停止：pi 不回应清队列时，pi 退出后停止照样结束（确认了的和没确认的）；长期存在的 pi 被停 200 次后不留住任何一次停止的上下文（泄漏测试）。会话目录：丢弃草稿只丢那一个，工作区不在了的草稿不归到对话下。标题：只有一个引号不算标题，引号里的空白去掉，标题要求的原文。收件箱：标为已看的"待授权"仍在收件箱。`windowFocused` 通知工作区 | `oneshot.test.ts` "without a line break"、"however much"、"without reading"、"keeps its pipes open"、"leaves the signal alone"、"OneShotError"；`index-feed.test.ts` "counts removals"、"only the connection flushed"；`index-view.test.ts` "by their ids"；`atrium-client.test.ts` "before the first list"、"not to one changes of another host left"；`session-controller.test.ts` "ends a stop once pi exits"；`session-controller.leak.test.ts` "context of each of 200 stops"；`session-catalog.test.ts` "and only it"、"once its workspace is gone"；`titles.test.ts`；`status.test.ts`；`index-commands.test.ts` "windowFocused" | 已覆盖 |
| 三方审查后补（2026-10-10，M1.9）· 交接：交接停 pi 的途中拿回来，等交接做完再起新 pi；pi 应答 `started`、运行还没开始时不让交接；菜单在消息发送中、运行中、停止中、重启中、宿主排队里有消息时置灰。归档：pi 第一次启动途中归档，启动完就停掉，不留控制器和进程。标题：改名后、重扫找到名字之前生成好的标题丢弃。关注：同一次运行里前一轮失败、最后完成或被停止的运行不标记；`asking` 是还没回答的对话框里最早那个出现的时间。列表同步：订阅者上次收到的序号早于已经忘掉的删除时推快照，正好在边界上照常推增量；宿主推送前一批失败时命令照样应答并记日志；客户端：布局命令失败时回到宿主发来的布局，不被期间不带布局的增量带偏。宿主重启而页面一直开着：页面在新宿主上立刻重新打开显示的对话，之后照常对话 | `session-manager.test.ts` "only once its hand-off has stopped pi"、"before the run begins"、"archived while it started"、"renamed meanwhile, though its file"、"after one of its turns failed"、"oldest dialog still unanswered"；`workbench.browser.test.tsx` "cannot hand off a session with"；`index-feed.test.ts` "removed more than it keeps"；`router.test.ts` "though sending the list changes"；`atrium-client.test.ts` "without a layout came meanwhile"；e2e `parallel.spec.ts` "opens the chat shown again when its host restarts under a page that stays" | 已覆盖 |

## 首次启动与设置（M1.10）

| 行为 | 测试 | 状态 |
|---|---|---|
| 找 Node：PATH 上没有为缺失；22.19.0 可用、22.18.9 版本过低；运行不了、不报版本、超时（杀掉）、中止都算缺失；用搜索路径作 PATH 运行 | `packages/pi/src/locate/node.test.ts` | 已覆盖 |
| 找 Homebrew：先找 PATH，再按顺序找安装位置；都没有为空 | `packages/host/src/setup/homebrew.test.ts` | 已覆盖 |
| 宿主的工具（Toolbox）：启动前不检测，之前问的拿到第一次的结果；重新检测排在进行中的之后，之后都用新结果；同时请求的共用一次；没找到时保留之前的；关闭时中止进行中的并等它，之后不再检测；没启动就关闭为空。启动时一并查 pi、Node、Homebrew、fd，空 PATH 下都没有 | `packages/host/src/setup/toolbox.test.ts`、`packages/host/src/tools.host.test.ts` | 已覆盖 |
| 登录程序找 pi 包：从 `pi` 的真实路径往上找名为 pi 的包，跳过别的名字、没有入口的、不是 JSON 或不是对象的 `package.json`，找不到、命令不存在时为空；真实 pi 的入口 | `packages/pi/src/auth/login.test.ts` "piPackageEntry"、`login.pi.test.ts` | 已覆盖 |
| 登录状态：列出服务商、OAuth 的名称、按钮文字和是否订阅、能否存 Key、已登录的方式和是否存在 `auth.json`（环境变量的 Key 不算存的）；真实 pi 的 anthropic、openai、openrouter 和环境变量里的 DeepSeek Key | `login.test.ts` "lists providers"、`login.pi.test.ts` | 已覆盖 |
| 登录过程：pi 的设备码、进度、提示、授权地址和提问原样转出，按 id 回答；pi 问登录方式时自动选浏览器；API Key 交给第一个密码类提问，其余提问照常转出，没给 Key 时全部转出；pi 撤回提问时告知，迟到的回答丢掉；pi 打印的非 JSON 行忽略，stderr 不读也不堵；设备 ID 用 pi 自己的；真实 pi：anthropic 的浏览器登录给出授权地址和粘贴回调的提问，取消后释放回调端口，Cloudflare 的账户 ID 提问，存 Key（权限 600）和退出 | `login.test.ts`、`login.pi.test.ts` | 已覆盖 |
| 登录失败与结束：带 pi 原文失败（报错、抛出的不是 Error、`auth.json` 坏了）；程序没说结果就退出算失败；pi 包缺少要用的接口算不可用；退出登录被拒带原文；查询和退出超时杀掉；取消后 3 秒不走就杀整棵进程树，读不到进程树时只杀程序；超时后再取消仍算超时；信号已中止时不启动，中途中止算取消，结束后不再理会信号；宿主走掉（标准输入关闭）时程序中止并退出、释放端口；资源计数回到 0 | `login.test.ts`、`login.pi.test.ts` "when the host goes away" | 已覆盖 |
| 宿主的登录状态（Logins）：列出能 OAuth 或能存 Key 的服务商，隐藏 `openai-codex` 和 `radius`，按钮文字没有时用 OAuth 名称；没有登录程序、没检测到工具、pi 或 Node 不可用、pi 不是能加载的包时不可用；查询失败时不可用，日志只记原因不记 pi 原文；关闭时中止进行中的查询并等程序退出 | `packages/host/src/setup/logins.test.ts` | 已覆盖 |
| 首次启动的检查（`check_setup`）：pi 就绪、损坏（带原文）、版本过低、缺失，Node 就绪、过低、缺失，Homebrew、fd 有无，登录状态和项目数；`refresh` 时重新读登录 shell、找到期间装好的 pi，不带时沿用上次的结果；检测失败时都算缺失；查完登录状态才读最新版本，取到期间找到的；pi 的报错截到 16 KiB；重新读登录 shell 后，之前环境里的凭据照样脱敏；Homebrew 不在 PATH 里时加到工具环境 PATH 的末尾，找得到它装的 Node；协议校验命令和结果，客户端发出 | `packages/host/src/setup/setup-service.test.ts`、`packages/host/src/setup/homebrew.test.ts` "withHomebrewOnPath"、`packages/host/src/tools.host.test.ts` "an earlier environment"、"outside PATH"、`packages/host/src/setup.host.test.ts`、`packages/host/src/server/router.test.ts`、`packages/protocol/src/envelope.test.ts`、`packages/client/src/atrium-client.test.ts` "first launch" | 已覆盖 |
| 客户端的首次启动状态：问过之前为空，问的时候保留上次的结果，只有最后一次问的结果（或失败原因）落下；问过以后，宿主说 pi 的凭据变了（`credentials_changed`）、安装成功、连上新的宿主时自动再问，凭据变了时还重新读请求过的模型列表；连上新的宿主时清掉旧宿主的登录和任务；宿主找到的最新 pi 直接放进去，和 `check_setup` 的回答交错时留检查时间较晚的 | `packages/client/src/atrium-client.test.ts` "first launch" | 已覆盖 |
| 登录与退出（`login`、`answer_login`、`cancel_login`、`logout`）：经装好的 pi 登录，pi 说的和问的整份广播给所有连接（另一个窗口也看到、也能作答），回答后提问去掉；API Key 交给第一个密码类提问；结束为成功、取消或带 pi 原文的失败，提问清空；授权地址或设备码页面不是 https 时不显示、取消并以 `insecure_url` 失败；新登录取消进行中的、等它的程序退出才开始（同一时刻只开一个程序），按请求顺序开始，登录不可用时不取消进行中的；退出登录先取消同一服务商进行中的登录、等它开始完，别的服务商的不动；登录成功和退出后广播 `credentials_changed`；pi 的文字（提问、选项、说明、进度、报错）截到 16 KiB；记住最后一次登录和安装的状态，后连上的连接立即收到，安装不带输出；只认进行中的登录，其余 `login_not_found`；没有工具时 `login_unavailable`；退出被拒为 `logout_failed` 带原因和原文；日志只记服务商、方式、结果和原因，不记 Key 和 pi 原文；关闭时取消进行中的并等程序退出；协议校验命令、结果和事件，路由转交，客户端发出并保存最新的登录状态 | `packages/host/src/setup/login-service.test.ts`、`packages/host/src/setup.host.test.ts` "signing in and out"、"a window that comes later"、`packages/host/src/sync/subscriptions.test.ts` "broadcast"、`packages/host/src/server/router.test.ts` "hands the login commands"、`packages/protocol/src/envelope.test.ts`、`packages/client/src/atrium-client.test.ts` "signs in and out" | 已覆盖 |
| 运行安装任务（runJob）：在给定的目录和环境里运行，标准输出和标准错误一起转出，跨两次写入的字符保持完整；有输入时从标准输入给出后关闭，没有时立刻关闭；取消时 SIGTERM 整个进程组，忽略的在宽限后强制结束整棵树；命令退出时结束留在组里的进程，组外进程占着输出时宽限后不再等；启动不了、已取消时不启动；资源计数回到 0 | `packages/host/src/setup/install-job.test.ts` | 已覆盖 |
| 下载安装脚本：跟随同一服务器上的跳转；跳到别的服务器、跳转过多、非 200、超过 1 MiB、超时、连不上都失败并给出原因；取消时停止 | `packages/host/src/setup/install-script.test.ts` | 已覆盖 |
| 安装与更新（`install_pi`、`install_node`、`update_pi`、`cancel_install`）：装 pi 把下载的脚本交给 `sh -s`，装 Node 运行找到的 `brew install node`，更新运行 `pi update`，都在给定目录、登录 shell 的环境里；输出整段广播给所有连接，不进日志，日志只记种类、结果、退出码和原因；更新等运行中的会话结束，期间显示还在运行的数目，等待时取消不运行 pi，不再监听会话；下载失败、启动不了、非零退出分别以 `download_failed`、`spawn_failed`、`exit` 失败；同一时刻一个任务（`install_busy`），没有工具、没有 Homebrew、没有 pi 时 `install_unavailable` 且不占位；只认进行中的任务（`install_not_found`）；取消运行中、等待中、下载中的任务；关闭时取消并等进程退出，之后不再接任务；成功后先重新检测工具（失败只记日志）再报告 `ok`，失败、取消时不做；更新运行时（等待时不）要启动 pi 的会话等它结束；更新后 `check_setup()` 已是新版本；会话管理器停掉空闲会话的 pi（`requested`），运行中的、有对话框等回答的不动，正在启动的（打开的会话、新建的对话）等启动完再停，下次打开时重新启动；`InstallService.last` 记住最后一个任务；协议校验命令、结果和事件，路由转交，客户端发出、保存最新任务和最后 1 MiB 输出，忽略不认识的任务的输出 | `packages/host/src/setup/install-service.test.ts`、`packages/host/src/sessions/session-manager.test.ts` "after pi is updated"、`packages/host/src/setup.host.test.ts` "installing"、`packages/host/src/server/router.test.ts` "hands the install commands"、`packages/protocol/src/envelope.test.ts`、`packages/client/src/atrium-client.test.ts` "installs and updates" | 已覆盖 |
| pi 新版本检查：向 pi.dev 的最新版本地址要 JSON，读出去掉空白的 `version`；不是 JSON、没有或不像版本号、超过 64 KiB、非 200、跳转、超时、连不上都失败并给出原因，取消时停止；启动后检查一次、之后每天一次，`check_pi_update()` 立即检查并共用进行中的一次；找到的版本和时间广播给所有连接，失败保留上次结果、日志只记原因；pi 的环境有 `PI_OFFLINE` 或配置为不检查时不发请求但保留定时；关闭时停掉进行中的检查和定时；`check_setup()` 带上最新版本；协议校验命令、结果和事件，路由转交，客户端发出、保存最新结果；测试宿主和 e2e 默认不检查 | `packages/host/src/setup/pi-latest.test.ts`、`packages/host/src/setup.host.test.ts` "the latest pi"、`packages/host/src/setup/setup-service.test.ts`、`packages/host/src/server/router.test.ts` "hands the install commands"、`packages/protocol/src/envelope.test.ts`、`packages/client/src/atrium-client.test.ts` "looks for the latest pi"（放进首次启动状态） | 已覆盖 |
| 从 pi 历史发现项目（`discover_projects`）：按 pi 存会话的位置（每个工作目录一个文件夹，或配置的目录本身）只读每个会话文件的第一行，按文件头的 `cwd` 统计会话数和最近修改时间，同一文件夹里不同 `cwd` 分开算，不是会话、没有 `cwd`、文件头没写完、不是 `.jsonl` 的、不是普通文件的（坏链接、管道）跳过，按工作目录分的文件夹是符号链接时跟进去，打开的文件都关上，目录不存在时为空，取消时停止；宿主按真实路径合并，去掉已添加的项目和它们的工作区（其中的子目录照常列出）、Atrium 对话目录下的（只按整段路径比较）、已不存在的和不是目录的，按最近使用排列；没检测到工具时为空；协议校验命令和结果，路由转交，客户端发出 | `packages/pi/src/sessions/session-files.test.ts` "sessionDirectories"、`packages/host/src/projects/discovery.test.ts`、`packages/host/src/sessions/index-commands.test.ts` "discoverProjects"、`packages/host/src/setup.host.test.ts` "finding projects"、`packages/host/src/server/router.test.ts` "looking for projects"、`packages/protocol/src/envelope.test.ts`、`packages/client/src/atrium-client.test.ts` "directories of pi's history" | 已覆盖 |
| 项目的主干分支（`list_branches`、`set_main_branch`）：列出 `origin` 上最近取回的分支（按名字，去掉 `HEAD`）和 `origin/HEAD` 指向的分支，不是仓库或没有 git 时都为空；选 `origin` 上的分支为主干、`null` 恢复自动，不在 `origin` 上的（含 `HEAD`）应答 `branch_not_found` 且不改，未知项目 `project_not_found`；改了之后重新扫描这个项目的工作区并重新计算改动，别的项目不动；列表里的项目带 `mainBranch`；worktree 的领先提交数按选的主干计；协议校验命令、结果和错误码，路由转交，客户端发出 | `packages/host/src/projects/project-service.test.ts` "branches"、"setMainBranch"、`packages/host/src/sessions/index-commands.test.ts` "setMainBranch"、`packages/host/src/index.host.test.ts` "main branch chosen"、`packages/host/src/server/router.test.ts` "choosing the main branch"、`packages/protocol/src/envelope.test.ts`、`packages/client/src/atrium-client.test.ts` "chooses main branches" | 已覆盖 |
| 偏好里的 `setupDone`、`titleModel`：默认首次启动未完成、跟随会话的模型，M1.10 之前的文件读作这样；`set_preferences` 改它们（`titleModel` 可设回 `null`），写进文件；协议校验 | `packages/host/src/store/preferences.test.ts`、`packages/host/src/server/router.test.ts`、`packages/protocol/src/envelope.test.ts` | 已覆盖 |
| 标题模型：设置里选了且 pi 在会话的目录里列出它（同一服务商、同一模型；对话按模型面板的问法问 Atrium 的数据目录，只看对话根目录之内的）时用它生成标题，没选、没列出或查不到时用会话的模型，查的时候关掉会话则不再生成；在 Atrium 里登录成功或退出后清空所有目录的模型列表缓存，进行中的查询结果也不留，关闭时照样等它结束 | `packages/host/src/sessions/titles.test.ts` "title model"、"titleModelLookup"；`session-manager.test.ts` "title model chosen"；`packages/pi/src/catalog/model-catalog.test.ts` "told to forget"、"under way when told to forget"；`packages/host/src/setup/login-service.test.ts` | 已覆盖 |
| 设置面板：侧栏底部"设置"或 ⌘, 打开，再按 ⌘, 关上；Esc、关闭按钮、点面板外关闭，点面板里不关；打开时焦点在面板里；停在上次看的分类，记在本机，重新载入后也是，记的不是分类时从外观开始；工作台显示时问一次首次启动的状态；有新版本 pi 时侧栏"设置"和 pi 分类各有一个蓝点，别的分类没有，装上后消失 | `packages/ui/src/settings/settings-panel.browser.test.tsx` | 已覆盖 |
| 设置 · 外观与关于：三段外观和侧栏的外观切换是同一个偏好；关于里有 Atrium（宿主）的版本、与宿主的连接（已连接、重连中）、pi 的版本和日志文件夹，在访达中显示日志文件夹 | `packages/ui/src/settings/settings-panel.browser.test.tsx` | 已覆盖 |
| 设置 · 模型与账户：订阅按 SPEC 的顺序列出 pi 提供的（pi 新加的 OAuth 服务商排在后面），已登录的有"退出"，用 Key 登录的订阅行不给"退出"；只有本窗口发起的登录打开授权页，同一次登录只开一次，另一个窗口的登录只显示进度；授权页可再打开，设备码可复制、打开验证页，pi 的选择、文字提问和折叠的回调地址按 id 作答，可取消；失败显示原因和 pi 原文，已登录的行不显示；开始不了时说明；退出或删除最后一个凭据时先问，可取消或仍要，不是最后一个时直接去掉；pi 去不掉时说明；Key 按服务商列出，存的可删、环境变量的不可删；添加 Key 只列能存 Key 且没登录的服务商，空的或全是空白的不发，去掉首尾空白后登录，进行中不能再存，本次登录成功后收起，失败留着并显示原因，别的窗口的 Key 登录不影响；登录用不了时指向终端的 `/login`；标题模型从对话的模型里按服务商分组选，或跟随会话的模型，同名模型按服务商区分，选的模型不在列表里时（列表读完后）提示暂用会话的模型 | `packages/ui/src/settings/accounts-section.browser.test.tsx`、`packages/ui/src/setup/providers.test.ts` | 已覆盖 |
| 设置 · 项目：每个项目的主干分支从 `origin` 的分支里选，标出 `origin/HEAD`，自动时显示它指向哪个；选的就是当前的时不发命令；"恢复自动"；没有主干时提示合并状态未知；分支不在 `origin` 上了或读不到分支时说明；没有项目时指向侧栏 | `packages/ui/src/settings/projects-section.browser.test.tsx` | 已覆盖 |
| 设置 · pi：位置（在访达中显示，桌面应用之外不给）、当前版本、最新版本（相同时标"已是最新"）、上次检查；检查更新时按钮忙；有新版本时"更新 pi"，之后等会话（可取消）、运行中显示输出并跟到最新一行（可取消）、失败显示完整输出和"重试"并自动展开手动更新、成功后重新检测期间显示"已更新"、之后显示到达的版本和可展开的日志，又发现更新的版本时再给"更新 pi"；取消后、别的安装任务都不影响；手动更新可复制 `pi update`，"我更新好了，重新检测"重新读登录 shell；开始不了时说明原因；读不到状态时说明。版本比较按数字、预发布早于正式版、忽略构建信息；安装输出去掉颜色和控制序列，`\r` 覆盖本行 | `packages/ui/src/settings/pi-section.browser.test.tsx`、`packages/ui/src/setup/pi-version.test.ts`、`packages/ui/src/setup/terminal-text.test.ts` | 已覆盖 |
| 设置 · pi · 网络代理（2026-10-11）：只收 `http`、`https` 的主机和端口，不收路径、查询、用户名密码，"不走代理"里不收空项、空白和逗号，拒绝时应答 `proxy_invalid`（`reason`）且什么都不改；地址存成一种写法（去空白和斜杠、小写）；没设时偏好读作 `null`，手改出的不合要求的代理读作没有；设了之后交给 pi 和安装、登录的环境里四个代理变量都是它，`NO_PROXY` 总带本机地址、去重，没设时环境不动；每次取工具时读设置，之后启动的用新的；宿主自己查最新版本、下载安装脚本按这份环境的代理走（小写优先，https 没设时用 http 的，`NO_PROXY` 里的直连，不用宿主自己的环境变量），请求完关掉连接；日志只记代理来自设置、登录 shell 还是没有，不记地址；客户端等宿主确认后才显示代理；界面：填地址和不走代理的地址（换行、逗号分隔），没改不能保存，保存中按钮等待，"不用代理"清除，宿主拒绝的四种原因和其他失败分别说明 | `packages/host/src/platform/proxy.test.ts`、`packages/host/src/setup/toolbox.test.ts` "withProxySetting"、`packages/host/src/setup/pi-latest.test.ts` "fetch it is given"、`packages/host/src/setup/install-script.test.ts` "fetch it is given"、`packages/host/src/store/preferences.test.ts` "no proxy"、`packages/host/src/sessions/index-commands.test.ts` "setPreferences"、`packages/host/src/setup.host.test.ts` "the proxy set"、`packages/host/src/tools.host.test.ts` "where the proxy comes from"、`packages/host/src/server/router.test.ts`、`packages/protocol/src/envelope.test.ts`、`packages/client/src/atrium-client.test.ts` "shows a proxy only once"、`packages/ui/src/settings/proxy-group.browser.test.tsx` | 已覆盖 |
| 首次启动 · 什么时候显示：宿主的第一份列表到之前窗口空着；`setupDone` 为假时从欢迎页开始，不显示步骤条；之后只在 pi 不可用时从第 1 步开始，没有"返回"，pi 一可用就回到工作台；首次启动的状态没读到或读失败时显示工作台；显示后别的窗口设了 `setupDone` 也不中途关掉；都已满足时一开始就结束、设 `setupDone`、回到工作台；因 pi 不可用进来的结束时不再设 `setupDone` | `packages/ui/src/setup/first-launch.browser.test.tsx` "when it shows"、"begun because pi cannot be used" | 已覆盖 |
| 首次启动 · 问 `check_setup` 的时机：连上宿主之前不问，连上后问一次，重连后再问一次 | `packages/ui/src/setup/first-launch.browser.test.tsx` "asks what first launch checks once connected, and again after reconnecting" | 已覆盖 |
| 首次启动 · 端到端：新的数据目录从欢迎页开始，登录不可用时继续，第 3 步列出 pi 会话里的目录、默认勾选，添加后回到工作台并把 `setupDone` 写进偏好，再次打开直接是工作台；其他端到端用例的数据目录预先写好 `setupDone` | `apps/desktop/e2e/first-launch.spec.ts`；`apps/desktop/e2e/launch.ts`（`markSetupDone`） | 已覆盖 |
| 首次启动 · 欢迎页与步骤之间：logo 位是 Atrium 的猫（图片加载出来，作为装饰不进无障碍树）；胶囊打开 pi.dev；"开始设置"跳过已满足的步骤；步骤条标出完成的和当前的；回车按主按钮，按着修饰键、焦点在别的按钮上、主按钮不可用时不按；一路返回到欢迎页，返回的第 1 步显示 pi 已就绪（版本、位置）和"继续"；pi 一可用自动前进到第一个没满足的步骤 | `packages/ui/src/setup/first-launch.browser.test.tsx` "welcome and moving between steps"（含 "logo slot"） | 已覆盖 |
| 首次启动 · 第 1 步：装 pi 时终端先显示要运行的命令，之后实时输出、等待会话的说明、运行中可取消（发 `cancel_install`）、取消后可再装；安装脚本 / npm 切换命令并可复制；失败按原因说明（退出码、中途结束、启动不了、下载不了）并可重试；拒绝开始时说明；"我已经装好了"带 `refresh` 重新检测，还没有时提示；任务跑完还是没有 pi（或 Node.js）时提示并可重新检测；版本过低时更新 pi，"我已经更新了"；缺 Node 有 Homebrew 时说明缺什么、用 Homebrew 装、本窗口发起的装好后接着装 pi（显示在第 1 步，失败可重试），别的窗口的不接着装；没有 Homebrew 时去 nodejs.org 下载；pi 损坏时标题不同、原始报错折叠；检查中等待，检查失败可重新检测 | `packages/ui/src/setup/first-launch.browser.test.tsx` "step 1" | 已覆盖 |
| 首次启动 · 第 2 步：订阅 / API Key 切换，各自的说明；有凭据后"继续"才可用；登录不可用时指向终端的 `/login`（可复制 `pi`）、可重新检测，"继续"可用 | `packages/ui/src/setup/first-launch.browser.test.tsx` "step 2" | 已覆盖 |
| 首次启动 · 第 3 步：列出 pi 历史里的文件夹（会话数、最近使用），最近的默认勾上；勾选改数目，逐个添加后结束并设 `setupDone`；选中的、拖进来的放在最上面并勾上，标"刚选的"，已列出的只勾上，读不出路径的不要；拖到上面时高亮；添加失败的留下并显示第一个原因，加好的去掉，已在某个项目里的（`project_exists`）算加好；没勾时不能添加；桌面应用之外拖放区不可用；"先新建一个对话"新建对话并结束 | `packages/ui/src/setup/first-launch.browser.test.tsx` "step 3" | 已覆盖 |
| 欢迎页按钮的点阵光带：进度 0～1 之外不画；进场窄、中间盖满按钮、离场窄；"\"方向倾斜；白点，同种子同图案；变速曲线的取值；扫完一次后下一次在开始后 6 秒、悬停扫过后恢复平时的速度，离开期间错过的跳过；页面显示后不久扫一次，两次之间不请求动画帧，悬停立刻扫，卸载后不再画 | `packages/ui/src/design/dots.browser.test.ts` "paintBand"、"easeBand"、"nextBandSweep"；`packages/ui/src/setup/first-launch.browser.test.tsx` "the start button's band" | 已覆盖 |
| 安装 ID 与点阵种子：第一次启动生成 `~/.atrium/install-id`（权限 600），之后沿用，内容不是 UUID 时重新生成；种子为正整数；握手的 `welcome` 带种子和日志文件夹，协议拒绝种子为 0、缺日志文件夹的；客户端连接状态带上；界面在连上前用 1、重连期间沿用，换种子时模型按钮和推理强度框的点阵跟着换 | `packages/host/src/platform/install-id.test.ts`、`packages/host/src/server/ws-server.host.test.ts` "welcomes"、`packages/protocol/src/envelope.test.ts`、`packages/client/src/atrium-client.test.ts`、`packages/ui/src/state/install-seed.browser.test.tsx`、`packages/ui/src/app/workbench.browser.test.tsx` "Workbench dots"、`packages/ui/src/chat/effort-box.browser.test.tsx` | 已覆盖 |

## 每个对话是一个容器（M1.11，2026-10-12）

[ADR-0007](../adr/0007-each-chat-is-its-own-container.md)：每个对话和工作区一样是一个容器，有自己的会话和标签页。

| 行为 | 测试 | 状态 |
|---|---|---|
| 协议：对话 id 是 `cht_` 加目录名（只许字母、数字和 `-`，最长 64），`rename_chat`、`create_session(containerId)`、`list_models(workspaceId \| null)`、`chat_not_found`，列表快照和变化带 `chats`；旧的 `"chats"`、带路径的、过长的、工作区 id 当对话 id 都拒绝 | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| 索引迁移：`sessions.json` v1 里"对话"的记录按工作目录归到各自的对话；`layouts.json` v1 的对话标签分到各自的对话，顺序不变，原来的当前标签在它的对话里仍是当前、别的对话以第一个标签为当前，在"对话"里的客户端去当前标签的对话（当前标签不在任何对话里时哪里都不在），没有记录或不是对话的标签去掉；两个旧文件备份成 `<名字>.v1.bak`；v1 里手改坏的记录（不是对象、对话记录没有目录）照损坏的文件重置；`chats.json` 损坏时单独重置 | `packages/host/src/store/load-index.test.ts`、`index-schema.test.ts` | 已覆盖 |
| 对话名：存在 `chats.json`，清空即删掉记录、不动别的对话，名字没变时不写文件；`rename_chat` 只认目录还在的对话（否则 `chat_not_found`），改完推列表变化 | `packages/host/src/store/chat-records.test.ts`、`sessions/index-commands.test.ts` "IndexCommands.renameChat"、`server/router.test.ts` | 已覆盖 |
| 会话目录：每个对话目录是一个对话，名字不像对话 id 的目录和散落的文件不算，目录删了对话就没了；对话的第一个会话按记录的创建时间、没有记录时按文件修改时间取最早的，归档的不算，全归档了为空 | `packages/host/src/sessions/session-catalog.test.ts` | 已覆盖 |
| 会话管理器：在对话里再建会话，用对话的目录；对话不在时 `chat_not_found`，什么都不记不开；丢弃空草稿时对话里还有别的会话就留着目录；对话里的运行结束不刷新工作区；`list_models(null)` 在 Atrium 的目录 | `packages/host/src/sessions/session-manager.test.ts` "SessionManager sessions in a chat"、"discards a draft"、`model-lister.test.ts` | 已覆盖 |
| 列表同步与客户端：`chats` 集合的快照和增量，按 id 增删改；`renameChat`、`createSession(containerId)`、按工作区或 `null` 取模型 | `packages/host/src/sync/index-feed.test.ts`、`packages/client/src/index-view.test.ts` "by their ids"、`atrium-client.test.ts` | 已覆盖 |
| 侧栏对话行：像工作区一样逐行列出，名称、最近活动（其中会话最近的一次）、最高优先级状态，按最近活动排列；最近 5 个，"显示全部 N 个"原地展开、"收起"收回；会话全归档了的对话不列；名称取别名、第一个会话的标题，第一个会话是草稿时"新对话"；点击时没有打开的标签就打开最近的会话，有就回到它的标签，选中时高亮；"···"重命名、清空即恢复默认，不切过去，对话已不在时说明（发消息时同样） | `packages/ui/src/app/workbench.browser.test.tsx` "lists chats like workspaces"、"names a chat"、"opens a chat's latest session"、"renames a chat"、"explains a chat that went"，`chat.browser.test.tsx` "describes"；纯函数：`packages/ui/src/sidebar/names.test.ts` "chatName" | 已覆盖 |
| 搜索、收件箱与对话区：搜索分工作区、对话、会话三组，对话名不分大小写，只有对话匹配时也列出，点对话切过去；收件箱和搜索的第二行是"对话 · 对话名"；⌘T 和标签栏"+"在当前对话里新建会话，⌘N 新建对话；对话的空状态说明会话建在这个对话里；对话和不在任何容器时按 `null` 取模型、不看 git 改动；设置的标题模型按 `null` 取模型 | `workbench.browser.test.tsx` "finds chats by name"、"collects the sessions that need the user"、"creates a session in the chat"；`chat.browser.test.tsx` "says where a new session goes"、"asks for the models once connected"；`accounts-section.browser.test.tsx`；`names.test.ts` "placeOf" | 已覆盖 |

## Fast（M1.11，2026-10-12）

[ADR-0008](../adr/0008-atrium-own-pi-extension-for-fast.md)：Atrium 自带的 pi 扩展给支持的模型的请求加 `service_tier: "priority"`，输入框里模型按钮左边是开关。

| 行为 | 测试 | 状态 |
|---|---|---|
| 协议（版本 7）：`set_fast` 及其应答、`fast_updated`、`fast_unavailable`，快照的 `fast`、模型的 `fast`（`{speed, moreUsage}` 或 `null`，速度大于 0、不超过 100，多一个键也不行）、偏好的 `lastFast` | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| 哪些模型支持 Fast：只有 `openai-codex`；Codex 模型列表列出的模型照列表（有 `priority` 档才支持，说明里读出速度倍数（整数、小数、`x` 前后可有空白，最多 100）和是否增加额度，说明不是文字或读不出的速度记为不详；不是对象的档位跳过），列表没列出的不支持，没有列表或列表为空时按内置规则（GPT-5.5、5.6、6、6.1 含变体，速度不详、额度增加，5.4 不算）；没有可用 `slug` 的模型跳过；扩展的报告按协议严格校验（含 `null` 的模型、文字的 `fast`），不合规整份作废，失败只收小写代码；模型目录带上 `fast`；`list_commands` 不列出 `atrium-fast`，同名的模板照列 | `packages/pi/src/fast/fast.test.ts`、`catalog/models.test.ts` "what Fast does"、`catalog/commands.test.ts` "Fast switch" | 已覆盖 |
| 扩展：符合 pi 的扩展 API；只注册一个命令；默认关，`on` / `off` 切换，别的词不变；开着时只给支持的模型、是对象的请求体加 priority，返回副本不改 pi 的请求。`tiers`：用 pi 的第一个 `openai-codex` 模型的凭据（登录给的 `baseUrl` 优先），在 `<baseUrl>/codex/models?client_version=99.0.0` 查列表（`baseUrl` 末尾的 `/`、`/codex`、`/codex/responses` 都归到同一处，不在末尾的 `/codex` 保留），带 `Authorization`、从 token 读出的 `chatgpt-account-id`（读不出就不带）、`originator: pi` 和 pi 给的其他请求头（值为 `null` 的不带），结果经 `setStatus("atrium-fast")` 报回；没登录（含 pi 取凭据时出错）、HTTP 错误、不是 JSON、不是列表、列表为空、连不上各报一个代码，不带服务器的原文，查询本身从不失败。第一次 `on` 在后台查，查到前按内置规则，查到后按列表；同时只查一次；有了列表后再 `on` 不再查；之后查失败时保留已有列表 | `packages/pi/src/fast/extension.test.ts` | 已覆盖 |
| pi 契约（1.1.0）：真实 pi 加载扩展后 `get_commands` 列出开关；`/atrium-fast on` 应答 `handled`、不起一轮、不出事件；之后的请求只在支持的模型上带 priority，关掉后不带。`/atrium-fast tiers`：扩展从 pi 的模型注册表拿到凭据，向本机的模型列表服务发一次请求，`setStatus` 在 pi 应答 `handled` 之前作为 `extension_ui_request` 发出；之后列表说不支持的和列表没列的模型都不带 priority。测试工具：faux 可换服务商名，`FAUX_PI_BASE_URL` 换 `baseUrl`（夹具里记作占位符），记下 pi 发出的请求体 | `packages/pi/src/contract/fast.pi.test.ts` | 已覆盖 |
| 宿主查模型列表时问扩展：带 `--extension` 启动短暂的 pi；列出了 `openai-codex` 模型且有开关时才发 `get_commands` 和 `/atrium-fast tiers`（开关混在其他命令里也认），按报告给模型标 `fast`，只认键为 `atrium-fast` 的 `setStatus`，同键的其他请求或其他类型的记录不算；报告是失败、不合规、没有报告、pi 超时或拒绝时按内置规则，只记原因代码；查询在列命令或扩展查询时被中止都照常失败并停掉 pi；没配扩展时不加参数、不多问；真实 pi 上整条链路 | `packages/pi/src/catalog/query.test.ts` "with the Fast extension"、`query.pi.test.ts` "Fast extension" | 已覆盖 |
| 宿主 · 偏好与目录：`lastFast` 默认关、旧文件读作关；会话记录的 `fast`，终端里开的会话切换后也有记录，没变化不写文件 | `packages/host/src/store/preferences.test.ts` "remembers Fast"、`sessions/session-catalog.test.ts` "keeps each session's Fast" | 已覆盖 |
| 宿主 · 控制器：快照带 `fast`；切换后只在变化时发 `fast_updated`、报告选择；pi 失败时原样转出、什么也不变；停止中和退出后拒绝 | `packages/host/src/sessions/session-controller.test.ts` "createSessionController's Fast" | 已覆盖 |
| 宿主 · 会话管理器：pi 带 `--extension` 启动，确认开关在后、开着时先补发 `on` 再读会话；关着时不发；切换记进会话记录和偏好，新的管理器按记录启动；崩溃重启后按会话自己的开关补发；没列出开关的 pi 一条也不发、记警告、`set_fast` 应答 `fast_unavailable`；没配扩展时同样；草稿快照的 `fast`；未知会话；路由转发 `set_fast` | `packages/host/src/sessions/session-manager.test.ts` "SessionManager Fast"、`server/router.test.ts` | 已覆盖 |
| 客户端：快照和 `fast_updated` 的开关；切换先在视图里生效，失败时放回宿主最后接受的，多次切换叠在一起时只在最后一次失败后放回（前一次被接受后才发起的也算在内）；没在看的会话照发、不建视图 | `packages/client/src/session-view.test.ts` "following Fast"、`atrium-client.test.ts` "models" | 已覆盖 |
| 界面：只在当前模型支持时显示 ⚡ 按钮（关是线框、开是强调色实心，`aria-pressed`；只有闪电、没有圈；⚡ 离模型按钮 10.5px、点按区域 32px 见方；能用时光标是小手，不能用时是默认光标；从关变开时播加速动效，打开状态下出现、关掉时都不播）；悬停卡片（鼠标移开就收起，点过之后也收起，键盘聚焦时弹出）写开关状态、速度（"约 N 倍速度"，不详时"更快"）、额度增加时"额度消耗增加"、下一次请求生效；点击切换，空状态用 `lastFast`、先建会话；扩展没加载时说明；停止中不能用；模型菜单里支持的模型名后带小 ⚡ | `packages/ui/src/chat/chat.browser.test.tsx` "ConversationArea's Fast button"、`model-picker.browser.test.tsx` "bolt"、`model-choice.test.ts` | 已覆盖 |
| 端到端：打包进宿主的扩展真的被 pi 加载，模型目录按本机模型列表服务的列表标 Fast（GPT-6.1 Sol 有 ⚡，内置规则会算支持的 GPT-5.5 没有），卡片写"约 2 倍速度，额度消耗增加"；选 GPT-6.1 Sol 后打开，下一次请求带 priority，换回 faux-1 开关消失、请求不带；对列表的每次请求都带 pi 的凭据 | `apps/desktop/e2e/fast.spec.ts` | 已覆盖 |

## 工作区归档（M1.11，2026-10-12）

SPEC-0001"M1.11 的工作区归档"：worktree 工作区可以归档（删掉目录、保留分支），在项目菜单里恢复。

| 行为 | 测试 | 状态 |
|---|---|---|
| 协议（版本 9）：`archive_workspace`、`restore_workspace` 及其应答 `{}`，工作区的 `archivedAt`（不能缺、不能为负），五个新错误码 | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| 宿主 · 索引与项目：工作区记录的 `archived`（时间、当时的分支和提交，旧文件没有这一项也能读）；`setArchived` 记下和清掉，未知工作区 `workspace_not_found` | `packages/host/src/store/load-index.test.ts`、`projects/project-service.test.ts` "ProjectService.setArchived" | 已覆盖 |
| 宿主 · 工作区列表：归档的工作区照列、带 `archivedAt`，分支和提交取归档时记下的、不算合并状态、扫描跳过；不能在里面新建会话 | `packages/host/src/workspaces/workspace-service.test.ts` "lists an archived worktree" | 已覆盖 |
| 宿主 · 归档（真实 git）：干净的 worktree 先停会话再 `git worktree remove`，分支留着、被忽略的文件随目录删掉，然后归档会话、记下时间分支提交；detached 在分支、远程分支或标签上的提交可以归档；有改动、有未跟踪文件、提交不在任何引用上时拒绝且什么都不动；本地工作区 `workspace_is_local`、未知 `workspace_not_found`、已归档的不再动；目录已不在（含已 prune 和被锁住的）时不跑 git 直接归档；被锁住删不掉时会话已停但不归档（先记下的归档标记撤掉）、日志只有退出码；会话停完再查一遍，其间有了改动或 detached 上的新提交时拒绝，分支上的新提交以停完后的为准；删目录前索引已记下归档；`worktree remove` 和 `add` 超时 10 分钟、别的 git 命令用默认；没有 git、列不出 worktree、读不了状态、查不了提交被谁持有时失败 | `packages/host/src/workspaces/workspace-archiver.test.ts` "WorkspaceArchiver.archive" | 已覆盖 |
| 宿主 · 恢复（真实 git）：按分支或 detached 的提交加回 worktree 并重扫；git 还登记着目录已不在的先 prune 再加；目录已回来的只清标记，没归档的不动；`worktree_restore_failed` 带原因：目录被占 `dir_taken`、本地分支已删（远程有同名分支时也不从远程新建）`branch_gone`、没有可用的分支和提交 `no_branch`，分支正被别处检出时不带原因、日志只有退出码；未知工作区、没有 git、列不出 worktree 时失败；归档和恢复一次一个，前一个失败后接着做；`close` 等进行中的做完（宿主关闭时在会话和索引之前调用） | `workspace-archiver.test.ts` "WorkspaceArchiver.restore"、"one at a time" | 已覆盖 |
| 宿主 · 会话：停掉工作区所有会话的 pi；归档工作区的所有会话（含草稿），从各布局里去掉；列表命令转交归档器、路由转发两个命令 | `packages/host/src/sessions/session-manager.test.ts` "SessionManager workspaces"、`index-commands.test.ts` "IndexCommands.archiveWorkspace"、`server/router.test.ts` | 已覆盖 |
| 客户端：两个命令带工作区 id 发出、应答 `{}` | `packages/client/src/atrium-client.test.ts` "sends the session, project, workspace" | 已覆盖 |
| 界面：只有 worktree 的菜单有"归档…"，有未提交改动时置灰并说明；确认框（挂在页面上、盖住整个窗口，380px 卡片、遮罩模糊 8px、按钮高 30px，焦点在"取消"）写明删除目录、保留的分支或提交（都没有时不写）、运行中的会话数（不算归档的和没在运行的）；取消、Esc、点遮罩都不归档；归档中按钮写"归档中…"、取消 Esc 遮罩都不起作用，失败时框不关、说明原因、可以再试，各错误码的说明；成功后工作区从侧栏消失；侧栏和搜索不显示归档的；项目菜单里有归档的才有"已归档的工作区"，展开和收起，新到旧、写归档时间，最多 8 行高再滚动；恢复后菜单关上、工作区回到侧栏，失败在问题行按原因说明 | `packages/ui/src/app/workbench.browser.test.tsx` "Workbench workspace archiving (M1.11)"、"describeArchiveError"、"describeRestoreError" | 已覆盖 |
| 端到端：真实 app 里归档一个开着标签页的 worktree，确认后目录删掉、分支还在、标签页和侧栏行消失；重启后仍是归档的，从项目菜单恢复，目录回来、在原分支上 | `apps/desktop/e2e/archive.spec.ts` | 已覆盖 |

## M1.11 三方审查后补（2026-10-12）

| 行为 | 测试 | 状态 |
|---|---|---|
| 丢弃草稿：等 pi 启动完再停的途中来了消息，草稿留着、消息照常发出；途中别的客户端打开了它，草稿和目录留着、pi 重新启动；丢弃了对话唯一的会话、删掉目录后，各客户端布局里的这个对话去掉，停在那里的回到没有位置，目录里有文件没删掉时布局不动；新建对话时布局写不进去，已记下草稿的目录留着 | `packages/host/src/sessions/session-manager.test.ts` "keeps a new draft closed while its pi starts"（两条）、"tab cannot be written"、"discards a draft that never got a message"、"keeps a chat directory that holds files"、"closes a tab closed while its opening waited" | 已覆盖 |
| 消息图片：轮结束后的重建还在读时，等它读完再找条目（读完之前没绑定，读完就有）；没在读时不等；界面在轮结束后另取一次，不沿用运行中发出的那次 | `packages/host/src/sessions/session-controller.test.ts` "waits for the read under way"、`packages/ui/src/chat/message-images.browser.test.tsx` "though the ask from while it ran" | 已覆盖 |
| Fast 开关：切换还在路上时别的客户端改了它（`fast_updated`）或重连后来了新快照，这次切换被拒时回到宿主现在的开关；期间来的其他事件不算宿主的开关 | `packages/client/src/atrium-client.test.ts` "another client switched it while a refused switch"、"though other events came" | 已覆盖 |

## M1.11 自用中改（2026-10-12）

| 行为 | 测试 | 状态 |
|---|---|---|
| 过程标题行和下面的正文左对齐：跑完的 › 箭头左边缘贴住正文左边、标题从 14.5px 起；运行中的小猫贴左、"进行中"从 24px 起；展开后各步的文字仍从 30px 起 | `packages/ui/src/chat/turn.browser.test.tsx` "starts the folded header's arrow at the reply's left edge"、"starts the running cat at the reply's left edge"、"lines the rows' text up 30px in" | 已覆盖 |
| 输入框的展开按钮固定在卡片右上角（离上边、右边各 20px），上方有胶囊时也不往下移；Tab 仍在文字框之后到它 | `packages/ui/src/chat/composer.browser.test.tsx` "keeps the expand button in the card's top right corner"；`packages/ui/src/chat/chat.browser.test.tsx` "shows it on keyboard focus" | 已覆盖 |
| 去掉显示模式：标签栏没有显示模式菜单，Ctrl+O 不做任何事；协议拒绝带 `displayMode` 的 `set_preferences`；`preferences.json` 升到 v3，迁移时删掉 `displayMode` | `packages/ui/src/app/workbench.browser.test.tsx` "has no display mode to switch"、`packages/protocol/src/envelope.test.ts` "a display mode"、`packages/host/src/store/preferences.test.ts`、`load-index.test.ts` | 已覆盖 |
| "新建对话"在"对话"分区标题下第一行（⌘N），没有对话时分区也显示、只有这一行；侧栏别处没有新建对话的按钮 | `packages/ui/src/app/workbench.browser.test.tsx` "starts a chat from the first row under 对话"、"puts 新建对话 before the chats' rows"、"a new chat with ⌘N" | 已覆盖 |
| 侧栏项目展开收起：工作区行 0.28 秒收拢 / 从 0 展开，各行依次淡出、淡入；动的时候裁切、静止时不裁（行里的菜单不被挡）；展开、收拢到底和收起后行间距一致（2px，到"对话"6px）；文件夹图标交叉淡化、缩放 0.6，颜色跟着过渡（0.3 秒） | `packages/ui/src/app/workbench.browser.test.tsx` "folds a project's workspaces away in 0.28 s"、"keeps the rows 2px apart"、"cross-fades the project's folder" | 已覆盖 |
| 对话归档（协议 11）：`archive_chat` / `restore_chat` 进协议，对话带 `archivedAt`；`chats.json` 升到 v2（记录可以只有归档），旧版的名称照读，别的字段保留，没变化不写 | `packages/protocol/src/envelope.test.ts`、`packages/host/src/store/chat-records.test.ts`、`load-index.test.ts`、`packages/client/src/atrium-client.test.ts` | 已覆盖 |
| 归档对话：先记下归档时间、要归档的会话（还没归档的，草稿也算）和第一个会话，再停 pi、归档、从布局去掉；记录写不进去时一个会话也不归档；再归档不变；恢复只放回记下的会话、不切过去；归档的对话不能新建会话；不存在的对话 `chat_not_found`；列表里归档的对话沿用归档时的第一个会话取名 | `packages/host/src/sessions/session-manager.test.ts` "SessionManager chats' archive"、`store/chat-records.test.ts` "lists chats with their names and archives"、`server/router.test.ts` | 已覆盖 |
| 界面：对话"···"里"归档"，没有会话在运行时直接归档，有时先确认（N 个正在运行）；归档的对话不在对话列表和搜索里；"已归档的对话"只在有归档时出现，点开按归档时间新到旧、沿用名称、最多 8 行高；"恢复"不切过去，最后一个恢复后这一行消失；失败在问题行说明 | `packages/ui/src/app/workbench.browser.test.tsx` "Workbench sidebar: archived chats" | 已覆盖 |

## 安全（security.md）

| 要求 | 测试 | 状态 |
|---|---|---|
| 错误 token 被拒绝（4401），日志里没有真 token；同源页面也必须带对 token | ws-server.host.test.ts "rejects a wrong token…"、"lets a page served by the host itself connect, but still requires the token" | 已覆盖 |
| 外来 Origin 在升级时被拒（403） | ws-server.host.test.ts "refuses a browser from a foreign origin…" | 已覆盖 |
| 只认第一条 hello；格式错误、版本不符、超时各有关闭码 | ws-server.host.test.ts "closes the socket on …"、"drops a client that never says hello…"、"answers only the first of two hellos" | 已覆盖 |
| 连接数、消息速率、字节速率、单条大小的上限 | ws-server.host.test.ts "disconnects a client that sends more than 200 messages…"、"allows exactly 32 MiB per second…"、"closes a connection that sends a message over 1 MiB…"、"refuses connections beyond 32 at once" | 已覆盖 |
| token 强度（单独运行与 Electron 两条路径） | `packages/host/src/server/auth.test.ts`；host-standalone.spec.ts "refuses a weak token…" | 已覆盖 |
| 渲染进程拿不到 Node，桥上只有 bootstrap、选择文件夹、窗口外观、拖入文件的路径、在访达中显示 | e2e "gives the page no Node access and only the bridge…" | 已覆盖 |
| 窗口页面从固定的 `atrium://app` 加载，CSP 只多允许连宿主端口，存储跨重启保留 | e2e "opens a window on the host's UI at a fixed origin…"、"keeps the page's storage across a restart…" | 已覆盖 |
| git 的输出、fetch 失败的原文不进日志，只记命令和原因；索引文件损坏只记文件名 | `workspace-service.test.ts` "logs a scan git could not run by its reason…"、"skips projects without an origin and logs a fetch that fails"；`index.host.test.ts` | 已覆盖 |
| 在访达中显示（`reveal`）只接受存在的绝对路径：相对路径、不存在的路径、不是字符串的都不理 | e2e `app.spec.ts` "shows in the Finder only an absolute path that exists"（`shell.showItemInFolder` 被替换，不打开真的访达） | 已覆盖 |
| 不能导航到别的源、不能开新窗口，链接交给系统浏览器 | e2e "keeps the page on its own origin…"（目标服务器零请求，`shell.openExternal` 被调用） | 已覆盖 |
| 宿主页面带 CSP、nosniff；开发页面也带 CSP | ws-server.host.test.ts "serves the UI with the full content security policy…"；`apps/desktop/e2e/dev.spec.ts` | 已覆盖 |
| 静态文件不越出 UI 目录：路径穿越、符号链接 | `packages/host/src/server/static-files.test.ts`；ws-server.host.test.ts "does not follow a symlink out of the UI directory…" | 已覆盖 |
| 读不了的文件、中途断开的下载不让宿主崩溃 | ws-server.host.test.ts "answers 404 for a file it cannot read…"、"survives a client that disconnects…" | 已覆盖 |
| 日志脱敏：凭据键、已知秘密、格式化参数、`Error`、子 logger 绑定 | `packages/host/src/platform/logger.test.ts`、`redact.test.ts`、`redact.prop.test.ts`；e2e "…never logs the token" | 已覆盖 |
| pi 的环境里名字像凭据的变量值加入脱敏列表，pi 在 stderr 回显也不进日志 | redact.test.ts "picks the values of credential-like variables…"；tools.host.test.ts "scrubs credentials from the tool environment…"；try-pi.test.ts "keeps credentials from the environment out of its log…" | 已覆盖 |
| pi 从 `auth.json` 读的 Key 被 pi 回显时不进日志（已知缺口，见 security.md"凭据与日志"） | — | 待 M1.10 |
| `@` 搜索不返回工作区之外的文件：`~/`、绝对路径、`..` 找不到；像 fd 选项的查询词（`--search-path=…`）只当文字；工作区里的符号链接照 pi 跟进去（2026-10-10 定） | `packages/host/src/files/file-search.host.test.ts` "finds nothing outside the working directory"、"takes a query that looks like an fd option as text…"；`fd-query.test.ts` "scopeOf" | 已覆盖 |
| 新建的 `~/.atrium` 权限 0700、日志 0600；已有目录不改权限；经符号链接给的目录按真实路径返回（pi 按真实路径给会话目录命名） | `packages/host/src/platform/home.test.ts`；`logger.test.ts` "creates log files readable only by their owner, rotated ones included" | 已覆盖 |
| 索引文件 0600、`turns/` 目录 0700；插话记录的文件名只用 pi 形状的会话 id | `packages/host/src/store/index-file.test.ts`、`turn-starts.test.ts` | 已覆盖 |

## 日志与链路追踪（observability.md）

| 要求 | 测试 | 状态 |
|---|---|---|
| traceparent 的生成、格式化、解析 | `packages/protocol/src/trace.test.ts`、`trace.prop.test.ts` | 已覆盖 |
| 宿主 span 挂在客户端的 trace 下，日志带 trace_id | ws-server.host.test.ts "records the whole connection…"；e2e "records the connection under one trace id…" | 已覆盖 |
| 日志磁盘上最多保留 5 个（含之前运行的）；`current.log` 是普通文件时能自愈；日志流出错不崩溃 | logger.test.ts "openLogFile" | 已覆盖 |
| 未结束的 span 计入资源计数 | `packages/host/src/server/connections.leak.test.ts` | 已覆盖 |
| `pnpm trace` 打印链路，跳过不完整的行 | `scripts/trace.test.ts`（跨轮转文件、别的 trace、半行、无记录、用法错误） | 已覆盖 |
| 宿主每分钟记录资源计数和内存（`resource usage`） | `packages/host/src/usage.host.test.ts` "logs resource counts and memory once a minute"（假时钟） | 已覆盖 |
| Electron 主进程每分钟把各进程的内存和 CPU 交给宿主记录（`app metrics`）；宿主就绪前、退出后、格式不对或超出上限的丢掉（2026-10-11 定） | `electron-port.test.ts` "hands app metrics to the running host"、"drops app metrics…"、"accepts app metrics at the limits"；`usage.host.test.ts` "logs the desktop app's processes…"；`apps/desktop/e2e/shutdown.spec.ts` "hands samples of the app's processes…"（`ATRIUM_APP_METRICS_INTERVAL_MS` 缩短间隔） | 已覆盖 |
| `pnpm usage` 按宿主的每次运行列出每小时的用量，比较第一个和最后一个小时的最低值，按规则标 `↑`；跨轮转文件、跳过半行、开头已轮转掉的运行从第一条记录算起（2026-10-11 定） | `scripts/usage.test.ts` | 已覆盖 |

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
| 长时间运行：资源回到基线，内存增长每次 < 1KB | `packages/host/test/soak/connections.soak.test.ts`、`sessions.soak.test.ts` | 已覆盖 |
| 热路径基准 | `packages/protocol/src/trace.bench.ts`（traceparent 解析）；`packages/pi/src/process/jsonl.bench.ts`（分帧：大量小记录、16 MiB 单行，后者能抓住每块重扫整个缓冲的退化） | 已覆盖 |
