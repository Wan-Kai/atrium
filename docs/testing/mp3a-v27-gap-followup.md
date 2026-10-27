# 协议 27 存活项补测（不重跑 Stryker）

基准是 `e29e49a` 的 `reports/stryker-incremental-remote-v27.json`：原 fresh 99 Survived（diagnostics 56、link 14、service 29）及新 Timeout 1638。生产后续已有 `c4620ef` 的非破坏 probe 修复、`7303616` 的保险箱分类修复；本轮**没有修改生产源码、协议或阈值，没有新增变异豁免**。

新增测试在正确生产代码上本来应绿；以下“检出”来自施加原报告的精确变异后断言失败，不伪称原生产代码先红。测试跑单 worker，未启动 Stryker、全量、UI、Swift 或外部网络。

## 验证结果

- 诊断分类／真实诊断／链路单元：**77/77**。
- 投影及真实 Noise 手机通道宿主测试：**19/19**。
- `src/remote/v27-survivor-break-check.json`：**44/44**（D39＋L5）。L566 初次未检出；补了完整 ready-timeout 诊断断言并修正过滤后全部复验。
- `test/remote/projections-survivor-break-check.json`：**8/8**（S7＋原 Timeout 1638）。
- `src/remote/live-rejection-break-check.json`：**1/1**，防止把 live 期间 4401 误说成重新做了令牌认证。
- 合计 53 条负控，确认检出原 99S 中的 **51** 项、原 Timeout 1 项及新增语义防线 1 项。另 3 项被先前正确性修复取代；其余 45 项本轮未逐项消除／复验，见下表。**不据此推算新 Stryker 百分比。**
- 分类 fixture 首次清理用 `events.once(close)`，被正常 destroy 后的 socket-hang-up error 拒绝，29 例清理失败；改为只等 close、保留 error handler 后通过。这是测试 fixture 问题，不是生产缺陷；首次失败见本任务工具输出。

## 证据层次与已检出 ID

D/L/S 分别指旧报告的 relay-diagnostics.ts、relay-link.ts、remote-service.ts；ID 只引用这个固定报告。

| 范围 | 原 ID | 新观察 |
|---|---|---|
| D：初态 | 246,250,254,255 | 不创建请求时域名仍 unknown；IPv6 字面量为 not_applicable；没有 upgrade 证据不能报 upgrade 失败 |
| D：码分类 | 227,228,230–235,237–239,241,242,377,379,380,382 | 受控 ClientRequest error 事件逐码断言完整快照，不宣称 OS 真实产生了每个 TLS/connect/DNS 错误 |
| D：lookup | 334,338,340,342 | resolver 用 setImmediate，确认 socket lookup 被观察；包含未分类 Error，不能由 request ENOTFOUND fallback 偷补相同结果 |
| D：因果 | 366,406,408,412–414,421,423–426,435,436,438 | 保留首个明确失败；全 connect 与混合 AggregateError 分开；错误 syscall、未知码、普通 reset/timeout 不造失败阶段；真实 TCP 已连接后再注入 connect-shaped 错误，network 仍 passed |
| L：真实连接边界 | 554,555,566,687,688 | 控制和 probe 在 70KiB 接受、70KiB＋1 拒绝；真实支持压缩的服务器确认未协商扩展；ready 超时核对完整诊断。70/1024 经 ws 转成 0 的无限额变体被超限消息抓住 |
| S：通知与资源 | 862,1367,1369,1637,1639–1641 | 无 watcher 不增通知 timer；unwatch 后新订阅/候选能发布；已发布 true 后一候选退出、另一条仍活，推进 100ms 不重复；手机断开立即 offline，不等流量采样 |

真实 TCP/TLS/HTTP/Noise 场景仍使用现有本机服务器；纯初态和错误码分类单测明确标为受控输入，不替代平台故障复现。不导出私有实现，不做通用模拟层。

## Timeout 1638：本次确证什么

精确变体仍保留 `cancelHandshakeNotice !== null` 防重复条件。受控执行失败于**额外 timer／重复通知**断言；两例 teardown 约 **23.93ms / 10.85ms**，timers/resources 全为 0，两个 relay PID 均退出。

因此本次没有复现忙循环或收尾阻塞，不能把历史 Stryker Timeout 写成已确认循环，也不能确定历史 deadline 是哪种环境／执行时序导致。原报告状态仍保留。详细受控日志在 `/tmp/atrium-projections-survivors/`；生产文件 hash 已确认恢复。

## 剩余表（不等于豁免表）

| 范围 | ID | 当前判断／下一步证据 |
|---|---|---|
| D | 252 | 对 URL.hostname 的规范 IPv6，仅开括号位于首位，放宽开括号 regex 锚点不改变剥离结果；独立静态推导，未加 ignore |
| D | 253 | 对规范 hostname，仅闭括号位于末位，放宽闭括号锚点不改变剥离结果；独立静态推导，未加 ignore |
| D | 454 | liveDiagnostics 同样先经过 URL 解析，合法 hostname 中开括号只在 IPv6 首位；未加 ignore |
| D | 455 | liveDiagnostics 的规范 IPv6 闭括号只在末位；未加 ignore |
| D | 265,292,328,332 | disposed 后 observe/opened／已入派发快照回调；尚未逐条建立正常调用路径或额外公开资源证据，不批量称等价 |
| D | 346,348 | 未授权 secureConnect 的防御分支；不能以关闭 TLS 校验造正常生产情形 |
| D | 389,399,410,411,418,419,430 | error 类型、空 errors、非 Error cause 等；本轮分类测试可能已增加覆盖，但未施加这些原变异复验，不计入已杀 |
| L | 517,519,521 | pending pong 在 stop／代次变化后的结果归属，需要专门迟到事件观察 |
| L | 548 | generation 增量变减量仍可能保持互异；未证明行为差异，不加豁免 |
| L | 644,741 | finish 已清理部分路径，仍须分别核实 stop/abort/无回调路径，不整体称冗余 |
| S | 924–928,932,935 | 外层取消/代次守卫可能被内层 probe 取消遮挡；先证明能穿过内层，不伪造私有状态 |
| S | 1297,1305,1314,1376,1378,1380,1488,1618 | 代次及旧流守卫需结合 closed 标记、候选移除和存活流证明真实可达性 |
| S | 1304,1307,1311,1317 | 控制失败／disable 的主动数据流关闭，需排除 relay 自动断流的遮挡 |
| S | 1650–1652 | 无 watcher／关闭时的投影计算与空发送集合；尚未建立公开差异 |

旧 L525、L528、L529 位于已被 `c4620ef` 取代的错误状态分支，标记 **superseded**，不是被测试杀死；不能恢复“单次 probe 超时踢手机”的错误预期。

## live 与 4401

SPEC 与真实链路测试明确：live 收到 4401 仍是 `token: unknown`、`failure: token_rejected`。当前连接被拒绝，不等于这次重做了令牌认证；后续真正 connect 收到 ready 才有新的 `token: passed`。版本仍为 27，无新例外。
