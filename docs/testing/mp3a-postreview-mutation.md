# MP3a 审查后变异验证：冻结 7b88613

## 结论与边界

2026-10-26 16:26:14–17:24:11 UTC，仅执行一次，退出 0；dry run 通过，未重试、未增大超时、未新增豁免。**不能把退出 0 写成所有审查范围均达标**：预先固定的 `RelayLink.#checkPong` 小范围仍为 **7K/3S＝70%**，需继续处理，不能由全组分数遮盖。

源码与测试冻结在 `7b88613cc4d0ad150139cfc4a27fe136d012f20a`。运行前、运行后均验证 HEAD、源码和测试哈希；最终报告六个执行文件的嵌入源码逐字匹配冻结版。原报告、配置、seed、manifest 的 21 项哈希前后不变。父分支的 UI/Swift/Electron/泄漏结果与本次无关，不计入此成绩。

**尚未实施的后续事项**：设置窗口是订阅 owner，SPEC 仍写“手机页”；采样 tick 无条件推送相同状态。父已要求待本次结果保存后另行安排最窄修。此报告只证明冻结版，不能代表后续 traffic 去重修复已验证。

## 固定范围与执行来源

- 原五个整文件：`relay-diagnostics.ts`、`relay-pong.ts`、`relay-link.ts`、`remote-service.ts`、`pairing.ts`；另加桌面 `apps/desktop/src/main/vault.ts` 整文件。
- 原 remote 测试集不缩小；1 runner × 2 test workers，基础超时 30000ms、系数 1.5，门槛 80%。无真实钥匙串、VPS、UI 或 Swift 测试。
- command runner 只有虚拟测试 `All tests`，无逐测试覆盖。不能依赖“测试改过了”使缓存自动失效。
- 使用同版 Stryker 10.0.0 增量匹配器离线复原原 477 身份：diagnostics 225、pong 31、link 63、service 155、pairing 3，准确对账历史 1619＝477新增＋1140复用＋2Ignored。
- 工作 seed 删除原477**所有状态**及旧 vault 整文件209项，共686项；不是只挑存活或已杀项目。诊断、pong及改过的 `#checkPong` 范围均强制重新执行。原报告不修改。
- 日志显示：dry run 20639ms；本轮生成1835项、复用1140项、Ignored 2项，**实际测试693项**。与冻结 seed 的离线增量重放逐身份对账一致。

## 分数分层

K/S/T 为 Killed/Survived/Timeout。删除、改写后不再能一对一识别的旧变异不算 Killed；没有新增 Ignored、CompileError 或 RuntimeError。

| 范围 | K / S / T | 分数 | 说明 |
|---|---|---:|---|
| 本次实际执行693项 | 623 / 70 / 0 | **89.90%** | 含远程范围和 vault 全文件，不冒充原477 |
| 原477中能一对一映射的465项 | 423 / 42 / 0 | **90.97%** | 全部强制重测；另12项不计Killed |
| 原远程范围的当前对应472项 | 430 / 42 / 0 | **91.10%** | 465个保留身份＋7个审查改写后的当前变异，不是只重跑旧Survived |
| 当前行为范围577项 | 524 / 53 / 0 | **90.81%** | 原映射项 ∪ 预先固定的审查方法区间，非所有文件的并集 |
| diagnostics 整文件225项 | 211 / 14 / 0 | **93.78%** | 全部本轮执行；原169/225＝75.11% |
| vault 整文件221项 | 193 / 28 / 0 | **87.33%** | 全部本轮执行 |
| `RelayLink.#checkPong`，154–165行 | 7 / 3 / 0 | **70%** | **局部未达标，不豁免、不遮盖** |
| relay-pong 整文件30项 | 30 / 0 / 0 | **100%** | 正确的非破坏 probe 语义，不沿用旧踢手机预期 |
| vault 原生错误常量22行＋read 121–149行＋write 163–188行 | 94 / 11 / 0 | **89.52%** | 冻结前已指定的分类与版本保护范围 |
| 选中范围缓存1140项 | 986 / 153 / 1 | 86.58% | 本轮未执行 |
| 范围外历史缓存765项 | 736 / 21 / 8 | 97.25% | 另18个既有Ignored；本轮未执行 |
| 混合总计2598个有效项 | 2345 / 244 / 9 | **90.61%** | 另20个既有Ignored；只作累计背景，不是新增行为成绩 |

原477的迁移账：368个旧Killed仍Killed，54个旧Survived被杀，42个旧Survived仍存活，原Timeout1638映射为当前1853并Killed；9个旧Killed＋3个旧Survived因审查改写不再一对一识别。未识别的旧ID：pong 743/744/745/750；link 515/516/523/525/526/527/528/529。它们不进入“杀死”计数，当前替代代码的变异另算。原99S现为 **54K＋42S＋3被取代**。

## Timeout 与失败日志审计

本轮**没有新的 Stryker Timeout**；原1638的新结果是明确断言失败，不再依靠超时算检出。混合报告里的9T全为旧缓存，未重跑：

| 当前报告位置/身份 | 旧变体 | 解释边界 |
|---|---|---|
| service 1754，718行 | `others.length < 2` | 空列表仍不断 shift 的静态不终止路径；本次未复现 |
| framing 65行 AssignmentOperator | `offset -= MAX_CHUNK` | 分帧偏移反向，终止条件无法正常到达；旧记录 |
| framing 65–70行 BlockStatement | 空循环体 | 无条件 for 丢失 return；旧记录 |
| framing 67行 ConditionalExpression | `false` | last 永不成立，分帧不终止；旧记录 |
| framing 67行 EqualityOperator | `end !== bytes.length` | 最后一块无法成为 last，可继续空分块；旧记录 |
| framing 69行 ConditionalExpression | `false` | 删除分帧唯一 return 条件；旧记录 |
| framing 139行 ConditionalExpression | `true` | Pong 被读为 Ping，真实双端可互相回应；旧记录，不称本轮忙循环 |
| secure-channel 138行 ConditionalExpression | `true` | 所有接收都发 Pong，可形成响应反馈；旧记录 |
| secure-channel 138行 EqualityOperator | `received.kind !== "ping"` | Pong 也再触发 Pong；旧记录 |

另筛查本次 Killed 的完整 `statusReason`：45项文本候选中，14项只是测试标题或输入包含 ECONNREFUSED，不是环境连接错误；29项确实包含 Vitest 的测试或 hook 超时；余2项含未处理异常。

- relay-pong 的10项（960/961/966/972/973/975/978/991/993/994）分别删除 Promise 执行体、deadline finish、finish体、resolve、pong体、匹配分支、close回调，或改空 pong/close 事件名、删除 ping。失败测试对应等待 probe 完成/实际 ping/close；源码与日志支持变异破坏了完成条件，不把它们说成原代码忙循环。
- vault 70 有**直接版本保护断言失败**（应 stale 却写入成功），同时出现另一个 remote-service 测试的 `relay_unreachable` 未处理拒绝。该伴随错误如实保留；不是凭它才算杀死。
- diagnostics 469 删除构造体，初态断言直接遇到缺失 Clock；异步关闭时又有相同 `now` TypeError。两者均与该变异吻合。
- 不新增重试、拉长超时或删掉错误日志。若把29项含测试/hook超时的 Killed **全部不记检出而保留分母**，本次693项保守下限仍为 **594/693＝85.71%**；这只是敏感性分析，不替代逐项因果记录，也不掩盖 `#checkPong` 的70%。

### 29项测试/清理超时的逐项记录

这些是 **Killed 中的 Vitest 超时**，不是新 Stryker Timeout。T 为测试15s截止，H 为hook10s截止。审计仅对照本轮日志、源码及测试，未重跑证明完全无flaky；部分次级H日志没有指明卡住的具体await。

| 当前ID | 被改操作与失败观察 | 因果判断 |
|---|---|---|
| link 778 | 清空ready截止回调；silent relay测试T | 不terminate，close及pending retryNow无法结算 |
| link 844 | 删除control close监听；70KiB+1后仍connected，另H | 已有直接状态断言失败；同时丢closed.resolve，stop可挂起 |
| link 846 | 清空同一close监听体；70KiB+1仍connected＋H | 同上，非仅凭超时杀死 |
| link 900 | 清空probe Promise执行体；off-probe/projection测试T＋H | 永久pending，无socket/abort/resolve；disconnect等待probe.done |
| link 905 | 清空finishRequest；70KiB probe未收到hello＋H | 丢request.end，真实HTTP请求没完成；直接握手断言已失败，具体清理await未定位 |
| link 910 | 清空probe deadline；irrelevant replies测试T | 无正常reply且deadline不关闭，probe未结算 |
| link 912 | 删除deadline socket.terminate；silent TLS测试T | diagnostics.timeout本身不结算Promise，close才结算 |
| link 938 | 删除probe close监听；bad-accept测试T、取消probe测试H | 丢resolve与清理，disconnect继续等待 |
| link 940 | 清空probe close体；bad-accept测试T | 同上，close不再结算 |
| link 956 | 去掉onDiagnostics可选调用；probe测试T＋明确TypeError | 未提供可选回调时抛错，发生在resolve之前 |
| link 958 | 仅删除resolve(error)；disabled probe/close测试T＋H | socket结束但Promise未完成 |
| service 1553 | PhoneStream options变空对象；握手等待失败＋H，明确clock.now TypeError | 构造失败、数据连接没打开；具体次级清理await未定位 |
| service 1554 | PhoneStream events变空对象；握手等待失败＋H，明确onBytes/onClosed非函数 | 回调缺失阻断握手/关闭；关闭异常还可阻断link完成回调 |
| service 1690 | 配对控制拒绝条件整体false；错误kind测试T | 不再关闭非法control，测试等待session.closed |
| service 1691 | `(A∨B∨C∨D)∧E`；错误kind测试T | 已建候选E=false，非法control不拒绝 |
| service 1692 | `false∨E`；错误kind测试T | 已建候选E=false，非法control不拒绝 |
| service 1693 | `((A∨B∨C)∧D)∨E`；错误kind测试T | 已建候选D/E=false，非法control不拒绝 |
| service 1694 | `false∨D∨E`；错误kind测试T | 同上 |
| service 1695 | `((A∨B)∧C)∨D∨E`；错误kind测试T | 当前代候选C/D/E=false，非法control不拒绝 |
| pong 960 | 清空Promise执行体；live/projection测试T | 没有ping、监听或resolve |
| pong 961 | 清空deadline回调；非破坏timeout测试T | fake clock已推进但失败结果不结算 |
| pong 966 | 清空finish；相关pong测试T | 所有结束路径失去resolve |
| pong 972 | 仅删除resolve；相关pong测试T | 释放资源仍不完成Promise |
| pong 973 | 清空pong回调；相关pong测试T | 正确pong不能结算 |
| pong 975 | payload匹配条件false；相关pong测试T | 正确pong也不能结算 |
| pong 978 | close回调变undefined返回；拒绝/stop测试T | 物理关闭不结算检查 |
| pong 991 | pong事件名变空；相关pong测试T | 监听不到真实pong |
| pong 993 | close事件名变空；拒绝/stop测试T | 监听不到真实close |
| pong 994 | 删除socket.ping；相关pong测试T | 不发出真实探测，等待实际ping/结果无法完成 |

service表中：A=`kind !== pair_confirm`，B=`request === undefined`，C=`generation不匹配`，D=`remoteStatic === null`，E=`handshakeHash === null`；原条件为A∨B∨C∨D∨E。非法control测试等待关闭时没有继续推进fake clock，因此不能靠后续配对deadline“补救”被删除的安全拒绝。两文件19项经独立只读审计，均有源码支持的变异致错路径；不需要假设无关环境超时才能解释Killed，但这不等于全套已证明无flaky。

### #checkPong 的3个存活项（未豁免）

原守卫 `!this.#stopped && generation === this.#generation` 同时保护诊断替换与通知：

| 当前ID（旧ID） | 变体 | 覆盖缺口 |
|---|---|---|
| 738（517） | `true` | stop/旧代结果仍可能覆盖诊断并通知 |
| 740（519） | `!stopped || generation === current` | stopped同代或运行中旧代都可能穿过 |
| 742（521） | `!stopped && true` | 丢代次保护 |

现有关闭测试核对完成与资源，未完整断言停止后的诊断不变及无迟到通知。可在父安排后补这两个公开观察；旧代路径可考虑在error通知中同步调用公开retryNow，令旧check的then晚于代次变化，再断言旧live证据不能覆盖新connecting/ready。此测试时序尚未实测，不声称已证明可达或等价，更不恢复“probe超时踢手机”的错误预期。

## 资源与证据

runner 退出后留下16个 relay 孤儿，均为本轮 `sandbox-l3Adp6`、PPID 1、PGID 99385。逐个核对 PID、启动时间及完整命令后只发送 SIGTERM；精确PID和该sandbox的Node进程复核均为0。未操作其他lane或共享 mutation cache。Stryker自身已删除sandbox目录；没有把这一行为写成手工保留了目录，日志和嵌入源码仍保留。

- 完整结果：`reports/stryker-incremental-remote-postreview-7b88613.json`
- HTML：`reports/mutation/remote-postreview-7b88613.html`
- 分层统计、原477逐项账、冻结manifest：`reports/mp3a-postreview-7b88613-{summary,cohort,manifest}.json`
- 原日志、退出码、时间、前后哈希、进程及精确清理记录：`/tmp/mp3a-postreview-plan-7b88613/`
- 只读身份分析脚本、全部fresh记录、失败审计、输出哈希：`/tmp/mp3a-postreview-analysis/`

统计脚本经独立只读审查；执行来源以缓存身份重放与终态日志交叉核对，不能仅从最终JSON的状态猜哪些真的跑过。上述证据只覆盖冻结版及本次批准范围，不代表后续实现、全量、安装或用户验收完成。
