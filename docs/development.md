# 开发环境与流程

> 2026-10-04 定，M1.1 搭好骨架时按实际情况补全。

## 环境与版本

| 项 | 要求 | 说明 |
|---|---|---|
| 系统 | macOS 13 及以上 | v0.1 只做 macOS；13.0 是 Electron 44 的最低要求 |
| Node.js | ≥ 22.19 | pi 的要求；开发和测试里都要跑 pi |
| pnpm | 12.9.1 | 根 `package.json` 的 `packageManager` 字段固定 |
| Electron | 44.5.1（自带 Node 24.21、Chromium 152） | 宿主跑在它自带的 Node 里（`utilityProcess`） |
| TypeScript | 7.0.2 | 原生实现，没有 JS 编译 API，依赖它的工具（如 Stryker 的 tsconfig 改写）要绕开 |
| git | ≥ 2.38 | 合并状态的判定要用 `git merge-tree --write-tree` |
| pi | 最低 1.0.1 | [pi-internals.md](research/pi-internals.md) 基于 1.0.1；M1.1 时本机装的是 1.0.2。pi 升级时先跑契约测试（`pnpm test:pi`） |

依赖一律锁定精确版本，升级单独提交（[coding-standards.md](architecture/coding-standards.md#依赖)）。

## 分支

- 每个里程碑开一个分支，如 `m1.1-skeleton`；完成并通过该里程碑的完成标准后，在本地合并回 `main`。
- 合并前可以用 `/code-review` 审查整个分支。
- 只在明确要求时推送。
- 原型在 `prototype/ui` 分支，不合并进 `main`。

## 提交

- 作者 `Ktoon <daodi154@gmail.com>`。
- 提交信息用英文、祈使句；正文说明改了什么、为什么。
- 每个提交都能通过 `pnpm check` 和第 1、2 层测试（lefthook 在提交和推送前检查）。

## 第一次准备

```sh
pnpm install                                                  # postinstall 会下载 Electron 的二进制
pnpm exec playwright install chromium chromium-headless-shell # 浏览器组件测试和端到端测试用
```

本机需要装好 pi（第 3 层契约测试会真的运行它）。

## 命令

| 命令 | 内容 |
|---|---|
| `pnpm dev` | 构建宿主和 Electron 主进程，启动 Vite（界面热更新，端口 5791，可用 `ATRIUM_DEV_PORT` 改）和 Electron。数据写在真实的 `~/.atrium`。改了宿主或主进程后重启它 |
| `pnpm build` | 构建宿主（单文件 `packages/host/dist/entry.cjs`）、界面、Electron 主进程和预加载脚本 |
| `pnpm package` | 构建后打包成本机用的 `apps/desktop/out/Atrium-darwin-<架构>/Atrium.app`（只做 ad-hoc 签名，不公证；[overview.md · 桌面端怎么启动宿主](architecture/overview.md#桌面端怎么启动宿主)）。拷进"应用程序"后从程序坞或 Spotlight 打开；数据同样在 `~/.atrium`，和 `pnpm dev` 不能同时开。改了代码要重新打包 |
| `node packages/host/dist/entry.cjs` | 不经 Electron 单独运行宿主；第一行输出地址和 token（只打到终端，不进日志） |
| `pnpm usage [日志目录]` | 按宿主的每次运行汇总日志里每分钟的资源计数和内存（宿主和 Electron 各进程），列出每小时的数值，第一个小时和最后一个小时的最低值对比，持续上涨的标 `↑`（[testing.md · 运行时监控](architecture/testing.md#运行时监控)）；默认读 `~/.atrium/logs` |
| `pnpm trace <trace id> [日志目录]` | 按 trace id 打印一条链路的 span 树和日志；默认读 `~/.atrium/logs` |
| `pnpm fixtures:record` | 用本机 pi 重录全部 pi 夹具，删掉其他版本的夹具目录；提交前审查 diff（testing.md"pi 夹具"） |
| `pnpm pi:try "<提示词>"` | 用宿主的组件直接驱动真实 pi：读登录 shell 环境、找 pi、发一条提示词，在终端里流式打出回复，结束时给出 trace id（日志在 `~/.atrium/dev-logs`）。`--cwd <目录>` 指定工作目录，`--keep-session` 保留会话文件，`--inherit-env` 跳过登录 shell，`--` 之后的参数原样交给 pi。会真的调用模型 |
| `pnpm check` | 格式、代码检查（含 JSDoc）、类型检查、knip |
| `pnpm mutation:nightly:install` | 装上每晚的全量变异测试（见下文）；加 `uninstall` 卸掉 |

测试命令见 [testing.md · 命令](architecture/testing.md#命令)。

## 夜间变异测试

全量变异测试每晚 02:00 在 `main` 上跑一次（2026-10-09 定，规则见 [testing.md · 让每个测试都有效](architecture/testing.md#让每个测试都有效)）。

- 装上：在仓库里运行 `pnpm mutation:nightly:install`。它写 `~/Library/LaunchAgents/com.atrium.nightly-mutation.plist` 并交给 launchd，记下当时 `node` 所在的目录；换了 Node 版本要重新装一次。`pnpm mutation:nightly:install uninstall` 卸掉。
- 跑什么：launchd 运行 `main` 上的 `scripts/nightly-mutation.sh`，不管当前检出的是哪个分支。它在单独的 worktree（`~/.cache/atrium-mutation`）里检出 `main` 的最新提交，装依赖，用 `caffeinate` 保持唤醒跑 `pnpm test:mutation --force`。`main` 没变就不跑；上一次还没跑完就跳过。
- 看结果：`~/Library/Logs/Atrium/mutation/latest.txt` 写着提交、起止时间、各组的分数，以及存活和超时的变异（变异测试分组见 testing.md）；当晚的完整输出在同目录的 `<日期>.log`。跑完会弹一条系统通知。早上先看它，存活的当天处理，超时要说得清为什么会卡住。
- Mac 在 02:00 睡着时，launchd 在下次唤醒后补跑。想让它准点跑，可以自己用 `sudo pmset repeat wakeorpoweron MTWRFSU 01:55:00` 让 Mac 定时唤醒（需要管理员权限，脚本不替你设）。
