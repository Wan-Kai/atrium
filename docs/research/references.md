# 参考资料

## pi

### 官方

- 仓库：[earendil-works/pi](https://github.com/earendil-works/pi)
- agent loop 源码：[`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)
- [Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) · [Packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) · [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) · [RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [extension 示例](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions)（60+ 个，含 `todo.ts`）
- [Pi package gallery](https://pi.dev/packages)

### 源码解析（建议阅读顺序）

1. [What I learned building an opinionated and minimal coding agent](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)：作者本人讲设计取舍
2. [Inside Pi Agent](https://edward40.com/p/pi-agent-internal/)：全景概览
3. 源码 + [pi 的设计艺术](https://zhanghandong.github.io/pi-book/ch02-packages.html)（张汉东，v0.66–v0.82）或 [etet2007/pi-agent-from-source](https://github.com/etet2007/pi-agent-from-source)（AI 生成，需对照源码核实）
4. [seyonv/pi-deep-dive](https://github.com/seyonv/pi-deep-dive)：42 条设计原则，链到源码行号
5. 专题：[Compaction Deep Dive](https://gist.github.com/sam-saffron-jarvis/8128d9838cc947c17c531f81c3619e1a)、[Build a Custom Agent Framework with PI](https://gist.github.com/dabit3/e97dbfe71298b1df4d36542aceb5f158)

pi 迭代很快，资料版本不一，对不上时以当前源码为准。

## 同类项目

### Paseo

[getpaseo/paseo](https://github.com/getpaseo/paseo)：daemon + 多端客户端（桌面、手机、Web、CLI），通过 WebSocket 通信。启动本机已安装、已登录的 CLI 作为子进程，各家走各自最原生的接口：

| Agent | 接入方式 |
|---|---|
| Claude Code | `@anthropic-ai/claude-agent-sdk`（底层启动 `claude` CLI） |
| Codex | 子进程 `codex app-server`，stdio JSON-RPC |
| OpenCode | `opencode serve` HTTP 服务 + `@opencode-ai/sdk` |
| pi | CLI 子进程，stdio JSONL RPC |
| Copilot / Cursor / Kimi 等 | ACP（`@agentclientprotocol/sdk`） |

值得看：`packages/server/src/server/agent/agent-sdk-types.ts`（统一的 `AgentClient` / `AgentSession` 接口）、`agent-sdk-capabilities.md`（各家 SDK 能力对比）。

**插件系统**（[quickstart](https://github.com/getpaseo/paseo/blob/main/public-docs/plugins/index.md) · [reference](https://github.com/getpaseo/paseo/blob/main/public-docs/plugins/reference.md) · [examples](https://github.com/getpaseo/paseo/tree/main/plugin-examples)）：

- 结构：`paseo-plugin.json` + `index.client.tsx`（React Native，跑在所有客户端）+ `index.server.ts`（daemon 子进程），两边通过 schema 校验的 RPC 通信；`client/`、`server/`、`shared/` 目录边界由编译器强制。
- 客户端贡献：侧边栏页面、工作区面板、Command Center、斜杠命令、composer pill、时间线条目改写与渲染、主题、设置页。
- 服务端钩子：`agent.turn_started` / `turn_ended`、权限请求；`before` 钩子可在创建 agent 时注入 MCP server、改 system prompt；可代答权限、turn 结束后续跑、追加时间线条目。
- 分发：本地目录、npm、git；有 update / reload / logs。插件为可信代码，无沙箱。
- **局限**：宿主层工作，碰不到 loop 内部（上下文改写、tool call 拦截、分支状态）。
- **与 pi extension 的关系**：两套独立系统。Paseo 在 `providers/pi/extensions/` 里为一批热门 pi extension（官方 todo 示例、rpiv-todo、subagents、ask-user、mcp-adapter）写死了适配器，把 tool result 的 `details` 映射成时间线条目。这是白名单，不是可扩展机制。

### DeepSeek Harness

[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)：基于 Cordis 的"一切皆插件"架构，模型、工具、会话、loop、UI 都由插件提供，developer preview，会有破坏性变更。文档里没有面向外部应用的 API，接入它大概率要写桥接插件。

对 Atrium 的价值：作为参照物，研究它如何把 loop 和 UI 统一进同一个插件系统，借鉴到 Atrium 的插件模型（见 [ADR-0004](../adr/0004-deep-pi-host-positioning.md)）。

## agent loop 近期趋势（2026）

- 推理与工具调用交错，reasoning 需要原样回传
- 上下文管理成为核心：compaction、清理旧 tool result、大输出落盘
- 工具按需加载：tool search、skills 渐进式披露、MCP
- 用代码执行代替零碎的工具调用
- 子 agent、并行调用、后台任务
- 设计要照顾 prompt cache：前缀保持稳定
