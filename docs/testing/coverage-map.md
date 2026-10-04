# 测试追踪表

> 每条需求、关键流程、错误路径和安全要求，对应到证明它的测试。规则见 [testing.md](../architecture/testing.md#让覆盖面全)。
>
> 新增行为时在这里登记；一个里程碑完成前，它涉及的行都要有测试，并通过变异门槛。"待 M1.x"表示计划在该里程碑补上。

## SPEC-0001 需求

| # | 需求 | 测试 | 状态 |
|---|---|---|---|
| 1 | 侧栏按项目和工作区组织，显示运行、待处理、合并状态；标签页切换会话 | — | 待 M1.5 |
| 2 | 流式输出回复和推理过程 | — | 待 M1.3 |
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
| 宿主不依赖 Electron，能用 node 单独运行 | 手动：`node packages/host/dist/entry.cjs`（M1.1 验证过）；待 M1.2 加自动化 | 部分 |
| 正确的 token 被接受，客户端进入"已连接" | `packages/host/src/server/ws-server.host.test.ts` "records the whole connection…"；`packages/client/src/connection.test.ts` | 已覆盖 |
| 宿主只监听 IPv4 回环 | ws-server.host.test.ts "listens on IPv4 loopback only" | 已覆盖 |
| 端口被占用时启动失败 | ws-server.host.test.ts "fails to start when the port is already taken" | 已覆盖 |
| 关闭宿主时所有连接已断开、保持连接的 HTTP 不拖慢关闭 | ws-server.host.test.ts "host lifecycle" | 已覆盖 |
| 界面跟随系统外观 | `packages/ui/src/design/appearance.browser.test.ts`；e2e "follows the system appearance" | 已覆盖 |
| 连接状态的文案 | `packages/ui/src/app/connection-status.browser.test.tsx` | 已覆盖 |

## 安全（security.md）

| 要求 | 测试 | 状态 |
|---|---|---|
| 错误 token 被拒绝（4401），日志里没有真 token | ws-server.host.test.ts "rejects a wrong token…"、"closes the socket on a hello with the wrong token…" | 已覆盖 |
| 外来 Origin 在升级时被拒（403） | ws-server.host.test.ts "refuses a browser from a foreign origin…" | 已覆盖 |
| 只认第一条 hello；格式错误、版本不符、超时各有关闭码 | ws-server.host.test.ts "closes the socket on …"、"drops a client that never says hello…"、"answers only the first of two hellos…" | 已覆盖 |
| token 用常量时间比较 | `packages/host/src/server/auth.test.ts` | 已覆盖 |
| 渲染进程拿不到 Node，只有 bootstrap 桥 | e2e "gives the page no Node access…" | 已覆盖 |
| 不能导航到别的源、不能开新窗口 | e2e "keeps the page on its own origin…" | 已覆盖 |
| 宿主页面带 CSP、nosniff | ws-server.host.test.ts "serves the UI with the full content security policy…"、"serves … as …"；e2e "opens a window…" | 已覆盖 |
| 静态文件不越出 UI 目录 | `packages/host/src/server/static-files.test.ts`；ws-server.host.test.ts | 已覆盖 |
| 日志脱敏：凭据键、已知秘密、错误信息、键名 | `packages/host/src/platform/redact.test.ts`、`redact.prop.test.ts`；e2e "…never logs the token" | 已覆盖 |
| `~/.atrium` 权限 0700，日志文件 0600 | 手动验证（M1.1）；待 M1.5 随索引存储加自动化 | 部分 |

## 日志与链路追踪（observability.md）

| 要求 | 测试 | 状态 |
|---|---|---|
| traceparent 的生成、格式化、解析 | `packages/protocol/src/trace.test.ts`、`trace.prop.test.ts` | 已覆盖 |
| 宿主 span 挂在客户端的 trace 下，日志带 trace_id | ws-server.host.test.ts "records the whole connection…"；e2e "records the connection under one trace id…" | 已覆盖 |
| 未结束的 span 计入资源计数 | `packages/host/src/server/connections.leak.test.ts` | 已覆盖 |
| `pnpm trace` 打印链路 | 手动（M1.1 验证过） | 部分 |

## 资源与性能（testing.md）

| 要求 | 测试 | 状态 |
|---|---|---|
| 200 次连接、50 次拒绝后资源计数回到基线 | connections.leak.test.ts | 已覆盖 |
| 定时器计数与释放 | `packages/host/src/platform/clock.test.ts` | 已覆盖 |
| 外观来回切换不留下脱离的 DOM | `apps/desktop/e2e/appearance.leak.spec.ts` | 已覆盖 |
| 启动到连上宿主 ≤ 2 秒 | `apps/desktop/e2e/startup.perf.spec.ts` | 已覆盖 |
| 长时间运行：资源回到基线，内存增长每次 < 1KB | `packages/host/test/soak/connections.soak.test.ts` | 已覆盖 |
| 热路径基准 | `packages/protocol/src/trace.bench.ts`（traceparent 解析） | 已覆盖 |
