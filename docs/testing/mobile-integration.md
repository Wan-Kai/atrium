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

守卫补测另暴露公开 `onState(error)` 中同步 `retryNow()` 的真实 socket 重入缺陷：旧 close 提前结算新 waiter 且多挂 retry timer。父读失败日志及源码后批准独立最窄修；不声称 Electron UI 已复现。`8591834` 的 stop / 当前代守卫补测与 `e6f6f48` 的流量去重已整合：父核对源码仅按可见 down/up 差异通知，离线仍衰减、隐藏旧计数不发；读过真实密文字节、稳定速率、归零、多 watcher 及恢复订阅断言。作者远程宿主 76、相关单元 49、远程泄漏 2 和 14＋1 负控通过，父尚未在组合版本独立复跑；不冒用上述冻结版成绩。

两项桌面失败只读诊断已完成，**还没有对照实验**：appearance 的登录查询与 RPC 退出是不同进程路径，先在不读取用户配置的隔离真实 pi 环境比较基线 / 整合及明确查询完成屏障；faux 只能另作 DOM 控制。ask-user 已有跳过预热但无显式回合终态屏障，先比较语义终态 / 完整预热，不增加固定 sleep 或抬高允许增长；仍增长时需解释保留路径，不能凭平台化认定无害。

## 尚未完成的验证

- 整套单元与桌面泄漏当前仍有上表失败；没有通过定向重跑抹去它们。`17dc6de` 三方限定复审已完成，订阅文档 / 无变化推送已窄修整合待复验；迟到守卫与公开重入的补测修复及新增范围变异尚待完成。全套非泄漏 Electron、活跃配对 / QR 的 Electron 堆和用户验收尚未完成；available QR 的安全方案已批准编写，尚未运行。
- 手机时间线在独立渲染分支 `87c7722` 的低负载窗口已测（18:43–18:46；98 Swift + 4 UI 通过，截图矩阵按计划跳过）：List 三次仍各 180000 builder / 180 body，Stack 为 5376 / 5504 / 5504 builder。全部数据已随 `6871905` 合入本分支，见 `mobile-render.md`；不能把观察通知次数的改善当作 List 构造次数改善，也没有同窗旧实现对照可归因耗时变化。Release 主线程 trace 和真机 50 ms 预算仍未验证；上述 UI 结果不是本整合分支的运行结果。
- 正式 RemoteService → Swift 的拒绝接缝已实测，仍不是 startHost / Electron / router / faux-pi 全契约；真实扫码 / 权限 / 锁屏 / 续签尚未验证。
- 配对系统默认样式只用于接线，非最终视觉验收；渲染零件尚缺的交互与视觉差异仍见 `docs/research/mobile-render.md`。
- MP4 的同步层、续传和发送回执尚未实现，连接后保持“正在同步”是当前切片的边界，不标为可发送的完整手机产品。
