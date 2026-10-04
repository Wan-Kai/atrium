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
- **检查**：本地 oxlint 插件 `scripts/lint/atrium-plugin.mjs` 的 `atrium/require-jsdoc` 规则，要求函数声明、方法、类、函数表达式和赋给变量的箭头函数都有 JSDoc，且有第一句、`@remarks`、`@sideEffects`（`eslint-plugin-jsdoc` 要求 Node ≥ 22.22，比项目的 22.19 新，所以没用它）；`require-param`、`check-tag-names` 等用 oxlint 自带的 jsdoc 规则。语义是否写对，靠代码审查。
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

- 不允许悬空的 Promise（oxlint `no-floating-promises`、`no-misused-promises`）。确实要"发出去不等"的，用 `void` 并写注释说明为什么。
- 可能耗时的操作（子进程、git、网络、文件扫描、等待 pi 响应）都接受 `AbortSignal`，取消后释放资源。
- 定时器、事件监听、订阅、子进程都要有对应的释放路径，并计入资源计数（[testing.md · 性能与资源泄漏](testing.md#性能与资源泄漏)）。
- 时间一律通过注入的 `Clock` 取，不直接调 `Date.now()` / `setTimeout`，以便测试用假时钟。

## 类型

- TypeScript strict，另开 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。
- 不用 `any`；外部输入（WebSocket 消息、pi 输出、索引文件）在边界用 zod 校验后再进入内部。
- 状态用可辨识联合（discriminated union）表达，`switch` 必须穷尽（`switch-exhaustiveness-check`）。

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
