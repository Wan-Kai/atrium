# 内置终端：T3 Code、Orca、herdr 怎么做，以及 Atrium 的选择

2026-11-12。用户提出"想在 Atrium 里内置一个终端工具"，先调研同类方案。本文是外部项目分析，参考性质，不约束实现；结论落在"对 Atrium 的结论"一节：三个方案、已定的四条和实测结果。

Atrium 现在的终端能力只有两条：pi 自己的 Bash（宿主起的子进程，无 TTY，输出进对话），以及标签栏"在终端中打开"（把目录交给外部 cmux 或系统终端，Atrium 不管生命周期）。[external-terminal.md](../architecture/external-terminal.md) 当时明确写了"不提供内嵌终端、PTY owner、VT/xterm 中继"，这份调研正是要重新评估那条界线。

## 一句话结论

三个项目都把 PTY 放在**界面之外**、界面只是 attach 上去的客户端；差别在谁拥有 PTY、渲染用哪套 VT、历史怎么留。Atrium 的宿主本来就是独立的 Node 进程（`utilityProcess.fork`，不依赖 Electron），是最顺的 PTY owner 位置；原本最担心的"node-pty 是原生模块、和单文件打包冲突"已经实测掉：N-API 预编译包 412 KiB，在打包的 Electron 里直接能用。

## T3 Code

源码：[pingdotgg/t3code](https://github.com/pingdotgg/t3code)（MIT，TypeScript/Effect）。架构文档 `docs/internals/terminal-runtime.md` 只有一页，但把取舍写得最清楚。

| 维度 | 做法 |
| --- | --- |
| PTY 归属 | 环境服务端（`apps/server`，Node）拥有 PTY、会话生命周期、保留的输出。**包括桌面渲染进程在内，所有客户端都通过同一条已认证连接 attach**，所以客户端能重连、能共享同一个运行中的会话；渲染器的选择是各客户端自己的事，不改变终端的契约 |
| PTY 实现 | node-pty（`patches/node-pty@1.2.0-beta.15.patch`），外面包一个 `PtyAdapter` 接口（`packages/shared/src/PtyAdapter.ts`），服务端实现是 `apps/server/src/terminal/NodePtyAdapter.ts`；里面有 Windows 等 pid 就绪、`spawn-helper` 补 `chmod 755` 这类脏活 |
| 历史 | 增量存（`Manager.ts`）：实时事件只带新增块；上限 **5000 行 / 8 MiB UTF-8**，淘汰不切开 Unicode 码点，实时输出不截断；客户端缓冲另有 **512 KiB** 上限；落盘 250 ms 去抖、按 key 合并；恢复只读有界尾巴，读之前关掉句柄再重写 |
| 重放的副作用 | 重放历史绝不能把终端应答写回当前 shell：服务端**从保留的历史里剥掉查询/响应流量**，网页渲染端**重放期间断开自己的 PTY writer**。两条都保留才安全 |
| 传输 | 一条 WebSocket 上的 Effect RPC。terminal 流按**字节窗口 + ACK**（最多 8 个未确认块 / 64 KiB），每个事件再加 128 字节固定开销，防止小事件绕过预算 |
| 空闲与回收 | `closeIdle` 每次用 `ps` / PowerShell 查子进程表（1 s / 1.5 s 预算）判断终端是不是真闲着；最多保留 128 个不活跃会话；启动终端时清掉 `PORT`、`TMUX`、`TMUX_PANE`、`STY`、`WINDOW`、`ZELLIJ*`，不让它继承发起服务的那个 tmux |
| 渲染 | **不用 xterm.js**：`apps/web/src/terminal/ghostty/` 是 `libghostty-vt` 原生 C ABI 的浏览器适配（`ghostty-vt.wasm` 一个浏览器 tab 一个实例、每个终端自己的句柄），用 Canvas 2D 批量画背景和样式段；输入、IME、选择、滚动、尺寸、链接、光标闪烁都自己写在 `surface.ts`（README 原话："intentionally not an xterm compatibility layer"）。iOS/Android 用 vendored 的 `GhosttyKit.xcframework` 原生模块（`apps/mobile/modules/t3-terminal/`） |
| 手机上 | 原生终端，不是 WebView |

值得抄的：历史与重放的边界、ACK 字节窗口、空闲判定、重放不写回 shell、`PtyAdapter` 这层接口（换实现不动上层）。

## Orca

源码：[stablyai/orca](https://github.com/stablyai/orca)（MIT，Electron + TypeScript）。文档 `docs/site/content/docs/terminal.mdx` 自述"和 VS Code 同一套 xterm.js 的终端"。

| 维度 | 做法 |
| --- | --- |
| 渲染 | 渲染进程用 xterm.js，而且深度改造：`config/patches` 里是 `@xterm/xterm@6.1.0-beta.336`、`addon-webgl`、`addon-search`、`addon-serialize`、`addon-image`、`addon-ligatures` 的补丁，加一份 `xterm-upstream.json` 和从源码重建补丁的脚本；`node-pty@1.1.0` 也打补丁 |
| PTY 归属 | 有独立的**终端 daemon**（`src/main/daemon/`）：daemon 侧的 pty adapter、hello/版本协商、snapshot 与流事件、按会话的历史文件与 tombstone。同时保留不走 daemon 的 `LocalPtyProvider` 作为本地直连路径。远端（SSH）、Remote Orca Server、手机都接 daemon |
| daemon 里的 headless 仿真 | 不是纯字节转发：daemon 维持一份终端仿真，能给出 viewport 快照、按新宽度 reflow（`emulation/conpty-reflow-viewport.ts`）、恢复鼠标编码/括号粘贴/备用屏幕等模式（`terminal-frame-restore-sequences.ts`、`terminal-mode-rehydrate-sequences.ts`），还有 OSC 7/标题扫描拿 cwd 和标题。这样宽度不同的客户端（手机、网页）attach 同一个 PTY 也能看对 |
| 准入 | `admission/` 里有系统 PTY 上限、per-host ledger、spawn gate、排队与延迟报错——不是"来一个开一个" |
| 历史 | `history/` 下按会话存文件、tombstone、seed transfer（把历史搬到新的宿主） |
| 手机 | RN + **WebView 里跑 xterm**（`mobile/src/terminal/terminal-webview-html`）。`mobile/terminal-output-streaming-findings.md` 记了一次真实排障：WebView 在 `web-ready` 之前会丢消息（两端都加队列），以及一个更本质的 bug——daemon 的 PTY 数据只转发给了桌面渲染进程，没喂给 runtime 的 tail buffer 和 `terminal.subscribe`，于是手机"发送成功但永远没输出" |
| 状态 | agent 终端标签显示 working / waiting / completed，靠各 agent 的 hook + 进程检测；终端支持 OSC 52（TUI 剪贴板）、find-in-scrollback、Copy Context、Reset Terminal、拖文件进终端 |
| 性能 | 专门的终端 perf 套件（打字延迟、帧时间、输出背压、隐藏面板恢复），按 10/25/50/100 个面板的规模跑，带预算检查 |

值得抄的：一个 PTY 要能同时服务多个 attach 者（tail buffer + 订阅者，不要只让桌面看得到）；daemon 侧做快照/reflow 而不是把历史字节往宽度不同的客户端硬灌；准入上限；终端 perf 有独立套件和预算。也要注意反面教训：daemon 化的代价是协议、版本、恢复、tombstone、seed transfer 一大堆状态机——这些代码量远大于终端本身。

## herdr

两个东西容易混：**Herdr 应用**（终端里的 multiplexer TUI，Rust）和 **herdr-core**（`hc`，"a terminal runtime for coding agents"）。用户说的"herdr 怎么做"，值得看的是 core，因为它是纯运行时。

| 维度 | 做法 |
| --- | --- |
| 形态 | Rust 单二进制 + 后台 server（PTY owner）；客户端只画。关掉客户端、断开 SSH，程序继续跑，`hc attach` 回去（`Ctrl+\` 脱离） |
| holder 进程 | 每个终端有 holder 进程；holder 丢了可以恢复（`--keep`），但恢复是"新 shell + 可选把上一次屏幕画在上面"（`restore_screen`），**绝不重跑任务**；意外 holder 丢失用继承的 cleanup token 把遗留程序一起结束 |
| PTY 与 shell | 默认 `$SHELL`，Windows 走 ConPTY / PowerShell；配置里可换 shell（executable + 参数列表，不经额外引号） |
| 状态 | **只信程序自报**：OSC 7501（Program Status Protocol，`printf '\e]7501;state=blocked:app=my-agent\e\\'`）。core 不读屏、不认 agent 品牌；程序不报就没有状态 |
| 另一层检测 | Herdr 应用（TUI）另有一层 per-agent 的 screen manifest（读 live bottom-buffer 屏幕、TOML 规则、有 hook 的 agent 用 hook 当权威），并明确"不叠加两个真相来源"。这一层在应用里，不在 core 里 |
| API | OpenRPC（`hc schema`）+ streams/events；`hc connect` 把协议走 stdin/stdout，能过 SSH；任何客户端都能接（官方桌面版、第三方 TUI、iPhone 的 Heeler） |
| 重启恢复 | 恢复 workspace/tab/pane 布局、cwd、焦点，能 resume 的 agent 用它自己的 session id 继续（原进程不复活）；终端历史默认**不落盘**（可能含凭据、token、提示词） |
| 多客户端 | 不同客户端可以各自看不同的 tab；同一个 tab 由最后活跃的客户端决定尺寸 |
| 移动端 | 第三方 Heeler 用 libghostty 渲染实时终端 + 原生 Chat + SSH 直连 |

值得抄的：OSC 7501 这种"状态由程序自报"的路子比读屏稳；holder 与"绝不重跑"的原则；历史默认不落盘这个安全默认值；`hc connect` 走 stdio 的设计。

## 横向对比

| | T3 Code | Orca | herdr-core | Atrium 现状 |
| --- | --- | --- | --- | --- |
| PTY 在谁手里 | 环境服务端 | 终端 daemon（本地另有一条直连路径） | 后台 server + 每终端 holder | 无 |
| UI 进程的角色 | attach 的客户端 | attach 的客户端 | attach 的客户端 | 无 |
| 渲染 | libghostty-vt（WASM / 原生） | xterm.js（深度 patch） | 自己画（draws nothing，交给客户端） | 无 |
| 历史 | 服务端有界保留 + 落盘 | 按会话文件 + 快照 + reflow | 默认不落盘 | 无 |
| 重放防副作用 | 剥查询/响应 + 断开 writer | headless 仿真快照 + 模式恢复 | 恢复屏幕 + divider | 无 |
| 状态 | 各 provider/agent 的 hook | agent hook + 进程 | 程序自报（OSC 7501） | 宿主已有 pi 的结构化事件，不需要猜 |
| 关掉 UI 后程序还活 | 是（服务端还在） | 是（daemon / 服务端还在） | 是（server + holder） | — |
| 手机 | 原生终端 | WebView + xterm | 第三方客户端 | 手机连宿主（relay 加密），目前没有终端 |
| 一次性成本 | node-pty + 两个 VT 产物的构建 | node-pty + 六个 xterm 补丁 + daemon 协议 | 一整个 Rust 运行时 | 很小：N-API 预编译包 412 KiB，不用重编译（已验证） |

三条共同的判断，比具体实现更值得记：

1. **PTY 不放在界面进程里。** 一旦放进去，"关窗后继续跑""手机接进来""重连后还在"全都做不了。
2. **历史必须有上限，而且重放要有边界。** 视频里那种"每次回调物化整份 scrollback"的做法，成本随历史线性涨；T3 和 Orca 都把"物化"限制在快照和落盘两处。
3. **状态不要读屏。** 三家都试过或绕开了屏幕解析；Atrium 的 pi 本来就通过 RPC 事件告诉宿主一切，内置终端不需要承担"判断 agent 在干什么"的职责。

## 为什么"接 Ghostty"不等于"接一个终端"

2026-11-06 libghostty-vt 发了 1.0（稳定 C ABI、MIT、官方 wasm / xcframework / Windows DLL），JetBrains、Neovim、Turborepo、OrbStack、herdr、cmux 都在用。容易产生的误解是"那直接接 Ghostty 就行了"，实际要分开看：

- **libghostty-vt 只管仿真。** 官方文档明确列了"永远不会有"的东西：标签页、多窗口、分屏、**会话管理**、配置、搜索 UI。它给的是"字节进、屏幕状态出"，加上按键/鼠标编码器；谁画、怎么画、谁活着，都是使用者的事。T3 的 `surface.ts`（IME、选择、滚动、链接、光标闪烁）就是这笔账。
- **Ghostty 应用不是可嵌组件。** 它是 Swift/AppKit、macOS 专属，没有给 Electron 用的 NSView；硬嵌要自己写原生 addon + overlay，和 React 布局抢 z-order、滚动、IME、剪贴板。
- **所以三家自己写的都是"拥有层"**：PTY、历史、attach、恢复、准入。这层才是"关窗还活着、重连还在、多端能看"的来源，Ghostty 给不了。

对 Atrium：Ghostty 的优势在"把复杂 TUI 画对、把屏幕读准"，而 Atrium 的 agent 走 RPC，不在终端里画 TUI；内置终端的用户是人，看日志、跑构建、敲几条命令。为此背一套自写的 surface + wasm/原生两套产物不划算。**第一版用 xterm.js**，力气花在拥有层上；真到"要在终端里跑 pi 的 TUI"那天再评估 libghostty-vt。

## 对 Atrium 的结论

### 现成的条件

- **宿主是天然的 PTY owner**：独立的 Node 进程（[overview.md · 进程模型](../architecture/overview.md#进程模型)），不依赖 Electron，可以单独运行，已经有 Clock、日志、子进程、登录 shell 环境这些基础件。
- **环境已经有安全约定**：`login-shell.ts` 只让登录 shell 带少数变量启动，交给 pi 的环境去掉 `ATRIUM_` / `ELECTRON_`（`ATRIUM_TOKEN` 不能漏进子进程）。终端 shell 必须复用这一份，否则等于开了一个能读到宿主 token 的窗口。终端输出也不能进日志和链路（[security.md · 子进程与文件](../architecture/security.md#子进程与文件)）。
- **布局与重连已经在宿主**：标签页布局按客户端记在宿主上，终端要能在重连续上同一个 PTY，就必须有自己的 id 和 attach 语义，而不是界面的局部状态。
- **手机有一条加密通道**（relay + 噪声）：技术上加终端流是通的，代价是协议、`remote-policy`、Swift 投影、手机渲染都要跟。

### 打包：最初的不确定项，已验证可行

宿主打成**单个文件**放进 `Contents/Resources/app/host/`，应用里没有 `node_modules`（[overview.md · 桌面端怎么启动宿主](../architecture/overview.md#桌面端怎么启动宿主)）。node-pty 是原生 addon（`.node`）加一个 `spawn-helper` 可执行文件，两者都没法被 esbuild 内联。所以要么把原生模块和 helper 作为独立资源目录随包发、按 Electron 版本准备预编译产物，要么换一条不依赖原生模块的 PTY 实现。

这个风险已经实测掉了：node-pty 1.1.0 是 N-API 预编译包，在 Atrium 打包的 Electron 44.5.1 里直接能用，不用重编译，最小产物 412 KiB，只需要补 `spawn-helper` 的执行位（详见下面"已验证"一节）。

### 三个方案

| | A. 命令面板（无 PTY） | B. 宿主内 PTY + 桌面 xterm.js | C. 独立 PTY holder + 多客户端 |
| --- | --- | --- | --- |
| 做什么 | `spawn` 一个命令，管道收 stdout/stderr，输出进一个标签 | 宿主持 PTY，桌面标签里用 xterm.js attach | 单独的 holder 进程持 PTY，宿主与手机都是客户端 |
| 能干什么 | 跑测试、构建、看 dev server 输出 | 真终端：交互式子进程、TUI、颜色、`Ctrl-C`、readline、进度条 | 同 B，外加关窗/退出后继续跑、手机看、多端同时看 |
| 干不了 | TUI、密码提示、`vim`/`top`、依赖 TTY 的程序，`Ctrl-C` 语义也不对 | Atrium 退出后终端一起结束 | 代价是协议、恢复、准入、tombstone 这一整套状态机 |
| 一次性成本 | 很小 | node-pty 打包 + 协议 + 界面 + 测试 | B 之上再加一个进程、恢复协议、手机渲染 |
| 建议 | 只在明确"只要看输出"时才值得 | **先做这个** | 等 B 用出真需求再说 |

推荐 **B**，但按 A 的思路留接口：宿主里的终端拥有者只暴露"open / attach / write / resize / close"，界面只消费 attach 流。这样以后要加 holder 进程（C），换的是 owner 的实现，不是协议和界面。

### B 方案的具体取舍

- **渲染**：桌面用 `@xterm/xterm` + `addon-fit` + `addon-webgl`（必要时 `addon-search`、`addon-serialize`），不引 libghostty。理由：xterm 是 VS Code 那条路，输入法、选择、滚动、链接、搜索都是现成的；libghostty 路线要自己写 surface（T3 那份 `surface.ts` 就是代价的证明），或者维护原生模块/wasm 两个产物。终端语义的准确性差距在"读 agent 的 TUI"这种场景才明显，而 Atrium 的 agent 不走 TUI。
- **历史与重放**：按 T3 的取舍——宿主保留有界历史（行数 + 字节双上限），落盘单独决定；attach 时先给快照再给增量；重放期间不把终端应答写回 shell；历史里剥掉查询/响应。不做 Orca 那套 daemon 侧 headless 仿真除非真要在不同宽度间 reflow。
- **传输**：走现有 WsServer，新命令 + 新事件（`terminal_open` / `terminal_attach` / `terminal_write` / `terminal_resize` / `terminal_close`，事件 `terminal_output` / `terminal_snapshot` / `terminal_exit`）；输出流按字节窗口 + ACK 控速（T3 的 8 块 / 64 KiB 是可直接用的起点）；协议号 +1。
- **安全**：终端 = 任意命令面。shell 用登录 shell 的那份环境（去掉 `ATRIUM_` / `ELECTRON_`）；输出与命令不写日志、不进链路、不进会话文件；默认**不给手机**（`local_only`），要不要放开是下一个决定。
- **归属**：终端挂在容器上（工作区目录、对话用 `~`、学习方向用方向目录），和"在终端中打开"的目录规则一致；标签类型是新的 `terminal`，一个容器可以开多个。
- **和 pi 的关系**：终端是给人的执行面，agent 只能“开一个终端跑某条命令”，输出不回给 agent（读输出仍靠 pi 自己的 Bash）；不开“agent 从终端读屏”之类的新语义。
- **和 cmux 的关系**：内置终端不能替代 cmux——Atrium 一退出它就没了。2026-11-12 用户定：两者并存，菜单项不删。
- **测试**：PTY 是多平台、有时序的东西，测试用真的 PTY 跑几个短命令（回显、`Ctrl-C`、resize 后的换行位置、退出码、历史上限），不 mock node-pty；泄漏测试覆盖 PTY、监听、定时器；打包测试必须覆盖"装好的 App 里能起终端"这一条，否则原生模块的问题只会在用户机器上出现。

### 2026-11-12 用户已定

1. **给谁用**：人和 agent 都能开。人自己开一个 shell；agent 也能请求宿主开终端，跑 dev server / watch 这类长任务，让人在标签里看着。
2. **活多久**：Atrium 退出时终端跟着结束，走方案 B（宿主内 PTY），不做独立 holder。
3. **手机**：只桌面。新命令对手机 `local_only`，不改 Swift 投影、不做手机渲染。
4. **和 cmux**：并存，"在终端中打开"保持不动。

由这四条推出的形状：

- **两条入口，一个拥有者**：用户点"新建终端"，或 agent 经扩展的通道（[ADR-0013](../adr/0013-agent-channel-status-and-hidden-command.md)，同 `agent_*` / `study_*` 的做法）请求宿主开一个终端。两条都落到宿主的同一个终端服务：宿主按调用方 pi 进程认出是哪个会话、按记录决定目录（不信参数），建 PTY，再当作一个标签推给界面。
- **agent 只开不读**：终端的输出是给人看的；agent 要读输出仍走它自己的 Bash。这样不必设计"agent 从终端读回输出"的协议，也不会和 pi 的 Bash 打两套语义。第一版 agent 能做的只有"开一个跑某条命令的终端"，且命令只作为 bash 的参数（不经 shell 拼接），目录由宿主定。
- **终端标签要有稳定 id**：布局记在宿主上，重连要能 attach 回同一个 PTY；PTY 随宿主退出而结束，所以不需要恢复已死的会话，只需要"标签还在但终端已结束"的状态。
- **不做**：多客户端 attach、退出后存活、手机、跨宽度 reflow、daemon 侧 headless 仿真、终端里的状态检测（agent 状态仍来自 pi 的 RPC 事件）。

### 已验证：打包能不能起 PTY

2026-11-12 在本机跑过（不改进仓库，只在 `/tmp` 里做）：

- `node-pty@1.1.0` 带 **N-API 预编译包**（`prebuilds/darwin-arm64/{pty.node,spawn-helper}`）。在 **Atrium.app 自带的 Electron 44.5.1**（Node 24.21，ABI 149）里直接 `require` 就能起 PTY，不需要为 Electron 重编译；同一份产物在系统 Node 22（ABI 127）下也照跑，确认是 N-API 而不是按 ABI 编的。
- 在任意路径下 `require('/…/Resources/app/native/node-pty')` 可以正常 spawn，只要目录结构保持包的样子。
- `spawn-helper` 少执行位时会失败成 `posix_spawnp failed`（npm 装下来的就是 `644`）。**宿主必须在用到它之前补 `chmod 755`**，T3 的 `NodePtyAdapter` 就是每次启动做一次。
- 最小可用产物 **412 KiB**：`package.json` + `lib/` + `prebuilds/<平台>/`；整包 62 MiB 里有 `deps/`、`third_party/`、`src/` 的源码，不用带。

所以打包改法是小的、可验证的：`apps/desktop/package.mjs` 的 `stageApp()` 多拷一个 `native/node-pty/`（只带上面三样、按平台挑 `prebuilds`），打包后的签名走现有 `codesign --deep` 覆盖到 `spawn-helper`；宿主按 `app.isPackaged` 决定从哪个目录 require。剩下的风险在"装好的包里能不能起"这条端到端用例上，得进 `test:package`。

### 实测（2026-11-12）

**环境一致性。** 用户的基准终端是 cmux（Ghostty 内核，`TERM_PROGRAM=ghostty`）。在 PTY 里用不同的启动种子跑同一个登录 shell，对比得到的变量：

| 种子 | 变量数 | PATH 段数（重复） | 结论 |
| --- | --- | --- | --- |
| 只给 12 个基本变量（不传 PATH）+ `TERM`/`COLORTERM` | 70 | 37（6） | 与用户终端（38 段、6 重复）只差 cmux 自己加的两个目录和 `/usr/ucb` |
| 基本变量 + 宿主 PATH | 70 | 51（20） | 重复堆叠，不对 |
| 直接继承宿主环境（扣 `ATRIUM_`/`ELECTRON_`） | 79 | 51 | 额外带进 `PI_SESSION_ID`、`AI_AGENT`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`、`NO_PROXY` 改过的值、`SHLVL=2`，会改变 CLI 行为 |

因此规则是：**种子只给 12 个基本变量加 `TERM`/`COLORTERM`，不传 `PATH`**（让 profile 自己算，与 Dock 开终端的过程一致）；**不**冒充 `TERM_PROGRAM=ghostty` 或 cmux 的 `CMUX_*` shim（那是 cmux 的 agent 集成）；`ATRIUM_*`、`ELECTRON_*`、`PI_SESSION_*` 一律剔除。接受的不同：在 Atrium 终端里跑 `claude`/`codex` 不带 cmux 的 wrapper（没有它的通知/关注集成）。

**四个 TUI 的启动实测**（PTY + `@xterm/headless` 回放，只用 Ctrl-C/Esc，不发真实请求）：

| | claude 2.1.322 | codex 0.167.2 | opencode 1.17.18 | pi 1.5.0 |
| --- | --- | --- | --- | --- |
| 首屏能渲染 | 是（inline，不进备用屏幕） | 是（备用屏幕） | 是（备用屏幕；首屏前有网络更新检查，最慢约 9 秒） | 是（备用屏幕） |
| 括号粘贴 / 鼠标 | 括号粘贴 | 两者都有 | 两者都有 | 两者都有 |
| 同步输出（`2026`） | 未用 | 用 | 未用 | 用 |
| truecolor | 用 | 用 | 用 | 用 |
| Kitty 键盘协议 | 未用 | **用** | 未用 | **用** |
| OSC 8 链接 | 未捕获到 | 未捕获到 | 未捕获到 | 用 |
| 退出后恢复模式 | — | 备用屏幕、粘贴、鼠标、Kitty 全部恢复，退出码 0 | — | — |

结论：**四个都能在 xterm.js 的仿真下正确启动和渲染**（方块字、表格、对话框对齐正常），首屏输出 2.6–19 KB，对 xterm.js 是小负载。唯一系统性缺口是 **Kitty 键盘协议**（codex、pi 都用），xterm.js 不支持，影响的是 Shift+Enter 这类带修饰键；基础键（`Ctrl-C` 已验证，codex 干净退出）不受影响。中文输入法、多行输入、选中复制手感经用户 2026-11-12 在最小 harness（Electron 44 + xterm.js + 本机 PTY，环境按上面的规则）里实测无问题，VT 层据此定为 xterm.js；Kitty 键位先走各家降级键。

### 下一步

1. 原型：终端标签的三种放法（独立标签 / 右栏第三页 / 对话下的分屏），请用户选。
2. 写 SPEC：命令与事件、终端 id 与标签、目录规则、agent 开终端的通道与限制、安全条目、打包与测试清单。
3. 实现顺序：打包里的 PTY（先让 `test:package` 能起一个 shell）→ 宿主终端服务与协议 → 桌面标签与 xterm → agent 入口 → 破坏检查、变异、泄漏。

## 参考

- T3 Code：[README](https://github.com/pingdotgg/t3code)、[`docs/internals/terminal-runtime.md`](https://github.com/pingdotgg/t3code/blob/main/docs/internals/terminal-runtime.md)、[`docs/user/terminal.md`](https://github.com/pingdotgg/t3code/blob/main/docs/user/terminal.md)、`apps/server/src/terminal/{Manager,NodePtyAdapter,OutputProtocol}.ts`、`apps/web/src/terminal/ghostty/README.md`、`packages/shared/src/PtyAdapter.ts`、`apps/mobile/modules/t3-terminal/`
- Orca：[Terminal 文档](https://www.onorca.dev/docs/terminal)、[Ways to run](https://www.onorca.dev/docs/ways-to-run)、`src/main/daemon/`（admission、emulation、history、protocol、providers）、`config/patches/`（xterm 6.1.0-beta.336、node-pty 1.1.0）、`mobile/terminal-output-streaming-findings.md`
- herdr：[herdr-core README](https://github.com/herdrdev/herdr-core)、[herdr-core 介绍页](https://herdr.dev/core/)、[Agents 文档（状态来源）](https://herdr.dev/docs/preview/agents/)、[对比页](https://herdr.chefgroep.nl/compare/)、heise 的[报道](https://www.heise.de/en/news/Herdr-Terminal-multiplexer-sorts-fleets-of-coding-agents-11450324.html)（提到 server/client、PTY、恢复矩阵、历史默认不落盘）
- libghostty-vt：[1.0 发布说明](https://mitchellh.com/writing/libghostty-1-0)、[文档首页（含"永远不会提供"清单）](https://github.com/ghostty-org/ghostty/blob/main/dist/doxygen/pages/main.md)、[安装（wasm / xcframework 产物）](https://github.com/ghostty-org/ghostty/blob/main/dist/doxygen/pages/getting-started/installing.md)
