# SPEC-0007：对话里的交互演示

- **状态**：评审中
- **创建**：2026-11-05
- **更新**：2026-11-05（用户定：演示内联在消息流里；演示里点的回答直接发出、不弹确认；库走 CDN 白名单；做成所有会话都能用的通用能力；CDN 只许写死版本的路径；同时加载不设上限；样式不设清单；Hugeicons 只放常用的；焦点在演示里时按键归演示）
- **相关**：[SPEC-0008 学习模式](0008-study-mode.md)（第一个用它的地方）、[plugin-model.md · HTML 设计稿](../architecture/plugin-model.md#待做的插件html-设计稿)（同一个沙箱底座）、[security.md](../architecture/security.md)、[design-language.md](../architecture/design-language.md)、调研 [inline-visuals.md](../research/inline-visuals.md)（Codex Visualize 的做法）、原型 `prototypes/study-mode-visuals-prototype.html`

## 背景与目标

有些东西光靠文字和静态图讲不清：有先后、有状态变化、能调条件对比的，比如两个事务交错执行、请求怎么过中间件、算法一步步怎么走。现在 Atrium 的回复能渲染 Markdown、代码、Mermaid 和公式，但不能跑模型写的 HTML（security.md：回复里的原始 HTML 一律不执行）。

Codex 的 Visualize 插件做了这件事：模型写一个 HTML 片段存成文件，回复里放一行引用，宿主在那个位置把它放进沙箱 iframe 内联显示，片段里的按钮还能替用户发一条消息。

目标：所有会话都能让 agent 在回复里内联显示一个可交互的演示；演示跑在沙箱里，碰不到宿主和对话；演示里你点的回答能直接交给 agent。学习模式先用起来。

## 非目标

- HTML 设计稿的标注、版本回退、分享（plugin-model.md 里那个插件；它以后复用这里的沙箱）。
- 演示状态的保存和恢复（Codex 的 `widgetState`），第一版每次打开从头开始。
- 演示联网取数据、调用接口。
- 图片生成。
- 手机端渲染演示（手机端只显示一张"在电脑上查看"的卡片，见"手机端"）。
- 演示放在右栏或单开标签（原型里对比过，2026-11-05 用户选了内联）。
- 把 CDN 上的库缓存到本地供离线打开（2026-11-05 用户定不做）。

## 需求

1. 当 agent 讲一个有动态过程的概念时，我希望它在回复里放一个能一步步点、能切换条件的演示，而不是只给我一段文字。
2. 当我在演示里点了一个回答，我希望它直接作为我的消息发给 agent，agent 接着讲。
3. 当 agent 改了演示，我希望对话里看到的是改过的版本。
4. 我希望演示跟着 Atrium 的深浅色和字体走，看起来是 Atrium 的一部分。
5. 我希望演示就算被提示注入写坏了，也读不到我的对话、文件和凭据，发不出网络请求，也不能自己替我发消息。
6. 以后复习时，我希望还能打开当时的演示。

## 方案设计

### 一个演示 = 一个文件 + 回复里的一个引用

- agent 把演示写成一个 **HTML 片段**文件（不带 `<!doctype>`、`<html>`、`<head>`、`<body>`），放在宿主给的目录里：
  - 学习方向的会话：方向目录下的 `visuals/`（SPEC-0008）。
  - 其他会话：`~/.atrium/visuals/<会话 id>/`，不放进工作区，免得弄脏仓库（plugin-model.md"文件放哪"）。
- 回复里在要显示的位置放一个代码块，语言是 `visual`，内容是一行 JSON：

  ````text
  ```visual
  {"path":"visuals/2-03-isolation.html"}
  ```
  ````

  `path` 是相对会话工作目录的路径，或者宿主给的目录下的绝对路径。用代码块而不是 Codex 那样的裸行：Streamdown 本来就按语言分派代码块（Mermaid 也是这样），不认识这个语言的地方（旧版本、导出的记录）会原样显示成一段代码，不会变成乱码。
- 改演示：agent 用普通的编辑工具在原文件上改，再在这一轮的回复里放一次引用。对话里**所有指向这个文件的卡片都显示最新内容**，文件变了就重新加载（plugin-model.md"实时刷新"）。
- 宿主只认这两类目录下的 `.html` 文件；路径越界、文件不存在、超过 1 MB，卡片显示错误码对应的提示，不加载。

### 怎么让 agent 知道

Atrium 自带的 pi 扩展（ADR-0008）在系统提示里加一段英文说明（同其他 Atrium 工具的写法）：

- 演示目录在哪（扩展按会话所在的容器算出来）。
- 片段的规矩：不用 `fetch`、XHR、WebSocket；根元素给唯一 id；小于 1 MB；只能从 CDN 白名单加载库，地址里必须写死完整版本号（不写的会被拦）；建议用宿主给的颜色变量，这样深浅色会跟着变，但不强制；样式自己写。
- 什么时候用：有先后或状态变化、要调条件对比的才做；静态结构用 Mermaid，表格用 Markdown 表格；正文里不提"我写了一个 HTML"之类的实现细节。
- 回传的写法（见下文"回传"）。

具体到某个容器的规则（比如学习模式"每节最多一个演示""最多一个先猜的问题"）写在容器自己的 AGENTS.md 里，不放进通用说明。

### 沙箱

照 plugin-model.md"沙箱视图由核心提供"的要求做成核心组件，HTML 设计稿以后也用它：

- **独立的源**：Electron 注册一个自定义协议（暂名 `atrium-visual:`），每个演示一个路径；宿主读文件，套上外壳（见"运行环境"），和 CSP 头一起返回。不用 `srcdoc`（会继承父页面的 CSP）。
- iframe `sandbox="allow-scripts"`，不给 `allow-same-origin`、`allow-popups`、`allow-forms`、`allow-top-navigation`；`referrerpolicy="no-referrer"`；拒绝权限请求（摄像头、麦克风、定位……）。
- CSP（照 Codex，先不开 `'unsafe-eval'`）：

  ```text
  default-src 'none';
  script-src 'unsafe-inline' <CDN 白名单> atrium-visual:;
  style-src 'unsafe-inline' <CDN 白名单> atrium-visual:;
  img-src data: blob: <CDN 白名单>;
  font-src data: <CDN 白名单> atrium-visual:;
  media-src data: blob:;
  worker-src blob:;
  connect-src 'none';
  frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
  ```

- **CDN 白名单**（2026-11-05 用户定，照 Codex）：`https://cdnjs.cloudflare.com`、`https://cdn.jsdelivr.net`、`https://esm.sh`、`https://unpkg.com`、`https://fonts.googleapis.com`、`https://fonts.gstatic.com`。**只许写死版本的路径**（2026-11-05 用户定）：CSP 管不到路径里的版本，所以演示用单独的 Electron session，宿主在 `webRequest.onBeforeRequest` 里按站点检查地址，不合规的拦下：
  - `cdn.jsdelivr.net`：`/npm/<包>@<x.y.z>/…`、`/gh/<用户>/<仓库>@<版本>/…`
  - `unpkg.com`：`/<包>@<x.y.z>/…`
  - `esm.sh`：路径里的包名带 `@<x.y.z>`（esm.sh 自己引的依赖也带版本，放行）
  - `cdnjs.cloudflare.com`：`/ajax/libs/<名字>/<x.y.z>/…`
  - 字体的两个站点不带版本，照放。
  - 拦下的请求在演示里就是加载失败；日志只记被拦的次数和站点，不记完整地址。
- **离开视口时卸载**，换成最后一次的截图；滚回来再加载（plugin-model.md）。视口里的演示同时加载几个**不设上限**（2026-11-05 用户定）。
- **截图怎么截**：演示完整在视口里、并且停下来 1 秒没有操作和高度变化时，宿主用 `webContents.capturePage(iframe 所在的矩形)` 截一张，只放内存、不写盘，每个演示只留最新一张。离开视口时换成这张图，大小不变；还没截到时显示一张同样高度的占位卡（演示的标题）。
- **高度**：片段的外壳用 `ResizeObserver` 量高度，经 postMessage 报给宿主，宿主设 iframe 高度，上限 10 000px，超过就让 iframe 自己滚动（同 Codex）。宽度跟消息流一样宽。

### 运行环境

宿主给每个片段套一个固定的外壳，片段只写内容：

- **颜色变量**：外壳提供一组颜色变量，从 design-language.md 的 token 映射，深浅色切换时宿主推一条消息，外壳换掉变量值。**不定清单、不强制用**（2026-11-05 用户定）：模型自己写样式，想跟着深浅色变就用这些变量。
- **字体和字号**跟 Atrium 一致。
- **图标**：外壳里带一份**常用的** Hugeicons（2026-11-05 用户定，不放全部；项目规定的界面图标，见 design-language.md），先从 Atrium 界面已经用到的图标里取，再补方向、播放、对错、加减这类演示常用的，名单放在代码里，系统提示列出可用的名字。片段用 `<i data-icon="名字">` 占位，外壳替换成 SVG；名单外的名字显示为空。不许自己画图标或从网络加载图标库。
- **键盘**：焦点在演示里时，按键归演示（2026-11-05 用户定）：Atrium 界面里的快捷键不响应；只有 macOS 菜单上的（⌘Q、⌘W、⌘,）照常。点演示外面焦点就回到 Atrium。
- **桥**：外壳在 `window.atrium` 上提供 `sendMessage(text)`（见"回传"），其他什么都没有。

### 回传

- 片段调用 `window.atrium.sendMessage(text)`：外壳先检查 `navigator.userActivation.isActive`（你刚在演示里点过），不是就丢掉；是就把文字经 postMessage 发给宿主。消息格式照 MCP Apps（SEP-1865）的 JSON-RPC（`ui/message`），以后同一个渲染器也能显示 MCP 服务器带的界面。
- 宿主收到后**直接发出**，不弹确认框（2026-11-05 用户定，Codex 会弹）：当作你在这个会话里发的一条消息，正在运行时按插话处理（同输入框）。
- 这条消息在记录里带来源：消息气泡前面有"来自演示"的标记（原型第 3 屏）。来源记在宿主的插话记录旁边（`turns/<会话 id>.json`），不改 pi 的消息内容。
- 限制：一条最多 4 000 字符；同一个演示两次发送至少隔 1 秒；超出的丢掉，日志只记次数，不记内容。
- 演示**不能**读对话、读文件、调工具、改输入框，也收不到 agent 的回复。

### 手机端

手机端（SPEC-0005）的消息流遇到 `visual` 代码块，显示一张卡片："演示 · <文件名>，在电脑上查看"。不渲染，第一版也不经 relay 传 HTML。

## 接口与数据

- **回复里的引用**：语言为 `visual` 的代码块，内容 `{"path": string, "title"?: string}`。
- **协议**：
  - 界面 → 宿主：`visual.resolve { sessionId, path }` → `{ url, size, mtime }` 或错误码（`visual.outside`、`visual.missing`、`visual.too_large`）。
  - 宿主 → 界面：`visual.changed { sessionId, path, mtime }`，宿主监视打开着的演示文件。
  - 界面 → 宿主：`visual.sendMessage { sessionId, path, text }`，宿主按插话或新一轮发出，并记来源。
- **自定义协议**：`atrium-visual://<令牌>/<文件名>`。令牌由宿主为每次 `resolve` 生成、只在当前运行内有效，对应会话和文件，iframe 里拿到的地址不能拿去读别的文件。
- **插话记录**：`turns/<会话 id>.json` 的每条用户消息可以多一个 `source: { kind: "visual", path }`（新增可选字段，不升版本）。
- **扩展**：系统提示里多一段演示说明，带演示目录的路径。

## 备选方案

- **引用写成裸行（Codex 的 `visualize{…}`）**：解析要另写一层，不认识它的地方会显示一行看不懂的文字。不用。
- **用工具调用（`show_visual`）而不是回复里的引用**：位置只能落在工具调用那里，没法放在一段话中间；模型改完文件还要再调一次。不用。
- **库由宿主内置、不走 CDN**：离线也能打开、只审一次，但能用的库少，模型容易去加载没内置的库。2026-11-05 用户定走 CDN。
- **放在右栏或单开标签**：原型乙、丙。用户选了内联。
- **点回答前弹确认框**：Codex 的做法。用户定直接发，靠"刚点过"的检查防止演示自己发消息。

## 风险与待定问题

- [x] **没网时打不开**：走 CDN 的演示离线会缺库。2026-11-05 用户定：不缓存，离线时演示里缺库的部分就是打不开。
- [x] **CDN 上的代码**：白名单里的地址谁都能发包。2026-11-05 用户定只许写死版本的路径（见"沙箱"）；剩下的风险是写死的那个版本本身有问题，它跑在沙箱里、不能联网、拿不到对话，接受。
- [x] 同时加载几个演示：不设上限（2026-11-05 用户定）。性能不够时再说。
- [x] 主题变量和样式类：不定清单，模型自己写（2026-11-05 用户定）。
- [x] Hugeicons：只放常用的（2026-11-05 用户定）。
- [x] 截图：完整可见并停 1 秒后用 `capturePage` 截 iframe 的矩形（用户让我定，见"沙箱"）。
- [x] 键盘冲突：演示优先（2026-11-05 用户定）。

## 实施计划

1. 自定义协议、外壳和 CSP：先用一个固定的片段跑通，测 CSP 拦得住联网、弹窗、跳转、读父页面。
2. 消息流里认 `visual` 代码块，`visual.resolve`、高度上报、深浅色切换、文件变了重新加载。
3. 回传：`sendMessage`、刚点过的检查、限速、来源标记。
4. 扩展的系统提示，拿真实模型试几次常见的概念。
5. 离开视口卸载、截图替换。
6. 手机端的占位卡片。

## 验证

- CSP 和沙箱：演示里尝试 `fetch`、`new WebSocket`、`window.open`、`top.location`、读 `parent.document`、加载白名单外的脚本、请求摄像头，全都失败（自动化测试）。
- 版本：`d3@7.9.0` 能加载；`d3`、`d3@7`、`d3@latest` 被拦（每个站点各测一条）。
- 焦点在演示里时按 Atrium 的快捷键不触发；点外面以后恢复。
- 回传：脚本自己调 `sendMessage` 被丢掉；真点了才发出；超长、太快的被丢掉；发出的消息带来源标记。
- 路径越界、文件不存在、太大，各显示对应提示。
- 改了文件，所有引用它的卡片都更新。
- 深浅色切换时演示跟着变。
- 自用：学习模式里几节课的演示，看模型写得出、用得上。
