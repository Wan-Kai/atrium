# ADR-0016：手机经自建 relay 连回宿主，用 Noise 端到端加密

- **状态**：已接受
- **日期**：2026-10-24
- **相关**：取代 [ADR-0005](0005-split-host-and-ui-pwa-first.md) 第 3 条里"远程访问借助 Tailscale、不自建 relay"；[ADR-0015](0015-native-ios-app-in-swiftui.md)；[mobile-remote.md](../research/mobile-remote.md)；[security.md](../architecture/security.md)

## 背景

手机在外面（蜂窝网络、公司网络）时连不到家里 Mac 上的宿主：Mac 在路由器后面，没有公网地址。ADR-0005 原定用 Tailscale，但它要求手机先装、先登录，而且 iOS 同一时间只能开一个 VPN，会和公司 VPN 冲突。

各家的做法（mobile-remote.md §1）：

- Codex、Claude Code 让本机主动出站连自家的中继，中继看得到明文；
- Paseo、Happy 的中继只转发密文；
- OpenCode 的 OpenTunnel 在本机终止 TLS。

security.md 的底线是凭据和对话内容不外泄，所以中继不能看到内容。

用户定的（2026-10-24）：

- 走中继加端到端加密；
- 中继部署在用户自己的 VPS 上，用 TypeScript 写；
- 先不做推送。

## 决策

1. **宿主主动出站连 relay，不开入站端口**。宿主仍只监听 `127.0.0.1`（security.md）；远程访问在设置里显式打开，关着时不连 relay。
2. **relay 是用户自己 VPS 上的 TypeScript 服务**，放在 `apps/relay`（Node + `ws`），前面由 Caddy 签证书、终止外层 TLS。
3. **relay 只转发，看不到内容**：
   - 每个宿主一条控制连接，只用来通知"有手机来了"；每台手机连上来，宿主再开一条数据连接，relay 把它和手机的连接一对一接起来、原样转发字节（2026-10-24 审查后定，不在一条连接里多路复用，免得一台读得慢的手机堵住别的）。
   - relay 只看得到 IP、时间、大小、宿主 id 和握手里的公钥。
   - 宿主连 relay 时，用部署 relay 时生成的密钥证明自己，别人拿到宿主 id 也挤不掉它（Paseo #367 的教训）。
   - relay 有连接数、帧大小和速率上限。
4. **端到端加密用 Noise IK**（`Noise_IK_25519_ChaChaPoly_SHA256`），宿主和每台手机各有一对长期的 X25519 密钥：
   - **配对**：
     - 桌面显示二维码，里面是 relay 地址、宿主 id、宿主公钥，和一个一次性的配对密钥（5 分钟过期、只能用一次）。
     - 手机第一次连接用 `IKpsk2`，配对密钥作为 PSK。PSK 在第二条握手消息才混入，所以手机握手后要再发一条加密的确认消息，宿主解开它才认定"这是扫了码的那台手机"，记下它的公钥和名字，再请你在 Mac 上核对校验码、确认。同一时刻只接受一台手机。
   - **之后**：用 `IK`，宿主只接受已登记设备的公钥。
   - **撤销**：在设置里列出已配对的设备，可以单独撤销。撤销后马上断开它，它下次握手被拒绝。
   - **不用 Paseo 的 NK**：NK 里手机是匿名的，分不清设备、撤销不了（mobile-remote.md §3）。
5. **加密的实现不自己发明**：
   - TypeScript 用 `@noble/*` 的原语，Swift 用 CryptoKit 的原语；
   - Noise 握手状态机两边都跑公开的 Noise 测试向量，另有 TypeScript ↔ Swift 的互通测试；
   - 每条消息带递增 nonce，重放、乱序就断开；
   - 超过 Noise 单条上限（65535 字节）的消息分块。
   - **MP0 的选择**（2026-10-25，`spikes/mobile-mp0/`）：两边都自己写只含 IK、IKpsk2 的状态机。TypeScript 用 `@noble/curves`、`@noble/ciphers`、`@noble/hashes` 2.4.0（Cure53 审计）：现成的 JS 实现要么哈希写死 BLAKE2b、要么不支持 PSK、要么依赖原生模块，而 Electron 44 内嵌的 Node 24.21.0 用 BoringSSL，没有 ChaCha20-Poly1305，只能用纯 JS。Swift 用 CryptoKit：现成实现里最好的 Torann 0.3.1 刚建库、单作者、未审计，只在测试 target 里精确锁定，做差分和模糊测试的对照。两边都过了 cacophony 的 IK、IKpsk2 向量，互相逐字节回放对方的确定性记录，Swift 还和 Torann 做了 100 次随机加 300 次变异的差分。实测发现：noble 和 CryptoKit 都在 DH 之前就拒绝低阶点（显式的全零检查是冗余防线）；CryptoKit 返回的 `Data` 是带偏移的切片，要在边界上重新起底；Swift 没法可靠擦除密钥。
6. **通道里跑的仍是现有的 Atrium 协议**：消息格式不变，只是换了传输方式。经 Noise 认证过的设备算已鉴权的客户端，不再用每次启动随机的 token，也不看 `Origin`。设备以自己的 `clientId` 连接，标签布局等按它分开存（现有做法）。
7. **密钥存放**：
   - 手机的私钥放 iOS 钥匙串，只允许本机读取（`ThisDeviceOnly`）；
   - 宿主的长期私钥、relay 令牌和已登记设备的列表放在 macOS 钥匙串保护的"保险箱"里（用户定，2026-10-24）：Electron 主进程用 `safeStorage` 加密后写到 `~/.atrium/remote/vault.bin`，加密用的密钥在钥匙串里，主进程启动宿主时经现有的进程端口交给它（同 token）；钥匙串不可用时远程访问不可用，不退回明文。细节见 [SPEC-0005](../specs/0005-mobile-app-and-remote-access.md)。
8. **推送以后再做**：等有了付费开发者账号，由 relay 调 APNs。正文在宿主上用设备的密钥加密，App 的通知扩展在本机解密，relay 和 Apple 只看到密文。不学 Paseo、Happy 把明文交给 Expo。
9. **第一版只走 relay**：在家时局域网直连更快，以后再加，加的时候同样走 Noise。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| Tailscale 加宿主监听 tailnet 地址（ADR-0005 原定） | 不用写也不用运营中继；WireGuard 本身加密 | 手机要装 Tailscale，和公司 VPN 冲突；tailnet 不能当鉴权，设备配对仍要自己做 |
| 厂商式明文中继（Codex、Claude Code） | 实现最简单 | 对话内容经过中继，违背 security.md |
| 盲 TLS 隧道（OpenTunnel） | 宿主的 HTTP / WebSocket 不用改 | 每台宿主要子域名和证书，控制 DNS 的一方能签证书；设备身份仍要另做；原生 App 用不上它的好处 |
| Noise NK，手机匿名（Paseo） | 握手简单 | 分不清设备，撤销不了，配对链接就是永久的全部权限 |
| WebRTC 点对点加中继兜底（Vibe Kanban） | 能直连时不经过中继 | 打洞、TURN、DTLS 复杂，自用阶段不值得 |
| 自建 relay 加 Noise IK（采用） | 中继看不到内容；设备有身份、能撤销；手机扫码就能用；relay 只做转发，很小 | 要运营一台 VPS；要在两种语言里各实现一遍握手并保持互通；relay 挂了手机就连不上 |

## 后果

- **正面**：
  - 手机在哪都能用，不依赖 VPN；
  - relay 被攻破也看不到对话和凭据；
  - 设备能单独撤销；
  - 以后加推送、局域网直连只是多一条路，协议不变。
- **负面 / 代价**：
  - 多运营一个服务：要部署、更新、看日志。relay 挂了手机就用不了，第一版没有备用路。
  - 宿主多一条常驻的出站连接，要重连、心跳，还要算进资源计数和泄漏测试。
  - 宿主多出长期密钥和设备登记两份秘密数据，security.md 要补对应的规则和威胁模型（丢了手机、VPS 被攻破、配对二维码被拍到）。
  - 加密实现两份，要靠测试向量和互通测试守住。
- **什么情况下应重新评估**：
  - 要给别人用、提供官方 relay 时：要考虑运营成本、滥用，以及多用户怎么隔离；
  - relay 的延迟或可用性成为实际问题时：先加局域网直连，再考虑点对点；
  - 有了推送需求和付费账号时：按第 8 条实现。
