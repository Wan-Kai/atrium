# 手机端：本机的 agent 怎么和手机共用一个对话

> 2026-10-23 调研，2026-10-24 整理。三个只读子代理分头读了源码和官方文档：Paseo（最新提交 `fed19f3`，0.13.0-beta.2，克隆在 `~/.cache/paseo-src-latest`；官方 relay 另一个仓库，`~/.cache/paseo-relay-src` 提交 `3fc41c9`）；Claude Code、Happy、Omnara、CloudCLI、Vibe Kanban；Codex、Cursor、OpenCode、Copilot CLI。标【源码】的读过代码，【文档】是官方文档写的，【issue】来自 GitHub issue，【推测】是推断。所有产品都没有实际装上跑、没有抓包。
>
> 据此定的：[ADR-0015](../adr/0015-native-ios-app-in-swiftui.md)（手机端做 SwiftUI 原生 App）、[ADR-0016](../adr/0016-remote-access-through-own-relay-with-noise.md)（经自建 relay 加 Noise 端到端加密连回宿主）。

## 1. 结论

1. **共用一个对话的做法各家一样**：会话只有一个持有者（本机的宿主或 daemon），桌面和手机都是它的客户端，不各自复制一份。Paseo、Codex、Claude Code Remote Control、Copilot CLI、OpenCode 都这样。出问题最多的是包装别人 TUI 的：Happy 要在"本地 / 远程"两种模式间切换，Omnara 旧版抓终端屏幕找权限提示，CloudCLI 读会话文件后另起一个 `--resume` 进程把对话分叉。Atrium 的宿主本来就持有 pi，属于前一种。
2. **区别在手机怎么连回本机**：
   - 厂商中继、中继看得到明文：Codex 经 chatgpt.com，Claude Code 经 Anthropic（对话记录存在服务器上），Cursor、Copilot 也是。
   - 端到端加密的中继：Paseo（Noise NK，可自托管）、Happy（NaCl / AES-GCM），OpenCode V2 的 OpenTunnel（TLS 在本机终止，中继只按 SNI 转发密文）。
   - 不建中继：OpenCode 直连、CloudCLI，宿主自己提供 Web / PWA，局域网或 Tailscale。
3. **电脑睡着就用不了**：本机跑 agent 的都要求电脑醒着，只能靠"保持唤醒"的开关缓解；能关机继续的只有云端执行（Codex Cloud、Cursor Cloud Agent、Claude Code 云会话、新版 Omnara）。

## 2. 多端共用一个对话的共同做法

| 问题 | 做法 | 出处 |
|---|---|---|
| 实时与历史 | 宿主为准；打开时拉最近一页，再订阅增量 | Paseo `docs/timeline-sync.md`、Codex `thread/resume`【源码】 |
| 断线补齐 | 每个会话的事件带递增序号，重连从断开处补；对不上就整段换掉。OpenCode 的 SSE 不重放，重连后全部重拉 | Paseo epoch+seq，Codex 中继 `seq_id`+`Ack`，Happy `after_seq`【源码】；OpenCode `packages/client/test/solid-connection.test.ts`【源码】 |
| 批准与提问 | 发给所有连着的端；新连上的端补收还没答的；先到的答复生效，广播"已处理"让别的端收起，后到的报错 | Codex `replay_requests_to_connection_for_thread`、`serverRequest/resolved`【源码】；Copilot CLI "uses the first response it receives"【文档】；Claude Code Channels"whichever answer arrives first"【文档】；Paseo `agent-manager.ts:3092-3125`【源码】 |
| 发消息 | 带客户端消息 id，宿主落盘去重；结果不确定时不盲目重发 | Paseo `message-receipts/`（`agent_request_outcome_unknown`）【源码】、Happy 的 outbox `localId`【源码】 |
| 草稿 | 各端各存一份，不同步 | Paseo `draft-store`【源码】 |
| 排队 | Paseo 放在客户端内存里，两端互相看不到、App 被杀就丢【源码】；Atrium 本来就在宿主 | Paseo `session-store` 的 `queuedMessages` |
| 关注 / 已读 | 宿主全局一份，任一端看过就一起清 | Paseo `clear_agent_attention`【源码】 |
| 在线与推送时机 | 客户端定时报在线、可见、在看哪个对话；有端正看着这个对话就不推，有端在线只给最近活跃的那端发应用内通知，都不在线才推 | Paseo `agent-attention-policy.ts`（180 秒）【源码】；Claude Code"焦点在终端时不推"【文档】 |
| 手机能做的 | 看实时进度、追加或插话、停止、批准、看 diff 和测试输出、新建对话、换模型；终端、编辑器、插件 / MCP 配置、需要本机浏览器的 OAuth 留在桌面；手机上不能切到跳过权限 | Claude Code、Codex、Cursor【文档】 |

## 3. Paseo

**拓扑**【源码 / 文档】

- daemon 跑在用户自己的机器上，默认只听 `127.0.0.1:6767`。
- 手机连 daemon 有三条路：
  - 官方 relay `relay.paseo.sh`：Elixir 写的，部署在 Fly.io，Apache-2.0，可以自托管。仓库里的 Cloudflare Durable Object 版已不再部署。
  - 直连局域网或 Tailscale：明文 ws，只靠 daemon 密码保护。
  - daemon 自带的 web UI。
- App 给一台主机存几条连接，测延迟后走最快的（`app/src/utils/connection-selection.ts`）。已知问题：直连恢复后仍停在 relay 上（#7613）。

**relay v2 的连接模型**（`packages/relay/src/cloudflare-adapter.ts`）【源码】

- daemon 为每个 serverId 开一条控制 socket。
- 每个客户端连上来时，relay 在控制 socket 上通知 daemon，daemon 再为这个客户端开一条数据 socket，一对一转发。
- 数据 socket 还没连上时，relay 最多缓存 200 帧。
- relay 单帧上限 32 MiB，只校验握手帧里的公钥格式，其余原样转发。

**配对**【源码 / issue】

- 二维码或链接是 `https://app.paseo.sh/#offer=…`，放在 URL 的 fragment 里，服务器拿不到。里面有 serverId、daemon 的 X25519 公钥和 relay 地址。
- daemon 的长期密钥存在 `$PASEO_HOME/daemon-keypair.json`（0600）。
- **手机没有长期身份**：每次连接都用临时密钥，所有客户端都是 `owner`。
- 所以拿到配对链接就等于拿到全部权限，也没法单独撤销某台设备。能做的只有设 daemon 密码，或换掉 daemon 密钥让所有设备重新配对。
- 一次性配对码、按设备撤销的方案（#416）还只是设计；手机凭据存在明文 AsyncStorage（#358，p0）也没修。
- 拿到 serverId 的人能挤掉真正的 daemon（#367），维护者以"配对链接当密码"为由不修。

**加密**（`docs/relay-endpoint-security.md`、`packages/relay/src/noise/`）【源码 / 文档】

- `Noise_NK_25519_ChaChaPoly_SHA256`，prologue `paseo-relay-e2ee/1`。
- 每条记录用 64 位计数器做 nonce，重放、乱序直接关闭通道；大帧切成不超过 65513 字节的块。
- 原语用 `@noble/*`，Noise 状态机是自己写的，用第三方测试向量校验。
- 旧版是 NaCl box，没有防重放（#359）。
- relay 看得到 IP、时间、大小、serverId。

**推送**（`server/push/push-service.ts`、`protocol/src/agent-attention-notification.ts`）【源码】

- daemon 直接调 Expo Push API，不经过 relay，内容是明文。
- 正文是最后一条回复的前 220 字，或者批准请求的标题 / 参数 JSON。
- 只有原生 App 能收，web / PWA 版是空实现。

**手机网络**（`client/src/daemon-client.ts`、`docs/timeline-sync.md`）【源码】

- 存活心跳 10 秒一次、15 秒超时，连续失败 2 次重连；回到前台立刻探活，3 秒没回应就重连。
- 冷启动先显示本地 SQLite 缓存，再按游标往后补。
- 没开压缩（`perMessageDeflate: false`）。

**踩过的坑**【issue】

- 补齐的一页按条数算，图片多的会话撑爆了 relay 单帧上限（#2220）。
- 一次全量同步 17 MB，撞上发送缓冲上限后一直重连（#6078）。
- relay 抖动后 Android / PWA 不再补齐（#4419）。
- iOS 加载大对话时 relay 断开（#4239）。

结论：补齐要按字节预算分页，大块二进制要单独传。

**技术栈**

- Expo + React Native + react-native-web，手机、web、桌面共用一套 UI。
- `@getpaseo/client` 和 `@getpaseo/protocol` 由 App、CLI、SDK 共用。

## 4. 其他产品

### Claude Code Remote Control【文档】

- **拓扑**：Claude 在本机跑，本机只发出站 HTTPS，先向 Anthropic API 注册、再轮询，手机连上后由服务器转发（https://code.claude.com/docs/en/remote-control）。对话记录存在 Anthropic 服务器上，所以开了 ZDR / HIPAA 的组织不能用。
- **配对**：同一个 claude.ai 账号；终端按空格出二维码。Trusted Devices（beta）给每台设备登记公钥，登录超过 18 小时要 Face ID 或 passkey 再确认，可以单独吊销。
- **共用会话**：终端、浏览器、手机交替发消息；一个会话同时只有一个本地进程持有。
- **对话框**：权限提示和 `AskUserQuestion` 一直挂着等人答，别的对话框 5 分钟后按默认关闭。
- **休眠**：恢复后自动重连。用户抱怨最多的是断开不提示、不能自动恢复（anthropics/claude-code#34255、#32982）。
- **推送**：走 Claude App；人在电脑前不推。
- **手机上限制**：不能选 bypass permissions，不能 `!` 执行 shell，MCP 的 OAuth 要回终端做。

### Happy（slopus/happy）【源码】

- **拓扑**：CLI 包装器加 Socket.IO 中继（可自托管，内置 PGlite），App 用 Expo 写。
- **配对**：CLI 生成一次性 box 密钥对，二维码 `happy://terminal?<公钥>`；已登录的手机用这个公钥加密账号密钥发回（`packages/happy-cli/src/ui/auth.ts`）。
- **加密**：每个会话一把 AES-256-GCM 数据密钥，服务器只存密文。推送例外，经 Expo 明文发出。
- **同步**：每个用户一个递增 `seq`；持久的 `update` 和瞬时的 `ephemeral` 分开；带版本的字段用 `expectedVersion` 做乐观并发（`docs/protocol.md`）。
- **控制权**：本地 / 远程两种模式二选一，手机一发消息就中止终端里的 claude、改由 SDK 驱动。切换时丢历史、终端乱码的 issue 很多（#527、#613）。
- **托管中继**：多次 404 / 522（#1866、#418）。

### Codex【源码 / 文档】

- **拓扑**：ChatGPT 手机 App 控制已连接的桌面 App，文件、shell、MCP、凭据都来自主机（https://learn.chatgpt.com/docs/remote-connections.md）。
- **中继**：本机 app-server 出站连 `wss://chatgpt.com/backend-api/wham/remote/control/server`（`codex-rs/app-server-transport/src/transport/remote_control/`）。
  - 信封带 `client_id`、`stream_id`，多个客户端在一条连接上多路复用。
  - 每个流的 `seq_id` 由后端 Ack，本机留着没确认的、重连后重发。
  - 载荷是明文 JSON-RPC，没看到端到端加密。
- **批准**：发给所有订阅的连接，新连接订阅时补发，答复后广播 `serverRequest/resolved`。
- **休眠**：主机睡了就停；桌面 App 有"保持唤醒"开关。

### Cursor【文档】

- 以云为中心：Cloud Agent 跑在 AWS microVM 里。
- Remote Control 让手机控制本机 worker，经 `api2.cursor.sh`；文档和 2026-10-06 的 changelog 对 agent 循环在哪跑说法不一【推测：是两代】。
- iOS 原生 App 和网页共用一个后端，没有 Android 版。
- 不是端到端加密，对话记录默认一直保留。

### OpenCode V2【文档 / 源码】

- **拓扑**：后台常驻 service，默认只听 localhost。
- **配对**：`opencode pair` 打印一次性链接和二维码，5 分钟过期、只能用一次，打开后种一个 30 天的 cookie；改密码就注销所有会话。
- **远程**：`pair --remote` 经 OpenTunnel（https://github.com/anomalyco/opentunnel），TLS 在本机终止，隧道服务只看 SNI。它自己提醒，经隧道来的请求看起来像来自 loopback，宿主不能按"是不是本地请求"放行。
- **同步**：server 为准；SSE 不重放，重连后客户端让缓存失效、重新拉。
- **批准**：广播 `permission.asked` / `permission.replied`，哪一端都能答。
- **推送**：没找到 Web Push。
- **用户需求**：2026-10-23 新开 #58368，"不直接暴露 serve 也能从手机远程控制桌面会话"。

### Copilot CLI remote【文档】

- 默认只同步、手机只能看，`/remote on` 后才能操控。
- 本机从 GitHub 轮询远程命令；冲突规则写明先到的答复生效。
- 有 `/keep-alive` 防休眠。

### 其他

- **CloudCLI（siteboon/claudecodeui）**：
  - 本机 Node 服务加 PWA，靠局域网或自备隧道；宿主自己生成 VAPID 密钥发 Web Push（`server/modules/notifications/vapid-keys.service.ts`）。
  - 从网页发消息会另起 `--resume` 进程，导致对话分叉（#1536）。
- **Vibe Kanban**：
  - 6 位配对码经 SPAKE2 建共享密钥，之后每个请求用 Ed25519 签名；本机出站连中继，能直连时走 WebRTC。
  - 公司 2026-04 关闭，远程服务下线。
- **Omnara**：旧版 PTY 包装器 2025-11 弃用，原因是"Claude Code 更新太快维护不下去"；新版把 agent 循环放到控制平面，本机只是执行环境。

## 5. 对比

| | agent 在哪 | 手机怎么连 | 中继看得到内容吗 | 配对 | 设备能单独撤销吗 | 批准 | 推送 |
|---|---|---|---|---|---|---|---|
| Paseo | 本机 | 自家 relay / 直连 / web UI | 不能（Noise NK） | 二维码带 daemon 公钥 | 不能 | 先到先得 | Expo，明文 |
| Claude Code RC | 本机 | Anthropic 中转 | 能，且存储 | 同账号加二维码 | Trusted Devices 能 | 挂着等，先到先得【推测】 | Claude App |
| Codex | 本机（也可选云） | chatgpt.com 中继 | 能（未见端到端加密） | 桌面出二维码 | 未查 | 先到先得，新端补收 | 有 |
| Cursor | 云，或本机 worker | Cursor 后端 | 能，且存储 | 账号 | 未查 | 未写明 | 有，含 Live Activity |
| OpenCode V2 | 本机 | 直连 / OpenTunnel | 不能（盲 TLS） | 一次性链接加 cookie | 改密码全部注销 | 广播，任一端答 | 未见 |
| Copilot CLI | 本机 | 轮询 GitHub | 能 | 同账号 | 未查 | 先到先得（写明） | 未查 |
| Happy | 本机 | 自建 Socket.IO 中继 | 不能（推送除外） | 二维码交换公钥 | 未查 | 远程模式下手机答 | Expo，明文 |

## 6. 对 Atrium

Atrium 现状（读源码确认，2026-10-24）：

- **已经有**：
  - 多个连接（最多 32）；
  - 列表同步用 `generation + seq` 游标，对话同步用 `epoch + seq`；
  - 发消息的 `requestId` 兼作 `clientMessageId`（`packages/protocol/src/commands.ts:85`）；
  - 排队在宿主的 `control.queue`；
  - 标签布局按 `clientId` 分开存。
- **缺的**：
  - 宿主只听 `127.0.0.1`（`packages/host/src/server/ws-server.ts:181`）；
  - token 每次启动随机生成、只在内存里，手机拿不到也存不住；
  - 没有设备身份；
  - 没有推送。
- **待核对**：
  - 同一个 `requestId` 重发时宿主会不会投递两次；
  - `ask_user` 两端同时答是不是先到先得；
  - 补齐的一页有没有字节上限。

用户定的方向（2026-10-24）：SwiftUI 原生 iOS App，经自建 relay 加 Noise 端到端加密连宿主，先不做推送。

借鉴：

- **会话持有**：宿主是唯一持有者，手机不另起 pi、不读会话文件。
- **批准与提问**：先到先得、补收、广播"已处理"，过期或重复的答复拒绝。
- **补齐**：按字节预算分页，恢复时只拉最近一页尾部，往上滚再拉更早的；大块二进制（图片）单独取。
- **消息幂等**：发消息带 id，宿主落盘去重，结果不确定时应答"不知道"，不盲目重发。
- **在线状态**：在线心跳只用来决定通知怎么发，不决定推哪些对话流；推送时机照 Paseo 的规则。
- **网络恢复**：回到前台立刻探活；"主机离线"要显式显示（Claude Code 的头号抱怨）。
- **设备与配对**：每台设备有长期身份，可以列出、单独撤销；配对码一次性有效、短期过期（OpenCode、Claude Code Trusted Devices；Paseo 缺的）。
- **不信来源**：不能按"来自本机 / tailnet / 隧道"放行。

不学：

- 推送内容明文交给第三方（Paseo、Happy 经 Expo）；
- 手机匿名的 NK 握手；
- 自己写 Noise 状态机却不对齐公开测试向量；
- 包装 TUI、另起进程续会话。

## 7. 开源 App 的源码对照（2026-10-25）

读了两个开源的"手机接管本机 agent"App 的源码：mimi-remote（gaixianggeng，GPLv3，commit `479358e`，SwiftUI，iOS 18+，经 Tailscale 或局域网直连 Mac 上的 Go 网关，主要接 Codex）和 cmux-iphone（lim-won，MIT，commit `982da7d`，iOS 17，HTTP + SSE 直连）。只学设计，不摘抄代码。

借鉴（已写进 SPEC-0005 或留给对应里程碑）：

- **发送分三态**（mimi `HarnessSubmissionController.swift`、`SessionStoreTurnSubmission.swift`）：没写进通道的是"失败"可重发，写出未确认的是"不确定"，同一会话有未确认的就拦下新发送；没有自动重试；对账按 `(clientMessageId, turn)` 精确匹配。
- **代数**：每次连接、每台主机一个代数，异步回调写回前核对（cmux `SSEClient.swift`、mimi `HostScope`）；网络变化编序号，只接受更大的。
- **游标在投影落地后才推进**（mimi）。cmux 的反例：事件 id 在宿主重启后从 0 重来、客户端游标只在内存，补发静默漏掉——我们的 `stream` 字段防这个，写成契约测试。
- **重连后补推未答的审批 / 提问**，客户端按 id 去重，"提交中"的卡片不被重置回待答（cmux）；先答先得、后到 404、广播收起（cmux `resolvePermission`）；回答时带上看到的内容的哈希、宿主内容变了就 409（cmux 的"屏幕哈希"）。
- **前后台**：`.inactive` 不动连接，`.background` 才断，`.active` 才恢复（mimi `RootView.swift`）。
- **自检分两层**：宿主发检查项代码，桌面和手机各自本地化；手机做分段计时的连通测试（mimi `doctor.go`、`HostConnectionSupport.swift`）。
- **流式 Markdown 的尾块边界由解析器给**：只冻结最后一个顶层块之前的内容，表格后跟半行的特例，超长纯文本快路径（mimi `MarkdownParser.swift`）。
- **时间线用 `List`**、`.equatable()` 行、滚动三态、"首次出现定位置之后原地更新"（mimi `ConversationTimelineView.swift`、`ConversationTimelineReducer.swift`）。
- **动效 token 带降级开关**：减弱动态效果时同一 token 返回淡变，附 `allowsScale` / `allowsSpatialMotion`；zoom 在呈现前就决定（mimi `MimiInteractionFeedback.swift`）。mimi 把 iOS 26 的玻璃全换成了扁平磨砂，理由是"一屏只要一种玻璃浓度"，这条理由值得记住；两个仓库都没有 `GlassEffectContainer` / `glassEffectID` 的写法可参考。
- **工程**：设备按 UDID 加租约（`mkdir` 原子锁 + PID 和启动时间，忙时退出码 75，mimi `ios-device-lease.sh`）；签名团队不进仓库、一个变量派生所有 bundle id（cmux `project.yml`）；快照测试先检查固定的模拟器（mimi）；AGENTS.md 是"场景 → 必读文件"表（mimi）。

不照搬：mimi 的共享 token 和可反复兑换的票据、cmux 的长期 6 位码和"撤销不断已打开的流"、靠网络层（Tailscale）加密而应用层明文、cmux 失败后降级成轮询、mimi 的 80 毫秒整块刷新（没有揭示节奏）、代码和 diff 不着色、用文案前缀推断状态、Codex 的单 writer 锁和只读观察模式（pi 不需要）。

## 8. 没核实的

- Claude Code 是闭源的，Remote Control 两端同时批准谁生效只有 Channels 文档；
- Codex 中继服务端是否存储内容；
- Cursor 新旧两版 Remote Control 的关系；
- OpenCode 是否有官方原生 App；
- Paseo relay 的 Elixir 实现（只读了 README）；
- Warp、Conductor、T3 Code、Jules。
