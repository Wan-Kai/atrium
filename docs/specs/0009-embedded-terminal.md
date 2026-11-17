# SPEC-0009：内置终端

- **状态**：实施中
- **创建**：2026-11-12
- **更新**：2026-11-12
- **相关**：[路线图 · 阶段](../roadmap.md)、[调研 · 内置终端](../research/embedded-terminal.md)、[外部终端最小接入](../architecture/external-terminal.md)、[domain-model](../architecture/domain-model.md)、[security.md](../architecture/security.md)、[ADR-0013](../adr/0013-agent-channel-status-and-hidden-command.md)（agent 与宿主的通道）

## 背景与目标

Atrium 现在的终端能力只有两条：pi 自己的 Bash（无 TTY，输出进对话）和标签栏"在终端中打开"（把目录交给外部 cmux 或系统终端，Atrium 不管生命周期）。

用户要在 Atrium 里**流畅地跑交互式程序**，主要是 Claude Code、Codex、OpenCode、Gemini CLI 这类 TUI agent，以及 `npm run dev`、`pnpm test --watch` 这类长任务。这些程序都要求真 TTY：要 `isatty`、要宽高、要 `Ctrl-C`、要进备用屏幕。

做完之后：桌面里有一个终端标签，宿主持有 PTY，人可以直接用；agent 也能请求开一个终端跑长任务、让人看着。终端随 Atrium 退出而结束，和 cmux 并存。

## 非目标

- **手机端**：第一版不给——新命令一律 `local_only`，不下发、手机不渲染终端。**但协议形状按"以后能加"设计**：`terminal_attach` 是订阅而不是占用，流控按"终端 × 连接"算，尺寸不当成终端属性（见"给手机留的口子"）。
- **比 App 活得久**：不做独立 holder 进程或 daemon；要终端活着就用现有的"在终端中打开"交给 cmux。
- **多客户端 attach**：同一个 PTY 同一时刻只服务一个界面连接；重连是重新 attach，不是多人共享。
- **终端状态检测**：不分析屏幕判断 Claude Code / Codex 在干什么（在等确认、跑完了）。agent 需要时自己 `terminal_read` + `terminal_wait`。
- **终端里的状态检测**：不分析屏幕判断 agent 在干什么，也不为 Claude Code / Codex 做会话归位（只有 pi 例外，见下文）。
- **Kitty 键盘协议、图片协议、OSC 52 写剪贴板、搜索、跨宽度 reflow**：第一版不做。Kitty 键位接受各家的降级键（`\`+回车、`Ctrl+J`、`Alt+Enter`），需要时再按调研文档里的 B 方案补编码层。
- **shell 集成**：不注入提示符、不装 shell 插件、不做"命令块"。

## 需求

1. 当我在一个工作区里，我希望从标签栏 `+` 新建终端，工作目录是这个工作区的目录，以便直接跑 `claude` 或 `npm run dev`。
2. 当我在一个对话里（没有工作区），我希望新建的终端开在 `~`，和"在终端中打开"的规则一致。
3. 当我在学习方向里，我希望终端开在方向的目录。
4. 当 agent 需要跑一个长任务，我希望它能开一个终端，我在标签上直接看到，并且知道这是它开的。
5. 当我关掉终端标签，如果里面还有程序在跑，我希望先问我一次；如果什么都没跑，就让我直接关掉。
6. 当我在终端里跑 `pi`，我希望它照现有规则出现在对话列表里（按 `cwd` 归到对应容器）。
7. 当界面重连或窗口重开，我希望还在跑的终端能重新接上，看到历史再继续。
8. 当我用输入法打中文、多行输入、复制输出，我希望和普通终端一样（已实测：xterm.js + 原生 PTY 下正常）。
9. 当 agent 需要驱动一个 TUI（Claude Code、Codex 之类），我希望它能开终端、读屏幕、敲键、等输出静默、再关掉，以便它自己完成"发指令 → 看结果 → 决定下一步"的循环。

## 方案设计

### 分层

```
界面（ui/tabs）  xterm.js 只做仿真和渲染
      │  协议（命令 + 事件，local_only）
宿主（host/terminal）
      │  PtyAdapter（node-pty，N-API 预编译）
      └  shell（$SHELL -i -l）
```

- **宿主持有 PTY。** 终端不是界面的局部状态：界面重连、标签重建都只是重新 attach 同一个 PTY。
- **`PtyAdapter` 是唯一的原生依赖**，接口只有 `spawn/write/resize/kill/onData/onExit`。以后要换 libghostty-vt 或独立 holder，换的是适配层，协议和界面不动（见调研文档）。
- **仿真和渲染都在界面**（xterm.js）。宿主只搬字节，不做终端仿真——第一版不需要 daemon 侧的 headless 仿真，因为只有一个客户端、也不需要跨宽度 reflow。

### 生命周期

- 一个终端 = 一个 PTY + 一个稳定的 `terminalId`，属于某个容器（工作区 / 方向 / 对话）。
- 关闭标签：宿主先判断 PTY 里**有没有前台进程**（macOS 上枚举 shell 的子进程，同 T3 的 `closeIdle` 做法）；有才让界面弹确认，然后发 `terminal_close`。宿主收到关闭请求后先 `SIGTERM` 进程组，3 秒后 `SIGKILL`，等 `onExit` 再释放记录。判断不出来（查询失败）时按"有"处理，宁可多问一次。
- 宿主退出（用户退出 Atrium）：按上面的顺序结束所有终端，不留悬空 PTY。
- 崩溃/重启：**不恢复已死的终端**。标签随布局恢复时如果终端已不存在，标签显示"终端已结束"和"重新开始"（等价于关掉重开，新 `terminalId`）。
- "重新开始"：`close` + `open`，不尝试重启原来的命令（和 herdr 的"绝不重跑任务"同一原则）。

### 历史与重放

- 宿主按终端保留有界历史：**最多 5000 行 / 8 MiB UTF-8**，淘汰不切开码点，实时输出不截断。
- 实时事件只带新增块；不每次物化整份 scrollback。
- `attach` 返回快照（历史 + 当前 cols/rows），之后是新输出。快照前**剥掉终端查询/响应流量**（`CSI c`、`CSI > c`、OSC 10/11 查询等），否则重放会把这些查询的回答灌进当前 shell。
- 界面重放期间**不把 xterm 的应答写回 PTY**，重放完再接通。
- 历史**不落盘**（可能含凭据和提示词；herdr 的默认值，这里照抄）。代价：宿主重启后看不到上次的输出。

### 流控

输出走现有 WebSocket，但要按字节窗口 + ACK 控速：每个 attach 流最多 8 个未确认块或 64 KiB（T3 的取值），每块另计 128 字节固定开销，防止小事件绕过预算。终端里 `yes` 或 `tail -f` 不能把界面打爆。

### 环境

这是用户明确要求的：**在终端里跑程序和直接打开终端一致**。实测（调研文档"实测"一节）：

- 种子只给这些：`HOME`、`USER`、`LOGNAME`、`SHELL`、`TMPDIR`、`LANG`、`LC_ALL`、`LC_CTYPE`、`SSH_AUTH_SOCK`、`ZDOTDIR`、`__CF_USER_TEXT_ENCODING`，再加 `TERM=xterm-256color`、`COLORTERM=truecolor`。
- **不传 `PATH`**：让 `.zprofile`/`.zshrc` 自己算，和 Dock 开终端的过程一致。实测这样得到的 PATH 与用户终端（cmux/Ghostty）只差 cmux 自己加的两个目录。
- **剔除**：`ATRIUM_*`、`ELECTRON_*`（token）、`PI_*`、`AI_AGENT`、`CLAUDE_CODE_*`、`VIBE_ISLAND_*`。实测"继承宿主环境"会带进这些，改变 CLI 的行为（agent 嵌套检测、遥测开关、`NO_PROXY` 变异）。
- **不冒充别的终端**：不设 `TERM_PROGRAM=ghostty`/`iTerm.app`，也不复制 cmux 的 `CMUX_*` shim。接受的不同：在 Atrium 终端里跑 `claude`/`codex` 没有 cmux 的通知集成。
- 终端里**没有 Atrium 自己的 token**；和 pi 用同一套剔除规则（[security.md](../architecture/security.md)）。

### 目录与标题

| 容器 | 目录 |
| --- | --- |
| 工作区（worktree） | 工作区目录 |
| 学习方向 | 方向现在的目录（归档的在 `Archive/` 下） |
| 对话（无工作区） | `~` |

- 目录只由宿主按容器 id 解析，**不接受客户端给的路径**。
- 标题默认取命令名或目录名；agent 开时可以带一个标题（≤ 40 字），仍然由宿主落成标签文字。

### agent 操作终端（2026-11-12 用户定：能驱动 TUI）

agent 有五个工具，都走 [ADR-0013](../adr/0013-agent-channel-status-and-hidden-command.md) 的 `call`，宿主按**请求来自哪个 pi 进程**认定会话。

| 工具 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `terminal_open` | `{ command, title? }` | `{ terminalId, title, directory }` | 在调用方容器的目录里开一个终端，用登录 shell 跑 `command` |
| `terminal_read` | `{ terminalId, lines? }` | `{ text, rows, cols, cursor, state, exitCode, reported }` | 当前屏幕的纯文本；不含 ANSI；最多 200 行 / 32 KiB；`reported` 是程序用 OSC 7501 自报的状态（没有就 `null`） |
| `terminal_type` | `{ terminalId, text, submit? }` | `{}` | 打字。程序开了括号粘贴就整段作为**一次粘贴**（多行不会逐行提交）；`submit` 为真时补一个回车。单次 ≤ 4 KiB |
| `terminal_key` | `{ terminalId, key }` | `{}` | 按一个**有名字的键**：`enter` / `esc` / `ctrl-c` / `ctrl-d` / `tab` / `shift-tab` / 四个方向键。宿主映射成字节，模型不写转义序列 |
| `terminal_wait` | `{ terminalId, until?, quietMs?, timeoutMs? }` | `{ quiet, exited, exitCode }` | `until: "quiet"`（默认）等屏幕安静，`"exited"` 只等进程结束；超时 `quiet: false` |
| `terminal_close` | `{ terminalId }` | `{}` | 只关自己开的 |

规则：

- **只能碰自己开的终端。** 条件：`origin === "agent"` 且 `sessionId` 是调用方；其余一律 `terminal_not_owner`。用户的终端绝不能让 agent 写——它会往你正在敲的终端里塞字符。
- **读屏靠 headless 仿真。** 原始字节里全是 ANSI，模型读不了；宿主因此对每个终端维护一份 `@xterm/headless` 的屏幕模型，只在 `terminal_read` 时取文本，不参与渲染。这份仿真是后面手机看 TUI 的基础（见"给手机留的口子"）。
- **等待有两种语义**：`terminal_wait` 接受 `until: "quiet" | "exited"`（默认 `quiet`），让模型能明确要"屏幕安静"还是"进程结束"，而不是从一个含糊的"等了"里猜（[调研 · agent 操作终端](../research/agent-terminal-tools.md)）。
- **等待是驱动 TUI 的关键，但"静默"不等于"跑完"。** 没有任何结构化信号说"跑完了"，只有"输出静默 + 超时"可用；所以 `terminal_wait` 的语义是"屏幕安静下来了"，**不是"任务完成了"**。工具说明里必须写清楚：tui 里安静只说明它画完了这一屏，结论要 `terminal_read` 看屏幕。（实测见下面"实测 · 驱动 TUI 的三个坑"。）
- **信任与授权询问不许代答。** Claude Code 在新目录里会先问"Press Enter to continue"再问"Is this a project you trust?"，并且默认停在 **"No, exit"**。agent 看到这类提示必须停下、告诉用户，不得自己按回车或选择"信任"——信任哪个目录是人的决定，而且盲按会直接把会话退掉。
- **写入不解析、不过滤命令。** 和 Bash 一样，不构成新的权限；风险是盲操作（向正在问"要不要执行"的 CLI 敲 `y`），靠"只能碰自己的终端 + 写入频率上限"缓解，不做语义拦截。
- **读到的内容会进模型上下文，也会进会话文件**（2026-11-16 用户定）：`terminal_read` 的屏幕正文和 `terminal_open` 的目录是普通工具结果，pi 会把它们写进会话 jsonl，屏幕上的凭据因此可能落盘——和 bash 工具输出同等对待。不进日志、不进链路这两条仍然成立。
- 没有 `cwd` 参数：目录由宿主按调用方会话的容器决定，和界面新建走同一套规则。
- **谁知道这六个工具**（2026-11-16 用户定）：除子对话外的所有会话——普通对话、工作区会话、任务对话都能开终端；agent 开的子对话拿不到，免得一层层开下去。
- **上限两本账**（2026-11-16 用户定）：每个容器里，人最多 4 个终端、agent 最多 6 个，分开计数，agent 用不掉人在用的标签页。命令 ≤ 2000 字，标题 ≤ 40 字。
- 标签上带 `agent` 标记；用户关掉它不通知模型（模型下次 `terminal_read` 得到 `terminal_not_found`）。

### 实测 · 驱动 TUI 的三个坑（2026-11-12，`mc --code` = Claude Code 2.1.322）

用户的 Claude Code 走 `mc --code` 启动；在最小 harness（Electron 44 + xterm.js + 原生 PTY、环境按上面的规则）里驱动它，量到的事实：

1. **首屏有两道闸**：先 "Press Enter to continue…"（安全提示），再 "Is this a project you trust?"（默认选中 "No, exit"）。后者按回车会**直接退出** Claude Code；要信任必须下移再回车。两道闸都是**静态画面**——安静好几秒。这就是"静默 ≠ 完成"的实证，也说明 `terminal_read` 不是可选项。
2. **安静间隙很长**：启动后停在输入框时，两次输出之间最大间隔 **6.7 s**；比 `terminal_wait` 的默认 800 ms 大一个数量级。所以 `quietMs` 只能当"这一屏画完了"，冲默认值去猜"跑完了"一定会错。
3. **启动很轻**：整个首屏约 3 KB / 33 个数据块，对 xterm.js 和协议都是小负载。

对实现的要求：`terminal_read` 返回屏幕文本和 `state`/`exitCode`；工具的说明里写明"安静 ≠ 完成，先读屏再决定"；信任/授权提示一律上交用户。

### 界面（选定的 A 方案）

- 终端是一个**独立标签**，和对话、任务平级；标签栏 `+` 里多一项"新建终端"。
- 标签抬头：`zsh — ~/work/atrium` 或命令名、`112×51`、"重新开始"、"清屏"。
- 键位与剪贴板：
  - 有选区时 `Cmd/Ctrl+C` 复制（不发 `^C`）；无选区时 `Ctrl+C` 照常中断。
  - `Cmd+K` 清屏；`Cmd+V` 走 xterm 的粘贴（括号粘贴由程序自己开）。
  - 右键菜单："复制"、"粘贴"、"重置终端"（清掉卡住的鼠标/键盘模式，不重启 PTY）。
- 关闭确认：只在有前台进程时弹一次，写明"终端里还有程序在跑，关闭会结束它"；闲着的终端直接关。

## 接口与数据

协议 **40 → 41**，新增部分全部对手机 `local_only`。

### 实体

```ts
/** 一个终端。 */
interface Terminal {
  id: TerminalId;                 // term_…
  containerId: string;            // 工作区 / 方向 / 对话
  title: string;
  cwd: string;                    // 只读展示用，由宿主解析
  cols: number;
  rows: number;
  state: "running" | "exited";
  exitCode: number | null;
  origin: "user" | "agent";
  sessionId: string | null;       // agent 打开时是发起会话
}
```

### 命令

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `terminal_open` | `{ containerId, cols, rows }` | 界面新建；目录由宿主按容器解析 |
| `terminal_attach` | `{ terminalId }` | 返回快照并开始收输出 |
| `terminal_write` | `{ terminalId, data }` | 单次 ≤ 64 KiB |
| `terminal_resize` | `{ terminalId, cols, rows }` | 8 ≤ cols ≤ 500，4 ≤ rows ≤ 200 |
| `terminal_close` | `{ terminalId }` | 先 TERM 后 KILL，等 `onExit` |

### 事件

| 事件 | 载荷 |
| --- | --- |
| `terminal_opened` | `Terminal` |
| `terminal_snapshot` | `{ terminalId, history, cols, rows }` |
| `terminal_output` | `{ terminalId, data }` |
| `terminal_exited` | `{ terminalId, exitCode }` |
| `terminal_closed` | `{ terminalId }` |

### 给手机留的口子（2026-11-12 定）

以后要让手机看/敲同一个终端，靠这三条已经留好的形状，不用改协议结构：

1. **attach 是订阅，不是占用。** 命令只表达"把这个连接接到这个终端上"；"同时只许一个连接"是宿主里的策略（第二个连接回 `terminal_not_owner`），不是命令的形状。手机上线时换成"接管"或"一主一从"只是改策略。
2. **流控按"终端 × 连接"算**，不按终端全局算。否则手机在弱网下会拖住桌面——这是多客户端最常见的坑，事后改要动协议。
3. **尺寸不是终端的不变属性**，是一个当前值，变化走事件；手机的宽度和桌面不同，需要仲裁规则（接管 / 一主一从 / 各给快照）。

还要提前知道的代价：本方案不做服务端终端仿真，手机拿到的历史是原始字节，宽度不同时 TUI 的框和表格会错位。届时二选一：接受"手机只适合看日志"，或补一份服务端 headless 仿真（Orca 的做法，复杂度回到 daemon 那条路）。手机渲染最省的是 WKWebView 里放 xterm.js（Orca 的路，注意 `web-ready` 之前要排队）。

### agent 工具的通道

不新增协议命令：agent 的读写走通道，只有 UI 需要的那五条命令在协议里。通道新增六个 `op`：`open_terminal`、`read_terminal`、`type_terminal`、`key_terminal`、`wait_terminal`、`close_terminal`，参数与上表一致。宿主侧新增依赖 `@xterm/headless`（只在宿主，不进界面）。

**为什么不给 agent 一个裸的 `terminal_write`**（2026-11-16 定，[调研](../research/agent-terminal-tools.md)）：文本和按键的失败方式不同——多行文本不加括号粘贴会逐行提交，而 `\r`、`\x03`、`\x1b[Z` 这类转义一旦写错，表现是"屏幕没动"，极难排查。所以 agent 侧按**意图**给两个工具（`type` / `key`），字面量别名只留给协议命令和界面。宿主顺手跟踪程序有没有开括号粘贴（`DECSET 2004`）和有没有说 OSC 7501，两者都从 PTY 输出里读，不额外请求什么。

### 错误码

`terminal_not_found`、`terminal_not_owner`（终端不属于这个连接/容器，或 agent 碰了别人的终端）、`terminal_write_too_fast`、`terminal_limit`（每容器 4 个、每会话 agent 4 个）、`terminal_bad_size`、`terminal_write_too_large`、`terminal_cwd_invalid`、`terminal_spawn_failed`。

### 文件与依赖

- 新增 `packages/host/src/terminal/`（`TerminalService`、`PtyAdapter`、历史、目录解析）。
- 新增 `packages/ui/src/tabs/terminal-tab.tsx` 与 `terminal-view.tsx`（xterm.js 适配）。
- 新增依赖：`node-pty@1.1.0`（宿主）、`@xterm/xterm`、`@xterm/addon-fit`、`@xterm/addon-webgl`（界面）。
- 打包：`stageApp()` 多拷 `native/node-pty/`（`package.json` + `lib/` + 对应平台 `prebuilds/`，实测最小 412 KiB）；启动时补 `spawn-helper` 的 `chmod 755`（不补就是 `posix_spawnp failed`）。

## 备选方案

| 方案 | 为什么不采用 |
| --- | --- |
| 只做"命令面板"（spawn + 管道，无 PTY） | 跑不了 TUI，`Ctrl-C` 语义也不对；用户明确要跑 Claude Code / Codex |
| 终端放右栏第三页（原型 B） | 340px ≈ 44 列，TUI 挤成一团，`git status` 都折行 |
| 终端放对话下分屏（原型 C） | 不砍，但排后：和 A 共用同一个终端服务，只是呈现位置不同，之后加不返工 |
| 独立 holder 进程 / daemon | 换来"退出后继续跑"，代价是恢复协议、准入、tombstone 一整套；用户选了"随 App 结束"，需要时交给 cmux |
| libghostty-vt 做仿真 | 语义更准，但要自己写渲染、输入、IME、选择（T3 的 `surface.ts` 就是代价），而实测 xterm.js 已经能跑这四个 CLI |
| 继承宿主环境（更"像"当前进程） | 实测会带进 `PI_*`、`AI_AGENT`、`NO_PROXY` 变异，改变 CLI 行为，且结果取决于 Atrium 被谁启动 |
| 历史落盘 | 可能含凭据和提示词；先按 herdr 的默认值不落盘 |

## 风险与待定问题

- [x] **关标签确认的触发条件**（2026-11-12 用户定）：只在有前台进程时问。实现靠枚举 shell 的子进程；查询失败按"有"处理。Windows 不做（Atrium 只打包 macOS）。
- [x] **agent 开的终端要不要在会话里留一行记录**（2026-11-12 用户定）：只在标签上标 `agent`，不往会话里写行。
- [x] **agent 的能力档位**（2026-11-12 用户定）：加到"能驱动 TUI"——开、读屏幕、写、等静默、关；只碰自己开的终端。
- [ ] **`terminal_wait` 的默认值**：静默 800 ms 对 Claude Code 够不够（它重画频率高），要不要按"最后一行变化"而不是任何输出。
- [x] **标题规则**（2026-11-12 代定）：agent 给的标题 > 命令名 > 目录名，冲突时前面的赢。
- [x] **多窗口/多客户端**（2026-11-12 代定）：一个终端同时只服务一个连接；第二个连接 attach 时回 `terminal_not_owner`，不接管。
- [x] **`terminal_open` 的并发**（2026-11-12 代定）：宿主串行处理；同一容器超过 4 个回 `terminal_limit`。

### 两路审查后未修的（2026-11-16，Astra + Grok 4.7）

已修：重放安全（界面先缓冲、重放期间断开 writer）、`terminal_wait` 的 quiet 改为"这次等待之后有输出再安静"、关闭收成每终端共享的一次（幂等、`closeAll` 走 TERM→宽限→KILL 并等、退出码不再假报 0、`agentClose` 走同一条路、宿主 shutdown 调用 `closeAll`）、落盘契约按用户决定改成"终端内容属于会话内容"。

未修，按优先级：

1. **输出流控**：协议无序号/ACK，`yes` 会顶到 socket 上限把整条连接关掉（`SlowConsumer`），聊天一起断。要做成按"终端 × 连接"的窗口与丢弃/重新快照。
2. **重连不重新 attach**：刷新或断线重连后标签还在、PTY 还活着，但输出仍发往旧 `connectionId`；需要 `welcome` 之后按标签重新 attach，并给一个"仍在跑的终端"清单。
3. **进程组清理**：node-pty 的 `kill` 只杀 shell；按 `-pid` 发信号在同组时会连带测试进程，已试并回退，需要先拿到可验证的 pgid 或走进程树遍历。
4. **控制序列跨块**：括号粘贴、OSC 7501、查询剥离都按单块扫描，被 PTY 切开就漏判；需要每终端一个有界尾缓冲。
5. **终端错误映射**：`CommandError` 在通道里被折成 `agent_failed`，模型分不清不存在/越权/限流/超长。
6. **两个上限不成立**：历史最后一块永不淘汰（可超 5000 行）；UI 写入按字符串长度算 64 KiB（中文可超）。
7. **界面露出**：终端标签统一叫"终端"，没有 `title`/`origin` 胶囊、没有规格里的抬头（目录、尺寸、清屏/重新开始）。
8. **⌘W 绕过关闭确认**；退出后立刻 `closed` 删记录（agent 的 `state`/`exitCode` 变死字段）；等待不接受 `AbortSignal`。

## 实施计划

1. **T0 文档** ✅ 2026-11-12：`domain-model` §10、`overview`（模块、进程模型、打包、界面）、`security.md`（环境、日志、`TERM`/`COLORTERM`、`ATRIUM_ELECTRON_ZIP_DIR`）、`design-language`（终端标签与 `--term`）。
2. **T1 原生与打包** ✅ 2026-11-16：`native/node-pty`（448 KiB）+ 三处解析 + 启动补 `spawn-helper` 执行位；`@package` 三条（包里有模块、helper 可执行、装好的 App 里跑 `echo packaged-ok` 看到输出）。
3. **T2 宿主与协议** ✅ 2026-11-16：`TerminalService`、历史与查询剥离、快照、命令与事件、`local_only`、协议 41；投递按 `connectionId`、所有权按 `clientId`（重连后 attach 回同一个 PTY）。
4. **T3 界面** ✅ 2026-11-16：终端作为查看标签（按容器、仅本窗口）、`TerminalPane`（xterm.js、粘贴/复制/`Cmd+K`、尺寸跟随）、关闭确认（`force` + `terminal_has_process`）、"已结束/重新开始"。
5. **T4 agent 操作终端**（进行中）：宿主侧 ✅（`@xterm/headless` 读屏、`agentRead/Write/Wait/Close`、只碰自己开的、4 KiB 与 20 次/秒限速、agent 终端广播给本地连接）；**剩下** pi 扩展的五个工具、通道五个 `op`、宿主把 agent 的 `open` 接到服务。
6. **T5 收尾**：破坏检查、变异（`terminal` 组 ≥ 80%）、泄漏（PTY/监听/定时器）、完整 UI 套件、追踪表登记、路线图更新。

## 验证

**自动化**

- 宿主：目录解析（工作区/方向/对话）、环境变量（必须一致/必须不同两组断言）、历史上限与淘汰不切码点、快照剥查询响应、流控窗口、关闭的 TERM→KILL→释放、`local_only` 拒绝手机、每容器/每会话上限。
- 界面：标签生命周期、重连后 attach 同一 PTY、有选区 `Cmd/Ctrl+C` 复制、无选区透传、关闭确认、`terminal_exited` 后显示"重新开始"。
- 打包：`test:package` 起真实 shell 拿到输出（覆盖原生模块和 `spawn-helper`）。
- 泄漏：反复开关终端 50 次后没有残留 PTY、监听、定时器。

**手动**

- 在终端里跑 `claude`、`codex`、`opencode`、`pi`：中文输入、多行输入、`Ctrl-C`、备用屏幕进出、退出后 shell 干净（2026-11-12 已在最小 harness 上验过一轮，产品里再验一遍）。
- 跑 `npm run dev` 看长输出不掉帧；`yes` 打不住界面。
- agent 用 `terminal_open` 起一个长任务，标签出现并带 `agent` 标记；关掉时确认框说明在跑什么。
- 退出 Atrium 后确认没有残留进程。
