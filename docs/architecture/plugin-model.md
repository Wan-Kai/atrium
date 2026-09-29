# 插件模型

> 状态：初步设想。计划先写死一个 todo 插件，再从中抽出接口（见 [路线图](../roadmap.md)）。

## 组成

一个 Atrium 插件分两半，打包在同一个 pi package 里（理由见 [ADR-0003](../adr/0003-plugin-as-pi-package.md)）：

- **逻辑**：一个 pi extension，负责注册工具、处理钩子、产出结构化数据（tool result 的 `details` 或自定义 entry）。
- **视图**：一个 React DOM 组件，由 UI 加载，按插件名或数据类型注册渲染器，负责把数据画出来。

```json
{
  "name": "@ktoon/atrium-todo",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./extension/index.ts"] },
  "atrium": { "views": ["./view/index.tsx"] }
}
```

pi 忽略 `atrium` 字段，桌面端读取它来加载视图。安装和分享直接用 pi 的机制（`pi install`、package gallery）。

## 约束

- **UI 不能依赖 `ctx.ui.custom()`**：RPC 模式只转发对话框和通知，不转发自定义终端组件。extension 只产出数据，渲染交给桌面端。
- **状态跟随会话分支**：状态放在 tool result 的 `details` 里，在 `session_start` / `session_tree` 时沿 `ctx.sessionManager.getBranch()` 重建（参考 pi 官方 `examples/extensions/todo.ts`）。
- **生命周期**：工厂函数里不启动进程和定时器，在 `session_start` 启动、在 `session_shutdown` 幂等清理。
- **依赖**：`@earendil-works/pi-*` 和 `typebox` 放进 `peerDependencies`（`"*"`），不要打包。
- **手机端**：视图基于 React DOM，在 PWA 里直接可用。将来若做原生 App，视图通过 WebView 加载，或由插件声明不支持手机端（见 [ADR-0005](../adr/0005-split-host-and-ui-pwa-first.md)）。

## 安全

extension 跑在 pi 进程里，拥有和 pi 相同的系统权限。第三方插件安装前要看源码；开放分享前，需要重新评估沙箱和权限声明。
