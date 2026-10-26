# 互通记录的格式

MP0 用它检查 TypeScript 和 Swift 两份 Noise 实现、Atrium 线路层（SPEC-0005"Noise 通道"）逐字节一致。每边用固定的密钥和临时密钥跑一遍握手和若干传输消息，把每个字节写下来；另一边读进来回放。

- TypeScript 生成：`ts-ik.json`、`ts-ikpsk2.json`（`node spikes/mobile-mp0/ts/interop.ts`）。
- Swift 生成：`swift-ik.json`、`swift-ikpsk2.json`，放在这个目录。TypeScript 侧的 `interop.test.ts` 见到 `swift-*.json` 就回放，没有就跳过。
- Swift 侧回放 `ts-*.json` 的做法同下面"怎么回放"。

## 字段

一个 JSON 对象。所有字节串都是**小写 hex**，没有前缀。

| 字段                                                               | 内容                                                                               |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `format`                                                           | `1`                                                                                |
| `generator`                                                        | `"ts"` 或 `"swift"`，只作说明，回放不比                                            |
| `protocol_name`                                                    | `Noise_IK_25519_ChaChaPoly_SHA256` 或 `Noise_IKpsk2_25519_ChaChaPoly_SHA256`       |
| `mode`                                                             | 首帧里的模式字节：IK 是 `1`，IKpsk2 是 `2`                                         |
| `host_id`                                                          | 如 `hst_0123456789abcdef`                                                          |
| `prologue`                                                         | `"atrium-remote/1" 0x00 host_id 0x00` 的 hex，必须等于按 `host_id` 算出来的        |
| `psk`                                                              | IKpsk2 的 32 字节 PSK；IK 是 `null`                                                |
| `phone_static`、`phone_ephemeral`、`host_static`、`host_ephemeral` | 四个 X25519 **私钥**（32 字节，未 clamp 的原始字节，按 RFC 7748 使用时再 clamp）   |
| `phone_static_public`、`host_static_public`                        | 两个静态公钥（`host_static_public` 就是二维码里的宿主公钥）                        |
| `handshake`                                                        | 两项，见下                                                                         |
| `handshake_hash`                                                   | 握手结束时的 `h`（32 字节）                                                        |
| `sas`                                                              | 6 位校验码字符串：`SHA-256("atrium-sas-v1" ‖ h)` 前 4 字节大端整数 mod 10⁶，左补零 |
| `transport`                                                        | split 之后的传输消息，按发生顺序，见下                                             |
| `decoded`                                                          | 接收方的分帧层依次交出来的东西，见下                                               |

`handshake[i]`：

| 字段            | 内容                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `from`          | `"phone"`（第 1 条）或 `"host"`（第 2 条）                                                             |
| `payload`       | 握手载荷（UTF-8 JSON）的字节                                                                           |
| `payload_text`  | 同一个载荷的文字，只给人看，回放不比                                                                   |
| `noise_message` | Noise 握手消息本身                                                                                     |
| `wire`          | 实际的 WebSocket 二进制帧：第 1 条是 `41 01 <mode>` 加 `noise_message`；第 2 条和 `noise_message` 相同 |

`transport[i]`：

| 字段         | 内容                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `from`       | 发送方                                                                                                           |
| `nonce`      | 发送方这条用的 nonce（每个方向各自从 0 数）                                                                      |
| `plaintext`  | 分帧后的明文：第 1 字节是类型（`00` 最后一块、`01` 还有块、`02` 心跳、`03` 心跳回应、`04` 控制消息），后面是正文 |
| `ciphertext` | 线上的帧，即 Noise 传输消息（AD 为空，16 字节标签在最后）                                                        |

`decoded[i]`，每当接收方收齐一样东西记一项（`value` 里的对象键按字典序写出，TS 回放用 `JSON.stringify` 比较，对键序敏感）：

- `{ "from", "kind": "message", "text" }`：一条完整的 Atrium 消息（各块拼起来的 UTF-8）；
- `{ "from", "kind": "control", "value" }`：控制消息解析后的 JSON 对象；
- `{ "from", "kind": "ping" }`、`{ "from", "kind": "pong" }`。

`from` 是发送方。`0x01` 块不单独记。

## 生成时的约定

- 私钥随便取，记下来就行。TypeScript 用的是 `SHA-256("atrium-mp0 ts phone static")` 这类标签的哈希；Swift 请换成自己的标签（如 `"atrium-mp0 swift phone static"`），两边用不同的密钥才算互通。
- 载荷和消息的 JSON 怎么排版无所谓：回放拿记录里的字节当输入，不重新序列化。
- 心跳和心跳回应**正好 1 字节**（`02`、`03`），多一字节对方就关闭通道。
- 一条消息超过 65518 字节正文就分块：前面每块 `01` 加 65518 字节，最后一块 `00` 加剩下的 1–65518 字节（只有空消息才是一个空的 `00` 块）。正文整好 65518 字节时只有一块 `00`。
- 控制消息是 `04` 加一个 JSON 对象，必须有字符串 `kind`，单块。
- 建议的内容（TypeScript 的两份就是这样）：
  - IKpsk2：载荷 `{"kind":"pair",…}` / `{"ok":true}`；传输 `pair_confirm`（手机）、`paired`（宿主）、`hello`、`welcome`、心跳、回应。
  - IK：载荷 `{"kind":"connect",…}` / `{"ok":true,"deviceId":…}`；传输 `hello`、`welcome`、`ping` 命令和应答、心跳，一条分两块的宿主消息、两块中间夹一个心跳回应，最后 `revoked`。

## 怎么回放

两步都要过，任何一处不一致就算失败：

1. **重新生成**：用记录里的私钥、`psk`、`host_id`、两条握手载荷和每条 `transport[i].plaintext`（按记录顺序），自己跑发起方和响应方，得到的每个字段（除 `generator`、`payload_text` 外）都要和记录逐字节相同。
2. **独立读对方的字节**：
   - 宿主一侧从 `handshake[0].wire` 解析首帧（检查 `41`、`01`、模式），读第 1 条，载荷要等于 `handshake[0].payload`；
   - 手机一侧写出自己的第 1 条后，读 `handshake[1].wire`，载荷要等于 `handshake[1].payload`；
   - 宿主读出的手机静态公钥要等于 `phone_static_public`；
   - 每条 `transport[i].ciphertext` 由接收方解密，明文要等于 `plaintext`；再喂给接收方的分帧层，交出来的东西依次等于 `decoded`。
