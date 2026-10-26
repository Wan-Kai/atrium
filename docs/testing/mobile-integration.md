# 手机并行切片整合记录

本记录属于 SPEC-0005：MP3 宿主与设置页、提前实现的 MP4 手机连接，以及 MP5 / MP6 渲染零件。只在独立 worktree 整合，不代表这些里程碑全部完成；用户验收前不合回 `main`、不推送。

## 冻结输入

- 整合起点：`main` 的 `ace843a`，包含回复翻译与已有桌面排版变化，必须保留。
- 手机连接：`aeb7359`，原实现及审查修复；两轴限定复审未发现剩余阻断。
- 手机渲染实现：`87c7722`，五项内容缺陷及围栏 metadata 修复；限定复审通过。父会话独立复跑相关 36 项 Swift 测试通过，日志 `/tmp/atrium-render-parent-review.log`。随后仅证据更新至 `6871905`，没有再次修改实现。
- 桌面手机页：`bda5559`（由 `f6e6d1d` 更新，`e28d033` 合入协调契约）；型号、connect/live 证据和匿名握手已接线。作者定向 UI 57 项、client / 动画 119 项、破坏 16/16 通过；锁文件已补齐，真实宿主联调仍待完成。
- 宿主远程：协调契约 `c709daf`（协议 27），行为实现 `e29e49a`（包含边界登记修复 `5d47db2`）。本轮变更的增量变异仍在运行，不提前将实现标为最终验收通过。

## 整合约束与顺序

1. 先合入手机渲染，保留 `main` 已有行为；解决文档的并列追加冲突，不采用整文件选边。
2. **协议冲突先协调**：回复翻译与远程模块各自使用了版本 26，内容却不同。宿主分支已在 `c709daf` 保留两边并集并统一升到 27，重新生成 Swift 与夹具；增加设备自报型号、真实连接 / 活性诊断快照、未认证候选握手进度。两个翻译命令明确限本机，Noise / relay v1 和保险箱格式不变。本整合分支取该协调结果，不另改协议。
3. 合入手机连接时，只给普通首页挂配对组装，注入共享 `HostStore`；保留 DEBUG 陈列 / 性能入口。合并 SwiftPM 依赖与测试资源，不把测试支持带入生产依赖。
4. 协调后串行运行生成漂移检查、仓库检查、Swift / 模拟器 / 本机互通以及必要的 TypeScript 回归；结果逐项登记。宿主和设置页的联调与三方审查仍须在合并验收前完成。

## 整合中的检查记录

- 渲染已在本整合分支合入（`828c32b`），后续测量证据在 `3309058`；与 `ace843a` 的冲突仅在追踪表顶部的并列新增章节，保留双方全文，没有改写 `main` 的翻译或排版代码。
- 宿主 `e29e49a` 已合入（`910ee60`），协议 27 生成漂移检查通过。随后合入手机连接 `aeb7359`：四处冲突为 App 根入口、SwiftPM 测试依赖 / Fixtures、knip 清单和追踪表。根入口同时保留 DEBUG 钥匙串检查与 Gallery，只有普通首页接共享 HostStore 的 PairingHome；测试依赖与资源、外部脚本清单及两路验证记录均保留。尚未运行这次组合后的完整验证。
- 桌面设置页 `bda5559` 合入时仅追踪表顶部并列新增章节冲突，保留宿主协议 27 与 MP3b 全部证据。宿主仍进行增量变异，当前只执行合并和轻量静态检查，不与其并发全量 / E2E / 模拟器性能。
- 仅渲染加 `ace843a` 的阶段，`pnpm protocol:swift --check`、`pnpm check` 通过；边界检查 URL 14、环境变量 41、隐藏命令 4，未登记 0、非精确 0。日志为 `/tmp/atrium-mobile-render-{protocol,check}.log`。
- `swift test --package-path apps/ios/AtriumKit --jobs 2 --explicit-target-dependency-import-check error -Xswiftc -warnings-as-errors`：**98 项 / 21 suites 通过**，日志 `/tmp/atrium-mobile-render-swift.log`。该轮为 macOS 逻辑测试，附带的 Debug 渲染基准输出不是 iOS UI 或 50 ms 预算验收。
- 手机连接合入后的首次 `pnpm ios:check` 发现 HostStore / HostStorageRecovery 的 12 个公开属性缺少文档；已在整合分支仅补属性说明，不修改逻辑、不放宽检查。这一失败保留于 `/tmp/atrium-mobile-combined-ios-check.log` 的首次运行记录（后续复验另存日志）。
- `git diff --cached --check` 报第三方 `swift-markdown-NOTICE.txt` 原样副本末尾的空行，未通过；保留上游声明，不为消除格式提示修改第三方文件，也不将这次检查报告为通过。仓库格式 / lint 检查另行运行。

## 尚未完成的验证

- 渲染加 `ace843a` 时的检查与 98 项 Swift 结果不是四路组合的结果；宿主 / 手机连接合入后另有生成检查和 `ios:check` 通过（复验日志 `/tmp/atrium-mobile-combined-ios-check-final.log`）。尚未跑四路整合后的全量检查、TypeScript、Swift / Xcode / UI / 互通验证，单路通过不自动视为完整整合通过。
- 手机时间线在独立渲染分支 `87c7722` 的低负载窗口已测（18:43–18:46；98 Swift + 4 UI 通过，截图矩阵按计划跳过）：List 三次仍各 180000 builder / 180 body，Stack 为 5376 / 5504 / 5504 builder。全部数据已随 `6871905` 合入本分支，见 `mobile-render.md`；不能把观察通知次数的改善当作 List 构造次数改善，也没有同窗旧实现对照可归因耗时变化。Release 主线程 trace 和真机 50 ms 预算仍未验证；上述 UI 结果不是本整合分支的运行结果。
- 正式宿主与 Swift 客户端、真实扫码 / 权限 / 锁屏 / 续签尚未验证。
- 配对系统默认样式只用于接线，非最终视觉验收；渲染零件尚缺的交互与视觉差异仍见 `docs/research/mobile-render.md`。
- MP4 的同步层、续传和发送回执尚未实现，连接后保持“正在同步”是当前切片的边界，不标为可发送的完整手机产品。
