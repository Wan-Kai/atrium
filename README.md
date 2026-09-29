# Atrium

> 一个以 [pi](https://github.com/earendil-works/pi) 为内核、可自扩展的个人 agent 桌面端。

Atrium 是我为自己的工作和生活搭建的 agent 平台，形态类似 Codex 桌面端。

它同时是一个**以练代学**的项目：通过做一个每天真正在用的东西，去理解 agent 的底层机制——agent loop、上下文管理、工具调度、扩展系统。

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
