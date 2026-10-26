# 手机端渲染零件（MP5 / MP6，2026-10-26）

第四路提前实现的零件，不表示 MP5 / MP6 或手机完整流程已完成。源码限于 AtriumRender（纯逻辑）和 AtriumUI（SwiftUI）；App 的 Debug 陈列页入口、测试资源与依赖清单是必要接线。视觉以 design-language「手机端」及定稿原型为准。

## Markdown 选型

选 `swiftlang/swift-markdown` **0.9.0**（Apache-2.0 + Runtime Library Exception，commit `25cb61d3482054b09ae76ca4f281b1bfe7fe5a43`），精确版本依赖；传递依赖 swift-cmark **0.9.0**（BSD-2 / MIT，commit `08ddb528923cc1a6527e02b7a1aee9e516ca749a`），锁在 Package.resolved。解析后变成 Sendable / Equatable 的显示模型；只有 AtriumUI 碰 SwiftUI。

比较：微软 SwiftStreamingMarkdown **v0.7.0**（MIT，commit `5f7c04e0558d…`）虽有流式视图，仍每快照整篇重解析、构建 attributed string，靠块的 Equatable 跳过视图更新；没有尾块缓存。自带动画可关闭，但列表、代码头、表格等块视图不可替换，达到我们的样式要 fork。依赖钉死 swift-markdown 0.7.3，又引入 Equatable 宏、swift-syntax、iosMath、HighlightSwift、Shimmer。精确 tag 依赖解析因上游 revision 依赖失败；按 commit 才可解析。Atrium 的显式 import-check 被上游宏 target 漏声明依赖卡住，Xcode 还需批准宏。

调研子代理在 M4 Pro、macOS release 实测（非模拟器/真机 UI 数据）：20 KB / 100 KB Markdown，swift-markdown 全文解析中位 **1.02 / 5.5 ms**，解析+遍历 **1.45 / 7.6 ms**；SSM 解析+建块 **9.4 / 46.9 ms**。每 150 ms 增长 60 字节，仅解析尾块中位约 **0.02 ms**、100 KB 样例 p95 **0.08 ms**。macOS arm64 strip 后增量代码：swift-markdown 约 **1.07 MB**；SSM 约 **2.5 MB**加 **1.6 MB**资源。不能把这些当作 iPhone 的性能结论。

### 流式边界和降级

解析选项关闭 smart punctuation，不替换代码回复里的引号。尾块由解析器的顶层块 SourceRange 确定，UTF-8 行/列换算；只冻结位于空行之后且首行完整的顶层块之前的内容。表格后半行、列表数字前缀尚未完整时，保留前一块一起解析。不用空行正则自行猜块类型。

引用定义可能在后面改变前面的链接，所以出现 `[` 时保守回到全文解析（仍按显示模型比较冻结行）；流结束也完整重解析一次。这牺牲带引用/任务列表/表格链接的增量性能以保持语义，不把后置引用错误冻结。解析和高亮不放在 SwiftUI body 的主线程。

支持标题、段落、强调、删除线、行内代码、链接、代码围栏、列表/任务列表、引用、GFM 表格、分隔线。HTML 作为原文；Mermaid / PlantUML 是原文加「在 Mac 上查看」；图片仅 alt，不产生自动外部请求。仅允许 http/https 的链接打开外部浏览器，不执行 javascript/file/自定义 scheme。公式暂原文，未引入数学渲染库。

揭示节奏沿用桌面的积压比例（150 ms 时间常数，不是所有突发都在 150 ms 内完全显示），按 Swift Character 切分以保留字素。初次历史快照全显，后续增长平滑揭示。

## 高亮选型

比较了 tree-sitter（swift-tree-sitter **0.10.0**，BSD-3，核心 **0.25.10** MIT）、HighlightSwift **1.1.0**（MIT）、HighlighterSwift **3.1.0**（MIT）、Splash **0.16.0**（MIT）。Highlightr **2.3.0** 已宣布停更。

子代理实测约 500 行 TypeScript、macOS release：tree-sitter **3.6 ms**（冷 query 18–24 ms），HighlightSwift **70 ms**（冷 0.6–0.9 秒，曾 5 秒）、HighlighterSwift **37 ms**（冷 96 ms）。Splash 只支持 Swift，淘汰。tree-sitter 快但各语言要分别接 parser / scanner / query，17 类语法约 11 MB 目标文件，部分 manifest 有链接问题。HighlightSwift 用后台 HTML attributed-string 导入，有线程约束风险；HighlighterSwift 不能公开自定义主题。

本次采用更小的可撤回选择：原版 **highlight.js 11.11.1** 常用语言 bundle（npm `@highlightjs/cdn-assets@11.11.1`，**BSD-3-Clause**，127496 B），自己写 JavaScriptCore actor 和 span→scope 转换。无需第三方 Swift 桥、不用 HTML importer；不 auto-detect，只按围栏语言高亮，未知语言原文。36 个语言包括 TS/TSX、JS、Swift、Python、Go、Rust、JSON、Bash、HTML、CSS、YAML、TOML、SQL、diff、Markdown。原版资源、许可证、来源一起打包；颜色在 AtriumUI 统一映射。长期超大代码块仍可能耗 CPU，须模拟器和真机单独测，不以 actor 名义声称已经满足帧预算。

## 过程轨道与 diff 边界

RailRows 接协议 Turn / Step，空文本过滤、末尾文字回复拆分、探索分组、插话/失败支线、压缩与提问节点。当前是显示零件，不包含连接、提问提交、详情取回和子代理车道完整交互；上层持有 expanded 与完成后 1 秒的折叠计时。

DiffLayout 接协议 DiffHunk，不自行解析 git 文本。hunk 内连续上下文超过 8 行折叠，变化两侧各留 3 行；中间缺失的上下文协议没发送，MP6 接线必须取得匹配比较版本的内容，不能伪造。base diff 是 merge-base→HEAD；`read_file` 读取工作树，不能拿它回填 base diff。没有版本匹配保证时不提供补读动作，本路不新增宿主 API。默认不换行；当前 SwiftUI 实现每个 hunk 横滑、header 固定，与原型每文件横滑不同，待验收。时间线方案与实测结果随后补入。

## 验证记录

### 逻辑与审查

- Markdown 每个 Character 前缀与整篇解析逐块相等，12 组含中文/emoji、表格后半行、列表数字前缀、setext、后置引用、HTML、围栏、缩进代码、混合 CR/LF/CRLF。审查找出并先红后绿修了源列切片剥掉缩进、仅计 LF 导致丢段落两处；另修容器中围栏闭合标记。
- 过程审查 7 项：像素猫绝对时间浮点截止、Reduce Motion 空间动画和重新开启、最终回复前思考被错误标 live、详情/答案遗漏、折叠插话丢失、等待回答标题。均有回归；3 项 SwiftUI 动效接线测试是源结构守卫，不替代运行时逐帧验收。
- `pnpm break-check .../Fixtures/render-break-cases.json`：最终 **24/24 CAUGHT**；第一次全 NOBUILD 是图库试图写 SwiftUI 只读 accessibility key，已改统一可追加降级的环境策略；第二次一项测试数组越界使破坏检查无法认失败，改成 `#require` 先核对长度后最终全检出。`rail-break-checks.json` **11/11 CAUGHT**。不把 NOBUILD 当成功。

### 性能（尚未通过验收预算）

本分支 `RenderPerformanceTests`，macOS arm64 Release，96000 B（4800 个块）的全量解析**加显示模型转换**，5 次中位 **43.86 ms**；500 行 TS 高亮**加 span 转换**中位 **49.73 ms**；已冻结后的追加，解析 22 B 尾块但仍有前缀检查/数组处理，**2.87 ms**。这些与前面调研的「仅 cmark 解析」不是同一指标；工作发生在 actor，不等于 UI 主线程耗时。

模拟器 iPhone 16 Pro / iOS 26.5，Debug，1000 个可变高度会话行、尾部 180 次更新，CADisplayLink 记录帧间隔；两种容器使用同一 `.equatable()` 行与同一夹具，XCUITest 核对跟随到最后一行。初轮实测：

| 容器 | 第一次 p95 / max (ms) / >50ms 次数 | 第二次 | 第三次 |
|---|---|---|---|
| List | 54.60 / 599.89 / 10 | 16.67 / 381.69 / 2 | 16.67 / 151.85 / 2 |
| LazyVStack | 16.67 / 790.33 / 2 | 42.80 / 1230.18 / 6 | 16.67 / 259.01 / 1 |

全量测试和辅助功能截图后的第二轮对比（同样每种三次）：List 的 p95 均为 **16.67 ms**，max **95.79 / 134.58 / 107.97 ms**（>50ms 次数 1/2/1）；LazyVStack 的 p95 均为 **16.67 ms**，max **128.05 / 89.50 / 164.64 ms**（2/1/2）。热身后好转但仍有长帧，保留两轮数据，不只报较好的一轮。

继续暂用 List（遵循 SPEC 的复用与初始定位取向；高负载采样不能用于判定两种容器谁更快），**不能据此认定性能完成**：两者均有长帧，Debug/模拟器/自动化有干扰，尚无 Release Instruments 的主线程任务 trace；50 ms 主线程预算未证实通过，真机未测。完整命令 `TEST_RUNNER_ATRIUM_GALLERY_SHOTS=1 pnpm test:ios`；结果和样本在 xcresult 附件，不记录真实对话。

最终验证：`pnpm check` 通过；`pnpm test` 3792 TS + 82 Swift 通过；`TEST_RUNNER_ATRIUM_GALLERY_SHOTS=1 pnpm test:ios` 的 82 Swift + **4 XCUITest** 通过（0失败、0跳过），保留 26 张组件明暗/降级截图及6份性能附件。`pnpm ios:shot`、`pnpm ios:shot --dark` 均通过，确认使用现有跨worktree模拟器锁。`pnpm boundary` 未登记0/非精确0，但工具不扫描Swift，新增依赖已手工在 security.md 登记。

### 有界长帧定位（2026-10-26，继续第四路）

先保留现有夹具与预算，追加 Debug 观测：最长帧发生时间、主 runloop 的 afterWaiting→beforeWaiting 区间、真实行 body / builder 执行数。runloop 区间也不是单个主线程任务或CPU采样（包含多个回调、框架工作和调度影响），不能冒称50ms任务门槛通过。按初始尾行替换、重复 `.id`、每次增量 `scrollTo`、模拟器调度四个假设依次做单变量对比；先测后改，不通过延长预热或降低输出速度让结果好看。

归因首轮发现：180次更新中仅180次行body执行（Equatable有效），但两种容器均执行180000次row builder。峰值在1.7–2.2秒，排除纯初始定位；主runloop awake区间也有长区间。移除List重复`.id`的单变量试验未减少builder，还破坏`scrollTo`（尾行断言真实失败），已恢复。去掉XCUITest的label轮询、改为测量期间不查询AX树，也未消除长区间，不将它误报为根因。

下一项有界优化：在UI内部保持稳定的行引用集合，单行内容变动只更新该行的Observable值；插入/删除/重排才换集合。它不拥有协议同步语义，不改变外部`TimelineRow`值模型。先用Observation通知测试证明尾行变动不使整个集合失效，再用同夹具和尾行可见断言比较；若长帧仍在，保留未完成结论，不继续无边界扩大。

定向命令 `TEST_RUNNER_ATRIUM_TIMELINE_BENCH=1 pnpm test:ios`：不跑26张截图，只跑时间线三次对比、一次80ms忙等待负控与基础UI测试，仍使用已有模拟器锁。测量期间不再轮询AX树，测量结束后再读取结果；这只减少观测干扰，并未证明它是原长帧的根因。

以下为候选前的失败数据，全部保留。测试期间其他路在跑宿主变异，父代理报告load 24–40；本路16:14实测load 19.39/23.68/26.79、16:29为22.42/23.46/25.32、16:44为25.00/19.26/19.64。前面几轮没有逐轮记录load，**不拿这些时间数值定方案优劣**。各栏三项依试次顺序，均为Debug / iOS 26.5模拟器：

| 实验 | List最大帧间隔 / awake最大值（ms） | LazyVStack最大帧间隔 / awake最大值（ms） | 结论 |
|---|---|---|---|
| 加归因探针，夹具不变 | 216.31/145.99/158.97；186.21/116.45/179.25 | 254.51/258.99/533.56；230.36/237.38/513.08 | 两者180000 builder、180 body；峰值并非只在初始定位 |
| 仅去掉List `.id` | 560.84/2173.81/401.90；549.90/2170.83/387.93 | 233.91/190.55/901.88；213.87/174.23/991.19 | List仍180000 builder，但0 body、尾行不可达，UI测试失败；恢复 `.id` |
| 恢复 `.id`，停止测量期间AX轮询 | 168.62/326.58/284.18；490.09/300.37/276.41 | 163.68/236.48/2067.21；146.94/215.94/2042.09 | 长区间仍存在，不能把轮询当成已确认根因 |

原始附件在 `apps/ios/.build/timeline-{attribution,no-id,no-poll}/`。`timeline-projection/` 已写 INVALID.md：候选第一次因测试weak var警告未编译通过，临时导出命令误取前一轮xcresult，**它不是候选数据**；弱引用测试改为Swift 6.3支持的weak let后已通过。后续因资源协调停止绝对性能复跑。

### 稳定行引用候选与功能回归

- `TimelineRows` 只在插入/删除/重排时改变集合；内容更新只通知对应Row。`ObservedTimelineRow` 把value读取放在行body，而不是List的身份扫描闭包。保留`.equatable()`与必需的`.id`。
- 确定性Observation测试先看到整集合通知失败，再验证1000行里的180次尾更新只有180次行通知、0次集合通知；还覆盖相同快照、同数重排/替换、移除的ARC释放。**这不是候选实际row-builder次数，更不是耗时通过证明。**
- 小型真实UI测试先抓到仅`Task.yield`就定位的错误：初始尾行和新追加尾行不在视口。改为真实content/viewport几何变化后`scrollTo`，等高内容更新不再无意义定位。按住手指时延后布局，idle时补处理；真实拖动进入reading后不抢位置。按住不拖动的精确系统事件序列仍只测了纯状态时序，未在模拟器实证。
- UI用40行夹具，确认初始末行可见、同一末行增长30段后**回复末端**可见、追加新轮可见；向上读历史后追加，检查同一历史文本仍可见且y位置变化≤2pt、新尾不进入视口，再点按钮回底。手动负控强行在reading时`scrollTo`，测试真实失败于历史保持断言，恢复后通过。
- 定向Swift测试9项通过，`timeline-break-cases.json` **8/8 CAUGHT**；`pnpm ios:check`通过；最后非基准的`pnpm test:ios` **88 Swift + 3 UI通过，2个截图/性能opt-in跳过**。本轮未叠加全量TS测试。

候选仍需低负载复验真实builder次数和耗时，并保存测试前后`uptime`、构建模式与xcresult；最后仍要Release Instruments及真机。当前不能宣称180000个builder已在运行时消除，不能宣称50ms主线程门槛通过。这里只交付可审查候选和可重复的验证入口。

### 冻结基线280c087的独立审查修复

五条确认发现均已用真实组件/协议输入见红，再修复；不是把父会话的语言小探针当作全路径复现。另有围栏 metadata 疑点经独立期望断言确认为错误并修复。

| 项目 | 真实红灯 | 修复与回归 |
|---|---|---|
| Markdown UTF-8 缓存 | NFD→NFC 的28 B原文换为21 B新文，实际update在旧偏移处崩溃（signal 5）；加长尾部后双向规范等价替换均产生错块和旧字节。真实字节追加组合符还会无谓重建 | `utf8.starts(with:)` 判断精确前缀；双向替换、缩短越界、组合符字节追加，输出另按UTF-8核对。`b44d0a4` |
| 高亮 ASCII 边界 | 真实 `highlight(..., language: "javascript")` 的8组输入全部还原失败：`<`/`>`/引号后组合符、`&`后variation selector、emoji与嵌套模板span，以及 `const`后组合符残留HTML结束标签 | UTF-8扫描标签与实体，不按Character匹配；逐字节还原断言。`ade4c4e` |
| write 正文 | 实际协议JSON解码，args为空、正文只在 `details.write.content`，原轨道detail为nil | 保留多行正文及尾换行，不捏造字段。`7f9dc25` |
| 零count diff | 真 `git -c diff.context=0 diff --no-index` 得到 `-3,0 +4` 与 `-4 +3,0`；插入前gap原为2（应3）、后接第二hunk的旧/新起点分别错一行 | 零count的start是前一行，换成实际边界再计算缺口/下一起点；完整segments独立断言。`c5d7cc8` |
| overflow 压缩 | 已知/未知after两条协议输入，原详情都只有摘要，丢前后token信息 | 展开显示原始精确计数与完整摘要，未知after不显示/不填0；正常与overflow共用内容。`7f9dc25` |
| 附查：围栏闭合 metadata | 开/闭围栏各0–3格、引用内外共32组合，原实现12组误报false；`"   ```swift\nx\n```"`直接断言失败 | 用解析器source span与literal行数，容器边界排除引用外的新围栏；补引用外围栏、未闭合正文尾反引号和缩进代码字面反引号。32组合均绿。`874ba14`。**当前UI忽略closed，不是可见页面故障** |

最终定向 `swift test`（warnings-as-errors / explicit import-check）**48项、8套通过**，包含时间线和轨道结构守卫；`pnpm ios:check`通过。新增 `render-review-break-cases.json` **12/12 CAUGHT**，既有render **24/24**、rail **11/11**复跑全检出；没有NOBUILD/MISSED。原始红绿/崩溃/破坏日志留在 `apps/ios/.build/review-280c087/`，回归和负控随源码提交。Swift仍按MP1约定不用变异工具。

本轮未改入口、配对、工程接线、同步或时间线身份/滚动；DiffLayout/DiffView仅澄清版本匹配约束，没有补读实现，也未改变base diff语义。资源协调下未跑全量TS/完整iOS UI/截图/绝对性能对比，先前预算未通过结论不变；保留分支和worktree，未合并、未推送。

### 陈列页与限制

Debug `ATRIUM_GALLERY` 支持 colors/type/glass/status/cats/atoms/rail/markdown/diff，`timeline-list` / `timeline-stack` 是独立基准屏；`-reduced` / `-solid` 后缀只追加辅助功能降级，不改变系统偏好。正式 Release 没有入口。截图由 XCUITest 的 per-launch environment 产生；不要在尚未启动模拟器时用 `SIMCTL_CHILD_ATRIUM_GALLERY=... pnpm ios:shot`，这会把变量带入模拟器 launchd，后续启动仍继承旧值。

尚未齐全、不能宣称与定稿完全一致的部分：表格暂以 12 行收起，不是实测 640pt/贴底收起；行内代码是 attributed background，尚非 6pt 圆角；diff 每 hunk 横滑，尚非每文件统一横滑，协议缺失的上下文需上层读取回填；完整 diff 工具条/新步骤的逐帧自动验收/子代理车道未做。超 128 KiB 代码只保留无高亮原文，图片仅 alt、公式原文。当前组件不是完整对话页面，不实现连接与发送，也不标 MP5 / MP6 完成。
