# 安全基线

> 2026-10-04 定。Atrium 是本机应用，但宿主开着一个本机端口、管理着能执行任意命令的 agent 进程，所以把这些底线写死，实现时逐条落实，并有对应的测试。

## 威胁模型

| 来源 | 风险 |
|---|---|
| 本机浏览器里的任意网页 | 尝试连接宿主的本机端口，冒充客户端发命令（让 agent 执行命令、读文件） |
| 本机其他用户或进程 | 读取 token、日志里的凭据 |
| 模型输出和外部内容 | 回复里的链接、图片、HTML 诱导打开恶意页面或外传信息 |
| agent 本身 | 执行危险命令。MVP 1 不做审批，靠"只在 git 仓库里用、出问题用 git 回滚"缓解（SPEC-0001 风险） |

## WebSocket 与鉴权

- 默认只监听 `127.0.0.1`，随机端口。监听其他地址必须在设置里显式打开（以后远程访问用）。
- token 每次启动随机生成（至少 32 字节），只存在内存里，由 Electron 主进程通过 preload 交给 UI，不写文件、不写日志。
- **token 不放在 URL 里**（会进日志和历史记录）。浏览器的 WebSocket 不能自定义请求头，用 `Sec-WebSocket-Protocol` 传递，或在连接后的第一条消息里鉴权；鉴权通过前不处理任何其他消息，超时断开。
- **校验 `Origin`**：只接受宿主自己提供的页面的来源；其他来源直接拒绝，即使带了 token。
- 每个连接限制单条消息大小和发送速率，超出断开。

## Electron

- 渲染进程：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`webSecurity: true`。
- preload 只通过 `contextBridge` 暴露最小接口（宿主地址、token、少量窗口操作），不暴露 Node 或 IPC 本身。
- 设置内容安全策略（CSP）：脚本只允许本应用；不允许 `eval`；图片和连接按需放开。
- 禁止窗口导航到别的页面（`will-navigate`），禁止新开窗口（`setWindowOpenHandler` 一律拒绝）。
- 外链只允许 `http` / `https`，用 `shell.openExternal` 交给系统浏览器。

## 渲染内容

- 回复的 Markdown 不执行原始 HTML，按文本显示（Streamdown 自带 rehype-harden）。
- 远程图片默认不加载，点击后才加载，防止通过图片地址外传信息。
- 链接一律交给系统浏览器，不在应用内打开。

## 凭据与日志

- API Key 只写进 pi 的 `~/.pi/agent/auth.json`，Atrium 不另存；读 `auth.json` 只取"是否已登录"，不把内容放进内存里的其他结构。
- 日志统一脱敏：token、API Key、OAuth 令牌、`Authorization` 头一律替换；默认不记录提示词、回复、工具参数和输出、文件内容（[observability.md](observability.md#脱敏)）。
- `~/.atrium/` 目录权限 `0700`，其中文件 `0600`。

## 子进程与文件

- 外部命令一律用 `execFile` / `spawn` 传参数数组，不经过 shell，防止命令注入；参数来自用户输入时（分支名、路径）先校验。
- 启动 Node 程序用 `process.execPath`，不通过 `npx` 或 `.bin` 脚本。
- `@` 引用的文件搜索限制在工作区目录内，解析符号链接后仍在目录内才返回。
- 安装 pi 只运行官方安装脚本（`https://pi.dev/install.sh`），地址写死在代码里。

## 测试

每一条都要有测试证明：没有 token、token 错误、来源不对的连接被拒绝；渲染进程里拿不到 Node；导航和新窗口被拦截；日志里搜不到测试时用的 token 和 API Key；`@` 搜索不会返回工作区之外的文件。追踪表里单列"安全"一组。
