# 阿里低代码引擎的插件与界面扩展

> 2026-10-22 读源码整理，给插件模型（[plugin-model.md](../architecture/plugin-model.md)）用。依据：[alibaba/lowcode-engine](https://github.com/alibaba/lowcode-engine) `main` 分支提交 `f6305c2`（2024-06-11，包版本 1.3.2）；仓库内文档 `docs/docs/`（即 lowcode-engine.cn 的源，`docs/package.json` 版本 1.2.31，同一提交）；另看了 `develop`（`7ceea19`，2024-07-03）和 `feat/runtime-2.0`（`46139fc`，2024-08-21）。路径相对仓库根，`packages/` 下各包对应 npm 的 `@alilc/lowcode-*`。
>
> 本地源码：`~/.cache/lowcode-engine-src`（`git clone --depth 1`，另 fetch 了上面两个分支）。

低代码引擎是"做低代码平台的框架"：一个可视化搭建器（左栏组件库、中间画布、右栏属性面板），编辑器上几乎所有东西都由插件往骨架里加。它和 Atrium 的形态差得远（搭建器 vs agent 对话界面），但"固定骨架 + 插件往区域里挂界面"这套正好是 Atrium 挂载点要解决的问题。

## 1. 项目现状

- **已停止维护**。`main` 最后一次提交 2024-06-11，`develop` 2024-07-03，`feat/runtime-2.0` 2024-08-21；GitHub API 显示最后 push 是 2025-03-10，未归档（`archived: false`），16k star、664 个未关 issue。
- npm：`@alilc/lowcode-engine` 的 `latest` 是 1.3.4（2025-03-11），1.3.3 同日发布；`beta` 是 1.3.3-beta.3（2024-06-18）。1.3.4 的 `gitHead`（`d960b24`）在公开仓库里取不到（`not our ref`），说明最后两版不是从公开分支发的。
- issue [#3111](https://github.com/alibaba/lowcode-engine/issues/3111)"是停止维护了吗"（2024-11）有 14 条回复，全是用户，维护者没有回应。社区分支 `@felce/lowcode-engine` 的 README 说"原工程 V1 确定不再进行社区开源维护，V2 版没有确切计划"——这是第三方的说法，官方没有找到对应公告。
- 2.0 只有一个渲染器 RFC（[#2713](https://github.com/alibaba/lowcode-engine/issues/2713)，2023-11）和没合并的 `feat/runtime-2.0` 分支（见第 8 节）。

结论：只当设计参考，不当依赖。

## 2. 插件机制

### 声明

插件是一个函数，挂两个静态字段（`packages/types/src/shell/type/plugin.ts`、`plugin-meta.ts`、`plugin-config.ts`）：

```ts
interface IPublicTypePlugin {
  (ctx: IPublicModelPluginContext, options?: any): IPublicTypePluginConfig;
  pluginName: string;
  meta?: {
    dependencies?: string[];               // 依赖的其他插件名
    engines?: { lowcodeEngine?: string };  // semver，如 '^1.0.0'
    preferenceDeclaration?: { title: string; properties: { key; type; description; default?; enum?; enumDescriptions?; deprecationMessage? }[] };
    eventPrefix?: string;                  // 事件命名空间，默认 'common'
    commandScope?: string;                 // 命令命名空间，注册命令时必填
  };
}
interface IPublicTypePluginConfig {
  init(): Promise<void> | void;
  destroy?(): Promise<void> | void;
  exports?(): any;                         // 给其他插件用的导出
}
```

发到 npm 时，同样的信息写在 `package.json` 的 `lcMeta` 字段（`docs/docs/api/plugins.md` 末尾、`docs/docs/guide/expand/editor/cli.md`"Meta 信息"），由工具链转成上面的静态字段。注意引擎运行时只认函数上的字段，`lcMeta` 是工具链的约定；文档里 `type`、`prototype` 等字段标着"尚未实现"。

### 注册与生命周期（`packages/designer/src/plugin/plugin-manager.ts`、`plugin.ts`）

- `plugins.register(plugin, options?, { autoInit?, override? })`：
  1. `eventPrefix` 撞上保留前缀（`designer`、`editor`、`skeleton`、`plugin`、`engine` 等 17 个）就清空并告警；
  2. 为这个插件建一个 `ctx`（每个插件一份，按名字缓存）；
  3. `options` 只保留 `preferenceDeclaration` 里声明过的 key（`plugin-utils.ts` 的 `filterValidOptions`），其余丢掉；
  4. 调插件函数拿到 `config`；
  5. 同名插件已存在：没有 `override: true` 就抛错；有就先 `destroy` 旧的；
  6. `engines.lowcodeEngine` 用 `semver.satisfies(引擎版本, 表达式, { includePrerelease: true })` 检查，不满足**抛错**，插件不注册。
- `plugins.init()`：按 `dependencies` 拓扑排序（`sequencify.ts`），缺依赖直接 `invariant` 失败；逐个 `await init()`，单个失败只记日志，继续初始化后面的（日志写"可能影响依赖它的插件"，但不跳过它们）。
- 引擎 `init()` 之后才注册的插件要带 `autoInit: true` 才会初始化。
- `delete(name)` 调 `destroy` 后移除。`destroy` 只调插件自己的回调，**插件加到骨架里的面板不会被自动移除**：shell 层给每个 `skeleton.add` 的配置打上了 `pluginName`（`packages/shell/src/api/skeleton.ts`），但仓库里没有任何地方读这个字段。`engine.destroy()` 里还留着 `// TODO: delete plugins except for core plugins`。
- 插件可以被 `setDisabled`，禁用后别的插件通过 `ctx.plugins.<名字>` 拿到的是 `undefined`。

### 插件拿到的上下文

`ctx` 是插件访问引擎的唯一入口（文档原话："ctx 是在插件中获取引擎 API 的唯一渠道"）。组装在 `packages/engine/src/engine-core.ts` 的 `pluginContextApiAssembler`：

| 字段 | 作用 | 是否按插件区分 |
|---|---|---|
| `skeleton` | 往骨架加面板、显隐 | 是：每个插件 new 一个，自动带上 `pluginName` |
| `project` | 文档模型（schema 的增删改） | 共享 |
| `material` | 资产包、组件元数据、元数据转换管道、画布上的组件操作按钮 | 共享 |
| `setters` | 注册 / 取设置器 | 共享 |
| `hotkey` | `bind(combos, cb)`，返回解绑函数 | 共享 |
| `event` | 全局事件总线，`emit` 自动加 `eventPrefix:` 前缀 | 是：前缀按插件 |
| `pluginEvent` | 只在插件内部的事件总线 | 是 |
| `command` | 注册 / 执行命令，名字是 `commandScope:name` | 是：scope 按插件 |
| `config` | 引擎配置（`engineConfig`） | 共享 |
| `preference` | `getPreferenceValue(key, default)`，只能读声明过的 key | 是 |
| `logger` | `bizName: plugin:<名字>` | 是 |
| `plugins` | 读其他插件的 `exports`：`ctx.plugins.PluginA.x` | 共享 |
| `common`、`canvas`、`workspace`、`commonUI` | 工具函数、拖拽、多窗口、通用 UI 组件 | 共享 |

宿主还可以通过配置 `enhancePluginContextHook` 往每个 `ctx` 上加东西，用 `customPluginTransducer` 在注册前改写插件（`plugin-context.ts`、`plugin-manager.ts`）。

### 插件之间

- 依赖：`meta.dependencies` 只决定 `init` 顺序。
- 调用：被依赖方在 `exports()` 里返回对象，依赖方用 `ctx.plugins.<名字>.<字段>` 取（Proxy 实现，`plugin.ts` 的 `toProxy`）。
- 消息：全局 `event`，或命令。

## 3. 编辑器骨架（skeleton）

这是和 Atrium 挂载点最直接对应的部分。代码在 `packages/editor-skeleton/src/`。

### 骨架是写死的，区域是固定的

`layouts/workbench.tsx` 是一个固定的 React 布局，按位置摆好每个区域的组件：

```
topArea
┌ leftArea ┬ leftFloatArea ┬ leftFixedArea ┬ toolbar    ┬ rightArea ┐
│ (图标列) │ (浮动面板)    │ (钉住面板)    │ mainArea   │ (面板)    │
│          │               │               │ bottomArea │           │
```

另有 `subTopArea`（只在 workspace 模式的布局里用）和 `stages`（右栏里的多级页面）。区域名有别名：`left`=`leftArea`，`main`/`center`/`centerArea`=`mainArea` 等（`api/skeleton.ts` 的 `normalizeArea`）。插件不能新增区域，只能往这些区域里放东西。

每个区域是一个 `Area`（`area.ts`），里面是一个 `WidgetContainer`（`widget/widget-container.ts`）：按 `name` 存的有序列表。区域分两种：

- **互斥（exclusive）**：同时只显示一个，区域是否可见取决于有没有"当前项"。`leftFloatArea`、`leftFixedArea`、`mainArea`、`bottomArea` 是互斥的。
- **非互斥**：全部显示，区域本身有 `visible` 开关。`leftArea`、`topArea`、`toolbar`、`rightArea` 是非互斥的（`rightArea` 和 `mainArea` 还设了 `defaultSetCurrent`，第一个加进来的自动激活）。

### 往区域里放东西：widget 类型

`skeleton.add(config)` 根据 `type` 创建对象（`skeleton.ts` 的 `createWidget`）：

| type | 是什么 | 常放在 |
|---|---|---|
| `Widget` | 直接渲染 `content` | `topArea`（logo、保存按钮）、`mainArea`（画布本身） |
| `Dock` | 一个图标 / 标题按钮，`props.onClick` 自定义 | `leftArea`、`topArea` |
| `PanelDock` | 图标 + 面板：点图标开关面板。构造时自动建一个同名 `Panel`，面板放进 `panelProps.area`（默认 `leftFloatArea`） | `leftArea` |
| `Panel` | 一块带标题栏的面板；`content` 是数组时变成多标签面板 | `rightArea`、`bottomArea`、左侧浮动 / 钉住区 |
| `Divider` | 分隔线 | 顶栏、工具栏 |

`type` 省略时：`Panel` 默认去 `leftFloatArea`，`Widget` 去 `mainArea`，其余去 `leftArea`。

配置字段（`packages/types/src/shell/type/widget-base-config.ts`、`editor-skeleton/src/types.ts`）：

```ts
interface IPublicTypeWidgetBaseConfig {
  type: string;            // 上表之一
  name: string;            // 全局唯一，后续 show/hide/remove 都按它找
  area?: string;
  index?: number;          // 排序，越小越靠前；不填按注册顺序
  content?: ComponentType | ReactElement | string;
  contentProps?: object;   // 传给 content 的 props
  props?: {                // 给外壳（图标、标题栏）用
    align?: 'left' | 'right' | 'top' | 'bottom' | 'center';
    icon?; title?; description?;      // title 可以是 i18n 对象
    condition?: (widget) => boolean;  // Panel：可见性由函数决定
    onInit?: (widget) => void;
    hiddenWhenInit?: boolean;
    help?; shortcut?;                 // shortcut 的注释写着 "todo: process shortcut"，未实现
  };
  panelProps?: { width?; height?; maxWidth?; maxHeight?; hideTitleBar?; area?; enableDrag?; keepVisibleWhileDragging?; floatable? };
  [extra: string]: any;    // 允许任意额外字段
}
```

几个实现细节：

- `index` 只在 `leftArea`、`topArea`、`subTopArea`、`rightArea` 的布局组件里参与排序（`layouts/*.tsx` 里 `sort` 按 `config.index || 0`）；`toolbar`、`bottomArea`、`mainArea` 和左侧面板区不排序。`align` 决定放在顶部还是底部（左栏）或左右（顶栏）。
- `content` 是**懒创建**的：第一次读 `body` 时才 `createContent(content, {...contentProps, config, editor})`，之后缓存（`widget/widget.ts`）。注意它把引擎的 `editor` 事件对象也塞进了 props。
- 重名：`Area.add` 发现同名就告警并返回已有项，不替换。
- 显隐 API（`api/skeleton.ts`）：`showPanel / hidePanel`、`showWidget / hideWidget`、`enableWidget / disableWidget`（禁用后不响应点击，文档建议初始化完成前先禁用）、`showArea / hideArea`、`remove({area, name})`、`getPanel`、`getAreaItems`；事件 `onShowPanel`、`onHidePanel`、`onShowWidget`… 都返回解绑函数。
- Panel 的可见性：父容器可见时，有 `props.condition` 就用它，否则看是否被激活（`widget/panel.ts`）。浮动 / 钉住状态记在 `localStorage`（`engineConfig.getPreference()`，键前缀 `ale_`，`skeleton.ts` 的 `toggleFloatStatus`）。
- **配置转换器**：`skeleton.registerConfigTransducer(fn, level, id)`，之后每次 `add` 都先把配置依次过一遍这些函数（按 `level` 升序）。官方示例是统一把所有 `PanelDock` 的面板宽度改成 240。也就是说，一个插件可以改写所有其他插件加的面板配置。
- 骨架里的面板**没有错误边界**：`components/widget-views` 下没有 `componentDidCatch`，整个包里只有属性表单的单个字段（`components/field/fields.tsx`）有，出错时那一行直接返回 `null`、只写日志。某个插件的面板渲染抛错会怎样，取决于外面有没有 React 错误边界——引擎没有加。

### 编辑器本身就是插件拼出来的

`engine-core.ts` 的 `registryInnerPlugin` 在引擎加载时注册了一批内置插件，用的是和第三方插件同一个 `plugins.register`：

| 内置插件 | 做什么 |
|---|---|
| `OutlinePlugin`（`packages/plugin-outline-pane`） | 大纲树：`leftArea` 的 `PanelDock` + `rightArea` 的 `Panel` |
| `___default_panel___`（`inner-plugins/default-panel-registry.tsx`） | 把**画布**作为 `Widget` 放进 `mainArea`；把属性设置面板作为 `Panel` 放进 `rightArea` |
| `___setter_registry___` | 注册 `@alilc/lowcode-engine-ext` 里的官方设置器 |
| `___component_meta_parser___` | 资产包变化时重建组件元数据 |
| `___register_defaults___`（`editor-skeleton/src/register-defaults.ts`） | 注册三个元数据转换器（解析函数、props 转设置器、追加通用配置项） |
| `builtinHotkey`、`defaultContextMenu`、`CommandPlugin` | 内置快捷键、画布右键菜单、节点 / 历史命令 |

骨架（`Workbench` 布局、区域、widget 类）和模型（`designer`、`project`、`editor`）是内核；内核之上，用户在界面上看到的面板、画布、设置器、快捷键全是内置插件。组件库面板、页面管理、数据源、代码编辑等都是 [lowcode-plugins](https://github.com/alibaba/lowcode-plugins) 仓库里的独立插件，由使用方自己注册。

但"同一套 API"有例外：

- `componentMetaParser(designer)` 和 `defaultPanelRegistry(editor)` 是工厂函数，**直接拿到内部的 `designer`、`editor` 对象**，绕过了 shell 层；画布组件 `DesignerPlugin` 收的也是内部对象。第三方插件拿不到这些。
- 想换掉内置部分，靠的是专门的配置开关：`disableDefaultSettingPanel`、`disableDefaultSetters`（`engine-options.ts`），或注册同名插件加 `override: true`。

## 4. 物料与设置器：按描述选渲染器

### 组件描述（metadata）

每个组件有一份描述（`packages/types/src/shell/type/component-metadata.ts`，协议见 `docs/docs/specs/material-spec.md`）：`componentName`、`title`、`icon`、`npm`（包名、导出名）、`props`（属性的名字和类型，入料工具从源码扫出来）、`configure`（编辑体验：`props` 面板配置、`component` 能力如是否容器、`supports`、`advanced`）、`snippets`（从组件面板拖出来时插入的 schema 片段，可以有多个）、`group`、`category`、`priority`。

`props` 和 `configure.props` 分两层：前者是"组件有什么属性"（机器扫出来的事实），后者是"属性面板怎么画"（人写的编辑体验）。`configure.props` 可以 `isExtends` 继承前者再按 `override` 覆盖（`editor-skeleton/src/transducers/parse-props.ts`）。

### 设置器的注册和选择

- 设置器是一个 React 组件，收 `value`、`onChange`、`field`（当前属性的模型）等 props（`docs/docs/guide/expand/editor/setter.md`）。
- 注册：`setters.registerSetter(名字, 组件或 { component, defaultProps?, title?, condition?, initialValue?, recommend?, isDynamic? })`，按名字存进一个 Map（`packages/editor-core/src/di/setter.ts`）。同名后注册的覆盖先注册的，没有提示。
- 选择分三层（`components/settings/settings-pane.tsx` 的 `setterInfo`、`transducers/parse-props.ts` 的 `propTypeToSetter`）：
  1. 属性配置里**显式写了** `setter`：字符串按名字查表；`{ componentName, props, initialValue }` 带参数；**数组**则包成 `MixedSetter`，让用户在几个设置器之间切换。
  2. 没写，就**按属性类型**给默认值：`string→StringSetter`、`number→NumberSetter`、`bool→BoolSetter`、`oneOf` 选项 ≥4 个用 `SelectSetter` 否则 `RadioGroupSetter`、`shape/object→ObjectSetter`、`arrayOf→ArraySetter`（元素类型递归）、`func→FunctionSetter`、`node/element→SlotSetter`、`oneOfType→MixedSetter`（每个分支递归）。
  3. 都不匹配：`MixedSetter`，什么都不预设。
- `MixedSetter` 在多个候选里挑哪个，用每个设置器注册时的 `condition(field)`（"for MixedSetter to check this setter if available"）。
- 引擎还会在选择结果上再改一道：开了 `supportVariableGlobally` 时，把所有设置器都包成 `[原设置器, 'VariableSetter']` 的 `MixedSetter`。
- 找不到注册名时，`createSetterContent` 直接返回 `null`，那一行属性就是空的。
- 组件描述在用之前还会过一条**元数据转换管道**：`material.registerMetadataTransducer(fn, level, id)`，按 `level` 排序执行（内置三个：解析函数、props 转设置器、追加"是否渲染""循环"等通用配置项）。插件可以借此统一给所有组件加或删配置项。

## 5. 渲染与隔离

### 渲染器

`packages/renderer-core` 按 schema（`componentName` + `props` + `children`）找组件、创建元素。找不到组件时渲染 `NotFoundComponent`；渲染抛错时渲染 `FaultComponent`（红框加"组件渲染异常，请查看控制台日志"），二者都能由使用方替换，`faultComponentMap` 还能按组件名分别指定（`renderer/renderer.tsx`、`renderer/base.tsx`）。每个物料组件都被 `hoc/index.tsx` 打补丁：改写原型上的 `componentDidCatch` 和 `render`，出错时渲染 `FaultComponent`——即**按单个组件**兜底，不是整页。

### 画布为什么放 iframe

设计器和渲染器在两个 frame 里（`docs/docs/guide/design/editor.md`"画布渲染"）。官方给的理由两条：给渲染器"更纯净的运行环境，更贴近生产环境"；扩展性，让使用方按接口换自己的渲染器（React、以前的 Rax，甚至 G6 做的关系图画布，见 `guide/design/renderer.md`）。**没有提安全隔离，实现上也不隔离**：

- iframe 没有 `src`、没有 `sandbox` 属性（`builtin-simulator/host-view.tsx`），内容由父页面 `document.write` 写进去（`create-simulator.ts`），和编辑器同源。
- 父页面直接把对象挂到 iframe 的 `window` 上：`win.LCSimulatorHost = host`（整个 host 对象，能访问设计器所有模块）、`win.AliLowCodeEngine = 一个插件 ctx`、`win._ = window._`。
- React 不在 iframe 里加载第二份，默认环境就是一段内联脚本 `window.React=parent.React; window.ReactDOM=parent.ReactDOM;`，连 React DevTools 的全局钩子也从父页面借（`host.ts` 的 `defaultEnvironment`）。

### 宿主和 iframe 怎么通信

不是消息，是**直接调方法**。文档（`guide/design/editor.md`"通信机制"）：两边"通过各自的代理对象进行，不允许其他方式，避免代码耦合"。

- iframe 里的 `react-simulator-renderer` 从 `window.LCSimulatorHost` 拿到 host，调 host 取 schema、组件、设置；
- host 调 renderer 暴露的方法：`getClientRects`、`getClosestNodeInstance`、`findDOMNodes`、`getComponent`、`setNativeSelection`、`setDraggingState`、`setCopyState`、`clearState` 等，用来做选中框、悬停、拖拽占位；
- 快捷键、焦点追踪、剪贴板直接挂到 iframe 的 `contentWindow` / `contentDocument` 上（`host.ts` 的 `mountContentFrame` 末尾）。

这里的"代理对象"是代码组织上的边界，不是进程或源的边界。

## 6. 资源加载

### 资产包

使用方给引擎一份资产包 JSON（`material.setAssets`，协议见 `docs/docs/specs/assets-spec.md`，版本 1.1.0），顶层：`version`、`packages`（要加载的 JS/CSS）、`components`（组件描述）、`sort`（组件面板分组）、`plugins`、`setters`、`extConfig`。`packages[]` 的字段：

```json
{
  "package": "@alifd/next",        // npm 包名
  "version": "1.23.0",
  "library": "Next",                // UMD 挂在 window 上的全局名，引擎靠它拿组件
  "urls": ["…/next.min.css", "…/next-with-locales.min.js"],   // 运行态
  "editUrls": ["…"],                // 编辑态（优先于 urls）
  "deps": ["…"],                    // 依赖的其他 package
  "external": true,                 // 是否被别的包当 external 排除了
  "loadEnv": ["design", "runtime"],
  "async": false, "exportMode": "functionCall", "exportSourceLibrary": "…"
}
```

协议里每个字段分 A / AA / AAA 三级："A 引擎核心支持，AA 官方插件和设置器支持，AAA 只是参考，由上层平台实现"。`plugins`、`setters` 两节是 AAA：只有名字、标题、截图这类目录信息，引擎不会照它加载插件。

### 加载方式和共享依赖

- **只有 UMD + 全局变量**。引擎本身"仅支持 cdn 方式引入，npm 包用于提供 typings"（`packages/engine/README-zh_CN.md`）。使用方页面先按顺序放 React、ReactDOM、PropTypes、lodash、moment、Fusion Next、引擎、官方扩展的 `<script>`，自己的构建配 `externals: { react: 'var window.React', … }`（`docs/docs/guide/create/useEditor.md`）。引擎自己的 UMD 构建也是同一组 externals（`packages/engine/build.umd.json`）。
- **React 只有一份**，靠的就是所有东西都从 `window.React` 取；iframe 里也从 `parent.React` 取。版本由使用方页面决定，插件和物料无法声明自己要哪个版本。
- iframe 里的加载分五级（`packages/types/src/assets.ts` 的 `AssetLevel`）：环境（React 等）→ 基础库 → 主题 → 运行时（simulator renderer）→ 业务组件，`create-simulator.ts` 按级拼出 `<link>` 和 `<script>` 写进 iframe。物料包的 `library` 名由 host 的 `buildLibrary` 记下，渲染时按包名到 `window[library]` 上取组件。
- **远程组件描述**：`components` 里带 `url` + `exportName` 的项，编辑器在主页面用 `AssetLoader` 加载脚本，再从 `window[exportName]` 读描述；按 `exportName` 和 `npm.version` 缓存（`packages/editor-core/src/editor.ts` 的 `setAssets`）。
- **插件不在资产包里加载**：插件是使用方代码里 `import` 进来、`plugins.register` 的。调试时有个 `@alilc/lowcode-plugin-inject` 插件，在线上页面加 `?debug` 就能把本地启动的插件 / 设置器 / 物料注入进去（`docs/docs/guide/expand/editor/cli.md`）。

## 7. 其他扩展点

- **事件总线**（`packages/shell/src/api/event.ts`）：`on / prependListener / off / emit`，`on` 返回解绑函数。`emit('x')` 实际发出 `<eventPrefix>:x`；`on` 必须写带冒号的完整名字，否则告警并忽略。前缀默认 `common`，所以没设 `eventPrefix` 的插件全挤在一个命名空间。
- **快捷键**（`api/hotkey.ts`）：`hotkey.bind(combos, callback, action?)`，返回解绑函数；会同时挂到画布 iframe 上。
- **命令**（`packages/editor-core/src/command.ts`、`shell/src/api/command.ts`，`plugin-command` 包里是节点和历史操作的内置命令）：`registerCommand({ name, description, parameters: [{ name, propType, description, defaultValue }], handler })`，注册名是 `commandScope:name`，没有 `commandScope` 直接抛错；`executeCommand` 先用 `propType` 校验参数再执行；`batchExecuteCommand`、`listCommands`、`onCommandError`。参数带类型和描述，看得出是想让外部（包括程序）按名字调用。shell 层还声明了一个"同一 scope 只能被一个插件用"的集合 `commandScopeSet`，但代码里只读不写，这条检查实际不生效。
- **i18n**（`packages/editor-core/src/intl/index.ts`）：界面上的标题、描述都可以是 `{ type: 'i18n', 'zh-CN': '…', 'en-US': '…' }`。渲染时按当前语言找，找不到依次退到 `en-US`、`zh-CN`；都没有显示 `##intl@<locale>##`。文案支持 ICU MessageFormat 参数。各包自带 `locale/zh-CN.json`、`en-US.json`。
- **配置**（`packages/editor-core/src/config.ts`）：`engineConfig` 是一个全局 KV，`get / set / has / onceGot / onGot`（等某个 key 被设置）。`init(container, options, pluginPreference)` 的 `options` 只在白名单 `VALID_ENGINE_OPTIONS` 里的键才接受——`enableStrictPluginMode` 默认就是 `true`，其他键告警丢弃；第三个参数是按插件名分组的偏好值，插件只能经 `ctx.preference` 读自己声明过的。
- **偏好声明**（`preferenceDeclaration`）：`{ title, properties: [{ key, type: 'string'|'number'|'boolean', description, default?, enum?, enumDescriptions?, useMultipleLineTextInput?, deprecationMessage? }] }`。类型注释说 `default` "只用于配置界面，不影响运行时"——设计意图是由引擎按声明生成插件的配置界面，但仓库里没有这个界面的实现。
- **错误与降级**：见第 3 节（骨架面板没有边界、属性行出错返回 `null`）和第 5 节（物料组件按单个兜底，`FaultComponent` 可替换）；插件 `init` 失败只记日志、不影响其他插件。

## 8. 公开承认的问题和后来的改动

- **shell 层**：插件拿到的不是内部对象，而是 `packages/shell` 里包了一层的类。内部对象存在 `Symbol` 键上（`shell/src/symbols.ts` 注释："以下 symbol 均用于在 shell 层对外暴露的模型中存储相应内部模型的 key"），对外只给公开方法；内部类型和公开类型分别叫 `IXxx` 和 `IPublicXxx`（`packages/types/src/shell/`）。目的是 API 稳定：内部可以重构，公开签名不动。文档的"API 设计约定"（`docs/docs/api/index.md`）：命名空间按变量 / 函数 / 事件组织；事件命名 `on[Will|Did]VerbNoun`，照搬 VS Code；绑定类函数都返回解绑函数；属性用 getter。
- **兼容包袱**：`common.editorCabin`、`designerCabin`、`objects` 是为兼容上一代引擎（vision）留下的，源码注释写"历史原因导致此处设计不合理，慎用。this load of crap will be removed in some future versions"（`shell/src/api/common.tsx`）；文档也说 `skeletonCabin / designerCabin` 这个命名"跟兼容上一个版本的引擎有关系"。
- **后门**：引擎导出 `__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED = { symbols, classes }`（`engine-core.ts`），拿着 symbol 就能从 shell 对象里取出内部对象。shell 是约定，不是隔离。内置插件和画布本身也直接用内部对象（第 3 节末）。
- **workspace 模式**（1.1.0 起，实验性，`packages/workspace`）：多个编辑窗口，每个窗口一套独立的 `editor`、`skeleton`、`setters`、插件管理器（`context/base-context.ts`）；插件分"注册在 workspace 层"和"注册在窗口层"（`ctx.registerLevel`，1.1.7 起）。资源类型可以声明成 `webview`：窗口里只放一个指向 URL 的 iframe（`inner-plugins/webview.tsx`，同样没有 `sandbox`）。shell 的 `Skeleton` 每次取内部对象时都要判断 workspace 是否激活、取哪个窗口的骨架，找不到就打"skeleton api 调用时机出现问题"——全局单例 API 后来要支持多实例时的补丁。
- **2.0 分支**（`feat/runtime-2.0`，未合并）：重写成 VS Code 的样子。`packages/engine-core` 里有 `extension`（`IFunctionExtension { id, version, metadata: { dependencies, engineVerison, preferenceConfigurations } }`、按依赖图初始化并检测循环依赖）、全局 `Registry`（按扩展点 id 存贡献，注释照抄 VS Code）、`configuration`（用 JSON Schema 声明配置）、`keybinding`、`command`、`workbench/widget`（`IWidget { id, content, action, target: LayoutParts, metadata: { title, icon, priority } }`，`LayoutParts` 是 `TopBar / SideBar / BottomBar / ActionBar / Main / AuxiliaryPanel`）。都是骨架：`WidgetRegistry.registerWidget` 只返回 id、不存，`Layout.registerPart` 是空函数。方向上是从"插件在代码里调 `skeleton.add`"走向"扩展点注册表 + 声明式贡献 + JSON Schema 配置"。

## 9. 对 Atrium 的启示

先说差别。低代码引擎的插件跑在编辑器页面里，什么都能碰；界面是"搭建器"，插件主要加面板；它的 iframe 是为了干净的运行环境，不是为了安全。Atrium 是对话界面，插件逻辑在 pi 进程里、视图在界面里，宿主只转发；视图要能在 PWA 里跑；安全底线是受信任视图和宿主 token 同在应用源里。下面每条都按这个前提判断。

### 借鉴

1. **骨架固定，挂载点由核心定义，插件不能新增**（挂载点）。低代码引擎十个区域写死在 `Workbench` 里，插件只能往里放。Atrium 的挂载点（工具步骤内联、自定义消息、右栏，以后的查看标签、状态栏、输入框上方）也应该是核心的一张固定清单，每个挂载点的外壳（标题栏、折叠、图标列、拖动宽度）由核心画，插件只画内容。这样外观一致，也能统一加错误边界和降级。
2. **挂载点分"互斥"和"并列"两类，形态由类型决定**（挂载点）。低代码的 `PanelDock`（图标 + 面板，同时只开一个）正好是 Atrium 右栏要的形态；状态栏、顶栏是并列的一排，用 `index` 排序、`align` 分左右。Atrium 不必照搬五种 widget 类型，但每个挂载点要说清楚是互斥还是并列、排序按什么。
3. **按描述选渲染器，分三层**（数据渲染）。设置器的选择顺序"显式指定 → 按数据类型给默认 → 通用兜底"直接对应 Atrium：工具步骤先找声明了这个工具名的视图，再按结果数据的类型找（例如 `details` 里声明了 `kind: "diff"` 的走 diff 视图），最后是通用工具行；代码块按语言找渲染器，找不到显示原文。只用精确的键匹配，不学 `condition(field)` 这种函数判断——判断函数要先加载插件代码才能执行，挡住了"不加载代码就知道谁来渲染"。
4. **插件拿到的是窄的、版本化的 API，不是内部对象**（视图 API、版本兼容）。shell 层的价值是让内部能重构而公开签名不变，`@atrium/plugin-kit` 的类型就该扮演这个角色：视图收到的是 kit 里定义的 props（工具参数、结果、运行状态、当前分支上的快照）和少数 hook，不是界面内部的 store 或 WebSocket 客户端。但要记住低代码自己证明了的一点：**同源里的包装层不是安全边界**（它有 `__SECRET_INTERNALS…` 后门，内置插件也直接拿内部对象）。Atrium 受信任视图照样能摸到 token，安全只能靠沙箱档的独立源 iframe。
5. **一切按插件名加命名空间，保留核心前缀**（manifest、视图 API）。事件的 `eventPrefix`、命令的 `commandScope`、保留前缀列表都是为了不撞名。Atrium 里视图注册的东西（挂载项 id、命令、偏好 key、日志里的来源）都用 `<包名>/<id>`，`atrium` 前缀留给核心。
6. **绑定类调用都返回解绑函数**（视图 API）。低代码统一用 Disposable，Atrium 视图 API 里的订阅、快捷键、通道监听照做，配合项目已有的"不留悬空订阅"和泄漏测试。
7. **文案用多语言对象，界面按当前语言取**（manifest、i18n）。manifest 里给挂载项的标题、描述写 `{ "zh-CN": "…", "en-US": "…" }`，界面按语言取、按固定顺序回退。这符合"宿主不产出给用户看的文字"：宿主只转发 manifest，翻译在界面侧。缺失时别学它显示 `##intl@…##`，回退到另一种语言或插件名。
8. **偏好先声明后使用，只认声明过的键**（manifest、设置）。`preferenceDeclaration` 的形状（key、类型、描述、默认值、枚举）可以直接放进 `package.json` 的 `atrium` 字段，设置页按声明画一个通用分区，不用加载插件代码；插件只能读到自己声明过的键。低代码只声明了、没做出配置界面，Atrium 要做完。
9. **2.0 分支的方向**（manifest）：他们从"在代码里调 `skeleton.add`"往"扩展点注册表 + 声明式贡献 + JSON Schema 配置"走，和 Atrium 已定的 manifest 声明视图一致，算是旁证。

### 改了再用

1. **版本检查：不满足就降级，不抛错**（版本兼容）。低代码 `engines.lowcodeEngine` 不满足时注册直接失败。Atrium 的 `atrium.api` 不兼容时，插件的工具照样在 pi 里跑，界面对它的工具显示通用工具行，并发一个带插件名和版本的错误码让界面提示用户。检查放在界面侧（它知道自己支持哪些 API 版本），宿主只转发 manifest。
2. **注册从命令式改成 manifest 声明 + 代码导出**（manifest、加载）。低代码的挂载全在 `init()` 里调 `skeleton.add`，不运行插件就不知道它要占哪些位置。Atrium 在 `atrium.views` 里声明每个视图挂在哪、对应哪个工具名或数据类型；ESM 只导出组件。好处：界面不加载代码就能排版和降级；可以等用户第一次展开时才加载；PWA 冷启动不必下载所有插件。
3. **插件注册的东西归插件，卸载时自动回收**（生命周期）。低代码给面板打上了 `pluginName` 却从不使用，`destroy` 后面板还在。Atrium 用声明式注册后这条容易做：插件被停用、升级或加载失败时，按包名清掉它的所有挂载项和订阅。
4. **每个挂载项一个错误边界，出错显示降级而不是消失**（降级）。低代码的骨架面板没有错误边界，属性行出错直接返回 `null`、只写日志。Atrium：工具步骤出错回到通用工具行，面板出错显示"这个插件的视图出错"加重新加载，同时上报错误码（不带对话内容）。物料渲染器"按单个组件兜底、兜底组件可替换"的思路可以用，但兜底组件由核心提供，不让插件换。
5. **共享依赖只有一份，但用 ESM + import map，并写明版本范围**（加载）。低代码靠 `window.React` 共享一份 React，插件不能声明版本，升级 React 就是赌。Atrium 已定 import map，再补一条：kit 的构建预设把 React 和视图 API 的版本范围写进产物元数据，界面加载前核对。沙箱档的 iframe 是另一个源，**借不到父页面的 React**（低代码那句 `window.React=parent.React` 只在同源下成立），沙箱视图要自带依赖或只用 postMessage 协议。
6. **替换内置渲染要显式**（挂载点）。低代码替换内置部分要么靠 `override: true`、要么靠专门的 `disableDefault…` 开关，同名覆盖设置器则是悄悄的。Atrium 里第三方插件给 `bash`、`edit` 这类内置工具提供视图时，不能静默顶掉内置的：manifest 里声明"可替换内置的哪个"，冲突时界面让用户在设置里选，默认用内置。
7. **调试注入**（工具链）。`?debug` 把本地开发的插件注入线上页面，这个体验值得给 `atrium-plugin dev`：开发服务器起来后，正在运行的 Atrium 直接加载本地构建的视图并热替换。但只在开发模式开放，不能变成"任意 URL 都能往应用源里注代码"。

### 不借鉴

1. **同源 iframe + 直接调对象当隔离**（隔离）。低代码的画布 iframe 无 `sandbox`、`document.write` 写入、`window.LCSimulatorHost` 直接给对象，只是代码组织。Atrium 的沙箱档按已定的独立源 + postMessage + JSON-RPC 做，不留直接对象引用。
2. **UMD + 全局变量 + 手写 `<script>` 顺序**（加载）。PWA 和 CSP（脚本只允许本应用）下也行不通。
3. **全局可写的配置 KV 和注入钩子**（视图 API）。`engineConfig` 任何插件都能 `set`，`enhancePluginContextHook`、`customPluginTransducer` 能改写别人的上下文和插件本身。视图不应该能改核心配置或别的插件。
4. **跨插件改写配置的转换器**（挂载点）。`registerConfigTransducer` 让一个插件改所有面板的配置，结果取决于注册顺序，出问题难查。面板宽度、顺序这类偏好由 Atrium 自己记在用户设置里。
5. **视图之间的依赖、`exports` 和全局事件总线**（视图 API）。低代码插件间靠 `ctx.plugins.X.y` 和 `common:` 总线互相调用。Atrium 视图之间第一版不通信；需要共享状态的，逻辑在 pi extension 里（pi 自己有 `pi.events`），视图从会话快照和通道里读。等有真实需求再设计。
6. **资产包里的插件目录**（分发）。分发已经交给 pi package（ADR-0003），不需要另一份目录协议。
7. **schema 驱动的界面、snippets、元数据转换管道**。这是搭建器的核心，Atrium 的视图是插件自己写的 React 组件，不由 JSON 生成。

## 10. 把 Atrium 现有界面迁成内置插件

用户在考虑让现有界面元素也由插件实现。低代码引擎正是这么做的（第 3 节末），它的经验和教训：

### 它是怎么分的

- **内核**：布局（`Workbench` 和十个区域）、widget 类、模型（文档、选区、历史）、插件管理器、事件 / 命令 / 配置服务、渲染器。
- **内置插件**：画布（作为 `mainArea` 的一个 Widget）、属性面板、大纲树、默认设置器、快捷键、右键菜单、元数据转换器。
- **第三方插件**：组件库面板、页面管理、数据源、代码编辑……使用方按需注册。
- 内置和第三方用同一个 `plugins.register`、同一种 `ctx`。

### 对 Atrium 的映射

| 留在核心（骨架） | 适合做成内置插件 |
|---|---|
| 窗口框架、会话列表、消息流的容器和滚动、输入框本身、会话树 | 各工具的步骤渲染（bash、read、edit、write、grep 等） |
| 右栏容器（图标列、面板切换、宽度）、查看标签栏容器、状态栏容器、设置页框架 | 回复里代码块的按语言渲染（Mermaid、PlantUML、JSON/CSV 查看等） |
| 插件加载、版本检查、错误边界和降级、沙箱 iframe 组件 | 右栏的各个面板（改动、以后的上下文检查器等） |
| 通用工具行、通用代码块（降级的终点） | 查看标签里的各种查看器、状态栏的各项、设置页的各分区 |

判断标准：**能用"挂载点 + 数据"描述清楚的放内置插件；挂载点本身、降级终点、和 pi 会话生命周期绑死的留在核心**。低代码把画布也做成 Widget，但它是靠拿内部对象的工厂注册的，等于挂着插件名的内核代码，插件化没带来替换能力。Atrium 的消息流和输入框同理，不要为了"一切皆插件"去拆。

### 可借鉴的做法

1. **内置插件只许用公开的视图 API**。低代码的 `componentMetaParser(designer)`、`defaultPanelRegistry(editor)` 直接拿内部对象，说明公开 API 不够时内置插件会走后门，后门一旦存在，公开 API 就永远补不齐。Atrium 用依赖规则守住：内置插件所在目录只能 import `@atrium/plugin-kit`（和 overview.md 现有的依赖方向规则一样由检查工具拦）。内置插件缺的能力，要么加进 kit，要么说明它属于核心。
2. **迁移就是 API 的验收**。每迁一个内置部分，都在检验挂载点和视图 API 够不够用；这和路线图"先写死 todo 插件再抽接口"一致。建议顺序：先迁工具步骤（挂载点最明确，有现成的通用工具行当降级），再迁代码块渲染（按语言选渲染器，正好验证第 9 节"按描述选渲染器"），然后是右栏面板、状态栏、查看标签，设置分区最后（要先有偏好声明）。
3. **内置和第三方只差来源和信任，不差接口**。内置视图随应用打包、静态 import、属于受信任档；第三方从 pi package 里按 import map 加载。注册表是同一张，形状相同。有一处 Atrium 特有：pi 自带的工具没有 pi package，内置的工具视图是"只有视图、没有 extension"的插件，所以内部注册的形状要允许没有逻辑那一半。
4. **内置的也要走错误边界和降级**，并且有测试覆盖"内置视图抛错 → 显示通用工具行"。低代码的内置面板出错没有兜底。
5. **替换规则一开始就定**。内置部分一旦是插件，用户自然会想用别的插件换掉（更好的 diff 视图）。低代码靠零散的 `disableDefault…` 开关和 `override`。Atrium 按挂载键统一处理：同一个键有多个候选时默认内置，设置里可选，见第 9 节"改了再用"第 6 条。
6. **按会话实例化，不用全局单例**。低代码的 API 起初是全局单例，后来做多窗口时只能在 shell 里每次判断"现在是哪个窗口的骨架"。Atrium 有多个会话和子对话，视图实例和它的状态要从一开始就挂在"哪个会话、哪个分支、哪次工具调用"上，不放模块级变量。
