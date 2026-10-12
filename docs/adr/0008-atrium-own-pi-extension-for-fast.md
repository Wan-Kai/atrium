# ADR-0008：用 Atrium 自带的 pi 扩展实现 Fast

- **状态**：已接受
- **日期**：2026-10-12（同日修订：哪些模型支持 Fast 改为问 Codex 的模型列表）
- **相关**：[SPEC-0001](../specs/0001-mvp1-single-session-chat.md)"输入框""模型与输入框 · Fast"、[pi-internals](../research/pi-internals.md) §5、[security.md](../architecture/security.md)

## 背景

自用（M1.11）时想在输入框里开关 Fast：OpenAI 对 ChatGPT 订阅的部分模型提供 priority 服务档（对外叫 Fast），请求带 `service_tier: "priority"`，约 1.5～2 倍速度，额度消耗增加。不是所有模型都能开，支持的模型随 OpenAI 上新而变（最初照社区插件只认 GPT-5.4 / 5.5 / 5.6，当天就漏了 GPT-6 系列）。

约束：

- pi 1.0.2、1.1.0 的核心不传服务档：pi-ai 的 `openai-codex-responses` 接受 `serviceTier`，但 pi-coding-agent 的设置和 RPC 命令里都没有它，pi 的维护者也不打算放进核心（服务档太依赖具体服务商）。能改请求的只有扩展的 `before_provider_request` 钩子。
- 社区插件 `pi-codex-fast-mode` 就是这样做的，但它是第三方代码、以 pi 的权限运行；开关是全局的，记在 pi 目录的状态文件里，和终端里的 pi 共用；状态只显示在 pi 终端界面的页脚。
- 宿主不替用户 `pi install` 任何东西。
- 回复里看不出 Fast 有没有生效：实测 Codex 不管请求带不带 priority，回复的 `service_tier` 都是 `"default"`，响应头里也没有服务档（pi-internals §5）。
- Codex 自己的模型列表接口 `chatgpt.com/backend-api/codex/models` 给每个模型标了 `service_tiers`，有 `id: "priority"` 的就有 Fast，还带一句说明（如 "2x speed, increased usage"）；Codex 桌面版就按它显示 Fast。这个接口要用 ChatGPT 登录的凭据请求，而宿主不碰凭据。

## 决策

**Atrium 自带一个很小的 pi 扩展 `atrium-fast`，只在 Atrium 启动的会话的 pi 里加载，由宿主按会话开关。**

1. **扩展改请求**：开着且当前模型支持时，在 `before_provider_request` 里给请求加上 `service_tier: "priority"`；其他情况原样放过。
6. **哪些模型支持，问 Codex 的模型列表**（同日修订）：扩展在 pi 进程里借 pi 自己的 ChatGPT 登录（`modelRegistry.getApiKeyAndHeaders`）请求 Codex 的模型列表，`service_tiers` 里有 priority 的模型才有 Fast，速度倍数和是否多耗额度取自它的说明。请求带 `client_version=99.0.0`：列出哪些模型取决于这个版本号，取一个足够高的才不漏（pi-internals.md §5）。宿主查模型列表时让那个短暂的 pi 也加载扩展，发 `/atrium-fast tiers`，扩展查完用 `setStatus` 把"哪些模型有 Fast、几倍速、是否多耗额度"报给宿主；凭据不出 pi。会话的 pi 在 Fast 打开时自己查一次，用来决定改哪些请求。查不到（没登录、断网、接口变了）时退回 `packages/pi` 里的内置规则（GPT-5.5、5.6、6、6.1 系列，2026-10-12 实测的结果），宿主记一条警告。
2. **随应用发布**：源码在 `packages/pi`，构建时打成一个文件放在宿主旁边（和登录程序一样），宿主启动会话的 pi 时用 `--extension <路径>` 加载。路径是参数里唯一的新东西，不含凭据。
3. **宿主用内部命令开关它**：`prompt` 发 `/atrium-fast on|off`。pi 立即执行扩展命令（运行中也可以），应答 `handled`，不进对话记录、不触发运行。扩展默认关，pi 每次启动后宿主按会话的开关补发。
4. **不会把命令误发给模型**：宿主只在 pi 的 `get_commands` 里看到扩展的 `atrium-fast` 时才发；扩展没加载上时 Fast 不可用。这个命令不出现在 `/` 菜单里。
5. **开关属于会话**：每个会话一份，新会话沿用上一次的选择；状态由 Atrium 的索引记住，不写进 pi 的会话文件，也不碰 pi 的设置。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| 让用户装 `pi-codex-fast-mode` | 不用写代码 | 第三方代码以 pi 的权限运行；开关全局且和终端共用，不能按会话；Atrium 看不到状态 |
| 等 pi 核心支持服务档 | 最干净 | 维护者明确不做（pi issue #4074） |
| 宿主按开关重启 pi，用启动参数或环境变量传给扩展 | 不用内部命令 | 每次开关都要重启 pi，运行中不能切换 |
| 扩展读宿主写的状态文件 | 不用内部命令 | 多一个文件和轮询，开关时机不确定 |
| 内置规则，随版本人工更新 | 不用联网、不碰凭据 | OpenAI 上新模型就过时，当天就漏了 GPT-6 系列；现在只作查不到时的后备 |
| 按回复里实际的服务档核对 | 不多发请求 | 做不到：Codex 回复的服务档总是 `default` |
| 宿主自己请求模型列表 | 不经扩展 | 宿主要读 pi 的凭据，违反"宿主不碰凭据" |
| 自带扩展，宿主用内部命令开关（采用） | 按会话、运行中可切换、从下一次请求生效；代码几十行，随应用签名 | 依赖 pi 的扩展接口和 `prompt` 处理扩展命令的方式，pi 改了要跟着改（契约测试会发现） |

## 后果

- 正面：Fast 和模型、推理强度一样在输入框里按会话切换；以后要改 pi 请求的功能（如其他服务商的服务档）有了现成的位置。
- 负面 / 代价：
  - Atrium 第一次往 pi 里加载自己的代码，扩展出错会出现在 pi 的 `extension_error` 里；要有契约测试覆盖真实 pi 的加载、命令和钩子。
  - 交给终端后，终端里的 pi 不加载这个扩展，Fast 不跟过去。
  - 用户自己装的 `pi-codex-fast-mode` 也改 `service_tier`，两者同时开时 Atrium 关不住它；暂不检测。
  - 服务端可能不按 priority 处理，回复里也看不出来，Atrium 不声称每一次都提速了。
  - 扩展会用 pi 的 ChatGPT 凭据多发一个请求（查模型列表，发往 pi 平时请求的同一个服务器），依赖一个没有公开文档的接口；接口变了就退回内置规则。
- 什么情况下应重新评估：pi 核心开始支持服务档时；Codex 的模型列表接口变了或不再给服务档时；要支持 API key 的 `openai` 或其他服务商的服务档时；pi 的扩展接口或扩展命令的处理方式变了时。
