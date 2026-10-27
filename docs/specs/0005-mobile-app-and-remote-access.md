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
iOS App ──wss──▶ relay（用户 VPS，前面的反代终止外层 TLS）◀──wss── 宿主 RelayLink
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

2026-10-25 MP2 按用户的 VPS 改：原先写的是"前面放 Caddy 签证书"。用户的 VPS 上 443 已由 nginx stream 转给 xray，xray 用证书终止 TLS，不是代理的流量回落到 nginx 的 `127.0.0.1:8080`（HTTP/1.1），所以改成"前面放一个终止 TLS 的反代（Caddy 或已有的 nginx）"，并补上 Docker 的部署方式。

1. **运行**：`atrium-relay` 是一个单文件 `relay.cjs`（Node 24），用 `node relay.cjs serve` 或 Docker 镜像（`apps/relay/Dockerfile`：官方 node 镜像，非 root 用户）运行。单文件在开发机上从锁定的依赖构建，镜像只是把它放进官方 node 镜像，在开发机上构建好再 `docker save | ssh … docker load` 传到 VPS（2026-10-25 MP2 实测：在 `docker build` 里装依赖要拉整个工作区的元数据和开发工具，很慢；VPS 上也没有 Node）。只监听本机地址：默认 `127.0.0.1:8787`（`--listen` 可改）；容器里监听 `0.0.0.0:8787`，端口只发布到宿主机的 `127.0.0.1`。数据目录（`--dir`，默认当前目录；容器里是挂进去的 `/data`）里有：
   - `relay.json`：手写的配置。`publicHost`（对外的域名，可带端口，必填）、`pathPrefix`（路径前缀，如 `/atrium`，默认空）、`trustedProxies`（信任哪些反代地址给的真实 IP 头，默认空）、`newStreamsPerIpPerMinute`（默认 30，0 表示不按 IP 限）。不认识的字段报错，免得拼错的配置悄悄不生效。
   - `hosts.json`：`add-host` 等命令维护的宿主表（0600），每个宿主只存 `hostId`、名字、令牌的 SHA-256 和创建时间。正在跑的 relay 每 2 秒看一次它变没变，变了就重读：删掉或换了令牌的宿主，控制连接以 4401 关掉，它的流一起关掉。读出来不合格时保留原来的表，记一条日志。
   - `logs/relay-<UTC 日期>.jsonl`：日志，一天一个文件，留 14 天。
2. **前面放一个终止 TLS 的反代**（Caddy 或已有的 nginx）：把 `https://<域名><前缀>/` 下的请求原样（不去掉前缀）转给 relay，支持 WebSocket 升级。relay 自己按 `pathPrefix` 认路径，对外的入口是 `wss://<域名><前缀>/v1/host` 等（见"relay 的线路协议"）。用户的部署：在 nginx 8080 的 server 里加 `location /atrium/`，示例在 `apps/relay/deploy/`。
3. **真实 IP**：只有连接来自 `trustedProxies` 里的地址时，relay 才读 `X-Forwarded-For`（从右往左取第一个不在信任列表里的）或 `X-Real-IP`；列表为空、或连接不是来自列表里的地址时，用连接的地址。**已知限制**：用户的部署经 xray 回落后，nginx 看到的来源都是 `127.0.0.1`，relay 拿不到手机的真实 IP，所有手机算同一个 IP，"每个 IP 每分钟 30 条新流"实际上成了全局每分钟 30 条（一个人用够了），也可以设成 0 关掉；其余上限（未认证连接数、每宿主的流数、缓冲）照常生效。要拿到真实 IP，得让 xray 回落时带 PROXY protocol、nginx 从中取地址，第一版不做。
4. **加宿主**：`atrium-relay add-host <名字>` 生成 `hostId`（`hst_<16hex>`）和 32 字节的宿主令牌（base64url），只往标准输出打印一次一行 `atrium-relay://<hostId>:<令牌>@<publicHost><pathPrefix>`，不进日志；relay 只存令牌的 SHA-256。`rotate-host <hostId>` 换令牌，同样只打印一次新的一行；`remove-host <hostId>` 删掉；`list-hosts` 列出 `hostId`、名字和创建时间（不含令牌）。
5. 在桌面"手机"页粘贴这一行，点"测试连接"。宿主据此连 `wss://<publicHost><pathPrefix>/v1/host`，收到 `ready` 算连上。
6. 部署、升级、回滚、加宿主、换令牌、查日志和已知限制写在 `apps/relay/README.md`；`apps/relay/deploy/` 里有 nginx 的 `location` 片段、`compose.yaml` 和不用 Docker 时的 systemd unit 示例。

### 配对流程

配对用 `Noise_IKpsk2_25519_ChaChaPoly_SHA256`，手机是发起方，宿主是响应方。按 Noise 规范，PSK 在第二条握手消息的末尾才混入，所以宿主读完第一条**还不能**确认对方知道 PSK；要等手机用握手后的密钥发来第一条传输消息（密钥确认）才算。

1. **出码**：桌面点"配对新设备"，宿主建一次配对（状态 `available`），二维码内容：
   `atrium://pair?v=1&relay=<wss 地址>&host=<hostId>&key=<宿主公钥 b64url>&pairing=<pairingId>&psk=<PSK b64url>&name=<Mac 名字>`
   查询参数的值按 UTF-8 百分号编码（沿用 MP0；空格是 `%20`，不是表单编码的 `+`，兼容 Swift `URLComponents`）。App 只用自己的扫码界面读它，不注册给系统相机。过期、取消或刷新后，旧码作废。
2. **握手**：手机在钥匙串里生成自己的 X25519 密钥对（`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`），先把这台主机记成"待确认"，再连 relay，握手：
   - 第一条（`e, es, s, ss`）的载荷：`{ kind: "pair", pairingId, deviceName, model, appVersion, protocolVersion }`。`deviceName` 默认取 `UIDevice.current.name`。
   - 宿主核对 `pairingId` 是当前这次、状态 `available`、没过期，回第二条（`e, ee, se, psk`），载荷 `{ ok: true }`。这一步**不改**配对状态。
   - 核对不过时分两种（2026-10-25 MP0 实测后补）：`pairingId` 就是当前这次、但已过期、已被占用或版本不一致，用这次的 PSK 回第二条，载荷 `{ ok: false, reason }` 后关闭（载荷经宿主静态密钥和 PSK 认证，手机可以信）；`pairingId` 不是当前这次（码已取消、刷新过、扫的是别的 Mac），宿主没有手机用的那个 PSK，写出的第二条手机解不开，所以直接关闭，手机解不开第二条或连接被关时显示"二维码已失效，请在 Mac 上重新出码"。
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
- **回到前台**：只在从后台（`.background`）回到 `.active` 时进入恢复；`.inactive`（下拉控制中心、系统弹窗）不动连接（2026-10-25 参考 mimi-remote 补）。0.5 秒内把状态改成"正在同步"。最近 20 秒内收到过宿主的东西，就发一次心跳，2 秒没回应再重连；否则直接新开连接。
- **重连**：退避从 1 秒开始，每次翻倍，最多 30 秒，加随机抖动。网络状态（`NWPathMonitor`）变化、回到前台时，退避清零重来。`version_mismatch`、`device_unknown`、被撤销时不再重连。
- **进入后台**：用 `beginBackgroundTask` 尽量关掉连接，但不依赖它一定执行；宿主靠心跳超时清理。回到前台再连上，按游标补齐（"协议改动"第 3 条）。
- **"已连接"分两步**：加密通道建好了显示"正在同步"；所有打开着的会话都补齐或换上快照后才算"已连接"，这之前发送按钮不可用。
- **断开期间**：
  - 输入框可以写，"发送"不可用，提示"重连后才能发送"；草稿只存在本机。
  - 不做离线发件箱：回来时可能已经过时，发出去容易误操作。
  - **发送分三态**：还没写进通道就断了的，标"没发出去"，文字退回输入框，可直接重发；已经写出、还没收到应答的，显示为"发送中"的气泡，不放回输入框；同一会话里还有"发送中"或"不确定"的消息时，新的发送先拦下，提示"上一条还没确认"，等它有结果再放行（2026-10-25 参考 mimi-remote 补）。
  - **已经发出、还没收到应答的消息**：重连后用同一个 `requestId` 自动重试一次（"协议改动"第 4 条）；宿主回"结果不确定"时，先在对话记录里找这个 `clientMessageId`，找到就算送到了，找不到就显示"没能确认是否送到 · 重发"，点了才用新的 `requestId` 发。
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
| `wss://<relay>/v1/host` | 宿主，控制连接 | 文本 `{ v: 1, type: "hello", hostId, token }`，5 秒内要到 | relay 先回文本 `{ type: "ready" }`，之后发 `{ type: "open", streamId, ipHash }`；宿主可回 `{ type: "refuse", streamId }`。WebSocket 原生 ping 20 秒一次，60 秒没回应算断开 |
| `wss://<relay>/v1/host/stream` | 宿主，每台手机一条 | 文本 `{ v: 1, type: "hello", hostId, token, streamId }`，5 秒内要到 | 二进制帧原样转发给对应的手机 |
| `wss://<relay>/v1/client?host=<hostId>` | 手机 | 无（直接是 Noise 消息） | 二进制帧原样转发给宿主的数据连接 |

`<relay>` 是 `<publicHost><pathPrefix>`（"部署 relay"），健康检查是 `GET <relay>/healthz`（回 200 和 `ok`，不带别的信息）；前缀下的其他路径和其他方法回 404。

- **认证**：令牌按 SHA-256 比对，用常量时间比较；`hostId` 不存在时照样拿一个固定的哈希比一次，不让耗时透露哪个 `hostId` 存在。`hello` 不是文本、不是 JSON、字段不对、`hostId` 不存在、令牌不对，都以 4401 关闭。通过后 relay 回 `{ type: "ready" }`（2026-10-25 MP2 加：宿主据此知道认证过了，"测试连接"要用）。
- **代数**：同一个 `hostId` 的新控制连接认证通过后挤掉旧的（旧的以 4409 关闭）；relay 给每条控制连接记一个代数，旧连接的关闭回调只清理自己那一代的东西，不碰新连接和它的流。每条流记在宣布它的那一代上：被挤掉的那一代的流以 4409 关掉手机（手机重连就到了新的那一代），数据连接只能接到当前这一代、还在等它的流，否则以 4404 关闭。
- **宿主不在线**：手机的连接以 4404 关闭，原因写 `offline:<上次在线的 Unix 秒>`。`hostId` 不存在的和从没上线过的一样写 `offline:0`；上次在线时间只在 relay 的内存里，relay 重启后也是 0。`host` 参数不是 `hst_<16hex>` 的以 4400 关闭。
- **接线**：relay 给新流分配 128 位随机的 `streamId`。宿主的数据连接到之前，手机发来的帧最多先存 8 帧、256 KiB，超了以 4507 关掉；10 秒内数据连接没来就以 4408 关掉手机。数据连接接上后，先按顺序转发存着的帧。任一端关闭，relay 关掉另一端（1000）；控制连接断了（不是被挤掉），这个宿主的所有流以 4404 `offline:<此刻>` 关掉手机。
- **帧**：手机和数据连接只能发二进制帧，发文本帧就以 4400 关掉这一对；控制连接只能发文本的 `refuse`，别的（二进制、不是 JSON、不认识的类型）以 4400 关闭。
- **上限**：
  - 没认证的连接（宿主两种入口还没发 `hello` 的）全局最多 64 条，多出来的接受后立刻以 4429 关闭；
  - 每个宿主同时最多 16 条流；同一个 IP 每分钟最多新建 30 条流（滑动的 60 秒，只算真的建起来的流；IP 怎么取、为什么在用户的部署里等于全局上限，见"部署 relay"第 3 条）；都以 4429 关掉手机；
  - 每帧最大 70 KiB（Noise 单条最大 65535 字节），超了 `ws` 以 1009 关掉发的那端，relay 再关掉另一端；
  - 每个方向积压（接收那端的 `bufferedAmount`）超过 4 MiB 就以 4507 关掉这一对连接；relay 所有缓冲（接线前存的帧加所有连接的积压）合计超过 256 MiB 时，新来的手机以 4507 关闭。
- **关闭码**（沿用 MP0 spike 定的，2026-10-25 MP2 写进这里）：

  | 码 | 含义 | 发给 |
  |---|---|---|
  | 4400 | 不合格：`host` 参数不对；手机或数据连接发了文本帧；控制连接发了二进制帧或不认识的消息 | 都可能 |
  | 4401 | 认证不过；或这个宿主被 `remove-host`、`rotate-host` 了 | 宿主两种连接 |
  | 4403 | 宿主回了 `refuse` | 手机 |
  | 4404 | 宿主不在线，原因 `offline:<秒>`（手机）；流不存在、已接上或不是当前这一代（数据连接） | 手机、数据连接 |
  | 4408 | 5 秒内没收到 `hello`；10 秒内数据连接没来 | 宿主两种连接、手机 |
  | 4409 | 被同一个 `hostId` 的新控制连接挤掉（控制连接，和那一代的手机） | 控制连接、手机 |
  | 4429 | 数量和速率：未认证的满 64、这个宿主的流满 16、这个 IP 一分钟内新建满 30 | 宿主两种连接、手机 |
  | 4507 | 字节：接线前的缓冲超了、某个方向积压超 4 MiB（关这一对）、缓冲合计超 256 MiB 时的新流 | 手机、数据连接 |
  | 1000 | 一对里的另一端关了 | 手机、数据连接 |
  | 1001 | relay 正在关闭（升级、重启） | 都可能 |
  | 1009 | 帧超过 70 KiB（`ws` 发） | 发帧的那端 |

  关闭原因只有 4404 的 `offline:<秒>` 带内容。手机只把这些码用来显示，不据此删掉配对（"撤销"）。
- **宿主自己也设限**，不依赖 relay（relay 可能被攻破）：同时最多 4 条还没握完手的流，握手 10 秒没完成就关；已认证的通道每台设备最多 2 条，新的挤掉旧的。
- **日志**：只记 `hostId`、`streamId`、IP 的加盐哈希（盐每次启动随机生成，不落盘）、字节数、关闭码和时长，不记载荷、`hello` 帧、令牌和查询串。`hostId` 只在符合 `hst_<16hex>` 时才记，免得把没认证的人随手发的字符串写进日志。每分钟记一次资源计数和内存。
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
- **实现**：MP0 比较后定为两边各自写（见 ADR-0016 第 5 条"MP0 的选择"）：TypeScript 用 `@noble/curves`、`@noble/ciphers`、`@noble/hashes`，Swift 用 CryptoKit，状态机两边各写一份，除了公开测试向量（cacophony 的 IK、IKpsk2），还要测畸形消息、低阶公钥、nonce 边界，并做模糊测试。新依赖精确锁定版本，登记进 security.md"外部边界登记"。

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
  - `relay: { url, hostId, status: off | connecting | connected | error, error, lastConnectedAt, diagnostics }`；
  - `hostFingerprint`（宿主公钥 SHA-256 的前 8 字节，分组显示）；
  - `devices: [{ deviceId, name, model: string | null, pairedAt, lastSeenAt, online, traffic: { down, up } }]`：`traffic` 是这台设备所有通道最近 2 秒的平均字节率（每秒），界面用它显示真实速率数值，不据此改变包的数量、疏密或速度；链路图按用户定稿的固定 3900ms 顺序循环播放（见 design-language“设置 · 手机”），离线设备不参与；仅流量数值变化引起的推送每秒最多一次；整个设置窗口打开时由 SettingsPanel 唯一拥有订阅，切换设置分类不另起订阅，不退回仅在"手机"页订阅。没有订阅的本机连接时不推。设备的颜色由界面按 `deviceId` 的哈希从一组固定色里取，不存；名字清空时恢复配对时手机报的 `deviceName`。
  - `pairing: { pairingId, qr, expiresAt, state, handshaking: boolean, request: { deviceName, model, sas } | null, refused: number } | null`，`refused` 是这次配对里因为已有手机在确认而被拒的次数，界面记一行"另一台手机也扫了这个码，已拒绝"。
- `set_remote({ enabled, relay?: string })`：`relay` 是那一行 `atrium-relay://…`；令牌只进不出，`remote_updated` 里不回传。
- `test_relay`、`start_pairing`、`cancel_pairing`、`confirm_pairing({ pairingId, accept })`、`rename_device({ deviceId, name })`、`revoke_device({ deviceId })`、`reset_remote_identity`。
- 新错误码：`local_only`、`remote_unavailable`、`pairing_expired`、`pairing_busy`、`device_not_found`、`relay_unreachable`、`relay_rejected`、`keychain_unavailable`、`vault_corrupt`、`response_too_large`、`request_conflict`、`outcome_unknown`。

#### 协议 27 的桌面接缝（2026-10-26，按已定稿设计补齐）

远程分支和 main 的回复翻译各自使用了协议 26，但形状不同；协调为 27，保留双方命令、偏好与错误，并重新生成 Swift 和夹具。手机白名单没有因此扩展：`translate_reply`、`cancel_translation` 明确只许本机调用；翻译没有独立新事件，偏好仍走既有 index 事件。

- **已配对型号**：`RemoteDevice.model` 只投影保险箱已有的自报型号，去掉两端空白后为空则 `null`；不是硬件认证，不从名字猜，不改保险箱格式。未通过确认落盘的候选不进入设备列表。
- **诊断快照**：`RemoteRelay.diagnostics` 初始为 `null`，表示没有已结束的检查；完成后含 `kind: connect | live`、注入 Clock 的 `checkedAt` 时间戳、`network/resolution/tls/token` 四项及 `failure`。每项为 `passed | failed | unknown | not_applicable`；`failure` 为 `resolution_failed | tcp_connect_failed | tls_failed | websocket_upgrade_failed | token_rejected | timeout | connection_closed | unknown | null`。只返回固定代码，不返回原始错误、令牌、证书文本或系统路径。重试时保留上次结束结果和时间；配置/代次变化清除，取消或旧代回调不得覆盖新结果。
- **诊断证据**：网络项只表示“到中继的 TCP 连接”，不代表系统能否上互联网。解析由 lookup 结果确认，TCP 由 connect 确认，TLS 只有通过正常证书校验的 secureConnect 才通过；不放宽校验。只有收到 relay 的 ready 才确认认可令牌，4401 表示拒绝。IP 字面量的解析、允许的 loopback ws 的 TLS 为不适用。Upgrade 失败单列，不能归成令牌错误；普通断开、ECONNRESET、总超时不能硬归因无网或某一步失败，缺证据的步骤保持未知。使用 ws 公开 finishRequest 时必须调用 request.end，并释放所有观测监听和定时器。
- **连接与活性分开**：connect 来自真实建连或临时 probe；live 来自已认证控制 socket 的本次匹配 pong。live 未重做解析、TLS 或令牌认证，这些项显示未知（本来不适用的仍为不适用），不能把旧认证当成刚刚重测。即使这次 live 检查期间收到真实 4401，仍是 `token: unknown`、`failure: token_rejected`：它记录连接被拒绝，不声称本次重做了令牌认证；后续真实 connect 收到 ready 才给出新的 `token: passed`。`test_relay` 仍成功回 `{}`、失败用原粗错误码，详细诊断只经本机状态/订阅提供。
- **握手活动**：`RemotePairing.handshaking` 与业务状态正交，按当前 pairingId、连接代次的候选集合派生。仅 available 时，通过当前配对、结构及版本检查的 IKpsk2 M1 之后、等待加密 key-confirm 的阶段为真；M1 尚不能证明持有 PSK，不显示候选身份、不标在线、不授予设备权限。多个候选中一个退出不误清另一个；失败、断开、确认、取消、过期、换码或关闭使相应投影清除，旧流不能复活新配对。保留四条未完成握手及十秒上限、不可续期的二维码期限；握手专属通知合并限频，终止清除立即发送，不人为延长动画。

#### MP3a 定的细节（2026-10-26）

写宿主时上文没说到、由 MP3a 定下的（可逆，用户不在时子代理定的，交付时列给用户）：

- **哪些存在保险箱、哪些不存**：保险箱里是宿主私钥、relay 那一行（地址、`hostId`、令牌）和设备列表（`deviceId`、公钥、手机报的名字和型号、你改的名字、配对时间）。"远程访问开着没有"和各设备的最后在线时间不是秘密，存在索引的 `remote.json`（domain-model §1"索引的存储"）。宿主在远程访问开着时才自动读保险箱，所以没用手机端的人不会被钥匙串弹窗打扰；被动的 `get_remote` 不触发读取。用户显式开启、填写 relay、测试连接或重置身份时也会读取，关着时的测试连接仍须先取凭据。
- **保险箱的状态**（`remote_updated` 的 `vault`）在 SPEC 原有的三种之外再加三种：`unread`（远程访问关着，还没读）、`waiting`（已经问主进程要了，在等钥匙串授权，界面显示"等待钥匙串授权"）、`unavailable`（宿主不在 Electron 里单独运行，没有保险箱）。宿主启动不等它：本机功能照常起来，读到了再连 relay。
- **进程交接的细节**：主进程把 `{ version, data }` 用 `safeStorage` 的异步接口（`encryptStringAsync` / `decryptStringAsync`，不阻塞主进程，等钥匙串授权时窗口照常能用）加密后写进 `vault.bin`；`vault_read` 的回答带上当前的 `version`（没有文件是 0、`data: null`）。主进程记着当前的 `version`，写入的 `version` 不比它大就拒绝（`error: "stale"`）；仅明确归为 `corrupt` 时当前 `version` 记为 0，好让用户确认的"重置"能写进去；暂时不可用或不认识的解密异常把当前版本留在/退回 `null`，后续写入必须重新读取，读取仍失败就不替换原文件。失败的 `error` 是 `keychain_unavailable`、`corrupt`、`stale`、`io` 之一，不带原文。主进程的写入也按到达顺序一个个来。
- **`get_remote({ watch? })`**：回当前的整份状态（和 `remote_updated` 的 `remote` 同形）；`watch: true` 之后这个连接收 `remote_updated`，直到 `watch: false` 或断开。业务状态、配对、relay 的既有通知路径保持不变；采样 timer 仅在可见设备的 `traffic.down/up` 数值确有变化时推整份，每秒最多一次，空闲或稳定速率不重复推送。可见包括仍在列表中的离线设备，继续按两秒窗口衰减到零；已撤销/隐藏设备的遗留计数变化不触发推送。首次 `get_remote` 始终返回完整当前状态，多个 watcher 共用采样窗口与 timer；最后一个 watcher 离开才清除采样 timer、计数和历史，恢复订阅从新窗口开始。订阅期间不另增空闲暂停采样机制；没有连接订阅时不算流量、不起定时器。`remote_updated` 只推给订阅的本机连接。
- **配对的结果留着**：配对结束（`committed`、`rejected`、`expired`）后，`pairing` 保持最后的状态，到下一次 `start_pairing` 或 `cancel_pairing` 才清成 `null`，界面能显示"配对成功"或原因。`pairing` 多一个 `reason`：`cancelled`（取消、出新码）、`declined`（在 Mac 上拒绝）、`timeout`（2 分钟没确认）、`disconnected`（确认前通道断开）、`vault_failed`（写保险箱失败），没结束或成功时是 `null`。这里的本机状态投影 `declined` 不等于通道里的原因：Mac 拒绝时手机收到的既有控制消息是 `{ kind: "pair_rejected", reason: "rejected" }`（与 MP0 FakeHost 一致）；不把线上 `rejected` 改成 `declined`。
- **保险箱解密失败的保守分类（Electron 44.5.1）**：`isAsyncEncryptionAvailable()` 返回 true 不代表钥匙串提供者此刻可用。先区分 decrypt Promise 拒绝与成功解密后的格式校验：只有确切消息 `Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.` 的 Error，以及成功解密后格式无效，归为既有 `corrupt`。它表示数据损坏/密钥不匹配等造成的“无法读取”，不是确定物理损坏。`safeStorage.decryptStringAsync is temporarily unavailable. Please try again.` 以及其他未知拒绝都归为 `keychain_unavailable`，不降版本、不探测额外加密、不外传或记录错误原文。固定 Electron 版本与原生消息的关联有测试；升级时必须重新核对原生实现。此结论来自精确版本源码，假 crypto 回归不等于平台实测，也未证明一次授权拒绝实际覆盖过文件；不新增线上字段、备份或重置意图协议。
- **确认之后不再打断**：点了确认、正在写保险箱时，取消、断开和超时都不再改配对，等写入的结果定成 `committed` 或 `rejected`（`vault_failed`）。写完时通道已经断了，`paired` 送不到，按上文第 6 步由日常连接补上。有手机在等确认（或正在写）时再点"配对新设备"，应答 `pairing_busy`。
- **5 分钟过期只管 `available`**：手机已经进了 `awaiting_confirmation`，就按 2 分钟的确认时限算。握手第一条到时已过期，第二条回 `pairing_expired`；`pair_confirm` 到时已过期，回 `pair_rejected` 的 `pairing_expired`（不算进 `refused`），已被占用回 `pairing_busy`（算进 `refused`）。
- **命令的结果**：`get_remote` 回状态；`start_pairing` 回 `{ pairingId }`；其余回 `{}`，变化经 `remote_updated` 到达（先推事件再回应答）。远程访问关着、保险箱不是 `ok` 或没填 relay 时，`start_pairing` 应答 `remote_unavailable`；保险箱 `keychain_unavailable`、`corrupt` 时要写保险箱的命令应答 `keychain_unavailable`、`vault_corrupt`（`reset_remote_identity` 除外，它就是用来从损坏里出来的）。`confirm_pairing` 的 `pairingId` 不是当前这次、或不在等确认，应答 `pairing_expired`。
- **`rename_device`**：名字最长 64 个字符，空的恢复成手机报的名字；写进保险箱。
- **撤销失败后重试**：写保险箱失败时设备留在内存的列表里、被拉黑，不显示、也连不上；再发一次 `revoke_device` 就是重试写入。本次运行已经撤销过的 id 也接受幂等的再次撤销，使后来的撤销能压过正在排队、可能重新写回该 id 的配对确认；从未存在的 id 仍应答 `device_not_found`。同一台手机（按公钥）重新配对成功，拉黑解除、沿用原来的 `deviceId`。
- **`reset_remote_identity`**：先写新的保险箱（新密钥对、空设备列表、已能读取的 relay 那一行不变），写成了才换上，再经每条通道发 `revoked` 并关闭；写失败什么都不变。损坏到无法读取时不能恢复 relay 凭据，重置后须重新填写，不从损坏内容里猜。成功重置也使旧二维码和排在重置之后的旧配对确认失效，不能再把旧手机写回新身份。
- **`test_relay`**：远程访问开着但断线时立刻重连控制连接（退避清零），等到 `ready` 或失败；已经连上时在原控制连接发带本次独有非秘密 payload 的 ping，只接受同 socket、同 payload 的 pong；空、错、旧或常规心跳的 pong 不消耗监听，写入回调不算成功；并发测试共享本次探测，关闭、停服和超时都释放等待、监听与定时器；这只承诺控制链路此刻可达，不承诺手机或 pi 已可用，不为测试挤掉已连接的手机，也不直接返回缓存成功；关着时另开一条临时的控制连接，收到 `ready` 就关。成功回 `{}`，连不上应答 `relay_unreachable`，认证不过（4401）应答 `relay_rejected`，10 秒为限。已认证控制连接上的单次匹配 pong 超时，只结算这次失败和 live 诊断，释放探测自己的监听/定时器，不 terminate 控制连接、不把探测失败置成控制生命周期 error、不关闭手机数据流；下次检查仍发新 payload。relay 真正 close/4401、宿主 stop、常规心跳独立判死仍照原生命周期断链。
- **relay 地址的协议**：那一行里的主机是 `127.0.0.1`、`localhost` 或 `[::1]` 时用 `ws://`（本机测试），其余一律 `wss://`。
- **控制连接的存活**：宿主每 30 秒对控制连接发一次 WebSocket ping，上一次的没回应就断开重连（relay 自己也 20 秒 ping 一次宿主）。数据连接靠通道心跳。
- **客户端传输**：`ClientTransport` 的 `checkAlive()` 在上一次探测没回应时自己断开对方并返回 `false`（本机是 `terminate()`，远程是关掉通道和数据连接），否则发一次探测返回 `true`；服务器每 `heartbeatMs` 调一次。远程的探测是通道心跳，30 秒没收到手机的任何东西才算没回应。已完成密钥确认、还在等 Mac 确认的通道尚未交给服务器，由远程服务每 15 秒探测；配对成功时取消这个定时器，交给服务器统一探测，不重复计时。远程数据 socket 主动结束后最多再等 1 秒即强制关闭；已经收到对端 WebSocket Close、但 TCP 半关闭未结束的 `CLOSING` 状态也受这个期限约束，不能让 relay 拖住宿主关闭。
- **超上限的快照**：会话事件超过 8 MiB 改发快照，快照本身也超时（MP4 加快照预算之前可能发生），丢掉这条并记一条 warn，手机会因为 `seq` 跳号自己重新订阅。
- **流量**：`traffic.down` 是宿主发往手机的、`up` 是手机发来的，按已认出设备的数据连接上的密文字节算（含帧类型及认证标签）。开始观看的首秒按已经观测的一秒计算，之后是两秒窗口；关闭通道后窗口里的历史流量仍保留到自然归零。

#### MP4a 定的细节（2026-10-27）

MP4 拆成三片，各自验收：**MP4a** 只读同步（列表、打开会话、实时追加、"已连接"的判断），**MP4b** 发消息与回执（"发送中"、"没发出去"、"结果不确定"一起交付），**MP4c** 续传与恢复（事件环、`session_resumed`、冷启动缓存、故障代理、真机、三方审查）。用户 2026-10-27 定：协议**一次升到 28**，下文"协议改动"第 2～4 条的字段都在 MP4a 定下；MP4a 的宿主只实现快照预算和 `maxBytes`，收到 `resume` 按第 3 条的"否则"照旧发快照，MP4c 再实现事件环。

**协议 28 的确切形状**：

- `subscribe_sessions` 加可选的 `snapshot: { turns: 1–20, bytes: 65536–4194304 }` 和 `resume: [{ sessionId, stream, epoch, seq }]`（最多 64 项）。不在 `sessionIds` 里的 `resume` 项忽略。
- `session_snapshot` 加必填的 `stream`（1～128 个字符的不透明字符串）。每个会话控制器建起来时取一个新的随机值；没有控制器的草稿快照每次现取一个，草稿之后没有事件，`stream` 对不上只会回到发快照。
- 新事件 `session_resumed { sessionId, epoch, seq }`，属于会话事件、推给手机。桌面不发 `resume`，宿主也不会给它发这条；桌面客户端收到时，`epoch` 和 `seq` 都等于手上的就当没变，否则重新订阅（同"事件接不上"）。
- `fetch_transcript` 加可选的 `maxBytes: 65536–4194304`，和条数一起限，至少一条。
- 回执不加字段：`requestId` 照旧，`request_conflict`、`outcome_unknown` 两个错误码 27 里已有。

**宿主的快照预算**：

- 预算记在连接上，每次 `subscribe_sessions` 都重设：带了 `snapshot` 用它，没带回到默认（20 轮、4 MiB）。它管三处：订阅时发的快照、换 `epoch` 时重发给这个连接的快照、事件超过 8 MiB 时改发的快照（"Noise 通道 · 大小"）。
- 字节和 `PAGE_BYTES` 一样，只算各条记录编码后的字节，不算 `control` 等其余字段；轮数和"快照与分页"一样，数到一轮为止。超了也至少带一条。
- 预算不会超过默认值，所以按预算截出来的，就是默认快照末尾的一段；`hasOlder` 在默认快照本来有更早的、或者截掉了几条时为真。手机拿到的快照因此和桌面看到的同一份状态一致，只是更短。

**App 的初始同步**（每一代连接各做一次，代指 `RemoteConnection` 的 `generation`）：

1. 通道建好、状态是"正在同步"时，先发 `subscribe_index`，不带 `cursor`（MP4a 每代都拿整份列表；带游标续上留给 MP4c）。
2. 再发 `subscribe_sessions`：`sessionIds` 是此刻打开着的会话页（MP4a 最多一个），预算 6 轮、512 KiB；随后对每个打开着的会话发 `open_session`。宿主只在会话的 pi 起来后发快照，没有 `open_session`，一个 pi 没在跑的会话永远等不到快照。手机的 `clientId` 是 `deviceId`，`open_session` 改的是手机自己的布局，不动桌面的标签。
3. **同步完成**：本代的 `subscribe_index` 应答成功并收到本代的 `index_snapshot`；每个打开着的会话要么收到本代的快照（MP4c 起也可以是 `session_resumed`），要么它的 `open_session` 或 `subscribe_sessions` 失败了（会话页显示错误，不拦住"已连接"）。满足后调 `markSynced(generation)`，状态才变成"已连接"。列表的订阅失败不算完成，停在"正在同步"。
4. **旧代隔离**：新的一代开始时，旧代还没回的请求全部作废；带旧 `generation` 的消息、`requestId` 不认识的应答都丢掉；发送时连接已换代（`.closed`）就不再管。已经显示的列表和会话内容先留着，等新快照整体替换。
5. **回到前台**：同一代连接在前台探测时也会回到"正在同步"（`RemoteConnection` 不会自己转回"已连接"）。这时在同一条连接上从头再同步一次：重新订阅列表，会话先从订阅里去掉再加回，拿新快照，满足第 3 条后再 `markSynced`；探测失败换了新的一代，就按第 4 条作废。MP4c 改为按游标补齐。
6. 已连接后再打开一个会话：它自己显示"正在加载"，等快照，不把整体状态拉回"正在同步"。会话事件接不上（不是下一条）时，和桌面一样先从订阅里去掉再加回来，拿新快照。
7. **审查后补（2026-10-27，gpt-6-astra 单路只读审查）**：
   - 同步由"通道打开"触发（`RemoteConnection.openings`），不看状态文字。回到前台时新连接还在握手就已显示"正在同步"，按状态触发会把订阅发进还没建好的通道丢掉，之后再也不同步。"正在同步"只在当前已有打开的通道时才触发同一条连接重新同步。
   - 离开会话页时发 `close_tab` 放掉手机的标签，不然这个会话一直留在手机的布局里，Mac 回收不了它的控制器。这个页面还在路上的请求不再作数，迟到的失败应答不会落到重新打开的同一个页面上。
   - 交给终端的会话（`handedOff`）Mac 不会为它起 pi，等不到快照，算作"已同步"，页面写"这个会话交给终端里的 pi 了"；之后若有快照就照常替换。
8. MP4a 已知的限制：列表快照超过 8 MiB 会被宿主丢掉，手机停在"正在同步"（MP4c 前不处理）；会话页不往前翻页，`hasOlder` 只显示一行"更早的在 Mac 上看"。

**界面（MP4a 只做简单的行，完整视觉在 MP6）**：

- 首页：衬线标题、连接胶囊（文字同现在的连接状态）；"等你处理"一组（挑选和排序同桌面收件箱 `inboxOf`：未归档，`asking` 不为空是"在问你"，否则没看过的 `attention` 是"出错"，要登录的也写"出错"；第二行"状态 · 项目 · 工作区"）；下面按项目、工作区分组列会话（不含已归档和子对话，标题取 `name`，没有就取 `prompt`，再没有是"新会话"；运行中写"运行中"）；最后"对话"一组。点一行打开会话页。
- 会话页：标题；用户消息是气泡；回复的文字照原文显示（不渲染 Markdown）；其余步骤每个一行，只写类型和名字；通知一行灰字。实时追加。MP4a 没有输入框。

#### MP4b 定的细节（2026-10-27）

用户不在时代定、可逆，交付时列给用户。在 `atrium/mp4-sync` 上接着 MP4a 做。

**宿主的回执**（`packages/host/src/remote/receipts.ts`）：

- 只管远程连接的 `prompt`、`steer`，在路由器里包在执行外面；桌面不经过。键是 `(deviceId, requestId)`，内容哈希是 `sha256(JSON[类型, sessionId, text, 附件个数])`。
- 一条回执有三种状态：`processing`（执行前先写盘，写完才执行）、`done`（记下应答：成功的 `result`，或失败的错误码和参数）、`unknown`（宿主重启时还在 `processing` 的，或执行时抛了不是 `CommandError` 的异常）。
- 同键再来：正在执行的接到同一次执行上（按正在执行的记录判断，不受下面 200 条上限挤掉的影响，内容不同照样回 `request_conflict`）；`done` 且内容相同，回原应答，不执行；内容不同回 `request_conflict`；`unknown` 回 `outcome_unknown`。都不执行。
- 执行时抛了不是 `CommandError` 的异常：记 error 日志，这一次就应答 `outcome_unknown`（它可能已经执行了一部分），不回 `internal_error`。
- 写 `processing` 失败就不执行，应答 `internal_error`，手机按"明确失败"处理；`done` 写盘失败只记 warn，应答照发。重启后它会变成 `unknown`，宁可不确定也不重发。
- 存储复用索引文件的做法（`loadIndexFile`：带版本、临时文件加改名、坏了挪开重来），放在 `<ATRIUM_HOME>/remote/receipts.json`。每台设备最多 200 条，超了先丢最早的；24 小时过期，读入和每次写入时清。
- 撤销设备不立刻删它的回执，等 24 小时过期；被撤销的设备连不上，留着不会被用。

**App 的发送**（`AtriumSync` 的 `SyncCore` 加发件状态，界面在会话页底部）：

- 会话页底部一行输入框和发送按钮。整体"已连接"、这个会话已同步、这个会话没有"发送中"或"不确定"的消息时才能发；断开时占位换成"先写着，连上后再发"。草稿 MP4b 只存在内存里，持久化留给 MP4c 的缓存。
- 发一条就生成随机 UUID 当 `requestId`（同时是 `clientMessageId`），先显示成"发送中"的气泡。
  - 发送时连接已断（没写进通道）：标"没发出去"，气泡收掉，文字退回输入框。
  - 宿主回失败：同样退回输入框，下面写"没发出去（错误码）"。
  - 回成功：等对话记录里出现这个 `clientMessageId` 的轮次再收掉气泡；`handled`、`queued` 直接收掉（排队的界面在 MP5）。
- 写出去了、还没应答就断了：新一代同步完成后，先在快照里找这个 `clientMessageId`，找到就算送到。找不到、发出不到 10 分钟、还没自动重试过的，用同一个 `requestId` 重试一次；否则标"不确定"。
  - 重试回 `outcome_unknown` 时也先找对话记录，找不到就标"不确定"。
  - "不确定"的气泡下面写"没能确认是否送到 · 重发"，点了用新的 `requestId` 发同一段文字。
- MP4b 的 App 只发 `prompt`，`steer`（插话）、图片和排队界面在 MP5。时间用注入的时钟。
- 三方审查后补（2026-10-27）：
  - 能发还要求这个会话不在续传中（续传完以前显示的是旧内容）。
  - 自动重试那一次没能写进通道时，第一次可能已经执行了，标"不确定"，不退回输入框。
  - 离开会话页不丢未落定的消息：照常等应答、重试，重新打开时还显示，并继续挡住下一条。

#### MP4c 定的细节（2026-10-27）

用户不在时代定、可逆，交付时列给用户。

**宿主的事件环**（`packages/host/src/sync/event-ring.ts`）：

- 只为有手机订阅的会话留，由订阅注册表在发布事件时顺手记下。手机连接在注册时标明 `remote`。
- 每个会话的环记着 `stream`、`epoch` 和最近连续的事件：最多 512 条、1 MiB（按编码后的字节）。超了从最早的丢；全宿主合计 32 MiB，超了先丢最久没用的会话的环。
- 没有手机订阅满 10 分钟就丢（注入的时钟）；控制器回收时一起丢。环的个数计入资源报告（`sync.ring`）。
- 会话发出快照（订阅时的，或换 epoch 时发布的）就从这个快照的 `stream`、`epoch`、`seq` 重新开始记；事件接不上（`epoch` 不同或 `seq` 跳号）就清空，等下一个快照。
- 订阅时续传：在同一次同步调用里判断、补发、登记。环的 `stream`、`epoch` 和手机给的相同，并且环覆盖 `seq + 1` 到最新，就依次补发这些事件，再发 `session_resumed`；`seq` 已是最新只发 `session_resumed`。否则照旧发快照（受预算）。补发的事件同样受手机的 8 MiB 单条上限，超了按原规则改发快照。

**App 的续传**：

- 新一代同步时，已有快照的打开会话带上 `resume`（`stream`、`epoch`、`seq`），状态不改回"正在加载"，内容留着，接着收事件；收到 `session_resumed` 或新快照才算这个会话同步完了。
- 列表带上游标（`generation`、`seq`）订阅；宿主能接上就立刻回一批（可能是空的）`index_changes`，这批或者一份快照到了，列表才算同步完了。
- 回到前台时同一条连接也按这个规则走。宿主只给新加入订阅的会话发快照或续传，所以仍要先从订阅里去掉再加回，加回时带上 `resume`。
- 三方审查后补（2026-10-27）：
  - 续传中的会话被宿主拒绝打开（例如在 Mac 上删掉了），或者在列表里显示已交给终端，同样算同步完了，不会一直"正在同步"。
  - 续传中收到 `seq` 不超过自己位置的事件（回到前台时通道里还没读完的旧事件），当作已有的忽略，不触发重新同步。

**冷启动缓存**（`AtriumSync` 的 `SyncCache`，iOS 上落在 Application Support）：

- 按 `hostId` 和缓存格式版本分目录：`index.json`（列表和它的游标）、`sessions/<id>.json`（会话的快照内容和它的 `stream`、`epoch`、`seq`）、`drafts.json`（各会话的输入框）。都是写临时文件再改名，所以读出来的游标一定对应读出来的内容。
- iOS 上用 `completeFileProtection`，目录标 `isExcludedFromBackup`。
- 什么时候写：列表变了、打开的会话变了（节流 1 秒，进后台时立刻写一次），草稿每次改动都写（打字、发出后清空、没发出去退回输入框都算）；`SyncModel` 停止运行时取消还在等的节流写入。
- 启动时先读缓存，首页和会话页上方标"不是最新"，直到这一代同步完成；之后按上面的续传规则补齐。
- 收到经认证的撤销，或者这台主机的记录被删掉，就删掉它的整个缓存目录；此后这个连接不再写缓存（离开页面、进后台、改草稿都不写），节流中的写也取消。只缓存打开过的会话，最多 20 个，超了删最久没打开的。

**故障与真机**：

- 契约夹具在 Swift 和 relay 之间放一个本机代理，能暂停转发、恢复、掐断全部连接。契约覆盖两件事：掐断后重连能续上（收到 `session_resumed` 而不是快照，中间的事件不丢不重）；消息发出、应答回来之前掐断，重连后用同一 `requestId` 重试，宿主只跑一次。
- 真机走通"配对 → 列表 → 打开 → 发一条 → 断网再连上"要用户的 iPhone 和 relay，放进验收步骤，由用户操作。

### 协议改动（协议版本 +1）

2026-10-27：第 2～4 条的字段在协议 28 一次定下，MP4a 只实现预算，见上文"MP4a 定的细节"。

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
  | `AtriumRender` | 流式 Markdown、代码高亮、diff。时间线倾向用 `List`（行高真实测量、cell 复用、`scrollTo` 对未实例化的行可靠），每行 `.equatable()`，滚动分"初始定位 / 跟随尾部 / 阅读历史"三态；MP5 用真机性能数据和 `LazyVStack` 对比后定 |
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
- relay 只记元数据，日志按 UTC 日期一天一个文件、留 14 天（"relay 的线路协议 · 日志"）。

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

1. **钥匙串授权会反复弹**：本机打包只做 ad-hoc 签名，每次重新打包签名都变，macOS 会再问一次"允许 Atrium 访问钥匙串"。`pnpm dev` 和打包版签名不同，各弹各的。MP0 实测（2026-10-25，`spikes/mobile-mp0/safestorage/`，打包的 `AtriumSpike.app`）：签名不变时不弹，一次读写交接 67–94 ms；重新打包后弹授权，读保险箱一直等到用户点允许（这次 6.6 秒）。所以宿主启动不能等保险箱：本机功能照常起来，远程访问显示"等待钥匙串授权"，授权后再连 relay。写进验收步骤。
2. **免费账号 7 天到期**：App 打不开前要重装。2026-10-26 真机实测：覆盖安装（同 bundle id、同签名团队）后钥匙串里的配对还在，不用重新扫码（`spikes/mobile-mp0/README.md`"真机"）。中国大陆的 iPhone 第一次联网要允许"使用无线数据"，之前所有连接都失败，界面要能说清"连不出去"。是否改用 SideStore 自动续签，用户自用一段时间后再定。
3. **Noise 两份实现**：原语成熟不等于组合起来对。先做互通实验、优先用现成实现；自己写就加畸形输入和模糊测试。
4. **Swift 侧跟不上协议**：靠生成类型、往返测试和契约测试守住。桌面的验收清单加一条"手机端是否要跟"。
5. **流式渲染的性能**：长回复和大代码块在旧 iPhone 上可能掉帧。MP5 做性能预算（同桌面：主线程没有超过 50 毫秒的卡顿）。
6. **relay 是单点**：VPS 挂了手机就用不了。第一版接受，`/healthz` 交给用户自己的监控。
7. **没有推送**：手机在口袋里时什么都收不到，这是"先不做推送"的已知代价。
8. **relay 拿不到真实 IP**（用户的部署，2026-10-25 MP2 记）：经 xray 回落后来源都是 `127.0.0.1`，按 IP 的限速退化成全局的，日志里的 IP 哈希也都一样（"部署 relay"第 3 条）。一个人用可以接受；要区分来源时再接 PROXY protocol。

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
- **relay**：用真实的 `ws` 起 relay、假宿主、假手机，覆盖认证、新控制连接挤掉旧的（旧连接的清理不碰新的）、宿主离线、接线超时、各项上限、读得慢、日志里没有秘密；另有路径前缀、信任的反代和真实 IP、`rotate-host` / `remove-host` 立刻踢掉在线的连接、命令行只打印一次令牌、日志按天轮转；泄漏测试（连接、定时器回到基线）。镜像在本机 `docker run` 起来，经 nginx 的示例片段用 MP0 的假宿主、假手机走一遍配对和 IK 重连。
- **宿主**：
  - 起真实的 relay 进程，用 TS 假手机走完配对：正常、过期、取消、拒绝、2 分钟没确认、确认前断开、两台手机同时扫、写保险箱失败、`paired` 没送到后用日常连接补上；
  - 日常连接：未知设备、版本不一致、`clientId` 不等于 `deviceId`、撤销时马上断开（包括这台设备已经打开的所有通道和订阅）、写保险箱失败时内存拉黑仍生效；
  - 续传：环内、环外、`stream` 或 `epoch` 变了、`seq` 已经最新、补发期间有新事件、宿主重启后 App 带着旧游标来（必须拿到快照，不能静默漏事件）、重连后还没回答的提问和对话框随快照带全；
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

### MP4 审查后补：手机记录写入所有权与失败恢复（2026-10-26）

- App 组装一个进程内共享 `HostStore`，所有配对页面、连接和恢复任务注入同一个写入权威。host 和 pending 各有仅内存的写入代次；每次写入都换代，即使内容相同。claim 核对与必要同步钥匙串操作在同一短临界区完成，不跨 await、不调用 UI 回调；钥匙串调用不占 MainActor，首次设备密钥生成也受同一保护。
- 配对开始取得原 host/pending 的版本 claim。旧成功确认、拒绝清理及存储重试必须核对各自原始版本；新配对使旧任务失权后，旧任务以 superseded 收尾，不覆盖新记录、删除新 pending 或发布过期成功。新 pending 的确认也依赖其原 host 版本，所以旧清理在任一版本变化后整体失权，不能只保住 pending 却删除其原 host、让新确认失败；清理自身部分成功则更新剩余操作的 claim。不改变持久记录格式。
- 用户取消、连接中断、本地超时都不能证明 Mac 没有保存设备；保留 pending，供下一次明确连接或冷启动用 IK 确认，不因取消擅自自动重连。冷启动选中某主机时，它的新 pending 优先于同主机旧正式记录，不因此切换到另一台主机。经 Noise 认证的 `device_unknown` 仍清理对应 pending。
- 经认证的撤销立即关闭通道并停止网络重试；若本地删除失败，连接事实仍为撤销，另以最新状态 `storageIssue` 暴露保存/清理失败，界面只显示通用原因和重试，不展示秘密或原始 NSError。记录仅当前未完成操作及原始版本；显式重试和后台回前台各尝试一次，不设存储重试定时器或持久队列。host/pending 部分删除成功后只重试剩余项；新配对替代的项不再删除或反复提示错误。共享 device-key 不删除。
- pending 补确认写失败时可继续当前同步，但保存问题持续可见，直到受控重试成功或被新配对取代。内存 claim 不跨进程保存撤销：未删掉的记录在重启后可能再次读到，之后的认证拒绝必须重新清理，不能声称本地已持久删除。

### MP4 审查后补：客户端累计缓冲预算（2026-10-26）

- SecureChannel 待发送密文累计最多 2 MiB，包括 writer 已取出、但 send 尚未完成的帧；只有实际写入完成、失败或取消才释放该帧占用。
- RemoteConnection 尚未由消费者取走的消息同时受 16 MiB payload 和 1024 条消息限制；条数是私有实现常量，不是新增可配置配额。空消息合法且 payload 为 0，但仍占一个消息名额，不能用零字节绕过累计内存保护。仅在消费者 next 取出时归还字节和条数，清理旧代同样只归还它自己的占用。正常 8 MiB 消息及两条最大消息仍可完整通过；任一限额溢出都按同一背压路径关闭。
- 这是可逆的客户端本地缓冲预算，不是 Noise 单消息大小或新协议字段，也不是整个 App 总内存上限。超预算明确报背压错误、关闭当前代并释放旧队列，按正常断线重新同步；不通过丢帧/丢消息腾位置，不自动重发命令，不引入离线发件箱。排入队列不等于宿主已接受，发送回执语义仍按本规格处理。
