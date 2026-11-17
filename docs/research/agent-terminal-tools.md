# agent 操作终端：别家怎么做

2026-11-16。为 SPEC-0009 的"agent 操作终端"（开、读、写、等、关）找参照。看的不是"谁的终端好看"，而是**给 agent 的接口长什么样、它靠什么判断"做完了"**。三家的材料：Claude Code 的背景命令工具（公开文档与工具 schema）、herdr 的 `hc`（官方文档与 README）、cmux 的 CLI 与随包 skill。

## 三种模型

| | Claude Code（Bash / BashOutput / KillBash） | herdr（`hc`） | cmux（CLI + skill） | Atrium（SPEC-0009） |
| --- | --- | --- | --- | --- |
| 开 | `Bash(run_in_background: true)`，返回 `shellId` | `hc run --bg --name web bun dev`（`--keep` 可跨重启保活） | `cmux new-split --command "npm run dev"`：造终端、**把文本 + 一个回车**送进新 shell，shell 留着 | `terminal_open { command, title? }` → `terminalId`，写 `command\r` 进登录 shell |
| 读 | `BashOutput(shellId, filter?)`：**只给自上次以来新增的输出** + `status: running/completed/failed`；`filter` 命中的行留下、其余**永久丢弃** | `hc read <t> --lines 60`（尾部行）；状态另外查：`hc get` / `hc events` | 读屏（skill 里约定：输入和读屏都显式给 workspace/surface） | `terminal_read`：**整屏文本**（已渲染、无转义）+ 光标 + 状态 + 退出码 |
| 写 | 没有再写进已启动命令的通道（一次一条命令） | `hc send <t> "…"`；`hc attach` 接管 | `send` / `send-key`；`--command` 自带一个回车 | `terminal_write { data }`，4 KiB/次、20 次/秒 |
| 等 | 不提供；靠轮询 `BashOutput` 的 `status` | `hc wait <t>`、`hc wait --children all`；完成由**程序自己报**（OSC 7501）或应用层的屏幕规则判定 | 无内建等待：读屏 → 判断 → 再读（skill 明确要求"CLI 返回成功不等于命令跑完，要读真实输出"） | `terminal_wait`：输出静默 800 ms / 进程结束 / 超时 |
| 关 | `KillBash(shell_id)` | `hc` 停止终端；子终端随父结束（`--outlive-parent` 例外） | 由用户/cmux 管；agent **不关**别人的 | `terminal_close`；agent 只能关自己开的 |
| 归属 | 每个 shellId 属于本会话 | 每个终端有 id、可跨机器（`vps/t3`）、有 holder 进程 | 显式 handle：`window:N` / `workspace:N` / `surface:N`（UUID 可查） | `terminalId` + 发起会话；用户的终端 agent 只读也不行 |

## 关键差异：怎么知道"做完"

- **Claude Code**：进程退出就是 `completed/failed`。因为它跑的是**非交互命令**，没有 TUI，退出码是可靠信号。
- **herdr**：状态**由程序自报**（OSC 7501：`state=working|blocked|idle|done|error`），core 不读屏、不认品牌。对不报状态的 agent，才退到应用层的屏幕规则（Herdr 应用里那套 TOML manifest）。
- **cmux**：不判断，交给调用方；skill 里反复强调"读真实输出再决定"。
- **我们**：只有"安静多久"和"进程退没退出"。这正是实测 `mc --code` 撞到的坑——Claude Code 停在信任提示上安静了 6.7 秒，静默看着像"完了"。

所以三家给出的结论其实一致：**要可靠地判断，要么有进程级状态（命令式），要么有程序自报的状态（TUI）**；纯靠静默都不可靠。

## 值得抄的四条

1. **句柄模型，不是"那个终端"**（三家都是）。我们的 `terminalId` + 会话归属已经对齐；错误码用 `terminal_not_found` / `terminal_not_owner` 也是这个意思。
2. **开局把命令连同回车一起送**（cmux 的 `--command`、我们的 `terminal_open`）。省掉"先 send 再 send Enter"的两步，也就少一个"忘了按回车"的失败模式。
3. **副作用之后不盲目重试**（cmux skill）：超时或未知结果先只读检查，再决定，不自动重发。我们的 `terminal_write` 同理，工具说明里应写死这条。
4. **人还在打草稿时不要插话**（herdr 的 `draft wait`：检测到未发送的草稿就等，最多 60 秒）。我们现在只允许 agent 碰自己的终端，所以暂时用不上；一旦允许 agent 往用户的终端写，这条必须补。

## 两条可以现在就改的

1. **`terminal_wait` 的语义再往前挪一步**：允许它接受 `until: "quiet" | "exited"`（默认 `quiet`），并把"静默 ≠ 完成"写进工具描述（已经计划写）。这样模型至少有两档语义可选，而不是拿一个含糊的"等了"。
2. **留一个 OSC 7501 的钩子**：宿主顺手解析输出里的 `\e]7501;state=…`，`terminal_read` 多返回一个 `reported` 字段。今天 Claude Code / Codex 不报，但 `pi`、Amp 这类会报的产品在增多（herdr 的资料里列了一排），而且这对我们**自己的 pi** 是免费的——将来"在 Atrium 的终端里跑 pi"也能显示 working/blocked。成本：一个正则 + 一个字段，不改变任何现有行为。

## 不建议抄的

- **只给增量输出**（Claude Code）：那是给非交互命令用的；TUI 的"增量"是重画序列，模型读不懂。整屏文本才对。
- **`filter` 丢弃未命中的行**：一次判断失误就永久丢内容，对读屏没有意义。
- **让 agent 读屏判断用户终端**：cmux 允许（它管的是同一批终端），我们不允许——用户正在敲的终端，agent 连读都不行。

## 参考

- Claude Code 的背景任务：`Bash(run_in_background)` 返回 `shellId`；`BashOutput(shell_id, filter?)` 返回自上次以来的输出与 `status`；`KillBash(shell_id)`。见社区整理的[工具 schema 摘要](https://deepwiki.com/x1xhlol/system-prompts-and-models-of-ai-tools/5.4.4-shell-command-execution)与[背景任务章节](https://github.com/yPin9/Learning-with-Claude/blob/main/ai/harness_engineering/31-background-tasks.md)。
- herdr：[`hc` 命令与语义](https://herdr.dev/core/)、[Agent automation 与状态来源](https://herdr.dev/docs/preview/agents/)、[对比页](https://herdr.chefgroep.nl/compare/)。
- cmux：本机安装的 `~/.pi/agent/skills/cmux/SKILL.md` 与 `references/panes-surfaces.md`（`--command` 的行为、显式 handle、副作用后不重试）。
