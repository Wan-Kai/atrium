# MP3b 手机设置页实施记录

## 撤销重试边界收紧：同身份换 token（本轮）

父会话复核真实 host：set_remote 保存 relay 时不会滤掉仅内存 blocked 的设备，所以同 URL / hostId 换 token 成功不等于失败撤销已落盘。纠正 A 的过宽决定：relay 保存不再调用显式清理，依靠公开 hostFingerprint / relay URL / hostId 的 observer 判定真正身份变化；reset 成功的显式、代次安全清理仍保留。保存失败、仅 token 更换均保留目标；不存 token 作比较，不改断线/null 快照逻辑。

验证：新增真实 SettingsPanel + 实际 client 回归，隐藏 A 后先保存失败、再成功同身份换 token（期间离开手机分类），返回仍准确重试 A，未把 A 塞回设备列表；修改前失败（`/tmp/mp3b/token-revoke-red.log`）。另补 URL、hostId 变化清除两个用例，并将原错误的“relay save 一律清除”测试收窄为 reset 成功清除。`pnpm test:ui revocation-retry --maxWorkers=1` 当前 8/8 通过（`token-revoke-green.log`）；`pnpm break-check docs/testing/mp3b-token-revocation-break-check.json` 4/4 检出（`token-revoke-break.log`）：恢复成功保存就清除、保存失败也清除、遗漏 URL / hostId 的身份比较。UI typecheck、改动文件类型感知 lint 与格式通过。未跑全量、e2e、变异、Xcode；真实 host 落盘/blocked 联调留父会话。

## 审查修复 B：保险箱错误及重置确认文案（本轮）

keychain_unavailable 仅表示暂时无法访问；提示允许授权、若此前拒绝则重启后再试。原“重新授权”改为被动“刷新状态”，不调用 set_remote、不承诺原进程再弹授权。corrupt 涵盖文件损坏或密钥不匹配导致无法读取，不断言已确定物理损坏。重置保留两步确认；只有 vault=ok 才使用设备数量，其它状态写数量未知，并明确永久替换原宿主身份/设备记录、所有手机重配；无法读取时不承诺保留 relay 凭据。仅 UI 文案与被动刷新入口，不改 host、协议或权限。不可读时设备列表标题也写“数量未知”，避免同屏一边写 0 台、一边确认数量未知。

B 验证：新增 `vault-guidance.browser.test.tsx` 8 项起初全红（`/tmp/mp3b/vault-red.log`），实现后 8 绿；列表未知数量的两个断言也单独见红（`vault-count-red.log`）。`pnpm test:ui vault-guidance revocation-retry phone-section settings-remote-watch --maxWorkers=1`：4 文件 / 45 项通过（`vault-regression.log`）；`pnpm break-check docs/testing/mp3b-vault-guidance-break-check.json`：6/6 检出（`vault-break.log`），覆盖拒绝后重启提示、腐坏/密钥不匹配的有限结论、未知/已知 0 数量、刷新不提权、两步 reset。已查看浅/深色长文案截图：`packages/ui/src/settings/.vitest/phone-vault-confirm-{light,dark}.png`、`phone-keychain-error-{light,dark}.png`。沿用既有错误行、详情与行内确认，无新卡片或页面。没有运行全量、e2e、变异或 Xcode，实际钥匙串分类留给宿主整合验证。

## 审查修复 A：失败撤销目标独立保留（本轮）

设置窗口 owner 内按 deviceId 维护仅失败撤销的目标表，与 PhoneSection 通用 failure/notice 分开；无磁盘存储、自动重试或通用命令队列。成功重试只删除对应目标；实际卸载、可见身份/relay 配置变化清表并推进代次。原 A 把保存 relay（包括只换令牌）及重置身份成功都视为清表时机，此处过宽，已由文首本轮纠正；现在只有 reset 保留成功后的代次安全回调，relay 仅在公开身份变化时由 observer 清理。失败或仅换 token 不清表，旧回调不复活或清除新身份目标。宿主已隐藏/拉黑的设备不重新加入列表。原有其它历史验证不改写为本轮结果。

A 验证：`revocation-retry.browser.test.tsx` 使用真实 SettingsPanel + 实际 client/协议解析 + 脚本化 socket；初始 4 项全红（`/tmp/mp3b/revoke-red.log`）。补入晚到 reset/关闭回调后共 5 项，连同 Phone 和窗口 watch 回归，`pnpm test:ui revocation-retry phone-section settings-remote-watch --maxWorkers=1` 为 37 项通过（`revoke-regression.log`）。`pnpm break-check docs/testing/mp3b-revocation-break-check.json` 7/7 检出（`revoke-break.log`）；UI typecheck 与改动文件类型感知 lint 通过。旧破坏清单的 revoke 与通用错误匹配点同步到当前代码，历史计数不重算。本轮未跑全量、e2e、变异、Xcode。

## 用户选择：整个设置窗口订阅（本轮）

审查后用户明确选择 SettingsPanel 为唯一 watch owner：挂载开启，实际卸载退订并清空；切换分类不重复订阅，未保存配置拦截关闭时维持订阅。PhoneSection 只管理自己的 mounted guard、动画和计时器；重试读取请求交给设置窗口，不持有 watch 生命周期。不全局常驻、不持久化二维码、不新增公网/手机连接、不自动确认或取消配对、不改变远程开关。

原“仅手机分类订阅”是被替换的实施决定，下方旧验证结果按历史保留，不冒充本轮结果。撤销失败重试被其它动作覆盖的问题不在本轮修改范围。

实现与窄验证：

- SettingsPanel 的挂载 effect 开 watch，cleanup 关 watch；关闭请求被配置 guard 拦截时不会触发 cleanup。PhoneSection 删除生命周期中的 watch 调用，保留自身 mounted guard 和计时器释放，读取失败的重试经 owner 的 `onRetryRemote` 回调。
- `settings-remote-watch.browser.test.tsx` 真实挂载/卸载生产 SettingsPanel；两项使用实际 `createAtriumClient`、协议 schema、脚本化 socket 和假时钟，另两项验证配置拦截与分类退出的局部资源。测试 harness 仅打开/关闭窗口和选分类，无自建 watch effect。
- 红阶段：初始 3 项全红（`/tmp/mp3b/settings-watch-red.log`）；实现后 4 项通过。覆盖非手机入口的橙点/错误、手机切走继续更新与结束清标记、无重复 watch、关闭清空与迟到读/推送、重开与只对仍打开窗口重连订阅；socket 命令完整过滤断言确认没有 set_remote、确认/取消配对等额外动作，窗口反复开关不新增连接。
- `pnpm test:ui src/settings --maxWorkers=1`：11 文件 / **145 项通过**（`settings-owner-green.log`），仅设置目录，不是全量 UI。初跑其它设置分类的命令数组多出一次 watch，按新契约精确更新期望，未删断言或过滤掉 watch。Phone 旧场景改为由真实 SettingsPanel 包住，保留 12 次窗口开关、8 次配对开关及动画/监听释放断言。
- `pnpm break-check docs/testing/mp3b-settings-watch-break-check.json`：**8/8 检出**（`settings-owner-break.log`）：不订阅、不退订、分类依赖导致重订、关闭请求过早退订、偷偷取消配对、迟到读取复活、退订后推送复活、窗口关闭仍重连订阅。每 case 一个浏览器文件串行跑。原 `mp3b-break-check.json` 的两个旧 owner case 也更新为窗口入口，历史计数不重记。
- 最终单文件 `pnpm test:ui settings-remote-watch --maxWorkers=1` 4 项通过（`settings-owner-final.log`）；UI/client 各自 typecheck、改动源文件/设置测试的类型感知 lint、格式及 diff 检查通过。
- 未跑全量测试、e2e、变异、Xcode。Electron Phone heap spec 仍缺，应覆盖真实窗口关闭后的 QR/DOM 释放，以及只切分类时局部动画和对话框释放、窗口 watch 保留；最窄入口仍见文末。

## 三方审查后的型号标注修复

只修确认弹层：`request.model.trim()` 非空时按原值显示，否则“未提供”；独立一行明确“手机自报，非硬件认证”，不把密钥确认误解为型号认证，也不从设备名推断。设备详情和协议不改。

- `pnpm test:ui remote-pairing.browser.test.tsx --maxWorkers=1`：先 3 项全红（`/tmp/mp3b/model-label-red.log`），实现后 3 项全绿（`model-label-green.log`）。覆盖普通型号前后空白、空字符串、全空白，并确认仍能看到校验流程和确认按钮。
- `pnpm break-check docs/testing/mp3b-pairing-model-break-check.json`：删除自报声明、不 trim、回退到设备名三个破坏全部检出（`model-label-break.log`）。单文件串行，无全量、e2e、Xcode 或变异。
- 改动 TSX 的格式、类型感知 lint 和 `git diff --check` 通过。历史全量超时记录保留。

**历史评估（当时未获决定、未修改；现已选择整个设置窗口订阅，见开头本轮）**。当时只读评估的最小方案：如选“整个设置窗口订阅”，把 watch true/false 的 effect 移到 `SettingsPanel`，仅挂载/卸载时运行；`PhoneSection` 保留本地 mounted/pending 生命周期保护，但移除 watch 调用。分类切换不再退订，关闭整个窗口才退订并清空含二维码的状态；不引入额外缓存或订阅 owner 参数。需要调整 PhoneSection 独立测试的初始 store 装载方式，并由 SettingsPanel 用例覆盖“外观页打开即订阅、切分类不重复订阅、关闭清空、迟到响应不能恢复、侧栏标记跟随推送”。若选“仅手机分类”，保留当前 owner，仅收窄提示的规格与验收范围。两种均须用户确认后再实现。

## 协议 27 协调补齐（历史轮次）

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

## 首次实现决定（历史，watch 范围已由用户选择替换）

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
