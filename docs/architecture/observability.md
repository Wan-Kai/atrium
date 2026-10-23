# 日志与链路追踪

> 2026-10-04 定。目标：任何一次用户操作或后台任务，都能用一个 trace id 串起从界面到宿主、再到 pi 进程和 git 的完整调用链，出问题时按它找到全部相关日志。

## 方案

参照 OpenTelemetry（遥测）的模型：一次操作是一条 **trace**，其中每个步骤是一个 **span**，span 之间是父子关系；日志都挂在当前 span 上。id 用 W3C Trace Context 的格式（trace id 32 位十六进制、span id 16 位十六进制，跨进程时传 `traceparent`），以后要接 Jaeger 等工具查看时不用改格式。

| 部分 | 选型 | 说明 |
|---|---|---|
| 链路追踪 | `@opentelemetry/api` + `sdk-trace-node`（2.x，稳定） | 宿主里用 AsyncLocalStorage 自动沿 `await` 传递当前 span，不用手动层层传参 |
| 导出 | 自己写一个 SpanExporter，写成本地 JSONL | 默认不联网；开发时可以额外打开 OTLP 导出，用 Jaeger 之类的工具看瀑布图 |
| 日志 | pino 10 | 每行一条 JSON；用 `mixin` 从当前 span 取 `trace_id` / `span_id` 自动带上；自带按路径脱敏 |
| 日志轮转 | pino-roll | 按大小轮转（10MB × 5 个文件）。关闭时用 `end` 写完再关，不用 `flushSync`：有写入正在进行时，`flushSync` 会让后写的记录先落盘，最后一条日志就不在最后了。写入或轮转时打开文件出错（磁盘满、EIO）时直接关掉文件，宿主照常关闭、释放锁，不卡在等日志上 |
| UI 与 client | 不引入浏览器端 OpenTelemetry SDK | client 只负责生成 `traceparent` 并随命令发出；界面的错误和性能问题经 WebSocket 发回宿主记录 |

OpenTelemetry 的日志 SDK（`sdk-logs`）还在 0.x，不用；日志走 pino，只借用追踪那部分。

pi 自己有一套遥测接口（`@earendil-works/pi-telemetry`），但 pi 1.0.1 的 RPC 模式没有接出来，外部进程无法把 trace 传进 pi 内部。所以 pi 进程是链路的边界，见下文"pi 进程"。

## 一条链路包含什么

**根**：

- 用户操作：client 发命令时生成 trace，命令信封里带 `traceparent`（协议字段，和 `requestId` 并列）。宿主的 `command <type>` span 以它为父，再用 span link 指向这个连接的 `ws.connect`，不挂在连接那条长 trace 下面（SPEC-0001"协议细节 · 追踪"）。
- 后台任务：定时 `git fetch`、会话目录扫描、自动生成标题、崩溃后自动重启、pi 更新检查，各自开一条新 trace，并用 span link 指向引起它的那条（例如标题生成链接到那次运行，自动重启链接到崩溃时的运行）。

**典型的 span 树**（发一条消息）：

```
ui.action send                         client 生成 trace
└─ command prompt                      宿主收到命令
   ├─ queue.enqueue / queue.dequeue
   └─ run                              从 prompt 到 agent_settled
      ├─ pi.rpc prompt                 RPC 请求 id = 这个 span 的 id
      ├─ pi.message                    一条助手消息（流式开始到结束）
      ├─ pi.tool bash                  tool_execution_start 到 end，带调用 id
      ├─ pi.retry                      自动重试（span event）
      ├─ pi.rpc get_entries            运行结束后的条目同步
      └─ publish                       推给订阅的客户端（只记数量和耗时）
```

其他会出现的 span：`git <子命令>`、`index.write`、`fs.scan`、`pi.process.start/exit`、`ws.connect`、`sync.snapshot`。

**宿主推给 UI 的事件带上所属运行的 trace id**，界面报错或卡顿时把它一起发回，就能和宿主那边的记录对上。

## pi 进程

- RPC 命令的 `id` 用对应 `pi.rpc` span 的 id 生成，形如 `<span id>-<序号>`（序号保证同一个 span 发多条命令时也不重复），pi 的响应原样带回这个 id，请求和响应自然落在同一条链路里。
- pi 进程在 `pi.process` span 激活时启动；Node 在启动时的上下文里执行子进程的流回调，所以 pi 的 stderr 和进程生命周期日志自动带上这个 span，pi 包不需要知道链路追踪。span 在 pi 退出时结束，记下退出码，不是宿主要求的退出标为错误。
- 进程起不来（没有进程号，如 pi 不在了、工作目录不在了）时只记一条 warn"pi did not start"，带工作目录和错误（如 `ENOENT`），不记"pi started"和"pi exited"：pi 没跑起来，不算崩溃（2026-10-22 自用时改：原先先记"pi started"，再记一次不是请求的"pi exited"，和真崩溃分不开）。`pi.process` span 照样标为错误。
- pi 发出的事件没有 id，宿主按"当前运行"把它们挂到 `run` span 下。
- pi 的 stderr 逐行记录在 `pi.process` span 下。
- 以后（MVP 2）Atrium 的内置 extension 可以接收 trace id，把 pi 内部的钩子（请求模型前、工具调用）也记成 span，经"通知加标记"通道送回宿主，链路就能延伸进 pi 内部。

## 日志格式

每行一条 JSON，字段对齐 OpenTelemetry 的日志数据模型：

| 字段 | 说明 |
|---|---|
| `time` | ISO 时间 |
| `level` | `trace` / `debug` / `info` / `warn` / `error` / `fatal` |
| `msg` | 英文短句，描述发生了什么 |
| `trace_id`、`span_id` | 当前 span，没有时省略 |
| `service` | `host` / `client` / `ui` / `desktop` |
| `session_id`、`project_id`、`workspace_id`、`request_id` | 有就带，便于按对象过滤 |
| `err` | 错误对象（名称、码、堆栈） |
| 其他 | 结构化属性，不拼进 `msg` |

span 结束时另写一条 `kind: "span"` 的记录：名称、开始结束时间、耗时、状态、父 span、links、属性。

- 文件位置：`~/.atrium/logs/host.<n>.jsonl`（按 10MB 轮转，磁盘上最多保留 5 个，包括之前运行留下的；`current.log` 链接到正在写的那个；含 client 和 UI 发回的记录）；Electron 主进程的日志以后加 `desktop.<n>.jsonl`。日志流出错（如磁盘写满）时写到 stderr，不让宿主崩溃。
- 级别：默认 `info`；设置里可切到 `debug`；`trace` 级只在开发时用。
- warn 和 error 只留给需要有人看的事。Atrium 自己要求的停止或中止引起的记录不记 warn，和"pi exited"按 `requested` 分 info、warn 一致（2026-10-23 定）。原先这几处都记 warn，宿主测试加上日志门禁（[testing.md · 日志门禁](testing.md#日志门禁)）后才发现：每次关会话、关宿主都会留下几条假 warn，把真的问题埋住。改为：
  - Atrium 自己放弃的请求（宿主停 pi 时还在等的、调用方用 signal 中止的），pi 之后才回的响应记 debug，照样丢掉；过了 pi 进程自己的期限（timeout）才到的、没有 id 的、从没发出过的 id 仍记 warn"pi response matches no waiting request"。为此记住的请求 id 有上限（最近 100 个，先进先出）：pi 可能永远不回，会话的 pi 可能一连跑好几天。
  - 模型目录的查询过了自己的期限（120 秒）被中止时，另记一条 warn"model list timed out"，只带期限（`timeoutMs`），不带目录路径；目录关闭时中止查询不记。这样上一条把"中止后的迟到响应"降为 debug 后，查询超时仍然看得见。
  - 运行后读 pi 的条目（`get_entries`）时宿主停了这个 pi（`reason: "stopped"`，只在 `stop()` 之后出现）记 info，pi 崩溃（`exited`）、超时、被拒仍记 warn"transcript refresh failed"。
  - 读登录 shell 的环境被宿主关闭中止（`reason: "aborted"`）记 info，超时、退出码不对、读不到标记、起不来仍记 warn"login shell attempt failed"。
  - 一次性 pi（标题生成等）因调用方中止而失败（宿主关闭时中止正在生成的标题）：`reason: "aborted"` 记 info，其他原因仍记 warn"one-shot pi failed"。
  - 没找到 pi（`pi inspected` 的 `status: "missing"`）记 info：没装 pi 是首次启动的正常状态，界面会引导安装；找到了却用不了（`unusable`）或版本太旧（`outdated`）仍记 warn。
- 查看：`pnpm trace <trace id>` 把一条链路的 span 和日志按树形打印出来。`pnpm errors` 把 warn、error、fatal 按签名汇总，标出最近一次宿主启动后才出现的新签名（[testing.md · 运行时监控](testing.md#运行时监控)）；签名不含 `msg` 之外的文字，所以 `msg` 要保持固定的短句，变化的信息放结构化字段。

## 脱敏

脱敏在写盘前对整行进行：pino 把消息、`err`、子 logger 的绑定组装进最终那一行，只有这一行能看到全部内容。每行解析成对象，按键名替换凭据（任意深度），再把已知秘密值（会话 token）从所有字符串里擦掉，然后重新序列化。

- 永远不记录：token、API Key、OAuth 令牌、`Authorization` 头（pino 的 `redact` 统一处理，测试里搜日志确认）。
- 默认不记录：提示词、回复、推理、工具参数和输出、文件内容、模型请求的原始数据。只记长度、数量、id 和耗时。`debug` 级也只记截断后的前 200 个字符，并在设置里提示。
- 路径可以记录（排查问题需要），用户主目录替换成 `~`。

这与 pi 遥测接口的数据原则一致：诊断数据不含提示词、补全、工具参数和输出、文件内容和凭据。

## 和测试的关系

- 测试里换成内存导出器，可以断言一次操作产生了预期的 span 树（例如停止时依次出现暂停出队、`clear_queue`、`abort`），用来定位第 4 层测试的失败。
- 第 4 层和第 6 层的测试收尾时检查宿主日志：测试没声明的 warn、error、fatal 让测试失败（[testing.md · 日志门禁](testing.md#日志门禁)，2026-10-23）。
- 泄漏测试把"未结束的 span 数"也算进资源计数：操作结束后必须回到 0（[testing.md · 性能与资源泄漏](testing.md#性能与资源泄漏)）。
- 资源计数和内存的定时记录（每分钟一次）也写进同一份日志：宿主的资源计数、堆和 RSS 记为 `resource usage`；Electron 主进程没有自己的日志，每分钟把 `app.getAppMetrics()` 里各进程的类型、内存（working set，KB）和 CPU 交给宿主，记为 `app metrics`（2026-10-11 定）。`pnpm usage` 按宿主的每次运行汇总这两种记录。
