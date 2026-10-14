# Atrium

> 以 [pi](https://github.com/earendil-works/pi) 为内核的 macOS 编码 agent 桌面端：先把每天写代码这件事做顺手，再把 agent 的内部机制变成看得见、能操作的界面。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/workbench-dark.png">
  <img alt="Atrium 的工作台：左边是项目和工作区，中间是对话和 agent 的过程，右边是这次的改动" src="docs/images/workbench-light.png">
</picture>

Atrium 的形态和 Codex 桌面端差不多：左边是项目和工作区，中间和 agent 对话，右边看文件和改动。不一样的地方在于它只接一个 agent，也就是 pi，并且打算往深里做：会话树、上下文检查器、工具调用拦截这些只有吃透 agent loop 才做得出来的界面，是它后面要做的事。

现在先做给自己日常写代码用，以后开源。

## 现在能做什么

**对话与过程**

- 流式显示回复，Markdown、代码块（Shiki 上色）、表格都按阅读排版
- agent 读了什么、改了什么、跑了什么命令，按步骤排成一条过程轨道，运行中展开，结束后折进这一轮的标题；每一步都能点开看详情和 diff
- 运行中可以排队下一条消息、插话、停止；pi 要你确认或回答时弹出对话框卡片；出错有错误卡片和"重试"
- 输入框里 `@` 引用文件、`/` 用命令，能粘贴、拖入图片，长文本粘贴后折叠；草稿按会话保留

**项目、工作区与会话**

- 一个项目下的每个 git worktree 是一个工作区，侧栏标出未提交、领先几个提交、是否已合并进主干
- 新建工作区时直接写第一条消息，模型按这条消息给分支起名，再建 worktree、开会话
- 多个会话并行跑，标签栏 ⌘1–9 切换；需要你的会话进收件箱
- 会话可以交给终端里的 pi 接着做，做完再接回来；终端里 pi 的历史会话也能在"历史"里找到、打开
- 会话自动起标题；不用的 worktree 可以归档（删目录、留分支），之后再恢复

**改动与文件**

- 右栏"文件""更改"两个标签：浏览工作区的文件树，看未提交或相对主干的改动
- 点开文件或改动，在对话区的标签页里看完整内容和 diff，几万行的 diff 也能顺畅滚动

<img alt="在对话区的标签页里看 src/api.ts 的改动" src="docs/images/changes-light.png">

**模型与状态**

- 模型和推理强度按会话选，记住每个模型上次的强度；支持的 Codex 模型可以开 Fast
- 状态栏显示轮数和步数、输出速度、token 用量、缓存命中、上下文占用，悬停看明细
- 首次启动引导装 pi、登录模型提供方、添加项目；设置里管外观、模型与账户、主干分支、网络代理、pi 的更新

<img alt="新建工作区：写下第一条消息，自动起分支名，基于 origin/main 新建 worktree" src="docs/images/new-workspace-light.png">

> 截图里的项目和模型回复都是演示数据，由端到端测试用的 faux 模型生成。

## 定位

[Paseo](https://github.com/getpaseo/paseo) 这类宿主追求横向连接更多 agent；Atrium 追求纵向把一个 agent 做透。

Atrium 以 pi 为唯一内核，接下来优先做只有深入 agent loop 才能实现的界面（规划中，见[路线图](docs/roadmap.md)）：

- **会话树**：分支导航、分叉、对比，插件状态跟随分支切换
- **上下文检查器**：每轮实际发给模型的内容、token 分布、压缩时机
- **loop devtools**：实时查看钩子事件流
- **工具调用拦截**：执行前查看、修改、拒绝参数
- **extension 自带视图**：插件的界面由宿主自动渲染

日常用法设想成这样一个循环：

```
用它写代码
   → 发现 agent 表现不对（上下文乱了、工具乱调、忘了约定）
   → 打开检查器，看清这一轮到底发生了什么
   → 写一个 extension 修掉它（以后由 agent 自己写）
   → extension 自带的视图直接出现在界面上
```

它同时是一个**以练代学**的项目：通过做一个每天真正在用的东西，去理解 agent 的底层机制，包括 agent loop、上下文管理、工具调度和扩展系统。详见 [ADR-0004](docs/adr/0004-deep-pi-host-positioning.md)。

## 核心想法

- **以 pi 为内核**：通过 pi 的 RPC 模式接入，agent loop、会话、工具、登录凭据都由 pi 负责，Atrium 负责桌面体验。会话就是 pi 的会话文件，终端和桌面端可以来回接着用。
- **插件即 pi package**：一个 Atrium 插件 = pi extension（逻辑）+ 桌面视图（渲染），打包在同一个 pi package 里，直接借助 pi 的生态安装和分享。
- **agent 能扩展自己的 app**：长期目标是提一句需求（比如"给我一个 todo 面板"），由 agent 生成插件并挂到桌面端。
- **留一道缝**：界面只依赖 Atrium 自己的协议和事件模型，不直接依赖 pi 的类型，将来可以接入其他 harness。

## 状态

MVP 1（v0.1，"替代 Codex 做日常编码"）的功能已经做完，正在自用阶段（[M1.11](docs/roadmap.md#m111-自用)）。只支持 macOS 13 及以上，还没有发布安装包，需要从源码构建。

## 从源码运行

需要 Node.js ≥ 22.19、pnpm 12.9.1、git ≥ 2.38。pi 没装的话，首次启动会引导安装。

```sh
pnpm install
pnpm dev        # 开发模式，界面热更新
pnpm package    # 打包成本机用的 Atrium.app（ad-hoc 签名，不公证）
```

打包出的应用在 `apps/desktop/out/Atrium-darwin-<架构>/Atrium.app`，拷进"应用程序"即可。更多命令和测试见 [开发环境与流程](docs/development.md)。

## 文档

从 [docs/README.md](docs/README.md) 开始：

- [路线图](docs/roadmap.md)：分阶段计划、当前状态与原则
- [需求与技术方案](docs/specs/)：每个功能的方案，MVP 1 见 [SPEC-0001](docs/specs/0001-mvp1-single-session-chat.md)
- [架构设计](docs/architecture/)：分层、领域模型、视觉规范、编码与测试规范
- [架构决策记录](docs/adr/)：为什么这样设计
- [调研与学习笔记](docs/research/)：pi 学习资料、同类项目调研

## License

[MIT](LICENSE)
