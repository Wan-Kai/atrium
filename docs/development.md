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

- 每个里程碑开一个分支，如 `m1.1-skeleton`；完成并通过该里程碑的完成标准后，在本地合并回 `main`。自用中的零散改动每件开一个 `self-use-<主题>` 分支，调研开 `research-<主题>`（见下文"标准开发流程"）。
- 合并前可以用 `/code-review` 审查整个分支。
- 只在明确要求时推送。
- 原型在 `prototype/ui` 分支，不合并进 `main`。

## 提交

- 作者 `Ktoon <daodi154@gmail.com>`。
- 提交信息用英文、祈使句；正文说明改了什么、为什么。
- 每个提交都能通过 `pnpm check` 和第 1、2 层测试（lefthook 在提交和推送前检查）。

## 标准开发流程

2026-10-20 定，把 M1.11 到 M1.15 实际走顺的做法写下来。每件事都按这个顺序走；新会话从 `AGENTS.md` 和路线图读到这里。

1. **开 worktree**：在 `../atrium.worktrees/<主题>` 新建分支（`git worktree add ../atrium.worktrees/<主题> -b <分支> main`），进去后 `pnpm install --offline`。主工作区（`atrium/`）常有别的会话在改，不在那里干活，也不动它里面不属于自己的改动。
2. **先改文档**：SPEC、design-language、domain-model、security 等按改动对应的改；自用中改的写明"某月某日自用时改，原先怎样、为什么改"。文档没覆盖到的设计问题先问用户，不自己定。
3. **看得见的改动先做原型**：原型放在 `prototype/ui` 分支的 worktree（本机是 `~/.cache/atrium-proto-wt`）的 `prototypes/<名字>-prototype.html`，一个文件、双击就能打开，比较 3～4 种明显不同的做法，浅色、深色都看。请用户选，选中的写进 design-language，注明"原型某某的 X"。用户都不满意就再出一批。
4. **测试先行**：一个测试、一段实现交替推进，每个测试先见过失败；修 bug 先写能复现它的测试。写完用 `pnpm break-check <cases.json>` 把代码按每个 case 改坏，确认测试会红（`MISSED` 的要补测试，确实等价的说明原因）。新行为登记进 `docs/testing/coverage-map.md`，自用中的改动记在"M1.11 自用中改（日期）"一节。
5. **检查与变异测试**：格式化改过的文件（`(git diff --name-only; git ls-files --others --exclude-standard) | grep -E '\.(ts|tsx|md|css|mjs)$' | xargs npx oxfmt`），`pnpm check` 通过，跑相关的测试层。改到核心模块时只对改动的文件跑变异测试（`pnpm test:mutation <组> --mutate=<文件>`），存活的补测试或注明等价（`// Stryker disable next-line <变异> : 原因`）。跑完按进程号清掉 Stryker 留下的孤儿进程（父进程是 1、命令行在本 worktree 的 `.stryker-tmp/` 里的），删掉 `.stryker-tmp`（里面有测试故意留的只读目录，先 `chmod -R u+rwx`）；worktree 根目录不留 `.tmp/`。
6. **审查**：里程碑或大的改动合并前做三方审查：两个外部模型加一个 Claude 子代理，各自只读审查，按"和 SPEC/ADR 不一致、竞态、安全、资源泄漏、界面是否按设计、测试缺口"逐条报，带严重程度、文件行号、触发场景。外部模型用哪两个由用户定，不自己换；合并去重后把需要拍板的设计问题交给用户，其余按测试先行修掉。
7. **装上试用**（用户要试的时候）：`pnpm package`；先看正在跑的 Atrium 下有几个 pi（重启会中断它们的回复），问过用户再用 `osascript -e 'tell application "Atrium" to quit'` 退出，替换 `/Applications/Atrium.app`（`ditto`），重新打开，看一眼宿主日志有没有新的错误。
8. **合并**：用户说"提交"才提交；合回 `main` 前先把 `main` 合进分支、`pnpm check` 和单元测试通过，再在主工作区 `git merge --no-ff`（它里面别人的未提交改动不碰，合并不涉及那些文件才合）。合完删掉分支和 worktree（装包要用的话装完再删）。只在用户明确要求时推送。

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
| `pnpm readme:shots` | 构建后重拍 README 的六张截图，覆盖 `docs/images/*.png`（1920×1145）。只用演示数据：临时目录里现造的 `weather-app` 仓库（本地 bare origin 和两个 worktree）、临时的 Atrium 主目录、pi 配置目录和 HOME，`PI_OFFLINE=1`；模型是以真实服务商名字注册的 faux（`packages/testkit/src/faux/readme-extension.ts` 按 `apps/desktop/e2e/readme/story.ts` 的脚本回复），ChatGPT 的模型列表和用量由本机的替身服务给出，不发真实请求，不碰 `~/.atrium`。用 `screencapture` 截应用窗口，窗口会被提到最前，跑的约 3 分钟里别动它；终端要有"屏幕录制"权限。六张图在同一段故事里依次拍出，不能只拍其中一张；跑完看一眼 `git diff docs/images`，不满意就 `git checkout -- docs/images` |
| `pnpm pi:try "<提示词>"` | 用宿主的组件直接驱动真实 pi：读登录 shell 环境、找 pi、发一条提示词，在终端里流式打出回复，结束时给出 trace id（日志在 `~/.atrium/dev-logs`）。`--cwd <目录>` 指定工作目录，`--keep-session` 保留会话文件，`--inherit-env` 跳过登录 shell，`--` 之后的参数原样交给 pi。会真的调用模型 |
| `pnpm check` | 格式、代码检查（含 JSDoc）、类型检查、knip |
| `pnpm break-check <cases.json>` | 破坏检查：按每个 case（`{ file, from, to, test, name, project? }`，`from` 在文件里恰好出现一次）把代码改坏，跑那个测试（`vitest run --project <project，默认 unit> <test> -t <name>`），打印 `CAUGHT` 或 `MISSED`，再改回去；有漏掉的退出码为 1。被中断时也会改回去（见上文"标准开发流程"第 4 步） |
| `pnpm mutation:nightly:install` | 装上每晚的全量变异测试（见下文）；加 `uninstall` 卸掉 |

测试命令见 [testing.md · 命令](architecture/testing.md#命令)。

## 夜间变异测试

全量变异测试每晚 02:00 在 `main` 上跑一次（2026-10-09 定，规则见 [testing.md · 让每个测试都有效](architecture/testing.md#让每个测试都有效)）。

- 装上：在仓库里运行 `pnpm mutation:nightly:install`。它写 `~/Library/LaunchAgents/com.atrium.nightly-mutation.plist` 并交给 launchd，记下当时 `node` 所在的目录；换了 Node 版本要重新装一次。`pnpm mutation:nightly:install uninstall` 卸掉。
- 跑什么：launchd 运行 `main` 上的 `scripts/nightly-mutation.sh`，不管当前检出的是哪个分支。它在单独的 worktree（`~/.cache/atrium-mutation`）里检出 `main` 的最新提交，装依赖，用 `caffeinate` 保持唤醒跑 `pnpm test:mutation --force`。`main` 没变就不跑；上一次还没跑完就跳过。
- 看结果：`~/Library/Logs/Atrium/mutation/latest.txt` 写着提交、起止时间、各组的分数，以及存活和超时的变异（变异测试分组见 testing.md）；当晚的完整输出在同目录的 `<日期>.log`。跑完会弹一条系统通知。早上先看它，存活的当天处理，超时要说得清为什么会卡住。
- Mac 在 02:00 睡着时，launchd 在下次唤醒后补跑。想让它准点跑，可以自己用 `sudo pmset repeat wakeorpoweron MTWRFSU 01:55:00` 让 Mac 定时唤醒（需要管理员权限，脚本不替你设）。
