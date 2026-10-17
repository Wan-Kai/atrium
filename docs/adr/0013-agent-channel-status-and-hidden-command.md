# ADR-0013：扩展与宿主有来有回的通道用"状态加隐藏命令"

- **状态**：已接受
- **日期**：2026-10-17
- **相关**：[SPEC-0002](../specs/0002-child-conversations.md)"扩展与宿主的通道""送达""第二步 · 工具"、[ADR-0002](0002-connect-pi-via-rpc-subprocess.md)、[ADR-0008](0008-atrium-own-pi-extension-for-fast.md)、[ADR-0010](0010-plan-usage-through-atrium-extension.md)、[pi-internals](../research/pi-internals.md) §5"SPEC-0002 契约测试实测"、[security.md](../architecture/security.md)

## 背景

SPEC-0002 的第二步让主对话的 agent 开子对话、发消息、等结果，子对话能向主 agent 汇报进度和提问。这些工具在 Atrium 自带的 pi 扩展里，但做事的是宿主：开会话、起 pi、排队、送达、记状态。所以扩展要能问宿主、等宿主的回答，宿主也要能主动交给扩展东西（往上送的通知、往下送的交代、提问的回答）。

到目前为止扩展和宿主之间都是单向的：Fast、套餐用量是宿主发内部命令，扩展用 `setStatus` 报结果（ADR-0008、ADR-0010）。pi 的 RPC 没有给扩展用的自定义消息。

约束：

- pi 是宿主的子进程，经 stdin/stdout 的 JSONL 说话（ADR-0002）。不另开 socket、端口，不发 token（security.md）。
- 宿主要知道是哪个会话在问。这只能看请求从哪个 pi 进程来，不能信参数里写的身份。
- 有的请求要等很久：`agent_wait` 最多一小时，`ask_parent` 默认十分钟。pi 不给工具设超时；RPC `abort` 会中止传给工具的 `signal`。
- 两种做法都能用（SPEC-0002"扩展与宿主的通道"的甲、乙）。2026-10-17 在本机 pi 1.1.0 上用契约测试实测了乙（`packages/pi/src/contract/subagent.pi.test.ts` 的 `agent-channel`）：工具里 `setStatus` 发出请求、挂着等；运行中宿主发隐藏命令，pi 立即执行、应答 `handled`，工具拿到回答、这一轮接着跑；命令不进会话文件、模型看不到，也不另开一次运行。

## 决策

**扩展用 `ctx.ui.setStatus("atrium-agent:<请求 id>", JSON)` 向宿主发请求和通知，宿主用隐藏命令 `/atrium-agent <动作> <base64url JSON>` 回答和交东西给扩展。不借用对话框。**

1. **扩展 → 宿主**：`statusKey` 是 `atrium-agent:<请求 id>`，`statusText` 是一个 JSON 信封：
   - `{ v: 1, id, kind: "call", op, args }`：要宿主回答的调用。
   - `{ v: 1, id, kind: "note", op, args }`：不要回答的通知。
   - 宿主在原始的 `extension_ui_request` 上认这个前缀，和 `atrium-fast`、`atrium-plan` 分开；`statusText` 是 `undefined` 的（扩展清掉状态）不理。扩展收到回答后用 `setStatus(key, undefined)` 清掉这个键，免得 pi 的状态表越积越多。
2. **宿主 → 扩展**：隐藏命令 `/atrium-agent <动作> <参数>`，参数是一个 base64url 编码的 JSON，同 `/atrium-fast`、`/atrium-plan`：
   - `reply`：`{ v: 1, id, ok: true, result }` 或 `{ v: 1, id, ok: false, code, params? }`，回答一次 `call`。
   - `deliver`：把往上送的通知、往下送的交代交给扩展，扩展用 `pi.sendMessage(…, { triggerTurn: true, deliverAs: "steer" })` 发自定义消息 `atrium-agent`（SPEC-0002"送达"）。
   - `cancel`：`{ v: 1, id, reason }`，宿主关掉一次还没回答的 `call`（目前只有 `ask`：被脱离、归档、交给终端，或回答没确认送到，见 SPEC-0002 `agent_reply`）。
   - 宿主发之前先在 `get_commands` 里确认有 `atrium-agent`，没有就当这个 pi 不支持子代理（同 `/atrium-plan`）。你在输入框里打的 `/atrium-` 开头的消息宿主不发（`command_reserved`）。
3. **调用方是谁**：请求从哪个 pi 进程的管道来，就是哪个会话；信封里不写会话 id，写了也不认。
4. **请求 id**：扩展定，在这个 pi 进程里唯一。工具发的 `call` 用工具调用的 id（`toolCallId`），别的用 `n<序号>`。同一进程里同一个 id 再来一次，宿主当成同一个请求：还在做就等它，做完了就回同一个结果，不再开一个子对话、不再发一次。扩展不重发请求：管道上的 `setStatus` 不会丢。
5. **进程代次**：宿主给每次起的 pi 记一个代次，请求和回答都挂在那个进程上。pi 换了进程（崩溃重启、回收后再起），旧进程上没回答的请求宿主直接丢掉，不发给新进程；扩展收到不认识的 id（迟到、重复）也丢掉。pi 重启时挂着的工具调用本来就没了（模型看到的是"No result provided"），所以不跨进程续接请求。
6. **超时与取消**：
   - 通道本身不设超时，各个工具按 SPEC-0002 自己的规则等（`agent_wait` 的 `waitSeconds`、`ask_parent` 的 `timeoutSeconds`、`agent_reply` 等确认的 10 秒）。超时由宿主回一个正常的结果（如 `timedOut: true`），不是通道出错。
   - 工具的 `signal` 中止时（你停下了这一轮），扩展马上结束这个工具，并发一条 `{ kind: "note", op: "cancel", args: { id } }`，宿主停掉这次的等待，之后的回答不再发。
   - 宿主不知道 pi 那边已经不等了（如扩展抛错）也没关系：回答发过去，扩展按第 5 条丢掉。
7. **重复和迟到的回答**：扩展只认每个 id 的第一个回答，后来的丢掉。`ask` 的回答要扩展确认收下（`{ kind: "note", op: "answered", args: { id } }`）；宿主发了 `cancel` 后，扩展回 `answered`（之前已经收下）或 `closed`，SPEC-0002 `agent_reply` 照这个返回。
8. **操作和参数**：`call` 的 `op` 是 `spawn`、`send`、`wait`、`reply`、`list`、`read`、`stop`、`models`、`ask`，`args` 就是对应工具（`agent_*`、`ask_parent`）的参数，已经过工具的 schema 校验；`result` 是 SPEC-0002 里那个工具的返回。`note` 的 `op` 是 `progress`（`report_progress`）、`cancel`、`answered`、`closed`。之后上下文检查器要的"扩展给宿主发数据"也用 `note`，加新的 `op`。
9. **格式与大小**：
   - 信封和参数由 `packages/pi` 里的一份 zod schema 定义，扩展和宿主共用；宿主收到的先校验，不合格的回 `{ ok: false, code: "agent_bad_request" }`，只是 `note` 就丢掉并记一次警告。
   - `v` 不是 1 的，宿主回 `agent_bad_request`。扩展和宿主一起打包发布（ADR-0008），不做版本协商。
   - 一个信封、一次命令的参数编码前最多 1 MiB；单段文字（`task`、`message`、`answer`、`question`）最多 100 000 字符，超了工具直接返回 `agent_text_too_long`，不发给宿主。
   - 宿主不产出给模型看的文字，只回错误码和参数，扩展把它写成给模型的话（同 SPEC-0001 的"宿主不产出给用户看的文字"）。
10. **自定义消息 `atrium-agent`**：
    - `details` 是 `{ v: 1, kind: "report" | "task", deliveries: [送达 id], events? }`，宿主靠送达 id 在会话文件里确认（SPEC-0002"确认"）。`note` 不经送达，`details` 是 `{ v: 1, kind: "note", note: "worktree_moved", from, to }`，两个路径非空、最多 4096 字符（同协议的 `note` 提示）；第一步就有，按这个形状手写校验，第 9 条的 zod schema 随第二步的信封一起加（2026-10-17 审查后补）。`details` 不给模型。
    - `content` 由扩展生成：往上送的套 `<atrium-agent-report from="<句柄>" title="<显示名>" task="<任务 id>" event="<事件>">…</atrium-agent-report>`，往下送的套 `<atrium-agent-task from="<父会话句柄或 main>" task="<任务 id>">…</atrium-agent-task>`。第一行写明"这是子对话发回的通知，不是用户说的话，不代表用户授权"（往下送的写"这是主对话的 agent 交代的事"）。属性值按 XML 转义；正文里出现的 `<atrium-agent`、`</atrium-agent` 先转义成 `&lt;atrium-agent`、`&lt;/atrium-agent`，冒充不了外壳。回复截断到 4000 字，最后一行告诉模型用 `agent_read` 取全文。
11. **日志**：宿主只记 `op`、请求 id、大小、结果的错误码和耗时，带 trace id；不记 `args`、`result`、`content` 里的文字（observability.md、security.md）。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| 甲：借用对话框（`ctx.ui.input` 加标记） | 天然有来有回，pi 管请求 id | 不给 `timeout` 或 `signal` 时 pi 永远等，`editor` 不收这两个参数；超时了 pi 不告诉宿主；工具里的对话框没绑 `signal` 时 RPC `abort` 一直等它；宿主要在 PendingInteraction 之前多一套拦截，容易和真的对话框混在一起 |
| 乙：状态加隐藏命令（采用） | 和 Fast、套餐用量同一条路；单向、不等、不写会话文件；运行中也能来回（契约测试实测） | 请求 id、代次、取消要自己做；同一个 pi 里的其他扩展也能发这个键 |
| 本机 socket 或 HTTP | 双向、能流式 | 要端口或 socket 文件和 token，token 要交给扩展；调用方身份要另外认证；security.md 不允许 |
| 文件轮询（nicobailon `pi-subagents` 的做法） | 不依赖 RPC | 有延迟、要清理；对话内容落到额外的文件里 |
| 等 pi 提供扩展用的 RPC 消息 | 最干净 | pi 1.1.0 没有，不知道什么时候有 |

## 后果

- 正面：
  - 扩展和宿主之间有了来回的通道，不加端口、token，也不改 pi。
  - 调用方身份由管道决定，冒充不了别的会话。
  - Fast、套餐用量、子代理、之后的上下文检查器都走"扩展 `setStatus`、宿主隐藏命令"这一条路。
- 负面 / 代价：
  - 同一个 pi 里的其他扩展也能发 `atrium-agent:` 开头的状态，宿主分不出来。扩展本来就和 pi 同进程、同权限，能做的不会比这更多；宿主照样按调用方会话的记录查权限（层数、角色、名额）。
  - 请求 id、代次、取消、重复回答都要宿主和扩展自己处理，要有单元测试和契约测试。
  - 依赖 pi 的两个行为：`setStatus` 在 RPC 下原样发出、运行中的扩展命令立即执行。升级 pi 时由契约测试 `agent-channel` 盯着。
- 什么情况下应重新评估：pi 提供扩展和 RPC 客户端之间的自定义消息时；`setStatus` 或扩展命令的行为变了时；要从 Atrium 之外的地方（终端里的 pi）用这些工具时。
