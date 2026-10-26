# 编码规范

> 2026-10-04 定。工具和检查方式见 [testing.md](testing.md)；安全要求见 [security.md](security.md)；日志与链路追踪见 [observability.md](observability.md)。

## 语言

| 对象 | 语言 |
|---|---|
| 标识符、文件名、代码注释、JSDoc、提交信息 | 英文 |
| 文档（`docs/`） | 中文 |
| 界面文案 | 中文（MVP 只做中文，见下文"多语言"） |

## 注释：JSDoc

**每个函数、方法、类、React 组件都写 JSDoc**，包括不导出的。写清三件事：

1. **What**：第一句话说它做什么。
2. **Why**：`@remarks` 说为什么需要它、为什么这样设计（对应哪条规格或约束、绕开了什么坑）。
3. **副作用**：`@sideEffects` 列出它对外部世界的影响：写文件、发网络请求、启动或杀进程、改全局或共享状态、订阅事件、注册定时器、写日志、发事件。没有副作用写 `@sideEffects none`。

另外按需写 `@param`、`@returns`、`@throws`（会抛哪种错误、什么条件下）。组件的 props 在 props 类型上逐个写说明。

```ts
/**
 * Translates one pi RPC event into zero or more Atrium session events.
 *
 * @remarks
 * pi's event format may only appear inside the `pi` package (overview.md, "包之间的依赖"),
 * so the host never sees raw pi events. `agent_end` is ignored on purpose: pi may still
 * retry or compact afterwards, and only `agent_settled` means the run is over
 * (pi-internals.md §2).
 *
 * @sideEffects none
 * @param event - A parsed line from pi's stdout that is not a command response.
 * @param run - The run the event belongs to, used to stamp message and tool ids.
 * @returns The translated events, in the order they must be published.
 */
export function translateEvent(event: PiEvent, run: RunContext): AtriumEvent[] { … }
```

```tsx
/**
 * Shows the reasoning-effort box with the dot field that covers one cell per level.
 *
 * @remarks
 * The design asks for a draggable box instead of a select so the level reads as
 * "how full" at a glance (SPEC-0001 "输入框"; design-language "推理强度框").
 *
 * @sideEffects Captures the pointer while dragging; schedules animation frames for the
 * spring; calls `onChange` when the level settles.
 */
export function EffortBox(props: EffortBoxProps) { … }
```

- **唯一的豁免**：内联的匿名回调（传给 `map`、`filter`、`then`、事件属性的箭头函数）。它们要么足够短一眼能看懂，要么就该提成具名函数并写 JSDoc。测试用例靠测试标题说明，不写 JSDoc。
- **检查**：本地 oxlint 插件 `scripts/lint/atrium-plugin.mjs` 的 `atrium/require-jsdoc` 规则，要求函数声明、方法、类、函数表达式和赋给变量的箭头函数都有 JSDoc，且有第一句、`@remarks`、`@sideEffects`（`eslint-plugin-jsdoc` 要求 Node ≥ 22.22，比项目的 22.19 新，所以没用它）；`require-param`、`check-tag-names` 等用 oxlint 自带的 jsdoc 规则。语义是否写对，靠代码审查。`@sideEffects` 是作者自己写的描述，不当证据；只核对一种矛盾（2026-10-23 加，`atrium/side-effects-none`）：写 `@sideEffects none` 的函数，自己或直接传给某个调用的回调（`new Promise(…)`、`.map(…)`、`.then(…)`）里调了有副作用的 API，就报错。算数的 API：从 `child_process` 导入的起进程函数，从 `fs`、`fs/promises` 导入的写文件、删文件、建目录等，`http`、`https`、`net` 的请求和监听，全局的 `fetch`、`setTimeout`、`setInterval`、`setImmediate`，任何对象上的 `.setTimeout` / `.setInterval`（注入的时钟），`process.exit`、`process.kill`（信号 0 除外），`console.*`，名叫 `log` 或以 `logger` 结尾的对象上的日志级别方法，`new WebSocket`。返回或存起来、以后才跑的闭包不算，宁可漏报不误报；只认原样的 `none`，"none until … then …"这类已经写明的留给审查。
- 函数内部的行内注释只解释"为什么"，不复述代码在做什么。

## 命名与组织

- 文件名 kebab-case；一个文件一个主要导出。不用默认导出。
- 测试与实现放在一起（`thing.ts` + `thing.test.ts`），后缀约定见 [testing.md](testing.md#分层)。
- 包之间、宿主内部模块之间的依赖规则见 [overview.md · 代码结构](overview.md#代码结构)。
- 不为未来预留抽象：有两个实现再抽接口（[路线图 · 原则](../roadmap.md#原则)）。

## 错误

- **按边界区分**：
  - 预期内的失败（pi 没装、目录不存在、git 版本太低、会话已被别的客户端回答）返回结果对象 `{ ok: false, error }`，错误带稳定的 `code`。
  - 程序错误和不该发生的状态直接抛异常，由入口统一记录并转成 `internal` 错误。
- **跨协议的错误只传错误码和参数**，不传给用户看的文字（见"多语言"）。错误码在 `protocol` 里定义成枚举，宿主和 UI 共用。
- 每个可能失败的用户操作，界面都有进行中、成功、失败三种状态，失败时留下可操作的错误（[testing.md](testing.md#让覆盖面全)）。
- 不吞错误：`catch` 里要么处理并说明理由，要么带上下文重新抛出，要么记日志并转成结果对象。

## 异步与取消

- 不允许悬空的 Promise（oxlint `no-floating-promises`、`no-misused-promises`）。确实要"发出去不等"的，用 `void` 并在上一行写 `// Fire and forget: <为什么>`，它会失败的话自己接上 `.catch` 记日志。宿主另有全局兜底（`platform/stray-rejections.ts`）：漏掉的拒绝记一条 error 日志（`Error` 记 `{ err }`，别的只记类型，免得带出对话内容）、宿主不退出（Node 22 默认会让整个宿主崩掉、连带所有会话）；它在宿主启动时装、关闭或启动失败时卸，只是兜底，不代替 `.catch`（2026-10-19 加）。
- 不拿长期不结束的 Promise（例如 pi 进程的 `exited`）做 `Promise.race` 的一方：每次 race 都在它上面挂一个回调，回调带着调用时的异步上下文（连同 trace 的 span）一直留到它结束，反复调用就越积越多。改成对它只挂一次、各次等待自己登记和注销（会话控制器的 `untilExit`，由本来就在等 pi 退出的 `watchExit` 叫醒）；那一次也不要在某条命令里懒创建，否则它带着那条命令的上下文活到 pi 退出。2026-10-10 浸泡测试发现：每次停止都在 pi 的 `exited` 上留一个，会话不归档就不释放。
- 可能耗时的操作（子进程、git、网络、文件扫描、等待 pi 响应）都接受 `AbortSignal`，取消后释放资源。
- 定时器、事件监听、订阅、子进程都要有对应的释放路径，并计入资源计数（[testing.md · 性能与资源泄漏](testing.md#性能与资源泄漏)）。
- 时间一律通过注入的 `Clock` 取，不直接调 `Date.now()` / `setTimeout`，以便测试用假时钟。例外：Electron 主进程和 `scripts/` 是组装层，只靠端到端测试覆盖，可以直接用定时器，并在 JSDoc 里写明。

## 类型

- TypeScript strict，另开 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。
- 不用 `any`；外部输入（WebSocket 消息、pi 输出、索引文件）在边界用 zod 校验后再进入内部。
- 状态用可辨识联合（discriminated union）表达，`switch` 必须穷尽（`switch-exhaustiveness-check`）。

## React

- 不在 effect 里跟着流式 props 改状态，改在渲染中调整（状态已对上就返回原对象）。否则每次提交都留一个更新，连续到达的 WebSocket 消息会让 React 判为死循环、抛 #185（2026-10-22，见 [self-use.md · 问题](../research/self-use.md#问题)）。

## 多语言

- MVP 只做中文，不引入 i18n 框架。
- **宿主不产出给用户看的文字**：错误、通知、状态都以码和参数发给 UI，由 UI 组织文案。以后加英文只改 UI。
- UI 里的文案写在组件旁边即可，不为翻译提前抽离。

## 无障碍

- 所有操作都能用键盘完成，焦点可见。
- 只有图标的按钮必须有可访问的名称（`aria-label`）。
- 文字和背景对比度达到 WCAG AA。
- 遵从系统"减弱动态效果"（[design-language · 动效](design-language.md#动效)）。

## 依赖

- 依赖锁定精确版本，不用 `^` / `~`；升级单独提交。
- 加新依赖前先确认没有现成的能用，并在提交信息里说明理由。
- 只有 `pi` 包能 import `@earendil-works/*`。

## Swift（手机端）

2026-10-25 定（MP1）。适用于 `apps/ios`（SwiftPM 包 `AtriumKit` 和 App 本体）。上文的通用规则照样适用：标识符和注释用英文、错误按边界区分、跨协议只传错误码、不吞错误、依赖锁精确版本、不为未来预留抽象；这里只写 Swift 特有的。工具都用 Xcode 自带的（Xcode 26.6：Swift 6.3、swift-format 6.3），不另装。

### 格式化与静态检查

- **格式化**：`swift format`（Xcode 自带的 swift-format），配置在 `apps/ios/.swift-format`：缩进 2 空格、行宽 120（和 oxfmt 一致），其余用默认。`pnpm ios:format` 改写文件；`pnpm check` 里跑 `swift format lint --strict`，只报不改。
- **静态检查**以编译器为主：Swift 6 语言模式（完整的数据竞争检查），所有警告当错误（对齐 `oxlint --deny-warnings`）：`AtriumKit` 由 `scripts/ios.mjs` 给 `swift build` / `swift test` 加 `-Xswiftc -warnings-as-errors`，App 用 Xcode 的 `SWIFT_TREAT_WARNINGS_AS_ERRORS`。没写进 `Package.swift` 的 `treatAllWarnings(as: .error)`，因为 Xcode 编译本地包时带 `-suppress-warnings`，两个选项冲突、构建直接失败。swift-format 的 lint 在默认规则外另开：`AllPublicDeclarationsHaveDocumentation`、`BeginDocumentationCommentWithOneLineSummary`、`ValidateDocumentationComments`（写了 `- Parameters:` 就要和签名对上）、`NeverForceUnwrap`、`NeverUseForceTry`、`NeverUseImplicitlyUnwrappedOptionals`、`NoLeadingUnderscores`。测试里要解包用 `try #require(…)`，不用 `!`。
- **不加 SwiftLint**（MP1 定）：它要用 Homebrew 另装、多一套版本要锁；我们要的规则里，风格和强制解包 swift-format 已经有，并发靠编译器，剩下的（每个声明都有文档注释、悬空 Task、不安全的并发豁免）swift-format 和 SwiftLint 都管不了，由下文的 `scripts/swift-lint.mjs` 做。以后真碰到要它的规则（复杂度、未使用代码的分析器等）再加。
- **生成的代码**（`Sources/AtriumProtocol/Generated/`）不跑格式化和 lint：`pnpm check` 要逐字节比较它和生成器的输出，在没装 Xcode 的机器上也能比，所以不经过 swift-format；生成器自己保证输出整齐。

### 文档注释

对齐上文的 JSDoc 规则，写成 Swift 的文档标记（`///`）：

1. **What**：第一句话说它做什么（第一段就是摘要）。
2. **Why**：`- Remark:` 说为什么需要它、为什么这样设计（对应哪条规格或约束、绕开了什么坑）。
3. **副作用**：`- SideEffects:` 列出对外部世界的影响（网络、钥匙串、文件、改共享状态、起 Task、注册定时器、写日志）；没有写 `- SideEffects: none`。Swift 的文档标记没有这个字段，是 Atrium 自己的约定，Xcode 的快速帮助里显示成一条普通的列表项。

按需写 `- Parameters:`（多个参数时用复数形式、逐个缩进列出；swift-format 要求）、`- Parameter x:`（只有一个参数时）、`- Returns:`、`- Throws:`。

```swift
/// Decodes one frame from the host and hands it to the session it belongs to.
///
/// - Remark: The host may still send events for a session this client stopped watching a
///   moment ago (SPEC-0005 "断线与恢复"), so those are dropped instead of failing the link.
/// - SideEffects: Updates the session's state; logs a dropped frame.
/// - Parameter frame: One frame's plaintext.
/// - Returns: Whether a session took it.
/// - Throws: `DecodingError` when the frame is not a host message.
func deliver(_ frame: Data) throws -> Bool { … }
```

- **要写的**：类型（`struct`、`class`、`enum`、`actor`、`protocol`）、函数和方法（含嵌套函数）、`init`、`subscript`，不论访问级别。函数、`init`、`subscript` 三部分都要；类型只要第一句和 `- Remark:`，因为类型本身不执行代码，副作用写在它的 `init` 和方法上。`public` 的属性和枚举 case 另由 swift-format 要求有一行文档。
- **豁免**：闭包（同 JSDoc 的内联匿名回调）、`extension` 本身（里面的声明照常写）、`typealias`、非 `public` 的属性和 case、`@Test` 函数和 `@Suite` 类型（靠测试标题说明，同 TypeScript 的测试用例）、UI 测试里以 `test` 开头的方法（XCTest 只认这个名字），以及生成的代码。
- **检查**：`scripts/swift-lint.mjs`（`pnpm check` 里跑）。swift-format 的 `AllPublicDeclarationsHaveDocumentation` 只管 `public`、不看段落，不够用，所以另写这个小脚本：去掉注释和字符串后逐行找声明，要求紧挨在上面（中间只能隔着属性，如 `@MainActor`）有 `///` 注释，且有第一句、`- Remark:`，函数类再要 `- SideEffects:`。只认一行开头的声明，写法奇怪的宁可漏报不误报；语义是否写对靠审查。

### 并发

- **Swift 6 语言模式**，完整的数据竞争检查是编译错误。另开 Xcode 26 新工程默认的"Approachable Concurrency"里 Swift 6 还没默认的两项：`NonisolatedNonsendingByDefault`（不隔离的 `async` 函数在调用方的 actor 上跑，不再悄悄换线程）、`InferIsolatedConformances`。SwiftPM 里写在 `Package.swift` 的共用设置，App 用 `SWIFT_APPROACHABLE_CONCURRENCY = YES`。
- **默认隔离**：`AtriumUI` 和 App 默认 `@MainActor`（`defaultIsolation(MainActor.self)`、`SWIFT_DEFAULT_ACTOR_ISOLATION = MainActor`），界面代码本来就都在主线程，不用到处标；其余模块默认不隔离。
- **状态放哪**：被几个任务同时碰的可变状态放进 `actor`（relay 连接、重连状态机，SPEC-0005 的 `AtriumRemote`）；只给界面用的状态放 `@MainActor @Observable` 的类；值类型和不可变的数据标 `Sendable`。不用 `@unchecked Sendable`、`nonisolated(unsafe)`、`@preconcurrency import`；确实要用时在上一行写 `// Unchecked: <理由>`，`scripts/swift-lint.mjs` 检查这行注释在不在，理由是否成立靠审查。这类豁免注释要紧挨着它豁免的那一行，所以写在文档注释和声明之间（`/// …`、`// Unchecked: …`、`final class X: @unchecked Sendable`），检查文档注释时会跳过它（2026-10-26 审查后定）。
- **不留悬空的 Task**（对应 TypeScript 的 `no-floating-promises`）：优先用结构化并发（`async let`、`withTaskGroup`、`withDiscardingTaskGroup`，SwiftUI 的 `.task {}` 跟着视图取消）。确实要非结构化的 `Task { … }` / `Task.detached { … }`，把句柄存在拥有者身上，拥有者结束（`stop()`、断开、`deinit`）时 `cancel()`；真要"发出去不等"，在上一行写 `// Fire and forget: <为什么>`，错误在 Task 里自己处理并记日志。`scripts/swift-lint.mjs` 拦"没被赋值、上一行也没有这句注释"的 `Task {`、`Task.detached {`。
- **取消**：耗时的操作（网络、握手、等待回执）都是 `async` 的并响应取消（`try Task.checkCancellation()`、`withTaskCancellationHandler`），对应 TypeScript 的 `AbortSignal`；取消后释放连接和定时器。
- **时间一律注入**（对齐上文的 `Clock`）：等待、超时、心跳、退避用注入的 `any Clock<Duration>`（标准库的 `Clock` 协议，生产传 `ContinuousClock()`）的 `sleep(for:)`；要时间戳的地方注入 `now: @Sendable () -> Date`。不直接调 `Task.sleep`、`Date()`、`Timer`、`DispatchQueue.asyncAfter`，`scripts/swift-lint.mjs` 在 App 本体以外（`AtriumKit` 的源码和测试、UI 测试）都拦这几种写法；测试确实要真实时间时（例如量真实耗时），上一行写 `// Real time: <为什么>`（2026-10-26 审查后定，原先只查源码）。例外：App 本体（`apps/ios/Atrium/`）是组装层，同 Electron 主进程，可以直接用，并在文档注释里写明。测试用的手动推进的时钟，等第一段要等待的代码出现时（MP0 的心跳或 MP4 的重连）放进一个测试支持 target，现在不建。

### 命名与组织

- 一个文件一个主要类型，文件名同类型名（UpperCamelCase，Swift 的惯例，不用 kebab-case）。
- 纯逻辑放 `AtriumKit` 的 target 里（能在 macOS 上 `swift test`），App 本体只做组装（`@main`、注入时钟和依赖）。模块之间的依赖见 [overview.md · 代码结构](overview.md#代码结构)。
- 协议类型只由 `pnpm protocol:swift` 生成，不手改（[testing.md · Swift（手机端）](testing.md#swift手机端)）。
