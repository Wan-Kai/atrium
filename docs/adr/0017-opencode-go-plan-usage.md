# ADR-0017：OpenCode Go 的套餐用量用 API Key 查固定地址

- **状态**：已接受
- **日期**：2026-11-02
- **相关**：[ADR-0010](0010-plan-usage-through-atrium-extension.md)、[ADR-0011](0011-plan-overview-all-subscriptions.md)（本文给它的"API key 不查"和"唯一例外地址"各加一个例外）、[SPEC-0001](../specs/0001-mvp1-single-session-chat.md)"M1.14 的套餐总览"、[security.md](../architecture/security.md)"Atrium 自带的 pi 扩展"

## 背景

用户在 Atrium 里接了 OpenCode Go（pi 的 `opencode-go` 服务商，只有 API Key 登录，见 [SPEC-0001](../specs/0001-mvp1-single-session-chat.md)"第 2 步：登录模型"）。Go 是订阅：每月 $10 / $40 的额度按美元计，5 小时、每周、每月三个窗口各有上限（Go 是每月额度的 20% / 50%）。用户想在状态栏的"套餐"卡片里看到这三段的用量和重置时间。

约束和调查（2026-11-02）：

- OpenCode 文档只在 Console 的 Billing 抽屉里说"能看 Go 的实时额度"，没有给 API。
- 官方客户端自己请求 `GET https://opencode.ai/zen/go/v1/usage`：`Authorization: Bearer <API Key>`，有工作区 id 时再带 `x-opencode-org-id`。源码在 `anomalyco/opencode` 的 `packages/core/src/usage-limits.ts`（`readGo`）和 `packages/schema/src/usage-limits.ts`；本地 server 把它包成实验性的 `GET /api/experimental/usage/limits`（`packages/protocol/src/groups/usage.ts`）。来源是这个项目的官方源码，不是社区猜测，但它没有文档、标着 experimental。
- 用用户的 Go Key 实测（2026-11-02）：只带 bearer、不带 `x-opencode-org-id` 也返回 200：
  `{"usage": {"rolling": {"status": "ok", "percent": 0, "resetsAt": "2026-11-03T07:01:46.000Z"}, "weekly": {"status": "ok", "percent": 15, "resetsAt": "…"}, "monthly": {"status": "ok", "percent": 7, "resetsAt": "…"}}}`。
  工作区没订阅 Go 时返回 403。这个接口不在网关的响应头里，只能主动问。
- ADR-0011 写了两条不再适用：Grok 的地址是"唯一"的例外地址；只查订阅登录（OAuth），API key 的不查。Go 恰好是"用 API Key 的订阅"，而它的用量地址是 `opencode.ai` 上一个 pi 不请求的路径（pi 请求的是 `/inference/go/…`）。ADR-0011 说再加地址要另写 ADR，这就是那一份。
- 凭据仍在 pi 里：扩展经 `modelRegistry.getApiKeyAndHeaders` 取 `opencode-go` 的 API Key，只用于这一个写死的地址。

## 决策

**一、API Key 的订阅也查，按服务商判断，不按登录方式。** `opencode-go` 用 pi 给的 API Key 访问用量接口；`xai`、`anthropic` 仍只在订阅登录（`isUsingOAuth`）时查，API key 的照旧报 `no_login`。ADR-0011 第"API key 没有订阅额度"的说法改成"没有订阅额度的那几家不查"。

**二、固定地址、最小请求头。** 只发往写死的 `https://opencode.ai/zen/go/v1/usage`，只带 `authorization: Bearer <API Key>` 和 `accept: application/json`，不带 pi 给 `opencode-go` 模型的其他头，不从模型或登录的 `baseUrl` 拼地址（和 Grok 一样）。走 pi 的 `fetch`（含代理）、15 秒为限、不跟随重定向。不发 `x-opencode-org-id`：pi 只存了 Key，没有工作区 id；实测不带也能拿到用量，拿的是这把 Key 的默认工作区。用户有多个工作区、需要指定时再重新评估。

**三、三个窗口各一条。** `rolling` 是 5 小时（18000 秒）、`weekly` 是 604800 秒、`monthly` 是 2592000 秒（30 天）；`usedPercent` 是 `percent`（夹到 0–100），`resetsAt` 是 `resetsAt` 的 ISO 时间换成毫秒，解析不了为 `null`；`model` 为 `null`，`parts` 为空。`status` 只表示是否已被限额，界面按百分比显示，不另记。`plan` 为 `null`（接口不给套餐名，Go / Go Plus 分不出）。三项都没有百分比时报 `unknown_shape`。

**四、其余照 ADR-0011。** 六十秒一次、全宿主共用；`no_login` 立即丢掉这家，别的失败保留十分钟；失败只报原因代码（`no_login`、`unreachable`、`http_<状态码>`、`not_json`、`unknown_shape`）。

**五、协议加一家。** `PlanProvider` 加 `opencode-go`（协议版本 30），手机的类型和往返夹具跟着重新生成。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| 不显示 Go 的用量 | 不加新地址，不依赖没文档的接口 | 用户刚买的订阅看不到余量，正是这次要做的 |
| 从 Console 的 `api/policies/current-budgets` 查 | 那是文档里 Billing 抽屉用的，还能看到按模型的预算 | 要 Console 的登录（浏览器授权），pi 里只有 Go 的 Key；返回的是美元预算，不是 Go 的三个窗口 |
| 等接口被拒（`limitName`、`resetsAt`）时再解析 | 不用主动问 | 只能在已经用超时看到，看不到余量 |
| 让用户去看 Console 的 Billing 抽屉 | 不写代码 | 每次都要开网页；Atrium 的套餐卡片就少一家 |
| 用 API Key 查固定地址（采用） | 和别家一样进卡片；不需要额外登录 | 依赖一个没有文档、标着 experimental 的接口；Key 发往 pi 不请求的路径 |

## 后果

- 正面：状态栏和设置里能看到 OpenCode Go 的 5 小时、每周、每月用量和重置时间，和其他订阅并排。
- 负面 / 代价：
  - 依赖没文档的接口：路径、字段变了就只报 `unknown_shape` / `http_404`，不显示，不影响别的家；升级 pi 或 OpenCode 时要复查。
  - Go 的 API Key 会发往 `opencode.ai/zen/go/v1/usage`，这是 pi 不请求的路径（同一台服务器）。
  - 不带工作区 id，多工作区账号拿到的是默认工作区；需要时可以补 `x-opencode-org-id`，但要另想 id 从哪来。
  - 60 秒一次、每个会话每次运行结束都问，和别家一样多一个请求（没登录时不发）。
- 什么情况下应重新评估：接口变了或拒绝 Key；OpenCode 给了文档化的用量 API；用户需要多工作区的用量；Go 的套餐名要显示在卡片上。
