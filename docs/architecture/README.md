# 架构设计

描述 Atrium **当前**的整体设计。这里的内容应当和实现保持一致：实现变了，文档跟着改。

| 文档 | 内容 |
|---|---|
| [overview.md](overview.md) | 整体分层、进程模型、数据归属 |
| [domain-model.md](domain-model.md) | 领域对象与类关系：项目、工作区、会话、运行、派生状态、宿主组件 |
| [event-model.md](event-model.md) | 早期协议草案，已被 SPEC-0001 取代，待协议定稿后重写 |
| [plugin-model.md](plugin-model.md) | 插件的组成、打包、状态与约束 |
| [design-language.md](design-language.md) | 颜色、字体、圆角、图标、点阵、动效与组件要点 |

为什么这样设计，见 [ADR](../adr/)。
