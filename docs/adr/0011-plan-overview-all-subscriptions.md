# ADR-0011：套餐总览——经任一会话的 pi 查所有订阅，Grok 的用量接口是唯一的例外地址

- **状态**：已接受
- **日期**：2026-10-16
- **相关**：[ADR-0010](0010-plan-usage-through-atrium-extension.md)（第 1、3 条被本文取代）、[SPEC-0001](../specs/0001-mvp1-single-session-chat.md)"M1.14 的套餐总览"、[security.md](../architecture/security.md)"Atrium 自带的 pi 扩展"、[pi-internals](../research/pi-internals.md) §5

## 背景

M1.13 按 ADR-0010 做了套餐用量：只查 ChatGPT（`openai-codex`）和 Claude 订阅，只在当前会话的模型是这家时查、显示这一家。自用时想要两件事：

- 看到 Grok（xAI 订阅：SuperGrok、X Premium）的余量。
- 不管当前用哪个模型，在一个地方看所有订阅还剩多少，好决定下一个会话用哪家。

约束和调查（2026-10-16）：

- pi 1.1.0 对 xAI 只请求 `api.x.ai/v1`（对话）和 `auth.x.ai`（登录、刷新令牌），不读、不给订阅用量。
- Grok 的用量在 `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`：Grok 自己的命令行（Grok Build）的 `/usage` 用它，没有官方文档；CodexBar、Hermes、Vibe Island 等社区工具都在用。请求带 `Authorization: Bearer <xAI 的 OAuth 访问令牌>`、`x-xai-token-auth: xai-grok-cli`、`accept: application/json`。
- 用 pi 自己的 xAI 订阅登录实测（2026-10-16，pi 1.1.0，在 pi 进程里取凭据）：HTTP 200，回
  `{config: {currentPeriod: {type: "USAGE_PERIOD_TYPE_WEEKLY", start, end}, creditUsagePercent: 34, productUsage: [{product: "GrokBuild", usagePercent: 33}, {product: "GrokChat", usagePercent: 1}, {product: "GrokImagine"}], onDemandCap, onDemandUsed, prepaidBalance, billingPeriodStart, billingPeriodEnd, isUnifiedBillingUser, topUpMethod}}`。
  `start`、`end` 是带微秒和 `+00:00` 的 ISO 时间；用了 0% 的产品没有 `usagePercent`（社区报告说 `creditUsagePercent` 是 0 时也会省略）；各产品的百分比加起来等于总的，是同一份额度按产品的拆分，不是各自的上限。周期也可能是每月的。
- 这个地址不是 pi 平时请求的服务器，ADR-0010 第 1 条"扩展只发往 pi 本来就请求的服务器"不允许。
- 扩展的 `/atrium-plan <服务商>` 用的是 pi 模型注册表里的登录，跟会话当前用的模型无关：任何一个加载了扩展的 pi 都能查任何一家。

## 决策

**一、Grok 的用量接口是扩展唯一允许发往"pi 平时不请求的服务器"的地址。** 只对 `xai` 的订阅登录（`isUsingOAuth` 为真）、只发往写死的 `https://cli-chat-proxy.grok.com/v1/billing?format=credits`，只带 bearer 令牌和上面两个头，不带 pi 给 `api.x.ai` 的其他头；API key 登录不查（API key 没有订阅额度）。其余照 ADR-0010：走 pi 的 `fetch` 和代理、不跟随重定向、凭据不出 pi、查失败只报原因代码。这取代 ADR-0010 第 1 条里"只发往 pi 本来就请求的服务器"的绝对说法；ChatGPT、Claude 的地址规则不变。

**二、所有订阅都查，经任一会话的 pi。** 宿主在每个会话的 pi 启动后和每次运行结束后，经这个会话的 pi 把 Atrium 认识的每一家（`openai-codex`、`anthropic`、`xai`）都问一遍，不再看会话当前的模型；同一服务商 60 秒内最多问一次、正在问时不再问（全宿主共用，不按会话）。没登录或是 API key 的报 `no_login`，界面不列。这取代 ADR-0010 第 3 条"当前模型是这两家之一时才问"。

**三、用量是宿主全局的一份，推给所有连接。** 不再随会话的指标走：宿主按服务商记最近一次的结果，变了就整份推给所有连接，连上时可以要一份。状态栏的"套餐"一组和设置的"模型与账户"都显示所有订阅；状态栏的摘要数字仍取当前会话模型那家。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| 守住 ADR-0010 第 1 条，Grok 不做 | 凭据只去 pi 去过的服务器 | 看不到 Grok 的余量；要等 pi 自己提供或 `api.x.ai` 有对应接口 |
| 读 Grok 命令行的 `~/.grok/auth.json` 去查 | 社区工具多这样做 | 要另装、另登录 Grok 命令行；宿主或扩展去读别的程序的凭据，违反"凭据只由 pi 管" |
| 只在当前模型是这家时查（ADR-0010 原样） | 请求最少 | 看不到别家的余量，正是这次要解决的 |
| 没有会话时起一个短暂的 pi 去查 | 没开会话也有数 | 每次都要起 pi；没开会话时一般也不急着看，"N 分钟前"说明了数有多旧 |
| 经任一会话的 pi 查所有订阅、Grok 一个例外地址（采用） | 不多起进程；凭据仍只在 pi 里用；一处看全 | 多了一个 pi 平时不访问的地址；依赖又一个没有文档的接口 |

## 后果

- 正面：一个地方看全 ChatGPT、Claude、Grok 的余量和重置时间；凭据仍不出 pi。
- 负面 / 代价：
  - pi 的 xAI 令牌会发往 `cli-chat-proxy.grok.com`。它属于 xAI，令牌的权限里本来就有 `grok-cli:access`，但不是 pi 自己访问的服务器。security.md 的扩展一条随之修订，写明这是唯一的例外。
  - 每个会话的每次运行结束都可能让扩展查三家（有 60 秒的限制，没登录的那家不发网络请求），比 M1.13 多一些请求。
  - 一个会话都没开时没有新数据，显示上次查到的结果和它有多旧；宿主重启后要等第一个会话的 pi 起来才有数。
  - Grok 的接口没有文档，格式变了就不显示（报 `unknown_shape`）。
- 什么情况下应重新评估：pi 自己开始提供订阅用量时；Grok 的接口变了或拒绝 pi 的令牌时；要再加一个 pi 平时不访问的地址时（不能因为有了这个先例就照加，要另写 ADR）。
