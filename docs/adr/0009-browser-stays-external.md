# ADR-0009：浏览器操作放在外部浏览器，定制功能做成浏览器插件

- **状态**：已接受
- **日期**：2026-10-12
- **相关**：[ADR-0005](0005-split-host-and-ui-pwa-first.md)、[ADR-0007](0007-each-chat-is-its-own-container.md)、[SPEC-0001](../specs/0001-mvp1-single-session-chat.md)"非目标""侧栏 · 对话"、[security.md](../architecture/security.md)、[路线图](../roadmap.md)"以后再说"

## 背景

路线图原先把"内嵌浏览器面板"列在以后：用 Electron 内嵌浏览器，作为工具提供给 agent，替代 v0.1 的 MCP 方案；ADR-0007 也设想以后浏览器页面作为对话里的标签页。

自用（M1.11）时日常已经在用 ego lite：一个给人和 agent 共用的 Chromium 浏览器，agent 经 `ego-browser` 命令操作（task space 隔开 agent 的标签、页面快照带元素引用、可见的 agent 光标、交还控制权给用户），用的是用户自己的登录状态和插件。它的 skill 装在 `~/.agents/skills`，pi 已经能读到。

内嵌浏览器的代价（2026-10-12 讨论时梳理）：

- `WebContentsView` 是盖在页面上的原生视图，界面的弹层、菜单、设置面板压不住它，要截图顶替或临时隐藏。
- Electron 读不到用户浏览器的登录状态，插件也只支持一部分（装不了应用商店的插件，没有工具栏和 popup）。
- 宿主是独立进程（ADR-0005），agent 的工具要经 pi extension → 宿主 → Electron 主进程转到 `webContents.debugger`，多一条要鉴权的通道。

## 决策

**Atrium 不内置浏览器。agent 的浏览器操作都在外部浏览器里做，默认是 ego lite；需要定制的功能做成自己的浏览器插件。**

1. **通用操作用 ego lite**：打开页面、点击、填表、截图、读页面，pi 按 ego-browser skill 调 `ego-browser` 命令。Atrium 不包一层自己的浏览器工具，ego lite 改了接口由它的 skill 跟着改。想用 Chrome 时，照旧在 pi 的 `mcp.json` 里配置 chrome-devtools 或 Playwright 的 MCP server。
2. **对话和工作区里不放浏览器标签页**：ADR-0007 里"以后浏览器页面也作为对话里的标签页"的设想不再成立，ADR-0007 的其余决定不变。
3. **插件只做 ego lite 做不到的、或和 Atrium 相关的事**，例如把当前页面或选中的内容送进会话、在页面上标出 agent 正在操作的标签。不做第二套通用的自动化接口。只用标准的 `chrome.*` API，在任何 Chromium 浏览器里都能装。自用中真遇到这样的需求时才开工。
4. **插件开工时按这些规则做**，细节到时写进 security.md：
   - 插件主动连宿主的 WebSocket。manifest 里写死 `key`，插件 id 固定；宿主把 `chrome-extension://<id>` 加进 Origin 白名单，第一次连接时用 Atrium 显示的配对码换 token，存在 `chrome.storage`。
   - 宿主只发有名字的命令和参数，插件不执行宿主发来的代码（也是应用商店"不执行远程代码"的要求）。
   - 只操作"Atrium"标签组里的标签，用户的标签拖进组里才能动；操作中的标签要有明显标记；付款、改密码等敏感网站先等用户确认。
   - 平时用 `chrome.scripting`，要真实的键盘鼠标输入时才短暂连上 `chrome.debugger`（连着时浏览器顶部会有提示条）。
   - 自用时用开发者模式加载未打包的插件；给别人用时以"不公开"方式上架 Chrome 应用商店。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| Electron `WebContentsView` 内嵌面板，agent 经 `webContents.debugger` 操作 | 浏览器就在 Atrium 里，能作为对话的标签页 | 弹层压不住原生视图；没有用户的登录和插件；要多一条 pi → 宿主 → 主进程的通道；浏览器的存储、隔离、安全都要自己管 |
| 内嵌 + 外部两种后端，对 agent 是同一套工具 | 两边的好处都有 | 要做两遍，还要维护一层抽象；现在没有非内嵌不可的需求 |
| 只用 MCP（chrome-devtools、Playwright） | 不用新做 | 没有 task space、交还控制权这类人和 agent 协作的体验；定制功能无处放 |
| 外部浏览器 ego lite + 自己的插件（采用） | Atrium 不碰浏览器；用户的登录和插件现成；协作体验来自 ego lite；定制功能走标准插件 API | 依赖 ego lite 的命令接口；Atrium 里看不到浏览器 |

## 后果

- 正面：Atrium 不用处理原生视图遮挡、浏览器存储和隔离；手机 PWA 接进来时，agent 照样操作 Mac 上的浏览器；插件和 ego lite 分工清楚，不会长出两套自动化接口。
- 负面 / 代价：
  - 用户要另装 ego lite（或配置 MCP），首次启动不管这件事。
  - 在 Atrium 里看不到 agent 在浏览器里做什么，要切到 ego lite 看。以后可以在会话里显示"正在 ego lite 中操作"并能跳过去，不在本 ADR 范围。
  - 插件能操控用户已登录的所有网站，宿主多一个高权限的客户端，鉴权和标签组的限制必须在开工时一起做。
- 什么情况下应重新评估：ego lite 停止维护或接口不再适合 agent；需要在 Atrium 里直接看页面（例如本地开发页面的预览）成了日常需求；公司管理的浏览器禁用了插件或 `debugger`。
