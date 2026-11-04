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
| Xcode | 26.6（Swift 6.3、swift-format 6.3、iOS 26.5 模拟器） | 只有手机端（`apps/ios`）要；没装时 `pnpm check`、`pnpm test` 跳过 Swift 部分并提示，`pnpm test:ios`、`pnpm ios:*` 报错退出（2026-10-25，MP1） |
| pi | 最低 1.0.1 | [pi-internals.md](research/pi-internals.md) 基于 1.0.1；M1.1 时本机装的是 1.0.2。pi 升级时先跑契约测试（`pnpm test:pi`） |

依赖一律锁定精确版本，升级单独提交（[coding-standards.md](architecture/coding-standards.md#依赖)）。

## 分支

- 每个里程碑开一个分支，如 `m1.1-skeleton`；完成并通过该里程碑的完成标准后，先请用户验收，用户明确确认通过后再在本地合并回 `main`。自用中的零散改动每件开一个 `self-use-<主题>` 分支，调研开 `research-<主题>`（见下文"标准开发流程"）。
- 合并前可以用 `/code-review` 审查整个分支。
- 只在明确要求时推送。

## 提交

- 作者 `Ktoon <daodi154@gmail.com>`。
- 提交信息用英文、祈使句；正文说明改了什么、为什么。
- 每个提交都能通过 `pnpm check` 和第 1、2 层测试（lefthook 在提交和推送前检查）。

## 标准开发流程

2026-10-20 定，把 M1.11 到 M1.15 实际走顺的做法写下来；2026-10-21 按用户要求将收尾改为先验收、确认通过后再合并和删除原 worktree，并将原型改为随任务存放，避免多个 agent 共用工作区、混杂未提交设计稿。每件事都按这个顺序走；新会话从 `AGENTS.md` 和路线图读到这里。

1. **开 worktree**：在 `../atrium.worktrees/<主题>` 新建分支（`git worktree add ../atrium.worktrees/<主题> -b <分支> main`），进去后 `pnpm install --offline`。主工作区（`atrium/`）常有别的会话在改，不在那里干活，也不动它里面不属于自己的改动。
2. **先改文档**：SPEC、design-language、domain-model、security 等按改动对应的改；自用中改的写明"某月某日自用时改，原先怎样、为什么改"。文档没覆盖到的设计问题先问用户，不自己定。
3. **看得见的改动先做原型**：在本任务自己的分支和 worktree 内创建 `prototypes/<名字>-prototype.html`，不另开共享原型分支或切到其他任务的 worktree。每份原型一个 HTML 文件、双击就能打开，比较 3～4 种明显不同的做法，浅色、深色都看。请用户选，选中的写进 design-language，注明"原型某某的 X"。用户都不满意就再出一批。保留的设计稿及其引用的资源随任务提交，验收后一起合并进 `main`；仅作设计参考，不接入生产构建。
4. **测试先行**：一个测试、一段实现交替推进，每个测试先见过失败；修 bug 先写能复现它的测试。写完用 `pnpm break-check <cases.json>` 把代码按每个 case 改坏，确认测试会红（`MISSED` 的要补测试，确实等价的说明原因）。新行为登记进 `docs/testing/coverage-map.md`，自用中的改动记在"M1.11 自用中改（日期）"一节。
5. **检查与变异测试**：格式化改过的文件（`(git diff --name-only; git ls-files --others --exclude-standard) | grep -E '\.(ts|tsx|md|css|mjs)$' | xargs npx oxfmt`），`pnpm check` 通过，跑相关的测试层。改到核心模块时只对改动的文件跑变异测试（`pnpm test:mutation <组> --mutate=<文件>`），存活的补测试或注明等价（`// Stryker disable next-line <变异> : 原因`）。跑完按进程号清掉 Stryker 留下的孤儿进程（父进程是 1、命令行在本 worktree 的 `.stryker-tmp/` 里的），删掉 `.stryker-tmp`（里面有测试故意留的只读目录，先 `chmod -R u+rwx`）；worktree 根目录不留 `.tmp/`。
6. **审查**：里程碑或大的改动合并前做三方审查：两个外部模型加一个 Claude 子代理，各自只读审查，按"和 SPEC/ADR 不一致、竞态、安全、资源泄漏、界面是否按设计、测试缺口"逐条报，带严重程度、文件行号、触发场景。外部模型用哪两个由用户定，不自己换；合并去重后把需要拍板的设计问题交给用户，其余按测试先行修掉。
7. **请用户验收**：实现、自查和审查完成后，主动通知用户，给出待验收版本、worktree 路径、启动方式、操作步骤、预期结果及已知限制，保留本任务分支和 worktree，等待用户明确确认验收通过。测试通过或自己认为完成不代替用户验收；未通过时在本任务 worktree 修复、复验，再请用户验收。用户要装上试用时才运行 `pnpm package`；先看正在跑的 Atrium 下有几个 pi（重启会中断它们的回复），问过用户再用 `osascript -e 'tell application "Atrium" to quit'` 退出，替换 `/Applications/Atrium.app`（`ditto`），重新打开；打包的签名（2026-11-03 起）：设了 `ATRIUM_CODESIGN_IDENTITY`（`security find-identity -v -p codesigning` 里的一条）就用那张证书签，TCC 的 designated requirement 变成「bundle id + 证书」，换装不再让 macOS 忘记已授过的「文稿」等权限；不设仍走 ad-hoc，它的 requirement 是二进制的 cdhash，每次换装都算一个新 app，macOS 会重新问能否访问"文稿"文件夹，先在系统弹窗里点允许，否则 `~/Documents` 下项目里的 git、pi、读文件都会挂住到点了为止（2026-10-24 查明，见 [self-use.md · 问题](research/self-use.md#问题)）。换签名后旧记录还在，先 `tccutil reset SystemPolicyDocumentsFolder dev.atrium.app` 再让它问一次。用一阵后跑 `pnpm errors` 看有没有新的错误签名。
8. **验收通过后合并与清理**：收到用户明确确认验收通过后，按提交约定收尾（用户说"提交"才提交）；合回 `main` 前先把 `main` 合进分支、`pnpm check` 和单元测试通过，再在主工作区 `git merge --no-ff`（它里面别人的未提交改动不碰，合并不涉及那些文件才合）。准备合并期间若改变了验收内容，重新请用户验收。合并成功后，确认原 worktree 无未保存的用户内容、无仍在运行的开发或验收服务，再以非强制方式删除本任务原 worktree 和已合并分支；存在未保存内容、仍在使用或用户要求保留时，保留并报告，不为清理终止用户进程或强制删除。只在用户明确要求时推送。

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
| `pnpm package` | 构建后打包成本机用的 `apps/desktop/out/Atrium-darwin-<架构>/Atrium.app`（`ATRIUM_CODESIGN_IDENTITY` 指定代码签名证书，不设则只做 ad-hoc 签名，都不公证；[overview.md · 桌面端怎么启动宿主](architecture/overview.md#桌面端怎么启动宿主)）。拷进"应用程序"后从程序坞或 Spotlight 打开；数据同样在 `~/.atrium`，和 `pnpm dev` 不能同时开。改了代码要重新打包 |
| `node packages/host/dist/entry.cjs` | 不经 Electron 单独运行宿主；第一行输出地址和 token（只打到终端，不进日志） |
| `pnpm usage [日志目录]` | 按宿主的每次运行汇总日志里每分钟的资源计数和内存（宿主和 Electron 各进程），列出每小时的数值，第一个小时和最后一个小时的最低值对比，持续上涨的标 `↑`（[testing.md · 运行时监控](architecture/testing.md#运行时监控)）；默认读 `~/.atrium/logs` |
| `pnpm errors [日志目录] [--since <ISO 时间>]` | 把日志里的 warn、error、fatal 按签名（service、level、msg、`err` 的类型和码，界面上报的再加归一后的问题文字）分组，列出次数、首次和最后出现的时间、涉及几次宿主运行；截止时间（默认最近一次宿主启动，`--since` 可改）之后才第一次出现的签名标 `new`、排在前面（[testing.md · 运行时监控](architecture/testing.md#运行时监控)）。只读；默认读 `~/.atrium/logs` |
| `pnpm trace <trace id> [日志目录]` | 按 trace id 打印一条链路的 span 树和日志；默认读 `~/.atrium/logs` |
| `pnpm fixtures:record` | 用本机 pi 重录全部 pi 夹具，删掉其他版本的夹具目录；提交前审查 diff（testing.md"pi 夹具"） |
| `pnpm readme:shots` | 构建后重拍 README 的六张截图，覆盖 `docs/images/*.png`（1920×1145）。只用演示数据：临时目录里现造的 `weather-app` 仓库（本地 bare origin 和两个 worktree）、临时的 Atrium 主目录、pi 配置目录和 HOME，`PI_OFFLINE=1`；模型是以真实服务商名字注册的 faux（`packages/testkit/src/faux/readme-extension.ts` 按 `apps/desktop/e2e/readme/story.ts` 的脚本回复），ChatGPT 的模型列表和用量由本机的替身服务给出，不发真实请求，不碰 `~/.atrium`。用 `screencapture` 截应用窗口，窗口会被提到最前，跑的约 3 分钟里别动它；终端要有"屏幕录制"权限。六张图在同一段故事里依次拍出，不能只拍其中一张；跑完看一眼 `git diff docs/images`，不满意就 `git checkout -- docs/images` |
| `pnpm pi:try "<提示词>"` | 用宿主的组件直接驱动真实 pi：读登录 shell 环境、找 pi、发一条提示词，在终端里流式打出回复，结束时给出 trace id（日志在 `~/.atrium/dev-logs`）。`--cwd <目录>` 指定工作目录，`--keep-session` 保留会话文件，`--inherit-env` 跳过登录 shell，`--` 之后的参数原样交给 pi。会真的调用模型 |
| `pnpm check` | 格式、代码检查（含 JSDoc）、类型检查、knip、`pnpm boundary --all` |
| `pnpm boundary [基准]` | 列出基准（默认 `git merge-base HEAD main`）以来的提交、未提交改动和未跟踪新文件碰到的外部边界：依赖增删改（标出非精确版本）、生产代码里新增和删掉的地址、环境变量、隐藏命令（标出是否已在 [security.md · 外部边界登记](architecture/security.md#外部边界登记) 登记）、`PROTOCOL_VERSION` 的变化（协议文件改了、版本没变时警告）、改动文件里的 `@sideEffects` 矛盾。新增了未登记的或非精确版本时退出码为 1。`--all` 拿全部生产代码对照登记表，接在 `pnpm check` 里 |
| `pnpm break-check <cases.json>` | 破坏检查：按每个 case（`{ file, from, to, test, name, project? }`，`from` 在文件里恰好出现一次）把代码改坏，跑那个测试（`vitest run --project <project，默认 unit> <test> -t <name>`），打印 `CAUGHT` 或 `MISSED`，再改回去；有漏掉的退出码为 1。被中断时也会改回去（见上文"标准开发流程"第 4 步）。Swift 的 case 写 `{ file, from, to, name, runner: "swift", filter, package? }`，跑 `swift test --filter <filter>`（2026-10-25 加，[testing.md · Swift（手机端）](architecture/testing.md#swift手机端)） |
| `pnpm protocol:swift [--check]` | 从 `packages/protocol` 重新生成 Swift 的协议类型（`apps/ios/AtriumKit/Sources/AtriumProtocol/Generated/Protocol.swift`），再写出往返测试的夹具；`--check` 只在内存里生成、和提交的文件比，不一致退出码 1（接在 `pnpm check` 里）。遇到生成器不支持的 schema 构造时报错，写明位置（[testing.md · Swift（手机端）](architecture/testing.md#swift手机端)） |
| `pnpm ios:format` | 用 Xcode 自带的 `swift format` 改写 `apps/ios` 下的 Swift 文件（生成的除外） |
| `pnpm ios:build [--simulator]` | 用 `xcodebuild` 构建 App：默认给真机（`generic/platform=iOS`，带 `-allowProvisioningUpdates`，用 Xcode 里登录的免费账号签名），`--simulator` 给模拟器。产物在 `apps/ios/.build/xcode/`（不进 git） |
| `pnpm ios:shot [--dark]` | 在模拟器 "Atrium iPhone 16 Pro" 上构建、装好、打开 App，设成浅色或深色，3 秒后截图到 `apps/ios/.build/shots/home-<light\|dark>.png`（不进 git）并打出路径；看界面的标准手段（testing.md"Swift（手机端）"） |
| `pnpm ios:install` | 先 `pnpm ios:build`，再用 `xcrun devicectl` 装到连着的 iPhone 上并打开。没有配对过的 iPhone、或 iPhone 没连上（`devicectl` 里是 unavailable）时，在构建之前就报错，写明设备名、上次连接的时间和怎么连上。免费账号签的 App 7 天后打不开，到时重跑一次 |
| `pnpm mutation:nightly:install` | 装上每晚的全量变异测试（见下文）；加 `uninstall` 卸掉 |

真机第一次装（2026-10-26 实测，iPhone 16 Pro、iOS 26.6.1）：

1. 手机用线连上、解锁，点"信任这台电脑"；`devicectl` 里显示 `unpaired` 时跑 `xcrun devicectl manage pair --device <udid>`，手机上会弹出确认。打开"设置 › 隐私与安全性 › 开发者模式"（会重启）。
2. 第一次 `pnpm ios:install` 能装上但打不开，脚本会提示到"设置 › 通用 › VPN 与设备管理"里信任开发者，信任后再跑一次。
3. 中国大陆的 iPhone 第一次联网会弹"允许使用无线数据"，选"无线局域网与蜂窝网络"。
4. 免费账号只能给已经有描述文件的 bundle id 签名：命令行 `xcodebuild` 拿不到 Xcode 里登录的账号时（报"No Accounts"），新的 bundle id 会签不出来，要在 Xcode › Settings › Accounts 里重新登录一次。

测试命令见 [testing.md · 命令](architecture/testing.md#命令)。

### 手机端的确切命令

2026-10-25 定（MP1）。agent 和人都直接用 `pnpm` 命令；下面是它们背后实际跑的（`scripts/ios.mjs`），写死在这里免得猜 scheme 和 destination。`<仓库>` 是仓库根目录，`<udid>` 是模拟器 "Atrium iPhone 16 Pro" 的 id（`xcrun simctl list devices available | grep "Atrium iPhone 16 Pro"`；没有时 `pnpm test:ios` 在最新的 iOS 运行时上用 `com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro` 建一个），`arch` 取本机的（Apple Silicon 是 `arm64`）。

| pnpm 命令 | 实际跑的 |
|---|---|
| `pnpm test` 的 Swift 部分、`pnpm test:ios` 第一步 | `xcrun swift test --package-path <仓库>/apps/ios/AtriumKit --explicit-target-dependency-import-check error -Xswiftc -warnings-as-errors` |
| `pnpm test:ios` 第二步（拿着模拟器锁，见下文） | `xcrun xcodebuild test -project <仓库>/apps/ios/Atrium.xcodeproj -scheme Atrium -destination id=<udid>,arch=arm64 -derivedDataPath <仓库>/apps/ios/.build/xcode -quiet` |
| `pnpm ios:build` | `xcrun xcodebuild build -project <仓库>/apps/ios/Atrium.xcodeproj -scheme Atrium -configuration Debug -destination generic/platform=iOS -derivedDataPath <仓库>/apps/ios/.build/xcode -allowProvisioningUpdates -quiet`（`--simulator` 时 destination 是 `generic/platform=iOS Simulator`） |
| `pnpm ios:install` | 先 `xcrun devicectl list devices --json-output <临时文件>` 找配对过、连得上的 iPhone，再跑上面的构建，然后 `xcrun devicectl device install app --device <手机 udid> <仓库>/apps/ios/.build/xcode/Build/Products/Debug-iphoneos/Atrium.app`、`xcrun devicectl device process launch --device <手机 udid> site.ktoon.atrium` |
| `pnpm ios:shot` | 拿模拟器锁（见下文），构建（destination `id=<udid>,arch=arm64`），`simctl boot`、`simctl ui <udid> appearance light\|dark`、`simctl install`、`simctl launch --terminate-running-process <udid> site.ktoon.atrium`，等 3 秒，`simctl io <udid> screenshot <文件>` |
| `pnpm ios:check`（`pnpm check` 的最后一步） | `node scripts/protocol-swift.mjs --check`；有 Xcode 时再跑 `xcrun swift-format lint --strict --parallel --configuration <仓库>/apps/ios/.swift-format --recursive <AtriumKit 的 Package.swift、Sources、Tests，Atrium/，AtriumUITests/>` 和 `node scripts/swift-lint.mjs apps/ios` |
| `pnpm ios:format` | 同上的 `swift-format format --in-place` |

**模拟器锁**（2026-10-26 审查后加）：几个 worktree 共用一台 "Atrium iPhone 16 Pro"，一个在截图时另一个装上自己的构建，就会截到或测到别的分支的 App。所以 `pnpm test:ios` 的第二步和 `pnpm ios:shot` 从找（或建）模拟器开始、到测完或截完为止，持有一把跨 worktree 的锁：`~/Library/Caches/atrium-ios/sim.lock`，用原子的 `mkdir` 建，里面的 `owner.json` 记着进程号、进程启动时间、worktree 和命令。

- 别的 worktree 拿着时就等，先打一行"waiting for the Atrium simulator: pid … (pnpm ios:shot in <worktree>) is using it"，最多等 30 分钟，超时退出码 1。
- 记录的进程已经不在（同一个进程号、同一个启动时间的进程找不到，进程号被别的进程重用也算），或者锁目录里 30 秒还没有 `owner.json`（建完目录就被杀了），就接管，打一行"took over the Atrium simulator from pid …"。接管时先把旧锁改名挪开再删，挪开后发现主人变了就放回去。
- 进程退出时（含 Ctrl-C、`SIGTERM`）删掉自己的锁；被 `kill -9` 的留下的锁由下一个人接管。实在卡住时确认没有别的 `ios.mjs` 在跑（`ps -ef | grep scripts/ios.mjs`），再手动删这个目录。
- `pnpm test` 里的 `swift test`、`pnpm ios:build`、`pnpm ios:install` 不碰模拟器，不拿锁。

只跑一部分 Swift 测试：`swift test --package-path apps/ios/AtriumKit --filter <套件名或测试函数名>`（例：`--filter RoundTripTests`）。

## 夜间变异测试

全量变异测试每晚 02:00 在 `main` 上跑一次（2026-10-09 定，规则见 [testing.md · 让每个测试都有效](architecture/testing.md#让每个测试都有效)）。

- 装上：在仓库里运行 `pnpm mutation:nightly:install`。它写 `~/Library/LaunchAgents/com.atrium.nightly-mutation.plist` 并交给 launchd，记下当时 `node` 所在的目录；换了 Node 版本要重新装一次。`pnpm mutation:nightly:install uninstall` 卸掉。
- 跑什么：launchd 运行 `main` 上的 `scripts/nightly-mutation.sh`，不管当前检出的是哪个分支。它在单独的 worktree（`~/.cache/atrium-mutation`）里检出 `main` 的最新提交，装依赖，用 `caffeinate` 保持唤醒跑 `pnpm test:mutation --force`。`main` 没变就不跑；上一次还没跑完就跳过。
- 看结果：`~/Library/Logs/Atrium/mutation/latest.txt` 写着提交、起止时间、各组的分数，以及存活和超时的变异（变异测试分组见 testing.md）；当晚的完整输出在同目录的 `<日期>.log`。跑完会弹一条系统通知。早上先看它，存活的当天处理，超时要说得清为什么会卡住。
- Mac 在 02:00 睡着时，launchd 在下次唤醒后补跑。想让它准点跑，可以自己用 `sudo pmset repeat wakeorpoweron MTWRFSU 01:55:00` 让 Mac 定时唤醒（需要管理员权限，脚本不替你设）。

## MP4 手机连接核心验证（2026-10-26）

`apps/ios/AtriumKit` 的 `AtriumRemote` 使用可替换的传输和注入时钟；`AtriumTestSupport` 提供内存 relay、秘密存储、手动时钟和真实 Noise 响应方，不连接用户服务器。

- 快速验证：`xcrun swift test --package-path apps/ios/AtriumKit --filter AtriumRemoteTests -Xswiftc -warnings-as-errors`。
- 回归破坏检查：`pnpm break-check apps/ios/Testing/remote-breaks.json`。包含协议 26 的无 token hello、配对记录恢复、倒计时、前后台、无网恢复、心跳和阻塞发送关闭。
- `SecureChannel.close()` 给队列最多 2 秒排空（注入时钟），之后强制关闭底层传输；连接停止、换代、进入后台使用同步 `abort()`，不派无人持有的清理任务。
- 配对本地倒计时按实际经过时间计算；本地超时或正式记录写入失败不能证明 Mac 没确认，因此保留 pending，供后续 IK 补确认。宿主认证的明确拒绝才清理对应 pending。
- 实时互通：`node apps/ios/Integration/run.mjs`，真实relay绑定本机随机端口，与固定协议25的TS MP0假宿主交互，正式App使用生成的当前协议版本（现为27）。`--negative-control` 故意报错SAS，命令应失败。`--production-rejection` 改用生产 RemoteService 验证真实拒绝，不覆盖 Swift 协议版本；其 `--hold-confirmation` 仅供 SIGTERM 清理验证，不能与 MP0 负对照混用。两模式 Swift 构建均 `--jobs 1`；测试专用环境变量、隔离与清理说明见 `apps/ios/Integration/README.md`。
- `pnpm test:ios` 包含三项XCUITest：首页、真实App进程的钥匙串、配对页面粘贴/相机备用。模拟器不支持真正扫码，手机权限与扫码仍需真机。
- DEBUG专用入口 `ATRIUM_PAIRING_KEYCHAIN_CHECK=1` 由XCUITest设置，仅执行固定CRUD/保护属性验收，service固定为 `site.ktoon.atrium.debug.pairing-keychain-check`、account每次随机，所有查询/清理都限定该项；不接受任意service/数据、不输出秘密、不编入Release。不能在XCUITest Runner内替代执行（Runner曾返回-34018）。App业务钥匙串和签名配置未改变。
- 截图先用 `pnpm ios:shot` / `pnpm ios:shot --dark` 在模拟器锁内切换真实主题，再 `pnpm test:ios`；从xcresult导出 `PairingScreenTests/testPasteValidationAndCameraFallback()` 的 `pairing-entry` / `pairing-invalid` 附件。`-AppleInterfaceStyle` 启动参数未生效，不作为主题验证依据。
- `PairingHome { HomeView() }` 只挂普通首页路径；整合时必须保留其他车道的Debug陈列/性能入口。它只是最小连接接线，未接同步层前保持“正在同步”，不伪装成完整MP4纵向切片。
