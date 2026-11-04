# 外部 cmux 终端：最小接入

2026-11-04，M1.11 自用后补充。用户确认先用 pi 的 skill 和 Bash 接外部终端；现有能力不够时先说明缺口，再取得业务代码修改授权。本文不沿用旧终端分支、reports、临时实例或历史 PID。

## 边界

```text
Atrium 的 pi agent → Bash → 官方 cmux CLI → cmux 原生终端
```

- pi 负责发现 skill、读取操作说明、调用已有 Bash。Atrium 不增加工具、协议、UI、服务或终端绑定。
- cmux 和用户拥有窗口、PTY、显示、终端 shell 和任务生命周期。Atrium 退出、停止回复、空闲回收或归档不主动关闭外部终端。
- 不提供内嵌终端、PTY owner、中继、VT/xterm、自动工作区绑定、结构化 `@terminal` 或归档自动停止任务。
- **不保证归档前所有终端任务已停止。** 归档删除工作目录仍可能影响外部任务；产品级保证需另立需求。
- Skill 是行为约定，不是同用户 Bash 的权限沙箱；不承诺阻止访问其他终端或读取同用户凭据。

## 安装与版本

当前本机已按用户授权从 Homebrew 主仓库安装 `homebrew/cask/cmux`：

| 项 | 位置 / 版本 |
|---|---|
| App | `/Applications/cmux.app` |
| CLI | `/opt/homebrew/bin/cmux` → App 的 `Contents/Resources/bin/cmux` |
| Homebrew cask | `0.65.2.2` |
| App / CLI | `0.65.2 (113)`，源码 `12023d89f` |
| pi | `1.5.0` |
| skill 上游 | `manaflow-ai/cmux` release `v0.65.2.2`，commit `12023d89feb5425c766ba05e8d8e4cfc176e3991` |
| skill 目标 | 当前 pi agent 目录下的 `skills/cmux/`、`skills/cmux-workspace/` |

两个 skill 已安装；cmux 已经用户明确授权切到 password 模式，官方目录 `0700`、密码文件 `0600`，值不进入对话。配置备份位置见安装清单。

当前 agent 目录为 `~/.pi/agent`。宿主从登录 shell 读环境，`PI_CODING_AGENT_DIR` 若另有配置，以实际值为准；不能把安装到 `~/.codex/skills` 当作 Atrium 可用。用户级安装也会影响该账户其他使用这份配置的 pi 会话，不是 Atrium 专属隔离。

安装仅选择两个官方 skill，完整保留其 references 和元数据。安装前检查同名目录，存在时先核对并备份，不让官方脚本直接覆盖用户内容。不批量安装其他 skills 或 hooks，不修改 shell、网络配置或设为默认终端。App 和 CLI 来自同一个安装，避免版本漂移。

官方安装器支持：

```sh
# 先下载并审阅固定 commit 的 skills.sh，再运行它；不要运行浮动 main。
bash <已审阅的安装器> \
  --ref 12023d89feb5425c766ba05e8d8e4cfc176e3991 \
  --dest <实际-pi-agent-目录>/skills \
  --skill cmux --skill cmux-workspace
```

## 外部调用规则：两个 skill 的最小本地修订

官方 `cmux-workspace` 在调用方环境 ID 缺失时会建议使用当前焦点；Atrium 的 agent 并不在 cmux 终端里，这条默认规则不适用。

保留官方主体，在两个 `SKILL.md` 正文开头加入相同的外部调用规则，并替换 workspace skill 中冲突的焦点回退句；cmux 的 description 补充外部命令、读屏和按键触发；workspace 的 Socket access 修正为本次正式安装的 CLI 和 state socket 路径，不沿用上游示例的 `/tmp/cmux.sock`。精确差异在 [cmux-skills.patch](../research/cmux-skills.patch)，9 个安装文件的版本和 SHA-256 在 [安装清单](../testing/cmux-installation.json)。安装后用 `patch -p1 -d <实际-pi-agent-目录>/skills < docs/research/cmux-skills.patch` 应用修订；更新前审查差异，不能直接覆盖。

1. 从用户明确指定或本轮创建结果取得目标。目标不明时询问或创建新窗口，不选择当前焦点。环境变量即使存在，也不自动视为用户授权。
2. 每次 CLI 调用显式传 `--socket`。已有目标按 `socket + window + workspace + surface` 核对；向终端输入和读屏明确传 workspace、surface，创建工作区明确传 window。短 ref 便于交流，跨调用保留 UUID；实例重启或目标失效后重新确认。
3. 不以 `identify` / `current-workspace` 的聚焦结果取得授权。目标查询只在已知范围内；允许列出元数据供用户选择，但不据此自动选择用户的窗口。
4. 终端创建只作用于本轮新建或用户授权的容器；命令支持时用 `--focus false`。拒绝有效目标时停止并报告，不切焦点补救。
5. 文本、Enter、Ctrl+C 和创建时的 `--command` 都是有副作用的输入。超时或结果未知时不自动重发；先读屏核实，不能确定就询问用户。允许有界重试只读查询。
6. `--command` 已附带一次 Enter，不额外发送。CLI 成功不是 shell 命令完成，真实读屏或命令自身的输出标记才是结果依据。
7. 不自动关闭、整理、复用旧窗口或 helper pane。退出 Atrium、归档或停止 agent 不发送外部关闭 / 停止动作。
8. 正常操作只让官方 CLI 读取官方密码存储。凭据不进 skill、模型提示词、命令参数或日志，不 export 到终端 shell；环境检查只报告相关变量是否存在，不输出完整环境。

上述约定不构成强制权限控制，也不提供 exactly-once 输入保证。

## 授权

正式安装的 socket 是 `~/.local/state/cmux/cmux.sock`（本机重新检查所得，不使用旧临时路径）。实际命令传它的绝对路径；不依赖 CLI 的 tagged/debug 自动发现。

默认 `cmuxOnly` 会拒绝 Atrium 的外部调用。采用官方 password 模式，不启用 `allowAll`，不为了方便改成无密码 automation。**修改全局授权前取得用户明确许可。**

release 源码的 `SocketPasswordResolver` 支持 CLI 自行读取 `~/.local/state/cmux/socket-control-password`；官方存储目录为 `0700`，密码文件为 `0600`。密码由 cmux 原生设置或经用户授权的本机配置过程写入，值不经对话。配置文件先备份，JSONC 保留注释及无关项；密码不写入 cmux.json，不导出 `CMUX_SOCKET_PASSWORD`。

App、CLI 与终端使用正常账户环境。私有 HOME 不意味着终端子进程隔离，macOS login 可能恢复账户 HOME；本方案不靠私有 HOME 实现隔离。即使没有凭据环境变量，同用户终端仍可能读取官方密码文件。

## 使用

在新启动的真实 Atrium pi 会话中确认 `/skill:cmux`、`/skill:cmux-workspace` 可见；agent 先读取两个 skill，再操作明确目标。

```sh
# 以下变量由用户明确指定或本轮创建结果提供；不是工作区自动绑定。
CLI=/opt/homebrew/bin/cmux
"$CLI" --socket "$SOCKET" send --workspace "$WORKSPACE" --surface "$SURFACE" 'printf "终端接入成功\\n"'
"$CLI" --socket "$SOCKET" send-key --workspace "$WORKSPACE" --surface "$SURFACE" enter
"$CLI" --socket "$SOCKET" read-screen --workspace "$WORKSPACE" --surface "$SURFACE"
"$CLI" --socket "$SOCKET" send-key --workspace "$WORKSPACE" --surface "$SURFACE" ctrl+c
```

新终端的首条命令可用官方 `--command`，无需再发 Enter。按安装版本核对输出格式：部分旧创建命令即使传 `--json` 仍输出 `OK <id>`，不能假定所有返回都为 JSON。

## 验收与恢复

实际结果见 [测试追踪表](../testing/coverage-map.md#外部-cmux-终端最小接入2026-11-04)。普通 CLI 探针、源码和 faux 不替代真实 Atrium 的 agent：

- 在实际 App 的新 pi 会话中验证两个 skill 的发现、正文读取和 Bash 调用；保留会话标识及安全的证据摘要，不复制凭据。
- 新建本轮专用 A/B 终端；读回不同随机标记和中文的真实输出。用户焦点在另一边时重复，检查两个终端无串输入，不以切焦点修复。
- 分开发文本与 Enter；对有寿命上限的任务发送 Ctrl+C，再执行 shell 命令确认可用。
- 无目标时询问；不存在的明确目标失败，不回退；结果未知不重发属于 skill 约定，未做故障注入时如实写明。
- 检查被控 shell 的 HOME 和凭据环境变量的存在性，不输出变量值；正常路径的凭据不出现在会话和日志里。不能据此承诺抵御同用户恶意 Bash。
- 退出保活由用户验收，或使用本次单独启动、`ATRIUM_HOME` 独立的真实 App 测试实例退出；不退出用户正在使用的 App。独立数据目录仅隔离 Atrium 数据，不隔离 cmux 终端或 pi 凭据。
- 不改生产代码时只做文档检查、安装内容检查和相关真实验收；不扩成性能、全量变异或终端内核工程。

回退仅移除本次安装的两个 skill（先核对本地修改），恢复本次备份的 cmux 配置。授权关闭后外部控制不可用，但不主动关闭 cmux 任务。用户验收前保留分支和 worktree，不合并、清理或推送。

## 官方依据

- [安装](https://cmux.com/docs/getting-started)
- [Skills](https://cmux.com/docs/skills)、[CLI](https://cmux.com/docs/cli)
- [固定版本 cmux skill](https://github.com/manaflow-ai/cmux/tree/12023d89feb5425c766ba05e8d8e4cfc176e3991/skills/cmux)
- [固定版本 cmux-workspace skill](https://github.com/manaflow-ai/cmux/tree/12023d89feb5425c766ba05e8d8e4cfc176e3991/skills/cmux-workspace)
- 鉴权以该 commit 的 `CLI/cmux.swift`（`SocketPasswordResolver`）、`Packages/macOS/CmuxSettings/Sources/CmuxSettings/SocketControl/SocketControlPasswordStore.swift` 为准；网页的访问模式列表不完整。
