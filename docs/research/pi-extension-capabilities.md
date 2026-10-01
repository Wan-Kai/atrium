# pi extension 的能力边界

> 依据：pi 主干 `9d1a650`（2026-09-29）的 [`docs/extensions.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)、[`docs/rpc-extension-ui.md`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md) 和 [`src/core/extensions/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts)。pi 迭代快，对不上时以源码为准。

一句话：extension 能在 agent loop 的每个关键节点看到并改写数据，但改不了 loop 本身的结构；在 RPC 模式下，它把数据传给宿主的通道很窄。

## 运行模式

pi 有四种 CLI 模式，另外还可以通过 SDK 嵌入。它们用的是同一套 agent、会话、工具和 extension，区别在于输入从哪来、输出到哪去、进程活多久。

| 方式 | 启动 | 输入 / 输出 | 生命周期 | 用途 |
|---|---|---|---|---|
| 交互模式（默认） | `pi` | 终端界面 | 直到用户退出 | 人直接使用 |
| print | `pi -p "..."` | 只输出最终回复文本 | 跑完即退出 | 脚本、管道 |
| JSON | `pi --mode json "..."` | 以 JSONL 输出事件流 | 跑完即退出 | 需要过程数据的一次性任务 |
| RPC | `pi --mode rpc` | stdin 收 JSONL 命令，stdout 回响应和事件 | 常驻 | 其他程序双向控制 pi（Atrium 采用） |
| SDK | `createAgentSession()` | 直接调用 TypeScript API | 跟随宿主进程 | 把 pi 嵌进自己的 Node 进程 |

## extension 在不同方式下的差异

loop 钩子、工具、命令、provider、MCP 在所有方式下都一样可用。差异只在 UI，以及 extension 和外部通信的通道：

| 能力 | 交互模式 | RPC | JSON / print | SDK |
|---|---|---|---|---|
| loop 钩子、工具、provider、MCP | ✓ | ✓ | ✓ | ✓（codemode、tool_search、MCP 需手动加载） |
| `/` 命令 | ✓ | ✓（通过 `prompt` 发 `/名称`） | ✓ | ✓ |
| 快捷键 | ✓ | ✗ | ✗ | 宿主自己实现 |
| 对话框（`select` / `confirm` / `input` / `editor`） | ✓ | ✓ 转发给客户端 | ✗ | 宿主传入自己的 `uiContext` 实现 |
| 单向 UI（`notify`、`setStatus`、`setWidget`、`setTitle`） | ✓ | ✓ 转发给客户端（`setWidget` 只能传字符串数组） | ✗ | 同上 |
| 自定义终端组件（`custom()`）、消息渲染器 | ✓ | ✗ | ✗ | 接口按终端组件设计，React 用不上 |
| `pi.events`（extension 间的事件总线） | 进程内 | 进程内，客户端收不到 | 进程内 | 宿主可以传入自己的 `eventBus` 直接监听 |

## 输入：extension 能看到什么

- **事件**：`pi.on()` 覆盖 loop 的每个阶段，见下一节。
- **主动查询**：`ctx` 上的工作目录、模型、推理强度、上下文用量、当前系统提示词；`sessionManager` 只读，但能读到整棵会话树，包括被放弃的分支；`pi` 上的工具列表（含 annotations）、设置、CLI flag。
- **用户**：命令、快捷键、flag 调用 extension；extension 也可以用 `ctx.ui` 的对话框主动要输入。
- **整个系统**：它就是 pi 进程里的一段 Node 代码，文件、网络、子进程都可以用。

## 输出一：沿 loop 拦截和改写

| 阶段 | 事件 | 拿到什么 | 能改什么 |
|---|---|---|---|
| 用户输入 | `input` | 文本、图片 | 放行 / 改写 / 吞掉 |
| | `user_bash` | 用户 `!` 执行的命令 | 接管执行 |
| 运行开始前 | `before_agent_start` | prompt、图片、系统提示词及其分段 | 修改分段 / 注入自定义消息 / 替换整个系统提示词 |
| 组装请求 | `context` / `context_with_system` | 本次请求的消息列表 | 返回新列表，**只影响本次请求，不改会话记录** |
| 发请求 | `before_provider_request` | 原始 payload | 替换 payload |
| | `before_provider_headers` | 请求头 | 修改请求头 |
| 流式返回 | `provider_stream_event`、`message_update` | 原始流事件、增量 | 只读 |
| 消息定稿 | `message_end` | 完整消息 | 替换（角色不变） |
| 工具调用前 | `tool_call` | 工具名、参数 | 修改参数 / 阻止并说明原因 / 终止 |
| 工具执行中 | `tool_execution_start/update/end` | 进度、结果 | 只读 |
| 工具结果 | `tool_result` | 结果 | 修改 `content`、`details`、`structuredContent`、`isError`、`usage` |
| 一轮结束 | `turn_end`、`agent_before_settle` | 本轮消息、上下文预览 | 追加条目（自定义数据、自定义消息、上下文编辑、压缩），并可要求再跑一轮 |
| 结束 | `agent_end`、`agent_settled` | 最终结果 | 只读 |
| 会话操作 | `session_before_switch/fork/tree/compact` | 操作参数 | 取消；压缩时提供自己的结果；切换分支时提供摘要 |
| 其他 | `resources_discover` / `cache_warming_decision` | — | 追加 skill、prompt、主题路径 / 决定是否保持 prompt cache |

其余事件（`session_start`、`session_shutdown`、`model_select` 等）只做通知。

## 输出二：注册新能力

- **工具**：`content` 给模型，`details` 给渲染和状态重建；`exposure` 控制模型能否直接看到；`annotations` 声明只读、破坏性等；工具内可以用 `ctx.executeTool` 调用其他工具。
- **命令、快捷键、CLI flag**。
- **模型服务商、虚拟模型（按请求路由）、MCP server**。
- **消息和条目渲染器**：只在终端界面生效。

## 输出三：主动操作

| 类别 | 操作 |
|---|---|
| 说话 | `sendUserMessage`（以用户身份，可插到运行中或排到运行后）；`sendMessage`（自定义消息，进上下文，可触发新一轮） |
| 存数据 | `appendEntry`：写进会话文件，不进上下文 |
| 改设置 | 可用工具集、模型、推理强度、会话名、条目标签 |
| 控制运行 | `compact`、`abort`、`shutdown`；`streamSimple` 发起嵌套模型调用 |
| 操作会话 | 新建、分叉、在会话树中切换、切换会话、重新加载（只能在命令里调用） |
| 协作 | `pi.events` 与其他 extension 通信 |

## 做不到什么

1. 改不了 loop 结构，只能在上述节点介入；要多跑一轮，只能在一轮结束时请求。
2. 流式输出不能中途改，只能在 `message_end` 整条替换。
3. `context` 的改写只对当次请求有效；要持久生效，得在一轮结束时追加上下文编辑条目。
4. 同一条回复里的工具调用可能并行，不能假设兄弟调用的结果已经存在。
5. 会话操作只能在命令里调用，在事件处理函数里调用会死锁。
6. 没有安全边界，权限等同 pi 进程。

## RPC 模式下 extension 到宿主的通道

| 通道 | 适合传什么 |
|---|---|
| `tool_execution_end` 的 `result.details` | 工具的结构化数据，驱动插件视图（[ADR-0003](../adr/0003-plugin-as-pi-package.md)） |
| `entry_appended` 事件（`appendEntry`） | 需要持久化、但不进上下文的数据 |
| 消息事件里的自定义消息（`sendMessage`） | 需要进上下文的数据 |
| `extension_ui_request` 对话框 | 审批、选择 |
| `extension_ui_request` 单向调用 | 轻量状态 |
| `extension_error` | extension 报错 |
| 宿主主动调用 `get_entries` / `get_tree` | 整棵会话树 |

**缺口**：没有通用的"extension 给宿主发自定义事件"的通道，`pi.events` 只在 pi 进程内有效。loop devtools、上下文检查器需要高频地把每轮上下文和钩子事件传出来，用 `appendEntry` 会让会话文件膨胀。可选的做法：

- 借用现有通道（Paseo 的做法）：宿主注入一个 extension，extension 用 `ctx.ui.notify` 发带固定标记前缀的 JSON 给宿主；宿主通过 `prompt` 发 `/内部命令 <base64 参数>` 调用 extension。不需要额外通道，但依赖通知被原样转发，数据和真正的通知混在一起；
- extension 自己和宿主之间开一条旁路（如 unix socket）；
- 改用 SDK 嵌入，宿主传入自己的 `eventBus` 直接监听。这会动摇 [ADR-0002](../adr/0002-connect-pi-via-rpc-subprocess.md) 的进程隔离。

做到上下文检查器时，写 ADR 决定。
