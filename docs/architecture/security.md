# 安全基线

> 2026-10-04 定。Atrium 是本机应用，但宿主开着一个本机端口、管理着能执行任意命令的 agent 进程，所以把这些底线写死，实现时逐条落实，并有对应的测试。

## 威胁模型

| 来源 | 风险 |
|---|---|
| 本机浏览器里的任意网页 | 尝试连接宿主的本机端口，冒充客户端发命令（让 agent 执行命令、读文件） |
| 本机其他用户或进程 | 读取 token、日志里的凭据 |
| 模型输出和外部内容 | 回复里的链接、图片、HTML 诱导打开恶意页面或外传信息 |
| agent 本身 | 执行危险命令。MVP 1 不做审批，靠"只在 git 仓库里用、出问题用 git 回滚"缓解（SPEC-0001 风险） |
| relay 或外层网络被攻破 | 可以拒绝服务、观察时间和密文字节量，不能伪造 Noise 认证的手机、宿主或撤销；宿主不信 relay 的限流 |
| 配对二维码泄露 | 有效期内可发起配对；必须持有一次性 PSK、完成密钥确认，并在 Mac 核对 SAS 后确认才获得会话权限 |
| 已配对手机丢失 | 在 Mac 撤销后立即断开它的全部通道；保存失败仍内存拉黑，重启恢复旧权限的风险须明确提示 |

## WebSocket 与鉴权

- 默认只监听 `127.0.0.1`，随机端口。监听其他地址必须在设置里显式打开。手机的远程访问不靠监听其他地址：宿主主动出站连用户自己的 relay，和手机之间用 Noise IK 端到端加密，设备配对、撤销、宿主长期密钥的存放见下文“宿主远程访问”（[ADR-0016](../adr/0016-remote-access-through-own-relay-with-noise.md)，2026-10-24 定）。
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
- 回复翻译（M1.11 自用后补充）：客户端只指定会话、轮与临时操作 id，宿主从当前分支读取已结束的正文、当前模型和已保存的目标语言。独立 pi 仅获得该正文与翻译要求，不加载项目指令、不提供工具、不续接原会话；正文与语言作为固定非命令前缀后的 JSON 数据走 stdin，避免 print 模式把正文开头的 `/命令` 当作扩展、技能或模板执行。翻译专用禁用 skills/templates，并以显式空 `--append-system-prompt` 覆盖全局和项目 `APPEND_SYSTEM.md`；仍加载服务商扩展，不把用户安装的扩展视为沙箱。正文走标准输入，不进进程参数、日志、链路或磁盘；输出按不可信 Markdown 走既有净化，不放宽 CSP。每连接最多一个翻译，操作 id 只在所属连接可取消；输入 256 KiB、译文 512 KiB UTF-8、执行 60 秒上限。断开与宿主关闭中止进程并释放监听、定时器；只记录安全错误类别。精确模型守卫是唯一生成的翻译专用扩展：宿主在系统临时目录新建私有 `atrium-translation-guard-*` 目录，写 `0600` 文件，只有应用内固定可信代码与 JSON 编码的模型标识，没有正文或凭据；路径不来自客户端。它在 `before_agent_start` 对照注册表精确模型和实际模型，不一致就 abort，不能先调用替代模型再报错。成功、失败和取消后删除，不顺带改变标题调用；真实 pi 契约验证服务商请求为零与文件回收。
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
- worktree 的中英文命名（2026-10-28 自用后补充）：仅将首条消息/子对话名称/agent 首件任务截到 1200 码点作为素材，连同固定分支（如有）编码为固定非命令前缀后的 JSON，经 stdin 给一次性 pi，防止开头 `/` 被当作命令。生成的中文名只存工作区 `alias`，不参与 Git 参数或目录拼接；分支仍经既有清理与 Git 校验。不读取图片、完整历史或源码来起名；日志不含素材、别名、分支或原始回答。命名可取消、关闭时等待清理，不给已有 worktree 回填。
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
- 任务（SPEC-0006）：
  - **新建 worktree 时不执行仓库里能放进命令的东西**：agent 能写共享的 `.git/config` 和 `.git/hooks`，而 `git worktree add` 会跑 `post-checkout` 钩子、fsmonitor 和过滤器。所以 Atrium 新建 worktree（手动、子对话、任务都一样）时：
    - 先查 `git config --local`（开了 `extensions.worktreeConfig` 时再查 `--worktree`）：有 `include.path`、`includeIf.*`，或过滤器名字含 `=`、换行，就拒绝建（`worktree_config_unsafe`）；只查仓库自己的配置，用户全局的 `include` 不管；
    - 带 `-c core.hooksPath=/dev/null -c core.fsmonitor=false`（`/dev/null` 下不会有钩子，不用宿主另备空目录），并把每个已配置过滤器（`git config --list` 读到的全部：仓库的、用户全局的、系统的）的 `smudge`、`clean`、`process` 置空、`required` 设为假；LFS 文件留成指针。只在 `.gitattributes` 里提到而配置里没有的过滤器没有命令，不用管。
    - 建完核对 HEAD 等于固定下来的起点提交，不等就报 `worktree_create_failed`（`head_mismatch`）；
    - 归档后恢复（`restore_workspace`）的 `git worktree add` 同样走这一组参数。
    - 2026-11-04 审查时发现：原先的"新建工作区"会跑这些钩子，是已有的问题，T1 已修（`workspaces/safe-git.ts` 的 `runSafeGit`）。2026-11-05 T4 审查后补：宿主自己的 git 另带 `log.showSignature=false`、`merge.verifySignatures=false`、`commit.gpgsign=false`（不跑仓库配置的 `gpg.program`）；提交里问"有没有暂存"的 `git diff --cached --quiet` 带 `--no-ext-diff --no-textconv`（`diff.external`、`diff.<名>.textconv` 不跑；`-c diff.external=` 清不掉，git 会因"cannot run"报错，所以用选项），且只有退出码 1 算有暂存，其他非零都当出错；提交的每条命令带 `--work-tree=<节点 worktree>` 并先核对 `git rev-parse --show-toplevel` 就是这个目录（节点能靠 `extensions.worktreeConfig` + `core.worktree` 把 git 引去别处），不是就拒绝。其他会执行命令的配置键里，`core.sshCommand`、`credential.helper`、网络类的不在宿主这几条命令的路径上（不 fetch、不 push）；`core.pager`、`core.editor`、`sequence.editor` 在没有终端时不起（`commit -m`，不开编辑器）。2026-11-05 T5 评估：`merge.<名>.driver`（合并驱动）会在合并 `.gitattributes` 里写了 `merge=<名>` 的文件时执行配置里的命令，agent 能写配置和属性文件，所以也关掉：和过滤器一样枚举 `git config --list`（含全局和系统）里的每个驱动，加 `-c merge.<名>.driver=`；实测清空后 git 报 "cannot run" 并把那个文件当冲突，宿主 `merge --abort` 后报 `merge_conflict`，驱动不会跑；名字含 `=` 或换行的驱动带不了，拒绝（`worktree_config_unsafe`，`params.reason: "driver_name"`）。`diff.<名>.textconv`、`diff.external` 不用关：实测 `git merge`（带 diffstat）和 `git merge-tree` 都不跑，宿主的 `git diff` 本来就带 `--no-ext-diff --no-textconv`。T5 发现的原有问题：MergeInspector 的 `git merge-tree --write-tree`（每次工作区扫描都跑）原先会执行合并驱动，现在也走 `runSafeGit`。仍没覆盖的：工作区扫描里直接跑的 `git status` 等不带安全参数，会跑 `core.fsmonitor` 和过滤器的 clean 命令，是 T1 之前就有的缺口，另排。
  - **宿主自己跑的 `git commit` / `git merge`**（节点结束时的提交、验收合并）带同样的 `core.hooksPath`、`core.fsmonitor` 和过滤器置空参数（同一个函数 `runSafeGit`，提交、合并不拒绝带 `include` 的仓库，只拒绝名字带不了的过滤器），不执行 agent 可能放进去的钩子；代价是项目自己的提交钩子不在这些提交上跑。合并参数固定（`git merge --no-ff --no-edit --no-stat -m "Merge branch '<分支>'" -- <提交号>`），合并的是任务 worktree 当前 HEAD 的提交号（正是检查过的那个）而不是分支名，分支名取自 worktree 的 `HEAD`；合并前和合并时的每条 git 命令都带 `--work-tree=<目录>`，并先核对任务 worktree 和主检出目录的 `git rev-parse --show-toplevel` 就是它自己（`core.worktree` 能把 git 引去别处，不符就 `merge_git_failed`）；任务 worktree 或主检出目录不干净、主检出目录不在主干上、项目没有主干，就不合并；冲突时 `git merge --abort`，再核对主检出目录回到合并前的提交且干净，否则不再碰它（`merge_abort_failed`）；不推送。
  - **`.worktreeinclude`**：
    - 只复制既匹配它、又被 git 忽略（`git check-ignore`）的普通文件，从来源目录复制、不软链；
    - 打开时不跟随链接（`O_NOFOLLOW`），跳过 `.git`、`node_modules`；
    - 单文件 10 MiB、总量 64 MiB 或 500 个文件为止（放不下的文件跳过，按路径排序先到先得）；
    - 来源目录里的 `.worktreeinclude` 是链接或不是普通文件时当作没有；目标已有的文件不覆盖；目标路径经过新 worktree 里指向目录外的链接时不写；
    - 复制不成不让建 worktree 失败；路径不进日志，只记跳过的个数。
  - **路径隔离只防明显的越界**（`work`、`check` 节点和 SPEC-0002 的 `work` 子对话；T2 已对 SPEC-0002 的 `work` 子对话生效，节点随 T4）：
    - 开关由宿主在 `--atrium-agent` 里给（`isolated`），只有 agent 开的 `work` 子对话为真；你手动开的子对话、主对话、终端里的 pi 没有；钩子在扩展里（`packages/pi/src/task/path-guard.ts`），宿主不替它判断；任务节点的开关在 `--atrium-task` 里（`isolated`，缺省为真，四种角色都开）；
    - `edit` / `write` 的目标先按 pi `resolveToCwd` 的规则解析（去 `@`、展开 `~`、`file://`、Unicode 空格），再求真实路径（不存在的文件取最深的存在祖先的真实路径，悬空符号链接按它指向的地方算）；
    - 不在工作目录的真实路径下、或第一段是 `.git`（不分大小写），或真实路径算不出来（符号链接成环、没有权限看），就拦下；
    - 命令里 `git -C`、`--git-dir`、`--work-tree`、`GIT_DIR=`、`GIT_WORK_TREE=` 指向工作目录之外也要拦（SPEC-0006；T4a 已做，`packages/pi/src/task/git-guard.ts`，开关同上，任务节点默认就开）：只读命令文本，按 shell 的规则拆成简单命令（引号、反斜杠、`;` `&&` `|`、`$(…)` 和反引号里的命令、`sh -c` / `eval` 的脚本），选项的 `=` 写法和空格写法都认，`-C` 只认 git 子命令之前的（`git commit -C HEAD` 不是），相对路径从 `cd` / `pushd` 之后的目录算，`~`、`$HOME`、`$PWD`、`$(pwd)` 展开，求真实路径（链接指出去的算出去）；`cd` 到工作目录之外之后再跑 git 也拦；路径靠别的变量或命令算出来（`$X`、`$(…)`、`${X:-…}`、`$'…'`、`$@`）、判断不了的一律拦；`builtin cd`、`command cd`、`if cd …`、`{ cd …; }` 都算 `cd`，可能没发生的 `cd`（`&&`、`||`、`|`、`&` 之后，`if`、循环、`case`、`{ }` 里）让"可能所在的目录"变成多个、git 在任何一个里越界都拦，`( )`、`$( )` 里的 `cd` 出了括号就忘；读标准输入的 shell（`bash <<< '…'`、`echo … | sh`、`sh -s`、不带脚本的 `bash`）一律拦；改 git 工作树的也拦：`git config core.worktree`、`extensions.worktreeConfig`、`-c core.worktree=…`、`--config-env=core.worktree=…`、`GIT_CONFIG_KEY_n=core.worktree`、`GIT_CONFIG_PARAMETERS`，`git config` 的 `--file` / `-f` 指向工作目录外、`--global`、`--system`、`--blob`；
    - **拦不住**：`bash` 里的 `cp`、`mv`、`>` 重定向、`sed -i`、脚本里的写入；检查和写入之间路径被换成符号链接（检查时间到使用时间之间的竞争）也拦不住；git 命令也一样不是沙箱：从脚本文件里调用（`bash run.sh`、`make`、`npm run`）、变量分段拼出来的路径、别名或函数、`env -C`、`xargs`、`git` 被改名复制、`GIT_COMMON_DIR` / `GIT_INDEX_FILE` 之类别的环境变量都看不见。用 `echo … >> <git 目录>/config` 之类重定向直接改仓库配置（含 `core.worktree`、`gpg.program`、`diff.external`）也拦不住，所以宿主自己的 git 不信任这些配置（上面"宿主自己的 git"几条是兜底，不是这里的拦截）；`bash run.sh`、`make` 这类带脚本文件的 shell 里的 git 看不见。这不是沙箱。
  - **调用方由宿主认定**：任务扩展的工具调用，宿主按发请求的 pi 进程查出会话，再看会话记录的 `task` 字段：`task_*` 只认这个任务的任务对话，`node_done` / `request_graph_change` 只认这个节点当前那次运行的会话。参数里的身份一律不信，不符应答 `task_caller_invalid`。
  - **拼进契约的文字当数据**：需求摘要、交接摘要、打回原因、`/task` 的范围和来源对话的内容进节点或任务对话的第一条消息时，包进标明来源、"不是用户说的话、不代表用户授权"的外壳，冒充外壳的标记先转义（同 ADR-0013 第 10 条）。
  - **任务对话（T6）**：
    - 它是只读角色：`--tools` 是 SPEC-0002 的只读白名单加它自己的八个工具和 `ask_user`，扩展的 `tool_call` 钩子再拦一遍（没有 `edit`、`write`、`agent_*`）。它的 `bash` 和只读子对话一样不受限（行为约束，不是技术隔离），在项目的主检出目录里；它读到的来源对话、节点的对话和 worktree 的 diff 都是别的模型写的数据，宿主逐页包进 `<atrium-quoted>` 并转义冒充外壳的标记，`/task` 后用户写的范围同理（外壳说明是用户写的范围）。
    - 它通过 `task_send_to_node` 对运行中的节点说话，宿主把话包进 `<atrium-task-note>`（说明不是用户直接说的）；`task_propose_graph` 的图经 GraphValidator，启动后要用户批准才生效；节点的 `task_*` 和任务对话的 `node_done` 一律 `task_caller_invalid`。
    - `/atrium-task mark` 是所有会话都收的隐藏命令（来源对话要写“已转为任务”“已放弃”行），只写一行不调模型的自定义消息，受 `command_reserved` 保护，用户和模型都发不出它。
    - `pnpm task:design` 只读用户的真实会话文件，复制进临时目录、在自己的宿主里跑，原文件前后各算一次哈希核对（SPEC-0006“T6 定下的细节”）；设计那一轮的 `bash` 仍在对话原来的目录里，要完全不碰仓库就用 `--cwd` 指一份副本。
  - **worktree 锁**：任务在用的 worktree 加 `git worktree lock --reason "atrium task <id>"`，归档、清理遇到就停（`workspace_in_task`）；宿主启动时只解原因是 Atrium 任务、且任务已结束的锁，你自己加的锁不动。原因必须整条是 `atrium task <id>`（id 只含字母、数字、`_`、`-`），别的写法一概不认。
  - **审核卡片的裁决由宿主执行**（ADR-0017，T8a）：任务关卡的 `answer_review` 是 `local_only`（手机不能答，手机只收到审核并忽略）；宿主先重算一遍当前有什么审核，裁决只对仍在的那一条有效（别处先答了、状态往前走了都是 `review_closed`），形状不对 `review_invalid`，然后走和列表行内处理同一套业务命令和状态检查；证据（git 事实、改动统计、图的差异）由宿主现算，别人写的话（交接摘要、agent 的说明）只作 `summary` 引用，不带状态；被跟着的任务（T7.1）没有审核。裁决生效后的记录由 `/atrium-task review` 经扩展写进任务对话，内容不进日志。
  - **不进日志**：任务数据（需求摘要、交接摘要、打回原因）存在 `~/.atrium/tasks/`，和会话内容同等对待，不进日志；`/atrium-task` 的参数同样不进日志，它和别的 `/atrium-` 隐藏命令一样受 `command_reserved` 保护。
- 宿主提供界面文件时同样解析符号链接，真实路径不在界面目录内就返回 404；先打开文件再读大小，读失败或客户端中途断开都不会影响宿主进程。
- 安装 pi 只运行官方安装脚本（`https://pi.dev/install.sh`），地址写死在代码里。
- **Atrium 自带的 pi 扩展**（ADR-0008）：只加载应用自己带的、随应用签名的文件，路径由宿主算出，不来自客户端或用户输入。回复翻译的上述临时精确模型守卫是窄例外：应用生成固定可信代码，只有 JSON 编码的模型标识可变，私有目录内创建并随调用回收，不接受用户代码或文件路径。它改发往服务商的请求里的 `service_tier`，并查 Codex 的模型列表：在 pi 进程里经 pi 的 `modelRegistry.getApiKeyAndHeaders` 取 ChatGPT 登录的凭据，只发往 pi 平时请求这个模型的地址（登录给的 `baseUrl`，没有就是 `openai-codex` 模型自己的 `baseUrl`）下的 `/codex/models`，走 pi 设好的代理。另外查套餐用量（ADR-0010，2026-10-15 修订）：ChatGPT 登录发往同一地址的根下的 `/wham/usage`（即 `chatgpt.com/backend-api/wham/usage`），Claude 只在订阅登录（`isUsingOAuth`）时发往模型 `baseUrl` 下的 `/api/oauth/usage`，API key 的不查；Grok（`xai`）只在订阅登录时发往写死的 `https://cli-chat-proxy.grok.com/v1/billing?format=credits`，只带 bearer 令牌和 `x-xai-token-auth: xai-grok-cli`、`accept`，不带 pi 给 `api.x.ai` 的其他头，API key 的不查——这是扩展发往 pi 平时不请求的服务器的第一个地址，再加别的要另写 ADR（ADR-0011，2026-10-16）；第二个是联网工具（ADR-0014，2026-10-20）：`web_search`、`web_fetch` 用名为 `DEEPSEEK_SEARCH_API_KEY` 的专用 key，先取 pi 里 `deepseek` 凭据的 `env`（经 `modelRegistry.getApiKeyAndHeaders`，宿主不碰），再取进程环境；不读凭据的 `apiKey` 和 `DEEPSEEK_API_KEY`，搜索与聊天分开计费，发往写死的 `https://api.deepseek.com/v1/tools/search` 和 `/fetch`（不取模型的 `baseUrl`），只带 `authorization`、`content-type`、`accept`，不跟随重定向，网页和搜索结果当数据不当指令；失败只报状态码，不带服务器的原文（DeepSeek 的 401 会回显收到的 key），`query` 和 `url`、网页内容不进日志，扩展不向宿主报任何状态；同一服务商 60 秒内最多一次。Claude 的用量另从回复里读：当前模型是 `claude-bridge` 或 `anthropic` 时，扩展在 `after_provider_response` 里只读 `anthropic-ratelimit-unified-*` 这组响应头，不碰凭据、不发请求（ADR-0012，2026-10-17）。带凭据的请求不跟随重定向（重定向算连不上，2026-10-16 审查后加）。凭据不离开 pi、不交给宿主、不写文件、不记日志；报给宿主的只有模型 id、速度倍数和是否多耗额度，以及套餐名、各窗口的已用百分比、长度、重置时间、按模型窗口的模型名和按产品的拆分（产品名和百分比，M1.14 起），宿主按格式校验后才用；查失败只报原因代码，不带服务器的原文。内部命令 `/atrium-fast`、`/atrium-plan` 只由宿主在确认扩展已加载后发出（2026-10-12 修订）。

## 宿主远程访问

MP3a，协议见 [SPEC-0005](../specs/0005-mobile-app-and-remote-access.md)。远程能力默认关闭；独立宿主没有 Electron 保险箱时不可用。本机监听仍只在 loopback，不增加公网入口。

- `remote-crypto` 只实现 IK/IKpsk2，不协商其他模式、不压缩；配对码五分钟、密钥确认后等待 Mac 两分钟。错码、错版本、认证失败、畸形帧、超限分块均不降级。
- 宿主独立限制四条未完成握手的流、十秒握手时限、每设备两条通道；单帧 70 KiB、上行消息 1 MiB、下行 8 MiB。通道与本机共用 32 连接总上限、发送背压及断线清理。每台手机单独一条 relay 数据连接。
- 远程 `hello` 必须不带本机 token，`clientId` 必须是 Noise 公钥认出的 `deviceId`。来源和设备 id 只由宿主写入；命令白名单、事件过滤穷举协议全集，远程不能操作配对、保险箱、登录和安装。`remote_updated` 只发给主动订阅的本机连接。
- 长期私钥、relay 令牌、设备公钥及名称只存于 `remote/vault.bin`：主进程用异步 `safeStorage` 加密，0700 目录、0600 临时文件后原子改名；宿主经带 id/version 的进程端口读写，渲染进程没有保险箱 IPC。`remote.json` 只放开关及最后在线时间。未启用时不自动读钥匙串；显式设置 relay、测试连接、重置才会读取，读取等待不阻塞本机服务。
- 读取必须明确返回版本与内容；缺字段、不可解码或重复的设备身份、损坏内容都 fail-closed，不自动换身份。缺文件才可首次生成；恢复损坏必须由本机显式重置。两侧写队列失败后可以继续重试，不将超限请求静默丢掉。仅落盘成功才授予配对权限或替换身份。
- 撤销先拉黑、关闭已有通道再写盘；确认配对写盘期间发生的后来撤销优先，不能由写盘回调重新放行。重置先写新身份再撤销全部通道。relay 传来的关闭码不能作为已认证撤销。
- TLS 默认用于远程 relay，只有 localhost、127.0.0.1、[::1] 用明文 WebSocket 供本机测试。解析时验证 URL 和端口；令牌只在控制/数据连接的首帧发送，不放 URL，不跟随重定向。临时连接测试可取消，不能在启用后认证并挤掉正式连接。
- **固定版本的解密失败分类**：Electron 44.5.1 的 `OnOsCryptReady` 无条件令 async availability 为 true；Chromium 152.0.7977.130 的 KeychainKeyProvider 在密码不可用时返回 temporarily unavailable，而 Encryptor 保留此状态。`decryptStringAsync` 只给不同 Error 消息，没有可用的结构化 code。主进程仅把精确的一般 ciphertext 失败消息和成功解密后的格式失败归为 `corrupt`；“暂时不可用”和所有未知拒绝均为 `keychain_unavailable`，清除已知版本为 null，禁止绕过重读来覆盖原文件。`corrupt` 也可能是密钥不匹配，不宣称确定磁盘损坏。原文不外传、不记日志；不加宽松 includes 匹配或额外加密探测。依据：[Electron v44.5.1 原生实现](https://github.com/electron/electron/blob/v44.5.1/shell/browser/api/electron_api_safe_storage.cc)、[该版本 DEPS](https://github.com/electron/electron/blob/v44.5.1/DEPS)、[Chromium KeychainKeyProvider](https://chromium.googlesource.com/chromium/src/+/152.0.7977.130/components/os_crypt/async/browser/keychain_key_provider.mm)、[Encryptor](https://chromium.googlesource.com/chromium/src/+/152.0.7977.130/components/os_crypt/async/common/encryptor.cc)。测试锁定 Electron 44.5.1 以要求升级时重新审阅消息合同；这些是静态证据及模拟回归，不是操作真实钥匙串后的平台实测，亦未证实授权拒绝已造成实际覆盖。
- safeStorage 的防护边界不变：能修改 ad-hoc 签名应用或同用户进程内存的攻击者不在保证之内。relay 可拒绝服务，已认证手机可使用白名单内能力；本机工具执行仍沿用 MVP 1 的风险模型。

## relay

2026-10-25 MP2 定，`apps/relay`，协议见 [SPEC-0005 · relay 的线路协议](../specs/0005-mobile-app-and-remote-access.md#relay-的线路协议appsrelay)。relay 跑在用户的 VPS 上，按"可能被攻破"设计：它只转发 Noise 密文，看不到对话和凭据；被攻破的后果是手机连不上（SPEC-0005"安全"）。它自己守的是"别人冒充不了宿主连上来、拖不垮它、日志里没有秘密"：

- **宿主令牌**：32 字节随机数，`add-host` / `rotate-host` 只往标准输出打印一次那一行，不进日志、不落盘；`hosts.json` 只存 SHA-256（文件 `0600`，原子写入）。比对用 `timingSafeEqual`，`hostId` 不存在时拿一个固定的哈希照样比一次。换令牌、删宿主后，正在跑的 relay 在 2 秒内发现，立刻以 4401 关掉这个宿主的控制连接和它的流。
- **日志**：只记元数据（`hostId`、`streamId`、IP 的加盐哈希、字节数、关闭码、时长）。不记载荷、`hello` 帧、令牌、查询串和原始 IP；盐每次启动随机生成、不落盘。没认证的连接发来的 `hostId` 不符合 `hst_<16hex>` 时不记。日志写在数据目录的 `logs/`（文件 `0600`），按天一个文件，留 14 天。
- **上限**：见 SPEC；都由 relay 自己守，宿主另有自己的上限（不信 relay）。WebSocket 不开压缩（`perMessageDeflate: false`）；HTTP 请求头 10 秒内要收齐。
- **真实 IP**：只信 `trustedProxies` 里的地址给的 `X-Forwarded-For` / `X-Real-IP`，别的连接的这两个头一概不看，伪造不了 IP 绕开按 IP 的限速。用户的部署里拿不到真实 IP，按 IP 的限速退化成全局的（SPEC-0005"部署 relay"第 3 条）。
- **部署**：只监听本机地址，TLS 由前面的反代终止；Docker 镜像以 `node` 用户（非 root）运行，示例里根文件系统只读、去掉全部 capability、`no-new-privileges`，端口只发布到 `127.0.0.1`；数据目录只挂这一个。

## 外部边界登记

2026-10-23 加。上面的散文写的是规则；这里用表格列出生产代码实际碰到的外部边界：发往或显示的地址、读到或交出去的环境变量、宿主发给扩展的隐藏命令。原先这些只散在各节和 SPEC、pi-internals 里，例如宿主每天请求的 `https://pi.dev/api/latest-version` 只写在 SPEC-0001 和 pi-internals 里，审查时要靠人在代码里找一次改动碰了什么。现在由 `pnpm boundary`（`scripts/boundary.mjs`）从代码里列出来和这三张表对照：

- `pnpm boundary [基准]`：列出基准（默认 `git merge-base HEAD main`）以来的提交、未提交的改动和未跟踪的新文件里，依赖的增删改（标出不是精确版本的）、新增和删掉的地址、环境变量、隐藏命令（标出是否已登记）、`PROTOCOL_VERSION` 的变化（`packages/protocol/src/` 的非测试文件改了、版本没变时警告），以及改动文件里 `atrium/side-effects-none` 报的矛盾。新增了未登记的地址、环境变量、隐藏命令，或依赖不是精确版本时退出码为 1。交付汇报里附上它的输出（acceptance.md"交给用户之前"）。
- `pnpm boundary --all`：拿全部生产代码对照这三张表，再查全部依赖是不是精确版本，有缺的退出码为 1；也列出登记了、代码里却找不到的项（只提示）。它接在 `pnpm check` 里。

**生产代码**的范围：`packages/{protocol,pi,host,client,ui,remote-crypto}/src`、`apps/desktop/src` 和 `apps/relay/src`（2026-10-25 加）下的源文件，不含 `*.test.*`、`*.bench.*`、`test/` 目录和 `packages/pi/src/contract/`（契约场景）；`packages/testkit`、`apps/desktop/e2e`、`scripts/` 和构建脚本不算。

**脚本怎么认**（按语法树，注释和正则字面量都不算）：

- 地址：字符串、模板字符串（`${…}` 记成 `*`）、JSX 文字里 `http://`、`https://`、`ws://`、`wss://` 开头的地址，去掉句末标点。
- 环境变量：环境对象（名字是 `env`、`environment` 或以 `Env` 结尾，如 `process.env`、`options.env`；`import.meta.env` 是 Vite 的构建常量，除外）上按名字取的和解构的；展开了环境对象、作为 `env` 选项或存进环境对象名下的对象字面量的键；全大写带下划线的字符串（以下划线结尾的是前缀，记成 `ATRIUM_*`）；全是全大写名字、至少一个带下划线的字符串数组的每一项。后两种不算 `ERR_` 开头的：那是 Node 的错误码（如 `ERR_STREAM_PREMATURE_CLOSE`），拿来和 `error.code` 比，不是环境变量（2026-10-23 审查后加）。MP3a 的 relay 诊断还精确排除这些 Node 错误码字符串：`CERT_HAS_EXPIRED`、`CERT_NOT_YET_VALID`、`CERT_SIGNATURE_FAILURE`、`DEPTH_ZERO_SELF_SIGNED_CERT`、`SELF_SIGNED_CERT_IN_CHAIN`、`UNABLE_TO_GET_ISSUER_CERT`、`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`、`UNABLE_TO_VERIFY_LEAF_SIGNATURE`、`EAI_AGAIN`、`EAI_FAIL`，以及用于匹配 HTTP 解析错误的字面量 `HPE_`（原先会记成 `HPE_*`）；不按 `CERT_`、`EAI_` 或 `HPE_` 前缀豁免其他名字。在环境对象上按名字取、解构或作为环境对象字面量键的照样算，包括这些错误码名字。
- 隐藏命令：`registerCommand(…)` 的第一个参数（字符串，或本文件、相对导入的文件里的字符串常量），记成 `/名字`。

表格第一列反引号里的值和脚本找到的按原文精确比对，改表格的格式要同步改脚本。只看代码认不出来的边界（拼出来的地址、按变量名取的环境变量）照样要登记，靠审查发现。拼出来的地址在第一列反引号后面写 `（拼出）`，反引号里用 `<…>` 写出地址的根从哪来：脚本不拿这类行和代码比对，`--all` 也不把它们当成"登记了、代码里找不到"来提示（2026-10-23 审查后加）。

### 加密依赖

`packages/remote-crypto` 精确依赖 `@noble/ciphers@2.4.0`（ChaCha20-Poly1305）、`@noble/curves@2.4.0`（X25519）、`@noble/hashes@2.4.0`（SHA-256/HMAC）。无动态下载；公开 cacophony 向量、TS/Swift 字节级夹具和畸形消息测试约束手写的两种 Noise 状态机。

### 出网地址

性质："请求"是 Atrium 的代码真的连过去；"显示"是界面里给你看、点了交给系统浏览器的；"比对"只用来解析或比较，不连。

| 地址 | 性质 | 谁 | 用途 | 出处 |
|---|---|---|---|---|
| `<用户 relay 地址>/v1/host` （拼出） | 请求 | 宿主 `remote/relay-link.ts` | 控制连接及可取消的连接测试；默认 wss，仅 loopback 用 ws | SPEC-0005、本文“宿主远程访问” |
| `<用户 relay 地址>/v1/host/stream` （拼出） | 请求 | 宿主 `remote/channel.ts` | 每手机独立的 Noise 数据连接，令牌只进首帧 | SPEC-0005 |
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
| `http://relay.invalid` | 比对 | relay（`relay.ts`） | 解析请求路径和 `?host=` 用的假基准地址，不会连 | — |
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
| `ATRIUM_FOLLOW_TASKS` | 桌面端主进程（`!app.isPackaged` 时才读）、单独运行的宿主（`entry.ts`） | 开发用：宿主只读地跟着 `pnpm task:try` 的任务目录（`<home>/tasks`），不写、不跑、不起 pi。打包版的桌面端不读它，Electron 里的宿主只收主进程交来的值，所以打包版设了也没用。目录等于 Atrium 自己的任务目录时宿主拒绝 | SPEC-0006"T7.1 定下的细节"、development.md"task:try 与 Atrium" |
| `ATRIUM_APP_METRICS_INTERVAL_MS` | 桌面端主进程 | 进程资源采样间隔（测试用） | testing.md"运行时监控" |
| `ATRIUM_RELAY_DIR` | relay（`cli.ts`） | 数据目录（`relay.json`、`hosts.json`、`logs/`），默认当前目录；Docker 镜像里是 `/data`，`--dir` 优先 | SPEC-0005"部署 relay" |
| `ATRIUM_RELAY_LISTEN` | relay（`cli.ts`） | 监听地址，默认 `127.0.0.1:8787`；Docker 镜像里是 `0.0.0.0:8787`（端口只发布到宿主机的 127.0.0.1），`--listen` 优先 | SPEC-0005"部署 relay"、本文"relay" |
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
| `/atrium-task` | 宿主 | 任务：回答节点和任务对话的工具调用、写进度行、写来源对话的“已转为任务”行（`mark`）、写审核裁决的记录（`review`）、提醒调用 `node_done` | SPEC-0006，本文"子进程与文件" |

隐藏命令都由 Atrium 自带的 pi 扩展注册，宿主确认扩展已加载后才发；`/atrium-` 开头的消息留给宿主（见上文"子进程与文件"）。

### 手机端界面与渲染零件（MP5 / MP6，2026-10-26）

此表补充 Swift 的边界；当前 `pnpm boundary` 只扫描 TS，不能代替对 Swift 的审查。

| 边界 | 用途与约束 |
|---|---|
| `https://github.com/swiftlang/swift-markdown.git`，精确 `0.9.0` | 构建期下载的 Markdown 解析器，Apache-2.0 + Runtime Library Exception；swift-cmark `0.9.0`（BSD-2 / MIT）由 `apps/ios/AtriumKit/Package.resolved` 锁定。运行时不联网 |
| `@highlightjs/cdn-assets@11.11.1` 的 `highlight.min.js` | 原版常用语言 bundle，BSD-3-Clause，来源/许可证随 AtriumRender 资源打包。SHA-256 `c4a399dd6f488bc97a3546e3476747b3e714c99c57b9473154c6fb8d259b9381`。JavaScriptCore actor 只执行这个受信任的本地脚本；用户代码作为字符串参数，不拼接执行；无网络/文件桥，不使用 WebView/HTML importer；超 128 KiB 保留无高亮原文 |
| Markdown 链接与 HTML | 只让 http/https 链接成为可打开链接；javascript、file、data、自定义 scheme 只保留文字。HTML、图表源码不执行；图片仅 alt，不自动出网 |
| `ATRIUM_GALLERY` | App 的 `#if DEBUG` 专用组件陈列页入口，值为陈列页名称；Release 不读。XCUITest 通过 `launchEnvironment` 设置，不承载用户数据 |
| `TEST_RUNNER_ATRIUM_TIMELINE_BENCH` → `ATRIUM_TIMELINE_BENCH` | 测试 runner 的定向时间线基准开关，跳过图库截图矩阵；Debug只记录帧/runloop区间和行构建计数，不记录真实内容 |
| `TEST_RUNNER_ATRIUM_GALLERY_SHOTS` → `ATRIUM_GALLERY_SHOTS` | 测试 runner 的截图/模拟器帧间隔基准开关；只作用于 XCUITest，不进生产行为 |

选型与尚未验证的性能边界见 [mobile-render.md](../research/mobile-render.md)。

## 测试

每一条都要有测试证明：没有 token、token 错误、来源不对的连接被拒绝；渲染进程里拿不到 Node；导航和新窗口被拦截；日志里搜不到测试时用的 token 和 API Key；`@` 搜索不会返回工作区之外的文件。追踪表里单列"安全"一组。
