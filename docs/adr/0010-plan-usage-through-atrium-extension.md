# ADR-0010：套餐用量经 Atrium 自带的 pi 扩展查询

- **状态**：已接受
- **日期**：2026-10-15
- **相关**：[ADR-0008](0008-atrium-own-pi-extension-for-fast.md)、[SPEC-0001](../specs/0001-mvp1-single-session-chat.md)"状态栏""M1.13 的上下文细分与套餐用量"、[security.md](../architecture/security.md)、[pi-internals](../research/pi-internals.md) §5

## 背景

自用时想在状态栏看到 coding plan 的余量和重置时间：ChatGPT（Codex）和 Claude 的订阅都有一个 5 小时窗口和一个每周窗口，用完就要等重置。Claude Code、Codex 自己的界面都显示它们。

约束：

- pi 1.1.0、1.2.0 都不读、不给套餐用量：它只在 429、`usage_limit_reached` 时报错。
- 两家都有查用量的接口，社区工具普遍在用（2026-10-15 查的公开资料，没有官方文档）：
  - ChatGPT：`GET https://chatgpt.com/backend-api/wham/usage`，带 ChatGPT 登录的 `Authorization: Bearer` 和 `ChatGPT-Account-ID`；回 `plan_type`，`rate_limit.primary_window`、`secondary_window` 各有 `used_percent`（0–100）、`limit_window_seconds`（18000 是 5 小时、604800 是一周）、`reset_after_seconds`、`reset_at`（Unix 秒）。
  - Claude：`GET https://api.anthropic.com/api/oauth/usage`，带订阅登录的 `Authorization: Bearer` 和 `anthropic-beta: oauth-2025-04-20`；回 `five_hour`、`seven_day`（`utilization` 0–100、`resets_at` ISO 时间），新版本另有 `limits[]`（`kind` 为 `session`、`weekly_all`、`weekly_scoped`，`percent`、`resets_at`，按模型的那项带 `scope.model.display_name`），这时旧的 `seven_day_<模型>` 都是 `null`。
- 回复的响应头里也有用量（Claude 的 `anthropic-ratelimit-unified-*`，Codex 走 SSE 时的 `x-codex-*`），但 Codex 默认走 WebSocket，拿不到响应头；新会话第一次回复前也没有。
- 这两个接口都要用 pi 存的登录凭据去请求，而宿主不碰凭据（security.md）。ADR-0008 已经有了先例：Atrium 自带的扩展在 pi 进程里借 pi 的登录查 Codex 的模型列表。
- GitHub Copilot 的额度要 GitHub 的 token，pi 不交给扩展；GLM、Kimi、MiniMax 等 coding plan 各家接口不同，没有公开文档。

## 决策

**Atrium 自带的 pi 扩展加一个内部命令 `/atrium-plan <服务商>`，在 pi 进程里借 pi 的登录查这家的用量接口，用 `setStatus` 报给宿主；宿主按服务商缓存，显示在状态栏的"套餐"一组。先做 ChatGPT（`openai-codex`）和 Claude 订阅（`anthropic` 的订阅登录）。**

1. **扩展只发往 pi 本来就请求的服务器**：`openai-codex` 发往这个模型的 `baseUrl`（登录给的优先）去掉 `/codex…` 后的 `/wham/usage`，即 `chatgpt.com/backend-api/wham/usage`；`anthropic` 只在 `modelRegistry.isUsingOAuth` 为真时发往模型 `baseUrl` 下的 `/api/oauth/usage`，用 API key 的不查。走 pi 的 `fetch`，也就走 pi 设好的代理。
2. **凭据不出 pi**：扩展只报服务商、套餐名（`plan_type`，Claude 没有就是 `null`）和每个窗口的已用百分比、窗口长度、重置时间、按模型的那项的模型名；查失败只报原因代码，不带服务器的原文。宿主按格式校验后才用。
3. **宿主什么时候问**：会话的 pi 启动后、每次运行结束（`agent_settled`）后、换了模型之后，当前模型是这两家之一、并且 pi 的 `get_commands` 里有 `atrium-plan` 时，经这个会话的 pi 发 `/atrium-plan <服务商>`（扩展命令立即执行，运行中也可以，不进对话记录）。同一服务商 60 秒内最多问一次，正在问时不再问；问到的结果给所有用这家的会话。
4. **关掉这一组也照样问**：状态栏关掉"套餐"一组时界面不显示；宿主照样按上面的时机问（很便宜，也让打开时马上有数）。查不到（API key 登录、断网、接口变了）就不显示这一组。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| 宿主读 `auth.json` 自己请求 | 不经扩展 | 违反"宿主不碰凭据" |
| 只读回复的响应头 | 不多发请求 | Codex 默认走 WebSocket 没有响应头；第一次回复前没有数 |
| 每次查用量起一个短暂的 pi（同查模型列表） | 不依赖会话的 pi | 每次都要起一个 pi，运行频繁时开销大 |
| 让用户装社区的用量插件 | 不用写 | 第三方代码以 pi 的权限运行；显示在 pi 终端的页脚，Atrium 看不到 |
| 扩展内部命令，经会话的 pi 查（采用） | 凭据不出 pi；不多起进程；和 Fast 同一条路 | 依赖两个没有官方文档的接口，变了就不显示 |

## 后果

- 正面：状态栏能看到这家订阅还剩多少、什么时候重置；接口变了只是不显示，不影响对话。
- 负面 / 代价：
  - 扩展用 pi 的凭据多发请求（每家每分钟最多一次），发往 pi 平时请求的同一个服务器，但路径是新的。security.md 的扩展一条随之修订。
  - 接口没有官方文档，格式变了要跟着改；Claude 的接口新旧两种格式都认。
  - 只有当前会话的模型是这两家时才看得到；别家的余量要等各自的接口验证后再加。
- 什么情况下应重新评估：pi 自己开始提供用量时；两个接口变了或被关掉时；要加别家的 coding plan 时。
