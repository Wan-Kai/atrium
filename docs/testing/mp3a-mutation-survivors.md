# MP3a 变异存活分析（第二轮快照，待第三轮更新）

> **WIP／不是最终验收报告。** 本文只分析 `reports/stryker-incremental-remote-second.json` 中的 216 个 `Survived` 和 10 个 `Timeout`；行号全部来自该报告的 **embedded source**，不是随后修改的工作区源码。父任务正在加入“等待确认的配对通道心跳”，该实现不在此快照内，不能用本表证明它已通过变异测试。最终第三轮结果到齐后须重新对账，不能直接沿用分数、ID 或行号。

## 口径与证据

快照 SHA-256：`84a66ec1ce468d11da3de389720765b31b1e63fabde20d72e5e69625dd5033cf`。文档表格与 JSON 做了集合核对：226 个 ID 各出现一次（216 Survived＋10 Timeout），无遗漏、无多余、无重复。

对应路线图 MP3a、SPEC-0005 的保险箱交接、配对／日常连接／撤销、宿主限额、状态订阅与流量。检查了报告内嵌源码、当前 `remote/` 的单元测试、`packages/host/test/remote/` 的宿主／安全／泄漏测试、桌面 `vault.test.ts` 及 crypto 的分帧实现。本文是静态分类，不是新增测试的运行结果；**没有为分类运行测试、注入变异或修改生产代码**。

- **E（等价／受不变量保护的冗余）**：给出具体的后续检查、状态不变量或未被消费者使用的值。只对单个变异及当前调用链成立，不意味着整段防御代码应该删除。
- **G（真实覆盖缺口）**：原实现做对了，变异会改变有效行为、诊断、异常结果或资源生命周期，但本快照的测试没有检出。每项说明缺少的可观察断言／场景；不是把变异后的问题说成原代码已有漏洞。
- 少数 G 是“待构造负对照”的资源或竞态缺口；其可达路径与观察方式写明，不冒称已经复现。缓存结果也不能证明后来加入的测试仍抓不住。
- 表内逗号分隔的是**全部实际 ID**，不使用省略范围。替换列在同一语义组内按 ID 顺序写出，长表达式用明确的被替换子表达式表示；`false` 不能误读为整条 `if` 都被删除。
- `coverageAnalysis: "off"` 配合 command runner：没有逐测试覆盖映射；`Survived` 不等于“没有执行到”。应区分没触发、触发却没有观察结果、独立防线抵消、以及增量缓存。没有建议整类 mutator suppression。

### 第二轮分数

| 范围 | Killed | Timeout | Survived | 分数 |
|---|---:|---:|---:|---:|
| `packages/host/src/remote/` | 1345 | 2 | 186 | **87.87%** |
| `apps/desktop/src/main/vault.ts` | 179 | 0 | 30 | **85.65%** |
| `packages/remote-crypto/src/` | 429 | 8 | 0 | 100% |
| 合计 | 1953 | 10 | 216 | **90.09%** |

分数为 `(Killed + Timeout) / (Killed + Timeout + Survived)`，不把 Ignored 放进分母。crypto 的 **437 个检出结果为缓存复用**，不是第二轮新跑了 437 个；因此必须单独报告宿主 87.87%，不能用 crypto 缓存掩盖宿主质量。宿主已超过里程碑的分组门槛 80%。`devices.ts` 是 31/39＝**79.49%**，低于 80% 的单文件现象如实保留：8 个存活中 4 个 canonical-key 正则锚点冗余、1 个 schema 失败后异常路径冗余、3 个真实索引覆盖缺口；门禁是组，不是要求每个文件都 ≥80%，更不能为凑分抑制变异。

## D：桌面保险箱 `apps/desktop/src/main/vault.ts`（30）

| ID | 报告行 | 替换／语义 | 分类与解释；G 的缺失观察 |
|---|---|---|---|
| 6 | 33 | `typeof message !== "object"` → `false` | **G**。仅保留 null 检查时，字符串／数字等在 `Reflect.get` 同步抛错，未进入队列的 catch。补原始值输入，断言 `handle` 正常返回 null，且不读写保险箱；现有 null 用例不能替代。 |
| 18 | 36 | `typeof id !== "number"` → `false` | **E**。`Number.isInteger` 对所有非 number 都为 false，后一项仍拒绝；不扩大可接收 id。 |
| 31 | 38 | 非 `vault_write` 检查 → `false` | **G**。带合法 id/version/data 的其他 IPC 类型会被当作 write。缺少未知 type＋其余字段全合法的输入，断言 null 且磁盘未变；现有 shutdown 没有 id，先被另一检查挡住。 |
| 39, 40 | 41 | 类型／整数联合项 → `false`；该项 `\|\|` → `&&` | **G**。正小数版本可越过校验，字符串数字也可能被接受。缺 version=1.5 等输入，断言完整 `vault_result/ok:false/error:io`、没有加密或落盘，随后合法写仍成功。 |
| 41 | 41 | 仅版本 typeof 项 → `false` | **E**。`!Number.isInteger(version)` 独立拒绝非数字。 |
| 57 | 42 | `data.length > MAX_DATA` → `>=` | **G**。恰好 4 MiB 的合法写被拒绝。缺桌面 keeper 这一端的完整边界成功与读回断言；宿主 port 的同值测试不覆盖这里。 |
| 64 | 60 | JSON.parse 的 catch → `{}` | **E**。解析失败后 value 仍 undefined，L63 返回 null，仍报告 corrupt。 |
| 66, 67, 68, 71 | 63 | 整个形状检查 → `false`／`\|\|` → `&&`／typeof 项 → `false`／null 项 → `false` | **G**。解密得到 JSON 原始值（分别用 null 与数字覆盖）后 `Reflect.get` 抛错，被队列兜底为 io，而非 corrupt。缺对合法 JSON 但错误顶层形状的完整 corrupt 应答；不能因为最终失败就称等价。 |
| 80, 81 | 66 | 版本类型／整数联合项 → `false`；其 `\|\|` → `&&` | **G**。解密的正小数等非法版本可能成为 current。缺受加密包装的非法版本内容，断言 corrupt，重置写 version=1 后读回新内容。 |
| 82 | 66 | 仅版本 typeof 项 → `false` | **E**。整数检查覆盖非 number。 |
| 87 | 66 | `version < 0` → `<= 0` | **G**。存储形状允许版本 0，变异误报损坏；缺解密内容 `{version:0,data:"..."}` 的完整成功响应。这里不同于“文件不存在时 version=0/data=null”。 |
| 89 | 66 | `typeof data !== "string"` → `false` | **G**。非字符串明文 data 会被作为成功读返回。缺正确版本＋错误 data 类型，断言 corrupt 而非仅检查版本。 |
| 98, 157 | 118, 157 | availability 拒绝兜底 `false` → `undefined` | **E**。只被 `!await` 消费，两者均判不可用，应答与副作用相同。 |
| 118, 119 | 128 | io 分支 type → `""`；ok → `true` | **G**。真实非 ENOENT 读失败已有覆盖，但只匹配 error。缺完整应答 `{type:"vault_result",id,ok:false,error:"io"}`；否则宿主可能忽略畸形响应并持续等待。 |
| 134 | 152 | `current === null` → `true` | **G**。每次写都重新读盘／询问可用性，破坏已知版本的缓存行为；缺成功首次读后，令第二次 read 不可用但 encrypt 仍可用，断言后续新版本写不再次读取并成功。也可观察外部更改文件时缓存版本仍控制 stale。 |
| 139 | 154 | 整个初次 read 错误门槛 → `false` | **G**。首读 io 后仍尝试写，不能把稍后的 availability 检查当作覆盖 io 的同一防线。缺首读非 corrupt 失败、写本身可成功的故障情景，断言保持原文件、不调用 encrypt、返回原错误。 |
| 142, 143, 144 | 154 | `before.error !== "corrupt"` → `true`／反转／`corrupt` → `""` | **G**。首次操作直接写损坏保险箱时，必须允许显式重置；现有损坏测试先读过，current 已变 0，绕过该分支。缺新 keeper 首次直接 write 对损坏文件的成功及读回断言。 |
| 167, 168 | 163 | encrypt 异常应答 type → `""`；ok → `true` | **G**。现有只匹配 `error:keychain_unavailable`，缺完整失败信封和未写盘断言。 |
| 177, 178 | 171 | `rm` 参数 → `{}`；force → `false` | **E（对 keeper 外部结果）**。已有临时文件正常删除；仅 ENOENT 时 force 有别，变异抛出的清理错误仍被外层队列 catch 转成相同 io，current 都不推进、队列都可继续。ENOTDIR 等两者本来都会抛；并非把清理本身视为不重要。 |

## C：数据通道 `packages/host/src/remote/channel.ts`（3）

| ID | 报告行 | 替换／语义 | 分类与解释 |
|---|---|---|---|
| 227 | 99 | binaryType `"nodebuffer"` → `""` | **E**。ws 默认就是 nodebuffer，非法 binaryType 赋值被忽略；`toBytes` 还接受 Buffer/片段/ArrayBuffer，线上字节不变。 |
| 267 | 214 | 注入的 `clock.now` → 返回 undefined | **E**。这份 `SecureChannel` → `FrameReader` 调用链只用 `clock.setTimeout`，没有读取该 now；宿主自己的心跳使用 `PhoneStream.#clock`，不是这个适配函数。 |
| 309 | 293 | `readyState === OPEN` → `true` | **E（当前 socket 所有权内）**。CONNECTING 已在上一分支 terminate；已关流被 #closed 拦住。对端先关闭时，在 close 回调中多建的 fallback timer 紧接着被 L94 取消，ws 对 CLOSED 的 close 无操作。当前所有者没有独立公开 socket 或另一条主动置 CLOSING 而未置 #closed 的路径。此结论不推广到任意 ws 包装器。 |

## V：设备文档 `packages/host/src/remote/devices.ts`（8）

| ID | 报告行 | 替换／语义 | 分类与解释；G 的缺失观察 |
|---|---|---|---|
| 386, 387, 396, 397 | 10, 24 | publicKey／hostKey 正则分别去 `^`／`$` | **E**。后续 `fromBase64Url(key,32)` 验证长度和 canonical base64url 往返，锚点放过的前后缀仍被独立拒绝；不是删了全部密钥校验。 |
| 406 | 45 | `!parsed.success` → `false` | **E**。safeParse 失败无 data，紧接着访问 hostKey 抛错，外层 catch 同样返回 null；成功路径不变。 |
| 416 | 62 | `RemoteDocument` schema 属性 → `{}` | **G**。looseObject 空形状接受坏 enabled／lastSeen，索引读取不再按约定拒绝。缺真实 IndexFile 加载错误类型／负数 lastSeen，断言采用索引损坏处理而非把坏数据交给服务。 |
| 418 | 71 | 索引名 `remote` → `""` | **G**。fixture 常直接传内存 index，无法发现读写到了错误文件。缺在真实 home 中保存、重启读回 `remote.json`，并断言没有创建错误名称文件。 |
| 421 | 74 | empty.enabled `false` → `true` | **G**。缺真实缺失索引时构造服务、start 后不请求钥匙串／不连接 relay 且 enabled=false 的断言。fixture 自己提供 false 不能覆盖默认工厂。 |

## P：配对状态机 `packages/host/src/remote/pairing.ts`（12）

| ID | 报告行 | 替换／语义 | 分类与解释；G 的缺失观察 |
|---|---|---|---|
| 459, 460 | 138 | 替换旧码时 state／reason → `""` | **G**。旧 available 码被 #end 后，onChange 同步发生在新码赋值前，旧结果是可见的。缺在 onChange 当场捕获 `view()`，断言旧码 rejected/cancelled 后才看到新 available；只看 start 后最终新码会掩盖它。 |
| 466 | 153 | 过期回调的 available 检查 → `true` | **E**。claim／cancel／替换均同步取消该定时器；仍能派发的回调对应 available。这里没有 await 让过期回调与状态改动交错。 |
| 541, 543, 544 | 230 | 确认期限整个条件 → `true`／`&&` → `\|\|`／state 项 → `true` | **E**。accept 在设 confirming 后同步取消定时器，终止／替换也取消；可执行此回调时仍是 awaiting_confirmation 且未 confirming。不是任意异步状态机通用等价。 |
| 575 | 260 | 拒绝后的 state → `""` | **G**。缺 answer(false) 后 `view().state === "rejected"` 的完整投影；返回 declined／结束原因正确不保证状态正确。 |
| 612 | 312 | `pairing.claim?.stream` → `.stream` | **E**。前项已限制 awaiting_confirmation，该状态只能由 claim 写入非 null claim 后产生。 |
| 615 | 313 | 断线后的 state → `""` | **G**。缺断线结束后状态为 rejected、reason=disconnected、request 保留同一手机的整体断言；仅等 reason 不足。 |
| 621 | 328 | dispose 的 cancelTimer 调用 → `;` | **E**。active 状态紧接着走 #end 再取消；terminal 状态的 timer 已在结束或确认时取消。 |
| 622 | 329 | dispose 中 confirming → `true` | **E**。dispose 后续不读 confirming，#end 也不读，随后丢掉 #pairing；没有把旧对象暴露给消费者。 |
| 642 | 352 | `reason !== null` → `true` | **E**。reason=null 仅 unused-code expiry，此时 claim=null，后一检查仍不通知；有 claim 的结束都传具体 reason。 |

## L：relay 行解析 `packages/host/src/remote/relay-line.ts`（6）

| ID | 报告行 | 替换／语义 | 分类与解释；G 的缺失观察 |
|---|---|---|---|
| 653 | 27 | 正则去起始 `^` | **G**。`garbage`＋合法 relay 行会被接受；parseVault 的 relay 字段只有长度限制，不能把协议入口的校验当成所有来源的保证。缺直接解析和加载带前缀垃圾的保险箱，断言 null／vault_corrupt、不连接。 |
| 664 | 27 | 路径重复 `*` → 必须恰好一段 | **G**。无 prefix、或 `/a/b` 两段合法行被拒绝。缺这两类输入的精确 endpoint；单段 `/atrium` 不区分。 |
| 670, 671, 672, 673 | 31 | 四个解构默认 `""` → `"Stryker was here!"` | **E**。match 非 null 时四个捕获组总是存在；路径组零次匹配是空串，不是 undefined，默认表达式不执行。 |

## R：控制连接／探测 `packages/host/src/remote/relay-link.ts`（31）

| ID | 报告行 | 替换／语义 | 分类与解释；G 的缺失观察 |
|---|---|---|---|
| 691 | 60 | 初始 status → `""` | **G**。start 会重写状态，掩盖构造后的错误值。缺 start 前 getter 的完整 connecting/null/null 断言。 |
| 711, 714 | 119 | 非 OPEN 门槛 → `false`；提前返回码 → `""` | **G**。connected 状态到 close 事件之间可处于 CLOSING；原实现立即返回 unreachable，变异走 ping 检查或错误码。缺对端启动关闭而本端 close 尚未分发的窗口内 retryNow，断言立即正确失败、不新增探测期限。 |
| 713 | 119 | socket 可选链 → 直接访问 | **E**。state=connected 时 socket 不为 null；关闭回调置 null 后在同一同步回调中更新 error，stop 则被 retryNow 首项 stopped 拦住。CLOSING 非 null，不能据此把 711 也算等价。 |
| 721, 723 | 126 | 成功判别 → `false`；`connected` → `""` | **E**。成功 state.error 本来就是 null；失败则返回实际 error，两个分支对消费者结果相同。 |
| 731 | 130 | cancelRetry 可选调用 → 直接调用 | **E**。已 start、未 stopped、socket=null 的可调用窗口只在断线后等待 retry，此时已同步装好取消函数；retry 自己清空后同步创建 socket，没有外部可插入窗口。 |
| 739, 741 | 160, 161 | off 的 pong／close 事件名 → `""` | **G**。once 只自动移除触发的那个，另一监听器仍保留。缺在同一存活 socket 连续成功检查后 close 监听数回基线，以及失败检查后 pong 监听清理的资源断言；Promise 只 resolve 一次不能证明无泄漏。 |
| 756, 759 | 189 | OPEN 条件 → `true`；socket 可选链 → 直接访问 | **G**。公开 refuse 在未 start／stop 后允许无操作，变异会空指针或对未 open socket 发消息。缺这些生命周期调用不抛、没有发送／新增资源的断言。 |
| 770 | 210 | stop 通知 waiter 的 status → `""` | **E**。waiter 仅判断是否 connected，再返回 error；`"error"` 和空串都返回同一个 relay_unreachable。 |
| 777, 778 | 224 | WebSocket options → `{}`；perMessageDeflate → `true` | **G**。默认开启压缩，且空 options 也丢失 payload 上限。缺允许压缩的真实测试服务器观察握手没有扩展协商，以及 >70 KiB 控制帧触发关闭的断言。 |
| 779 | 224 | maxPayload `70 * 1024` → `70 / 1024` | **G**。ws 将该小数转换为 0，含义是不限制，而不是更严的小上限。缺超限控制帧关闭并重新连接／释放旧资源的断言。 |
| 836 | 278 | `message?.type === "open"` → `true` | **G**。ready 后其他类型带合法 streamId 会触发 onStream，甚至 null 走到属性访问抛错。缺 ready 后发送 `type:"other"`＋合法 id 和 null 的同步消费确认，断言没有数据连接／没有未捕获异常；不是能直接绕过后续 Noise。 |
| 874 | 324 | onState 调用 → `;` | **G**。getter 仍更新，轮询 getter 掩盖回调丢失。缺回调记录中 connecting→connected→error 的完整状态及时间，不能只看 link.state。 |
| 883, 885, 886, 889, 892 | 343–345 | 对象判断 → `true`／`&&` → `\|\|`／typeof 项或非 null 项 → `true`；catch → `{}` | **E（当前消费者）**。JSON 原始值 spread 后是无 type 的对象，null spread 也是空对象；异常由 null 变 undefined，调用者都用可选链。均不能产生 ready/open。不能据此推论删除 L278 的 type 检查也等价。 |
| 899, 900, 901 | 367 | probe options → `{}`；压缩 → `true`；上限乘 → 除 | **G**。同 777–779，但独立 probe 路径必须单独验证：不协商压缩、超限 ready 帧不成功，完成后资源归零。 |
| 903 | 369 | 初始 result → `""` | **E**。close 只判断 result 是否 null；未 ready 的任意非 null 值都按 close code 映射固定错误。 |
| 908, 909 | 373 | abort options → `{}`；once → `false` | **E（AbortController 正常生命周期）**。signal 只发生一次 abort，close 时还显式移除；不以手工重复 dispatchEvent 的非调用约定作为必要场景。 |
| 922 | 378 | `parseControl(data)?.type !== "ready"` → `false` | **G**。任意文本帧可被当作成功；缺等待服务端发送的非法文本真正被客户端消费后，确认 probe 未完成，再发正确 ready／关闭并断言结果。仅 send 后立即推进假时钟可能先走 timeout，掩盖该变异。 |
| 924 | 378 | parseControl 可选链 → 直接取 type | **G**。非法 JSON/null 在事件回调抛 TypeError；缺确认非法帧已消费、无 uncaught error 且 probe 留待正确 ready／关闭的断言。 |
| 934 | 385 | removeEventListener 的 abort 名 → `""` | **G**。正常成功且未 abort 的 signal 保留闭包/socket。缺 probe 完成后 signal 上 abort 监听数量归基线（例如 Node getEventListeners），多轮成功不增长；仅资源 tracker 看不到事件监听器。 |

## S：远程服务 `packages/host/src/remote/remote-service.ts`（123）

### S1：订阅、配置、探测和出码

| ID | 报告行 | 替换／语义 | 分类与解释；G 的缺失观察 |
|---|---|---|---|
| 950, 951 | 38 | PairPayload pairingId 正则去 `^`／`$` | **E**。L552 还把整个字符串与本机随机生成的规范 pairingId 严格相等比较；额外前后缀不能成为当前配对。 |
| 959, 1014 | 86, 140 | samples 空数组 → `["Stryker was here"]` | **E**。首样本取到字符串，其 at 为 undefined，时间比较为 false，不访问 totals；随后的 filter 同样为 false 去掉它。首个有效样本与空数组相同。 |
| 973 | 98 | PairingMachine.onChange → 空回调 | **G**。缺不推进流量定时器、只观察 send 事件的配对出码／过期／取消／请求状态序列；轮询 get 或下一秒采样推送会掩盖即时通知缺失。 |
| 984 | 101 | close reason `pairing_ended` → `""` | **G**。关流仍发生、pair_rejected 不变；缺实际结束路径日志的 reason=pairing_ended 断言，不是授权缺口。 |
| 991 | 111 | startup catch 中 #changed → 空回调 | **E（状态结果）**。#load 的 finally 已发布同一失败状态；catch 没有新状态变化。重复通知次数不是契约，不能为杀变异要求它固定重复。 |
| 1015 | 141 | 清 totals → `;` | **G（保留内存）**。重订阅先拍基线，所以差值速率未必错，但已撤销设备的累计 Map 可跨观看周期保留。缺多轮不同设备、取消全部订阅／撤销后的受控 heap 保留增长断言；只断言界面速率归零不足。 |
| 1019, 1020, 1021 | 153 | 整个 unavailable 门槛 → `false`／`\|\|` → `&&`／store-null 项 → `false` | **G**。即使 #ensure 后来拒绝，enabled/index 等副作用已可能发生；standalone disable 还可直接成功。缺无 vault 的 set(false) 完整错误，以及 set(true) 拒绝前后 enabled、index、推送均不变。后续拒绝不能代替“无副作用”。 |
| 1037 | 158 | #changed → `;` | **G**。set 等待后续 vault/relay 写期间本机应看到新开关。缺卡住后续读取／保存时，send 已发布 enabled 的断言；只看最终状态不够。 |
| 1042 | 159 | `relay === undefined` → `true` | **G**。set(false,newRelay) 会早退而不保存新地址。缺关闭同时更新 relay、重启读回新配置且仍 disabled 的断言。 |
| 1045 | 160 | #connect → `;` | **G（并发）**。顺序 disable 时 connect 被 !enabled 拦住；但 await index.save 期间另一 set(true) 可改变 enabled。缺可控两次保存交错后最终 enabled=true 的实际控制连接建立，不能只因顺序调用无效就判等价。 |
| 1052 | 168 | pairing.cancel → `;` | **E**。后一句同步进入 #disconnect，第一段就在任何 await 前再次 cancel，没有中间外部回调。 |
| 1054 | 173 | #changed → `;` | **G**。无新 link 状态通知的配置更改（尤其 disabled 下更新 relay）须发布最终地址；缺监听事件中的最终 relay，而不是主动 get。 |
| 1063 | 182 | #connect → `;` | **G（并发）**。enabled=true 但新连接尚未因另一个排队操作启动时，testRelay 应接管正式 link，而非启动暂态 probe。缺卡住启用路径后并发 testRelay，观察只建正式连接且探测完成不将它挤掉。 |
| 1069 | 183 | `#probe === null` → `true` | **G**。并发 testRelay 可新建第二 probe；缺关着远程时两次并发测试共享同一控制连接／Promise 结果、资源最终归零。 |
| 1074 | 187 | probe.finally 的 #connect → `;` | **G**。probe 期间 enable 会先 abort probe，必须等 finally 启动正式 link。缺挂起探测→开启→探测退出后实际 connected 的因果断言。 |
| 1092 | 199 | vault 非 ok 检查 → `false` | **E（当前状态不变量）**。endpoint 非 null 只能来自已成功 #load/#save 的 contents，此时 vault=ok；失败初始化没有 contents。#trusted 还独立检查，不能把该变异描述为读取不可信身份。 |
| 1095 | 199 | endpoint-null 检查 → `false` | **G**。enabled 且已初始化但 relay=null 可达，随后读 endpoint.url 抛 TypeError。缺在该状态 startPairing 抛精确 CommandError(remote_unavailable)、没有生成配对／定时器的断言。 |
| 1110 | 215 | 返回 `{pairingId}` → `{}` | **G**。缺将命令返回 pairingId 与 QR／本机投影中的同一个 id 作完整相等断言；仅从 view 拿 id 可漏掉错误响应。 |

### S2：确认、设备管理与撤销

| ID | 报告行 | 替换／语义 | 分类与解释；G 的缺失观察 |
|---|---|---|---|
| 1123 | 237 | contents 可选链 → 直接访问 | **E**。能拿到有效 claim 必须先成功出码并完成安全通道；contents 已存在。reset 只替换，不设 null，关闭也不置 null。 |
| 1137, 1139 | 243 | find 谓词 → 返回 undefined／false | **G**。acceptedDevice fallback 只保留确认时快照；队列中先完成 rename 时应该使用 current.devices 的新名字。缺延迟写队列→rename 先入队→confirm 入队，最终保留最新名字和原 deviceId 的断言。普通重配对两份记录相同，不能区分。 |
| 1154, 1155, 1158 | 253 | 容量检查 → `false`／`>=256` → `>256`／错误码 → `""` | **G**。缺已有 256 个不同 key 时确认第 257 个：精确 remote_unavailable、vault 仍 256、没有 paired/accept；以及已满时重配对已有 key 可以成功的配套边界。 |
| 1167 | 256 | `!revokedAfterAcceptance` → `true` | **G（不是立即重授权）**。后续仍 close 已撤销流，但删除 blocked 会影响尚未持久化的撤销。缺 confirm 写在途时 revoke、confirm 成功后 revoke 持久化失败，随后旧 key 日常 IK 仍被拒绝，且本机不显示为可用设备。现有成功落盘的 revoke 会再次删设备而掩盖这个差异。 |
| 1174 | 258 | close reason revoked → `""` | **G**。缺“确认在途被撤销”路径的精确关闭日志 reason；关流动作仍在，不能报授权漏洞。 |
| 1178, 1179, 1180, 1181 | 259 | `!revokedAfterAcceptance && !closed && enabled` → `true`／最后 `&&` → `\|\|`；前两项 → `true`／`\|\|` | **E（当前关流链）**。四者都保留最后 `!claim.stream.closed`。被撤销时 L258 已同步 close；disable/close 在 #disconnect 的首段同步关闭所有流。此后 write continuation 没有 await，检查时被撤销／关闭的 claim 必定 closed。不会走 #session；不要只看到授权条件减弱就宣称能重授权。 |
| 1190 | 263 | #changed → `;` | **E（状态结果）**。#pairing.committed 已在持久化后发状态；若接纳 session，#session 再发在线状态；无新的状态在两者之后改变。不以重复推送数为契约。 |
| 1198 | 268 | close reason vault_failed → `""` | **G**。缺确认写失败的结构化关闭日志 reason；已有 host_error 不代替诊断字段。 |
| 1221 | 292 | rename 后 #changed → `;` | **G**。缺不主动 get、不推进采样时 watcher 收到新名字的事件断言。 |
| 1246 | 311 | close reason revoked → `""` | **G**。缺直接撤销在线设备的精确关闭日志，revoked 控制消息和 close 仍正常。 |
| 1247 | 313 | 拉黑后 #changed → `;` | **G**。在线流关闭回调可能代发事件；缺撤销离线设备且 vault 写挂起时，watcher 已收到设备移除的断言。 |
| 1255 | 317 | 撤销落盘后 #changed → `;` | **E（投影）**。拉黑后 #view 已隐藏设备，落盘只从 contents 删除同一隐藏项，没有新的可见字段；前一通知足够。 |
| 1260 | 324 | store-null 项 → `false` | **G**。reset 继续进入 #ensure，错误会被 catch 改成 keychain_unavailable。缺 standalone reset 精确 remote_unavailable，且未读写／无身份的断言。 |
| 1264 | 325–327 | reset 的 ensure try → `{}` | **G**。未读取既有身份就重置会丢 relay，并让 VaultStore 使用未知旧版本。缺冷启动直接 reset：读取非零版本的有效 vault，保留 relay、提高版本、换 fingerprint、清设备。 |
| 1265, 1267 | 327–329 | catch → `{}`；vault 非 corrupt 检查 → `false` | **G**。非 corrupt 读失败不能继续重置；缺 read 失败而 write 可成功的 port，断言精确 keychain_unavailable 且 write 调用数 0／旧身份不变。若测试 write 自己也失败，会掩盖这个门槛。 |
| 1277 | 337 | blocked.clear → `;` | **G（保留内存）**。reset 换密钥且设备清空，旧随机 id 不会正常复用，不能称旧设备仍能连接。缺大量 revoke→reset 循环的受控保留集合／heap 归基线断言，防旧 id 无界留存。 |
| 1284 | 341 | close reason identity_reset → `""` | **G**。缺 reset 关闭多设备时日志的精确 reason；不影响 revoked 消息本身。 |
| 1285 | 343 | reset 后 #changed → `;` | **G**。没有活跃配对／流可代发通知时，缺 watcher 立即收到新 fingerprint、空 devices 的事件断言。 |
| 1286 | 344 | reset 后 #connect → `;` | **G**。构造服务时索引 enabled=true、磁盘有有效 relay，但还未 start；直接 reset 会先 ensure 读出 relay，再保存新身份，应由此处建立 link。缺这个冷启动直接 reset 场景下实际 connected、relay 不变且密钥已换的断言；无需虚构“损坏 vault 却保留 endpoint”的 private 状态组合。 |

### S3：加载、错误映射与连接所有权

| ID | 报告行 | 替换／语义 | 分类与解释；G 的缺失观察 |
|---|---|---|---|
| 1292, 1293, 1294 | 360 | ensure 整个检查 → `false`／`\|\|` → `&&`／store-null 项 → `false` | **G**。公开 testRelay 在 standalone 可达 #ensure，null store 将被 catch 映射为 keychain_unavailable 而非 remote_unavailable；前两者还可触发 close 后再读。缺 standalone testRelay 的精确错误及无读取／无推送断言。 |
| 1342 | 384 | `parsed.relay !== null` → `true` | **G**。合法 relay=null 的已有 vault 会被 parseRelayLine(null) 判失败，误标 corrupt。缺重启加载合法无 relay 的非空 vault，断言身份不变、vault=ok、不初始化新密钥。 |
| 1357, 1360 | 393–394 | instanceof 检查 → `true`；兜底错误码 → `""` | **G**。底层 port 抛普通 Error 时可能透传原异常／错误码丢失。缺从公开 await 命令观察 CommandError(keychain_unavailable)，且不泄漏底层异常消息；background start 吞掉异常后仅检查 view 无法区分。 |
| 1361, 1362 | 395–396 | finally → `{}`；#changed → `;` | **G**。start 失败有外层 catch 补通知，set 成功有尾部通知；但直接调用 testRelay 等的 load 失败没有代发。缺 subscribed testRelay 读失败后不轮询／不推进时间即收到最终错误状态。 |
| 1366, 1367, 1370 | 402 | `\|\|` → `&&`；非 ok 项 → `false`；contents-null 项 → `false` | **E（状态不变量）**。contents 非 null 与 vault=ok 同时由成功 load/save 建立；正常调用链不把已 ok 改为 waiting，失败初始化保持 contents=null。任一项足以拒绝未信任状态，不能称删掉一项就能读取不可信 contents。 |
| 1374, 1376, 1377 | 404–405 | corrupt 条件 → `false`／常量 → `""`；vault_corrupt → `""` | **G**。缺先加载损坏 vault 后调用 rename/revoke 等经 #trusted 的命令，断言精确 vault_corrupt。只断言初始化命令的错误不覆盖此处。 |
| 1378, 1383 | 406, 408 | keychain 判断 → `true`；remote_unavailable → `""` | **G**。缺 unread／unavailable 时直接 rename/revoke，断言 remote_unavailable 且未触发读写；已有 keychain_unavailable 用例不区分这两个变异。 |
| 1386, 1389 | 420 | store-null 检查 → `false`；错误码 → `""` | **E（当前入口）**。#save 只从 #load、已 #trusted 的写操作、或已通过 reset 的 store 检查进入；没有 store=null 的可达保存。不是所有 defensive guard 都等价，而是这一私有入口已被前置门槛支配。 |
| 1395, 1397, 1398 | 422 | write.error=corrupt 分支 → `false`／匹配常量 → `""`／结果码 → `""` | **G**。VaultPort 类型允许 write 返回 corrupt，原实现有明确映射。缺该失败答复下公开命令精确 vault_corrupt、旧 contents/fingerprint 不变、无 accept 的断言；io 的测试不覆盖它。 |
| 1415, 1416, 1417 | 446 | closed/disconnecting 联合项 → `false`／`\|\|` → `&&`；disconnecting 项 → `false` | **G（竞态资源）**。disable／换配置清空 #link 后还在 await drain，另一个启用／探测回调可能提前建新 link。缺用可控关闭闸门重叠断开与启用，断言旧连接完全释放前不建新控制连接，完成后恰好一条；不能把最终 connected 当作充分。 |
| 1421 | 446 | vault 非 ok 检查 → `false` | **E（当前入口）**。能派生非 null endpoint 的 contents 只在 vault=ok 时存在；L452–453 独立阻止无 endpoint 的连接。 |
| 1427, 1429, 1430 | 448–450 | probe 检查 → `false`；整个块 → `{}`；abort → `;` | **G**。前两者在旧 probe 未完成时新建 link，旧认证可能挤掉新连接；最后一项返回但不终止 probe。缺探测握手挂起→开启远程，断言旧探测被取消、先关后开且最终正式 link 不被迟到 hello 顶掉。 |
| 1435 | 457–460 | onState → `{}` | **G**。同时漏本机状态通知与主动关闭数据流。缺只断控制连接但保留数据端的 relay fixture，断言已有流立即关闭、watcher 得到 error/offline，不依赖 relay 替宿主关流。 |
| 1436 | 458 | error 判断 → `true` | **E（当前建连时序）**。首次 connecting/connected 回调发生在没有 streams 时；重连的 error 回调已同步清空旧流，收到 ready 前也不会接受新 open。因此额外关闭空集合，无新增结果。 |
| 1437, 1438, 1439 | 458 | error 判断 → `false`／`!==`／常量 → `""` | **G**。真实 relay 会顺带关闭数据端，现有集成因此可能掩盖宿主这一独立防线。缺控制线掉、数据线故意保持的恶意／故障 relay，断言数据流立即关闭、未等 30 秒心跳。 |
| 1441 | 458 | close reason relay_closed → `""` | **G**。缺上述“仅控制线掉”的路径日志 reason，正常 relay 先关数据可能走 socket_closed。 |
| 1446 | 468 | disconnecting++ → `--` | **G**。计数不再阻止重入 connect。缺与 1415 组相同的受控重叠断开／启用时真实连接数量、关闭先后断言，而非访问私有计数来凑测试。 |
| 1450 | 474 | close reason remote_off → `""` | **G**。缺主动 disable 关流的结构化日志 reason。 |
| 1454 | 479 | disconnect 完成 #changed → `;` | **G**。换 relay 时 link=null 等状态须在 await 断开后发布；缺断开过程没有其他流回调代发时 watcher 看到 off 的事件，随后新配置才 connected。close 清空 watchers 的情形本来不会通知，不用它证明此项。 |

### S4：流、握手、控制消息和资源

| ID | 报告行 | 替换／语义 | 分类与解释；G 的缺失观察 |
|---|---|---|---|
| 1459, 1460 | 490 | closed/disabled 联合项 → `false`／`\|\|` → `&&` | **G（生命周期竞态）**。连接 stop 已发起但 close 尚未消费时，已排队 open 回调可到达；最后会被其他关流逻辑拦住也不代表不多开 socket。缺停用／关闭与已排队 open 的交错，断言不创建新数据连接、不新增 remote.data。 |
| 1465 | 490 | 去掉 `!stream.settled` filter | **G**。已认证通道也占用四条握手名额，合法第 5 条流被错拒。缺先建至少 4 条已 settled 通道（分设备满足每台最多 2 条），再有新握手成功，同时 4 条未 settled 时仍拒绝第 5 条。 |
| 1470 | 491 | link 可选链 → 直接访问 | **G（生命周期竞态）**。#disconnect 将 link=null 后，旧 link 的队列仍可能交付 open；原代码无操作，变异抛异常。缺这个交错下无 uncaught error、无数据连接的断言。不能用正常 open 时 link 存在来证明总是存在。 |
| 1475, 1476, 1477 | 498 | 字节计数整门槛 → `false`／`\|\|` → `&&`／无 watcher 项 → `false` | **G（资源／不观看不采集）**。无人观看时仍积累各设备计数；重订阅基线能抵消差值，但违反按需采集并可能保留已撤销 id。缺多轮未观看的不同设备连接／撤销之后受控 heap 或保留计数资源稳定的断言；不要用重复调用 get 的值相同就称等价。 |
| 1479 | 498 | deviceId-null 项 → `false` | **E（可见速率）**。未认证字节进入 null key 桶，正式 deviceId 后续不会读取此桶；#view 只按 vault 的非 null id 显示，unwatch 清空。最多单个额外桶，不是能把握手字节错归某设备，也不据此宣称整个按需计数守卫可删除。 |
| 1489 | 507 | pairPhones.delete(phone) → `;` | **G（保留内存）**。握手成功但未 key-confirm 就关闭的流会被 Map 强引用。缺多轮这种半配对关闭后的 heap 保留稳定断言；remote.data 计数为零并不能发现 Map 引用。 |
| 1491 | 509 | deviceId 非 null 检查 → `true` | **G**。未配对流关闭会把 `"null"` 写进 lastSeen。缺失败握手／未确认断线后真实非秘密索引内容没有伪设备键、没有无意义保存的断言。 |
| 1498 | 514 | onClosed 中 #changed → `;` | **G**。缺单个已认证设备自行断线、无其他状态事件／不推进采样时，本机 watcher 立即收到 online=false 及 lastSeen 更新。 |
| 1500 | 519 | draining.add → `;` | **G**。close 在逻辑关流后可能先于底层 socket.done 返回。缺关闭握手被对端延迟时，service.close／disable 在 done 前仍 pending，done 后资源归零再完成的断言。只在 teardown 最终等资源归零会掩盖返回时机错误。 |
| 1501 | 520 | done.then 删除 → 空回调 | **G（保留内存）**。已完成 Promise 永久留在 Set，后续 Promise.all 虽立即通过也不释放历史条目。缺多轮开关流后的 heap／保留 Promise 数稳定，不以“最终 close 能完成”代替。 |
| 1512 | 543 | `pairing === null` → `false` | **G（诊断，不是授权）**。没有 pairing 的 IKpsk2 在读取 pairingId 时抛 TypeError，被 catch 关闭；原实现先用随机 PSK 读首条，再以 pairing_not_found 关闭。缺同一合法首帧的精确关闭日志 reason／无握手二，不能说变异允许配对。 |
| 1522 | 552 | `pairing === null` → `false` | **G（诊断，不是授权）**。null 时后半相等检查抛错，外层 catch 仍关闭。缺无当前码而收到正确形状首帧时 reason=pairing_not_found（而不是 handshake_failed）且不答成功。 |
| 1528 | 553 | close reason pairing_not_found → `""` | **G**。缺取消／刷新码握手拒绝的精确日志 reason；假手机仅发现连接断开不足。 |
| 1543 | 563 | answer.ok 检查 → `true` | **E（当前调用链）**。拒绝也暂写入 pairPhones，但 L577–579 仍同步关闭流；onClosed 同步删该 Map 条目，不调用 secure，不可能收到解密后的控制消息。授权、资源最终结果相同。 |
| 1572, 1573, 1576 | 574 | `&&` → `\|\|`；answer.ok 项 → `true`；device 非 undefined 项 → `true` | **E**。对已知但版本不合的设备，前两者只提前设置局部 deviceId，L577 仍拒绝并 return；未知设备 answer.ok 不为 true，第三项不使它进入；成功 answer 本来就意味着 device 存在。没有越过独立拒绝门槛，不是已知设备版本校验漏洞。 |
| 1591, 1592 | 583–584 | catch → `{}`；close → `;` | **G**。畸形 Noise／解密载荷仍等到 10 秒握手期限才关，攻击流占名额过久。缺发送确实到达宿主的错误首帧后，在推进期限前立即释放名额、准确关闭 reason、无 accept 的断言；假手机自行关闭可能掩盖宿主漏关。 |
| 1606, 1608 | 600–601 | remoteStatic-null／handshakeHash-null 检查 → `false` | **E**。#control 只由 SecureChannel 解密后的 onReceive 调用；成功 finish 的 transport 已同时提供二者。request 还须来自握手许可 Map。不是任何未认证输入都能调用到这里。 |
| 1613 | 606 | 删除消费过的 pairPhones 条目 → `;` | **G**。第二个 pair_confirm 不再走 unexpected_control，而会再次 claim、增加 refused 并以 pairing_busy 结束流，改变状态／原因。缺同流重复确认，断言不二次 claim／不增加 refused，关闭日志是 unexpected_control；只断言最终没有多登记设备不足。 |
| 1635 | 630 | shift 可选链 → 直接调用 | **E**。同步 while 条件保证数组 length≥2，shift 不可能 undefined；没有 await 或外部共享数组。 |
| 1636 | 630 | close reason replaced → `""` | **G**。缺第三条已认证连接挤掉最旧连接的精确日志 reason；连接数上限仍正确。 |
| 1642 | 635 | session 后 #changed → `;` | **G**。缺日常 IK 首次上线（非配对 committed 的代发路径）后 watcher 立即收到 online=true 和 lastSeen，而非 get 的当前值。 |
| 1647, 1648, 1649 | 648 | 失败日志回调 → 空；字段对象 → `{}`；日志消息 → `""` | **G**。缺 lastSeen index.save 单独失败时，服务保持已认证连接，同时只记录规定 warn、包含 device_id/trace_id、不含密钥／内容的完整日志断言。 |

### S5：通知与采样尾部

| ID | 报告行 | 替换／语义 | 分类与解释；G 的缺失观察 |
|---|---|---|---|
| 1686, 1687, 1688 | 693 | 整个 early return → `false`／`\|\|` → `&&`／无 watcher 项 → `false` | **E（外部发送）**。close 同步清空所有 watchers，并拒绝重新订阅；无 watchers 时循环无收件人。变异多构造一次纯投影，仍不发秘密或事件。不代表允许改变 get 的关闭后订阅检查。 |
| 1701 | 700 | 无 watcher 项 → `false` | **E（当前调度）**。唯一入口是成功增加 watcher 后的 get，或已有 timer 回调；最后一个 unwatch 同步取消 timer，close 还有独立检查。因此没有无 watcher 的可执行采样入口。 |
| 1707 | 704 | 整个 previous/time 条件 → `true` | **G**。首次观看时 totals 为空暂时无错；后续若时钟停住／回退且 totals 非空，可能除以零、输出 NaN/Infinity。缺用 Clock 明确构造非递增采样时间，断言所有发出的 down/up 有限且非负、不污染后续恢复样本。不能仅以普通递增 FakeClock 证明等价。 |
| 1712, 1713 | 704 | `at > previous.at` → `true`／`>=` | **G**。同时间点第二次有效采样（例如时钟调整、timer 已到但墙钟没前进）应跳过除法；缺上述非递增时间下有字节的完整事件断言。若将来 Clock 契约明确保证严格递增，才可重新以不可达证明归 E；本表不自行加此假设。 |

## I：宿主保险箱 IPC `packages/host/src/remote/vault.ts`（3）

| ID | 报告行 | 替换／语义 | 分类与解释；G 的缺失观察 |
|---|---|---|---|
| 1764 | 90 | post 抛错后 waiting.delete → `;` | **G（保留内存）**。Promise 已 resolve，但 Map 保留 resolver，重复失败请求累计。缺大量 post 同步失败后受控 heap／retained closure 稳定；重复收到 id 只会对已完成 Promise 再 resolve，不产生不同返回值，不能拿它当有效负对照。 |
| 1767 | 91 | 内部合成答复 type → `""` | **E**。合成对象不经 receive/schema，也不发回外界；read/write 只读取 ok/error，返回仍为 io。 |
| 1813 | 114 | 收到答复后 waiting.delete → `;` | **G（保留内存）**。成功请求永久留存 resolver；现有 duplicate-answer 测试只能证明二次 resolve 无效，不能证明释放引用。缺多轮真实 port 请求／响应后受控 heap 保留稳定的断言。 |

## T：10 个缓存 Timeout，不能一律叫死循环

这 10 项在第二轮沿用缓存状态；下面说明机制，不声称第二轮重新测得超时。Timeout 计入 Stryker 检出分子，但“没在时限内完成”与“断言识别了错误”不是同一证据。

| ID | 文件／报告行 | 替换 | 机制与证据边界 |
|---|---|---|---|
| 1871 | crypto/framing.ts:65 | `offset += MAX_CHUNK` → `-=` | 分块游标反向走，不能到达 last，持续 push；已知分帧循环不终止。 |
| 1872 | crypto/framing.ts:65–70 | for 循环体 → `{}` | 无条件 for 没有 return，确定忙循环。 |
| 1876, 1877, 1880 | crypto/framing.ts:67,69 | last → `false`／`end !== bytes.length`；`if(last)` → `false` | 1876/1880 永不退出；1877 对单块／空消息 end 已到末尾时永远为 false。已知分帧终止条件被破坏。 |
| 1892 | crypto/framing.ts:139 | Ping 判别 → `true` | Pong 被解成 Ping，双方 SecureChannel 会继续答 Pong，形成同步／事件往返的心跳循环，不是正常网络慢。 |
| 2234, 2236 | crypto/secure-channel.ts:138 | ping 条件 → `true`／`!== "ping"` | 无条件答 Pong，或收到 Pong 再答 Pong，已知回环测试形成心跳循环。这 8 项合计为 crypto 缓存 timeout。 |
| 1634 | host/remote/remote-service.ts:630 | `others.length >= 2` → `< 2` | 首个 session 的 others=[]，条件永真，shift 返回 undefined 又不改变 length；可选链不抛，确定忙循环。不是测试等待网络导致。 |
| 928 | host/remote/relay-link.ts:382 | `socket.on("error", …)` → 监听空字符串 | **不是循环。** HTTP upgrade 前 abort/terminate 可让 ws 发 error，缺监听成为未处理错误，随后 close/Promise/runner 收尾可能异常而达到超时。只能称“错误处理／完成路径被破坏的缓存 timeout”，不能凭 status 推断 CPU 忙循环。 |

父任务已新增 `handles abort before the HTTP upgrade without an uncaught socket error`：创建 probe 后立即 abort，断言 relay_unreachable、remote.control/timer 均归零、服务端没有升级 socket。父任务报告对错误事件名的定向 break-check 已捕获失败／超时。**这是父任务的新负对照证据，不是本分析自行运行的测试，亦未把第二报告 928 的缓存 Timeout 改写成新 Killed。** 第三轮须说明是否强制重跑该项，才能更新其实际检出方式。

## 更新第三轮时的检查清单

1. 以第三报告的文件＋location＋replacement 对齐，不假定全局 ID 稳定；特别是 remote-service 新心跳字段／方法会移动行号和新增变异。
2. 重新计算各范围 Killed/Timeout/Survived，区分新执行与缓存；逐项核对本表所有 ID 是否消失、被杀、继续存活或换号。
3. 保留这里的独立防线推理，但重新确认新实现没有破坏其前提；特别是确认后的 closed 防线、队列撤销后的 blocked 生命周期、probe 与正式 link 交接。
4. G 不因分组达标而自动变成 E；补测需要观察外部响应／事件／实际连接／持久化结果／诊断／保留资源，不能只断言私有实现或重复次数来凑分。资源类需要能证明对象不再被保留的检查，tracker 的 socket/timer 计数不够。
5. 本文不修改 suppression、源码或测试，不代替父任务的完整检查、三方审查与用户验收。
