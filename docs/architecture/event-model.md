# 事件模型

> 2026-10-07 改写。早期草案（`turn_started`、`interrupt` 等）已被取代，不再保留。

Atrium 协议是 UI 和宿主之间的唯一契约，经 WebSocket 传输（[ADR-0005](../adr/0005-split-host-and-ui-pwa-first.md)）。

- **准绳**：`packages/protocol` 里的 zod 定义，两端共用，收到的每条消息都做运行时校验。
- **概览与规则**：[SPEC-0001 · 接口与数据](../specs/0001-mvp1-single-session-chat.md#接口与数据)：信封、应答、握手与心跳、事件的序号、追踪、订阅、背压、附件，以及命令和事件的总表。
- **命令落到哪个类、事件从哪来**：[领域模型 §8](domain-model.md#8-协议与类的对应)。
- **pi 的 RPC 事件怎么翻译成 Atrium 的事件**：[pi-internals.md](../research/pi-internals.md) §3 和宿主的 EventTranslator。

这里不再另列命令和事件，避免和 zod 定义、SPEC 出现两份不一致的清单。
