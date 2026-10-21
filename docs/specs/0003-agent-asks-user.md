# SPEC-0003：agent 向你提问

- **状态**：已确认（界面与行为 2026-10-21 定，待实施）
- **创建**：2026-10-21
- **更新**：2026-10-21（位置选 A 卡片；序号选乙"序号即控件"；在输入框发消息算直接回复；只有不是 agent 开的会话有这个工具；不能只答一部分）
- **相关**：[路线图](../roadmap.md) M1.11 自用、[SPEC-0001](0001-mvp1-single-session-chat.md)"对话框""并行、同步与关注"、[SPEC-0002](0002-child-conversations.md)（`ask_parent`、"哪些会话有哪些工具"）、[ADR-0008](../adr/0008-atrium-own-pi-extension-for-fast.md)（Atrium 自带的 pi 扩展）、[ADR-0013](../adr/0013-agent-channel-status-and-hidden-command.md)（扩展与宿主的通道）、[design-language · 提问卡片](../architecture/design-language.md#输入框)、原型 `prototypes/agent-question-prototype.html`（四种位置）和 `prototypes/agent-question-card-prototype.html`（A 的细化）

## 背景与目标

agent 做到一半常遇到要你拍板的事（改到哪为止、选哪个库、叫什么名字）。现在它只能停下来写一段话问你，这一轮就结束了；你回一句，它再接着做。问题埋在回复里，选项要自己抄，几个问题混在一段话里容易漏答。

Claude Code 有 `AskUserQuestion`：agent 调用工具提出 1～4 个选择题，界面让你点选，答案作为工具结果交回，这一轮不断，接着做。pi 本身没有这样的工具（官方示例 `question.ts`、`questionnaire.ts` 用 `ctx.ui.custom` 画终端界面，RPC 模式下不可用）。

目标：Atrium 自带的扩展注册一个提问工具，形状对齐 Claude Code，界面上直接点选作答；等你回答的会话照现有的"待回答"状态进标签、侧栏和收件箱。

## 非目标

- 审批（工具调用前问你可不可以，MVP 2）、计划模式的批准。
- 用它要密码、Key 之类的敏感输入。
- 超时自动选默认值（agent 一直等，你停止它才结束）。
- 系统通知、声音提醒（关注状态沿用现有做法）。
- agent 开的子代理直接问你：它们照旧用 `ask_parent` 问主 agent（2026-10-21 定）。
- 只答一部分就提交（2026-10-21 定）。

## 需求

1. 当 agent 有几种合理做法拿不准时，我希望它把选项列出来让我点选，而不是猜或者停下这一轮。
2. 当它一次有几个问题，我希望一次答完、知道答到哪了、不漏答。
3. 当选项都不合适，我希望能写自己的回答，或者干脆直接回复一段话。
4. 当我在看别的会话，我希望知道哪个会话在等我回答（同现有"待回答"）。
5. 回头看对话时，我希望看得到它问了什么、我答了什么。

## 方案设计

### 工具

Atrium 自带扩展注册 `ask_user`，参数对齐 Claude Code 的 `AskUserQuestion`（模型对这个形状已经熟悉）：

- `questions`：1～4 个，每个：
  - `header`：短标签，最多 12 个字符，用作卡片上的标签、记录里的题名。
  - `question`：完整的问题，最多 1 000 字符。
  - `options`：2～4 个，每个 `label`（最多 60 字符）、`description`（这个选项意味着什么、代价是什么，最多 300 字符）、可选的 `preview`（Markdown，最多 4 000 字符；只有单选题能带，用来对比布局草图、代码片段、配置 diff）。
  - `multiSelect`：可以多选，默认 `false`。
- 每题自动带一个"其他"，可写自己的回答（最多 4 000 字符）。
- 扩展校验，不合格的直接返回给模型、不问你：题数、选项数不在范围内；`label` 是"其他""Other"或在同一题里重复；`header` 在同一组里重复；多选题带 `preview`；文字超过上面的上限。各上限不写进 schema，由扩展查（同 ADR-0013 第 9 条的做法），模型拿到的是写明哪一项、上限多少的错误。
- 推荐的选项排第一、`label` 末尾写"(Recommended)"或"（推荐）"，界面把这段去掉、换成"推荐"标记；记录和交回模型的答案里也去掉。
- `executionMode: "sequential"`：一个会话同一时刻最多一组问题。
- 工具说明照 Claude Code 的写（英文，同其他 Atrium 工具）：拿不准、有几种合理做法要用户定时用；不要用来问"这样可以吗"、不要要密码和 Key；推荐的放第一并标出；一次把相关的问题问完。
- 返回给模型（`content` 的文字由扩展写，`details` 给界面重建记录，见"接口与数据"）：
  - 答了：每题一行 `"<question>" = <答案>`，答案是选项的 `label`（多选用逗号连起来），"其他"写成 `Other: <文字>`。
  - 跳过：`The user skipped these questions. Continue with your best judgment, or ask in a different way.`
  - 直接回复：`The user did not pick an answer and replied directly; their message follows.`，你的消息随后作为插话送到（见"直接回复"）。
  - 停止或作废：工具以取消结束（pi 照常把被中止的工具记成出错）。

### 哪些会话有这个工具

- 只有**不是 agent 开的会话**有：主对话、对话、你手动开的子对话（`by: "user"`，你直接在和它说话）。**agent 开的子对话（`by: "agent"`）没有**，拿不准照旧用 `ask_parent` 问主 agent，由主 agent 决定要不要用 `ask_user` 问你（2026-10-21 定）。
- 做法同 SPEC-0002"哪些会话有哪些工具"：
  - 不带上下文的 agent 子对话：启动参数 `--exclude-tools` 加上 `ask_user`；只读角色的白名单（`--tools`）本来就不含它。
  - 带上下文的 agent 子对话：工具声明和父会话一样（为了命中缓存），由扩展在 `tool_call` 钩子里拦下，`work` 角色"放全部"也不放它；返回"这个子对话不能直接问用户，用 ask_parent 问主 agent"。
  - 宿主收到 `ask_user` 请求时照样按会话记录再查一遍，是 agent 开的就回 `ask_user_unavailable`。
- 交给终端的 pi 不加载 Atrium 的扩展，没有这个工具；扩展在非 RPC 模式（`ctx.mode !== "rpc"`）下也直接返回错误，不挂起。

### 生命周期

- 工具执行时经 ADR-0013 的通道问宿主：`call`，`op: "ask_user"`，请求 id 是工具调用的 id。宿主把问题放进会话控制状态的 `question`，推 `control_updated`；你答了，宿主用隐藏命令 `reply` 交回扩展，工具返回。
- 一直等，不设超时，运行计时照走。
- 结束的几种情况：
  - **你答了、跳过了、直接回复了**：见"作答""直接回复"。
  - **你点停止**：pi 中止工具的 `signal`，扩展结束工具并发 `note cancel`，宿主清掉 `question`。
  - **pi 退出或崩溃、宿主重启**：问题作废（ADR-0013 第 5 条），工具调用随进程没了；重启后续做的规则同 SPEC-0001"失败与重启"。
  - **归档、交给终端**：会话已经在跑，交给终端照旧应答 `session_busy`；归档停掉 pi，问题作废。
- 等你回答时会话的 `asking` 是问题出现的时间：标签、侧栏、收件箱显示"待回答"（问号圆圈、`--attn`），同 extension 对话框；问题结束就清掉。有问题的会话不回收进程（同对话框）。
- 多个窗口同时答，只接受第一个；其余的、对已结束的问题的回答应答 `question_closed`。
- 问题和回答是工具调用和结果，写在 pi 的会话文件里，重建对话记录后仍在（和 extension 对话框只在宿主存活期间保留不同）。

### 作答

- 单选、多选从形状上分开：单选的序号是圆，多选的是圆角方（"界面"的序号乙）。题目后面一个小标签写"单选"，或"多选"加已选几项（"多选 · 已选 2"）。
- 单选：点一下或按 1～5 选中（最后一个是"其他"）；多题时选完 0.2 秒后自动到下一道没答的题，都答了就停在原地等你提交。多选：点、按数字或空格勾选和取消，按 ⏎ 或"下一题"继续。↑↓ 移动当前行，Tab / ⇧Tab 换题。底部的键盘提示跟着变（单选"1–N 选择 · ⏎ 下一题 / 确定"，多选"1–N 勾选 · 空格 勾选当前行 · ⏎ 下一题 / 确定"）。快捷键只在焦点不在输入框里时生效。
- 选"其他"时，那一行下面出现一个多行输入框：铺满这一行，左边和选项文字对齐，至少两行高，随内容长高，最多约六行，再多在框里滚动；选中后焦点直接进去。框里 ⏎ 确定（都答了就提交，否则到下一题），⇧⏎ 换行；输入框下方右对齐写这两个键。数字键只用来选择，不会打进输入框。"其他"选中但没写字，这一题不算答了。
- **全部答完才能提交**（2026-10-21 定）：没答完时"提交回答"不可用；答不了的题用"其他"说明。"跳过"一次跳过整组。
- 未提交的选择按会话保存在页面里，切会话、切标签回来还在；不落盘，不跨窗口同步。另一个窗口先答了，这边的卡片随 `control_updated` 消失。

### 直接回复

等你回答时输入框照常可用，占位文字是"直接回复也行：发出后代替回答，agent 接着做"。**在输入框发出的消息代替回答**（2026-10-21 定）：

- 回车和 ⌘+回车一样：宿主先用 `reply` 结束问题（结果是"直接回复"），再把这条消息作为插话（`steer`）发给 pi。工具一返回，这批工具调用就做完了，插话在模型下一次请求前送到，所以 agent 在同一轮里接着做，看到的是工具结果后紧跟你的消息。图片、`@` 文件、长粘贴照常带上（走插话本来的路，不塞进工具结果）。
- 排队里已经有的消息不受影响，仍等这一轮结束。
- `/` 命令（内置、扩展、模板、skill）不算回复，照它们本来的规则处理，问题保持。
- 宿主先确认问题还开着再结束它：同时有别的窗口提交了回答，回答算数，这条消息照普通的运行中输入处理（插话照插话，排队照排队）。

### 对话记录

- 过程轨道上提问是一步，节点 `--attn`：等你时"正在问你 · N 个问题"（节点外一圈慢慢扩散的光环，文字 `--attn-text`）；结束后"问了你 N 个问题""你跳过了这 N 个问题""你没选，直接回复了"或"问题已取消"（停止、作废）。
- 答了的下面常显每题一行"题名 · 你的回答"（题名 `--text-dim`，答案 `--text-2`；多选用顿号连，"其他"写成"其他：“文字”"），不用点开。直接回复的不另写：你的消息紧接着作为插话出现在轨道上（"你插话 · 内容"），不重复。点这一步展开详情块，看完整问题和所有选项（选中的打勾）。
- 等你回答时，这一轮标题行的小猫换成 18px 问号圆圈（`--attn`），文字"等你回答 · 0:42"（`--attn-text`，计时等宽）。问题结束换回小猫和"进行中"。
- 一轮跑完折叠后，标题行摘要加"问了你 N 个问题"，和"改了 N 个文件"同样的灰字。
- 复制成 Markdown、导出时这一步写成一段引用：问题和你的回答。
- 宿主从会话文件重建时，从工具调用的参数和结果的 `details` 读出这一步；`details` 读不出（旧版本、被截断）时退回普通工具步骤的样子。

### 界面

2026-10-21 定了 A"卡片"（原型 `prototypes/agent-question-prototype.html` 的 A；B 接管输入框、C 对话流里、D 居中面板没选）。同日细化，序号选乙"序号即控件"（原型 `prototypes/agent-question-card-prototype.html` 的乙；甲 控件加键位、丙 轻序号没选），"其他"的输入框改成多行。尺寸、颜色、动效见 [design-language · 提问卡片](../architecture/design-language.md#输入框)。

- 位置：消息流底部、输入框上方的卡片，宽度同输入框，沿用现有 extension 对话框卡片的位置；有对话框卡片时提问卡片在它们下面、紧挨输入框。排队、子对话的胶囊条在卡片上方。
- 顶上一行：橙色问号加"agent 在问你"，多题时接"· 已答 N / M"；右边是各题题名的胶囊标签，当前题高亮，答完的打勾，点了换题。
- 问题、单选 / 多选标签，下面是选项行：序号（单选圆、多选圆角方）、选项名和"推荐"、说明；最后一行"其他"。带预览的题左边选项、右边预览（悬停或键盘移到哪个选项就预览哪个，没有就预览选中的、再没有就第一个）。
- 底部：左边键盘提示，右边"跳过""下一题"（多题、还有没答的才有）、"提交回答"。
- 卡片太高时（题多、带预览），卡片最高到对话区高度的 60%，选项在卡片里滚动，顶上一行和底部按钮不动。

## 接口与数据

### 扩展与宿主（ADR-0013 的通道）

- `call`，`op: "ask_user"`，请求 id 是工具调用的 id，`args` 是校验过的工具参数。`packages/pi` 的信封 schema 加这个 `op`。
- 宿主的 `reply`：`result` 是 `{ outcome: "answered", answers }`、`{ outcome: "skipped" }` 或 `{ outcome: "reply" }`；`answers` 同下文 `answer_question` 的。错误 `{ ok: false, code: "ask_user_unavailable" }`（agent 开的子对话）、`agent_bad_request`（同一会话已经有一组问题，不应发生，`executionMode` 已串行）。
- 扩展收到 `reply` 后回 `note answered`（同 `ask_parent`），宿主收到才算这次回答交到了，之后才发直接回复的插话；10 秒收不到就按 ADR-0013 第 7 条发 `cancel`，扩展回 `answered` 照常、回 `closed` 时这次回答作废，界面在卡片上方说"回答没送到 agent，问题已结束"（`question_lost`）。
- 你停下运行：扩展发 `note cancel`，宿主清掉问题。
- 日志只记 `op`、请求 id、题数、结果（`answered` / `skipped` / `reply` / `cancelled`）、耗时，不记问题、选项和回答的文字。

### 协议

- `Control.question: PendingQuestion | null`（`IDLE_CONTROL` 里是 `null`）：
  - `PendingQuestion`：`{ id, askedAt, questions }`，`id` 是工具调用的 id，`askedAt` 是宿主收到的时间。
  - `questions[]`：`{ header, question, multiSelect, options }`；`options[]`：`{ label, description, preview: string | null, recommended: boolean }`，`label` 已去掉"(Recommended)" / "（推荐）"（`packages/pi` 解析时做）。
- 命令 `answer_question(sessionId, questionId, answer)`：
  - `answer` 是 `{ answers }` 或 `{ skipped: true }`。`answers[]` 与 `questions` 一一对应：`{ selected: number[], other: string | null }`，`selected` 是选项的下标，`other` 是"其他"的文字。
  - 宿主校验：题数对得上；单选恰好一项（一个下标，或只有 `other`）；多选至少一项；下标在范围内、不重复；`other` 去掉首尾空白后非空、最多 4 000 字符。不合格应答 `question_invalid`（`params.index` 是第几题）。
  - 问题已经结束（答过、跳过、直接回复、停止、作废）或 id 对不上，应答 `question_closed`。
  - 应答 `{}`；问题结束随 `control_updated` 推出。
- `prompt` / `steer` 在 `control.question` 不为空、消息不是 `/` 命令时，按"直接回复"处理：先结束问题，再按插话发出，应答同 `steer`。
- `SessionSummary.asking`：取未回答对话框和 `question` 里最早出现的时间。
- 对话记录：`ToolDetails` 加 `{ tool: "ask_user", questions, outcome }`，`questions` 同 `PendingQuestion` 的；`outcome` 是 `{ kind: "answered", answers }`、`{ kind: "skipped" }`、`{ kind: "reply" }` 或 `null`（被取消、还在等）。宿主从工具结果的 `details` 读，实时与重建一样。
- 错误码新增 `question_closed`、`question_invalid`、`question_lost`。协议版本加一。

### 工具结果的 `details`

扩展写进会话文件：`{ v: 1, questions, outcome }`，形状同上（`questions` 是去掉推荐标记后的）。`packages/pi` 解析时校验，读不出就当没有 `details`。

### 界面状态

- 未提交的作答按会话 id 和问题 id 存在 UI 的内存里（每题选了哪些、"其他"的文字、当前题），问题结束或换了问题就丢掉。

## 备选方案

- **只靠 extension 对话框（`ctx.ui.select`）**：一次只能一题、选项只有文字，没有说明、多选和"其他"。不够用。
- **用第三方 pi 扩展（如 `pi-ask-user-question`）**：画的是终端界面，RPC 下用不了，还是要 Atrium 自己接界面。
- **直接回复的文字塞进工具结果**：图片、`@` 文件、skill 都带不进去，还要另做一套；用插话送到，模型看到的顺序一样（工具结果后紧跟你的消息）。
- **界面的位置 B / C / D**：见原型 `agent-question-prototype.html`。B 等待时不能往排队加消息；C 要滚到它那里答、题多时一轮很长；D 挡住对话、小问题也弹面板太重。
- **序号甲 / 丙**：甲（标准控件加行尾键位）多一列；丙（轻序号）单选没选时看不出能点。

## 风险与待定问题

- [x] 1. 界面的位置：A 卡片（2026-10-21 定）。
- [x] 1a. 序号的样式：乙"序号即控件"（2026-10-21 定）。
- [x] 2. 等你回答时在输入框发消息：算直接回复，代替回答（2026-10-21 定）。
- [x] 3. 子代理：agent 开的子对话没有这个工具，照旧用 `ask_parent` 问主 agent（2026-10-21 定）。你手动开的子对话不是子代理，有这个工具。
- [x] 4. 只答一部分就提交：不能（2026-10-21 定）。
- [ ] 5. 实施前用契约测试实测：挂着的工具被 `abort` 后，pi 把它记成什么结果；工具返回后紧跟的插话确实在模型下一次请求前送到。结果写进 pi-internals。

## 实施计划

按 development.md 的标准流程，测试先行：

1. `protocol`：`PendingQuestion`、`Control.question`、`answer_question`、`ToolDetails` 的 `ask_user`、新错误码，协议版本加一。
2. `pi`：扩展注册 `ask_user`（参数、校验、说明、`details`、`signal` 取消、非 RPC 模式报错）；`tool_call` 钩子在 agent 子对话里拦它；信封 `op`；解析工具结果的 `details`；契约测试与夹具（`ask-user`）。
3. `host`：SessionController 收 `ask_user` 请求、放进 `control.question`、`answer_question`、直接回复（先结束、等确认、再插话）、停止和作废、`asking`；会话启动参数给 agent 子对话加 `--exclude-tools ask_user`；对话记录投影 `ask_user` 步骤。
4. `client`：会话视图带上 `question`，`answerQuestion`。
5. `ui`：提问卡片（序号乙、单选多选、"其他"多行框、预览、键盘）、过程轨道的提问步骤和记录、标题行"等你回答"、折叠摘要、输入框占位文字、复制成 Markdown。
6. 文档：pi-internals（契约实测）、coverage-map 登记。

## 验证

- 单元：参数校验（每条拒绝规则）、去推荐标记、`answer_question` 的每条校验、`details` 解析、交回模型的文字。
- 宿主：答了 / 跳过 / 直接回复 / 停止 / pi 崩溃 / 归档各一条；两个客户端同时答只认第一个；直接回复与另一窗口的回答竞争；回答确认超时；agent 子对话调用得到 `ask_user_unavailable`；`asking` 的起止。
- pi 契约：真实 pi 里工具挂着时宿主回答、这一轮接着跑；`abort` 中止；工具返回后插话送到的顺序；带上下文的 agent 子对话里被钩子拦下。
- 界面（浏览器组件测试）：单选点选和自动下一题、多选勾选取消和计数、"其他"展开多行框并聚焦、数字键不进输入框、没答完提交不可用、跳过、切会话回来选择还在、另一窗口答了卡片消失、重建后的记录、明暗截图。
- 端到端：faux 模型调用 `ask_user`，在 Electron 里点选提交，模型收到答案接着回复；输入框直接回复，模型在同一轮看到你的消息。
- 泄漏：问题挂着时停止、归档 200 次，宿主的等待和监听回到基线；卡片反复出现消失不留脱离的 DOM。
