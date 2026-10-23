# DeepSeek Harness 客户端插件：插槽与"挂载子插件"

> 2026-10-23 读源码整理，给 [plugin-model.md](../architecture/plugin-model.md) 的"挂载点""视图运行时"做参考。
>
> **依据**：GitHub `deepseek-ai/deepseek-harness` 最新提交 `687f282`（2026-10-17，tag `dsh-v0.2.1-rc.2`，浅克隆在 `~/.cache/deepseek-harness-src`）。下文路径相对这个仓库，行号也按这个版本。
>
> **版本对照**：
> - 本机源码 `~/Documents/MT/projects/deepseek-harness` 是 `0.1.0-rc.5`（文件时间 2026-08-13），**落后很多**：没有 `ui-renderer`（那时渲染在 `web-react`、插槽服务在 `runtime`）、没有 `registerFactory`、没有插件管理页和插件市场、没有 `apps/desktop`。插槽的核心做法（`register` + `children` + `slots.inject`）那时已经有了（本机 `packages/client/runtime/src/client/slots.ts:143`）。
> - 已装的 `/Applications/DeepSeek Harness.app` 是 `0.2.0-rc.2`（`Info.plist`、`Resources/runtime/primary-runtime/runtime.json`）。`app.asar` 里搜得到 `dsh-client-ui-plugin-manager`、`registerFactory`、`slots.inject`，搜不到 `dsh-client-ui-plugin-market`，和 GitHub 上 0.2.0 到 0.2.1 之间加了市场一致。
> - npm 上 `@deepseek-ai/dsh-client-ui-slots` 的 `next` 是 `0.2.1-rc.2`，`latest` 还停在 `0.0.1-rc.1`。
>
> 只读了源码和文档，没有运行、构建或启动应用。第三方例子 `Wan-Kai/dsh-plugin-workspace`（本机 `~/Documents/MT/projects/dsh-plugin-workspace`）只有一个宿主侧插件 `repo-brief`，没有界面，下文只在"开发者体验"里提一句。

DSH 的界面本身就是一棵 Cordis 插件树：浏览器里跑第二个 Cordis，每个界面功能是一个插件。所谓"挂载子插件"在 DSH 里分两层：

- **Cordis 层**：插件在自己的上下文里 `ctx.plugin(child)`，子插件的生命周期挂在父插件下。
- **界面层**：插件在注册自己组件时用 `children` **声明**几个插槽，别的插件用 `ctx.slots.inject(name, () => ctx.slots.register(...))` 往里**贡献**组件。插槽跟着声明它的那条注册活，声明消失，里面的贡献一起清掉。

下面先讲 Cordis，再讲插槽（重点），再讲工具渲染、两半配对、加载、安全、开发者体验，最后单列"DSH 自己的界面有多少是插件"。

## 1. Cordis 层的嵌套

DSH 把 Cordis 作为源码放在 `vendor/cordis`。概念速览见 `docs/cordis-primer.md`，API 参考是 `docs/cordis-api/*.md`（生成的）。

### 父插件加载子插件

```ts
// vendor/cordis/src/registry.ts:185
plugin<P extends Plugin>(plugin: P, ...args: Spread<GetPluginConfig<P>>): Fiber & PromiseLike<Fiber>
// :176，等于 ctx.plugin({ inject: deps, apply: callback })
inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>
```

- 每加载一次产生一个 **fiber**（插件的一次运行实例）。子 fiber 的上下文是父上下文的原型继承：`this.ctx = parent.extend({ fiber: this })`（`vendor/cordis/src/fiber.ts:236`）。所以子插件能看到父插件看得到的所有服务，自己 `provide` 的服务对兄弟和父也可见（同一个隔离作用域内）。
- 子 fiber 的销毁登记成父 fiber 的一个 effect：`this.dispose = parent.fiber.effect(...)`（`fiber.ts:265`）。**父插件卸载 → 逆序跑它的 effect → 子 fiber 卸载**，子插件注册的一切（监听、服务、插槽贡献）跟着回收。
- `ctx.effect(execute, label)` 是所有可回收注册的底座：`execute` 立即执行，返回的清理函数在调用 disposer 或 fiber 卸载时逆序执行（`docs/cordis-api/fiber.md`）。生成器形式可以一次装好几个、失败时把已装的逆序撤掉。

### 服务的提供与注入

- `ctx.provide(name, value)`（`vendor/cordis/src/reflect.ts:44`）或 `class X extends Service { constructor(ctx){ super(ctx, 'name') } }` 提供服务，插件用 `export const inject = ['slots', 'remote']` 声明依赖。
- 依赖没到齐时 fiber 停在 PENDING，**没有超时**；提供者重载时，依赖它的 fiber 被卸掉再重跑（`docs/cordis-tutorial/06-composition-and-hmr.md`"Diagnosing a plugin that never loads"）。
- `ctx.isolate(name)` 让一棵子树有自己的同名服务（`docs/cordis-api/context.md`），客户端没用到（`client-plugin-loading-model` 笔记"Costs accepted"：groups/isolation unused）。

### 客户端里实际怎么用

客户端里 `ctx.plugin(child)` 主要用来**把一个包拆成几个可独立回收的子单元**，不是给第三方挂子插件：

- `ui-tool` 的 `apply` 先注册工具调用树，再依次 `ctx.plugin(readToolview)`、`ctx.plugin(todoToolview)` 等九个内置工具视图（`packages/client/ui-tool/src/client/apply.ts:44-52`）。每个都是 `{ name, inject, apply }` 对象插件，例如 `todoToolview`（`ui-tool/src/client/tool/toolviews/todo-row.tsx:81-94`）。
- `ui-conversation` 用 `ctx.plugin(ConversationController, …)`、`ctx.plugin(todoDockEntry)`（`ui-conversation/src/client/apply.ts:574-580`）。
- 会话作用域也是一个空 fiber：`createScope` 里 `ctx.plugin(agentScope)` 再 `fiber.ctx.extend({ [kScope]: … })`（`packages/api/session-controller/src/client/scope.ts:44-46`），服务方法按调用方的作用域标记找会话。

插件之间**不靠父子关系通信**。别的插件要往某个插件的界面里放东西，走的是下一节的插槽，不是被那个插件 `ctx.plugin` 进去。DSH 明确否决了"每个插槽一个 Cordis 上下文 / fiber"：贡献者要的是"自己插件的生命周期 ∩ 插槽声明的生命周期"，不是继承声明者的能力；那样会带来能力继承和双父卸载的问题（`.agents/notes/archived/architecture/2026-08-05-slot-declaration-injection.md:36`）。

## 2. 插槽：插件怎样留位置、子插件怎样挂进来

权威文档是 `docs/subsystems/slots.md`，设计理由在 `.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md`（下称"插槽标准"）。代码分两个包：

- `packages/client/ui-slots`：不依赖 React 的注册表核心 `SlotCore` 和全部类型（`src/index.ts`，1673 行）。
- `packages/client/ui-renderer`：Cordis 服务 `SlotRegistry`（`ctx.slots`），把注册接到调用方的 fiber 上，加上 React 渲染、错误边界、store 实例（`src/client/registry.ts`、`src/client/scoped-slots.tsx`）。

### 只有一个 API：注册时顺便声明子插槽

```ts
// docs/subsystems/slots.md 里插槽标准的示例（插槽标准 :23-32）
ctx.slots.register({
  name: 'root',                       // 我挂进哪个插槽
  children: {                         // 我渲染哪些插槽 = 声明 + 授权
    'sidebar':      { kind: 'single', scope: 'root' },
    'conversation': { kind: 'single', scope: 'session' },
  },
  store: createLayoutStore,           // 可选：共享的界面状态
  inject: injectFrame,                // 可选：给组件的数据和回调
}, AppFrame)
```

- 没有单独的"定义插槽"调用。`children` 里的键**就是**这个组件被允许渲染的插槽，同时让这些插槽"存在"（`docs/subsystems/slots.md:17`）。
- 一个插槽只能有一个声明者。第二个插件再声明同名插槽、往没声明的插槽里注册，都在加载时抛错（`SlotCore.register`，`ui-slots/src/index.ts:1207-1260`）。
- 外壳只渲染 `'root'`：`ctx.slots.renderSlot('root', {})` 是唯一的上下文级渲染入口，传别的键直接抛错（`ui-renderer/src/client/registry.ts:382-396`）。其余插槽都在声明它的组件里用 props 上的 `renderSlot` 画。
- 类型侧用声明合并：每个包往 `SlotMap` 里加自己声明的插槽的形状（`ui-slots/src/index.ts:26`、`:116-140`）：

```ts
// packages/client/ui-tool/src/client/contract/slots.ts:26-30
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'tool.call.toolview': { kind: 'keyed'; scope: 'session'; owner: ToolCallOwnerProps }
  }
}
```

  `children` 的值在编译期和 `SlotMap` 对照（`SlotSpec`，`:165`），组件渲染了没声明的键、或者声明了却不渲染，都是编译错误（`RendersCheck`，`:806`）。
- 插槽名按组合路径写：`<领域>.<条目>.<洞>`，如 `tool.call.toolview`（`packages/client/AGENTS.md:12`）。

### 父插件怎样留位置：以 `ui-tool` 为例

`ui-tool` 自己挂进 `ui-chat` 声明的 `conversation.chat.node`（键 `tool-call`），同时声明子插槽 `tool.call.toolview`，然后在组件里按工具名分派：

```ts
// packages/client/ui-tool/src/client/apply.ts:34-42
ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
  name: 'conversation.chat.node',
  key: 'tool-call',
  locale: NS,
  children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } },
  inject: toolInject,
}, ToolCallTree))

// packages/client/ui-tool/src/client/tool/ToolCallTree.tsx:52-55
renderSlot('tool.call.toolview', owner, {
  entryKey: toolName,
  fallback: <GenericToolCard {...owner} t={t} />,
})
```

### 子插件怎样挂进来：`slots.inject` 等声明出现

别的包的插件不知道声明者什么时候加载（客户端插件激活顺序只由服务依赖决定，见第 5 节），所以贡献要包在 `ctx.slots.inject` 里：

```ts
// docs/subsystems/slots.md:36-45
export const inject = ['slots']
export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'review',
      order: 100,
    }, HeaderAction))
}
```

`SlotRegistry.inject`（`ui-renderer/src/client/registry.ts:209-271`）的行为：

- 声明已在：立刻跑回调；不在：订阅这个键的"声明生命周期"，等声明出现再跑。
- 回调返回一个 disposer，或一个生成器依次 yield 几个 disposer（几项贡献要么全装上、要么全撤回，`packages/client/AGENTS.md:149`）。
- 声明消失（声明者被卸载、或它那条注册被撤掉）：回调的效果被撤掉；声明再出现（例如热重载后）：回调**重跑**。为了分清"消失又出现"和"一直在"，`SlotCore` 给每个键记一个声明代数 `declarationEpoch`，同一 tick 里合并的"塌掉再声明"也算新的一代（`ui-slots/src/index.ts:1474-1476`；`2026-08-05-slot-declaration-injection.md:17`）。
- 等待和贡献都挂在**贡献者自己的 fiber** 上：贡献者卸载，等待取消、贡献撤回。声明者的上下文不会交给贡献者（同一笔记 :19）。
- 延迟声明后回调抛错：先撤掉已装的，再在微任务里抛出，不让一个贡献者卡住别的监听者（`registry.ts:247-258`）。
- 直接 `register` 进未声明的插槽仍然抛错——"有意的独立顺序"和"装配写错"要分得开（同一笔记"Alternatives"）。

`register` 本身也走 `ctx.effect`（`registry.ts:740-746`），并且必须是原型方法：Cordis 的服务代理在调用时把 `this.ctx` 绑成**调用方**的上下文，效果才落到调用方的 fiber 上（`registry.ts:174-181` 的注释）。

### 卸载时的级联

注册返回的 disposer 撤掉这条贡献，**并且**把它在 `children` 里声明的插槽全部塌掉：插槽规格清空、里面的贡献清空，递归往下（`releaseEntry` / `releaseChildren`，`ui-slots/src/index.ts:1590-1614`）。台账是一张 `Map<key, record>`，贡献、子插槽、store 实例都挂在同一条注册上，一起生一起死。持有旧 `renderSlot` 的组件再调用会抛"过期授权"错误（插槽标准 :95）。

所以"父插件卸载 → 子插件的界面消失"有两条路，结果一样：

1. 子插件是父插件 `ctx.plugin` 进来的（如 `ui-tool` 的九个工具视图）：子 fiber 随父 fiber 卸载，它的 `register` 效果撤掉。
2. 子插件是别的包：父插件的注册撤掉 → 它声明的插槽塌掉 → 子插件的贡献被台账清掉，子插件的 `inject` 回调效果也被撤掉、回到等待；父插件重新加载后子插件自动重挂。

### 四种基数和排序、替换

插槽声明时定两件事：基数（`kind`）和作用域（`scope`）（`docs/subsystems/slots.md:48-62`；类型 `ui-slots/src/index.ts:101-104`）。

| 基数 | 含义 | 贡献要带的字段 |
|---|---|---|
| `single` | 一格，优先级最低的那条渲染 | `priority?` |
| `list` | 一排，按 `id` 分格，按 `order` 排，同序按注册顺序 | `id`、`order?`、`label?`、`priority?` |
| `keyed` | 拥有者按 `entryKey` 分派，命中那格渲染 | `key`、`priority?` |
| `chain` | 每条带纯函数 `select(owner)`，按 `priority` 依次试，第一个非 null 的渲染，结果作为 `matched` 传给组件；全 null 渲染拥有者的 `fallback` | `select`、`priority?` |

作用域：`root`（全局一份）、`session`（必须在会话里，拿得到 `sessionId`、`useSession`）、`session-maybe`（可有可无）。

**替换是靠"同一格、更低优先级"**：`single`、`keyed` 的同一个键、`list` 的同一个 `id`，可以有几条不同优先级的注册，最低的渲染，其余被遮住；同一格同一优先级再注册就抛错（`SlotCore.register` 的注释和实现，`ui-slots/src/index.ts:1138-1146`、`:1220-1243`）。文档的规矩是：要追加就用新的 `id` 或没被占的键；复用已有的格就是在替换内置界面（`docs/subsystems/slots.md:62`、`:200`）。框架**不区分内置和第三方**，替换没有开关、不问用户。最危险的是 `root`：`ui-renderer` 在 `SlotMap` 的注释里专门写了"不要往这里注册"，因为第三方动态包会被分到更低的优先级，一注册就把整个应用框架顶掉（`ui-renderer/src/client/registry.ts:36-44`）。

动态包（agent 现写的插件，见第 7 节）的优先级由守卫统一分配：非 `chain` 的注册一律改成"本页递增的更低值"，后来的盖住先来的（`packages/extensions/cordis-client-runner/src/client/guard.ts:125-131`）。

### 组件拿到什么

组件是纯函数，**拿不到 `ctx`**，也不读任何 React context（`packages/client/AGENTS.md:42-44`）。它的 props 由几份拼成，每份都从一个来源自动推导（`ComposedProps`，`ui-slots/src/index.ts:605-614`；表见 `docs/subsystems/slots.md:64-75`）：

| 一份 | 来源 | 内容 |
|---|---|---|
| 运行时 `PropsRuntime<K>` | `SlotMap` 里这个插槽的 `owner` + 作用域 | 拥有者在 `renderSlot` 时传的参数；`session` 作用域加 `sessionId`、`useSession` 等标准 hook |
| 子插槽 `PropsRenderSlots<S>` | 自己注册时的 `children` | `renderSlot` / `renderSlotChain`，键被收窄到声明过的 |
| store `PropsStore<H>` | 注册时的 `store` | `useStore` 选择器 + 声明过的 `actions.*`，拿不到 `set` |
| 业务 `InjectFace<I>` | 注册时的 `inject` 工厂的返回值 | 普通数据和回调；`hooks` 里的可订阅源被框架绑成 `use<Name>` |
| 文案 `t` | 注册时的 `locale` | 按命名空间的翻译函数 |
| `matched` | `chain` 的 `select` 返回值 | 被选中的原因 |

几条规矩（`packages/client/AGENTS.md:7-33`）：

- hook 只能由框架造。业务组件不写 `useSyncExternalStore`，可订阅的数据要么走 `inject` 的 `hooks`，要么是声明过的 store，要么是标准 hook。
- 界面域之间只传可 JSON 化的数据和回调；React 节点只能经插槽传，不能作为 props 或 inject 的值。
- `inject` 工厂在插件的 `apply` 闭包里，只能用该插件 `inject` 声明过的服务，返回的是"收窄后的面"，不是整个服务对象。
- 插槽拥有者可以在 `children` 的声明里放一个**插槽级** `inject`，所有往里挂的组件都拿到同一份能力。例如 `conversation.chat.node` 给每个节点 `useTurnData(key)`，节点只能读到同一轮里别人发布的数据，不能扫整个会话（`docs/subsystems/slots.md:108`）。

`registerFactory` 是 0.2 加的第二种声明：可复用的组件"工厂"，调用方每次渲染时选它的本地子组件，例如 `conversation.user.text` 被用户消息、排队、目标三处共用（`packages/client/ui-slots/README.md:30-34`、`docs/subsystems/slots.md:178-189`）。它解决的是"同一套组装在几处复用"，和挂子插件关系不大。

### 条件显示

没有声明式的 `when` 条件。条件显示靠这几样：

- `chain` 的 `select(owner)`：纯函数，读拥有者给的参数决定接不接管。决定不接管就**不挂载**组件，而不是挂上再返回 null（插槽标准 :56-58）。例子是 `conversation.composer`：审批、提问、子代理各注册一条，有待处理的就接管输入框，都没有时显示原输入框；`overlay: true` 让原输入框藏起来而不卸载，草稿不丢（`ui-slots/src/index.ts:274-290`）。
- `keyed` 找不到键、或插槽空着：渲染拥有者给的 `fallback`。
- `list` 的 `only` 选项只渲染某个 `id`（`ui-slots/src/index.ts:267`），右栏、设置页这类"一次显示一个"的位置用它。
- 作用域：`session` 插槽只在绑定了会话的子树里渲染。
- 其余由组件自己根据数据决定画什么。

### 错误隔离

- 每条贡献外面一个错误边界 `SlotErrorBoundary`，`inject` 工厂也在边界里执行，出错只黑掉这一条（`ui-renderer/src/client/scoped-slots.tsx:395-421`、`:1120-1124`）。
- `single`、`keyed`、`list` 出错的那条"退位"：从这一格里去掉，格子落到下一条优先级的注册（被它遮住的内置版本会重新出现）；一格全退位了，显示空的占位 `<div data-slot-error>`，而不是拥有者的 fallback（`scoped-slots.tsx:1126-1133`、`:1174-1177`；`SlotCore.reportEntryError`，`ui-slots/src/index.ts:1545-1553`）。
- `chain` 的 `select` 抛错按"不接管"处理并记日志，链和 fallback 不受影响（`scoped-slots.tsx:1201-1216`）。
- 装配错误（`SlotAssemblyError`，例如 `session` 插槽没有会话绑定）照样往上抛，不降级：配置错了要让人看见（`scoped-slots.tsx:409-411`）。
- 所有崩溃走 `ctx.slots.onEntryError` 一个通道，插件列表和 agent 自扩展用它报告（`ui-renderer/src/client/registry.ts:438-445`）。
- 加载期没有这么宽容：任何一个客户端插件包导入失败、fiber 失败或卡在 PENDING，整个界面停在启动页并列出出错的包，**不支持部分可用**（`packages/client/web/README.md:128`）。

### 现有的插槽（摘要）

完整清单是生成的 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`（100 个键，带基数、作用域、拥有者、当前占用者和"替换风险"），会话页的层级图在 `docs/subsystems/slots.md:114-187`。和 Atrium 挂载点对得上的几个（声明者 → 现在往里挂的包，按 `name: '<键>'` 搜出来的）：

| 位置 | 插槽 | 基数 | 声明者 | 现在的贡献者 |
|---|---|---|---|---|
| 应用框架 | `root` | single | 内建 | `ui-layout`（`AppFrame`） |
| 左栏 | `sidebar` | single | `ui-layout` | `ui-sidebar` |
| 中间主面板 | `main` | keyed | `ui-layout` | `ui-conversation`（键 `conversation`）、`ui-plugin-manager`、`ui-schedule` |
| 右栏 | `rightbar` | single | `ui-layout` | `ui-sidebar-right` |
| 右栏标签 | `sidebar.right.pane.tab` | keyed | `ui-sidebar-right` | 文件、预览、浏览器、终端、改动、计划、子代理等 9 个包 |
| 底部整宽 | `shell.bottom` | single | `ui-layout` | 无 |
| 浮层（提示、状态胶囊） | `shell.overlay` | list | `ui-layout` | 9 个包 |
| 对话视图 | `conversation.view` | list | `ui-conversation` | `ui-chat`、`ui-trajectory` |
| 对话节点 | `conversation.chat.node` | keyed | `ui-chat` | `ui-chat`、`ui-tool`、`ui-goal`、`ui-user-questions`、`ui-workflow-run` |
| 单个工具 | `tool.call.toolview` | keyed | `ui-tool` | `ui-tool`、`ui-skill`、`ui-deliverables`、`ui-cordis` |
| 输入框接管 | `conversation.composer` | chain | `ui-conversation` | `ui-approval`、`ui-user-questions`、`ui-subagent` |
| 输入框工具条 | `conversation.input.left/right/model/plan/permission` | list / single | `ui-conversation` | `ui-model-selection` 等 |
| 会话标题栏按钮 | `conversation.session.header.actions/utilities` | list | `ui-conversation` | `ui-jobs`、`ui-subagent`、`ui-open-in-app`、`session-log-export` 等 |
| 设置页分区 | `settings.section` | list | `ui-settings` | 通用、模型、账户、插件、预设 |
| 插件页标签 | `plugins.tab` | list | `ui-plugin-manager` | `ui-plugin-market`（"发现"） |

没有专门的"状态栏"：底部状态类的东西放 `shell.overlay` 或 `shell.bottom`（`ui-layout/src/client/index.ts:88-105`）。插槽层级很深，`ui-tool` 自己既是 `conversation.chat.node` 的贡献者又是 `tool.call.toolview` 的声明者，`ui-sidebar-right` 同理——"挂子插件"在 DSH 里是一条多级的链。

## 3. 工具调用和消息怎么渲染

### 工具：按工具名分派，找不到用通用卡片

- `ui-tool` 声明 keyed 插槽 `tool.call.toolview`，在 `ToolCallTree` 里用 `entryKey: toolName` 分派，没有注册的工具名渲染 `GenericToolCard`（`ui-tool/src/client/tool/ToolCallTree.tsx:50-55`）。键是线上的工具名，**按名字精确匹配**，没有按数据类型或判断函数选的机制。
- 业务包为自己的工具注册视图：`ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: '<工具名>' }, Row))`（`packages/client/ui-tool/README.md`"Registering a business tool view"）。例子：`ui-skill` 注册 `skill`。内置的 bash、read、edit、grep、web、todo、提问等九个也走同一条路（第 1 节），README 说它们"可以各自搬到所属的业务包"。
- 组件拿到的拥有者参数 `ToolCallOwnerProps`：`callId`、`toolName`、`phase`（`preparing` / `start` / `result`）和对应阶段的 `block`、`cwd`、`home`、会话授权的 `loadImage`、`openFile` / `inspect` 回调（`ui-tool/src/client/contract/slots.ts:26-30`、`:85-91`）。`preparing` 阶段的参数是一个"惰性读取器"，模型还在生成参数时就能读到已经闭合的字段（例如 `file_path`），后面变了框架再重发（同一 README"Built-in views"）。
- 强制降级：被自动审查拒绝的调用一律用通用卡片，不进专用视图（`ToolCallTree.tsx:40-51`）。专用视图自己也要对不认识、格式不对的数据退回通用形式（`packages/client/AGENTS.md:59`）。
- 卡片的数据**在客户端从原始事件推导**。宿主侧工具定义里有 `presentCall` / `presentResult`（一个封闭的 `card: 'generic' | 'terminal' | 'diff'` 联合，`.agents/notes/implemented/architecture/2026-07-02-tool-render-intent-union.md`），但 0.2 起会话流不再调用它们，只送原始的 `tool/call`、`tool/result` 和结果里持久化的 `data.meta`；客户端卡片模型直接读这些。理由：两处各解释一遍同一事件，而 keyed 插槽本来就是 Web 的扩展点（`.agents/notes/implemented/architecture/2026-08-23-client-derived-tool-presentation.md`"Problem""Decision"）。

### 其他消息：先折成节点，再按节点类型分派

非工具的会话事件（自定义事件、目标、提问的晚到回复等）走 Conversation 层：业务包注册一个 `ConversationNodeDefinition`（`match(event)` 认领事件并给出稳定 id，`start` / `update` 折叠状态，`buildViewNode` 产出节点数据），再往 `conversation.chat.node` 注册同名键的渲染组件（`docs/subsystems/conversation.md` 的完整示例 :78-243，注册在 :237-242）。要点：

- 状态由事件按 `seq` 重放得出，往前翻页、断线重连、实时追加三条路结果一致；不能扫整个事件窗口（同文"Window update paths"）。
- `exclusive: true` 认领一个事件，同一视图里通用定义就不再显示它（同文 :250）。
- 没有任何定义认领的事件由视图的"未认领事件兜底"处理（同上）。

### 文件预览和右栏标签：带优先级档的注册表

右栏标签类型用 `ctx.sidebarRightTabs.register({ id, kind, patterns, priority, canOpen, … })` 登记，再往 `sidebar.right.pane.tab` 注册同 `id` 的组件。打开一个资源时，按 `patterns`（glob）匹配，再按优先级档 `extension` > `builtin` > `fallback`、匹配长度、注册顺序选；`canOpen` 可以拒绝（`packages/client/ui-sidebar-right/README.md:80-88`）。文档预览同理：`ctx.documentPreviews.register({ id, extensions, priority, … })` 加 keyed 插槽 `sidebar.right.tab.document`，未知扩展名退回纯文本（`ui-sidebar-documentpreview/README.md:12`、`:35`）。这是 DSH 里唯一一处把"第三方优先于内置"写成显式规则的地方；工具视图没有这一层。

## 4. loop 侧和界面侧：同一个包的两半

### 怎么配对

- 一个 npm 包可以同时有宿主面和浏览器面：`exports["."]` 是宿主插件（`lib/index.js`），`exports["./client"]` 是浏览器 bundle（`lib/client.js`），`package.json` 里 `dsh.client: { platform: 'web', inject?, immediately?, external? }` 声明它有浏览器半边。例子：`packages/session-query/session-log-export/package.json`（宿主出导出路由，浏览器在会话标题栏放按钮和对话框）。纯界面包的宿主面是空的 `apply`（`packages/client/AGENTS.md:146`）。
- 配对靠**同一个包名**：宿主的 `cordis.yml` 里加一行这个包，宿主插件就加载；`dsh-client-modules` 的宿主半边扫描已挂载的条目，看到 `dsh.client` 就把它的 `./client` 编进浏览器的启动图（第 5 节）。没挂的包，即使声明了 `dsh.client` 也不进图（`.agents/notes/implemented/architecture/2026-07-23-client-plugin-loading-model.md`"Why is the roster yml rows and not a scan?"）。

### 怎么通信

| 方向 | 机制 | 出处 |
|---|---|---|
| 界面调宿主 | 宿主服务方法加 `@Remote` / `@RemoteScope('agent', …)`，构建时生成类型、编解码器和客户端桩，界面里调 `ctx.remote.<命名空间>.<方法>()`；会话作用域里是 `agentCtx.remote.…` | `docs/api-gateway.md:7-62` |
| 宿主推流给界面 | `@Remote({ mode: 'stream' })` 返回异步迭代器，界面拿到 `RemoteStreamHandle`，还能经同一条流上行 | `docs/api-gateway.md:60` |
| 宿主事件 | 白名单里的 Cordis 事件经内部 `$events` 流转发，界面 `ctx.remote.$on()` 订阅；会话作用域的 waterfall 事件（例如审批、提问）界面可以返回结果或 `next()` | `docs/subsystems/web-client.md:34`、`:74` |
| 持久的会话数据 | 宿主会话日志 → `follow` / `page` → 客户端事件窗口 → Conversation 节点 → 插槽 → React | `docs/subsystems/web-client.md:66-75` |
| 不持久的控制状态 | 宿主快照流 → 客户端投影 store → 标准 hook | 同上 |

几条和 Atrium 相关的约定：

- **界面层只管画**："怎么画"的东西不写进会话日志；卡片数据由客户端从原始事件推导，重放时重算，算不出来就用通用形式（`packages/client/AGENTS.md:59`）。要给模型看的新输入必须是会话事件。
- 插件自己的事件类型用声明合并加进 `SessionEventMap`，宿主写、客户端读，同一个包里共享类型（`docs/subsystems/conversation.md:78-130` 的 `review/*` 示例）。
- 远程方法的契约在构建期生成：改了方法签名要重跑 `pnpm run build:lib`，开发态的宿主可以用源码回退，但客户端拒绝没有严格编解码器的描述（`docs/api-gateway.md:136-160`）。

## 5. 加载、共享依赖、热重载、版本

### 两种包

- **平台包**：React 一家、Cordis、zod、`@tanstack/react-virtual`，以及几个静态的客户端库（`dsh-client-store`、`ui-slots`、`ui-primitives`、`ui-dockkit`）。打进外壳、预先放进模块表，所有插件共享这一份（`packages/client/web/src/platform.ts:8-15`）。插件构建时这些自动当外部依赖（`packages/client/AGENTS.md:78-87`）。
- **插件包**：其余一切，带 `dsh.client`，用共享的 tsdown 预设（`packages/client/tsdown.client.ts:115`）各自打成 `lib/client.js` 和 source map。CSS 内联在 bundle 里，执行时插成 `<style data-plugin="<id>">`，重载时按标记删掉（`.agents/notes/archived/architecture/2026-07-19-gui-web-client-architecture.md:34`）。

### 不用 import map，用自己的模块表

浏览器没有 Node 的模块系统，DSH 自己写了一个"懒 CommonJS 表"（`dsh-client-modules`；设计见 `.agents/notes/implemented/architecture/2026-07-23-client-plugin-loading-model.md`，下称"加载笔记"）：bundle 是同源的经典 `<script>`，执行时只调 `window.__ModuleLoader__.load({ id, factory })` 登记工厂；第一次被 `require` 时才执行，依赖递归物化，不需要排序（加载笔记"One module system, one plugin governor"）。

- **插件之间不许 import 对方的值**，构建时就报错；只能 `import type`，行为走 Cordis 服务，界面走插槽（`packages/client/AGENTS.md:40`）。
- import map 和模块联邦被明确否决："DI 的 require 表让共享显式、出错就响、可替换；全局变量会悄悄泄露身份和版本"（加载笔记 Alternatives :119；`archived/.../2026-07-19-gui-web-client-architecture.md:126`）。
- 宿主用 `/plugins/??a/client.js,b/client.js&rev=…` 合并请求，版本号取文件的 mtime、ctime、大小，响应永久缓存（`docs/subsystems/client-modules.md:88`、`:102`）。

### 启动：全有或全无

1. 宿主扫描已挂载条目，把 `window.__DSH_BOOT__ = { rev, entries, batches }` 写进首页（`docs/subsystems/client-modules.md:13-86`）。
2. 第一阶段预取 `immediately` 的基础设施行；第二阶段挂 Cordis Loader、为每行建条目，激活顺序**只由服务依赖决定**，`dsh.client.inject` 里的包名边只是提示。
3. 全部 fiber 都 ACTIVE 才切到真界面；有失败或卡住的，停在启动页逐个列出（加载笔记 :70；`packages/client/web/README.md:128`）。依赖等待没有超时，这一步扫描是兜底。

### 用户和第三方插件怎么进来

- 打包单位是 **bundle**：一个 npm 包，`dsh.bundle.patch` 指向一份 `cordis.patch.yml`，往配置树里插行。用户的 **profile** 按顺序叠加 bundle 层（`docs/user/develop/basic/publish.md`"Two concepts""The loading order"）。客户端插件就是被某行挂上、带 `dsh.client` 的包，和宿主插件同一条路。
- 安装：`dsh plugin --profile <名字> add <包>`（转给 pnpm），或界面的插件页（`ui-plugin-manager`），或插件市场的"发现"标签（`ui-plugin-market`，读第三方索引）。开着 HMR 时装完当场重组生效，否则提示重启（`packages/boot/plugin-manager/README.md:14`、`:73`）。
- 版本：bundle 写 `engines.dsh` 的 SemVer 范围，安装前和启动时都检查，不满足就拒绝；没写就看它对 `@deepseek-ai/dsh*` 的 peer 依赖范围。可以按"包@版本 × DSH 版本"手动豁免，并提示可能崩溃或丢数据（`publish.md:66`；plugin-manager README"Version compatibility and exemptions"）。**界面侧没有单独的视图 API 版本**，兼容性是整包一起判。

### 热重载

`client-hmr` 的宿主半边每 500ms 轮询 bundle 的文件信息，变了就推 `rebuilt` 帧；浏览器半边一次换一个 fiber：作废旧工厂 → 预取新脚本 → 删条目 → 等旧 fiber 清理完 → 删样式 → 重新导入 → 等激活。依赖它服务的插件由 Cordis 自动连带重载（加载笔记"Hot reload"）。代价写得很明白：**重载是粗粒度的，插件里的 React 状态丢失**，数据层（连接、会话对象）不受影响；不做 react-refresh（`packages/client/hmr/README.md:36`、`:116`）。插件启用、停用也走同一条路，不刷新页面。

## 6. 安全与信任

- **客户端插件跑在应用的源里，没有沙箱，也没有权限声明。** bundle 是同源的经典脚本，和内置插件同一个模块表、同一个 Cordis 根。`inject` 只声明依赖哪些服务，是依赖注入的纪律，不是权限。
- 连动态包（agent 现写的插件）的守卫也自认不是安全边界："这是 API 纪律，不是安全边界：动态包的代码和接受它定义的宿主进程一样可信"（`packages/extensions/cordis-client-runner/src/client/guard.ts:12-13`）。守卫做的是白名单：只给生命周期动词（`effect`、`on`、`provide`、定时器）和声明过的服务，拒绝返回 Cordis 上下文，插槽注册统一分配优先级（同文件 :22-25、:56-63、:125-131）。动态包的浏览器半边按"异步函数体"求值，只拿到 `React`、`console`、`styles`、`host` 几个名字，`fetch`、`setTimeout` 这类全局量不可用；要在用户批准或亲手点运行后才加载（`cordis-client-runner/README.md`"What the page does""What the run surface offers"）。
- 宿主 API 的保护针对的是别的网站，不是插件：Host / Origin 检查防 DNS 重绑定和跨站请求，再加浏览器 token 认证（`packages/client/connection/README.md:47`）。插件在应用源里，天然能用这些凭据。
- 安装环节的把关：插件市场安装前弹确认框，带作者、来源和信任提示（`ui-plugin-market/README.md:33`）；pnpm 默认拦依赖的构建脚本，用户逐个批准（`packages/boot/plugin-manager/README.md:64`）；版本不兼容拒装。
- **沙箱 iframe 只用于内容，不用于插件**：
  - HTML 预览开"可交互"时用 Blob iframe，`sandbox="allow-scripts"`、不加 `allow-same-origin`，相关的 js/css 由宿主读好打进去，限 4 MiB / 32 MiB / 64 个；关时用 DOMPurify 净化成静态文档，CSP 禁脚本和外部资源（`ui-sidebar-documentpreview/README.md:49`、`:60`）。
  - 右栏浏览器标签默认 `sandbox` 带 `allow-same-origin`（访问的是别的源，读不到 DSH），用户可以对单个标签临时关掉沙箱（`ui-sidebar-browser/README.md:63`）。

## 7. 开发者体验

- **文档**：Cordis 有入门（`docs/cordis-primer.md`）、七章教程（`docs/cordis-tutorial/`，从空目录做起，不需要 API key）、生成的 API 参考（`docs/cordis-api/`）。面向插件作者的 `docs/user/develop/` 讲第一个插件、工具、配置、打包发布、让 agent 写插件，**全是宿主侧**，没有一篇讲客户端插件或插槽（在 `docs/user` 里搜 `slot`、`dsh.client` 都是 0 处）。
- 写客户端插件的资料都在仓库内部：`packages/client/AGENTS.md`（规矩和"新插件包清单"）、`docs/subsystems/slots.md`、`docs/subsystems/conversation.md`、各包 README、`.agents/notes/` 里的设计笔记。新包清单要求改三处登记（`tsconfig.client.json`、`web-app` 的 `cordis.patch.yml`、`web-app/package.json`），漏一处会在不同的、更晚的地方报错（`packages/client/AGENTS.md:147`）。
- **类型包**：`@deepseek-ai/dsh-client-ui-slots` 等发布在 npm，但 `latest` 标签还是 `0.0.1-rc.1`，新版本在 `next`；插件要和宿主共享实例的包放 `peerDependencies` + `devDependencies`（`publish.md`"Install into a profile"）。
- **没有脚手架和模板**。构建预设 `clientBundle` 在仓库里（`packages/client/tsdown.client.ts:115`），没有单独发布成给外部作者用的工具包。
- **给 agent 的工具反而更全**：生成的插槽目录 `slot-catalog.ts` 写了每个插槽的基数、作用域、参数、占用者和替换风险，运行中可以用 `cordis_inspect what:"client"` 查活的插槽树（`docs/subsystems/slots.md:191`）；"Creator"预设让 agent 写插件并用 `plugin_manager` 工具安装。
- 第三方例子 `Wan-Kai/dsh-plugin-workspace` 只有一个宿主插件 `@wan-kai/dsh-repo-brief`：`dsh.bundle.patch` 指向一行 `cordis.patch.yml`，`@deepseek-ai/cordis` 放 peer，用 tsdown 构建（`plugins/repo-brief/package.json`）。没有界面，印证了外部作者目前主要写宿主侧插件。

## 8. DSH 自己的界面有多少是插件

几乎全部。官方 Web 组合（`packages/bundle/web-app/cordis.patch.yml`）里浏览器侧的插件行有 60 个；连渲染机制 `ui-renderer`、连接层、会话的客户端模型都是动态插件（`packages/client/AGENTS.md:50-51`）。

### 核心骨架（不是插件，不能替换）

| 部分 | 是什么 | 出处 |
|---|---|---|
| 外壳内核 `dsh-client-web` | 启动页、两阶段启动、加载状态；不依赖框架，不 import 任何动态包的值（它要报告插件系统自己的失败）；不是 Loader 条目 | 加载笔记 :31；`packages/client/AGENTS.md:103` |
| 模块系统 `dsh-client-modules`（浏览器半边） | 懒 CJS 表。0.2 起它也是图里的一行，但工厂在主脚本之前由宿主先送到；热重载拒绝替换它，要刷新页面 | 加载笔记 :31、:95 |
| Cordis 和它的 Loader | 浏览器和宿主跑同一份源码 | 同上 |
| `root` 插槽本身 | `SlotCore` 构造时内建，外壳只渲染它 | `ui-slots/src/index.ts:1013-1018` |
| 平台库 | React、`dsh-client-store`、`ui-slots`、`ui-primitives`、`ui-dockkit`，静态打进外壳；改了要重建页面 | `packages/client/web/src/platform.ts:8-15` |

### 内置插件（都能被同一套 API 替换或扩展）

| Atrium 里对应的东西 | DSH 的包 | 怎么挂上去的 |
|---|---|---|
| 窗口框架、三栏布局 | `ui-layout` | 占 `root`，声明 `sidebar`、`main`、`rightbar`、`shell.bottom`、`shell.overlay`、`shell.leading`（`ui-layout/src/client/index.ts:178-189`） |
| 会话列表 | `ui-sidebar` + `ui-workspace` | `ui-sidebar` 占 `sidebar`、声明 `sidebar.workspaces`，`ui-workspace` 往里挂列表（`ui-sidebar/src/client/index.ts:84`） |
| 对话流 | `ui-conversation`（外壳、输入状态机、事件装配）+ `ui-chat`（聊天视图和节点）+ `ui-trajectory`（另一种视图） | `main` 的 `conversation` 键 → `conversation.view` 列表 → `conversation.chat.node` |
| 工具渲染 | `ui-tool`（树、通用卡片、九个内置视图） | `conversation.chat.node` 的 `tool-call` 键 → `tool.call.toolview` |
| 输入框 | `ui-conversation` 的 `conversation.composer.bar`；模型选择、权限、计划、附件各是一个包 | 被 `conversation.composer`（chain）接管时让位给审批、提问、子代理 |
| 右栏 | `ui-sidebar-right` + 文件、预览、浏览器、终端等标签包 | `rightbar` → `sidebar.right.pane.tab` |
| 设置 | `ui-settings` 框架 + 通用、模型、账户、插件等分区包 | `settings.section` 等 |
| 状态栏 | 没有这个位置 | 状态类东西放 `shell.overlay`（列表）或 `shell.bottom` |
| 插件管理、市场 | `ui-plugin-manager`、`ui-plugin-market` | `main` 的一个键；市场是 `plugins.tab` 的一项 |

### 内置和第三方用的是不是同一套 API

是同一套：同一个 `ctx.slots.register` / `inject`、同一个模块表、同一个加载器、同一种 bundle。`ui-sidebar-right` 的文档特意说内置的引导标签"走的就是另一个包的类型走的那条公开路径"（`ui-sidebar-right/README.md:81`）。没有只给内置用的注册接口。差别在这几处：

- **框架装配接口**：`ctx.slots.install`（渲染器）、`installLocale`、`installScope`、`provideRoot` 都是"启动一次"的，第二次调用抛错；文档说扩展标准 hook 是"框架和领域适配器的拥有者"的事（`ui-renderer/src/client/registry.ts:279-352`；`docs/subsystems/slots.md:100`）。这是靠先到先得和约定，不是权限。
- **共享代码**：只有平台库能被所有插件 import；第三方插件不能把自己的组件给别人用，只能走插槽（`packages/client/AGENTS.md:40`、`:155`）。`dsh.client.external` 只许基础设施用。
- **优先级不对称**：内置的注册优先级默认 0，动态包被分到更低的值，**动态包天然盖过内置**（第 2 节）。
- **展示上的特权**：插件页的功能预览图只给内置 bundle，存在插件管理页内部的表里，"第三方插件没有预览接口"（`docs/cookbook/adding-a-plugin-preview.md:5`）；市场里内置的显示"Provided by DSH"。

### 代价（源码和文档里写明的）

- **启动全有或全无**：一个包失败整个界面不出来，没有渐进渲染（`packages/client/web/README.md:128`；`archived/.../2026-07-19-gui-web-client-architecture.md:119`、`:129`）。
- **加载顺序靠服务依赖，等待没有超时**：缺服务的插件静静卡在 PENDING，只有启动时的全量扫描兜底；`inject` 包名边只是提示，和真正的依赖不一致时到扫描那一步才发现（加载笔记 :70、"Costs accepted"）。插件激活顺序不定，才需要 `slots.inject` 和声明代数这一整套（第 2 节）。
- **自建基础设施**：模块表、浏览器化的 Loader、合并请求路由、source map 拼接都要自己维护；Loader 在浏览器里带着用不上的机制（加载笔记"Costs accepted"）。
- **调试**：外部脚本失败只拿得到 URL，拿不到 HTTP 状态；每个 bundle 多一份 map；宿主和客户端是两套 TypeScript 程序，"这个文件在哪个程序里"时常要想（加载笔记 :107；`archived/.../2026-07-19-gui-web-client-architecture.md:119`）。
- **类型约束重**：注册选项密，框架带大量推断机制（`NoInfer`、裸调用签名代替 `FC`），原型阶段的偏差也是硬编译错误（插槽标准"Consequences"、:97-102）。
- **开发循环**：每改一个插件都要重打 bundle、重挂 fiber，React 状态丢；换掉 connection 这类底层提供者，所有依赖它的插件跟着重载，"正确但重"（加载笔记 :95-97）。新包要改三处登记（第 7 节）。
- **替换的坑**：任何人都能用更低优先级遮住内置界面，`root` 一注册就顶掉整个框架，只能靠注释警告（`ui-renderer/src/client/registry.ts:36-44`）。

## 9. 对 Atrium 的启示

前提和 DSH 不同：DSH 的界面是浏览器里第二棵 Cordis 插件树，部署时按配置拼，插件之间靠服务和插槽协作，没有沙箱。Atrium 的插件逻辑在 pi 进程里，视图只负责画，宿主只转发，第一版插件之间不通信、不覆盖核心组件（[plugin-model.md](../architecture/plugin-model.md)"不做"）。[lowcode-engine.md](lowcode-engine.md) 第 9、10 节已写过的结论（挂载点核心定、按精确键选渲染器、Disposable、按包名命名空间等）这里不重复，只写 DSH 带来的新东西和与它的分歧。

### 借鉴

1. **挂载点按"基数"分类**（挂载点表）。DSH 的 `single` / `list` / `keyed` / `chain` 比低代码的"互斥 / 并列"多两种，正好对上 Atrium：工具步骤是 `keyed`（按工具名分派），右栏面板、查看标签、状态栏是 `list`（`id` + `order`），输入框上方的提问卡片是"接管"型（类似 `chain`，见"改了再用"第 2 条）。挂载点表里给每行加一列"基数"。
2. **降级是一条链，不是一个兜底**（降级）。DSH：专用视图出错 → 从格子里退位、落到下一条注册 → 全退位显示占位；`keyed` 找不到键 → 拥有者的 fallback；视图对不认识的数据自己退回通用形式；核心还能**强制**通用（被自动审查拒绝的调用不进专用视图）。Atrium 照做：第三方工具视图出错 → 内置视图（如有）→ 通用工具行；宿主拒绝、中止或 `details` 校验失败的调用直接用通用工具行。退位要上报错误码，测试要覆盖每一级。
3. **卡片数据在界面侧从原始数据推导，"怎么画"不进会话文件**（数据通道）。DSH 0.2 把宿主侧的 `presentCall` / `presentResult` 从会话流里拿掉，理由是"两处各解释一遍同一事件"。这印证了 Atrium 已定的做法：宿主只转发不透明的插件分支，视图用自己的 schema 校验。不要再加"宿主替插件算展示数据"的口子。
4. **组件不拿上下文，props 由框架按挂载点拼好**（视图 API）。DSH 的组件只收拥有者参数、作用域标准 hook、自己的 store、自己的 inject 面；跨界面只传可 JSON 化的数据和回调。Atrium 的视图 props 按挂载点固定：工具步骤给 `phase` + 参数 + 结果 + 当前分支上的插件条目，面板给会话 id + 条目，hook 只有 kit 提供的几个。DSH 的"插槽级 inject"（同一挂载点的所有视图共享同一份受限能力，如 `useTurnData(key)`）就是 Atrium `useSessionData` 的形状：按挂载点给，不给整个会话。
5. **工具视图的三个阶段**（挂载点 · 工具步骤；HTML 设计稿"流式"）。DSH 的拥有者参数用 `phase: 'preparing' | 'start' | 'result'` 区分，`preparing` 时给一个能读已闭合字段的惰性参数读取器。Atrium 工具步骤的 props 直接用这个判别字段；pi 的 RPC 是否转发生成中的工具参数仍待核实，没有时 `preparing` 阶段就不出现。
6. **注册都挂在插件的生命周期上，撤掉时连带清理**（发现与加载）。DSH 用一张台账让贡献、子插槽、store 实例同生同死，旧的 `renderSlot` 再调用直接报"过期授权"。Atrium 停用、升级、卸载插件时按包名清掉它的视图、订阅和挂载项，热替换前先清旧的。
7. **给 agent 的挂载点目录**（以后的阶段 · agent 自扩展）。DSH 从类型和注册点生成插槽目录（基数、参数、占用者、替换风险），agent 运行中还能查活的树。Atrium 到阶段 5 时从 kit 的类型生成挂载点说明，交给写插件的 agent。

### 改了再用

1. **"插件挂子插件"：第一版不做，留出将来的做法**（挂载点、不做）。DSH 需要它，是因为整个界面都是插件、激活顺序不定、部署时拼装，挂载点只能由插件声明；所以才有 `children` 声明、`slots.inject` 等待、声明代数、级联塌落这一整套。Atrium 的挂载点由核心静态定义、启动时就在，插件之间第一版不通信，用不上等待和代数。将来真有第二个插件要往某个插件的视图里加东西（例如给 HTML 设计稿加标注工具）再做，做法按 DSH 改：
   - 插件在 manifest 里声明自己开的挂载点（`atrium.views[].slots`），不在代码里调 `register`，这样不加载代码就知道树长什么样；
   - 名字带包名前缀（`<包名>/<洞>`），一个挂载点只有一个声明者，保留 DSH 的"重复声明即报错"；
   - 挂载点跟着声明它的视图活，视图没了里面的贡献一起撤，保留 DSH 的级联；
   - 贡献者不拿声明者的任何能力，只拿声明者在 manifest 里写明的参数（DSH 否决"每个插槽一个上下文"的理由同样适用）。
2. **接管型挂载点用键匹配，不用 `select` 函数**（挂载点 · 输入框上方）。DSH 的 `chain` 靠纯函数 `select(owner)` 决定谁接管，要先加载代码。Atrium 让核心按"待处理请求的类型"这类数据键匹配，manifest 声明自己接管哪种键；同时保留 DSH 的 `overlay` 思路：被接管时原输入框隐藏不卸载，草稿不丢。
3. **替换内置要显式，默认用内置**（挂载点、以后的阶段）。DSH 只靠优先级遮蔽，没有开关也不问用户；动态包天然盖过内置；往 `root` 注册就把整个框架顶掉，只能靠注释警告。右栏标签的优先级档（`extension` > `builtin` > `fallback`，再按匹配长度）是唯一写成规则的地方，但默认第三方优先。Atrium 第一版不允许覆盖核心组件；以后开放时用档位的结构，但默认 `builtin` 优先，由用户在设置里改选（和 lowcode-engine.md"改了再用"第 6 条一致）。
4. **版本按视图 API 判，不兼容就降级**（发现与加载）。DSH 只有整包的 `engines.dsh`，不满足就拒装、拒启动，可以手动豁免。Atrium 的逻辑跑在 pi 里，不该因为视图 API 不兼容拒装；按 `atrium.api` 只关掉视图、显示通用工具行，提示用户。豁免不做。
5. **加载失败只影响这个插件的挂载点**（视图运行时）。DSH 启动"全有或全无"，任何一个包失败整个界面停在启动页。Atrium 反过来：核心界面不等插件，视图在第一次需要时加载，失败的只在自己的挂载点降级。
6. **热替换接受粗粒度**（开发与构建）。DSH 明说重载丢 React 状态、不做 react-refresh。Atrium 的插件状态本来就在会话文件里，组件局部状态丢掉代价小，照它粗粒度做：卸旧挂载、删样式、重新 import、重挂。
7. **插件作者的入口要一处**（开发与构建）。DSH 写客户端插件的资料全在仓库内部，面向作者的教程只讲宿主侧，没有脚手架；新包要改三处登记，漏一处在不同时刻报错。`@atrium/plugin-kit` 要发布、带一篇"写一个视图"的教程和模板，注册只靠 `package.json` 的 `atrium` 字段一处。

### 不借鉴

1. **自建模块表、否决 import map**（视图运行时）。DSH 的理由是共享要显式、模块要能热替换、插件之间靠依赖注入协作。Atrium 视图之间不 import 也不通信，共享的只有 React 和视图 API，import map 足够，而且是 ESM、PWA 和 CSP 下都好用。不为此自建加载器。
2. **浏览器里再跑一套插件框架和服务注入**（视图运行时）。Atrium 视图不提供也不消费服务；插件之间要共享的东西在 pi 里用 `pi.events`。
3. **生成远程方法的双半通信**（视图到逻辑）。DSH 的 `@Remote` 让插件的宿主半边直接暴露方法给界面。Atrium 已定插件不在宿主里跑代码，视图到逻辑只走宿主代发的 `/atrium-plugin` 隐藏命令。两者相同的一点是"按同一个包名配对两半"，这和 ADR-0003 一致。
4. **无沙箱、无权限声明地加载第三方界面**（安全）。DSH 的客户端插件和内置同源同权，连给 agent 写的动态包的守卫都自认"不是安全边界"；沙箱 iframe 只给 HTML 预览这类内容用。Atrium 保持已定的两档：受信任视图在应用源里，项目级插件第一次加载前要确认；第三方开放分享时进独立源沙箱。DSH 的 HTML 预览参数（`sandbox="allow-scripts"`、不加 `allow-same-origin`、相关资源由宿主读好限量打包）可以作为核心沙箱组件的对照。
5. **重型的类型推导**（开发与构建）。五份 props 的自动推导、`NoInfer`、裸调用签名，换来的是插件契约全编译期检查，代价是注册选项密、原型阶段的偏差都是硬错误（DSH 自己记在插槽标准"Consequences"）。Atrium 的挂载点是固定的一小张表，kit 给每个挂载点一个写死的 props 类型就够。

### "一切皆插件"放到 Atrium 值不值

DSH 是这条路走到底的样本：60 个浏览器插件，连渲染机制和连接层都是插件，核心只剩外壳内核、模块系统、Cordis、`root` 插槽和平台库（第 8 节）。它得到的：任何界面都能被同一套 API 替换或扩展，agent 能现写插件改自己的界面，不同部署（Web、桌面、无界面）按配置拼。它付出的：启动全有或全无、激活顺序要靠服务等待和声明代数兜、自建加载基础设施、两套类型程序、每次改动重打包重挂载、任何人都能遮住内置界面。

Atrium 的建议：**内置的"内容型"界面走插件 API，骨架不拆。**

- 工具步骤、代码块渲染器、右栏面板、查看标签、状态栏的各项，用和第三方同一套视图 API 写，静态打包、走同一张注册表、同一套降级。这些正好是挂载点表里的位置，迁一个就验收一次 API（和 lowcode-engine.md 第 10 节的映射一致）。
- 窗口框架、会话列表、消息流容器、输入框、设置框架、插件加载和降级本身留在核心。DSH 的骨架在理论上可替换，实际只能靠注释警告别碰 `root`，也没有第三方替换过布局；Atrium 又已定"不覆盖核心组件"，把骨架做成插件只会背上 DSH 的成本、拿不到好处。
- 内置插件不许有特权接口：DSH 的框架装配接口靠"先到先得"、预览图只给内置，属于约定和例外。Atrium 用依赖规则硬拦：内置视图目录只能 import `@atrium/plugin-kit`。
- 内置视图失败也要降级到通用形式，DSH 的错误边界对内置和第三方一视同仁，这点照做。

### 和低代码引擎的异同

| 方面 | 低代码引擎 | DSH | Atrium 取哪边 |
|---|---|---|---|
| 挂载点谁定义 | 核心写死十个区域 | 只有 `root` 内建，其余由插件在注册时声明 | 低代码：核心定义 |
| 注册方式 | 代码里 `skeleton.add` | 代码里 `slots.register`，类型靠声明合并 | 都不取：manifest 声明 + ESM 导出组件 |
| 选渲染器 | 显式 → 按类型 → 兜底；有 `condition` 判断函数 | 按键精确匹配；`chain` 用纯函数选 | 精确键匹配 |
| 卸载清理 | 名义上归插件，实际不清 | 台账级联，严格 | DSH |
| 出错 | 面板无边界 | 每条一个边界，退位到下一条 | DSH |
| 共享依赖 | `window.React` 全局 | 自建模块表 | 都不取：import map |
| 隔离 | 同源 iframe，不是安全边界 | 无，沙箱只给内容 | 都不取：两档信任 |
| 内置和第三方 | 同一 API，但内置会拿内部对象 | 同一 API，少数约定上的特权 | 同一 API，依赖规则禁止后门 |
