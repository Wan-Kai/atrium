# 受控 UI 诊断（c710d51）

本任务只改诊断测试/记录，不改产品，不直接修正原断言。作者基线 `c710d51`，生产源码同 `376e1b5`；不将新观察回写为历史通过。

历史：`d910237` 桌面泄漏整套 ask-user 失败（运行中 span / SVG 指纹），定向仍失败且为 RunStatus / RunCat / shimmer 的另一组指纹；`376e1b5` 完整非泄漏 Electron 67/68，children 原两个 source-line 断言之一失败，父当时同环境定向 1/1 不抹失败；本轮诊断并非与该历史环境逐值相同。完整出处见 `mobile-integration.md`，原日志/截图不修改。

## 预先限定的实验

最多各一次，任一启动、编译、夹具错误立即停报；不加 sleep、重试、预算或阈值。最多构建一次。保持默认测试超时，原 round 的既有等待不加时。

- Q0：复制原 ask-user 流程/断言，1 次跳过预热、8 次测量；两次堆采样前后仅记序列化终态/折叠值，不持有 DOM/JSHandle。旁路观测可能影响调度，绿不能否认旧失败。
- Q1：相同预热/8 次，增加对应 run_settled(completed)、turn done、reply streaming=false、question 消失、fold 真实退出屏障。
- Q2：同 Q1，仅固定跳过/提交各一次预热，仍测8次；绿也要查增长对象保留路径，不凭增加预热认定无害。
- C0：原 children 期望值保留，失败后正常展开旧轮；仅记录必要任务/送达/事件 ID、落盘与协议/DOM 归属，主断言仍失败。
- C1：复用 README faux 的按任务匹配独立 gate；audit 已交接后才放行父 gate 返回测试目录内真实 read 工具，验证运行中 audit 旧轮 step/lane；父 settled 后放 tests，验证新轮来源行。
- C2：正常 UI 停止父（不是 agent_stop），确认 paused=stopped，两个 waiting report 后继续发送，核对同一批 IDs→落盘→投影→DOM。

环境：临时 HOME / PI_CODING_AGENT_DIR、固定 Node22.19.0 与已装真实 pi、已有 browser cache；白名单不继承 API keys/代理/NODE_OPTIONS/SSH agent/开发覆盖，禁版本查询。faux.env 保持优先级。无外层 sandbox，不降低 Electron 安全设置，不称硬阻断全部外网。不接触用户凭据、vault、Keychain 或 VPS。

**环境差异**：本轮 runner 使用 `LANG=zh_CN.UTF-8`，PATH 为 Node22.19.0/bin、`/Users/ktoon/.local/bin`、`/usr/bin`、`/bin`、`/usr/sbin`、`/sbin`；不含父旧 full-run 的 `/opt/homebrew/bin` 和 `/usr/local/bin`。这是沿用最小环境策略，不是与旧67/68运行逐值同env；locale/可执行文件发现的影响未作对照，不据此认定原因，也不回写旧manifest。

原堆空增长/来源行断言位置和期望值保留。堆及原始私有诊断只在测试拥有的0700目录、0600文件中用于必要分析，结束清理原始堆，保留必要元数据/保留路径与退出/失败证据。清理不吞主错误，各资源即使前一步失败仍尝试释放。

## 本次窗口：选例失败后停止

- 工作区起初干净，ff-only 到 `c710d51da12b2bc4a1b21e31a3fab6e4255e7a8a`；未改产品源码。新增 Q0/Q1/Q2 专用诊断测试草稿；C0/C1/C2 尚未编写/执行。
- 编写阶段 desktop typecheck exit 0，日志 `/tmp/mp3b/ui-diag-typecheck.log`；这不是动态验证。
- 唯一一次 `pnpm build` exit **0**。白名单环境键名、HEAD及1121个构建产物文件SHA-256记录在 `/tmp/mp3b-controlled-c710d51/build/manifest.json`，日志同目录 `run.log`。其中 `sourceHash=a7f795d9…` 是当时诊断测试文件的hash，**不是产品源hash**；产品版本依据记录的HEAD、当时tracked树干净以及产物hash绑定。不以此推导任何测试通过。
- Q0 的唯一启动尝试使用 `--grep '^Q0 '`，Playwright 返回 **No tests found / exit 1**。Playwright grep 匹配含文件名的完整标题，该锚定前缀不匹配注册用例；测试主体、Electron、堆采样均未开始。日志 `/tmp/mp3b-controlled-c710d51/Q0/run.log`，命令/源 hash 在同目录 manifest。**这是选例/夹具失败，不是 Q0 泄漏结果。**
- 按授权的停止规则，没有校准选择器后重跑，也未运行 Q1/Q2/C0/C1/C2；原 ask-user/children 断言及旧失败记录未动。
- 两个外层隔离 HOME 均已删除，无堆文件产生；工作树 app/host 可执行 argv 精确范围匹配为 0（不是全系统进程审计），资源记录 `/tmp/mp3b-controlled-c710d51/resources.json`。证据目录0700、日志/manifest0600。
- 当时按规则停报。父随后单独批准修正选例、首次执行主体，见下节；旧 manifest/source hash 不修改。

## 恢复授权后的六个首次主体执行

没有再次构建。父要求去掉诊断新增 reload，并把缺失快照逐个记为 not-produced（实际 IO/权限错误仍聚合）；仅改任务草稿，未动产品/原测试/断言/超时。Q0 先 `--list`，未锚定完整标题片段精确列出1项；旧 No tests found 尝试与本次首次主体分目录保留。没有 pass-with-no-tests、sleep、重试或继续增加预热。

| 实验 | 唯一主体执行 | 实际观察 | 证据目录（均在 `/tmp/mp3b-controlled-c710d51/`） |
|---|---|---|---|
| Q0 | exit 0，12.0s | 1次跳过预热＋8轮，原零增长断言通过；两次采样前后均 done/streaming=false，但末轮 expanded=true、fold=open；run started/settled 为1/1及9/9 | `Q0-first-body/` |
| Q1 | exit 0，24.4s | 仍1次跳过预热＋8轮；对应run settled completed、done/streaming=false、question消失、fold真实退出均达到；采样前后expanded=false、fold=[] | `Q1-first-body/` |
| Q2 | exit 0，26.8s | 固定跳过/提交各预热一次＋8轮；同样到语义终态，run数2/2及10/10；未继续加预热 | `Q2-first-body/` |
| C0 | exit 0，3.3s | 原两个source-line断言及后续audit打开操作均通过；本次是audit和tests各开一次闲时新轮，非混合呈现；不覆盖历史67/68失败 | `C0-first-body/` |
| C1 | exit 0，5.1s | audit sending交接时尚未落盘；放行父gate后真实read完成，audit同delivery ID落盘且在旧轮agent step/lane；父settled后才放tests，新轮source-line正确 | `C1-first-body/` |
| C2 | exit 0，2.9s | 正常UI stop，父run stopped/paused=stopped；两条waiting后正常继续发送；一条落盘report含两个delivery IDs/events，协议新轮source有两项，DOM两条来源行 | `C2-first-body/` |

### 额外混杂与证据可重算边界

**Q0及C0主动关闭了trace/screenshot/video**（其他本轮诊断也如此），而原例默认 `trace: retain-on-failure`、`screenshot: only-on-failure`。因此保留流程/期望值不等于复刻历史运行条件；录制方式是除旁路观察和环境差异之外的额外混杂因素。本轮没有证明Playwright快照器持有DOM，也没有证明关闭trace解释了旧失败。旧children trace仅含测试调用、没有frame-snapshot，是对那个历史工件的观察，**不能据此推断当前trace真实行为；当前内部采集/保留行为未核实**。

封存的 `run-ui-diagnostic.py` 与 `inspect-stable-detached.py` 是事后归档副本，不当作各次执行前已锁定的输入。**runner的版本差异可确定**：C0 manifest没有helperHash，而最终runner必写该字段。**inspect不能仅凭较晚mtime认定逻辑改过**：作者流程是从 `/tmp/mp3b/inspect-stable-detached.py` 复制归档；本次静态核验这两个现存文件逐字相同，SHA-256均为 `ad40d5ba862a17b4d13e3e082cf656d90f2bf1591a03483dbde4a2f6cd93ae53`。这只证明当前临时文件与归档副本一致，没有运行前版本hash，不能反向证明执行时必为同版，更不补造“运行前封存”。生成 `heap-audit.json` 的原一次性计数分析脚本未保存；raw heap也已删除。因此这些额外计数是作者分析产物，父现在不能从原堆独立重算；校验JSON及hash不等于复算计数或验证原分析输入。父本次未复跑、未解析原堆，只核了元数据及已封存工件。

### Q 的边界与保留路径

作者当时解析六份V8堆，报告三组同名 native detached 计数 **1→1**，按名称没有增长对象。Q2两份堆中的native ID分别为 **386959、291135**；同名计数不证明跨快照为同一对象。路径脚本分别从根做排除weak边的BFS，保存的是**单条最短强路径**，不是全部retainers、支配树或retained-size分析：GC roots / Global handles → global_object → `__zod_globalConfig` → `localeError` → context / previous → native。脱敏类型/边名/ID见 `baseline-stable-retainer.json`、`final-stable-retainer.json`。它们不是本次增长对象，不能排除其他保留来源，更不能拿来解释历史 RunStatus/RunCat/SVG 指纹或当作豁免。

Q0的旁路CDP/属性读取可能影响调度，且本次采样前本来就已done。三组均绿，没有形成失败→成功的判别对照；**不能判定旧失败由终态屏障或初始化引起，也不提ask-user产品修复。** 原reply数量屏障不保证fold卸载这一代码/观测事实成立，但不是历史泄漏的因果证据。

### C 的身份链与最窄结论

C0保留原期望值、流程和失败出口，没有把原source-line断言改绿；但录制配置及上述环境差异使其不是历史条件复刻。本次两个任务的done/replyEntry、各一次父会话custom_message report、task/session/delivery/event ID、协议新轮来源及DOM均一致；faux contexts也含相应task ID。contexts含历史，因此同一audit在后续上下文再次出现不算重复送达，去重以落盘delivery ID为准。

C1新增的是独立的**read工具批边界**，不是原例的spawn工具批边界；它只证明合法混合路径存在，不复现原例精确时序。C1两个“打开”按钮只断言可见，**未点击验证两条路由**；C2同样只核对应来源按钮可见。C0实际只点击audit来源入口，不能泛化为两个孩子、两种呈现入口的路由均已验证。

C1/C2只复用公开 `README_FAUX_EXTENSION` / `ReadmeFauxScript.children[].match` / `waitFor`；没有使用截图App的provider/窗口/PATH配置，而是在本次 `fauxPiEnvironment` 创建的私有wrapper里选用该既有扩展，保留E2E_REAL_PI、PATH、--version及faux.env优先级，仍走正式 `launchApp`。gate到达、交接日志不是完成屏障；实验另核任务记录、落盘details、协议投影和对应turnId中的DOM。

- C1 audit delivery `8726b137-d41d-418f-8097-b225bbd4f47a`：交接时sending、落盘report为空；工具边界后在父会话entry `a5accc4d`，task `t-d4e38837-c302-4867-bed5-224f032d91bd`，旧turn `e85a9b1e-943d-44ee-ab82-390e59d27453`。该轮展开后只有audit finished事件行及打开按钮，**source-line=0**；tests随后在新turn `a5b52620-bf9c-4463-b84f-a3458189f722` 来源行，delivery `c1f08fb8-7970-4382-acfc-860b564011df`。父两次run均completed。
- C2 两条waiting ID为 `872ceb5d-0be4-47e9-9ecd-61e883f16bd2`（tests）、`7c9a4889-f1d3-48d9-b1a3-514651597121`（audit）。恢复后同一entry `e35492d7`含两ID及两个finished事件，新turn `96c30691-c8b6-457f-a030-78d18c9dcb77`两条来源行；按实际完成顺序tests在前，不假设release顺序等于到达顺序。父先stopped后completed，两个子任务均done。

**已证明的最窄结论**：合法混合时序下，“两个报告都必须是source-line”不是SPEC必要条件。若父批准修测试，应以具体任务的送达及source/agent-step正确归属为屏障，正常展开后核对，不只是放宽文本选择器。**尚未证明**：376e1b5历史失败必属A；当时缺少身份链，B/C仍不能靠本次绿排除。C0本次通过不改写旧失败；C1/C2也不代表所有送达竞争已覆盖。没有修改UI/host/pi生产实现。

### 源码、证据与收尾

- 旧未执行选例尝试的 Q 源hash仍是 `a7f795d90cebf922287ebfb6a0f4790e5134c16cbb24cab1fdb5cfa75037c7a1`；本次Q0/Q1/Q2共同为 `d20f944d5206d6745ebb7a215287b4a18c583aabb3906e57e12578e8e468c65a`。
- C0用例源hash `6c77c3268b04da63bb38598fe2a71b5f4a2d3a1be6ef3d261d9d307f3e32a6f2`；C1/C2共同为 `a787f6da1b7517b3ed910a4b6046dfb84adffa080ac85f8b4f49c10f5653f0b6`。C1/C2的旁路helper额外记录controlHistory，C0时helper哈希单列在 `C0-first-body/helper-source.sha256`，未将后续helper版本冒称C0输入。
- 每个目录保留一次run.log、manifest、observations；Q另有作者生成的heap-audit（hash/数量、无正文）及Q2的脱敏稳定节点路径。`evidence-hashes.json`清单封存39项证据hash（原目录连清单自身共40份文件，不是清单40条）；它不补足上述执行输入/原分析脚本缺口，不保留raw协议帧或请求头。
- 父只读复核39项封存、1121产物hash、三份重命名源hash及C1/C2 helper hash一致，并独立核对C1/C2 task/delivery/entry/turn与DOM链；没有复跑。Q仅核元数据，未从原堆复算。Opus单路只读意见支持最窄结论，不能替代这些未做的动态/原堆检查。
- 事后新增私有附件位于 `/tmp/mp3b-controlled-c710d51/source-snapshots/`：四份当前草稿的确切字节，以及仅以controlHistory三处逆差分恢复的 `children-diagnostic-data.C0.ts`，后者SHA-256必须并已匹配 **`21fbe86eb6bcbbe17826840246622609c4cad5a3ace0ab318cec01369c90e21d`**。当前helper SHA为 `549739780f69395561e461090db663a4c16df5b240806e1b683abbb4810a387e`；未改任何工作树草稿。新附件连同说明使用独立 `addendum-hashes.json`（6项），旧39项逐项复核仍一致，旧hash表本身未改。
- 精确清理测试拥有的 `apps/desktop/test-results/children-boundary.diagnost-6de15-olled-idle-batch-deliveries/observations.json`：删除前是0600普通文件，SHA-256 `69af72168bd1d55e7bd449ea6b2fc39cf2b0964fc3f04f64673c48676e94f659` 与原封存 `C2-first-body/observations.json` 相同。只删该副本，未删目录或修改封存；记录在新增 `addendum.json`。
- 因果分析后按原始SHA逐一核验并删除**6份原始heap**，剩余0；私有证据目录0700、文件0600。`final-resources.json`记录6个测试App都exitCode=0，PID现均不存在；6份外层HOME已删除，worktree app/host可执行范围匹配0。这不是全系统进程审计，也不是每个gate内部timer的单独泄漏证明。
- 六次主体后没有新增重型验证、全套或负控；没有增加测试超时。任务专用测试/旁路helper继续是**未提交草稿**，不将Q0作为已解释的正式回归交付。执行完仅将三个任务拥有的 `*.diagnostic.spec.ts` 改名为 `*.diagnostic.ts`（ask-user、children、children-boundary），内容字节/SHA完全不变，退出Playwright默认spec/test收集；没有更改默认配置或脚本。执行时的原路径/manifest不回写，复现时须父批准显式选入。最终保留/提交哪些诊断资产由父复核后决定。本次边界补充只提交本文，不提交/改动四份诊断草稿，不将它们带入正式check；仅做文档及静态证据核验，没有运行测试/build。

## 最窄测试修正提案（只读，尚未实施/运行）

1. **只修原children用例的完成与呈现判据。** 从实际spawn结果取得audit/tests各自的sessionId/taskId，要求两项finished报告都有精确身份链：对应任务完成、父会话落盘report及delivery ID可核、当前协议投影中每个预期事件恰好一次。固定faux末句不得作为完成屏障；若仍保留文字展示断言，与送达证明分开。原角色、独立worktree/分支等断言保留，不改产品/协议，也不改ask-user。
2. **按已验证投影决定DOM位置，而非两个locator做OR。** 汇总 `turn.source.report.events` 与 `turn.steps[kind=agent].source.report.events`，对完整(sessionId, taskId, event)键计数，跨source/step也不能重复。协议指向source时在对应turn的来源行验证；指向agent-step时先正常展开该turn过程，再验证对应finished事件行。两种路径都必须核对各自的正确turn归属和唯一性，缺失/错误身份/重复/错误轮一律失败；不能仅增加文本等待或删除报告断言。
3. **保留并补足打开正确子会话的原意。** 正常点击实际呈现的audit入口，核对目标子会话session/task身份及选中标签；返回父会话后同样点击tests入口。tests可能跨worktree，返回使用已有父会话导航而非假设首标签就是父会话。每次以该次导航后的真实订阅/快照身份与可见会话相互核对，不只验按钮可见；保留原audit打开验证，并补上本轮尚未验证的tests路由。
4. **考虑只提炼C1/C2为两个稳定正式回归，不搬整套诊断。** 沿用明确的公开gate及任务身份链，C1固定read批边界混合路径，C2固定停止/两条waiting/继续发送的同批路径；无需新生产RPC或新通用harness。获单独窗口后，先在C1保留其已成立的送达/投影链、加回原过强audit source-line=1条件，要求它确实在该断言失败，作为**测试判据的红证据**；再核验正确判据及两个实际导航。该红证据目前尚未执行，不能用逻辑反例冒称一次新的红测试，也不能把它称为376e1b5历史失败根因复现。

只有父批准后才决定正式助手/用例的最小组织、实现与验证。旧67/68及ask-user历史失败不直接关闭；本提案不承诺已排除历史B/C或已修复泄漏。
