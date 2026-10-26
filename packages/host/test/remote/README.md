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

这些只验证工具本身，不替代宿主 RemoteService、保险箱、白名单或资源泄漏验收。主任务负责在 `docs/testing/coverage-map.md` 登记集成验证。
