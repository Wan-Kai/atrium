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
- token 每次启动随机生成（32 字节，base64url 编码为 43 个字符），只存在内存里，由 Electron 主进程通过进程消息端口交给宿主、通过 preload 交给 UI，不写文件、不写日志。宿主单独运行时用 `ATRIUM_TOKEN` 指定的 token 也必须满足同样的长度和字符集，否则拒绝启动。
- **token 不放在 URL 里**（会进日志和历史记录）。浏览器的 WebSocket 不能自定义请求头，用 `Sec-WebSocket-Protocol` 传递，或在连接后的第一条消息里鉴权；鉴权通过前不处理任何其他消息，超时断开。
- **校验 `Origin`**：带 `Origin` 的请求只接受宿主自己提供的页面（窗口里的 `atrium://app`，以及开发时的 Vite 页面）的来源，其他来源在升级阶段就以 403 拒绝，即使带了 token。不带 `Origin` 的请求放行（仍要 token）：浏览器总会带 `Origin`，不带的只能是本机的非浏览器进程，网页无法伪造这种请求。
- 上限（超出就用协议关闭码断开）：同时最多 32 个连接（4503）；每个连接每秒最多 200 条消息、32 MiB（4429；不低于一个连接能暂存的附件总量，一次拖入 20 张图逐张上传也碰不到，2026-10-10 定）；单条消息最大 1 MiB（WebSocket 1009）。这些上限防的是本机其他进程把宿主拖垮，正常使用远远碰不到。图片附件压缩后逐张上传，同样受单条 1 MiB 的限制；宿主为每个客户端暂存的附件最多 32 MiB、20 张。往客户端发送时，某个连接积压超过 16 MiB 就以 4507 断开它，读得慢的客户端不能让宿主内存无限增长（SPEC-0001"协议细节"）。
- 关闭宿主时先停止监听并断开所有 HTTP 连接（包括只发了一半的升级请求），再断开 WebSocket，关闭期间不会再出现新连接。

## Electron

- 渲染进程：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`webSecurity: true`。
- preload 只通过 `contextBridge` 暴露最小接口（宿主地址和 token、让用户选择文件夹、设置窗口外观；M1.5 起；拖进输入框的文件的路径，用 `webUtils.getPathForFile`，只对用户亲手拖进来的文件有用，M1.7 起；在访达中显示 pi 的位置和日志文件夹，M1.10 起；用默认浏览器打开工作区里的 HTML 文件，2026-10-15 起），不暴露 Node 或 IPC 本身。每个 IPC 处理函数都只回应应用自己页面的来源，外观只接受三个取值，在访达中显示只接受存在的绝对路径；用浏览器打开只接受扩展名是 `.html`、`.htm` 的绝对路径，用 `lstat` 确认是普通文件（不是符号链接、目录），再以 `file://` 地址交给 `shell.openExternal`，路径不记日志。桌面端不知道工作区在哪，工作区的边界由宿主守：界面只在宿主读到了这个文件之后才给"在浏览器打开"（`read_file` 只读工作区里的、路上没有链接的路径），被拒绝的、是链接的不给（2026-10-16 审查后定）。
- 设置内容安全策略（CSP）：脚本只允许本应用；不允许 `eval`；图片允许本应用、`data:`、`blob:` 和 `https:`（回复里的远程图片，见下文"渲染内容"），连接只允许本应用。宿主直接提供的页面（单独运行时）由宿主加响应头；窗口里的页面从 `atrium://app/` 加载（overview.md"桌面端怎么启动宿主"），由 Electron 主进程转发宿主的文件并换上同样的策略，只额外允许连接宿主端口；开发时页面来自 Vite，主进程给它加的策略再额外允许内联脚本（React 热更新需要）。
- `atrium` 协议只转发到宿主的静态文件服务，路径校验和符号链接检查仍由宿主做；宿主的 `Origin` 白名单只多出 `atrium://app` 这一个来源。主进程判断"是不是自己的页面"时比较协议和主机名（`atrium:` 加 `app`），不用 `URL.origin`：Node 对非标准协议给出的 origin 是 `"null"`，所有不透明来源都相等。协议处理器只接受主机名 `app`。
- 网页的权限请求一律拒绝，只有一个例外：应用自己的页面（同上，按协议和主机名比）写剪贴板（`clipboard-sanitized-write`，`navigator.clipboard.writeText`），复制按钮要用（2026-10-20 自用时补：原先连它也拒了，对话区的复制按钮一直没效果，e2e 为了不碰真剪贴板把 `writeText` 换成了假的，没发现）。读剪贴板（`clipboard-read`）照样拒绝，粘贴走输入框自己的 paste 事件，不需要它。
- 禁止窗口导航到别的页面（`will-navigate`），禁止新开窗口（`setWindowOpenHandler` 一律拒绝）。
- 外链只允许 `http` / `https`，用 `shell.openExternal` 交给系统浏览器。
- 本机打包的 Atrium.app（overview.md"桌面端怎么启动宿主"）只做 ad-hoc 签名，没打开 Electron fuses 的加固（关掉 `ELECTRON_RUN_AS_NODE`、命令行调试参数等），留到对外分发时和签名公证一起定（2026-10-11 定）。只在本机用时，能改这个应用的进程本来就能改用户的其他文件；端到端测试还要靠调试参数驱动它。

## 渲染内容

- 回复的 Markdown 不执行原始 HTML，按文本显示（Streamdown 自带 rehype-harden）。
- 回复里的 `https` 远程图片直接显示（2026-10-07 定）。**接受的风险**：模型输出（可能受网页、文件里的提示注入影响）可以把信息编进图片地址，图片一加载就发到对方服务器。为了看图方便接受这一点，限制在：只放开 `https`，`http` 图片不加载、显示成链接；原始 HTML 不渲染，图片只能来自 Markdown 的图片语法。
- 链接一律交给系统浏览器，不在应用内打开。
- PlantUML（2026-10-20）：官方纯 JavaScript 引擎按需加载到专用 module worker，不提供 Node、文件读取、token、客户端或预加载桥；worker 不允许网络、动态脚本和本地文件加载，不自动回退公共服务器。引擎用 worker 内的 XML DOM 构造 SVG、用 OffscreenCanvas 测量文字；这个 XML DOM 没有页面、脚本执行、资源加载或导航能力，不提供真实页面 DOM。标准库、外部 include 和额外主题资源不开放；输入、输出、并发、等待数量和时间上限见 SPEC“回复渲染”，超时或取消时终止 worker。生成的 SVG 当作不可信图片，只用 `blob:` 图片展示，绝不注入页面 DOM；不开放内联链接和外部资源。保持现有 CSP，不增加 `unsafe-eval`、`wasm-unsafe-eval` 或任意外部连接。
- 回复里的本地图片（2026-10-20）：UI 先把工作区内的相对路径、绝对路径或 `file:` URL 化为工作区相对路径，再经现有 `read_file` 读取；宿主原有的越界、符号链接、文件类型和 10 MiB 上限仍是安全边界。工作区外、带 `..`、未知协议和没有工作区时不读取，也不向静态文件服务请求；本地 SVG 不显示。路径和图片内容不记日志。全屏预览只显示已经允许的图片，不增加读文件或导航能力。
- 回复里的文件定位链接（2026-10-20）：只解析显式本地 Markdown 链接与完整的带行号行内代码；原始地址通过惰性属性传给受控组件，仍保留 Markdown 默认 hardener/sanitizer，不允许原始 HTML 冒充本地链接。路径校验和宿主 `read_file` 都守住当前工作区；仅点击才打开，只读定位，不执行文件或命令。没有工作区、越界或不支持的本地地址保持文字，不回退外部导航；文件路径不进日志。
- JSON/CSV 结构化查看（2026-10-20）：不执行脚本、表达式、公式或 HTML，不自动取远端数据或把单元格变为链接。JSON 用保留源码位置的语法树，不经普通对象重建，以免大整数失真、重复属性消失或 `__proto__` 改变对象原型；CSV 只解析逗号与标准引号。输入大小、深度、节点与单元格限额见 SPEC，失败保留原文。来源内容与解析器原始错误不进入日志。
- 消息缩略图（M1.11）用 `data:` 地址显示宿主从会话文件读出的图片，格式只认 png、jpeg、gif、webp，SVG 这类能带脚本的格式宿主不给、协议也不收。读哪个文件由宿主按会话目录决定，客户端只给会话、轮和第几张；图片数据不进日志和链路（SPEC-0001"M1.11 的消息图片"）。

## 凭据与日志

- API Key 只写进 pi 的 `~/.pi/agent/auth.json`，Atrium 不另存；读 `auth.json` 只取"是否已登录"，不把内容放进内存里的其他结构。登录（SPEC-0001"第 2 步"）由登录程序调用 pi 完成，它只向宿主报告每家是否已登录和登录方式，不回传凭据；用户粘贴的 Key 经宿主写进登录程序的标准输入，不进参数、环境和日志，宿主转交后不留副本。登录过程的消息（pi 的提问、授权地址）不进日志。
- 授权地址只接受 `https`，经桌面端的 `shell.openExternal` 交给系统浏览器；测试里换成记录地址的假实现，不打开真浏览器。
- 日志统一脱敏：token、API Key、OAuth 令牌、`Authorization` 头一律替换；默认不记录提示词、回复、工具参数和输出、文件内容（[observability.md](observability.md#脱敏)）。例外：extension 的 `notify` 通知不在界面上显示，原文截断到 4 KB 后照常脱敏写进日志，便于排查 extension（2026-10-09 定）；它可能带出 extension 自己选择输出的内容。脱敏在每行日志写盘前对整行进行，消息里的格式化参数、`Error` 的消息、子 logger 的绑定都覆盖到。
- pi 的 stderr 会逐行进日志，可能带着凭据（例如报错时回显的 Key）。宿主拿到交给 pi 的环境后，把其中名字像凭据的变量（名字含 `key`、`token`、`secret`、`password`、`passwd`、`credential`、`auth`，值至少 8 个字符）的值加入脱敏列表，在记录第一条日志前完成。重新读取登录 shell 的环境后（首次启动装好工具时）列表只增不减：已经在跑的 pi 还拿着旧环境里的 Key（2026-10-11 定）。**没有覆盖的**：pi 自己从 `auth.json` 读的 Key 不在环境里，宿主不读它的内容，所以 pi 回显这类 Key 时日志里拦不住；这是已知缺口，**接受**（2026-10-10 定）：宿主不碰凭据的内容，不为了脱敏去读 `auth.json`。
- `PiRequestError` 的 `message` 只有命令名和原因，pi 的原文（错误文字、stderr 末尾）只放在 `detail`，`detail` 只用于界面上"展开看原始报错"。链路追踪记录异常时只取名字、消息和调用栈，碰不到 `detail`；记日志时只记 `command` 和 `reason`，不把整个错误对象交给 logger（pino 会把 `detail` 一起序列化）。
- `~/.atrium/` 由宿主新建时目录权限 `0700`，日志文件 `0600`。已经存在的目录不改权限（`ATRIUM_HOME` 可能指向 `/tmp` 这类共享目录，改了会影响别人），权限过宽时记一条警告。

## 子进程与文件

- 子进程的环境里没有 token：宿主把登录 shell 的环境交给 pi 时去掉 `ATRIUM_`、`ELECTRON_` 开头的变量，读取登录 shell 时 shell 也只带少数基本变量启动（SPEC-0001"第 1 步"）。这份环境可能含有用户的 API Key，日志里不记录它的内容。
- 设置里的网络代理（SPEC-0001"设置 · pi"）只接受 `http`、`https` 的地址，不能带用户名和密码：它会进 pi 和安装程序的环境，而脱敏只认名字像凭据的变量，`HTTPS_PROXY` 里的密码拦不住。日志只记代理来自设置、登录 shell 还是没有，不记地址。`NO_PROXY` 总带着 `localhost,127.0.0.1,::1`，pi 连本机的服务不经代理（2026-10-11 定）。
- 外部命令一律用 `execFile` / `spawn` 传参数数组，不经过 shell，防止命令注入；参数来自用户输入时（分支名、路径）先校验。
- 在 `PATH` 里找 pi 时跳过相对路径（包括 POSIX 里表示"当前目录"的空项），宿主不会运行恰好位于自己工作目录里的 `pi`。交给 pi（`pi --version` 和 `pi --mode rpc`）的 `PATH` 也去掉相对项：pi 的启动脚本用 `#!/usr/bin/env node` 在 `PATH` 上找 `node`，相对项会让它运行工作目录里的 `node`。
- Atrium 自己的 Node 程序用 `process.execPath` 启动，不通过 `npx` 或 `.bin` 脚本。pi 用找到的绝对路径直接启动（宿主跑在 Electron 里时 `process.execPath` 是 Electron 本身），PATH 取自登录 shell，不经过 shell。git 同样用登录 shell 的 PATH，去掉相对项和空项，仓库里同名的 `git` 不会被执行（2026-10-08 审查后补）；git 超时或取消时连同它拉起的子进程（ssh、凭据助手）一起结束。
- `@` 引用的文件搜索限制在工作区目录内：不接受 `~/`、绝对路径和 `..`，查询词放在 `--` 之后传给 `fd`，不会被当成选项。工作区里的符号链接和 pi 一样跟进去，它指向的内容算工作区的一部分（用户自己放的链接，agent 本来也能经它读到；2026-10-10 定）。
- 工作区改动（SPEC-0001"工作区改动"）跑的 git 命令都是固定参数，不带用户给的路径，ref 写完整名；统计未跟踪文件时只读 `git ls-files` 列出的、工作区里的普通文件：打开时拒绝符号链接（`O_NOFOLLOW`），类型、大小和内容都从同一次打开里取，最多读 1 MB；git 的输出和文件路径不进日志（2026-10-10 定）。
- 归档工作区（SPEC-0001"M1.11 的工作区归档"）只经 `git worktree remove` 删目录，不加 `--force`、宿主自己不递归删除任何东西；目录只取索引里登记的 worktree 路径，不来自客户端，放在 `--` 之后传给 git；本地工作区（项目目录本身）不能归档。删之前宿主当场确认没有未提交的改动、当前提交在某个分支或标签上，所以归档不会丢提交；被 git 忽略的文件随目录删掉，确认框里写明。日志只记工作区 id 和 git 的退出码，不记路径和分支名（2026-10-12 定）。
- 右栏的文件树和查看标签（SPEC-0001"M1.12 的文件与更改"）只读工作区里的东西：`list_dir`、`read_file` 只接受相对路径，各段不能是空、`.`、`..`；路径上的目录不能是符号链接（上级目录的真实路径必须正好是工作区目录拼上这段路径），最后一段打开时不跟随（`O_NOFOLLOW`），链接只报告"是链接"、不读它指向的内容。这比 `@` 搜索严：搜索只给出文件名交给 pi，这里要把内容送到界面上，不让一个链接把工作区外的文件（如 `~/.ssh`）显示出来。类型、大小和内容取自同一次打开；文本最多读 1 MB、图片 10 MB。被忽略的文件用 `git check-ignore --stdin` 认，文件名从标准输入给。日志只记工作区 id 和错误类别，不记路径和内容（2026-10-13 定）。
- pi 普通配置编辑（SPEC-0001“设置 · pi”，2026-10-20）：只接受固定文件名 `settings.json`、`models.json`、`mcp.json`、`keybindings.json`，项目作用域只开放 settings / mcp；全局目录来自宿主交给 pi 的环境，项目目录来自登记的工作区，不接受任意客户端路径。`auth.json`、`mcp-auth.json` 不在白名单；全局 agent 目录来自用户自己的 pi 环境，允许目录与祖先的符号链接，先解析到真实路径再读写并展示；项目 `.pi` 路径仍拒绝符号链接，且项目配置只创建已有工作区下的 `.pi`，不重建已删除的工作区。最终文件一律拒绝符号链接、非普通文件和多硬链接文件，避免配置别名读到凭据。单文件最多 256 KiB UTF-8，打开后限量读取；保存按 pi 的语法校验对象（models 支持行注释与尾逗号，校验忽略 BOM，空 settings 视为对象，原文保留）、比较原文件 SHA-256，同宿主串行受理并用同目录临时文件原子替换（新文件 `0600`）。settings 另持有与 pi 一致的 `proper-lockfile` 锁（`realpath: false`，锁忙立即冲突），从读取当前版本到替换都在锁内，成功和失败都释放；不为兼容锁协议手写过期或续租逻辑。普通配置可能手填密钥，内容只送到配置编辑器，不写入索引、对话、日志、链路和错误文本；文件系统错误映射为稳定错误码，不记录原错误的路径与消息。只保存，不执行配置、不自动重启 pi。
- 子对话分叉到新 worktree（SPEC-0002，M1.15）：临时 pi 写的中间文件放在宿主用 `mkdtemp` 在自己数据目录下的 `tmp/`（`~/.atrium/tmp`，权限 `0700`，一个数据目录只有一个宿主）新建的 `atrium-fork-*` 目录里，目录里写一个标记文件 `.atrium-fork`，写不了就删掉这个目录；子对话的 pi 起好或失败后删掉它，删不掉只记一条不带路径的日志。宿主启动时只删 `tmp/` 里名字带这个前缀、并且有标记文件的目录，别的一概不碰，删完之前不新建（2026-10-17 审查后改：原先放在系统临时目录，两个宿主同时开着时后启动的会删掉前一个正在用的目录）。中间文件是对话内容，不进日志，路径也不记。新 worktree 的分支名来自用户输入，先整理成 `atrium/…` 再交给 git，同新建工作区。
- 停止消息编辑（M1.11 自用，2026-10-20）：正文与图片仍经普通消息和附件通道发送，不放进隐藏命令参数。`/atrium-edit` 只接受严格结构、限长的 base64url JSON（动作、随机操作标识、条目 id 和旧 leaf）；扩展核对当前分支，旧操作不能恢复覆盖后来的消息；宿主必须先确认扩展已加载，再发隐藏命令，避免未知命令成为模型输入。回退和恢复不摘要旧分支，不主动调用模型，旧记录留在原 pi 文件。宿主检查最后一轮、停止状态和 epoch，不信任界面的可编辑标记；仍拒绝伪造隐藏命令。失败日志只记错误码 / 类别，不带正文、图片或隐藏命令参数。
- `/atrium-` 开头的消息留给宿主（SPEC-0002"送达"）：你打的消息、插话、改排队里的消息、新建工作区的第一条消息以它开头时，宿主应答 `command_reserved`，不发给 pi（界面在新建工作区之前就拦下，不先建 worktree）。这样只有宿主能对扩展发隐藏命令（`/atrium-fast`、`/atrium-plan`、`/atrium-agent`），你和粘贴进来的文字冒充不了宿主。隐藏命令的参数是 base64url 的 JSON，扩展读不出就什么都不做；参数里可能有路径，不进日志。会话文件和索引里的子对话数据（`atrium-agent` 消息的路径、父会话 id、名字）超出协议的长度时当作没有，不让一条坏数据带着整份对话记录或会话列表被客户端丢掉。
- agent 开的子对话（SPEC-0002 第二步，M1.15；通道见 ADR-0013）：
  - 2026-10-21 用户明确同意 `explore`、`advise` 默认开放普通 `bash`，以支持 Git 差异、目录、进程等读取和查询；原先白名单不含 Bash。**只读是行为约束，不是技术上的写入隔离**：首件任务提示 Bash 仅用于读取与查询，禁止修改文件及仓库状态、构建、测试、启动服务，需要修改时交给 `work` 子代理；不做命令解析或过滤，普通 Bash 仍可能写入或执行任意程序。不带上下文的由宿主 `--tools` 在 pi 注册表保留 `read,bash,ffgrep,fffind,ls` 及按角色和层数开放的 agent 工具；带上下文的由 Atrium 扩展在 `tool_call` 钩子里按同样的白名单拦，`edit`、`write`、`powershell`、MCP、`codemode` 等仍不可用。`read` 与 Bash 能访问绝对路径，不隔离工作区外的文件。你自己装的扩展和 pi 同进程，能注册同名工具覆盖内置工具、也能写 `atrium-agent:` 状态键冒充 Atrium 的扩展，不在保证之内；宿主按 pi 进程认定调用方，照样按索引里的当前关系和角色核对 agent 操作权限。
  - 2026-10-22 自用选装 pi-fff：所有 agent 开的子对话停用旧独立工具 `grep/find`，搜索只开放 `ffgrep/fffind`；`work`、带上下文、交给终端的参数同样排除旧名，扩展也拦旧名。保留 Bash，不过滤其命令。扩展通过用户级 pi package 安装，和 pi 同权限，不是沙箱；配置独立 frecency/history 数据库，避免默认复用或清理 Neovim 的库；关闭 home 根扫描和跟随目录链接只是缩小范围，外部路径索引仍可用。原生同步调用的取消和多会话重复索引成本仍是试用风险，见 [调研](../research/pi-fff.md)。
  - 交给终端时复制的命令带上工具参数（`--tools`、`--exclude-tools`），终端里扩展不在，这只是建议，你可以删掉；这些参数是工具名，不含凭据和路径。
  - 主 agent 交代的事全文存在子对话的索引记录（`deliveries`）里，pi 写进会话文件、宿主在文件里见到后删掉，只短暂停留；往上送的通知只存引用，回复从子对话的会话文件里读。这些文字是对话内容，不进日志：日志只记送达 id、任务 id、事件种类和字数。
  - 通知和交代给模型时套上标明来源、"不是用户说的话、不代表用户授权"的外壳，冒充外壳的标记先转义（ADR-0013 第 10 条）。子对话的文字只当数据交给父会话的模型，宿主不照它做任何事。
  - 扩展写到状态行的请求有长度上限，读不出的当坏请求回 `agent_bad_request`，不记内容；隐藏命令的参数同样不进日志。
- 宿主提供界面文件时同样解析符号链接，真实路径不在界面目录内就返回 404；先打开文件再读大小，读失败或客户端中途断开都不会影响宿主进程。
- 安装 pi 只运行官方安装脚本（`https://pi.dev/install.sh`），地址写死在代码里。
- **Atrium 自带的 pi 扩展**（ADR-0008）：只加载应用自己带的、随应用签名的文件，路径由宿主算出，不来自客户端或用户输入。它改发往服务商的请求里的 `service_tier`，并查 Codex 的模型列表：在 pi 进程里经 pi 的 `modelRegistry.getApiKeyAndHeaders` 取 ChatGPT 登录的凭据，只发往 pi 平时请求这个模型的地址（登录给的 `baseUrl`，没有就是 `openai-codex` 模型自己的 `baseUrl`）下的 `/codex/models`，走 pi 设好的代理。另外查套餐用量（ADR-0010，2026-10-15 修订）：ChatGPT 登录发往同一地址的根下的 `/wham/usage`（即 `chatgpt.com/backend-api/wham/usage`），Claude 只在订阅登录（`isUsingOAuth`）时发往模型 `baseUrl` 下的 `/api/oauth/usage`，API key 的不查；Grok（`xai`）只在订阅登录时发往写死的 `https://cli-chat-proxy.grok.com/v1/billing?format=credits`，只带 bearer 令牌和 `x-xai-token-auth: xai-grok-cli`、`accept`，不带 pi 给 `api.x.ai` 的其他头，API key 的不查——这是扩展发往 pi 平时不请求的服务器的第一个地址，再加别的要另写 ADR（ADR-0011，2026-10-16）；第二个是联网工具（ADR-0014，2026-10-20）：`web_search`、`web_fetch` 用名为 `DEEPSEEK_SEARCH_API_KEY` 的专用 key，先取 pi 里 `deepseek` 凭据的 `env`（经 `modelRegistry.getApiKeyAndHeaders`，宿主不碰），再取进程环境；不读凭据的 `apiKey` 和 `DEEPSEEK_API_KEY`，搜索与聊天分开计费，发往写死的 `https://api.deepseek.com/v1/tools/search` 和 `/fetch`（不取模型的 `baseUrl`），只带 `authorization`、`content-type`、`accept`，不跟随重定向，网页和搜索结果当数据不当指令；失败只报状态码，不带服务器的原文（DeepSeek 的 401 会回显收到的 key），`query` 和 `url`、网页内容不进日志，扩展不向宿主报任何状态；同一服务商 60 秒内最多一次。Claude 的用量另从回复里读：当前模型是 `claude-bridge` 或 `anthropic` 时，扩展在 `after_provider_response` 里只读 `anthropic-ratelimit-unified-*` 这组响应头，不碰凭据、不发请求（ADR-0012，2026-10-17）。带凭据的请求不跟随重定向（重定向算连不上，2026-10-16 审查后加）。凭据不离开 pi、不交给宿主、不写文件、不记日志；报给宿主的只有模型 id、速度倍数和是否多耗额度，以及套餐名、各窗口的已用百分比、长度、重置时间、按模型窗口的模型名和按产品的拆分（产品名和百分比，M1.14 起），宿主按格式校验后才用；查失败只报原因代码，不带服务器的原文。内部命令 `/atrium-fast`、`/atrium-plan` 只由宿主在确认扩展已加载后发出（2026-10-12 修订）。

## 外部边界登记

2026-10-23 加。上面的散文写的是规则；这里用表格列出生产代码实际碰到的外部边界：发往或显示的地址、读到或交出去的环境变量、宿主发给扩展的隐藏命令。原先这些只散在各节和 SPEC、pi-internals 里，例如宿主每天请求的 `https://pi.dev/api/latest-version` 只写在 SPEC-0001 和 pi-internals 里，审查时要靠人在代码里找一次改动碰了什么。现在由 `pnpm boundary`（`scripts/boundary.mjs`）从代码里列出来和这三张表对照：

- `pnpm boundary [基准]`：列出基准（默认 `git merge-base HEAD main`）以来的提交、未提交的改动和未跟踪的新文件里，依赖的增删改（标出不是精确版本的）、新增和删掉的地址、环境变量、隐藏命令（标出是否已登记）、`PROTOCOL_VERSION` 的变化（`packages/protocol/src/` 的非测试文件改了、版本没变时警告），以及改动文件里 `atrium/side-effects-none` 报的矛盾。新增了未登记的地址、环境变量、隐藏命令，或依赖不是精确版本时退出码为 1。交付汇报里附上它的输出（acceptance.md"交给用户之前"）。
- `pnpm boundary --all`：拿全部生产代码对照这三张表，再查全部依赖是不是精确版本，有缺的退出码为 1；也列出登记了、代码里却找不到的项（只提示）。它接在 `pnpm check` 里。

**生产代码**的范围：`packages/{protocol,pi,host,client,ui}/src` 和 `apps/desktop/src` 下的源文件，不含 `*.test.*`、`*.bench.*`、`test/` 目录和 `packages/pi/src/contract/`（契约场景）；`packages/testkit`、`apps/desktop/e2e`、`scripts/` 和构建脚本不算。

**脚本怎么认**（按语法树，注释和正则字面量都不算）：

- 地址：字符串、模板字符串（`${…}` 记成 `*`）、JSX 文字里 `http://`、`https://`、`ws://`、`wss://` 开头的地址，去掉句末标点。
- 环境变量：环境对象（名字是 `env`、`environment` 或以 `Env` 结尾，如 `process.env`、`options.env`；`import.meta.env` 是 Vite 的构建常量，除外）上按名字取的和解构的；展开了环境对象、作为 `env` 选项或存进环境对象名下的对象字面量的键；全大写带下划线的字符串（以下划线结尾的是前缀，记成 `ATRIUM_*`）；全是全大写名字、至少一个带下划线的字符串数组的每一项。后两种不算 `ERR_` 开头的：那是 Node 的错误码（如 `ERR_STREAM_PREMATURE_CLOSE`），拿来和 `error.code` 比，不是环境变量（2026-10-23 审查后加）；在环境对象上按名字取的照样算。
- 隐藏命令：`registerCommand(…)` 的第一个参数（字符串，或本文件、相对导入的文件里的字符串常量），记成 `/名字`。

表格第一列反引号里的值和脚本找到的按原文精确比对，改表格的格式要同步改脚本。只看代码认不出来的边界（拼出来的地址、按变量名取的环境变量）照样要登记，靠审查发现。拼出来的地址在第一列反引号后面写 `（拼出）`，反引号里用 `<…>` 写出地址的根从哪来：脚本不拿这类行和代码比对，`--all` 也不把它们当成"登记了、代码里找不到"来提示（2026-10-23 审查后加）。

### 出网地址

性质："请求"是 Atrium 的代码真的连过去；"显示"是界面里给你看、点了交给系统浏览器的；"比对"只用来解析或比较，不连。

| 地址 | 性质 | 谁 | 用途 | 出处 |
|---|---|---|---|---|
| `https://pi.dev/api/latest-version` | 请求 | 宿主（`setup/pi-latest.ts`） | 每天查一次 pi 的最新版本；`ATRIUM_PI_LATEST_URL` 可换地址、设为空就不查，pi 的环境里有 `PI_OFFLINE` 时也不查 | SPEC-0001"设置 · pi"、pi-internals |
| `https://pi.dev/install.sh` | 请求 | 宿主（`setup/install-script.ts`）；界面（`setup/install-step.tsx`）显示同一条命令 | 安装 pi 的官方脚本，地址写死 | 本文"子进程与文件" |
| `https://api.deepseek.com/v1/tools/search` | 请求 | Atrium 的 pi 扩展（`pi/src/search`） | `web_search` 联网工具 | ADR-0014，本文"子进程与文件" |
| `https://api.deepseek.com/v1/tools/fetch` | 请求 | Atrium 的 pi 扩展（`pi/src/search`） | `web_fetch` 联网工具 | ADR-0014 |
| `https://cli-chat-proxy.grok.com/v1/billing?format=credits` | 请求 | Atrium 的 pi 扩展（`pi/src/plan`） | Grok 订阅登录时查套餐用量 | ADR-0011 |
| `<ChatGPT 登录的 baseUrl 的根>/codex/models?client_version=*` （拼出） | 请求 | Atrium 的 pi 扩展（`pi/src/fast/extension.ts`） | 查 Codex 的模型列表和速度档；根是 pi 里 ChatGPT（`openai-codex`）登录给的 `baseUrl`，没有就是模型自己的 `baseUrl`，去掉末尾的 `/codex` 或 `/codex/responses`（`extension/credentials.ts` 的 `backendRoot`） | ADR-0008，本文"子进程与文件" |
| `<ChatGPT 登录的 baseUrl 的根>/wham/usage` （拼出） | 请求 | Atrium 的 pi 扩展（`pi/src/plan/extension.ts`） | ChatGPT 登录时查套餐用量（即 `chatgpt.com/backend-api/wham/usage`）；根同上 | ADR-0010 |
| `<Claude 订阅登录的模型 baseUrl>/api/oauth/usage` （拼出） | 请求 | Atrium 的 pi 扩展（`pi/src/plan/extension.ts`） | Claude 只在订阅登录（`isUsingOAuth`）时查套餐用量；根是模型的 `baseUrl`，去掉末尾的 `/` | ADR-0010 |
| `http://127.0.0.1:*` | 请求 | 桌面端主进程（`main/main.ts`）连宿主，`atrium` 协议拼上请求路径转发到这里；宿主（`server/ws-server.ts`）把它当自己的来源 | 本机宿主的地址和 `Origin` 白名单 | 本文"WebSocket 与鉴权" |
| `ws://127.0.0.1:*` | 请求 | 桌面端主进程（`main/main.ts`）写进 CSP 的 `connect-src`；界面（`app/app.tsx`）把宿主地址的 `http` 换成 `ws` 连过去 | 页面只允许连本机宿主 | 本文"Electron" |
| `http://localhost:*` | 比对 | 宿主（`server/ws-server.ts`） | `Origin` 白名单里的另一种写法 | 本文"WebSocket 与鉴权" |
| `http://host.invalid` | 比对 | 宿主（`server/static-files.ts`） | 解析请求路径用的假基准地址，不会连 | — |
| `https://api.openai.com/auth` | 比对 | Atrium 的 pi 扩展（`pi/src/extension/credentials.ts`） | ChatGPT 访问令牌里账号 id 所在的声明名，不是请求地址 | ADR-0008 |
| `https://pi.dev` | 显示 | 界面（欢迎页、设置） | pi 官网链接 | SPEC-0001 |
| `https://nodejs.org/` | 显示 | 界面（`setup/install-step.tsx`） | 缺 Node 时给的下载链接 | SPEC-0001"第 1 步" |
| `http://127.0.0.1:7897` | 显示 | 界面（`settings/proxy-group.tsx`） | 代理地址输入框的示例和报错文字 | SPEC-0001"设置 · pi" |

### 环境变量

| 名字 | 谁读或交给谁 | 用途 | 出处 |
|---|---|---|---|
| `ATRIUM_HOME` | 宿主、桌面端主进程、`pi:try` | Atrium 的数据目录（默认 `~/.atrium`）；桌面端据此把 Electron 的数据分开 | development.md、本文"凭据与日志" |
| `ATRIUM_PORT` | 宿主（单独运行时） | 监听端口，默认随机 | 本文"WebSocket 与鉴权" |
| `ATRIUM_TOKEN` | 宿主（单独运行时） | 指定 token，要满足长度和字符集 | 本文"WebSocket 与鉴权" |
| `ATRIUM_UI_DIR` | 宿主（单独运行时） | 要提供的界面文件目录 | overview.md"桌面端怎么启动宿主" |
| `ATRIUM_PI_LATEST_URL` | 宿主 | 查 pi 最新版本的地址，空就不查（测试不联网） | 见上表 |
| `ATRIUM_DEV_URL` | 桌面端主进程 | 开发时页面来自 Vite 的地址 | development.md `pnpm dev` |
| `ATRIUM_HOST_ENTRY` | 桌面端主进程 | 换一个宿主入口（测试用） | overview.md"桌面端怎么启动宿主" |
| `ATRIUM_APP_METRICS_INTERVAL_MS` | 桌面端主进程 | 进程资源采样间隔（测试用） | testing.md"运行时监控" |
| `ATRIUM_*` | 宿主（`platform/login-shell.ts`）、`pi/src/env/pi-env.ts` | 这个前缀的变量不交给登录 shell 读出的工具环境和 pi | 本文"子进程与文件" |
| `ELECTRON_*` | 同上 | 同上，例如 `ELECTRON_RUN_AS_NODE` | 本文"子进程与文件" |
| `HOME` | 宿主、pi 包 | 登录 shell 启动时带上；找 pi 的配置目录和会话目录 | SPEC-0001"第 1 步" |
| `USER` | 宿主（`platform/login-shell.ts`） | 登录 shell 启动时带上的基本变量 | 同上 |
| `LOGNAME` | 同上 | 同上 | 同上 |
| `SHELL` | 宿主、`pi:try` | 用哪个登录 shell 读环境；登录 shell 启动时带上 | 同上 |
| `TMPDIR` | 宿主（`platform/login-shell.ts`） | 登录 shell 启动时带上的基本变量 | 同上 |
| `LANG` | 同上 | 同上 | 同上 |
| `LC_ALL` | 宿主（登录 shell、git） | 登录 shell 启动时带上；跑 git 时设成 `C`，输出不随语言变 | 同上 |
| `LC_CTYPE` | 宿主（`platform/login-shell.ts`） | 登录 shell 启动时带上的基本变量 | 同上 |
| `SSH_AUTH_SOCK` | 同上 | 同上（git 走 ssh 要用） | 同上 |
| `ZDOTDIR` | 同上 | 同上 | 同上 |
| `__CF_USER_TEXT_ENCODING` | 同上 | 同上 | 同上 |
| `PATH` | 宿主、pi 包 | 登录 shell 启动时带上；找 pi、git、fd、Homebrew，交给 pi 和 git 前去掉相对项 | 本文"子进程与文件" |
| `SHLVL` | 宿主（`platform/login-shell.ts`） | 读出的环境里去掉的 shell 自己的变量 | 同上 |
| `_` | 同上 | 同上 | 同上 |
| `PWD` | 同上 | 同上 | 同上 |
| `OLDPWD` | 同上 | 同上 | 同上 |
| `HTTPS_PROXY` | 宿主（`platform/proxy.ts`）读登录 shell 的、写设置里的交给 pi 和安装程序 | 网络代理 | 本文"子进程与文件" |
| `https_proxy` | 同上 | 同上 | 同上 |
| `HTTP_PROXY` | 同上 | 同上 | 同上 |
| `http_proxy` | 同上 | 同上 | 同上 |
| `NO_PROXY` | 同上 | 不走代理的地址，总带本机地址 | 同上 |
| `no_proxy` | 同上 | 同上 | 同上 |
| `GIT_OPTIONAL_LOCKS` | 宿主（`platform/git.ts`）交给 git | 设成 `0`，查询时不抢仓库的锁 | — |
| `GIT_TERMINAL_PROMPT` | 同上 | 设成 `0`，git 不在终端里问密码 | — |
| `PI_CODING_AGENT_DIR` | pi 包（`env/agent-dir.ts`、`sessions/session-files.ts`） | 照 pi 的规则找它的配置目录 | pi-internals |
| `PI_CODING_AGENT_SESSION_DIR` | pi 包（`sessions/session-files.ts`） | 照 pi 的规则找会话目录 | pi-internals |
| `PI_OFFLINE` | 宿主（`main.ts`）读交给 pi 的环境 | 设了就不查 pi 的最新版本，和 pi 一致 | SPEC-0001"设置 · pi" |
| `DEEPSEEK_SEARCH_API_KEY` | Atrium 的 pi 扩展（`pi/src/search`） | 联网工具的专用 key，先取 pi 凭据的 `env`、再取进程环境；不读 `DEEPSEEK_API_KEY` | ADR-0014 |
| `INIT_CWD` | `pnpm pi:try`（`host/src/dev/try-pi.ts`） | pnpm 给的调用目录，作默认工作目录；只在开发命令里用 | development.md |

只在开发和测试里用的不在生产代码范围内，不登记：`ATRIUM_DEV_PORT`（`scripts/dev.mjs`、界面的 Vite 配置）、`UV_THREADPOOL_SIZE`（测试）、测试场景里的 `GIT_*` 等。

### 隐藏命令

| 命令 | 谁发 | 用途 | 出处 |
|---|---|---|---|
| `/atrium-agent` | 宿主 | 子对话的送达、取消、给模型的说明 | ADR-0013，本文"子进程与文件" |
| `/atrium-fast` | 宿主 | 开关 Fast、查 Codex 的速度档 | ADR-0008 |
| `/atrium-plan` | 宿主 | 查套餐用量 | ADR-0010 |
| `/atrium-edit` | 宿主 | 停止后编辑消息：回退和恢复 | 本文"子进程与文件" |

隐藏命令都由 Atrium 自带的 pi 扩展注册，宿主确认扩展已加载后才发；`/atrium-` 开头的消息留给宿主（见上文"子进程与文件"）。

## 测试

每一条都要有测试证明：没有 token、token 错误、来源不对的连接被拒绝；渲染进程里拿不到 Node；导航和新窗口被拦截；日志里搜不到测试时用的 token 和 API Key；`@` 搜索不会返回工作区之外的文件。追踪表里单列"安全"一组。
