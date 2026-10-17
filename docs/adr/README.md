# 架构决策记录（ADR）

每份 ADR 记录一个影响长远、难以撤回的决策：当时的背景、选了什么、放弃了什么、带来什么后果。

## 规则

- **只追加，不修改**。决策被推翻时，写一份新 ADR，并把旧 ADR 的状态改为"已取代"，注明被哪份取代。这是唯一允许对旧 ADR 做的修改。
- **一份 ADR 一个决策**。
- 新建时复制 [template.md](template.md)，编号取下一个。

## 状态

| 状态 | 含义 |
|---|---|
| 提议 | 待讨论 |
| 已接受 | 当前生效 |
| 已废弃 | 不再适用，且没有替代决策 |
| 已取代 | 被新的 ADR 取代 |

## 索引

| 编号 | 标题 | 状态 | 日期 |
|---|---|---|---|
| [0001](0001-use-pi-as-core.md) | 以 pi 作为唯一内核，不做多 harness 抽象 | 已接受 | 2026-09-29 |
| [0002](0002-connect-pi-via-rpc-subprocess.md) | 通过 RPC 子进程接入 pi | 已接受 | 2026-09-29 |
| [0003](0003-plugin-as-pi-package.md) | 插件以 pi package 形式组织和分发 | 已接受 | 2026-09-29 |
| [0004](0004-deep-pi-host-positioning.md) | 定位为 pi 的深度宿主，纵向做透而非横向连接 | 已接受 | 2026-09-29 |
| [0005](0005-split-host-and-ui-pwa-first.md) | 宿主与 UI 分离、经 WebSocket 通信，手机端先走 PWA | 已接受 | 2026-09-29 |
| [0006](0006-organize-sessions-by-workspace.md) | 以工作区组织会话，工作区与目录一一对应 | 已接受（第 4 条被 0007 取代） | 2026-10-02 |
| [0007](0007-each-chat-is-its-own-container.md) | 每个对话是一个独立的容器 | 已接受（浏览器标签页的设想被 0009 取代） | 2026-10-12 |
| [0008](0008-atrium-own-pi-extension-for-fast.md) | 用 Atrium 自带的 pi 扩展实现 Fast | 已接受 | 2026-10-12 |
| [0009](0009-browser-stays-external.md) | 浏览器操作放在外部浏览器，定制功能做成浏览器插件 | 已接受 | 2026-10-12 |
| [0010](0010-plan-usage-through-atrium-extension.md) | 套餐用量经 Atrium 自带的 pi 扩展查询 | 已接受（第 1、3 条被 0011 取代） | 2026-10-15 |
| [0011](0011-plan-overview-all-subscriptions.md) | 套餐总览：经任一会话的 pi 查所有订阅，Grok 的用量接口是唯一的例外地址 | 已接受 | 2026-10-16 |
| [0012](0012-claude-usage-from-replies-and-openai-mapping.md) | Claude 的用量也从回复的响应头读，经 claude-bridge 和 pi 新的 ChatGPT 登录的会话算到对应的订阅 | 已接受 | 2026-10-17 |
| [0013](0013-agent-channel-status-and-hidden-command.md) | 扩展与宿主有来有回的通道用"状态加隐藏命令" | 已接受 | 2026-10-17 |
