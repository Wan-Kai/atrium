# MP3a 协议 27：验证记录与审查修复

本页保留 `e29e49a` 的验证事实；后续修复不能沿用它的变异成绩冒称新源码已验证。协议协调是 `c709daf`（固定 main `ace843a` 为祖先），未重新修改协议 27 或线上配对原因。

## 中断与已完成运行

- 1 runner × 1 测试 worker：经主线批准正常 SIGINT，exit 130，**中止，不是通过**。实际完成 110 个新变异：84 Killed、26 Survived、0 Timeout，剩余 367 个未完成。源码/测试 hash、配置和部分报告均已保留。
- 同一源码/测试基线改用 1 runner × 2 测试 worker：dry-run 通过，2026-10-26 22:19:47 完成，exit 0。复用 2244 条既有状态（包含 1×1 已完成结果和忽略项）；实际新跑 367 个：293 Killed、73 Survived、1 Timeout。
- 合计新执行的 477 个：**377 Killed、99 Survived、1 Timeout，79.25%**。不能用混合总分 **88.31%** 或宿主汇总 **85.96%** 掩盖这一不足；新 `relay-diagnostics.ts` 单文件 **75.11%**，覆盖还未补齐。
- 完整混合报告：2278 Killed、303 Survived、10 Timeout、20 Ignored。9 个 Timeout 是旧缓存；新 Timeout 是 `remote-service.ts:806` 的逻辑运算符变异（ID 1638），**根因未确认，不能叫已证实忙循环**。
- 协议定向变异生成 20 个，全部 Killed。只报告实际生成的变异，不把没有生成变异的配置范围算作额外覆盖。
- 随后翻译单元 126、翻译宿主集成 6、远程泄漏 2、构建通过。Electron 保险箱两例失败：手工 hello 仍写 26，引发协议不匹配；日志另有 `fast tiers unavailable`。未用重跑抹掉失败，也未宣称整套 Electron 通过。

报告保留在 `reports/stryker-incremental-remote-v27.json`、`reports/stryker-incremental-contract-v27.json`、`reports/stryker-incremental-remote-v27-1x1-aborted.json`。中断 manifest 为 `reports/mp3a-v27-1x1-aborted-manifest.json`、`reports/mp3a-v27-1x2-manifest.json`。

恢复现场另保存到 `/tmp/mp3a27-resume-evidence/`，包括日志、sentinel、报告与进程清单。确认没有测试父进程后，仅对 18 个 PPID=1 且命令位于本 worktree `.stryker-tmp/sandbox-Q45uhU/` 的 relay 发正常 SIGTERM，复核剩余 0；未删报告、沙箱或共享缓存，未触碰其他 worktree 进程。

## 审查：单次探测不能驱逐手机

Grok 审查指出并由真实 socket 回归复现：原 `relay-pong.ts` 在十秒 deadline 结束时主动 terminate，`RelayLink` 又把仅此次探测失败改成生命周期 error，导致 `RemoteService` 关闭手机流。这违反 SPEC 的“不为测试挤掉手机”。原测试要求超时后物理连接关闭，**测试预期本身错误**；旧 `relay-pong.ts` 的 100% 变异分数不能证明满足规格。

本次修复只使 deadline 结算当前检查、更新 live 诊断并释放其监听和定时器，不主动关闭控制连接，不伪造生命周期 error。实际 close/4401、stop、常规心跳自己判死仍由原生命周期处理。新增回归经真实 relay 和真实 Noise 手机通道，只丢独有 payload 的 pong、允许常规心跳；检查手机保持收发、下一次新 payload 检查成功，另外保留真实断连和拒绝会关闭手机的断言。

本轮按主线要求仅做单 worker 定向测试和破坏检查：单元 39、真实 relay 集成 64 全过，包含上述新回归 3 项；破坏检查 20＋2 全检出，类型检查、改动文件 lint/格式、diff 检查通过。未启动小时级变异或全量，修复后变异需等主线安排窗口。SPEC 另明确本机投影 `declined` 与既有通道 `pair_rejected.reason="rejected"` 的区别，没有换 wire 原因或版本。
