# ADR-0001：以 pi 作为唯一内核，不做多 harness 抽象

- **状态**：已接受
- **日期**：2026-09-29

## 背景

Atrium 要做成可自扩展的 agent 桌面端，需要一个 harness 负责 agent loop、会话和工具。项目目标是以练代学、日常自用，维护者只有一人。

## 决策

以 [pi](https://github.com/earendil-works/pi) 作为唯一内核。桌面插件就是 pi 插件，插件可以直接使用 pi 的全部 loop 钩子。

## 备选方案

| | A：双层抽象（类似 Paseo） | B：基于 pi（采用） |
|---|---|---|
| 做法 | 底层适配多个 harness，顶层基于抽象设计插件 | pi 作为唯一内核 |
| 插件能力 | 只有公共子集：MCP 注入工具 + 观察事件 | 整个 agent loop：`context`、`tool_call`、分支状态、续跑 |
| 工作量 | 每个 harness 一个适配器 + 抽象层 | 只接 pi |
| 学习收获 | 偏集成与抽象设计 | 偏 agent 内部机制 |
| 分享 | 分发、安装、版本自建 | pi package 现成 |
| 风险 | 抽象过早，公共子集很薄 | 绑定 pi，pi 迭代快 |

## 后果

- 正面：插件能力强，工作量小，学习路径贴合目标，分享机制现成。
- 负面：绑定 pi 的演进节奏；不能直接使用 Codex、Claude Code 这些 harness 本身。模型订阅不受影响，比如 pi 支持用 ChatGPT Plus/Pro 订阅登录使用 Codex 模型（2026-09-29 更正）。
- 缓解：桌面端只依赖自有事件模型（见 [事件模型](../architecture/event-model.md)），保留接入其他 harness 的可能。
- 重新评估：确实需要接入 Codex / Claude Code / DeepSeek Harness 时。
