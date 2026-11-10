# 对话里的交互演示：Codex 的 Visualize 怎么做

2026-11-05 调研，为 [SPEC-0007](../specs/0007-inline-visuals.md) 和学习模式（[SPEC-0008](../specs/0008-study-mode.md)）定方案。

## 来源

- 本机 ChatGPT 桌面版自带的 Codex 插件 `visualize@openai-bundled` 1.0.74：`~/.codex/plugins/cache/openai-bundled/visualize/1.0.74/`，看了 `skills/visualize/SKILL.md`（给模型的规则）、`scripts/render.py`（导出成独立网页时用的外壳和 CSP）、`assets/standalone-host-bridge.js`（片段和宿主之间的桥）。插件是专有的，这里只记做法，不抄原文。
- [ChatGPT Visualizations 文档](https://learn.chatgpt.com/docs/visualizations)：只讲用法和支持范围（网页版、桌面版预览中；Codex CLI 和 IDE 扩展不渲染）。
- [openai/codex #37913](https://github.com/openai/codex/issues/37913)：确认文件放在 `~/.codex/visualizations/<年>/<月>/<日>/<会话>/<名字>.html`，回复里是一条内容引用。

## Codex 的做法

### 产出

- 模型写一个 **HTML 片段**（不带 `<!doctype>`、`<html>`、`<head>`、`<body>`），存成文件，放在会话专用的目录里。小于 1 MB；不许 `fetch`、XHR、WebSocket。
- 回复里单独一行写内容引用 `visualize{"path":"<绝对路径>"}`，宿主在这个位置内联显示。可选 `"mode":"wide"`（最宽 1 024px）和 `title`。
- 改演示是在原文件上改，再在这一轮的回复里重新放一次引用。
- 规则要求片段只放可视化本身，解释写在片段外面的正文里。

### 沙箱

- iframe 只给 `sandbox="allow-scripts"`，没有 `allow-same-origin`；`referrerpolicy="no-referrer"`。
- CSP：`default-src 'none'`；脚本 `'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'` 加白名单；样式 `'unsafe-inline'` 加白名单；图片、字体、媒体只许白名单；`worker-src blob:`；`connect-src blob: data:`（不能联网）；`frame-src`、`object-src`、`base-uri`、`form-action` 都是 `'none'`。
- 导出的独立网页用 `srcdoc`，所以外层壳的 CSP 要比里面宽（`frame-src 'self'`）。

### 能从哪加载

- CDN 白名单：`cdnjs.cloudflare.com`、`cdn.jsdelivr.net`、`esm.sh`、`unpkg.com`，字体 `fonts.googleapis.com`、`fonts.gstatic.com`、`fonts.bunny.net`。白名单外的会被拦下，不报错。
- 宿主自己的组件（日历、火焰图、请求瀑布、调用栈）放在 `persistent.oaistatic.com/plugins/visualize/` 下，固定版本。
- 规则里点名固定版本，比如图表用 `d3@7.9.0`，地图用固定的数据源。
- Atrium 的做法（MV1 实测后，2026-11-06）：只许写死完整版本的地址；esm.sh 给的模块按依赖声明的范围引依赖（`/d3-array@3?target=es2022`），会被拦下，所以系统提示让模型在 esm.sh 上加 `?bundle`，依赖打进同一个文件（见 SPEC-0007"沙箱"）。

### 宿主提供的运行环境

- 主题变量（`--background`、`--foreground`、`--muted`、`--primary`、`--border` 等，图表系列 `--viz-series-1`～`6`），规则禁止写死颜色；深浅色由宿主切换。
- 一套基础样式类（`.card`、`.btn`、表单、标签页、表格、tooltip），规则要求直接用、不改样式。
- 图标用宿主提供的 lucide，禁止自己画或从网络加载图标。
- 高度：片段用 `ResizeObserver` 量 body，通过 `MessagePort` 报给宿主，宿主设 iframe 高度，上限 10 000px，超过就让 iframe 自己滚动。

### 回传

- `window.openai.sendFollowUpMessage({ prompt, title })`：替用户发一条消息开新的一轮。**只有在用户刚点过的时候才发**（检查 `navigator.userActivation.isActive`），宿主会弹确认框，`title` 是确认框标题。
- `window.openai.setWidgetState({ modelContent, privateContent })`：存演示状态，最多 16 KiB；`modelContent` 尽量交给模型但不保证，保存不触发新的一轮。演示重新打开时从 `widgetState` 恢复。
- `openExternal({ href })`：同样要用户刚点过。

### 什么时候用

规则里写：静态结构用 Mermaid，要表格给 Markdown 表格；动态、空间运动、可调参数的才写 HTML；只在明显讲得更清楚时才做；正文里不提"我做了一个可视化"之类的实现细节。

## 对 Atrium 的结论（2026-11-05 用户定）

| 项 | Atrium 的做法 | 和 Codex 的差别 |
|---|---|---|
| 产出 | 片段文件 + 回复里一行引用，宿主内联显示 | 一样；文件位置由会话所在的容器决定（学习方向是 `visuals/`） |
| 沙箱 | 自定义协议给每个演示独立的源，只给 `allow-scripts`，CSP 从 `default-src 'none'` 起，不能联网 | 不用 `srcdoc`（会继承外层 CSP，见 [plugin-model.md](../architecture/plugin-model.md)）；先不开 `'unsafe-eval'` |
| 库 | **走 CDN 白名单**，照 Codex 的那几个 | 一样。代价：没网时打不开，见 SPEC-0007 待定问题 |
| 运行环境 | 主题变量从 [design-language.md](../architecture/design-language.md) 的 token 映射；基础样式类；图标给 Hugeicons；高度上报 | 图标用 Hugeicons（项目规定），不用 lucide |
| 回传 | 用户刚点过才发；**直接发，不弹确认框**；消息标"来自演示" | Codex 弹确认框 |
| 演示状态 | 第一版不做 | Codex 有 `widgetState` |
| 范围 | **做成通用能力**，所有会话都能用，学习模式先用起来 | 一样（Codex 也是通用的） |
