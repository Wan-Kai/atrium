# MP3a d49fbbb：两个整文件强制重测

## 结论

冻结 `d49fbbbe7664d17a19512fd359816e15c75e6207`，**只执行一次，exit 0，无重试**。按Stryker分类，本次执行、两个整文件及预先固定的完整方法/回调范围均达到80%；不以含缓存总分代替。追加审计发现11项Killed只有空计数输出，**不能确认它们已被具体行为断言检出**。保留全分母、仅不给这11项检出信用时，fresh/service分别85.37%/84.06%；连T也不计仍分别85.29%/83.95%。这是敏感性计算，不是新测试成绩或改判原JSON。剩余160个Survived及原Killed分类均保持，没有新增豁免，也不表示所有边界已覆盖。

UTC `2026-10-26T19:30:57Z` → `21:49:55Z`。运行前后纯文件校验通过，HEAD/源码/测试/配置/manifest无漂移，六份报告嵌入源码与冻结文件一致；原7b报告未改。父整合分支的其他验证不混入本次统计。本次没有跑额外全量、build、Electron、Swift或真实钥匙串/VPS验证。

## 冻结与缓存失效

- 原六个整文件选择与remote测试集不变；1 runner × 2 test workers，30000ms＋1.5，80%门槛。
- 工作seed来自7b完整报告；清除 **RelayLink253＋RemoteService889＝1142** 条全部历史状态，包含971K/170S/1T，而非只删存活项。
- 另外1476条保留为历史记录，含20个既有Ignored。command runner无逐测试覆盖，不能靠“测试变过”自动失效缓存。
- 初始dry-run成功，command runner的1个虚拟 `All tests` 净耗时27352ms，不是说只跑了一个Vitest用例。
- 日志：生成1862项，复用691项，另2个既有Ignored；**实际执行1169项**。以冻结seed和实际库存重新做增量身份匹配，逐项与日志对账。

## Stryker独立分类分数

K/S/T为原报告的Killed/Survived/Timeout，不等于全部分类都有具体失败证据。没有新增Ignored、CompileError或RuntimeError；以下原分数保持不变，11项缺证据的敏感性计算另列。

| 范围 | K / S / T | Stryker分类分数 | 来源 |
|---|---|---:|---|
| 本次实际执行1169项 | 1008 / 160 / 1 | **86.31%** | 全部本次执行；只计Killed仍86.23% |
| RelayLink整文件253项 | 228 / 25 / 0 | **90.12%** | 全部强制重测 |
| RemoteService整文件916项 | 780 / 135 / 1 | **85.26%** | 全部强制重测；不计T仍85.15% |
| `#checkPong`完整10项 | 10 / 0 / 0 | **100%** | 原7b固定范围70%，本次完整重测，不只3个旧S |
| control close完整注册/回调31项 | 30 / 1 / 0 | **96.77%** | 固定区间相交统计 |
| `#setState`完整7项 | 7 / 0 / 0 | **100%** | 全部本次执行 |
| C终态close与#setState并集38项 | 37 / 1 / 0 | **97.37%** | 不重复计相交身份 |
| `#sampleTraffic`完整72项 | 65 / 7 / 0 | **90.28%** | 包括所有新分支 |
| 四个直接修复范围并集120项 | 112 / 8 / 0 | **93.33%** | 不是两整文件或全部fresh的替代 |
| 选中其他四文件历史缓存691项 | 638 / 53 / 0 | 92.33% | 本次未执行；另2个既有Ignored |
| 范围外历史缓存765项 | 736 / 21 / 8 | 97.25% | 本次未执行；另18个既有Ignored |
| 累计有效2625项 | 2382 / 234 / 9 | **91.09%** | 含缓存，只作背景；另20个既有Ignored |

### 11项缺失败证据的保守敏感性（不是新测试结果）

| 范围 | 全分母不变、仅不计11项检出 | 再不计Timeout |
|---|---:|---:|
| fresh | `(1008−11＋1)/1169＝85.37%` | `997/1169＝85.29%` |
| RemoteService整文件 | `(780−11＋1)/916＝84.06%` | `769/916＝83.95%` |

11项全在service且不与四个固定区间相交，RelayLink及固定区间分数不因这个计算改变。没有增加Survived、ignore或重测，也不能把上述百分比说成新执行成绩。

预先冻结的1-based半开区间：link `#checkPong`154:3–165:4、control close注册/回调288:5–313:7、`#setState`325:3–330:4；service采样830:3–865:4。取**与区间相交的完整变异**，包含包围节点，绝不按结果裁剪。close范围含包围它的#connect空体变异763，不含287行error监听843；因此是30K/1S，而不是仅按起点落入区间的29K/1S。未改变冻结口径。

## 原1142身份与改写

离线曾预报1129个源码投影、13个跨改写无法一对一识别；实际生成后，投影中又有2项没有对应的当前生成身份（旧service1905的ObjectLiteral、1923的CallExpression）。**13＋2均不当作Killed**。

- 实际重新识别1127项：969K/157S/1T，全部本次执行。
- 原Killed中957仍Killed，12项跨改写、2项没有当前生成身份；无已映射Killed退为Survived。
- 原Survived中12被杀、157仍存活、1跨改写。
- 原Timeout1754实际重测后仍Timeout。
- 当前另外42个新/改写变异：39K/3S。与1127个保留身份合成1169个实际执行项，不与旧477或旧693分母混算。

旧未识别项和新项均在逐项账中保留，不猜测语义相似就建立一对一映射。

## Timeout、测试截止与附带错误

**本轮唯一fresh Stryker Timeout为1754**：service718行 `others.length >= 2` → `others.length < 2`。首个认证会话进入时 `others=[]`；条件0<2恒真，`shift()?.close()`对空数组不改变长度，也没有await/yield，构成可达同步不终止循环。工作seed已删除旧结果；最终报告明确给出新的Timeout，进度日志在977/1169处首次出现1 timed out。

证据边界：报告没有该项的statusReason/执行栈，结论来自**本次分类＋身份核对＋源码可达性推导**，不是采样到的现场栈，也没有额外复跑。另8T全部仍为旧crypto缓存，未重测；与旧1638（已在7b重测Killed）不是同一项。

### 追加：全fresh Killed的失败证据形状核对

原先只筛查测试超时/错误候选，漏掉了没有错误标记的Killed。父/Opus指出后，直接从权威报告重新检查全部1008个fresh Killed并核对完整reason：997项有FAIL、失败数量汇总及错误标题；恰有11项没有FAIL/错误/Unhandled，未发现其他同形缺证据项：**1375、1446、1449、1462、1465、1468、1504、1513、1530、1533、1863**，均在service。

这11项reason都只有RUN头、空白、`Test Files   (24)`、`Tests   (45/13/43)`及Start at/Duration元数据，通过/失败数量为空；`testsCompleted: 1`和`killedBy: ["0"]`仅指command runner的虚拟`All tests`。**无法由这些输出判断崩溃、bail、截断或具体断言失败**，不凭静态上可能抛错补造现场因果。原始形状、逐ID元数据及保守计算见失败审计新增章节。确认997项有标记不代表人工逐项确认了全部因果。

### 原测试截止及附带错误候选

另外，**70个Killed含Vitest测试/hook超时**：link42、service28；18个未处理异常/基础设施候选中16项重叠，共72个不同记录已逐项对照本轮源码及日志。部分是明确异常/断言失败，部分只有截止但源码显示必要的resolve/close/拒绝/淘汰路径被删除；后者不冒称有独立的超时前断言或现场挂起栈。本lane两路只读审计支持这72个候选的变异致错解释，但不等于证明所有flaky均不存在。父/Opus仅限定复核固定范围120项、C区间7条依赖测试超时的记录及898/1505/1754；其余约60条未由父/Opus全量复核，不把本lane判断写成其逐项认可。

必须保留两项附带噪声：

- **link898**：已abort仍开probe导致的单元等待超时与变体一致；同一记录另有host-connection日志门禁缺少预期warn，不能归因于此变体，不拿来当检出证据。
- **service1505**：不取消旧probe使checking不结算，与超时一致；另有清理ENOTEMPTY，原因未定，不当作变异证据。

没有为这些记录新增重试、加时、弱断言或豁免。逐ID变体、失败测试及因果限制见 [失败审计](mp3a-d49-failure-audit.md)。

## 直接修复范围的8个存活项

以下全部继续计Survived，不把当前调用图解释批量转成等价豁免。

| 当前ID | 变体 | 尚未覆盖/证明的边界 |
|---|---|---|
| link860 | 删除close中的diagnostics.dispose | ready后finish已清理，但stop-before-ready会走这个else作为显式观测监听清理；不能由通常路径重复就断言全等价或永久泄漏 |
| service1885 | 删除无watcher守卫 | 当前get先加watcher、最后unwatch取消timer；未证明所有已入队/重入定时器边界 |
| service1887 | 早退false改true | get忽略返回值，#changed又有关闭/无watcher保护；当前调用图解释，不扩大豁免 |
| service1893 | previous/时间守卫整体true | 初次totals空，未触发缺previous；同时间/回拨未测 |
| service1898 | 正时间差判断true | 实际Clock用Date.now，不是单调时间；回拨可产生负速率/零分母，不能称不可达 |
| service1899 | 时间差`>`改`>=` | 同一时间戳的除零边界未覆盖 |
| service1930 | 删除contents可选访问 | 有认证计数时通常已加载contents，当前内容替换不置null；没有null＋计数的执行证明 |
| service1932 | 设备ID匹配改恒true | 只证明“列表非空”；现有隐藏用例分别被blocked或空列表挡住。重置保留旧计数后、衰减前再配新设备的组合仍是覆盖缺口，未实测该场景 |

其他152个存活属于两个整文件的既有范围；完整ID、位置、替换和状态保留在原报告与fresh清单，不隐去或转成ignore。

## 资源、文件与完成范围

runner结束后发现45个本轮relay孤儿候选。逐个核对PID、启动时间、PPID=1、PGID=81202、完整命令及`sandbox-G98NoC`归属后，仅SIGTERM这些PID；精确PID与该sandbox的Node进程复核均为0。未触及其他lane、用户应用或共享cache；这是被破坏的变异测试进程清理记录，不冒称未变异应用发生了同样泄漏。Stryker自身按原配置删除sandbox，嵌入源码及日志仍保存。

- 原始报告：`reports/stryker-incremental-remote-d49fbbb.json`
- HTML：`reports/mutation/remote-d49fbbb.html`
- 分层统计/身份账/冻结manifest/区间：`reports/mp3a-d49-{summary,ledger,manifest,scopes}.json`
- 完整运行、UTC、退出码、前后哈希/进程及精确清理：`/tmp/mp3a-next-mutation-d49fbbb/`
- 只读统计脚本、fresh及失败候选、固定范围完整库存、输出哈希：`/tmp/mp3a-d49-analysis/`

只验证d49冻结版的本次批准范围；未变的diagnostics、pong、vault、pairing分数是旧缓存，不冒充本次实际新执行。没有进一步代码修复、全仓全绿或用户验收结论。
