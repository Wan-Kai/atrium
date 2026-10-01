# Atrium

> pi 的深度宿主：把 agent 的内部机制变成看得见、可操作的界面。

Atrium 是一个**看得见内部、能随手改的编码 agent 桌面端**，形态类似 Codex 桌面端。先做给自己日常写代码用，以后开源。

日常用法是这样一个循环：

```
用它写代码
   → 发现 agent 表现不对（上下文乱了、工具乱调、忘了约定）
   → 打开检查器，看清这一轮到底发生了什么
   → 写一个 extension 修掉它（以后由 agent 自己写）
   → extension 自带的视图直接出现在界面上
```

它同时是一个**以练代学**的项目：通过做一个每天真正在用的东西，去理解 agent 的底层机制——agent loop、上下文管理、工具调度、扩展系统。

## 定位

[Paseo](https://github.com/getpaseo/paseo) 这类宿主追求横向连接更多 agent；Atrium 追求纵向把一个 agent 做透。

Atrium 以 [pi](https://github.com/earendil-works/pi) 为唯一内核，优先做只有深入 agent loop 才能实现的界面：

- **会话树**：分支导航、分叉、对比，插件状态跟随分支切换
- **上下文检查器**：每轮实际发给模型的内容、token 分布、压缩时机
- **loop devtools**：实时查看钩子事件流
- **工具调用拦截**：执行前查看、修改、拒绝参数
- **extension 自带视图**：插件的界面由宿主自动渲染

详见 [ADR-0004](docs/adr/0004-deep-pi-host-positioning.md)。

## 核心想法

- **以 pi 为内核**：通过 pi 的 RPC 模式接入，agent loop、会话、工具由 pi 负责，Atrium 负责桌面体验。
- **插件即 pi package**：一个 Atrium 插件 = pi extension（逻辑）+ 桌面视图（渲染），打包在同一个 pi package 里，直接借助 pi 的生态安装和分享。
- **agent 能扩展自己的 app**：长期目标是提一句需求（比如"给我一个 todo 面板"），由 agent 生成插件并挂到桌面端。
- **留一道缝**：桌面端只依赖 Atrium 自己的事件模型，不直接依赖 pi 的类型，将来可以接入其他 harness。

## 状态

早期规划阶段，还没有代码。

## 文档

从 [docs/README.md](docs/README.md) 开始：

- [架构设计](docs/architecture/)：分层、事件模型、插件模型
- [架构决策记录](docs/adr/)：为什么这样设计
- [需求与技术方案](docs/specs/)：每个功能的方案
- [路线图](docs/roadmap.md)：分阶段计划与原则
- [调研与学习笔记](docs/research/)：pi 学习资料、同类项目调研

## License

[MIT](LICENSE)
