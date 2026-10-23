# pi 与 DeepSeek Harness：设计思路和插件开发的差异 {#pi-vs-dsh}

两者分歧在于**谁是核心**。pi 本身就是固定的 agent loop，扩展只在节点上介入；DSH 没有特权核心，loop、会话日志和界面都能换成别的插件。

- pi 一个进程跑一个会话，界面在进程外；DSH 一个常驻进程装下所有会话和宿主逻辑。[](source:pi-ext)[](source:dsh-arch)
- pi 会话文件是条目树，扩展只能追加；DSH 会话日志是类型化事件流，插件能声明新事件。[](source:pi-int)[](source:dsh-session)
- pi 的扩展没有界面通道，宿主要自己接；DSH 的插件一个包两半，界面插槽和远程方法都现成。[](source:dsh-note)
- 所以在 pi 上做插件，是"往别人的引擎上装配件"；在 DSH 上做插件，是"拼装整台引擎"。

@answer scope="pi 1.3.0（本机）· DSH 687f282（0.2.1-rc.2）· 2026-10-23 · 读源码和文档整理，未实测 DSH"
@meta locale=zh-CN
@source pi-ext title="pi extension 的能力边界" path=docs/research/pi-extension-capabilities.md
@source pi-int title="pi 内部机制笔记" path=docs/research/pi-internals.md
@source adr2 title="ADR-0002：经 RPC 子进程接 pi" path=docs/adr/0002-connect-pi-via-rpc-subprocess.md
@source dsh-note title="DeepSeek Harness 客户端插件调研" path=docs/research/deepseek-harness-plugins.md
@source dsh-arch title="DSH architecture.md" url=https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md
@source dsh-session title="DSH 会话子系统" url=https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/subsystems/session.md
@source dsh-web title="DSH Web 客户端子系统" url=https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/subsystems/web-client.md
@source dsh-proj title="DSH 会话投影" url=https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/subsystems/session-projection.md

## 两者的设计思路差在哪？ {#philosophy}

| 方面 | pi | DeepSeek Harness |
| --- | --- | --- |
| 核心理念 | 极简内核，扩展在节点上介入 | 没有特权核心，一切皆插件 {good:可替换} |
| 谁拥有 agent loop | pi 自己，结构改不了 {caution:固定} | loop 本身是一个插件 |
| 扩展点的形态 | 事件钩子：拿到数据、返回改写 | 服务注入加事件；拦截类事件要调 `next()` 交给下一个 |
| 产品形态 | 一个 CLI，多种运行模式 | 按配置拼装：Web、无界面、SDK、ACP |
| 界面 | 只有终端界面能扩展 | 浏览器客户端，100 个插槽 |
| 成熟度 | 1.x，迭代快 | 开发者预览 0.2，会有破坏性变更 {caution:不稳定} |

pi 把"agent 怎么跑"定死，换来的是简单、好嵌入；DSH 把"agent 怎么跑"也交给插件，换来的是整机可换，代价是组装和调试成本。[](source:dsh-arch)

## pi 加 Atrium 是什么形状？ {#pi-shape}

@architecture id=pi-stack title="pi 体系：Atrium 作为宿主"
| ui | Atrium 界面 | frontend |
| host | Atrium 宿主 | backend |
| pi | pi 进程（每会话一个） | backend |
| ext | 扩展（钩子） | backend |
| file | 会话 JSONL 条目树 | database |
| ui > host | WebSocket 协议 | emphasis |
| host > pi | RPC：stdin/stdout | emphasis |
| pi > ext | 节点上的钩子 |
| pi > file | 追加条目 |
| ext > host | setStatus 借道 | dashed |

pi 的 RPC 只转发对话框和单向通知，扩展没有自定义消息可用。Atrium 和扩展来回通信，靠 `setStatus` 加隐藏命令搭成。[](source:pi-ext) 每个会话一个进程，一个会话出问题不波及别的会话。[](source:adr2)

## DeepSeek Harness 是什么形状？ {#dsh-shape}

@architecture id=dsh-stack title="DSH 体系：一棵插件树"
| client | 客户端插件树（插槽） | frontend |
| gateway | 远程网关 | backend |
| host | 宿主插件树（Cordis） | backend |
| loop | agent-loop 插件 | backend |
| log | 会话事件日志 | database |
| client > gateway | Remote 方法和流 | emphasis |
| gateway > host | 调服务 | emphasis |
| host > loop | 驱动所有会话 |
| loop > log | 提交事件 |
| log > client | follow 流和投影 | dashed |

宿主和浏览器跑同一套 Cordis：插件提供服务、事件和可回滚的副作用，卸载时一并撤销。[](source:dsh-arch) 浏览器侧有自己的插件树和插槽，界面经网关调宿主的服务。[](source:dsh-web)

## 运行时逐项比较 {#runtime}

| 方面 | pi | DeepSeek Harness |
| --- | --- | --- |
| 进程 | 一个会话一个进程；终端、RPC、SDK 等模式 | 一个常驻宿主进程装下所有会话 |
| 会话数据 | JSONL 条目树，有分支；扩展只能追加自定义条目和消息 | 带序号的类型化事件日志；插件用声明合并加事件类型 |
| 派生状态 | 扩展自己在 `session_start` 时沿分支重建 | 宿主注册纯函数投影，框架折叠，客户端拿成品 {good:现成} |
| 能力注册 | `registerTool`、`registerCommand`、`on(事件)` | `provide` / `inject` 服务，按 agent 的作用域注册 |
| 生命周期 | 工厂函数加 `session_start` / `session_shutdown` | 副作用随插件卸载自动撤销，激活顺序由服务依赖决定 |
| 可替换的底层 | 服务商可替换 | 文件系统、子进程、沙箱都能换提供者 {good:全可换} |
| 空闲 | 宿主决定；Atrium 空闲 30 分钟停 pi | 没找到自动挂起；冷会话按需自动恢复 |
| 隔离 | 进程隔离会话，扩展和 pi 同权限 | 不隔离，一个插件卡住波及全部 {bad:无隔离} |
| 热重载 | 终端里有 `/reload`，RPC 里没有 | 按插件粒度热重载，丢组件状态 |
| 分发 | pi package，`pi install` | bundle 加配置补丁，按 profile 叠加；插件页和市场 |

DSH 的空闲行为是读源码没找到挂起机制，不是确认没有。[](source:dsh-note)

## 做同一个插件，两边有多不同？ {#todo}

以 todo 为例：模型调工具更新清单，界面显示清单，用户在界面上勾掉一项。

| 要做的事 | 在 pi（加 Atrium） | 在 DSH |
| --- | --- | --- |
| 注册工具 | 扩展里 `registerTool` | 宿主插件注册工具 |
| 存状态 | 写进工具结果的 `details` 或自定义条目 | 声明一种会话事件，写进日志 |
| 切分支后的状态 | 扩展按 `getBranch()` 重建；界面取分支上最后一条 | 投影按事件折叠，分叉时框架处理 |
| 显示 | 依赖宿主（Atrium）提供挂载点和视图 API | 插件自带浏览器半边，往插槽注册组件 {good:自带} |
| 界面回传 | 宿主代发隐藏命令给扩展 | 界面调插件自己的远程方法 |
| 实时进度 | `setStatus` 借道，限频 | 远程流或投影推送 |
| 跨会话汇总 | 做不到，扩展只活在一个会话里 {bad:做不到} | 在根上下文提供全宿主一份的服务 |
| 脱离宿主 | 终端 pi 里照样能用，只是没有视图 {good:可用} | 离不开 DSH |

## 做插件时各自卡在哪？ {#tradeoffs}

| 维度 | pi 体系 | DSH 体系 |
| --- | --- | --- |
| 上手难度 | 低：一个文件、几个钩子 {good:简单} | 高：先学 Cordis、服务注入、插槽、生成契约 {caution:陡} |
| 能做多深 | 只能在 loop 节点上介入，不能改结构 | loop、会话日志、界面都能换 {good:深} |
| 界面 | 要宿主另做一整套 | 现成插槽，但启动全有或全无 |
| 数据通道 | 窄：条目、`setStatus`、对话框 | 宽：事件、投影、远程方法和流 |
| 出错影响 | 局限在一个会话进程 | 可能拖垮整个宿主 |
| 被内置界面限制 | 只能放进宿主留的挂载点 | 任何插件都能盖掉内置界面 {caution:易误盖} |
| 版本风险 | pi 升级可能改钩子行为 | 开发者预览，接口会变 |

pi 的问题是"够不着"：通道窄、界面靠宿主、跨会话做不到。DSH 的问题是"管不住"：什么都能换，隔离和稳定靠约定。

## 对 Atrium 意味着什么？ {#atrium}

@callout level=note title="Atrium 站在 pi 这一边，补的是 pi 缺的那一半"
Atrium 的插件系统，本质上是在 pi 外面补上 DSH 原生就有的界面插槽、状态投影和回传通道。
补的方式受 pi 的边界约束：插件逻辑仍在 pi 进程里，宿主只转发，所以跨会话和高吞吐这两块补不全。
从 DSH 能借的是形状，不是机制：插槽的基数和降级、投影"客户端拿成品"、按数据语义恢复连接。

- [ ] 接受"pi 体系做不到跨会话"，需要时再开放受控的宿主能力 API。
- [ ] 插件状态在扩展一侧折叠成快照，对应 DSH 的投影。
- [ ] 不追求 DSH 式的"一切皆插件"，骨架留在核心。
