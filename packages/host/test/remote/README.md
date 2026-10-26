# MP3a remote test harness

只连测试自己的 `127.0.0.1`，不接用户的 relay。没有 pi 导入，也不启动宿主服务。

## Relay

```ts
import { startTestRelay } from "./relay-process";

const relay = await startTestRelay({ signal, timeoutMs: 5_000 });
// relay.endpoint: RelayEndpoint { url, hostId, token }
// relay.line: add-host 实际输出的一行
// relay.pid / relay.dataDir
await relay.cleanup(); // 幂等
```

将 `apps/relay/src/entry.ts` 实时打包到临时目录，分别用子进程执行真实的 `add-host`、`serve`。配置、宿主表、日志和 bundle 都在临时目录。先取得空闲 loopback 端口，再注册、启动；期间端口被抢会报启动失败，不重定向、不连其他地址。只有收到该子进程的 listening 输出才返回。关闭先发 SIGTERM，2 秒仍没退出就 SIGKILL，等退出后删目录。子进程边界使用真实时钟。

## Phone

```ts
import { FakePhone } from "./fake-phone";

const phone = new FakePhone({ clock, staticKey, deviceName: "Test iPhone", model: "test" });
const session = await phone.pair(pairingLink, { confirm: false });
session.channel.sendControl({ kind: "pair_confirm" });
const paired = await session.control(["paired", "pair_rejected"]);
// session.sas 是六位字符串；配对 session.deviceId 为 null，使用 paired.deviceId。
await session.hello(String(paired.deviceId));
await session.close();

const daily = await phone.connect(); // 同一手机身份，IK；daily.deviceId 来自握手
await daily.hello(String(daily.deviceId));
await phone.dispose(); // 包括尚未完成握手的 socket
```

- `pair(link, options?)`、`connect(hostId?, options?)`：`protocolVersion`、`payload` 可改握手载荷；`signal`、`timeoutMs` 控制等待。`pair` 默认发送 `pair_confirm`，`confirm: false` 留给测试手动发。
- `hosts`：内存中的主机记录副本；断线不删，认证过的 `revoked` / `device_unknown` 才撤销，`pair_rejected` 清掉待确认记录。没有任何凭据写到手机或用户目录。
- Session：`channel` 是真实 `SecureChannel`，可发 control、message、ping；`next(predicate, waitOptions?)` 等原始 `Received`；`control(kinds, waitOptions?)` 等控制消息；`message(predicate?, waitOptions?)` 等解码后的 JSON。
- `send(value)` 发任意 JSON；`sendHello(clientId, overrides?)` 只发送；`hello(clientId, overrides?, waitOptions?)` 另等 welcome。`overrides` 可改 `protocolVersion`、加 token 等，供拒绝用例使用。
- `request(command, waitOptions?)` 自动补 requestId 和 traceparent，按 requestId 等回应；也可显式传这两项。
- `close({ terminate?, code?, reason? })` 控制断开；`closed` 等实际 socket 关闭，结果为 `{ code, reason }`。
- 所有 receive 等待默认 5 秒；`waitOptions` 为 `{ signal?, timeoutMs? }`。手机 chunk / 等待 / 关闭计时用注入的 clock，默认宿主 `systemClock`；测试可传 `FakeClock`。
- 任意非 `ws://127.0.0.1:<port>` 的 relay 地址在打开 socket 前拒绝。不要把真实配对码传进测试。

## 自检

```sh
PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH" pnpm exec vitest run --project unit packages/host/test/remote/harness.test.ts
PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH" pnpm break-check packages/host/test/remote/break-check.json
```

九项自检使用真实 relay 子进程和独立的 Noise 响应端：CLI 注册、健康检查与进程/目录清理；选择性收消息；等待取消/超时及定时器清理；IKpsk2 / SAS / 手动与自动确认；紧跟握手的控制消息；80 KB 分块消息；自定义 hello；IK 重连、请求回应、认证撤销；待确认断线后的未知设备拒绝；挂起握手的取消与 dispose；非 loopback 地址拒绝。九个定向破坏均应检出。地址守卫的破坏检查用无效公钥，仍在联网前失败，不访问外部地址。

## 宿主集成与泄漏验证

```sh
pnpm exec vitest run --project host packages/host/test/remote
pnpm exec vitest run --project leak packages/host/test/remote/service.leak.test.ts
pnpm break-check packages/host/test/remote/service-break-check.json
```

- `service.host.test.ts`：21 项真实 relay + RemoteService 集成。配对确认/SAS、旧码/过期、拒绝/取消、确认超时/断线、竞争手机、错误 PSK/协议版本、保险箱失败、丢 paired 后 IK 恢复、未知设备、撤销与写失败拉黑、重配复用身份、改名/重置、重配写入途中撤销竞态、4 个未认证通道/10 秒、每设备 2 通道/30 秒、流量采样与取消订阅、关闭时取消探测、关闭期间完成的确认不授权。
- `host-connection.host.test.ts`：2 项完整 `startTestHost` 集成。经共同服务器验证 hello/每日连接、设备身份/token/版本拒绝、本机命令白名单、本机 watcher 与手机事件隔离、索引订阅和撤销清理。预期 warn 按宿主日志门禁声明。
- `service.leak.test.ts`：40 轮配对/日常连接/撤销，20 轮每次 4 个待确认通道的开关循环；每轮检查 ResourceTracker 和 FakeClock，最终比较真实 TCP socket 数。仅这些压力循环通过 relay 的真实配置把 `newStreamsPerIpPerMinute` 从默认 30 改为 1000，不改宿主的连接上限；否则测到的是 relay 正确返回 4429，而非资源泄漏。
- `service-fixture.ts`：`MemoryVault` 实现真实版本递增/写入可见性语义，支持下一次失败和写入闸门；其余服务、Noise、WebSocket 与 relay 都是真实实现。直接服务测试的 accept adapter 只记录授权，不冒充共同服务器。
- 探测取消用例只暂停测试自己创建的 relay 子进程，`finally` 恢复；故障断言有独立的实时时限，破坏检查也不会把子进程留在暂停状态。

`service-break-check.json` 含 18 个源代码定向破坏。修改源代码的主代理负责在无并行编辑/测试时执行；子代理只检查目标文本唯一匹配，不执行它，避免临时变更污染其他测试。普通 harness 自检的 9 个破坏另在 `break-check.json`。

主任务负责在 `docs/testing/coverage-map.md` 登记集成验证、执行 source break-check、变异测试和最终整套验收。
