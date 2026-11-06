# 测试追踪表

> 每条需求、关键流程、错误路径和安全要求，对应到证明它的测试。规则见 [testing.md](../architecture/testing.md#让覆盖面全)。
>
> 新增行为时在这里登记；一个里程碑完成前，它涉及的行都要有测试，并通过变异门槛。"待 M1.x"表示计划在该里程碑补上。

## T1 worktree 加固（SPEC-0006"工作区"，2026-11-04，待验收）

真的 git、真的仓库（testkit `createGitScene`），仓库里埋真的钩子、过滤器和 fsmonitor（`plantTraps`，每个被执行就留一个标记文件；`testkit/git.test.ts` 先证明裸 git 会触发它们，所以"没出现标记"不是陷阱本来就没响）。

| 行为 / 风险 | 验证 |
|---|---|
| 新建工作区、新建子对话的 worktree 不跑 `post-checkout` 钩子、smudge/clean 过滤器、`process` 过滤器、`core.fsmonitor`；只有用户全局配置里定义的过滤器也不跑 | `workspaces/worktree-creator.test.ts` "hooks, filters and fsmonitor" |
| 宿主的 `git commit`、`git merge` 同一组参数，不跑 `pre-commit`、`post-commit`、`post-merge`、过滤器；对照：裸 git 会跑 | `workspaces/safe-git.test.ts` |
| 配置遍历：每个过滤器（含名字带点的）四条命令；没有名字的 `filter.smudge` 不算；git 不在仓库里时报错 | `safe-git.test.ts` `safeGitOptions` |
| 有 `include.path`、`includeIf`、`config.worktree` 里的 include、名字带 `=` 的过滤器时拒绝，不建分支不建目录；子对话也拒；无 include 或只有用户全局的 include 照建 | `worktree-creator.test.ts` "a repository that includes other configuration" |
| 起点固定：起点分支（或父工作区的 HEAD）在 `worktree add` 前被移动，仍从核对时的提交建；建完 HEAD 不等于起点报 `head_mismatch`、留目录、不登记 | `worktree-creator.test.ts` "the start" |
| `.worktreeinclude`：只复制被忽略、未跟踪、列出的文件；不跟随链接；`node_modules` 跳过；不覆盖；不写出新 worktree 的链接；`.worktreeinclude` 是链接时不用；10 MiB 边界、64 MiB 总量、500 个文件；跳过只记个数不记路径 | `workspaces/worktree-include.test.ts` |
| 新建工作区和子对话都带上 `.worktreeinclude` 的文件；子对话读的是父工作区的目录 | `worktree-creator.test.ts` ".worktreeinclude" |
| 任务锁：加锁、同任务重复加锁、解锁、不动别的任务或用户的锁、`git worktree list` 的锁原因解析、启动时只清已结束任务的锁 | `workspaces/worktree-lock.test.ts`、`worktree-list.test.ts` |
| 归档遇到任务锁：`workspace_in_task`（带任务 id），目录和会话都不动；用户自己的锁仍由 git 拒绝（`worktree_remove_failed`） | `workspace-archiver.test.ts` |
| 恢复归档的 worktree 同样不跑钩子、过滤器、fsmonitor；仓库配置有 `include` 时拒绝，标记保留 | `workspace-archiver.test.ts` |
| 界面说法：`worktree_config_unsafe`、`head_mismatch`、`workspace_in_task`；错误码进协议和 Swift 投影 | `ui/state/new-workspace.test.ts`、`ui/app/workbench.browser.test.tsx`、`protocol/envelope.test.ts` |

- 破坏检查：`docs/testing/t1-worktree-break-check.json`。
- 没做：加锁、解锁、启动清锁还没接到任何流程上（T1 里没有任务）；不关 `merge.<名>.driver`、`diff.<名>.textconv`（T5 已评估：驱动关掉，`textconv` 不用，见 T5 一节和 security.md）。

## T3 任务核心（SPEC-0006"状态机""调度器""改图"，2026-11-04，待验收）

`packages/host/src/tasks/`：类型、`GraphValidator`、`Scheduler.step`、`TaskStore`；开发入口 `pnpm task:replay`。全是纯函数加文件，不起 pi。

| 需求 / 风险 | 验证 |
|---|---|
| 状态机每条转移、调度器每条规则：就绪与汇合、`node_done` 结算与提交顺序、`no_done` 提醒一次再失败、五种失败、`held` 与 `stopped` 分开、暂停恢复、重跑沿用 attempt、打回（旁支一起重置、attempt+1、`backFrom`、上限 2）、取消、放弃、问题 / 改图等待、批准 / 拒绝、human 节点与合并（`merging`、`merge_blocked`、再点通过重试）、工作区 `none→creating→ready` 与失败、`work` 独占、6 个名额、宿主重启 | `tasks/scheduler.test.ts`、`scheduler-resources.test.ts`（表驱动 85 项） |
| SPEC 列的六种交错：兄弟失败后重跑、暂停后恢复、合并冲突后改图加节点使 human 回到 `pending`、打回时旁支重置、一个 running 一个 waiting 时第三个失败、`stopped` 期间批准改图 | 同上，用例名里带原文 |
| 性质（随机图 + 随机事件序列，含同一事件送两次、迟到的旧 attempt）：`work` 在跑时没有别的节点在跑；`stopped` 的任务不起新节点；打回不超过 2 次；同一 attempt 不重复 `start_node`（重跑后除外）、`creating` 时不重发 `ensure_workspace`；任务状态与节点状态一致（另写一份状态表对照）；任何状态下合作式操作都能走到 done；另有名额、依赖、`endedAt` | `tasks/scheduler.prop.test.ts`（fast-check，400 + 500 次游走；`scheduler-model.ts` 放生成器和不变量；另有固定种子的"覆盖"测试，保证游走真的走到打回、保持、合并等动作） |
| `step` 纯：不改传入的任务（测试里深度冻结）、同一输入同一输出、不适用的事件原样返回 | `scheduler-resources.test.ts`、`scheduler.prop.test.ts` |
| `GraphValidator` 每条规则一个通过、一个不通过：结构（20 个上限、重复 id、未知节点、环、打回边、起点终点）、字段（agent / human / `merge`）、不属于项目、只读规则、启动后（不能删、不能改、入边锁定） | `tasks/graph-validator.test.ts`（27 项） |
| `TaskStore`：追加事件、`task.json` 快照、重开读回；截断的最后一行丢弃并补齐换行；中间坏行报错；`task.json` 缺失 / 损坏 / 落后 / 超前时从事件重建；事件串行；无效事件不写入；重放得到同样的动作（动作带 node + attempt，供 T4 认"已做过"） | `tasks/task-store.test.ts`（23 项） |
| 三个示例事件文件重放结果 | `tasks/fixtures.test.ts`；`dev/task-replay.test.ts`（输出格式、目录 / 文件、截断行、错误码） |

- 破坏检查：`packages/host/src/tasks/tasks.break-check.json`，32 处全部抓到（六条性质各至少一处，另有表驱动、`GraphValidator`、`TaskStore` 的）。
- 变异测试：`pnpm test:mutation tasks --force`（新组 `tasks`，`types.ts`、`test-support.ts`、`scheduler-model.ts` 不算）：scheduler.ts 84.90%（单独跑 86.04%）、graph-validator.ts 89.67%、task-store.ts 85.31%、advance.ts 93.45%、status.ts 90.20%、graph.ts 80.42%、draft.ts 80.00%、replay.ts 92.59%、texts.ts 90.91%。`dev/task-replay.ts` 不在变异组里（构建入口，测试直接调 `main`）。
- 没做：`TaskRunner` / `TaskService` / 动作幂等的真实认出（T4）；`archive_*` 事件在 `Task` 里无处记（T5）；冲突文件列表不在事件里。

## 新建 worktree 同时生成中文名（M1.11 自用后补充，2026-10-28）

用户确认全部新增入口，显示选 `prototypes/worktree-chinese-name-prototype.html` 的 A“中文单行”：英文分支/目录不改，中文名只存工作区 `alias`，已有 worktree 不回填。协议 29；手机类型和往返夹具已重新生成。

| 需求 / 风险 | 验证 |
|---|---|
| 一次 AI 调用生成中英文名；固定分支不被模型改写；JSON/fence/旧英文回复；独立清理中文、16 码点、汉字和控制字符 | `workspaces/branch-namer.test.ts`，新增测试先红后绿；素材以固定前缀 JSON 走 stdin；超时参数 15 秒沿用 OneShot |
| 模型优先级、错误不带内容、取消后不再起 pi、close 中止并等待清理 | `branch-namer.test.ts`；真实 pi 超时/进程管理沿用既有 `pi/src/oneshot` 测试，不声称新增真实模型测试 |
| 两个创建入口单次登记别名；扫描抢先记录不覆盖非空手动名 | `worktree-creator.test.ts`、`projects/project-service.test.ts`，三文件最终 98 项通过 |
| 字段跨协议 / client / router / index 不丢；固定分支保留 | `protocol/worktree-names.test.ts`、`envelope.test.ts`、`client/atrium-client.test.ts`、`server/router.test.ts`、`sessions/index-commands.test.ts`，新增接缝均见红 |
| 手动空/带上下文子对话传名称和父模型；agent 传首任务及选定模型 | `session-manager.test.ts`、`agent-relay.test.ts`；Electron `children.spec.ts` 验证 fork 和 agent 新 worktree 的中文侧栏、英文悬停及真实分支 |
| 自动分支 / 手填 / 仅图片均命名一次；重试保存 alias（包含 null），跨项目 / 手改分支丢旧名 | `ui/state/new-workspace.test.ts` 48 项通过；新增关键行为见红并做破坏验证 |
| 侧栏 34px 单行中文，悬停英文；手填分支命名失败不误说随机 | `app/new-workspace.browser.test.tsx` 31 项通过，新增浏览器测试见红；原型明暗、长名、失败截图已查 |
| 冷模型查询不能拖住关闭；子对话命名在途关闭不创建分支、不误记崩溃；资源归零 | `worktree-names.host.test.ts` 两例先红后绿：不推进 120 秒期限先断言关闭完成；第二例挂住一次性命名，复现 DOMException 被记 error 后改为预期 CommandError。均无意外 warn/error，不把失败后的清理推进当通过依据 |
| 创建后重启中文名保留，英文分支/目录不变 | `apps/desktop/e2e/new-workspace.spec.ts` 两旅程；连同 `children.spec.ts` 共 8 项通过 |

最终验证：`pnpm check`、构建通过；单元 4301 项通过；宿主全量 243/243。宿主首轮 241/242，其中未改动的 `changes/checkout.host.test.ts` 15 秒超时，单文件 36/36 后，含两项新关闭回归的全量 243 项通过，保留首轮失败记录。UI 两次全量均 1162/1163，既有状态栏“opens a row…”失败，单文件各自 28/28 通过，不报整套 UI 全绿；本功能浏览器 31/31 通过。Node 泄漏 20/20；`pnpm test:ios` 的 Swift 402 项及模拟器 UI 测试通过（首次因 RoundTripTests 的旧版本 28 断言失败，改为 29 后复验）。Xcode 输出 debugger-version 诊断但退出码 0。破坏检查最终复跑宿主核心 18＋接线 9＋UI 3，30 处全部检出。另将 Electron 自动命名夹具的 alias 改成 null，准确在中文侧栏断言见红，恢复原文件后 1/1 通过（hash `2815e1c4` 前后一致）；最终正向两文件 8/8 通过。

改动行变异（未改阈值、配置或添加 suppress）：UI 100%（70 Killed / 0 Survived / 0 Timeout；57 缓存、13 本轮执行）；shared 87.50%（14 Killed / 2 Survived / 0 Timeout，存活为 JSON.stringify 会省掉的 undefined 字段）；host 2/2 Killed，命名箭头删掉的首轮被无关 session-manager 不稳抢先检出，独立重测后确实在新增冷查询回归中因没有命名进程失败，保留两轮证据。

Git 组首轮 158 Killed / 8 Timeout / 24 Survived，补测后 180 / 5 / 5，围栏定向复测再检出 3 项。父按文件、精确位置、mutator 和 replacement 独立合并第二轮与末轮原始 JSON，得到 183 Killed / 4 Timeout / 3 Survived（另 8 个既有 Ignored，不进分母）。末轮 `retrySurvivors` 删掉三个范围外存活，不能引用最新 HTML 的 100%；完整口径保留它们。三项存活为 split 空项兜底和两处被后续/真实 GitRunner 覆盖的取消守卫；四项 Timeout 未确认根因、不计检出。仅 Killed 为 183/190＝96.32%；父进一步查出其中一项 Killed 是删除 `closing.abort()` 后在取消等待处测试超时，虽有直接因果，仍保守不给超时信用，采用 **182/190＝95.79%**。所有 Killed 有失败输出，未以无日志状态补造因果。原始证据保留 `/tmp/atrium-worktree-names-git-mutation{,-second,-fence}.log`、`-second.json` 及 `-summary.json`；原报告不改判、不删存活。

审查按用户决定只跑 GPT-6 Astra / Grok 4.7，Claude 已由用户停止、无审查结论。冷模型查询关闭等待、子对话取消误报 error 已先红后修，两方限定复核无阻断；接口表、领域模型、关闭副作用文档已补齐，旧重试沿用快照已明确并补测试。相邻既有“在途 agent 模型查询被主动取消后仍可能记 error”不纳入本功能修复，保留为边界。

`pnpm boundary`：依赖、URL、环境变量、隐藏命令无新增；协议 28 → 29；未登记 0、非精确依赖 0、改动副作用矛盾 0。无本 worktree 的开发/测试/Stryker 进程、`.tmp` 或 `.stryker-tmp` 残留。

未运行整套桌面 / 全套桌面泄漏、真实模型套餐冒烟、打包安装；不访问真实项目数据、`~/.atrium`、凭据或剪贴板。原型仅在独立浏览器任务空间打开。2026-10-28 用户要求“合并并提交”，按验收通过处理；功能提交 `7e1a87f` 已本地合回 `main`，不安装、不推送。合并前 `main` 没有前进，分支同步应答 Already up to date；重新通过 `pnpm check`、单元 4301、完整 UI（`--maxWorkers=1`）1163/1163，以及完整非泄漏 Electron 套件 71 项（其中 `log-gate.spec.ts` 是 `test.fail()` 声明的预期失败自检，整套退出码 0）。这不抹去此前默认并行 UI 的状态栏失败或证明其根因已解决。原分支/worktree 仍有当前会话的 pi 和 Xcode DTServiceHub 以它为 cwd，故安全保留，不终止用户进程、不强删。

## UI受控诊断（c710d51；不是正式回归或旧失败结案）

Q0/Q1/Q2/C0/C1/C2各一次通过，前置Q0选例错误未执行主体，原记录保留。C1/C2按精确身份链证明运行中步骤与闲时来源行/同批两项均为合法呈现，原“必须两个source-line”判据过强；原children测试尚未修，历史67/68根因不能直接归入此例。Q均无增长但没有红绿对照，且录制、环境有差异，不抹旧ask-user失败。父核hash/最小元数据，未复跑或重算已删原堆；Opus单路只读审计的来源边界已补。诊断代码未纳入默认收集，不登记为新增正式用例，见 [实验记录](ui-controlled-diagnostics.md)。

## 手机整合父复验（376e1b5，2026-10-27）

父独立 check/build、远程 unit 52 / host 76 / leak 2、完整 host 240 / UI 1100 / Node leak 20 通过。新 QR 删除作者初稿的 120 秒覆盖后，按默认 60 秒与未配置页、启动失败、vault 串行 **7/7**；未重跑作者 QR 两项负控。

完整 unit（4 workers）4186 过 / 1 个原 Git 场景 5 秒超时；最小环境隔离的完整非泄漏 Electron（1 worker）67 过 / 1 个双子代理来源行失败，同环境仅一次定向 1/1 不抹全套失败。外层 macOS sandbox 的另一次完整尝试因大量启动/renderer 失败报告 7 过 / 61 失败，不能混成产品成绩；没有放宽 Electron 自身安全设置。旧 appearance / ask-user 泄漏失败仍未解决。完整命令、隔离边界、原始日志与只读诊断见 [整合记录](mobile-integration.md)。`d49fbbb` 新变异已单次完成并经父独立核数，详见下节；旧局部 70% 保留为 `7b88613` 历史，当前完整守卫10项均检出，不由普通测试推算。

## Electron ready 失败清理（作者基线 8a0a936）

`apps/desktop/e2e/launch-failure.spec.ts` 包装 Playwright 公共 launch，取得真实 App/ChildProcess 后注入 firstWindow 失败，不 mock launchApp。三个场景：自建 home 的进程退出且目录删除；existingHome 进程退出而 caller sentinel/目录保留；真实 close 完成后额外抛错，AggregateError 按顺序保留 ready/cleanup 两个原始错误。测试外层无论断言如何都调用已保存的原 close 并删除自己创建的目录，独占单 worker，不访问用户保险箱或钥匙串。

旧实现 3 红（exit 1，`/tmp/mp3b/launch-red.log`）：自建场景同时证明进程仍活、home 仍存在；existing 场景进程仍活；第三项不存在 cleanup 错误聚合。修复后 3/3 通过（exit 0，`launch-green-final.log`），desktop typecheck/scoped lint/format 通过。中间一次验证因 Playwright close 后 app.process() handle 已销毁而失败（`launch-green.log`），改为关闭前保存真实 ChildProcess，未修改期望值。`pnpm build` exit 0（`qr-build.log`）。修复只覆盖已取得 App 后的 ready 阶段，不扩大到 electron.launch 自身拒绝；成功 close 流程不变，existingHome 不擅删，清理错误不吞掉。active QR 的独立证据见下节，不由启动清理回归推导。

## MP3b available QR · 真实 Electron（作者基线 8a0a936）

`phone.leak.spec.ts` 在原未配置 case 外增加 available QR：正式 App/宿主、loopback 生产 relay、隔离 faux pi；测试进程动态 fake safeStorage 先验引用/往返，文件仅不透明合成标记，不触 native 加解密、不称 Keychain 实测。真实分类点击及 Meta+, 不自动取消/确认；CDP 仅记白名单元数据，逐次核对订阅/退订应答、原 pairingId/期限。2 轮预热＋20 轮后 detached DOM 无增长，原未配置 case 失败 trace 保留，只有 QR test type 关闭采集。

以下作者正向、负控与恢复后 2/2 对应 `455620a`，**含初稿预设的 120 秒 QR 覆盖**（没有因失败加时）；父默认 60 秒结果单独列于上节。正向通过；临时持有真实 QR DOM 在原堆断言检出 2→22 增长，临时丢弃 watch:false 在原协议断言检出缺少退订成功应答（两次 exit 1）。两次按原始字节恢复、SHA-256 一致后，完整该文件单 worker **2/2、exit 0**。App/faux/快照目录清理完成，relay 资源归零；所有收尾错误保留而不覆盖主错误。静态检查通过。初次 describe 内覆盖 worker 采集选项失败不计负控；改为 test.extend 独立配置，无产品修改。日志、精确恢复 hash、未测分支见 [MP3b 记录](mp3b-settings.md#electron-active-qr-与启动失败资源边界作者基线-8a0a936)。不覆盖 SAS/已配对手机在线/真实钥匙串/MP4，也不泛化到父会话后续组合树。

## 四路整合 · Mac 手机设置窗口资源（2026-10-26）

`apps/desktop/e2e/phone.leak.spec.ts` 使用真实 Electron、打包的宿主 / UI 与隔离临时 home，远程访问保持默认关闭。两轮预热后取 GC 堆快照，再做 20 轮“打开设置 → 手机 → 关于 → 手机 → 关闭”，对比 detached DOM 无增长。正向 1/1 通过；临时在页面里保留真实 PhoneSection 节点后，同一堆断言真实失败（非启动或编译失败）；核对 SHA-256 恢复精确源码，再次 1/1 通过。所有已启动后的异常路径关闭测试 App、删除测试快照目录。首轮错误使用已配置页标题导致选择器失败，修成未配置页的真实标题；未修改产品或减弱堆断言。日志与边界见 [整合记录](mobile-integration.md#桌面资源验证计划)。

此项不冒充活跃配对 / QR 的 Electron 堆验证，也不代表全部桌面泄漏已通过；该次未配置页验证时，活跃状态仍只有浏览器资源回归，后补证据单独列于上节。该次没有启用远程访问、填写 relay 凭据或操作真实钥匙串。
## MP3a d49冻结版两个整文件强制重测（2026-10-26 UTC）

原六文件/remote测试集/1runner×2worker/30000+1.5/80%不变，仅一次exit0，dry-run通过、前后冻结校验无漂移。清除link+service全部1142历史结果；实际1169项的Stryker分类为1008K/160S/1T＝86.31%（不计T仍86.23%），RelayLink整文件90.12%、RemoteService85.26%；这些分类不等于每项都有完整失败证据。完整checkPong10/10＝100%，采样65/72＝90.28%，close30/31＝96.77%，setState7/7＝100%，C并集37/38＝97.37%；预先固定的独立范围均≥80，不拿累计91.09%遮盖。

原1142中1127重新识别，13跨改写＋2无当前生成身份不计Killed，另42当前新/改写变异单列。1754已强制重测仍Timeout，其变体可达空数组同步不终止循环；报告无现场栈，按实际分类＋静态因果披露。70个Killed含测试/hook截止，另2个独立错误候选逐ID审计；898附带缺warn门禁失败、1505附带ENOTEMPTY保持未解释，不用来充当检出证据。45个精确归属本轮sandbox孤儿SIGTERM后复核0，未动其他lane/cache。

追加只读核对全部1008个fresh K：997项有FAIL/失败汇总/错误标题，恰有11项service K只有空计数输出，无法确认崩溃/bail/截断/断言失败，不由静态可抛错补造现场因果。保留全分母、仅不计这11项检出的敏感性计算：fresh85.37%、service84.06%；连T也不计为85.29%/83.95%。不是新测试成绩或改判，原JSON不变、不增加Survived/ignore；11项不在四个固定区间。父独立核对哈希、计数、身份映射和证据缺口；Opus只读核对固定120项状态，并核C区间7条测试超时及898/1505/1754的因果，不代表父或Opus逐项认可全部70条测试超时。

全部旧报告保留，无重试/加时/新豁免；160存活继续计入，直接修复范围8项逐条说明。详见 [d49分层报告](mp3a-d49-mutation.md) 与 [失败审计](mp3a-d49-failure-audit.md)。其他四文件分数仍为历史缓存，没有本轮全量/GUI/Swift/平台钥匙串验证或用户验收结论。

## MP3a RelayLink 公开终态回调重入修复（独立授权C）

真实socket、onState(error)同步retryNow/stop两项原生产红，确认旧close提前结算新waiter并多挂retry timer。仅两处重排：终态已有waiter先结算，再通知；backoff先安装，使通知内retry/stop可取消。公开回调所有权已写overview；不是Electron UI故障复现。

relay-link32/32；复验远程宿主76、相关单元52、远程泄漏2全部通过（单worker）。738/740/742三个原本正确守卫精确负控＋三个真实修复逆转负控共6/6，资源/socket/client/FakeClock归零；原742阻塞解除，未伪造代次。定向格式/lint/host类型通过，首次lint问题已整改且无抑制。完整红绿、次序、重复ready与backoff观察见 [后续定向验证](mp3a-late-diagnostics-and-traffic.md)。未跑新Stryker或全量，不推算新分数；旧70%仍保留为冻结版历史。

## MP3a traffic 仅可见数值变化时推送（冻结版后，B）

SPEC订阅边界同步为整个设置窗口、SettingsPanel唯一owner；仅采样timer按可见设备down/up实际差异推送，离线仍可见，blocked/删除计数不触发；保留2秒衰减、初始get及普通状态即时通知，无新增订阅/协议/暂停采样机制。

idle原实现红（3次重复）、恢复旧推送路径使稳定速率断言红，中间隐藏设备3场景红后补可见性。新增宿主10、远程宿主总76、相关单元49、远程泄漏2均通过，单worker；新负控14/14＋既有unwatch负控1/1，定向格式/lint/host类型通过。旧空闲必推单测按新契约改断言，保留资源验证；初次lint条件断言问题已整改。独立只读审查无阻断。没有运行新Stryker、全量或UI，没有性能测量；结果与证据见 [后续定向验证](mp3a-late-diagnostics-and-traffic.md)。

## MP3a 迟到诊断保护补测（冻结版后，A阶段记录）

真实socket与公开stop/retryNow边界新增停止后诊断不变/无迟到通知，强化当前代成功、失败、恢复仍更新；29/29，精确738/740负控2/2，socket/client/计时器/资源关闭归零，定向lint/格式/host类型通过，生产未改。742的公开新代测试发现真实onState(error)同步retryNow重入问题：旧close提前结算新retry并多起timer；当时按授权停下，未修实现、未伪造私有代次、未豁免742。后续独立授权C已修复并完成742负控（见上）。证据与后续边界见 [迟到诊断与traffic记录](mp3a-late-diagnostics-and-traffic.md)。未启动新Stryker，不推算分数。

## MP3a 审查后冻结版变异复核（7b88613，2026-10-26 UTC）

保持原范围/测试集/超时/80%，单runner×双worker只执行一次，exit 0、dry-run通过。强制失效原477全体及vault整文件缓存；实际693项623K/70S/0T＝89.90%，原远程范围当前472项430K/42S＝91.10%，诊断整文件93.78%、vault整文件87.33%。原477逐身份映射465项，另12项改写不计Killed；原1638现在明确Killed。含缓存总分90.61%只作背景。

**仍有局部未达标：预先固定的RelayLink.#checkPong审查区间7K/3S＝70%**；三个迟到结果守卫尚未证明等价，不以总分遮盖。pong100%、vault分类/版本保护区间89.52%。29个Killed含Vitest测试/清理超时，逐项对照源码及日志说明因果；9个Stryker Timeout全为旧缓存。16个本轮sandbox孤儿经精确核对后SIGTERM，剩余0。没有重试、扩大超时或新增豁免。

完整成绩、原cohort账、局部缺口、失败审计和证据位置见 [冻结版变异报告](mp3a-postreview-mutation.md)。该冻结版本尚未包含设置窗口订阅文案与 traffic 无变化推送的后续窄修，不能声称被本次结果覆盖；后续已实施，另见上方 A/B/C 与父组合复验。没有运行全量/UI/Swift/真实钥匙串或用户VPS。

## MP3a 协议 27 存活项定向补测（2026-10-26）

不改生产代码，不跑 Stryker/全量。诊断分类、初态、异步 lookup、首个失败及 AggregateError、真实 TCP/70KiB/压缩边界、watch 通知与真实手机 offline 均补了观察；live+4401 明确 token unknown，只有后续 connect ready 才取得新认证结果。纯受控分类与真实 socket 证据分开，没有把人工错误事件说成平台故障。

定向单元 77、宿主 19 全过（单 worker）；精确原变异负控检出旧 99S 中 51 项、旧 Timeout 1638，另 1 条新语义负控通过，共 53 项。3 项旧错误状态分支已被先前修复替代，余 45 项未逐条消除／复验；不推算新百分比、不新增 ignore。1638 受控失败是额外 timer／重复通知，清理约 24ms/11ms、资源归零，未证明历史 Timeout 根因或循环。完整 ID、证据分层和剩余表见 [定向补测记录](mp3a-v27-gap-followup.md)。

## MP3a 保险箱解密错误分类（2026-10-26，审查修复）

固定 Electron 44.5.1／Chromium 152.0.7977.130 静态源码证明：async availability 为 true 也可能缺少可用钥匙串密钥；拒绝只带消息，不带结构化 code。不是平台实测，也没有据此声称真实授权拒绝已覆盖用户文件。

| 行为 | 证据 |
|---|---|
| available=true 但 decrypt temporarily-unavailable 或未知异常，不误报 corrupt；已知高版本退回未知状态，重试写前重读，不允许 version1 或更高新版本绕过失败覆盖原文件 | `apps/desktop/src/main/vault.test.ts` 先 6 红，后 24 项全部通过；假 crypto 刻意保持 encrypt 可用以验证守卫，不伪称系统实际覆盖；同时核对原文件字节、版本、无临时文件、无额外 encrypt |
| 仅精确 native ciphertext 消息及成功解密后的无效 JSON／格式允许显式 reset；近似消息、普通对象 rejection 都保守 unavailable | 同文件表驱动测试，`vault-classification-break-check.json` 8/8 检出；既有 `vault-break-check.json` 5/5 再通过 |
| Electron 升级必须复核消息合同，不依赖错误文本的 includes，不回传原文 | 测试独立写出确切消息，并断言 desktop 依赖仍为 44.5.1；静态依据和升级要求见 security.md |
| 自己的 Electron 测试不再把 hello 写死为 26 | `remote-vault.spec.ts` 从公开 `@atrium/protocol` 引入 `PROTOCOL_VERSION`；只运行类型/lint检查，未启动 Electron。先前两例失败与 `fast tiers unavailable` 仍保留，不报已修复后通过 |

仅改保险箱分类和测试协议引用；无 UI、wire 字段或版本变更，无备份／额外加密探测，无真实钥匙串操作。单 worker 定向验证、desktop 类型及 scoped lint/格式通过；未启动新 Stryker 或全量验证。

## MP3a 协议 27 协调及设置页接缝（2026-10-26）

协调提交 `c709daf` 合入固定 main `ace843a`（已核实祖先关系），解决双方都占用版本 26 却形状不兼容的问题；保留翻译和远程协议并集，新增型号、诊断和握手活动投影，统一为 27。Swift 类型、往返夹具与版本断言同步。以下是新增验证；下节 `c09b54d` 的全量/变异仍为历史记录，不冒充本轮结果。

| 行为 | 证据 |
|---|---|
| 三项投影字段必填，未知型号为 null，诊断区分 unknown/not_applicable/failed，拒绝原始错误字段；保持翻译命令、语言偏好、错误；两翻译命令显式 local_only | `protocol/src/remote.test.ts`、`envelope.test.ts`、`translation.test.ts`、`server/remote-policy.test.ts`；Swift 协议 16 项；`protocol/src/coordination-break-check.json` 7/7 检出 |
| 型号从已存自报值 trim，空白为 null，不猜硬件，不改保险箱格式 | `test/remote/projections.host.test.ts` 及 `service-security.host.test.ts` 的真实 relay 流程 |
| 多候选、旧 QR、旧连接代次、过期、取消、关闭后灰包消失；不暴露 M1 候选身份，不改业务状态机；晚加入 watcher 得到当前事实，短握手不人为延长 | `projections.host.test.ts`；`remote/pairing.test.ts`、`remote-service.test.ts`；首次 RED 后 GREEN，候选激活通知 100ms 合并，终止清除立即发送 |
| connect/live、关着时 probe、配置/身份/代次变化、probe 取消、旧结果不能覆盖新状态；重试保留已结束快照，重置不能把旧诊断与新指纹一起推送 | `remote-service.test.ts`、`projections.host.test.ts`；投影和重置破坏检查共 14/14 检出 |
| 实际 TCP/地址解析/TLS/HTTP Upgrade/令牌认可证据；不把普通 reset 或总超时归因为无网；正常 CA 验证的 TLS 才通过 | `relay-diagnostics.test.ts` 16 项本地真实请求/服务器：可信测试 CA、未信任证书、主机名不匹配、拒绝连接、受控 resolver、静默 TLS、reset、503、畸形 101、HPE 解析错误、正常 open 后关闭；未访问 VPS，未放宽 TLS |
| request/socket 的七个观测监听在成功、失败、取消后移除；必须履行 finishRequest 的 request.end 责任 | 同上真实 listener 引用核对；先复现 ws 请求错误处理会同步 close，改为 prepend 记录；畸形 101/HTTP 解析回归先红后绿，不重复实现 WebSocket 验证器 |
| 当前控制 socket 的本次随机 16 字节 ping；空/错/旧/常规心跳 pong 不成功且不消耗监听；并发共享、正确 pong 成功、超时不悬空、stop/close/rejection 清理（原测试错误要求探测超时关闭物理连接，审查修复见下行） | `relay-link.test.ts` 真实 socket；先复现任意 pong 提前成功；重复 12 轮核对真实 socket 的监听数与资源；`diagnostics-pong-break-check.json` 20/20 检出（最初两项测试名过滤不匹配，修正后全部复验）；旧三条移动锚点复验通过 |
| 审查修复：单次匹配 pong 缺失不 terminate 控制、不伪造生命周期 error、不踢已认证手机；常规心跳仍能收到 pong，下一次新 payload 可成功，真实 close/4401 仍断手机 | `live-probe.host.test.ts` 本地选择性 pong 代理＋真实 relay＋真实 Noise 手机，先红后绿 3 项；`relay-link.test.ts` 的公开状态/控制消息/监听及计时断言同步纠正。定向单元 39、真实 relay 64 通过，原破坏清单调整后的 20 项＋恢复两处误断链的 2 项全部检出；未启动新变异 |
| 错误码字面量不冒充环境变量；显式 env 读取/解构/对象键仍受检查，未知相似前缀不豁免 | `scripts/boundary.test.ts` 12 项、7 条破坏检查；只增 11 项精确例外，不新增虚假登记。`boundary --all` 14 URLs / 41 env / 4 commands，未登记 0 |

阶段验证：协议协调阶段定向 200 项、协议类型检查和 Swift 16 项通过；行为补齐后定向协议/路由/远程单元 470 项、真实 relay 61 项通过，随后补强的协议/白名单 25 项再次通过；远程泄漏 2 项通过。最终源码 `pnpm check` 通过。变异仅对五个变更远程文件运行增量，原始报告 `reports/stryker-incremental-remote-close.json` 保留，v27 结果独立写到 `reports/stryker-incremental-remote-v27.json`；`e29e49a` 的运行现已完成，但新执行 477 项仅 79.25%、diagnostics 单文件 75.11%，不能用混合总分 88.31%／宿主汇总 85.96%掩盖不足；之后又修了探测误断链，旧分数不代表修复后源码。详细并发、中断、缓存、失败及证据位置见 [协议 27 验证记录](mp3a-v27-validation.md)，新增变异等待主线安排窗口。

边界与未完成项：完整桌面泄漏、既有 file-search 竞态、既有 Electron quit 重入问题仍按下节保留失败证据，未顺带修改。未做真实钥匙串授权、真机、用户 VPS、打包安装或跨分支人工验收；本轮不是三方正式审查。

## MP3b 桌面手机设置页（2026-10-26）

SPEC-0005 需求 1、配对和撤销；视觉按 design-language「设置 · 手机」。实现决定、协议 27 协调及截图见 [MP3b 记录](mp3b-settings.md)。

| 行为 | 验证 |
|---|---|
| 用户选择：整个设置窗口唯一 watch；非手机分类也接收橙点/relay 错误，切分类不重订，实际关闭清空，配置关闭拦截仍订阅，重开/重连及晚到读取/推送安全；普通导航不改变访问权限或取消配对 | `settings-remote-watch.browser.test.tsx` 4 项（真实 SettingsPanel + 实际 client + 脚本化 socket；配置拦截用 fakeClient）；`phone-section.browser.test.tsx` 的 category navigation 改为只在窗口卸载后退订；保留 client 的代次保护测试 |
| 全部 9 个本机命令的字段、应答和错误传递 | 同上客户端命令用例；浏览器 rename/revoke/reset/relay/pairing 用例 |
| 3900ms 上行汇合、relay 停留、下行分发、各段边界、锁闪烁、固定设备色与 S 曲线 | `remote-map.test.ts` 3 项；浏览器 fake-clock lock 用例 |
| 减弱动态效果不启动动画时钟、静态箭头、最多四台加 +N、完整列表、车道/节点/行三向悬停 | `phone-section.browser.test.tsx` 的 replaces motion |
| 首次启用、钥匙串等待/不可用、保险箱损坏/无 Electron、行内重置确认 | 浏览器 renders vault 参数化用例及 requires inline confirmation |
| relay 掩码替换及重新配对警告、测试连接、保守诊断清单 | 浏览器 saves relay、diagnostic checklist、retryable failures |
| 协议 27 自报型号 / null；connect/live、四类步骤证据、八种安全失败文案、上次检查时间、重试保留、配置清空、原地探测的有限成功承诺 | `remote-coordination.browser.test.tsx` 的 self-reported model、diagnostic evidence、live checks、safe wording 参数化用例 |
| 协议 27 匿名握手：一次灰色往返、快速 true/false 立即清除、换 pairingId 重置、取消、原二维码期限、过期/拒绝/确认后忽略旧活动、Reduce Motion 无动画时钟 | 同上 handshaking、restarts、obsolete activity、unauthenticated request、static handshake 用例；四设备折叠仍由旧浏览器用例覆盖 |
| 审查修复：配对确认弹层型号标注“手机自报，非硬件认证”；空字符串/空白写“未提供”，不从设备名推断 | `remote-pairing.browser.test.tsx` 参数化 3 项，修改前 3 红、修改后 3 绿；`mp3b-pairing-model-break-check.json` 3 处检出 |
| 协议 27 全字段入 store；过期推送优先于旧读取；旧 socket 或退订后的活动不能复活 | `atrium-client.test.ts` 的 projects protocol 27 evidence（真实协议 schema 校验） |
| 审查修复 B：keychain 暂不可用、拒绝后需重启；corrupt 为损坏或密钥不匹配导致不可读；刷新仅被动读取；未知/已知设备数量与两步不可逆 reset 提示 | `vault-guidance.browser.test.tsx` 8 红→8 绿；相关 45 项通过，`mp3b-vault-guidance-break-check.json` 6/6 检出；浅/深色错误与长确认截图见 MP3b 记录 |
| 审查修复 A 及边界纠正：撤销失败目标归设置窗口、按 deviceId 独立；其它动作与分类切换不覆盖；成功仅清本项；关闭、成功 reset 或公开指纹/relay URL/hostId 变化清旧项；同身份换 token 成功或保存失败不清项；旧回调不能复活或清新目标 | `revocation-retry.browser.test.tsx` 当前 8 项（真实 SettingsPanel/client）；新增 token-only 回归先红后绿，`mp3b-token-revocation-break-check.json` 4/4 检出；原 A 的 5 项与 7/7 破坏检查作为历史记录保留于 MP3b 记录 |
| 原地改名与清空恢复、撤销确认、撤销写盘失败仍保留可重试目标 | 浏览器 watches only、saves relay、keeps revoke retry |
| 真实二维码输入和矩阵、5 分钟过期、刷新、SAS、确认/拒绝、另一台手机被拒、完成/失败原因、Esc 不关外层设置 | 浏览器 counts down a real QR、declines a pairing、pairing failure 参数化用例 |
| 断线时配对不能确认但仍可 Esc 关闭；同步重复点击只发一次；失败不乐观授予权限 | 浏览器 lets Escape dismiss、blocks duplicate commands、reports failures |
| 重复打开关闭释放定时器、配对 Escape 监听、watch 与 DOM | 浏览器 frees timers 12 轮、releases pairing 8 轮；另做真实 Chromium CDP DOM 计数 25 轮及人为保留 DOM 的负对照 |
| 明暗真实设置截图 | 浏览器 captures light and dark：`packages/ui/src/settings/.vitest/phone-settings-{light,dark}.png`（自动生成、不提交）；与原型对照记录见 MP3b 记录 |

整个窗口订阅本轮：新增生命周期测试起初 3 红，实现后含资源回归共 4 绿；设置目录定向单 worker 11 文件 / 145 项通过，`mp3b-settings-watch-break-check.json` 8/8 检出。Phone 场景通过真实 SettingsPanel 承载，不在测试里手写 watch owner；原 25-case 清单的两个 owner case 已迁移至窗口入口。

历史验证（原 phone-only 实施阶段，未改写为本轮结果）：`pnpm break-check docs/testing/mp3b-break-check.json` 当时 25 处检出（23+2 分两轮）。客户端增量变异（仅本次新增实现行）72/72 检出；链路动画纯逻辑初跑 102/103，唯一存活是两段三次曲线在 0.5 处相等，注明等价后 101/101。最终相关单元 151 项、界面 37 项通过；随后单 worker 全量界面 1030 项及 Swift 22 项通过。全量单元先前通过，最后单 worker 重跑仍遇其他 Git/boundary 测试超时并在 900 秒被中断，不能算通过，详见 MP3b 记录。

## MP3a 宿主远程模块（2026-10-26）

以下为历史快照 `c09b54d` 的实现与验证记录，不作为当前整合结果：协议 v27、模型、诊断与握手的协调整合仍待完成。

范围：SPEC-0005 的宿主、Noise、配对/日常连接/撤销、远程白名单与大小限制；不包含 MP3b 设置页和 MP4 的快照预算、续传、回执。协议独立提交 `20169cc`（26），后续未改形状。

| 行为 | 验证 |
|---|---|
| IK/IKpsk2、低阶点、畸形密文、nonce、分帧/分块大小与期限、心跳、错误即关通道；TS/Swift 字节级互通 | `packages/remote-crypto/src/*.test.ts`、`test/interop.test.ts`、cacophony 向量与四份互通夹具；64 项 |
| 成功读取必须有 version/data，IPC id 对应、超限写终结、post 失败、写队列拒绝后恢复且不消耗版本 | `host/src/remote/vault.test.ts`、`host/src/electron-port.test.ts` |
| 主进程 safeStorage 异步可用性/加解密、损坏与缺文件分开、版本拒绝、原子文件、清理异常后继续 | `apps/desktop/src/main/vault.test.ts`（15 项；真实文件 ENOTDIR 复现清理失败，不 mock fs） |
| 未启用的本机启动不自动读钥匙串；等待授权时仍能读状态和关闭开关；显式重置损坏；standalone 不可用；晚到读取不初始化已关服务 | `remote-service.test.ts`；`apps/desktop/e2e/remote-vault.spec.ts` 前两例经真实 utilityProcess IPC（不可用场景替换 safeStorage 的 availability，不触发真人授权） |
| relay 地址只对 loopback 用 ws，端口合法；凭据不出状态；ready/ping、指数退避与手动重试、异常控制帧、可取消 probe | `relay-line.test.ts`、`relay-link.test.ts`；后者声明/行覆盖 100%、分支 94.23%（定向覆盖运行） |
| 设备密钥 canonical base64url、id/公钥不重复、名字回退；QR 查询值用 `%20` 而非 `+`，兼容 Swift 百分号解码 | `devices.test.ts`；`service.host.test.ts` 元数据例先红后绿；实际 `xcrun swift -e` 对照 `URLComponents` 的两种输入 |
| 可用码五分钟、确认两分钟、并发确认只能赢一个、到期码/取消/拒绝/确认前掉线/不正确 PSK/版本/保存失败 | `pairing.test.ts`；`test/remote/service.host.test.ts` 启真实本地 `apps/relay` 子进程 |
| 保存成功但 paired 丢失后用 IK 补齐；未知设备拒绝；同公钥重配沿用身份和自定义名；重置先保存再撤销，并废弃排在重置之后的旧配对确认 | `test/remote/service.host.test.ts` |
| 撤销立即断全部通道，保存失败仍拉黑、可重试；正在保存的确认不能解除后来撤销；撤销→排队确认→再次撤销不能绕成新 id | `service.host.test.ts` 三种 gated vault 撤销交错；后两种先复现再修复，分别以删除 `?? acceptedDevice` 和已撤销 id 的幂等门槛作负对照 |
| 最多四个未完成握手、十秒期限；每设备两通道、三十秒静默；待确认配对同样主动探测，成功后移交服务器心跳；流量按真实密文字节、1 秒预热/2 秒窗口、离线历史自然归零 | `service.host.test.ts` 两个心跳用例先红后绿；精确计算 UTF-8＋帧类型＋Poly1305 标签及逐秒窗口；`relay-link.test.ts` 假时钟与真实 socket |
| 手机 hello 无 token 且 clientId 等于 Noise deviceId；九个本地管理命令完整转交；手机管理请求 local_only；事件只推本机 watcher | `server/router.test.ts`、`server/remote-policy.test.ts`；`test/remote/host-connection.host.test.ts` 真实 startHost＋relay＋假手机 |
| 命令/事件全集穷举分类，child 创建拒绝；8 MiB 应答转 response_too_large、事件转快照，仍超限告警丢弃 | `server/remote-policy.test.ts`、`server/connection.test.ts` |
| 数据通道畸形帧、错误密文、分块超时、出站超限、CONNECTING 中止、关闭兜底、独立积压、done/资源真实关闭顺序 | `remote/channel.test.ts` 32 项真实 ws＋Noise；31 项阶段曾测行覆盖 99%、分支 95.65%，最终用整文件变异结果而非这次历史覆盖率验收 |
| 对端发 Close 后保持 TCP 半关闭，宿主结束时仍在 1 秒内完成 done、释放资源 | `channel.test.ts` raw `allowHalfOpen` peer：核对 101、Close1000 回应及 host FIN；原实现 RED（done=false/data=1），修复后 GREEN，恢复 OPEN-only 判断的破坏检查 CAUGHT；不是通过改超时或 suppression 凑分 |
| 已有 A 时未知 B 密钥仍拒；错误版本立即关；错误控制不能确认；撤销/改名 A 不碰 B；真实重建服务恢复 enabled/disabled；本地状态通知与元数据不含秘密 | `test/remote/service-security.host.test.ts` 18 项；`service.host.test.ts` 日志/流量例；不以空设备表下的拒绝代替身份匹配断言 |
| 加密包也进入生产外部边界扫描，测试文件仍排除 | `scripts/boundary.test.ts` 新例先红后绿；定向删除 scope 中的 remote-crypto，破坏检查检出 |
| 资源归零（40 轮配对/连接/撤销；20 轮四通道开关）、probe 挂起时关闭/启用不会晚到挤正式连接 | `test/remote/service.leak.test.ts` 两项；`service.host.test.ts` probe 用 SIGSTOP 控制真实 relay，finally 确保 SIGCONT |

测试辅助实现也验证：`test/remote/harness.test.ts` 9 项；relay 经真实 CLI 子进程登记，强制 loopback。泄漏压力场景把测试 relay 的接入配额显式设为 1000，生产 30/分钟不变；宿主的四流/两通道上限不变。

破坏检查（均已执行、全部 CAUGHT）：crypto 32（`packages/remote-crypto/test/break-check.json`，crypto 子代理）；早期服务器 8、vault 12（`/tmp/mp3a-break/`）；桌面异常修复 5（`apps/desktop/src/main/vault-break-check.json`）；辅助假手机/relay 9（`test/remote/break-check.json`）；远程单元 17＋25（`src/remote/{break-check,extra-break-check}.json`）；真实 relay 18（`test/remote/service-break-check.json`）；排队撤销 2、重置 2（`queued-{revocation,reset}-break-check.json`）；九条路由 9（`router-break-check.json`）；密文流量 3（`traffic-break-check.json`）；日志 14、活性/元数据/QR 5、状态/IPC边界 9、数据通道 34（`src/remote/{log,live-check,state,channel}-break-check.json`）；安全集成 20、配对心跳 3（`test/remote/{security,pair-heartbeat}-break-check.json`）；生产边界 1（`/tmp/mp3a-boundary-break.json`）；TCP 半关闭 1（`src/remote/half-open-break-check.json`）。Electron 前两例另把已构建宿主的 `vault: config2.vault` 改成 `undefined`，两项都失败，恢复后通过；没有用类型错误代替运行时负对照。

**最终源复核（18:27～18:31）**：`pnpm check` 全过；`pnpm test` 单元 **4010**＋Swift **22** 全过；默认并行 `pnpm test:host` **205** 全过（含真实 relay **47** 项）；`vitest run --project leak` 的 Node 全量 **17** 项过；`pnpm build` 过；重建后的 Electron `app.spec.ts`＋`remote-vault.spec.ts` **14** 项过。protocol 与生成 Swift 自 `20169cc` 起无后续改动。

**变异过程和最终口径**：首轮全组 **78.68% 未达标**（宿主远程 71.47%），没有用 crypto 抬平均。按存活项补测后第二轮 **90.09%**；配对等待心跳与 QR 编码修复后第三轮完整基线 **90.11%**，并把不确定的 relay 错误监听 Timeout 实际重测为 **Killed**。分析其中的存活项又复现了上述 CLOSING 原实现缺陷；修复后对 **channel 整文件强制重跑 164 个**，160 killed／4 survived／0 timeout，**97.56%**。Stryker 原生保留范围外的 2061 条真实既有状态（含 20 ignored），最终完整报告 `reports/stryker-incremental-remote-close.json` 的 13 份生产源码均与交付源码逐字一致：全组 **90.07%**（1977 killed、9 timeout、219 survived），宿主远程单独 **87.88%**，crypto **100%**，桌面保险箱 **85.65%**。`devices.ts` 单文件 79.49% 如实保留，门槛按组，未抑制真实覆盖缺口。

219 个存活和 9 个缓存 Timeout 的逐项理由及对账见 [MP3a 变异存活分析](mp3a-mutation-survivors.md)。剩余 Timeout 是分块／心跳回环和设备队列忙循环，不冒称本轮全重跑；crypto 的 437 个检出来自先前独立运行（429 killed、8 timeout），18 ignored 原因在源码。破坏了清理的 Stryker 子测试曾留下 relay 子进程，已按本 worktree 的 sandbox 绝对路径和 PPID=1 精确清理，最终核对为 0；没有终止用户应用或服务器。

**失败和限制如实保留**：一次 `pnpm test:host` 178/179，既有 `files/file-search.host.test.ts` 的“超过 1 MiB”失败：`runFd` 超限只 kill，但进程先退出 0 时仍接受此前 chunks，代码未在本任务修改。后一次与四 worker 变异并跑，178/182，四个既有 git 用例 15 秒超时；空载串行复核 203 项通过，最终默认并行全量 205 项也通过；未改该文件，不删用例或放宽期限。两次 `pnpm test:leak` 的 Node 17 项均过，桌面分别 5/7、6/7：首轮 ask-user 的脱离 DOM（42 个 SVGCircleElement、2 个运行中 span、2 个 SVG）、图片模态拦截下一次点击；次轮 PlantUML naturalWidth 5 秒未就绪。前两项单跑 2/2、PlantUML 单跑 1/1 均通过；尚未确认根因，未改 UI，不把整套桌面泄漏报绿。Electron 的“宿主退出后迟到的钥匙串回答”额外实验正文通过、清理阶段 Close context 超时；诊断确认原 `postMessage` 迟到时静默 no-op，没有未处理拒绝。挂起是既有 quit 重入：`will-quit` 阻止退出后，对已结束的 `host.stop()` 立即 `.finally(app.quit)` 的再次 quit 被忽略；仅延后到 `setImmediate` 的实验通过。未顺带修既有生命周期问题，撤回未提交的防御代码和实验测试，保留原两项已提交的 IPC e2e；详细复现 `/tmp/mp3a-late-vault-diagnosis.md`，恢复后的构建与两项再通过。未访问用户 VPS，未做真机、真实钥匙串授权弹窗或打包安装；MP3b/MP4 不由这些测试代验。

## M1.11 自用中改（2026-10-26）

| 行为 | 测试 | 破坏检查 |
|---|---|---|
| 回复下方信息行自身上下各 4px 外边距（原型 `chat-footer-spacing-prototype.html` 的 A），不改字号、按钮、正文样式和轮容器之间的 24px 间隔 | `packages/ui/src/chat/turn.browser.test.tsx` "gives the reply info row 4px of vertical breathing room" | 去掉 `my-1` 后该用例见红，`CAUGHT` |

验证：新用例先在原实现上失败（实际 `0px`），实现后通过；`pnpm check` 通过；单元 202 个文件 3792 项和 Swift 22 项通过；界面 49 个文件 1003 项通过；`apps/desktop/e2e/chat.spec.ts` 3 项通过；改动测试所在文件 2 份 × 2 轮压力检查通过。另用真实 Electron 和合成数据核对正文到信息行的实际间距为 8px（正文既有 4px 加信息行 4px），看过浅色、深色、长回复、空状态和出错状态截图，未见截断或布局跳动；临时截图用例与产物已清理。`pnpm boundary`：依赖、URL、环境变量、隐藏命令均无变化，协议 25 不变，未登记项 0。只改展示类名，不涉及核心纯逻辑、协议、资源或新依赖，未跑变异、泄漏、性能、浸泡、打包和真实模型测试。

同步 `main` 收尾：四处冲突均保留双方内容，回复翻译及协议 26 原样保留，本任务相对 `main` 仍只有信息行留白、回归测试、文档和原型。`pnpm check`、构建、串行 Node 单元 204 个文件 3854 项、Swift 22 项、界面 51 个文件 1029 项、`apps/desktop/e2e/chat.spec.ts` 3 项通过。默认并行单元曾出现两个已登记的负载敏感 git 超时，相关文件单独 8＋3 项通过，随后串行全量通过；全量界面首轮另有一个 `question-card` 预览用例失败，单文件 20 项及全量重跑通过，未改这个无关组件或放宽断言。

## 回复翻译（M1.11 自用后补充）

用户选 `prototypes/reply-translation-prototype.html` 的 A“原文下展开”：当前会话模型、默认简体中文、设置仅配置目标语言；译文仅挂载组件内保留，不进原对话上下文或磁盘。

| 行为 | 验证 |
|---|---|
| 只接受会话/轮/操作引用，不接受客户端指定正文、模型、语言；操作 id 与结果形状、语言校验 | `packages/protocol/src/translation.test.ts` 三例；`envelope.test.ts` 的命令、错误码与偏好样例；协议 26 |
| 客户端传正确引用与取消 id，语言只在宿主保存后的索引更新中生效，失败不乐观修改 | `packages/client/src/atrium-client.test.ts`“reply translation”两例；`index-view.test.ts` 默认偏好 |
| 当前分支已结束轮的正文与当前模型；只翻译最终正文，不含过程、思考、工具；空、运行中、未知轮拒绝 | `packages/host/src/sessions/session-manager.test.ts` 的翻译来源用例 |
| 一连接一在途请求，按连接取消、重用 id 不串请求、超限和空结果、错误不含原文 | `packages/host/src/sessions/reply-translation.test.ts` |
| 真实宿主与 pi/faux：当前模型与保存语言、无原历史和工具、无译文落盘、失败可重试、取消和断开、宿主关闭清理 | `packages/host/src/reply-translation.host.test.ts` |
| 输出字节上限与不完整 JSON 记录有界、期限与取消释放进程 | `packages/pi/src/oneshot/oneshot.test.ts`；真实 pi 的 `oneshot.pi.test.ts` |
| 原文不变、A 展开/收起复开、失败重试、取消焦点、旧请求和旧取消应答不过期覆盖、源/轮/会话/语言变化和卸载清理 | `packages/ui/src/chat/reply-translation.browser.test.tsx` |
| 目标语言默认中文，限长/控制字符校验；保存中/成功/失败、失败草稿与外部偏好更新，不出现模型选择 | `packages/ui/src/settings/translation-group.browser.test.tsx` |
| 桌面真实调用、原文和会话文件不改、只有语言落盘、重启译文消失；浅/深色截图 | `apps/desktop/e2e/reply-translation.spec.ts` |
| 200 次真实子进程翻译后计数/实际定时器/signal 基线；切换译文页面后 DOM 不增长 | `packages/host/src/sessions/reply-translation.leak.test.ts`；`apps/desktop/e2e/reply-translation.leak.spec.ts` |

功能分支验证（2026-10-26，`79e1fd2`；以下是同步最新 `main` 之前的结果，未安装）：

- `pnpm check`（格式、lint、全包类型、knip、边界登记）与构建通过。单元 **3643**、串行宿主 **164**、串行 pi 契约 **99**、串行界面 **1028** 通过；最后一次构建后重新跑真实 pi 翻译契约 **12**、真实宿主翻译 **6** 通过。完整单元后只把客户端的 `allSettled([...Set])` 按 lint 建议改为等价的 `allSettled(Set)`，客户端 **108** 项复验通过。
- 相关泄漏 **4** 项通过：宿主 200 次成功、50 次取消，客户端 1000 次取消回执可回收，及原有客户端视图回收；桌面翻译旅程与 DOM 泄漏各连续两次，**4/4** 通过。分别故意隐藏构建产物里的翻译按钮、在隔离窗口保留已移除 DOM，桌面测试均红；DOM 负对照明确检出译文 section 从 1 增到 11，恢复后通过。浅/深色的真实 Electron 页面截图已查阅；不把透明侧栏的页面截图当原生材质验收。
- `pnpm break-check` 最终 **60** 处全部 `CAUGHT`：协议/客户端 10、UI 19、宿主原组 14、安全 3、正文来源/边界 7、pi 准备/清理/限额 7。UI 初轮有 1 个漏检，补上等待 Promise 完成后真正提交 React 更新的测试，连同新回归后 19/19；格式化与 UTF-8 代码收敛使两处旧 case 过期，更新精确片段后宿主 14 处重新全过，没有把 case 不执行算检出。
- 增量变异：shared **100%**；host 报告 **99.41%**（回复翻译服务与来源 accessor 都为 **100%**；唯一存活来自误纳入所选行范围的既有 proxy 守卫，未改它）；pi **97.67%**，均无超时。最初 host 来源分支覆盖不足、pi 70.83% 未过，按存活项补了尾部空白/思考/工具/压缩、空正文、精确字节边界，以及真实 FS 准备失败、取消和清理、合法长 JSON、恰好限额与重复 kill 的回归。报告含缓存复用，不把累计 killed 数当本轮新验证量；最后一轮 shared 复用 48/52、host 124/168、pi 63/124；仅非复用、非等价豁免的变异重新执行。pi 余下 3 项：同步 spawn 失败时去掉 guard 存在判断、将 rm 的 force 改 false 都在相同失败路径被 catch，结果等价；停止后仍解析剩余 stdout 的变异只涉及停止窗口内的缓冲工作，现有测试没有区分这项额外工作，保留实现并登记覆盖边界，不作广泛豁免。一次标准 host 变异在工具 600 秒期限被中断，不计通过；之后采用“定向测试先跑，未检出者仍跑完整本组”的临时配置完成，并将整组阶段串行以避免下面的基线不稳。未改项目变异配置或门槛。
- 按用户选择，GPT-6 Astra、Grok 4.7、Claude Opus 5.5 三方只读审查；Astra 指出的斜杠执行、APPEND_SYSTEM、CLI 模糊/合成模型三项阻断均有真实 pi 回归，并经其有界复核关闭。Claude 的取消后立即请求、断线取消提示、文件列表挤在译文前的三项低问题也已修复并复核。未留已知阻断。
- 诚实保留首轮失败：默认全量 UI 的 status-bar tooltip 被指针拦截、宿主 setup 的 1 秒 ready 等待、pi edit-aborted 的 get_entries 时序各失败一次，单文件及随后串行全量都过，登记到 testing.md；没有放宽断言、重录夹具或删除测试。新的桌面泄漏用例曾在首条消息发出前失败，失败快照显示文字仍在输入框（已有 Enter 送出不稳现象）；本能力的两条新旅程改为点击公开的“发送”按钮，不测试键盘快捷键，之后连续两轮全部通过。
- `pnpm boundary`：协议 **25 → 26**；无新依赖、地址、环境变量或隐藏命令；全量登记仍为 URL 13、环境变量 39、隐藏命令 4，未登记 0、非精确依赖 0。翻译 guard 的私有临时文件例外已写进 security 与 pi-internals。

限制与未验证：模型调用期限 60 秒，256/512 KiB 是内存上限，不保证接近上限的回复能在期限内译完；超时保留原文并可重试。只测真实 pi 加 faux，没有调用真实订阅验证翻译质量；未跑全套桌面、性能/压力/浸泡、打包或安装。用户随后明确要求本地合回 `main`、删除对应 worktree，不安装。

### 同步 main 后的收尾（2026-10-26）

同步 `main` 的 `1679b01`（MP0/MP1/MP2 和压缩提示的小猫样式）。只冲突路线图和追踪表的新增段落，保留双方内容；桌面生产代码无冲突。沿用新加入的 Swift 协议投影门禁，为两个新命令补齐结果样例（完整性测试先见红），重新生成 Swift 类型与三份往返夹具。Swift 往返测试把协议版本仍写死为 25，先看到 `26 != 25` 失败，再随本次版本升级明确改为 26；不删除断言、不绕过生成检查。

合并前复验：`pnpm check`（含 Swift 格式/lint 与生成类型比较）通过；串行 Node 单元 **3854**、界面 **1028**、Swift **22** 及模拟器 UI 测试通过；重新构建后的全套桌面端到端 **63/63** 通过（日志门禁的 `test.fail()` 是预期失败，Playwright 汇总仍是 63 passed）。没有手机端翻译入口的新增设计，只同步协议投影；未安装到真机、未替换或重启用户现用 Atrium。按用户要求本地合并并安全删除任务 worktree，不推送。

## MP5 / MP6 界面与渲染零件提前并行（2026-10-26）

`agent/ios-ui-render`，仅交付零件与 Debug 陈列页，不标 MP5/MP6 完成。选型、实测与未完项见 [mobile-render.md](../research/mobile-render.md)。Swift 测试根目录为 `apps/ios/AtriumKit/Tests/`。

| 行为 | 验证 |
|---|---|
| 暖色浅/深 token、拉丁衬线与中文回退、弹簧/0.18秒降级、预览不得撤销系统辅助设置 | `AtriumUITests/DesignTokenTests.swift`；陈列页 colors/type/glass/status 的浅深截图 |
| 5×5、21点涡旋、三档亮度、1.65秒同相位、静态1.15秒 | `VortexPatternTests.swift`；多尺寸图标并排截图 |
| 32×32像素猫、五场景/四姿势、4–6秒动作与精确绝对时间截止 | `PixelCatTests.swift` 与原型导出的17张网格逐格相等；`PixelCatIdleTests.swift`；猫图明暗与 reduced 截图 |
| Turn/Step→过程行、空内容过滤、探索聚合、支线、回复拆分、最终回复前的思考不误标运行中 | `RailRowsTests.swift`（协议JSON夹具）；`RailDetailTests.swift`（全文/输出/探索失败详情/问答摘要不丢） |
| 减弱动态无空间动画、恢复循环、折叠保留插话、等待提问标题 | `RailViewContractTests.swift` 3项为**源结构守卫**；截图不代替运行时动态切换/逐帧验收 |
| 字素安全的150ms积压比例揭示、尾部结束、替换/停顿/组合emoji | `AtriumRenderTests/TextRevealTests.swift` |
| 解析器尾块边界与全文一致、后置引用、缩进、CR/LF/CRLF、不执行HTML/危险scheme、图表源码降级 | `StreamingMarkdownTests.swift`，12组逐Character前缀差分与围栏/安全链接回归；缩进/混合换行/容器闭合均先红后绿 |
| 本地 highlight.js 的常用19种语言名/别名、未知语言降级、嵌套span、转义与原文还原 | `CodeHighlighterTests.swift`，真实 JavaScriptCore 执行 |
| hunk头/行号、前后缺失上下文、长上下文保留边缘并可展开 | `DiffLayoutTests.swift`；diff 明暗截图；缺失行回填交给上层，陈列页不伪造数据 |
| 时间线初始定位/跟随/读历史、未读提示、回到底部 | `TimelineFollowTests.swift`；XCUITest 的1000行 List/LazyVStack基准核对真实尾行存在 |
| 模拟器陈列页、截图、性能样本 | `apps/ios/AtriumUITests/GalleryScreenshotTests.swift`；`TEST_RUNNER_ATRIUM_GALLERY_SHOTS=1 pnpm test:ios`；截图在 `apps/ios/.build/gallery/`，原始附件在 Xcode xcresult |

验证：`pnpm check` 通过；`pnpm test` 最终 **202文件/3792项 TS + 82项 Swift** 通过。首次全量 testkit/git 夹具构造超时1项，单独重跑3/3及第二次完整全量通过，没有改它。两份破坏检查 `Fixtures/{render-break-cases,rail-break-checks}.json` 分别 **24/24、11/11 CAUGHT**（其中3个UI接线守卫不是行为测试）。Swift 暂不接变异工具，遵循 MP1 约定。`TEST_RUNNER_ATRIUM_GALLERY_SHOTS=1 pnpm test:ios` 最终82 Swift + 4 XCUITest通过（0失败/0跳过），26张组件浅深/减弱动态/实色玻璃截图已导出到 `apps/ios/.build/gallery/`；标准 `pnpm ios:shot` 浅深各一次通过。

**性能仍未达验收结论**：macOS Release 96KB解析+转换中位43.86ms，500行TS高亮+转换49.73ms；后台actor，不是主线程数值。模拟器第一轮两容器均有>50ms帧间隔（完整三次数字见调研），暂用List但未证明50ms主线程预算通过。没有真机、Release Instruments trace、长时间耗电/泄漏压力或完整手机连接/发送验收。

### 时间线有界定位与候选（2026-10-26，第四路续）

| 行为/证据 | 验证与边界 |
|---|---|
| 原实现1000行180次更新，每种容器180000次builder、约180次body | Debug `GalleryTimelineStats` 分开计数；峰值时间与主runloop awake区间一起记录，awake不是单个任务或CPU时间。高负载原始数据保留于 mobile-render.md，不用来评判容器优劣 |
| 稳定行引用：内容更新不换整个集合 | `TimelineRowsTests`：先红后绿，180次更新仅180次Row通知/0次集合通知；相同快照无通知、同数重排/替换、移除对象释放。**仅证明观察通知，不等于已复测实际builder次数** |
| 真正布局后才定位；等高更新不重复scrollTo；按住期间的布局在释放后处理 | `TimelineFollowTests`新增layoutTiming/heldFinger两例；指尖按住的原生回调时序未实证。小型UI先抓到Task.yield不足，修后初始/追加定位通过 |
| 高度增长后跟随、历史位置不被追加打断 | `GalleryScreenshotTests.testTimelineUpdatesAndPreservesHistory`：末行增加30段后末端可见；读历史后追加，同一文本y位置差≤2pt且新尾不可见；回底可见新尾。强行在reading时滚到底部的手动负控确实失败，恢复后通过 |
| 定向验证与资源协调 | `TimelineRowsTests|TimelineFollowTests` 9项通过；`timeline-break-cases.json` 8/8 CAUGHT；`pnpm ios:check`通过；非基准`pnpm test:ios` 88 Swift + 3 UI通过，截图矩阵和性能2项opt-in跳过。本轮未再跑全量TS |

移除List `.id`的实验破坏了定位，已经恢复；停止AX轮询未消除长帧，也不认作根因。稳定引用候选**在该轮功能回归时尚未复测真实builder计数/绝对耗时**；16:14～16:44机器load约19～25、其他路宿主变异进行中，按主代理要求停止耗时对比。后续单次窗口见下；真机/Release Instruments仍待做；入口 `AtriumApp.swift` 已交接 ios-connect，本批未改。

### 较低负载单次窗口（2026-10-26 18:43，第四路87c7722）

仅执行一次 `TEST_RUNNER_ATRIUM_TIMELINE_BENCH=1 pnpm test:ios`，实现与夹具不变。18:43:35开始load **3.39/5.04/6.17**，18:46:43结束 **3.26/4.21/5.59**；不是无竞争环境（结束仍有杀毒/Chromium/模拟器进程）。Debug、arm64、iPhone 16 Pro / iOS26.5模拟器。

| 证据 | 结果与边界 |
|---|---|
| List三次实际builder/body | 各 **180000/180**；没有消除List构造扫描。先前180次Row通知/0集合通知不等于实际builder下降 |
| Stack三次实际builder/body | **5376/180、5504/180、5504/180** |
| 全部六次帧/awake | List max **68.58/63.18/73.05ms**，awakeMax **123.60/44.69/53.48ms**；Stack max **63.06/53.53/54.48ms**，awakeMax **54.99/49.17/45.11ms**；p95全部16.67ms，六次各有一个>50ms帧间隔。完整n/maxAt/次数见mobile-render，不挑最优 |
| 80ms忙等待负控 | awakeMax **80.02ms**、最大帧99.14ms，≥75ms断言通过；awake并非单个任务/CPU采样 |
| 功能与测试范围 | **98 Swift、4 UI通过，1项截图矩阵跳过**。七次基准尾行exists均过，但不是hittable；独立40行测试的末端可见/历史y≤2pt/回底断言通过 |
| 结果归属核验 | 明确导出 **Test-Atrium-2026.10.26_18-43-39-+0800.xcresult**，summary及七附件时间全部落在本次启动结束区间；bundle副本、原始附件、命令日志与load在 `apps/ios/.build/timeline-window-87c7722/` |

只提交证据，不改性能实现、不触碰integration worktree。未做同窗旧实现对照、全量TS/变异、截图矩阵；不能归因耗时改善或判定容器胜负。**剩余验证：Release Instruments主线程trace与真机50ms预算**；List进一步定位须另开有界任务。详见 [全部试次与限制](../research/mobile-render.md#较低负载的单次测量窗口2026-10-26-184387c7722)。

### 冻结基线280c087审查修复（第四路）

| 行为 | 真实回归与负控 |
|---|---|
| Markdown只缓存精确UTF-8前缀，规范等价替换不复用旧偏移 | `StreamingMarkdownTests.canonicalReplacements/shorterCanonicalReplacement/appendedCombiningMark`；双向NFD/NFC按字节核对，原短输入实际signal 5崩溃；恢复String前缀判断被检出 |
| 原版高亮入口无损还原实体旁组合符、variation selector、emoji和嵌套span | `CodeHighlighterTests.unicodeRoundTrip` 8组全部先红后绿；实体/结束span各恢复Character语义均被检出 |
| write正文只在协议details时仍完整可展开 | `RailDetailTests.writeContent`，真实JSON args为空、保留末尾空行；错取path而非content被检出 |
| overflow与正常压缩都保留精确token和完整摘要，未知after不捏造 | `RailDetailTests.overflowCounts` 已知/未知两组；丢计数、未知填0均被检出 |
| git零count表示前一行，首缺口与后续缺口完整旧/新坐标正确 | `DiffLayoutTests.zeroContextInsertion/zeroContextDeletion`，hunk头用真实零上下文git输出核实；首缺口、下一old、下一new三个错误分别被检出 |
| 合法围栏的不同开闭缩进不能误报未闭合，仅metadata | `StreamingMarkdownTests.closingFenceIndentation` 32组合原12处红；`fenceContainerBoundary` 独立期望验证引用外新围栏不关闭旧代码、正文末反引号不误闭合、缩进代码反引号保持字面；三项负控全检出。UI尚未消费closed，不声称修了可见故障 |

最终 **48项/8套定向Swift、`pnpm ios:check`通过**；`render-review-break-cases.json` **12/12**，既有render **24/24**、rail **11/11 CAUGHT**。红绿与崩溃记录见 [mobile-render.md](../research/mobile-render.md#冻结基线280c087的独立审查修复) 和本地 `.build/review-280c087/`。缺失上下文的版本匹配只澄清文档，由MP6接线保证；没有新增补读API/改base语义。审查修复这轮未跑全量TS、iOS UI、截图或性能；后续真实builder与单次较低负载测量见上一节，50ms预算仍未证实通过。

## MP1 Swift 工程基础（手机端，2026-10-25～26）

路线图 MP1：Swift 的规范、`apps/ios` 工程骨架、`pnpm protocol:swift` 和往返测试、Swift 进 `pnpm check` / `pnpm test`，破坏检查扩到 Swift（[testing.md · Swift（手机端）](../architecture/testing.md#swift手机端)、[overview.md · iOS 工程](../architecture/overview.md#ios-工程2026-10-25-定mp1)）。

| 行为 | 验证 |
|---|---|
| 协议包导出的每个 zod schema 按导出名、每条命令的结果按 `<命令>Result` 导出成 JSON Schema，`$ref` 都指向包里的名字，带协议版本 | `packages/protocol/src/json-schema.test.ts` 两例 |
| 生成器：对象 → `struct`，必填、可为 `null`、可省略、既可省略又可为 `null`（`Nullable`）、常量字段分开处理；字符串枚举 → `enum: String`；嵌套类型不遮住顶层类型和 Swift 自己的类型，关键字转义 | `scripts/swift-codegen.test.ts`"writes an object as a struct…"、"keeps nested names clear…" |
| 判别联合 → 先读判别字段再分派的 `enum`；嵌套联合按它的全部取值分派；只有常量的成员是不带值的 case；判别字段是字符串枚举时按值展开；布尔判别要给 case 名，没给就报错 | `swift-codegen.test.ts`"writes a discriminated union…"、"names a boolean discriminator's cases…" |
| 没有判别字段的对象联合按"只有它有的必填键"分派；标量联合先试常量；品牌 id 的联合是 `String` | `swift-codegen.test.ts`"tells objects apart…" |
| 可省略的常量（`fork_session` 的 `noteSent`）存成可选值，在时必须是那个常量 | `swift-codegen.test.ts`"keeps an optional constant…"；Swift `CodingSupportTests`"keeps an optional constant…" |
| 不支持的构造（`allOf`、元组、数字常量、分不开的联合、找不到的引用）报错，写明位置；同样的输入输出相同 | `swift-codegen.test.ts`"refuses what the protocol does not use…"、"writes the same output…" |
| `pnpm protocol:swift --check`：提交的 Swift 类型和协议一致时通过；差一行或没有文件时退出码 1，提示重新生成；接在 `pnpm check` 里，没有 Xcode 也跑 | `scripts/protocol-swift.test.ts` 三例；`scripts/ios.test.ts`"still compares the generated protocol types without Xcode…"；手工：给 `WelcomeMessage` 加一个可选字段后 `pnpm check` 退出码 1（"… is out of date with packages/protocol; run pnpm protocol:swift"），改回后 0 |
| 往返夹具和 `envelope.test.ts` 的合法样例保持一致（超过 4096 字符的字符串截成 64 个） | `envelope.test.ts`"Swift fixtures" 两例 |
| 生成的类型能编译（Swift 6、警告当错误、模块依赖检查）；每个客户端、宿主样例解码再编码后和原 JSON 语义相等；按 `type` 分派、未知类型 / 错的常量 / 缺字段报错 | `pnpm test` 的 Swift 部分；`AtriumProtocolTests/RoundTripTests.swift` 五例 |
| 编解码支持：缺省和 `null` 分开、不许 `null` 的地方拒绝、开放字段保留 `null`、`ContextReserve`、`InteractionAnswer`、`JSONValue` 往返 | `AtriumProtocolTests/CodingSupportTests.swift` 七例 |
| 各模块的最小实现：Noise 套件名、配对链接只认 `atrium://pair`、协议版本相同才连、Mermaid / PlantUML 显示原文、首页标题 | `NoiseSuiteTests`、`PairingLinkTests`、`ProtocolCheckTests`、`DiagramFenceTests`、`HomeViewTests` |
| App 在模拟器上打开显示首页标题 | `apps/ios/AtriumUITests/AtriumUITests.swift`（`pnpm test:ios`） |
| `pnpm ios:install`：没配对的 iPhone、配对了但连不上时在构建之前报错，写明设备名、上次连接时间和怎么连；连着时按免费团队构建、装上、打开 | `scripts/ios.test.ts` 三例（`xcrun` 替身）；手工：手机不在时报"katonn的iPhone (iPhone 16 Pro) is paired but not connected (last seen 2026-09-10 09:32 UTC)…"，退出码 1 |
| `pnpm test:ios`：先 `swift test`（警告当错误、依赖检查），再在 "Atrium iPhone 16 Pro" 上跑 UI 测试；没有这个模拟器时在最新的 iOS 运行时上建；没 Xcode 时 `ios:*` 报错退出 | `scripts/ios.test.ts` 其余四例 |
| `pnpm test` 先跑单元层再跑 `swift test`；带参数时只跑 Vitest；单元层失败就停；没 Xcode 时跳过 Swift 照样通过 | `scripts/test.test.ts` 四例 |
| `scripts/swift-lint.mjs`：每个类型、函数、`init`、`subscript` 有文档注释、第一句、`- Remark:`，函数类有 `- SideEffects:`；多行属性、测试、XCTest 的 `test…` 方法、字符串和注释里的文字、生成的代码不算；不安全的并发要 `// Unchecked:`，没人留着的 `Task` 要 `// Fire and forget:`；AtriumKit 的源码不许直接用真实时间 | `scripts/swift-lint.test.ts` 五例 |
| 破坏检查支持 Swift：`runner: "swift"` 跑 `swift test --filter`，Swift Testing 的失败算 `CAUGHT`，改坏后编译不过算 `NOBUILD`（算漏掉） | `scripts/break-check.test.ts`"runs swift test for Swift cases…" |

`pnpm break-check` 共 41 处。TypeScript 25 处：首轮 22 处检出、3 处漏掉；标量联合"先试常量"补了断言，swift-lint 的注释处理补了用例，另一处是 case 指错了测试，改对后 3 处重跑全部检出。Swift 16 处（`runner: "swift"`）：首轮 14/15 检出，漏掉的是 `decodeOmittable` 自己的 `null` 检查。它永远不会生效（`decode` 对没有 `null` 的类型本来就拒绝 `null`），于是连同多余的 `JSONValue` 重载一起删掉，补了"开放字段保留 `null`"的测试，再把这个函数改成 `decodeIfPresent`，检出。Swift 的 case 包括生成的代码（删掉 `ResponseMessage.Success` 编码 `result` 的一行、删掉 `InteractionAnswer` 对 `cancelled: true` 的核对）、编解码支持的每个分支和各模块的判断。变异测试只涉及 `packages/protocol/src/json-schema.ts`（shared 组，`--mutate`）：16 个，首轮 14 杀死、2 存活，都是删掉和 zod 4.6.5 默认值相同的选项，已在源码注明等价，重跑 100%。跑变异时发现 Stryker 复制沙箱时卡在 SwiftPM 的 `.build`（里面有 socket），已在 `stryker.config.mjs` 忽略 `apps/ios/**/.build`。`scripts/` 和 Swift 不在变异分组里（Swift 没有接 Muter，见 testing.md）。

`pnpm check` 通过（含 `ios:check`）；`pnpm test` 单元 192 个文件 3613 项、Swift 19 项通过；`pnpm test:ios` 19 项 Swift 加 1 项模拟器 UI 测试通过；`pnpm ios:build` 真机构建签名通过（团队 `QGZ4G5UJ65`，bundle id `site.ktoon.atrium`）；`pnpm ios:shot` 浅色、深色截图看过。没验证：真机安装和打开（手机不在电脑旁边，只验证了没连时的报错），以及 lefthook 推送前跑 `pnpm test` 的耗时（多了约 10 秒的 `swift test`）。

### 只读审查后补（GPT-6 Astra，2026-10-26）

审查报中 5 条、低 2 条，没有高。每条先写见红的测试，再修，再做破坏检查，各自提交。

| 发现 | 行为 | 验证 |
|---|---|---|
| 中 1 | 生成的文件带整份 JSON Schema（键排好序）的 SHA-256，只改长度、范围这类约束时 `--check` 也失败 | `scripts/swift-codegen.test.ts`"carries a fingerprint…"；破坏检查把 `SessionId` 的 `max(128)` 改成 `max(64)`，`protocol-swift.test.ts` 检出 |
| 中 2 | 每条命令至少一个合法结果写成 `command-results.json`，Swift 按生成的 `commandResultType(_:)` 用各自的类型往返；宿主样例覆盖 `HostMessage` 的每种 `type`（补上了 `credentials_changed`） | `json-schema.test.ts`"names the result schema of every command…"；`swift-codegen.test.ts`"maps each command's type…"；`envelope.test.ts`"examples" 两例；Swift `RoundTripTests`"decodes and re-encodes every command's result…"、"knows no result type…" |
| 中 3 | 文档注释和声明之间可以隔着豁免注释（`// Unchecked:` 等）；豁免注释写在文档注释上面时照样报 | `swift-lint.test.ts`"reads a doc comment above an exemption comment…" |
| 中 4 | 真实时间在 App 本体以外都查（含 AtriumKit 的测试和 UI 测试），确实要时上一行写 `// Real time: <为什么>` | `swift-lint.test.ts`"refuses real time everywhere but the app…" |
| 中 5 | `test:ios` 的模拟器部分和 `ios:shot` 从找模拟器到测完、截完拿着跨 worktree 的锁；别人拿着就等、超时报出是谁；进程不在（含进程号被重用）、或 30 秒没写主人的锁被接管；退出时放锁 | `scripts/ios.test.ts`"ios.mjs simulator lock" 七例；手工：两个 `ios:shot` 同时跑，第二个打出"waiting for the Atrium simulator: pid … is using it"，等第一个截完再截，两个都退出码 0，锁目录清空 |
| 低 6 | 可省略的常量编码时也核对，不是那个值就抛 `EncodingError` | `swift-codegen.test.ts`"keeps an optional constant…"；Swift `CodingSupportTests`"refuses to write an optional constant…" |
| 低 7 | 读输出的 Xcode 调用失败时打出命令、输出和错误；只是探 Xcode 在不在的那次照旧不出声 | `ios.test.ts`"ios.mjs failures" 两例 |

`pnpm break-check` 共 31 处（TypeScript 26、Swift 5），全部检出：指纹 3、命令结果和宿主覆盖 7（含 2 处 Swift：把 `fetch_transcript` 的结果类型换成 `PingResult`、删掉 `noteSent` 的编码）、豁免注释 1、真实时间 3、模拟器锁 9、常量编码 3（2 处 Swift）、失败输出 3。锁的"超时退出"那处改坏后脚本会一直等，跑完查过没有留下 `ios.mjs` 进程。没有改核心模块，没跑变异测试；`json-schema.ts` 多了 `commandResults`，它的测试已覆盖。


### 真机验收时补（2026-10-26）

| 行为 | 测试 | 破坏检查 |
|---|---|---|
| `devicectl` 不给 `reality`、`marketingName` 的配对过的 iPhone 也能装（Xcode 26.6 对刚配对的 iPhone 16 Pro 就是这样，原先误报"没有配对过的 iPhone"） | `scripts/ios.test.ts`"uses a paired iPhone that devicectl describes without reality or a marketing name"、"names a paired iPhone that is away by its product type …" | 两处，都检出 |
| 装上了但手机还没信任开发者时，说明去哪里信任，而不是只转出 `devicectl` 的长报错 | `scripts/ios.test.ts`"says how to trust the developer when the phone refuses to open an app it has not trusted yet" | 一处，检出 |

真机：`pnpm ios:install` 装到 iPhone 16 Pro（iOS 26.6.1），空 App 打开、运行（MP1 完成标准最后一条）。

## 手机端 MP2：relay（SPEC-0005，2026-10-25）

`apps/relay`：SPEC-0005"部署 relay""relay 的线路协议"全部。集成测试起真实的 relay（假时钟、`127.0.0.1` 随机端口、前缀 `/atrium`），用真实 `ws` 客户端当宿主和手机（`apps/relay/test/peers.ts`），读得慢的手机是完成升级后暂停读取的原始 TCP 连接。

| 行为 | 验证 |
|---|---|
| `GET <前缀>/healthz` 回 200 `ok`（不缓存的纯文本），别的路径、方法、根路径回 404；三个入口之外的升级回 404；没有前缀时挂在根上 | `apps/relay/src/relay.test.ts`"relay entry points" |
| 宿主 `hello` 后回 `ready`；`open` 只带 `streamId`（128 位）和 `ipHash`；二进制帧两个方向原样、按顺序转发；接线前的帧先存、接上后按顺序先送；任一端关闭另一端 1000；手机或数据连接发文本帧 4400 关掉这一对 | 同上"relay pass-through" |
| 认证：令牌错、宿主不存在、版本或类型不对、缺令牌、二进制或非 JSON 的 `hello`、数据连接缺或格式错的 `streamId` 都 4401；失败日志只在 `hostId` 像 `hst_<16hex>` 时记它，从不记令牌；5 秒内没 `hello` 4408，4999 毫秒到的照样认；计时器先到、`hello` 后到的不认；一个连接不论怎么结束只让出一个未认证名额 | 同上"relay authentication""relay hello deadline" |
| 代数：新控制连接挤掉旧的（4409），旧连接的流 4409；旧连接的关闭不让新的下线；挤掉前宣布的流再来数据连接 4404 | 同上"relay control generations" |
| 宿主离线：从没上线或不存在的 `hostId` 4404 `offline:0`，`host` 参数不对 4400；控制连接断了，它的流和之后的手机 4404 `offline:<断开时的秒>`；20 秒一次 ping，答着就不断，60 秒没回应断开并关掉它的流（日志 `unresponsive`）；宿主走后不留定时器 | 同上"relay offline hosts" |
| 接线：10 秒没有数据连接 4408（9999 毫秒时还在），之后来的数据连接 4404；接上后不再超时；同一条流的第二条数据连接 4404；`refuse` 4403，不认识的 `refuse` 不理；控制连接发二进制（即使内容是 `refuse`）、非 JSON、不认识的类型 4400 并带下它的流；接线前 9 帧或超过 256 KiB 4507（正好 256 KiB 不关） | 同上"relay wiring a stream" |
| 上限：70 KiB 的帧过、多 1 字节发的那端 1009、另一端 1000；每宿主 16 条流，第 17 条 4429；未认证 64 条，第 65 条 4429；每地址每分钟 30 条新流（只算建起来的），滑过 60 秒恢复；设成 0 不限；只信任的反代的 `X-Forwarded-For`；缓冲合计超了新手机 4507；读得慢的手机积压过 4 MiB 4507，同一宿主的另一台手机照常收到每一帧 | 同上"relay limits" |
| 宿主表：删掉的宿主控制连接 4401、手机 4404、数据连接 4401，之后连不上；换令牌后旧令牌 4401、新令牌可用，日志代数 1 → 下线 `revoked` → 3；被切断的宿主的手机看到切断时刻，从没上线的仍是 `offline:0`；只改名不断，新宿主可用 | 同上"relay host table" |
| 日志只有元数据：没有令牌、载荷（原文、hex、base64）、原始 IP、`hello`；每种事件的字段逐个核对 | 同上"relay log""relay log events" |
| 关闭：所有连接 1001，计数和定时器归零；关闭中新来的升级 404，不回应关闭帧的连接 2 秒后切断；半截的请求和 keep-alive 连接不拖住关闭 | 同上"relay shutdown"、"does not wait for a half-sent request" |
| 不压缩帧（客户端提出也不接受） | 同上"does not compress frames" |
| 200 轮（上线挤掉上一代、收发、接线超时、拒绝、认证失败、`hello` 超时、宿主离线的手机）后资源计数、假时钟的定时器、Node 的 TCP 句柄和 `Timeout` 回到基线；连接还开着时关闭也全部释放 | `apps/relay/src/relay.leak.test.ts` |
| 真实 IP：只在连接来自信任的反代时读 `X-Forwarded-For`（从右往左第一个不信任的）或 `X-Real-IP`，值不是地址时用连接地址，`::ffff:` 前缀去掉 | `apps/relay/src/client-address.test.ts` |
| 每地址的滑动窗口：不算被拒的、过了窗口忘掉地址并停掉清理定时器、0 不限 | `apps/relay/src/rate-limit.test.ts` |
| `relay.json`：默认值、全部字段、缺文件、不认识或不对的字段只报名字、前缀格式、非 JSON | `apps/relay/src/config.test.ts` |
| `hosts.json`：0600 原子写入、目录 0700、坏表拒读、改名失败不留临时文件；轮询报告每次变化和坏表，没变不报，停了不再报（包括正在进行的那次） | `apps/relay/src/hosts.test.ts` |
| 日志文件：按 UTC 日期一天一个、0600、过了午夜换文件、只删自己的超过 14 天的文件、关闭后不再开文件、打不开或列不出目录时报一次错码并接着跑 | `apps/relay/src/daily-log.test.ts` |
| 命令行：`add-host` 只往标准输出打一次那一行、只存令牌的哈希；`rotate-host` 只换这一个宿主的令牌；`remove-host`、`list-hosts`（不含令牌）；名字、用法、缺或坏的 `relay.json`、坏的 `hosts.json`（不覆盖）；`serve` 记日志、按信号干净退出、2 秒内跟上 `rotate-host`（在线的 4401）、运行中加的宿主、坏表保留旧表、每分钟资源行、日志写不了时只在终端报错码、端口被占 | `apps/relay/src/cli.test.ts` |

验证（2026-10-26）：`pnpm check` 通过；`pnpm test` 196 个文件 3741 项通过；relay 的单元和集成 160 项、泄漏 2 项通过；`pnpm test:stress --copies 8 --rounds 3 apps/relay` 24 次没有失败。`pnpm break-check` 25 处全部检出（认证、代数、离线原因、两种超时、接线缓冲的帧数和字节、积压、每宿主流数、未认证数、每地址速率、缓冲合计、信任的反代、ping 超时、换令牌、日志里的 `hostId`、文本帧、只存哈希、轮询生效、3 处泄漏、日志保留、关闭码 1001）。变异测试新加 `relay` 组：第一次 82.90%（189 个存活），补测试、删掉冗余代码（关闭时第二个代数判断、`onData` 里的代数判断、`stopPings`、日志的 `#broken`、没用的 `CliIo` 选项）后 958 个全部杀死、0 存活、0 超时，等价的在源码注明理由。

本机 Docker（colima，arm64）：`docker build` 和 `--platform linux/amd64` 都成功，构建的检查阶段在镜像的 Node（v24.22.1）上跑通 `add-host` / `list-hosts`，打包坏了构建失败（截断 `relay.cjs` 实测）；按 `compose.yaml` 的设置（只读、去掉 capability、uid 1000）`docker run`，再起一个和它共用网络的 nginx 原样加载 `deploy/nginx-location.conf`：直连和经 nginx 的 `/atrium/healthz` 都是 `ok`，其他路径 404；`docker exec … add-host` 打印的一行交给 MP0 的假宿主，假手机经 nginx 配对（两边校验码一致）、IK 重连、`hello`/`welcome`、心跳都通过；`rotate-host` 后在线的宿主 2 秒内收到 4401，之后的手机 4404 `offline:<秒>`；`docker stop` 干净退出（日志最后是 `stopped`），日志里没有令牌。没在用户的 VPS 上验证（由主 agent 部署）。

## pi 1.3.0 契约夹具补齐（2026-10-23）

本机 pi 1.3.0 此前只有 19 个场景的夹具，`pnpm test:pi` 56 过、33 失败，失败全是 `no fixture … for pi 1.3.0`（契约断言在录制比较之前跑，都通过了）。以 `RECORD_FIXTURES=1` 只跑这 33 个场景所在的 17 个契约文件录下 `pi-1.3.0/` 的 33 个新文件，同文件里已有的 `ask-steer`、`ask-abort` 重写后逐字节不变；再录一次逐字节相同。不改断言、规范化规则和产品代码，旧版本目录保留（testing.md"pi 夹具"）。和 1.1.0 的差异只有 `custom-idle` 是 pi 的变化（空闲时扩展 `sendMessage` 开的运行，`handled` 应答改在 `agent_start` 之前，系统消息带 `sections`），宿主两种先后都已处理，见 pi-internals"版本"。

| 行为 | 验证 |
|---|---|
| 本机 pi 1.3.0 的每个契约场景都有夹具，输出和夹具不一致就失败 | `pnpm test:pi`（`packages/pi/test/contract.ts` 的 `recordOrCheck`），89 项 |
| 新夹具都能按原样回放 | `packages/pi/src/contract/replay.test.ts`"plays back exactly as recorded" |

`pnpm break-check` 3 处，全部检出：把 `custom-idle.jsonl` 的 `"disposition":"handled"` 改成 `started`、`exit-sigterm.jsonl` 的 `"code":143` 改成 `0`、`error-retry.jsonl` 的 `auto_retry_start` 改名，对应契约场景都因漂移检查失败。`pnpm test:pi` 89 过、0 失败；`pnpm test` 3473 过（含回放 102 项，仍有既有的日志流 EBADF 提示）；`pnpm check` 通过。没有改产品代码，不跑变异测试；第 1 层测试仍读旧版本夹具，没有改用 1.3.0。

## 外部边界清单 `pnpm boundary` 与 `@sideEffects none` 核对（2026-10-23）

审查时不再靠人在代码里找一次改动碰了哪些外部边界。security.md 新加"外部边界登记"三张表（出网地址 13、环境变量 39、隐藏命令 4，按全量扫描填），`scripts/boundary.mjs` 用 oxc-parser 按语法树从生产代码里认出它们和登记表对照；`--all` 接进 `pnpm check`（本仓库约 0.3 秒、零误报）。`@sideEffects` 只核对一种矛盾，做成 oxlint 规则 `atrium/side-effects-none`，全仓生效；启用时报了 4 处，都是测试里"等一个 tick"的辅助函数，改了 JSDoc 文字。

| 行为 | 验证 |
|---|---|
| `--all` 列出登记表里没有的地址、环境变量、隐藏命令和非精确版本的依赖，退出码 1；注释、JSDoc、正则字面量、`import.meta.env`、测试、bench、`test/`、契约场景、testkit、scripts 都不算；模板字符串的 `${…}` 记成 `*`，句末标点去掉；常量名经相对导入解析出隐藏命令；登记了但代码里没有的只提示 | `scripts/boundary.test.ts`"lists the production URLs" |
| `ERR_` 开头的字符串（Node 错误码）不当环境变量，单个字符串和数组里都不算；登记表里标了 `（拼出）` 的行不和代码比对，`--all` 不提示它们找不到（审查后加） | `scripts/boundary.test.ts`"lists the production URLs" |
| 全部登记、版本精确时只打一行汇总，退出码 0 | `scripts/boundary.test.ts`"passes with one summary line" |
| 本仓库的生产代码全部在登记表里（删掉 `https://pi.dev/api/latest-version` 那一行就失败） | `scripts/boundary.test.ts`"finds every production URL" |
| 按改动：基准默认是和 `main` 的 merge-base，范围含提交、未提交和未跟踪的文件；依赖增删改（标出非精确）、新增和删掉的边界（标出是否登记）、协议文件改了而版本没变的警告、改动文件里的 `@sideEffects` 矛盾；新增未登记或非精确时退出码 1 | `scripts/boundary.test.ts`"lists dependency, URL" |
| 指定基准；`PROTOCOL_VERSION` 旧值→新值；没有 `.oxlintrc.json` 时写明没查 | `scripts/boundary.test.ts`"takes an explicit base" |
| 只改协议的测试文件不警告 | `scripts/boundary.test.ts`"warns only for non-test" |
| 基准不是提交、生产代码解析不了时退出码 2，不当作没有边界 | `scripts/boundary.test.ts`"refuses a base"、"stops on production code" |
| `@sideEffects none` 的函数自己或直接传给调用的回调里调起进程、写文件、网络、定时器（含注入的时钟）、`process.exit/kill`、`console`、logger、`new WebSocket` 时报错 | `scripts/lint/atrium-plugin.test.ts`"reports each" |
| 不报：同名的正则 `exec` 和本地函数、只读的 fs 函数、返回或存起来的闭包、`process.kill(pid, 0)`、"none until …"、写了副作用的、没有 JSDoc 的 | `scripts/lint/atrium-plugin.test.ts`"leaves alone" |

`pnpm break-check` 37 处：首轮 30 处检出、7 处漏掉，补了测试（解析失败、`toolEnv` 这类名字、句末标点、JSX 文字、全大写但不是环境变量的数组、只读 fs 函数）后 6 处重跑全部检出；另一处是规则里"整条 `import type` 跳过"的判断，`import type` 导入的名字不能被调用，删掉了这个分支；终版 36 处全量重跑全部检出。`pnpm check` 通过；单元默认并行两次各有 1 项未改动的 `pi-config.test.ts`"queues several same-path saves…"报 `config_conflict`（同上文已记的既有不稳，单文件 3 次 44 项通过），串行全量 182 文件 3450 项通过。审查后补登三条由登录 `baseUrl` 拼出的真实请求（Codex 模型列表、ChatGPT 和 Claude 的套餐用量），加 `ERR_` 排除和 `（拼出）` 标记，新增 4 处破坏检查全部检出。`scripts/` 不在变异测试分组里，没跑变异测试。

## 日志门禁与生产日志的新错误汇总（2026-10-23）

测试通过、日志里却有 warn/error 的"假绿灯"改成门禁（[testing.md · 日志门禁](../architecture/testing.md#日志门禁)）；自用的生产日志用 `pnpm errors` 汇总新错误（[testing.md · 运行时监控](../architecture/testing.md#运行时监控)）。门禁拿到的基线里，"Atrium 自己要求的停止或中止"引起的假 warn 按 observability.md 新定的原则降级，归档后改动面板还在读的问题一并修掉（SPEC-0001"M1.11 的工作区归档"）。

| 行为 | 验证 |
|---|---|
| 门禁按 level、msg、声明的字段精确匹配；不写次数至少一次，写了正好这么多次，可能出现的次数不限；声明了没出现也失败；失败信息只有 level、msg、`err` 的类型和码 | `packages/testkit/src/log-gate.test.ts` 的 `findLogProblems` 各例 |
| 门禁不管界面上报的性能信号（`client issue` 的 `long_task`、`slow_frames`），界面上报的错误照样拦 | `log-gate.test.ts`"leaves the UI's reports of long tasks and slow frames out, but not the errors it reports" |
| 端到端门禁真的接在收尾上：声明了却没出现的日志让测试失败 | `apps/desktop/e2e/log-gate.spec.ts`（`test.fail()`；手工去掉门禁后变成意外通过） |
| 读日志目录里全部 `host.<n>.jsonl`，按编号顺序，跳过半行和别的文件 | `log-gate.test.ts`"reads every rotated host log file in number order" |
| 第 4 层：`dispose()` 关宿主、读日志、删主目录后核对，意外的 warn 让它失败且不留主目录；声明了就放过；声明了没出现也失败；只核对一次 | `packages/host/test/harness.host.test.ts` |
| 第 6 层：`close()` / `cleanup()` 读这个主目录的宿主日志核对，同一主目录的几次启动共用声明，软断言；faux 环境自动登记"标题请求失败（`model_failed`）可能出现" | `apps/desktop/e2e/launch.ts`、`faux-pi.ts`，由全量 `pnpm test:e2e` 验证（没有单独的自测） |
| `pnpm errors` 按 service、level、msg、`err` 类型和码分组，跨轮转文件计次数、首末时间、运行次数 | `scripts/errors.test.ts`"groups warn, error and fatal records by signature" |
| 界面上报的问题：React 压缩错误只留错误号，其余去掉网址、路径、id、数字 | `errors.test.ts`"puts the UI's reported problems in their signature" |
| 新签名：截止时间（默认最近一次宿主启动，`--since` 可改）之后才第一次出现；没有宿主启动时不标；`--since` 不是时间、目录不在时报错退出；不写日志目录 | `errors.test.ts` 其余三例 |
| 没找到 pi 记 info；用不了、版本太旧仍 warn | `packages/host/src/tools.host.test.ts`"finds no pi, Node, Homebrew or fd on an empty PATH and logs that" |
| 宿主关闭时中止读登录 shell 记 info | `tools.host.test.ts`"notes a login shell read it gave up on while closing at info level" |
| stop 作废、signal 中止的请求，迟到的响应记 debug；过了 pi 进程期限的、没有 id 的、从没发出过的仍 warn；记住的请求 id 最多 100 个 | `packages/pi/src/process/pi-process.test.ts`"drops responses that arrive after stop was called"、"still warns after stop about a response to a request given up before it"、"notes a response to a request its caller aborted"、"remembers only the last 100 requests" |
| 一次性 pi 被调用方中止记 info，其他原因仍 warn | `packages/pi/src/oneshot/oneshot.test.ts`"kills pi when aborted, and logs that at info level"、"fails when %s, and logs only why" |
| 模型目录查询过了自己的期限另记 warn"model list timed out"（只带期限），关闭时中止不记 | `packages/pi/src/catalog/model-catalog.test.ts`"gives up after 120 seconds"、"aborts the queries under way on close" |
| 停 pi 打断运行后读条目记 info，其他原因仍 warn | `packages/host/src/sessions/session-manager.test.ts`"notes a read of pi's entries cut short by closing at info level" |
| 归档的工作区不再读改动：不跑 git、不建监听、不推送；归档时正在跑的读取失败、监听断开都不记；恢复后照常；从列表里消失（不是归档）的照旧记 | `packages/host/src/changes/changes-service.test.ts`"ChangesService: archived workspaces" 四例；`packages/host/src/changes.host.test.ts`"reads nothing more of a worktree once archived"（真实 git、真实归档，修复前门禁报 3 条"changes not read"） |

每个新测试先见过失败。`pnpm break-check` 24 处全部 `CAUGHT`（门禁去掉检查、可能出现 / 字段 / 次数的判定、读轮转文件的顺序、`pnpm errors` 的 React 归一、数字归一、新签名判定、默认截止时间、`err` 进签名，以及上表每处级别改动和归档的四处判断）。增量变异测试（只变异改动的行）：pi 组 `pi-process.ts`、`oneshot.ts`、`model-catalog.ts` 30 个全部杀死；git 组 `changes-service.ts` 首轮 26/27，存活的是 `archived()` 去掉可选链（工作区从列表里消失时会抛错），补了"still logs a read that fails once the workspace is gone"后 27/27。

验证：`pnpm check` 通过；单元 3463、宿主 157（连跑多次通过）；`pnpm test:leak` 全过（Node 13、端到端 7）；全量 `pnpm test:e2e` 61 过、1 项已知不稳的失焦材质用例失败（系统焦点，未到门禁）。门禁不管界面上报的长任务、掉帧（`log-gate.test.ts`"leaves the UI's reports of long tasks and slow frames out"），`kind: error` 照样拦。端到端门禁的接线自测 `apps/desktop/e2e/log-gate.spec.ts` 用 `test.fail()` 声明一条不会出现的日志；手工去掉 `launch.ts` 的软断言后它变成"Expected to fail, but passed"，恢复后通过。浸泡测试在 `main` 上同样因资源基线失败（既有问题）；临时绕过基线断言核实了声明：会话的浸泡每轮杀一次 pi，声明 `pi exited`（`requested: false`）正好轮数次，连接的浸泡声明错误 token。待查项（首次代码高亮的长任务、"changes not read"、浸泡基线、EBADF）登记在 [self-use.md · 问题](../research/self-use.md#问题)。

## 自用记录里 2026-10-23 的待查项（2026-10-24）

[self-use.md · 问题](../research/self-use.md#问题) 10-23 记下的几项。首次代码高亮的长任务查明后用户定暂不做，没有改动，测量记在 self-use.md。

| 行为 | 验证 |
|---|---|
| 工作区目录在 Atrium 外被删（界面还停在上面）：不跑 git、不建监听、不记日志，胶囊收到 `stat` 为 `null`、面板"读不到改动"；按轮询和重试只看目录，回来了照常读和监听；读到一半目录没了、监听因此断开都不记；看目录期间工作区被放下不留定时器 | `packages/host/src/changes/changes-service.test.ts`"ChangesService: a directory gone outside Atrium"四例；`packages/host/src/changes.host.test.ts`"a shown worktree removed outside Atrium"（真实 git、真实删目录，修复前门禁报"changes not read"、胶囊停在旧数字） |
| 审查后补（2026-10-25，GPT-6 Astra）：读的时候发现目录不在，就停掉还开着的监听、改为轮询（删掉整棵树时监听不一定报错），已在轮询的不重新计时，目录回来后监听只建一份、退订后不留定时器和监听；放下工作区时正在看目录的读不再排轮询；只有 `ENOENT`、`ENOTDIR` 或不是目录才算不在，看不了的（如 `EACCES`）算在、照旧跑 git 记日志 | `changes-service.test.ts`"stops the watchers once a read finds the directory gone though none broke…"、"tries to watch again 30 seconds after first finding the directory gone…"、"schedules nothing for a workspace let go while a look found its directory gone"、"directoryPresent"两例（真实文件系统、`chmod 000` 的父目录）。破坏检查 8 处全部 `CAUGHT`；git 组只变异改动的行 55/55 |
| 浸泡测试的资源基线等宿主启动后自己做的事（找工具、git 版本检查）结束再取，结束时比对基线加上浸泡中才出现的计数（为 0） | `packages/host/test/harness.ts` 的 `settledResources`；`packages/host/test/soak/connections.soak.test.ts`、`sessions.soak.test.ts` |
| 会话浸泡里被停、被杀的两个对话，停止和杀进程一定落在运行中：它们的回复由 faux 挂住，测试等它们这一轮的轮开出来再动手，不看回复长短 | `packages/host/test/soak/sessions.soak.test.ts`（`HELD`、`runsStarted`）；faux 按提示词挑回复：`packages/testkit/src/faux/faux.pi.test.ts`"answers a prompt starting as a byPrompt entry says with its reply"。杀之前人为等 2 秒，旧写法第一轮就报"the round has not ended"，新写法各轮照常；30 分钟 1800 轮全部正确；堆增长按不含 V8 编译代码的空间算（`heapWithoutCode`，testing.md"长时间运行"），2026-10-25 的 30 分钟 810 B/轮，通过 |
| 单元测试不再漏出"atrium: log stream error: EBADF"：写失败的日志流关完之后才恢复 stderr | `packages/host/src/platform/logger.test.ts` 的 `failingLogFile`；全量 `pnpm test` 输出里没有这行 |

每个新测试先见过失败。`pnpm break-check` 改坏 5 处、6 次检查（不看目录就读、不看目录就建监听、目录不在时仍记日志、目录不在时不进轮询、放下后仍进轮询；第一处另用宿主用例跑了一次），全部 `CAUGHT`；"放下后仍进轮询"首轮 `MISSED`，补了"schedules nothing for a workspace let go while its directory was looked at"后检出。git 组只变异 `changes-service.ts` 改动的行：49 个全部杀死。浸泡测试和 EBADF 是测试自己的改动，没有破坏检查（改坏的就是被修的测试本身）。faux 的 `byPrompt` 破坏检查 4 处全部 `CAUGHT`（不按提示词挑、取不到文字块、取第一条而不是最新一条用户消息、取到文字后丢掉）。

验证（2026-10-25）：`pnpm check` 通过；`pnpm test` 3510 通过，输出里没有 EBADF；`pnpm test:host` 158 通过；faux 的 pi 测试 16 通过；会话浸泡 30 分钟通过（810 B/轮，不含编译代码），连接浸泡 0.5 分钟通过；`pnpm test:e2e` 62 过、1 项失败，是已知不稳的失焦材质用例（`screencapture -l` 报 `could not create image from window`），单跑同样失败。

## M1.11 自用之后：流式回复连着到一阵增量时界面报 React #185（2026-10-22）

宿主日志 10-20 到 10-22 14:53 的 50 条 `client issue`（打包版）都是同一个栈：WebSocket 消息 → 会话视图 store 的 `setState` → `useSyncExternalStore` 的重绘 → React 抛 #185。根因是 `use-revealed-text.ts` 在 effect 里对每次新到的文字 `setState`：store 的更新按同步优先级提交，提交末尾同步跑 effect，effect 的更新留下一次待渲染，React 把连续 50 次这样的提交当成死循环。页面忙时攒下的 WebSocket 帧，Chromium 会在同一个任务里逐条派发、每条之间只跑微任务（本机 Playwright 实测：主线程忙 100 ms 后 199 条消息全在 React 调度任务之前派发完），React 自己的调度任务插不进去，于是一阵超过 50 条的增量就抛错。改为渲染时就接住新文字（React 的"根据上一次渲染调整状态"写法），effect 只管逐帧揭示，界面显示不变。完整工作台里流式思考、工具输出、回复各 120 次连续更新，修复前回复阶段每次提交都留下 `StreamedText` 的更新（另有 Streamdown 挂载时的一次），修复后只剩这一次挂载。

| 行为 | 验证 |
|---|---|
| 会话视图连续收到超过 React 嵌套更新上限的一阵更新（中间只有微任务，同一次读 WebSocket 那样），流式回复照常揭示到完整文字，不抛错 | `packages/ui/src/chat/streaming.browser.test.tsx`"a burst of deltas" |
| 回复停止流式时立刻整段显示；之后再流式时从已显示的长度接着揭示，任何一次 DOM 变化都不比已显示的短 | `packages/ui/src/chat/streaming.browser.test.tsx`"revealing a reply" |

第一条在改动前失败，报错和线上同样经 store 的 `setState` 抛出。`pnpm break-check` 5 处：4 处检出；没检出的是把返回值从 `visibleText(shown, …)` 改回 `visibleText(state, …)`，渲染时的 `setState` 会让 React 立即重跑这次渲染、丢掉第一次的结果，重跑时两者相同，属于等价改动。`pnpm check`、构建、单元 3436、UI 996 通过（首轮 UI 有 1 项 `image-preview.browser.test.tsx`"keeps very large images fully fitted below 25 percent…"失败，单跑 3 次、全量重跑均通过，和本次改动无关）；`streaming.browser.test.tsx` 连跑 5 次通过；桌面 `chat.spec.ts` 三项、`rendering.spec.ts` 一项通过。`use-revealed-text.ts` 不在变异测试分组里，没跑变异测试。没跑全量桌面、泄漏、性能，也没有打包装上后用真实 pi 复现。

## FFF 与自用零散改动的统一合并（M1.11 自用，2026-10-22）

用户要求统一合回 `main`，并明确选择“全部提交并合并”：除FFF接入外，纳入当前未提交的重新隐藏非套餐Claude、Friday品牌及 `4a91bcd` / `cf55815` 两个已提交的Tabler展开文件夹图标改动。核对 `main` 为 `1a8f99f`，是当前分支祖先，无新增主干提交或代码冲突；主工作区未提交的 `docs/architecture/plugin-model.md` 不在范围内，保持原样。保留用户选择的“稍后更新”，本轮不安装或重启应用、不推送。

合并前验证：

- `pnpm check`、构建、串行单元3424、宿主149通过；单元仍有既有日志流EBADF提示。
- 全量UI首轮983过、侧栏 `names a chat by its alias, else its first session's title, else as new` 1项失败；单跑通过、全量重跑984项通过。该测试及排序实现相对main均无变化：fixture分别取 `Date.now()`，而列表按更新时间降序；首轮实际名称都正确，顺序受跨毫秒创建影响。不改无关测试、排序、断言或重试设置。
- 全量非leak/perf/package桌面61过、1项既有 `app.spec.ts` 失焦材质用例失败；单独重跑同样因系统 `screencapture -l` 的 `could not create image from window` 失败，未到颜色比较，不冒称全绿或已修复。此次相关的 `models.spec.ts` 五项再跑通过；Friday和隐藏Claude的浅/深色桌面截图已查看，子代理六项也在全量中通过。
- 追加改动行变异：`model-rules.ts` 新增anthropic规则5个，4Killed、1等价Survived，80%；存活仅将不被过滤逻辑读取的说明字段 `reason: "paid"` 改为空字符串，已在源码注明，不为此放宽测试或豁免整条规则。Friday注册项2/2Killed，100%。新独立报告无缓存复用，不是整文件分数。host首轮误选空行产生0新变异不计；随后dry run遇既有配置队列 `config_conflict`，单文件44项通过、完整定向重跑完成。
- FFF的host32、pi23个改动行变异全Killed、8项破坏检查全检出、相关单元压力检查和7种原包RPC场景，沿用下节本轮已完成的证据。完整pi契约56过、33项缺既有1.3.0夹具，0行为断言或漂移；不顺带重录无关夹具。
- 对相对main的已提交及未提交整批做独立只读复核，无阻断；不冒称正式三方里程碑审查。没有新增资源管理代码，未跑完整插件泄漏、性能A/B、真实模型、浸泡或打包安装。

## pi-fff 选装与子代理专用搜索工具（M1.11 自用，2026-10-22）

用户确认主代理、子代理都安装，子代理关闭旧独立搜索工具，保留 `ffgrep/fffind` 名字避免混用。用户级 `pi install npm:@ff-labs/pi-fff@0.11.0` 完成，独立数据库、tools-only、不扫描home根及不跟随目录链接的配置见 [调研 §8](../research/pi-fff.md#8-用户选装与子代理限制2026-10-22)。不增加生产依赖、不默认内置、不自动重启现有会话。所有 agent 开的子对话停用旧 `grep/find`，包括 work、带上下文和交给终端；主代理选择不变，`read/bash/ls` 保留，不禁止 Bash 内搜索命令。

| 行为 | 验证 |
|---|---|
| 只读角色使用独立FFF工具名、主代理不受影响 | `agent-launch.test.ts` 精确启动参数；`agent/words.test.ts` 首件任务工具列表及work说明 |
| work、深层、继承父参数、循环祖先、终端交接均排除旧名字 | `agent-launch.test.ts` 14项；父级agent工具排除及角色限制继续保留 |
| 扩展防线允许新名字、拦旧名字，主代理仍可使用原工具 | `agent/extension.test.ts` 参数化角色/guard；新旧工具名及主代理各精确断言 |
| 原有只读保护与任务说明仍通过真实pi | `agent-tools.pi.test.ts` 12项；重录并复跑pi1.3.0的 `agent-guard`、两种 `agent-readonly-bash`、`agent-task` 四夹具；不改旧版本夹具 |
| 已安装FFF原包经过模型→工具→结果链路 | 隔离原生+faux实测7种主/子参数场景，均能调用 `ffgrep/fffind` 并得到文件/行；旧名被注册表或扩展挡下。没有从桌面实际派出子代理，不冒称真实模型或完整桌面验收；脚本在 `/private/tmp/atrium-fff-live-check/` |

先修改期望观察8项失败，再实现pi侧；宿主侧新期望也先观察work/继承路径失败。8项定向破坏检查（pi4、host4）全部检出；三个相关单元文件2副本×2轮压力检查通过。`pnpm check`、串行单元3424、宿主149通过，单元仍输出既有日志流EBADF提示。完整pi首轮55过、34失败：33项是已知缺pi1.3.0夹具，另1项为本次改变任务工具列表后的 `agent-task` 夹具漂移，已按新语义重录；随后整个 `agent-tools.pi.test.ts` 12项通过，最终全量pi为56过、33项仅因缺夹具失败，0项行为断言或夹具漂移。最终 `pnpm check` 再通过，相关三文件加夹具回放175项通过。四份夹具差异已核对：三份只改工具名文字；flags场景未装FFF，因此除新名字的白名单参数外，声明中去掉旧grep/find，仍可用Bash。不把全量pi称为已通过，不为本次顺带重录无关夹具。

独立只读复核无阻断，未代替正式三方里程碑审查。改动行范围的增量变异无缓存复用：host32、pi23个全部Killed，0存活/超时/错误；host另7个受既有注释忽略，两个范围有效分数均100%，不是整文件分数。构建和 `children.spec.ts` 六项真实桌面回归通过，包含子代理派出、孙级送达、带上下文、worktree、只读Bash与禁止write；这些桌面场景未安装FFF，实际原包搜索另由上述7种RPC场景验证。未跑完整界面/桌面、性能A/B、真实模型、完整插件泄漏或长时浸泡。当前安装应用仍是旧版，用户已选择“稍后更新”，保留4个现有pi会话，未替换或重启应用；用户目录的改动仅包安装及FFF配置，独立阶段未触碰其余并行模型/品牌改动，尚未提交、合并或推送；随后用户授权整批提交合并，见上节。

## 模型档位与发送图片预览的合并验证（M1.11 自用，2026-10-22）

用户验收后要求两项代码一起合回 `main`。先提交 `self-use-hide-off-thinking-label` 与 `self-use-sent-image-preview`，在图片任务分支整合；追踪表的同位置新增记录冲突已全部保留，SPEC 与视觉规范自动合并，不改变两项已验收行为。核对最新 `main` 为 `6671c7d`，没有新的主干改动。

合并前 `pnpm check`、构建、串行全量单元 3414 项通过；串行 UI 首轮 982 过、1 项既有 Markdown 悬停按钮用例失败，该文件单跑 27 项及全量重跑 983 项通过，未改无关实现或弱化断言。单元仍输出过日志流 `EBADF` 提示，不影响用例通过。`models.spec.ts` 与 `images.spec.ts` 六项桌面验证通过，含实际重启后打开历史图片，以及连续开关 20 次的 DOM 泄漏检查。独立阶段的六项破坏检查、两个文件各 2 副本 × 2 轮压力检查和明暗截图记录见下文；未改核心变异分组，不声称新增核心变异分数。未跑全量桌面、真实 pi 契约、性能、浸泡或打包安装。按授权本地合并，未推送、未安装；不触碰主目录的 `plugin-model.md` 修改。

## 发送图片点击放大（M1.11 自用，2026-10-22）

用户报告对话中自己发送的图片无法放大。用真实 `UserBubble` 复现：本页保留图和历史取回图点击后都没有预览；根因是 `Shown` 仅输出 `<img>`，规格也曾将大图列为以后再做，并非解码或宿主读取失败。本次只将可用缩略图接入既有 `ImagePreview`，沿用回复图片的 B 全屏画布，不另做视觉方案、文件读取或宿主协议。加载 / 失败占位保持不可交互。两个调用点按图片地址设 key，换图即卸载旧预览；保留原尺寸、裁切与缓存规则。

`message-images.browser.test.tsx` 新增本页 / 历史两条点击路径：选择第二张不同图片，验证原地址、640×400 完整几何、实际缩放到 800px、适应窗口、Esc 关闭、Enter 重开、关闭按钮、焦点回到原缩略图，预览不额外取图；两条路径都验证换图和卸载关闭模态。原有测试继续验证 64px 和换行，补占位无放大入口。最初两条打开预览测试见红；补实现后又用换图用例见红，再加来源 key 后通过。几何断言首次沿用默认窄视口，适应比例实际是 57%，改为显式 1000×800 后两文件 22 项通过，未改缩放实现或弱化几何断言。lint 发现测试内三元分支后，改用预先给定的图片数组索引，保留完整断言。

桌面 `images.spec.ts` 验证粘贴 → 发送 → 原图预览与缩放 → 退出 → 重启 → 从 pi 记录取回 → 再次预览；新增 `@leak` 实际连续开关 20 次、堆快照检查无新增脱离 DOM。关闭点击处理的桌面负对照同时检出两个场景。四项 `pnpm break-check` 全部检出（不开预览、不关预览、本页来源 key 移除、历史来源 key 移除）。`pnpm check`、构建、全量 UI 975 项、桌面两项（含泄漏）通过。真实组件浅 / 深色缩略图和全屏预览截图已看，临时截图代码移除。独立只读复核无阻断；该复核未实跑测试，完整会话切换旅程依赖现有身份门槛和记录卸载逻辑，不将卸载单测冒称完整旅程。

相关图片布局单元 5 项通过，消息图片浏览器文件压力检查 2 副本 × 2 轮全部通过，设计扫描无发现。独立验收阶段未跑全量单元、全量桌面、真实 pi 契约、性能、浸泡或打包安装，未混入“隐藏关闭档位”改动。用户随后确认并授权两项一起合并，集成验证见上文。

## 模型按钮隐藏关闭的思考档位（M1.11 自用，2026-10-22）

用户直接指定 `off` 时隐藏模型按钮上的“关闭”，不另做视觉方案原型；只省略按钮里的档位文字节点，不留占位，不改真实思考设置、点阵或交互。其他六档照常显示，悬停说明、辅助功能名称与面板里的“关闭”仍保留。

`packages/ui/src/chat/model-picker.browser.test.tsx` 新增浅 / 深色 `off` 用例：按钮只显示模型名、无 `.atrium-model-level` 节点，辅助功能和悬停说明仍报告档位；打开面板仍显示“关闭”，键盘仍可选到低档，面板保持打开。逐档验证 minimal / low / medium / high / xhigh / max 的文字不受影响；既有仅支持 `off` 的模型用例补按钮无档位字断言。先见旧实现失败，再实现后文件 40 项通过；真实按钮浅 / 深色截图已查看，临时截图代码已移除。

验证：`pnpm check`、构建、模型选择单元 16 项、串行全量 UI 979 项、桌面 `models.spec.ts` 4 项通过；模型选择浏览器文件压力检查 2 副本 × 2 轮全部通过。两项 `pnpm break-check` 均检出（恢复 off 文字、误隐藏所有档位），设计扫描无发现。只改 JSX 展示，不涉及核心变异分组或资源生命周期；独立验收阶段未跑全量单元、全量桌面、真实 pi 契约、泄漏、性能、浸泡或打包安装。用户随后确认并授权与发送图片预览一起合并，集成验证见上文。

## 项目工作区展开行显示剩余数量（M1.11 自用，2026-10-21）

用户指定将项目工作区的“显示全部 7 个”改为“显示剩余 2 个”。剩余数按已经过滤、排序后的工作区数减去实际已显示数计算，额外展示的当前工作区也扣除；没有剩余时不出现“显示剩余 0 个”。展开、收起、换项目后收回及行尺寸不变，对话分区不改。用户已指定文案，无新的视觉方案选择；本任务 worktree 的 `prototypes/sidebar-remaining-count-prototype.html` 列出 7/5、8/6、6/6 三个状态。

`packages/ui/src/app/workbench.browser.test.tsx` 覆盖：总 8、已显示 6 → 剩余 2；当前工作区回到前五 → 剩余 3；总 7、已显示 5 → 剩余 2；总 6、已显示 6 → 不显示展开行，回到前五 → 剩余 1；展开全部后“收起”；正好五个无展开行；换项目收回。新增边界测试及修改的文案断言已见红，再实现后该文件 107 项通过。真实组件浅 / 深色截图已看，布局、选中行和按钮样式未改变，临时截图代码已移除。

验证：`pnpm check`、构建、侧栏单元 21 项、串行全量 UI 940 项通过；三项 `pnpm break-check` 均检出（误用总数、只扣前五不扣额外当前项、没有剩余仍显示展开行）。真实组件浅 / 深色截图确认布局和文案，设计扫描无发现；截图首次写 `/tmp` 被浏览器测试的文件安全限制拒绝，改存工作区被忽略的 `.vitest/` 后成功，未放宽安全限制，临时截图代码已移除。用户确认并授权提交、合并后，核对最新 `main` 无新增提交，补跑全量单元 3268 项通过，工作台浏览器测试做 2 副本 × 2 轮压力检查全部通过；单元输出过日志流 `EBADF` 提示，不影响用例通过。仅改侧栏 JSX 展示，不涉及核心变异分组、宿主或协议；未跑桌面端到端、泄漏、性能、浸泡或打包安装。实现来自 `self-use-sidebar-remaining-count`，按用户要求本地提交合并；未安装、未推送。

## 只读子代理默认提供 Bash（M1.11 自用，2026-10-21）

用户确认只读是行为约束，不是沙箱强制保证。`explore`、`advise` 默认提供 Bash，首件任务明确仅可读取、检查与查询，不得修改文件或仓库状态、构建、测试、启动服务；需要修改时请父 agent 交给 `work` 子代理。原先白名单不含 Bash；`edit`、`write` 等白名单外工具仍受限。不新增命令过滤器，不声称能阻止 Bash 写入。

| 行为 | 测试 | 状态 |
|---|---|---|
| 普通启动、继承父参数、交给终端的白名单含 Bash，层数限制及其他工具边界不变 | `packages/host/src/sessions/agent-launch.test.ts` | 已见红并通过 |
| explore 与 advise 的首件任务声明 Bash 及读取用途约束；work 的目录说明、带上下文不重做父调用的说明保持 | `packages/pi/src/agent/words.test.ts` 的 `taskText` | 已见红并通过 |
| 带上下文子代理的工具钩子允许 Bash，仍拒绝 edit、write、MCP 和越层 agent 调用 | `packages/pi/src/agent/extension.test.ts` 的 `the tool hook` | 已通过，移除 Bash / 放行 write 的破坏检查均检出 |
| 真实 pi 的 flags / extension 两种方式能执行 Bash 查询，write 调用报错且文件不存在 | `packages/pi/src/contract/agent-tools.pi.test.ts` 的 `agent-readonly-bash-*`、`agent-guard` | pi 1.3.0 五场景已录制并漂移复验通过；移除 Bash 的负对照检出 |
| 真实桌面开默认只读子代理，查看 Bash 查询结果，write 未创建文件 | `apps/desktop/e2e/children.spec.ts` 的 `a read-only child can query with Bash but cannot call write` | 已通过；构建产物移除 Bash 后在真实结果 `Tool bash not found` 上失败，恢复后完整 children 五项通过 |

验证：`pnpm check`、构建、串行全量单元 / 宿主 3415 项、上述真实 pi 五项、完整 children 桌面五项通过；相关三个单元文件做 2 副本 × 2 轮压力检查全部通过。五项 `pnpm break-check` 均检出（启动参数、扩展放行 Bash、角色说明、禁止 write、真实 pi），另有上述桌面负对照。聚焦本批实际改动的 `words.ts:17-18,236-244` 做 pi 组变异，实跑 13 个全部 killed、100%，无缓存复用、存活或超时；不冒称整文件或整组覆盖。独立只读源码复核无阻断问题。

完整 `pnpm test:pi` 实跑 47 过、33 失败，失败逐条确认均为未修改旧场景缺本机 1.3.0 夹具，不弱化漂移检查、不顺带重录整套；不声称全套 pi 通过。单元层输出过一次日志流 `EBADF` 提示，但 3415 项全部通过。用户确认并要求提交、合并后，核对最新 `main` 无新增提交；补跑全量 UI 首轮 938 过、1 个已记录的 Markdown 悬停按钮用例偶发失败，该文件单跑 23 项及全量重跑 939 项全部通过，未改无关测试或弱化断言。本批未跑全量桌面、泄漏、性能、浸泡、打包安装；不修改 UI、宿主任务送达或资源回收逻辑。实现来自 `self-use-readonly-agent-bash`，用户已授权本地提交合并；未安装、未推送。SPEC-0002 与 security 已同步接受的风险边界。

## SPEC-0001 需求

| # | 需求 | 测试 | 状态 |
|---|---|---|---|
| 1 | 侧栏按项目和工作区组织，显示运行、待处理、合并状态；标签页切换会话 | `apps/desktop/e2e/workspaces.spec.ts`；组件与宿主见"项目、工作区与会话（M1.5）"。待处理的状态随 M1.6、M1.9 | 部分覆盖 |
| 2 | 流式输出回复和推理过程 | `apps/desktop/e2e/chat.spec.ts`、`chat.perf.spec.ts`；组件与渲染见"协议、客户端与流式显示（M1.3）" | 已覆盖 |
| 3 | 粘贴或拖入截图随消息发出 | 组件与宿主见"模型与输入框（M1.7）"的图片两行（压缩、上传、暂存、带图片发出、过期重传）；端到端没有：Playwright 造不出系统剪贴板里的图片 | 部分覆盖 |
| 4 | 看到工具调用：命令和输出、读的文件、diff、写入的文件 | — | 待 M1.4 |
| 5 | 随时中断 | `apps/desktop/e2e/run-control.spec.ts`（停止后排队暂停，继续发送）；控制器与界面见"运行控制（M1.6）" | 已覆盖 |
| 6 | 运行中默认排队，可插话 | `apps/desktop/e2e/run-control.spec.ts`（回车排队、⌘回车插话、插话在下一步前送达）；见"运行控制（M1.6）" | 已覆盖 |
| 7 | 输入框旁切换模型和推理强度 | `apps/desktop/e2e/models.spec.ts`（换模型、⌘⇧E 调推理强度到最高、新对话沿用上一次的模型和档位）；组件与宿主见"模型与输入框（M1.7）" | 已覆盖 |
| 8 | 重启后恢复之前的会话 | `apps/desktop/e2e/history.spec.ts`（从 pi 的文件恢复）、`workspaces.spec.ts`（重启后标签页、当前标签和草稿还在）、`app.spec.ts`（页面存储跨重启） | 已覆盖 |
| 9 | 状态栏显示上下文、缓存、token、速度，可选择显示哪些 | `apps/desktop/e2e/status-bar.spec.ts`（真实宿主和 pi 下回复后显示轮、步、token、上下文，悬停看分段，打开费用后新对话也显示）；组件与宿主见"状态栏（M1.8）" | 已覆盖 |
| 10 | 在 Atrium 里回答 extension 的对话框 | `apps/desktop/e2e/run-control.spec.ts`（`/faux-confirm` 的卡片上作答）；见"运行控制（M1.6）" | 已覆盖 |
| 11 | 默认只突出回复，点开过程看每一步（2026-10-12 去掉显示模式的切换） | `packages/ui/src/chat/turn.browser.test.tsx`（跑完的轮折叠进标题行、点开看每一步）；`packages/ui/src/app/workbench.browser.test.tsx` "has no display mode to switch" | 已覆盖 |
| 12 | 会话在后台继续运行 | `apps/desktop/e2e/parallel.spec.ts`（三个会话同时运行，切走、断网时照常跑完，宿主重启后状态和对话记录正确）；宿主见"并行、同步与关注（M1.9）" | 已覆盖 |
| 13 | 首次启动引导安装 pi、登录、添加项目 | `apps/desktop/e2e/first-launch.spec.ts`（新的数据目录从欢迎页走到工作台）；组件与宿主见"首次启动与设置（M1.10）"。在没装 pi 的账户上走一遍要手动做，挪到 M1.11 | 部分覆盖 |
| 14 | 复制消息或回复 | — | 待 M1.4 |

## 进程与连接（M1.1）

| 行为 | 测试 | 状态 |
|---|---|---|
| Electron 启动宿主，窗口打开宿主提供的界面 | `apps/desktop/e2e/app.spec.ts` "opens a window on the host-served UI…" | 已覆盖 |
| 宿主不依赖 Electron，能用 node 单独运行，SIGTERM 时写完日志再退出 | `apps/desktop/e2e/host-standalone.spec.ts` | 已覆盖 |
| 正确的 token 被接受，客户端进入"已连接" | `packages/host/src/server/ws-server.host.test.ts` "records the whole connection…"；`packages/client/src/connection.test.ts` | 已覆盖 |
| 与 hello 同一次读到的下一帧不丢 | ws-server.host.test.ts "treats a frame that arrives together with the hello…" | 已覆盖 |
| 宿主只监听 IPv4 回环 | ws-server.host.test.ts "listens on IPv4 loopback only"（断言实际绑定地址） | 已覆盖 |
| 端口被占用时启动失败，失败记录写进日志、资源释放 | ws-server.host.test.ts "fails to start when the port is already taken…" | 已覆盖 |
| 关闭宿主：所有连接断开；保持中的 HTTP 连接和只发了一半的升级请求都不拖住关闭 | ws-server.host.test.ts "host lifecycle" | 已覆盖 |
| 本机打包的 Atrium.app 不靠仓库运行：签名有效，宿主、登录程序和界面都在应用目录里，应用图标是 `assets/icon.icns`（猫），窗口照常连上宿主，退出时日志写完（2026-10-11 定） | `apps/desktop/e2e/package.spec.ts`（`pnpm test:package`） | 已覆盖 |
| 退出应用时等宿主写完日志 | `apps/desktop/e2e/shutdown.spec.ts`："waits for a host that is slow to exit…" 用 `e2e/slow-exit-host.cjs` 包住真实宿主、把退出推迟 1.5 秒，应用不等就留不下标记文件 | 已覆盖 |
| 同一客户端的标签命令按收到的顺序生效：索引里已有的会话不等第一次扫描就打开、切换立刻生效；还不认识的会话等扫描时关掉的标签不会再打开；一条失败不耽误下一条；关闭后排队的命令不再执行；新建会话在 pi 启动后打开成所在容器的激活标签，这期间换过位置就不切过去（2026-10-08 修，原来在机器繁忙时重启后 ⌘W 偶尔无效） | `packages/host/src/sessions/session-manager.test.ts` "closes a tab closed while its opening waited for the first scan…"、"opens a session the index knows…without waiting for the first scan"、"goes on with a client's next tab change after one that failed"、"does nothing more for a client's queued tab changes once it closes"、"opens a new session's tab where it belongs but leaves the client where it went…"；`layouts.test.ts`；`apps/desktop/e2e/workspaces.spec.ts` | 已覆盖 |
| 测试里的 git 不会穿过临时根目录、操作外面的仓库（`GIT_CEILING_DIRECTORIES`）（2026-10-08 修，变异测试时曾在 atrium 自己的仓库里切分支、建分支和 worktree） | `packages/testkit/src/git.test.ts` | 已覆盖 |
| 宿主关闭时日志按写入的顺序落盘，最后一行是 "host stopped"；有写入正在进行时也一样；测试读日志前等全部落盘；写日志出错时不再一直等：等落盘的报错，关闭的直接关掉文件（2026-10-08 修，原来在机器繁忙时偶尔乱序） | `packages/host/src/platform/logger.test.ts` "drainLogFile"、"closeLogFile"（占满线程池，让一次写入一定还在进行；把流指向没打开的描述符，让写入一定失败）；`apps/desktop/e2e/shutdown.spec.ts` | 已覆盖 |
| 宿主启动中途收到退出：不在退出后报"已就绪" | `packages/host/src/electron-port.test.ts` "does not report ready or take app metrics, and closes the host, when shutdown arrives while it is still starting"（启动和退出由测试控制） | 已覆盖 |
| 重新连接时关闭旧连接，旧连接晚到的事件不改写新状态 | connection.test.ts "closes the previous socket on reconnect…" | 已覆盖 |
| 界面跟随系统外观 | `packages/ui/src/design/appearance.browser.test.ts`；e2e "follows the system appearance" | 已覆盖 |
| 图标：统一从 `design/icons.tsx` 取 Hugeicons，线宽 1.75，加粗的按各自的宽度（勾 2.25，更多、上箭头 2.5），实心的填色并保留轮廓，不给尺寸时跟随文字；Meta 标借 Tabler 的形状；侧栏领先数和已合并用图标不用字符（2026-10-12） | `packages/ui/src/design/icons.browser.test.tsx`、`app/workbench.browser.test.tsx` "lists a project's workspaces" | 已覆盖 |
| 连接状态的全部文案，包括启动中、桥接失败；连上后只留给读屏、不占位置，没连上时主窗口底部一行（2026-10-12） | `packages/ui/src/app/connection-status.browser.test.tsx`、`workbench.browser.test.tsx` "connection line" | 已覆盖 |

## 已停止消息的编辑重发（M1.11 自用，2026-10-20）

| 行为 | 测试 | 状态 |
|---|---|---|
| 协议 22 的 epoch / turn 身份、正文和附件限额、纯图片、started-only 结果与错误码；客户端不乐观追加旧分支 | `packages/protocol/src/edit-stopped-message.test.ts`、`envelope.test.ts`；`packages/client/src/atrium-client.test.ts` 的 stopped edit 用例 | 已覆盖 |
| 同会话无摘要导航，user 即 leaf 和 null parent、aborted 助手尾条目、旧上下文排除、保留图片与纯图片、恢复及重启持久化 | `packages/pi/src/contract/edit.pi.test.ts` 的 `edit-aborted`、`edit-root-restore`、`edit-image-only`；五份本次 pi 1.3.0 夹具 | 已覆盖 |
| 导航取消 / 异常仍可能 handled，必须查 leaf；只允许最新操作恢复且不能覆盖新消息，元数据与模型消息路径分开；隐藏命令 id-only 编码与目录隐藏 | `packages/pi/src/edit/{edit,extension}.test.ts`、`catalog/commands.test.ts`；契约 `edit-cancel`、`edit-navigation-error` | 已覆盖 |
| 最后一轮及 stopped / 本人普通消息门禁、epoch 冲突、并发编辑和其他写入互斥、图片穿透、停止队列保留、操作中退出不自动续做 | `packages/host/src/sessions/session-controller.test.ts` 的 “editing the last stopped user message”；`packages/host/src/edit-stopped.host.test.ts` 的真实宿主与客户端场景 | 已覆盖 |
| 已读真实 leaf 才提交；提交拒绝 / handled 恢复旧分支；响应丢失不重复已落盘新 user；磁盘与内存条目不一致则停 pi，不能追加到仅内存的父条目 | `packages/host/src/sessions/stopped-edit.test.ts`；`session-manager.test.ts` “stops pi when an edit anchor exists only in memory…” | 已覆盖 |
| 缺 Atrium 扩展不把隐藏命令发给模型；上传附件随编辑路由、reserved / slash 拒绝，旧请求与已完成轮拒绝且模型请求数不增加 | `server/router.test.ts` 的 stopped edit；`edit-stopped.host.test.ts` 三个真实宿主场景（含未传 fastExtension） | 已覆盖 |
| A 底部独立编辑草稿、原气泡不动、取消和成功恢复下一条草稿、提交锁定、失败 / 冲突保留文字、图片完整恢复与失败重试、纯图片、StrictMode 与过期结果保护 | `packages/ui/src/chat/chat.browser.test.tsx` 的 stopped message editor；输入框、消息和轮相关 browser 测试 | 已覆盖 |
| client/session 独立编辑状态，切换及在途请求结果保留，旧回调不删新草稿，归档 / 移除回收 store；私有 edit 草稿仅页面内保留、不留下孤立 localStorage 正文，普通草稿仍可重启恢复 | `packages/ui/src/state/stopped-edits.test.ts` 7 项；`drafts.test.ts` 的 private stopped-edit 用例；`chat.browser.test.tsx` 的切换、附件过期重传及 StrictMode 回归 | 已覆盖 |
| 编辑、取消、失败重试、同一会话 / 标签 / 文件，磁盘旧分支保留、模型上下文不含误发消息、应用重启后恢复新分支 | `apps/desktop/e2e/edit-stopped-message.spec.ts`，真实 Electron + faux，已连续三次通过 | 已覆盖 |
| 原控制器的定时器 / 监听 / 异步上下文不因新操作回归 | `packages/host/src/sessions/session-controller.leak.test.ts`，200 次操作与异步上下文回收两项通过 | 已覆盖（既有泄漏场景；不声称新增编辑分支的专项 GC 浸泡） |

破坏检查：协议 / 客户端 7/7、宿主 9/9、pi 11/11 均实际 `CAUGHT`。宿主首轮 epoch guard 的负对照曾 `MISSED`：后置重复校验仍拒绝请求，但已错误暂停队列；补断言控制状态不改变后检出，未把重复校验当成“无意义防御”。UI 的初始 5 项、切换保留 4 项、附件过期重传 4 项、私有草稿不留孤立存储 1 项破坏检查已检出。宿主事务补测的 21 个定向破坏检查、标题 / 改名互斥与闲置 pi 重启的 3 个检查也均检出。

最终验证：`pnpm check` 与构建通过；单元和宿主 183 文件 / 3199 项通过（`--maxWorkers=2`）；UI 40 文件 / 835 项串行通过；新增真实 pi 契约 5 项不带录制开关复跑通过；控制器泄漏 2 项通过；编辑重发、运行控制与历史的 Electron e2e 共 6 项通过。检查过真实 Electron 的浅 / 暗编辑与失败截图。首轮高并发单元有 4 个既有文件系统 / git 超时，相关 45 项单独复跑通过；一次全量出现未改动的 pi-config 排队保存用例 `config_conflict`，单文件 44 项通过，最终限并发全套通过，根因未在本任务中定位。UI 并行时也复现了既有 changes-pane 动画用例不稳，单文件 13 项通过，最终串行全套通过。没有删测试、放宽超时或断言；不把这些首次失败算成绿灯。

聚焦变异：协议 / 客户端新增路径 100%（14/14）；宿主本次改动行与新事务 91.93%（319 检出、28 存活，无超时；控制器 93.60%、会话管理器 80.56%、事务 92.54%、路由 100%）；pi edit 两文件 96.65%（169 检出、4 个循环保护被删后的真实死循环超时、6 等价存活）；UI 草稿与编辑状态两文件 97.98%（243 检出、5 存活）。宿主使用保留源代码别名的 Node mutation 配置，聚焦运行控制器、事务、管理器、路由与真实宿主编辑场景，不声称跑过全库全量变异。宿主首轮 71.43% 未过，补多节点恢复、输入种类、过期读、互斥、落盘失败和重启边界后才达到上述结果。

存活项不作笼统等价豁免：pi 六项为有效树上已有的可选链 / 重复路径保护，原因在源码注明；UI 一个是 `target` 非空已蕴含 store 存在（源码有说明），另四个在本次未修改的旧命令草稿分支。宿主事务的内部阶段错误文字被最终 `edit_failed` 归一化、目标校验的可选链和 attempted/before 重复条件等不改变外部结果；仍保留并登记的覆盖缺口包括状态栏指标在编辑路径上的独立敏感性、首次扫描尚未登记时 sessionFile 与 catalog 读取来源的隔离验证，以及提交完成后立即释放代理送达的专门破坏检查。保留实现中的保护，不声称每个存活均已证明等价。

全量 `test:pi` 不是通过：本机为 1.3.0，36 个旧场景仍缺该版本夹具（本次实跑 41 通过 / 36 失败，后续只定向复跑新增五项）。本次仅新增五份编辑夹具，没有顺带升级旧夹具；待独立处理版本迁移。

### 三方审查后补（2026-10-21）

审查基线 `c90ab93`，功能 `6d10106`，合入 main 的集成点 `c037533`。外部模型由用户指定 Opus 5.5、Grok 4.7，另有独立 Claude Sonnet 5.5；均只读。Opus 首轮源码检索耗时后中止，续接同一会话提交有限范围报告；没有把未读的 UI / 协议 / 全局 1.3.0 说成已审查。后续用固定生产差异做有界补充审查，Opus 补读编辑器；Grok、Claude 针对原发现复审。没有更换用户选定模型，也未把任何一位的“没有发现”当作全库无缺陷保证。

#### Standards

Opus 未确认硬性规范、安全或正确性违规；提示事务恢复分支可读性和 `prompting` 计数重复是启发式气味，不作为借机重构的理由。保护条件、宿主稳定错误码和既有包边界保留；新磁盘读取 helper 有 JSDoc，错误参数仅含 id / epoch / 状态，不含正文。追加的 draft-child 改名门禁不把既有命名流程扩成回滚事务：已在编辑前保存的 catalog 名字仍保留，只阻止稍后向正被编辑的 pi 追加名字。普通改名路径检查后无 await 间隙，未改。

#### Spec

| 去重发现 | 修复与回归 |
|---|---|
| 中高：回退 / 恢复提高 epoch，原框失败重试永久携带旧 epoch；取消提示又让用户误以为正文不会被删除 | 活 pi 且恢复同一最后 stopped 目标时，宿主仅在本次 `edit_failed.params` 回 `turnId / epoch`；界面只消费该确认，不采用任意最新页面 epoch。不同目标、非 stopped、其他错误、缺失 / 非数字确认、旧请求完成均不能重绑。冲突提示先复制再取消。Controller、browser 与真实 Electron 的回退后拒绝—原框重试回归；关闭 UI epoch 刷新的 Electron 负对照失败。 |
| 中：回退后 pi 退出 / 确认读取失败，仅 stop 不重建视图，原消息暂时消失 | 保留每次成功的实际磁盘页，恢复失败停止 pi 后也发布最近的磁盘证明；一次磁盘证明都没有时不发布虚构页。helper 覆盖退出、末次读取失败、零成功读取；原来仅断言 stop 的用例补完整分支断言。 |
| 中：会话管理器首次 await 前没有编辑预约，已排队交接不复查；draft-child 改名跨 await 可能在回退中补写 pi | 编辑从入口占 `prompting`，完整 await Controller 后才 finally 释放；交接串行回调重新查 occupied；草稿子会话在补写名字前重新查 forking。四个真实边界回归；另补两个并发预约依次释放的回归，防首个失败清掉另一请求的预约或计数泄漏。 |
| 低：等待刷新后拒绝过期请求，已经提前暂停队列 | 通过二次 epoch / 目标检查才暂停；同一 stopped 用户的新部分回复和 done 两种刷新变化均拒绝且保持完整 `IDLE_CONTROL`。 |
| 低中：恢复已停止 pi 却仍确认 retry epoch，下一次 attach 又使其过期 | 已退出时只回 `status: exited`，不回 retry 标识；正文继续留在原编辑器，提示复制后取消、重新打开会话。Controller 的受控退出事件时序与 browser 覆盖，不将需要重开说成可直接重试。 |

修复完成后的验证：`pnpm check`、构建通过；单元 / 宿主 183 文件 **3216** 项、UI 40 文件 **844** 项、相关 Electron **6** 项、新增真实 pi 契约 **5** 项、Controller 泄漏 **2** 项通过。只用隔离 HOME / faux，没有请求真实聊天模型或替换当前应用。新增测试的条件式脚本曾被 lint 拒绝，已改成声明式应答队列 / 参数表，无规则豁免；首次宿主变异 dry-run 发现旧 no-extension 用例未同步新增恢复参数，已改为精确断言 epoch / turnId，而非放宽为只检查错误码。

新增定向破坏检查 **23/23 检出**：宿主恢复 / CAS / 已退出门禁 9 项、会话管理器入口与并发预约计数 8 项、UI 恢复确认与已退出文案 6 项；另有真实 Electron 的 epoch 刷新负对照。宿主变异的完整本次范围报告为 **91.07%**（367 检出 / 36 存活 / 403，无超时），其中 Controller 93.56%、路由 100%、事务 92.09%，但会话管理器 78.95% 未够单文件 80%。补并发预约及零磁盘证明回归后，发现 command runner 的增量报告会直接复用 403/403，不能当作新测试的验证；因此对相同管理器改动范围与事务空证明门禁使用 **`--force`**，实际重跑 61 个变异：**86.89%**（53 检出 / 8 存活，无超时），管理器 **85.96%**（49/57），事务新增门禁 **100%**（4/4）。保留两份不同范围报告，不拼成一次未实际执行的全量成绩。剩余管理器存活有既有 sessionFile 首次扫描来源隔离、错误归一化 / 可选链、重复归档门禁，以及删除零计数 Map 清理的资源覆盖缺口；实现保留，不笼统豁免。

用户已选择 A、作为已知限制交付的边界：原消息停止后再改思考档位，原生 pi 的新分支可能未带上这个旧分支的配置条目，当前生成使用新档位、重开可能按新分支恢复旧档位；尚未新增专项真实重开契约。本版不额外适配或改写该类元数据，需要时在重开后重新选择档位；用户已确认按此限制合并。提交独占期不允许 Stop / Cancel 与回退穿插属于既有范围；初次独立磁盘读取失败也停止 pi 是保守故障处理，不声称已实现 fsync / 掉电事务或任意同权限外部写入的协作事务。

## pi 普通配置编辑（M1.11 自用）

| 行为 | 测试 | 状态 |
|---|---|---|
| 只接受四个普通配置名，拒绝凭据名与任意路径；携带原文和 SHA-256 版本，限制传输大小 | `packages/protocol/src/pi-config.test.ts`；`envelope.test.ts` 的命令与错误码全集 | 已覆盖 |
| 客户端读全局配置、保存项目配置时携带原始版本和原文，不经会话发送 | `packages/client/src/atrium-client.test.ts` “pi configuration” | 已覆盖 |
| 配置路径来自 pi 环境或登记的工作区；缺失只在保存时创建；JSON 对象校验、UTF-8 大小上限、并发版本冲突、原子保存、符号链接和硬链接保护、错误不泄露原文 | `packages/host/src/setup/pi-config.test.ts`；`setup/pi-config.host.test.ts` 的真实宿主与客户端及日志检查；`server/router.test.ts` 的配置路由 | 已覆盖 |
| 设置内选择全局或当前工作区的配置，编辑、保存、重读；无效 JSON、失败与冲突保留草稿，未保存退出确认和保存期间保护 | `packages/ui/src/settings/pi-config-group.browser.test.tsx`（含保存时的丢弃确认保护）；`settings-panel.browser.test.tsx` “does not let the workbench shortcut discard a config draft” | 已覆盖 |

审查后新增回归（2026-10-20 已验证）：`packages/host/src/setup/pi-config.test.ts` 覆盖已删除工作区不重建、全局目录链接与末级凭据链接的区别、UTF-8 错误与成功替换后的清理；`packages/pi/src/config/` 覆盖 pi 兼容语法、共享 settings 锁及锁释放；UI 的配置与工作台测试覆盖统一确认、背景不可交互、过期成功/失败响应、BOM/CRLF；`apps/desktop/e2e/pi-config.spec.ts` 从设置保存带 BOM、CRLF、注释及尾逗号的 models，再经真实 pi 刷新模型目录验证加载（桌面端到端已通过）。settings-lock 的目录和心跳泄漏测试通过。锁文件变化后补齐 Shiki 四个子路径预构建，并以清空本工作树 UI 的 Vitest 缓存后全套 786 项通过证明不会再中途重载。

审查修复并集成 main 后的验证（2026-10-20）：`pnpm check`、构建、单元/宿主 3053 项、UI 794 项、相关桌面端到端 4 项通过。`models.spec.ts` 曾在 ⌘N 后因模型胶囊的文字与旧对话相同而提前输入，现等待新对话登记且旧消息离场，不增加睡眠或重试。

聚焦变异验证：协议与客户端新增路径 100%（31/31），宿主配置/路由与 pi 配置适配器 87.97%（350 检出、1 个读循环体被删的真实死循环超时、48 个存活，共 399 个；门槛 ≥80%）。pi 文件锁自身 100%，语法校验 95.92%，宿主服务 86.14%。逐项审阅存活边界，不声称全部等价、不做笼统豁免：原有 OS Error 类型、UTF-8 默认值与重复元数据检查等价在源码注明；其他存活仍包括工作区登记并发撤销/根目录替换的部分元数据分支、锁前后重复版本检查、锁损坏错误映射、清理异常、仅改变字符串内容但不改变根对象有效性的语法变异，以及删除队列 Map 清理的内存覆盖缺口。实现保留全部保护，但现有测试不能证明这些每一条分支；后续增量或每夜变异继续跟踪。现有客户端、宿主连接和新增 settings-lock 心跳/目录泄漏测试三项通过；尚未加入配置队列自身的 GC 泄漏测试。

## pi 链路（M1.2）

| 行为 | 测试 | 状态 |
|---|---|---|
| faux 模型在真实 pi 进程里按脚本流式输出推理和文本，以 `agent_settled` 结束 | `packages/testkit/src/faux/faux.pi.test.ts` "streams scripted thinking and text…" | 已覆盖 |
| faux 的工具调用由 pi 真实执行（`stopReason: "toolUse"`），结果进入下一轮 | faux.pi.test.ts "lets pi really run a scripted tool call…" | 已覆盖 |
| faux 的错误回复、放慢后中途中断 | faux.pi.test.ts "ends a reply scripted as an error…"、"can be interrupted mid-stream…" | 已覆盖 |
| faux 下 pi 的配置目录在测试目录里，不碰用户的 `~/.pi` | faux.pi.test.ts "keeps pi's agent directory inside the test directory…" | 已覆盖 |
| 同一脚本每次输出相同（夹具可复现） | faux.pi.test.ts "prints the same records on every run…" | 已覆盖 |
| 分帧只认 LF：U+2028/2029 和行内 CR 不断行，去掉一个结尾 CR，跨块的行和多字节字符能拼回，流结束时交出最后半行 | `packages/pi/src/process/jsonl.test.ts`；任意切块都能读回全部记录：`jsonl.prop.test.ts` | 已覆盖 |
| 按 id 对应乱序响应；失败响应带 pi 的错误文字；没有 id、对不上 id 的响应只记日志 | `packages/pi/src/process/pi-process.test.ts` "matches responses to requests by id…"、"rejects with pi's error text…"、"logs a response without an id…"、"gives up at the deadline…drops the late response" | 已覆盖 |
| 按命令设期限（`compact`、`bash` 不限时，调用方可改），期限走注入的时钟；`AbortSignal` 能取消，已取消的不发出 | pi-process.test.ts "waits for $type without a deadline"、"lets the caller lift or shorten a deadline"、"aborts a request through its signal…" | 已覆盖 |
| 事件按序交给所有监听者，一个监听者抛错不影响其他；退订生效；非 JSON、没有 type 的行只记长度 | pi-process.test.ts "events" 一组 | 已覆盖 |
| 能发 `extension_ui_response` | pi-process.test.ts "sends extension dialog answers to pi" | 已覆盖 |
| stderr 按行进日志，内存只留最后 8 KiB；不换行的输出按 16 KiB 分段记，多字节字符跨块不乱码 | pi-process.test.ts "logs stderr line by line…"、"logs output without line breaks in bounded pieces…" | 已覆盖 |
| 交给 pi 的环境不含 `ATRIUM_`、`ELECTRON_` 变量，`PATH` 去掉相对项 | `packages/pi/src/env/pi-env.test.ts`；pi-process.test.ts "never passes Atrium's or Electron's variables or relative PATH entries to pi"；inspect.test.ts "never gives pi --version a relative PATH entry…" | 已覆盖 |
| pi 不再读 stdin 时，等待中的请求（含不限时的）以 `exited` 失败并停止 pi | pi-process.test.ts "fails waiting requests, untimed ones included, and stops pi when it stops reading stdin" | 已覆盖 |
| pi 崩溃：退出码、stderr 尾部、等待中的请求失败；启动不了时报告原因 | pi-process.test.ts "reports a crash…"、"reports a pi that cannot be started" | 已覆盖 |
| 停止：先关 stdin，再 SIGTERM，最后连同脱离进程组的孙进程一起杀；停止后到达的响应被丢弃；停止完成时不留定时器；孙进程占着管道也能结束；杀进程树失败（如 `ps` 不能运行）时退而只杀 pi，停止仍能完成；强杀永不触及自己的进程组和 0、1 号进程组 | pi-process.test.ts "stop" 一组；`kill-tree.test.ts` | 已覆盖 |
| 真实 pi 跑完一轮；bash 工具运行中停止，不留子进程 | `pi-process.pi.test.ts` | 已覆盖 |
| 读登录 shell 的完整环境：交互式配置生效；值里的换行、等号完整保留；shell 自己的变量不要；token 和 Atrium、Electron 的变量不进入结果；rc 打印的横幅和回显不干扰；交互式卡住时退到登录 shell 并杀掉它启动的进程；都失败、启动不了、不支持的 shell 时沿用宿主环境（去掉这两类变量）；可中途取消；`.zshrc` 留下占着输出的后台任务时立即返回；超时时连另一个进程组里的后代一起杀，读不了进程表时退而杀 shell 的进程组；sh、dash、ksh 同样支持；shell 带着终端会有的基本变量启动；不给 shell 输入可等；shell 退出后才到的收尾标记照样等到；结束后不留定时器和 abort 监听 | `packages/host/src/platform/login-shell.test.ts` | 已覆盖 |
| 找 pi 并检查版本：找不到、可用、版本过低、不能运行（带 pi 的报错，没有报错时说明是退出码、信号还是超时）、输出没有版本；用找到的 PATH 运行 `pi --version`；不在相对路径和空项里找 pi，跳过名为 `pi` 的目录；启动不了（如解释器不存在）时给出系统的报错；`pi --version` 的期限走注入的时钟，超时或取消时用 SIGKILL 杀掉（忽略 SIGTERM 的也不留下），答复后取消期限、移除 abort 监听 | `packages/pi/src/locate/inspect.test.ts`、`locate.test.ts`；真实 pi：`locate.pi.test.ts` | 已覆盖 |
| 宿主启动后在后台读环境、找 pi，结果写日志但不写环境内容（`.zshrc` 里的 Key 不进日志）；关闭宿主时中止查找、不留 shell；`close()` 重复调用只关一次；工具环境里的凭据从日志里抹掉；查找意外失败时宿主照常运行、只是没有 pi | `packages/host/src/tools.host.test.ts` | 已覆盖 |
| `PiDeps` 的宿主实现：请求 id 取自当前 span 并编号；pi 的定时器计入宿主的定时器计数；日志按级别写、带当前 span | `packages/host/src/platform/pi-deps.test.ts` | 已覆盖 |
| pi 的启动、stderr、退出日志挂在 `pi.process` span 下；崩溃时 span 标为错误，宿主停止时为正常；每条命令一个 `pi.rpc` span，挂在调用方 span 下，请求 id 由它派生；命令失败时 span 标为错误 | `packages/host/src/sessions/traced-pi.test.ts` | 已覆盖 |
| `pnpm pi:try`：参数解析；事件渲染；找不到 pi 时退出码 1；真实 pi 流式打出回复，整次运行在一条 trace 里；模型回复失败时退出码 1，重试后成功时退出码 0；环境（含登录 shell 里的）中的凭据不进日志；中断时停掉 pi、退出码 130 | `packages/host/src/dev/try-pi.test.ts`、`try-pi.pi.test.ts` | 已覆盖 |
| pi 契约：一轮完整运行、工具调用、运行中排队与 `queue_update`、命令被处理掉、`clear_queue` + `abort`、会话文件延迟写出、`get_entries` 全量与增量和未知游标、自动重试与不可重试错误、对话框往返、压缩期间发消息报错、退出码 | `packages/pi/src/contract/*.pi.test.ts`（12 个场景，同时检查夹具） | 已覆盖 |
| 夹具：规范化（时间、度量、路径、UUID、只在固定键下识别的条目 id 及其引用，以及已认出的条目 id 在其他文字里的出现）、比较时只忽略系统消息的文字、录制顺序、文件格式；每个夹具按原样回放；回放替身的对上检查、错误详情、崩溃后和停止后的请求、`stop()` 丢弃迟到的响应并按夹具结束、对话框 | `packages/testkit/src/pi-fixtures/*.test.ts`、`packages/pi/src/contract/replay.test.ts` | 已覆盖 |
| faux：回复可以等测试放行，中断会结束等待；`/faux-noop`、`/faux-confirm` | `packages/testkit/src/faux/faux.pi.test.ts` | 已覆盖 |

## 协议、客户端与流式显示（M1.3）

| 行为 | 测试 | 状态 |
|---|---|---|
| 协议 schema：每条命令和事件按线上的 JSON 形态通过校验；未知命令和无效消息分开，能读出 `requestId` 就带上；字段越界、多余字段、错误的 traceparent 和 trace id 被拒；错误码、停止原因、运行结果、退出原因的每个取值 | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| `welcome` 带心跳间隔和每次启动都不同的宿主实例 id | ws-server.host.test.ts "welcomes with the heartbeat and an instance id…" | 已覆盖 |
| 每条命令一条应答：结果、`CommandError` 的错误码和参数、其他异常一律 `internal_error`（只记日志，不发原文）、未知和无效消息带能读出的 `requestId`；`ping` 和界面问题上报由 router 直接处理 | `packages/host/src/server/router.test.ts`；ws-server.host.test.ts 的限流、"answers only the first of two hellos" | 已覆盖 |
| 命令 span 以命令的 `traceparent` 为父，link 到连接的 `ws.connect` | router.test.ts "answers ping in a command span…"；`packages/host/src/chat.host.test.ts` | 已覆盖 |
| 心跳：宿主按注入的时钟 ping，到下一次还没 pong 的客户端被终止，正常的继续 | ws-server.host.test.ts "pings clients on the injected clock…" | 已覆盖 |
| 发送端背压：积压超过上限以 4507 关闭，之后不再发送 | `packages/host/src/server/connection.test.ts` | 已覆盖 |
| 订阅：整组替换，只对新加入的会话发快照；只把会话事件发给它的订阅者；断开时清掉 | `packages/host/src/sync/subscriptions.test.ts`；session-manager.test.ts | 已覆盖 |
| 事件翻译：真实 pi 输出（推理、文字、出错重试、中断）翻译成带自己 id 的消息和增量；工具调用先不显示且不占位；漏掉开头的块也有序号；停止原因的映射；用户消息的文字 | `packages/pi/src/events/translate.test.ts` | M1.4 改为按轮，见"对话记录（M1.4）" |
| 会话控制器：一次运行从 `agent_start` 到 `agent_settled`，带 `prompt` 的 trace；事件按序编号；用户消息带对应 `prompt` 的 `requestId`（`handled` 的跳过）；快照含流式中的消息和运行；运行结果；pi 崩溃时运行失败并报告退出，之后的 `prompt` 被拒 | `packages/host/src/sessions/session-controller.test.ts`（含夹具回放） | 已覆盖 |
| 新建对话：在 `chats/` 下建目录、在里面启动 pi、用 pi 报告的会话 id；pi 没找到、不可用或启动即退出时 `pi_unavailable`；未知会话 `session_not_found`；宿主关闭时停掉所有 pi | `packages/host/src/sessions/session-manager.test.ts` | 已覆盖 |
| 一轮对话经 WebSocket：新建、订阅得到快照、发消息得到按序编号的流式事件；两个客户端订阅同一会话收到同样的事件；真实客户端从新建到看到回复替换掉乐观显示的消息 | `packages/host/src/chat.host.test.ts` | 已覆盖 |
| 客户端连接：握手、只认真的 welcome、拒绝原因且不重试、主动断开不重试、替换连接时忽略旧 socket、断线按退避重连（最后一档重复，连上后归零）、可关闭重连、心跳 ping 到下一次没应答就断开 | `packages/client/src/atrium-client.test.ts` | 已覆盖 |
| 客户端命令：每条新的请求 id 和 trace；结果按 schema 校验；错误应答变成 `CommandError`；没有连接或断线时 `ConnectionLostError`、不重发；上报截断到 4 KB | atrium-client.test.ts | 已覆盖 |
| 会话视图：订阅时创建、退订时释放；快照整体替换；事件按序应用，缺口、重复、换代都重新取快照；流式只复制改动的那一块；乐观显示的消息在确认、失败、被 extension 处理时移除；重连后重新订阅 | `packages/client/src/session-view.test.ts`、atrium-client.test.ts | M1.4 改为按轮，见"对话记录（M1.4）" |
| 回复渲染：排得紧凑（行高 1.55、块之间 12px、列表项上下 2px，圆点在第一行中线）、GFM（表格、嵌套与任务列表、删除线）、无序列表的圆点自己画（5px、靠近文字，折行和文字对齐，有序列表不变，任务列表只有勾选框）、中文标点旁的加粗、`$$…$$` 与 `\(…\)` 公式而不认单个 `$`、Shiki 高亮与 diff、Mermaid、链接交给系统浏览器且不弹确认、`https` 图片直接显示而 `http` 图片变成链接、原始 HTML 按文字显示且不执行 | `packages/ui/src/chat/markdown.browser.test.tsx`、`markdown-transforms.test.ts` | 已覆盖 |
| 覆盖"回复渲染"全部范围的样例按真实节奏分片流式渲染，每一步都不出错，结束后与一次性渲染逐字节一致 | `packages/ui/src/chat/streaming.browser.test.tsx`（样例 `reply-showcase.md`） | 已覆盖 |
| 平滑揭示：只放慢增长部分；每帧按积压量揭示、约 150 毫秒的时间常数；长时间停顿也只算 250 毫秒；不切断字形，未到齐的字符等到齐；结束时一次显示完 | `packages/ui/src/chat/text-reveal.test.ts`；基准 `text-reveal.bench.ts` | 已覆盖 |
| 滚动跟随：停在底部时跟随；往上翻停止跟随并出现"回到底部"，有新内容时带圆点；点了回到底部并恢复跟随；下方变高（输入框、卡片）时仍在底部；最后一轮的过程展开、步骤详情打开、过程折叠时每一帧都在底部；不在底部时这些都不移动视窗 | `packages/ui/src/chat/follow-bottom.test.ts`、`chat.browser.test.tsx` | 已覆盖 |
| 对话区：用户气泡（乐观显示的没有时间）、推理过程运行时展开结束后折叠、回复出错和已停止的标注、"进行中 · 12s"、各部分的顺序；输入框回车发送、Shift+回车换行、输入法组字时不发送；第一次发送时新建对话并订阅；发送失败的原因 | `packages/ui/src/chat/chat.browser.test.tsx` | M1.4 改为按轮，见"对话记录（M1.4）" |
| 等待回复（2026-10-11 定）：空闲时发出消息起显示"进行中"行（宿主开始运行前不带计时），运行中发的进排队、不显示；这一轮还没有可显示的东西时这一行留在轮里，回复出来后去掉，没东西就停止的轮不显示；行首是眨眼的小猫（装饰，不进无障碍树） | `packages/ui/src/chat/chat.browser.test.tsx` "run line"、"counts the run's time" | 已覆盖 |
| 在真实应用里发消息，推理和流式回复显示出来，运行结束后推理折叠成"思考了 N 秒"，没有残留的计时和乐观显示 | `apps/desktop/e2e/chat.spec.ts` | 已覆盖 |
| 客户端订阅和退订 1000 个会话后视图全部释放，并能被回收 | `packages/client/src/atrium-client.leak.test.ts` | 已覆盖 |
| pi 拒绝消息时的错误码：运行中或压缩中回 `session_busy`，其他拒绝回 `pi_rejected`（带 pi 原文），退出或停止回 `pi_unavailable/exited`，不回应回 `unresponsive`；回显先到、失败后到时不删别的 prompt 的位置；`prompt` 不设期限 | `packages/host/src/sessions/session-controller.test.ts`；`packages/pi/src/process/rejections.test.ts` | 已覆盖 |
| 新建对话：pi 报不出会话 id 时停掉它；管理器关闭后才建好的对话停掉自己的 pi | `packages/host/src/sessions/session-manager.test.ts` | 已覆盖 |
| 快照带 `exited`；客户端发现宿主重启后把旧会话标为已失效、保留已显示的消息、不再订阅；同一宿主重连照常订阅 | session-view.test.ts、atrium-client.test.ts | 已覆盖 |
| 心跳没应答时立刻放弃连接：等待中的命令失败、开始重连，晚到的关闭事件不重复处理；已连接时再次连接让旧命令失败；等待重连时断开变成"已断开" | atrium-client.test.ts | 已覆盖 |
| 对话界面：运行中不能发送；连按两次只建一个对话；会话已退出或已失效时下一条消息新建对话；新错误码的文字 | `packages/ui/src/chat/chat.browser.test.tsx` | 已覆盖 |
| 滚动跟随不被自己滚动的那次事件打断，即使其间内容又长高了 | follow-bottom.test.ts | 已覆盖 |
| 滚动跟随不被浏览器的滚动锚定打断：上方和下方在两帧之间都变高时仍在底部；运行中过程逐步变长时每一帧都在底部 | `chat.browser.test.tsx` "…between frames"、"…process grows step by step" | 已覆盖 |
| 流式渲染走真实路径：经消息列表和平滑揭示流式显示，顶层块只增不减、已写完的块文字只增不减（图块除外），结束后在别处重新挂载，与直接渲染已完成的回复一致（2026-10-24 改：原先断言整段文字只增不减，和"源码换成渲染结果"冲突，见文末"已知不稳的测试修复"） | `packages/ui/src/chat/streaming.browser.test.tsx` "streams through the transcript as the app does, never dropping a finished block or shrinking it, and ends as the finished reply renders" | 已覆盖 |
| 界面的未捕获错误、未处理的 Promise 拒绝和长任务上报给宿主，每类每 10 秒最多一次，卸载后停止 | `packages/ui/src/app/issue-reporting.browser.test.ts` | 已覆盖 |
| 50 tok/s 流式输出长 Markdown 时没有超过 50 毫秒的长任务，帧时间 p95 ≤ 16.7 毫秒 | `apps/desktop/e2e/chat.perf.spec.ts` | 已覆盖 |

## 对话记录（M1.4）

| 行为 | 测试 | 状态 |
|---|---|---|
| pi 契约：一份会话历史含推理、bash/write/edit/read 工具（一次回复一个调用，pi 并行执行同一回复里的调用，事件顺序不定）、出错重试（错误回复和移除它的 `context_edit`）、手动压缩（切开一轮）、`/faux-navigate` 回到早先的条目再分支；13 路并发两轮都与夹具一致 | `packages/pi/src/contract/history.pi.test.ts`（夹具 `history.jsonl`） | 已覆盖 |
| 事件翻译：真实 pi 输出翻译成按块位置的推理、文字、完整的工具调用、工具的实时输出、结果、自动重试和压缩结束；漏掉开头的块先补开头；重复的开头只报一次；部分参数和其他更新不报；没有时间的消息用翻译器的时钟；嵌套工具调用的输出不报 | `packages/pi/src/events/translate.test.ts` | 已覆盖 |
| 条目映射：真实会话的每个条目变成 Atrium 的形状（用户、助手的推理/文字/工具调用、工具结果、压缩、重试移除、其他条目只留树中位置）；消息按自己的时间，其他条目按条目时间，读不出时为 0；流式中和延迟的停止原因算正常停止；用量只留输入输出；用户消息的图片数；替换而不是移除的 `context_edit`、`!bash` 消息不显示 | `packages/pi/src/history/log-entry.test.ts` | 已覆盖 |
| 工具详情：bash 的命令、read 的路径和范围（非整数不算）、edit 的展示 diff 和增删行数（运行中没有 diff）、write 的内容只来自参数；`file_path` 旧名；字段缺失和其他工具没有详情；内容块的文字拼接和图片计数 | `packages/pi/src/history/tools.test.ts` | 已覆盖 |
| 协议：轮、步骤（每种）、工具详情（每种）、提示条、轮级事件、带 `items` 和 `hasOlder` 的快照、`fetch_transcript` 及其结果和上限、`transcript_changed`；越界和未知取值被拒 | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| 规则：块对应的步骤和位置 id；输出按 UTF-8 字节截到 16 KB，bash 留结尾、其他留开头、不切开字符；实时输出与结果（详情按结果重算）；结束时运行中的工具改为未完成；结果按最后一条回复（完成、停止、出错带原文，工具调用后或没有回复算停止）；改动汇总（编辑累计、写入后不计行数、只算成功的、按首次出现排序）；用量相加 | `packages/host/src/transcript/rules.test.ts` | 已覆盖 |
| SessionLog：沿 pi 报告的叶子走出当前分支，其他分支不算；新条目；叶子可以不随新条目移动；缺父和环处停止；清空 | `packages/host/src/transcript/session-log.test.ts` | 已覆盖 |
| 重建：真实会话两个分支的完整结果（工具、重试、轮间压缩、分支）；插话规则；重试按 pi 的计法编号，每轮重新计；没有失败的被移除回复不算重试；轮中的压缩放在轮后、轮前的就地；回复前的孤立消息和不认识的工具结果跳过；按最后一条回复结束；用时由时间戳推算、用量相加；当场看到的轮用实时 id、`clientMessageId` 和计时 | `packages/host/src/transcript/projection.test.ts` | 已覆盖 |
| 对话记录：跟着真实会话实时构建，每次运行后用条目重建都与推过的一致，压缩后只追加提示条，换分支后报告变化；第一轮按块逐步推出的事件；按宿主时钟计时轮和推理；插话不占 `prompt` 的 id；非插话的用户消息结束上一轮；结束时未完成的工具；没有轮时忽略事件；重建不一致时报告变化；实时的轮从末尾对应到新条目；重置后重读；快照取最近 20 轮及其后的提示条；按条目往前分页 | `packages/host/src/transcript/session-transcript.test.ts` | 已覆盖 |
| 会话控制器：真实会话回放，四次运行都在同一 epoch，压缩后推 `notice_added`，换分支后 epoch 加一并推快照；`get_entries` 的游标；分页和过期 epoch、未知条目回 `transcript_changed`；运行中的轮在快照里；开始时用给定的条目；运行结果按最后一轮；崩溃时先结束轮；一次只读一页、期间再要求就再读一次；读的期间开始运行就等运行结束；运行中和退出后不读；未知游标时全部重读；其他失败上报并等下次；没有变化不推 | `packages/host/src/sessions/session-controller.test.ts` | 已覆盖 |
| 会话管理器：新建时读一次条目；运行后再读与推过的一致，不多推事件；`fetch_transcript` 交给会话；scripted pi 按次序回答同一命令（`sequence`） | `packages/host/src/sessions/session-manager.test.ts`、`chat.host.test.ts`、`server/router.test.ts` | 已覆盖 |
| 客户端会话视图：轮的开始、步骤增加、增量、更新、结束、提示条；只复制改动的轮和步骤；找最后一个同 id 的轮；新 epoch 的快照整体替换；对不上的步骤事件重新取快照；更早的页放在前面，过期 epoch 或已不在最前的丢弃 | `packages/client/src/session-view.test.ts` | 已覆盖 |
| 客户端分页：一次只取一页，同时的请求共用一次；不在观察、加载中、已失效或没有更早的不取；`transcript_changed` 时重新取快照，其他失败往上抛 | `packages/client/src/atrium-client.test.ts` | 已覆盖 |
| 界面的轮：过程折叠成标题行（"已完成，用时 · 读了 · 跑了 · 改了 · N 条命令没走通"，展开时只有"已完成，用时 N"），折叠时插话仍可见；只有推理时显示"思考了 N 秒"或"思考过程"；没有过程时没有标题行；点击步骤展开详情（命令输出、截断说明、带行号和增删竖条的 diff）；运行中展开、正在进行的步骤转圈，详情不自动展开、点开后实时显示（2026-10-13 改）；已停止、出错（可展开原始报错）；信息行（复制回复的 Markdown 原文，只有这一个复制按钮；改动胶囊展开文件和 diff、用量、结束时间）；小菜单按钮选中、Esc（不传给外层）和点击外部关闭（`menu-button.browser.test.tsx`）；提示条展开压缩摘要 | `packages/ui/src/chat/turn.browser.test.tsx`；纯函数：`turn-layout.test.ts` | 已覆盖 |
| 过程轨道（2026-10-12）：标题和各行文字从 30px 起，主线节点在 10.5px、支线节点在 19.5px；节点（做完的圆点、探索的放大镜、进行中、走不通的支线、汇入的插话）；跑完后轨道停在最后一步，下面没有竖线，没有完成行，停止、出错只在标题行写；工具的动词随状态（正在运行 / 运行了 …）、编辑的文件胶囊带增删行数、悬停看全路径、文件胶囊前是 material-icon-theme 的类型图标（M1.12 起，认不出的是主题的通用文件图标）；探索行"探索了代码库 · 读了 N 个文件，搜索了 M 次"，读过的文件胶囊最多 5 个加"+N 个"；没有内容的推理（空的或全是空白，模型藏起了推理）和空的文字步骤不是按钮、任何模式和运行中都没有详情块；当场跑完的轮停 1 秒再平滑折叠（`after` 定时器，点标题行或卸载时取消），摘要淡入；折叠和展开的时长（高度 0.4 秒，各行 0.22 / 0.26 秒、依次晚 14ms，摘要晚 0.16 秒淡入 0.26 秒）；展开从高度 0 长出来，折叠从当前高度收起；减弱动态效果时直接切换；运行中新到的步骤播放进场，已有的不播 | `packages/ui/src/chat/turn.browser.test.tsx`；纯函数（`describeStep`、`describeExplore`、`exploredFiles`）：`turn-layout.test.ts`；端到端：`apps/desktop/e2e/chat.spec.ts`（跑完后自动折叠） | 已覆盖 |
| 会话文件与打开会话：M1.4 的"最近会话"列表在 M1.5 由侧栏和"历史"取代，读取和打开的测试见"项目、工作区与会话（M1.5）" | — | 已取代 |
| 用 pi 写的真实会话文件恢复：工具、重试、压缩在当前分支上，另一个分支不显示，提示条在它所在的轮之后，过程标题行的统计；接着发消息照常运行 | `apps/desktop/e2e/history.spec.ts` | 已覆盖 |
| 审查后补上（2026-10-08）：当场看到的轮和插话按记录重建（停在工具结果之后的下一轮仍是新的一轮）；上下文溢出的恢复不算重试；空报错按 pi 写 "Unknown error"；任何位置新增的提示条都推 `notice_added` 并带插入位置；pi 崩溃中断的一轮为 `failed`；长文字以预览发送、标 `partial`，`fetch_step` 取回完整步骤，快照和分页按 4 MB 装；`write` 的内容只发一份；打开目录已不存在的会话回 `session_cwd_missing`；刷新失败的日志只记命令和原因；扫描会话目录只认 LF、可随关闭中止；界面的时间经注入的时钟；导出遇到重建时报错而不是导出一部分 | `packages/host/src/transcript/*.test.ts`、`sessions/*.test.ts`、`packages/client/src/*.test.ts`、`packages/pi/src/sessions/session-files.test.ts`、`packages/ui/src/chat/*.test.ts(x)` | 已覆盖 |
| 同一回复里的并行工具调用：只由手写的条目和事件覆盖（重建、实时），录制的场景每次回复只调一个工具，因为 pi 并行执行时事件顺序不定 | `projection.test.ts`、`session-transcript.test.ts`、`translate.test.ts` | 部分覆盖 |
| 打开 1000 轮的会话到首屏 ≤ 500 毫秒（中位数，实测约 25 毫秒；第一次打开含启动 pi 约 1 秒） | `apps/desktop/e2e/history.perf.spec.ts` | 已覆盖 |
| 2000 轮会话的对话记录重建（基准，本机中位约 2.4 毫秒） | `packages/host/src/transcript/rebuild.bench.ts` | 已覆盖 |
| 对话区：轮、提示条、待确认的消息、运行状态的顺序；运行的计时在轮里；滚到顶加载更早的，且阅读位置不动；提问导航条跳转；长消息折叠与展开；导出会话时取完所有页 | `packages/ui/src/chat/chat.browser.test.tsx`、`packages/ui/src/app/workbench.browser.test.tsx`、`packages/ui/src/tabs/session-menus.test.ts` | 已覆盖 |

## 项目、工作区与会话（M1.5）

| 行为 | 测试 | 状态 |
|---|---|---|
| 索引文件：原子写入、权限 0600；版本逐级升级并留 `.v<N>.bak`；新版本拒绝且不改文件；不是 JSON、版本无效、格式不符、缺少升级步骤时挪成 `.corrupt-<时间>.json` 并从空开始；保留不认识的字段；写入期间的多次保存只写最新的一次；写入失败不留临时文件、之后还能再写；缺文件不算损坏 | `packages/host/src/store/index-file.test.ts` | 已覆盖 |
| 宿主单实例：锁文件记进程号和启动时间；活着的宿主占着就拒绝；进程已不在、早于开机、内容损坏或形状不对时接管；只删自己的锁；同一家目录第二个宿主启动失败、第一个关掉后能启动；启动失败也释放锁 | `packages/host/src/store/host-lock.test.ts`、`server/ws-server.host.test.ts` | 已覆盖 |
| 应用单实例：同一家目录第二次打开时退出并让第一个窗口回到前面；设了 `ATRIUM_HOME` 时 Electron 的数据跟着它 | `apps/desktop/e2e/app.spec.ts` | 已覆盖 |
| 损坏的索引文件在列表里报告一次、界面提示到关掉为止；新版本格式拒绝启动、改回后能启动；偏好和每个客户端的布局跨重启保留 | `packages/host/src/index.host.test.ts`、`packages/ui/src/app/workbench.browser.test.tsx` | 已覆盖 |
| git 调用：用工具环境、关可选锁、不弹提示、固定语言；最多同时 4 个、其余排队；按注入的时钟超时（默认 30 秒）；取消；起不来时报 `spawn` 并释放名额；非零退出是结果不是错误 | `packages/host/src/platform/git.test.ts` | 已覆盖 |
| 合并状态（真实 git）：目录没了是已移除；Atrium 建的、没提交的是无改动；有提交是 `pending` 并数出 ↑N；merge、快进、squash（主干之后又改了别处）、cherry-pick 都算已合并；主干回滚了改动、冲突算 `pending`；外部 worktree 按 reflog 区分无改动和已合并（含 amend、只快进到主干）；没有分支或 reflog 时无法判断；没有主干时无法判断但仍报未提交；git 低于 2.38 不模拟合并；git 出错；同样的提交只判断一次，`git status` 每次都跑，知道是否未提交时可以跳过 | `packages/host/src/workspaces/merge-inspector.test.ts`、`worktree-list.test.ts` | 已覆盖 |
| 项目登记：真实路径；不存在或不是目录报 `path_not_found`；已是项目、已是某个项目的 worktree（含反过来）报 `project_exists`；仓库的子目录、没有 git 或 git 出错时当普通目录；重名加序号；同时添加同一目录只成功一个；移除只删索引；改名与重名；工作区改名和清除；只为已登记的项目记新 worktree | `packages/host/src/projects/project-service.test.ts` | 已覆盖 |
| 工作区扫描：本地工作区和各 worktree（记成外部）、分支、detached 的短提交、创建时间；目录没了和被 prune 后是已移除；普通目录、仓库子目录、没有 git 时没有分支和合并状态；没有 `origin/HEAD` 时无法判断，项目设了主干就按它；运行结束后重扫、没变化不通知；每 5 分钟和窗口聚焦（至少隔一分钟）fetch，之后不跑 `git status`；没有 `origin` 的跳过，普通目录不 fetch 它所在的仓库，目录名以空格结尾的仓库照常 fetch，fetch 失败记日志；新加的项目立刻扫描；git 出错时保留上次的结果并按原因记日志；关闭后停掉定时器 | `packages/host/src/workspaces/workspace-service.test.ts` | 已覆盖 |
| 会话文件：真实文件的会话 id、工作目录、会话名（最新的 `session_info`，去空白，空的清除）、第一条带文字的提问；不是会话的文件、坏链接、目录、其他文件、缺的和锁住的目录都跳过；只按 LF 分行；跨块的大文件；文件只增长时只读新增部分，没变的不重读，变小或没变长却改过的从头读；写了一半的行和文件头等写完；文件没了忘掉，同一路径的新文件整个读；只清理扫描的那个目录；可中止；不留打开的文件；会话目录按 pi 的顺序、目录名按 pi 的规则 | `packages/pi/src/sessions/session-files.test.ts` | 已覆盖 |
| 会话目录：只读已登记容器对应的目录并核对 `cwd`；Atrium 建的会话按记录的容器，容器不在了按目录；草稿在文件出现前列出，出现后不再是草稿；文件没了是 `missing`；丢弃草稿；归档（终端会话也记下）；每个对话目录是一个对话（2026-10-12 改，见"每个对话是一个容器"），新对话不等扫描；同一会话多个文件取最新并记日志；pi 全放一个目录时也能分开；不知道目录时只列记录；只在变化时通知、扫描期间的请求合并；关闭后停止 | `packages/host/src/sessions/session-catalog.test.ts`；兜底标题：`prompt-line.test.ts` | 已覆盖 |
| 布局：每个客户端分开；打开的标签按顺序、激活、切换容器；关掉激活的标签时右边的、再左边的接上；各客户端关掉某会话的标签；去掉消失的容器；只留最近的 10 个客户端 | `packages/host/src/sessions/layouts.test.ts`；客户端的即时更新：`packages/client/src/index-view.test.ts` | 已覆盖 |
| 会话管理器：新建对话（自己的目录）和工作区会话由宿主定 id、记成草稿、打开成标签后马上应答，pi 在后台用 `--session-id` 启动（2026-10-11 改），会话 id 不随 pi 的报告变；打开新建的草稿等这次启动、失败时报错，pi 不可用时新建照样成功、记日志，打开或第一条消息再启动；启动中关掉的空草稿照样丢弃并停掉 pi；关闭时启动到一半的会话不留 Controller，关闭后新建的不向 pi 发命令；打开终端会话用 `--session`、同时只启动一个、退出后在新 epoch 重启并给订阅者快照；目录没了、文件没了时报错不启动；重启后的草稿不启动，第一条消息时用 `--session-id`；没发过消息的草稿关掉最后一个标签时丢弃（对话的空目录一并删、有文件的留下），发过消息的保留；归档停掉 pi、关掉各处标签并丢掉 Controller（资源计数 `session.controller` 归零）；改名先启动 pi；项目移除时停掉其中的会话并丢掉它们的 Controller；运行状态进列表、运行结束重扫，草稿在 pi 报告第一轮时就重扫、运行中已能找到文件；插话记录读入和写回，读写失败只记日志 | `packages/host/src/sessions/session-manager.test.ts` | 已覆盖 |
| 插话记录：存进 `turns/<会话 id>.json`，每个条目只记一次；不适合做文件名的 id 只放内存；损坏时重来；重建时按记录把工具结果之后的消息当新的一轮，没有记录时按位置推断 | `packages/host/src/store/turn-starts.test.ts`、`transcript/projection.test.ts`、`session-transcript.test.ts` | 已覆盖 |
| 列表推送：订阅时马上给自己客户端的快照；一段时间内的变化合并成一份推给所有订阅者；断开后不再推；关闭时丢掉待推的 | `packages/host/src/sync/index-feed.test.ts`、`subscriptions.test.ts` | 已覆盖 |
| 协议与路由：新命令、快照的每种取值和越界、新错误码；路由把布局类命令连同客户端交给会话层，列表命令交给索引命令 | `packages/protocol/src/envelope.test.ts`、`packages/host/src/server/router.test.ts` | 已覆盖 |
| 客户端：每次连上都订阅列表；第一份快照前为空，之后只收同一宿主更新的快照；开标签、关标签、切容器、改偏好立刻反映；各命令的字段和结果 | `packages/client/src/atrium-client.test.ts`、`index-view.test.ts` | 已覆盖 |
| 宿主层：添加项目后推来工作区、合并状态，聚焦后出现终端会话，worktree 不能再登记成项目；偏好和布局跨重启；损坏重置；新版本拒绝启动 | `packages/host/src/index.host.test.ts` | 已覆盖 |
| 侧栏：工作区按本地、新到旧、已收尾排序，合并标签、运行状态、本地的提示；点击切换；项目折叠后显示待合并数和运行状态并记住；添加项目（取消不添加）、已存在时说明是哪个项目；搜索工作区和会话（不分大小写，结果保留到关闭）、没有匹配；对话行见"每个对话是一个容器"；工作区和项目改名、移除项目；外观三档切换并通知窗口 | `packages/ui/src/app/workbench.browser.test.tsx`；纯函数：`packages/ui/src/sidebar/names.test.ts` | 已覆盖 |
| 标签栏与对话区：当前容器的标签、激活、切换、关闭；"历史"按新到旧、标出已打开、不含归档；"+"新建；会话"···"改名、归档、复制路径（草稿不可复制）；快捷键 ⌘N、⌘T（不在任何容器时新建对话）、⌘W、⌘1–9、⌘⇧[ ]；窗口聚焦通知宿主；空状态只有一句话（2026-10-14 改，见"M1.11 自用中改"）；空状态里一输入就在当前位置新建会话（只建一次，失败显示在输入框上方），第一条消息等它建好；退出或丢失的会话先重新打开再发 | `packages/ui/src/app/workbench.browser.test.tsx`、`packages/ui/src/chat/chat.browser.test.tsx` | 已覆盖 |
| 审查后补上（2026-10-08）：pi 没在跑的会话可以先订阅、启动后补快照，消息会先启动它，启动失败时标签还在；重启后的当前标签能显示对话；第一次扫描完成前不把会话当作文件不见了，丢弃草稿前再扫一次、启动中和发送中的不丢；草稿不能改名；正在新建的会话按容器分开；移除项目先停掉其中的会话；`atrium://` 的其他主机不能导航过去；宿主锁按进程启动时间认持有者、接管时只有一个能成、残留的接管锁也能接管；git 去掉 PATH 里的相对项、超时结束整个进程组、输出过大放弃；合并判定按工作区和分支缓存、不缓存失败；git 一时读不了仓库时保留上次结果；选中 worktree 时登记它的主仓库；添加项目串行；写入失败期间保存的内容照样写出；列表推送关闭后不再挂定时器；"状态未知"标签 | `session-manager.test.ts`、`index-commands.test.ts`、`session-catalog.test.ts`、`host-lock.test.ts`、`git.test.ts`、`merge-inspector.test.ts`、`workspace-service.test.ts`、`project-service.test.ts`、`index-file.test.ts`、`index-feed.test.ts`、`chat.browser.test.tsx`、`workbench.browser.test.tsx`、`app.spec.ts`、`workspaces.spec.ts` | 已覆盖 |
| 端到端：真实 git 项目的 worktree 和普通目录在侧栏里和 git 一致，worktree 里提交后聚焦显示 ↑1，终端里开的会话聚焦后出现在对应工作区的"历史"；新建会话成标签，重启后标签、当前标签和草稿还在，⌘W 丢弃空草稿；从侧栏和"历史"打开 pi 的会话文件 | `apps/desktop/e2e/workspaces.spec.ts`、`history.spec.ts`、`history.perf.spec.ts` | 已覆盖 |
| 变异测试补测（2026-10-09，M1.6 时重测超时的变异后发现）：项目路径与 git 目录分开的仓库、只问所选目录；未知项目的移除不改动任何东西、改名；版本低于 1、没有升级步骤的旧版本挪开；每种文件缺字段时重置并记下挪到哪里；插话记录的单字符 id、已知条目不重写；合并判定的提交来源（含 `git am`、`git pull` 的合并，2026-10-09 补上）、版本号、只问给出的主分支、失败不缓存；worktree 列表的分支前缀、最后一条记录；会话文件的头部、`session_info` 的名字、读不了的文件下次从头读；工作区服务：公共目录名以空格结尾、只扫描新加的项目、裸仓库、被锁定且目录没了的 worktree、fetch 后的未提交状态、关闭时停止、fetch 的期限、日志 | `project-service.test.ts`、`index-commands.test.ts`、`index-file.test.ts`、`index-schema.test.ts`、`load-index.test.ts`、`turn-starts.test.ts`、`merge-inspector.test.ts`、`worktree-list.test.ts`、`packages/pi/src/sessions/session-files.test.ts`、`workspace-service.test.ts` | 已覆盖 |

## 运行控制（M1.6）

| 行为 | 测试 | 状态 |
|---|---|---|
| 协议：控制状态、`control_updated`、`prompt_handled`、九条新命令及其应答（`prompt` 的 `queued` 带 `itemId`、`stop` 的 `confirmed`）、三个新错误码；对话框回答只能是值、确认或取消之一；自动发出的标记和重启提示 | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| pi 的事件翻译：压缩开始、插话队列（每次完整，只取插话）、四种对话框（超时为 0 或没有即不限时）、通知及其级别；重试带 pi 的上限；终端专用的请求不翻译 | `packages/pi/src/events/translate.test.ts` | 已覆盖 |
| pi 契约（1.1.0）：运行中插话在 `queue_update` 里列出，工具这一批跑完后送达再清空；空闲时插话只进 pi 的队列、不开始运行 | `packages/pi/src/contract/steer.pi.test.ts` | 已覆盖 |
| 排队：运行或压缩期间的消息进宿主排队，运行结束、`handled` 后、压缩结束后逐条发出；编辑、删除、清空；不认识的项应答 `queue_item_not_found`；出队的那条被拒绝时先放回最前、后面的不抢先：pi 忙就等它自己的运行结束，pi 退出就交给重启后由排队发出（只发一次），其他拒绝暂停 | `packages/host/src/sessions/session-controller.test.ts` "queueing messages" | 已覆盖 |
| 插话：运行中交给 pi，发出前先记下，`queue_update` 先到也对得上，送达后应答才到也不残留；按 `queue_update` 的文字确认送达；没有运行时（空闲、消息发送中）按消息走、该排队就排队；被扩展处理时去掉待发副本；排队项改为插话，失败时放回原处 | session-controller.test.ts "steering" | 已覆盖 |
| 停止：暂停排队，pi 退回的插话放回最前，`abort`；2 秒内确认即结束，否则保持"停止中"、拒收消息和继续发送，直到 pi 确认或退出；空闲时直接确认；pi 已应答、`agent_start` 未到时也中止；`abort` 失败不算确认，等到 pi 退出；停止后空闲时新消息直接发出，排队仍暂停；反复停止同一个 pi 的运行，不在它的退出上留下等待 | session-controller.test.ts "stopping" | 已覆盖 |
| 对话框：保留到回答，只收第一个、类型要对得上；到期移除；pi 退出时作废；结束时在对话记录里留一行（回答、取消、超时、作废），运行中结束的跟在这一轮后面、重建后仍在；通知截断到 4 KB 写日志，带原长度 | session-controller.test.ts "answering dialogs" | 已覆盖 |
| 崩溃：重启 pi（新 epoch 快照 + "进程已自动重启"提示），pi 没收下的消息重发，收下了就补发"系统自动发出"的续做；未送达的插话回到排队；连续 3 次失败后出错；运行正常结束后计数归零；宿主要求的停止不重启；pi 应答后、`agent_start` 前崩溃也重发；重发时 pi 又走了，被打断的那条留给下一次重启；停止后崩溃不发出，没收下的那条进暂停的排队；重启中消息排队、停止让它和被打断的那条留在暂停的排队；另一处启动换上的 pi 直接用；停止的运行也让计数归零；"重试"续做失败的一轮、或重发重启用尽时丢失的消息（收下了就补发续做），启动失败时保留失败状态，启动期间算作重启中、再点重试不起作用、关闭会话停掉新 pi；续做的那一轮记为自动发出 | session-controller.test.ts "after pi crashes"、"retrying"；`session-manager.test.ts`（崩溃后用会话文件重启、用尽后列为出错；继续发送时启动放弃重启的 pi；重启中发消息或打开会话不另起 pi；重启中归档或关闭宿主不再启动；启动时开启自动重试） | 已覆盖 |
| 对话记录：自动发出的标记当场和重建后都在，记进 `turns/`；重启提示在重建后回到它跟着的那一项后面；重试步骤带 pi 的上限，重建后保留 | `packages/host/src/transcript/session-transcript.test.ts`、`store/turn-starts.test.ts` | 已覆盖 |
| 客户端：控制状态、`prompt_handled` 去掉待发副本；排队或被插话收下的消息去掉待发副本；运行控制命令的字段与结果 | `packages/client/src/session-view.test.ts`、`atrium-client.test.ts` | 已覆盖 |
| 界面：运行中回车排队、⌘回车插话、Esc 和按钮停止，这句提示在输入框的占位文字里（停止中是"正在停止…"），输入框下面没有提示行，停止中按钮不可用；胶囊条（排队、已暂停与继续发送、编辑删除插话清空、待送达插话数）；四种对话框卡片与倒计时；连续崩溃的错误卡片；最后一轮失败时的"重试"，重启中不给；重启提示、对话框结果提示与"系统自动发出"；停止中输入框保留文字、不发送；重试显示"第 N / M 次"或"第 N 次"；出错的会话在标签、工作区上显示"出错"，高于运行中 | `packages/ui/src/chat/run-control.browser.test.tsx`、`chat.browser.test.tsx`、`turn-layout.test.ts`、`app/workbench.browser.test.tsx` | 已覆盖 |
| 杀掉 pi 后自动恢复（端到端） | `apps/desktop/e2e/run-control.spec.ts` | 已覆盖 |
| 测试工具：faux 写下 pi 的进程号；夹具把工具耗时规范化为 0 | `packages/testkit/src/faux/faux.pi.test.ts`、`pi-fixtures/normalize.test.ts` | 已覆盖 |

## 模型与输入框（M1.7）

| 行为 | 测试 | 状态 |
|---|---|---|
| 协议：推理档位、模型、目录里的模型、会话的模型；`list_models`、`set_model`、`set_thinking_level` 及其应答；快照的 `model`、`model_updated`；`models_unavailable`；偏好的 `lastModel`、`thinkingByModel` | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| 推理档位按模型元数据算出（照抄 pi-ai 的规则），模型的基本数据，pi 的占位模型算作没有模型 | `packages/pi/src/catalog/models.test.ts` | 已覆盖 |
| 短启 pi 查模型：不带会话、在指定目录、查完停掉；默认模型必须在列表里；pi 退出带 stderr、中止时停掉 pi、中止在先不启动 | `packages/pi/src/catalog/query.test.ts`；真实 pi：`query.pi.test.ts`（faux 的模型与默认、没有凭据时列表为空） | 已覆盖 |
| 模型目录：按目录缓存、同一目录同时只查一次、刷新重查（期间的请求共用）、失败丢掉旧答案、120 秒期限、关闭时中止并等待 | `packages/pi/src/catalog/model-catalog.test.ts` | 已覆盖 |
| pi 契约（1.1.0）：模型列表、换模型和推理强度、换到不支持推理的模型时档位降到 off、未知模型被拒绝、档位规则与 pi 一致 | `packages/pi/src/contract/models.pi.test.ts` | 已覆盖 |
| 事件翻译：`thinking_level_changed` | `packages/pi/src/events/translate.test.ts` | 已覆盖 |
| 控制器：快照带模型，换模型和推理强度后读回、只在变化时发 `model_updated`、报告选择、再读条目；pi 拒绝时原样转出、什么也不变；停止中和退出后拒绝；跟随 pi 自己改档位；重启后换成新 pi 的模型 | `packages/host/src/sessions/session-controller.test.ts` "model" | 已覆盖 |
| 会话管理器：新会话先设上一次的模型和档位再读会话；没记住档位、没选过模型、记住的模型已不在（只记命令和原因）时的处理；从文件打开的会话不设；转发换模型和推理强度；未知会话 | `packages/host/src/sessions/session-manager.test.ts` "models" | 已覆盖 |
| `list_models`：工作区在其目录、对话在 `~/.atrium`；未知工作区；pi 失败给 `models_unavailable` 带最后 4 KB；其他失败原样转出；路由 | `packages/host/src/sessions/model-lister.test.ts`、`index-commands.test.ts`、`server/router.test.ts` | 已覆盖 |
| 偏好：记住上一次的模型和每个模型的档位，新会话用它们，第 1 版文件升级 | `packages/host/src/store/preferences.test.ts`、`load-index.test.ts` | 已覆盖 |
| 客户端：快照和 `model_updated` 的模型；容器的模型列表（加载中保留旧列表、失败带错误）；换模型和推理强度先在视图里生效，被拒绝时放回、宿主报告过的不动 | `packages/client/src/session-view.test.ts`、`atrium-client.test.ts` "models" | 已覆盖 |
| 测试工具：faux 可加模型（名字、推理、图片、档位表）；脚本化的 pi 可把收到的命令写到 stderr；faux 的确定性测试把工具耗时规范化 | `packages/testkit/src/faux/faux.pi.test.ts`（修了 pi 1.1.0 的 `durationMs` 让它时有时无失败的问题） | 已覆盖 |
| 界面：模型按钮（服务商图标、模型名、档位字、拉满时发光，没有模型时"选择模型"）；面板（两列：左边服务商图标栏 44×40、图标 22px、选中底色、当前模型所在服务商的小点、悬停或聚焦时左侧说出名字，右边选中服务商的模型、顶上名字和模型数、高度固定 320px；打开时选中当前模型的服务商、没有时选第一个；点图标切换、悬停不切换、面板尺寸不变；基础数据、当前模型打勾、点选即关、刷新、加载中保留旧列表、失败可展开原始报错并重试、没有可用模型的提示）；推理强度框（档位名、"3 / 4"、说明、每档 56px、拖动吸附、点格子跳档、方向键、到头不动、外部改档跟随、聚焦）；⌘⇧I / ⌘⇧E；停止中不能用；空状态显示上一次的模型、选模型时先建会话；被拒绝时说明原因 | `packages/ui/src/chat/model-picker.browser.test.tsx`、`effort-box.browser.test.tsx`、`chat.browser.test.tsx` "model button"；逻辑：`model-choice.test.ts` | 已覆盖 |
| 点阵：覆盖度、档位越高越密、拉满变彩色、同种子同图案、扫光、深浅色、扫光节奏 | `packages/ui/src/design/dots.browser.test.ts` | 已覆盖 |
| 协议：`list_commands`、`search_files` 及其应答，`fd_missing` | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| `/` 命令：pi 契约（1.1.0：extension 命令、pi 自带的 `/llama` `/mcp`、模板、skill 的顺序；模板发出时展开；插话不收 extension 命令）；映射；控制器和会话管理器（草稿先启动 pi）；路由；客户端 | `packages/pi/src/contract/commands.pi.test.ts`、`catalog/commands.test.ts`、`session-controller.test.ts` "commands"、`session-manager.test.ts` "commands"、`router.test.ts`、`atrium-client.test.ts` | 已覆盖 |
| `@` 文件：找 fd（pi 的目录优先、`PI_CODING_AGENT_DIR`、PATH 上 fd 再 fdfind、跳过不能运行的）；打分、排序、子目录范围、不出工作目录、fd 参数（字面匹配）、解析输出；真实 fd（先一层再递归、隐藏文件、`.ignore`、不含 `.git`、特殊字符、取消和 5 秒期限时停掉 fd）；同一会话的新查询取消旧的；没有 fd 时 `fd_missing` | `packages/pi/src/locate/fd.test.ts`、`packages/host/src/files/fd-query.test.ts`、`file-search.host.test.ts`、`session-manager.test.ts` "file search" | 已覆盖 |
| 输入框：`/` 列表（过滤、方向键、回车或 Tab 选中、Esc 关闭、只在开头、读不到时提示）；`@` 列表（变成小胶囊、Tab 进入目录、带空格的路径加引号、去掉胶囊、fd 缺失提示、邮箱不算、中文后面的 `@` 算）；长粘贴收成胶囊；↑↓ 历史（到最早时加载更早的）；草稿按会话存取、发送后清掉；展开；"+" 菜单；提示文字；按钮能按时光标是小手，不能按时是默认光标；对话区接上命令、文件、历史和草稿，空状态先建会话 | `packages/ui/src/chat/composer.browser.test.tsx`、`chat.browser.test.tsx` "composer"；逻辑：`composer-text.test.ts` | 已覆盖 |
| 草稿：按会话存取、清空即删、存不下时只留在内存、坏数据当没有；归档的会话、运行中从列表消失的会话清掉草稿，新宿主的第一份列表不清 | `packages/ui/src/state/drafts.test.ts`、`app/workbench.browser.test.tsx` "drafts" | 已覆盖 |
| 图片：协议（`upload_attachment`、`attachmentIds` 最多 20 张、只有图片时文字可为空、什么都没有不行、排队项的图片数、两个错误码）；宿主暂存（按连接、32 MiB / 20 张、全部在才取、30 分钟释放、断开和关闭时释放）；路由取出图片交给会话；控制器带图片发出、排队、插话、停止退回、崩溃重发；客户端上传、带图片发送、待发副本带图片数 | `packages/protocol/src/envelope.test.ts`、`packages/host/src/server/attachments.test.ts`、`router.test.ts` "attachments"、`session-controller.test.ts` "images"、`packages/client/src/atrium-client.test.ts` "images" | 已覆盖 |
| 消息图片缩略图（M1.11）：pi 包按条目 id 从会话文件读出用户消息的第几张图（只数图片块、只认四种格式、不是用户消息或没有数据时没有、还没写完的行不算、跨块的长行、读不了的文件、取消、关文件）；协议 `fetch_image`（最多第 20 张、应答只收四种格式且不为空、`image_unavailable`）；宿主由轮找到条目（读出的轮、当场看到并绑定后的轮，运行中没绑定的和没有的轮没有）、从目录登记的文件里读、没有文件或没有这张图时 `image_unavailable`、路由转交；客户端取图、按消息留着最近 50 条发出消息的预览、没发出去的不留；界面：这里发出的消息用留着的预览、其他按轮逐张取、取不到显示"图片不可用"、待发和加载中是灰框、轮结束后再取一次、64px 正方形裁切填满并换行、在气泡上方，页面留着最近 100 张取过的图（跨会话分开）、取不到的不留；端到端：真实 app 贴图发送后显示缩略图，重启后从 pi 的会话文件取回 | `packages/pi/src/sessions/session-files.test.ts` "readUserImage"、`packages/protocol/src/envelope.test.ts`、`packages/host/src/transcript/session-transcript.test.ts` "finds the entry"、`session-manager.test.ts` "message images"、`router.test.ts`、`packages/client/src/atrium-client.test.ts` "message images"、"latest 50"、`packages/ui/src/chat/message-images.browser.test.tsx`、`chat.browser.test.tsx` "shows each turn's images"、"shows the images of a message it sent"、`apps/desktop/e2e/images.spec.ts` | 已覆盖 |
| 图片：压缩（WebP、长边 2048、放进一条消息、先降质量再缩小、很小的图照原样、放不下时拒绝、不是图片时报错）；输入框（粘贴、"+"菜单、拖入、上传完才能发、只有图片也能发、模型不支持时不添加、换到不支持的模型时提示但照发、上传失败的说明、移除、切标签保留）；拖入的其他文件按工作区目录变成引用；对话区上传、过期时重传一次再发、模型不支持时拒绝；排队面板显示图片数 | `packages/ui/src/chat/images.browser.test.ts`、`composer.browser.test.tsx` "images"、`chat.browser.test.tsx` "images"、`run-control.browser.test.tsx` | 已覆盖 |
| 工作区改动（照抄 Paseo，取代本会话改动）· 协议：`watch_changes`、`watch_diff`、`changes_updated`、`diff_updated`（文件、hunk、行、状态、二进制和过大） | `packages/protocol/src/envelope.test.ts` "changes" | 已覆盖 |
| 工作区改动 · git：胶囊的数字（工作树对 merge-base，加未跟踪文件的行数，跳过二进制、过大、链接和被忽略的；比较基准：主干上用 `origin/<分支>`、分支上用 `origin/<主干>` 或本地主干、项目自己的主干；没有基准、HEAD 分离、非 git 时不显示）；面板的 diff（未提交 = HEAD 对工作树加未跟踪文件，已提交 = merge-base..HEAD；编辑、删除、重命名带旧路径、二进制、链接；单文件和累计上限保留行数；整个 diff 过大；还没有提交的仓库；非 git）；监听的根目录和被忽略的目录；输出解析；git 执行器的输出上限 | `packages/host/src/changes/checkout.host.test.ts`、`diff-text.test.ts`、`platform/git.test.ts` "too large" | 已覆盖 |
| 工作区改动 · 服务：只给有人看的工作区算和监听；文件变化 1 秒后重算、面板 150 毫秒；同样的结果不重发、新连接照样收到；`.git` 里只认 HEAD、index、refs，不认锁文件，被忽略目录不算，`.gitignore` 变了重读；linked worktree 的 git 目录；按需重算；未知工作区；没人看时停止监听、计时器和资源归零；git 失败只记命令和原因；监听坏了改为轮询（5 秒起翻倍到 60 秒，有变化回 5 秒），30 秒后重试监听，成功后停止轮询；路由、断开时清理；真实宿主、真实 git 和文件监听下数字和面板随文件变化 | `packages/host/src/changes/changes-service.test.ts`、`server/router.test.ts` "changes"、`changes.host.test.ts` | 已覆盖 |
| 工作区改动 · 客户端与界面：每个工作区的改动、面板只收自己目标的结果、刷新时保留已显示的文件、重连后重发；胶囊（紧凑数字、没有改动时不显示、对话不看）、右侧抽屉（默认模式、切换、"有没有未提交"变了回到默认、文件列表与跳转、折叠、hunk 与行号、重命名、二进制、过大、没有改动时去另一模式、不是 git、读不到、太大、刷新、Esc 和关闭；换容器时收起在 2026-10-13 改为换工作区照样开着，见"左栏折叠与右栏"；抽屉在 M1.12 改为右栏的"更改"和改动标签，见"文件与更改"）；端到端：真实宿主里改文件后胶囊和面板 | `packages/client/src/atrium-client.test.ts` "workspace changes"、`packages/ui/src/chat/changes.test.ts`、`packages/ui/src/files/right-panel.browser.test.tsx`、`chat.browser.test.tsx` "workspace changes"、`apps/desktop/e2e/changes.spec.ts` | 已覆盖 |
| 第二轮审查后修复（2026-10-10）· 插话按 pi 队列的增减条数对应（不按文字），skill 展开后照样跟得上，收回时按发出时的文字；同一会话的插话逐条发；轮到时已在停止的不发、应答 `session_stopping`；只有图片的插话带"（见图片）"；换模型被 pi 接受但读回失败时照样成功、取条目后再读；同一张上传不被两条消息同时用；工作区改动：一次 git 运行拿到状态、行数和补丁，文件与链接互换算一个文件，按面板顺序扣大小额度，大于 1 MB 的未跟踪文件只数行，读不了的未跟踪文件跳过，git 读失败显示"读不到改动"，ref 用完整名，`diff.suppressBlankEmpty` 下的空行；服务：一开始建不起监听也轮询，恢复时立刻又失败的照样轮询（按轮次），监听建好后再算一次，收尾时补上漏掉的请求，没有 git 时给结果，胶囊读失败不影响面板；界面：重新上传逐张、仍失败时放回带新上传，带引号的 `@` 不越过别的词，菜单开着时 Esc 只关菜单，空状态也有胶囊，切走容器后不再往转交的会话送字；拖入时只按文件条目对应目录（浏览器测试造不出目录条目，未单独测） | `session-controller.test.ts` "counts pi's steers"、"expanded"、"one at a time"、"placeholder"、"once a stop began"、"could not be read back"；`attachments.test.ts` "one message at a time"；`checkout.host.test.ts` "link"、"cannot read"、"damaged index"、"allowance"、"full name"、"staged"；`diff-text.test.ts` "parseDiffOutput"、"suppressBlankEmpty"；`changes-service.test.ts` "without git"、"cannot be set up"、"fails at once"、"owed"；`chat.browser.test.tsx` "one at a time"、"empty state too"、"forgets the session"；`right-panel.browser.test.tsx` "only the menu"；`composer-text.test.ts` "past other words" | 已覆盖 |
| `/` 命令端到端：输入时列出 pi 的命令，回车选中（变成标签，输入框留空），再回车发出，extension 命令处理后没有运行、标签消失 | `apps/desktop/e2e/models.spec.ts` | 已覆盖 |
| 空状态输入 `/` 建会话后，打的字、图片转到新会话的输入框并获得焦点；模型列表在连上后才请求、重连后再请求；列表还没东西可选时回车照常发送 | `packages/ui/src/chat/chat.browser.test.tsx` "before it is connected"、"handing the first words"；`composer.browser.test.tsx` | 已覆盖 |
| 审查后修复（2026-10-10）· 宿主：`@` 的查询词放在 `--` 之后，`--search-path=…` 这类查询搜不出工作目录外的东西，以 `-` 开头的名字找得到（fd 输出的 `./` 去掉）；含 NUL 的查询什么也不找、不占 fd 进程计数；停止时 pi 先发的空队列更新不丢插话，同文字的插话按"pi 从队头送达"配对图片，还在途中的插话等它到了再收回；会话拒绝的消息不释放它的图片；一次上传 20 张图不触发限流（每秒 32 MiB）；重启用尽后再启动、还没写出文件的会话重启时用它原来的模型；换模型后读回失败按 pi 的错误应答 | `file-search.host.test.ts` "looks like an fd option"、"cannot be given"；`fd-query.test.ts` "./"；`session-controller.test.ts` "share a text"、"on its way"、"read back"、"latest steer"；`attachments.test.ts` "fails"；`chat.host.test.ts` "whole allowance"；`ws-server.host.test.ts` "32 MiB"；`session-manager.test.ts` "model it had" | 已覆盖 |
| 审查后修复（2026-10-10）· pi 包与客户端：过长的命令描述和模型名截断，名字或 id 过长的整条不列；中止测试等 pi 收到命令再中止，不靠计时；两次换模型重叠且都失败时回到宿主最后报告的模型 | `catalog/commands.test.ts`、`catalog/models.test.ts` "too long"；`query.test.ts` "aborted while it reads"；`atrium-client.test.ts` "goes back" | 已覆盖 |
| 审查后修复（2026-10-10）· 界面：草稿以页面内存为准、同步写进 localStorage，写不下时留在内存并删掉旧的、存储被别处改了时重读；上传在输入框离开后完成也记进草稿；压缩中的图片显示占位、不能发送；发送失败时消息和图片回到空的输入框；空状态转交后继续打的字记在新会话、新会话先显示也能收到转交，新会话的输入框只抢一次焦点；⌘⇧I 打开模型面板后的 Esc 只关面板；新查询没回来时不选旧结果；有小胶囊或图片时 ↑ 不调历史；↑ 历史含插话；带空格的目录 Tab 进入时加引号继续找；拖入的目录带 `/` | `state/drafts.test.ts`；`composer.browser.test.tsx` "went away"、"compressed"、"model panel"、"query before"、"capsule"；`chat.browser.test.tsx` "old failure"、"before it shows"、"before its creation is answered"；`composer-text.test.ts` "quoted"、"space"、"steers"、"droppedReference"（拖入目录的判断取自拖放条目，浏览器测试造不出目录条目，只测了路径规则） | 已覆盖 |
| 变异测试补测（2026-10-10）· 插话：pi 的队列多几项就只列出几条、还在等轮到的不算，运行结束后才轮到的作为消息发出，停止收回后重新跟上 pi 的队列，pi 从别处拿到的文字照原样还回、不带图片；没人等模型列表时换模型只读回一次；上传：单个连接的数量上限，消息在途中过期的上传照样能用，断开只清自己的；`@` 的绝对路径即使工作目录里有同名目录也不搜；连接关闭时工作区改动的监听归零；客户端：第三次换模型叠上来时回到宿主的模型，宿主接受的那次算作回退的目标，别的工作区或面板关着时的 diff 不收，面板换工作区或换模式后不显示旧的文件；id 过长的模型不列、没有默认；草稿：恢复不覆盖已有的文字、粘贴、文件或图片，只有图片的草稿也转交，别处改了存储后跟上，存不下的草稿比之后的存储优先，一个监听停了别的照常，换图片只通知所在的草稿；diff 解析：多位数的计数、只在行首切分、像 hunk 头的行、二进制判断的边界、CRLF，按额度给行数的边界和顺序；git：origin/HEAD 没了时比 origin 的同名分支，在主干上而 origin 没有主干时不显示基准（不拿主干和自己比），已跟踪的二进制文件改了显示为二进制，没有共同历史时什么也不显示，只有删除，未跟踪文件只数前 500 个，已提交模式不含未跟踪文件，缺对象时"读不到改动"，预先取消，大文件数行；服务：重复显示不重发、集合变大时原来的照常收，首次结果前不再显示的连接不发，面板还开着时最后一个看数字的离开也继续监听，没人看后再显示时重新开始监听，看的工作区不见了时什么也不做，按模式各发各的、新开的面板收到没收过的，换模式不重新监听、换工作区放掉旧的，断开放掉面板的工作区，关掉的面板不影响别人再看，面板 150 毫秒只算 diff，diff 失败记日志接着算下一个模式，顶层 `.gitignore` 变了照新列表忽略，读的途中放掉的工作区不再排计时、不记日志、不建监听，不在仓库里时不监听，一次只跑一个查看，关闭时停掉一切并等查看结束、之后什么都不做，重试监听 30 秒、60 秒翻倍，不再是仓库时继续重试，轮询时面板的 diff 也更新，git 主动停下不记日志，非 Error 记为 unknown；真实 `fs.watch` 递归报告深处的路径、停止后放掉、监听不了时返回后报错 | `session-controller.test.ts` "as pi's queue grew by"、"after the run ended"、"took the steers back"、"without images"、"nobody listening"；`attachments.test.ts` "count alone"、"on its way"；`file-search.host.test.ts` "though the directory has one"；`ws-server.host.test.ts` "a connection closing"；`atrium-client.test.ts` "a third change"、"the model to go back to"、"another workspace's diff"、"moves to another in the same mode"、"switches to the other"；`query.test.ts` "too long"；`drafts.test.ts`；`diff-text.test.ts` "weighFiles"、"isLikelyBinary"、"at a header's start"、"more than one digit"；`checkout.host.test.ts` "rather than comparing main with itself"、"tracked binary file"、"origin's own branch"、"no history in common"、"lines removed alone"、"first 500"、"among a branch's commits"、"object gone"、"called off"、"a chunk at a time"；`changes-service.test.ts` "who is shown what"、"the panel's targets"、"the ignored directories"、"looks"、"closing"、"watching again"；`watch-directory.host.test.ts` | 已覆盖 |

## 状态栏（M1.8）

| 行为 | 测试 | 状态 |
|---|---|---|
| 协议：会话指标（轮、步、token、费用、推理、当前分支、上下文、计时，允许未知）、快照的 `metrics`、`metrics_updated`、偏好的 `statusBar` 与 `set_preferences` | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| pi：条目里助手消息的四种 token 和推理 token、系统消息的大小（正文、分段、增减的工具）、压缩条目的系统提示词检查点；系统提示词和工具定义的回放与估算和 pi-ai 的 `getCurrentSystemMessage`、pi 的 `estimateTokens` 一致（含录制的会话）；`get_session_stats` 的映射（没有模型、压缩后、窗口为 0、异常数值）；契约：真实 pi 的统计按整个文件数，和条目相加一致；事件翻译的 `request_started`、`output_started`；夹具把统计里的 token、费用、百分比归一化 | `history/log-entry.test.ts`、`history/system-prompt.test.ts`、`stats/session-stats.test.ts`、`contract/stats.pi.test.ts`、`events/translate.test.ts`、`testkit/src/pi-fixtures/normalize.test.ts` | 已覆盖 |
| 宿主：读统计的时机（pi 启动、每条回复、压缩、运行结束、换模型）、一次只读一次、读失败保留旧值只记原因（pi 退出不记）、关闭后不再发布；从 `turn_start` 计时：首 token 平均、模型用时（含失败）、最近一次的输出速度、请求里的压缩不算、pi 换掉时丢掉未完成的计时；条目算出整个文件的推理 token、当前分支的 token 和上下文分段；起始条目不发布；控制器接上后快照带指标、变化推 `metrics_updated`、崩溃后读新 pi、宿主停掉后重新启动时照样读和发布；偏好保存改过的分组、整份替换、旧文件和非法 id | `sessions/session-metrics.test.ts`、`session-controller.test.ts` "status bar figures"、`session-manager.test.ts`、`store/preferences.test.ts`、`server/router.test.ts`、`chat.host.test.ts`、`transcript/session-log.test.ts`、`session-transcript.test.ts` "entries" | 已覆盖 |
| 客户端：快照和 `metrics_updated` 的指标、`statusBar` 整份替换 | `packages/client/src/session-view.test.ts` "status bar figures"、`index-view.test.ts` | 已覆盖 |
| 界面：数字格式（K、M、千分位、秒、tok/s、≈ $）、缓存命中、上下文比例与 70%/85% 变色、分段（不小于 0）、分组注册表与默认、只记与默认不同的选择；状态栏默认三组、按选择显示、未知显示"—"、悬停卡片（鼠标移开就收起，点过之后也收起，键盘聚焦时弹出；会话统计、Token 用量含推理与当前分支、上下文分段、没有窗口和刚压缩、费用）、调节面板（预览、开关、恢复默认、Esc 和点外面关闭、Esc 不传给输入框）；对话区里显示会话的指标、空状态不显示、选择发给宿主；状态栏高 28px、离输入框 4px、离底边 8px，输入框文字离卡片左边和上边 20px，空状态和会话里输入框位置一致（2026-10-12） | `packages/ui/src/chat/status-figures.test.ts`、`status-bar.browser.test.tsx`、`chat.browser.test.tsx` "status bar" | 已覆盖 |

## 并行、同步与关注（M1.9）

| 行为 | 测试 | 状态 |
|---|---|---|
| 列表同步 · 宿主：整份列表按 id 比出变化，每批变化取下一个 `seq`、各客户端共用；30 毫秒内的变化合成一批；布局只发给自己、不占 `seq`；带游标订阅时补发游标之后的变化（布局和偏好整份），别的宿主、早于记住的删除、比游标落后超过 200 项、游标超前时发快照并写明原因；断开的连接不再发，关闭后不再推 | `packages/host/src/sync/index-feed.test.ts`、`sessions/index-commands.test.ts` | 已覆盖 |
| 列表同步 · 客户端：快照整份收下，变化只在同一 generation 上应用（原位替换、新的放末尾）；重连时带上自己的游标订阅 | `packages/client/src/index-view.test.ts`、`atrium-client.test.ts` | 已覆盖 |
| 先读到自己的写：宿主应答一个连接的命令前先把等着发给它的列表变化发出去（解析不了的消息不算）；客户端改布局的命令（打开、关标签、选容器）没应答前保留自己选的布局，全部应答后换成宿主最新的布局，失败的命令也就此回退 | `sync/index-feed.test.ts` "flushed"、`sessions/index-commands.test.ts` "IndexCommands.answering"、`server/router.test.ts` "before answering any of its commands"、`atrium-client.test.ts` "keeps the tab chosen while a layout the host made before reaches it" | 已覆盖 |
| 关注 · 宿主：运行失败（轮次自己失败、有错误原文）标"出错"，像凭据问题的标"待授权"；崩溃重启用尽也标；一次运行只标一次；下次运行开始时去掉；看过只清"出错"，标记写进索引、重启后还在；等待回答的时间在对话框出现时记、没有对话框或 pi 退出时去掉 | `session-manager.test.ts` "SessionManager attention (M1.9)"、`session-catalog.test.ts`（标记）、`server/router.test.ts` | 已覆盖 |
| 关注 · 界面：状态优先级（待回答 > 待授权 > 出错 > 运行中）和图标；工作区状态不算归档的；收件箱跨项目汇总、按优先级再按时间排、展开后最多显示 3 条可再展开；显示出错的会话时（窗口有焦点或获得焦点）发 `clear_attention` | `packages/ui/src/sidebar/status.test.ts`、`workbench.browser.test.tsx` "status"、"inbox"、"attention and hand-off" | 已覆盖 |
| 交给终端 · 宿主：草稿、忙（运行、提交、停止、重启、排队里还有消息）、不认识的会话被拒；标记写进索引后停掉 pi、应答文件；之后打开不启动 pi，会启动或写 pi 的命令应答 `session_handed_off`；重启后标记还在；`take_back` 去掉标记并在新 epoch 启动 pi | `session-manager.test.ts` "SessionManager handing off (M1.9)"（含排队、消息在途、重启中）、`server/router.test.ts` | 已覆盖 |
| 交给终端 · 客户端与界面：`hand_off`、`take_back`、`clear_attention` 命令；菜单项（草稿、运行中置灰），复制 `pi --session '<文件>'`（单引号转义），失败提示；交接后的面板（再复制、"在 Atrium 里继续"） | `atrium-client.test.ts`、`packages/ui/src/tabs/hand-off.test.ts`、`workbench.browser.test.tsx` "attention and hand-off" | 已覆盖 |
| 宿主重启后（`hostInstanceId` 变了）界面重新打开、重新订阅正在显示的会话 | `chat.browser.test.tsx` "ConversationArea after the host restarted" | 已覆盖 |
| OneShotPi：`--mode json -p --no-session --no-tools --thinking off --model … --system-prompt …`，内容从标准输入给；取最后一条回复的文字；回复出错或中止、退出码非 0、没有回复或没有文字、超时（停掉整棵进程树，读不到进程树时只杀 pi）、中止都算失败，只记原因；中止在先时不启动；契约：真实 pi 的 print 模式 | `packages/pi/src/oneshot/oneshot.test.ts`、`oneshot.pi.test.ts` | 已覆盖 |
| faux 模型在 `-p` 下用脚本的 `title` 回答，没写时回错误，不写 `pi.pid` | `packages/testkit/src/faux/faux.pi.test.ts` "print mode" | 已覆盖 |
| 自动标题：输入（用户消息最多 1200、总共 2000，按字符截）、整理（第一行、成对引号、末尾标点、50 个字符、整理后为空算失败）、第一轮的文字和回复的最后一段；一个会话同时只生成一个，失败只记原因、下次运行结束再试，写不进去只记原因，关闭时取消；宿主：运行结束重扫后、会话已写出文件、没名字、有模型时在会话目录用会话的模型调用，经会话自己的 pi 写回；生成期间有了名字或交给终端时丢弃；关闭时停掉一次性的 pi；控制器给出从头开始的全部条目 | `packages/host/src/sessions/titles.test.ts`、`session-manager.test.ts` "SessionManager titles (M1.9)"、`session-controller.test.ts` "beyond what a snapshot holds" | 已覆盖 |
| 端到端：三个会话并行，切换标签、断网重连、宿主重启后状态和对话记录正确；后台出错进收件箱，点开后切到它、收件箱清掉、标签上的图标还在；交给终端（复制的命令和面板上的一样，重启后面板还在，接回后能继续对话）；第一次运行结束后用模型起名，标签和历史里都显示 | `apps/desktop/e2e/parallel.spec.ts`、`inbox.spec.ts`、`hand-off.spec.ts`、`chat.spec.ts` "names a chat with the model" | 已覆盖 |
| 泄漏 · 宿主：真实宿主、真实客户端和脚本 pi 下，新建再关掉对话、订阅再退订运行中的会话、订阅着列表和运行中的会话时连接直接断掉、发消息再停止，各 200 次后资源计数（含新加的会话订阅数 `sync.subscription`）、Node 的定时器、管道、套接字、子进程都回到基线；崩溃重启 200 次见会话控制器的泄漏测试 | `packages/host/src/sessions.leak.test.ts`、`sessions/session-controller.leak.test.ts`、`sync/subscriptions.test.ts` | 已覆盖 |
| 泄漏 · 界面：在三个带 Markdown 和代码块回复的会话之间来回切换 15 轮，不留脱离的 DOM | `apps/desktop/e2e/sessions.leak.spec.ts` | 已覆盖 |
| 浸泡：真实宿主和 faux pi，三个对话每轮同时运行，一个中途停止、一个每轮被杀掉 pi（按精确 pid）后自动重启续做、一个跑完，每轮运行中断开连接再换新连接，每 30 轮归档换新；每轮核对三者的结果，结束时资源计数、子进程回到基线，每轮堆增长 < 1KB | `packages/host/test/soak/sessions.soak.test.ts` | 已覆盖 |
| 变异测试补测（2026-10-10，M1.9）· OneShotPi：最后一行没有换行也读到，跳过不是助手 `message_end` 的记录（缺 `message`、为 null 或字符串、用户消息、`message_update`），没有内容的回复算没有回复；stderr 再多也读掉；pi 没读内容就退出算 `exited`；pi 起的进程攥着管道时 pi 退出 1 秒后照样应答；结束后不留定时器、不再理会中止；错误名。列表同步：删除也算进变化数，变化数正好到上限时仍发变化；`flush` 只发给那个连接，没有待发的变化时不重建列表；项目、工作区按 id 区分。客户端：列表到达前选的容器在应答后保留；失败的命令回到宿主的布局，不被别的宿主的变化带偏。停止：pi 不回应清队列时，pi 退出后停止照样结束（确认了的和没确认的）；长期存在的 pi 被停 200 次后不留住任何一次停止的上下文（泄漏测试）。会话目录：丢弃草稿只丢那一个，工作区不在了的草稿不归到对话下。标题：只有一个引号不算标题，引号里的空白去掉，标题要求的原文。收件箱：标为已看的"待授权"仍在收件箱。`windowFocused` 通知工作区 | `oneshot.test.ts` "without a line break"、"however much"、"without reading"、"keeps its pipes open"、"leaves the signal alone"、"OneShotError"；`index-feed.test.ts` "counts removals"、"only the connection flushed"；`index-view.test.ts` "by their ids"；`atrium-client.test.ts` "before the first list"、"not to one changes of another host left"；`session-controller.test.ts` "ends a stop once pi exits"；`session-controller.leak.test.ts` "context of each of 200 stops"；`session-catalog.test.ts` "and only it"、"once its workspace is gone"；`titles.test.ts`；`status.test.ts`；`index-commands.test.ts` "windowFocused" | 已覆盖 |
| 三方审查后补（2026-10-10，M1.9）· 交接：交接停 pi 的途中拿回来，等交接做完再起新 pi；pi 应答 `started`、运行还没开始时不让交接；菜单在消息发送中、运行中、停止中、重启中、宿主排队里有消息时置灰。归档：pi 第一次启动途中归档，启动完就停掉，不留控制器和进程。标题：改名后、重扫找到名字之前生成好的标题丢弃。关注：同一次运行里前一轮失败、最后完成或被停止的运行不标记；`asking` 是还没回答的对话框里最早那个出现的时间。列表同步：订阅者上次收到的序号早于已经忘掉的删除时推快照，正好在边界上照常推增量；宿主推送前一批失败时命令照样应答并记日志；客户端：布局命令失败时回到宿主发来的布局，不被期间不带布局的增量带偏。宿主重启而页面一直开着：页面在新宿主上立刻重新打开显示的对话，之后照常对话 | `session-manager.test.ts` "only once its hand-off has stopped pi"、"before the run begins"、"archived while it started"、"renamed meanwhile, though its file"、"after one of its turns failed"、"oldest dialog still unanswered"；`workbench.browser.test.tsx` "cannot hand off a session with"；`index-feed.test.ts` "removed more than it keeps"；`router.test.ts` "though sending the list changes"；`atrium-client.test.ts` "without a layout came meanwhile"；e2e `parallel.spec.ts` "opens the chat shown again when its host restarts under a page that stays" | 已覆盖 |

## 首次启动与设置（M1.10）

| 行为 | 测试 | 状态 |
|---|---|---|
| 找 Node：PATH 上没有为缺失；22.19.0 可用、22.18.9 版本过低；运行不了、不报版本、超时（杀掉）、中止都算缺失；用搜索路径作 PATH 运行 | `packages/pi/src/locate/node.test.ts` | 已覆盖 |
| 找 Homebrew：先找 PATH，再按顺序找安装位置；都没有为空 | `packages/host/src/setup/homebrew.test.ts` | 已覆盖 |
| 宿主的工具（Toolbox）：启动前不检测，之前问的拿到第一次的结果；重新检测排在进行中的之后，之后都用新结果；同时请求的共用一次；没找到时保留之前的；关闭时中止进行中的并等它，之后不再检测；没启动就关闭为空。启动时一并查 pi、Node、Homebrew、fd，空 PATH 下都没有 | `packages/host/src/setup/toolbox.test.ts`、`packages/host/src/tools.host.test.ts` | 已覆盖 |
| 登录程序找 pi 包：从 `pi` 的真实路径往上找名为 pi 的包，跳过别的名字、没有入口的、不是 JSON 或不是对象的 `package.json`，找不到、命令不存在时为空；真实 pi 的入口 | `packages/pi/src/auth/login.test.ts` "piPackageEntry"、`login.pi.test.ts` | 已覆盖 |
| 登录状态：列出服务商、OAuth 的名称、按钮文字和是否订阅、能否存 Key、已登录的方式和是否存在 `auth.json`（环境变量的 Key 不算存的）；真实 pi 的 anthropic、openai、openrouter 和环境变量里的 DeepSeek Key | `login.test.ts` "lists providers"、`login.pi.test.ts` | 已覆盖 |
| 登录过程：pi 的设备码、进度、提示、授权地址和提问原样转出，按 id 回答；pi 问登录方式时自动选浏览器；API Key 交给第一个密码类提问，其余提问照常转出，没给 Key 时全部转出；pi 撤回提问时告知，迟到的回答丢掉；pi 打印的非 JSON 行忽略，stderr 不读也不堵；设备 ID 用 pi 自己的；真实 pi：anthropic 的浏览器登录给出授权地址和粘贴回调的提问，取消后释放回调端口，Cloudflare 的账户 ID 提问，存 Key（权限 600）和退出 | `login.test.ts`、`login.pi.test.ts` | 已覆盖 |
| 登录失败与结束：带 pi 原文失败（报错、抛出的不是 Error、`auth.json` 坏了）；程序没说结果就退出算失败；pi 包缺少要用的接口算不可用；退出登录被拒带原文；查询和退出超时杀掉；取消后 3 秒不走就杀整棵进程树，读不到进程树时只杀程序；超时后再取消仍算超时；信号已中止时不启动，中途中止算取消，结束后不再理会信号；宿主走掉（标准输入关闭）时程序中止并退出、释放端口；资源计数回到 0 | `login.test.ts`、`login.pi.test.ts` "when the host goes away" | 已覆盖 |
| 宿主的登录状态（Logins）：列出能 OAuth 或能存 Key 的服务商，隐藏 `openai-codex` 和 `radius`，按钮文字没有时用 OAuth 名称；没有登录程序、没检测到工具、pi 或 Node 不可用、pi 不是能加载的包时不可用；查询失败时不可用，日志只记原因不记 pi 原文；关闭时中止进行中的查询并等程序退出 | `packages/host/src/setup/logins.test.ts` | 已覆盖 |
| 首次启动的检查（`check_setup`）：pi 就绪、损坏（带原文）、版本过低、缺失，Node 就绪、过低、缺失，Homebrew、fd 有无，登录状态和项目数；`refresh` 时重新读登录 shell、找到期间装好的 pi，不带时沿用上次的结果；检测失败时都算缺失；查完登录状态才读最新版本，取到期间找到的；pi 的报错截到 16 KiB；重新读登录 shell 后，之前环境里的凭据照样脱敏；Homebrew 不在 PATH 里时加到工具环境 PATH 的末尾，找得到它装的 Node；协议校验命令和结果，客户端发出 | `packages/host/src/setup/setup-service.test.ts`、`packages/host/src/setup/homebrew.test.ts` "withHomebrewOnPath"、`packages/host/src/tools.host.test.ts` "an earlier environment"、"outside PATH"、`packages/host/src/setup.host.test.ts`、`packages/host/src/server/router.test.ts`、`packages/protocol/src/envelope.test.ts`、`packages/client/src/atrium-client.test.ts` "first launch" | 已覆盖 |
| 客户端的首次启动状态：问过之前为空，问的时候保留上次的结果，只有最后一次问的结果（或失败原因）落下；问过以后，宿主说 pi 的凭据变了（`credentials_changed`）、安装成功、连上新的宿主时自动再问，凭据变了时还重新读请求过的模型列表；连上新的宿主时清掉旧宿主的登录和任务；宿主找到的最新 pi 直接放进去，和 `check_setup` 的回答交错时留检查时间较晚的 | `packages/client/src/atrium-client.test.ts` "first launch" | 已覆盖 |
| 登录与退出（`login`、`answer_login`、`cancel_login`、`logout`）：经装好的 pi 登录，pi 说的和问的整份广播给所有连接（另一个窗口也看到、也能作答），回答后提问去掉；API Key 交给第一个密码类提问；结束为成功、取消或带 pi 原文的失败，提问清空；授权地址或设备码页面不是 https 时不显示、取消并以 `insecure_url` 失败；新登录取消进行中的、等它的程序退出才开始（同一时刻只开一个程序），按请求顺序开始，登录不可用时不取消进行中的；退出登录先取消同一服务商进行中的登录、等它开始完，别的服务商的不动；登录成功和退出后广播 `credentials_changed`；pi 的文字（提问、选项、说明、进度、报错）截到 16 KiB；记住最后一次登录和安装的状态，后连上的连接立即收到，安装不带输出；只认进行中的登录，其余 `login_not_found`；没有工具时 `login_unavailable`；退出被拒为 `logout_failed` 带原因和原文；日志只记服务商、方式、结果和原因，不记 Key 和 pi 原文；关闭时取消进行中的并等程序退出；协议校验命令、结果和事件，路由转交，客户端发出并保存最新的登录状态 | `packages/host/src/setup/login-service.test.ts`、`packages/host/src/setup.host.test.ts` "signing in and out"、"a window that comes later"、`packages/host/src/sync/subscriptions.test.ts` "broadcast"、`packages/host/src/server/router.test.ts` "hands the login commands"、`packages/protocol/src/envelope.test.ts`、`packages/client/src/atrium-client.test.ts` "signs in and out" | 已覆盖 |
| 运行安装任务（runJob）：在给定的目录和环境里运行，标准输出和标准错误一起转出，跨两次写入的字符保持完整；有输入时从标准输入给出后关闭，没有时立刻关闭；取消时 SIGTERM 整个进程组，忽略的在宽限后强制结束整棵树；命令退出时结束留在组里的进程，组外进程占着输出时宽限后不再等；启动不了、已取消时不启动；资源计数回到 0 | `packages/host/src/setup/install-job.test.ts` | 已覆盖 |
| 下载安装脚本：跟随同一服务器上的跳转；跳到别的服务器、跳转过多、非 200、超过 1 MiB、超时、连不上都失败并给出原因；取消时停止 | `packages/host/src/setup/install-script.test.ts` | 已覆盖 |
| 安装与更新（`install_pi`、`install_node`、`update_pi`、`cancel_install`）：装 pi 把下载的脚本交给 `sh -s`，装 Node 运行找到的 `brew install node`，更新运行 `pi update`，都在给定目录、登录 shell 的环境里；输出整段广播给所有连接，不进日志，日志只记种类、结果、退出码和原因；更新等运行中的会话结束，期间显示还在运行的数目，等待时取消不运行 pi，不再监听会话；下载失败、启动不了、非零退出分别以 `download_failed`、`spawn_failed`、`exit` 失败；同一时刻一个任务（`install_busy`），没有工具、没有 Homebrew、没有 pi 时 `install_unavailable` 且不占位；只认进行中的任务（`install_not_found`）；取消运行中、等待中、下载中的任务；关闭时取消并等进程退出，之后不再接任务；成功后先重新检测工具（失败只记日志）再报告 `ok`，失败、取消时不做；更新运行时（等待时不）要启动 pi 的会话等它结束；更新后 `check_setup()` 已是新版本；会话管理器停掉空闲会话的 pi（`requested`），运行中的、有对话框等回答的不动，正在启动的（打开的会话、新建的对话）等启动完再停，下次打开时重新启动；`InstallService.last` 记住最后一个任务；协议校验命令、结果和事件，路由转交，客户端发出、保存最新任务和最后 1 MiB 输出，忽略不认识的任务的输出 | `packages/host/src/setup/install-service.test.ts`、`packages/host/src/sessions/session-manager.test.ts` "after pi is updated"、`packages/host/src/setup.host.test.ts` "installing"、`packages/host/src/server/router.test.ts` "hands the install commands"、`packages/protocol/src/envelope.test.ts`、`packages/client/src/atrium-client.test.ts` "installs and updates" | 已覆盖 |
| pi 新版本检查：向 pi.dev 的最新版本地址要 JSON，读出去掉空白的 `version`；不是 JSON、没有或不像版本号、超过 64 KiB、非 200、跳转、超时、连不上都失败并给出原因，取消时停止；启动后检查一次、之后每天一次，`check_pi_update()` 立即检查并共用进行中的一次；找到的版本和时间广播给所有连接，失败保留上次结果、日志只记原因；pi 的环境有 `PI_OFFLINE` 或配置为不检查时不发请求但保留定时；关闭时停掉进行中的检查和定时；`check_setup()` 带上最新版本；协议校验命令、结果和事件，路由转交，客户端发出、保存最新结果；测试宿主和 e2e 默认不检查 | `packages/host/src/setup/pi-latest.test.ts`、`packages/host/src/setup.host.test.ts` "the latest pi"、`packages/host/src/setup/setup-service.test.ts`、`packages/host/src/server/router.test.ts` "hands the install commands"、`packages/protocol/src/envelope.test.ts`、`packages/client/src/atrium-client.test.ts` "looks for the latest pi"（放进首次启动状态） | 已覆盖 |
| 从 pi 历史发现项目（`discover_projects`）：按 pi 存会话的位置（每个工作目录一个文件夹，或配置的目录本身）只读每个会话文件的第一行，按文件头的 `cwd` 统计会话数和最近修改时间，同一文件夹里不同 `cwd` 分开算，不是会话、没有 `cwd`、文件头没写完、不是 `.jsonl` 的、不是普通文件的（坏链接、管道）跳过，按工作目录分的文件夹是符号链接时跟进去，打开的文件都关上，目录不存在时为空，取消时停止；宿主按真实路径合并，去掉已添加的项目和它们的工作区（其中的子目录照常列出）、Atrium 对话目录下的（只按整段路径比较）、已不存在的和不是目录的，按最近使用排列；没检测到工具时为空；协议校验命令和结果，路由转交，客户端发出 | `packages/pi/src/sessions/session-files.test.ts` "sessionDirectories"、`packages/host/src/projects/discovery.test.ts`、`packages/host/src/sessions/index-commands.test.ts` "discoverProjects"、`packages/host/src/setup.host.test.ts` "finding projects"、`packages/host/src/server/router.test.ts` "looking for projects"、`packages/protocol/src/envelope.test.ts`、`packages/client/src/atrium-client.test.ts` "directories of pi's history" | 已覆盖 |
| 项目的主干分支（`list_branches`、`set_main_branch`）：列出 `origin` 上最近取回的分支（按名字，去掉 `HEAD`）和 `origin/HEAD` 指向的分支，不是仓库或没有 git 时都为空；选 `origin` 上的分支为主干、`null` 恢复自动，不在 `origin` 上的（含 `HEAD`）应答 `branch_not_found` 且不改，未知项目 `project_not_found`；改了之后重新扫描这个项目的工作区并重新计算改动，别的项目不动；列表里的项目带 `mainBranch`；worktree 的领先提交数按选的主干计；协议校验命令、结果和错误码，路由转交，客户端发出 | `packages/host/src/projects/project-service.test.ts` "branches"、"setMainBranch"、`packages/host/src/sessions/index-commands.test.ts` "setMainBranch"、`packages/host/src/index.host.test.ts` "main branch chosen"、`packages/host/src/server/router.test.ts` "choosing the main branch"、`packages/protocol/src/envelope.test.ts`、`packages/client/src/atrium-client.test.ts` "chooses main branches" | 已覆盖 |
| 偏好里的 `setupDone`、`titleModel`：默认首次启动未完成、跟随会话的模型，M1.10 之前的文件读作这样；`set_preferences` 改它们（`titleModel` 可设回 `null`），写进文件；协议校验 | `packages/host/src/store/preferences.test.ts`、`packages/host/src/server/router.test.ts`、`packages/protocol/src/envelope.test.ts` | 已覆盖 |
| 标题模型：设置里选了且 pi 在会话的目录里列出它（同一服务商、同一模型；对话按模型面板的问法问 Atrium 的数据目录，只看对话根目录之内的）时用它生成标题，没选、没列出或查不到时用会话的模型，查的时候关掉会话则不再生成；在 Atrium 里登录成功或退出后清空所有目录的模型列表缓存，进行中的查询结果也不留，关闭时照样等它结束 | `packages/host/src/sessions/titles.test.ts` "title model"、"titleModelLookup"；`session-manager.test.ts` "title model chosen"；`packages/pi/src/catalog/model-catalog.test.ts` "told to forget"、"under way when told to forget"；`packages/host/src/setup/login-service.test.ts` | 已覆盖 |
| 设置面板：侧栏底部"设置"或 ⌘, 打开，再按 ⌘, 关上；Esc、关闭按钮、点面板外关闭，点面板里不关；打开时焦点在面板里；停在上次看的分类，记在本机，重新载入后也是，记的不是分类时从外观开始；工作台显示时问一次首次启动的状态；有新版本 pi 时侧栏"设置"和 pi 分类各有一个蓝点，别的分类没有，装上后消失 | `packages/ui/src/settings/settings-panel.browser.test.tsx` | 已覆盖 |
| 设置 · 外观与关于：三段外观和侧栏的外观切换是同一个偏好；关于里有 Atrium（宿主）的版本、与宿主的连接（已连接、重连中）、pi 的版本和日志文件夹，在访达中显示日志文件夹 | `packages/ui/src/settings/settings-panel.browser.test.tsx` | 已覆盖 |
| 设置 · 模型与账户：订阅按 SPEC 的顺序列出 pi 提供的（pi 新加的 OAuth 服务商排在后面），已登录的有"退出"，用 Key 登录的订阅行不给"退出"；只有本窗口发起的登录打开授权页，同一次登录只开一次，另一个窗口的登录只显示进度；授权页可再打开，设备码可复制、打开验证页，pi 的选择、文字提问和折叠的回调地址按 id 作答，可取消；失败显示原因和 pi 原文，已登录的行不显示；开始不了时说明；退出或删除最后一个凭据时先问，可取消或仍要，不是最后一个时直接去掉；pi 去不掉时说明；Key 按服务商列出，存的可删、环境变量的不可删；添加 Key 只列能存 Key 且没登录的服务商，空的或全是空白的不发，去掉首尾空白后登录，进行中不能再存，本次登录成功后收起，失败留着并显示原因，别的窗口的 Key 登录不影响；登录用不了时指向终端的 `/login`；标题模型从对话的模型里按服务商分组选，或跟随会话的模型，同名模型按服务商区分，选的模型不在列表里时（列表读完后）提示暂用会话的模型 | `packages/ui/src/settings/accounts-section.browser.test.tsx`、`packages/ui/src/setup/providers.test.ts` | 已覆盖 |
| 设置 · 项目：每个项目的主干分支从 `origin` 的分支里选，标出 `origin/HEAD`，自动时显示它指向哪个；选的就是当前的时不发命令；"恢复自动"；没有主干时提示合并状态未知；分支不在 `origin` 上了或读不到分支时说明；没有项目时指向侧栏 | `packages/ui/src/settings/projects-section.browser.test.tsx` | 已覆盖 |
| 设置 · pi：位置（在访达中显示，桌面应用之外不给）、当前版本、最新版本（相同时标"已是最新"）、上次检查；检查更新时按钮忙；有新版本时"更新 pi"，之后等会话（可取消）、运行中显示输出并跟到最新一行（可取消）、失败显示完整输出和"重试"并自动展开手动更新、成功后重新检测期间显示"已更新"、之后显示到达的版本和可展开的日志，又发现更新的版本时再给"更新 pi"；取消后、别的安装任务都不影响；手动更新可复制 `pi update`，"我更新好了，重新检测"重新读登录 shell；开始不了时说明原因；读不到状态时说明。版本比较按数字、预发布早于正式版、忽略构建信息；安装输出去掉颜色和控制序列，`\r` 覆盖本行 | `packages/ui/src/settings/pi-section.browser.test.tsx`、`packages/ui/src/setup/pi-version.test.ts`、`packages/ui/src/setup/terminal-text.test.ts` | 已覆盖 |
| 设置 · pi · 网络代理（2026-10-11）：只收 `http`、`https` 的主机和端口，不收路径、查询、用户名密码，"不走代理"里不收空项、空白和逗号，拒绝时应答 `proxy_invalid`（`reason`）且什么都不改；地址存成一种写法（去空白和斜杠、小写）；没设时偏好读作 `null`，手改出的不合要求的代理读作没有；设了之后交给 pi 和安装、登录的环境里四个代理变量都是它，`NO_PROXY` 总带本机地址、去重，没设时环境不动；每次取工具时读设置，之后启动的用新的；宿主自己查最新版本、下载安装脚本按这份环境的代理走（小写优先，https 没设时用 http 的，`NO_PROXY` 里的直连，不用宿主自己的环境变量），请求完关掉连接；日志只记代理来自设置、登录 shell 还是没有，不记地址；客户端等宿主确认后才显示代理；界面：填地址和不走代理的地址（换行、逗号分隔），没改不能保存，保存中按钮等待，"不用代理"清除，宿主拒绝的四种原因和其他失败分别说明 | `packages/host/src/platform/proxy.test.ts`、`packages/host/src/setup/toolbox.test.ts` "withProxySetting"、`packages/host/src/setup/pi-latest.test.ts` "fetch it is given"、`packages/host/src/setup/install-script.test.ts` "fetch it is given"、`packages/host/src/store/preferences.test.ts` "no proxy"、`packages/host/src/sessions/index-commands.test.ts` "setPreferences"、`packages/host/src/setup.host.test.ts` "the proxy set"、`packages/host/src/tools.host.test.ts` "where the proxy comes from"、`packages/host/src/server/router.test.ts`、`packages/protocol/src/envelope.test.ts`、`packages/client/src/atrium-client.test.ts` "shows a proxy only once"、`packages/ui/src/settings/proxy-group.browser.test.tsx` | 已覆盖 |
| 首次启动 · 什么时候显示：宿主的第一份列表到之前窗口空着；`setupDone` 为假时从欢迎页开始，不显示步骤条；之后只在 pi 不可用时从第 1 步开始，没有"返回"，pi 一可用就回到工作台；首次启动的状态没读到或读失败时显示工作台；显示后别的窗口设了 `setupDone` 也不中途关掉；都已满足时一开始就结束、设 `setupDone`、回到工作台；因 pi 不可用进来的结束时不再设 `setupDone` | `packages/ui/src/setup/first-launch.browser.test.tsx` "when it shows"、"begun because pi cannot be used" | 已覆盖 |
| 首次启动 · 问 `check_setup` 的时机：连上宿主之前不问，连上后问一次，重连后再问一次 | `packages/ui/src/setup/first-launch.browser.test.tsx` "asks what first launch checks once connected, and again after reconnecting" | 已覆盖 |
| 首次启动 · 端到端：新的数据目录从欢迎页开始，登录不可用时继续，第 3 步列出 pi 会话里的目录、默认勾选，添加后回到工作台并把 `setupDone` 写进偏好，再次打开直接是工作台；其他端到端用例的数据目录预先写好 `setupDone` | `apps/desktop/e2e/first-launch.spec.ts`；`apps/desktop/e2e/launch.ts`（`markSetupDone`） | 已覆盖 |
| 首次启动 · 欢迎页与步骤之间：logo 位是 Atrium 的猫（图片加载出来，作为装饰不进无障碍树）；胶囊打开 pi.dev；"开始设置"跳过已满足的步骤；步骤条标出完成的和当前的；回车按主按钮，按着修饰键、焦点在别的按钮上、主按钮不可用时不按；一路返回到欢迎页，返回的第 1 步显示 pi 已就绪（版本、位置）和"继续"；pi 一可用自动前进到第一个没满足的步骤 | `packages/ui/src/setup/first-launch.browser.test.tsx` "welcome and moving between steps"（含 "logo slot"） | 已覆盖 |
| 首次启动 · 第 1 步：装 pi 时终端先显示要运行的命令，之后实时输出、等待会话的说明、运行中可取消（发 `cancel_install`）、取消后可再装；安装脚本 / npm 切换命令并可复制；失败按原因说明（退出码、中途结束、启动不了、下载不了）并可重试；拒绝开始时说明；"我已经装好了"带 `refresh` 重新检测，还没有时提示；任务跑完还是没有 pi（或 Node.js）时提示并可重新检测；版本过低时更新 pi，"我已经更新了"；缺 Node 有 Homebrew 时说明缺什么、用 Homebrew 装、本窗口发起的装好后接着装 pi（显示在第 1 步，失败可重试），别的窗口的不接着装；没有 Homebrew 时去 nodejs.org 下载；pi 损坏时标题不同、原始报错折叠；检查中等待，检查失败可重新检测 | `packages/ui/src/setup/first-launch.browser.test.tsx` "step 1" | 已覆盖 |
| 首次启动 · 第 2 步：订阅 / API Key 切换，各自的说明；有凭据后"继续"才可用；登录不可用时指向终端的 `/login`（可复制 `pi`）、可重新检测，"继续"可用 | `packages/ui/src/setup/first-launch.browser.test.tsx` "step 2" | 已覆盖 |
| 首次启动 · 第 3 步：列出 pi 历史里的文件夹（会话数、最近使用），最近的默认勾上；勾选改数目，逐个添加后结束并设 `setupDone`；选中的、拖进来的放在最上面并勾上，标"刚选的"，已列出的只勾上，读不出路径的不要；拖到上面时高亮；添加失败的留下并显示第一个原因，加好的去掉，已在某个项目里的（`project_exists`）算加好；没勾时不能添加；桌面应用之外拖放区不可用；"先新建一个对话"新建对话并结束 | `packages/ui/src/setup/first-launch.browser.test.tsx` "step 3" | 已覆盖 |
| 欢迎页按钮的点阵光带：进度 0～1 之外不画；进场窄、中间盖满按钮、离场窄；"\"方向倾斜；白点，同种子同图案；变速曲线的取值；扫完一次后下一次在开始后 6 秒、悬停扫过后恢复平时的速度，离开期间错过的跳过；页面显示后不久扫一次，两次之间不请求动画帧，悬停立刻扫，卸载后不再画 | `packages/ui/src/design/dots.browser.test.ts` "paintBand"、"easeBand"、"nextBandSweep"；`packages/ui/src/setup/first-launch.browser.test.tsx` "the start button's band" | 已覆盖 |
| 安装 ID 与点阵种子：第一次启动生成 `~/.atrium/install-id`（权限 600），之后沿用，内容不是 UUID 时重新生成；种子为正整数；握手的 `welcome` 带种子和日志文件夹，协议拒绝种子为 0、缺日志文件夹的；客户端连接状态带上；界面在连上前用 1、重连期间沿用，换种子时模型按钮和推理强度框的点阵跟着换 | `packages/host/src/platform/install-id.test.ts`、`packages/host/src/server/ws-server.host.test.ts` "welcomes"、`packages/protocol/src/envelope.test.ts`、`packages/client/src/atrium-client.test.ts`、`packages/ui/src/state/install-seed.browser.test.tsx`、`packages/ui/src/app/workbench.browser.test.tsx` "Workbench dots"、`packages/ui/src/chat/effort-box.browser.test.tsx` | 已覆盖 |

## 每个对话是一个容器（M1.11，2026-10-12）

[ADR-0007](../adr/0007-each-chat-is-its-own-container.md)：每个对话和工作区一样是一个容器，有自己的会话和标签页。

| 行为 | 测试 | 状态 |
|---|---|---|
| 协议：对话 id 是 `cht_` 加目录名（只许字母、数字和 `-`，最长 64），`rename_chat`、`create_session(containerId)`、`list_models(workspaceId \| null)`、`chat_not_found`，列表快照和变化带 `chats`；旧的 `"chats"`、带路径的、过长的、工作区 id 当对话 id 都拒绝 | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| 索引迁移：`sessions.json` v1 里"对话"的记录按工作目录归到各自的对话；`layouts.json` v1 的对话标签分到各自的对话，顺序不变，原来的当前标签在它的对话里仍是当前、别的对话以第一个标签为当前，在"对话"里的客户端去当前标签的对话（当前标签不在任何对话里时哪里都不在），没有记录或不是对话的标签去掉；两个旧文件备份成 `<名字>.v1.bak`；v1 里手改坏的记录（不是对象、对话记录没有目录）照损坏的文件重置；`chats.json` 损坏时单独重置 | `packages/host/src/store/load-index.test.ts`、`index-schema.test.ts` | 已覆盖 |
| 对话名：存在 `chats.json`，清空即删掉记录、不动别的对话，名字没变时不写文件；`rename_chat` 只认目录还在的对话（否则 `chat_not_found`），改完推列表变化 | `packages/host/src/store/chat-records.test.ts`、`sessions/index-commands.test.ts` "IndexCommands.renameChat"、`server/router.test.ts` | 已覆盖 |
| 会话目录：每个对话目录是一个对话，名字不像对话 id 的目录和散落的文件不算，目录删了对话就没了；对话的第一个会话按记录的创建时间、没有记录时按文件修改时间取最早的，归档的不算，全归档了为空 | `packages/host/src/sessions/session-catalog.test.ts` | 已覆盖 |
| 会话管理器：在对话里再建会话，用对话的目录；对话不在时 `chat_not_found`，什么都不记不开；丢弃空草稿时对话里还有别的会话就留着目录；对话里的运行结束不刷新工作区；`list_models(null)` 在 Atrium 的目录 | `packages/host/src/sessions/session-manager.test.ts` "SessionManager sessions in a chat"、"discards a draft"、`model-lister.test.ts` | 已覆盖 |
| 列表同步与客户端：`chats` 集合的快照和增量，按 id 增删改；`renameChat`、`createSession(containerId)`、按工作区或 `null` 取模型 | `packages/host/src/sync/index-feed.test.ts`、`packages/client/src/index-view.test.ts` "by their ids"、`atrium-client.test.ts` | 已覆盖 |
| 侧栏对话行：像工作区一样逐行列出，名称、最近活动（其中会话最近的一次）、最高优先级状态，按最近活动排列；最近 5 个，"显示全部 N 个"原地展开、"收起"收回；会话全归档了的对话不列；名称取别名、第一个会话的标题，第一个会话是草稿时"新对话"；点击时没有打开的标签就打开最近的会话，有就回到它的标签，选中时高亮；"···"重命名、清空即恢复默认，不切过去，对话已不在时说明（发消息时同样） | `packages/ui/src/app/workbench.browser.test.tsx` "lists chats like workspaces"、"names a chat"、"opens a chat's latest session"、"renames a chat"、"explains a chat that went"，`chat.browser.test.tsx` "describes"；纯函数：`packages/ui/src/sidebar/names.test.ts` "chatName" | 已覆盖 |
| 搜索、收件箱与对话区：搜索分工作区、对话、会话三组，对话名不分大小写，只有对话匹配时也列出，点对话切过去；收件箱和搜索的第二行是"对话 · 对话名"；⌘T 和标签栏"+"在当前对话里新建会话，⌘N 新建对话；对话的空状态同别处，只有一句话（2026-10-14 改，原先说明会话建在这个对话里）；对话和不在任何容器时按 `null` 取模型、不看 git 改动；设置的标题模型按 `null` 取模型 | `workbench.browser.test.tsx` "finds chats by name"、"collects the sessions that need the user"、"creates a session in the chat"；`chat.browser.test.tsx` "says only one line"、"asks for the models once connected"；`accounts-section.browser.test.tsx`；`names.test.ts` "placeOf" | 已覆盖 |

## Fast（M1.11，2026-10-12）

[ADR-0008](../adr/0008-atrium-own-pi-extension-for-fast.md)：Atrium 自带的 pi 扩展给支持的模型的请求加 `service_tier: "priority"`，输入框里模型按钮左边是开关。

| 行为 | 测试 | 状态 |
|---|---|---|
| 协议（版本 7）：`set_fast` 及其应答、`fast_updated`、`fast_unavailable`，快照的 `fast`、模型的 `fast`（`{speed, moreUsage}` 或 `null`，速度大于 0、不超过 100，多一个键也不行）、偏好的 `lastFast` | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| 哪些模型支持 Fast：只有 `openai-codex`；Codex 模型列表列出的模型照列表（有 `priority` 档才支持，说明里读出速度倍数（整数、小数、`x` 前后可有空白，最多 100）和是否增加额度，说明不是文字或读不出的速度记为不详；不是对象的档位跳过），列表没列出的不支持，没有列表或列表为空时按内置规则（GPT-5.5、5.6、6、6.1 含变体，速度不详、额度增加，5.4 不算）；没有可用 `slug` 的模型跳过；扩展的报告按协议严格校验（含 `null` 的模型、文字的 `fast`），不合规整份作废，失败只收小写代码；模型目录带上 `fast`；`list_commands` 不列出 `atrium-fast`，同名的模板照列 | `packages/pi/src/fast/fast.test.ts`、`catalog/models.test.ts` "what Fast does"、`catalog/commands.test.ts` "Fast switch" | 已覆盖 |
| 扩展：符合 pi 的扩展 API；只注册一个命令；默认关，`on` / `off` 切换，别的词不变；开着时只给支持的模型、是对象的请求体加 priority，返回副本不改 pi 的请求。`tiers`：用 pi 的第一个 `openai-codex` 模型的凭据（登录给的 `baseUrl` 优先），在 `<baseUrl>/codex/models?client_version=99.0.0` 查列表（`baseUrl` 末尾的 `/`、`/codex`、`/codex/responses` 都归到同一处，不在末尾的 `/codex` 保留），带 `Authorization`、从 token 读出的 `chatgpt-account-id`（读不出就不带）、`originator: pi` 和 pi 给的其他请求头（值为 `null` 的不带），结果经 `setStatus("atrium-fast")` 报回；没登录（含 pi 取凭据时出错）、HTTP 错误、不是 JSON、不是列表、列表为空、连不上各报一个代码，不带服务器的原文，查询本身从不失败。第一次 `on` 在后台查，查到前按内置规则，查到后按列表；同时只查一次；有了列表后再 `on` 不再查；之后查失败时保留已有列表 | `packages/pi/src/fast/extension.test.ts` | 已覆盖 |
| pi 契约（1.1.0）：真实 pi 加载扩展后 `get_commands` 列出开关；`/atrium-fast on` 应答 `handled`、不起一轮、不出事件；之后的请求只在支持的模型上带 priority，关掉后不带。`/atrium-fast tiers`：扩展从 pi 的模型注册表拿到凭据，向本机的模型列表服务发一次请求，`setStatus` 在 pi 应答 `handled` 之前作为 `extension_ui_request` 发出；之后列表说不支持的和列表没列的模型都不带 priority。测试工具：faux 可换服务商名，`FAUX_PI_BASE_URL` 换 `baseUrl`（夹具里记作占位符），记下 pi 发出的请求体 | `packages/pi/src/contract/fast.pi.test.ts` | 已覆盖 |
| 宿主查模型列表时问扩展：带 `--extension` 启动短暂的 pi；列出了 `openai-codex` 模型且有开关时才发 `get_commands` 和 `/atrium-fast tiers`（开关混在其他命令里也认），按报告给模型标 `fast`，只认键为 `atrium-fast` 的 `setStatus`，同键的其他请求或其他类型的记录不算；报告是失败、不合规、没有报告、pi 超时或拒绝时按内置规则，只记原因代码；查询在列命令或扩展查询时被中止都照常失败并停掉 pi；没配扩展时不加参数、不多问；真实 pi 上整条链路 | `packages/pi/src/catalog/query.test.ts` "with the Fast extension"、`query.pi.test.ts` "Fast extension" | 已覆盖 |
| 宿主 · 偏好与目录：`lastFast` 默认关、旧文件读作关；会话记录的 `fast`，终端里开的会话切换后也有记录，没变化不写文件 | `packages/host/src/store/preferences.test.ts` "remembers Fast"、`sessions/session-catalog.test.ts` "keeps each session's Fast" | 已覆盖 |
| 宿主 · 控制器：快照带 `fast`；切换后只在变化时发 `fast_updated`、报告选择；pi 失败时原样转出、什么也不变；停止中和退出后拒绝 | `packages/host/src/sessions/session-controller.test.ts` "createSessionController's Fast" | 已覆盖 |
| 宿主 · 会话管理器：pi 带 `--extension` 启动，确认开关在后、开着时先补发 `on` 再读会话；关着时不发；切换记进会话记录和偏好，新的管理器按记录启动；崩溃重启后按会话自己的开关补发；没列出开关的 pi 一条也不发、记警告、`set_fast` 应答 `fast_unavailable`；没配扩展时同样；草稿快照的 `fast`；未知会话；路由转发 `set_fast` | `packages/host/src/sessions/session-manager.test.ts` "SessionManager Fast"、`server/router.test.ts` | 已覆盖 |
| 客户端：快照和 `fast_updated` 的开关；切换先在视图里生效，失败时放回宿主最后接受的，多次切换叠在一起时只在最后一次失败后放回（前一次被接受后才发起的也算在内）；没在看的会话照发、不建视图 | `packages/client/src/session-view.test.ts` "following Fast"、`atrium-client.test.ts` "models" | 已覆盖 |
| 界面：只在当前模型支持时显示 ⚡ 按钮（关是线框、开是强调色实心，`aria-pressed`；只有闪电、没有圈；⚡ 离模型按钮 10.5px、点按区域 32px 见方；能用时光标是小手，不能用时是默认光标；从关变开时播加速动效，打开状态下出现、关掉时都不播）；悬停卡片（鼠标移开就收起，点过之后也收起，键盘聚焦时弹出）写开关状态、速度（"约 N 倍速度"，不详时"更快"）、额度增加时"额度消耗增加"、下一次请求生效；点击切换，空状态用 `lastFast`、先建会话；扩展没加载时说明；停止中不能用；模型菜单里支持的模型名后带小 ⚡ | `packages/ui/src/chat/chat.browser.test.tsx` "ConversationArea's Fast button"、`model-picker.browser.test.tsx` "bolt"、`model-choice.test.ts` | 已覆盖 |
| 端到端：打包进宿主的扩展真的被 pi 加载，模型目录按本机模型列表服务的列表标 Fast（GPT-6.1 Sol 有 ⚡，内置规则会算支持的 GPT-5.5 没有），卡片写"约 2 倍速度，额度消耗增加"；选 GPT-6.1 Sol 后打开，下一次请求带 priority，换回 faux-1 开关消失、请求不带；对列表的每次请求都带 pi 的凭据 | `apps/desktop/e2e/fast.spec.ts` | 已覆盖 |

## 工作区归档（M1.11，2026-10-12）

SPEC-0001"M1.11 的工作区归档"：worktree 工作区可以归档（删掉目录、保留分支），在项目菜单里恢复。

| 行为 | 测试 | 状态 |
|---|---|---|
| 协议（版本 9）：`archive_workspace`、`restore_workspace` 及其应答 `{}`，工作区的 `archivedAt`（不能缺、不能为负），五个新错误码 | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| 宿主 · 索引与项目：工作区记录的 `archived`（时间、当时的分支和提交，旧文件没有这一项也能读）；`setArchived` 记下和清掉，未知工作区 `workspace_not_found` | `packages/host/src/store/load-index.test.ts`、`projects/project-service.test.ts` "ProjectService.setArchived" | 已覆盖 |
| 宿主 · 工作区列表：归档的工作区照列、带 `archivedAt`，分支和提交取归档时记下的、不算合并状态、扫描跳过；不能在里面新建会话 | `packages/host/src/workspaces/workspace-service.test.ts` "lists an archived worktree" | 已覆盖 |
| 宿主 · 归档（真实 git）：干净的 worktree 先停会话再 `git worktree remove`，分支留着、被忽略的文件随目录删掉，然后归档会话、记下时间分支提交；detached 在分支、远程分支或标签上的提交可以归档；有改动、有未跟踪文件、提交不在任何引用上时拒绝且什么都不动；本地工作区 `workspace_is_local`、未知 `workspace_not_found`、已归档的不再动；目录已不在（含已 prune 和被锁住的）时不跑 git 直接归档；被锁住删不掉时会话已停但不归档（先记下的归档标记撤掉）、日志只有退出码；会话停完再查一遍，其间有了改动或 detached 上的新提交时拒绝，分支上的新提交以停完后的为准；删目录前索引已记下归档；`worktree remove` 和 `add` 超时 10 分钟、别的 git 命令用默认；没有 git、列不出 worktree、读不了状态、查不了提交被谁持有时失败 | `packages/host/src/workspaces/workspace-archiver.test.ts` "WorkspaceArchiver.archive" | 已覆盖 |
| 宿主 · 恢复（真实 git）：按分支或 detached 的提交加回 worktree 并重扫；git 还登记着目录已不在的先 prune 再加；目录已回来的只清标记，没归档的不动；`worktree_restore_failed` 带原因：目录被占 `dir_taken`、本地分支已删（远程有同名分支时也不从远程新建）`branch_gone`、没有可用的分支和提交 `no_branch`，分支正被别处检出时不带原因、日志只有退出码；未知工作区、没有 git、列不出 worktree 时失败；归档和恢复一次一个，前一个失败后接着做；`close` 等进行中的做完（宿主关闭时在会话和索引之前调用） | `workspace-archiver.test.ts` "WorkspaceArchiver.restore"、"one at a time" | 已覆盖 |
| 宿主 · 会话：停掉工作区所有会话的 pi；归档工作区的所有会话（含草稿），从各布局里去掉；列表命令转交归档器、路由转发两个命令 | `packages/host/src/sessions/session-manager.test.ts` "SessionManager workspaces"、`index-commands.test.ts` "IndexCommands.archiveWorkspace"、`server/router.test.ts` | 已覆盖 |
| 客户端：两个命令带工作区 id 发出、应答 `{}` | `packages/client/src/atrium-client.test.ts` "sends the session, project, workspace" | 已覆盖 |
| 界面：只有 worktree 行悬停时在"···"左边有归档图标（2026-10-13 从菜单移出，"···"里只剩"重命名"；同日改成红色垃圾桶、较透的红底，和"···"隔 4px），有未提交改动时置灰（`aria-disabled`）、说明原因、点了不弹框；确认框（挂在页面上、盖住整个窗口，380px 卡片、遮罩模糊 8px、按钮高 30px，焦点在"取消"）写明删除目录、保留的分支或提交（都没有时不写）、运行中的会话数（不算归档的和没在运行的）；取消、Esc、点遮罩都不归档；归档中按钮写"归档中…"、取消 Esc 遮罩都不起作用，失败时框不关、说明原因、可以再试，各错误码的说明；成功后工作区从侧栏消失；侧栏和搜索不显示归档的；项目菜单里有归档的才有"已归档的工作区"，展开和收起，新到旧、写归档时间，最多 8 行高再滚动；恢复后菜单关上、工作区回到侧栏，失败在问题行按原因说明 | `packages/ui/src/app/workbench.browser.test.tsx` "Workbench workspace archiving (M1.11)"、"describeArchiveError"、"describeRestoreError" | 已覆盖 |
| 端到端：真实 app 里归档一个开着标签页的 worktree，确认后目录删掉、分支还在、标签页和侧栏行消失；重启后仍是归档的，从项目菜单恢复，目录回来、在原分支上 | `apps/desktop/e2e/archive.spec.ts` | 已覆盖 |

## M1.11 三方审查后补（2026-10-12）

| 行为 | 测试 | 状态 |
|---|---|---|
| 丢弃草稿：等 pi 启动完再停的途中来了消息，草稿留着、消息照常发出；途中别的客户端打开了它，草稿和目录留着、pi 重新启动；丢弃了对话唯一的会话、删掉目录后，各客户端布局里的这个对话去掉，停在那里的回到没有位置，目录里有文件没删掉时布局不动；新建对话时布局写不进去，已记下草稿的目录留着 | `packages/host/src/sessions/session-manager.test.ts` "keeps a new draft closed while its pi starts"（两条）、"tab cannot be written"、"discards a draft that never got a message"、"keeps a chat directory that holds files"、"closes a tab closed while its opening waited" | 已覆盖 |
| 消息图片：轮结束后的重建还在读时，等它读完再找条目（读完之前没绑定，读完就有）；没在读时不等；界面在轮结束后另取一次，不沿用运行中发出的那次 | `packages/host/src/sessions/session-controller.test.ts` "waits for the read under way"、`packages/ui/src/chat/message-images.browser.test.tsx` "though the ask from while it ran" | 已覆盖 |
| Fast 开关：切换还在路上时别的客户端改了它（`fast_updated`）或重连后来了新快照，这次切换被拒时回到宿主现在的开关；期间来的其他事件不算宿主的开关 | `packages/client/src/atrium-client.test.ts` "another client switched it while a refused switch"、"though other events came" | 已覆盖 |

## M1.11 自用中改（2026-10-12）

| 行为 | 测试 | 状态 |
|---|---|---|
| 过程标题行和下面的正文左对齐：跑完的 › 箭头左边缘贴住正文左边、标题从 14.5px 起；运行中的小猫贴左、"进行中"从 24px 起；展开后各步的文字仍从 30px 起 | `packages/ui/src/chat/turn.browser.test.tsx` "starts the folded header's arrow at the reply's left edge"、"starts the running cat at the reply's left edge"、"lines the rows' text up 30px in" | 已覆盖 |
| 输入框的展开按钮固定在卡片右上角（离上边、右边各 20px），上方有胶囊时也不往下移；Tab 仍在文字框之后到它 | `packages/ui/src/chat/composer.browser.test.tsx` "keeps the expand button in the card's top right corner"；`packages/ui/src/chat/chat.browser.test.tsx` "shows it on keyboard focus" | 已覆盖 |
| 去掉显示模式：标签栏没有显示模式菜单，Ctrl+O 不做任何事；协议拒绝带 `displayMode` 的 `set_preferences`；`preferences.json` 升到 v3，迁移时删掉 `displayMode` | `packages/ui/src/app/workbench.browser.test.tsx` "has no display mode to switch"、`packages/protocol/src/envelope.test.ts` "a display mode"、`packages/host/src/store/preferences.test.ts`、`load-index.test.ts` | 已覆盖 |
| "新建对话"是"对话"分区标题右侧的图标（⌘N，2026-10-13 改，原先是标题下第一行），没有对话时分区也显示、只有标题；对话行紧跟标题；侧栏别处没有新建对话的按钮 | `packages/ui/src/app/workbench.browser.test.tsx` "starts a chat from the icon on 对话's heading"、"puts the chats' rows right under the heading"、"a new chat with ⌘N" | 已覆盖 |
| 收件箱卡片（2026-10-13）：在滚动的项目和对话下面、"设置"正上方；默认收成标题行（"等你处理"、数字、按优先级每种状态一个图标），点标题往上展开（列表在标题行上方，展开、"还有 N 条"展开都不挪动标题行；列表高度 0.28 秒展开收起、各行依次淡入淡出，最多展开到 228px，箭头 0.3 秒转半圈）、再点收起，展开状态记在 localStorage、下次照样打开；设置"外观 · 侧栏"的开关"显示“等你处理”"关掉后卡片不显示、工作区行的状态照旧，开关发 `set_preferences { inbox }`；偏好 `inbox` 默认真，之前的偏好文件读作真，协议、路由透传 | `workbench.browser.test.tsx` "collects the sessions that need the user in a card"、"opens the inbox's card as it was left"、"leaves the inbox out when switched off"；`settings-panel.browser.test.tsx` "switches 等你处理"；`preferences.test.ts` "shows 等你处理 until told not to"；`router.test.ts`、`envelope.test.ts`；`apps/desktop/e2e/inbox.spec.ts` | 已覆盖 |
| 侧栏底色（2026-10-13）：浅色是取自 DeepSeek Harness 的从上到下的渐变（各段颜色和位置），深色仍是半透明 `rgba(95,102,114,.42)` | `packages/ui/src/app/workbench.browser.test.tsx` "paints the sidebar" | 已覆盖 |
| 侧栏透出系统材质（2026-10-13）：桌面端页面给 `<html>` 标 `data-material`，此时页面底色和侧栏底色都透明（浅色深色一样），主区仍不透明；窗口 `vibrancy: "sidebar"`、背景透明 | `packages/ui/src/app/workbench.browser.test.tsx` "material through the sidebar"、`apps/desktop/e2e/app.spec.ts` "sidebar material" | 已覆盖 |
| 红绿灯和标签对齐（2026-10-13）：窗口的红绿灯离左边 12pt、离顶部 17pt，14pt 的按钮中心在 24pt，和标签、侧栏开关同一水平线 | `apps/desktop/e2e/app.spec.ts` "puts the traffic lights level with the tabs" | 已覆盖 |
| 左栏折叠与右栏（2026-10-13）· 状态：左栏折没折、右栏开没开、右栏宽度各记一个 localStorage 键，没有时是展开、关着、560px；读到的宽度不是数、小于 360px 时当 560px，小数取整；宽度按对话区至少 440px、面板至少 360px 收窄 | `packages/ui/src/state/panes.test.ts` | 已覆盖 |
| 左栏折叠与右栏（2026-10-13）· 工作台：开关在侧栏右上角（226px, 10px），点它或 ⌘B 折叠：侧栏宽度 0.24 秒（先快后慢）收到 0、内容淡出并左移 24px、不能聚焦，开关移到红绿灯右边（84px），标签栏左边距 12px → 120px，开关、标签栏都按同一曲线过渡；说明带快捷键；启动时照上次的样子；标签栏最后一个按钮开关改动面板，开着时按下态，⌥⌘B 也行；换工作区照样开着，到对话里隐去、开关不可用并说明原因，点它和 ⌥⌘B 都不动；新建工作区页上 ⌥⌘B 不动；折没折，开关都能点（按 Electron 拖动区按页面顺序叠加的规则，它没被后面的 `drag` 盖住） | `packages/ui/src/app/workbench.browser.test.tsx` "Workbench panes" | 已覆盖 |
| 左栏折叠与右栏（2026-10-13）· 改动面板：0.24 秒从 0 打开（先快后慢）、面板一开始就是自己的宽度，收起到 0 之后才卸载（里面的过渡先结束不算）；拖左边缘变宽（360px 到对话区剩 440px），拖动时跟手、不加过渡、显示 2px 的 `--tint` 线，松手后恢复过渡；双击回到 560px；← → 每次 16px；放不下时收窄、记住的宽度不变；拖到一半卸载后不再跟着指针；对话里马上隐去，回到工作区重新打开；每个工作区的面板从头开始（选的模式不带过去）；面板贴着左边缘一起滑进滑出（和宽度同一曲线），伸出对话区的部分被裁掉（对话区根元素横向裁切）；一开始就开着时直接显示、不滑；刚开始打开（还是 0 宽）就收起时也会卸载、结束监听（过渡被取消而不是结束）；房间窄、面板被收窄时从显示的宽度开始拖 | `packages/ui/src/chat/changes-pane.browser.test.tsx`、`chat.browser.test.tsx` "keeps the panel open"、`chat.browser.test.tsx` "cuts off the changes panel" | 已覆盖 |
| 左栏折叠与右栏（2026-10-13）· 性能：改动面板开着约 2 万行 diff（6 万个元素）时折叠（M1.12 起是改动标签，见"文件与更改"）、展开左栏，渲染主线程上每段（脚本、样式、布局、PrePaint、绘制）≤ 4 毫秒 | `apps/desktop/e2e/changes.perf.spec.ts` | 已覆盖（收起右栏的第一帧、重新打开的重建未覆盖，见 testing.md "性能预算"） |
| 侧栏项目展开收起：工作区行 0.28 秒收拢 / 从 0 展开，各行依次淡出、淡入；动的时候裁切、静止时不裁（行里的菜单不被挡）；展开、收拢到底和收起后行间距一致（2px，到"对话"6px）；文件夹图标交叉淡化、缩放 0.6，颜色跟着过渡（0.3 秒） | `packages/ui/src/app/workbench.browser.test.tsx` "folds a project's workspaces away in 0.28 s"、"keeps the rows 2px apart"、"cross-fades the project's folder" | 已覆盖 |
| 对话归档（协议 11）：`archive_chat` / `restore_chat` 进协议，对话带 `archivedAt`；`chats.json` 升到 v2（记录可以只有归档），旧版的名称照读，别的字段保留，没变化不写 | `packages/protocol/src/envelope.test.ts`、`packages/host/src/store/chat-records.test.ts`、`load-index.test.ts`、`packages/client/src/atrium-client.test.ts` | 已覆盖 |
| 归档对话：先记下归档时间、要归档的会话（还没归档的，草稿也算）和第一个会话，再停 pi、归档、从布局去掉；记录写不进去时一个会话也不归档；再归档不变；恢复只放回记下的会话、不切过去；归档的对话不能新建会话；不存在的对话 `chat_not_found`；列表里归档的对话沿用归档时的第一个会话取名 | `packages/host/src/sessions/session-manager.test.ts` "SessionManager chats' archive"、`store/chat-records.test.ts` "lists chats with their names and archives"、`server/router.test.ts` | 已覆盖 |
| 界面：对话行悬停时"···"左边的归档图标（2026-10-13 从菜单移出，"···"里只剩"重命名"；和"···"隔 4px），没有会话在运行时直接归档，有时先确认（N 个正在运行）；归档的对话不在对话列表和搜索里；"已归档的对话"只在有归档时出现，点开按归档时间新到旧、沿用名称、最多 8 行高；"恢复"不切过去，最后一个恢复后这一行消失；失败在问题行说明 | `packages/ui/src/app/workbench.browser.test.tsx` "Workbench sidebar: archived chats" | 已覆盖 |
| 新建工作区 · 协议（协议 12）：`list_bases`、`create_workspace` 的字段和应答，`create_session` 的 `go`，错误码 `worktree_create_failed`；客户端发出它们，`go` 没给时不带 | `packages/protocol/src/envelope.test.ts`、`packages/client/src/atrium-client.test.ts` | 已覆盖 |
| 新建工作区 · 宿主（真实 git）：从 `origin/main` 建（本地 main 领先时也从 origin 的提交起，不设上游，日志不带分支）、本地分支作起点、目录在 `<仓库>.worktrees/<分支最后一段>`；扫描记成外部的同一目录改记为 Atrium 建的；`branch_invalid`（`a..b`、`-b`、`@{-1}`、`atrium/`）、`base_missing`（含 `--all`）、`branch_exists`、`dir_taken`（目录已有东西、有工作区记录，含归档的）、`not_git`（普通目录、仓库的子目录）、未知项目、没有 git、`worktree add` 失败只记退出码；和归档恢复排同一个队、`close` 等它做完；`list_bases` 的主干、当前分支（detached、没有提交时为空）、本地和远程分支（去掉 `*/HEAD`）、`not_git`；列表命令转交、路由转发；`go: false` 打开标签但不挪位置 | `packages/host/src/workspaces/worktree-creator.test.ts`、`workspace-archiver.test.ts` "waits for a worktree change before it in the queue it shares"、`sessions/index-commands.test.ts`、`server/router.test.ts`、`sessions/session-manager.test.ts` "without taking the client there" | 已覆盖 |
| 新建工作区 · 界面状态：建议的分支名、默认起点（主干、本地分支、`HEAD`）、每个项目一个草稿键；页面打开关闭、换项目回到新建 worktree 并保留分支名；页面的模型按钮（选的模型和档位、选了模型没选档位用记住的）；发出后按步走：建 worktree 后页面改成这个工作区、建好会话后草稿交给会话并关掉页面、离开了页面时 `go: false` 且不动用户去的页面、选了模型或档位就设上、都没选用 `list_commands` 等 pi、最后发出并消失；失败停在那一步，消息回到原来的框（会话已建好时回到会话的框，框里有新字时不覆盖），可以再发；再打开页面时去掉还没有会话的失败；失败的说法 | `packages/ui/src/state/new-workspace.test.ts` | 已覆盖 |
| 新建工作区 · 界面：项目行悬停的"+"打开页面，项目行选中、工作区行不选中、没有标签栏、输入框有焦点；点工作区、对话（含回车）、收件箱、搜索到的工作区对话会话，或"新建对话"、⌘N、⌘T 就离开，⌘W 和 ⌘1–9 在页面上不起作用；项目被移除时关掉；页面上不把背后会话的错误标成已看过；选择排：项目、新建 worktree（默认）或已有工作区（本地在前）、起点按本地和远程分组、分支名原地改（回车确定、Esc 放弃），选已有工作区时说明变、起点和分支名不显示；不是 git 仓库时进本地工作区、"新建 worktree"置灰并说明；发出后时间轴（还没开始、进行中、做完、失败的节点，第一步写分支和起点）、淡色的待发消息、输入框能打字不能发、选择置灰；建好会话后切到新工作区、时间轴留在会话上方直到发出，发出时由会话自己的待发消息接替；第 1 步失败写原因、消息回到页面的框；第 3 步失败留在会话上方，下一次发送时消失；页面上选的模型在发出前设给会话；输入框 `held` 时能打字不能发（2026-10-20 起时间轴和气泡改在这一轮里，见下文"M1.11 自用中改（2026-10-20）"） | `packages/ui/src/app/new-workspace.browser.test.tsx`、`packages/ui/src/chat/composer.browser.test.tsx` "while held" | 已覆盖 |
| 新建工作区 · 端到端：真实 app 和 git 仓库，本地 main 领先 origin 时从项目页用第一条消息建 worktree，回复出现在新工作区里、侧栏选中它；worktree 在 `repo.worktrees/` 下、在新分支上、从 `origin/main` 的提交起、没有上游配置 | `apps/desktop/e2e/new-workspace.spec.ts` | 已覆盖 |
| AI 起分支名 · 协议（协议 15，2026-10-14）：`name_branch` 的字段（文字不能空、模型可为 `null` 但必须给）和应答，错误码 `branch_name_failed`；客户端发出它 | `packages/protocol/src/envelope.test.ts`、`packages/client/src/atrium-client.test.ts` | 已覆盖 |
| AI 起分支名 · 宿主（真实 git）：整理模型的回答（第一行、小写、去掉 `/` 之前、非 `a-z0-9` 换成一个 `-`、去首尾 `-`、40 个字符内在最后一个 `-` 处截断或硬截、不到 2 个字符算 `invalid`）；在项目目录调用，带说明、按字符截到 1200、15 秒；模型依次是 pi 列出的标题模型、页面的模型、pi 在项目目录的默认模型（标题模型查不到时退到下一个），都没有 `no_model`；调用失败 `failed`；本地分支、目录、工作区记录占着时依次加 `-2`…`-9`（不带前缀的同名分支不算），都占着 `taken`；未知项目、普通目录、没有 git 在调用模型之前就失败；日志只记项目和原因，不记消息和回答；列表命令转交、路由转发 | `packages/host/src/workspaces/branch-namer.test.ts`、`sessions/index-commands.test.ts` "hands naming a branch"、`server/router.test.ts` | 已覆盖 |
| 一次性调用不带目录里的 AGENTS.md（`--no-context-files`）；faux 在 `-p` 下被要求起 git 分支名时用脚本的 `branch` 回答、没写时回错误，目录名里有 branch 不算，记下模型收到的说明 | `packages/pi/src/oneshot/oneshot.pi.test.ts` "tells the model only its instructions"、`oneshot.test.ts`；`packages/testkit/src/faux/faux.pi.test.ts` "print mode" | 已覆盖 |
| AI 起分支名 · 界面状态：页面默认自动起名，换项目时保留写了的名字、否则自动；发出后多一步"起名"，用页面的模型按文字起，起好后（还在页面上时）页面的分支名换成它，再发不再起名；起不成用随机名接着走、记作随机；只有图片（文字为空白）时用随机名、没有这一步；离开了页面时不改别的页面，起名时页面关掉也接着走 | `packages/ui/src/state/new-workspace.test.ts` "names the branch…"、"names a branch randomly…"、"names no more…"、"closed while naming" | 已覆盖 |
| AI 起分支名 · 界面：分支名按钮自动时写"自动起名"、前面 `--tint` 的 sparkles、悬停说明，写了名字换回铅笔；点开是空的输入框，占位"输入分支名，留空让 AI 起名"（`--text-dim`），提示多"清空恢复自动起名"，清空恢复自动；时间轴"起名"进行中写"按第一条消息"，起好写名字、下一步只写"基于 origin/main"，起不成写"没起成，用随机名 xxx"、下一步写随机名，不报错；自己写了名字没有这一步；第 1 步失败后按钮写起好的名字 | `packages/ui/src/app/new-workspace.browser.test.tsx` "says the model names the branch"、"names the branch, creates the worktree"、"names the branch randomly"、"goes without naming"、"edits the branch in place"、"stops at a worktree" | 已覆盖 |
| AI 起分支名 · 端到端：真实 app、宿主和 faux pi，没写分支名时第一条消息经 pi 起名，worktree 建在整理后的 `atrium/<名字>` 上、目录同名 | `apps/desktop/e2e/new-workspace.spec.ts` "names the new worktree's branch" | 已覆盖 |
| 认证类失败的判断（protocol 一份，宿主的 `auth` 关注状态和对话里的错误卡片共用）：每个关键词各自认得出、`401` 按整词、其他失败不算 | `packages/protocol/src/listing.test.ts` | 已覆盖 |
| 认证类失败的错误卡片：橙色钥匙和"登录已失效"，有"重试"的地方前面多一个"去登录"，没有设置可开或不是最后一轮时不显示；其他失败仍是红色"回复出错"；"去登录"打开设置的"模型与账户" | `packages/ui/src/chat/turn.browser.test.tsx` "credentials""去登录 only"、`packages/ui/src/app/workbench.browser.test.tsx` "去登录" | 已覆盖 |
| 失败的一轮（2026-10-13）：错误卡片只有一个主按钮，同色浅底（登录失效又能重试时是"去登录"、`--attn-soft` 底 `--attn-text` 字，"重试"是 `--text-muted` 的文字按钮；其他是"重试"，`--danger-soft` 底 `--danger` 字）；"详情"在这一行最右，点开原始报错、`aria-expanded`，› 0.3 秒转向下；没有回复也没有改动的失败轮不显示信息行，有部分回复或改了文件时照常显示 | `packages/ui/src/chat/turn.browser.test.tsx` "behind 详情"、"credentials"、"去登录 only"、"ends a failed turn" | 已覆盖 |
| 回复里的代码块（2026-10-14，原型 B"平铺"）：`--code` 底、圆角 10px、不描边，内边距 12px 14px，12.5px 等宽、行高 20px，没有行号，高亮不带主题底色；语言名在右上角（11px `--text-dim`、垫 `--code` 底）；只有"复制"一个按钮，用 Atrium 的图标；深色外观是深色的 `--code` | `packages/ui/src/chat/markdown.browser.test.tsx` "lays a code block flat"、"dark code colour" | 已覆盖 |
| 块的按钮悬停或里面有焦点时才出现，语言名同时淡出 | `markdown.browser.test.tsx` "while hovered or focused inside" | 已覆盖 |
| 回复里的表格不加框、占满宽度：表头 13px 半粗 `--text-muted`、下面 1px `--line-strong`，行间 1px `--line-soft`、最后一行下面没有线；悬停时出现"复制表格""放大"；放大后的表格边框是 `--line`，不是黑色 | `markdown.browser.test.tsx` "without a frame"、"seen larger" | 已覆盖 |
| 代码块、表格、图下面和别的块一样隔 12px；行内代码 `--surface-2` 底、圆角 6px | `markdown.browser.test.tsx` "keeps 12px under"、"inline code" | 已覆盖 |
| Mermaid：平铺在 `--code` 上，节点用 token 的中性色（浅色 `--main` 白、深色 `--main` 深）；悬停有"看源码""复制""放大"，切到源码再切回图；还在输出的块（插件已加载）显示源码、没有切换 | `markdown.browser.test.tsx` "Mermaid flat"、"Mermaid in dark colours"、"still being written" | 已覆盖 |
| 空状态（2026-10-14）：工作区、对话、不绑定项目的新对话一样，中间只有一句"每天都做一些改变出来"（20px），句末一个闪烁的光标（2px 宽、1.15em 高、离字 3px、`--tint`、1.06 秒一亮一灭不渐变、读屏不读）；减弱动效时常亮（浏览器测试没法切减弱动效，未测）；打开着的会话还什么都没有时也显示这一句，发出第一条消息就换成对话，内容还在加载、有更早的记录、在运行、在压缩、新建工作区页正在建它时不显示 | `packages/ui/src/chat/chat.browser.test.tsx` "says only one line"、"says the same line"、"does not say the line" | 已覆盖 |
| 消息列（2026-10-15）：消息和输入框在同一列里，最宽 800px（`--column`，含左右 24px 内边距），在对话区居中；运行控制、新建工作区页的选择行和时间轴用同一个宽度 | `packages/ui/src/chat/chat.browser.test.tsx` "one column at most 800 px wide" | 已覆盖（运行控制、选择行、时间轴只共用同一个值，未单独测） |
| 侧栏搜索框（2026-10-15）：常驻顶部、在"项目"标题上面，没有搜索按钮；输入时项目和对话换成结果；Esc 清空并离开搜索框，项目列表回来 | `packages/ui/src/app/workbench.browser.test.tsx` "from the box always at the top" | 已覆盖（不随下面滚动只靠它在滚动区外面，未单独测滚动） |
| 项目里的工作区（2026-10-15；2026-10-21 改为剩余数）：最多列 5 个，当前所在的排在后面时接着显示；有未显示的工作区时末尾"显示剩余 N 个"，N 扣除所有已显示项，点开全部列出、变成"收起"，再点回到 5 个及额外的当前项；当前离开后它不再多列；当前换到别的项目时收回去，回来也是收着的（2026-10-16）；没有剩余时无展开行；这类展开行整行可点（和行一样宽、高 30px，对话的也是；已归档的对话、收件箱的"还有 N 条"共用同一个样式，未单独测） | `packages/ui/src/app/workbench.browser.test.tsx` "lists five of a project's workspaces"、"folds a project's workspaces back"、"every workspace of a project with five"、"lists chats like workspaces" | 已覆盖 |
| 状态栏详情卡片（2026-10-15）：标题行下面没有分隔线；卡片不伸出窗口，展开的长列表（如 50 个 skill）在卡片里滚动（2026-10-16） | `packages/ui/src/chat/status-bar.browser.test.tsx` "splits the context in its card"、"grows past the window" | 已覆盖（各卡片共用同一个标题行和外框，只在上下文卡片上测） |
| 已移除的工作区（2026-10-15）：worktree 目录不在了的工作区不在项目里列出，搜索也找不到；它是当前所在的时照样列出、选中 | `packages/ui/src/app/workbench.browser.test.tsx` "whose directory is gone" | 已覆盖 |
| 侧栏材质不随焦点变（2026-10-15）：窗口 `visualEffectState: "active"`，另一个窗口拿走焦点时，系统画出的侧栏颜色不变 | 不自动测（用户 2026-10-24 定：截屏要屏幕录制权限）。原先 `app.spec.ts` "keeps the sidebar's material as it is when another window takes the focus" 用 `screencapture -l` 截窗口比较颜色，没有屏幕录制权限的终端里报 `could not create image from window`，整套端到端一直有这一项失败，已删去；页面一侧的透明仍由 "marks the page as having macOS's sidebar material behind it" 测 | 不自动测 |
| 新建工作区页的下拉（2026-10-14，原型 B"单行"）：行高 32px、13px `--text-2`，左边图标、右边补充信息、行尾 ✓ 槽（`--tint`，没选中时空着），选中项 `menuitemradio` 打勾；项目补充信息是所在目录（过深时只留最后两级）、悬停完整路径；工作区："新建 worktree"加号 `--tint`，本地电脑图标 `--text-muted`，worktree 分支图标 `--tint`，有未提交改动时橙点（悬停说明）、领先时 ↑N、没归档的会话数；起点：过滤框打开就聚焦、按名字一部分过滤不分大小写、都不匹配时"没有匹配的分支"，主分支和本地当前分支的小标签，当前起点打勾 | `packages/ui/src/app/new-workspace.browser.test.tsx` "lists each choice on one line"、"filters the bases"、"chooses a new worktree" | 已覆盖 |
| 改名框（2026-10-14，原型 B"原地 + 提示"）：盖在名字上、字的位置不动，26px 高、圆角 6px、`--main` 底、1px `--tint` 描边加 `--focus-ring`、字号随所在的行；下方 4px 浮一行提示（`⏎ 保存`、`esc 取消`，工作区加"清空恢复为分支名"，对话加"清空恢复为第一个会话的标题"），11px `--text-muted`、圆角 6px、和框左对齐、挂在页面上不被行裁掉，是框的说明；新建工作区页的分支名提示在上方、字在按钮原来的位置；会话在标签上原地改、关闭按钮先藏起来，改名失败在菜单旁说"改名失败"，到菜单里下一个操作为止 | `packages/ui/src/sidebar/rename-field.browser.test.tsx`；`workbench.browser.test.tsx` "renames a chat in place"、"renames a workspace in place"、"renames and archives the active session"、"renaming the session failed"；`new-workspace.browser.test.tsx` "edits the branch in place" | 已覆盖 |
| 会话改名经过 pi：标签上改名后 pi 在会话文件末尾写 `session_info`，标签显示 pi 记下的名字，重启后还在 | e2e `apps/desktop/e2e/rename.spec.ts`；宿主 `session-manager.test.ts` "renames a session in pi"；契约 `packages/pi/src/contract/session.pi.test.ts` | 已覆盖 |

## M1.11 自用中改（2026-10-19）

| 行为 | 测试 | 状态 |
|---|---|---|
| 哪些服务商走订阅套餐：`claude-bridge`、`openai-codex`、`github-copilot` 不管登录状态都算；`openai`、`xai` 只在设置的登录状态里这家用 OAuth 登录时算（用 API Key、没登录、别家用 OAuth、登录状态不知道或 pi 不能登录都不算）；`anthropic`、`deepseek` 和别的服务商用 OAuth 也不算 | `packages/ui/src/chat/model-choice.test.ts` "counts claude-bridge, openai-codex and github-copilot"、"counts openai and xai only while signed in"、"never counts anthropic, deepseek" | 已覆盖 |
| `claude-bridge` 显示为"Claude 订阅"、用 Claude 的图标；`deepseek` 显示为"DeepSeek"、用官网图标而不是首字母 | `model-choice.test.ts` "names the providers it knows"；`packages/ui/src/chat/model-picker.browser.test.tsx` "shows claude-bridge as Claude 订阅" | 已覆盖 |
| 走套餐的签：模型面板左列走套餐的服务商图标右下角有"套餐"签（离按钮右边 1px、下边 3px，高 12px，`--tint` 底、字 8px 600、面板底色），在"当前模型"小点下面不重叠；右栏顶上服务商名后面写"套餐"（`--tint`、11px）；输入框模型按钮的图标带同样的签（比图标右边多出 8px、下边 4px）；签是名为"走套餐"的图；按量计费的服务商、登录状态没说用 OAuth 的 OpenAI 和 xAI 都没有签；对话区和新建工作区页把设置的登录状态交给模型按钮，登录状态到了签跟着出现 | `model-picker.browser.test.tsx` "ModelPicker's plan tag"、"opens above the button"；`packages/ui/src/chat/chat.browser.test.tsx` "tags a provider on a plan as the setup's login state says"；`packages/ui/src/app/new-workspace.browser.test.tsx` "tags the model button of a provider on a plan" | 已覆盖（深色外观下的颜色未单独测） |
| 胶囊点开的面板（design-language"胶囊点开的面板"）：排队面板和子对话列表各自浮在自己的胶囊正上方 8px、左边和胶囊左边齐；排队面板右边到胶囊条右边；子对话列表宽度按内容、最窄 300px、右边不超出胶囊条（胶囊前面的东西多了也一样）；箭头转半圈 | `packages/ui/src/chat/run-control.browser.test.tsx` "floats the queue 8px above its capsule"；`packages/ui/src/children/children.browser.test.tsx` "floats its list 8px above the capsule"、"keeps its list within the bar" | 已覆盖 |
| 点空白处（面板、胶囊和输入框以外的地方）、按 Esc 收起面板（排队面板和子对话列表都是）；点面板里的东西（如行的"···"菜单）、点输入框和它里面的按钮（打字、停止）不收起；收起编辑的 Esc、输入框拿去停止运行的 Esc 不收起面板；点另一个胶囊换成那个的面板；收起后不再监听 | `run-control.browser.test.tsx` "closes the queue on a press outside it"、"keeps the queue open on a press in the input box or on its stop button"、"closes the queue on Escape, but not on the one that gives up an edit"、"switches to the other capsule's panel"；`children.browser.test.tsx` "closes its list on a press outside it and on Escape" | 已覆盖（输入框停止运行的 Esc 未单独测；监听的释放未单独测） |
| 面板的动效：展开时从底边往上长（`clip-path`，0.28 秒 `cubic-bezier(.45, 0, .15, 1)`，裁剪留出阴影的位置），各行从下 6px 淡入（0.22 秒，第一行晚 60ms，之后每行再晚 30ms）；收起不做动画、面板直接消失（2026-10-21 自用时改）；减少动态效果时直接出现、消失 | `run-control.browser.test.tsx` "grows the panel from its bottom edge"（含收起时面板立刻没有）、"closes the queue on a press outside it, the panel going at once"、"opens and closes at once when less motion is asked for" | 已覆盖 |
| 模型列表的规则表：恢复 pi 自己的 `anthropic` 和它的默认模型（2026-10-22 用户要求，OAuth / API Key 都可见，界面不加套餐签）；仍去掉 `azure-openai-responses`、不是 ChatGPT 登录的 `openai`（登录状态读不出时也去掉）、OpenRouter 里 `anthropic/`、`openai/` 开头的，别家 `openai/` 开头的不算；同一订阅两条路时列表里有 `openai-codex` 的模型就不列 `openai` 的，没有时 ChatGPT 登录的 `openai` 照常列；pi 的默认模型被去掉、不在列表里或没有时没有默认 | `packages/host/src/sessions/model-rules.test.ts` | 已覆盖 |

## M1.11 自用中改（2026-10-20）

空思考／空回复展示（SPEC-0001“空思考与空回复”，不改变协议、原始步骤或重试策略）：

| 行为 | 测试 | 状态 |
|---|---|---|
| 空／纯空白 thinking、text 不生成过程或回复，不打断只读工具合并，不覆盖非空回复；Markdown 导出同样不列空思考 | `packages/ui/src/chat/turn-layout.test.ts` "omits blank thinking and text…"、"has no display content or exported thinking…" | 已覆盖；合并 main 后 `turn-layout.ts` 增量变异 100%（642 个检出、其中 631 个复用，无存活／超时），展示层三项破坏检查均 CAUGHT |
| 集成 main 的末尾压缩回复规则：正文后空思考、压缩、空文字不遮住正文，压缩仍留在过程、导出保留正文 | `packages/ui/src/chat/turn-layout.test.ts` "keeps a reply visible across trailing blanks and compactions after integration" | 已覆盖；分别去掉空块过滤、尾部压缩跳过，两项破坏检查均 CAUGHT |
| 运行中空块沿用等待行，文字到达后正常显示；工具正常执行并可看详情，不显示空思考或空回复 | `packages/ui/src/chat/turn.browser.test.tsx` "waits without blank thinking…"、"omits blank thinking while keeping tools…"、"keeps a tool-only run visible…" | 已覆盖 |
| 正常空结束不留回复、过程、footer 或错误；连接失败仍有错误和手动重试，取消仍为已停止；非空思考后的失败／取消标题优先显示结束状态 | turn.browser.test.tsx "leaves a normal empty end…"、"keeps connection errors and cancellation distinct…"、"keeps %s ahead of a thinking-only header" | 已覆盖 |
| 用户输入、report 通知开头的正常空 stop 都正常完成；推进假时钟 60 秒不额外 prompt、不重启、不产生 retry 步骤；来源及送达确认保留 | `packages/host/src/sessions/session-controller.test.ts` "leaves a normal empty reply completed…"、"leaves a report's normal empty reply completed…" | 已覆盖；两项破坏检查均 CAUGHT |
| 真实 pi + faux 经工具执行到正常空结束，桌面不显示空思考／回复；再发一条无工具空结束，不留 footer；非空摘要／正文原有旅程正常 | `apps/desktop/e2e/chat.spec.ts` "shows tools without blank thinking…"、"sends a message and streams the reply…" | 已覆盖；回退过滤后桌面回归测试失败，恢复后通过；浅／深色截图已检查 |

一轮中间的压缩是过程轨道上的一步（SPEC-0001 `compaction`、design-language"压缩步骤""运行中压缩"，协议 20）。

| 行为 | 测试 | 状态 |
|---|---|---|
| pi 包把 `compaction_start` 翻译成带原因的 `compaction_started`，`compaction_end` 翻译成带原因、`aborted`、`willRetry`、报错原文和结果（只有条目里也有的 `summary`、`firstKeptEntryId`、`tokensBefore`）的 `compaction_finished`；中止、失败时结果为空 | `packages/pi/src/events/translate.test.ts` "reports the start of a compaction with what set it off"、"reports a compaction's end with the entry it wrote…"、"reports tool calls once complete…"（录制夹具） | 已覆盖 |
| 压缩条目带 `firstKeptEntryId` | `packages/pi/src/history/log-entry.test.ts` "maps a recorded session…"、"keeps no system prompt for a compaction that stored none…" | 已覆盖 |
| 真实 pi（1.1.0、faux）：一次运行最后一条回复之后（`agent_end` 和 `agent_settled` 之间）、工具结果之后下一次请求之前都会自动压缩（`threshold`）；条目的位置，和 `compaction_end` 的结果与条目相同 | 契约 `packages/pi/src/contract/compaction-run.pi.test.ts`，夹具 `pi-1.1.0/compaction-run.jsonl` | 已覆盖（本机 pi 是 1.3.0，没有这一版的夹具，契约测试用 1.1.0 跑） |
| 协议：`compaction` 步骤（`tokensBefore`、可空的 `tokensAfter`、`summary`、`overflow` / `threshold` / 空的 `reason`），`compacted` 提示条加 `tokensAfter`；协议版本 20 | `packages/protocol/src/envelope.test.ts` "Step: says a compaction's tokens as whole counts…"、"HostMessage accepts…every session event" | 已覆盖 |
| 重建：压缩条目后面（下一条开启新一轮的消息之前）还有这一轮的回复、工具结果、插话或送达，就是这一轮在那个位置的一步；紧跟用户消息的是第一步；紧挨下一条消息的是两轮之间的提示条，宿主当场看到的除外（这一轮最后一步）；一轮几次压缩就几步；溢出恢复是"失败的回复、压缩、重试的回复"，没有重试步骤；任何一轮之前的是提示条 | `packages/host/src/transcript/projection.test.ts` "makes a compaction a step where it happened…"、"…right after the user message the turn's first step"、"…right before the next user message a notice between the turns, unless the host saw it in the run"、"shows pi recovering from an overflow…"、"gives each compaction in a turn its own step…"、"takes a reply pi omitted to recover from a context overflow for no retry…"、"puts a compaction before any turn in place…" | 已覆盖 |
| 工具结果之后、压缩之后的用户消息照样算插话 | projection.test.ts "still takes a message after a tool result and a compaction for a steer" | 已覆盖 |
| 压缩后的 token 数：之后第一条三项不全为 0 的回复的 `input + cacheRead + cacheWrite`，步骤和提示条一样；没有这样的回复时为空 | projection.test.ts "gives each compaction in a turn its own step, its input after it…"、"puts a compaction before any turn in place, as a notice with the next reply's input…"、"…unless the host saw it in the run" | 已覆盖 |
| 实时：运行中压缩成功完成时 `step_added`（在当前位置），下一条有用量的回复来了 `step_updated` 补上 token 数，上一轮最后一步的压缩由下一轮的回复补；中止、失败、没有运行中的轮时不加；`/compact` 没有原因 | `packages/host/src/transcript/session-transcript.test.ts` "adds a finished compaction as a step…"、"adds no step for a compaction that was stopped or failed…"、"waits for a reply that says its input…" | 已覆盖 |
| 实时和重建一致：录制的两次运行（最后一步的压缩、工具结果后的压缩）逐条发出的步骤，运行结束后重读都是 `same`；看到的压缩按条目记下原因交给 `onTurnsSeen` | session-transcript.test.ts "adds each compaction live where it happened, and a rebuild that knows the host saw them agrees" | 已覆盖 |
| 先前的宿主记下的压缩照样让一轮最后的压缩算这一轮的步骤；没有记录时是提示条 | session-transcript.test.ts "keeps a compaction at the end of a run a step through rebuilds, by an earlier host's record too" | 已覆盖 |
| 控制器：压缩结束先发 `step_added`、再发 `control_updated`（不再压缩）；之后的回复补 token 数；运行结束重读时记下压缩和原因，不重发快照 | `packages/host/src/sessions/session-controller.test.ts` "adds the compaction as a step when pi ends it…" | 已覆盖 |
| 压缩记录存进 `turns/<会话 id>.json` 的 `compactions`（有了才写，每条只记一次，原因按第一次），下一个宿主读回；会话 id 不能做文件名的只在内存；分叉、子对话复制父会话的记录 | `packages/host/src/store/turn-starts.test.ts` "records the compactions the host saw during runs…"、"writes nothing when every entry recorded is known already"；`session-manager.test.ts` "hands the session the compactions an earlier host saw during runs…"、"copies the parent's turn starts to a child forked into a new worktree…" | 已覆盖 |
| 界面：压缩步骤的节点是两道横贯主线的刻痕（13×1.5px，中心相距 3px，`--text-dim`），主线不断；文字"压缩了上下文 · 152K → 41K"（`--text-muted`，数字等宽）、不知道压缩后时"· 压缩前 152K"、溢出时"上下文超出窗口，已压缩"，后面 `›`；点开是"压缩前 152K tokens · 压缩后 41K · 保留了最近的原文"（`--fs-sm`、`--text-dim`）和 Markdown 摘要，`›` 转向下 | `packages/ui/src/chat/turn.browser.test.tsx` "TurnView compaction"；`turn-layout.test.ts` "describes a compaction by the context before and after…" | 已覆盖（深色外观未单独测） |
| 折叠后的标题行末尾"压缩了 N 次上下文"，在"N 条命令没走通"之后 | turn.browser.test.tsx "ends the folded header with how many times the context was compacted"；`turn-layout.test.ts` "counts files read, searches and commands…" | 已覆盖 |
| 运行中压缩：运行中的轮的轨道末尾一行"正在压缩上下文…"（闪光，刻痕节点），前一步不再算进行中；第一步之前压缩时也有轨道、没有等待行；轮与轮之间的压缩仍在底部（2026-10-26 起底部是压扁的小猫加扫光，见"M1.11 自用：'正在压缩上下文'的小猫与扫光"） | turn.browser.test.tsx "says on the rail where pi compacts now…"；`chat.browser.test.tsx` "says pi compacts on the running turn's rail…"、"says at the bottom of the conversation while pi compacts, the cat pressed flat" | 已覆盖 |
| 轮与轮之间的提示条"上下文已压缩 · 152K → 41K"，不知道压缩后时"上下文已压缩 · 压缩前 152K tokens" | turn.browser.test.tsx "NoticeView"；`turn-layout.test.ts` "writes a compaction in the process as a quoted line…" | 已覆盖 |
| 正文后自动压缩不把正文收进折叠过程：跳过末尾连续压缩后取最后一步文字为回复；压缩保留在过程，工具后跟压缩、只有压缩或空轮不产生回复；Markdown 导出保留完整正文；实时追加压缩后正文仍可见，折叠与展开均不重复正文（2026-10-20 自用修复） | `packages/ui/src/chat/turn-layout.test.ts` "keeps the reply outside the process…"、"has no reply for only compactions…"、"exports the complete reply…"；`turn.browser.test.tsx` "keeps the answer visible when a trailing compaction…" | 已覆盖 |
| 复制成 Markdown：压缩步骤写成一行引用，提示条带压缩前后 | turn-layout.test.ts "writes a compaction in the process as a quoted line, and one between turns with the context after it" | 已覆盖 |
| 过程里 AI 说的话（一轮里的文字步骤）：节点是 7px 实心蓝点、外圈 2px 底色，文字正文色、500 字重；思考不加标识 | `packages/ui/src/chat/turn.browser.test.tsx` "what the agent said" | 已覆盖 |
| 推理和文字步骤在行里显示第一行（空白合并、最多 160 字，后面还有内容加"…"），不按句号截（"Grok 4.7"不被截断）；一行放不下由行尾截断、不折行 | `packages/ui/src/chat/turn-layout.test.ts` "opening"；`turn.browser.test.tsx` "shows as much of a long first line as the row holds" | 已覆盖 |
| 运行中的点阵涡旋（侧栏、标签栏 14px，子对话行 12px）：5×5 裁成圆的 21 个点、跟文字色；每个点按三档亮度跳变、1.65 秒一圈，按位置错开成螺旋臂；不同时刻出现的图标同一相位；减弱动态时停在一帧；其他状态不用它 | `packages/ui/src/design/running-dots.browser.test.tsx`；`sidebar/status-icon.browser.test.tsx`；`chat/lanes.browser.test.tsx` "counts beside a child still on its task" | 已覆盖 |
| 用户气泡里没有空格可断的长串（URL、token）在气泡宽度处断开，不伸出气泡 | `packages/ui/src/chat/chat.browser.test.tsx` "breaks a long URL at the bubble's width" | 已覆盖 |
| 输入框文字离卡片左边 20px、上边 16px，展开按钮离上边 16px、右边 20px，和第一行对齐（2026-10-20 由 20px 收到 16px） | `composer.browser.test.tsx` "starts the text 20px from the card's left and 16px from its top"、"keeps the expand button in the card's top right corner"；`chat.browser.test.tsx` "sits just under the input box" | 已覆盖 |
| 回复里的表格最高 640px（原先 Streamdown 默认 300px）；2026-10-22 起再高就收起、不在里面滚动，见下文"M1.11 自用中改（2026-10-22）" | `packages/ui/src/chat/markdown.browser.test.tsx` "folds a table taller than 640px…" | 已覆盖 |
| 新建工作区的启动过程在这一轮里（原型甲）：发出后对话区就是消息流的版式（同对话记录的内边距和间距，气泡在消息列顶部靠右），气泡下面是这一轮的过程，标题行同运行中（小猫、扫光的"准备工作区"），步骤一步步长出、没开始的不画；从新建工作区页换成会话、"发出消息"做完、宿主的这一轮到了，气泡和标题行的位置都不变，气泡、标题行、"准备工作区"那一行和已经长出的步骤是同一份 DOM（不重新挂载），标题行接着就是"进行中"；会话自己的待发副本和"进行中"那一行不另外画 | `packages/ui/src/app/new-workspace.browser.test.tsx` "keeps the message and the steps where the turn is, the same nodes, from sending till the turn runs"、"lays the launch out as the transcript does…"、"names the branch, creates the worktree and the session, then sends…"、"goes without naming a branch written…"；`chat.browser.test.tsx` "does not say the line in a session the new-workspace page is making" | 已覆盖 |
| 入场动效只给刚开始的一步：发出时第一步、之后新开始的一步有入场；会话再显示这次启动时已经有的步骤没有 | new-workspace.browser.test.tsx "keeps the message and the steps where the turn is…"、"shows the steps of a launch shown again without their entrance…" | 已覆盖 |
| 气泡在"发出消息"做完前 60% 不透明，做完后 0.2 秒变实、时间淡入；气泡下面一行高度不变 | new-workspace.browser.test.tsx "shows the message at 60% until it has gone, then fully, with its time coming in" | 已覆盖 |
| 做完后步骤原地收成一行灰色摘要"在 <分支> 建好工作区 · 基于 <起点> · 用时 N 秒"（30px、前面 `›`），点开再展开四步；agent 的步骤接在摘要下面；减少动态效果时直接换；选的是已有工作区时"在 <工作区> 里开好会话" | new-workspace.browser.test.tsx "folds the steps into a summary of where and how long once sent…"、"folds the steps into the summary at once when less motion is asked for"、"says it opened a session in a workspace already there" | 已覆盖（收起的高度动画只看了结束状态） |
| 失败：那一步 × 加原因，行尾"重试"；标题"没建好工作区"、前面 ⌄；气泡保持 60%，下面"没发出，已放回输入框"；"重试"从失败的那一步接着走，不再起名，输入框里还是放回的那条时清空，打了别的就不动；已经有会话时不再建会话；失败停住的时间不算进用时 | new-workspace.browser.test.tsx "stops at a worktree that could not be created…"、"goes on from a failed step on 重试…"；`packages/ui/src/state/new-workspace.test.ts` "retryLaunch" | 已覆盖 |
| 启动的状态：发出后启动留在列表里（`sentAt`、`done` 为全部步数），给这一轮的摘要用，不再挡发送；记下开始、失败、发出的时间（页面的时钟） | new-workspace.test.ts "creates the worktree, the session, waits for pi and sends, step by step, then stays for its turn"、"pageLaunch"、"retryLaunch" | 已覆盖 |
| 窗口的权限：只有应用自己的页面（按协议和主机名）能写剪贴板（`clipboard-sanitized-write`，复制按钮要用），读剪贴板、通知、媒体等一律拒绝，别的来源、不是地址的都拒绝 | `apps/desktop/src/main/permissions.test.ts`；打包后实测过一次真写剪贴板（e2e 不碰真剪贴板） | 已覆盖 |
| 破坏检查脚本：按 case 改坏代码、跑指定的测试和项目（默认 unit）、报 CAUGHT / MISSED、有漏掉的退出码 1、每次都改回原样；case 的文字在文件里不是恰好一次时什么都不改、退出码 2 | `scripts/break-check.test.ts` | 已覆盖 |

### 对话图表与图片（2026-10-20）

SPEC-0001“回复渲染”；原型 `chat-rendering-support-prototype.html` 的 B“全屏画布”。

| 行为 | 测试 | 状态 |
|---|---|---|
| PlantUML / puml 完整代码块用官方本地 JS 引擎，在独立 worker 里渲染时序、类、活动、组件图及中文；暗色主题；SVG 只作为 Blob 图片；未闭合代码块不开始工作；源码切换、全屏放大、语法失败保留原文并重试 | `packages/ui/src/chat/plantuml.browser.test.ts`、`diagram-block.browser.test.tsx` | 已覆盖 |
| 输入 32 KiB、输出 2 MiB UTF-8、缩放后单边 8192px；并发 2、等待 16、10 秒期限；排队/运行取消、异常和期限清理 worker、监听和定时器；本地 include、URL include、宏展开后的 URL 和额外库被拒；真实 module worker 的 URL / 类型 | `plantuml.test.ts`、`plantuml.browser.test.ts`（含 `scale 4` 的回归） | 已覆盖 |
| 保留行内及引用式 Markdown 图片的原始 URL；本地路径只经当前工作区的 read_file，支持相对、工作区内绝对和 file URL；拒绝越界、协议相对、控制字符、未知协议、凭据 URL、不可显示格式；HTTPS / HTTP 策略不变；原始自定义 HTML 不能冒充图片组件 | `reply-image-source.test.ts`、`reply-images.browser.test.tsx`、`markdown-transforms.test.ts`、`markdown.browser.test.tsx`；宿主原有文件边界见 `workspace-files.test.ts` | 已覆盖 |
| 图片读取失败可重试，文本或 SVG 内容不泄露为图片；没有工作区不发本地读请求；切换工作区时旧记录不能向新工作区读图片；增加图片上下文不破坏新建工作区消息/过程节点的原位交接 | `reply-images.browser.test.tsx`、`chat.browser.test.tsx` “never reads an old transcript's image…”；`app/new-workspace.browser.test.tsx` “same nodes” | 已覆盖 |
| 图片全屏 B：应用窗口内深色画布、首次适应且小图不放大、手动 25%–400%、fit 可低于 25%、拖动与键盘平移、缩放边界、视口跟随、失败重试、pointer cancel、强模态/Tab/Esc/焦点恢复及卸载清理 | `image-preview.browser.test.tsx`、`image-preview-layout.test.ts` | 已覆盖；13 个破坏检查全部检出 |
| Mermaid 已显示的同一张图随外观重画，不再被 Streamdown 忽略 mermaid 配置的缓存挡住；完整样例含 Mermaid、PlantUML 和数据图片，流式最终结果与一次性结果一致 | `markdown.browser.test.tsx` “redraws the same Mermaid…”；`streaming.browser.test.tsx` | 已覆盖 |
| 真实桌面端 CSP 下两种图表和工作区图片显示、越界拒绝、全屏缩放与 Esc 焦点恢复、明暗色；不发外部渲染请求，不把源码或图片路径写日志 | `apps/desktop/e2e/rendering.spec.ts` | 已覆盖；禁用 PlantUML 注册后测试先失败 |
| 在两个含图表和图片的会话间来回切换 20 次并打开/关闭全屏，不留 worker、额外 Blob URL 或脱离 DOM | `apps/desktop/e2e/rendering.leak.spec.ts` | 已覆盖；移除 Blob 回收后实际从 1 增到 3，测试失败，恢复后通过 |

最终验证：`pnpm check`、构建、全量单元 2980、UI 845、相关桌面端到端 6 项（`chat`、`new-workspace`、`rendering`、`rendering.leak`）通过。首次 UI 中的自身节点重建回归已修；既有 changes-pane“0.24 s”动画偶发失败单跑和全套重跑通过，未修改该测试或实现。父代理 13 个、图片预览子代理 13 个破坏检查全部检出；桌面端禁用 PlantUML 注册、禁用 Blob 回收也都实际见红。聚焦变异 `plantuml.ts`、`reply-image-source.ts`、`markdown-transforms.ts`、`image-preview-layout.ts` 为 98%（391 检出、1 个删循环体造成的真实死循环、8 个存活，共 400）；分项 100%、99.25%、93%、100%。8 个存活仅包括 remark 合法 AST 的 7 个形状/标识守卫放宽，以及非法 HTTP(S) 地址的 catch 返回删除后仍被本地协议守卫拒绝，逐项在源码解释，没有笼统屏蔽。尚未跑整套端到端、pi 契约、性能/压力/浸泡或打包安装。

### 回复文件定位与 JSON/CSV（2026-10-20，本轮补充）

用户选择 `reply-data-navigation-prototype.html`：JSON B“源码优先”、CSV A“就地看结果”；保留文件引用，暂不加 Diff 增强，图表/SVG/PDF 不进入本批。

| 行为 | 测试 | 状态 |
|---|---|---|
| 行内完整文件行引用、显式及引用式本地链接保留原地址；不把命令或行列形式误识别成文件；工作区边界、未知协议、控制字符、遍历拒绝；http(s)、mailto、标题锚点不变；没有工作区退回文字，点击前不读取 | `reply-file-target.test.ts`、`markdown-transforms.test.ts`、`reply-files.browser.test.tsx`；`chat.browser.test.tsx` “uses the real workspace opener…” | 已覆盖 |
| 同文件只开一个固定标签；行范围是一次性窗口状态，重复定位生效，旧请求不能确认新请求（含关闭/重开计数重置）；关闭清理；不影响其它文件的请求 | `state/workspace-views.test.ts` “file line navigation” | 已覆盖 |
| 读取和记忆滚动恢复后，跨 64 行组、换行长行仍按实际 DOM 定位；持续范围高亮；超出末行有说明；卸载取消原生 rAF，不留下滚动或确认动作 | `files/file-viewer.browser.test.tsx`；原生帧包装观察保留真实调度，卸载后再过一帧验证回调未运行 | 已覆盖 |
| JSON 先源码、点击才解析；只展开根层；顶层标量、大整数、负零、重复属性和顺序不丢；严格拒绝注释、尾逗号、非法词法及过深内容；限额失败完整回原文；不投影 `__proto__` 到普通对象 | `reply-data.test.ts`、`reply-data-block.browser.test.tsx` | 已覆盖 |
| CSV 完整后默认表格，首行作表头；BOM、CRLF/CR、逗号/换行/转义引号、空字段及原始次序；错误列数、引号、最后一行/单元格与恰好限额；公式/HTML 只作文本；64 KiB、200 行、50 列、5000 格有界 | 同上 | 已覆盖 |
| 未闭合根围栏、停止后的围栏、引用/列表围栏、短于开围栏的结束符、CR-only 整文解析中的字面反引号、伪造元数据不能提前解析；闭合后正常显示；其它代码仍用默认组件 | `markdown-transforms.test.ts` “data fence completion/source provenance”、`reply-files.browser.test.tsx`；真实 Markdown 接入，不只手工传 `isIncomplete` | 已覆盖；审查复现后修正 |
| 两种视图都复制完整原文，复制反馈通过 UiClock 且卸载取消；对比度测试显式设浅色初态再切深色，避免继承环境主题而漏检；主题变化不丢阅读选择，内容/语言变化重置；语义表格、键盘折叠和源码切换；字符串、数字、布尔值及行内文件引用的明暗 WCAG AA 对比度 ≥4.5 | `reply-data-block.browser.test.tsx`（复制模拟系统边界，不写用户剪贴板）；对比度用真实计算样式和独立 WCAG 公式，原字符串 3.89597、蓝色值 4.21358 实际见红后局部修复，不改全局 token | 已覆盖 |
| 实际桌面 CSP 下 JSON 默认源码、CSV 默认表格、精确大数/重复 key、原生文件标签 195–198 行定位及重复点击不重复开标签；明暗截图 | `apps/desktop/e2e/reply-data.spec.ts`；同时回归 `chat`、`new-workspace`、`rendering`、`rendering.leak` | 相关桌面 7 项通过；对比度修复后新桌面项重建重跑通过 |

本轮验证：`pnpm check`、构建通过；全量 UI 曾 877 项全过。最后扩充对比度覆盖后全量为 876 过、1 个既有 changes-pane 动画用例失败，该项随后单跑通过；本批相关 5 文件 77 项专项全部通过，不把最终全量描述为全绿；新增数据解析 51 个单元、组件 18 个浏览器用例，28 个数据模块、10 个文件定位/接入及 4 个原生帧回收/对比度破坏检查全部检出；另按存活变异逐个在隔离副本重放了 23 个数据解析缺口。串行全量单元 `pnpm test --no-file-parallelism` 3092 项通过。**默认并行单元两次均在未修改的宿主 `pi-config.test.ts`“queues several same-path saves…” 报 `config_conflict`；该文件 44 项单独通过，不能把默认并行全量宣称通过**。既有 changes-pane“0.24 s”动画在一次并行负载下失败，单独/完整 UI 重跑通过；不修改无关宿主或动画代码，也不删断言、加重试。工具端口占用导致的未启动运行不计测试通过；共享 63315 端口再次被占用后，另用 `/tmp/atrium-file-nav-vitest.mjs` 复用同一 UI Vite 配置、同一 46 个文件/877 用例及原 globalSetup，仅隔离 API 端口到 63316 和临时缓存，全套曾通过；最后一次全套的既有动画失败仍照实保留。没有为通过而跳用例或改断言。

变异结果按本批四文件单独计数，不把报告中其它缓存文件的 100% 计入本批：最终完整聚焦运行检出 903、真实忙循环超时 3、存活 41，共 944 个有效变异，95.66%（AST 89.85%、数据解析 97.03%、地址 98.39%、查看状态 98.80%）。数据解析 3 个超时均用独立 Node 忙循环实测确认。剩余存活逐项审阅：AST 的合法形状/范围与冗余结束检查、数据解析的 9 个等价/不可达保护和地址的冗余守卫均在源码解释，没有新增笼统变异屏蔽；查看状态仍有 3 个原有 `pinViewer` 的覆盖缺口，本批未修改该行为，不冒称已证明。尚未跑整套桌面、pi 契约、性能/压力/浸泡或打包安装；未提交。

### Opus 5.5 / Grok 4.7 双路审查修复（2026-10-20）

双路报告合并后修复 7 项，额外核实并修复生产路径复制多一个结尾换行；不把既有栅格 `data:` 支持当作新漏洞。均先通过真实入口见红，再最小修复。

| 行为 | 回归 | 状态 |
|---|---|---|
| gone/failed 不消费行请求；恢复长文本后实际 DOM 行可见并仅消费一次，后续重读不重滚；成功的空文本/非文本正常完成 | `files/file-viewer.browser.test.tsx` “keeps a pending line request…” 等新增 7 项 | 红 2 → 文件 32 项通过 |
| 链接图片的放大按钮与原目标链接/文件按钮并列；预览 portal 到 body，画布点击不激活原链接，关闭恢复焦点，目标仍可单独激活 | `reply-images.browser.test.tsx` “isolates a linked…”；`image-preview.browser.test.tsx` “keeps the modal outside…”；真实桌面 `rendering.spec.ts` 带链接图片样例和截图 | 浏览器红 2 → 通过；真实桌面通过 |
| 适应比例低于 25% 时键盘 `-` 不反向放大；按钮/键盘边界一致 | `image-preview.browser.test.tsx` “keeps very large…” | 实际几何见红后通过 |
| 行内 `IP/域名:端口` 不猜文件；冒号形式需带目录，裸文件使用 `#L` 或显式链接；行范围后再接列号拒绝，编码冒号文件名仍保留 | `reply-file-target.test.ts` 新增 8 项 | 红 2+5 → 文件 42 项通过 |
| 工作区分支/HEAD 对象更新不重读本地图，目录真正变化仍重新读取 | `chat.browser.test.tsx` “keeps local reply images loaded…” | 实际 readFile 调用数见红后通过 |
| 停止/引用/列表中的未闭合围栏统一说明“未闭合”，不误称仍在输出 | `reply-files.browser.test.tsx`、`reply-data-block.browser.test.tsx` | 生产 Markdown 先见红，再通过 |
| CSV/JSON 生产接入的源码/结构化视图复制一致：仅移除 mdast-to-hast 补的一个 LF，源码原有末尾空白不被 trim；CSV 默认表格不因补出的空行误报 | `reply-files.browser.test.tsx` “copies … source identically through production Markdown…” | 两种格式实际 clipboard 边界红 2 → 通过，不写用户剪贴板 |

验证：`pnpm check`、构建通过；串行全量单元 170 文件/3100 项通过；最终全量 UI 46 文件/890 项通过（隔离 API 端口 63316，同一 Vite 配置与 globalSetup，无跳过/改断言）。首轮 888 过/1 个既有右栏 0.24 s 动画失败，单独确认通过，仍如实保留记录。本轮未重新宣称默认并行单元稳定。相关桌面 7 项通过；随后把渲染场景换成真实带链接图片再通过。新样例暴露 Mermaid 离屏惰性绘制的测试前提：先滚入对应 Mermaid 块，再等待 SVG/主题色；没有延长超时、加重试或降低断言。11 项破坏检查全检出；其中端口误识别负对照精确恢复旧点/斜杠启发式，确实由 `127.0.0.1:8080` 新例检出，不借旧 `count:42` 用例充数。

仅改动的核心 `reply-file-target.ts` 聚焦变异：129 killed、3 survived、0 timeout，97.73%。3 个存活为范围存在的冗余守卫、file URL 冗余结尾锚点及前置短路已证明 suffix 存在后的防御式 optional access，源码逐处说明，没有新增笼统屏蔽；不把其它缓存文件合计 99.75% 算作本轮聚焦分数。

原生红绿灯遮挡仍待核实：临时真实桌面脚本尝试 `screencapture -l`，系统返回 `could not create image from window`，不能用不含原生按钮的 `window.screenshot` 冒充验证，暂未猜测性改标题栏。正式页面明暗、链接图片及全屏截图已查阅。未跑整套桌面、pi 契约、性能/压力/浸泡、打包安装；未提交、未合并。

### 试用后图表与预览细化 · 全选 B（2026-10-21）

原型 `prototype/ui` 的 `prototypes/diagram-controls-refinement-prototype.html` 用锁定版真实本地引擎生成样张；用户三项都选 B。PlantUML 默认中性轻框、无阴影/透明底、13px PingFang SC 和明暗调色，时序不再重复底部参与者；worker 追加默认皮肤但原文不变、显式参数优先，其它 start tag 不猜。Mermaid 工具行常显，B 顺序与 Tab 一致；使用锁定版 DOM 适配激活原生缩放动作、读取实际比例，不改 SVG 或重写几何。预览名称固定避让左侧 120px（包括窄窗口），用户截图已确认原先确实与原生红绿灯重叠。

| 行为 | 回归 | 状态 |
|---|---|---|
| 四种真实 PlantUML 图可画；B 明暗节点/字/细边、统一字体字号、无阴影、无底部重复参与者；用户显式颜色在两种外观都能覆盖；原来的预算/资源拒绝不变 | `plantuml.browser.test.ts` 13 项；`diagram-block.browser.test.tsx` 保留原源码切换与 Blob 图片路径 | 实际 worker 红 3 → 通过 |
| 皮肤位于 UML opener 后、原文前；BOM、CRLF/CR、大小写/缩进保留；不把注释或其它 start tag 猜成 UML；明暗完整默认参数与用户后续指令都保持 | `plantuml-theme.test.ts` 5 项 | 已覆盖，聚焦变异 51 killed / 0 survived / 0 timeout，100% |
| 固定工具行内真实比例、实际 SVG 几何变化、缩小/放大/适应；原文复制与源码切换；滚轮/边界 disabled、resize 后适应、主题重挂载与观察器释放；240px 嵌套列按钮保持至少 26px，不出界 | `mermaid-controls.browser.test.tsx` 6 项；`markdown.browser.test.tsx` 更新为检查新外层面与仅可见按钮 | 红 2 → 通过；原生 DOM 适配有真实渲染/行为约束 |
| 桌面与 360px 长名窗口都从 x≥120 开始，不与原生按钮区域重叠，仍保留缩放控件、焦点和 Esc | `image-preview.browser.test.tsx` 原 11 项增加真实 rect 断言 | 红 2 → 文件通过 |
| 一次性/逐字流式最终 DOM 仍完全一致，等待新增比例输出就绪，不删去控件差异；归一化只替换真正随机 Mermaid ID，不误替换新控件类名 | `streaming.browser.test.tsx` 2 项 | 新控件异步显示曾真实触发失败，完善就绪信号后通过 |
| 真实桌面 CSP 下 B 时序图、内联 Mermaid 缩放/适应改变实际图形、明暗重画、图片预览避让；切换会话/放大关闭仍回收资源 | `apps/desktop/e2e/rendering.spec.ts`、`rendering.leak.spec.ts` | 2 项通过，明暗与全屏截图已查阅；原生控件本身仍不能用页面截图代替 |

破坏检查在单独源码副本运行，避免故意改坏代码触发用户正在使用的 Vite HMR；依赖复用、API 63318、独立缓存，断言和源码与当前树相同。13 项有效负对照全部检出：主题接入/footbox/覆盖顺序，宽窄标题避让，原生开关/动作/比例/观察与释放、隐藏原生重复入口，以及成对撤回宽图 minmax/min-width 与窄工具行两处 wrap 兜底。最初单独撤回布局兜底之一是等价保护，改为精确恢复原缺陷；另证实引擎 dark 标记不会二次反转显式皮肤颜色，删除了不必要的额外标记处理而不是增加豁免。隔离副本 Stryker 首次因软链接根 node_modules 无法构建沙箱而未启动测试；回原树的 Stryker 自有沙箱完成，原始源文件 SHA 校验未变，仅新主题模块实际运行的 51 个变异均检出，不把旧缓存合计分数冒充本轮结果。

本分支集成 main 之前：`pnpm check`、构建通过；171 文件/3105 项串行单元通过，47 文件/900 项串行 UI 全过，未跳用例或弱化断言。并发单元负载下仍遇未修改的宿主 pi-config 队列例 `config_conflict`，单文件 44 项通过，安静串行全量通过。并行 UI 还出现过旧右栏 0.24 s 时序失败及不同文件的导入期 SyntaxError；冷缓存对照三文件 69 项通过，但全套并行仍有导入失败，未宣称已修复工具链并发。两个真实功能回归（外层面/新按钮清单、比例就绪）已按用户选的 B 完整更新原测试，不把它们当作已知不稳。机械设计扫描只报原有渐变文字/弹性状态提示，不改与这次图表无关的视觉。此段记录集成前本分支验证。

2026-10-21 后续集成 main `dbea812`（已停止消息编辑、空思考/空回复布局）：手工合并 `conversation-area.tsx` 时同时保留 session 身份门槛、无 session key 的图片上下文及 main 的编辑 store/回调/草稿与图片占位恢复；`turn-view.tsx` 与 main 无差异。新增组合断言：已停止且含本地图的回复进入编辑后图仍在，工作区 metadata 更新不重读、目录变化才重读。初版 fixture 误用 done，按规格没有编辑入口；修正为 stopped 后，正向两项通过，初次负对照结果作废，最终重新验证的三个接缝负对照（空编辑回调、去身份门槛、丢图片能力）均在隔离副本被对应断言检出。独立只读复核按 main 完整 diff 确认两边行为保留，无阻断。集成后 189 文件/3405 单元与宿主、47 文件/938 串行 UI、9 相关桌面全部通过，`pnpm check`/构建通过；桌面覆盖流式、空结束、编辑后重启恢复、新建工作区交接、图表/图片 CSP 与回收、JSON/CSV 及真实文件行定位。未跑整套桌面、全部 pi 契约、性能/压力/浸泡或打包安装，也未关闭用户正在用的开发进程。

## M1.11 自用中改（2026-10-22）

| 行为 | 测试 | 状态 |
|---|---|---|
| 回复里超过 640px 的表格在 640px 处收起：不在里面上下滚动，最下面 48px 渐隐，下面一行"还有 N 行"（N 是没有完整露出的行数）；这一行 13px `--text-dim`、30px 高，文字和第一列对齐，悬停底色比表格两边各宽 8px | `packages/ui/src/chat/markdown.browser.test.tsx` "folds a table taller than 640px there, fading out, with how many rows are left under it" | 已覆盖 |
| 点开后整张表铺在回复里、不渐隐，按钮变"收起"（`aria-expanded`）、sticky；再点收回 640px | 同上 "lays the whole table out in the reply once opened, and folds it again on 收起" | 已覆盖 |
| 展开后在表格中间"收起"贴着滚动区底边；收起后表格顶部在视野外时滚回表格顶部（只动最近的滚动区，滚动区比收起的表格矮时也滚回） | 同上 "keeps 收起 at the bottom of the view inside an opened table, and brings the table back into view on folding" | 已覆盖 |
| 不超过 640px 的表格不渐隐、没有这一行 | 同上 "leaves a table that fits as it is: no fade, no button" | 已覆盖 |
| 流式输出中长到 640px 以上同样收起，表头在视野里（不跟着滚到最新一行） | 同上 "folds a table still streaming in at 640px, its header in view" | 已覆盖 |

### 子对话列表的模型右对齐（2026-10-22）

用户指定：列表里每行的模型名都右对齐，而不是有第二行的对齐、没第二行的跟着名字靠左。根因是模型紧跟在名字块后面，位置由名字和 320px 的第二行决定。

| 行为 | 测试 | 状态 |
|---|---|---|
| 每个子对话行里模型的右边缘在同一竖线上：不管有没有第二行、名字多长、有没有位置或"+N"、时间文字多长（"刚刚"到"59 分钟前"）；位置和"+N"在名字后面，模型在右边一列、紧挨固定 50px 宽右对齐的时间 | `packages/ui/src/children/children.browser.test.tsx` "lines the models up in one column on the right, whatever else a row says" | 红 → 绿；两项 `pnpm break-check` 都检出（去掉 `ml-auto`、去掉时间的固定宽度）|

### catpaw-cli 图标（2026-10-22）

用户指定的绿色双猫爪原图替换 `catpaw-cli` 的首字母回退，仅改品牌映射与本地资源；不改名称、布局、其他 provider 或用户的 pi 扩展、认证和模型设置。对应 SPEC-0001“模型选择按钮”。

| 行为 | 测试 | 状态 |
|---|---|---|
| `catpaw-cli` 使用收到的 `catpaw.webp` 原图，名称不变；`sankuai-openai` 仍走原有回退 | `packages/ui/src/chat/model-choice.test.ts` “uses the supplied image only for catpaw-cli…” | 红 → 绿 |
| 明暗主题下，模型按钮与服务商列表加载同一张可解码的 512×512 图，分别保持 20×20 / 22×22，名称、当前选中状态不变 | `packages/ui/src/chat/model-picker.browser.test.tsx` “renders the supplied CatPaw image…” 两项 | 红 → 绿 |
| 实际桌面构建和 CSP 下加载本地打包图，模型切换后仍显示；明暗主题截图 | `apps/desktop/e2e/models.spec.ts` “renders the supplied CatPaw icon…”；仅隔离 faux provider，不请求内部模型 | 缺映射时先在 `Cfaux-1` 失败；恢复后四项模型面板桌面回归全部通过 |

验证：`pnpm check`、构建、串行全量单元 180 文件 / **3391** 项、相关桌面 `models.spec.ts` **4** 项通过；新增单元与浏览器用例在无映射时先红，相关两个文件合计 **48** 项通过。定向破坏检查 **5/5** 检出（删映射、错图、误改 `sankuai-openai`、仅按钮丢图、仅列表丢图），源码摘要核对已原样恢复。`model-choice.ts` 整个文件聚焦变异 **100%**（169 killed、0 survived、0 timeout，另 2 个原有忽略项；本工作树首次实跑，无缓存复用），达到 ≥80% 门槛。明暗真实桌面截图均已查阅；独立只读审查无阻断，按建议纠正 `ProviderIcon` 既有 JSDoc 的“所有资源均来自官网”说法，不改其渲染行为。

验证失败与边界：首次串行 UI 与单元放在同一父命令，单元通过后 UI 被父工具 240 秒总时限中断，没有完整 UI 结果；随后默认并行全套 UI 实跑 **971** 项，**970 过 / 1 失败**，失败是已登记的 `changes-pane.browser.test.tsx`“0.24 s”动画，单独运行该文件 **13** 项通过，未改代码、断言或加入重试。浏览器正向首次尝试还误用了不存在的 heading 查询，已按既有 tabpanel 语义更正，未改生产 DOM。全量单元输出一条既有日志流关闭时的 `EBADF` 提示，但 3391 项均通过，不将该提示称为已修复。未跑全部桌面 e2e、宿主集成、pi 契约、泄漏、性能/压力/浸泡或打包安装；本批不改变进程、定时器、订阅或认证链路。验收前阶段未提交、合并、推送或替换正在运行的 Atrium，保留分支与 worktree 待用户验收。

用户确认后的收尾（2026-10-22）：先同步 `main` 的 `4ecbc0e`，检查、3394 项单元、971 项 UI（`--maxWorkers=2`，没有改断言或加重试）全过，相关模型桌面 4 项及打包应用冒烟 1 项通过，包内 CatPaw 图片逐字节与用户原图一致。随后并行任务更新了 `main`，再同步 `dc216f6`，最终 `pnpm check`、180 文件 / **3414** 项串行单元、48 文件 / **971** 项 UI 全过；既有 `EBADF` 日志提示仍在。最终同步后未重跑打包或桌面测试，前面的包不冒充最新集成构建。用户随后明确收敛为**仅合并回 main，不要求安装**，因此不替换或重启 Atrium、不推送；安全清理本任务 worktree 与分支，不碰主工作区已有的 `plugin-model.md` 修改及原 `brave-otter` 的两篇调研笔记。

## `/` 命令与命令标签（M1.11，协议 13，2026-10-13）

SPEC-0001"M1.11 的 `/` 命令"。

| 行为 | 测试 | 状态 |
|---|---|---|
| skill 的标签（协议 13）：`Turn.user.command` 只收 `{ kind: "skill", name }` 或 `null`；pi 包认出 pi 展开的 `<skill name location>…</skill>`（有参数、没参数、只有空白、多行参数；不是这个格式的照原文），用户消息只留参数、记下 skill 名字；会话文件扫描时的兜底标题用参数的第一行，没有参数时用 skill 名字；宿主重建和实时的轮都带上 `command`，用 skill 开头的插话写成 `/skill:名字 参数`；界面：气泡开头是标签（22px，星光图标 14px、`--ctx-tools` 色，`skill:名字`），后面是参数，复制按钮、↑ 历史、提问导航、导出的 Markdown 都是 `/skill:名字 参数`（没有参数时只有 `/skill:名字`）；不是命令开头的消息没有标签 | `packages/protocol/src/envelope.test.ts` "Turn"、`packages/pi/src/history/skill-block.test.ts`、`log-entry.test.ts` "skill"、`packages/pi/src/sessions/session-files.test.ts` "skill"、`packages/host/src/transcript/projection.test.ts` "skill"、`session-transcript.test.ts` "skill"、`packages/ui/src/chat/composer-text.test.ts` "typedMessage"、"started with a skill"、`turn-layout.test.ts` "started with a skill"、`turn.browser.test.tsx` "started with a skill"、"typed as it is"、`chat.browser.test.tsx` "started with a skill" | 已覆盖 |
| 输入框的命令标签：`/` 列表按"扩展""模板""技能"分组（内置排最前），每行是按类型上色的图标、`/名字`、靠右的描述，↑ ↓ 按画出来的顺序走；选中（回车、Tab、点击）后开头的 `/词` 和一个空格变成标签，后面的文字留作参数、光标在标签后，不发出；标签后打 `/` 不再列命令，提示文字"接着写要说的话（可选）"；第一行从标签后 6px 开始，标签贴输入框左边、在第一行垂直居中；光标在最前面且没选中文字时退格，标签变回 `/名字`（和后面的文字隔一个空格），光标在名字后；标签记在草稿里（存进 localStorage，切走再回来还在；旧版存的草稿读作没有标签，标签格式不对的读作没有草稿）；发出时文字是 `/名字 参数`，后面接粘贴和文件；客户端的待发消息记下标签（prompt 和 steer，发给宿主的只有文字），待发气泡开头是标签、后面是参数 | `packages/ui/src/chat/composer-text.test.ts` "tagCommand"、"groupCommands"、"writtenCommand"、"starts with the chosen command"、`packages/ui/src/state/drafts.test.ts` "commands were tags"、"only a command"、`packages/ui/src/chat/composer.browser.test.tsx` "Composer's / commands"、"keeps a tag in the draft"、`packages/client/src/atrium-client.test.ts` "tag a message went with"、`packages/ui/src/chat/chat.browser.test.tsx` "sends a tagged message" | 已覆盖 |
| 内置命令 `/model`、`/thinking`、`/copy`：列表里排最前、组名"内置"，斜杠图标 `--tint` 色，`/名字` 后是方括号里的参数提示（没有参数的不显示），pi 的命令还没读到时先列内置命令、下面一行"正在读取命令…"，读到后接在后面；没有办法执行内置命令时不列、手打的 `/model` 照旧发给 pi；有内置标签时提示文字是"参数（可选）"（如"服务商/模型（可选）"），没有参数的是"回车执行"；回车或 ⌘回车时开头是内置命令（标签，或手打的 `/名字` 后面空格、换行或结束，名字连着别的字不算，其他类型的标签不算）就执行、不发消息，参数是名字后面去掉首尾空白的文字；执行了才清空输入框（执行期间改过就不清），没执行输入框不动；执行之后 ↑ 从最新的历史开始；输入框暂停时不执行；`/model` 不带参数打开模型列表、`/thinking` 不带参数打开推理强度框并聚焦（同 ⌘⇧I / ⌘⇧E；按钮出现时已有的请求不打开，同一个请求不重复打开，停止中不打开、恢复后也不补开）；`/model 服务商/模型` 按容器的模型列表找（id 里带 `/` 也行，列表不是就绪时先读一次），找不到说明"没有这个模型"，pi 拒绝时说明原因；`/thinking 档位` 只收 pi 的档位，当前模型不支持的说明"当前模型不支持这个档位"，不是档位的说明"没有这个档位"，不知道模型的档位时交给 pi；还没有会话时 `/model` 先建会话再换；`/copy` 复制最后一条已经结束的回复的 Markdown（运行中的那轮不算），标签栏"···"旁一行"已复制最后一条回复"，3 秒后消失（只在这个会话是当前标签时显示，新的提示顶掉旧的并重新计时）；还没有回复说明"还没有回复可复制"，剪贴板拒绝说明"复制失败"；失败都显示在输入框上方 | `packages/ui/src/chat/builtin-commands.test.ts`、`composer.browser.test.tsx` "Composer's built-in commands"、`model-picker.browser.test.tsx` "request"、`chat.browser.test.tsx` "ConversationArea's built-in commands"、`packages/ui/src/tabs/session-notice.browser.test.tsx`、`packages/ui/src/app/workbench.browser.test.tsx` "what a command just did" | 已覆盖 |
| 运行中（有运行、在停止或在压缩）、草稿时不能用的内置命令在列表里置灰（悬停说明原因，回车、点击都选不中），回车时在输入框上方说明原因、输入框不动 | `packages/ui/src/chat/builtin-commands.test.ts` "builtinBlocked"、`composer.browser.test.tsx` "greys during"、`chat.browser.test.tsx` "ConversationArea's /compact" "does not compact" | 已覆盖 |
| `/compact [要求]` · 宿主与 pi 包：`compact_session` 只在空闲时调 pi 的 `compact`（带上要求，没有就不带），运行中、pi 自己在压缩、在停止时应答 `session_busy`，pi 已退出时 `pi_unavailable`，草稿 `session_is_draft`，未知会话 `session_not_found`；压缩期间 `control.compacting` 为真（手动的和 pi 自己的都算，变化时推 `control_updated`），新消息进排队，完成或失败后出队；pi 的 "Nothing to compact…" 应答 `nothing_to_compact`、"Already compacted" 应答 `already_compacted`（按开头认），其余失败（含 pi 退出）`compact_failed`，日志只记会话 id 和失败类别，不是 pi 的错误原样抛出；录制的会话里经控制器压缩后照旧读条目、出提示条；路由；客户端（有要求才带 `instructions`） | `packages/pi/src/process/rejections.test.ts` "compactRejection"；`packages/host/src/sessions/session-controller.test.ts` "compacting on request"、"on a recorded session"；`session-manager.test.ts` "SessionManager compacting"；`server/router.test.ts` "run control"；`packages/client/src/atrium-client.test.ts` "compacting"；`packages/protocol/src/envelope.test.ts` | 已覆盖 |
| `/export` · pi 契约（1.1.0）：`export_html` 写到给的 `outputPath`、应答 `{path}`，不在当前目录留文件；会话文件还没写出来时报 "Nothing to export yet…" | `packages/pi/src/contract/session.pi.test.ts` "export-html" | 已覆盖 |
| `/export` · 宿主与客户端：`export_session` 让会话的 pi 写进系统临时目录下新建的 `atrium-export-*` 目录，读出后删掉整个目录（成功、超大、失败都删），应答 `{ html }`；运行中也能导出；正好 20 MB 照给，超过应答 `export_failed`（`too_large`）；pi 出错应答 `export_failed`（`failed`），日志只记会话 id 和失败类别，不是 pi 的错误原样抛出；pi 已退出 `pi_unavailable`；草稿 `session_is_draft`，未知会话 `session_not_found`；路由；客户端 | `packages/host/src/sessions/session-controller.test.ts` "exporting"、`session-manager.test.ts` "SessionManager exporting"、`server/router.test.ts` "run control"、`packages/client/src/atrium-client.test.ts` "exporting"、`packages/protocol/src/envelope.test.ts` | 已覆盖 |
| `/export` · 界面：列在 `/copy` 后面、描述"导出为 HTML"；执行时下载 `atrium-<会话 id>.html`（`text/html`），运行中也行，成功清空输入框；草稿说明"发出第一条消息后才能用"；`too_large` 说明"会话太大（超过 20 MB），没能导出"、`failed` 说明"没能导出：pi 出错了"，输入框不动、不下载。"···"菜单的"导出为 Markdown"下载 `atrium-<会话 id>.md`（`text/markdown`） | `packages/ui/src/chat/builtin-commands.test.ts`、`composer.browser.test.tsx` "lists the built-ins first"、`chat.browser.test.tsx` "ConversationArea's /export"、`packages/ui/src/app/workbench.browser.test.tsx` "as Markdown, downloading" | 已覆盖 |
| 分叉 · pi 契约（1.1.0）：RPC `fork {entryId}` 应答 `{text, cancelled}`，切在那条用户消息之前；`clone` 应答 `{cancelled}`，复制整条分支；新文件马上写在同一会话目录，保留条目 id，头部有 `parentSession` | `packages/pi/src/contract/session.pi.test.ts` "fork-clone" | 已覆盖 |
| 分叉 · 宿主与客户端：`fork_session(sessionId, turnId, name)` 用另起的 pi（`--session <文件>`，在会话的工作目录）分叉，最后一轮用 `clone`、其他轮 `fork` 到下一轮（跳过压缩等不是轮次的条目）的第一条用户消息；取新会话 id、设名字、停掉这个 pi；轮次开始时间抄到新会话（抄不了只记日志）；扫描后在同一容器打开成标签并切过去（客户端已去别处时不切）；整个分叉 30 秒为限，宿主关闭时中止；扩展取消、pi 出错、退出、超时、扫不到都应答 `fork_failed`，日志只记会话 id 和失败类别；运行中、正在发送、启动、压缩、停止、重启 `session_busy`，pi 已退出也能分叉；找不到这一轮或没对上条目 `turn_not_found`；草稿 `session_is_draft`，未知会话 `session_not_found`，已交接的拒绝；路由；客户端 | `packages/host/src/sessions/session-controller.test.ts` "fork point"、`session-forker.test.ts`、`session-manager.test.ts` "SessionManager forking"、`server/router.test.ts` "run control commands"、`packages/client/src/atrium-client.test.ts` "forking"、`packages/protocol/src/envelope.test.ts` | 已覆盖 |
| 分叉 · 界面：每一轮结束的回复下方、复制右边有"从这里分叉"，点了让宿主在这一轮后分叉，名字是会话标题（最多 250 字）加"（分叉）"；运行中、停止中、压缩中变淡（0.4）、禁止光标、悬停"运行中不能分叉"、点了没反应；失败在标签栏旁用危险色说明（`session_busy`"运行中不能分叉"、`turn_not_found`"没能分叉：找不到这一轮"、`fork_failed`"没能分叉：pi 出错了"、其他"没能分叉"），一直留着直到别的提示替换；再点分叉先清掉这个会话的提示，不动别的会话的 | `chat.browser.test.tsx` "ConversationArea's fork button"、`packages/ui/src/tabs/session-notice.browser.test.tsx` | 已覆盖 |
| `/compact [要求]` · 界面：列表最前、参数提示"要求"；执行时把名字后面的文字作为要求交给宿主（没有就不带），成功清空输入框；`nothing_to_compact`、`already_compacted`、`compact_failed` 在输入框上方说明（"对话还太短，不用压缩""刚压缩过，没有新内容""没能压缩：pi 出错了"）、输入框不动；压缩期间对话区底部一行"正在压缩上下文…"（压扁的小猫加扫光，2026-10-26 改），结束后消失 | `packages/ui/src/chat/builtin-commands.test.ts`、`composer.browser.test.tsx` "lists the built-ins first"、`chat.browser.test.tsx` "ConversationArea's /compact" | 已覆盖 |

## 文件与更改（M1.12，协议 14，2026-10-13）

| 行为 | 测试 | 状态 |
|---|---|---|
| 协议：`list_dir`、`read_file` 及其应答（项的种类、5000 项上限、四种图片、文本 1 MB 上限、路径 4096 字符上限），`path_invalid`、`read_failed` | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| `list_dir` 列文件、目录、链接，去掉 `.git` 和被 git 忽略的，已跟踪的照列；按目录自己的位置问 git；名字以 `:` 开头不当成 pathspec；不是 git 仓库或没有 git 时只去掉 `.git`；管道之类的不列；超过 5000 项列按名字的前 5000 项并说截断 | `packages/host/src/files/workspace-files.test.ts` "WorkspaceFiles.listDir" | 已覆盖 |
| `read_file`：文本和字节数；0 字节、不是 UTF-8 的是二进制；文本超过 1 MB、图片超过 10 MB 不读；四种图片按开头的字节认，不按名字；链接只报告是链接 | `workspace-files.test.ts` "WorkspaceFiles.readFile" | 已覆盖 |
| 路径检查：绝对路径、空段、`.`、`..`、NUL、经过链接的目录、目标是链接（列目录）、目录或管道或套接字（读文件）都是 `path_invalid`；不存在、在文件下面、工作区目录不在是 `path_not_found`；经链接添加的工作区照常读 | `workspace-files.test.ts` "refuses …"、"says nothing is there …"、"reads a workspace reached through a link …" | 已覆盖 |
| 读不了（权限、git 失败）是 `read_failed`，日志只记工作区 id 和错误类别，不记路径 | `workspace-files.test.ts` "fails as read_failed …" | 已覆盖 |
| git 的输入：写进去并结束；git 没读完就退出不算错 | `packages/host/src/platform/git.test.ts` "writes the input given to git …"、"is not thrown by git exiting …" | 已覆盖 |
| 两条命令经路由交给工作区文件；真实宿主、真实 git 上列目录、读文件，不经链接读到工作区外 | `packages/host/src/server/router.test.ts` "hands listing a directory …"；`packages/host/src/changes.host.test.ts` "workspace files over the WebSocket" | 已覆盖 |
| 客户端发 `list_dir`、`read_file` | `packages/client/src/atrium-client.test.ts` "a workspace's files" | 已覆盖 |
| 文件类型图标用 material-icon-theme 的：先整个文件名，再从最长的扩展名起（开头的点也算），不分大小写，认不出时是主题的通用文件图标；浅色外观先找浅色变体，但只在同一步里优先 | `packages/ui/src/files/file-icons.test.ts` | 已覆盖 |
| 图标从 UI 自己的文件加载；浅色、深色外观各显示对应的那张；只是装饰（`alt` 空、`aria-hidden`），按给的尺寸；两种外观同一张时只放一张 | `packages/ui/src/files/file-icon.browser.test.tsx` | 已覆盖 |
| 树：改动按目录建树，目录在前、按名字（码点）排，只有一个子目录的目录链并成一行，目录的行数是下面文件的和；改动标签按树的顺序排文件；列目录的项目录在前、名字里的数字按大小排；恢复展开的目录最多五层 | `packages/ui/src/files/trees.test.ts` | 已覆盖 |
| 每个工作区的视图（查看标签只在界面内存里）：预览标签被下一个单击替换、双击或在标签上双击固定、已打开的文件只显示不挪、改动标签只有一个；标签顺序（会话在前）；关掉显示的标签显示左边那个；要定位的文件只跳一次；选的改动模式；右栏选的标签（存储记不住时本次运行照样记得）；展开和折叠的路径按工作区（折叠再按模式）记在 localStorage | `packages/ui/src/state/workspace-views.test.ts` | 已覆盖 |
| 文件的事实：大小（B、KB、MB）、行数、太长的不上色；按文件名认语言（整个名字、扩展名、开头的点、不分大小写，Shiki 没有的名字和扩展名逐个对上，认不出不上色）；diff 的两侧拼成文本上色再按行对回，超过上限不上色 | `packages/ui/src/files/file-facts.test.ts`、`languages.test.ts`、`diff-sides.test.ts` | 已覆盖 |
| 右栏的标签：第一次知道工作区有没有改动时决定默认标签（有改动是"更改"并带文件数，没有是"文件"），之后改动来去不翻；选的标签按工作区记；关闭按钮，栏里 Esc 关闭、菜单开着时只关菜单；每个工作区的模式各自的 | `packages/ui/src/files/right-panel.browser.test.tsx` "RightPanel's tabs"、`chat/changes-pane.browser.test.tsx` "keeps each workspace's mode its own" | 已覆盖 |
| 右栏"更改"：改动的树（目录在前、单链一行、行数），折叠按工作区和模式记住，点文件打开改动标签并定位、行显示选中，菜单切到已提交并说明比较什么，"有没有未提交"变了回到默认，没有改动时说明并给另一模式，刷新时保留已显示的文件 | `right-panel.browser.test.tsx` "RightPanel's 更改" | 已覆盖 |
| 右栏"文件"：在目录名下列工作区的文件（目录在前、文件带大小），第一次展开时读、期间转圈，记住展开的、恢复最多五层，全部折叠，改动的文件带点（新文件绿色、目录没有），单击在预览标签打开、双击固定、行显示选中，目录列不全和读不了时说明；刷新、工作区里的运行结束、diff 再来时重读每个展开的目录（第一次来的 diff 和没有 diff 不算，运行开始和别处的运行结束不算） | `right-panel.browser.test.tsx` "RightPanel's 文件"、`packages/ui/src/files/use-diff.browser.test.tsx` | 已覆盖 |
| 查看标签 · 工作台：从树打开的文件在会话后面的预览标签里、占据对话的位置；下一个单击替换、双击固定（树里或标签栏）；点会话标签回到对话；关掉显示的标签显示左边那个；⌘1–9、⌘⇧[ ] 把查看标签和会话一起数，⌘W 关显示的那个；改动标签只有一个、悬停说明比较什么；宿主换了活动会话时显示会话，去别处再回来查看标签还在；标签栏开关叫"右栏"，对话里不可用并说明 | `packages/ui/src/app/workbench.browser.test.tsx` "Workbench viewer tabs (M1.12)"、"Workbench panes" | 已覆盖 |
| 胶囊和监听：右栏开着时胶囊把它转到"更改"，已是"更改"时才关；改动标签显示时监听 diff（右栏关着也是），它走了就停；查看标签占据整个对话区，显示会话时对话回来 | `chat.browser.test.tsx` "turns the open panel to 更改"、"watches the diff while the 改动 tab shows"、"gives the whole area to a viewer tab" | 已覆盖 |
| 文件标签：名字、目录、大小、行数，带行号，按外观上色；按 64 行一组画、只布局视野附近的、没画时每行按 20px 占位；只在要求时换行；宽图按标签宽度缩小、小图按原大小；二进制、太大、链接、不在了、读不了各自说明；有改动时显示改动数和去改动的入口；运行结束和它的 diff 变了时重读，读到同样的保留滚动位置 | `packages/ui/src/files/file-viewer.browser.test.tsx` | 已覆盖（读到同样内容时跳过重画只是渲染上的优化，未单独测） |
| 改动标签：按树的顺序列每个文件，顶上是模式、文件数和总行数；带行号的行和 hunk 头、重命名、二进制、太大；文件头滚动时贴在顶上；按语言上色；单个和全部折叠，按模式记住、切模式时显示各自的；全部展开；定位一次、展开它、文件头闪一下（最后一个文件也能到顶；它比标签高时滚到底就是它的最后一行，不多留空白，2026-10-14），离开时停掉闪动；只在要求时换行；不换行时每个文件各自横向滚，文件头和别的文件不动，行的底色铺到这个文件最长的一行（2026-10-14）；已提交模式的名字和没有改动 | `packages/ui/src/files/diff-viewer.browser.test.tsx` | 已覆盖 |
| 端到端：真实宿主里改文件后右栏"更改"、改动标签，"文件"里打开文件标签并从它去改动 | `apps/desktop/e2e/changes.spec.ts` | 已覆盖 |
| 性能：改动标签显示约 2 万行 diff 时折叠、展开左栏，渲染主线程上每段 ≤ 4 毫秒；在会话和它之间切换 ≤ 100 毫秒（三次的中位数）；用滚轮滚到底每段 ≤ 4 毫秒（三遍的中位数） | `apps/desktop/e2e/changes.perf.spec.ts` | 已覆盖 |
| 泄漏：打开两个文件标签和改动标签（都上了色）再用 ⌘W 关掉，来回 15 轮不留脱离的 DOM | `apps/desktop/e2e/viewers.leak.spec.ts` | 已覆盖 |

## 上下文细分与套餐用量（M1.13，协议 16，2026-10-15）

| 行为 | 测试 | 状态 |
|---|---|---|
| 系统消息的分段按块拆开：`project_context` 按每个 `<project_instructions path>` 块分到文件，`skills` 按每个 `<skill>` 块分到 skill（名字解开 XML 转义），各是整块的字数；没有块时为空，别的分段不拆；条目里记下每条系统消息设的分段的块 | `packages/pi/src/history/prompt-sections.test.ts`、`log-entry.test.ts` "and their pieces" | 已覆盖 |
| 回放系统消息后分到系统提示词（`content` 和 pi 自己的分段）、记忆文件、Skills、内置工具（含 `codemode`、`tool_search`）、MCP 工具（`mcp__服务器__工具` 按服务器、带工具数，`mcp_servers` 只算合计）、扩展（其余工具和分段）；名字像 MCP 但没有工具名的算扩展；分段被替换或删掉时它的块跟着换掉；从最近存了提示词的压缩开始；各列表按 token 从多到少、再按名字；和 pi 对录下的会话的估算一致 | `packages/pi/src/history/system-prompt.test.ts` | 已覆盖 |
| 自动压缩预留：读 pi 全局设置，没有文件或没写时 16384，模型覆盖优先、再是 `reserveTokens`；`enabled` 按 pi 的读法为假（`false`、`0`、空字符串）时是"关"，`null`、没写、真值照常；pi 不收的值（非 JSON、负数、小数、字符串、`null`，普通设置不对时哪怕模型自己的对，模型的设置不是对象，关着也算）为未知 | `packages/pi/src/env/compaction.test.ts` | 已覆盖 |
| 指标：每次读统计时一起读预留（读失败为未知）；按会话当前的模型读，换模型后按新的；家目录下的记忆文件写成 `~/…`（`/home/meow` 不算 `/home/me` 下）；收到套餐用量时推出去，没变不推 | `packages/host/src/sessions/session-metrics.test.ts`、`session-controller.test.ts` "compaction reserve" | 已覆盖 |
| 经 Claude Code 的模型（`claude-bridge`，2026-10-16，2026-10-17 审查后补）：系统提示词是 15,300 字符加 `content` 和去掉外框的 `addendum`（不足外框长度时算 0），开场自定义（`tools`、`rules`、`docs` 缺任何一段，含会话中途换成自定义开场、扩展另加 `docs`）时加 `preamble`，不算 pi 默认的开场、`tools`、`rules`、`docs`、`cwd`；其余各段和别的服务商不变；跟踪器给出的指标总按会话当前模型的服务商分，起始的条目也是，换模型后推出去，没有条目或分法没变时不推；控制器换到 `claude-bridge` 后卡片的系统提示词跟着变，pi 重新启动带回 `claude-bridge` 时开头的快照就是新的分法 | `packages/pi/src/history/system-prompt.test.ts` "through Claude Code"；`session-metrics.test.ts` "provider of the session's model"、"new model before any entries"；`session-controller.test.ts` "through Claude Code"、"a new pi brings" | 已覆盖 |
| 协议：`context.parts`、`context.reserve`、`metrics.plan` 的格式；预留是数、`"off"` 或 `null`；百分比超过 100、超过 8 个窗口、不认识的服务商、缺预留的、预留是别的字的都拒绝 | `packages/protocol/src/envelope.test.ts` | 已覆盖（`metrics.plan` 在 M1.14 去掉，见"套餐总览"一节） |
| 上下文卡片：宽 340px；对话消息在先（总量减其余各段，不小于 0），没有 token 的段不显示；每段色块、名称、个数、"~N"、占窗口一位小数的百分比；预留斜纹行、剩余空间行；"距自动压缩还剩 ~N"，自动压缩关着时写"自动压缩已关"、没有预留行，读不到设置时写"距自动压缩还剩 —"；记忆文件、工具、MCP 的行点了展开、再点收起，各自独立；"压缩会话"按了同 `/compact`，不能压缩时不可用；卡片和这一组之间的空隙属于卡片；没有分段时只显示总量 | `packages/ui/src/chat/status-bar.browser.test.tsx`、`status-figures.test.ts` "contextRows"、"windowShare" | 已覆盖（`/compact` 本身见"`/` 命令"一节） |
| 套餐用量的解析：ChatGPT 的 `wham/usage` 读套餐名和两个窗口（重置时间秒转毫秒，没有百分比的窗口不要，一个窗口都没有不算）；Claude 的 `api/oauth/usage` 有 `limits[]` 时读 `session`、`weekly_all`、每个模型的 `weekly_scoped`（别的种类、没有百分比、没有模型名的不要，解析不了的重置时间为未知），没有时读旧的四个窗口里不为 `null` 的 | `packages/pi/src/plan/plan.test.ts` "codexUsage"、"claudeUsage" | 已覆盖 |
| 宿主校验扩展报的用量：服务商只能是这两家，失败是小写短代码，最多 8 个窗口，百分比夹到 0–100，长度、时间不合格的（含超出安全整数的）为未知，模型名、套餐名截断；其余都不要；`atrium-plan` 只认扩展注册的，不进 `/` 菜单 | `plan.test.ts` "readPlanReport"、"isPlanQuery"；`packages/pi/src/catalog/commands.test.ts` | 已覆盖 |
| 扩展查用量：ChatGPT 发往登录地址根下的 `/wham/usage`，带 pi 的头、`originator: pi`、bearer 和账户 id；Claude 只在订阅登录时发往 `/api/oauth/usage`，带 OAuth beta，API key 的报 `no_login`；没登录、查凭据失败、连不上、HTTP 错误、不是 JSON、不是用量各报原因代码，不带服务器原文；不跟随重定向（算连不上，Fast 查模型列表也是）；Claude 按模型分的窗口多于 8 个时只报前 8 个；不认识的服务商不报；扩展的接口和 pi 的对得上，和 Fast 合成一个入口 | `packages/pi/src/plan/extension.test.ts`、`plan.test.ts` "first eight windows"、`packages/pi/src/fast/extension.test.ts` "no redirect" | 已覆盖 |
| 经会话的 pi 查：pi 列出扩展的 `atrium-plan` 才发，只要这个服务商的、合格的报告，pi 拒绝时也停止监听；真实 pi 加载合成的扩展，列出两个内部命令，查询不进对话、在应答前报出用量 | `packages/pi/src/plan/query.test.ts`；契约：`packages/pi/src/contract/plan.pi.test.ts`（夹具 `pi-1.1.0/plan.jsonl`） | 已覆盖 |
| 宿主的用量服务：同一服务商每分钟最多问一次、一次只问一个，各服务商分开；`no_login` 立即丢掉，其余失败满 10 分钟才丢，只记服务商和代码；查不到报告、超时或查询出错同样满 10 分钟才丢，只记 pi 的命令和原因；只在变化时通知，取消订阅后不再通知 | `packages/host/src/sessions/plan-usage.test.ts` | 已覆盖（M1.14 改成全宿主一份，见"套餐总览"一节） |
| 会话跟随自己模型的服务商：pi 启动后和每次运行结束后问，换模型后跟到另一家或不跟，关闭时取消订阅、关闭途中 pi 最后的事件不再订阅，宿主停掉后重新启动时再跟；没有服务时什么都不显示 | `packages/host/src/sessions/session-controller.test.ts` "plan usage" | M1.14 改，见"套餐总览"一节 |
| 状态栏"套餐"：只在有用量时出现，显示用得最多的窗口，≥ 80% 变橙；卡片宽 300px，标题"ChatGPT Plus 用量"和查到的时间，每个窗口的名称、重置时间、百分比；没有新用量时查到的时间和重置时间每分钟随时钟走，卡片卸下时停；能在调节面板里关掉；窗口名、重置时间（一天内写几小时几分后，再远写周几几点）、查到的时间的写法 | `packages/ui/src/chat/status-bar.browser.test.tsx` "StatusBar's plan group"；`status-figures.test.ts` "the plan's figures" | 已覆盖（卡片在 M1.14 改成按服务商分段，见"套餐总览"一节） |
| 端到端：ChatGPT 订阅的会话发完消息后状态栏出现"套餐 82%"，卡片列出两个窗口；用量是 pi 的登录经扩展查的，pi 启动时问了一次、之后一分钟内的运行没再问 | `apps/desktop/e2e/plan.spec.ts` | 已覆盖（M1.14 加了设置里的一组，见"套餐总览"一节） |

## 套餐总览（M1.14，协议 17，2026-10-16）

| 行为 | 测试 | 状态 |
|---|---|---|
| Grok 用量的解析：`config.creditUsagePercent` 和 `currentPeriod` 读成一个窗口（长度 = `end − start`，`end` 是重置时间，带微秒和 `+00:00` 的时间也认），`productUsage` 每项一个 `parts`（没有百分比按 0，没有名字的不要，最多 16 个）；有周期没有总百分比时按 0；周期解析不了、结束不晚于开始时长度为未知；两样都没有的不是用量 | `packages/pi/src/plan/plan.test.ts` "grokUsage" | 已覆盖 |
| 宿主校验扩展报的 `parts`：没报为空，名字截到 64 个字、百分比夹到 0–100，正好 16 个收；不是数组、多于 16 个、有一项没名字或百分比不是数的，整份不要；`xai` 是 Atrium 查的服务商 | `plan.test.ts` "readPlanReport"、"isPlanQuery, isPlanProvider" | 已覆盖 |
| 扩展查 Grok：只在订阅登录时发往写死的 `cli-chat-proxy.grok.com/v1/billing?format=credits`（ADR-0011 允许的唯一地址），只带 bearer、`x-xai-token-auth: xai-grok-cli` 和 `accept`，不带 pi 给 `api.x.ai` 的头；API key 报 `no_login`；连不上、HTTP 错误、不是用量各报原因代码 | `packages/pi/src/plan/extension.test.ts` "Grok" | 已覆盖 |
| 真实 pi：API key 登录的 `xai` 查询报 `no_login`、不发请求；ChatGPT 的报告带空的 `parts` | 契约：`packages/pi/src/contract/plan.pi.test.ts`（夹具 `pi-1.1.0/plan-xai-key.jsonl`、`plan.jsonl`） | 已覆盖 |
| 宿主的用量服务全宿主一份：按 `openai-codex`、`anthropic`、`xai` 的顺序列出，不管谁先查到；监听者每次听到所有服务商的；同一服务商连续同样的失败只记一次日志，换了原因或中间查到过用量再记，各服务商分开；没查到过的服务商报 `no_login` 不算变化 | `packages/host/src/sessions/plan-usage.test.ts` | 已覆盖 |
| 会话问所有订阅：pi 启动后和每次运行结束后经自己的 pi 问三家，不管当前模型，换模型不问，没有模型也问；宿主停掉后重新启动再问；停 pi 途中 pi 最后的事件不再问；会话指标里没有 `plan` | `packages/host/src/sessions/session-controller.test.ts` "plan usage" | 已覆盖 |
| 推给所有连接：每个连接握手后紧跟 `welcome` 推一次 `plans_updated`（新宿主是空列表）；之后变了就推 | `packages/host/src/server/ws-server.host.test.ts` "right after its welcome"、`packages/host/src/chat.host.test.ts`（握手等到它） | 已覆盖 |
| 协议 17：`plans_updated` 的格式（三家、空列表、带产品的窗口）；超过 100%、9 个窗口、不认识的服务商、4 份、窗口缺 `parts`、产品超过 100%、没名字、名字超过 64 个字、17 个产品都拒绝；会话指标再带 `plan` 拒绝 | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| 客户端：推来之前是空列表，之后每次整份换，格式不对的不要；不为它发命令 | `packages/client/src/atrium-client.test.ts` "plans" | 已覆盖 |
| 状态栏"套餐"：有任何一家就出现；摘要取当前模型那家用得最多的窗口，≥ 80% 变橙；当前模型不是查到的订阅时只写"套餐"、不变色；那家没有窗口时写"套餐 —"；卡片标题"套餐用量"，每家一段（当前那家在前、标"当前"），Grok 的每周下面列各产品（名字拆开、没有自己的进度条）；时间每分钟随时钟走；调节面板的说明 | `packages/ui/src/chat/status-bar.browser.test.tsx` "StatusBar's plan group"；`status-figures.test.ts` "names a subscription"、"lists it first"、"run-together name"、"the status bar's groups" | 已覆盖 |
| 设置 · 模型与账户的"套餐用量"：在订阅登录和 API Key 之间，每家一段、不标"当前"；还没有时写怎么来的；Atrium 加载不了 pi 的登录时也显示 | `packages/ui/src/settings/accounts-section.browser.test.tsx` "usage" | 已覆盖 |
| Claude 的用量从回复读（ADR-0012）：扩展的 `after_provider_response` 钩子在模型是 `claude-bridge` 或 `anthropic` 时把 `anthropic-ratelimit-unified-5h/7d-utilization`（0–1）和 `-reset`（秒）报成 `atrium-plan-reply`；名字不分大小写，百分比留两位，没有利用率或不是数的窗口不要，两个都没有不报，别的服务商、没有模型的回复不报；钩子不改回复 | `packages/pi/src/plan/extension.test.ts` "reply hook"；`plan.test.ts` "replyUsage" | 已覆盖 |
| 宿主收回复带来的用量：只认 `atrium-plan-reply` 里合格的用量（失败、别的状态键、不是 JSON 的不要），这个 pi 和重新启动后的 pi 都听；服务里不受每分钟一次的限制；回复带来的遇到 `no_login` 满 10 分钟才丢，查询查到的仍立即丢 | `plan.test.ts` "planReplyOf"；`packages/host/src/sessions/session-controller.test.ts` "replies bring"；`plan-usage.test.ts` "a reply brought" | 已覆盖 |
| 三方审查后补（2026-10-17）：Grok 的总百分比或产品百分比在却不是数时整份不是用量（不当 0）；回复报告只收 `anthropic`、没有套餐名、没有产品拆分的；回复只替换长度相同、不分模型的窗口，按模型的窗口留着、没有的加在后面；回复不清上一次的失败，`no_login` 夹着回复也只记一次；查询出错按 pi 的命令和原因和扩展的失败一起去重 | `packages/pi/src/plan/plan.test.ts` "not a number"、"planReplyOf"；`packages/host/src/sessions/plan-usage.test.ts` "merges a reply"、"once in a row though replies"、"a query that failed once in a row" | 已覆盖 |
| 服务商按订阅归并：`claude-bridge` 算 Claude、`openai` 算 ChatGPT，其余是自己（`constructor` 之类的名字也不误认）；摘要、排序和"当前"都按归并后的 | `packages/ui/src/chat/status-figures.test.ts` "claude-bridge's models"；`status-bar.browser.test.tsx` "through claude-bridge" | 已覆盖 |
| 端到端：ChatGPT 订阅的会话运行后，状态栏卡片是"套餐用量"加标了"当前"的 ChatGPT 一段；设置 · 模型与账户里同一段、不标"当前"；用量仍只问了一次 | `apps/desktop/e2e/plan.spec.ts` | 已覆盖 |

## 子对话与子代理（M1.15，2026-10-17）

| 行为 | 测试 | 状态 |
|---|---|---|
| pi 契约（1.1.0）：扩展在工具里用 `setStatus` 问宿主、挂着等，运行中的隐藏命令回答它，应答 `handled`，不进会话文件、模型看不到、不另开运行（SPEC-0002 通道"乙"） | `packages/pi/src/contract/subagent.pi.test.ts` "agent-channel" | 已覆盖 |
| pi 契约：空闲时 `triggerTurn` 的自定义消息开一次运行，模型看到 user 消息；会话文件等助手回复才写出 | 同上 "custom-idle" | 已覆盖 |
| pi 契约：运行中的自定义 steer 不列在 `queue_update` 里，工具这一批跑完后在同一次运行里送到；`clear_queue` 清掉它、不列出它 | 同上 "custom-steer"、"custom-clear" | 已覆盖 |
| pi 契约：`--tools` 只声明列出的工具（扩展的也要写），`--exclude-tools` 去掉列出的；去掉的调不到、不执行 | 同上 "tools-allow"、"tools-exclude" | 已覆盖 |
| pi 契约：`tool_call` 钩子拦下的调用不执行，模型得到报错的工具结果，正文是钩子的理由 | 同上 "tool-block" | 已覆盖 |
| pi 契约：工具里 `createBranchedSession` 切在当前叶子，写进给的目录、条目 id 不变、父会话照跑；另一个目录 `--fork --session-id` 起的 pi 在 `get_state` 前写出文件、`cwd` 是新目录；送自定义消息后没配对的调用补 "No result provided" | 同上 "agent-fork" | 已覆盖 |
| faux 记下每次请求声明的工具和给模型的消息 | `packages/testkit/src/faux/extension.ts`（经上面的契约测试） | 已覆盖 |
| 第一步 · 协议 18：`SessionSummary.parent`、`create_session.child`、`fork_session.child`、`detach_session`、`metrics.children`、`note` 提示和两个新错误码的格式，超长或缺字段的拒绝 | `packages/protocol/src/envelope.test.ts` | 已覆盖 |
| 第一步 · 隐藏命令：参数是一个 base64url 的 JSON 词，读不出的当没有；`/atrium-agent note` 把提示写成 `atrium-agent` 自定义消息、不开运行，别的动作和读不出的提示什么都不做；提示以 Atrium 而不是用户的口吻说新路径和旧路径属于谁；命令列表里不出现 `atrium-agent` | `packages/pi/src/agent/agent.test.ts`；`packages/pi/src/catalog/commands.test.ts` "child conversations' command"；`packages/pi/src/plan/extension.test.ts` "child conversations' command" | 已覆盖 |
| 第一步 · 真实 pi：空闲时 `/atrium-agent note` 立即写进会话文件，下一次请求带上它 | 契约：`packages/pi/src/contract/agent-note.pi.test.ts`（夹具 `pi-1.1.0/agent-note.jsonl`） | 已覆盖 |
| 第一步 · 提示进对话记录：pi 写出时报 `note_added`，消息中途也不打断消息；会话文件里读成 `note`，在树里的位置不变；别的扩展的自定义消息、读不出的提示不显示；宿主放在它跟着的那一轮后面成一条提示，读到后重读条目；界面写"在新的 worktree 里继续：新路径（之前的路径属于 旧路径）" | `packages/pi/src/events/translate.test.ts` "Atrium's note"；`packages/pi/src/history/log-entry.test.ts` "Atrium's note"、"another extension's custom message"；`packages/host/src/transcript/projection.test.ts` "Atrium's note"；`session-controller.test.ts` "once pi wrote Atrium's note"；`packages/ui/src/chat/turn-layout.test.ts` "SPEC-0002" | 已覆盖 |
| 第一步 · 子对话的用量：按 pi 的算法（回复、工具结果、压缩、分支摘要、usage 条目）累加，跳过基线及以前，基线不在文件里时不算；增量读，只算写完的行，文件变短重读；读不了时保持原值；`lastEntryId` 跳过头、坏行和没写完的行 | `packages/pi/src/stats/file-usage.test.ts` | 已覆盖 |
| 第一步 · 记录与树：索引记下父会话、名字和基线，pi 有名字后用 pi 的；脱离只去掉父会话；子、孙、祖先的列法遇环停下；归档计划：同容器的后代一起归档、别处的分支脱离、已归档的跳过 | `packages/host/src/sessions/session-catalog.test.ts` "child conversation"；`packages/host/src/sessions/child-tree.test.ts` | 已覆盖 |
| 第一步 · 子对话合计：每个后代（归档的也算，2026-10-17 审查后改）基线之后的用量相加，没有时为 `null`；子对话自己的指标一变就刷新上面每一层，刷新中又来的再跑一次；关闭后指标里还在 | `packages/host/src/sessions/children-usage.test.ts`；`session-metrics.test.ts` "child conversations"；`session-manager.test.ts` "children figures"、"usage its children produced" | 已覆盖 |
| 第一步 · 新 worktree：从工作区当前的提交（分离 HEAD 也行）开，分支整理成 `atrium/…`，占用时 `-2`…`-9`，都占了拒绝；名字剩不到 2 个字时 `child-` 加随机词；普通文件夹的项目和不认识的工作区拒绝 | `packages/host/src/workspaces/worktree-creator.test.ts` "createFrom" | 已覆盖 |
| 第一步 · 宿主开子对话：空子对话挂在父会话下、pi 写文件前就有名字、首次启动带 `--name`；不同容器、草稿、已归档或不认识的父会话拒绝；新 worktree 里开空子对话；不能建 worktree 的宿主拒绝；从某轮分叉到同一工作区只算复制之后的；分叉到新 worktree：先用临时 pi 写到带标记的临时目录，子对话的 pi 用 `--fork` 在新目录起，收到提示；停止时残留的、自己标记过的临时目录才清 | `packages/host/src/sessions/session-manager.test.ts` "SessionManager child conversations (SPEC-0002)" | 已覆盖 |
| 第一步 · 分叉到新 worktree 后子对话的 pi 没起来：会话文件没写出的忘掉、应答 `fork_failed`；已写出的留在父会话下、带名字，`fork_failed` 带它的 `sessionId`，界面说"子对话没有开好"；临时目录都删掉 | `session-manager.test.ts` "whose pi did not start"；`packages/ui/src/children/new-child.test.ts` | 已覆盖 |
| 第一步 · 脱离与归档连带：脱离保留它自己的子对话；归档会话、对话、工作区时同容器的后代一起归档，别处的脱离 | 同上 "detaches a child"、"archives a session with its children"、"workspace is archived"、"archives a chat" | 已覆盖 |
| 第一步 · `/atrium-` 开头的消息、插话、排队修改报 `command_reserved`；界面写"以 /atrium- 开头的消息留给 Atrium 自己用，没有发出" | `session-manager.test.ts` "opens with /atrium-"；`packages/ui/src/chat/chat.browser.test.tsx` "refused /atrium- message" | 已覆盖 |
| 第一步 · 草稿子对话能改名：名字写进记录（同名、不认识的会话不写），它的 pi 起了的再发 `set_session_name`，没起的不起；"重命名"对草稿子对话可用 | `session-catalog.test.ts` "names a recorded session"；`session-manager.test.ts` "names a draft child"；`workbench.browser.test.tsx` "renames a draft child conversation" | 已覆盖 |
| 第一步 · 新建工作区的第一条消息以 `/atrium-` 开头时，界面在建 worktree 之前就报 `command_reserved`，消息放回输入框，一个命令都不发 | `packages/ui/src/state/new-workspace.test.ts` "refuses a message opening with /atrium-" | 已覆盖 |
| 第一步 · 路由与客户端：`detach_session`、带 `child` 的 `create_session` 和 `fork_session` | `packages/host/src/server/router.test.ts`；`packages/client/src/atrium-client.test.ts` "child conversations" | 已覆盖 |
| 第一步 · 界面规则：子对话只列直接的、没归档的、最近更新的在前；行状态取整个子树的最高（含运行中）；标签页状态被后代的待回答、待登录、出错抬高，运行中不抬；面包屑到顶层，遇环、缺父会话停下，超过三层中间折成"…" | `packages/ui/src/children/children.test.ts` | 已覆盖 |
| 第一步 · 子对话条和弹出框：没有子对话不显示；"子对话 N"加各状态的图标和数；列表和内容一样宽、最近更新的在前，写位置、"已在终端中继续"、"+N"、模型和思考程度、时间；模型的右边缘每行对齐（位置、"+N"、时间文字多长都一样）；点行打开，菜单脱离、归档，失败在标签栏旁说 | `packages/ui/src/children/children.browser.test.tsx` "ChildCapsule"（"lines the models up in one column on the right"）；`chat.browser.test.tsx` "children's capsule" | 已覆盖 |
| 第一步 · 开子对话的对话框：回复下的"↳"带上到这一轮的对话（运行中变淡、不能点）；"+ 新建"菜单开空的（草稿下不能点）；名字默认"子对话 N"；工作区的会话可选新 worktree 和分支，对话的只有"当前对话"；失败留在对话框里说；Esc 关 | `children.browser.test.tsx` "NewChildDialog"；`chat.browser.test.tsx` "asks for a child"；`packages/ui/src/app/workbench.browser.test.tsx` "+ menu"、"under a draft" | 已覆盖 |
| 第一步 · 标签、面包屑、历史、收件箱：子对话标签有"↳"，父标签被后代抬高；标签栏下的面包屑点名字回去；历史行"↳ 名字"、悬停"属于「父对话」"；收件箱行写"位置 · 父对话 › 子对话" | `workbench.browser.test.tsx` "Workbench child conversations (SPEC-0002)"；`children.browser.test.tsx` "Breadcrumb" | 已覆盖 |
| 第一步 · 端到端：真实宿主和 pi 下从回复开子对话，带上之前的对话，标签有"↳"、面包屑点回主对话；子对话回复后主对话的子对话条列出它，token 卡片有"含子对话"；开到新 worktree：建出 `atrium/…` 分支和工作区并切过去，提示行写新旧路径，子对话接着能回复；从"+ 新建"开空的子对话；归档主对话时同工作区的子对话一起归档，新 worktree 里的脱离（没有"↳"和面包屑） | `apps/desktop/e2e/children.spec.ts` | 已覆盖 |
| 第一步 · 泄漏：宿主开、归档子对话 200 次后没有留下 pi、计时器、句柄；界面里开子对话、从子对话条归档 10 次后没有分离的 DOM | `packages/host/src/sessions.leak.test.ts` "child conversation 200 times"；`apps/desktop/e2e/sessions.leak.spec.ts` "@leak opening a child conversation" | 已覆盖 |
| 第一步 · 状态栏：token 和费用卡片里"含子对话"是自己的加子对话的，自己的不知道时只算子对话的 | `packages/ui/src/chat/status-bar.browser.test.tsx` "child conversations" | 已覆盖 |

## M1.15 第一步三方审查后补（2026-10-17）

| 行为 | 测试 | 状态 |
|---|---|---|
| 同一个会话文件同时有两个读取（两层祖先一起刷新）时只算一次，之后接着增量读也对 | `packages/pi/src/stats/file-usage.test.ts` "two read it at the same time" | 已覆盖 |
| 子对话合计：token 取整；关闭时停掉读取、之后不再刷新；脱离时忘掉那个文件；一次刷新刚结束时又要的刷新照样再跑 | `packages/host/src/sessions/children-usage.test.ts` "whole tokens"、"stops its reads once closed"、"just as one ended" | 已覆盖 |
| 用量文件里的坏数据当作没有：费用或消息不是对象、`message` 为 `null`、`1e999`、不是对象的行、没写完但是合法 JSON 的行 | `file-usage.test.ts` "not numbers"、"lastEntryId" | 已覆盖 |
| 开子对话途中父会话被归档：同容器分叉出的跟着归档、应答 `session_not_found`；新 worktree 里的脱离；父会话所在工作区正在归档时等它做完再处理；正在归档或已归档的会话不能脱离 | `session-manager.test.ts` "while the fork ran"、"while the worktree was made"、"waits for an archiving"、"refuses to detach" | 已覆盖 |
| 归档计划穿过已归档的会话，下面还没归档的同容器会话一起归档；脱离的子对话恢复工作区后仍是脱离的；删 worktree 失败时不调 `archiveWorkspace`，也就不脱离 | `child-tree.test.ts` "goes through an archived one"；`session-manager.test.ts` "leaves it detached once restored"；`workspace-archiver.test.ts`（删失败时只有 stop 和 release） | 已覆盖 |
| 分叉到新 worktree：轮的起点在子对话的 pi 加载之前复制；子对话的 pi 没有 Atrium 扩展时应答带 `noteSent: false`、不发隐藏命令；界面在标签栏旁说"没能告诉模型换了目录" | `session-manager.test.ts` "before its pi loads them"、"no Atrium extension"；`children.browser.test.tsx` "not told where it works" | 已覆盖 |
| 留下来的子对话（pi 写出文件后失败）：对话框关掉、打开它、标签栏旁说"子对话没有开好"；`keptChild` 只认带字符串 `sessionId` 的 `fork_failed` | `children.browser.test.tsx` "kept though its pi failed"；`packages/ui/src/children/new-child.test.ts` | 已覆盖 |
| 草稿子对话在 pi 启动途中改名，等启动完再告诉 pi | `session-manager.test.ts` "still starting" | 已覆盖 |
| 提示的路径最多 4096 字符，超长的当作读不出；索引里超出协议长度的父会话 id 和名字当作没有 | `packages/pi/src/agent/agent.test.ts` "up to 4096"、"too long"；`session-catalog.test.ts` "hand-edited index" | 已覆盖 |
| 真实 pi：`/atrium-agent note` 之后、下一条消息之前，会话文件里已经有这条自定义消息 | 契约：`agent-note.pi.test.ts`（读磁盘） | 已覆盖 |
| `createFrom`：没有 git、没有提交可起、git 加不了 worktree 时的失败；分支名用到 `-9`；避开登记了但不在磁盘上的目录；默认随机名是 6 位十六进制；建好时记日志 | `worktree-creator.test.ts` "createFrom" | 已覆盖 |
| 界面：输入框 `/child` 开空的子对话（运行中也行）；不是 git 仓库的项目没有"新建 worktree"，分离 HEAD 的有；子对话条和面包屑打开的会话盖过那个工作区的查看标签；子对话列表和排队面板一次只开一个；子对话都没了就收起列表；自己指向自己的会话不算自己的子对话 | `chat.browser.test.tsx` "/child"；`children.browser.test.tsx` "no git repository"、"detached HEAD"、"over the file"、"closes its list"；`run-control.browser.test.tsx` "one list at a time"；`children.test.ts` "its own parent"；`builtin-commands.test.ts`；`composer.browser.test.tsx` | 已覆盖 |
| 没有专门测试的：分叉的空闲检查和"算忙"之间不再有 await（改成先 `holdForFork` 再建临时目录，靠读代码）；基线读不到时记成读不到的基线、什么都不算；临时目录标记写不了就删；删临时目录失败只记日志；启动清理做完才新建临时目录 | — | 未覆盖（时序和文件系统故障难以稳定复现） |


## M1.15 第二步：agent 开子对话（2026-10-17）

| 行为 | 测试 | 状态 |
|---|---|---|
| 通道：扩展写的调用和提示按操作读出参数，每个参数的文字上限；读不出的带 id 回坏请求、没有 id 的不回；状态行超长不读；宿主的答复和取消按版本、错误码读 | `packages/pi/src/agent/channel.test.ts` | 已覆盖 |
| 给模型的文字：外壳转义、通知的每种事件、截断的回复怎么读全文、问题的 id 和选项、进度只带一次；交代的开场（角色、工具、带上下文时"没配对的调用属于父会话"）；每个错误码；`ask_parent` 的每种结局；每个调用的结果都带后面要用的 id | `packages/pi/src/agent/words.test.ts` | 已覆盖 |
| 扩展：注册十个工具、命令、身份参数和 `tool_call` 钩子；工具按调用 id 问宿主、只认第一个答复、停下时告诉宿主不再等；文字超限不问宿主；`agent_spawn` 带上下文在当前叶子切分支；`report_progress` 立即返回；`ask_parent` 的回答、超时、取消、重复回答、只留 64 个已关的问题；`deliver` 写成自定义消息（空闲开运行、运行中 steer），回复只在给模型的文字里；钩子按白名单拦只读的分叉子对话、层数 2 拦主 agent 的工具、第一件事里不重做父会话没配对的调用 | `packages/pi/src/agent/extension.test.ts` | 已覆盖 |
| 真实 pi 1.1.0：工具在状态行上问宿主、运行中的 `reply` 答它、模型读到结果；空闲时 `deliver` 开一次运行、模型读到带外壳的交代；扩展拦下的只读子对话调不了白名单外的工具、模型得到理由 | `packages/pi/src/contract/agent-tools.pi.test.ts` "agent-call"、"agent-task"、"agent-guard" | 已覆盖 |
| 对话记录：通知、交代的自定义消息读成 `agent` 条目和实时的 `agent_message`；工具结果的 `details` 给出开出的子对话和带回的事件；读不出的不显示；`readEntries` 读整份文件 | `details.test.ts`；`log-entry.test.ts` "notices and a task"；`translate.test.ts` "notices or a task"；`file-usage.test.ts` "readEntries" | 已覆盖 |
| 宿主投影：由通知或交代开头的轮、运行中进来的成一个步骤；重建和实时一致；看到过的通知才开轮 | `projection.test.ts` "notices or a task"、"follows what the host saw"；`session-transcript.test.ts` "opens a turn with a task" | 已覆盖 |
| 启动参数：agent 层数、身份参数、只读白名单、层数 2 去掉主 agent 的工具、不是 agent 开的去掉子对话的两个、带上下文的继承父会话的参数 | `packages/host/src/sessions/agent-launch.test.ts` | 已覆盖 |
| `agent_spawn` 的检查按 SPEC 的顺序回错误码；6 个的名额（含正在建的）；记句柄、第一件事待送、起 pi 交给它；可写的默认进自己的 worktree（`agent/<句柄>`）；带上下文从这个进程拿到的目录切出、用完删掉 | `agent-relay.test.ts` "agent_spawn's checks"、"opening a child"；`worktree-creator.test.ts` "agent/ branch" | 已覆盖 |
| 任务与通知：第一件事带开场；一轮做完告诉父会话（回复条目、用时）并回收空闲的子对话；你在子对话里开的轮不通知、有标签的不回收；停下、出错、崩溃；回复从文件读、截断 4000、进度只带一次；归档的收件人丢掉、交给终端和暂停的留着、睡着的起 pi 也过名额 | `agent-relay.test.ts` "tasks and notices" | 已覆盖 |
| 等待：默认 `any`、取走待送的事件；`all` 遇到问题提前返回、`needs_you` 不提前；已有的事件立即算；名单为空立即返回；别人的任务 `agent_not_allowed`；超时、你说话时提前返回；被中止的放回、不答复；`wait: true` 只等自己那件事（2026-10-21 删掉 `agent_wait` 和 `wait: true`，这一行的测试随之删掉，见"子对话全在后台与边界送达"） | `agent-relay.test.ts` "waiting" | 已覆盖 |
| 问题：子对话收下才说送到；关了删掉没送到的问题通知；10 秒没确认让子对话关掉；同样的回答再送一次；进程退出、脱离时作废；不是 agent 开的会话不能问 | `agent-relay.test.ts` "questions" | 已覆盖 |
| 列出、读、停、模型：状态、模型、未完成的任务、要时列出结束的；按页读回复和最近的步骤；停下连带 agent 开的子孙、到你开的为止；碰不到的子对话的每种错误码；能用的模型标出当前的 | `agent-relay.test.ts` "list, read, stop and models" | 已覆盖 |
| 通道：读不出的回 `agent_bad_request`；同一进程同一请求只答一次、新进程再答；层数 2 没有主 agent 的工具但能问父会话；进程退出时删掉它拿到的分支目录 | `agent-relay.test.ts` "the channel" | 已覆盖 |
| 排队面板与重启：删掉待送的、`sending` 和不认识的拒绝；宿主重启后都暂停、`claimed` 放回、问题作废，等你放开；不带 `tree` 只放自己的；宿主关闭时把在跑的任务记成 `stopped`；归档、交给终端、脱离时结束它的任务（2026-10-21 起索引里不再有 `claimed`，旧的读成 `waiting`，见"子对话全在后台与边界送达"） | `agent-relay.test.ts` "the queue panel, a restart and the host closing"；`router.test.ts` "delivery commands"；`session-catalog.test.ts` "agent fields" | 已覆盖 |
| 控制器送达：空闲时几条通知合成一次、先记 `sending`、开的运行算它们的；交代单独送、和排队按时间先后；运行中所有通知马上合成一条 steer 进去、交代等运行结束（2026-10-20）；重启后、pi 不在、停止中、排队暂停时不送（你发消息时一起走）；有回复后按文件确认、没在文件里的放回；运行没开起来时留给你；运行的开始和结束（含崩溃）告诉 relay；通知或交代开头的轮前不能分叉 | `session-controller.test.ts` "handing pi deliveries" | 已覆盖 |
| 界面：车道的分出、经过、碰一下、汇回，没结束的虚线，有车道时文字缩进；别的轮的子对话的事件画成来源行；由通知开头的轮是来源行（问题用问题色）、交代的轮有全文和"主对话"；"打开"打开子对话 | `packages/ui/src/chat/lanes.browser.test.tsx`；`turn-layout.test.ts` "layoutTurn with children"、"laneLayout"、"describeStep for children"、"where a turn notices or a task opened came from"；`agent-words.test.ts` | 已覆盖 |
| 界面：排队面板的待送达（能删和删不掉的、不能编辑插话、计入排队数、进来时不弹开）和"宿主重启后暂停 · 继续"；子对话条的角色标记、"在问主 agent"第二行和进度、问主 agent 算问号但不抬高标签、"全部继续"按子树加总 | `run-control.browser.test.tsx` "deliveries"、"held ones"；`children.browser.test.tsx` "children the agent opened"；`children.test.ts` "asking its parent's agent"、"heldIn" | 已覆盖 |
| 补的边界：正在建的子对话也占名额（建 worktree 时睡着的子对话不能起）；停下父会话时只停 `wait: true` 在等的子对话，只等一件事的 `agent_wait` 被停下不停子对话；同一调用的第二个答复不再清一次状态；文件末尾没换行的整行 JSON 不读（2026-10-21 删掉等待后，等待相关的边界不再适用） | `agent-relay.test.ts` "still being created"、"leaves a child running"；`extension.test.ts` "first answer"；`file-usage.test.ts` "without its LF" | 已覆盖 |
| 变异测试后补（2026-10-18）：控制器在 pi 退出后不送、不报没有的运行；宿主停 pi 时 pi 自己走掉的运行不算崩溃；交给 pi 还没答复就退出的，不再等它开运行；没有待送达时排队照走；你发消息放开的待送达排在暂停排队里更早的消息前面；送不了的之后立刻送下一批；运行中送的急通知不算下一轮的开头；排队因 pi 拒收暂停时待送达留着；起来时先按文件确认；插话也算你说话；运行中进来的待送达照样显示；`model()`。启动参数：从带上下文的子对话再分叉沿用它起步的参数、保留去掉主 agent 工具的那条；层数在会话上方的环处断开。记录：任务、`toolGuard`、送达的每种状态都读得回。投影与实时：通知开头、看到过的轮带 pi 的重试上限；通知开新轮时上一轮照它的结局结束 | `session-controller.test.ts` "handing pi deliveries"、"carries the model"；`agent-launch.test.ts` "forked from a forked child"、"breaks a loop"；`store/agent-records.test.ts`；`projection.test.ts` "limit on retries as measured"；`session-transcript.test.ts` "ends the turn before" | 已覆盖 |
| 带上下文的子对话不重做父会话的调用：父会话原样的参数里有可选字段的 `null`、写成文字的数字或布尔，pi 校验后子对话同样的调用照样拦下 | `extension.test.ts` "pi's checked input" | 已覆盖 |
| 运行中的通知（2026-10-20）：上一批 steer 进去的还没送到时新来的先留着，送到后合成一条再发；`agent_wait` 不填 `tasks` 时也取已经结束、结果还在待送达里的任务，马上返回、记成 `claimed`，已交给 pi 的不取（2026-10-22 改：不再留着，宿主马上发，扩展在轮次边界合成一条；`agent_wait` 已删，见"子对话全在后台与边界送达"） | `session-controller.test.ts` "every notice at once"、"before the last ones steered are in"；`agent-relay.test.ts` "takes by default, at once" | 已覆盖 |
| 排队暂停时你发消息只放行这一次暂停：恢复排队后 pi 拒收又暂停，新来的待送达照样留着 | `session-controller.test.ts` "for that pause only" | 已覆盖 |
| 变异测试后补的 relay 边界：档位往上、往下换；孙对话的任务记 `originTask`；`agent_send` 写下的任务和送达；句柄只在自己的子对话里找；`agent_read` 一次运行的范围、步骤标题；等待只被自己会话里你说的话、自己进程的退出、点名的取消结束；运行由通知开头时记在原任务或新的后续任务下、`followUpOf` 带给父会话；停和起不交叉；不能再送的交代和通知不送；层数 2 的 `canSpawn: false`；只有 `finished` 带工作区 | `agent-relay.test.ts`（变异测试后补的各条） | 已覆盖 |
| relay 修的三处：子对话的 pi 正在重启时宿主退出，任务照样记成 `stopped`（`host_exit`）；`agent_stop` 停了你开的那一轮后，之后你停它的任务仍算你停的；子对话被归档、脱离时的 `ended` 交给在等它的等待，等待立即返回 | `agent-relay.test.ts` "what reviews of the relay found" | 已覆盖 |
| 资源：等待（超时、事件、被停下）和回答（确认、10 秒加 10 秒没回）结束后，relay 不留定时器 | `agent-relay.test.ts` "leaves no timer behind"（假时钟数定时器） | 已覆盖 |
| 端到端：主 agent 一次开两个子对话（一个只读在同一工作区，一个可写在自己的 worktree、分支 `agent/<句柄>`），子对话做完一轮，主对话收到通知（来源行）并汇总；子对话条列出两个；点"打开"进子对话，看到交代的全文和它的回复。宿主的组装（模型目录、`agent/` 前缀）也由它覆盖 | `apps/desktop/e2e/children.spec.ts` "the agent opens two children" | 已覆盖 |
| 端到端：主 → 子 → 孙，子对话做完第一轮后 pi 被回收，孙对话的结果送到子对话时它的 pi 再起，接着做完再通知主对话；子对话条里写 "+1"，子对话里有孙对话的来源行 | `children.spec.ts` "a grandchild's result reaches the main conversation"（faux 的 `grandchildReplies`，子对话按会话里已有的回复挑下一条） | 已覆盖 |
| 端到端：只读子对话调 `write`，pi 不给它这个工具，文件没写出来 | `children.spec.ts` "a read-only child cannot write a file" | 已覆盖 |
| 交给终端的命令带上工具参数，需要时加引号 | `packages/ui/src/tabs/hand-off.test.ts` "flags the host gave" | 已覆盖 |
| 下一轮由通知或交代开头时，"从这里分叉"和"从这里开子对话"变淡、说明原因、点了不做事（中间隔着提示行也一样）；宿主应答 `turn_not_found`（`agent_turn`）时标签栏旁这么说 | `chat.browser.test.tsx` "fades forking and a child"、"why it did not fork"；宿主：`session-controller.test.ts` "refuses to fork before a turn notices" | 已覆盖 |
## M1.15 第二步三方审查后补（2026-10-18）

| 行为 | 测试 | 状态 |
|---|---|---|
| 带上下文的子对话只拦分叉点那批：父会话那批是第一件事（带开场的那条交代）前面那条助手消息里没有结果的调用，中间隔着的同批结果和别的条目跳过；子对话自己还没有结果的调用不算；孙对话的历史里有父会话自己的第一件事、更早的分叉点也不算；之后的交代（哪怕前面是崩溃留下没结果的调用）什么都不拦 | `packages/pi/src/agent/extension.test.ts` "the tool hook, at the fork"、"parentCalls"、"at what the first task follows"、"reading a task's content" | 已覆盖 |
| 外壳转义：扩展用的每个外壳标签（`atrium-agent…`、`atrium-subagent`、`event`、`reply`、`question`）的开头和结尾都转义、只认整个标签名、别的文字原样；子对话的回复冒充不了 `agent_wait` 里另一个子对话的事件；可选答案、原因、分支、工作目录（含第一件事里的）、列出的子对话名和进度、步骤标题都转义；只有目录没有分支时也写出目录；宿主换目录的提示里两个路径也转义（2026-10-21 起改用通知的外壳测："cannot close a notice's reply"） | `packages/pi/src/agent/words.test.ts` "for every wrapper the extension writes"、"inside the wrappers"；`packages/pi/src/agent/agent.test.ts` "escapes a wrapper tag in a path" | 已覆盖 |
| `ask_parent` 被自己的计时或宿主关掉后，问宿主的那次调用一起结束：之后停下这次运行不再发 `cancel` | `packages/pi/src/agent/extension.test.ts` "ask_parent, once closed" | 已覆盖 |
| `agent_read` 的 `limit`：回复最多 16000、步骤最多 50，超了宿主回 `agent_bad_request`；工具说明写明步骤的上限 | `packages/pi/src/agent/channel.test.ts` "answers a bad request"、"reads each call's own arguments" | 已覆盖 |
| 对话记录里的事件带 `work` 子对话的分支（截到 256）和改动统计，读不出的统计不显示 | `packages/pi/src/agent/details.test.ts` "keeps a work child's branch and changes" | 已覆盖 |
| 宿主重启后：先同时把所有有待送达的会话（和被强杀时丢了任务的父会话）暂停，再读文件；等待接住的在父会话文件里找到那次工具结果就删、找不到放回 `waiting`；读回的进度随下一条通知带一次；还标着进行中、又没有待送达的任务按 `stopped`（`host_exit`）记进父会话、一起暂停（2026-10-21 起没有等待接住的送达，这一半的测试删掉） | `packages/host/src/sessions/agent-relay.test.ts` "after a restart drops what a wait took"、"holds every session's deliveries at once"、"carries the progress read back"、"after the host was killed"；"holds what waited when the host stopped" | 已覆盖 |
| 暂停的原因：没送出去记成 `stalled`，不算进 `heldDeliveries`，"全部继续"（`tree`）不放开、只有它自己会话的"重试"放开；暂停的都删光了就不再暂停 | `packages/host/src/sessions/agent-relay.test.ts` "holds what pi stalled on as stalled"、"lets go the hold once nothing held is left"、"holds what pi stalled on, back as waiting" | 已覆盖 |
| 名额：被回收、等着送达的子对话不占名额，起 pi 那一刻按父会话依次占；7 个同时收到通知或一起"全部继续"时先起 6 个，兄弟一轮做完、被归档/脱离、你开的那一轮结束时叫醒下一个；起不来的不反复重试，你开的子对话（不是 agent 开的）一轮结束也不叫醒它 | `packages/host/src/sessions/agent-relay.test.ts` "starts recycled children notices come to"、"lets go seven children held since a restart"、"wakes a child waiting for a place"、"wakes a child waiting with a place free" | 已覆盖 |
| 宿主退出时只记下 `stopped`，不起 pi、不交给 pi | `packages/host/src/sessions/agent-relay.test.ts` "only records what it tells as the host closes" | 已覆盖 |
| 通知先写进父会话再把任务记成做完：写不进去时任务还开着；等待在写的过程中结束也拿得到这条事件（`pending` 不含它），被停下的等待把它放回 `waiting` | `packages/host/src/sessions/agent-relay.test.ts` "leaves a task open when its parent's notice could not be written"、"gives a wait an event that comes while its write"、"puts back as waiting an event a wait took" | 已覆盖 |
| `wait: true` 的停止在受理期间就来了：等待一开始就结束、不回答，子对话的运行一开始就被停下，父会话收到 `stopped`（`parent_stopped`）（2026-10-21 改：没有等待了，受理期间来的停止不影响开出的子对话，改测 "answers a spawn whose stop came while its child was being made"） | `packages/host/src/sessions/agent-relay.test.ts` "ends at once a wait whose stop came while its child was being made" | 已覆盖 |
| 同一个问题的几次 `agent_reply` 依次处理：第一个算数，不同的答案应答 `agent_question_closed`，同样的再确认一次；已关的问题每个子对话只留最近 16 个 | `packages/host/src/sessions/agent-relay.test.ts` "counts the first answer to a question when two come at once"、"keeps the latest 16 questions" | 已覆盖 |
| 同一进程里做完的请求再来一次，回同一个结果（每个进程留最近 64 个回答过的，被停下、没回答的等待不占），不再做一遍（2026-10-21 改用子对话的 `ask_parent` 被取消来测"没回答的不占"） | `packages/host/src/sessions/agent-relay.test.ts` "answers a request repeated after it was answered" | 已覆盖 |
| `agent_send` 让停下或崩溃用尽的子对话的排队重新走；停下后被回收的子对话状态是 `stopped` | `packages/host/src/sessions/agent-relay.test.ts` "lets the queue of a child stopped or crashed out go again"；`session-manager.test.ts` "calls a child the agent opened stopped once its pi was put away" | 已覆盖 |
| 脱离时删掉原父会话交代、还没送出的事，原父会话照样收到 `ended`；运行中被脱离的，之后开的孙对话不再记着原来那件事 | `packages/host/src/sessions/agent-relay.test.ts` "drops the tasks a detached child had waiting"、"none once its parent is detached" | 已覆盖 |
| 归档在跑的子对话：先停 pi 时运行的结束不按出错通知，父会话收到 `ended`（`archived`）；归档、交接没做成时，每一次停 pi 都放开了（同一次放开两遍只算一次）之后的运行照常通知父会话 | `packages/host/src/sessions/agent-relay.test.ts` "tells the parent a running child archived or handed off ended"、"once every stop for an archive or hand-off called off is over"；`session-manager.test.ts` "tells the parent a child the agent opened ended when it is archived mid-task" | 已覆盖 |
| 删掉一件还没送的交代：这件事悄悄结束（不通知父会话、等它的等待结束），第一件事删了就不再算创建中；起不来的子对话的第一件事不再待送 | `packages/host/src/sessions/agent-relay.test.ts` "ends a task quietly when you remove its delivery"、"drops the first task of a child that could not start" | 已覆盖 |
| `work` 子对话做完的通知带分支和从起点算起的改动统计（文件数、增删行，已提交和没提交的、未跟踪的都算；二进制文件不算行；未跟踪的文件都算数，行只数前 500 个的） | `packages/host/src/sessions/agent-relay.test.ts` "gives a work child's branch and what its worktree changed"；`packages/host/src/changes/checkout.host.test.ts` "changesSince"（含 "the lines of the first 500 only"） | 已覆盖 |
| 送达真正发出前再判断一次：停下、暂停、pi 退出或换了就放回 `waiting`、不发（换上的 pi 接着发）；steer 进去的运行先结束了，它开的下一次运行算它的（读文件之前开始的也算），停下清掉了 pi 的队列就放回；回复只算这次运行开头之后的；扩展报 `extension_error` 时没开起运行的送达放回再发一次，第二次就暂停成"没送出去"（2026-10-22 改：steer 进去的运行先结束了，它放回 `waiting` 再发、开下一次运行；pi 先开了也照样算它的，见"子对话全在后台与边界送达"） | `packages/host/src/sessions/session-controller.test.ts` "keeps back deliveries a stop overtook"、"from a pi that exited or was replaced"、"counts the run a steered delivery opens"（两条）、"puts back a steered delivery a stop took"、"tells a run's reply only from after"、"hands deliveries again that an extension's error lost" | 已覆盖 |
| 排队面板：没送出去时顶上"没送出去"和"重试"，宿主重启后"宿主重启后暂停"和"继续"；只剩待送达、排队因停下而暂停时有"继续发送"、没有"清空" | `packages/ui/src/chat/run-control.browser.test.tsx` "were not sent, with 重试"、"offers 继续发送 for a stopped queue"、"held ones wait until you go on" | 已覆盖 |
| 过程轨道：车道空出来给下一个子对话时，按每个子对话的那一段画虚实；"开子对话"一行在这件事于本轮结束时写用时；合回那一行和通知行写 `work` 子对话的"+A −D" | `packages/ui/src/chat/turn-layout.test.ts` "laneLayout"；`lanes.browser.test.tsx` "dashes only the part of a lane"、"says on the merge what a work child changed"、"opens a lane beside the main line" | 已覆盖 |
| agent 反复开子对话、子对话做完被回收，常驻的 pi、句柄、计时器回到基线（每个子对话的控制器照常留到归档） | `packages/host/src/sessions.leak.test.ts` "keeps no more pi running after the agent opens a child" | 已覆盖 |
| `SessionSummary.agent.taskId`、`taskStartedAt`：协议只收最多 128 字符的 id、不小于 0 的整数时间或 `null`、不能缺；宿主给子对话手上最早那件开着的事和它交代下来的时间，做完换下一件的，都做完是 `null`（任务记录写进索引就推摘要） | `packages/protocol/src/agent.test.ts` "reads when a child's open task was handed down"；`packages/host/src/sessions/agent-relay.test.ts` "gives when the child's open task was handed down" | 已覆盖 |
| 过程轨道"开子对话"一行：这件事没在本轮结束、还是子对话手上那件（不是之后交代的）、子对话在做或在问时，状态后面写从 `taskStartedAt` 算起的实时用时，每秒走一次；本轮结束的写用时、不走；宿主时钟快一点时写 0 秒；卸下后不再走 | `packages/ui/src/chat/lanes.browser.test.tsx` "counts beside a child still on its task" | 已覆盖 |
| `Control.deliveriesHeld` 收 `restart`、`stalled`、`null` | `packages/protocol/src/envelope.test.ts` "accepts every error code, turn and run outcome" | 已覆盖 |
| 变异测试后补（M1.15 第二步之外的新代码）：起分支名给模型的说明原文钉住；没有点的文件名没有扩展名（`xts` 不按 `ts` 认） | `packages/host/src/workspaces/branch-namer.test.ts` "BRANCH_INSTRUCTIONS"；`packages/ui/src/files/file-icons.test.ts` "without a dot or with nothing after it" | 已覆盖 |
| 宿主的全局兜底：没人处理的 Promise 拒绝记一条 error 日志、宿主不退出；`Error` 记 `err`，别的只记类型；宿主关闭、启动失败（索引太新、端口被占）时卸掉，不留监听 | `packages/host/src/platform/stray-rejections.test.ts`；`packages/host/src/index.host.test.ts` "logs a rejection nobody handled"、"newer Atrium"；`packages/host/src/server/ws-server.host.test.ts` "port is already taken" | 已覆盖 |

## 子对话全在后台与边界送达（M1.11 自用，2026-10-21～22）

| 行为 | 测试 | 状态 |
|---|---|---|
| 主 agent 只有七个工具，没有 `agent_wait`；`agent_spawn`、`agent_send` 不收 `wait`、`waitSeconds`，宿主当成不合格式；结果末尾写"做完会通知你，手上没别的事就结束这一轮"；真实 pi 1.3.0 加载扩展后声明的就是这七个 | `packages/pi/src/agent/extension.test.ts` "registers the nine tools"、"declares each tool"；`channel.test.ts` "answers a bad request"；`words.test.ts` "words a child started in the background"；`packages/host/src/sessions/agent-launch.test.ts`；真实 pi `packages/pi/src/contract/agent-tools.pi.test.ts`（本机 1.3.0 实跑，夹具未保留） | 已覆盖 |
| 旧会话里的 `agent_wait`、`wait: true` 的结果照旧给出车道合回的位置，过程轨道照旧写"等子对话" | `packages/pi/src/agent/details.test.ts`；`packages/ui/src/chat/agent-words.test.ts`、`turn-layout.test.ts`、`lanes.browser.test.tsx` | 已覆盖 |
| 索引里旧宿主留下的 `claimed` 送达读成 `waiting`（去掉 `claimedBy`），读不出的照旧丢掉；重启后 `sending` 放回 `waiting`、问题作废 | `packages/host/src/store/agent-records.test.ts` "reads a delivery a wait took"；`agent-relay.test.ts` "holds what waited when the host stopped" | 已覆盖 |
| 受理期间父会话的工具被停下：照常回答，开出的子对话照做，不停它 | `agent-relay.test.ts` "answers a spawn whose stop came while its child was being made" | 已覆盖 |
| 轮次边界合并插入：pi 在跑时扩展收着宿主发来的，`turn_end` 时通知合成一条、补进手上那件事的话合成一条（通知在前），用 steer 交给 pi；pi 空闲时连同收着的马上发；同一条送达只交一次；这一轮被停下（回复中止或运行的 signal 已中止）时丢掉收着的 | `packages/pi/src/agent/extension.test.ts` "deliver, while pi runs"；真实 pi `agent-tools.pi.test.ts` "agent-boundary"（工具跑着时到的两条在这批跑完时一起进去、只多一次请求）、"agent-boundary-stop"（`clear_queue` 加 `abort` 后下一轮没有它），夹具 `pi-1.3.0/agent-boundary*.jsonl` | 已覆盖 |
| 宿主：在跑时通知和补进手上那件事的话一来就发，不等上一批进去；新交代的事等运行结束；几次 steer 进去的都记着，运行先结束了就放回 `waiting` 再发、开下一次运行，pi 先开了也算它们的；交给 pi 和在文件里确认时各记一条 info 日志（只有条数、是否开新运行、等了多久） | `packages/host/src/sessions/session-controller.test.ts` "hands pi notices as they come"、"words for the task in hand at once"、"hands again a steered delivery"、"as all of theirs, however many times"、"logs deliveries once pi has them" | 已覆盖 |
| `agent_send` 给正在做主 agent 交代的事的子对话：补进这件事（任务 id 不变、不另开任务、`steered: true`），交给 pi 时不带第一件事的说明；对方在等主 agent 回答时应答 `agent_question_open`（带 `questionId`）、什么都不留；对方在跑你开的那一轮时照旧排成下一件事；没赶上边界、事情已做完时，它开的运行记成后续任务、通知父会话；`agent_read` 读这件事的回复不在补进来的话那里截断 | `packages/host/src/sessions/agent-relay.test.ts` "words for the task in hand (2026-10-22)"；`packages/pi/src/agent/words.test.ts` "words words added to the task in hand"、"words every code" | 已覆盖 |
| 端到端：主 agent 给正在跑的子对话发话，子对话下一次请求模型时上下文里已经有这句话，子对话只回复一次、主对话只收到一条"完成" | `apps/desktop/e2e/children.spec.ts` "the agent's words for a child at work go into the task in hand"（连跑 10 次通过；把 relay 改成不补进时失败） | 已覆盖 |
| 子对话的交付（2026-10-22，借鉴 `pi-subagents`）：第一件事的说明要求最终回复依次写结论、改了的文件、验证了什么和怎么验证、没验证什么、卡在哪里；之后的交代提醒同样几项；补进手上那件事的话写"对你手上这件事的补充"、不带提醒 | `packages/pi/src/agent/words.test.ts` "opens a first task with who the child is"、"opens words for the task in hand as more on it"、"tells a work child where to change files" | 已覆盖 |
| `ask_parent` 没得到回答（超时、回答没送到、脱离、归档、交给终端）时不让子对话猜：停下依赖它的事，以最终回复写明要谁决定什么、已经做了什么；工具说明同样写明 | `packages/pi/src/agent/words.test.ts` "to stop what needs it rather than guess"；`extension.test.ts` "declares each tool" | 已覆盖 |
| 三方审查后（Astra、Grok 4.7、Claude Opus 5.5，2026-10-22）：扩展在 `agent_end`（不是被停下的）时交出收着的，pi 再开一次运行带进去、宿主只看到一次运行；空闲时宿主重发收着的那几条也交出；重发的一批取代收着的重叠部分、同一事件不出两次；去重只认还在 pi 队列里或已进上下文的（看 `message_start`），被停下时忘掉 pi 队列里那些、重发照交；新交代的事不和补话合成一条、两件事的补话分开 | `packages/pi/src/agent/extension.test.ts` "deliver, while pi runs"；真实 pi `agent-tools.pi.test.ts` "agent-boundary-end"（测试专用探针 `packages/pi/test/agent-end-probe.ts` 在 `agent_end` 卡住 pi，期间送达；夹具 `pi-1.3.0/agent-boundary-end.jsonl`） | 已覆盖 |
| 三方审查后（宿主）：在跑时通知和补话分两条命令、通知在前；relay 把同一件事的几条补话合成一条；删掉待送的补话不结束那件事；原来那件的运行已结束、"做完"还没写进索引时，补话开的运行记成后续任务、结果通知父会话；对方正在被停下时 `agent_send` 照旧排成下一件；"送达已确认"日志每条只记一次；旧索引里带 `claimedBy` 的记录都去掉这个字段 | `packages/host/src/sessions/session-controller.test.ts` "as two commands, the notices first"、"logs each delivery confirmed once"；`agent-relay.test.ts` "several words for the task in hand as one"、"remove words for it before they went"、"not written done yet"、"a child being stopped"；`packages/host/src/store/agent-records.test.ts` "reads a delivery a wait took" | 已覆盖 |
| 子对话的过程轨道里，运行中插进来的主 agent 的话写"主 agent 插话"加第一行 | `packages/ui/src/chat/turn-layout.test.ts` "words a task's words that came into its run" | 已覆盖 |

## M1.11、M1.12 三方审查后补（2026-10-14）

| 行为 | 测试 | 状态 |
|---|---|---|
| 归档的会话不再起 pi：消息、插话、打开、要起 pi 的命令都应答 `session_not_found`；归档途中（停 pi 到写完索引）发来的消息、插话同样，不发给 pi | `packages/host/src/sessions/session-manager.test.ts` "starts no pi for a session archived"、"while it is being archived" | 已覆盖 |
| 对话归档途中：其中会话的消息应答 `session_not_found`、新建会话应答 `chat_not_found`，不起 pi；同一个对话的归档和恢复按收到的顺序做 | `session-manager.test.ts` "while its chat is being archived"、"in the order asked" | 已覆盖 |
| 工作区归档：从停 pi 到做完或失败，其中会话不起 pi、不能新建会话，之后放开；索引记下这次归档的会话；恢复时先放回记下的会话再清标记，早先没记的放回工作区里所有归档的会话 | `session-manager.test.ts` "from its stop until released"、"restores the sessions given"；`packages/host/src/workspaces/workspace-archiver.test.ts`（各条的 `release`、`sessions`）、"puts back the sessions archived with it" | 已覆盖 |
| 压缩中算忙：交给终端应答 `session_busy`，停空闲 pi 时不停它 | `session-manager.test.ts` "counts a compaction as busy" | 已覆盖 |
| 分叉途中原会话算忙：消息进排队、放开后发出；再分叉、压缩、交给终端应答 `session_busy` | `packages/host/src/sessions/session-controller.test.ts` "holds the session busy for a fork"；`session-manager.test.ts` "holds the session busy until the fork's pi is done" | 已覆盖 |
| 新建 worktree 的起点只收完整的 ref（`refs/heads/`、`refs/remotes/`）或 `HEAD`，短名、标签、像选项的都是 `base_missing`；git 超时也是 `worktree_create_failed`，日志只记原因 | `packages/host/src/workspaces/worktree-creator.test.ts` "is no full branch name"、"starts from HEAD"、"when git times out" | 已覆盖 |
| 右栏默认标签：有未提交改动或领先基线的提交时是"更改"；开着的面板守住打开时的默认，关上才放开；胶囊按面板实际所在的标签决定转到"更改"还是关上 | `packages/ui/src/files/right-panel.browser.test.tsx` "for commits ahead of the base"；`packages/ui/src/state/workspace-views.test.ts` "the open panel holds"；`packages/ui/src/chat/chat.browser.test.tsx` "turns a panel that opened at 文件 to 更改" | 已覆盖 |
| 文件树：一个目录先发的读后回来不盖掉后读的；刷新只读展开且看得见的目录，折起的里面的等它再露出来才读，露出来时立刻读 | `right-panel.browser.test.tsx` "keeps a directory's latest listing"、"only the expanded directories showing"、"only as it shows"；`packages/ui/src/files/trees.test.ts`（`shownDirs`） | 已覆盖 |
| 查看标签的滚动位置和换行按标签记：切走切回不变，关掉（或预览被换掉）就忘；文件读回来之前切走不改记下的位置；别的工作区同路径的文件各读各的；"改动"标签被要求去某个文件时去那里 | `workspace-views.test.ts` "viewer places"；`chat.browser.test.tsx` "keeps each viewer tab's scroll and wrapping"、"reads a file afresh in another workspace"；`packages/ui/src/files/file-viewer.browser.test.tsx` "before the file reads"；`packages/ui/src/files/diff-viewer.browser.test.tsx` "where it was left"、"rather than where it was left" | 已覆盖 |
| 从搜索、收件箱、"历史"点一个会话（哪怕就是当前的）把它显示到查看标签前面；宿主换了激活会话时同样；查看标签盖着时不把会话的错误标为看过 | `packages/ui/src/app/workbench.browser.test.tsx` "chosen in the search, the inbox or 历史"、"when the host makes another active"、"only once no viewer tab is over it" | 已覆盖 |
| 对话区按钮按下有反馈（2026-10-15）：小按钮（复制、分叉、回到底部）缩到 0.9，文字按钮和胶囊 0.95，整行 0.985，禁用的不缩；复制后按钮换成 ✓、悬停"已复制"，2 秒后复原，剪贴板拒绝时不换；"改了 N 个文件"的箭头转半圈 | `packages/ui/src/chat/turn.browser.test.tsx` "shows a check for 2 seconds once copied"、"gives each button a press" | 已覆盖 |
| 从对话里打开文件（2026-10-15）：工作区里的会话，读 / 编辑 / 写的步骤和探索行下的文件胶囊是按钮（悬停"打开 路径"），点了在固定的文件标签里打开；相对路径按工作区目录、绝对路径只认工作区里面的，去掉 `.`、按 `..` 往上，出了工作区或 `~` 开头的不能点；对话（不是工作区）里都不能点；点胶囊不展开这一行，点行的其他地方照旧展开 | `packages/ui/src/files/workspace-path.test.ts`；`turn.browser.test.tsx` "opens an edited file from its chip"、"turns down a plain chip"、"explore row's chip"；`chat.browser.test.tsx` "ConversationArea's file chips" | 已覆盖 |
| HTML 文件在浏览器打开（2026-10-15）：`.html`、`.htm`（不分大小写）文件的标签顶部有"在浏览器打开 (⌘O)"，⌘O 只在这个标签显示着时有用（加了 ⇧ ⌥ ⌃ 的不算），标签关掉就不再听；别的文件、没有桌面端时没有，宿主拒绝读（如经过链接的目录）、是链接时也没有；交给桌面端的是工作区目录（去掉末尾斜杠）接上文件路径的绝对路径；不认识的工作区没有 | `packages/ui/src/files/file-viewer.browser.test.tsx` "in the browser"、"offers the browser"；`chat.browser.test.tsx` "ConversationArea's HTML tabs" | 已覆盖 |
| 文件标签显示时也订阅 diff（关面板时） | `chat.browser.test.tsx` "watches the diff while a file tab shows" | 已覆盖 |
| "改动"标签：重新发来的 diff 改了某个文件时，这个文件先无色显示新内容，再重新上色 | `diff-viewer.browser.test.tsx` "colours a file again once a diff sent again changes it" | 已覆盖 |
| 一次运行结束即使同时另一个会话开始跑也算结束（文件树、文件标签重读） | `packages/ui/src/files/use-diff.browser.test.tsx` "as another starts" | 已覆盖 |
| 上色 worker 出错：等着的文本无色返回，下一次另起一个 worker | `packages/ui/src/files/highlight.browser.test.ts` | 已覆盖 |
| 文件图标和语言只认表里自己的条目，`constructor`、`__proto__` 这类名字不算 | `packages/ui/src/files/file-icons.test.ts`、`packages/ui/src/files/languages.test.ts` "nor by an object's own members" | 已覆盖 |
| 拖右栏的边时宽度只在松手时写进存储，拖动途中不写 | `packages/ui/src/chat/changes-pane.browser.test.tsx` "once let go, not on every move"；`packages/ui/src/state/panes.test.ts` "not a width passed through" | 已覆盖 |
| `/compact` 要记住的内容和消息一样带上长粘贴和 `@` 文件，并清空输入框 | `chat.browser.test.tsx` "takes the long pastes and the files into what to keep in mind" | 已覆盖 |
| 内置命令失败只在发出它的会话里说原因，切到别的会话后不显示 | `chat.browser.test.tsx` "only in the session it was run in" | 已覆盖 |
| 分叉：重启 pi 时按钮变灰；名字截断不切开 emoji（代理对） | `chat.browser.test.tsx` "is faded and does nothing during %s"（"a restart of pi"）、"cuts a long title between characters" | 已覆盖 |
| 新建工作区：起点发完整的 ref（本地 `refs/heads/`、远程 `refs/remotes/`），界面和错误只显示短名；分支列表回来之前不让发送 | `packages/ui/src/state/new-workspace.test.ts` "as full refs"、"a ref's short name"；`packages/ui/src/app/new-workspace.browser.test.tsx` "sends the full ref of the base chosen"、"holds the send back until the bases come" | 已覆盖 |
| 新建工作区的页面在创建途中被关掉时，输入的内容留在新页面上，不交给建好的会话 | `new-workspace.test.ts` "goes on when the page was closed" | 已覆盖 |
| UI 只经 `@atrium/client` 拿协议的值（只有类型可直接从 `@atrium/protocol` 引），由 oxlint 的 `no-restricted-imports` 守住 | `pnpm check`（`.oxlintrc.json`） | 已覆盖 |

## 安全（security.md）

| 要求 | 测试 | 状态 |
|---|---|---|
| 错误 token 被拒绝（4401），日志里没有真 token；同源页面也必须带对 token | ws-server.host.test.ts "rejects a wrong token…"、"lets a page served by the host itself connect, but still requires the token" | 已覆盖 |
| 外来 Origin 在升级时被拒（403） | ws-server.host.test.ts "refuses a browser from a foreign origin…" | 已覆盖 |
| 只认第一条 hello；格式错误、版本不符、超时各有关闭码 | ws-server.host.test.ts "closes the socket on …"、"drops a client that never says hello…"、"answers only the first of two hellos" | 已覆盖 |
| 连接数、消息速率、字节速率、单条大小的上限 | ws-server.host.test.ts "disconnects a client that sends more than 200 messages…"、"allows exactly 32 MiB per second…"、"closes a connection that sends a message over 1 MiB…"、"refuses connections beyond 32 at once" | 已覆盖 |
| token 强度（单独运行与 Electron 两条路径） | `packages/host/src/server/auth.test.ts`；host-standalone.spec.ts "refuses a weak token…" | 已覆盖 |
| 渲染进程拿不到 Node，桥上只有 bootstrap、选择文件夹、窗口外观、拖入文件的路径、在访达中显示 | e2e "gives the page no Node access and only the bridge…" | 已覆盖 |
| 窗口页面从固定的 `atrium://app` 加载，CSP 只多允许连宿主端口，存储跨重启保留 | e2e "opens a window on the host's UI at a fixed origin…"、"keeps the page's storage across a restart…" | 已覆盖 |
| git 的输出、fetch 失败的原文不进日志，只记命令和原因；索引文件损坏只记文件名 | `workspace-service.test.ts` "logs a scan git could not run by its reason…"、"skips projects without an origin and logs a fetch that fails"；`index.host.test.ts` | 已覆盖 |
| 在访达中显示（`reveal`）只接受存在的绝对路径：相对路径、不存在的路径、不是字符串的都不理 | e2e `app.spec.ts` "shows in the Finder only an absolute path that exists"（`shell.showItemInFolder` 被替换，不打开真的访达） | 已覆盖 |
| 用浏览器打开（`openInBrowser`）只接受绝对路径、扩展名 `.html` / `.htm`、`lstat` 是普通文件的：其他扩展名、符号链接、目录、不存在的、相对路径（哪怕指向同一个文件）、不是字符串的都不理；交出去的是 `file://` 地址 | e2e `app.spec.ts` "opens in the browser only an absolute path to a regular HTML file"（`shell.openExternal` 被替换，不打开真的浏览器） | 已覆盖 |
| 不能导航到别的源、不能开新窗口，链接交给系统浏览器 | e2e "keeps the page on its own origin…"（目标服务器零请求，`shell.openExternal` 被调用） | 已覆盖 |
| 宿主页面带 CSP、nosniff；开发页面也带 CSP | ws-server.host.test.ts "serves the UI with the full content security policy…"；`apps/desktop/e2e/dev.spec.ts` | 已覆盖 |
| 静态文件不越出 UI 目录：路径穿越、符号链接 | `packages/host/src/server/static-files.test.ts`；ws-server.host.test.ts "does not follow a symlink out of the UI directory…" | 已覆盖 |
| 读不了的文件、中途断开的下载不让宿主崩溃 | ws-server.host.test.ts "answers 404 for a file it cannot read…"、"survives a client that disconnects…" | 已覆盖 |
| 日志脱敏：凭据键、已知秘密、格式化参数、`Error`、子 logger 绑定 | `packages/host/src/platform/logger.test.ts`、`redact.test.ts`、`redact.prop.test.ts`；e2e "…never logs the token" | 已覆盖 |
| pi 的环境里名字像凭据的变量值加入脱敏列表，pi 在 stderr 回显也不进日志 | redact.test.ts "picks the values of credential-like variables…"；tools.host.test.ts "scrubs credentials from the tool environment…"；try-pi.test.ts "keeps credentials from the environment out of its log…" | 已覆盖 |
| pi 从 `auth.json` 读的 Key 被 pi 回显时不进日志（已知缺口，见 security.md"凭据与日志"） | — | 待 M1.10 |
| `@` 搜索不返回工作区之外的文件：`~/`、绝对路径、`..` 找不到；像 fd 选项的查询词（`--search-path=…`）只当文字；工作区里的符号链接照 pi 跟进去（2026-10-10 定） | `packages/host/src/files/file-search.host.test.ts` "finds nothing outside the working directory"、"takes a query that looks like an fd option as text…"；`fd-query.test.ts` "scopeOf" | 已覆盖 |
| 新建的 `~/.atrium` 权限 0700、日志 0600；已有目录不改权限；经符号链接给的目录按真实路径返回（pi 按真实路径给会话目录命名） | `packages/host/src/platform/home.test.ts`；`logger.test.ts` "creates log files readable only by their owner, rotated ones included" | 已覆盖 |
| 索引文件 0600、`turns/` 目录 0700；插话记录的文件名只用 pi 形状的会话 id | `packages/host/src/store/index-file.test.ts`、`turn-starts.test.ts` | 已覆盖 |

## 日志与链路追踪（observability.md）

| 要求 | 测试 | 状态 |
|---|---|---|
| traceparent 的生成、格式化、解析 | `packages/protocol/src/trace.test.ts`、`trace.prop.test.ts` | 已覆盖 |
| 宿主 span 挂在客户端的 trace 下，日志带 trace_id | ws-server.host.test.ts "records the whole connection…"；e2e "records the connection under one trace id…" | 已覆盖 |
| 日志磁盘上最多保留 5 个（含之前运行的）；`current.log` 是普通文件时能自愈；日志流出错不崩溃 | logger.test.ts "openLogFile" | 已覆盖 |
| 未结束的 span 计入资源计数 | `packages/host/src/server/connections.leak.test.ts` | 已覆盖 |
| `pnpm trace` 打印链路，跳过不完整的行 | `scripts/trace.test.ts`（跨轮转文件、别的 trace、半行、无记录、用法错误） | 已覆盖 |
| 宿主每分钟记录资源计数和内存（`resource usage`） | `packages/host/src/usage.host.test.ts` "logs resource counts and memory once a minute"（假时钟） | 已覆盖 |
| Electron 主进程每分钟把各进程的内存和 CPU 交给宿主记录（`app metrics`）；宿主就绪前、退出后、格式不对或超出上限的丢掉（2026-10-11 定） | `electron-port.test.ts` "hands app metrics to the running host"、"drops app metrics…"、"accepts app metrics at the limits"；`usage.host.test.ts` "logs the desktop app's processes…"；`apps/desktop/e2e/shutdown.spec.ts` "hands samples of the app's processes…"（`ATRIUM_APP_METRICS_INTERVAL_MS` 缩短间隔） | 已覆盖 |
| `pnpm usage` 按宿主的每次运行列出每小时的用量，比较第一个和最后一个小时的最低值，按规则标 `↑`；跨轮转文件、跳过半行、开头已轮转掉的运行从第一条记录算起（2026-10-11 定） | `scripts/usage.test.ts` | 已覆盖 |

## 资源与性能（testing.md）

| 要求 | 测试 | 状态 |
|---|---|---|
| 200 次连接（每次都订阅索引）、50 次拒绝后资源计数和 Node 真实定时器都回到基线；常驻的只有资源报告和后台 fetch 两个定时器，git 进程为 0 | connections.leak.test.ts | 已覆盖 |
| 真实 pi 启动、停止 200 次后，资源计数、定时器、子进程、管道句柄都回到基线，每个 pi 进程及其进程组都已消失 | `packages/pi/src/process/pi-process.leak.test.ts` | 已覆盖 |
| 会话控制器 200 轮对话框（回答、取消、超时、作废）、停止（立即确认、超时后确认）、崩溃重启后，没有待触发的定时器，旧 pi 上没有留下监听 | `packages/host/src/sessions/session-controller.leak.test.ts` | 已覆盖 |
| 测试失败、超时或被杀时不留临时目录 | 根目录 `test-temp-root.ts`（Vitest、Playwright 全局初始化）；验证方法见 testing.md"临时文件与残留进程" | 已覆盖 |
| 定时器计数与释放 | `packages/host/src/platform/clock.test.ts` | 已覆盖 |
| 外观来回切换不留下脱离的 DOM | `apps/desktop/e2e/appearance.leak.spec.ts`。这个测试看不到事件监听器泄漏；外观监听器的移除由 appearance.browser.test.ts 断言 | 已覆盖 |
| 启动到连上宿主 ≤ 2 秒 | `apps/desktop/e2e/startup.perf.spec.ts` | 已覆盖 |
| 长时间运行：资源回到基线，内存增长每次 < 1KB | `packages/host/test/soak/connections.soak.test.ts`、`sessions.soak.test.ts` | 已覆盖 |
| 热路径基准 | `packages/protocol/src/trace.bench.ts`（traceparent 解析）；`packages/pi/src/process/jsonl.bench.ts`（分帧：大量小记录、16 MiB 单行，后者能抓住每块重扫整个缓冲的退化） | 已覆盖 |

## 联网搜索与抓取（ADR-0014，2026-10-20）

| 行为 | 测试 | 状态 |
|---|---|---|
| Atrium 的扩展注册 `web_search`、`web_fetch`，参数模式要求 `query` / `url`，说明里写明网页内容不是用户的话；与 pi 的 `ExtensionAPI` 类型相容 | `packages/pi/src/search/extension.test.ts` "fits pi's extension API…"、"registers web_search and web_fetch…"；`packages/pi/src/plan/extension.test.ts` "…and the web tools, from Atrium's one extension" | 已覆盖 |
| 搜索用搜索 key（`DEEPSEEK_SEARCH_API_KEY`，来自 `deepseek` 凭据的 `env` 或进程环境），带 `authorization`、`content-type`、`accept`；`count` 没给就不发；结果给模型的是标题、地址、站点和日期、`summary`；没有结果不算失败 | extension.test.ts "searches with the search key…"、"leaves count out…" | 已覆盖 |
| 抓取返回标题加 Markdown，超过 60,000 字符时截断并写明，不把代理对截成两半 | extension.test.ts "fetches a page…"、"cuts a long page…"、"does not cut a surrogate pair…" | 已覆盖 |
| 不合规的地址（非 http(s)、带用户名密码、无法解析、超长）、空的或缺的 `query` 不发请求 | extension.test.ts "refuses the address…"、"refuses a blank or missing query…" | 已覆盖 |
| 没有搜索 key：不发请求，告诉模型去设 `DEEPSEEK_SEARCH_API_KEY` | extension.test.ts "tells the model there is no key…" | 已覆盖 |
| 找 key 的顺序：`deepseek` 凭据的 `env` 先于进程环境；空白算没有、落到下一个；pi 答不出来算没有凭据；只读这个名字，不读凭据的 `apiKey`（聊天）和 `DEEPSEEK_API_KEY` | extension.test.ts "uses the search key in the env of pi's deepseek credential…"、"has no key from the chat credential alone…"；"searchKey" 一组 | 已覆盖 |
| 失败只报状态码和让模型知道怎么办的话，不带服务器的原文（401 会回显 key）；不是 JSON、不是搜索或抓取的答案；连不上；不跟随重定向（key 不发到别处）；工具的信号触发时按"已停止"结束 | extension.test.ts "reports a failed status as a code…"、"words HTTP %i…"、"reports an answer that is not JSON…"、"reports unreachable…"、"ends as aborted…" | 已覆盖 |
| 真实 pi 里加载扩展，模型调用 `web_search`、`web_fetch` 得到真实结果（2026-10-20 手动，pi 1.3.0，隔离的 `PI_CODING_AGENT_DIR`：`deepseek` 凭据带 `env` 时返回结果且 `auth.json` 没被改写；凭据有聊天 key 但没有搜索 key 时 `no_key`；环境变量里的聊天 key 不当搜索 key） | 没有自动化测试：契约夹具只录了 pi 1.1.0，且要联网和真实 key | 手动验证 |

## M1.11 自用：空闲回收 pi 与控制器（2026-10-22）

`pnpm usage` 在 10-21 那次 24 小时的运行里标出 `pi-process` 3 → 17、`session.controller` 3 → 68、heap 21 → 171 MB。对照日志和索引：这一天新建 75 个会话（59 个 agent 开的子对话）、打开 400 次；留下的 pi 都属于打开过、没归档的会话，控制器多为被回收了 pi 的子对话，夜里两者和 heap 一起持平。不是违反 SPEC 的泄漏，是"不回收"的设计在重度使用下的累积。用户定：pi 已停且没人订阅就丢控制器，空闲超时就停 pi（SPEC-0001"空闲回收"，30 分钟，宿主随每分钟的资源报告查一次）。

| 行为 | 测试 | 状态 |
|---|---|---|
| 空闲满 30 分钟停 pi（`requested`），标签开着也停；从最后一个事件算起，没有事件时从 pi 启动算；下一条消息起新的 pi | `packages/host/src/sessions/session-manager.test.ts` "idle reclaim" 的 "since its last event"、"never used" | 已覆盖 |
| 停 pi 途中发来的消息等它停完、送到新的 pi（不发给正在退出的那个） | 同上 "while the idle stop is under way" | 已覆盖 |
| 等停 pi 的启动算在启动：这期间交给终端应答 `session_busy`，不留两个 pi 写同一个文件 | 同上 "counts a start waiting for the idle stop as busy" | 已覆盖 |
| pi 已停时编辑已停止的消息：页面 epoch 是停掉的 pi 的就按新 pi 的核对，更旧的应答 `transcript_changed` | `session-manager.test.ts` "restarts an idle pi for an edit" | 已覆盖 |
| 在跑、宿主排队里有消息、有未回答对话框的不停 | 同上 "leaves a session alone" | 已覆盖 |
| pi 停了、没人订阅、没有标签开着时丢掉控制器；有人订阅、标签开着（切回马上有快照）、pi 还活着时不丢；再打开从文件重建 | 同上 "lets go of a stopped session's controller"、"while its tab is open"、"keeps a live session's controller" | 已覆盖 |
| 崩溃用尽（`failure`）、排队暂停（队列已空，扣着待送达）、正在崩溃重启的不丢控制器 | 同上 "gave up after crashing"、"queue was stopped, emptied since"、"being started again after a crash" | 已覆盖 |
| 5 轮打开 → 跑一轮 → 空闲 → 丢掉后，`pi-process`、`session.controller`、`timer` 回到 0 | 同上 "returns pi and controller counts to none" | 已覆盖 |
| 宿主每分钟的资源报告顺带回收：第 30 分钟的报告（距最后一个事件差一点不到 30 分钟）不停，下一次停掉 | `packages/host/src/usage.host.test.ts` "stops an idle session's pi" | 已覆盖 |

审查（Claude 子代理，只读）后按用户决定改：开着标签的不丢控制器；点过停止的会话（排队暂停，队列空也算）维持留着控制器；修了等停 pi 的启动没算在启动（交给终端会和它撞出两个 pi）；停掉后编辑已停止的消息第一次必定 `transcript_changed`：用户定放宽，pi 已停、页面 epoch 正是停掉的那个时按新 pi 的 epoch 核对，更旧的照样拒绝（`session-manager.test.ts` "restarts an idle pi for an edit, taking the stopped pi's epoch"，原先这条测试约定的是一律拒绝）；每分钟的报告先排下一次再回收，回收抛错不会让报告停掉（这一条没有测试：要让回收抛错只能改坏代码）；测试里"运行后的事件到齐"改为等 pi 的请求都答完（span 数回到 pi 数），宿主集成测试改为在第 30 分钟确认 pi 还在。已知：被丢掉控制器的 agent 子对话 `agent_list` 报开始时的模型。前后共 20 项 `pnpm break-check` 全部检出（审查前 13 项，含去掉 `main.ts` 里的调用；审查后 7 项，含把等待挪回启动之外、去掉标签条件、阈值提前一分钟、去掉 epoch 换算、不论新旧一律换成新 epoch）。第一轮漏了三项：断言在异步停止之前（补等待）、"排队里有消息"和"排队暂停"重复（pi 已停时有消息必然暂停，删掉前者）、释放时删时间记录只省内存（源码注明等价）。改动行变异测试 host 组审查前 56/56、审查后 58/58、放宽编辑门禁后连同之前的增量共 73/73 killed（100%）。`pnpm check`、单元（审查前首轮既有的 `pi-config.test.ts` 队列用例并发下失败 1 项，重跑全过；审查后 3436 项一次全过）、宿主 150 项、泄漏 vitest 13 项通过。未跑桌面端到端；界面对 `requested` 退出后下次发送重新打开的路径是更新 pi 后 `stopIdle` 已有的，未改界面。给空闲超时停掉的你开的会话送通知时起 pi，是 AgentRelay `wake` 既有的行为（不是 agent 子对话就直接 `ensureRunning`），已由 `agent-relay.test.ts` "drops what goes to a session archived … and starts one asleep" 覆盖（主会话 `main` 没有 pi 时被起来）。

## M1.11 自用：worktree 归档结果改为右上角提示（2026-10-22）

用户嫌侧栏项目标题下的一行通知难看，选了原型 `prototypes/archive-toast-prototype.html` 的 A“玻璃胶囊”；失败按用户要求也放右上角、也自动消失（design-language“提示”，SPEC-0001“M1.11 的工作区归档”）。对话归档失败仍在侧栏问题行。

| 行为 | 测试 | 状态 |
|---|---|---|
| 成功“已归档「名称」”，`role=status`、`--ok-text` 勾，3 秒后 0.2 秒退场再去掉 | `packages/ui/src/sidebar/archive-toasts.browser.test.tsx` "for 3 seconds" | 已覆盖 |
| 失败“没能归档「名称」：原因”，`role=alert`、`--danger` 图标、原因 `--text-muted`，6 秒 | 同上 "for 6 seconds" | 已覆盖 |
| 悬停或键盘聚焦 × 时暂停，移开接着走剩下的、至少 0.6 秒；× 悬停或聚焦时才显示，点了立即退场 | 同上 "while hovered"、"keyboard's focus"、"when it is pressed" | 已覆盖 |
| 窗口右上角离顶 56px、离右 12px，高 34px、玻璃模糊，叠放间隔 8px、新的在上、最多 3 条；名称超过 180px 省略 | 同上 "top right"、"180 px"、`pushToast` | 已覆盖 |
| 侧栏后台归档的成功与失败都走这里，不在侧栏里；关掉后从列表去掉 | `packages/ui/src/app/workbench.browser.test.tsx` "archiving in the background"、"background archive failed" | 已覆盖 |

19 项 `pnpm break-check` 全部检出。改动不在变异分组（侧栏组件不属核心模块），未跑变异测试。

## M1.11 自用：Friday 服务商品牌（2026-10-22）

用户指定 `sankuai-openai` 显示为 `Friday`，使用 friday.sankuai.com 官网 favicon 的本地 80×80 PNG。内部 ID、模型选择与套餐判断不变。来源登记在 `packages/ui/src/design/brand/SOURCES.md`。

- `model-choice.test.ts`：精确断言 Friday 名称与本地图标，改实现前见红；名称还原和错配 OpenAI 图标两项破坏检查均检出。
- `model-picker.browser.test.tsx`：按钮与服务商图标、图片真实加载、Friday 面板名、选择时继续传 `sankuai-openai`；单文件 41 项通过。
- `models.spec.ts`：真实 Electron + pi + faux 验证按钮、服务商图标与面板名称，构建内嵌图像逐字节比对；1 项通过，生成浅 / 深色截图。
- 构建、单元 3414 项、全量 UI 984 项通过；单元仍输出日志流 EBADF 警告。未跑全量桌面测试或本次 UI 核心文件变异测试。

## M1.11 自用：重新隐藏非套餐 Claude（2026-10-22）

按用户要求重新加入 `anthropic` 的整家过滤，保留 `claude-bridge` 套餐路径；OpenRouter Claude 过滤不变。不动凭据和正在使用这些模型的会话。此条取代下节的恢复可见行为。

- `packages/host/src/sessions/model-rules.test.ts`：完整列表、OAuth / API Key 的原生 Claude 与默认模型清除；先见五项失败，再六项通过。删除新增规则的 `pnpm break-check` 检出。
- `apps/desktop/e2e/models.spec.ts`：`hides non-plan Claude and clears its default from the model picker`，等待模型读取完再确认无 Anthropic 服务商、无可选模型；真实 Electron + pi + faux 通过。
- `pnpm check`、构建、单元 3414 项、宿主 149 项通过。单元输出一条日志流 `EBADF` 警告，未使测试失败。
- 定向 host 变异测试超出 120 秒执行期限，最后进度 22/100、无存活或超时，未得到最终分数；已清理本次沙箱，无残留测试进程。未跑全量 UI / 桌面测试。

## M1.11 自用：恢复 pi 原生 Claude 模型（2026-10-22）

仅移除模型规则表里对 `anthropic` 的整家过滤；模型面板、标题模型和 agent 继续共用同一目录，原生 Claude 默认模型照常保留。套餐签规则不改，OAuth 登录的原生 Claude 仍不显示签，不新增计费说明；Claude Bridge 及其它服务商规则不变。沿用现有无签布局，不引入新的视觉设计。

| 行为 | 测试 | 状态 |
|---|---|---|
| `anthropic` 在 OAuth / API Key 登录时保留模型与默认；其它登录状态或读取失败不再把它过滤；仍过滤 Azure、OpenRouter 的指定前缀及付费 / 重复 OpenAI 路径 | `packages/host/src/sessions/model-rules.test.ts` 的完整列表断言与 `keeps native Claude models and pi's default with %s credentials` | 已覆盖；旧实现下五项断言见红 |
| 即使用 Claude OAuth，按钮、服务商图标和模型列表标题都没有套餐签；可选中并关闭面板，Claude Bridge 的套餐签保持 | `packages/ui/src/chat/model-picker.browser.test.tsx` 的 `selects native Claude without a plan tag even with OAuth…` 及现有 Bridge 断言 | 已覆盖；临时把 `anthropic` 加入 OAuth 套餐名单，浏览器断言实际见红 |
| 真实 Electron → 宿主 → pi：原生 Claude 默认模型可见、可切换并发送消息；三处无套餐签；明暗截图 | `apps/desktop/e2e/models.spec.ts` 的 `lists native Claude, keeps its default and selects it without plan tags`（隔离目录、真实 pi + faux，不使用真实账户） | 已覆盖；恢复旧过滤并重建后，默认按钮错误显示“选择模型”，端到端见红；移除后通过，明暗截图已看 |

验证：`pnpm check`、构建通过；宿主集成全量 147 项、模型相关单元 26 项、UI 全量 938 项、模型相关 Electron 3 项通过。`pnpm break-check` 两项全部检出；宿主 `model-rules.ts` 聚焦变异实跑 95 个，全部 killed（100%，无缓存复用、存活或超时）。独立只读源文件复核未发现阻断（未独立执行 diff 或重跑测试）。未增加资源生命周期，无本批泄漏测试；未跑 pi 契约、其它端到端、性能 / 压力 / 浸泡、打包安装或真实账户付费请求。

全量单元 / 宿主共 3407 项，**不能宣称全绿**：首轮 3406 过，未修改的 `workspace-files.test.ts` 创建 5001 个文件用例超时；复跑 3405 过，该文件创建恰好 5000 个文件用例超时，另有未修改的 `install-service.test.ts` 等安装输出用例失败。目录超时伴随清理 `ENOTEMPTY`，输出亦有日志流 `EBADF`。目录文件曾单独 22 项全过，但最终隔离复跑仍有一次目录超时；安装服务隔离复跑 24 项通过。不改超时、不弱化断言、不顺带修这些失败，保留为本次验收的验证限制。

UI 默认测试端口 63315 被其它 worktree 的测试占用，未终止对方进程；用 `/tmp` 下导入原配置且仅覆盖 UI 项目端口的临时配置（63328）完成全量 UI 与浏览器破坏检查，仓库配置未改。初次浏览器破坏检查因端口冲突报 `MISSED`，换端口后确实进入测试并检出，不把环境启动失败当作检出。

用户确认合并与删除 worktree 后，同步 `main` 的 `a43ba71`，仅追踪表冲突，保留双方记录；实现差异仍限于本任务。合并前 `pnpm check`、构建、串行单元 3270 项、串行 UI 940 项、模型 Electron 3 项通过，使用仓库原配置，无超时调整或断言弱化。此前单元 / 宿主的失败记录保留，不改写为从未失败：本轮单元全过但仍有日志流 `EBADF` 输出。集成后首轮 UI 有未修改的右栏 0.24 秒动画例失败，单文件 13 项及随后串行全量通过；同时模型 Electron 的旧 `/faux-noop` 命令例失败，整文件独立复跑 3 项通过。本轮不冒称重新跑过宿主全量、变异测试或其它桌面旅程；未安装、未推送，主工作区无关的文档草稿不纳入提交。

## M1.11 自用：合并状态、"+A −D"和新 worktree 起点先用本机主干（2026-10-22）

本机合并、不推送时，侧栏一直显示未合并，新开 worktree 的"+A −D"也把本机 `main` 多出的提交算进去。主干的名字照旧（项目设置或 `origin/HEAD`），比较时先用本机的同名分支，本机没有再用 `origin/<主干>`（SPEC-0001"worktree 合并状态""工作区改动"，domain-model"已决定 15"）。用户随后确认新建 worktree 的默认起点也一样：本机有主干就从本机的开始，否则从 `origin/<主干>`；`list_bases` 的 `main` 改成完整 ref（协议 25）。

| 行为 | 测试 | 状态 |
|---|---|---|
| 合进本机 `main`、没推送的分支显示已合并 | `workspace-service.test.ts` "tells a branch merged into the local main branch, not pushed, merged"（改前 `pending`） | 已覆盖 |
| 只在远程合并的分支，本机 `main` 没更新前仍是待合并，更新后显示已合并 | "keeps a branch merged only on origin pending until the local main branch has it"（改前一开始就是 `merged`） | 已覆盖 |
| 本机没有主干分支时比 `origin/<主干>`，后台 fetch 照常起作用 | "fetches every few minutes … against origin without a local main branch"（原 fetch 测试改成删掉本机 `main`） | 已覆盖 |
| "+A −D"和改动面板比本机主干，本机合并、没推送的提交不算进新 worktree 的改动 | `checkout.host.test.ts` "compares a branch with the local main branch, leaving out what was merged into it here and not pushed"（改前 +4、`origin/main`） | 已覆盖 |
| 本机没有主干时比 `origin/<主干>`；同名的本地分支 `origin/main` 抢不走 | "compares a branch with origin's main branch when there is no local one"；"compares with origin's main branch by its full name…"（改成删掉本机 `main`） | 已覆盖 |

| `list_bases` 的 `main`：本机有主干时 `refs/heads/<主干>`，否则 `refs/remotes/origin/<主干>`，都没有为 `null`；项目设置的主干同样本机优先 | `worktree-creator.test.ts` "lists the local main branch…"、"lists origin's main branch when there is no local one"、"follows the project's own main branch, local first…"（改前都是 `origin/…` 短名） | 已覆盖 |
| 新建工作区页默认起点用 `main` 指的那一个，"主分支"小标签标在它上面（本机的或远程的） | `new-workspace.test.ts` "starts from the main branch…"；`new-workspace.browser.test.tsx` "chooses a new worktree from the main branch…"（本机）、"filters the bases…"（只有远程）；假客户端默认改成没有本机主干的仓库 | 已覆盖 |
| 真实 Electron：本机 `main` 比 origin 多一个没推送的提交，新 worktree 从本机 `main` 开始，"基于 main" | `apps/desktop/e2e/new-workspace.spec.ts`（原先断言的是从 `origin/main` 开始） | 已覆盖 |

破坏检查：起点部分 7 处全部检出（`/tmp/lm-break3.json`，另加变异测试指出的一处：没有 `origin/HEAD` 时 `origin` 上恰好有叫 `null` 的分支，补进 "has no main branch without origin/HEAD…"）。变异测试：`worktree-creator.ts`、`new-workspace.ts` 改动行补测试后无存活，`workspace-service.ts`、`checkout.ts` 改动行 100%（两处等价在源码注明）。合并状态与"+A −D"部分 5 处全部检出（`/tmp/lm-break.json`；`checkout.host.test.ts` 的两处第一次没写 `project: "host"`，跑到了单元层、报 MISSED，补上后检出）。

## M1.11 自用：模型列表不为不存在的目录起 pi（2026-10-22）

自用整理时宿主日志里有 22 次非请求的"pi exited"，21 次是模型列表（`list_models`）为已删掉的工作区目录起的一次性 pi：起不来（没有进程号），记成"pi started"加一次非请求退出，应答 `models_unavailable`（self-use.md"问题"）。改为宿主先看目录，不在就应答 `path_not_found`（`params.path`），不起 pi；pi 起不来时只记"pi did not start"（SPEC-0001"模型与输入框"、observability.md"pi 进程"）。另 1 次（10-11）是目录在、pi 跑了 42 秒后 Node 取工作目录遇到 `EINTR`，原因不同，没改。

| 行为 | 测试 | 状态 |
|---|---|---|
| 工作区目录不在（含 `refresh`）、原处是文件、Atrium 目录不在时应答 `path_not_found`（`params.path` 是那个目录），不问模型目录 | `packages/host/src/sessions/model-lister.test.ts` "without asking pi when the workspace's directory is gone"、"a file stands where"、"Atrium's directory is gone"（改前三项见红） | 已覆盖 |
| 真实宿主：添加项目后删掉目录，`list_models` 应答 `path_not_found`，日志里没有"pi started""pi exited""pi did not start" | `packages/host/src/models.host.test.ts`（去掉目录检查后见红） | 已覆盖 |
| pi 起不来（pi 不在、工作目录不在）：只记一条 warn"pi did not start"（`cwd`、`err` 的 `ENOENT`），不记"pi started"和"pi exited"；`exited`、等待中的请求、资源计数照旧 | `packages/pi/src/process/pi-process.test.ts` "reports a pi that cannot be started because it %s"（改前两项见红，日志和用户日志里的一样：没有 pid 的"pi started"加 `code: null` 的"pi exited"） | 已覆盖 |

`pnpm break-check` 8 项全部检出（`/tmp/fmd/cases.json`：去掉目录检查对单元和宿主各一项、`isDirectory` 换成只判空、去掉 `path`、去掉"pi did not start"、无条件记"pi started"、spawn 失败照记"pi exited"、真崩溃不记"pi exited"）。变异测试：`model-lister.ts` 改动行（host 组）16/16 killed；`pi-process.ts` 改动行（pi 组，分三段跑：`--mutate` 用逗号写多段时只认第一段）14/14 killed。界面不改：模型面板照常显示"读不到模型列表"和"重试"，请求时机不变。

## 子对话列表标模型、插话重叠、弹窗直接消失（2026-10-21）

| 行为 | 测试 | 状态 |
|---|---|---|
| 会话扫描读文件里最新的 `model_change` 与 `thinking_level_change`：取最后一条、类型不符或字段不是字符串的不算、没有为 `null`、藏在别的条目里的同名字样不算 | `packages/pi/src/sessions/session-files.test.ts` "reads the model and thinking level from the latest model_change and thinking_level_change"；真实 pi 录制文件 "reads the session id, working directory, name, first question and model of a file pi wrote" | 已覆盖 |
| 目录把文件里的模型放进 `SessionSummary.model`；级别协议不认得、provider / model id 超上限的为 `null` 而不是让整份列表被拒；草稿为 `null` | `packages/host/src/sessions/session-catalog.test.ts` "lists the model and thinking level a session's file records…" | 已覆盖 |
| 协议 23：`SessionSummary.model` 过协议校验（有值与 `null`） | `packages/protocol/src/envelope.test.ts`（会话摘要的两个样例） | 已覆盖 |
| 子对话行写"模型名 · 档位"：名字取目录、目录没有则写 id；只有 `off` 的模型不写档位；没有记录不写；行高 40px、行间 2px | `packages/ui/src/children/children.test.ts` `modelLine` 三项；`children.browser.test.tsx` "tells each child's model and thinking level in its row, and keeps the rows apart" | 已覆盖（宿主换模型到列表更新的延迟未测） |
| 折叠过的过程只留下插话行时，折叠一结束就清掉折叠动画，插话行不再盖到回复上（原先复用同一个 DOM 节点，`fill: forwards` 的高度 0 留在上面） | `packages/ui/src/chat/turn.browser.test.tsx` "keeps the steers a folded turn leaves in view clear of the reply once the fold has played" | 已覆盖 |
| 排队面板、子对话列表收起时直接消失，不播收起动画；展开动画不变 | `packages/ui/src/chat/run-control.browser.test.tsx` "grows the panel from its bottom edge…"、"closes the queue on a press outside it, the panel going at once" | 已覆盖 |

## agent 向你提问（SPEC-0003，2026-10-21）

先是实施前的 pi 契约实测，2026-10-22 实现后续登记。协议 24。

| 行为 | 测试 | 状态 |
|---|---|---|
| 工具挂着等宿主时先发 `steer`、再回答：插话应答 `queued` 并列在 `queue_update` 里，工具返回后紧跟工具结果送到模型，同一次运行 | `packages/pi/src/contract/subagent.pi.test.ts` "ask-steer: …"，夹具 `pi-1.3.0/ask-steer.jsonl` | 已覆盖（破坏检查：探针回答被改成别的文字时检出） |
| 工具挂着时 `abort`：扩展抛出的文字成为 `isError` 的工具结果、`details` 为 `{}`，不再请求模型；下一次发消息模型看到这条结果 | `subagent.pi.test.ts` "ask-abort: …"，夹具 `pi-1.3.0/ask-abort.jsonl` | 已覆盖（破坏检查：探针中止时的文字被改时检出） |
| 协议：问题与答案的形状和上限（1～4 题、2～4 个选项、各文字上限）；`answersQuestion`：单选恰好一项、多选至少一项、下标在范围内不重复、"其他"去空白后非空 | `packages/protocol/src/question.test.ts` | 已覆盖 |
| 协议：`Control.question`、`answer_question`（答案 / 跳过，空答案和两者兼有被拒）、`ToolDetails` 的 `ask_user`、`question_closed` / `question_invalid` | `packages/protocol/src/envelope.test.ts`（各样例、命令清单、错误码清单） | 已覆盖 |
| pi：读模型写的问题（去推荐标记、默认单选、去空白，推荐标记只认末尾），逐条拒绝并写明哪一题哪一项（题数、选项数、各文字上限、"Other"/"其他"不分大小写、重复选项、多选带预览、重复题名、形状不对），空白预览算没有 | `packages/pi/src/agent/ask-user.test.ts` "checkQuestions" | 已覆盖 |
| pi：交回模型的文字（答案按选项顺序、"其他"去空白、跳过、直接回复）与停止时的文字；读结局（版本不对、停止后的空 `details` 读成没有） | `ask-user.test.ts` "answerText"、"askUserOutcome" | 已覆盖 |
| pi：扩展注册 `ask_user`（声明给模型的说明和参数整体比对）、经通道问宿主、结局存进 `details`、问题不合格不问宿主、宿主拒绝的措辞、停止时通知宿主并抛出、子代理在执行和钩子两处被拒 | `packages/pi/src/agent/extension.test.ts` "ask_user"、"refusal" | 已覆盖 |
| pi：读会话文件时从参数读问题、从结果读结局 | `packages/pi/src/history/tools.test.ts` "shows ask_user's questions" | 已覆盖 |
| pi 契约（Atrium 扩展、真实 pi 1.3.0）：调用读成整理过的问题、宿主回答后模型读到答案、结局写进结果；停止时出错结果并通知宿主；`work` 子代理按宿主的参数没有这个工具 | `packages/pi/src/contract/agent-tools.pi.test.ts` "ask-user"、"ask-user-abort"、"ask-user-child"，夹具 `pi-1.3.0/ask-user*.jsonl`；`agent-call`、`agent-task`、`agent-guard`、`agent-readonly-bash-extension` 重录，只多了 `ask_user` 的声明 | 已覆盖 |
| 宿主：`work` 子代理启动参数排除 `ask_user`（含层数 2、带上下文继承父会话参数、互为父会话的环） | `packages/host/src/sessions/agent-launch.test.ts` | 已覆盖 |
| 宿主控制器：问题进控制状态、回答 / 跳过、对不上或答不全的拒绝且问题保留、插话代替回答（先摘下问题、pi 收下插话后才回答）、排队里的插话也算、插话被拒或被处理时问题恢复并重新发布、`/` 命令不算、停止当场作废、插话途中停止不恢复、pi 退出和扩展放弃时作废、同时只有一组 | `packages/host/src/sessions/session-controller.test.ts` "asking you (SPEC-0003)" | 已覆盖 |
| 宿主中转：交给控制器、回答后回复扩展、agent 子代理（任意层）回 `ask_user_unavailable` 而你开的子对话能问、作废的不回复、扩展放弃时通知控制器、pi 已不在时的放弃安静处理、已有问题时拒绝 | `packages/host/src/sessions/agent-relay.test.ts` "ask_user (SPEC-0003)" | 已覆盖 |
| 宿主：会话"待回答"算上问题，回答后清掉；路由转 `answer_question` | `session-manager.test.ts` "waits for the questions its agent asked"、`router.test.ts` | 已覆盖 |
| 客户端：`answerQuestion` 发出命令 | `packages/client/src/atrium-client.test.ts` | 已覆盖 |
| 界面状态：单选 / 多选 / "其他"的选取、算不算答了、下一道没答的题、拼出答案、按会话保存草稿（换问题、题数不对时重来） | `packages/ui/src/chat/question-state.test.ts` | 已覆盖 |
| 提问卡片：顶行（没有图标，`agent` 字母依次跳动、减弱动效时不动，`agent` Syne 橙 / `/` / `在问你` / `已答 N / M`）、题名标签、单选 / 多选标签与"已选 N"、序号即控件（圆 / 圆角方、选中蓝底勾）、推荐标记、单选 0.2 秒后到下一题、多选勾选计数、没答完不能提交、"其他"多行框（铺满整行、聚焦、长高、⏎ 确定、⇧⏎ 换行）、数字键不进输入框、↑↓ 移动、← → 换题、跳过、草稿保留、预览跟着指向的选项、只有问题时卡片区也显示、在对话框下面 | `packages/ui/src/chat/question-card.browser.test.tsx` | 已覆盖 |
| 输入框：有问题时占位文字换掉，回车和 ⌘回车都按插话发 | `composer.browser.test.tsx` "while the agent's questions wait" | 已覆盖 |
| 过程轨道：文字（正在问你 / 问了你 / 跳过 / 直接回复 / 已取消）、折叠摘要"问了你 N 个问题"、记录行、Markdown；等你时问号标题行"等你回答"和光环节点、答完橙点和常显记录、点开看全部选项、停止后灰点不是死路 | `turn-layout.test.ts` "the agent's questions on the rail"、`turn.browser.test.tsx` "the agent's questions" | 已覆盖 |
| 端到端：真实 Electron + pi + faux 模型，agent 问两题，卡片点选提交，模型同一轮读到答案、标签"待回答"起止、过程记录；有问题时在输入框发消息，卡片消失、模型同一轮先读到"直接回复"再读到你的话 | `apps/desktop/e2e/ask-user.spec.ts` | 已覆盖（负对照：去掉"有问题时回车按插话发"后第二条变红） |
| 泄漏：控制器 200 轮（回答、直接回复、放弃、停止）每次调用都得到回答、不留问题、计时器和监听回到基线、问题对象可回收；界面 8 轮卡片出现消失不留脱离的 DOM | `session-controller.leak.test.ts` "answers and lets go of the agent's questions"、`apps/desktop/e2e/ask-user.leak.spec.ts` | 已覆盖（负对照：故意留住问题对象 / 卡片节点时都变红） |

破坏检查（2026-10-22）：新行为的 50 个改坏点全部检出；第一次没检出的 4 处，3 处补了测试，1 处是多余的守卫，已删掉。

破坏检查（2026-10-26，顶行改版）：4 个改坏点（`agent` 写回一行纯文字、`在问你` 改名、计数加回`· `、点阵全部跳过不画）全部检出。改动只涉及 `question-card.tsx`（浏览器测试覆盖）和 `design/dots.ts`（纯绘制，不在变异分组），不跑变异测试。

破坏检查（2026-10-28，顶行去掉点阵问号、改成 `agent` 字母波浪，原型 `question-card-header-v4-prototype.html` 的乙一）：6 个改坏点（去掉逐字母的错开、波浪只播一次、减弱动效时照样动、整词的辅助功能名称改掉、`agent` 改回正文色、行首加回问号图形）全部检出。`dots.ts` 里画点阵问号的函数随之删掉。改动只涉及 `question-card.tsx`、`styles.css`（浏览器测试覆盖），不在变异分组，不跑变异测试。

变异测试（只变异改动的行，2026-10-22）：协议 `question.ts` 100%（76）；pi `ask-user.ts`、扩展的 `ask_user` 部分、`history/tools.ts` 100%（255），`ask-user.ts` 里 5 处为类型写的判断与一处空白预览后的上限参数注明等价；宿主控制器、中转、启动参数的改动 100%（控制器 100、中转 28、启动参数 5 个变异；过程中补了"插话被拒后重新发布问题""停止后不恢复""回复途中不收新问题""pi 已不在时放弃"四个测试，删掉了两处多余代码）；界面 `question-state.ts`、`turn-layout.ts` 的改动 100%（175），为类型写的判断注明等价。`question-state.ts` 加进了界面的变异分组。

已知不稳（2026-10-22）：`children.spec.ts` "the agent opens two children" 在和其他端到端文件一起跑时 1/4 次失败（第二个子对话的来源行 5 秒内没出现，测试自己注明两条通知可能分开到），单跑 7/7、整组复跑 3/3 通过；和这次改动无关，未修改。整套界面测试在新 worktree 冷缓存第一次跑时 4 个文件导入期 SyntaxError，单跑与热缓存重跑全过（同路线图已记的现象）。

### 三方审查后补（SPEC-0003，2026-10-22）

GPT-6 Astra、Grok 4.7、Claude 子代理各自只读审查，合并去重后修了下列问题；每条先写会红的测试，再改代码。

| 问题（来源） | 改法 | 测试 | 状态 |
|---|---|---|---|
| `ask_user` 没声明 `executionMode: "sequential"`，同一批两次提问时第二组被宿主拒成 `agent_bad_request`（三方） | 声明串行；本机 pi 1.3.0 已核对整批会依次执行 | `extension.test.ts` 声明比对；契约 `agent-tools.pi.test.ts` "ask-user-two"（夹具 `ask-user-two.jsonl`，改前第二组同时发出） | 已覆盖 |
| 换题时选项重挂，焦点掉出卡片，按键失效（三方） | 焦点在卡片里时换题，焦点跟到新题选中的或第一个选项 | `question-card.browser.test.tsx` "keeps the focus in the card…"、"moves the focus onto the next question's options…" | 已覆盖 |
| 提交失败后按钮永久锁住（三方） | 发送结果回传卡片，没发出就解锁；`question_closed` / `question_invalid` 有中文说明 | "lets you send again when sending failed…"；`chat.browser.test.tsx` "describes" 两项 | 已覆盖 |
| "其他"没有 4000 字上限（Claude、Grok） | `maxLength` | "takes no more than 4000 characters…" | 已覆盖 |
| 草稿在切会话（视图加载中）、直接回复被退回时被清掉（Astra、Claude） | 只在有新问题时换掉草稿，问题短暂不在时保留 | "keeps what you picked while the questions are away…" | 已覆盖 |
| ⌘ + 数字被卡片当成选择，和切标签冲突（Claude） | 带 ⌘、Ctrl、Alt 的按键不处理 | "leaves keys held with ⌘, Ctrl or Alt…" | 已覆盖 |
| 多行"其他"和带引号的问题会拆开交回模型的一行一题格式（Grok） | 问题、选项、"其他"都写成 JSON 字符串 | `ask-user.test.ts` "answerText"；`ask-user.jsonl` 重录（只多了引号）；端到端预期同步 | 已覆盖 |
| 胶囊条盖住提问卡片底部的按钮（Grok；对话框卡片同样） | 对话框、出错、提问卡片都放进输入框的容器，胶囊条在卡片上方 | "sit between the capsule bar and the box…"；真实应用截图核对 | 已覆盖 |
| pi 规范化过的参数（`null`、`"true"`/`"false"`）在读历史时读不出，提问退回普通步骤（Astra） | 读历史时照 pi 的读法 | `ask-user.test.ts` "reads a call's arguments as pi ran them…" | 已覆盖 |
| 宿主拒绝、别的版本的结果被显示成"问题已取消"、原样输出看不到（Astra） | 读不出结局又不是空的结果按普通工具步骤显示 | `history/tools.test.ts` | 已覆盖 |
| 直接回复被退回后"待回答"时间被重置（Astra、Claude） | 问题的等待时间取 `askedAt` | `session-manager.test.ts` "keeps since when the questions wait through a direct reply pi refused…"（改前差几毫秒） | 已覆盖 |
| 没有控制器时调用不回复、工具一直挂着；回复途中的新问题回 `agent_failed`（Claude、Grok） | 前者回 `agent_failed`；控制器新增 `asking`（问题开着或回复在途），中转据此回 `agent_bad_request` | `agent-relay.test.ts`、`session-controller.test.ts` | 已覆盖 |
| 宿主不查题名、选项名重复和多选带预览（Claude）；`ToolDetails.questions` 无上限 | 通道 schema 加校验；`max(4)` | `channel.test.ts` | 已覆盖 |
| 复制成 Markdown 缺完整问题（三方） | 每题写题名、问题和回答 | `turn-layout.test.ts` | 已覆盖 |
| 多选时取消"其他"会清掉写过的字（Grok） | 不选时留着，选回来还在 | `question-state.test.ts` "keeps the other answer's text…" | 已覆盖 |
| 结束后的文字颜色不是 `--text-muted`（Grok） | 改色 | `turn.browser.test.tsx` 颜色断言 | 已覆盖 |

破坏检查：上面 19 处全部检出；补变异测试时又加了 3 处（停止期间早先的回复不清掉后来的问题、读历史时数字和 `null` 的结果、Markdown 里问题的换行），也都检出。

变异测试（审查修复后复跑改动的行，2026-10-22）：pi 组 `ask-user.ts`、`history/tools.ts`、`channel.ts` 的改动、宿主组控制器 / 中转 / 启动参数的改动、界面组 `question-state.ts` 和 `turn-layout.ts` 的改动，存活的都已补测试或在源码注明等价（控制器里"回复在途时不会有另一个回复"那处）。复跑结果：pi 99.65%（1 个存活，随后补测试检出）、宿主 100%、界面 99.49%（1 个存活，随后补测试检出）。

最终验证（2026-10-22）：`pnpm check` 通过；单元与宿主串行 3532 项中 3531 过，1 项 `setup.host.test.ts` "updates pi…" 失败，这次没改这个测试和它覆盖的代码，单跑 3/3 通过；界面 964 项全过；控制器泄漏 3 项通过；端到端 `ask-user`、`ask-user.leak`、`run-control`、`children`、`chat` 共 15 项一起跑全过；pi 契约本次相关的 `agent-tools`（9 项）、`ask-steer` / `ask-abort` 通过，其余失败都是旧场景缺 1.3.0 夹具。

记录、未改的：preview 按等宽原文显示（用户定，SPEC 措辞已改）；以 `/` 开头的普通回复被当成命令（SPEC 写成已知限制）；卡片出现时没有屏幕阅读器播报；后台会话结束后草稿留到页面关闭（每会话一份，有界）；插话途中 pi 退出时，同一条消息可能既回到排队又退回输入框（Grok 指出，插话本来就有的竞态），按用户要求在本分支修了，见下表最后三行。

端到端排查（2026-10-22）：界面泄漏测试第一次写时，⌘T 后没等新标签就打字，6 次里约 1 次消息落到别的地方、卡片不来、超时；改成先等"新会话"标签，泄漏和端到端各重复 6 次 18/18 通过。`run-control.spec.ts` "queues a message during a run…" 在和其他文件一起跑时失败过 1 次（第一条消息后没出现"停止"），单跑 4/4、组合复跑 4/4 通过，未改。
| 插话还在等 pi 应答、或排在别的插话后面时 pi 退出：消息被放回排队，同时命令报 `pi_unavailable`，输入框（或排队面板的"插话"）又退回一份（Grok，既有竞态） | 退出时给这些插话打上"已回排队"，它们的命令应答 `queued`，不再报错；排在后面的不再发出 | `session-controller.test.ts` "puts a steer pi had not answered when it went back in the queue once…"、"puts steers waiting their turn…"、"keeps a queued message steered as pi went in the queue once"（改前三项都报 `pi_unavailable`）；破坏检查 3 处检出 | 已覆盖 |

## 已知不稳的测试修复（2026-10-23）

testing.md"已知不稳的测试"表里的项逐个复现、找根因、修掉，修好的从表里删去。压力测试用 `pnpm test:stress`（默认 13 份并行、每份一个 worker），修前修后用同样的方式跑。

| 测试 | 根因 | 修法 | 稳定性证据 | 状态 |
|---|---|---|---|---|
| `pi-config.test.ts` "queues several same-path saves in order while unrelated paths remain writable" | 生产代码的竞态：`save()` 先 `await locate()`（读 pi 的环境、`realpath`、`lstat`）再进同路径的队列，后发的保存若先找到文件就插到前面，读到旧版本，应答 `config_conflict`。SPEC 写的是"同宿主对写入串行受理"，按到达的顺序受理不改外部行为 | 同一（工作区, 文件名）的保存按调用的顺序进同路径的队列：每次保存先等同一文件上一次保存排进队列，再找路径；不同文件互不等待 | 新增 "accepts same-path saves in the order they were made, even when finding the file takes the earlier one longer"（第一次保存等 pi 的环境，第二次先找到文件），修前 3/3 失败；破坏检查 3 处检出。修前压力 39 次失败 8 次，修后 104 次全过。2026-10-24 变异测试 host 组 `pi-config.ts` 82.16%（整个文件，存活多在这次没改的代码里）；新代码里"受理完只删自己的那条"的两个变异存活，补 "keeps the order of a save made while another still finds its file, behind saves already let through"（四次保存，第三次找文件时发第四次），破坏检查 2 处检出；完全不删的两个变异只多留一条已结束的记录，同 `saves` 的已有注释，没法从外部看到。补测试后压力 78 次全过 | 已修 |
| `workspace-files.test.ts` "lists a directory of exactly 5000 entries whole"（同文件 5001 的用例同理） | 测试本身：每次用 `await writeFile` 逐个建 5000、5001 个文件，机器忙时建文件全机竞争，13 份并行时每份约 6.5 秒，超过 5 秒期限 | 改用 testkit 新增的 `numberedFiles(count)`：只读的共享大目录，跨运行复用，全局初始化先确保在（testing.md"测试里的大目录"）；5000 的用例仍用真实 git，用 `gitSceneEnv` 拦住它往上找仓库 | 修前压力 78 次两个用例全部超时，修后 78 次全过。`shared-directory.test.ts` 3 项，破坏检查 6 处检出 | 已修 |
| `install-service.test.ts`（表里 install-job 一行的"同类用例"） | 测试本身：每个测试新写 `brew`、`pi` 两个可执行脚本，macOS 首次运行前的检查排队，13 份并行时脚本迟迟不出输出 | 链接到 testkit 共享的 shell pi，脚本按被调用的名字区分 `brew` 和 `pi`（testing.md"测试里的可执行文件"） | 修前压力跑 `setup/` 52 次："holds pi's starts…" 52 次全败，"runs one job at a time" 46 次、另 4 个用例 3～11 次超时；修后 52 次全过。破坏检查：把替身里的 `brew` 分支改坏，"installs Node…" 检出 | 已修 |
| `workbench.browser.test.tsx` "names a chat by its alias, else its first session's title, else as new" | 测试本身：夹具的 `session()` 各自取 `Date.now()` 作更新时间，对话列表按最近活动降序，跨毫秒建的后两个对话排到前面 | 三个对话的更新时间在测试里写定（相差 1 秒） | 在建夹具前插入 2 毫秒忙等可稳定复现（修前失败、行序为"新对话、周报、解释 merge-tree"），修后同样插入忙等通过；压力结果见下 | 已修 |
| `changes-pane.browser.test.tsx` "opens from nothing in 0.24 s, the panel at its width from the start, and closes back to nothing before it goes" | 生产代码：打开的过渡在时间线上已到头、还没被标记结束时就收起（或打开到一半收起），打开的过渡被 `transitioncancel` 取消、收起的过渡接着开始；处理函数把这次取消当成收起结束，面板在收起开始时就没了（宽度还是 320 或 96.5 时面板已移除）。用户看到的是打开中途收起时面板一下子消失，不按 design-language"右栏打开收起"滑出 | 窗格的过渡结束或取消时，只有窗格不再有动画（`getAnimations()` 为空）才移除面板；结束和取消用同一个处理函数。测试里打开、收起改用 `flushSync` 当场画出、当场读过渡，不再隔帧读墙钟 | 新增 "stays while it closes when closed partway through opening, and goes once it has closed"（打开暂停在 120ms 处再收起），修前失败、面板在收起途中已不在；破坏检查 3 处检出，去掉 `onTransitionCancel` 未检出：Chromium 在这几种取消之后都会紧接着再发一次 `transitionend`，取消的处理留作防御。修前整套界面默认并行 6 次失败 2 次，修后 8 次全过；压力 13 份并行 4 轮这个文件 52 次全过，和另外四个文件一起 4 轮 52 次全过 | 已修 |
| `markdown.browser.test.tsx` "shows a block's buttons in place of its language while hovered or focused inside" | 测试本身：真实的指针停在前一个测试（可能是别的文件）留下的位置，正好在新代码块上时，"静止"状态读到的就是悬停状态 | 先把指针移开（`unhover`）并等静止状态，再悬停、移开、聚焦 | 在测试开头把指针停在代码块将出现的位置可稳定复现：修前失败（`expected ['0','1'] to strictly equal ['1','0']`，与压力下的失败相同），修后通过。修前压力（13 份并行，混合五个文件）143 次失败 1 次 | 已修 |
| `markdown.browser.test.tsx` "draws Mermaid flat in neutral colours, and switches to its source and back"（不在表里，压力测试时发现） | 测试本身：缩放按钮等图适配好（Streamdown 写好缩放比例）才出现，比图的节点晚一点；测试在节点一出现就读按钮，机器忙时只读到"看源码、复制、放大" | 先等缩放比例出现再读 | 修前同样的混合压力 143 次失败 5 次，失败时记下的按钮少了三个缩放按钮；修后见上一行的 52 次 | 已修 |
| 压力测试脚本（`pnpm test:stress --project ui`） | 工具本身：ui 项目沿用页面的固定端口（`strictPort`），各份同时启动时只有一份拿到浏览器服务端口，其余一个测试都没跑，报告却被算作通过 | ui 项目在测试里不要求固定端口；一个测试都没跑的那份算作出错 | 修前 4 份里 3 份"ran no tests"，修后 4 份都跑了 | 已修 |
| `streaming.browser.test.tsx` "streams through the transcript as the app does, never losing text, and ends as the finished reply renders"（第一部分：表格；用例 2026-10-24 改名为 "…never dropping a finished block or shrinking it…"） | 生产行为：流式中表头行先以原文（`\| 模块 \| 职责 \|`）显示，分隔行写完才变成表格，文字一下子变少；平滑揭示按真实帧推进，哪一帧落在分隔行里看机器忙不忙 | 用户 2026-10-24 定改产品：先改 SPEC-0001"回复渲染"和 design-language"表格"，再加 `withoutUnfinishedTable`（`markdown-transforms.ts`）：流式时末尾以 `\|` 开头的表头行和写了一半的分隔行先不显示，分隔行列数够了直接出表格；代码块里的不算；输出结束（含停止）时全部显示 | `markdown-transforms.test.ts` "withoutUnfinishedTable" 26 项；`markdown.browser.test.tsx` "shows a table streaming in only once its delimiter row has all its columns…"（修前失败，表头以原文显示）、"shows a table's header as written once a reply that stops before its delimiter row has ended"；破坏检查 12 处检出；变异测试 ui 组 `markdown-transforms.ts`：新代码无存活（不可达的 `?? ""` 和"表头之后没有围栏"注明等价），整个文件 93.33%，存活的 22 个都在原有的 `remarkReplyData` 等函数里，这次没改。修后同样的压力 52 次里该用例仍失败 3～4 次，原因是图块（见 testing.md 不稳表），未修完 | 已修（与下一行合起来） |
| `image-preview.browser.test.tsx` "fills the application window with the chosen dark canvas and fits the original"、"does not enlarge a small image and restores the trigger after the close button" | 生产代码：预览区的大小只等 ResizeObserver 第一次回调，在那之前按 1×1 排版；回调要等下一次绘制，机器忙时图片先解码好，图就先按 1×1 适配（宽 1px），标签写着"1%" | 打开时（`useLayoutEffect` 里 `showModal` 之后）先同步量一次画布，再交给 ResizeObserver 跟着变 | 新增 "fits the image to the canvas even when it has loaded before the canvas was first observed"：把 ResizeObserver 换成从不回调的替身，图比画布高、按画布高度适配；修前失败（图按 1×1 适配，和整套里的失败相同），修后通过；破坏检查 2 处检出（去掉同步测量、高度量成宽度）。修前整套界面默认并行 15 次失败 3 次；修后整套 6 份并行 3 轮 18 次、13 份并行 2 轮 26 次都没有这两项失败 | 已修 |
| `workbench.browser.test.tsx` "lists every session of the container in its history, newest first, marking open ones"（不在表里，压力测试时发现） | 测试本身：和"names a chat by its alias…"同一类，`list()` 里的 s1、s2 各自取 `Date.now()`，跨毫秒时 s2 更新、排到前面 | 这两个会话的更新时间在测试里写定（相差 1 秒） | 在 `list()` 建 s2 之前插入 2 毫秒忙等可稳定复现（修前这一项失败、其余 107 项不受影响），修后同样插入忙等通过。修前混合压力 52 次失败 1 次 | 已修 |
| `streaming.browser.test.tsx` 同一用例（第二部分：量法） | 测试本身：揭示按真实帧推进，机器忙时帧间隔大、一次推进得多，这次循环里揭示走多远每次不同；走得远时越过 Mermaid / PlantUML 的结束围栏，源码按 SPEC 换成图，图没画好时块里只剩工具栏或"正在画图…"。揭示确定地走完全文后又发现，块公式、链接、"```mermaid" 换行前的语言名、没写完网址的图片，都会从源码换成渲染结果，文字自然变少：断言"整段文字只增不减"和 SPEC 的渲染方式本身冲突，以前只是因为揭示到不了这些地方才通过 | 用户 2026-10-24 定只改测试、产品不改：① 平滑揭示改用测试里一帧帧推进的假 `requestAnimationFrame`（每个增量一帧、相隔 1/60 秒，再补 120 帧），揭示每次都确定地走完全文；并断言流式中两张图都已出现。② 断言改成块级不变量（用户选的 A）：顶层块数只增不减；一个块不再是最后一块后文字只增不减；图块不参与，交给结束时"和一次性渲染一致"。用例改名 | 改量法前，揭示走完全文后每次都失败（确定）。破坏检查 3 处检出：每来一个增量揭示进度减半（已写完的块消失）、流式时去掉第一行、已写完的块截短。同样的压力（13 份并行 4 轮，混合 streaming、markdown、image-preview、workbench、diff-viewer 五个文件）52 次全过；修前 39 次败 29 次，改表格后 52 次败 3～4 次 | 已修 |

### 独立审查后补（GPT-6 Astra，2026-10-24）

| 问题 | 改法 | 测试 | 状态 |
|---|---|---|---|
| `withoutUnfinishedTable` 把后面还有文字的围栏（`` ```not-a-close ``）当成闭合，代码里的表头行被藏起来，违反 SPEC"代码块里的不算" | 开、闭围栏分开判断：闭合只认同种字符、不短于开围栏、后面只有空白；反引号围栏的信息串里不能有反引号（CommonMark） | `markdown-transforms.test.ts` "withoutUnfinishedTable"：两条一起新增和改动 17 项，其中 2 项按真实渲染的结果由"原样显示"改为"藏起来"；修前先写的 12 项里 8 项失败，另 5 项是写实现时为破坏检查补的。`markdown.browser.test.tsx` "holds back, while streaming, just the trailing lines that the renderer leaves as a paragraph, not code or table rows"：27 段文字逐段用真实渲染（非流式的 Markdown）对照，末尾落在段落里的才该藏；修前跑时（当时 22 段）7 段不一致 | 已修 |
| 分隔行不带开头竖线（`--- \| ---`）、或表格吃进不带竖线的行之后，下一行数据被当成新表头藏起来；另外段落里一行以竖线开头的文字之后，下一行永远不藏，而真实渲染里表格可以从那里开始 | 某行是否已在表格里：往上找到空行、标题或围栏为止，中间有"表头 + 列数相同的完整分隔行"就算；不再看上一行是不是以竖线开头 | 同上；两条合起来破坏检查 12 处检出。2026-10-25 变异测试 ui 组 `markdown-transforms.ts`：新代码先存活 15 个，补 11 项（每项也加进真实渲染对照，现在 38 段），3 个注明等价（短于三个的波浪线不会闭合三个以上的围栏、第一行之前当空行、表头和它下一行不会是围栏）；之后新代码无存活，整个文件 94.21%，存活的 22 个都在这次没改的函数里 | 已修 |
| `numberedFiles` 重建有 TOCTOU：两个进程都看到旧目录不全，A 挪走旧的、放好完整的，B 接着把 A 刚放好的挪走删掉 | 按代命名、从不挪动或删除（用户 2026-10-24 定，不用跨进程锁：锁的持有者被杀会留下锁，抢锁又会回到竞态）：不全的留着，新的放到下一个空着的名字；改名失败就重新看，取别人放好的 | `shared-directory.test.ts` "never moves or removes a complete directory another caller published while it was rebuilding a purged one"（受控交错：一方看到不全后停住，另一方放好再放行），修前失败（另一方放好的目录 inode 变了）；"takes the copy another caller published just before its own…"、"passes over a name something else holds"、改写的"builds the directory again under the next free name…"；破坏检查 7 处检出 | 已修 |
| `pnpm test:stress` 只看每个测试的结果，丢掉子进程的退出码：导入失败、`afterAll` 抛错、运行级错误、被杀，只要报告里有测试就算通过 | 一份也算没跑好：被信号杀掉、文件在测试之外失败（报告里文件 `status: failed` 且带错误）、没有失败的测试却非零退出或报告 `success: false`；`ATRIUM_STRESS_RUNNER` 换成替身供脚本自己的测试用 | `scripts/stress.test.ts` 7 项（替身 Vitest 写报告、按要求退出或被杀），修前 4 项失败；破坏检查 7 处检出 | 已修 |

## M1.11 自用："正在压缩上下文"的小猫与扫光（2026-10-26）

用户嫌"正在压缩上下文…"光秃秃、扫光不明显。原型 `prototypes/compacting-indicator-prototype.html` 比较四个方向（A 刻痕轻压 / B 点阵收拢 / C 小猫受压 / D 分段条压缩），用户选定 C，扫光选"加宽提亮"，`.atrium-shimmer` 全局一起换（design-language"运行中压缩""扫光文字"，SPEC-0001"压缩"）。轨道上不变（静态刻痕 + 扫光）；对话区底部换成"进行中"的版式：18px 小猫贴左、文字 24px 起，小猫每 2.4 秒压扁一次、压时眼睛睁大，眨眼照旧；这一行带 6px 淡入的入场；减弱动态效果时停在被轻轻压着的静帧。

| 行为 | 测试 | 状态 |
|---|---|---|
| 对话区底部一行：`role=status`、小猫（`compacting-cat`）在文字前、文字扫光、`pl-6` 版式、带入场（`atrium-compacting-line`），结束后消失 | `packages/ui/src/chat/chat.browser.test.tsx` "says at the bottom of the conversation while pi compacts, the cat pressed flat" | 已覆盖 |
| 扫光全局换参数（1.9 秒一轮、亮带 32%–68%、47%–53% 满亮平台）："进行中"、运行中步骤、压缩提示共用 | 视觉参数无断言；两处既有用例仍断言 `.atrium-shimmer` 类名 | 已覆盖（参数未测） |
| 压扁与睁眼的动效、减弱动态效果的静帧 | 纯 CSS；浏览器测试切不了减弱动态效果（同空状态的光标） | 未测 |

5 项 `pnpm break-check` 全部检出（去小猫、去入场类、去 `pl-6`、去扫光、改 testid）。改动不在变异分组（视图组件与 CSS），未跑变异测试。真实渲染明暗截图已看（一次性用例渲染真实 `Transcript`，用完即删）。

## MP4 手机连接核心（SPEC-0005，2026-10-26，进行中）

| 范围 | 用例与证据 |
|---|---|
| Noise IK / IKpsk2、SAS、分帧 | `AtriumNoiseTests`：cacophony 公开向量、TS/Swift 固定记录逐字节互通回放、负例与固定种子输入。篡改负例改为从 TS 记录重建响应方后直接断言 `.decryptFailed`，已删除 `withKnownIssue`，最终无 known issues；自实现固定种子 fuzz 不称为独立差分验证 |
| 日常连接、同步边界 | `RemoteConnectionTests`：IK、生成的 protocol 26 `hello` 不带 token、clientId=deviceId、旧代发送和同步结果不能污染新连接、pending 用 IK 补确认、配对通道交接 |
| 安全与连接状态 | Noise 内的 `device_unknown` / `revoked` 清理；外层 4401/4409 不删除；离线时间、版本不符、无网、relay 不通；1→30 秒退避与抖动、心跳、15 秒握手超时 |
| 配对与存储 | `PairingFlowTests` / `HostStoreTests`：先存 pending、SAS 一致、确认后正式记录、拒绝理由、丢失确认答复恢复、全局设备密钥不随主机删除、旧正式记录不被新 pending 覆盖、损坏私钥不静默轮换 |
| 通道 | `SecureChannelTests`：双向分块、自动心跳回复、篡改与未知帧关闭、超限、30 秒分块截止时间、关闭码；`ChannelCloseTests`：阻塞发送只能由 close 解开，优雅关闭在注入时钟 2 秒后强制释放 |
| 审查后回归 | 只读审查发现的 4 类问题均先见测试失败：background→inactive→active 未恢复、短暂无网后卡住、关闭等待 writer 无界、确认写失败/本地超时丢 pending。另修按唤醒次数而非实际时间计配对倒计时 |

连接核心阶段验证：全 Swift 111 项 / 17 suites 通过；当时篡改回放产生的 2 项 known issues 已由上述直接拒绝断言替换。`pnpm break-check apps/ios/Testing/remote-breaks.json` 最终13/13检出（核心11项，加UI即时交接与非法粘贴两项）。回归修复后 `pnpm check` 通过。全仓 `pnpm test` 首轮 3791 过、`scripts/boundary.test.ts` 1 项 5 秒超时；该文件单独重跑 8/8 通过，未修改其超时或断言。之后完整重跑：TypeScript 3792/3792、Swift 111/111 通过，保留首轮超时记录。

### 配对界面、本机互通与平台验证补充

- `AtriumUI/Pairing/`：系统样式测试接线，只有扫码/粘贴、SAS/倒计时、失败恢复与完成交接；协议状态仍唯一来自 `PairingFlow`。`PairingModelTests` 验证非法输入不联网、重复提交只连一次、取消后旧回调无效、通道只交接一次。审查发现成功后必须点击“完成”才交接的缺口，先复现成功后直接dismiss会abort，再改为成功回调立即交接，完成按钮只关闭页面；回归与限定复查通过。XCUITest 曾复现布尔 sheet 与可选 model 同帧设置导致空白，改成按 model 身份呈现后通过。
- `node apps/ios/Integration/run.mjs`：真实本机 relay（路径前缀 `/atrium`）+ 不改动的 TS MP0 假宿主 + 正式 Swift WebSocket/Noise；连续三次通过配对/SAS、hello、IK重连、心跳ACK、撤销断链、旧密钥拒绝。`--negative-control` 错误SAS使指定断言失败；启动期/构建期SIGTERM正确清理，relay资源归零、临时目录无残留。**MP0协议25仅在测试显式覆盖，不是协议26生产宿主/faux-pi契约。** 普通Swift测试对此项明确skip，专用命令实际执行。
- 平台钥匙串：最初在XCUITest Runner调用返回 `-34018`；测试target entitlement只进入bundle模拟段，实际Runner仍无权限。迁到真实App进程的DEBUG固定检查后通过，已撤掉旧Runner链接/entitlement配置。仅使用固定测试service与UUID account，所有读写与清理精确限定；验证生产KeychainStore插入、覆盖、读取、删除、缺失及实际 `AfterFirstUnlockThisDeviceOnly` 属性。把生产属性改成 `WhenUnlockedThisDeviceOnly` 的负对照使该用例失败，恢复后通过。Release构建通过且产物不含检查入口/命名空间标记。
- 最后 `pnpm test:ios`：Swift报告115项/19 suites，无known issues（其中1项实时互通默认skip，另由专用runner实跑）；模拟器3项全部通过，xcresult `Test-Atrium-2026.10.26_16-33-59-+0800.xcresult` 明确记录首页、`PairingKeychainTests/testProductionKeychainRoundTripAndProtection()`、`PairingScreenTests/testPasteValidationAndCameraFallback()`。
- 明暗真实截图：`apps/ios/.build/shots/pairing-light/`、`pairing-dark/`（manifest注明对应附件），已查看入口与非法链接/相机备用状态。初次用 `AppleInterfaceStyle` 启动参数未改变主题，两组实际都是深色，不算明暗验证；改由模拟器主题设置后重新拍摄。提交后收起键盘，错误不再被遮挡。

最终 `pnpm check` 通过；已将两个互通脚本明确登记为knip入口、把系统Swift编译器列入外部二进制名单（不忽略源码）。UI交接修复后重新跑完整 `test:ios`，上述三项从最终xcresult再次核对为Passed。

边界：系统样式只是测试接线，未验收为最终视觉；首页连接仍显示“正在同步”，不会替代同步层擅自标“已连接”。未测真机扫码/权限弹窗、锁屏首次解锁、实际备份迁移、七天续签、真实生产宿主/faux-pi、WAN/TLS故障代理。此节不标完整MP4完成。

### MP4 冻结基线 323e7b7 后的审查修复

- 测试资源：`ConnectionResourceScope` 对 `RemoteConnectionTests` 每个 case 注册连接，成功或抛错均 stop，并检查弱引用释放及手动时钟 sleeper 归零。原 pending IK / inactive / handover 三条成功路径先在新退出断言下失败；补 teardown 后26项通过。`teardownAfterThrow` 特意抛错验证失败路径；`Testing/resource-breaks.json` 删除 stop 的破坏检查1/1检出。假宿主会话由 Harness 显式持有，不再依赖遗留 writer 泄漏保持连接；无应答心跳测试在每个发送时点读取真实密文，避免把排队等同发送成功。
- 存储所有权与恢复：`PairingFlowTests/cancelledConfirmationRecovers`、`PairingOwnershipTests`、`PairingRevocationTests`、`StorageRecoveryTests` 分别覆盖取消后 pending/IK、同内容新代与迟到成功/拒绝、配对期认证撤销及密钥范围、host/pending 各自删除失败/部分成功/前台和显式重试、旧清理不得使新 pending 的后续确认失权、同步不中断但确认写失败持续可见。App 注入同一个 HostStore，`MainThreadCheckingStore` 验证生产加载与配对路径不在 MainActor 做钥匙串 IO；持久格式不变。
- 界面审查：`PairingRestorationTests` 实际将同 host 新 relay pending 接到新端点并用 IK 替换；`PairingPresentationTests` 验证离线绝对时间和非 pairing QR 不中断取景；`PairingStoragePresentationTests` 验证网络状态不变时存储问题仍刷新；`PairingModelTests` 验证成功交付前再核对 claim、配对持有的存储错误也在回前台时只重试一次，取消与 superseded 不复活。没有新增取消后自动 IK 或配对恢复按钮。
- 本轮存储/界面定向 Swift 验证66项/10 suites 通过（warnings-as-errors），新行为先见红灯。`storage-review-breaks.json` 15/15、适配新实现后的原 `remote-breaks.json` 13/13、`resource-breaks.json` 1/1 全部检出。当前代码的只读所有权复查未发现破坏性路径；指出的 model 前台重试遗漏已补红绿测试。未跑本轮全量 check/test、Xcode/模拟器和真机验收；上述旧阶段的平台证据不冒充本次复验。
- 累计缓冲：`BufferBudgetTests` 验证出站2 MiB含在途密文、精确边界/加1字节、很多小帧、真实发送完成才归还、迟到完成不减负、阻塞writer的abort/owner释放；入站16 MiB与1024条双限额、空消息、next归还、旧代隔离、取消/finish后计数与保留队列归零。`RemoteBufferIntegrationTests` 用实际Noise通道和RemoteConnection接收循环验证1025条空消息及16 MiB+1字节都会明确背压断线，旧队列清空，新代只交付新消息；两条8 MiB消息完整分帧/解密且nonce连续。没有用静默丢消息或离线重发规避压力。
- 预算单独定向26项/5 suites 通过，`buffer-breaks.json` 12/12检出；最终把本轮相关存储、连接、界面和预算回归合跑，92项/15 suites 通过（warnings-as-errors）。Swift格式、Swift文档lint和diff检查通过；只读预算审查无高可信阻断项，未独立跑测试。当时尚未直接组合测RemoteConnection出站溢出后的完整重连，下节已补该缺口。仍未用分配器测Data释放；已有阻塞writer/计数/队列清空和连接溢出回归不能冒称整机内存或长期泄漏验收。

### 2feea5b 后的收尾验证

- `RemoteBufferIntegrationTests/outboundOverflowReconnects` 从真实配对通道 handover 进入 RemoteConnection，经公开 `send` 排入未确认标记消息；暂停旧 transport writer 后第二条触发2 MiB累计限制，调用方收到 `.backpressure`，旧 writer 结束、队列与预算归零。测试闸住旧 receive 的终止结果，确认公开 send 的失败处理自己进入退避；手动时钟推进后，新 transport 完成 IK/hello 并进入 syncing。此时才释放旧结果，核对旧 generation 的 send 被拒绝、旧收尾不伤新代、新端点只收到 fresh 标记且回显完整，没有重发旧未确认消息，最终 stop 后弱引用和 sleepers 归零。
- 该生产路径在2feea5b已接好，本轮新增测试先绿；没有声称原实现先红。随后分别移除 send 中的 `failed(generation,error)`、发送代次守卫、失败回调代次守卫，三个破坏都产生真实测试失败。`buffer-breaks.json` 扩到15项，最终15/15检出。第一轮因新增测试的 actor 属性被 `||` autoclosure 隔离限制而 NOBUILD，不计检出；拆成局部 awaited 值后重跑全部实际检出。
- 本轮新增 UI 测试局部使用 `PairingTestResources`：每 case 在 start 前注册连接、接受 responder 后注册通道；成功或抛错均 stop/abort 并检查弱引用和手动时钟归零。`PairingResourceTests/throwingBody` 覆盖 start 后、接受 responder 后故意抛错，缺少清理时实际失败；`resource-breaks.json` 扩到2项、2/2检出。新增 model 测试的 cancel defer 在 submit 前安装，不绕过 accept 抛错路径；仅检查本轮新增 UI/预算测试，没有扩成生产依赖或全仓资源框架。
- 收尾相关定向 Swift 35项/6 suites 通过，开启 warnings-as-errors 和显式 target 依赖检查；出站组合回归另外连续5次通过。Swift格式、文档lint、diff检查通过。生产逻辑未改，仅把 PairingFlow.run 的过期取消注释改为关闭通道但保留不确定 pending。本轮未跑全量、Xcode/模拟器、真机或实时 TS 互通。

### 正式线路拒绝原因接缝修复

- 正式 RemoteService 的本机投影 reason 为 `declined`，其 `onEnded` 发给手机的 `pair_rejected.reason` 为 `rejected`；MP0 拒绝也发 `rejected`。Swift 现在把两者映射为 `.declined`，真正未知的 `future_refusal` 仍为 `.other`。仅改错误投影，不改权限、清理或协议定义。
- `PairingFlowTests/refuses` 的真实 Noise 参数化交换覆盖8种理由，包含正式线路值、已有 declined 和未知值；断言 pending 清掉、旧正式记录保留。`PairingPresentationTests/wireRejectionMessage` 从同一真实 Noise 拒绝结果检查明确的“Mac 拒绝了配对”文案，而非网络错误。两条测试以结构化 task group 持有 flow，异常退出也取消并等待，transport/channel 的 defer 覆盖抛错路径。
- 先改测试时，旧实现对 `rejected` 的状态及 UI 文案共3处断言失败；补一行映射后，`--jobs 1` 定向 PairingFlow/PairingPresentation 共11项、2 suites 通过。缓存只增量编译修改文件，未引入 renderer/Markdown 编译。`rejection-breaks.json` 移除 rejected 映射的单项破坏实际检出；本次通过仅向真实 xcrun 追加 `--jobs 1` 和现有缓存检查参数的临时适配器执行，没有使用伪造测试输出。
- 红/绿/破坏日志分别为 `/tmp/ios-connect-rejected-red.log`、`/tmp/ios-connect-rejected-green.log`、`/tmp/ios-connect-rejected-break.log`。既有 `remote-breaks.json` 的理由分支匹配同步到双值分支，未在本轮重跑整组。格式、Swift文档lint、diff检查通过；未跑全量、Xcode/模拟器或动态 TS 互通。真实 RemoteService + relay → Swift 拒绝方案记录在 `apps/ios/Integration/README.md`，本轮只提方案，不冒称 startHost/faux-pi 或正式宿主动态契约已通过。

## 正式 RemoteService → Swift 拒绝互通（连接切片，2026-10-26）

- 在 `1399b0c` 后仅合固定 host `e29e49a`（merge `e03bc76`），协调生成协议27，文档冲突保留双方；未合 renderer/整合分支。本轮没有修改 host/protocol 生产源码，也不标完整 MP4 完成。
- `node apps/ios/Integration/run.mjs --production-rejection` 使用实际生产 RemoteService、relay 和 Swift WebSocket/Noise/PairingFlow。vault/index 只有最小内存端口，不 import Vitest fixture，不启动 startHost/Electron/router/faux-pi。HTTP 控制复用 bearer、loopback、限长/超时和清理，只等待真实 awaiting_confirmation、核对 SAS、调用真实 `confirmPairing(false)`，不构造拒绝帧。
- `ProductionRejectionInteropTests/macRefusal` 不覆盖版本，Swift 默认生成版本与 TS 当前27一致；断言真正加密线路的 `.failed(.declined)`、无成功通道、pending 清空、旧本地正式记录与共享设备密钥保留、无存储问题。旧记录是客户端内存夹具，不声称曾与此服务实际配对。TS 同时验证本地 reason=declined、devices/accept=0、vault 字符串未改变；cleanup 再查没有授权、host/relay counters=0、所有控制请求/listener 关闭。
- 安全保存映射原件后，暂时仅移除 Swift `rejected` 分支，实跑新正式互通 **exit 1，仅 Mac 拒绝状态一处断言失败**（实际 `.other("rejected")`）；恢复并逐字节比对原件后同场景 **exit 0、1 test/1 suite 通过**。第一次因协议27与新测试增量编译12.09秒，无 Markdown/renderer 新编译；恢复后1.38秒。红灯 `/tmp/ios-connect-production-rejection-red.log`，首次绿灯 `...-green.log`，最终当前源码绿灯 `/tmp/ios-connect-production-rejection-final.log`。
- `node apps/ios/Integration/run.mjs --production-rejection --hold-confirmation` 在真实匹配 SAS/awaiting_confirmation 后输出 held 信标。外部验证器此时 SIGTERM runner，实测 **exit 1**；host/relay counters归零、control请求与listener关闭、已捕获的 Swift 后代进程组全部消失、临时 bundle 目录移除。日志 `/tmp/ios-connect-production-rejection-cancel.log`。负对照断言失败也完成相同 fixture 清理；最终扫描无残留 `atrium-local-interop-*` 目录。
- 原 MP0 命令仍通过（exit 0，1 test）；`--negative-control` 仍只在错误 SAS 断言失败（exit 1），并清理资源，再跑普通 MP0 通过。最终日志 `/tmp/ios-connect-mp0-production-final.log`，负对照 `/tmp/ios-connect-mp0-negative-after-production.log`。新增 CLI/env 仅测试可见，登记于 Integration README/development，入口登记 knip。
- `swift test --jobs 1 --filter 'PairingFlowTests|PairingPresentationTests|RoundTripTests'`（warnings-as-errors、显式 target 依赖检查）**18项/3 suites通过**，含 declined 兼容、未知理由、UI 文案和生成协议往返，日志 `/tmp/ios-connect-production-swift-targeted.log`。定向 oxlint、包含现有 host ambient declaration/MP0 TS-extension 设置的临时 tsc 配置通过；初次 lint 的文档参数/不安全类型断言已修，初次类型检查遗漏声明和配置不计通过，未放宽类型规则或修改生产/spike源码。误用不存在的 eslint 命令失败后改用仓库 oxlint。只读审查无高可信阻断，审查者未另跑测试。
- 未跑全量 check/test/knip、Xcode/模拟器、真机、WAN/TLS、长期整机泄漏或完整 MP4 同步。这个新增证据只覆盖正式服务拒绝接缝，不把它升级为 startHost/faux-pi 契约。

## Children来源判据与真实导航校正（MP3整合回归，2026-10-27，待完整门禁）

对应SPEC-0002“显示”及MP3本机行为保持：同轮送达可落在agent步骤，闲时送达可成为新轮source，不能仅接受source-line。这里只改测试判据与夹具，不改生产或协议。候选五文件位于`apps/desktop/e2e/`；原旅程其它检查及其它旅程保持。

| 场景/不变量 | 用例/助手 | 已有验证及边界 |
|---|---|---|
| 运行中audit合流、tests闲时新source，完整session/task/event与落盘归属 | `children-delivery.spec.ts` C1、`child-delivery-fixture.ts`、`child-delivery-observation.ts` | 旧source-only判据已见一次目标红；固定B1正向通过。旧红无同次DOM正向附件，不回填历史67/68根因 |
| 停止父后两报告waiting，再一次送入同一record/新turn | 同文件C2 | B1正向通过；实际删除tests source，原count2以2/1失败，协议/持久记录保持。该控制未执行到新增全局清点 |
| 原两孩子/worktree旅程与双导航 | `children.spec.ts`指定原旅程、`child-delivery-assertions.ts` | B1三例共六次真实导航与返回、18独立凭据通过；原旅程本次自然为混合位置，不是旧B0的两source路径 |
| 当前完整小夹具中每个报告全局一次、正确turn/slot/finished及可见完成文案 | `child-delivery-assertions.ts` | 跨位置真实DOM副本：B0有效SURVIVED→B1目标计数红→恢复B1三例绿；实际source文字错误仅使completionVisible红。未知实体也计总数，不声称覆盖任意无testid副本或agent文字负控 |
| 打开报告必须去实际目标孩子 | 同助手的真实订阅/task快照/标签与返回检查 | 实际audit点击转发到真实tests按钮，只有tests订阅/任务/选中标签，原audit订阅5秒红；不是按钮无响应，也不是后续每道导航检查的独立敏感性证明 |

以上动态证据归属固定B1 assertions SHA `b110bb5a…`。随后13条lint诊断作最小修订，新SHA `7008dc50…`：非变异排序保重复/null及原顺序，visible仍在浏览器回调内，双失败保两原错并补cause。四文件格式化、五文件格式检查/lint和desktop typecheck各一次退出0，父核43封存/436旧证据/1121产物；**修订后children路径尚无动态验证；父在未提交整合树一次完整check已过（11.788s，boundary14/41/4，未登记0/非精确0）。随后唯一list为70例/33文件、一次构建通过，完整Electron选择集16过/1败/53未执行：chat.spec.ts:35点击超时，C1/C2/原两孩子旅程均未执行，无新增18份回执。已父核48工件及输入未漂移，首失败后未重跑。随后获准一次受限trace解析：所读流无frame-snapshot，解析器未匹配click结构、未取得动作时间，不据此说没有click；材料不足已停，chat根因未定，不能称门禁通过**。旧诊断四草稿仅保留在MP3b lane及私有快照，不迁入整合候选、不加ignore规则；整体check不冒称检查过这些草稿。

既有`pnpm break-check`只支持Vitest/Swift，本次明确使用有界Playwright控制，不伪装调用该命令或扩通用harness。资源尾采node78614、1322及后来单次观测不在分别记账，不称完整资源门禁；原unit/Git、appearance、ask-user失败不由这批结果关闭。详细冻结、正负控制与父核验见[整合记录](mobile-integration.md)；上述验证阶段未提交候选代码、未合main或推送。后续用户授权阶段保存与合并，当前状态见[手机端阶段交接](mobile-handoff.md)，不因此新增动态通过记录。

## 手机端手测、模拟器签名修复与阶段保存（2026-10-27）

- 用户在隔离 Mac/新 iPhone 模拟器中完成配对，报告手机停在“正在同步”；对后续可测的连接管理项目整体反馈通过。没有逐项操作回执，不将所有拒绝/超时/撤销分支都列成独立实测通过。Mac 新建对话的展开思考交互，用户手动未复现旧自动化点击超时。
- 测试包此前误用关闭签名的构建方式，既有真实 App 内固定 Keychain 检查一次显示 `failed:keychain:-34018`。另获授权后一次离线 simulator ad-hoc 构建、一次覆盖安装，实际可执行文件包含正确的模拟器 App 身份；唯一修后固定检查显示 `passed`，已恢复普通首页。源码、工程和锁文件未因修复改变。没有卸载/擦除，数据容器路径变化及元数据读取脚本问题如实保留，不宣称逐字节数据保留已验证。
- 本机证据在 `/tmp/atrium-ios-manual.jtM5X0/` 及其 `signing-repair/`；证据性质、现场归属和限制见[阶段交接](mobile-handoff.md)。Mac 使用进程内保险箱替身，故不覆盖真实 Mac Keychain 或 Mac 重启持久性；手机同步/列表/发送仍未实现。
- 用户明确将此前列出的自动化异常暂缓，并要求保存当前状态、本地合回 `main`。本次合并检查结果记在交接末尾；这是阶段检查点，不是把旧完整 unit/Electron/泄漏失败改绿，也不代表 MP3–MP6 全部完成。

## 桌面弹窗不超出窗口（M1.11 自用后修复，2026-10-26）

原型 `prototypes/popup-bounds-prototype.html` 选 A“原位限高”。SPEC-0001“桌面浮层的窗口边界”、SPEC-0002“显示”和 design-language“浮层边界”同步；入口与决策见 `research/popup-bounds.md`。

| 行为 | 回归 | 红绿证据 |
|---|---|---|
| 24 条子对话列表按上方余量滚动、最后一行操作菜单不被裁，缩窗后仍在四边内 | `test/popup-bounds.browser.test.tsx` “contains many children…”；`run-control.browser.test.tsx` 边界用例 | 原版顶部 −582.5px，先红；接入后通过 |
| 公共几何、top layer 逃出 overflow/filter、DOM 归属、原尺寸与 CSS 上限、动态重算及释放 | `design/floating-layer.browser.test.tsx` | no-op 负对照 12 项失败；最终 25 项通过，涵盖模态、尺寸上限与真实 scroll 事件后两帧的滚动保持 |
| 通用菜单覆盖侧栏/标签/历史/面包屑/子对话行末/设置/比较范围/新工作区的全部调用点 | `menu-button.browser.test.tsx` “keeps a long menu…”及各入口既有测试 | 边界与裁剪先红；修后通过 |
| 模型面板、服务商说明、状态栏详情与自定义、Fast、候选与添加菜单、提问导航摘要 | chat 下对应浏览器文件新增边界用例 | 各新用例先红；添加菜单首次负对照未检出，强化为真实 clip-path 后检出；chat 首轮 611 项通过 |
| 长名字的开子对话/归档确认表单在小窗口内，取消与提交可滚到 | `test/popup-bounds.browser.test.tsx` “keeps the new-child form…”、“contains a long archive name…” | 各自在原版左缘 0px 先红，修后通过 |
| 设置分类在矮窗口能滚动，窄窗口仍可关闭 | 同文件 “lets the settings categories…” | 原版分类被压缩，无滚动，先红；修后通过 |
| 改名提示在右下角换边，长字不溢出且不抢焦点 | 同文件 “keeps a rename hint…”及既有 `rename-field.browser.test.tsx` | 原版提示右缘 1906.6px（360px 窗口），先红；修后通过 |
| 归档失败提示在窄窗口内，关闭按钮不缩小 | 同文件 “keeps a long archive failure…”及既有 toast 测试 | 原版左缘 −5181.5px，先红；修后通过 |
| 开着子对话列表再开设置/新建表单：背景浮层不得盖过模态 | 同文件 “suspends an open child list…” | 审查后新增，原实现保持 popover-open 先红；挂起/恢复、模态内菜单及背景外点/Esc/模型快捷键门禁修后通过 |

### 审查与补充回归

用户选 GPT-6 Astra、Grok 4.7，加 Claude Opus 5.5 做只读审查；合并同根问题后修复并有界复核：

- 背景 top-layer 浮层盖过 div 模态：按 inert / 可见 aria-modal / 原生 modal 挂起和恢复；仅跟踪相关 DOM 变化，不因流式文字频繁重算；消费者在挂起时不处理外点、Esc 或背景模型快捷键。
- 已被 360px 上限约束的菜单仍无谓翻边：按实际受限外框判断，不按整个 scrollHeight。普通、field、chip 菜单的默认宽度有旧 absolute scaffold 对照，明确较宽的历史内容仍能撑宽。
- 自定义服务商名 256 字符仍伸出框：换行并验证文字 Range 的实际行矩形，不只量外框。
- 隐藏悬停卡片持续观测、淡出时还原位置：只在 hover / focus-visible 和原离场期间启用几何；Group/Fast 250ms，导航摘要 150ms；假时钟验证重入、截止时间与卸载清理。
- native top layer 可能落入拖动区：统一 no-drag；新桌面用例原版算出 `none` 先红，修后计算样式及 CDP 点击通过。没有把它冒称真实 macOS 鼠标拖动区命中已验收。
- 归档提示被后开的面板盖住、矮窗口堆叠越底：提示栈跟随右上锚点、非模态置顶、模态下挂起，超高可滚；正常不设 overflow，保留阴影和入退场，栈空隙不拦背景点击。四条新增回归分别先红后绿，含等列表 clip 动画结束后再做命中判断。

真实滚轮自查还发现临时放大 scrollport 会把末行拉回：1239px 内容、591px 面板应能滚到 648px，实际只到 479.5px。不翻转的面板直接应用最终高度；翻转测量保存/恢复偏移，自身滚动不重定位，嵌套菜单仍跟随父层。首尾及翻转回归等待原生 scroll 事件和两帧，修前分别 `320 → 0`、`348 → 224`，修后稳定。最终浅色首屏、深色末行的真实 Chromium 截图已检查；修复后的原生 scroll 事件与两帧验证通过。交互原型和桌面菜单明暗截图也已检查；Electron 页面截图不用于证明原生材质或系统按钮遮挡。

### 最终验证与未验证

- `pnpm check`、`pnpm build` 通过（构建仍有既有大 chunk 提示）。边界清单：`boundary --all` 地址 14、环境变量 41、隐藏命令 4，未登记和非精确版本均 0；无新增外部边界、依赖或协议变更。
- 串行单元 **3854**、独立串行 UI **1088 / 56 文件**通过；九个相关浏览器文件 **2 副本 × 2 轮**压力通过。
- 相关桌面 **22 项**在隔离串行复验全部通过：归档、子对话、模型、输入候选、新工作区、改名、运行控制、状态栏及本次两项桌面回归。包含新增 `@leak`：添加菜单和模型面板预热 3 轮、再开关 20 轮，前后堆快照无新增脱离 DOM；先故意保留菜单节点使该用例失败，恢复后通过。监听/observer/定时器释放另有浏览器精确回归。
- 三份正式破坏清单共 **27 处全部检出**：`floating-layer.break-check.json` 7、`popup-bounds.break-check.json` 9、`popup-consumers.break-check.json` 11。最初 0ms 退场两处未检出（React 提交前同步读 popover 状态会假绿），补“截止前计时器不能提前消失”的断言后检出。导航中指针可能经过多个标记，断言所有待退场计时器在截止前保持，而不是假定只有一个。
- `children.browser.test.tsx` 原用默认 414px 视口却造 680px 容器，现显式使用 1280×820，保留原 300px 最窄/右边对齐断言；窄窗口独立覆盖。不涉及既有核心变异分组，未跑 Stryker，不把破坏检查称为变异分数。

失败及中断照实保留：首轮全 UI 的导航退场计时器数假定为 1、实际为 2；新桌面用例曾因收起后的菜单按钮不在可访问树而清理失败，已修测试夹具。中断前将全 UI、压力与 Electron 同时跑，出现 UI 浏览器连接关闭、压力浏览器退出超时、Electron 页面关闭/worker 收尾超时，以及子对话停止时的未预期 SIGTERM warn；另一次旧子对话旅程没在来源行看到 audit 通知，独立重跑通过。未查明这些并行/中断失败的共同根因，也未修改宿主、通知派发或日志门禁来放行。用户报告上次运行意外中断后，恢复任务并分别独立复验：UI 1088、压力四次、桌面 22 全通过；不能据此宣称并行环境问题已修。

未跑全套桌面、宿主/PI 契约、全量泄漏、性能预算、真实订阅、打包安装；实际 macOS 鼠标在顶部拖动区的命中仍留人工验收。用户已确认验收并授权本地提交、合并回 `main` 和安全清理；不安装、不推送。合并前先同步最新 `main` 并复验，结果续记如下。

### 用户确认后的合并前复验

修复已提交为 `858916a`（`Keep desktop popovers within window bounds`），再以 `e68cacd` 合入最新 `main` `ace843a`，无冲突。保留主干上已验收的回复底部间距和其新增测试，不改本次弹窗交互。合并后独立串行复验：`pnpm check`、单元 **3854**、UI **1089 / 56 文件**全部通过。此次同步后没有重跑桌面、压力或破坏检查，前述对应结果来自同步前修复版；不冒称这些检查又跑过。

## MP4a 只读同步（SPEC-0005，2026-10-27，待验收）

| 行为 | 测试 |
|---|---|
| 协议 28：`subscribe_sessions.snapshot` / `resume`、`session_snapshot.stream`、`session_resumed`、`fetch_transcript.maxBytes` 的形状和边界（轮数 1–20、字节 64 KiB–4 MiB、`resume` ≤ 64、`stream` 1–128 字符、`session_resumed` 不带 trace） | `envelope.test.ts`（样例与拒绝用例）、`remote.test.ts`（版本 28）；Swift `RoundTripTests`（重新生成的夹具） |
| 快照按预算截：数到一轮为止、按编码字节、至少一条、`hasOlder`、放得下或没预算原样返回 | `sync/snapshot-budget.test.ts` |
| 预算记在连接上，每次订阅重设，没带回默认；发给它的每个快照（订阅、换 epoch 的发布、`sendTo`）都截；断开即忘 | `sync/subscriptions.test.ts` "snapshot budgets" |
| 路由把 `snapshot` 交给会话层；会话管理器把它交给注册表；同一控制器给两个连接的快照 `stream` 相同 | `router.test.ts`、`session-manager.test.ts` "snapshot budgets" |
| `stream`：控制器的跨 epoch 不变；草稿快照每次新取；由注入的 `newStream` 生成 | `session-controller.test.ts`（快照、换 branch 后的两个 epoch）、`session-manager.test.ts`（草稿） |
| `fetch_transcript.maxBytes` 与条数一起限，至少一条 | `session-transcript.test.ts`、`session-controller.test.ts` |
| `session_resumed` 推给手机；桌面客户端收到同位置不变、别处重新订阅、快照前忽略 | `remote-policy.test.ts`、`client/session-view.test.ts` |
| 经真实 relay：手机快照是桌面快照的末尾一段（同 epoch/seq/stream），之后的实时事件 seq 连续 | `test/remote/phone-sync.host.test.ts`（真实宿主 + 脚本 pi + relay 子进程 + TS 假手机） |
| Swift 列表状态：快照整体替换、增量原地更新/新增在后/删除、快照前与别的实例的增量忽略 | `IndexStateTests` |
| Swift 会话状态：快照前忽略、下一条才接、各类事件、接不上要重订、`session_resumed`、重新加载与失败 | `SessionStateTests` |
| 初始同步：先列表（无游标）再会话（预算 6 轮/512 KiB）再 `open_session`；列表应答+快照+每个打开会话有快照或失败才 `markSynced`，只一次；旧代消息和不认识的应答丢弃；新代作废旧请求；同一代回到前台从头再同步；已连接后打开不回到同步中；重订、关闭 | `SyncCoreTests`、`SyncCoreResumeTests` |
| 首页分组：收件箱挑选与排序同桌面 `inboxOf`；工作区命名与排序同 `workspaceName` / `sortWorkspaces`；标题兜底；不含归档与子对话；"N 在跑" | `HomeListTests` |
| 驱动：通道建好后发订阅，列表来了才把连接标成"已连接"；请求 id 是 UUID | `SyncModelTests`（真实 `RemoteConnection` + `TestHost`） |
| 胶囊映射、行图标、会话页状态行与步骤/通知文字 | `HomeViewTests`、`SessionPageTests` |
| Swift 契约：真实宿主 + 脚本 pi + 进程内真实 relay，正式 Swift 配对后 `SyncModel` 同步列表和打开的会话（8 轮里拿 6 轮、`hasOlder`、有 `stream`），"已连接"之后 Mac 上发的消息实时到达 | `node apps/ios/Integration/run.mjs --sync-contract`（`SyncContractTests`，普通 `swift test` 跳过） |

- 破坏检查：TS `packages/host/src/sync/mp4a-break-check.json`、Swift `apps/ios/Testing/sync-breaks.json`。结果与变异测试见本节"验证"。
- 已知缺口：手机通道上"事件超过 8 MiB 改发快照"的预算接线（`ws-server.ts` 的 `snapshotOf` 走 `budgeted`）没有测试经过——造一个 8 MiB 的事件成本高，`connection.test.ts` 只测了替换本身；列表快照超过 8 MiB 的情况按 SPEC 记为 MP4a 限制；Mac 新开对话后的 `prompt` 只在契约里经桌面发，手机发送是 MP4b。

### MP4a 审查后补（gpt-6-astra 单路只读，2026-10-27）

| 行为 | 测试 |
|---|---|
| 同步由通道打开（`RemoteConnection.openings`）触发；回到前台时新连接握手晚于"正在同步"也能同步完成 | `SyncModelTests/foregroundReconnect`（修前复现：一直停在"正在同步"） |
| 离开会话页发 `close_tab`；这个页面还在路上的请求作废，迟到的失败不落到重新打开的页面 | `SyncCoreReviewTests/closesTab`、`lateFailureAfterReopen` |
| 交给终端的会话算已同步、显示原因；已是最新的会话不被改成"交给终端" | `SyncCoreReviewTests/handedOff`、`SessionPageTests` |
| 契约夹具的轮询随等待结束而停；契约测试失败时也停任务、关连接 | `sync-contract.ts` `remoteUntil`、`SyncContractTests`（结构上保证，未专门制造失败） |
| `SyncModel` 的请求 id 由组装处注入 | `SyncModelTests` |

审查提的测试缺口仍保留：超大事件改发快照按预算的接线（`ws-server.ts`）、`stream` 在控制器复用 / 回收重建 / 连续草稿快照之间的生命周期、按预算截与真实转写截在多字节和工具记录上的直接对照。

## MP4b 发送与回执（SPEC-0005，2026-10-27，待验收）

| 行为 | 测试 |
|---|---|
| 回执：同一请求只跑一次、同 id 不同内容 `request_conflict`、哈希算附件个数不算附件 id、正在跑的接上同一次、失败原样再答、非 `CommandError` 记为不确定、执行前先写盘且写不了就不执行、重启后未完成的答 `outcome_unknown`、做完的答案跨重启保留、24 小时过期（读写都清）、每设备 200 条丢最早、坏文件挪开重来 | `remote/receipts.test.ts` |
| 只有手机的 `prompt` / `steer` 经过回执，桌面直接执行 | `router.test.ts` |
| 经真实 relay：同一 `requestId` 发两次只起一次 run，内容不同 `request_conflict` | `test/remote/phone-sync.host.test.ts` |
| App 发件：草稿发出生成新 id、"发送中"时拦下一条、空输入不发、没写进通道就退回输入框（排在已输入的前面）并写"没发出去"、宿主拒绝写错误码、`started` 等轮次出现、`handled`/`queued` 直接收掉、`outcome_unknown` 先找对话记录再标不确定、"重发"用新 id、断线后下一次同步完成时找记录 / 同 id 重试一次 / 超过 10 分钟或已重试标不确定、关页面丢掉该会话的发件、记住最近送达的消息 | `SyncOutboxTests` |
| 驱动：连接已断时发出的消息退回输入框 | `SyncModelTests/notWritten` |
| 输入框占位与"没发出去"文字 | `ComposerTests` |
| Swift 契约：手机经回执发消息，实时看到它的轮次后收掉，之后又能发 | `run.mjs --sync-contract` |

- 破坏检查：TS `packages/host/src/remote/mp4b-break-check.json`；Swift 追加在 `apps/ios/Testing/sync-breaks.json`。等价改写已直接删掉而不是豁免：重启时 `processing → unknown` 的转换、`state !== "done"` 的判断，二者都由"没有答案就是不确定"覆盖。
- 未覆盖：故障代理下的丢包 / 断开 / 延迟（MP4c）；契约夹具的 pi 总报同样的条目，跑完后宿主的重建会用新 epoch 盖掉实时轮次，所以契约用 `lastDelivered` 检查实时看到的轮次。

## MP4c 续传与恢复（SPEC-0005，2026-10-27，待验收）

| 行为 | 测试 |
|---|---|
| 事件环：同一 stream / epoch 内从 `seq + 1` 补到最新；别的 stream / epoch、环外、超过最新、环没跟到最新都不能续；新快照重来，跳号清空；同位置快照保留；没手机看的不记；按条数 / 字节丢最早；全宿主超额丢最久没用的会话；最后一台手机离开满 10 分钟遗忘、期间回来不遗忘；`drop`、`close` 归零资源 | `sync/event-ring.test.ts` |
| 注册表：手机连接看的会话从快照起记、发布的事件进环、Mac 连接不记、断开后 10 分钟遗忘、退订即不再计数、`forget` | `sync/subscriptions.test.ts` "the phones' event ring" |
| 会话管理器：带 `resume` 订阅补发漏掉的事件再发 `session_resumed`，对不上发快照；归档（控制器放掉）时清掉环 | `session-manager.test.ts` "resuming a phone"、"archives a session" |
| 路由把 `resume` 交给会话层 | `router.test.ts` |
| App 会话状态：有快照才有续传点；续传中照收事件、到自己位置的 `session_resumed` 才算同步完；快照也算；没副本不进入续传 | `SessionStateResumeTests` |
| App 同步：重连时列表带游标、会话带 `resume` 且保留内容；`index_changes` 也算列表到齐；同一连接回到前台先去掉再带 `resume` 加回 | `SyncCoreTests/reconnect`、`SyncCoreResumeTests` |
| 冷启动缓存：按主机和版本分目录读写列表 / 会话 / 草稿、读不出算没有、最多 20 个会话丢最旧、排除备份、整个删除；恢复后标"不是最新"、列表按游标续；从缓存打开会话并续传 | `SyncCacheTests`、`SyncCoreCacheTests` |
| 驱动：写缓存、下次启动从缓存开始、被撤销删缓存 | `SyncModelTests/cache` |
| Swift 契约（故障代理）：掐断后重连走续传，期间 Mac 发的消息补齐且不是快照（轮数没被预算截短）；上行被扣下的消息掐断后用同一 id 重试一次，宿主只跑一次 | `run.mjs --sync-contract` |

- 破坏检查：TS `packages/host/src/sync/mp4c-break-check.json`；Swift 追加在 `apps/ios/Testing/sync-breaks.json`。注册表里"只有手机连接才从快照起记"的判断与环自己的"没手机看就不记"等价，已删掉。
- 契约夹具发现一处宿主行为：pi 条目的 `usage` 缺 `cacheRead` / `cacheWrite` 时，宿主算出的 `branchTokens` 是 `NaN`，经 JSON 变成 `null`，违反协议。手机端严格解码，会把这条事件丢掉，之后那个会话卡住不动。真实 pi 总会写这两个字段，所以只改了夹具；宿主侧的防护和"一条解码失败的消息让会话卡住"记为已知风险，留到 MP7 自用时观察。
- 未覆盖：真机、蜂窝 / Wi-Fi 切换、relay 在公网（交给用户验收）；回到前台的续传只在单元测试和同一条连接上覆盖，契约里没有真实的前后台切换。

## MP4 三方审查后补（SPEC-0005，2026-10-27，待验收）

| 行为 | 测试 |
|---|---|
| 续传中的会话被拒绝打开、或在列表里已交给终端，算同步完；续传中收到不超过自己位置的事件当作已有的忽略；续传中不能发；自动重试没写进通道标"不确定"；离开页面不丢未落定的消息 | `SyncMP4ReviewTests` |
| 撤销后不再写缓存（改草稿、离开页面、进后台）；发出后磁盘上的草稿也清掉；停止运行时取消还在等的节流写入 | `SyncModelTests/cache` |
| 回执：正在执行的请求按执行中的记录合并，不受 200 条上限挤掉影响、内容不同仍回冲突、仍写在文件里；执行抛非 `CommandError` 当次就回 `outcome_unknown` 并记 error；结束状态写盘失败记 warn；附件个数不同算冲突；恰好 24 小时仍有效 | `receipts.test.ts` |
| 事件环：同 stream 新 epoch 或不同位置的快照重来；快照前不记；重新有人看后超过 10 分钟也不遗忘；Mac 断开不减手机的计数 | `event-ring.test.ts`、`subscriptions.test.ts` |
| Swift 契约：宿主已执行（Mac 看到该 `clientMessageId` 的轮次）但应答在下行丢失，掐断重连后不再执行第二次 | `run.mjs --sync-contract` |

- 破坏检查：TS `packages/host/src/sync/mp4-review-break-check.json`、Swift `apps/ios/Testing/sync-review-breaks.json`，全部抓到。
- 记为已知、未改：pi 崩溃重启时宿主重发了原消息、而旧 pi 的应答随后以 `pi_rejected` 失败，手机会把文字退回输入框（桌面同样的语义；转录里出现该 `clientMessageId` 后仍记为送到）。下行丢应答的契约里，重连后的快照 / 续传已包含这条轮次，手机按"已送到"收掉，不会走到同 id 重试；同 id 重试由回执应答的路径由宿主 e2e `phone-sync.host.test.ts` 覆盖。
- 第三方（grok）审查后再补：打开会话算"用过"，淘汰按最久没打开（`SyncCacheTests/pruneByOpening`）；已接受但快照里还没有轮次的消息在 10 分钟内保留（`SyncOutboxTests/letGo`）；回执里读不出的成功应答回 `outcome_unknown`（`receipts.test.ts`）。grok 另报"取消 `.task` 时 `for await` 等 `AsyncStream` 会卡住、旧连接停不下来"，经实测 `AsyncStream` 在消费任务被取消时立即结束，`SyncModelTests/cache` 也覆盖取消后 `run()` 返回，判为不成立、未改。

## MP5a 对话本身（SPEC-0005"MP5 定的细节"，2026-10-28，待验收）

| 行为 | 测试 |
|---|---|
| 会话状态记下快照和事件里的 `control`、`model`、`fast`、`metrics`、运行开始时间，`run_settled` / 退出清掉；缓存副本带上它们，旧副本照样能读 | `SessionStateControlTests`、`SyncCacheTests` |
| 一轮的版式：气泡（宿主代发的不显示）、过程行、回复、摘要；运行中按开始时间计时（`m:ss` / `h:mm:ss`）；停止 / 出错的标题；pi 的错误原文；改动的文件数和增删行 | `TurnLayoutTests` |
| 会话页用 `TurnView`（轨道运行中展开、结束 1 秒后收起、Markdown 流式回复、长按复制、改动行）和顶栏"项目 · 分支" | 截图 `pnpm ios:shot --gallery=conversation`（模拟器）；真机性能和逐项视觉对照交给用户验收 |

- 未覆盖：时间线仍是 `LazyVStack`，`List` 与 `LazyVStack` 的取舍要等真机性能数据；50 毫秒卡顿预算未测。

## MP5b 运行控制（SPEC-0005"MP5 定的细节"，2026-10-28，待验收）

| 行为 | 测试 |
|---|---|
| 插话走回执、以 `steer` 发、宿主接了就收掉、断线后以 `steer` 重试一次；停止 / 继续发送 / 清空 / 删除 / 改成插话 / 编辑 / 重试 / 继续送达各发对应命令且带上条目和文字；没同步或会话没开不发；动作失败记下原因直到关掉或下一次动作；页面显示时清除未清的 `error` 关注（`auth`、已清的不发，请求在路上不重发） | `SyncControlTests` |
| 输入框占位（离线 / 提问中 / 运行中 / 空闲）、停止键（运行中或停止在路上，停止在路上时转圈）、长按插话只在运行中、横幅（停止 / 崩溃且排队非空、送达暂停）、排队数、崩溃失败文案、正在重启、动作失败的文字 | `SessionControlsTests` |
| Swift 契约：Mac 开着一次不结束的运行，手机发的消息进宿主排队、插话交给 pi、停止后排队暂停、"继续发送"放出排队那条并跑完 | `run.mjs --sync-contract` |
| 出错卡片（这一轮出错 / pi 连续崩溃）的样子，浅色和深色 | 截图 `pnpm ios:shot --gallery=conversation [--dark]` |

- 破坏检查：`apps/ios/Testing/mp5b-breaks.json`，全部抓到。
- 未覆盖：排队 sheet、长按菜单、横幅、toast 的界面只在模拟器上编译通过，没有截图或 UI 测试（要真实数据），交给用户验收时逐项看。

## MP5c 提问、对话框、子对话、图片（SPEC-0005"MP5 定的细节"，2026-10-28，待验收）

| 行为 | 测试 |
|---|---|
| 提问的选择：单选替换并跳下一题、多选切换、"其他"有字才算答、全部答完才有回答、选项按序、其他去掉首尾空白 | `QuestionDraftTests` |
| 回答提问和对话框发对应命令；子对话按父会话列出、最近更新在前、不含归档；对话框倒计时；子对话角色名和状态；等待回答的 id（提问在前） | `SyncControlTests/answers`、`HomeChildrenTests`、`SessionSheetsTests` |
| 图片：逐张上传、全部拿到 id 再带 `attachmentIds` 发；只有图片也能发；上传被拒退回文字和图片；重连后重传再发、同一 `requestId` | `SyncImagesTests` |
| 图片缩到长边 2048、JPEG 不超过 750,000 字节（base64 不超过 1,000,000 字符）、小图保持原尺寸、不是图片的放弃 | `ImageShrinkerTests` |
| Swift 契约：对话框 Mac 先答，手机上随之消失；手机答的宿主接受；带一张图的消息经真实宿主上传后发出 | `run.mjs --sync-contract` |

- 破坏检查：`apps/ios/Testing/mp5c-breaks.json`，全部抓到。
- 未覆盖：提问 sheet、对话框 sheet、子对话 sheet、提问卡片、照片选择器只在 iOS 模拟器编译通过，没有截图或 UI 测试；ask_user 的"两端同时回答"在契约里用扩展对话框验证（同一机制：宿主先到先得、`control` 里那一项消失），ask_user 本身只有单元测试；契约的 pi 不回显图片，轮次里的图片数没有验证（宿主若不认附件 id 会拒绝，契约检查了没有拒绝）。

## MP5 只读审查后补（2026-10-28）

| 行为 | 测试 |
|---|---|
| 有提问时输入框发出走 `steer`；上传后消息没写出 / 上传没写出，文字和图片一起退回；自动重试的上传被拒标"不确定"；不确定的带图消息重发时重新上传；关闭页面后迟到的动作失败不再显示 | `SyncMP5ReviewTests` |
| 自动弹出：提问先、再最早的对话框，各一次，同步完成前不弹；子对话副标题；"已在别处回答" | `SessionPresentTests` |
| Swift 契约：插话进了宿主的 `control.steers`；Mac 先答之后手机再答，宿主回 `interaction_closed` | `run.mjs --sync-contract` |

- 破坏检查：`apps/ios/Testing/mp5-review-breaks.json`，全部抓到。
- 记为已知、未改：排队时的"+1"浮字；"正在重启 pi"放在对话末尾而不是标题行；动作失败的 toast 在打开的 sheet 下面看不到；提问卡片重新打开时之前的选择不保留；子对话 sheet 打开期间不随列表更新；倒计时和计时用手机时钟对宿主时间戳；没有提问的 `ask_user` 契约（扩展对话框走同一机制）。

## MP6a 改动列表和 diff（SPEC-0005"MP6 定的细节"，2026-10-28，待验收）

| 行为 | 测试 |
|---|---|
| 同步核心：看得见的工作区 `watch_changes`（整组发、相同不重发、只收看着的）、一次一个 `watch_diff`（只收对应的、换目标清掉旧的、`null` 关掉）、重连后重发 | `SyncChangesTests` |
| 改动列表：按种类计数（改名算修改）、合计行数、按目录分组（根目录在最后）、按改动量排、筛选、"2.2k"缩写、改名写"旧 → 新" | `ChangeListTests` |
| 文件图标：同桌面的查找（全名、最长扩展名、浅色变体、找不到用通用图标）、表里每个图标都能画、SVG 路径（直线、曲线、平滑曲线、二次、圆弧和连写的标志、读不了的放弃） | `FileIconTests`、`SVGPathTests` |
| 图标资源和桌面的表一致（`--check`）、继承 `<svg>` 的 `fill="none"` | `scripts/ios-file-icons.test.ts`，并在 `pnpm check`（`ios:check`）里 |
| diff 页和文件图标的样子 | 截图 `pnpm ios:shot --gallery=diff-page`、`--gallery=files` |

- 未覆盖：改动列表页本身没有截图（要真实同步数据）；hunk 跳转后的那一下闪色没做；契约没有覆盖 `watch_diff`（宿主侧已有测试）。

## MP6b 首页、工作区页、抽屉、空状态、签名（SPEC-0005"MP6 定的细节"，2026-10-28，待验收）

| 行为 | 测试 |
|---|---|
| 每个工作区首页显示 3 个（问你 > 出错 > 运行 > 其余，同级按新到旧）和"还有 N 个"；本地 / worktree；已合并；对话最多 5 个；最近更新的会话所在位置（不算归档和子对话） | `HomeLayoutTests` |
| 工作区小签（已合并优先；未提交 · ↑N） | `WorkspaceTagTests` |
| 签名到期：从描述文件的签名外壳里读出 `ExpirationDate`、读不出时没有；剩几天、今天到期、已过期；剩 1 天及以内提醒 | `SigningTests` |
| 抽屉：外观跟随所选或系统；主机状态文案 | `DrawerTests` |

- 破坏检查：`apps/ios/Testing/mp6b-breaks.json`，全部抓到。
- 未覆盖：首页、工作区页、抽屉、空状态的界面没有截图（要真实的配对和数据），"忘掉这台 Mac"的清理（钥匙串、缓存）没有自动测试，交给用户验收时逐项看。

## MP6c 模型 sheet（SPEC-0005"MP6 定的细节"，2026-10-28，待验收）

| 行为 | 测试 |
|---|---|
| 同步核心：同步后才 `list_models`、带工作区和刷新、保留目录和默认模型；`set_model` / `set_thinking_level` / `set_fast` | `SyncModelsTests` |
| 档位名和说明同桌面（最高一档总是"最慢最贵"、只有关闭的"这个模型不推理"）、点阵覆盖、token 缩写、服务商名和图标文件、总走套餐的服务商、按服务商分组保持顺序、Fast 说明、模型胶囊文字、换模型后保留档位（没有就"高"，再没有就最高） | `ModelChoiceTests` |
| 服务商图标、点阵推理强度框（中档、最高档的品牌渐变、只有一档时不可拖）的样子 | 截图 `pnpm ios:shot --gallery=models` |

- 服务商图标由 `scripts/ios-brand-icons.mjs` 从桌面的 `packages/ui/src/design/brand` 用 Chromium 画成 96px PNG 后提交；脚本要 Playwright 的浏览器，没有放进 `pnpm check`。
- 破坏检查：`apps/ios/Testing/mp6c-breaks.json`，全部抓到。
- 未覆盖：模型 sheet 整体没有截图（要真实同步数据），拖动的橡皮筋和弹簧吸附没有做（点或拖到哪一档就是哪一档）。

## MP6d 新会话（SPEC-0005"MP6 定的细节"，2026-10-28，待验收）

| 行为 | 测试 |
|---|---|
| 同步核心：同步后才新建、一次一个、先 `create_session` / `create_chat` 再订阅打开、发 `prompt` 带回执；`workspace_not_found` / `session_cwd_missing` 把工作区标成找不到；断线时结果不明 | `SyncStartTests` |
| 提示句（分支、对话、找不到）；选位置 sheet 按项目列工作区、不列已合并的 | `NewSessionTests` |
| 最近 3 个位置：按会话最近更新、每个工作区一次、不含对话和已合并的；首页 `+` 的默认位置取第一个 | `HomeLayoutTests/recentWorkspaces` |
| 新会话页（猫、提示句、位置胶囊、输入框）的样子 | 截图 `pnpm ios:shot --gallery=new-session [--dark]` |

- 破坏检查：`apps/ios/Testing/mp6d-breaks.json`，7 处全部抓到。
- 未覆盖：新会话页第一版不带图片；发出后原地变成会话页、选位置 sheet、找不到工作区的橙色胶囊没有 UI 测试或截图（要真实同步数据），留给验收时在真机上看。

## MP6 审查（codex gpt-6-astra、grok grok-4.7，2026-10-28）

| 行为 | 测试 |
|---|---|
| 从会话页的"改了 N 个文件"推出改动列表时，会话页不关闭、不退订（同打开子对话） | `SessionPresentTests/staysUnderPush` |
| 模型目录只属于最后问的那个位置：换位置立刻清空，旧位置迟到的应答丢掉；页面在同步完成后再问一次 | `SyncModelsTests/place` |
| "在 Mac 上找不到"标记和上次新建失败只活一个连接：新连接清掉，回到前台（同一连接）不清 | `SyncStartTests/reconnect` |
| 新会话第一条消息被拒：会话留下，文字退回这个会话的输入框 | `SyncStartTests/promptRefused` |
| 首页 `+` 的位置：最近更新的会话所在工作区，那个会话在对话里就是新对话；最近位置不算归档的会话 | `HomeLayoutTests/recentWorkspaces` |
| 模型搜索结果按服务商 + 模型 id 区分行 | `ModelChoiceTests/rowIds` |
| Fast 说明没有倍数时也带"，额度消耗增加"（同桌面） | `ModelChoiceTests/fastAndPill` |
| 改动行在第一次 `changes_updated` 之前写"正在读取改动…"，不说没有改动 | `HomeViewTests` |
| 带描边的文件图标不画（会缺一块），退回通用图标 | `scripts/ios-file-icons.test.ts` |

- 破坏检查：`apps/ios/Testing/mp6-review-breaks.json`，10 处全部抓到。
- 用样例同步数据截图（经真的 `SyncCore.receive`）：`pnpm ios:shot --gallery=location-sheet|new-session-missing|model-sheet|drawer [--dark]`，已逐张看过。
- 没有自动测试、靠验收看：抽屉里的 relay、手机名、版本和"重新配对"；忘掉 Mac 清理失败时的提示；新建进行中不能点"×"；新会话页的失败提示只显示本页发起的。
- 审查里决定不改的：hunk 之间的上下文不展开（协议没有按版本取内容的命令，SPEC 已写明）；签名到期用 `Date.now`（按天显示，`Signing` 本身接受注入的时间，界面层不另做时钟）；`ios-brand-icons.mjs` 不进 `pnpm check`（要 Playwright 的浏览器）。

## T2 路径隔离（SPEC-0006"路径隔离"、SPEC-0002"路径隔离"，2026-11-04，待验收）

| 行为 | 测试 |
|---|---|
| 第一步按 pi `resolveToCwd` 解析：相对路径、`..`、绝对路径、开头的 `@`（只去一个）、`~` / `~/`（`~name` 不展开）、`file://`（含百分号转义）、各种 Unicode 空格 | `path-guard.test.ts` `resolveWritten` |
| 第二步求真实路径：存在的穿链接、不存在的多级目录取最深存在的祖先、悬空链接按目标（含相对链接）、成环和无权限当算不出来 | `path-guard.test.ts` `realLocation` |
| 第三步判定：放行 `./ok.txt`、`.github`、`.gitignore`、深处的 `x/.git/y`；拦 `..`、`@/tmp/x`、`~/x`、`file:///tmp/x`、名字以 cwd 开头的兄弟目录、经外部目录链接写新文件（任意深）、指向外部的文件链接和悬空链接、cwd 本身是链接、`.git`（目录、文件、不存在、大小写、经链接）、算不出来的路径 | `path-guard.test.ts` `checkWrite` |
| 钩子：拦 `edit` / `write`、统一原因、不看 `read` / `bash` 和没有文本路径的调用、开关为假时不动；和 pi 的扩展接口对得上 | `path-guard.test.ts` `guardPaths` |
| 真实 pi 加 faux 模型：被拦 `../outside-…`、`@<外部>/…`、`~/…`（HOME 设在目录外）、`file://…`、经外部目录链接写新文件、`.git/config`；模型读到原因；放行 `./ok.txt`；`.git/config` 内容不变 | `path-guard.pi.test.ts` "blocks a work child's writes…"、"keeps .git/config" |
| 终端里的 pi（没有宿主的参数）、手动开的子对话（`isolated: false`）、没有这个字段的旧参数：钩子不动作，同样的写入全部落地 | `path-guard.pi.test.ts` "does nothing in …" |
| 宿主算 `isolated`：agent 开的 `work`（含带上下文的、孙）为真；手动开的、带 `work` 记录的用户会话、`explore`、`advise`、主对话为假；写进 `--atrium-agent` | `agent-launch.test.ts` `agentSelf, isolated` |
| 宿主层：用宿主算出的参数起真 pi，agent 开的 `work` 子对话写目录外被拦、目录内写成；手动开的都写成 | `agent-isolation.host.test.ts` |

- 破坏检查：`packages/pi/src/task/path-guard.break-check.json`，31 处全部抓到（解析 6、真实路径 5、判定 6、钩子 5、扩展接线 5、宿主 5）。
- 变异测试：`pnpm test:mutation pi --mutate=packages/pi/src/task/path-guard.ts`：92.93%（92 杀、7 活；活下来的是等价或只影响退出条件的变异，原因文字的一个随后补了字面断言）。
- 没做：`bash` 里 `git -C` 等的拦截（SPEC-0006 要，留给 T4）；终端 pi 的"钩子不生效"由 `path-guard.pi.test.ts` 覆盖，没有另做 `fixtures` 录制（`unrecorded`，断言文件结果不断言 pi 流量）。

## T4a 节点运行的 pi 扩展一侧（SPEC-0006"一个 agent 节点怎么跑""扩展与通道"，2026-11-05，待验收）

`packages/pi/src/task/`：`schema.ts`（给 T4b 的接口）、`extension.ts`（`node_done`、`request_graph_change`、`/atrium-task`）、`words.ts`（给模型的话、各角色可用的工具）、`git-guard.ts`（bash 的 git 拦截）。契约测试用 `packages/pi/test/fake-task-host.ts` 当假宿主：只看 pi 的事件、回答通道请求，按 SPEC 判待结算的作废和结算，是 T4b 判定的参照。

| 需求 / 风险 | 验证 |
|---|---|
| `--atrium-task` 只分会话种类和角色：节点（四种角色）、任务对话、都不是（缺参数、读不出、未知角色、带多余字段）；都不是时什么也不注册；参数不带身份 | `task/schema.test.ts`、`task/extension.test.ts`；`task-node.pi.test.ts` "who gets the node tools"（真 pi：五种情形下模型的工具里没有 `node_done` / `request_graph_change`） |
| 请求信封、参数、回答、隐藏命令各自的 zod 校验：版本、未知操作、多余字段、超长、坏请求回 id；文字上限 | `task/schema.test.ts` |
| `node_done` 单独调用：宿主收到请求，这一轮停住（不再请求模型），`agent_settled` 时待结算生效；`ok: false` 带 `reason` | `task-node.pi.test.ts` done-alone、done-gave-up |
| 待结算作废：与别的工具同批（新的 `turn_start`）、之后插话（steer）、之后被停下、之后模型出错；各自结算为 `no_done` / `stopped` / `error`，不是 `node_done` | `task-node.pi.test.ts` done-with-others、done-then-steer、done-then-stop、done-then-error |
| `request_graph_change` 单独调用停住这一轮；同批有别的工具同样作废 | `task-node.pi.test.ts` graph-change、graph-change-with-others |
| 宿主的拒绝（`task_args_invalid`、`task_caller_invalid`）变成给模型的错误结果，不带 `terminate`，模型能改了再调；超长由扩展自己答，不问宿主；读不出的参数由扩展答 `task_bad_request` | `task-node.pi.test.ts` refused、wrong-caller、too-long；`task/extension.test.ts` |
| 工具停下（abort）时清掉状态、发 `cancel`、工具失败；回答只认每个 id 的第一个，迟到的、读不出的不理 | `task-node.pi.test.ts` stopped-while-asking；`task/extension.test.ts` |
| `nudge` 开新一轮，模型读到提醒；同 id 再发（含 pi 重启后）不再开；只对节点 | `task-node.pi.test.ts` nudge；`task/extension.test.ts` |
| `resume` 把宿主的话包进外壳开新一轮（节点、任务对话都行），外壳标签在正文里被转义、宿主自己的引用外壳不动；`progress` 写一行不开轮、按 id 去重 | `task-node.pi.test.ts` resume、conversation；`task/words.test.ts`、`task/extension.test.ts` |
| 节点按角色限制工具：`explore` / `advise` / `check` 只读表，`work` 全部（不含旧 `grep` / `find`），任何节点都没有 `agent_*`、`ask_parent`、`report_progress` | `task/words.test.ts`；`task-node.pi.test.ts` "a node's tools by role" |
| 节点默认开路径隔离（`isolated` 可关）；agent 开的 `work` 子对话照旧 | `task/extension.test.ts`；`task-node.pi.test.ts` task-role-work |
| bash 的 git 拦截：`git -C`、`--git-dir`、`--work-tree`（`=` 与空格两种）、`GIT_DIR=`、`GIT_WORK_TREE=`；引号、转义、相对路径、`~` / `$HOME` / `$PWD`、符号链接、`cd` / `pushd` 之后、`$(…)`、反引号、`sh -c`、`eval`、嵌套过深、无法判断的路径；`git commit -C HEAD` 不算；不在隔离里全部放行 | `task/git-guard.test.ts`；`task-node.pi.test.ts` "bash git outside"（真 pi、真 git：外部仓库没多出提交，`git status` 照跑，关隔离或不是任务会话时命令照跑） |

- 破坏检查：`packages/pi/src/task/node.break-check.json`，59 处全部抓到（扩展 24、words 5、schema 3、git-guard 27）。
- 变异测试：见汇报（`pnpm test:mutation pi --mutate=<文件>`）。
- 没做：宿主一侧（T4b）：`TaskRunner`、调用方核对、待结算的真实判定、`--atrium-task` 的下发；任务对话的 `task_*` 工具（T6，`schema.ts` 里留了扩展位）。拦不住的 bash 写法见 security.md 路径隔离一条。

## T4b 节点运行的宿主一侧（SPEC-0006"一个 agent 节点怎么跑""调度器""工作区"，SPEC-0003"哪些会话有这个工具"，2026-11-05，待验收）

`packages/host/src/tasks/`：`runner.ts`（TaskRunner：每任务一个串行队列，执行 T4 范围内的动作）、`judge.ts`（按 pi 事件判待结算）、`channel.ts`（调用方核对、参数校验、回答）、`contract.ts` + `quote.ts`（契约拼装、外壳转义）、`commit.ts`（节点提交）、`task-workspaces.ts`（`ensure_workspace` 与加锁，用 T1 的创建器）、`task-service.ts`、`new-task.ts`；`sessions/task-sessions.ts` 与 `session-manager.ts` 的 `taskSessions`（节点会话的单独启动路径）、`agent-launch.ts` 的 `taskLaunchFlags`；`store/task-session-record.ts`（会话记录的 `task` 字段）；`dev/task-try.ts`（`pnpm task:try`）。测试用 `packages/testkit` faux 的新字段 `byConversation`（按对话的第一条用户消息挑回复，一个文件脚本化每个节点各自的 pi）。

| 需求 / 风险 | 验证 |
|---|---|
| 三节点图 `explore → work → check` 跑到最后一个 agent 节点通过；可写节点的改动提交，提交带 `Atrium-Task: <taskId>/<node>/<attempt>`；check 的交接摘要记着它跑了什么；任务建的 worktree 起锁、结束解锁 | `node-run.host.test.ts` "runs explore, work and check" |
| 按角色的工具：`explore` / `check` 只读白名单 + 三个节点工具，`work` 全部（无 `agent_*`）；节点不带 `--atrium-agent`、不是 agent 子对话 | `agent-launch.test.ts` `taskLaunchFlags`；`node-run.host.test.ts` "gives each node its own tools" |
| 契约：做什么、怎样算完成、整张图（✓ / ← / 下一步 / 之后 / 由用户决定）、不归你做的（从图算）、上游最新一次 passed 的摘要（被打回重置的旁支不传旧摘要）、新 worktree 的环境提示、被打回的原因与上一次的摘要和提交、下一步名字；模型来源的文字（目标、结论、摘要、原因）套 `<atrium-quoted>`，外壳标签被转义，名字和"做什么"也转义 | `contract.test.ts`、`quote.test.ts`；`node-run.host.test.ts` "hands the upstream summary…as quoted data"、"puts the earlier summary and the reason into the contract of a node that was sent back" |
| 批准改图后的新契约（`图已改…` + 新图 + 新的"不归你做的"） | `contract.test.ts` `graphChangedText`；`node-run.host.test.ts` "waits for a graph change…" |
| 待结算由 pi 事件判定：`turn_start` 作废、`agent_end` 末条出错作废、`agent_settled` 带 `aborted` 作废（先看 `aborted`）、`auto_retry_end` 失败；结算为 done / graph_change / none / stopped / error | `judge.test.ts` |
| `node_done` 与别的工具同批 → 作废（`node_done_void`），之后重新调用生效；不调 `node_done` → 提醒一次（`nudged`），再不调 → `failed(no_done)`；提醒只在这一轮结束后发 | `node-run.host.test.ts` "does not count a node_done that other tools…"、"reminds a node that did not call node_done once…" |
| 调用方由宿主认定：别的会话、旧 attempt、节点不在 `running`（停了、等待、已结束）、已取消或结束的任务 → `task_caller_invalid`；空 summary / reason / suggestion → `task_args_invalid`（`params.field`）；任务不存在 → `task_not_found` | `channel.test.ts`；`node-run.host.test.ts` "refuses node_done from a session that is not the node's running one"（真 pi：模型读到拒绝，不记待结算） |
| `request_graph_change`：这一轮结束不提醒、不提交、停 pi，节点 `waiting(graph_change)`；批准后在原会话里接着跑并提交 | `node-run.host.test.ts` "waits for a graph change without reminding or committing…" |
| 节点用 `ask_user`：走 SPEC-0003 的问题卡，节点 `waiting(question)`，答了回 `running` 接着跑（节点不被"agent 子对话不能问"拒掉） | `node-run.host.test.ts` "lets a node ask the user with ask_user…" |
| 兄弟失败：在跑的节点这一轮结束后 `held`（pi 停掉），重跑失败节点后 `held` 的自动在原会话接着跑；`gave_up`（`node_done({ ok: false })`）、`model_error`（pi 不重试的出错）、`crashed`（会话起不来）、`workspace`（worktree 建不出） | `node-run.host.test.ts` "fails a node that gives up, holds its sibling…"、"fails a node whose model call ends in an error…"、"starts the same attempt again after its session could not start…"、"fails a work node when the task's worktree cannot be made" |
| 打回（直接喂 `human_sent_back`）后新 attempt 开新会话，契约里有上次的原因、摘要和提交 | `node-run.host.test.ts` "puts the earlier summary and the reason…" |
| `start_node` 幂等：同一 attempt 会话起不来后重跑，接回已记录的会话，不开第二个 | `node-run.host.test.ts` "starts the same attempt again after its session could not start, without a second session"（读索引里该节点该 attempt 的记录数为 1） |
| `commit_node` 幂等与不重复提交：HEAD 已带同样尾注就记下它；没改动不提交；另一 attempt 另提；提交走 `runSafeGit`（钩子、过滤器、fsmonitor 不跑，含读 HEAD 和 `diff`）、不签名、仓库没有作者时用 Atrium 的 | `commit.test.ts`；`node-run.host.test.ts` "finds the commit again after a replay that lost its event…" |
| 宿主重启后接着跑：`recover` 重做丢了的动作（建 worktree、起节点、缺的提交），再送 `host_restarted`；跑着的节点收到"宿主重启了…"接着做 | `node-run.host.test.ts` "carries on after the host restarts…" |
| （已被 T4 审查修复取代，见末尾"T4 审查修复"）可写节点的提交落定才 `passed`，任务结束在提交之后 | `scheduler.test.ts` "does not end the task until the last writing node's commit is settled"、"drops a commit that arrives after the task was cancelled" |
| 节点会话不在用户的会话列表里 | `node-run.host.test.ts` "leaves no node session in the list the user sees" |
| 泄漏：反复起停节点后 pi 进程、控制器、监听、定时器回到基线；宿主在节点跑着时关闭，runner 与所有 pi 都释放 | `node-run.leak.test.ts` |
| `pnpm task:try`：参数、模型、图文件校验、任务 id 稳定、事件的输出、停下的条件与退出码；示例图合法 | `dev/task-try.test.ts` |
| faux 新字段 `byConversation`：按对话的第一条用户消息挑回复、按对话里已有的助手消息数挑第几条（pi 重启后接着走） | `packages/testkit/src/faux/faux.pi.test.ts` |

- 破坏检查：`packages/host/src/tasks/node-run.break-check.json` 34 条（补测试后只重跑了 contract 的 4 条）；`done` 后记 `committed` 的 3 条在 `tasks.break-check.json`，全部检出。
- 变异测试：`pnpm test:mutation tasks`，见汇报；`runner.ts`、`task-workspaces.ts`、`task-service.ts`、`new-task.ts` 需要真实的 pi 和 git，由宿主层测试覆盖，没放进变异层（变异测试跑的是不带 `.host` 的单元测试）。
- 没做（留给后面的步骤）：`merge`、`ask_archive`、`progress_line`、`wake_task_conversation`、`notify` 只记一条 debug 日志不执行（T5、T6、T7）；`node_done` 那一轮在宿主重启前已结束、会话文件里能看到 `terminate` 结果的结算（T9 的完整重启流程）；节点对话里用户亲手停下、插话的宿主层用例（需要 T8 的界面命令，判定本身由 `judge.test.ts` 覆盖）。

## T4 审查修复（三路审查 Codex / Grok / Claude 对 T4 的发现，2026-11-05，待验收）

按审查意见的字母编号。破坏检查：`packages/host/src/tasks/review-fixes.break-check.json`（宿主 36 条）、`packages/pi/src/task/review-fixes.break-check.json`（守卫 10 条），`tasks.break-check.json` 因提交落定后才 `passed` 改了 1 条、删了 2 条；`node-run.break-check.json` 有 6 条的 `from` 随代码改了（全部重跑检出）。三组均已重跑，全部检出。变异测试（只跑改动的行）：`tasks` 组 250 个变异 98.09%，`pi` 组 git-guard.ts 81.84%（补测试前，补后未重跑），`git` 组 safe-git.ts 100%，`host` 组 agent-launch.ts 84.62%。

| 行为 | 测试 |
|---|---|
| A1/A2/A4 宿主的 git 不跑仓库配置里的命令：`diff.external`（`diff.trustExitCode`）、`log.showSignature` + 已签名 HEAD 的 `gpg.program`；`diff --cached --quiet` 只有退出码 1 算有暂存，其他非零报错；安全参数多了 `log.showSignature` / `merge.verifySignatures` / `commit.gpgsign` | `tasks/commit.test.ts` "does not run a diff driver…"、"does not run gpg.program…"、"fails on any exit code but 1…"；`workspaces/safe-git.test.ts`（参数表） |
| A3 `core.worktree` 劫持：提交前核对顶层目录，不是节点 worktree 就拒绝且不碰外面；每条提交命令带 `--work-tree` | `commit.test.ts` "refuses to commit when the worktree's configuration points core.worktree elsewhere…"、"pins every command to the worktree…" |
| A3/H bash 守卫：改 `core.worktree`、`extensions.worktreeConfig`、`-c core.worktree=`、`GIT_CONFIG_KEY_n`、`git config --file` 越界；`$'…'`、`${X:-…}`、`$@`；`builtin`/`command cd`、`if`/`{ }`/循环里的 `cd`；子 shell 的 `cd` 不外泄、可能没发生的 `cd` 不覆盖；读标准输入的 shell | `packages/pi/src/task/git-guard.test.ts` 新增 4 组 "what the T4 review found it let through"；`cd OUT && cd ../work/sub` 一条改为拦（第二个 `cd` 可能失败） |
| B/C 提交标记：`commitPending` 区分"还没提交"和"查过没有改动"（`commit_checked`）；`host_restarted` 只对这一个 run 重发 `commit_node`；已结束任务 `recover` 再解锁 | `scheduler.test.ts`（"does not end the task until…"、"passes a writing node that changed nothing…"、"asks again for a pending commit…"）；`runner.test.ts` "lets go of the worktree's lock again…"；`node-run.host.test.ts` "finds the commit again after a replay that lost its event…" |
| J 提交失败 → `failed(commit)`，后继不起、任务不结束；重跑只重试提交（同一 attempt、不开新会话），成功后图照常往下走 | `scheduler.test.ts` "fails a writing node whose commit failed…"、"retries only the commit…"、"ignores a node's turn ending…"；`channel.test.ts` "refuses a node that waits for its commit"；`review-fixes.host.test.ts` "fails the node with `commit`…"（`index.lock` 让 `git add` 失败一次，删掉后重跑） |
| D1 同批 `node_done` 后又改图 → `node_done` 作废；放行、停下后继续时清掉待结算 | `judge.test.ts` "voids a node_done when a graph change is accepted…"；`scheduler.test.ts` "drops a waiting node_done…"、"forgets a waiting node_done when a stopped node goes on"；`review-fixes.host.test.ts` "does not pass a node on a node_done that a graph-change request…" |
| D2 `node_done` 已生效的节点被要求 hold 时照常通过；judge 的决定和 `stop_node` 读状态在同一个队列 | `scheduler.test.ts` "passes a node whose node_done stands instead of holding it"；`review-fixes.host.test.ts` "passes a node whose node_done stands when a pause…" |
| E1 `crashed` 去重按次 | `runner.test.ts` "reports a second crash of the same node after a rerun" |
| E2 pi 中途崩溃被控制器重启后，宿主作废那一轮并发"宿主重启了" | `review-fixes.host.test.ts` "tells a node its pi was restarted after a crash…"（`SIGKILL` 节点的 pi） |
| F 契约没送到就补发契约（`contract_sent` 标记） | `scheduler.test.ts` "records that the contract was sent once…"；`review-fixes.host.test.ts` "sends the contract, not a line about carrying on…" |
| G 新建 worktree 那一行：explore 先跑过也有；单个 work 节点第二次 attempt 没有 | `review-fixes.host.test.ts` "tells the first work node the worktree is new…"、"does not tell a work node's second attempt…" |
| I 节点 id 的格式与长度；契约里写 id 的地方都转义；`SHELL_TAG` 认空白、零宽字符、全角 `＜` | `graph-validator.test.ts`；`contract.test.ts` "escapes node ids wherever they are written…"；`quote.test.ts` |
| K 停下的节点在对话里又运行 → `node_resumed` 先记再接受调用 | `review-fixes.host.test.ts` "lets a node the user stopped go on…" |
| L 调用方校验、记待结算、judge 记账在同一个队列步骤 | `runner.test.ts` "takes a node_done at once after a question was answered…"（假的会话层，信号连着到） |
| M 关宿主时取消在途的 `prompt` / `command`（带 `AbortSignal`） | `runner.test.ts` "closes while a prompt is stuck…" |
| N 刚发出 prompt / nudge / resume、`agent_start` 还没到的 15 秒内，`stop_node(after_turn)` 等这一轮 | `runner.test.ts` "does not hold a node right after it was sent a turn that has not begun…"、"holds a node at once when no turn is going…" |
| O 带 `task` 字段的会话不用 agent 启动参数，无启动路径的直接报错 | `sessions/agent-launch.test.ts` "sessionLaunchFlags…" |
| P 标记指向的工作区没有 base commit 时报错不重建；`createFrom` 带取消信号；已取消不记 `workspace_created` | `tasks/task-workspaces.test.ts` |

- 没有单独的测试：结束了的任务释放节点上下文（P，只回收内存，源码里按 `Stryker disable` 标注）；`merge.<名>.driver`（T5）。
- 没做：协议包里没有失败原因枚举的镜像，`commit` 这个新原因留给 T5 的协议工作。

## T5 human 节点与合并（SPEC-0006"human 节点""合并""归档""协议（给 UI）"，2026-11-05，待验收）

合并、冲突、abort 失败都用真的 git 仓库（testkit `createGitScene`）；合并测试的 git 运行器缺 `cwd` 就抛错，变异体改掉 `cwd` 也不会合并进本仓库。

| 需求 / 风险 | 验证 |
|---|---|
| 合并检查顺序：worktree 脏（含未跟踪）、已合并 / 没改动直接 `merged`（主目录脏或不在主干也一样）、主目录脏、主目录不在主干（含游离 HEAD、项目没有主干）；处理后能合并；成功是 `--no-ff` 的合并提交、不推送 | `tasks/merge.test.ts` |
| 冲突：`merge --abort`，主目录回到合并前的提交且干净，没有残留的合并状态，冲突文件列表；改好后能合并；`abort` 退出码失败、abort 后留下文件、abort 后提交跑偏 → `merge_abort_failed`；git 自己拒绝 → `merge_git_failed`、主目录没动 | `merge.test.ts` |
| 合并驱动不跑：配置里的驱动被清空，文件变冲突（对照：裸 git 会跑）；`merge-tree`（MergeInspector）同样不跑（原有问题）；驱动名带 `=` 拒绝；钩子不跑；`core.worktree` 把主目录或任务 worktree 引走 → `merge_git_failed`；仓库没配作者时用 Atrium 的作者；合并提交号而非名字；关宿主的信号在合并前抛出 | `merge.test.ts`、`workspaces/safe-git.test.ts`、`workspaces/merge-inspector.test.ts`、`tasks/task-merge.host.test.ts` |
| 宿主层（真实宿主 + faux pi）：脏 worktree / 脏主目录 / 不在主干分别挡住、处理后合并成功；冲突后主目录原样、处理后合并；已合并不重复合并；配置的合并驱动不跑；归档提问：已合并事实、有未提交改动时 `workspace_dirty` 且提问保留、先留着再归档、已取消未合并任务的事实、重启后提问和答案还在 | `tasks/task-merge.host.test.ts` |
| 打回：旁支和下游一起重置（human 节点图，不起 pi）、第三次用同一条边 `task_back_limit`、重启后事件重放出同样的任务；`task_not_found`、`task_state_invalid` 各情形；暂停 / 恢复 / 取消；列出磁盘上的任务 | `tasks/human-node.host.test.ts` |
| 调度器：`archive` 在任务结束（完成、取消）时置 `asked`、借来的 worktree 没有；`archive_answered` 结束后仍收，`asked`→`kept`/`archived`、`kept`→`archived`、其余忽略；`blockedFiles` 截到 50 个、重试时清掉 | `tasks/scheduler.test.ts` |
| Runner：`merge` 动作的四种结果（合并、被挡带文件、抛错 → `merge_git_failed`、关宿主时什么也不记且仍 `merging`）；`continue_node` 发"继续"、状态不符报 `task_state_invalid` | `tasks/runner.test.ts` |
| 视图：状态 / 尝试 / 摘要（取最近一次给出的）/ 打回边用了几次 / `attention` 优先级 / 文本截断 / 没有图；协议枚举和上限与宿主一致 | `tasks/task-view.test.ts` |
| 协议：命令和事件的往返、命令结果、Swift 夹具；错误码；整条 WebSocket 上的 `list_tasks` / `open_task` / `answer_human` / 推送 / 取消订阅 / 错误码；手机只能列出和打开 | `protocol/envelope.test.ts`、`tasks/tasks-protocol.host.test.ts`、`server/router.test.ts`、`server/remote-policy.test.ts`、`client/atrium-client.test.ts`（客户端放过任务推送）；`pnpm protocol:swift --check` |
| `pnpm task:try`：解析回答（通过 / 打回带或不带原因 / 退出 / 不认识）、human 节点显示、合并被挡的说明、归档显示、问什么、什么时候停、按行读输入；示例图读得进来 | `dev/task-try.test.ts` |
| 泄漏：反复合并、被挡、打回、归档、订阅和退订后，资源、子进程、句柄和定时器回到原样 | `tasks/node-run.leak.test.ts` |

- 破坏检查：`packages/host/src/tasks/t5.break-check.json`（34 处）、`t5-host.break-check.json`（7 处，`project: host`）。第一次跑时各漏了几处，补测后全部抓到：已合并 / 没改动的直接算合并（原先靠 git 的"Already up to date"碰巧也对）、`abort` 退出码（原先被"主目录没回原样"盖住）、摘要取最近一次、`open_task` 参数顺序。三处改成不再声称：按名字还是按提交号合并（实测 git 都选分支，留着提交号是为了合的就是检查过的那一个）、客户端放过任务推送（只是类型上的守卫）、任务 id 的形状检查（`openTaskStore` 对不存在的目录什么也不建，检查是纵深防御）。
- 没有测试保护的：`TaskWorkspaces.merge` 里主干名取自项目的覆盖值（测试里的主干都是 `main`）；`opened.get(...) === taskId` 的守卫（连接中途换了任务时不推旧任务）。
- 真实模型：`pnpm task:try` 跑 `explore-work-check-merge.json`（claude-bridge/claude-haiku-4-5）：打回一次（第二次的契约带上次的摘要和原因）、主目录切到 `side` 时通过被挡（`merge_main_not_trunk`）、切回后合并成功、origin 未动、回答"归档"后 worktree 目录被清理。


## T6 任务对话与 /task（SPEC-0006"任务对话""/task 与创建""改图""扩展与通道"、附录，2026-11-05，待验收）

任务对话用真的 pi + faux 模型（`byConversation` 按第一条消息 `<atrium-task-design>` 认它）；来源对话、任务对话、节点都是真会话。读 diff 用真的 git 仓库（testkit `createGitScene`）。

| 需求 / 风险 | 验证 |
|---|---|
| 八个工具的参数和结果（往返、缺字段、页码 0、不存在的引导词、空图、多余参数）；`task_set_schedule` 不是一个已知调用；四个引导词 id；`mark` 命令；进度行和转换行的 `details` | `pi/task/schema.test.ts` |
| 扩展：对话会话注册八个工具（顺序执行）、没有 `task_set_schedule`；节点只注册两个；没有标记的会话只注册命令；读结果的文字和页脚（一页没有页脚）；写结果的文字；超长 / 读不了的参数自己答 `task_text_too_long` / `task_bad_request`；`task_graph_invalid` 带码和节点；结果不对当 `task_bad_request`；停下的调用发 `cancel`；`edit` / `write` / `agent_*` / `node_done` 被钩子拦；`mark` 对没有任务标记的会话写 `converted` / `abandoned` 行、不开轮次、按 id 去重、读不了的忽略；进度行带 `what` 和 `node` | `pi/task/extension.test.ts`、`words.test.ts` |
| 调用方由宿主认定：对话会话 / 另一个会话 / 另一个任务 / 节点；`task_not_found`；应答带结果或错误码；节点发 `task_*`、对话发 `node_done` 都 `task_caller_invalid` 且什么也没执行；同一调用 id 只答一次、被撤回的丢掉、旧的 pi 代次丢掉 | `tasks/channel.test.ts`、`tasks/runner.test.ts`（假会话层） |
| 工具对任务的作用：状态 JSON（每个节点的全部字段、没有图、作废读作 pending、待批准的图）；摘要和名字和模型的记录、启动后拒绝摘要、结束 / 取消后四个改的工具拒绝而读的照常；提图的各种拒绝（环、缺字段、不属于项目、改了已跑的节点、多余字段）、设计中立即生效并记引导词、启动后进待批准且忽略引导词；读来源（分页、外壳、转义冒充的标记、超页、不是对话来的任务）；读节点的摘要 / 契约 / 对话；带话给运行中的节点（外壳、转义、不在跑的拒绝）；diff（范围、`since`、外壳、没有改动、截断、git 失败、仓库配的外部 diff 不跑、没有 worktree） | `tasks/conversation.test.ts`、`tasks/transcript-text.test.ts` |
| 调度器：`summary_set` 只在设计中；`graph_proposed` 的引导词只在设计中记 | `tasks/scheduler-resources.test.ts` |
| 设计消息：来源 id、范围包外壳并转义、四套引导词全文、项目 / 无项目的说明、五步指令的顺序；引导词：四个 id 与版本、每套写明自己的名字、写代码的三套把实现和验证分开并以带合并的 human 节点收尾、调研一套没有 work | `tasks/design.test.ts`、`tasks/guides.test.ts` |
| 进度行和唤醒：节点开始 / 通过写进度行（带 `what`、`node`、按行 id）；手工造的任务不写；改图申请唤醒任务对话（`kind: wake`，理由和建议包节点的外壳并转义） | `tasks/runner.test.ts`（假会话层）、`tasks/design.host.test.ts` |
| **宿主层（真宿主 + faux pi）**：`/task`（`createFromChat`）→ 读来源 → 写摘要 → 起名 → 按引导词提图 → 启动 → 三个节点跑到 `done`，来源对话文件里有 `converted` 行、任务对话文件里有进度行、任务对话的工具里没有 `write` / `agent_*`；节点申请改图 → 唤醒任务对话 → 它提新图 → 批准 → 节点接着跑、任务 `done`；拒绝后节点按原图做；已转过的再 `/task` 答 `task_already_converted`（带任务 id）；放弃：记录和目录没了、任务对话归档、来源对话第二行 `abandoned`、能重新 `/task`；已启动（取消）的仍答 `task_already_converted`；崩溃留下的半删记录不挡；不认识的会话 `session_not_found`；启动检查（无图、有环、不属于项目的 work）；批准 / 拒绝的状态错误；批准前再校验；放弃时推送的连接收到空列表且不记警告 | `tasks/design.host.test.ts`（11 项） |
| 协议：五个命令的往返、答复、路由（含参数完整）、手机不能发；三个新错误码；协议号 31；Swift 投影和往返夹具 | `protocol/envelope.test.ts`、`protocol/remote.test.ts`、`server/router.test.ts`、`server/remote-policy.test.ts`；`pnpm protocol:swift --check` |
| 任务对话的启动参数：只读白名单 + 八个工具 + `ask_user`、标记里是 `conversation`、没有 `--atrium-agent` | `sessions/agent-launch.test.ts` |
| `pnpm task:design`：参数解析、按会话 id 找文件并读 cwd（只读）、提醒（实现节点后没有 `check`、没有 human 节点）、打印的摘要和图、读任务对话最后说的话 | `dev/task-design.test.ts` |
| 泄漏：反复建任务再放弃后资源、子进程、句柄、定时器回到原样；设计中关宿主时运行器和任务对话的 pi 都释放 | `tasks/node-run.leak.test.ts`（新增 2 项） |

- 破坏检查：`packages/host/src/tasks/t6.break-check.json`（35 处，pi、协议、宿主单元）和 `t6-host.break-check.json`（11 处，`project: host`），共 46 处全部抓到。第一次跑时漏了两处，补测后抓到：一页的文字不该有页脚（`pageFooter`）；放弃时没归档任务对话（原先只断言了“不在侧栏”，任务对话本来就不在侧栏，断言恒真，改读索引里的 `archived`）。
- 变异测试：`pnpm test:mutation tasks --mutate=<文件>` 会让每个变异都跑 `tasks` 组里的全部宿主层测试（几分钟一个），所以这次用了只含单元测试的临时分组（`mutation-groups.mjs` 里加过 `t6` / `t6pi`，跑完已还原、没有提交），命令同 `pnpm test:mutation <组> --force --mutate=<文件>`。结果：`conversation.ts` 90.64%、`channel.ts` 99.13%、`design.ts` 100%、`transcript-text.ts` 96.81%；pi 侧 `extension.ts` 89.64%、`words.ts` 94.25%、`schema.ts` 94.35%。`dev/task-design.ts` 的纯函数（解析、找文件、提醒、打印、读最后一句）变异全部抓到；`runTaskDesign` 和 `main` 要真模型，不在变异组里（同 `task-try.ts`），整文件 54.22% 主要是它们。conversation.ts 第一次只有 81.87%，补了状态 JSON 的逐字段断言、diff 的空 / 截断 / git 失败、对话里的工具调用、契约和对话的来源标签、带话的整段文字，抓到了大部分。没跑：`runner.ts`、`task-service.ts`、`new-task.ts`（`tasks` 组按说明不含这三个，由宿主层测试覆盖）、`scheduler.ts` 本次新增的两处（表驱动测试加破坏检查，没单独跑变异：另一个变异测试在跑它）、`agent-launch.ts`、`session-manager.ts`、协议文件（各有测试和破坏检查）。
- 没有测试保护的：`task_send_to_node` 经真宿主送进真 pi 的 `streamingBehavior: "steer"`（宿主层没有这一条：单元测试只验证调用 `deliver` 时带着外壳的话）；`pnpm task:design` 的 `runTaskDesign` 本身（要真模型，已手跑，见下）；任务对话的 `bash` 不受只读约束（SPEC 里已写明）。
- 真实模型：`pnpm task:design --from <id> --model claude-bridge/claude-haiku-4-5` 在一段现造的需求对话上跑通，选了 `feature`、写出摘要和四节点图（explore → work → check → human 合并，human 可打回 work），原文件前后哈希相同；输出见 T6 的验收报告。

## T7 任务区（只读）（SPEC-0006"界面""任务对话的进度和记录折叠""错误码"、"T7 定下的细节"，2026-11-06，待验收）

界面测试在真浏览器里渲染整个 `Workbench`，客户端是假的（`fakeClient` 多了 `tasks`、`task(id)`），所以侧栏入口、任务区、标签、列表、图、任务对话、需求对话的那一行都走真实的组件和真实的 store；宿主一侧用真宿主 + faux pi + 真客户端。

| 需求 / 风险 | 验证 |
|---|---|
| 侧栏入口在搜索下面，数字是"待我介入"组的任务数（设计中、等你、停下），为 0 不显示；点它主区换成任务区，选侧栏里的工作区离开任务区 | `ui/tasks/task-area.browser.test.tsx`（"the sidebar's task entry"） |
| 任务区标签：任务、定时在前且都没有关闭按钮；任务标签有关闭按钮，关掉回到列表、任务不受影响；定时标签的空状态 | 同上（"the task area's tabs"） |
| 任务列表：按待我介入 → 运行中 → 已完成分组和排序、每行的名字 / 项目 · worktree / 当前节点 / 最后活动 / 状态、设计中的行、失败 / 合并被挡 / human / 暂停 / 改图各自的说法、已完成 7 天 5 条加"显示全部"和"收起"、项目筛选含"不属于项目"、空状态、定时触发的时钟图标 | 同上（"the task list"）；排序、分组、紧迫程度、7 天 5 条、筛选的逻辑 `ui/tasks/task-list-model.test.ts`；各状态的说法、节点和模型的说法、"多久以前" `ui/tasks/task-words.test.ts` |
| 任务标签：七种节点状态各有自己的图标和图例、边数；单独指定的模型蓝字 / 继承灰字 / human 节点没有模型；点节点描框、换节点、点空白取消；悬停出做什么 / 怎样算完成 / 失败原因 / 合并被挡的原因；设计中的任务显示草图和版本、任务模型、项目 · worktree、"需求对话"链接；点链接回需求对话并离开任务区；打开任务并经会话订阅看任务对话、没有输入框和任务按钮；`task_not_found` 的话和读取中；节点状态随宿主推送变（运转中→通过）不重载；human 节点在等时订 `watch_changes` 并显示改动统计 | 同上（"a task's tab"）；分层、居中、边的路径、打回环的泳道、环和不存在的边、20 个节点的耗时 `ui/tasks/graph-layout.test.ts` |
| 任务对话里的进度：同一段连成一组、最后一组展开成过程轨道的步骤（失败 ×、等你橙点）、前面的组收成一行摘要（节点通过数、时间范围）、点开再收起、点过之后加一行不改选择、新的一组出现时上一组自己收起；设计指示缩成一行 | 同上（"the task conversation's progress and records"）；分组和摘要的纯逻辑在同一文件里经界面验证 |
| 需求对话里的"已转为任务「名」· 状态 · 打开 ›"，点"打开"开任务标签；同一任务两条标记只画最后一条（任务已放弃） | 同上（"the line a conversation shows once it became a task"） |
| 任务区状态：打开的任务标签不重复、关闭后去前一个或列表、显示 / 隐藏不动标签、筛选和显示全部 | `ui/state/task-area.test.ts` |
| 客户端：`watchTasks` 要列表并收整张推送、旧 `seq` 丢掉、答案不盖掉更新的推送、重连后计数重来并再要一次、停止后推送不收；`openTask` 保留整个任务、`task_not_found` → `missing`（留着上次的任务）、别的失败 → `failed`、重连后再开 | `client/atrium-client.test.ts`（"tasks (SPEC-0006, T7)"） |
| 宿主：`TaskSummary.current`（失败 > 停下 > 等你 > 运转中，同级取图里靠前）、`activeAt`、`scheduled`；`TaskView.model`、`sourceSessionId`、`TaskNode.model` | `host/tasks/task-view.test.ts` |
| 对话记录：任务对话的进度行和需求对话的标记投影成 `task_progress` / `task_mark` 两条线之间的 notice；`atrium-task` 的 `nudge` / `resume` / 读不了的什么也不画 | `host/transcript/projection.test.ts`、`pi/history/log-entry.test.ts` |
| 进度行实时到：pi 写下进度行时翻译成 `task_line_added`，控制器重读文件；`nudge` / `resume` / 读不了的不发 | `pi/events/translate.test.ts`；真宿主 `host/tasks/board.host.test.ts` |
| **真宿主 + 真客户端**：任务列表里有设计中的任务（无当前节点、`activeAt`）、`open_task` 的整个任务（模型、需求对话、节点模型 `null`）、任务对话按 id 订阅得到快照和第一条设计指示、启动后列表变 `done`、进度行逐条出现在任务对话、节点状态推送、需求对话里有 `task_mark` | `host/tasks/board.host.test.ts`（先在没有 `task_line_added` 时失败过：60 秒也没有进度行） |
| 协议：新字段的往返、两种新 notice、协议号 32；Swift 投影和往返夹具（`pnpm protocol:swift --check`，`swift test --filter AtriumProtocolTests` 通过，`swift build` 通过） | `protocol/envelope.test.ts`、`protocol/remote.test.ts` |
| 性能：50 个任务 × 20 个节点，按下"任务"到列表画好、按下一行到图画好 | `apps/desktop/e2e/tasks.perf.spec.ts`（`@perf`，数字见 testing.md） |

- 破坏检查：`packages/ui/src/tasks/task-area.break-check.json`（46 处，`project: ui` 的是界面测试）。
- 没有测试保护的：悬停卡的浮动位置（`useFloatingLayer`，别处已测）；任务标签在窄窗口下的排版；点阵涡旋等动效；浅色 / 深色截图对照设计稿靠人看（截图在验收报告里）。
- 没做（留给后面的步骤）：见 SPEC-0006"T7 定下的细节 · 没做、留给后面"。

## T7.1 开发时在 Atrium 里跟着 task:try（SPEC-0006"T7.1 定下的细节"，2026-11-06，待验收）

宿主一侧用真宿主、真文件系统（递归 `fs.watch`）、真任务存储；写者是同一进程里另开的一个 `openTaskStore`（`pnpm task:try` 在另一个进程里，写的是同样的字节，一次真实运行见验收报告），半行用手写字节造。

| 需求 / 风险 | 验证 |
|---|---|
| 纯读重放：整份日志重放成存储会给的任务（同一个 `parseEvents` / `replayEvents`）；最后一行没写完时忽略、写完整后读到；**不写**（每个文件的哈希和 mtime 不变，落后的 `task.json` 不修、没有的不建、半行不截、不补换行）；没有事件时没有任务；中间坏行报 `TaskStoreCorruptError`；用大小和 mtime 判断变没变 | `host/tasks/task-reader.test.ts` |
| 跟随：已有的任务列出、之后写者每走一步推一次、不为第一次扫描推；后来才出现的任务目录、整个消失的任务；半行忽略且目录不变、写完整后读到；watch 起不来时轮询、watch 开着但漏了通知时的兜底；目录不存在时只记一次 warn（不含路径）、之后重试、出现后跟上并推给监听者；自己的任务同 id 时自己赢并记一次 warn；跟自己的任务目录（含符号链接）时拒绝；中间坏行的任务保留上次的状态、只记一次；关闭后 watch 和计时器都释放、不再通知，等着去抖的那次也取消 | `host/tasks/task-follower.test.ts` |
| 真宿主：被跟着的任务和自己的任务一起出现在 `list_tasks`，`open_task` 的 `followed` 为 `true` / `false`、被跟着的 `sourceSessionId` 为 `null`、`archiveFacts` 为 `null`；写者一步步写，`task_updated` 里节点一个个变色，`tasks_updated` 里状态和当前节点跟着变；**十二个任务命令**（`answer_human` 两种、`rerun_node`、`continue_node`、暂停、恢复、取消、启动、放弃、批准图、拒绝图、`answer_archive`）和 `recover`、`submit` 都答 `task_read_only` 且目录不变，Atrium 自己的目录里没有它；不认识的 id 仍是 `task_not_found`；跑着、停在节点的被跟着任务 400ms 里没有任何 pi（`session.controller` 为 0、目录不变）；写者留着半行时目录逐字节不变；同 id 时自己赢（列表、视图、命令）；目录不存在时 warn 一次、出现后跟上；目录被删时从列表拿掉并推送；跟自己的目录时拒绝 | `host/tasks/followed-tasks.host.test.ts`（日志门禁：未声明的 warn 会失败） |
| 泄漏：宿主一轮轮起停，一个 watch、关后为 0、`timer` 为 0、Node 的 `FSEvent` / `FSWatcher` 回到基线；六十次追加后资源计数回到稳定值 | `host/tasks/followed-tasks.leak.test.ts`（`Timeout` 数没比，它随测试运行器自己的计时器变，见文件注释） |
| 打包版忽略：只有主进程在 `!app.isPackaged` 时读 `ATRIUM_FOLLOW_TASKS`；Electron 里的宿主只收主进程交来的值（空串被拒） | `apps/desktop/src/main/follow-tasks.test.ts`、`host/electron-port.test.ts`；`security.md` 环境变量表登记，`pnpm boundary --all` 通过 |
| 界面：被跟着的任务的任务对话窗格写两行只读说明、不写"正在读取任务对话…"、不订阅会话；`task_read_only` 的说法 | `ui/tasks/task-area.browser.test.tsx`（"says a followed task is read-only"）、`ui/tasks/task-words.test.ts` |
| 协议：`TaskView.followed` 往返（`true` 与 `false` 都在例子里）、错误码 `task_read_only`、协议号 33；Swift 投影和往返夹具（`pnpm protocol:swift --check`、`swift test --filter AtriumProtocolTests` 通过） | `protocol/envelope.test.ts`、`protocol/remote.test.ts` |

- 破坏检查：`packages/host/src/tasks/t71-follow.break-check.json`（40 处，`project` 写明 host / leak / ui，其余是 unit）。
- 没有测试保护的：入口 `entry.ts` 把环境变量或主进程交来的值写进宿主配置的那几行（真实运行里走过：开发版 Electron 经 `config` 消息交给宿主，见验收报告）；`startTaskFollower` 里"没变就不重读"的优化（只省读文件，行为一样）。
- **一次真实运行**（2026-11-06）：开发版 Electron + Vite，临时 `ATRIUM_HOME`，`ATRIUM_FOLLOW_TASKS=<仓库>.task-try-xyz/tasks`，另一个进程 `pnpm task:try packages/host/examples/explore-work-check-merge.json --model deepseek/deepseek-flash:off`，跑到 human 节点；Atrium 里图上节点一个个变色，停在"等你验收"；task:try 空闲时哈希和 mtime 在第二次启动 Atrium 前后逐文件相同。截图见验收报告。
- 没做（留给后面的步骤）：见 SPEC-0006"T7.1 定下的细节 · 没做"。

