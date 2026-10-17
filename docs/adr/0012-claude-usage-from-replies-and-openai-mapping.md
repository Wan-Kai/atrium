# ADR-0012：Claude 的用量也从回复的响应头读，经 claude-bridge 和 pi 新的 ChatGPT 登录的会话算到对应的订阅

- **状态**：已接受
- **日期**：2026-10-17
- **相关**：[ADR-0010](0010-plan-usage-through-atrium-extension.md)、[ADR-0011](0011-plan-overview-all-subscriptions.md)、[SPEC-0001](../specs/0001-mvp1-single-session-chat.md)"M1.14 的套餐总览"、[security.md](../architecture/security.md)"Atrium 自带的 pi 扩展"、[pi-internals](../research/pi-internals.md) §4、§5

## 背景

M1.14 自用时发现两种常见的用法看不到额度：

- **经 claude-bridge 用 Claude**：社区扩展 pi-claude-bridge 注册服务商 `claude-bridge`，请求经 Agent SDK 交给本机的 `claude`，用 Claude Code 自己的登录（Anthropic 自 2026-04-04 起把 pi 直接用订阅 OAuth 发的请求算到额外用量，所以很多人改走它）。pi 的 `anthropic` 登录这时常常没有或已过期，扩展查 `api/oauth/usage` 只得到 `no_login`。Claude Code 的登录在钥匙串里，归 Claude Code 管，Atrium 和扩展都不该去读（security.md）。
- **pi 1.1 新的 ChatGPT 登录（服务商 `openai`，"Sign in with ChatGPT"）**：令牌的 resource 是 `https://api.openai.com/v1`、权限 `chatgpt.tokens.use.direct`，pi 直接请求 `api.openai.com/v1`。Atrium 的设置里登录 ChatGPT 走的就是它（旧的 `openai-codex` 在设置里隐藏）。

调查（2026-10-16、17）：

- pi-claude-bridge 0.9.3 把 Claude Code 的 SDK `rate_limit_event` 还原成 Anthropic 回复里同名的响应头，作为一次"服务商回复"交给 pi，pi 的扩展在 `after_provider_response` 里能读到。实测（经 bridge 发一条消息，Claude Code 2.1.301）：`anthropic-ratelimit-unified-5h-utilization: 0.05`、`-5h-reset: 1792218000`、`-7d-utilization: 0.03`、`-7d-reset: 1792753200`，另有 `-status`、`-reset`、`-representative-claim`、`-overage-status`；利用率是 0–1 的小数，重置时间是 Unix 秒；每次请求的第一条回复前就到。pi 自己用 Anthropic 订阅登录时，真实回复里也是这组头。
- `openai` 的直连令牌：`chatgpt.com/backend-api/wham/usage` 回 401 `no_matching_rule`，`/v1/responses` 不带 `x-codex-*` 用量头；OpenAI 在 2026-10-01 答复"目前不支持，以后可能做"（openai/sign-in-with-chatgpt-devkit#3、openai/codex#54219）。直连令牌用的是同一个 ChatGPT 账户的套餐，另有每个应用的每周上限，也读不到。

## 决策

**一、Claude 的用量也从回复的响应头读。** Atrium 自带的扩展在 `after_provider_response` 里，当前模型的服务商是 `claude-bridge` 或 `anthropic`、回复带 `anthropic-ratelimit-unified-5h-utilization` 或 `-7d-utilization` 时，把它们报成 Claude（`anthropic`）的用量：5 小时、每周各一个窗口，百分比 = 利用率 × 100，重置时间 = `-reset` × 1000。不读凭据、不发请求，只读 pi 交给扩展的头。用另一个状态键 `atrium-plan-reply` 报，宿主在每个会话的 pi 上一直听着，收到就算查到了这家（不受"每分钟最多问一次"的限制，只要格式对就收）。

**二、回复只更新它知道的窗口，不因查询报 `no_login` 而立刻丢掉。** 回复的头里只有不分模型的 5 小时和每周两个窗口，查询还可能有按模型的每周窗口（如"每周 · Opus"）：回复只替换已有用量里长度相同、不分模型的窗口，其余窗口留着，已有用量里没有的加在后面，查到的时间记成现在（三方审查后定，免得按模型的窗口随回复和查询交替时有时无）。宿主只收 `anthropic`、没有套餐名、窗口没有产品拆分的回复报告，别的扩展写同一个状态键冒充别家的不收。 经 bridge 的人多半没有 pi 的 `anthropic` 登录，每分钟一次的查询会一直报 `no_login`；照 M1.13 的规则会把刚从回复读到的用量马上丢掉。改为：`no_login` 只立即丢掉查询查到的用量；回复带来的，和别的失败一样，满 10 分钟才丢。回复不清"上一次的失败原因"，所以经 bridge 的人每分钟一次的 `no_login` 仍只记第一次。

**三、会话的服务商按订阅归并。** 界面判断"当前模型是哪个订阅"时，`claude-bridge` 算 Claude（`anthropic`），`openai` 算 ChatGPT（`openai-codex`）。`openai` 的用量本身查不到，只在同时有 `openai-codex` 登录、查到了它的用量时，显示那一份（同一个账户的套餐；不含每个应用的上限）。只有 `openai` 登录时什么都不显示。已知限制：界面只按服务商名归并，不区分订阅登录和 API key——用 `OPENAI_API_KEY` 或 Anthropic API key 的会话，在另有这家订阅用量时也会被算成那家订阅（三方审查后决定先这样，以后由宿主带上会话是否订阅登录再改）。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| 扩展读 Claude Code 钥匙串里的登录，去查 `api/oauth/usage` | 不用等回复就有数 | 读别的程序的凭据，违反 security.md |
| 起 `claude` 跑 `/usage` | 用 Claude Code 自己的登录 | 每次都起一个进程；输出是给人看的文字，没有约定的格式 |
| 只做归并、不读响应头 | 改动最小 | 经 bridge 的人多半没有 pi 的 `anthropic` 登录，归并了也没有数 |
| 拿 `openai` 的令牌去试 `wham/usage` | — | OpenAI 明说不支持，实测 401；还要把令牌发往 pi 不请求的服务器 |
| 读响应头 + 归并（采用） | 不碰凭据、不多发请求；经 bridge 的会话一跑就有数 | 要先有一次回复；依赖 bridge 还原的头和 Claude Code 未写进文档的 `unifiedWindows` |

## 后果

- 正面：经 bridge 用 Claude 的会话，跑一轮就看到 5 小时和每周的余量；pi 自己的 `anthropic` 订阅会话也多了一个更及时的来源。用新 ChatGPT 登录的会话，在有旧登录时能看到 ChatGPT 的余量。
- 负面 / 代价：
  - 没跑过 Claude 的会话时，经 bridge 的人看不到 Claude 的余量；数据在 10 分钟内没有刷新、又有查询失败时会丢。
  - 依赖 pi-claude-bridge 还原响应头的做法，bridge 改了就读不到（只是不显示）。
  - `openai` 的额度和每个应用的上限仍看不到；只靠 `openai` 登录的人看不到 ChatGPT 的余量。
- 什么情况下应重新评估：OpenAI 给直连令牌提供用量接口时；pi-claude-bridge 换了报告用量的方式时；pi 自己开始提供用量时。
