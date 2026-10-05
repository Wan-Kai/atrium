# Atrium 项目守则

Atrium 是以 pi 为唯一内核的 macOS 桌面 coding agent。本文件给在这个仓库里工作的 agent 和人看，内容只放"每次都要遵守的规则"和"去哪里找"，细节都在 `docs/` 里。

## 开工前

1. 先读 [docs/roadmap.md](docs/roadmap.md) 的"当前状态"和"开工前必读"，找到当前里程碑，读它"参考"一栏列出的文档章节。
2. 上下文丢失（新会话、对话被压缩）后，同样从路线图开始找回，不凭记忆。
3. 动手前确认本次改动属于哪个里程碑、对应 SPEC 的哪条需求或流程。

## 以文档为准

- 规格：[SPEC-0001](docs/specs/0001-mvp1-single-session-chat.md)；领域模型：[domain-model.md](docs/architecture/domain-model.md)；代码结构与依赖规则：[overview.md · 代码结构](docs/architecture/overview.md#代码结构)；视觉：[design-language.md](docs/architecture/design-language.md)。
- 实现和文档不一致时，**先改文档再改代码**；文档没覆盖到的设计问题，先提出来，不自行决定。
- pi 的行为以 [pi-internals.md](docs/research/pi-internals.md) 为准，对不上时以 pi 源码为准并更新笔记。

## 写代码

遵守 [coding-standards.md](docs/architecture/coding-standards.md)，其中最常用的：

- **每个函数、方法、类、React 组件都写 JSDoc**：第一句写 what，`@remarks` 写 why，`@sideEffects` 写副作用（没有写 `none`），按需 `@param` / `@returns` / `@throws`。只有内联匿名回调豁免。
- 包之间、宿主模块之间的依赖只能按 overview.md 规定的方向；只有 `packages/pi` 能 import `@earendil-works/*`。
- 宿主不产出给用户看的文字，只发错误码和参数。
- 不留悬空 Promise；耗时操作接受 `AbortSignal`；时间经注入的 `Clock`。
- 安全底线见 [security.md](docs/architecture/security.md)；日志与链路追踪见 [observability.md](docs/architecture/observability.md)：日志带 trace id，不记录凭据和对话内容。

## 测试

遵守 [testing.md](docs/architecture/testing.md)：

- 能用真的就用真的；默认不用 `vi.mock`。
- 每个测试先见过失败；修 bug 先写能复现的测试。
- 断言完整、确定；时有时无的测试按 bug 修，不删。
- 新增的行为在追踪表 `docs/testing/coverage-map.md` 里登记。

## 完成一项任务的标准

- [ ] 相关测试通过，新行为有测试，并在追踪表登记
- [ ] `pnpm check` 通过（格式、代码检查含 JSDoc、类型、knip）
- [ ] 改动涉及核心模块时，变异测试增量通过（≥ 80%）
- [ ] 涉及资源（进程、监听、定时器、订阅）时，泄漏测试通过
- [ ] 文档同步：设计变化改 `docs/architecture/`，里程碑完成时更新路线图"当前状态"

## 提交与分支

见 [docs/development.md](docs/development.md)：每个里程碑一个分支，完成后本地合并回 `main`；提交信息英文祈使句；**只在明确要求时推送**。

## 常用命令

`pnpm dev`、`pnpm check`、`pnpm test`（及 `test:pi`、`test:host`、`test:ui`、`test:e2e`、`test:leak`、`test:perf`、`test:mutation`、`test:soak`）、`pnpm bench`、`pnpm trace <trace id>`、`pnpm pi:try "<提示词>"`。M1.1 搭好后以 `package.json` 为准。
