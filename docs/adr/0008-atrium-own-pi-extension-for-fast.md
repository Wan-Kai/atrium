# ADR-0008：用 Atrium 自带的 pi 扩展实现 Fast

- **状态**：已接受
- **日期**：2026-10-12
- **相关**：[SPEC-0001](../specs/0001-mvp1-single-session-chat.md)"输入框""模型与输入框 · Fast"、[pi-internals](../research/pi-internals.md) §5、[security.md](../architecture/security.md)

## 背景

自用（M1.11）时想在输入框里开关 Fast：OpenAI 对 ChatGPT 订阅的 GPT-5.4 / 5.5 / 5.6 提供 priority 服务档（对外叫 Fast），请求带 `service_tier: "priority"`，约 1.5 倍速度，额度消耗约 2～2.5 倍。不是所有模型都能开。

约束：

- pi 1.0.2、1.1.0 的核心不传服务档：pi-ai 的 `openai-codex-responses` 接受 `serviceTier`，但 pi-coding-agent 的设置和 RPC 命令里都没有它，pi 的维护者也不打算放进核心（服务档太依赖具体服务商）。能改请求的只有扩展的 `before_provider_request` 钩子。
- 社区插件 `pi-codex-fast-mode` 就是这样做的，但它是第三方代码、以 pi 的权限运行；开关是全局的，记在 pi 目录的状态文件里，和终端里的 pi 共用；状态只显示在 pi 终端界面的页脚。
- 宿主不替用户 `pi install` 任何东西。

## 决策

**Atrium 自带一个很小的 pi 扩展 `atrium-fast`，只在 Atrium 启动的会话的 pi 里加载，由宿主按会话开关。**

1. **扩展只做一件事**：开着且当前模型支持时，在 `before_provider_request` 里给请求加上 `service_tier: "priority"`；其他情况原样放过。哪些模型支持的规则写在 `packages/pi`，扩展和宿主共用一份。
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
| 自带扩展，宿主用内部命令开关（采用） | 按会话、运行中可切换、从下一次请求生效；代码几十行，随应用签名 | 依赖 pi 的扩展接口和 `prompt` 处理扩展命令的方式，pi 改了要跟着改（契约测试会发现） |

## 后果

- 正面：Fast 和模型、推理强度一样在输入框里按会话切换；以后要改 pi 请求的功能（如其他服务商的服务档）有了现成的位置。
- 负面 / 代价：
  - Atrium 第一次往 pi 里加载自己的代码，扩展出错会出现在 pi 的 `extension_error` 里；要有契约测试覆盖真实 pi 的加载、命令和钩子。
  - 交给终端后，终端里的 pi 不加载这个扩展，Fast 不跟过去。
  - 用户自己装的 `pi-codex-fast-mode` 也改 `service_tier`，两者同时开时 Atrium 关不住它；暂不检测。
  - 服务端可能不按 priority 处理，钩子看不到实际的服务档，Atrium 不声称每一次都提速了。
- 什么情况下应重新评估：pi 核心开始支持服务档时；要支持 API key 的 `openai` 或其他服务商的服务档时；pi 的扩展接口或扩展命令的处理方式变了时。
