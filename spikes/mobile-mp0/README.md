# MP0 互通实验

路线图"手机端 · MP0"的一次性实验代码，验证 SPEC-0005 的加密和连接方案。结论写回 SPEC-0005 和 ADR-0016；能复用的部分在 MP1 以后挪进正式位置，这里的代码不进产品。`spikes/**` 不做代码检查和 knip，只做格式化。

（这份是 Swift 侧的部分，和 TS 侧的同名文件合并时把下表的行并进去。）

| 目录                                                              | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `swift/Sources/AtriumNoiseSpike/`                                 | 基于 CryptoKit 手写的 `Noise_IK_25519_ChaChaPoly_SHA256`、`Noise_IKpsk2_25519_ChaChaPoly_SHA256`：`CipherState`、`SymmetricState`（内部类型，值类型复制会重用 nonce）、`NoiseHandshake`（两种角色）、`NoiseTransport`；Swift 6 严格并发；固定临时密钥只有 `internal` 的构造器，测试用 `@testable import` 才能用                                                                                                                                                                | 2026-10-25：cacophony（`tools/extract-vectors.sh` 下载并校验 SHA-256 `3bde7c09…6cae`，抽出两条存进测试资源）的 IK、IKpsk2：两条握手、四条传输逐字节一致，`h` 等于 `handshake_hash`。负例：篡改（握手两条的各段、传输）、重放、乱序、握手消息重放给已完成的状态、7 个低阶点（第 1 条的 `e`、第 2 条的 `e`、二维码里的宿主公钥）、超长（握手和传输按 65535）、过短、载荷超 1 KiB（写和读两边）、明文超 65519、作废后再用、调用顺序不对、参数和模式不配、prologue 或宿主公钥不对、nonce 到 2⁶⁴−1，都被拒绝且整个状态作废。PSK 不对时宿主读第 1 条照常成功、手机读第 2 条才失败，印证 SPEC 的密钥确认 |
| 同上，`Tests/AtriumNoiseSpikeTests/TorannDifferentialTests.swift` | 和 Torann 0.3.1（MIT、纯 CryptoKit、未审计；tag `v0.3.1`，commit `8697fdb`，`exact: "0.3.1"`，**只加在测试 target**）的差分测试                                                                                                                                                                                                                                                                                                                                                | 2026-10-25：每种模式 100 次随机密钥、prologue、PSK、载荷（含 0、1、1024、65519 字节的边界），两边的握手消息、`h`、六条传输消息逐字节一致，并且互相读得懂对方的消息；300 次变异（翻位、截断、追加、换成随机字节）的握手第 1、2 条和传输消息，两边都拒绝。模糊测试顺带抓出一个 bug：CryptoKit 返回的 `ciphertext`/`tag` 是切片，`+` 之后下标不从 0 开始，调用方按下标访问会崩，已改成重新起底并加了测试                                                                                                                                                                                             |
| `swift/Sources/AtriumRemoteSpike/`                                | 线路层：首帧 `41 01 <模式>`、prologue、分帧 `00`–`04`（心跳和回应正好 1 字节、控制消息必须是带字符串 `kind` 的对象、消息必须是 UTF-8）、拼块 30 秒超时（从第一个 `01` 起算）、手机→宿主 1 MiB / 宿主→手机 8 MiB、SAS、配对链接解析（`pairingId` 是 `pair_<16hex>`）、心跳规则（10 秒一次、15 秒没回应算一次、连续 2 次重连）；`SecureChannel`（actor，加密按调用顺序、经单一写任务发出）；`RemoteClient` 的配对、IK 日常连接、`hello`（不带 `token`，`clientId` = `deviceId`） | 2026-10-25：25 个测试通过（带参数的按一个算），其中 10 个是手机端流程对进程内 Swift 假宿主（`MemorySocket`）：配对两边校验码相同并接着 `hello`/`welcome`、IK、握手第 2 条里的拒绝（`device_unknown`）、密钥确认后的 `pair_rejected`、宿主公钥不对、拼块超时真的在 200 ms 后关闭通道、20 万字节的消息分块收发、宿主心跳自动回应、篡改帧和不认识的帧类型关闭通道、发超限消息被拒                                                                                                                                                                                                                    |
| `interop/`                                                        | TS 的 `FORMAT.md`、`ts-ik.json`、`ts-ikpsk2.json`（从 TS worktree 复制）；Swift 生成的 `swift-ik.json`、`swift-ikpsk2.json`（标签 `SHA-256("atrium-mp0 swift …")` 的密钥，内容照 FORMAT.md 的建议，IK 里有一条 65 554 字节、分两块、中间夹心跳回应的宿主消息）                                                                                                                                                                                                                 | 2026-10-25：**两个方向都通过**（Swift 侧全部 53 个测试、7 组）。Swift 按 FORMAT.md 两步回放 `ts-*.json`（重新生成逐字段比对；只用接收方独立读对方的字节，交出的东西等于 `decoded`）通过；TS 的 `replayRecord`（从 `/tmp` 只读地调用 TS worktree 的 `interop.ts`）回放 `swift-*.json` 通过；四份记录还用 Torann 独立重算握手、`h` 和传输密文，一致                                                                                                                                                                                                                                                 |
| `swift/SpikeApp/`、`swift/run-sim.sh`                             | 模拟器测试 App（bundle id `site.ktoon.atrium.spike`，iOS 26，Personal Team `QGZ4G5UJ65` 自动签名）：粘贴配对链接 → `URLSessionWebSocketTask` 连 `<relay>/v1/client?host=<hostId>` → IKpsk2 → 密钥确认 → 校验码 → `paired` → 设备身份进钥匙串（`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`）→ 配对通道上 `hello`/`welcome` → IK 日常连接、`hello`/`welcome`、心跳。`NSAllowsLocalNetworking`                                                                             | 2026-10-25，iOS 26.5 模拟器（iPhone 17 Pro）对 TS 的 `fake-host.ts --local-relay`：配对成功，两边校验码一样（614 237；另一次 209 219）；重装、重启 App 后从钥匙串读出身份，IK 直接连上，心跳往返 3–4 ms；Mac 上按 `n` 拒绝时手机显示"Mac 拒绝了这次配对"；用过的码再扫显示"已被别的手机占用"（宿主回 `pairing_busy`）；宿主 `revoke` 后手机经 Noise 收到 `revoked`，删掉钥匙串里的主机记录。截图在 `swift/screenshots/`                                                                                                                                                                           |

## 跑起来（Swift 侧）

Xcode 26.6（Swift 6.3）。第一次构建要联网拉 Torann（只有测试用，但 SwiftPM 解析整个包时会拉）。

```sh
cd spikes/mobile-mp0/swift
swift test                                   # 全部测试（macOS 上跑），约 10 秒
ATRIUM_WRITE_INTEROP=1 swift test --filter InteropRecord   # 重新生成 swift-*.json，之后在仓库根 pnpm exec oxfmt spikes/mobile-mp0/interop/*.json
./run-sim.sh --screenshot /tmp/idle.png      # 建 / 启动 "Atrium Spike (iPhone 17 Pro)" 模拟器，构建、安装、启动、截图
```

端到端（TS 侧在 `spikes/mobile-mp0/ts`）：

```sh
node fake-host.ts --local-relay 8787 --pair --auto-confirm --public-relay ws://127.0.0.1:8787   # 终端 1；去掉 --auto-confirm 就在终端里按 y / n
./run-sim.sh '<打印出来的 atrium://pair?… 链接>' --auto-pair --screenshot /tmp/e2e.png --wait 10  # 终端 2
./run-sim.sh --auto-connect --no-build      # 之后：只用钥匙串里的身份走 IK
```

- 模拟器和 Mac 共用网络，`ws://127.0.0.1:<端口>` 就能连到本机的 relay；不加 `--public-relay` 时链接里是局域网 IP，模拟器也连得上。
- `run-sim.sh` 的参数：链接（启动参数 `-pairLink`）、`--auto-pair`（`-autoPair YES`）、`--auto-connect`（`-autoConnect YES`）、`--no-build`、`--screenshot <文件>`、`--wait <秒>`。也可以不带参数启动，在 App 里粘贴链接、点"配对"。
- Xcode 工程是手写的最小 `project.pbxproj`（文件夹同步组，本地包引用 `..`，约 250 行）；`apps/ios` 怎么生成工程留给 MP1 定。

## 发现与待定（Swift 侧）

- **CryptoKit 的 DH 也先于全零检查拒绝低阶点**：`sharedSecretFromKeyAgreement` 对 7 个低阶点都直接抛错，显式的全零检查走不到（破坏检查确认去掉它测试仍过）。和 noble 一样，检查留着当冗余防线。
- **CryptoKit 返回切片**：`SealedBox.ciphertext` 等是带偏移的 `Data` 切片，拼接后下标不从 0 开始。正式的 `AtriumNoise` 要在边界上统一重新起底（已在 spike 里做并有测试）。
- **Swift 擦不掉密钥**：`Data` 和 CryptoKit 的密钥类型都没法可靠清零，spike 只在握手结束或失败时丢掉引用。正式版若要求擦除，得换成自己管理的缓冲区。
- **互通记录的 `decoded.value` 键序**：TS 回放用 `JSON.stringify` 比较，对键序敏感；Swift 写记录时排序键名，而两边的控制消息正文本来就按键名排序（Swift 的 `RemoteJSON`），所以对得上。建议 FORMAT.md 写明"`value` 按语义比较"或"键按字典序"。
- **Torann 的 tag 带 `v` 前缀**（`v0.3.1`），SwiftPM 的 `exact: "0.3.1"` 能解析到它；它的固定临时密钥入口是 `internal`，`swift test`（debug，可测试编译）下 `@testable import Torann` 能用，release 构建用不了。Torann 只在测试 target，App 没有链接它。
- **模拟器上钥匙串可用**：自动签名、带 team id 时不需要描述文件；同一 bundle id 重装后钥匙串项还在。真机上的 7 天重签、重装后是否保留，要等真机验证。
- 手机这边握手第 2 条之前连接被关（宿主对非当前 `pairingId` 直接关闭）或解不开第 2 条时，App 显示"二维码已失效"；WebSocket 关闭码是 4404 时显示"Mac 不在线"。关闭原因只用来显示，不触发删除（relay 能伪造）；只有经 Noise 认证的 `revoked` 和握手第 2 条的 `device_unknown` 才删掉主机记录。
- 没做 / 没验证：真机（扫码用的 VisionKit、本地网络权限弹窗、免费签名）、"Mac 不在线"（4404）在 App 里的实际显示、`device_unknown` 在 App 里的端到端（只在 Swift 进程内测试和 TS 端到端里覆盖）、前后台切换和 `NWPathMonitor`、重连退避、"待确认"记录在下次日常连接时补成正式记录。
