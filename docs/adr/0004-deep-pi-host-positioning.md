# ADR-0004：定位为 pi 的深度宿主，纵向做透而非横向连接

- **状态**：已接受
- **日期**：2026-09-29
- **相关**：[ADR-0001](0001-use-pi-as-core.md)、[ADR-0003](0003-plugin-as-pi-package.md)、[调研笔记](../research/references.md)

## 背景

调研发现 [Paseo](https://github.com/getpaseo/paseo) 已经提供了完整的宿主层插件系统（界面扩展 + daemon 侧 RPC + agent 生命周期钩子），并且支持 pi。"可定制的 agent 桌面端"这个形态已有成熟项目，Atrium 需要明确自己的方向。

Paseo 的插件在宿主层工作，碰不到 agent loop 内部。它对 pi extension 的渲染支持，是核心代码里写死的一张适配器白名单。

讨论过的方向：

1. 改用 DeepSeek Harness 作为底层，避开与 Paseo 的重叠。
2. 继续基于 pi，深度结合 pi extension，做出宿主层方案做不到的界面。

## 决策

采用方向 2。Atrium 定位为 **pi 的专属宿主：把 agent 的内部机制变成看得见、可操作的界面**。

- Paseo 追求横向连接更多 agent；Atrium 追求纵向把一个 agent 做透。
- 优先做只有深入 pi 内部才能实现的功能：
  - **会话树**：分支导航、分叉、对比，插件状态跟随分支切换
  - **上下文检查器**：每轮实际发给模型的内容、token 分布、压缩时机，可钉住或丢弃
  - **loop devtools**：实时钩子事件流，类似 React DevTools 之于 React
  - **工具调用拦截**：执行前查看、修改、拒绝参数
  - **extension 自带视图**：宿主按约定自动渲染（ADR-0003），不依赖白名单
- DeepSeek Harness 作为参照物：研究它如何把 loop 和 UI 统一进同一个插件系统（Cordis），借鉴到 Atrium 的插件模型，不作为底座。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| 以 DeepSeek Harness 为底层 | 插件系统天然统一 loop 与 UI，贴合自扩展愿景 | developer preview，会有破坏性变更；自带 Web UI，重叠对象只是从 Paseo 换成 DSH；学到的偏 Cordis 范式而非 agent 通用机制 |
| 基于 pi 深度结合（采用） | 差异化来自深度而非回避；每个功能都在拆解 agent，贴合以练代学；pi 极简、文档和生态成熟 | 绑定 pi；深度功能依赖 pi 内部接口，需跟进其演进 |
| 直接用 Paseo 当外壳 | 省掉桌面端，自带移动端 | 两套插件格式要自己拼接；放弃宿主层的设计与学习 |

## 后果

- 正面：定位清晰，与 Paseo 形成互补而非竞争；功能路线与学习路线重合。
- 负面：深度功能对 pi 的内部接口依赖更强，pi 升级时适配成本更高。
- 缓解：深度功能尽量通过 pi extension 的公开钩子实现，桌面端仍只依赖 Atrium 事件模型。
- 重新评估：DeepSeek Harness 稳定后，可写桥接插件做横向对比。
