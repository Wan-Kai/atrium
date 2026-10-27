# 手机并行切片整合记录

本记录属于 SPEC-0005：MP3 宿主与设置页、提前实现的 MP4 手机连接，以及 MP5 / MP6 渲染零件。只在独立 worktree 整合，不代表这些里程碑全部完成；用户验收前不合回 `main`、不推送。冻结 `1f522fa` 后的三方审查、用户决定及中断恢复记录见 [mobile-review.md](mobile-review.md)。

## 冻结输入

- 整合起点：`main` 的 `ace843a`，包含回复翻译与已有桌面排版变化，必须保留。
- 手机连接：`aeb7359`，原实现及审查修复；两轴限定复审未发现剩余阻断。
- 手机渲染实现：`87c7722`，五项内容缺陷及围栏 metadata 修复；限定复审通过。父会话独立复跑相关 36 项 Swift 测试通过，日志 `/tmp/atrium-render-parent-review.log`。随后仅证据更新至 `6871905`，没有再次修改实现。
- 桌面手机页：`bda5559`（由 `f6e6d1d` 更新，`e28d033` 合入协调契约）；型号、connect/live 证据和匿名握手已接线。作者定向 UI 57 项、client / 动画 119 项、破坏 16/16 通过；锁文件已补齐，真实宿主联调仍待完成。
- 宿主远程：协调契约 `c709daf`（协议 27），行为实现 `e29e49a`（包含边界登记修复 `5d47db2`）。该输入当时 fresh 79.25%、诊断文件 75.11%，未达新增范围门槛；后续冻结 `7b88613` 的重验见下节，旧成绩不与新成绩混算。

## 整合约束与顺序

1. 先合入手机渲染，保留 `main` 已有行为；解决文档的并列追加冲突，不采用整文件选边。
2. **协议冲突先协调**：回复翻译与远程模块各自使用了版本 26，内容却不同。宿主分支已在 `c709daf` 保留两边并集并统一升到 27，重新生成 Swift 与夹具；增加设备自报型号、真实连接 / 活性诊断快照、未认证候选握手进度。两个翻译命令明确限本机，Noise / relay v1 和保险箱格式不变。本整合分支取该协调结果，不另改协议。
3. 合入手机连接时，只给普通首页挂配对组装，注入共享 `HostStore`；保留 DEBUG 陈列 / 性能入口。合并 SwiftPM 依赖与测试资源，不把测试支持带入生产依赖。
4. 协调后串行运行生成漂移检查、仓库检查、Swift / 模拟器 / 本机互通以及必要的 TypeScript 回归；结果逐项登记。宿主和设置页的联调与三方审查仍须在合并验收前完成。

## 整合中的检查记录

- 渲染已在本整合分支合入（`828c32b`），后续测量证据在 `3309058`；与 `ace843a` 的冲突仅在追踪表顶部的并列新增章节，保留双方全文，没有改写 `main` 的翻译或排版代码。
- 宿主 `e29e49a` 已合入（`910ee60`），协议 27 生成漂移检查通过。随后合入手机连接 `aeb7359`：四处冲突为 App 根入口、SwiftPM 测试依赖 / Fixtures、knip 清单和追踪表。根入口同时保留 DEBUG 钥匙串检查与 Gallery，只有普通首页接共享 HostStore 的 PairingHome；测试依赖与资源、外部脚本清单及两路验证记录均保留。尚未运行这次组合后的完整验证。
- 桌面设置页 `bda5559` 合入时仅追踪表顶部并列新增章节冲突，保留宿主协议 27 与 MP3b 全部证据。当时宿主进行增量变异，只执行合并和轻量静态检查；该轮变异已结束且新增范围未达门槛，结果见审查记录。
- 后续已合入：`c4620ef` 探测超时不踢手机（整合 `b1aca30`）、`1399b0c` 手机拒绝映射（`26e6925`）、`cc61b01` 型号自报（`b9d347a`）、`d88c55b` 用户选定的设置窗口订阅（`78a1cbd`）。父会话在 `b9d347a` 实跑 `pnpm check` 通过，日志 `/tmp/atrium-mobile-review-fixes-check.log`，边界 14 / 41 / 4，未登记与非精确均 0；不等于后来提交已全量复验。
- 仅渲染加 `ace843a` 的阶段，`pnpm protocol:swift --check`、`pnpm check` 通过；边界检查 URL 14、环境变量 41、隐藏命令 4，未登记 0、非精确 0。日志为 `/tmp/atrium-mobile-render-{protocol,check}.log`。
- `swift test --package-path apps/ios/AtriumKit --jobs 2 --explicit-target-dependency-import-check error -Xswiftc -warnings-as-errors`：**98 项 / 21 suites 通过**，日志 `/tmp/atrium-mobile-render-swift.log`。该轮为 macOS 逻辑测试，附带的 Debug 渲染基准输出不是 iOS UI 或 50 ms 预算验收。
- 手机连接合入后的首次 `pnpm ios:check` 发现 HostStore / HostStorageRecovery 的 12 个公开属性缺少文档；已在整合分支仅补属性说明，不修改逻辑、不放宽检查。这一失败保留于 `/tmp/atrium-mobile-combined-ios-check.log` 的首次运行记录（后续复验另存日志）。
- `git diff --cached --check` 报第三方 `swift-markdown-NOTICE.txt` 原样副本末尾的空行，未通过；保留上游声明，不为消除格式提示修改第三方文件，也不将这次检查报告为通过。仓库格式 / lint 检查另行运行。

## 桌面资源验证计划

补最窄 `apps/desktop/e2e/phone.leak.spec.ts`：真实 Electron / 宿主、隔离的临时 home，远程访问保持默认关闭，不读写用户保险箱。预热后重复打开设置、切入手机 / 关于 / 手机并关闭，对比强制 GC 后的堆快照，检查 detached DOM 无增长；另临时保留真实 PhoneSection DOM 做负对照，确认同一断言会失败后恢复。异常路径仍关闭测试 App 并清理快照目录。此项只验证未配置页和设置生命周期，不冒称活跃配对、真实钥匙串或全部远程进程泄漏均已覆盖。

已在整合 `78a1cbd` 加该测试上执行：`pnpm build` 通过（保留 Vite 大 chunk 警告）；`pnpm --filter @atrium/desktop test:e2e phone.leak.spec.ts --workers=1` 正向 1/1 通过，临时保留真实 PhoneSection DOM 的负控在堆增长断言处失败（退出 1），按 SHA-256 核对源码完整恢复后再跑 1/1 通过。前两轮预热、20 轮设置开关，每轮两次进入手机页。日志为 `/tmp/atrium-phone-heap-{positive,negative,restored}.log`，build 日志 `/tmp/atrium-mobile-phone-heap-build.log`。初次脚本误用了已配置态标题 `relay`，在未配置页的选择器等待失败、尚未进入堆检查；改为真实标题“接上你的 relay”，没有修改产品代码或放宽断言，初次失败保留在 `/tmp/atrium-phone-heap-initial.log`。

## 审查修复后的组合验证（2026-10-26 深夜至 27 日）

已合 `7303616`（保险箱分类，整合 `6a581a4`）、`317b02e`（正式拒绝互通，`1371729`）、`7b88613`（诊断 / 资源补测，`1c1da5e`）、`4812542` / `69f4049`（撤销重试 / 保险箱文案，`97e5cc4`）和父复核后的 token-only 修正 `5027751`（`d910237`）。文档冲突保留双方证据，main 的小猫 / 扫光记录保持原位置，不重复追加。

| 父会话独立执行 | 结果及边界 |
|---|---|
| 安装 | 离线 frozen 首次因缺 `@electron/osx-sign` 的公共缓存元数据失败；随后原锁文件在线 frozen 安装通过，供应链策略 896 项通过，未改版本或放宽策略。日志 `/tmp/atrium-mobile-vault-install{,-online}.log` |
| `pnpm check` | `d910237` 通过，边界 14 URLs / 41 env / 4 隐藏命令，未登记和非精确均 0。日志 `/tmp/atrium-mobile-review-final-check.log`。此前 `1371729` 的初次 check 仅 Integration README 格式失败，单文件格式化后通过；初次 `/tmp/atrium-mobile-vault-interop-check.log` 保留 |
| 单元，4 workers | `1371729` 为 4145/4145；补测合入后的 `d910237` 为 **4182 过、1 失败**：未改动 `packages/testkit/src/git.test.ts` 的 clone 场景超过既有 5 秒，属 testing.md 已登记的同一用例；定向单 worker 3/3，通过不覆盖整套失败。日志 `/tmp/atrium-mobile-combined-unit.log`、`/tmp/atrium-mobile-review-final-unit.log`、`/tmp/atrium-mobile-review-git-recheck.log` |
| 宿主，1 worker | `97e5cc4` 为 **230/230**，此后只有 UI token-only 修正。日志 `/tmp/atrium-mobile-combined-host.log` |
| UI，1 worker | `97e5cc4` 为 1097/1097；`d910237` 为 **1100/1100**。日志 `/tmp/atrium-mobile-{combined-ui,review-final-ui}.log` |
| Swift macOS | `1371729` 的汇总为 **237 tests / 43 suites**，两个 opt-in 互通用例默认跳过；显式 target 依赖检查与 warnings-as-errors 开启。日志 `/tmp/atrium-mobile-combined-swift.log`；不是 iOS 帧预算证据 |
| 正式服务拒绝互通 | `1371729` 实跑 `node apps/ios/Integration/run.mjs --production-rejection`，**1/1**；生产 RemoteService / relay / Swift Noise，协议 27，拒绝不新增设备、不授予应用通道、不改变拒绝前 vault，收尾 counters 归零。日志 `/tmp/atrium-mobile-parent-production-refusal.log`。另外 vault 单元独立 24/24，日志 `/tmp/atrium-mobile-parent-vault-tests.log` |
| `pnpm test:ios` | `97e5cc4` 通过；macOS Swift 汇总同上。xcresult 实际确认 **UI 5 过 / 2 跳过**：首页、Gallery、时间线位置、App 进程 Keychain 探针、粘贴与相机后备；默认未开截图矩阵 / 性能测量。`apps/ios/.build/xcode/Logs/Test/Test-Atrium-2026.10.26_23-54-20-+0800.xcresult`，摘要 / 用例 `/tmp/atrium-mobile-combined-ios-{summary,cases}.json`。Xcode 有 debugger version 诊断但退出 0，未据此删测试；不是“Executed 0 tests”的空 XCTest 汇总 |
| 相关 Electron | `97e5cc4` 构建后 remote-vault 2 项＋Phone heap 1 项 **3/3**，日志 `/tmp/atrium-mobile-vault-phone-e2e.log`。前者只在测试 App 中将 availability 设为 false，不碰实际钥匙串拒绝流程 |
| Node 泄漏，1 worker | `d910237` **20/20（9 文件）**，日志 `/tmp/atrium-mobile-review-node-leak.log` |
| 桌面全部泄漏，1 worker | `d910237` **7 过 / 2 失败**；Phone 通过。appearance 失败在日志门禁（logins unavailable 两次、pi stdin 关闭后需 SIGTERM 一次），不是其 DOM 断言；ask-user 是已登记的同一增长：运行中 span 2 / SVGCircleElement 42 / SVGSVGElement 2。两项定向复验仍失败：appearance 只剩 SIGTERM 警告一次；ask-user 是 RunStatus / RunCat、shimmer 等另一组节点，不是重复上述指纹。未放宽断言或白名单，不能报全套绿。测试 / heap helper 相对 ace843a 未改，但未据此认定运行时归属。日志 `/tmp/atrium-mobile-review-{desktop-leak,leak-recheck}.log`，首轮截图和 trace 留 `/tmp/atrium-mobile-desktop-leak-evidence.skhYAr/` |

父已查看 UI 作者的四张 `phone-{vault-confirm,keychain-error}-{light,dark}.png`（明暗、不可读与长确认），不是新设计或活跃手机联调的替代。变异采用独占重型窗口，以上验证没有与新一轮 Stryker 并行。

## 冻结版修后变异与后续边界

`2cb7958` 验证记录已随 `8a0a936` 整合。宿主对冻结 `7b88613` 单次执行 693 项，623K / 70S / 0T（89.90%）；原远程范围当前对应 472 项为 91.10%，diagnostics 整文件 93.78%，vault 整文件 87.33%。**`RelayLink.#checkPong` 审查小范围仍为 7K / 3S＝70%**，不能用含缓存总分 90.61% 遮盖。原 477 中 465 可一对一映射，另 12 改写不计杀死；29 个 Killed 含测试 / hook 超时的因果与 9 个旧缓存 Timeout 分别记录，见 [完整报告](mp3a-postreview-mutation.md)。

父会话没有再跑该 58 分钟变异；独立核对了原日志的 dry run / 1835 生成 / 1140 复用 / 693 实测、退出码 0、JSON 中的整文件与 10 项 guard 统计，并以 `git show 7b88613` 核对六份嵌入源码全部一致。作者已开始下一批负控，不能用其活动工作树作冻结版比较目标。

守卫补测另暴露公开 `onState(error)` 中同步 `retryNow()` 的真实 socket 重入缺陷：旧 close 提前结算新 waiter 且多挂 retry timer。父读失败日志及源码后批准独立最窄修，`d49fbbb` 两处次序调整已整合；作者相关单元 52、远程宿主 76、泄漏 2、守卫及逆转负控 6/6 通过，父只读复核生产差异和新断言；随后 `17dc6de...e70a68f` 的 Astra / Grok 4.7 / Claude Opus 5.5 限定复核两轴均无新增确定缺陷。不是 Electron UI 故障复现；后续父组合复跑见下节，新变异结果与父独立核对见下文。`8591834` 的 stop / 当前代守卫补测与 `e6f6f48` 的流量去重已整合：父核对源码仅按可见 down/up 差异通知，离线仍衰减、隐藏旧计数不发；读过真实密文字节、稳定速率、归零、多 watcher 及恢复订阅断言。作者远程宿主 76、相关单元 49、远程泄漏 2 和 14＋1 负控通过，父随后在 `376e1b5` 独立复跑相关 52 / 76 / 2 项通过；不冒用上述冻结版变异成绩。

两项桌面失败只读诊断已完成，**还没有对照实验**：appearance 的登录查询与 RPC 退出是不同进程路径，先在不读取用户配置的隔离真实 pi 环境比较基线 / 整合及明确查询完成屏障；faux 只能另作 DOM 控制。ask-user 已有跳过预热但无显式回合终态屏障，先比较语义终态 / 完整预热，不增加固定 sleep 或抬高允许增长；仍增长时需解释保留路径，不能凭平台化认定无害。

## 活跃二维码与启动失败资源回归（已父组合复跑）

`9684735` / `455620a` 已整合，作者构建基于 `8a0a936`：真实 Electron 的启动 ready 失败三个场景先 3 红后 3 绿，分别验证自建 home 清理、调用者 home 保留及主错误 / 清理错误同时可见。available QR 用正式宿主 / loopback relay、测试 App 内经身份与往返自检的 fake safeStorage（文件仅不透明标记），不操作真实钥匙串。两轮预热加 20 轮分类 / Meta+, 开关，保持同一配对和期限、真实退订应答、无多余管理命令；正向过，真实 QR DOM 保留使原堆断言 2→22、丢弃 watch:false 使原协议断言失败，精确恢复后 QR 与未配置页 2/2。旧中间 handle / Playwright 配置错误另记，不算敏感性证据。

父已读实现与回归。新 QR 测试初稿预设了未经单独批准的 120 秒覆盖（作者确认没有因运行失败或超时增加），整合时删除，父在 `376e1b5` 已按仓库默认 **60 秒**完成相关 Electron 7/7（下表）；没有调整轮数、堆断言或协议断言。作者原 SHA-256 与结果只对应其提交，不冒称是删除覆盖后的父树哈希。Network.enable 失败清理仍只有静态检查；真实 Keychain、SAS / 确认阶段、已有手机在线和 MP4 未覆盖。详见 [作者记录](mp3b-settings.md#electron-active-qr-与启动失败资源边界作者基线-8a0a936)。

## 父组合复验（376e1b5，2026-10-27）

本节均由父独立执行，包含 A/B/C 宿主窄修与两项 Electron 提交；重型任务串行，未与 Stryker 并发。普通测试未增加超时、放松断言或重试到绿。日志前缀 `/tmp/atrium-mobile-postreview-`：

| 检查 | 结果 | 日志后缀 |
|---|---|---|
| `pnpm check` / `pnpm build` | 均 exit 0；边界 14 URL / 41 env / 4 隐藏命令，未登记及非精确均 0；保留 Vite 大 chunk 警告 | `combined-check.log` / `build.log` |
| remote 定向 unit / host / leak，单 worker | 52 / 76 / 2 全过 | `remote-unit.log` / `remote-host.log` / `remote-leak.log` |
| 完整 unit，4 workers | **4186 过、1 失败 / 4187**；仍为 `testkit/src/git.test.ts` 的双 scene clone 测试，`Test timed out in 5000ms`；没有加时或忽略 | `full-unit.log` |
| 完整 host / UI / Node leak，各单 worker | **240 / 1100 / 20 全过**，分别 21 / 57 / 9 文件 | `full-host.log` / `full-ui.log` / `full-node-leak.log` |
| `launch-failure.spec.ts phone.leak.spec.ts remote-vault.spec.ts --workers=1` | **7/7**；3 启动失败＋2 手机页＋2 vault，QR 沿用默认 60 秒 | `electron.log` |
| 完整非泄漏 Electron，隔离环境，单 worker | **67 过、1 失败 / 68**（runner 汇总含既有预期失败自检）；双子代理场景缺 audit 完成来源行 | `full-electron-unwrapped.log` |
| 同隔离环境仅一次双子代理定向复现 | 1/1；不抹去上述整套失败，不据此判无回归 | `electron-children-recheck.log` |

非泄漏 Electron 使用已构建产物，命令为 `pnpm --filter @atrium/desktop test:e2e --grep-invert '@leak|@perf|@package' --workers=1`。命令外层是新建临时 HOME / PI_CODING_AGENT_DIR、SHELL=/usr/bin/false、固定 Node 22.19.0 与真实 pi 所在 PATH、已存在的 Playwright 缓存；白名单环境不继承 API keys / 代理 / NODE_OPTIONS / SSH agent / 开发入口覆盖，禁版本查询。各用例的 faux.env 仍优先，真实 pi 包发现不换 wrapper；无真实账户 / 订阅或 VPS 操作。临时 home 已删除，事后 integration 路径下 Electron/host 可执行进程匹配为 0；不是全系统进程审计。本轮没有再跑 Swift/Xcode，旧结果只代表旧快照。

### 隔离预检失败，不隐藏为功能成绩

父先尝试进程级 macOS sandbox：最初 require-not 候选策略连 IPv4 loopback 都返回 EPERM；改用明确的 IP 出站 deny 加 localhost allow 后，Node 的 IPv4 / IPv6 loopback 通过，TEST-NET 192.0.2.1:9 返回 EPERM，未发送应用载荷。但这不能证明 Electron 兼容；父未先做单 App 预检就运行整套，结果 **61 失败 / 7 报告通过**，主要是 firstWindow/renderer 启动失败，另有旧 afterEach 在启动没返回时访问 undefined。既有 `log-gate` 使用 test.fail，启动错误也能被算成预期失败，不能从该 7 推导正常功能覆盖。

原日志 `full-electron.log` 与证据 `/tmp/atrium-mobile-sandbox-electron-evidence.path` 指向的目录保留。随后仅去掉外层 sandbox、保留最小环境与 Electron 自身安全设置，单 App 控制用例 1/1（`electron-isolated-control.log`），再得上表 67/68；未禁用 Electron sandbox/contextIsolation 或放宽 CSP。**未包外层 sandbox 的运行不称硬阻断所有外网**；隔离环境与本机替身服务是实际边界。两个策略预检日志为 `/tmp/atrium-mobile-e2e-sandbox-probe{,-allowlist}.log`；命令和隔离环境键名清单在 `/tmp/atrium-mobile-isolated-e2e*-manifest.json`，没有用户凭据值。

### 新发现的双子代理断言失败

`children.spec.ts:155` 在固定 faux 回复“两个都做完了”已出现后，等 audit `source-line` 5 秒仍为 0；截图只有 tests 完成来源行，首轮“派出去了”前过程已折叠。该固定回复不能证明两份报告均已送达。原整套证据保存在 `/tmp/atrium-mobile-unwrapped-electron-evidence.Kh1oca/test-results/children-the-agent-opens-t-7d1bb-nt-is-told-and-sums-them-up/`；父仅统计 trace 事件类型，只有动作/错误，无 frame-snapshot，不能回放证明折叠内部。

只读诊断（非实验）发现 SPEC-0002 允许运行中报告成为当前回合步骤，闲时才成为轮首来源；`session-transcript` 的 takesSteer 分支与 laned 事件不产出 source-line，故“audit 合法进入首轮过程而选择器漏掉”是优先候选。尚未排除未完成/未送达、实际遗漏、批量/投影丢项；即使展开也不一定成为 source-line。用例与相关投影/聊天呈现未改，但共享 client、host connection/ws-server/启动路径有改动，不能据未改文件判无整合回归。后续应以 faux gate 控制报告到达阶段并核对任务/送达/投影/DOM 的最小元数据，不用固定 sleep、加时或只追求绿色；目前未实施。

### 新变异结果与父独立核对

`fd89d97` / `acab06d` 记录冻结 `d49fbbb` 的单次运行：UTC 2026-10-26 19:30:57–21:49:55，约139分钟，exit 0。此前父核验冻结方案并在普通组合验证结束后释放独占窗口；两整文件1142项历史状态全失效，六文件、原测试集、1 runner×2 workers、30000ms＋1.5、80%不变，没有重试。dry-run净耗时27352ms；生成1862项，复用691项及2个既有Ignored，实际执行1169项。

- Stryker分类：1008K/160S/1T＝**86.31%**；RelayLink **90.12%**，RemoteService **85.26%**。完整 `#checkPong` **10/10＝100%**，采样 **65/72＝90.28%**，close **30/31＝96.77%**，`#setState` **7/7＝100%**，C并集 **37/38＝97.37%**。本轮固定范围达到80%；旧70%仅保留作7b历史，不用含缓存91.09%替代新范围。
- 原1142身份实际映射1127（969K/157S/1T）；13项跨改写、2项未生成不计Killed，另42项当前新/改写变异单列。
- 70个Killed含测试/hook截止，与唯一fresh Stryker Timeout1754分开；1754的变体把循环条件改为`others.length < 2`，首个认证流可达同步不终止循环。没有现场栈，不把静态因果写成采样证明。898的附带缺warn、1505的ENOTEMPTY仍未解释，不当检出证据。
- Opus只读复核另发现11项service Killed只有空计数、没有具体失败依据；父独立扫描及作者复核均确认恰有这11项。保留全分母、不给这11项信用的敏感性：fresh85.37%、service84.06%；连T也不计为**85.29% / 83.95%**。不是新测试成绩，不改原JSON/Survived/ignore；11项均不在四个固定区间。详见 [分层报告](mp3a-d49-mutation.md) 与 [失败证据审计](mp3a-d49-failure-audit.md)。

父没有再跑Stryker：用独立脚本核对1940个Git blob与冻结哈希、前后1952项哈希、12份原证据及4份终态输出；六份报告嵌入源码同时匹配固定Git和整合树。独立复算fresh/缓存、固定半开相交区间、C并集和1142身份账；核对45条SIGTERM记录的PID/启动时间/完整命令与本轮PGID81202、sandbox-G98NoC一致，现存该sandbox Node匹配为0。报告/HTML/统计/ledger/manifest/scopes已按哈希复制到整合树的忽略目录`reports/`，未覆盖旧报告。核对日志 `/tmp/atrium-parent-d49-{verify,extra-audit}.log`。

审查归属分开：作者两路审计原72个失败候选；父核验数据/哈希与缺口；Opus逐核固定120项状态、C区间7条测试超时及898/1505/1754的因果，未全量逐核其余约60条超时。没有宣称所有Killed均有完整因果、全仓全绿或真实钥匙串/真机已验收。

### 六项受控UI诊断（c710d51，作者记录d8a0cb0）

唯一一次build成功，最初Q0因选例锚定错误返回No tests found，未启动App；另经父批准修选例并去掉多余reload后，Q0/Q1/Q2/C0/C1/C2主体各一次exit 0，没有再次构建或重跑。原产品与原测试未改，诊断草稿退出默认收集，详见 [实验记录](ui-controlled-diagnostics.md)。

- Q0原流程旁路观察、Q1终态/折叠退出、Q2固定两路径预热，仍各测8轮/零增长；均通过，没有失败→成功对照，不能解释旧ask-user。录制主动关闭、LANG/PATH也与父旧复验不同，是额外混杂，不是历史条件复刻。作者堆分析同名计数1→1；原分析脚本未存、raw heap按约删除，父仅核元数据，不能再独立重算或据此归因。
- C0本次两个闲时新轮，原断言通过，不改写67/68。C1受控read工具批后audit同delivery落盘到旧轮agent步骤且无source-line，tests闲时开新轮；C2两条waiting经正常继续发送后同批落盘/投影/两条来源行。父按task/session/delivery/entry/turn独立核对一致，支持“必须两条source-line”的判据过强；C1并非原spawn批的精确时序，不能证明历史失败必属A或排除B/C。C1/C2未实际点击两条路由，C0仅点audit。

父及Opus单路只读核对39项封存、1121产物及执行源hash；父另以三处逆差分恢复C0旧helper，匹配其事后记录hash。未复跑；原始堆不可复核、事后runner版本与分析脚本来源边界见实验记录。原39项不覆盖，新附件6项另封存；连两份清单共47份已核hash归档到整合树私有忽略目录`reports/mobile-ui-controlled-c710d51/`。父核对脚本/日志 `/tmp/atrium-parent-controlled-verify.{py,log}`。

下一步只针对children测试判据做红绿修正：精确任务报告及正确source/agent-step归属各一次，保留角色/worktree与真实导航；不是放宽locator或改产品，目前尚未实施。ask-user不因本次绿关闭。appearance四格停在下述依赖准备，未实际执行；Git仍待受控验证。

### Children判据的单次红证据（ded285e，未修正交付）

在独立设置页worktree准备3份测试/助手候选，原`children.spec.ts`与四旧诊断草稿不变；产品未改。先冻结源、runner、环境及原1121项构建，desktop typecheck exit0、精确列例exit0/恰一例，随后C1单次exit1（8.6秒），唯一失败在候选`children-delivery.spec.ts:225`的原audit来源行断言：Expected1 / Received0，仍为5秒断言、60秒用例预算。没有附带启动、夹具、日志门禁或清理错误，没有build/install/C2/全套/重试。

父只读核20工件hash、8源码、1121产物及真实runner/命令/退出。冻结源码的顺序和唯一失败表明，之前的任务done/replyEntry、两报告落盘/投影各一次、四gate释放、两个父run completed及角色/worktree断言已通过；**完成凭据用了body-only附件，未生成独立JSON，父未独立读取具体session/task/turn值**，不把这一缺口写成已核。trace/截图/error-context仅作不透明工件保留并核hash，不提取正文。足以作为已证过强判据的目标红证据，不是原67/68历史时序或根因复现；新的合法DOM判据、双路导航和原旅程修正尚未交付。

后续单路只读复核（`t-d4d173b9-fe67-4dea-ae25-80995edbba18`，不是正式三方）重算20工件/8源码及runner，读冻结候选、原断言和固定产品实现，认可上述窄结论，未发现前置或清理逻辑使红失真。但**同一次红没有正向DOM对照**，未实测父会话当前显示及audit合流行；0的渲染原因由协议投影、固定代码和此前同产物C1诊断旁证支撑。另确认`source-line`也用于非车道的过程事件，绿色轮来源须限定正确turn的`data-testid=source`容器，过程事件须限定旧turn的event行并正常展开，不只按testid或整窗口计数。新绿色的独立JSON及正向DOM不能追补为旧红已观察过的事实。复核没有运行验证、读取不透明工件或正在改写的绿色候选，也未审核父核验脚本。

作者采样的35个本次进程身份（含App PID26984）与5个测试目录均消失，外层HOME已删；父按PID+启动时间及目录复核，不声称全系统/未采样进程/全部资源无泄漏。采样见git下的xcodebuild，未采argv，不能推断具体用途或称做过Xcode验证。原目录`/tmp/atrium-children-c1-red.ZoIOmx/`保持；23份文件（20工件、原hash清单、父核验脚本及日志）按字节归档到私有忽略目录`reports/mobile-children-c1-red-ded285e/`，父没有重跑。后续绿色验证将凭据直接写独立白名单JSON，不为补附件重跑本次红。

### Children绿色候选首轮（三例通过，尚未交付）

更早的实现中恢复快照`/tmp/atrium-children-green-interrupted-dwjitxv_/`写于2026-10-27 09:40（UTC+8），不是测试输入冻结。之后10:22的实际执行封存在`/tmp/atrium-children-green.jB5rvC/`；不能由代理任务的中断/恢复状态推断测试次数。该目录记录一次desktop typecheck exit0、一次精确列例（3例/2文件）exit0、一次worker1/retries0/max-failures1的三例首轮：**C1 7.0s、C2 5.5s、原旅程4.4s，3/3，17.4s**。本次恢复核终态及父核验均未重跑；没有新的build/install/负控/全套/`pnpm check`或正式门禁。

五份测试/助手源码（含原旅程修正）尚未提交或合入整合分支，执行HEAD为`ded285e`；四份旧诊断草稿不变。原旅程保留spawn、角色/worktree/分支、任务与子回复显示，三段spawn后faux回复改为相同中性句，仅作显示断言，不再当送达屏障。默认采集/60秒、原隔离env及1121项旧构建保持；既有源快照与runner按执行前hash冻结，文档事后补报告另列addendum，不覆盖执行版。

六份独立完成/导航JSON与六个路径附件副本均保存。父脚本`/tmp/atrium-parent-children-green-verify.py`逐项核41工件、9源码、1121产物、3阶段命令及退出，独立重算：C1 audit为初始turn的agent步骤、tests为新turn source，两持久record/两completed；C2一个record的两delivery/events、一个新turn的两source、stopped→completed；原旅程本次为分两次送达、两source轮/三completed，不能把它称作同批路径复验。六次导航的目标订阅、task快照、选中/返回标签及对应报告位置与各自真实child身份一致；完成与导航后身份不变。父未读对话正文；任务/回复文本的显示验证由冻结断言和通过日志支持。回执用fixture唯一名字与event桥接delivery，未独立重建未导出的早期queued记录或run_started历史，不把它们说成已逐条复核。

112个采样PID/start与12个观测目录均已消失，外层HOME删除；不外推未知进程/每个资源。44份文件（41工件、原清单、父核验脚本及日志）按字节归档到私有忽略目录`reports/mobile-children-green-ded285e/`，没有提取trace/截图/原帧。旧红的body-only附件及同次DOM正向观察缺口仍保留。

单路只读审查及补核（`t-2e229ac5-e601-4eb9-bd43-cab4750bea3a`、`t-6625cf54-26ab-4510-965f-d2002b95e250`）认可三过的窄结论，但定稿前还需补：①同一目标容器已查`count=1`，**跨容器/跨轮次多画一份仍漏查**；②新helper漏了原“完成”可见文案检查，source分支也尚未查DOM `data-event`，协议正确不能代替显示正确。两项起初均为静态审查发现；跨位置重复现已由下述阶段A暴露未检出，可见状态控制尚未执行。这不是已复现的自然产品bug。另有5秒冷启动等待的潜在不稳：spawn返回只到task waiting，pi异步启动；旧90秒回复等待本来也受60秒用例上限约束。没有负载超时实测，不用总4.4秒推剩余裕量，不自行扩大预算/重试。展开helper的正常点击为清除linger并固定展开，未记录初始状态，不能称本次必然两次点击或删展开必红。当前不关闭历史67/68、ask-user或appearance问题，也不借用此前三方审查给新候选背书。

### Children跨位置重复控制A（B0有效未检出，已恢复）

`/tmp/atrium-children-duplicate-A.Tqq5Kk/`封存一次typecheck/list/C1，退出均0；C1用例4.8s、Playwright汇总5.1s，无重试。唯一临时变化是在B0助手原局部`count/visible`断言之前包一层控制：将真实audit agent报告DOM克隆到不同tests turn的现有source容器，保留正确原行和原断言。克隆没有React点击回调，只点击原行；它是测试侧DOM呈现违规，不是生产源码变异、额外协议送达或SourceLines生成的新source。

独立installed、capture、cleanup JSON及完成/导航两份JSON共五份，各有路径附件副本。注入前audit报告1；注入后及原按钮正常click的capture均实采原处1/另处1/全父2、两处CSS-visible，click为`isTrusted=true`、`originalButton=true`；不声称同屏可见。C1其余完成/两次真实导航通过。故结论为**有效SURVIVED：B0漏查跨位置副本**，绝不当作产品绿或负控检出。finally记录abort、marker0和控制槽删除；副本已随正常导航卸载。

父全文核控制及执行/恢复脚本，并用`/tmp/atrium-parent-children-duplicate-a-verify.py`重算57工件、五JSON/五副本、变体精确逆差分、1121产物及真实导航身份；五B0源码和四旧草稿恢复一致，临时助手按hash删除，旧红20/绿色41工件不变。40个采样PID/start及五观测目录现不存，外层HOME删除；没有复跑、提取不透明工件或推断未知进程。60份文件（57工件、清单、父脚本/日志）按字节私有归档到`reports/mobile-children-duplicate-a-ded285e/`。

当时批准最小B1补强及使用完全相同控制的一次目标红窗口，结果见下；其它控制、全套/正式门禁、提交与整合仍待。现有`break-check.mjs`仅支持Vitest/Swift，未伪装成Playwright支持、未扩工具；本阶段是显式记录的Playwright对照。未改等待预算、采集、安全设置或产品构建。

### Children B1同故障目标红（正向尚待）

B1仅修改测试助手和本lane文档，未注入源码SHA为`b110bb5af2983e67482b2561536a4ace76feb2be776b27debbbdd27c36e1d28b`。它正常展开完整小夹具的已加载过程，全父清点event行和非内嵌source-line：排除spawn、非laned NoticeLine不双计数，未知名字/错误状态的实体不丢弃；先验全局数量，后验turn/位置、finished属性和可见完成短语。DOM只有名字关联，身份仍靠唯一夹具映射、完整协议身份及真实导航，不称DOM直接提供taskId。每次返回父后重新取投影/清点；只承诺当前2–3轮夹具，不泛化未加载历史或任意无testid呈现结构。

`/tmp/atrium-children-B1-duplicate.BZKrf9/`封存64项。B1加**与A完全相同字节**的控制（`b03b5cbc…`）后，一次typecheck/list退出0，一次C1退出1、用例9.4s：唯一测试断言为`parent visible report counts: exactly one per child`，audit期望1实2、total期望2实3，原5000ms预算。实际inventory含旧turn正确audit、另一turn的invalid audit副本、正确tests source；四份独立JSON及副本保存complete/installed/inventory/cleanup。失败发生在位置/文案细验及导航之前，不能把已观察到的true字段称作后续断言已执行。无点击/capture为null符合预定红，finally移除marker **1→0**、abort、删除控制槽。

父核64项/四JSON及副本、同控制、恢复逆差分、源码和1121产物；`/tmp/atrium-parent-children-b1-red-verify.py`通过，未重跑。单路只读复核`t-21cae4fa-d2cb-4760-a14a-45ae5af06466`认可目标红，未见高可信假绿问题，不是新正式三方。日志另有“1 error was not a part of any test”：安装Playwright 1.63执行后读取的源码hash及父/审查者复核，明确`max-failures=1`的合成停止通知走`onError`计入`_fatalErrors`；不是另一个产品/夹具调用栈。

**资源不写零残留**：即时尾采31个PID/start中node78614仍在；作者后来一次和父当前检查均无对应进程。采样关系显示它是Electron及fixture Git的父进程，未采argv，不能断言角色、退出原因/时刻或用“短暂”代替测量。五目录和外层HOME删除，无kill/等待重跑；这不是完整资源门禁通过。已精确恢复B1、删除临时助手，旧红20/绿41/A57工件未变。67份文件私有归档到`reports/mobile-children-b1-red-ded285e/`，不透明工件仅按字节复制/核hash，未解码。

恢复后B1的三例正向已另给一次有界窗口，当前尚无结果；尤其C2/原旅程、第二子导航和返回后的新增清点不得借本次目标红记为通过。未增加超时、重试、构建/安装或正式门禁，测试代码仍未提交/整合。状态/丢来源/错导航等其它控制尚未执行，历史整套失败不关闭。

### Appearance四格准备阻断（16dfcbf）

基线`ace843a`与当前`c710d51`计划各做原关闭/被动等待既有查询完成两格，同环境、真实pi、原录制及60秒预算；未新增查询或生产探针。基线独立worktree `appearance-baseline-ace843a` / 分支`agent/appearance-baseline-ace843a`已创建并保留。

原生安装器的Electron生命周期不保证遵守`--offline`，故父另批准仅安装阶段的进程级IP网络限制；两个TEST-NET IPv4/IPv6探针均EPERM，不泛化到broker/XPC或产品测试。基线唯一一次离线frozen安装exit 1，供应链检查需要的`@babel/helper-module-transforms.jsonl`完整元数据缺失，锁前后hash一致；不是Electron缓存或产品失败。简略缓存虽有8.0.6及匹配integrity，但无发布时间；旧验证缓存的指纹/政策未证明匹配，不伪造full metadata、不复制历史忽略时间设置、不自动联网重试。

**当前安装0次、两版build0次、四格0次；没有启动Electron或产生heap/trace。** 父只读核日志/manifest及CLI帮助/cache path，没有做联网view或补缓存。源码/缓存支持及后续待定边界见 [准备记录](appearance-first-layer.md)；8份已存在的安装/探针工件按字节核对归档到私有忽略目录`reports/appearance-preparation-ace843a/`，未复制用户配置或包缓存。此阻断不关闭旧appearance警告，重型窗口已释放。

## 尚未完成的验证

- 普通组合自查已执行，但整套 unit、非泄漏 Electron 与旧桌面泄漏仍有上述失败；不以定向绿代替整套绿。三方生产窄修和新增 E2e/harness 限定复审已完成；新变异门槛已有上述证据，但剩余失败的修正/诊断、SAS / 已配对手机在线与用户验收仍待完成。available QR 已有作者负控及父默认 60 秒组合正向，不再列为完全未测。
- 手机时间线在独立渲染分支 `87c7722` 的低负载窗口已测（18:43–18:46；98 Swift + 4 UI 通过，截图矩阵按计划跳过）：List 三次仍各 180000 builder / 180 body，Stack 为 5376 / 5504 / 5504 builder。全部数据已随 `6871905` 合入本分支，见 `mobile-render.md`；不能把观察通知次数的改善当作 List 构造次数改善，也没有同窗旧实现对照可归因耗时变化。Release 主线程 trace 和真机 50 ms 预算仍未验证；上述 UI 结果不是本整合分支的运行结果。
- 正式 RemoteService → Swift 的拒绝接缝已实测，仍不是 startHost / Electron / router / faux-pi 全契约；真实扫码 / 权限 / 锁屏 / 续签尚未验证。
- 配对系统默认样式只用于接线，非最终视觉验收；渲染零件尚缺的交互与视觉差异仍见 `docs/research/mobile-render.md`。
- MP4 的同步层、续传和发送回执尚未实现，连接后保持“正在同步”是当前切片的边界，不标为可发送的完整手机产品。
