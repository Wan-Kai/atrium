# 事件模型

> 状态：草案。先覆盖基础对话，权限确认、模式切换等以后再加。

Atrium 事件是桌面端和 harness 适配器之间的唯一契约。

## 命令（桌面端 → harness）

| 命令 | 说明 |
|---|---|
| `prompt(text, attachments?)` | 发起一轮对话 |
| `interrupt()` | 中断当前 turn |
| `close()` | 结束会话，释放进程 |

## 事件（harness → 桌面端）

| 事件 | 说明 |
|---|---|
| `turn_started` | 一轮开始 |
| `text_delta` | 回复文本增量 |
| `reasoning_delta` | 推理内容增量 |
| `tool_started` | 工具开始执行（名称、参数） |
| `tool_finished` | 工具执行结束，携带结构化 `details`，供插件视图渲染 |
| `turn_settled` | agent 不会再自动继续 |
| `error` | 错误 |

## 参照

- Paseo 的 `AgentSession` 接口（`startTurn` / `subscribe` / `interrupt` / `close`）
- pi 的 [RPC 协议](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
