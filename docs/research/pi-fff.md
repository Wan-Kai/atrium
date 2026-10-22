# pi-fff 接入可行性调研

> 2026-10-22；M1.11 自用阶段调研。上游按 npm 稳定版 `@ff-labs/pi-fff@0.11.0` 检查，不把 nightly / main 的行为算进稳定版。第1～7节保留接入前的核查与建议；用户随后确认选装，安装及子代理工具选择见第8节，规格以 SPEC-0002 为准。

## 结论

**有接入价值，优先作为 pi 侧的可选搜索工具试用，不宜直接宣布取代 Atrium 的文件搜索。** 它提供的是给模型调用的文件 / 内容搜索，以及 pi TUI 的 `@` 补全；不是可直接放进 React 的搜索组件。稳定版默认额外注册 `fffind`、`ffgrep`，不覆盖内置工具；`tools-only` 模式最符合先验证工具收益的范围。`override` 会改变 `find` / `grep` 的语义，建议另行决定。[S2][S3]

接入前重点确认：Atrium 的只读子代理工具白名单、每个会话独立索引的资源成本、停止响应、工作区外搜索，以及是否复用用户 Neovim 数据库。已另做当前 pi 的隔离注册与搜索测试，详见第6节；不能只凭 README 的“无需子进程 / 本地运行”就当成零成本或沙箱化。[S3][S6][S9][S11]

## 1. 调研基线与证据

- npm `latest` 为 `0.11.0`，`gitHead` 是 `95fd777c2529fc7b4d7572dabff64cc07268f2c5`；源码仓库是 `dmtrKovalenko/fff` 的 `packages/pi-fff`。其 npm tarball SHA-1 为 `d7d79d75b338bf79b762a3c554ed55d839df51a6`。[S1]
- 下载 tarball（`npm pack --ignore-scripts`），并 checkout 上述 commit。发布包 `src/index.ts` 与该 commit 对应文件 `git diff --no-index` 无差异；其他小文件已逐个阅读，未声称逐字比对整个发布包。
- 上游包声明 MIT；仓库根许可证要求保留版权及许可文字。若以后内置分发，还需一起盘点 `ffi-rs` 和 native binary 的传递依赖，而不是只列扩展自身。[S1][S15]
- pi 相关 peer dependencies 全是 `*`，**这不是所有 pi 版本都验证兼容的承诺**。实际运行兼容性应以本机 pi 版本的隔离测试为准。[S1]

临时资料：`/tmp/atrium-pi-fff-research/package`（扩展发布包）、`/tmp/atrium-pi-fff-research/fff-node/package`（Node SDK 发布包）、`/tmp/atrium-pi-fff-research/upstream`（固定 commit 源码）。未修改用户 pi 设置，未全局安装。

## 2. 实际提供什么

### 模式和工具名

| 模式 | 稳定版默认工具 | TUI 补全 | 是否覆盖内置 |
|---|---|---|---|
| `tools-and-ui`（默认） | `fffind`、`ffgrep` | 尝试挂 FFF `@` 补全 | 否 |
| `tools-only` | `fffind`、`ffgrep` | 不使用 FFF 补全 | 否 |
| `override` | `find`、`grep` | 尝试挂 FFF `@` 补全 | 是 |

`PI_FFF_MULTIGREP=1` 才额外启用 `fff-multi-grep`（override 下叫 `multi_grep`）；代码注释明确说作者近期测试认为该工具有害，正在尝试移除。README 却仍把它写成始终提供的能力。以上按代码，不按宣传表格。[S2][S3]

模式解析：CLI flag > 环境变量 > 全局 `pi-fff.json` > 默认值；恢复会话时，已落入会话 custom entry 的 `/fff-mode` 选择优先于启动设置。进出 override 需要重新加载才能改变注册名称。[S3][S4]

### 参数和行为（源码为准）

| 工具 | 参数 | 关键行为 |
|---|---|---|
| `fffind` | `pattern`；可选 `path`、`exclude`、`limit`、`cursor` | 模糊 / glob 路径搜索；多词 AND；默认每页 **30**；按原生相关度 / frecency / git 状态排序；弱匹配只给少量样本 |
| `ffgrep` | `pattern`；可选 `path`、`exclude`、`caseSensitive`、`context`、`limit`、`cursor` | 默认 **20**；根据正则元字符和 JS 正则可解析性自动决定 regex / literal；默认 smart-case；无精确结果时可能再做 fuzzy 搜索并标明；拒绝 `.*` 等匹配一切的模式 |
| `fff-multi-grep`（显式启用） | `patterns`；可选 `constraints`、`context`、`limit`、`cursor` | literal OR；默认20；没有普通 grep 那样的工作区外 `path` 路由 |

grep 上下文最多20行、普通 grep pageSize 最多50、每文件最多200个匹配，单行输出先 trim 再截至500字符。游标存在扩展进程内的有界 Map（各最多200条），不是持久化恢复能力。[S3]

**不能视作 rg 的逐项替代：** 默认 smart-case、自动正则、无精确结果时 fuzzy 回退、结果排序、分页和输出裁剪都会改变行为；显式固定到某个文件且零命中时，fuzzy 回退甚至会放宽到整个 picker（源码注释为避免文件名写错）。README 的 `literal` / `ignoreCase` 参数、100 / 200 默认数均与本版源码不符。[S2][S3]

稳定版已完整查看的 `src/index.ts` **没有 bash 改写、`tool_call` 拦截或自动把 `rg` 转成 FFF 的 hook**；它靠额外工具与 promptGuidelines 引导模型使用，不会让既有 bash 命令自动加速。[S3]

### UI 边界

- 模块运行时仍 import `@earendil-works/pi-tui` 的 `Text`、宽度计算等，用于 TUI renderCall / renderResult；`tools-only` 也不能据此删掉 TUI peer dependency。[S3]
- `@` 补全只调用可选的 `ctx.ui.addAutocompleteProvider`；不存在这个方法就跳过。它没有注册浏览器 UI，也没有为 Atrium 自己的输入框提供 RPC 文件搜索 API。[S3]
- `/fff-health`、`/fff-rescan`、`/fff-mode` 通过 `ctx.ui.notify` 输出；健康报告包括索引文件数、git、数据库与扫描情况。Atrium 当前不会把这些普通通知显示给用户，见第7节。[S3]

## 3. 运行、索引和资源

### 生命周期

`session_start` 解析配置、注册最终工具、创建主 picker 并等待扫描；未触发该事件的 SDK 使用有 `before_agent_start` 兜底。`session_shutdown` 销毁 finder / auxiliary pool 并清轮询计时器。`ensureFinder` 用 Promise 合并同进程的并发初始化，避免重复持有 native DB 锁。[S3][S5]

Node 下使用 `@ff-labs/fff-node`，失败才尝试 Bun SDK；Bun 下相反。模块 Promise 在 `globalThis` 缓存以避免 reload 反复加载 native graph。两种 SDK 都是 package dependencies，不是只在目标 runtime 安装其中一个。[S1][S7]

### 索引不是轻量无状态查询

每个 picker 是独立 native 实例，内部后台扫描、文件监听、内容索引 / mmap cache；默认开启 watch、mmap cache 和 content indexing。扩展只设置 basePath、AI mode 等，**没有暴露 cache budget / 关闭 watcher 的配置**。主索引之外，对工作区外路径有最多3个常驻 auxiliary picker；空闲5分钟后在下一次 acquire / size 时清理，不是独立定时立即过期。[S5][S6][S8][S9]

因此一个会话一个 pi 进程时，同工作区多个会话仍会各自扫描、监听、缓存；上游 LMDB 的进程内共享池不等于跨进程共享文件索引。这是源码结构推导，不是已测得的 Atrium 内存数据。[S6][S8][S9][S11]

native 内容缓存预算按仓库文件数自动选择128 / 256 / 512 MiB和文件数上限；这是可缓存内容的预算，**不是已经分配的 RSS，也不是整个 pi 进程内存上限**，更不能把该预算当成扩展性能实测。[S12]

### 等待和取消

- 创建后 `waitForScan(15_000)`：Node SDK 每50ms轮询，超时返回 `false`；扩展未检查该结果，所以15秒后可能拿不完整索引继续用，后台扫描还在进行。不能把15秒称为完整索引保证或全部初始化总耗时上限。[S5][S8]
- 三个工具只在 execute 开头检查 `signal.aborted`；等待初始化以后未再次检查。Node 的 grep / search 通过同步 FFI 调 native，没有把 AbortSignal 交下去。普通 grep传10秒搜索预算，可能还有第二次 fuzzy 搜索；不是可随时中止的异步操作。[S3][S8][S10]
- LMDB 打开在 native create 内，先于异步 scan 等待；native 源码自己注明首次 write lock / GC 可能挂住。扩展的“创建失败则退回无数据库模式”只处理已返回的错误，不处理 native 调用不返回。[S5][S11]

**建议的验证重点：** 多会话冷启动、停止时延、工作区删除 / 归档、强杀后 DB 重开、索引途中 shutdown、超大树和 symlink。不能把源码存在 destroy 当成这些泄漏 / 竞态已被证明不存在。

## 4. 本地数据、安全和安装

### 扫描范围

- `/` 默认禁止，`$HOME` 默认允许并警告，`followSymlinks` 默认 true。禁用 home 只拦“picker 根就是 HOME”的情况，不等于建立用户目录访问沙箱。[S3][S4][S6]
- `fffind` / `ffgrep` 的绝对路径、`~/`、`../` 可启用工作区外 auxiliary 索引。不存在 / glob 路径会向上找已存在祖先，所以拼错路径可能触发更大范围扫描。[S6]
- native walker 有 `.gitignore` / ignore 规则及非 git 根的大目录排除，但 ignore 与代码文件启发式不是凭据访问控制；不能认为搜不到任何密钥。symlink 可以把扫描引到工作区外。[S13]
- 扩展源码没有网络请求、shell 执行、telemetry 或凭据逻辑。**这不代表完整 native binary 已经过安全审计；搜索结果仍会作为工具结果进入模型上下文**，不是“源码永远不会离开机器”。[S2][S3]

### 数据库不是 OS 级只读

路径逐个按以下顺序解析：显式 CLI > env > 全局配置 > 已存在的 Neovim frecency / query DB > pi agent 目录下 `fff/{frecency,history}`。默认可能自动选中用户 Neovim 数据。[S3][S4]

README 说“only reads these databases”，准确范围应是：扩展没有调用记录自己搜索 / 选择的 `trackQuery`，不主动把 agent 查询写进 Neovim 历史；**不是 DB 文件绝对不改动**。native 会创建 DB / lock、首次创建 sub-database、清 stale reader、启动 frecency GC；打开时发现 `data.mdb` 超 cap 甚至直接删 `data.mdb` / `lock.mdb`（frecency cap12MiB，query cap8MiB）。因此试用应明确设置独立 DB 目录，不要直接复用 Neovim 的库。[S2][S3][S11]

使用标准 LMDB locking、MDB_NOTLS、默认1024 reader slots，支持同进程相同路径共享 Env，且有暂态 reopen 重试；不能据此断言多进程共享 DB 一定冲突或一定安全。应实测真实 Atrium 多进程并发、异常退出与重开，尤其不要把 native 锁挂住等同于能捕获的 JS 异常。[S11]

### Node / 原生依赖

`fff-node@0.11.0` 声明 Node `>=18`，通过 `ffi-rs:^1.0.0` 加载平台 dylib，而非在每次搜索时起 Rust CLI。optionalDependencies 提供 `darwin-arm64` 和 `darwin-x64`，也提供 Linux / Windows / Android 平台包。模块从 npm 平台包查找二进制，开发树才回退本地 target build；没有运行时自动下载逻辑。[S8][S14]

已查看 pi-fff、fff-node、fff-bun 和本机适用 binary 包 manifest：无 install / postinstall 脚本；`ffi-rs` 当前解析候选 `1.3.7` manifest 也没有 install / postinstall。可以在临时目录先用 `npm install --ignore-scripts` 安装依赖供隔离测试，仍必须保留 optionalDependencies。**安装不运行脚本不等于加载 native binary 没有执行代码**。`ffi-rs` 是范围依赖，单锁 `pi-fff@0.11.0` 不能固定整条供应链，正式接入需记录 lockfile 的实际解析版本。[S1][S14]

以上只是 manifest / loader 的兼容前提，不是已在所有 macOS / Node 版本测试通过，也没有证明 Electron utilityProcess 可直接加载。按 Atrium 现架构继续让系统 Node 的 pi 子进程加载，更少跨 Electron ABI / 打包边界。

## 5. 后续验证与尚未确定

以上上游部分基于发布包及固定 commit 静态检查；第6节单独记录真实 pi 测试。仍不能把这些证据扩大为：

1. 比 rg / fd 快多少、节省多少 token（需真实任务 A/B，计入扫描和常驻成本）。
2. 所有 pi 版本及 reload 均兼容（当前1.3.0的启动注册 / override已测，reload未测）。
3. Atrium 自己的 `@`、文件树、文件打开能力能自动得到 FFF 后端。
4. Atrium 只读子代理能直接使用额外工具。扩展确实会调用 `setActiveTools`，但主 agent 的真实 pi 1.3.0 隔离测试已确认 `--tools` / `--exclude-tools` 仍生效，**没有白名单绕过**；是否给只读子代理开放这些搜索工具，仍需宿主显式配置。[S3]
5. 泄漏、停止响应、多会话数据库并发、工作区归档和真实工作区外边界已经通过验收。

## 6. 隔离实测（2026-10-22）

环境：macOS arm64、Node `22.23.1`、pi `1.3.0`、插件 `0.11.0`。在 `/private/tmp/atrium-fff-smoke` 用以下命令安装；运行时另设空 HOME、`PI_CODING_AGENT_DIR`、XDG目录和 `PI_OFFLINE=1`，不读取日常凭据、不发模型请求：

```sh
npm install --prefix /private/tmp/atrium-fff-smoke \
  --ignore-scripts --legacy-peer-deps --no-audit --no-fund \
  @ff-labs/pi-fff@0.11.0
```

本机安装6个包，包括适用的 `fff-bin-darwin-arm64@0.11.0`、`ffi-rs@1.3.7` 及其平台依赖；不需要 Bun。确实加载并执行了 native binary，不只是检查注册表。

| 实验 | 结果 | 证据范围 |
|---|---|---|
| `tools-only`，单文件 fixture | `ffgrep` 返回 `hello.ts` 第1行，`fffind` 返回同文件；正常退出，无 stderr | 真实 pi 注册与 native执行；见下方探针说明 |
| `override` | active names 是 `grep/find`，搜索结果正确 | 同上；不是旧 grep 参数兼容测试 |
| `--tools read,bash,grep,find,ls` + tools-only | active names严格保持这5个；FFF工具未激活 | 没有被扩展的 `setActiveTools` 绕过 |
| `--exclude-tools ffgrep,fffind` | 两个FFF工具均未激活 | 显式排除仍生效 |
| 两个RPC进程、同cwd / 同独立DB | 两边搜索成功，frecency / query tracker均active，退出0 | 一次小样本；不证明长期并发 / 崩溃恢复 |
| 原包经临时 settings 的 `packages` 自动加载，不用探针 | 三个RPC进程都识别本worktree为git目录，各索引1614个文件，健康命令 `handled`；退出0、无stderr | 证明不必改Atrium启动代码就能沿pi的包发现机制加载 |

**探针限制：** 前五项由临时 `probe.ts` 包装原扩展工厂，在正常注册时保存工具定义，然后通过测试命令直接调用其 `execute`；没有模拟模型回复，未覆盖完整 `tool_call` 事件链和 Atrium 界面。最后一项直接加载未包装的原包，通过 `/fff-health` 验证自动发现与初始化。不能把这些称为 Atrium 端到端验收。

临时脚本 / 原始结果：`probe.ts`、`run.py`、`results.jsonl`、`autoload.py`、`autoload-results.txt`，均在上述临时目录。另取过一次启动后3秒的RSS快照和无扩展对照；两组只取单次快照，无法排除GC和运行阶段差异，**不据此报告内存增量或速度收益**。未跑生产测试套件、性能A/B、泄漏或取消延迟测试。

## 7. 对 Atrium 的具体判断

本项归属 **M1.11自用候选工具调研**，对应 SPEC-0001 需求4的工具过程展示、既有第三方扩展兼容边界；不扩大需求10为通用插件UI，也不提前建设路线图明确后置的通用插件系统。

以下是调研时的接入前基线，不把第8节随后实施的子代理限制倒算成原有能力。

| 想获得的能力 | 能否直接获得 | 接入前代码依据 |
|---|---|---|
| 主会话 / work子代理用FFF搜代码 | **可以，先可选安装即可** | [session-manager.ts](../../packages/host/src/sessions/session-manager.ts)只追加自带扩展及身份/工具参数，没有关闭pi的包发现；第6节实测自动加载 |
| 显示调用参数与结果 | **可以，沿用通用工具展示** | [history/tools.ts](../../packages/pi/src/history/tools.ts)对未知工具返回空专用details；[turn-layout.ts](../../packages/ui/src/chat/turn-layout.ts)显示工具名和参数，结果走已有输出展示；不继承插件TUI renderer |
| 新增工具也并入“探索了代码库”的摘要 | **不会自动发生** | 同文件 `EXPLORE_TOOLS`只认识 `read/grep/find/ls`；可独立小改，不阻塞先用 |
| explore / advise子代理用FFF | **默认不行**（tools-only） | [agent-launch.ts](../../packages/host/src/sessions/agent-launch.ts)、[agent/words.ts](../../packages/pi/src/agent/words.ts)的白名单没有 `fffind/ffgrep`；带上下文时[extension.ts](../../packages/pi/src/agent/extension.ts)的refusal同样会拦。要开放须同步这两条路径及提示词 |
| Atrium输入框的 `@` 变成FFF | **不行，需要另设计和适配** | 当前[文件搜索](../../packages/host/src/files/file-search.ts)是宿主执行fd，限定工作区、可取消；pi RPC的 `addAutocompleteProvider`是no-op，终端补全不会传到React |
| `/fff-health` 等在窗口里可见 | **命令可调用，但通知当前不显示** | SPEC-0001[对话框协议](../specs/0001-mvp1-single-session-chat.md#协议细节2026-10-07-定)约定单向通知只记日志；不能靠这个命令让用户看见健康状态 |

pi 1.3.0还将旧 `@sinclair/typebox` 导入映射到宿主提供的 `typebox`（本机 `dist/core/extensions/loader.js`、`virtual-modules.js`），本次无需补装peer；`tools-only`不会调用TUI绘制函数，搜索逻辑在RPC正常运行。pi官方[扩展文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)、[包机制](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)和[RPC UI边界](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md)可作背景，精确兼容结论只覆盖本次实装版本。

### 建议的最小接入路线（尚未执行）

1. **先用现有pi安装机制选装稳定版**，不复制源码到Atrium、不增加Electron native依赖、不改宿主协议。安装命令是 `pi install npm:@ff-labs/pi-fff@0.11.0`；它会修改用户pi设置，需用户决定后才执行。新启动的Atrium会话沿pi规则加载；已运行会话不自动生效，也不为此中断它们。
2. 在实际agent目录的 `pi-fff.json` 设 `mode: "tools-only"`，给 `frecencyDbPath` / `historyDbPath` **指定独立绝对路径**，避开默认复用Neovim库；先设 `enableHomeDirScanning: false`、`followSymlinks: false` 缩小扫描范围。这是试用范围取舍，不是安全隔离；此配置也会影响同一agent目录下的终端pi。Atrium当前普通配置编辑器未开放 `pi-fff.json`，不能承诺已有设置面板能编辑它。
3. 先在主会话 / work子代理比较真实代码探索任务：搜索命中率、工具轮数、token、连同冷启动的总时长和多会话资源。不默认启用multi-grep，不默认override，保留bash/rg作为精确搜索退路。
4. 证明有收益后，再决定是否给explore/advise加入两种工具名和摘要分类；先改SPEC-0002、安全约定和覆盖表，再补真实pi工具限制 / 历史展示回归。更改 `@` 后端是另一项设计，不借此调研直接替换fd。
5. **若要随Atrium默认内置**，先验证取消、6个子代理加主会话的多进程成本、临时catalog pi的额外索引、归档 / 删除worktree、异常退出和重开、泄漏；同时锁完整native供应链并盘点许可证。静态看到每个 `session_start` 都建picker，意味着短启查询模型的pi也可能额外扫目录；本次未专门验证PiCatalog。

最终建议：**可以接，先作为pi侧可选的模型搜索工具试用；暂不默认内置，不替换输入框 `@` 或文件树。**

## 8. 用户选装与子代理限制（2026-10-22）

用户确认“主代理和子代理都安装”，并选择：**子代理关闭原搜索工具，新工具保留 `fffind` 这样的独立名字，避免混用。** 因此不是 override，也不只给只读角色加工具：所有 agent 开的子代理都停用旧独立 `grep/find`，主代理选择不变；保留 `read/bash/ls`，不封锁 Bash 内的搜索命令。方案写入 SPEC-0002“角色与限制”和安全文档。

### 已执行的日常安装

- `pi install npm:@ff-labs/pi-fff@0.11.0` 已成功；`pi list` 确认用户级包路径为 `~/.pi/agent/npm/node_modules/@ff-labs/pi-fff`。原设置备份在 `/private/tmp/atrium-fff-install-backup.wepkXq/settings.json`，没有修改其他包声明。
- 新建 `~/.pi/agent/pi-fff.json`：`mode: "tools-only"`，数据库绝对路径为该agent目录下 `fff-trial/frecency` 和 `fff-trial/history`，`enableHomeDirScanning: false`、`followSymlinks: false`。不复用Neovim数据，也不使用工作区共享配置。新pi按自身规则加载；未对任何现有会话执行reload、停止或重启。
- npm安装时报告2项high，审计定位在**原有** `pi-mcp-adapter` → `@modelcontextprotocol/client`，不是此次FFF依赖。未执行 `npm audit fix` 或顺带升级。原始审计保存在上述备份目录的 `audit.json`；对应 GHSA-6qxp-vccf-f47h、GHSA-6prh-2h8m-c8cw。

### 新限制的实际验证

在独立HOME、agent目录和工作目录里，加载**已安装的原版FFF包**、当前源码Atrium扩展和仓库faux模型，不用包装FFF工厂或直接调用execute。验证主代理、explore、advise、work、带上下文式explore/work参数，以及保留旧名声明专测扩展防线的work，共7种参数场景：

1. 假模型确实声明并调用 `ffgrep/fffind`，原生后端返回fixture里的文件与匹配行。
2. 子代理参数排除旧名，旧 `grep/find` 调用返回工具不存在；只测扩展防线时，旧调用返回要求使用FFF名字的错误。
3. 主代理保留原选择；脚本请求结束后，7个pi全部退出0。

脚本和事件保存在 `/private/tmp/atrium-fff-live-check/`。此验证经过真实pi的模型→工具→结果事件链，但角色/启动参数由脚本构造，**没有从Atrium窗口实际派出子代理**；真正分叉历史与界面验收另按现有测试链执行。没有发起真实模型付费请求。

代码更改、回归结果和未完成项见 [测试追踪表](../testing/coverage-map.md#pi-fff-选装与子代理专用搜索工具m111-自用2026-10-22)。日常插件安装已生效于新pi；当前已安装的Atrium应用尚未更新到本分支的子代理限制；用户已选择“稍后更新”，本轮保留4个现有pi会话，不安装或重启应用，不把源码完成当成已替换应用。

## 来源

链接固定到本次检查的发布 commit；npm registry 记录用于确定发布内容和依赖。代码与 README 不一致时以上文源码观察为准。

- [S1](https://registry.npmjs.org/@ff-labs%2fpi-fff/0.11.0)：扩展 npm 发布元数据、tarball、依赖、peer、license。
- [S2](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/packages/pi-fff/README.md)：扩展 README；安装、模式、宣称、配置。
- [S3](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/packages/pi-fff/src/index.ts)：完整扩展入口；工具 schema / 执行、注册、模式、UI、取消、生命周期。
- [S4](https://github.com/dmtrKovalenko/fff/tree/95fd777c2529fc7b4d7572dabff64cc07268f2c5/packages/pi-fff/src)：`config.ts`、`paths.ts` 的配置校验与 DB 路径。
- [S5](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/packages/pi-fff/src/file-picker.ts)：AI mode、数据库失败回退、scan 等待。
- [S6](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/packages/pi-fff/src/aux-finders.ts)：工作区外索引、路径路由、pool / TTL。
- [S7](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/packages/pi-fff/src/sdk.ts)：Node / Bun 加载和 reload 缓存。
- [S8](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/packages/fff-node/src/finder.ts)：create 默认、实例独立、destroy、scan 轮询。
- [S9](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/crates/fff-core/src/file_picker.rs)：native 扫描、watcher、缓存与共享状态结构。
- [S10](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/packages/fff-node/src/ffi.ts)：同步 FFI 搜索路径。
- [S11](https://github.com/dmtrKovalenko/fff/tree/95fd777c2529fc7b4d7572dabff64cc07268f2c5/crates/fff-core/src/dbs)：`env_pool.rs`、`lmdb.rs`、`frecency.rs`、`query_tracker.rs`；另见 [native create / destroy](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/crates/fff-c/src/lib.rs)。
- [S12](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/crates/fff-core/src/types.rs)：ContentCacheBudget 的 repo 自动预算。
- [S13](https://github.com/dmtrKovalenko/fff/tree/95fd777c2529fc7b4d7572dabff64cc07268f2c5/crates/fff-core/src/walk)：walker；另见 [ignore.rs](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/crates/fff-core/src/ignore.rs)。
- [S14](https://registry.npmjs.org/@ff-labs%2ffff-node/0.11.0)：fff-node 发布 manifest；另见 [binary loader](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/packages/fff-node/src/binary.ts)、[fff-bun manifest](https://registry.npmjs.org/@ff-labs%2ffff-bun/0.11.0)、[ffi-rs manifest](https://registry.npmjs.org/ffi-rs/1.3.7)。
- [S15](https://github.com/dmtrKovalenko/fff/blob/95fd777c2529fc7b4d7572dabff64cc07268f2c5/LICENSE)：MIT 许可全文。
