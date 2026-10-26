# MP3a 迟到诊断与 traffic 推送：后续定向验证

基线 `2cb7958`（生产源码与冻结 `7b88613` 相同）。父已批准分两个提交；尚未安排新 Stryker 窗口，不继承旧冻结版成绩。

## A：公开的迟到诊断保护

契约：SPEC-0005 的取消/旧代回调不得覆盖新证据；probe 不拥有控制连接生命周期。

验证边界已由父确认：真实 WebSocket、RelayLink 的公开 stop/retryNow、diagnostics getter 和 onState 回调；不直接改变 private generation，不导出私有接口。正常实现先绿，再逐条施加旧报告738/740/742变体证明可观察断言变红，不伪称生产先红。需核对停止后无迟到证据/通知、新代不被旧check覆盖、当前代正常成功/失败仍更新，以及真实资源释放。公开回调同步retryNow属于重入，若暴露新缺陷则先报告，不擅自扩大实现。

正常实现基线28/28，新增stop及强化current成功/失败/恢复观察后29/29；精确738/740负控2/2均同时检出诊断覆盖与迟到通知，恢复后29/29。停止后真实socket/client、资源及计时器归零。定向格式/lint、host类型检查通过；不是生产先红，生产文件未改。

**742仍阻塞，未施加/未豁免**：真实旧socket4401关闭时，在公开onState(error)同步调用retryNow，已进入新connecting，但新retry在新socket ready前收到旧relay_rejected，并多出一个重试timer（control1/timer2，新ready后仍timer2）。这是真实公开回调重入缺陷，不能为杀掉742而伪造private代次或掩盖旧close副作用。按父要求停止扩实现；失败复现及完整日志保留在 `/tmp/mp3a-late-pong-tests/reentry-reproduction.test.ts`、`.patch`、`reentry-investigation.log`，未把失败调查用例混入已绿回归。正常stop清理仍全部归零，后续修复等待单独授权。

未跑Stryker、全套或独立泄漏套件；旧70%保持历史事实，不能由两项负控推算新分数。

## B：仅在可见 traffic 数值变化时采样推送

契约：整个设置窗口由 SettingsPanel 唯一拥有订阅；保留2秒窗口、离线但仍在列表的设备速率衰减、状态/配对/relay即时通知，最后unwatch释放采样资源。

验证边界已由父确认：RemoteService get/watch/unwatch、发送给本机watcher的完整remote_updated、真实Noise手机密文字节及注入Clock/ResourceTracker。先让idle/稳定公开值的回归在无条件推送版本失败，再只调整采样timer的可见down/up变化判断。不用全状态深比较，不增加参数/协议/暂停采样机制；覆盖多watcher、恢复订阅和被隐藏设备遗留计数。

结果待执行后填写。
