# 测试与代码质量

> 2026-10-04 定。工具版本是当时 npm 上的最新版，搭骨架时（M1.1）固定下来。

测试的两条核心要求：**覆盖面全**，并且**每个测试都有效**，能测出真实问题。下面的工具、分层和规则都是为这两条服务的。

参考：Paseo 的 `docs/testing.md`（本地源码 `~/.cache/paseo-src`），它的原则和这里一致；pi 的测试在 `packages/coding-agent/test/`。

## 工具

| 方面 | 工具 | 说明 |
|---|---|---|
| 测试框架 | Vitest 5 | 单元、集成；浏览器模式（`@vitest/browser-playwright`，真实 Chromium）跑组件测试，组件渲染用 `vitest-browser-react` |
| 端到端 | Playwright（`@playwright/test`） | 用 `_electron.launch` 驱动真实的 Electron 应用 |
| 属性测试 | fast-check 4 | 随机生成输入找边界情况；也用它的 `commands` 做基于模型的测试 |
| 变异测试 | Stryker 10，命令运行器 | 往代码里注入 bug，检验测试能不能抓住。Stryker 的 Vitest 插件靠 Vitest 的 provide/inject 激活变异，这在 Vitest 5 上失效（所有变异都会"存活"），所以改用命令运行器：每个变异跑一遍 Node 测试层（`vitest.mutation.config.ts`），没有逐测试覆盖分析，全量约 2 分钟 |
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

## 让每个测试都有效

1. **变异测试是硬门槛**。核心模块变异分数 ≥ 80%：事件翻译、对话记录重建、会话控制器、同步、状态派生、分帧、合并判定，以及连接层（鉴权、静态文件、WebSocket 服务、协议编解码、客户端连接）。连接层列入是因为 M1.1 的变异测试在这里找出了真实缺陷（握手超时后仍处理 hello、关闭时被暂停的下载挂住），而且它是安全边界。存活的变异逐个处理：补测试，或在代码里用 `// Stryker disable next-line <变异类型>: <理由>` 说明它与原代码等价或不可达。平时增量跑改动的文件，每个里程碑完成前用 `pnpm test:mutation --force` 全量跑一次。
   - 时有时无的测试会让变异分数虚高：偶发失败被算成"杀死了变异"。M1.1 时日志流有竞态，分数显示 93%，修掉竞态后真实分数是 78%，补测试后才到 100%。
   - 超时也算"检测到"。启动真实子进程的测试在高并发下会变慢，Stryker 把变慢判成超时，分数同样虚高（M1.2 时一个只改日志文字的变异被记为超时）。所以并发固定为 4；看结果时留意超时数，超时的变异要能说清楚为什么会让测试卡住。
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
- 关键对象用 `WeakRef` + `FinalizationRegistry` 断言确实被回收：归档会话后反复 `gc()`，它的 SessionController 和 SessionLog 必须消失。
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

测试里启动的替身进程要能自己收场：fake pi 发现自己成了孤儿（父进程变成 1 号）就退出，它的孙进程只活 60 秒。这样即使测试进程被 Stryker 超时杀掉，也不会留下一直运行的进程。

教训（M1.2）：一个测试每次留下 64 MiB 的临时目录，变异测试重复跑上千次，把磁盘写满了。

### 运行时监控

测试覆盖不到真实使用。宿主每分钟把资源计数、堆、RSS 写进日志；Electron 主进程用 `app.getAppMetrics()` 记录各进程的内存和 CPU。M1.9 自用期间每天看一眼趋势，发现持续上涨就补一个能复现的泄漏测试。

## 命令

| 命令 | 内容 |
|---|---|
| `pnpm test` | 第 1、2 层 |
| `pnpm test:pi` | 第 3 层（需要本机装有 pi） |
| `pnpm test:host` | 第 4 层 |
| `pnpm test:ui` | 第 5 层 |
| `pnpm test:e2e` | 第 6 层 |
| `pnpm test:real` | 第 7 层 |
| `pnpm test:mutation` | 变异测试（默认增量，`--force` 全量），报告在 `reports/mutation/index.html` |
| `pnpm test:leak` | 泄漏测试（宿主、client、界面） |
| `pnpm test:perf` | 性能预算 |
| `pnpm bench` | 热路径基准，和本机基线比较（`BENCH_UPDATE=1` 重新记录基线） |
| `pnpm test:soak` | 长时间运行（默认 30 分钟） |
| `pnpm check` | 格式、代码检查、类型检查、knip |

仓库目前没有 CI，先靠 lefthook 和本地命令；推到 GitHub 后再接 CI。
