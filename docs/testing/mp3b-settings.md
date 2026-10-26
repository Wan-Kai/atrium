# MP3b 手机设置页实施记录

## 协议 27 协调补齐（本轮）

按 SPEC-0005「协议 27 的桌面接缝」：型号只显示 `model`（null 未知）；诊断只显示宿主的步骤证据、connect/live 区别和 `checkedAt`，重试不清旧证据、null 不沿用；network 文案为「到 relay 的 TCP 连接」，live 不声称重测认证/DNS/TLS；测试连接仅承诺 relay 控制链路。`available && handshaking` 才显示未认证的匿名握手阶段和一次灰色往返，false、结束、换码立即清除，不等动画播完；减弱动态效果使用静态箭头。旧的协议 26 缺字段说明保留为历史记录，本轮不再适用。

验证限于 client/UI 定向测试（单 worker）、破坏检查及文件级类型/格式/lint；不跑全量、Xcode、重型 e2e 或变异。真实宿主行为由父会话合入后联调。

本轮结果：

- 契约合入：`e28d033` merge `c709daf`；coverage-map 冲突保留双方章节，uqr 锁合并保留。未另外修改 host、protocol 或 Swift 源码。
- 红测试分步见到：型号显示失败 → 实现；诊断缺失失败 → 实现；匿名握手标题缺失失败 → 实现。测试按已知协议字段更新旧夹具，不再测试旧的错误码推断。
- `pnpm test:ui remote-coordination phone-section settings-panel --maxWorkers=1`：**3 文件 / 57 项通过**（`/tmp/mp3b/p27-ui-final.log`）。其中新增协调文件 20 项，包含八种失败码、非 available 旧活动、快速清除和换码。
- `pnpm exec vitest run --project unit packages/client/src/atrium-client.test.ts packages/ui/src/settings/remote-map.test.ts --maxWorkers=1`：**2 文件 / 119 项通过**（`p27-unit-final.log`）；客户端生产逻辑无需改动，已有整份快照及请求/连接代次保护能够承载新增字段。
- `pnpm break-check docs/testing/mp3b-protocol27-break-check.json`：**16/16 检出**（`p27-break-final.log`），串行，每 case 只有一个定向文件。初次仅删除旧 socket 的第一道判断没有失败，因为后续 `live === current` 仍隔离旧连接；改为同时破坏这两道分发门禁，回归确实捕获旧推送复活。不是新增生产逻辑，也未降低断言。
- UI/client 各自 typecheck 与改动文件的类型感知 oxlint 通过；未跑仓库全量检查（会触发 iOS 检查），未跑全量测试或变异。
- 已查看四张真实 SettingsPanel 截图：`packages/ui/src/settings/.vitest/phone-diagnostics-{light,dark}.png`、`phone-handshake-{light,dark}.png`。沿用原型的图下弹层、灰包和匿名候选；诊断加证据类别/时间，详情较长时在既有设置滚动区滚动。
- 待父会话合入 `e29e49a` / `5d47db2` 后验证实际同 socket ping/pong、真实网络阶段、候选活动即时清除与真机配对。仍未做 Electron 堆快照或用户验收；之前的全量超时记录不删除。

范围：SPEC-0005 需求 1、配对流程、撤销、本机命令与事件；按 design-language「设置 · 手机」和定稿链路图原型实现。仅改 client、ui 及相关验证文档，不合并 main、不推送。

## 可逆实现决定

- client 只在手机分类挂载期间 watch；离开时清空带一次性密钥的状态，重连时仅对仍打开的页面恢复 watch。事件比未恢复的读取 Promise 新时保留事件。
- 当前协议不含已配对设备的 `model`：详情显示「宿主未提供」，不从设备名猜型号。
- 当前协议仅区分 `relay_unreachable` / `relay_rejected`。前者的网络、DNS、TLS 标为「未能确定」，后者可确定令牌被拒；不假装逐项检测成功。
- 协议没有握手中间事件，保留二维码直到 `awaiting_confirmation`；不伪造「握手完成、等密钥确认」状态或握手数据包。
- 使用已有 MP0 使用的 uqr 0.1.3 编码真实二维码，四模块静区；不复用原型的伪随机码。
- 所有 destructive 操作行内确认，失败保留错误和重试；撤销写盘失败时保留目标 id，设备即使已从推送列表消失仍能重试。
- 动画固定 3900ms，速率只写在节点下，不按流量改变线宽或包大小（遵循定稿原型，与 SPEC 早期「按流量画疏密」不同）。

## 验证记录

### 已验证

统一用 Node 22.19.0。日志保存在本机 `/tmp/mp3b/`，截图使用合成设备和地址、不含真实密钥。

- `pnpm check`：最终通过（`check-last.log`）。boundary：URLs 14、环境变量 41、隐藏命令 4，未登记 0、不精确 0。
- `pnpm test`：先前完整通过，203 文件 / 3799 项，随后 Swift 22 项通过（`test.log`）。后续补了 3 项纯逻辑测试；最终定向 `pnpm exec vitest run --project unit packages/client packages/ui/src/settings/remote-map.test.ts --maxWorkers=1` 为 4 文件 / 151 项通过。
- `pnpm test:ui`：一次完整运行 50 文件 / 1028 项通过（`ui-all2.log`）。之后补了剪贴板、配对监听释放等测试；`pnpm test:ui phone-section settings-panel --maxWorkers=1` 为 37 项通过（`ui-related-last.log`）。父会话要求继续降并发复验后，最终 `pnpm test:ui --maxWorkers=1` 全量 **50 文件 / 1030 项通过**，用时 205.73 秒（`ui-review.log`）；随后 `node scripts/ios.mjs kit --if-xcode` 的 Swift **22 项通过**（`swift-review.log`）。
- 破坏检查 25 处全部检出：`docs/testing/mp3b-break-check.json`，前 23 处整批通过（`break.log`），新增的 Escape 监听与倒计时释放 2 处随后通过（`listener-break.log`）。最初漏掉的 map → list 悬停已补测试；client 的两处初始漏检，一处补拒绝参数测试，另一处是断线时提前 return 与 catch 相同结果的等价路径。
- 客户端增量变异：`pnpm test:mutation shared '--mutate=packages/client/src/atrium-client.ts:931-944,packages/client/src/atrium-client.ts:1106-1115,packages/client/src/atrium-client.ts:1238-1238,packages/client/src/atrium-client.ts:1519-1546'`，72/72 检出、无超时、100%。初跑的非等价存活均补测（晚失败不能覆盖、退订时断线与宿主拒绝）；JSON 省略 undefined 字段的等价变异已注释。
- 动画纯逻辑变异：`pnpm test:mutation ui --mutate=packages/ui/src/settings/remote-map.ts`，初跑 102/103，唯一存活为三次曲线在 0.5 的相等分界；注明等价后 101/101、100%，无超时。两份报告在 `reports/mutation/{shared,ui}.html`。
- 自动资源回归：普通页面 12 次开关，每次时钟归零、DOM 移除、watch 关闭；配对页 8 次，每次倒计时归零，卸载后 Esc 不再发命令。
- 真实 Chromium CDP：对真实 SettingsPanel + fake RemoteState，25 次打开/关闭后强制 GC；`Memory.getDOMCounters` 从 `{documents:2,nodes:405,jsEventListeners:277}` 到 `{documents:2,nodes:360,jsEventListeners:273}`，无增长。再故意保留 5 份已卸载 DOM，涨到 `{documents:2,nodes:1432,jsEventListeners:385}`，负对照成立。不是 Electron 堆快照分析的替代。
- Impeccable 检测器对新增页面、CSS、地图、配对组件返回 `[]`；未做独立模型审查，留给 MP3 集成审查。

### 失败与未复验的部分

- 第一轮全量 UI 冷缓存触发 `react-dom/server` 优化后重载，Mermaid、滚动及 iframe 就绪失败。补齐 `react-dom/server` 与 `@atrium/protocol > zod` 的显式预构建；下一轮全量 1028 项通过。中间曾把 zod 写成顶层依赖名，Vite 提示无法解析，改成实际的协议包依赖路径后定向运行无此警告。
- 最终重跑 `pnpm test`：3793 过、9 超时，4 文件（`scripts/boundary.test.ts`、testkit 的 git、宿主 workspace-archiver/workspace-service），日志 `test-final.log`。再用 `--maxWorkers=2` 仍出现 Git 场景超时，整次运行超出 300 秒工具限时。同期另两个 worktree 的变异测试在跑、机器 load 约 30；未终止别人进程，也未放宽测试期限。不能把本轮全量说成通过；父会话在机器空闲时应重跑。
- 该轮全量 UI 因前序占用及整条工具命令 300 秒期限被中断，未得到完整结果（`ui-final.log`）；未删除或跳过测试，之后已用单 worker 全量复验 1030 项通过。
- 继续复验：`pnpm test --maxWorkers=1` 从 15:50 跑到 16:05，900 秒工具限时中断，没有完整汇总（`unit-review.log`）。已观察到 5 个超时：workspace-archiver 1 项、boundary 3 项、testkit/git 1 项；启动时机器 load 40.90，结束时 24.93，其他 lane 同期在跑。不据此断言全部超时的唯一原因，也未动这些非本 lane 文件。全量单测最终绿灯仍待资源允许时补齐。
- 尚无真实宿主端到端配对、真机扫码或钥匙串授权验证：本 worktree 依要求只合到 20169cc，宿主仍回 `remote_unavailable`。没有运行 Electron `test:leak` 的堆快照、打包、三方审查或用户验收。没有合并 main、推送或修改用户的剪贴板。

### 截图和原型差异

- 浏览器测试自动生成：`packages/ui/src/settings/.vitest/phone-settings-light.png`、`phone-settings-dark.png`，真实 900×640 SettingsPanel。已阅读两张图片。
- Ego 浏览器人工查看（960px 窗口）另存 `/tmp/mp3b/real-{light,dark,qr}.png`；原型对照 `/tmp/mp3b/prototype-{light,dark,pair}.png`。实际组件来自临时 Vite 页面，截图后页面和服务器已删除/停止，任务浏览器已关闭。
- 保留：地图布局、252px 高度、五色、S 车道、统一圆点、锁闪光、节点详情尖角、灰色离线、完整列表、图下配对层。
- 差异：用仓库 Hugeicons（不是原型手绘近似图标）；颜色按 deviceId 哈希（不是原型按设备顺序分配）；Mac/relay 下写实际合计速率；日期含本地时分；真实二维码 160px 加静区；不放原型的模拟按钮、假的型号/RTT/诊断细分/握手中间态；测试连接文字明确可能重连，避免原型“不会影响已有连接”的错误承诺；成功提示只保留最新一条，错误常驻重试区。断线时没有模拟 Mac 发向断口的数据包（只显示红色断线与原因）。

### 整合待办（父会话）

1. **锁文件已完成（父会话授权后补）**：根 `pnpm-lock.yaml` 仅在 `packages/ui` importer 增加 `uqr` 的三行（specifier/version 都是 `0.1.3`），复用原有 MP0 的包条目，无其他解析变化。最初普通 offline 与 lockfile-only 安装因已存在的 node_modules 快速返回、没有修正根锁；用 `pnpm install --offline --frozen-lockfile` 实测拒绝，明确指出 UI 新增 uqr 未锁定。补齐这三行后，重新运行 **`pnpm install --offline` 和 `pnpm install --offline --frozen-lockfile` 均退出 0**，最终 diff 仍仅三行。交付路径不再依赖 `--lockfile=false`；日志为 `/tmp/mp3b/install-lock-final.log`、`install-frozen-final.log`。没有新引入未缓存的包。
2. **协议缺项已补齐**：父会话提供 `c709daf` 的协议 27 接缝，UI 已消费 `model`、诊断证据及 `handshaking`，见文档开头本轮结果。未知仍只用于 null / unknown，不再把已有字段退化成占位；协议本身未由本 lane 修改。真实行为留集成阶段验证。
3. 机器空闲后重新跑全量 unit（全量 UI 已在单 worker 下通过），合真实宿主后做端到端与真机扫码，再按 MP3 安排三方审查及用户验收。
4. Ego Lite 提示有更新；未升级，若需要请用户批准。

### Electron 堆快照的最窄入口（仅核对，未执行）

- 共用实现：`apps/desktop/e2e/heap.ts` 的 `takeHeapSnapshot(page, file)`（Electron renderer 的 CDP 会话，强制 GC、写 `.heapsnapshot`）、`findDetachedDomLeaks(baseline, final)`（按 V8 `detachedness` 统计脱离 DOM 的增长，预期空数组）。
- 最小现有示范：`apps/desktop/e2e/appearance.leak.spec.ts`，使用 `launchApp()`、前后两份快照和重复操作。启动工具在 `apps/desktop/e2e/launch.ts`，隔离 `ATRIUM_HOME`；`apps/desktop/playwright.config.ts` 固定一个 worker。
- 核验现有 Electron 快照链路的最窄命令：先 `pnpm build`，再 `pnpm --filter @atrium/desktop test:e2e appearance.leak.spec.ts --workers=1`。已有当前分支产物时可省去 build；不必运行会先跑所有 Node 泄漏测试的 `pnpm test:leak`。
- Phone 当前测试是 `packages/ui/src/settings/phone-section.browser.test.tsx` 的页面 12 轮和配对 8 轮生命周期回归，以及上述人工 Chromium DOM 计数；**尚无 Phone 专用 Electron 堆快照 spec**。集成真实宿主后，最小新增是仿照 appearance 的单个 `phone.leak.spec.ts`：预热后关闭设置取 baseline；重复进入手机分类/打开并取消配对/关闭设置，每步等 DOM 状态落定；最终关闭后取快照，断言 `findDetachedDomLeaks` 为 `[]`，并注入保留 DOM 的负对照。届时定向命令为 `pnpm --filter @atrium/desktop test:e2e phone.leak.spec.ts --workers=1`（目前该文件不存在）。协议占位宿主只能测 `remote_unavailable` 页，不能宣称覆盖地图、二维码、动画与配对监听。
