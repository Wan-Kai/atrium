# 测试与代码质量

> 2026-10-04 定。工具版本是当时 npm 上的最新版，搭骨架时（M1.1）固定下来。

测试的两条核心要求：**覆盖面全**，并且**每个测试都有效**，能测出真实问题。下面的工具、分层和规则都是为这两条服务的。

参考：Paseo 的 `docs/testing.md`（本地源码 `~/.cache/paseo-src`），它的原则和这里一致；pi 的测试在 `packages/coding-agent/test/`。

## 工具

| 方面 | 工具 | 说明 |
|---|---|---|
| 测试框架 | Vitest 5 | 单元、集成；浏览器模式（`@vitest/browser-playwright`，真实 Chromium）跑组件测试，组件渲染用 `vitest-browser-react`。组件测试直接用 UI 包的 `vite.config.ts`（`extends`），和页面一样带 React 与 Tailwind 插件；依赖在配置里预构建（`optimizeDeps.include`），否则测试中途发现新依赖时 Vite 会重载页面，加载出两份 React，渲染全部失败 |
| 端到端 | Playwright（`@playwright/test`） | 用 `_electron.launch` 驱动真实的 Electron 应用 |
| 属性测试 | fast-check 4 | 随机生成输入找边界情况；也用它的 `commands` 做基于模型的测试 |
| 变异测试 | Stryker 10，命令运行器 | 往代码里注入 bug，检验测试能不能抓住。Stryker 的 Vitest 插件靠 Vitest 的 provide/inject 激活变异，这在 Vitest 5 上失效（所有变异都会"存活"），所以改用命令运行器：每个变异跑一遍 Node 测试层（`vitest.mutation.config.ts`），没有逐测试覆盖分析。按模块分成几组，每组只跑自己相关的测试（2026-10-10 定，见下文"每个变异只跑本组的测试"） |
| 覆盖率 | `@vitest/coverage-v8` | 只作发现漏测的提示 |
| 界面泄漏分析 | 自写的堆快照分析（`apps/desktop/e2e/heap.ts`） | 比较场景前后"已脱离文档的 DOM 节点"按名称的数量。原计划用 memlab，但 Chromium 152 改用快照里的 `detachedness` 字段标记脱离节点、不再加 "Detached" 前缀，memlab 2.0.5 认不出来，注入的泄漏也报 0 |
| 基准 | Vitest 5 的 `bench` 测试夹具 | 热路径基准写在 `*.bench.ts`，用 testkit 的 `compareWithBaseline` 和本机基线比较 |
| 代码检查 | oxlint 1.x + `oxlint-tsgolint` | 开启类型感知规则；同时用它的 vitest、react、react-hooks 规则 |
| 格式化 | oxfmt | 兼容 Prettier 的格式；还没到 1.0，版本固定，升级单独提交 |
| 类型检查 | TypeScript 7 | strict，另开 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` |
| 死代码 | knip | 没用到的文件、导出、依赖 |
| 提交钩子 | lefthook | 提交前：格式化并检查改动的文件；推送前：类型检查 + 第 1、2 层测试 |

**为什么代码检查选 oxlint**：宿主大量是异步代码，漏写 `await` 会让错误悄悄丢失。`no-floating-promises`、`no-misused-promises`、`switch-exhaustiveness-check` 这几条类型感知规则在 oxlint 里稳定可用；Biome 2 里同类规则还在 nursery。ESLint + typescript-eslint + Prettier 同样完整，但更慢、配置更多。Paseo 用的也是 oxlint + oxfmt + tsgolint + knip + lefthook。

## 分层

原则：**能用真的就用真的**。文件系统、git、WebSocket、pi 进程都用真实的；只有模型和时钟换成可控的替身。

| 层 | 文件后缀 | 测什么 | 依赖 |
|---|---|---|---|
| 1 纯逻辑 | `*.test.ts` | 事件翻译、从条目树重建对话记录、状态派生与优先级、命名规则、合并状态判定、上下文估算、排队与停止的状态机、同步游标、平滑揭示 | 不 mock 自己的模块；pi 进程用回放录制夹具的替身，时间用假时钟 |
| 2 属性与模型 | `*.prop.test.ts` | ① JSONL 分帧：任意切块、多字节字符跨块、U+2028 ② 随机生成带分叉和压缩的条目树，重建结果等于参考实现 ③ 随机组合发送、插话、停止、崩溃：不丢、不重，停止后不再出队 ④ 随机断线、重连、乱序：客户端状态最终等于宿主状态 | 同第 1 层 |
| 3 pi 契约 | `*.pi.test.ts` | 逐条验证 [pi-internals](../research/pi-internals.md) 里我们依赖的行为：`prompt` 的三种回应、会话文件延迟写出、`get_entries` 与 `leafId`、`abort` + `clear_queue`、`queue_update`、压缩期间 `prompt` 报错、对话框往返、退出码 | 真实的 `pi --mode rpc` 子进程；模型用 faux（见下文）。第 1 层的夹具由这一层录制 |
| 4 宿主集成 | `*.host.test.ts` | SPEC-0001 的关键流程：恢复、草稿、后台运行、重连、多客户端、宿主重启、杀掉 pi 后自动恢复、停止锁定；合并状态在真实 git 里造出 merge、squash、rebase、cherry-pick | 真实宿主 + WebSocket + `client` 包；HOME、`~/.atrium`、pi 会话目录都在临时目录；pi 用 faux 模型 |
| 5 UI 组件 | `*.browser.test.tsx` | 输入框（输入法组字时回车、长文本粘贴变胶囊、↑ 历史、快捷键）、Streamdown 分片流式渲染结果等于一次性渲染、滚动跟随、推理强度框拖拽吸附、减弱动态效果 | 真实 Chromium，不用 jsdom（它的输入法、剪贴板、滚动、布局都不真实） |
| 6 端到端 | `e2e/*.spec.ts` | 少量关键旅程：首次启动（pi 已装 / 未装，安装源指向本地）；添加项目 → 发消息 → 流式 → 停止 → 重启应用 → 历史恢复；后台会话进收件箱 | 整个应用都是真的，只有模型是 faux；失败时保留 trace、截图、录像 |
| 7 真实模型冒烟 | `*.real.test.ts` | 用真实订阅跑一两个任务 | 手动触发，不进默认测试 |

端到端测试只连本机测试服务器，不访问外网；会把链接交给系统浏览器的操作，测试里先替换 `shell.openExternal` 只做记录，绝不真的打开用户的浏览器。

测试和实现放在一起（`thing.ts` + `thing.test.ts`）；端到端放在 `apps/desktop/e2e/`；第 4 层的测试宿主放在 `packages/host/test/harness.ts`。共用的测试工具放在 `packages/testkit`：faux 模型、回放夹具的 pi 替身、假时钟、临时环境、git 场景。testkit 不依赖任何内部包（最多依赖 protocol），pi 替身按结构类型匹配 pi 包的接口，避免和被测包形成循环依赖（见 [架构总览 · 代码结构](overview.md#代码结构)）。

### faux 模型

pi-ai 自带 `fauxProvider()`：内存里的假模型，按脚本返回文本、推理和工具调用（见 pi 的 `packages/ai/README.md` "Faux Provider for Tests"）。测试用一个 pi extension 通过 `pi.registerProvider()` 注册它，启动时 `pi --mode rpc --extension <faux 扩展> --model <faux 模型>`；每个测试的回复脚本通过扩展命令或环境变量指定的文件传入。

2026-10-04 在 pi 1.0.2 上验证通过（不需要退路）：

- 扩展里 `import { fauxProvider, ... } from "@earendil-works/pi-ai"` 由 pi 的扩展加载器解析到它自带的 pi-ai，不需要我们安装。
- 启动参数：`pi --mode rpc --extension <faux 扩展> --provider faux --model <faux 模型 id>`；`PI_CODING_AGENT_DIR` 指向临时目录，隔离用户的 `~/.pi/agent`。
- 验证过的行为：推理和文本分片流式输出，以 `agent_settled` 结束；工具调用会被 pi 真实执行（bash 工具跑了命令，结果回到下一轮）；`tokensPerSecond` 放慢输出后，`abort` 能在中途打断（`stopReason: "aborted"`）；`stopReason: "error"` 且消息像 5xx 时，pi 会自动重试（`auto_retry_start`）。
- **结果确定**：faux 默认每片长度随机、`api` 和工具调用 id 带时间戳和随机数。固定 `api`、`tokenSize` 的 `min` 等于 `max`、工具调用传固定 `id` 后，同一脚本跑两次的输出，去掉时间戳字段后逐行相同。夹具录制时只需要规范化时间戳类字段。
- 回复脚本放在文件里，路径由环境变量传给扩展；每个场景启动一个新的 pi 进程。
- 实现在 `packages/testkit/src/faux/`：`extension.ts` 是交给 pi 加载的扩展（为什么它能 import pi-ai，见 [架构总览 · 包之间的依赖](overview.md#包之间的依赖)），`fauxPi(script)` 写好脚本并返回启动参数和环境变量，三层测试用同一个入口。

没有采用的退路：本地 HTTP 服务模拟兼容 OpenAI 的接口，用 `models.json` 指向它。

**端到端测试里让宿主用上 faux**（2026-10-07）：`apps/desktop/e2e/faux-pi.ts` 的 `fauxPiEnvironment(script)` 给 `launchApp` 一份环境变量。`SHELL` 设成宿主不支持的 shell，宿主就不读登录 shell，沿用自己的环境（SPEC-0001"第 1 步"）；PATH 最前面放一个名为 `pi` 的包装脚本，它把 `--version` 原样交给真实的 pi，其余调用加上 faux 扩展的参数。宿主照常找到、检查、启动"pi"，整条链路都是真的，只有模型是 faux。变量名避开 `ATRIUM_` 前缀，宿主不会把这类变量交给 pi。

### pi 夹具（2026-10-05 定）

**用途**：第 3 层用真实 pi 跑各种场景，把"宿主发了什么、pi 回了什么"录下来，供第 1 层的纯逻辑测试回放，不用启动 pi。消费者是 M1.3 的事件翻译（实时事件 → Atrium 事件）、M1.4 的对话记录重建（条目 → 对话记录），以及 M1.2 完成标准里的"适配器测试用录制的夹具跑通"。

**位置**：`packages/pi/fixtures/pi-<版本>/<场景>.jsonl`，进 git。仓库里只保留一个版本：重录新版本时，在同一次提交里删掉旧版本的目录，这次提交的 diff 就是"pi 的输出变了什么"，旧版本留在 git 历史里。

**格式**：一个场景一个 JSONL 文件，按实际发生的顺序记录宿主和 pi 之间的每一条往来：

| 记录 | 含义 |
|---|---|
| `{"kind":"fixture","scenario":"prompt-started","pi":"1.0.2","script":{…},"args":[…]}` | 第一行：场景名、pi 版本、faux 回复脚本、pi 的启动参数 |
| `{"kind":"send","record":{…}}` | 宿主写给 pi 的一行（命令或 `extension_ui_response`） |
| `{"kind":"stdout","record":{…}}` | pi 打印的一条记录（响应、事件、对话框请求），原样保存 |
| `{"kind":"exit","code":0,"signal":null,"requested":true}` | pi 退出；`requested` 表示是不是宿主要它停的，回放时宿主要求的退出等调用方 `stop()` 才发生，其余的当作崩溃自己发生 |
| `{"kind":"session","lines":[…]}` | 场景结束时会话文件的全部行（文件头 + 条目），只在用到会话文件的场景里有 |

**规范化**（录制时做，保证同一台机器上重录结果逐字节相同）：

- 时间：名为 `timestamp` 的数字字段 → `0`；ISO 时间字符串 → `"1970-01-01T00:00:00.000Z"`；会话文件名里的时间 → `1970-01-01T00-00-00-000Z`。
- 度量：`usage` 里的所有数字（含 `cost`）、`tokensBefore`、`estimatedTokensAfter`、`wall_time_seconds`、`durationMs`（pi 1.1.0 起工具结果带的执行时长）→ `0`。token 数受系统提示词长度影响，而系统提示词里有本机路径；耗时取决于机器。
- 路径：临时工作目录 → `<cwd>`，pi 配置目录 → `<agent>`，会话目录 → `<sessions>`，faux 扩展目录 → `<faux>`，用户主目录 → `<home>`（系统提示词里有 pi 的安装路径）。长的路径先换。
- 随机 id：UUID（会话 id 等）按首次出现的顺序换成 `<uuid-1>`、`<uuid-2>`……；条目 id 只在 `id`、`parentId`、`leafId`、`since`、`targetId`、`firstKeptEntryId` 这几个键下识别，按首次出现的顺序换成 `e1`、`e2`……，引用同一个 id 的地方一起换，树的结构不变；已经认出的条目 id 出现在别的文字里（比如 `/faux-navigate <id>` 这样的命令参数）时，按完整的词一并替换；正文里碰巧是 8 位十六进制、但不是已知 id 的文字不动。请求 id 由录制时注入的 `nextRequestId` 生成，本来就是 `r1`、`r2`……。
- 工具调用 id 本来就由 faux 脚本固定，不用处理。

**录制与漂移检查**：

- `pnpm fixtures:record`：用本机的 pi 重录全部场景，写到 `pi-<本机版本>/`，并删掉其他版本的目录。
- 2026-10-09 本机 pi 升到 1.1.0：另录了 `pi-1.1.0/`（直接以 `RECORD_FIXTURES=1` 跑契约测试，不删旧目录），`pi-1.0.2/` 暂时保留，因为第 1 层的回放测试还按它写；两版的差别见 pi-internals"版本"。第 1 层改用新版本时，再用 `pnpm fixtures:record` 只留一个版本。
- `pnpm test:pi`：先对真实 pi 做契约断言，再把这次的输出规范化后和同版本的夹具比较，不一致就失败，提示重录并审查 diff。本机 pi 版本没有对应的夹具时也失败，要求先录制。这样升级 pi 后，第一次跑 `test:pi` 就会逼着人看 pi 的输出变了什么。
- 比较时只忽略系统消息里的文字（role 除外）：系统提示词写着本机的路径，换台机器就不同。系统消息的键和 `sections` 的结构仍要一致，pi 改了系统提示词的组织方式也能发现。夹具本身保存录到的文字。

**回放**：testkit 的 `replayPi` 读一个夹具，提供和 `PiProcess` 同形状的对象（按结构类型匹配，不 import pi 包）：

- `request(command)` 要求它和夹具里下一条 `send` 的类型、字段一致（请求 id 除外），否则抛出写明"期望什么、收到什么"的 `FixtureMismatch`；然后依次发出它后面的 `stdout` 记录，直到下一条 `send`。请求按夹具里录下的 id 登记，录下的响应凭这个 id 找到对应的请求，调用方自己的 id 不用和夹具一致。
- 失败和真实的 `PiRequestError` 一样：`message` 只有命令和原因，pi 的原文在 `detail`。
- `respond()` 同样对上下一条 `send`。
- `stop()` 和真实进程一样：还在等的请求以 `stopped` 失败，之后到的响应丢掉，按夹具的 `exit` 记录结束（调用方没做完场景里的步骤也一样，没有 `exit` 记录时按退出码 0）。停止以后的请求以 `stopped` 失败，崩溃以后的以 `exited` 失败，都不再对夹具；`respond()` 被丢掉。
- 记录在微任务里逐条发出，保持顺序，不依赖真实时间。

**实现**：录制、规范化、比较和回放在 testkit 的 `pi-fixtures/`；跑场景的 `runScenario` 在 `packages/pi/test/contract.ts`；场景在 `packages/pi/src/contract/*.pi.test.ts`；`packages/pi/src/contract/replay.test.ts` 让每个夹具都按原样回放一遍。

**在运行中途发命令**：faux 回复可以写 `waitFor: "<名字>"`，在测试调用 `release(名字)` 之前不开始输出；这段时间 pi 打印的最后一条是这一轮的用户消息（`message_end`，role 为 user），测试等到它再发命令，命令在夹具里的位置就是固定的。中断会结束等待。faux 扩展还注册了 `/faux-noop`（输入被处理掉，`handled`）和 `/faux-confirm`（弹确认框，再用通知报告结果）。

**首批场景**（全部在 pi 1.0.2 上录制，两次录制逐字节相同）：

| 场景 | 验证 |
|---|---|
| `prompt-started` | 一轮完整运行：推理、文本分片、`agent_settled` |
| `prompt-tool` | 工具调用：`tool_execution_start/update/end`，结果进入下一轮 |
| `prompt-queued` | 运行中再发 `prompt`（`streamingBehavior`）：`queued` 和 `queue_update` |
| `prompt-handled` | extension 命令把输入处理掉：`handled`，不运行 |
| `abort` | 运行中 `clear_queue` + `abort`：`stopReason: "aborted"`，`abort` 在真正停下后才回应 |
| `session-lazy-file` | 会话文件在第一条消息出现前不存在，之后逐条追加；`get_state.sessionFile` |
| `get-entries` | `get_entries` 的全量与 `since` 增量、`leafId`；未知 `since` 报错 |
| `error-retry` | 可重试错误：`auto_retry_start/end`；不可重试错误直接结束 |
| `dialog` | extension 对话框：`extension_ui_request` → `extension_ui_response` → 继续 |
| `compaction` | 压缩期间 `prompt` 报错，`compaction_start/end` |
| `exit-stdin`、`exit-sigterm` | 关 stdin 退出码 0；SIGTERM 退出码 143 |

## 让每个测试都有效

1. **变异测试是硬门槛**。核心模块变异分数 ≥ 80%：事件翻译、对话记录重建、会话控制器、同步、状态派生、分帧、合并判定，以及连接层（鉴权、静态文件、WebSocket 服务、协议编解码、客户端连接）、pi 进程管理（PiProcess、杀进程树）和 pi 的启动边界（交给 pi 的环境、找 pi 与版本检查、读取登录 shell 的环境）、日志脱敏。连接层列入是因为 M1.1 的变异测试在这里找出了真实缺陷（握手超时后仍处理 hello、关闭时被暂停的下载挂住），而且它是安全边界；pi 的启动边界同理：它决定 pi 拿到什么环境、运行哪个可执行文件，M1.2 的审查在这里找出了相对 `PATH` 项和挂住的 `pi --version`。存活的变异逐个处理：补测试，或在代码里用 `// Stryker disable next-line <变异类型>: <理由>` 说明它与原代码等价或不可达。
   - **什么时候跑**（2026-10-09 定）：每次改动涉及核心模块，增量跑改动的文件（`pnpm test:mutation`），通过才算完成，里程碑合并也看这个。全量（`--force`）每晚在 `main` 上定时跑一次（`scripts/nightly-mutation.sh`，见 [development.md](../development.md#夜间变异测试)），不再卡里程碑：增量模式看不到测试文件的改动，测试被改弱后仍沿用旧的"已检出"结果，全量是为了发现这种情况，晚一天发现影响不大。早上看前一晚的结果，有存活或说不清的超时当天处理。不等到 MVP 结束再统一处理：存活的变异越积越难处理，M1.5 留下的 116 个过了一天就要重新读代码才能判断。
   - **每个变异只跑本组的测试**（2026-10-10 定）：命令运行器不知道哪些测试覆盖了哪段代码，原先每个变异都跑整套 Node 测试（约 30 秒），其中近八成时间花在三个用真实 git 的测试文件上（工作区扫描、合并判定、工作区改动），哪怕变异的是协议里的一个字段。现在按模块分成五组，`stryker.config.mjs` 里每组写明变异哪些文件、跑哪些测试：
     - `shared`：协议和客户端；跑它们自己的测试，加宿主的 `server/`、`sync/`。
     - `pi`：pi 包和测试工具的时钟；跑 pi 包、testkit，加宿主的 `sessions/`。
     - `host`：宿主里不碰 git 的部分；跑宿主的测试，去掉 `workspaces/`、`changes/`、`projects/` 和用 git 的集成测试。
     - `git`：宿主的 `workspaces/`、`changes/`、`projects/` 和 `platform/git.ts`；跑这几处的测试，加用 git 的集成测试。
     - `ui`：界面的纯逻辑文件；跑界面的 Node 层测试。

     `pnpm test:mutation` 依次跑各组（也可以只跑某几组：`pnpm test:mutation git ui`），每组的增量结果分开存（`reports/stryker-incremental-<组>.json`）。代价是只能被别组测试抓住的变异会显示存活，补本组的测试或注明理由。之前试过、不用的办法：Stryker 自带的 Vitest 运行器能按覆盖选测试，但在 Vitest 5 下运行时激活的变异全被判成存活（10.0.0 仍然如此）；先跑 `vitest related` 选出的测试、全过再跑整套确认，在四个文件 377 个变异上没有提速（被检出的变异有 `--bail` 本来就停得早），存活的变异还因为跑两轮超过期限被记成超时（23 个里 18 个）。全量仍然慢，所以放到夜里跑。
   - 时有时无的测试会让变异分数虚高：偶发失败被算成"杀死了变异"。M1.1 时日志流有竞态，分数显示 93%，修掉竞态后真实分数是 78%，补测试后才到 100%。
   - 超时也算"检测到"。启动真实子进程的测试在高并发下会变慢，Stryker 把变慢判成超时，分数同样虚高（M1.2 时一个只改日志文字的变异被记为超时）。所以并发固定为 4，每次测试最多 3 个线程（`vitest.mutation.config.ts` 的 `maxWorkers`，四份合起来不超过机器的核数），并给每个变异在 Stryker 估算的时间上再多留 30 秒（`timeoutMS`）：M1.6 的全量运行在默认的 5 秒下记了 533 个超时，抽查 5 个，4 个其实全部测试都通过，是存活的变异。看结果时留意超时数，超时的变异要能说清楚为什么会让测试卡住；超时偏多时，从增量报告里删掉超时的结果，单独重测这些变异。
2. **每个测试先见过失败**：一个测试、一段实现交替推进；修 bug 先写能复现它的测试。
3. **用代码检查约束测试写法**（oxlint vitest 规则）：`expect-expect`（必须有断言）、`no-conditional-expect`、`no-conditional-in-test`、`no-disabled-tests`、`no-focused-tests`、`no-restricted-matchers`（禁 `toBeTruthy`、`toBeDefined` 这类弱断言）、`no-large-snapshots`、`prefer-strict-equal`（整体比对）。
4. **结果必须确定**：停止的 2 秒锁定、重试退避、平滑揭示、`git fetch` 间隔都用假时钟，不用 `sleep` 等待；随机数注入种子，fast-check 失败会给出种子用于复现；时有时无的测试按 bug 处理，找到根因修掉，不删测试。
5. **默认禁止 `vi.mock`**（`no-restricted-vi-methods`）。确需使用时写注释说明理由再豁免。要隔离依赖就设计成可替换的适配器（如 `PiProcess`、`Clock`），不 mock 模块。
6. **夹具来自真实 pi**：由第 3 层录制，标注 pi 版本；pi 升级时重录，比较差异。
7. **覆盖率是底线不是目标**：核心包分支覆盖 ≥ 90%，用来发现漏测；真正的门槛是变异分数。

## 让覆盖面全

- **追踪表** `docs/testing/coverage-map.md`（M1.1 建立）：SPEC 的每条需求、每条关键流程、每种错误路径，对应到具体测试文件和用例名。
- **每个可能失败的操作**至少测成功和失败；超时、断线有不同的恢复方式时再单独测。失败用例断言用户看得到、能操作的东西，不断言内部字段或日志。
- **里程碑完成标准**都包含：追踪表里这个里程碑涉及的行都有测试，并通过变异门槛。

## 性能与资源泄漏

宿主要连续运行很多天，同时管着多个 pi 进程；界面要承受长会话和高速流式输出。这类问题功能测试测不出来，单独做一套。

### 风险清单

| 位置 | 典型问题 |
|---|---|
| 宿主 | 会话归档或关闭后 SessionController、SessionLog、对话记录还被引用；PiProcess 的事件监听没解绑；断开的连接和订阅没清理；定时器（`git fetch`、重试）没停 |
| 子进程 | 停止、崩溃、宿主退出后 pi 进程或工具启动的子进程残留 |
| client | 退订后 SessionView 的 store 没释放；重连后旧的监听还在 |
| UI | 切换标签、关闭会话后组件和 DOM 节点残留；Shiki、Mermaid 实例重复创建；长会话和流式输出卡顿 |

### 四类测试

**1. 泄漏测试**（`*.leak.test.ts`，跑在第 4 层的真实宿主上，Node 以 `--expose-gc` 启动，单进程串行）

- 同一个操作重复 N 次（默认 200）：打开和关闭会话、订阅和退订、客户端连上和断开、发消息和停止、杀掉 pi 让它自动重启、归档。
- 主断言是**计数回到基线**，结果确定。宿主自己的资源计数之外，还要核对 Node 真实的活动资源（如 `process.getActiveResourcesInfo()` 里的 `Timeout`），否则"计数释放了但 `clearTimeout` 没调"这种泄漏看不出来。计数包括：活着的 PiProcess 和 SessionController 数量、事件监听数、订阅数、定时器数、`process.getActiveResourcesInfo()`、按进程组查到的子进程 PID 都回到操作前。宿主为此在 `platform/` 暴露一份资源计数（测试和日志共用，不为测试另开分支）。
- 关键对象用 `WeakRef` + `FinalizationRegistry` 断言确实被回收：归档会话后反复 `gc()`，它的 SessionController 和 SessionLog 必须消失。每一轮先让出当前任务、再 `gc()`、最后才 `deref()`：`deref()` 会让目标在当前任务结束前保持存活，先查再回收就永远回收不掉（2026-10-07 写客户端泄漏测试时踩到）。
- 堆增长只作辅助断言：预热后每轮取一次 `heapUsed`，线性回归的斜率不超过阈值（初值每次 1KB），阈值放宽，避免误报。
- 有疑点时写出堆快照（`v8.writeHeapSnapshot`），用 Chrome DevTools 的 Memory 面板看引用链。

client 也做同样的测试：订阅和退订 1000 次，store 数量回到基线，SessionView 被回收。

**2. 界面泄漏测试**（`e2e/*.leak.spec.ts`，Playwright 驱动 Electron）

- 场景：在几个会话间来回切换、打开再关闭长会话、流式输出后切走，各重复 N 次。
- 通过 CDP 强制垃圾回收后，在场景前后各取一份堆快照，比较"已脱离文档的 DOM 节点"按名称的数量（`findDetachedDomLeaks`）；任何增长都算泄漏，断言为空。React 组件卸载后仍被引用时，它的 DOM 也会留下，所以同样能抓到。
- 场景里的每一步都要等界面真正变化后再做下一步：Chromium 会合并来得太快的变化，不等就等于没跑完场景。

**3. 性能预算**（`e2e/*.perf.spec.ts`，取多次运行的中位数）

| 场景 | 预算（初值，实测后校准） |
|---|---|
| 冷启动到能输入 | ≤ 2 秒 |
| 打开 1000 轮的会话到首屏 | ≤ 500 毫秒 |
| 50 tok/s 流式输出长 Markdown（表格、代码块、公式）期间 | 没有超过 50 毫秒的长任务；帧时间 p95 ≤ 16.7 毫秒 |
| 切换标签 | ≤ 100 毫秒 |

长任务和帧时间在渲染进程里用 `PerformanceObserver` 采集。超出预算即失败。

- 流式输出那一项在 `e2e/chat.perf.spec.ts`：faux 以 50 tok/s 输出 6 节"表格 + 代码 + diff + 行内与块公式"的长回复。帧时间取相邻两次 `requestAnimationFrame` 的间隔。2026-10-07 在 M 系列 MacBook 上实测：三次都没有长任务，帧间隔 p95 约 10 毫秒（120Hz 屏）。在渲染里故意每次卡 60 毫秒，测试会报出 67 毫秒的长任务，失败。

**4. 基准与长时间运行**

- 热路径基准（`*.bench.ts`，`pnpm bench`）：JSONL 分帧吞吐、事件翻译、2000 轮会话的对话记录重建、同步增量应用、平滑揭示。基线按机器保存在不进仓库的 `.bench/` 里，第一次运行或 `BENCH_UPDATE=1` 时记录；之后比较中位延迟，变慢超过 20% 打印警告，只在慢到 3 倍时失败。基准受机器负载影响，不阻塞提交。
- 长时间运行（`pnpm test:soak`）：真实宿主 + faux pi，模拟几个会话交替运行、流式、停止、崩溃、重连，默认 30 分钟（过夜可跑更久）。按时长采样约 60 次（至少间隔 1 秒），记录宿主的 RSS、堆、资源计数、子进程数，输出 CSV；资源计数结束时回到基线、预热后"每次循环的堆增长"小于 1KB 才算通过。按循环而不是按分钟算增长，短时间运行（`SOAK_MINUTES=0.5`）和过夜运行用同一个标准。

### 让这些测试有效

- 每个泄漏测试都要见过失败：故意引入一个泄漏（不解绑监听、不清定时器、不杀子进程），确认测试会报出来。
- 优先断言确定的计数和回收，堆数值只作辅助，阈值放宽；固定种子，串行运行，降低噪音。
- 性能预算失败时保留 trace（Playwright trace、CDP 性能记录），便于定位。

### 临时文件与残留进程

测试自己创建的临时目录，在创建后立刻用 `onTestFinished` 登记清理，测试失败也会删除；不要把清理写在测试体末尾。兜底有两层：

- Vitest 和 Playwright 的全局初始化（根目录 `test-temp-root.ts`）把每次运行的 `TMPDIR` 指向一个新目录，运行结束整个删除；测试启动的子进程（pi、宿主、Electron）继承它。
- 变异测试把 `TMPDIR` 放进 Stryker 的沙箱目录，沙箱结束时删除。超时的变异会被 Stryker 直接杀掉，测试里的清理和上面的全局清理都来不及运行。

测试里启动的替身进程要能自己收场：scripted pi（testkit 里按脚本行为的 pi 替身）发现自己成了孤儿（父进程变成 1 号）就退出，它的孙进程只活 60 秒。这样即使测试进程被 Stryker 超时杀掉，也不会留下一直运行的进程。测试里故意挂住的命令同样要有寿命上限（如 `sleep 25.1234` 这种带小数、按测试进程区分的写法，或有次数上限的循环），不能用 `sleep 4321` 这类长时间的值：M1.2 的全量变异测试中，被打坏的清理逻辑加上被 Stryker 杀掉的测试进程，留下了 59 个卡在 rc 文件里的登录 shell。

教训（M1.2）：一个测试每次留下 64 MiB 的临时目录，变异测试重复跑上千次，把磁盘写满了。

git 场景（testkit 的 `createGitScene`：一个裸远端加一个克隆，`main` 上有一次提交并推送）每个测试进程只真正建一次，之后每个场景复制这份模板，再把克隆的 `origin` 指向自己那份远端（2026-10-10 定）。建一个场景要跑六七个 git 命令、一秒左右，三个 git 测试文件要建约 80 个；复制只要几十毫秒。

测试里跑的 git 一律带 `GIT_CEILING_DIRECTORIES`（testkit 的 `GIT_SCENE_ENV`，指向本次运行的临时根目录），让 git 永远不会往上找到临时目录外面的仓库。教训（M1.5）：变异测试的临时目录在 atrium 自己的仓库里面；超时的测试已经跑了清理、删掉了临时仓库的 `.git`，测试体却还在执行 git，于是 git 找到了 atrium 本身的仓库：切换了分支、移动了 main、留下了测试建的分支和 worktree。下一步就是 `git push`，只因中间一步失败才没推出去。

### 测试里的可执行文件

macOS 在一个新建的可执行文件第一次运行前会先检查它，这些检查要排队：100 个新写的脚本同时运行，中位数要 7 秒、最慢 14 秒；而通过符号链接运行一个已经检查过的文件，中位数只要 37 毫秒（2026-10-05 实测）。所以测试不要每次新写可执行文件：

- 测试用的替身（scripted pi、shell pi）每种内容只写一份，按内容哈希命名、原子写入，放在全局初始化指定的目录里，所有测试进程共用；测试在自己的临时目录里放一个指向它的符号链接，行为通过环境变量传入。
- 全局初始化（`test-temp-root.ts`）在任何测试进程启动前先把它们各运行一次，检查在单进程时完成。
- 这个目录不在每次运行的临时根目录下，所以跨运行复用，只检查一次；变异测试时它在 Stryker 的沙箱里。

教训（M1.2）：几个测试在高并发下时有时无地失败，表现为"pi --version 10 秒没回应"、"停止时 pi 还没启动完就收到了 SIGTERM"，根因都是新写的可执行文件第一次运行被挡住。

### 压力测试

时有时无的失败要靠同时多跑几份才看得出来。`pnpm test:stress [--copies N] [--rounds R] [--project P] [路径…]` 同时跑 N 份（默认核数减一）、连跑 R 轮（默认 2 轮），每份只用一个 worker，最后列出失败过的测试（第几次里失败几次）和最慢的几个测试。新增或改动的测试合并前跑一次，宿主层用 `--project host`。

每份只用一个 worker，是为了让各份测试互相竞争、暴露竞态和时序假设，而不是把 CPU 饿死。教训（M1.4）：13 份 Vitest 各用默认的"每核一个 worker"同时跑，14 核上有约 170 个测试进程，会启动子进程的测试（读登录 shell、跑 pi）被拖慢 30～60 倍，超过 5 秒的默认期限而失败；把期限放宽到 60 秒后全部通过，耗时连续分布在 4～6 秒、没有卡在某个固定值上，说明不是死锁或竞态。改成每份一个 worker 后，26 次全部通过，最慢的测试约 1.3 秒。

### 运行时监控

测试覆盖不到真实使用。宿主每分钟把资源计数、堆、RSS 写进日志；Electron 主进程用 `app.getAppMetrics()` 记录各进程的内存和 CPU。M1.11 自用期间每天看一眼趋势，发现持续上涨就补一个能复现的泄漏测试。

## 命令

| 命令 | 内容 |
|---|---|
| `pnpm test` | 第 1、2 层 |
| `pnpm test:pi` | 第 3 层（需要本机装有 pi）：契约断言，并检查输出和同版本的夹具一致 |
| `pnpm fixtures:record` | 用本机 pi 重录全部夹具，删掉其他版本的夹具目录；提交前审查 diff |
| `pnpm test:host` | 第 4 层 |
| `pnpm test:ui` | 第 5 层 |
| `pnpm test:e2e` | 第 6 层 |
| `pnpm test:real` | 第 7 层 |
| `pnpm test:mutation` | 变异测试（默认增量，`--force` 全量），报告在 `reports/mutation/index.html` |
| `pnpm test:leak` | 泄漏测试（宿主、client、界面） |
| `pnpm test:perf` | 性能预算 |
| `pnpm bench` | 热路径基准，和本机基线比较（`BENCH_UPDATE=1` 重新记录基线） |
| `pnpm test:stress` | 同时多跑几份、连跑几轮，找时有时无的失败（见"压力测试"） |
| `pnpm test:soak` | 长时间运行（默认 30 分钟） |
| `pnpm check` | 格式、代码检查、类型检查、knip |

仓库目前没有 CI，先靠 lefthook 和本地命令；推到 GitHub 后再接 CI。
