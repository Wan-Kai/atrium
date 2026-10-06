# 架构设计

描述 Atrium **当前**的整体设计。这里的内容应当和实现保持一致：实现变了，文档跟着改。

| 文档 | 内容 |
|---|---|
| [overview.md](overview.md) | 整体分层、进程模型、数据归属 |
| [domain-model.md](domain-model.md) | 领域对象与类关系：项目、工作区、会话、运行、派生状态、宿主组件 |
| [event-model.md](event-model.md) | 协议文档的入口：准绳在 `packages/protocol`，概览在 SPEC-0001"接口与数据" |
| [plugin-model.md](plugin-model.md) | 插件的组成、打包、状态与约束 |
| [design-language.md](design-language.md) | 颜色、字体、圆角、图标、点阵、动效与组件要点 |
| [testing.md](testing.md) | 测试分层、工具、让测试有效和覆盖全面的规则、性能与泄漏、代码检查与格式化 |
| [coding-standards.md](coding-standards.md) | 语言、JSDoc、命名、错误、异步与取消、类型、多语言、无障碍、依赖 |
| [security.md](security.md) | 威胁模型、WebSocket 鉴权、Electron、渲染内容、凭据与日志、子进程与文件 |
| [observability.md](observability.md) | 日志格式、链路追踪（trace id）、脱敏 |

为什么这样设计，见 [ADR](../adr/)。
