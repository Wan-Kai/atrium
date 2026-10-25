# SPEC-0005：手机端与远程访问

- **状态**：已确认（2026-10-25 用户确认设计稿定稿、开始开发）
- **创建**：2026-10-24
- **更新**：2026-10-24（GPT-6 Astra 只读审查后重写：配对加密钥确认和状态机；补字节级线路契约；每台手机在宿主侧单开数据连接；出站另设上限；幂等只管 `prompt`、`steer`，写明"结果不确定"；续传加切换点和完成标记；远程 `clientId` 绑定设备；推送给手机的事件按来源过滤；第一版收窄；先做互通实验）
- **相关**：[ADR-0015](../adr/0015-native-ios-app-in-swiftui.md)（SwiftUI 原生 App）、[ADR-0016](../adr/0016-remote-access-through-own-relay-with-noise.md)（自建 relay 加 Noise）、[mobile-remote.md](../research/mobile-remote.md)（调研）、[SPEC-0001](0001-mvp1-single-session-chat.md)"协议细节""快照与分页""运行控制""并行、同步与关注"、[SPEC-0003](0003-agent-asks-user.md)、[security.md](../architecture/security.md)、原型 `prototypes/mobile-app-prototype.html`（手机 App）和 `prototypes/mobile-pairing-settings-prototype.html`（桌面"手机"设置页）

## 背景与目标

Atrium 的 agent 在 Mac 上跑，离开电脑就看不到进度，也没法回答它的提问。各家的做法见 mobile-remote.md。用户定了：做 SwiftUI 原生 iOS App，经用户自己 VPS 上的 relay 连回宿主，手机和宿主之间用 Noise 端到端加密，宿主的身份放 macOS 钥匙串保护的保险箱，先不做推送（2026-10-24）。

目标：

- 桌面和手机看到的是**同一个对话**，由宿主持有；两端都能发消息、插话、停止、回答。
- 手机在任何网络下都能连上（不依赖 VPN），relay 看不到内容。
- 每台手机都有自己的身份，可以单独撤销。
- 手机网络断开、App 切到后台再回来时，很快看到最新状态；发出去的消息不会因为重试而投递两次，没确认的会明确告诉你。

## 非目标

- 推送通知、灵动岛和锁屏上的实时进度（要付费开发者账号，ADR-0015）。
- Android、iPad 的专门布局（iPad 能装 iPhone 版就行）、Apple Watch。
- 手机上的终端、编辑文件、设置和 pi 配置、登录服务商、装 pi、添加项目、插件。
- 第一版不做（以后可加）：手机上新建 worktree 和子对话、"正在看哪个会话"、分叉、编辑已停止的消息、局域网直连、点对点（ADR-0016 第 9 条）。
- 多用户共用一个 relay、官方托管的 relay。
- 电脑睡着时用云端接着跑（mobile-remote.md §1）。
- 审批（MVP 2）。审批做出来以后手机上要能答，到时候在这里补。
- 本机窗口改用续传和发消息回执：第一版只给手机用，桌面以后再接（审查建议，不一次改两边）。

## 需求

1. 桌面设置里有"手机"一页：打开或关闭远程访问、填 relay、配对、列出和撤销设备（原型 `mobile-pairing-settings-prototype.html`）。
2. 配对：Mac 上显示二维码，手机扫码后两边显示同一个 6 位校验码，在 Mac 上点确认才算配对成功。二维码 5 分钟内有效；同一时刻只接受一台手机，一个码只能成功配对一次。
3. 手机上能看工作区和对话的列表，以及每个会话的状态：待回答、出错、运行中、已完成未读。
4. 打开一个会话后：看对话和实时输出、展开过程、发消息（可带图片）、插话、排队、停止、回答提问和对话框、切换模型和思考档位、看改动和 diff、在已有工作区或对话里开新会话。
5. 两端同时操作时结果确定：提问和对话框先到的答复生效，另一端的卡片随之收起；同一条消息不会因为重试而投递两次；宿主说不清是否送到时，手机明确显示"不确定是否送到"，由你决定是否重发。
6. 连接状态始终看得见：已连接、正在同步、正在重连、主机离线（附上次在线时间）、relay 连不上、版本不一致。同步完成前不允许发送，已经填的内容留在输入框里。
7. 回到前台后 0.5 秒内显示连接状态；网络可用时，通常 3 秒内回到最新状态（实测 p50）；短时间断开只补缺的事件，不重新拉整个对话。
8. relay 只看得到元数据；被攻破时拿不到对话、凭据和文件，也不能让手机删掉配对。
9. 撤销一台设备后，它马上断开，以后再也连不上。

已配对的手机是**完全可信的设备**：它能让 agent 执行任意本机工具。下文的命令白名单只是收窄手机上的产品入口，不是沙箱。

## 方案设计

### 总体

```
iOS App ──wss──▶ relay（用户 VPS，Caddy 终止外层 TLS）◀──wss── 宿主 RelayLink
   │               控制连接：只通知"有新流"                       │ 控制连接 1 条
   │               数据连接：每台手机一条，一对一转发字节          │ 数据连接 每台手机 1 条
   └──────────── Noise 加密通道，里面跑现有的 Atrium 协议 ───────────┘
                                                                    │
                                   Electron 主进程：safeStorage 保管保险箱（钥匙串）
```

- **宿主**：新增模块 `remote/`，负责连 relay、跑 Noise 握手、配对、登记设备。每条通道对外是一个"客户端传输"（见"宿主"），握手之后的路由、订阅、同步和本机窗口共用。
- **relay**：新应用 `apps/relay`（TypeScript，Node + `ws`），只负责路由和转发。
- **App**：新应用 `apps/ios`（SwiftUI）。

### 概念

| 名词 | 是什么 |
|---|---|
| 宿主身份 | `hostId`（relay 上 `add-host` 时生成）和一对长期的 X25519 密钥（第一次打开远程访问时在宿主生成），存在保险箱里 |
| 保险箱 | 宿主的秘密数据：宿主私钥、relay 地址和宿主令牌、已配对设备的列表。Electron 主进程用 `safeStorage` 加密后写到 `<ATRIUM_HOME>/remote/vault.bin`（0600），加密用的密钥在 macOS 钥匙串的"Atrium Safe Storage"里。宿主是唯一的写入者 |
| 设备 | 一台配对过的手机：`deviceId`（`dev_<16hex>`）、名字、公钥、配对时间。最后在线时间不算秘密，记在索引里 |
| 配对 | 一次进行中的配对：`pairingId`、32 字节一次性密钥（PSK）、过期时间、状态。只在宿主内存里，同时最多一个 |
| 流 | relay 上一台手机的一次连接，`streamId` 由 relay 分配 |
| 通道 | 一条流上完成 Noise 握手之后的加密双向通道，对应宿主的一个连接 |

### 部署 relay

1. 在 VPS 上运行 `atrium-relay`（`node relay.cjs` 或 Docker），配置文件 `relay.json`（含信任的反代地址）。前面放 Caddy 签证书、反代 `wss://<域名>`；relay 只认 Caddy 转来的真实 IP 头。
2. `atrium-relay add-host <名字>`：生成 `hostId`（`hst_<16hex>`）和 32 字节的宿主令牌，只打印一次，relay 只存令牌的 SHA-256。`rotate-host <hostId>` 换令牌，`remove-host` 删掉。
3. 在桌面"手机"页粘贴一行 `atrium-relay://<hostId>:<令牌>@<域名>`，点"测试连接"。
4. 部署说明写在 `apps/relay/README.md`，附 Caddyfile 和 systemd unit 示例。

### 配对流程

配对用 `Noise_IKpsk2_25519_ChaChaPoly_SHA256`，手机是发起方，宿主是响应方。按 Noise 规范，PSK 在第二条握手消息的末尾才混入，所以宿主读完第一条**还不能**确认对方知道 PSK；要等手机用握手后的密钥发来第一条传输消息（密钥确认）才算。

1. **出码**：桌面点"配对新设备"，宿主建一次配对（状态 `available`），二维码内容：
   `atrium://pair?v=1&relay=<wss 地址>&host=<hostId>&key=<宿主公钥 b64url>&pairing=<pairingId>&psk=<PSK b64url>&name=<Mac 名字>`
   App 只用自己的扫码界面读它，不注册给系统相机。过期、取消或刷新后，旧码作废。
2. **握手**：手机在钥匙串里生成自己的 X25519 密钥对（`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`），先把这台主机记成"待确认"，再连 relay，握手：
   - 第一条（`e, es, s, ss`）的载荷：`{ kind: "pair", pairingId, deviceName, model, appVersion, protocolVersion }`。`deviceName` 默认取 `UIDevice.current.name`。
   - 宿主核对 `pairingId` 是当前这次、状态 `available`、没过期，回第二条（`e, ee, se, psk`），载荷 `{ ok: true }`。核对不过就回 `{ ok: false, reason }` 后关闭（第二条的载荷用宿主的静态密钥认证过，手机可以信）。这一步**不改**配对状态。
3. **密钥确认**：手机发第一条传输消息 `{ kind: "pair_confirm" }`。宿主能解开它，才说明手机知道 PSK。宿主**原子地**把配对从 `available` 改成 `awaiting_confirmation`，记下这台手机的静态公钥和这条通道；已经不是 `available` 的（另一台手机先到），回 `{ kind: "pair_rejected", reason: "pairing_busy" }` 并关闭。
4. **校验码**：两边各自从握手结束时的哈希 `h` 算出 6 位校验码：`SHA-256("atrium-sas-v1" ‖ h)` 的前 4 字节按大端转成整数，对 10⁶ 取余，补零到 6 位。桌面弹层显示"某某的 iPhone 请求配对 · 校验码 123 456"，手机上显示同一个码，提示"在 Mac 上确认"。校验码只有约 20 位，只供人对照，不代替 PSK 和密钥确认。
5. **确认**：桌面点确认。`confirm_pairing` 带 `pairingId`，宿主只认第 3 步记下的那台手机的公钥和那条通道：
   - 先把设备写进保险箱，等主进程回"写好了"，配对改成 `committed`；
   - 再经通道发 `{ kind: "paired", deviceId, hostName }`。手机把"待确认"转成正式的主机记录，通道直接转为正常使用（接着走"日常连接"第 3 步的 `hello`）。
   - 保险箱写失败：配对改成 `rejected`，桌面显示原因，手机收到 `{ kind: "pair_rejected", reason: "host_error" }`。
6. **结束**：
   - 桌面点拒绝、2 分钟没确认、通道在确认前断开、5 分钟过期：配对改成 `rejected` 或 `expired` 并作废。要配对就重新出码。
   - 第 5 步写好了但 `paired` 没送到手机（断线）：手机下次用"待确认"里的主机信息走日常连接，第二条握手的载荷里有 `deviceId`，补成正式记录。日常连接被拒（`device_unknown`）就删掉"待确认"。

配对的状态只能这样走：`available → awaiting_confirmation → committed | rejected`，以及 `available → expired | rejected`（取消）。每一步的改动都在宿主的一次同步调用里完成，不跨 `await`。

### 日常连接

1. 手机连 relay，用 `Noise_IK_25519_ChaChaPoly_SHA256` 握手，第一条载荷 `{ kind: "connect", appVersion, protocolVersion }`。
2. 宿主按握手里解出的手机静态公钥查设备，回第二条，载荷是：
   - 查到：`{ ok: true, deviceId }`，通道建立；
   - 查不到：`{ ok: false, reason: "device_unknown" }`，然后关闭；
   - 协议版本不兼容：`{ ok: false, reason: "version_mismatch", hostProtocol }`，然后关闭。手机停止重连，显示"Mac 上的 Atrium 和 App 版本不一致"。
3. 通道里先跑现有的 Atrium 握手：手机发 `hello`，**不带 `token`**，`clientId` 必须等于 `deviceId`，不等就以 `BadHandshake` 断开；宿主回 `welcome`。
4. 宿主给这个连接标上 `origin: "remote"` 和 `deviceId`。这两样只由通道写入，客户端发的任何字段都改不了。之后按"远程客户端能用的命令"过滤命令，按"给手机推什么"过滤事件。

### 撤销

- 在桌面撤销一台设备：宿主先在内存里把它拉黑、立刻关闭它的所有通道（关闭前经通道发 `{ kind: "revoked" }`），再写保险箱。写失败时桌面提示"没能写入保险箱，重启 Atrium 后它会恢复"并给"重试"，内存里的拉黑一直保留到这次宿主退出。
- 手机只在**收到经 Noise 认证的** `revoked` 或握手第二条的 `device_unknown` 时，才删掉这台主机的钥匙串数据和本机缓存、草稿，显示"这台手机已被撤销"，引导重新配对。外层 WebSocket 或 relay 给的关闭原因只用来显示"连接断开"，不触发删除（relay 能伪造它们）。手机离线时被撤销，下次连接拿到 `device_unknown` 时同样处理。
- "撤销全部并重新生成宿主密钥"：清空设备列表，换掉宿主密钥对，所有手机都要重新配对。relay 上的宿主令牌不变（要换就到 relay 上 `rotate-host`）。
- **换 relay**：手机记的 relay 地址来自二维码。第一版换了 relay 地址或 `hostId` 后，每台手机都要重新扫码配对（设备列表保留，重新配对的手机按公钥认出、覆盖原记录）；经旧通道把新地址推给手机以后再做。

### 断线与恢复（App）

- **心跳**：通道层的心跳（见"Noise 通道 · 分帧"），前台每 10 秒一次，15 秒没回应算一次失败，连续 2 次失败就重连。宿主对每条通道同样发心跳，30 秒没回应就关闭。
- **回到前台**：0.5 秒内把状态改成"正在同步"。最近 20 秒内收到过宿主的东西，就发一次心跳，2 秒没回应再重连；否则直接新开连接。
- **重连**：退避从 1 秒开始，每次翻倍，最多 30 秒，加随机抖动。网络状态（`NWPathMonitor`）变化、回到前台时，退避清零重来。`version_mismatch`、`device_unknown`、被撤销时不再重连。
- **进入后台**：用 `beginBackgroundTask` 尽量关掉连接，但不依赖它一定执行；宿主靠心跳超时清理。回到前台再连上，按游标补齐（"协议改动"第 3 条）。
- **"已连接"分两步**：加密通道建好了显示"正在同步"；所有打开着的会话都补齐或换上快照后才算"已连接"，这之前发送按钮不可用。
- **断开期间**：
  - 输入框可以写，"发送"不可用，提示"重连后才能发送"；草稿只存在本机。
  - 不做离线发件箱：回来时可能已经过时，发出去容易误操作。
  - **已经发出、还没收到应答的消息**单独显示为"发送中"的气泡，不放回输入框。重连后用同一个 `requestId` 自动重试一次（"协议改动"第 4 条）；宿主回"结果不确定"时，先在对话记录里找这个 `clientMessageId`，找到就算送到了，找不到就显示"没能确认是否送到 · 重发"，点了才用新的 `requestId` 发。
- **冷启动**：先显示本机缓存的列表和最近打开会话的快照，标为"不是最新"，同步完成后整体替换。缓存的规则见"iOS App · 存储"。

### 远程客户端能用的命令

按白名单放行，白名单之外的应答新的错误码 `local_only`。白名单写在宿主的一个文件里，有一个测试检查 `COMMAND_TYPES` 里的每个命令都被明确归了类（2026-10-24 共 75 个：放行 39、不放行 36），以后新增命令不归类，测试就通不过。

- **放行**：
  - 握手与订阅：`ping`、`subscribe_index`、`subscribe_sessions`、`open_session`；
  - 读：`fetch_transcript`、`fetch_step`、`fetch_image`、`list_models`、`list_commands`、`watch_changes`、`watch_diff`、`list_dir`、`read_file`；
  - 发与控：`prompt`、`steer`、`stop`、`resume_queue`、`clear_queue`、`update_queued`、`remove_queued`、`steer_queued`、`remove_delivery`、`resume_deliveries`、`retry_run`、`answer_interaction`、`answer_question`；
  - 设置会话：`set_model`、`set_thinking_level`、`set_fast`、`compact_session`；
  - 会话与对话：`create_chat`、`create_session`（带 `child` 参数的应答 `local_only`）、`select_container`、`close_tab`、`clear_attention`、`rename_session`、`archive_session`；
  - 其他：`upload_attachment`、`report_client_issue`。
- **不放行**：
  - 项目和工作区：`add_project`、`remove_project`、`rename_project`、`discover_projects`、`archive_workspace`、`restore_workspace`、`set_main_branch`、`list_branches`、`list_bases`、`create_workspace`、`name_branch`、`rename_workspace`、`rename_chat`；
  - 登录与安装：`login`、`answer_login`、`cancel_login`、`logout`、`install_pi`、`install_node`、`update_pi`、`cancel_install`、`check_setup`、`check_pi_update`；
  - 配置：`read_pi_config`、`save_pi_config`、`set_preferences`；
  - 本机专用：`window_focused`、`hand_off`、`take_back`、`export_session`；
  - 第一版不做的：`edit_stopped_message`、`fork_session`、`detach_session`、`archive_chat`、`restore_chat`、`search_files`；
  - 新增的远程管理命令（下文"宿主"）一律只给本机。

### 给手机推什么

事件也按来源过滤（`SubscriptionRegistry` 的广播和握手后的补发都要过滤）：

- **推**：列表（`index_snapshot`、`index_changes`）、会话事件、`changes_updated`、`diff_updated`、`plans_updated`、新增的 `session_resumed`。
- **不推**：`login_updated`（里面有授权地址）、`install_updated`、`install_output`、`pi_latest`、`credentials_changed`，以及新增的 `remote_updated`。
- 和白名单一样，有一个测试检查 `HostMessage` 的每种事件都归了类。

## 接口与数据

### relay 的线路协议（`apps/relay`）

宿主到 relay 有两种连接：一条**控制连接**，只用来知道"有手机来了"；每台连上来的手机，宿主再开一条**数据连接**，relay 把它和手机的连接一对一接起来。这样每台手机的积压就是那条数据连接自己的 `bufferedAmount`，一台读得慢的手机不会堵住别的手机（审查后改，原先是一条控制连接里按流 id 多路复用）。

| 入口 | 谁连 | 第一帧 | 之后 |
|---|---|---|---|
| `wss://<relay>/v1/host` | 宿主，控制连接 | 文本 `{ v: 1, type: "hello", hostId, token }`，5 秒内要到 | relay 发文本 `{ type: "open", streamId, ipHash }`；宿主可回 `{ type: "refuse", streamId }`。WebSocket 原生 ping 20 秒一次，60 秒没回应算断开 |
| `wss://<relay>/v1/host/stream` | 宿主，每台手机一条 | 文本 `{ v: 1, type: "hello", hostId, token, streamId }`，5 秒内要到 | 二进制帧原样转发给对应的手机 |
| `wss://<relay>/v1/client?host=<hostId>` | 手机 | 无（直接是 Noise 消息） | 二进制帧原样转发给宿主的数据连接 |

- **认证**：令牌按 SHA-256 比对，用常量时间比较；失败以 4401 关闭。同一个 `hostId` 的新控制连接认证通过后挤掉旧的；relay 给每条控制连接记一个代数，旧连接的关闭回调只清理自己那一代的东西。
- **宿主不在线**：手机的连接以 4404 关闭，原因写 `offline:<上次在线的 Unix 秒>`。
- **接线**：relay 给新流分配 128 位随机的 `streamId`。宿主的数据连接到之前，手机发来的帧最多先存 8 帧、256 KiB；10 秒内数据连接没来就以 4408 关掉手机。任一端关闭，relay 关掉另一端；控制连接断了，这个宿主的所有流一起关掉。
- **上限**：
  - 没认证的连接（宿主两种入口还没发 `hello` 的）全局最多 64 条；
  - 每个宿主同时最多 16 条流；同一个 IP 每分钟最多新建 30 条流；
  - 每帧最大 70 KiB（Noise 单条最大 65535 字节）；
  - 每个方向积压超过 4 MiB 就以 4507 关掉这一对连接；relay 所有缓冲合计 256 MiB，超了拒绝新流。
- **宿主自己也设限**，不依赖 relay（relay 可能被攻破）：同时最多 4 条还没握完手的流，握手 10 秒没完成就关；已认证的通道每台设备最多 2 条，新的挤掉旧的。
- **日志**：只记 `hostId`、`streamId`、IP 的加盐哈希、字节数、关闭码，不记载荷和 `hello` 帧。另有 `GET /healthz`。
- **relay 能看到的**：IP、时间、大小、`hostId`、`streamId`、宿主令牌，以及握手第一条里手机的临时公钥。手机的静态公钥在 IK 里是加密的，看不到。宿主令牌泄露后，别人能冒充宿主连 relay、挤掉真的宿主，但完成不了握手（手机按二维码里的宿主公钥核对），后果是手机连不上；到 relay 上 `rotate-host` 换令牌。

### Noise 通道

字节级的约定，TypeScript 和 Swift 两边照这一节实现，互通测试按这一节写。

- **模式**：配对 `Noise_IKpsk2_25519_ChaChaPoly_SHA256`，平时 `Noise_IK_25519_ChaChaPoly_SHA256`。手机是发起方。
- **手机的第一帧**：`0x41`（`A`）、版本 `0x01`、模式（`0x01` 是 IK，`0x02` 是 IKpsk2），后面是握手第一条。宿主不认识版本或模式就直接关闭，不回退到别的版本。宿主的第一帧就是握手第二条。
- **prologue**：ASCII `atrium-remote/1`、`0x00`、`hostId` 的 ASCII、`0x00`。模式名本身已经进了握手哈希，两边模式对不上握手就会失败。
- **公钥**：DH 结果全零（低阶点）就中止握手。
- **握手载荷**：UTF-8 JSON，最长 1 KiB。
- **传输**：每个 WebSocket 二进制帧是一条 Noise 传输消息（不超过 65535 字节）。nonce 是 Noise 规定的隐式计数，两个方向各自从 0 开始，不写进帧里；丢帧、重放、乱序都会让解密失败，失败就关闭通道。不做 rekey；nonce 到上限就关闭（实际碰不到）。
- **分帧**：每条明文的第 1 字节是类型：
  - `0x00`：一条 Atrium 消息的最后一块，`0x01`：后面还有块；
  - `0x02`：心跳，`0x03`：心跳的回应；
  - `0x04`：通道控制消息（JSON，单块）：`pair_confirm`、`paired`、`pair_rejected`、`revoked`。
  
  一个方向上，同一条消息的块是连续的（发送方整条发完再发下一条）；心跳和控制消息可以夹在块之间。收到 `0x01` 后 30 秒内没收齐就关闭。不认识的类型就关闭。
- **大小**：手机发给宿主的一条消息最大 1 MiB（同本机）；宿主发给手机的一条消息最大 8 MiB。超过时：
  - 应答：改发失败应答 `response_too_large`（`params.limit`），App 按需改用分页或提示"在 Mac 上查看"；
  - 会话事件：改发这个会话的快照（受手机的快照预算）；
  - 都按编码后的整条消息算（含信封、`control`、base64）。
- **不压缩**：先压缩再加密，在攻击者能往里放内容时会泄露信息。
- **实现**：先在 MP0 的互通实验里比较现成的 Noise 实现（TypeScript 和 Swift 各看 2～3 个），能用就用。自己写的话：TypeScript 用 `@noble/curves`、`@noble/ciphers`、`@noble/hashes`，Swift 用 CryptoKit，状态机两边各写一份，除了公开测试向量（cacophony 的 IK、IKpsk2），还要测畸形消息、低阶公钥、nonce 边界，并做模糊测试。新依赖精确锁定版本，登记进 security.md"外部边界登记"。

### 宿主

**新模块** `packages/host/src/remote/`：

| 文件 | 职责 |
|---|---|
| `vault.ts` | 经 Electron 端口读写保险箱（见下）；宿主单独运行时没有保险箱，远程访问不可用（`remote_unavailable`） |
| `relay-link.ts` | 控制连接和各数据连接：连接、认证、重连（1 秒到 60 秒退避）、按流开数据连接，计入资源计数 |
| `channel.ts` | 一条数据连接上的握手、分帧、心跳，对外是 `ClientTransport` |
| `pairing.ts` | 配对的状态机和超时，用注入的 `Clock` |
| `devices.ts` | 设备列表、内存里的拉黑、最后在线时间（写进索引） |
| `receipts.ts` | 发消息的回执（"协议改动"第 4 条） |
| `remote-service.ts` | 把以上几个组起来，给路由和界面用 |

**客户端传输**：`ws-server.ts` 现在的 `acceptConnection` 直接用 WebSocket 的 `on`、`ping`、`terminate`。抽出一个最小接口 `ClientTransport`：`send(text)`、`bufferedAmount`、`close(code, reason)`、`onMessage`、`onClose`、`checkAlive()`（本机用 WebSocket 的 ping/pong，远程用通道心跳）。握手之后的逻辑两边共用；本机升级阶段的 `Origin` 检查、连接数、限流、关闭时的清理原样留在本机这条路上。远程通道也算进"最多 32 个连接"。

**保险箱的进程交接**：现在的 Electron 端口只有启动配置、关闭和资源报告，要加一对带请求 id 的消息：

- 宿主 → 主进程：`{ type: "vault_read", id }`、`{ type: "vault_write", id, version, data }`；
- 主进程 → 宿主：`{ type: "vault_result", id, ok, data? , error? }`。
- 主进程用 `safeStorage` 加解密，写入时先写临时文件再改名，按 `version` 拒绝过期的写；宿主是唯一的写入者，写操作排队依次进行。
- 失败一律不放行：钥匙串不可用、文件损坏时远程访问显示原因（"钥匙串不可用""保险箱损坏"），本机功能照常；损坏时不会自动重新生成身份，要你在设置里点"重置"。
- `safeStorage` 防的是别的应用和拿到磁盘文件的人。本机打包只做 ad-hoc 签名、没收紧 Electron fuses（security.md），同用户下能改这个应用的进程不在防护范围内。

**给本机界面的命令和事件**（只给 `origin: "local"` 的连接）：

- `get_remote` / 事件 `remote_updated`：
  - `enabled`、`vault`（`ok` / `keychain_unavailable` / `corrupt`）；
  - `relay: { url, hostId, status: off | connecting | connected | error, error, lastConnectedAt }`；
  - `hostFingerprint`（宿主公钥 SHA-256 的前 8 字节，分组显示）；
  - `devices: [{ deviceId, name, pairedAt, lastSeenAt, online, traffic: { down, up } }]`：`traffic` 是这台设备所有通道最近 2 秒的平均字节率（每秒），链路图按它画数据包的疏密；宿主每秒最多推一次，没有在看"手机"页的本机连接时不推。设备的颜色由界面按 `deviceId` 的哈希从一组固定色里取，不存；名字清空时恢复配对时手机报的 `deviceName`。
  - `pairing: { pairingId, qr, expiresAt, state, request: { deviceName, model, sas } | null, refused: number } | null`，`refused` 是这次配对里因为已有手机在确认而被拒的次数，界面记一行"另一台手机也扫了这个码，已拒绝"。
- `set_remote({ enabled, relay?: string })`：`relay` 是那一行 `atrium-relay://…`；令牌只进不出，`remote_updated` 里不回传。
- `test_relay`、`start_pairing`、`cancel_pairing`、`confirm_pairing({ pairingId, accept })`、`rename_device({ deviceId, name })`、`revoke_device({ deviceId })`、`reset_remote_identity`。
- 新错误码：`local_only`、`remote_unavailable`、`pairing_expired`、`pairing_busy`、`device_not_found`、`relay_unreachable`、`relay_rejected`、`keychain_unavailable`、`vault_corrupt`、`response_too_large`、`request_conflict`、`outcome_unknown`。

### 协议改动（协议版本 +1）

1. **`hello.token` 改为可选**：本机 WebSocket 必须带，远程通道必须不带（带了按 `BadHandshake` 断开）；远程的 `clientId` 必须等于通道认出的 `deviceId`。
2. **快照预算**：`subscribe_sessions` 加可选的 `snapshot: { turns: 1–20, bytes: 64 KiB–4 MiB }`，默认不变（20 轮、4 MB）；App 用 6 轮、512 KiB。预算跟着这次订阅走，之后因为 `epoch` 变化重发的快照也按它。`fetch_transcript` 加可选的 `maxBytes`，按编码后的字节截断，至少一条。按字节算是吸取 Paseo #2220、#6078 的教训。
3. **订阅时续传**：
   - `session_snapshot` 加 `stream`：一个不透明的字符串，宿主实例和会话控制器每次新建都不同（`epoch` 只在一个控制器里有意义，控制器回收重建后会从 1 重来）。
   - `subscribe_sessions` 加可选的 `resume: [{ sessionId, stream, epoch, seq }]`。
   - 宿主为最近有手机订阅的会话在内存里留最近的事件：每个会话最多 512 条、1 MiB；全宿主合计 32 MiB，超了先丢最久没用的；没有手机订阅满 10 分钟就丢；控制器回收时一起丢。这部分计入资源报告。
   - 订阅时在**同一次同步调用里**取出 `(seq, S]` 的事件、登记订阅（`S` 是此刻最新的 `seq`），所以补发的和之后实时的之间不会插进别的，也不会漏：
     - `stream`、`epoch` 都对得上，事件环覆盖 `seq + 1` 起的部分：依次补发这些事件，然后发新事件 `session_resumed { sessionId, epoch, seq: S }`；`seq` 已经等于 `S` 时只发这一条。
     - 否则照旧发快照（受预算）。快照本身不占 `seq`，下一条事件是 `S + 1`（现有做法）。
   - 每个会话收到 `session_resumed` 或快照，算这个会话同步完了。
4. **发消息的回执**（第一版只给远程连接的 `prompt`、`steer`）：
   - App 的 `requestId` 是随机 UUID，一次发送的重试用同一个，新的一次发送用新的。（桌面现在的 `requestId` 是"客户端 id + 计数"，重启后会重复，所以桌面不接回执，以后要接得先改成随机的。）
   - 回执按 `(deviceId, requestId)` 记，内容哈希只算命令类型、`sessionId`、文字和图片张数，不算附件 id（断线后附件要重新上传，id 会变）和 `traceparent`。
   - 执行前先把"处理中"写进 `<ATRIUM_HOME>/remote/receipts.json`（临时文件加改名）；同一个键再来一次时，接到正在执行的那一次上，不再执行。执行完记下应答。
   - 同一个 `requestId`、同样内容、已经做完：直接回原来的应答。内容不同：`request_conflict`。
   - 宿主重启时，还在"处理中"的改成"结果不确定"；再拿这个 `requestId` 来，应答 `outcome_unknown`，不执行。宿主和 pi 之间没有事务，不承诺恰好一次，只保证不会因为重试多发一次。
   - 每台设备最多 200 条，24 小时过期；App 只在 10 分钟内用同一个 `requestId` 重试，超过就当"不确定"处理（见"断线与恢复"）。
   - 附件不记回执：断线时宿主丢掉这条连接上传的附件（现有做法），重连后 App 重新上传，再用原来的 `requestId` 重试。
5. **先答先得**：读代码确认 `answer_question`、`answer_interaction` 判定和关闭在同一次同步调用里（`session-controller.ts`），已经是先到的生效，另一个应答 `question_closed` / `interaction_closed`，`control` 的更新推给所有订阅者，卡片随之收起。只补两条连接同时回答、回答后应答丢失的测试。App 收到 `question_closed` 时显示"已在别处回答"。

### iOS App（`apps/ios`）

- **最低系统**：iOS 26（用户定，2026-10-24）。Swift 6，开严格并发检查。
- **工程**（2026-10-25，MP1）：`apps/ios/AtriumKit` 是 SwiftPM 包，下表的模块是它的 target；App 本体和 UI 测试在手写维护的 `apps/ios/Atrium.xcodeproj` 里（文件夹同步、设置写在 xcconfig），不用 XcodeGen、Tuist，取舍见 [overview.md · iOS 工程](../architecture/overview.md#ios-工程2026-10-25-定mp1)；规范见 coding-standards、testing 的"Swift（手机端）"。
- **模块**（同一个 Xcode 工程里的 Swift 包）：

  | 模块 | 内容 |
  |---|---|
  | `AtriumProtocol` | 由 `packages/protocol` 生成的 `Codable` 类型，不手改 |
  | `AtriumNoise` | 握手、`CipherState`、分帧 |
  | `AtriumRemote` | relay 连接、心跳、重连、前后台切换（`actor`） |
  | `AtriumSync` | 列表和会话的状态：快照、续传、`session_resumed`、"发送中"的消息和回执、"同步完成"的判断。语义对齐 `packages/client` 的 `index-view`、`session-view` |
  | `AtriumRender` | 流式 Markdown、代码高亮、diff |
  | `AtriumUI` | SwiftUI 界面，视觉按选定的原型 |

- **协议类型的生成**（同 ADR-0015）：`pnpm protocol:swift` 用 zod 4 的 `z.toJSONSchema` 导出 `packages/protocol` 的 JSON Schema，再由自己写的生成器转成 Swift 的 `enum`（判别联合）和 `struct`。生成器只支持协议实际用到的构造，遇到不支持的就报错。生成的文件提交进仓库；`pnpm check` 重新生成后比对，有差异就失败。往返测试用 `envelope.test.ts` 里的样例，只证明编解码对得上；同步语义靠契约测试（"验证"）。
- **渲染**：
  - Markdown 用 Apple 的 `swift-markdown`（cmark-gfm）解析，自己写 SwiftUI 渲染；流式时只重新解析最后一块，对齐桌面 Streamdown 的按块缓存。
  - 代码高亮的库在 MP5 比较 2～3 个后选定。
  - Mermaid、PlantUML 显示原文加"在 Mac 上查看"。
  - 揭示节奏对齐桌面（按积压量平滑揭示，约 150 毫秒追平）。
- **存储**：
  - 钥匙串（`ThisDeviceOnly`，不进备份）：设备私钥，每台主机的公钥、`hostId`、relay 地址、`deviceId`，以及配对中的"待确认"记录。
  - 缓存：放在 Application Support 下按 `hostId` 和缓存格式版本分开的目录，数据保护 `complete`，标 `isExcludedFromBackup`。每个会话一个文件，快照和它的游标（`stream`、`epoch`、`seq`）一起原子写入，所以读出来的游标一定对应读出来的内容。被撤销、删掉这台主机时清掉缓存和草稿。
  - 草稿、偏好：App 沙盒。
- **扫码**：VisionKit `DataScannerViewController`，只认 `atrium://pair`。
- **安装**：用免费账号（Personal Team）签名，`pnpm ios:install` 调 `xcodebuild` 和 `devicectl` 装到连着的 iPhone 上。每 7 天要重装，App 在离过期还剩 1 天时提示。重装要保持同一个 bundle id 和签名团队，钥匙串里的配对和草稿才留得住，验收时实测。

### 界面

2026-10-25 定稿，视觉规范写在 [design-language · 手机端](../architecture/design-language.md#手机端) 和"设置"里的"手机"分类；原型 `prototypes/mobile-app-final-prototype.html`（手机）、`prototypes/mobile-pairing-linkmap-prototype.html`（桌面设置页）。经过的选择：

- 2026-10-24：手机第一轮选 A"系统原生"（iOS 26、Liquid Glass、按功能定密度）；设置页选 D"链路图"，再改成顺序动画（上行汇合、下行分发）。
- 2026-10-25：用户觉得 A 太像普通 iOS 配置页，参考 Claude Code、Codex、Cursor 的手机端重做视觉，选乙"Claude 式"：暖色底、衬线大标题、内容直接放在底色上，不用卡片和分隔线；顶部只有悬浮的圆形玻璃按钮，没有导航栏和 tab bar；玻璃只用在浮在内容上的东西。过程保留桌面的纵向时间轴；插图是用点阵画的像素猫。

功能上定的：

- **首页**：上面"等你处理"（元信息"状态 · 项目 · 工作区"，不写时间），不单列"运行中"；下面按项目 → 工作区 → 会话，每个工作区最多 3 个会话，其余进工作区页；不绑定项目的对话在最下面，不缩进。"改动"从工作区标题和对话里进，主机信息在左上角抽屉（只点按钮打开）。
- **运行中发消息同桌面**：空闲时发送就是发出，运行中发送进排队；插话（桌面的 ⌘回车）是长按发送弹出的菜单"立即插话"，排队 sheet 里也能把一条改成插话。没有单独的"排队 / 插话"切换。
- **提问**：进入有提问的对话时自动弹出 sheet。
- **模型 sheet**：同桌面的图标栏、模型列、点阵推理强度框和 Fast；选完不关（推理强度和 Fast 在同一个 sheet 里）。
- **改动列表**：单行按目录分组、行高 32pt，可切按改动量排；diff 默认不换行。键盘弹起时隐藏排队和子对话胶囊。
- **新会话**：新会话就是一个空的对话页，输入框上方是位置和模型两个胶囊；位置默认取入口（首页：最近用的工作区；工作区页：这个工作区；"对话"组：新对话），在 Mac 上已找不到的工作区在胶囊和选择里标出来、不能发送；发出时原地变成对话，标题先显示"新会话"，pi 起好名字后换上。手机发出新会话时宿主依次执行 `create_session` 和 `prompt`；`prompt` 失败时这个会话留作草稿、文字退回输入框。
- **最低 iOS 26**；不加 Face ID 锁。

### 可观测性

- 宿主日志新增 `remote` 服务：记设备 id、流 id、握手结果（不含载荷）、配对状态的变化、关闭码、字节数。不记校验码、PSK、令牌、二维码内容、消息内容。
- 手机连接的 trace 照旧从 `hello` 的 `traceparent` 接上，命令沿用现有的 span。
- App 的问题经 `report_client_issue` 写进宿主日志（同界面）；连不上时先存在本地，下次连上再报。
- relay 只记元数据，日志按天轮转。

### 安全（并入 security.md）

| 威胁 | 应对 |
|---|---|
| relay 或 VPS 被攻破 | 只看得到元数据；能让手机连不上，看不到内容。它伪造的关闭原因不会让手机删掉配对 |
| 配对二维码被拍到 | 5 分钟有效；同时只接受一台手机，密钥确认后才进入待确认；要在 Mac 上确认，两边显示同一个校验码 |
| 手机丢了 | 在 Mac 上撤销；私钥只在这台手机的钥匙串里，不进备份 |
| 宿主令牌泄露 | 冒充不了宿主（握手要宿主私钥），只能让手机连不上；`rotate-host` 换令牌 |
| 本机其他应用读保险箱 | 加密的密钥在钥匙串里，按应用签名授权；同用户下能改 Atrium 的进程不在范围内 |
| 配对过的手机冒充别的客户端 | `clientId` 必须等于通道认出的 `deviceId`，来源只由通道写入 |
| 手机碰到本机专用的东西 | 命令白名单、事件过滤，都有"每项都归了类"的测试。手机本身是可信设备，能让 agent 执行任意工具 |
| 重放、篡改、降级 | Noise 的隐式 nonce 和认证加密；版本和模式写在首帧，不认识就关闭，不回退 |
| 未认证的流占满名额 | relay 和宿主各自限数、限时 |
| 读得慢的手机拖垮宿主 | 每台手机一条数据连接，各自 16 MiB 积压上限（同本机）；relay 每个方向 4 MiB |

## 备选方案

已在 ADR-0015、ADR-0016 里比较过。本 SPEC 内部的取舍：

| 问题 | 采用 | 没采用 | 理由 |
|---|---|---|---|
| relay 上怎么分手机 | 一条控制连接 + 每台手机一条数据连接 | 一条连接里按流 id 多路复用 | 多路复用时，加密后的数据都在一个 socket 里，积压算不到具体哪台手机，一台慢的会堵住其他的；要做公平调度才行（审查后改） |
| 配对怎么确认手机知道 PSK | IKpsk2 加一条密钥确认 | 读完第一条就当确认 | IKpsk2 的 PSK 在第二条才混入，第一条证明不了什么 |
| 断开期间发消息 | 不允许，草稿留着 | 离线发件箱 | 回来时可能已经过时，发出去容易误操作 |
| 发消息幂等 | 只管远程的 `prompt`、`steer`，先记"处理中"，宿主重启后报"结果不确定" | 所有写命令都记、本机也记 | 其余命令重复执行影响小或天然只生效一次（回答）；桌面的 `requestId` 重启后会重复，接回执要先改 |
| 续传 | 宿主内存里的事件环，加 `stream` 和 `session_resumed` | 每次重拉快照 | 手机断线频繁，每次重拉费流量也慢 |
| 宿主身份存放 | `safeStorage` 加密文件（密钥在钥匙串） | 用 `security` 命令直接存钥匙串 | `security` 要把秘密放在命令行参数里，同用户的进程看得到 |
| 校验码 | 6 位，从握手结束时的哈希算出 | 只在 Mac 上点确认 | 拍到二维码的人可能抢先，只看设备名分不出来 |

## 风险与待定问题

1. **钥匙串授权会反复弹**：本机打包只做 ad-hoc 签名，每次重新打包签名都变，macOS 会再问一次"允许 Atrium 访问钥匙串"。`pnpm dev` 和打包版签名不同，各弹各的。MP0 实测，写进验收步骤。
2. **免费账号 7 天到期**：App 打不开前要重装。是否改用 SideStore 自动续签，用户自用一段时间后再定。
3. **Noise 两份实现**：原语成熟不等于组合起来对。先做互通实验、优先用现成实现；自己写就加畸形输入和模糊测试。
4. **Swift 侧跟不上协议**：靠生成类型、往返测试和契约测试守住。桌面的验收清单加一条"手机端是否要跟"。
5. **流式渲染的性能**：长回复和大代码块在旧 iPhone 上可能掉帧。MP5 做性能预算（同桌面：主线程没有超过 50 毫秒的卡顿）。
6. **relay 是单点**：VPS 挂了手机就用不了。第一版接受，`/healthz` 交给用户自己的监控。
7. **没有推送**：手机在口袋里时什么都收不到，这是"先不做推送"的已知代价。

## 实施计划

每一步按 development.md 的标准流程走：开 worktree、先改文档、原型、测试先行、审查、请用户验收。最不确定的（两种语言的加密互通、真机、钥匙串）放最前面；功能先打通一条最窄的路，再加宽。

| 步 | 内容 | 完成标准 |
|---|---|---|
| MP0 互通实验 | 比较现成的 Noise 实现并选定；TS 和 Swift 各跑通 IK、IKpsk2、密钥确认、分帧、心跳；最小的本机 relay；真机经它和 TS 写的假宿主完成配对握手；实测 `safeStorage` 经 Electron 端口交接和钥匙串弹窗 | 真机配对握手通过，两边都过公开测试向量；结论写回本 SPEC 和 ADR-0016 |
| MP1 Swift 规范与类型生成 | coding-standards、testing 补 Swift（格式化、静态检查、文档注释、Swift Testing）；`apps/ios` 工程；`pnpm protocol:swift` 和往返测试；`pnpm check` 接上能在命令行跑的 Swift 检查 | 生成的类型能编译，往返测试通过 |
| MP2 relay | `apps/relay`：两种连接、认证、代数、上限、日志、`add-host` / `rotate-host`、部署说明 | 单元和集成测试（真实 `ws`），泄漏测试；在用户的 VPS 上跑起来 |
| MP3 宿主远程模块与桌面"手机"页 | `ClientTransport`、保险箱交接、RelayLink、通道、配对状态机、设备、撤销、白名单、事件过滤、消息上限；按选定原型做设置页 | TS 假手机在端到端测试里完成配对（含各种失败）、日常连接、撤销；变异测试 ≥ 80% |
| MP4 纵向切片 | 宿主：快照预算、续传、回执。App：扫码配对、列表、打开一个会话、发文字、断线重连和"发送中"、连接状态 | 真机走通"配对 → 列表 → 打开 → 发一条 → 断网再连上"；契约测试（Swift 客户端连真实宿主加 faux pi） |
| MP5 对话 | 流式渲染、过程、插话、排队、停止、提问和对话框、关注状态、图片 | 契约测试；性能预算 |
| MP6 改动与新建 | 改动列表和 diff、新会话、换模型和思考档位 | 同上 |
| MP7 自用 | 用一周，查重连、耗电、流量；按需修 | 用户验收 |

## 验证

- **Noise**：两边都跑公开测试向量；TS ↔ Swift 互通（Swift 用 TS 生成的确定性握手记录，反过来也一样）；篡改、重放、乱序、超长、低阶公钥、不认识的版本和模式、拼块超时都要被拒绝。
- **relay**：用真实的 `ws` 起 relay、假宿主、假手机，覆盖认证、新控制连接挤掉旧的（旧连接的清理不碰新的）、宿主离线、接线超时、各项上限、读得慢；泄漏测试（连接、定时器回到基线）。
- **宿主**：
  - 起真实的 relay 进程，用 TS 假手机走完配对：正常、过期、取消、拒绝、2 分钟没确认、确认前断开、两台手机同时扫、写保险箱失败、`paired` 没送到后用日常连接补上；
  - 日常连接：未知设备、版本不一致、`clientId` 不等于 `deviceId`、撤销时马上断开、写保险箱失败时内存拉黑仍生效；
  - 续传：环内、环外、`stream` 或 `epoch` 变了、`seq` 已经最新、补发期间有新事件；
  - 回执：同 id 同内容、同 id 不同内容、执行中再来一次、宿主重启后的"结果不确定"、过期；
  - 先答先得：两条连接同时回答、回答后应答丢失；
  - 白名单和事件过滤：每项都归了类；消息超上限时的处理；
  - 每个新测试都做破坏检查；`remote/` 加进变异测试分组。
- **App**：
  - Swift Testing 的单元测试，覆盖同步算法、分帧、重连状态机、缓存的原子写入；
  - 契约测试：宿主用 testkit 的 faux pi，经本机 relay 连上；
  - 少量 XCUITest：配对、发消息、回答提问；
  - 网络故障：在 relay 和手机之间放一个能丢包、加延迟、断开的代理。
- **追踪表**：新行为都登记进 `docs/testing/coverage-map.md`。
