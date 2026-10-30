import AtriumProtocol
import Foundation

/// Turns a turn's steps into the rows of its process rail.
///
/// - Remark: Mirrors the desktop's `layoutTurn`, `stepNode` and `describeStep`
///   (`packages/ui/src/chat/turn-layout.ts`, `steps.tsx`) so both sides tell the same story:
///   - the last visible text is the reply, under the rail, not a row; blank thinking and text are
///     left out; compactions after the reply stay rows;
///   - two or more read-only calls in a row (`read`, `grep`, `find`, `ls`) fold into one
///     "探索了代码库" row with a magnifier; a single one keeps its own row;
///   - a failed call is a dead end, a steer or the main agent's words a branch, the agent's
///     questions an orange dot, a compaction two ticks, text said mid-turn a larger accent dot;
///   - while the turn runs, a running call, or the last row when it is thinking or text, is live.
///   Not yet on the phone: the children's lanes (SPEC-0002), so a child's events come as plain
///   rows; other tools show their name without their arguments.
nonisolated enum RailRows {
  /// Tools that only look around.
  static let exploreTools: Set<String> = ["read", "grep", "find", "ls"]

  /// The rows of a turn's process, and the text that answers it.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter turn: The turn.
  /// - Returns: The rows, and the reply's text if the turn ended on one.
  static func layout(_ turn: Turn) -> (rows: [RailRow], reply: String?) {
    let visible = turn.steps.filter { step in
      switch step {
      case .thinking(let thinking): !thinking.text.allSatisfy(\.isWhitespace)
      case .text(let text): !text.text.allSatisfy(\.isWhitespace)
      default: true
      }
    }
    let lastIndex = visible.lastIndex { if case .compaction = $0 { false } else { true } }
    var replyIndex: Int?
    var reply: String?
    if let lastIndex, case .text(let text) = visible[lastIndex] {
      replyIndex = lastIndex
      reply = text.text
    }
    let running = turn.outcome == .running
    var rows: [RailRow] = []
    var group: [Step.Tool] = []
    /// Ends a run of read-only calls.
    ///
    /// - Remark: One call keeps its own row; more fold into one.
    /// - SideEffects: Appends to `rows` and empties `group`.
    func flush() {
      if group.count == 1, let only = group.first {
        rows.append(toolRow(only))
      } else if let first = group.first {
        rows.append(exploreRow(group, id: first.id))
      }
      group = []
    }
    for (index, step) in visible.enumerated() where index != replyIndex {
      if case .tool(let tool) = step, exploreTools.contains(tool.tool) {
        group.append(tool)
        continue
      }
      flush()
      rows += self.rows(of: step)
    }
    flush()
    if running, let last = rows.indices.last, rows[last].node == .dot || rows[last].node == .said,
      let lastStep = turn.steps.last, stepID(lastStep) == rows[last].id, isThought(lastStep)
    {
      rows[last] = live(rows[last], step: lastStep)
    }
    return (rows, reply)
  }

  /// The rows one step makes: usually one; a report of a child's events one per event.
  ///
  /// - Remark: See `layout(_:)`.
  /// - SideEffects: none
  /// - Parameter step: The step.
  /// - Returns: The rows.
  private static func rows(of step: Step) -> [RailRow] {
    switch step {
    case .thinking(let thinking):
      let verb = thinking.durationMs.map { "思考了 \(max(1, Int(($0 + 500) / 1000))) 秒" } ?? "思考过程"
      return [RailRow(id: thinking.id, node: .dot, verb: verb, object: opening(thinking.text), detail: thinking.text)]
    case .text(let text):
      return [RailRow(id: text.id, node: .said, verb: "说明", object: opening(text.text), detail: text.text)]
    case .tool(let tool):
      return [toolRow(tool)] + agentEvents(tool)
    case .steer(let steer):
      return [RailRow(id: steer.id, node: .steer, verb: "你插话", object: steer.text, detail: steer.text)]
    case .agent(let agent):
      switch agent.source {
      case .task(let task):
        return [RailRow(id: agent.id, node: .steer, verb: "主 agent 插话", object: opening(task.text), detail: task.text)]
      case .report(let report):
        return report.events.enumerated().map { index, event in eventRow(event, id: "\(agent.id):\(index)") }
      }
    case .retry(let retry):
      let limit = retry.maxAttempts.map { " / \($0)" } ?? ""
      return [RailRow(id: retry.id, node: .dot, verb: "自动重试 · 第 \(retry.attempt)\(limit) 次", object: retry.error)]
    case .compaction(let compaction):
      let after = compaction.tokensAfter.map { " · 压缩后 \($0) tokens" } ?? ""
      let counts = "压缩前 \(compaction.tokensBefore) tokens" + after
      let detail = counts + (compaction.summary.isEmpty ? "" : "\n\n" + compaction.summary)
      if compaction.reason == .overflow {
        return [RailRow(id: compaction.id, node: .compaction, verb: "上下文超出窗口，已压缩", detail: detail)]
      }
      let before = formatTokens(compaction.tokensBefore)
      let object = compaction.tokensAfter.map { "\(before) → \(formatTokens($0))" } ?? "压缩前 \(before)"
      return [RailRow(id: compaction.id, node: .compaction, verb: "压缩了上下文", object: object, detail: detail)]
    }
  }

  /// A tool call's row, retaining plain-text details and question answers.
  ///
  /// - Remark: Summary labels must not replace the original content.
  /// - SideEffects: none
  /// - Parameter tool: The protocol call.
  /// - Returns: The row with its disclosure content.
  private static func toolRow(_ tool: Step.Tool) -> RailRow {
    var row = toolSummary(tool)
    var parts: [String] = []
    if !tool.args.isEmpty {
      let encoder = JSONEncoder()
      encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
      if let data = try? encoder.encode(tool.args) { parts.append(String(decoding: data, as: UTF8.self)) }
    }
    if case .edit(let edit) = tool.details, let diff = edit.diff { parts.append(diff) }
    if case .write(let write) = tool.details { parts.append(write.content) }
    if case .askUser(let ask) = tool.details {
      let answers: [QuestionAnswer]
      if tool.status == .done, case .answered(let answered) = ask.outcome {
        answers = answered.answers
      } else {
        answers = []
      }
      parts += ask.questions.enumerated().map { index, question in
        let answer = answers.indices.contains(index) ? answers[index] : nil
        if let answer {
          let labels = answer.selected.compactMap { selected in
            question.options.indices.contains(selected) ? question.options[selected].label : nil
          }
          let other = answer.other.map { "其他：“\($0)”" }
          row.answers.append(question.header + " · " + (labels + [other].compactMap(\.self)).joined(separator: "、"))
        }
        return
          ([question.header, question.question]
          + question.options.enumerated().map { optionIndex, option in
            let label = (answer?.selected.contains(optionIndex) == true ? "✓ " : "") + option.label
            return [label, option.description, option.preview].compactMap(\.self).joined(separator: "\n")
          }).joined(separator: "\n")
      }
    }
    if let output = tool.output, !output.isEmpty { parts.append(output) }
    row.detail = parts.isEmpty ? nil : parts.joined(separator: "\n\n")
    row.partialSteps = tool.partial ? [tool.id] : []
    return row
  }

  /// A tool call's summary.
  ///
  /// - Remark: The verb says "正在…" while it runs and turns past once it ended; a command that
  ///   succeeded "通过", an edit its counts, a failure "失败", an unfinished call "未完成".
  /// - SideEffects: none
  /// - Parameter tool: The call.
  /// - Returns: The row.
  private static func toolSummary(_ tool: Step.Tool) -> RailRow {
    let running = tool.status == .running
    let failedEnd: String? =
      switch tool.status {
      case .failed: "失败"
      case .unfinished: "未完成"
      default: nil
      }
    var node: RailRow.Node = running ? .live : tool.status == .failed ? .dead : .dot
    let tone: RailRow.EndTone = tool.status == .failed ? .bad : .quiet
    let verbs: (String, String)
    switch tool.details {
    case .askUser(let ask):
      node = running ? .asking : tool.status == .done ? .ask : .dot
      return questionsRow(tool, ask: ask, node: node)
    case .bash(let bash):
      verbs = ("正在运行", "运行了")
      return RailRow(
        id: tool.id, node: node, verb: running ? verbs.0 : verbs.1, object: bash.command, objectIsCode: true,
        end: tool.status == .done ? "通过" : failedEnd, endTone: tone)
    case .read(let read):
      let range = read.offset.map { " 第 \($0) 行起" } ?? ""
      return RailRow(
        id: tool.id, node: node, verb: running ? "正在读" : "读了", object: read.path + range, end: failedEnd,
        endTone: tone)
    case .edit(let edit):
      let done = tool.status == .done && edit.diff != nil
      return RailRow(
        id: tool.id, node: node, verb: running ? "正在编辑" : "编辑了", object: edit.path,
        end: done ? "+\(edit.added) −\(edit.removed)" : failedEnd,
        endTone: done ? .counts(added: edit.added, removed: edit.removed) : tone)
    case .write(let write):
      return RailRow(
        id: tool.id, node: node, verb: running ? "正在写入" : "写入了", object: write.path, end: failedEnd,
        endTone: tone)
    case .agent, nil:
      let agentVerbs = agentToolVerbs[tool.tool]
      let verb = agentVerbs.map { running ? $0.0 : $0.1 } ?? tool.tool
      return RailRow(id: tool.id, node: node, verb: verb, end: failedEnd, endTone: tone)
    }
  }

  /// The verbs of the tools the main agent uses with its children (desktop `AGENT_TOOL_VERBS`).
  private static let agentToolVerbs: [String: (String, String)] = [
    "agent_spawn": ("正在开子对话", "开子对话"),
    "agent_send": ("正在交代子对话", "交代了子对话"),
    "agent_wait": ("等子对话", "等了子对话"),
    "agent_reply": ("正在回答", "回答了"),
    "agent_list": ("正在列出子对话", "列出了子对话"),
    "agent_read": ("正在读子对话", "读了子对话"),
    "agent_stop": ("正在停下子对话", "停下了子对话"),
    "agent_models": ("正在列出模型", "列出了模型"),
    "report_progress": ("汇报进度", "汇报了进度"),
    "ask_parent": ("在问主 agent", "问了主 agent"),
  ]

  /// The row of the agent's questions to you (SPEC-0003, "对话记录").
  ///
  /// - Remark: "正在问你 · N 个问题" while it waits, then how it ended.
  /// - SideEffects: none
  /// - Parameters:
  ///   - tool: The call.
  ///   - ask: Its questions and outcome.
  ///   - node: The node.
  /// - Returns: The row.
  private static func questionsRow(_ tool: Step.Tool, ask: ToolDetails.AskUser, node: RailRow.Node) -> RailRow {
    let count = ask.questions.count
    if tool.status == .running {
      return RailRow(id: tool.id, node: node, verb: "正在问你", object: "\(count) 个问题")
    }
    switch tool.status == .done ? ask.outcome : nil {
    case .answered: return RailRow(id: tool.id, node: node, verb: "问了你", object: "\(count) 个问题")
    case .skipped:
      return RailRow(id: tool.id, node: node, verb: "你跳过了", object: count == 1 ? "这个问题" : "这 \(count) 个问题")
    case .reply: return RailRow(id: tool.id, node: node, verb: "你没选，直接回复了")
    case nil: return RailRow(id: tool.id, node: node, verb: "问题已取消")
    }
  }

  /// The row of read-only calls folded together: "探索了代码库 · 读了 7 个文件，搜索了 2 次".
  ///
  /// - Remark: "正在探索代码库" while any of them runs.
  /// - SideEffects: none
  /// - Parameters:
  ///   - tools: The calls.
  ///   - id: The first call's id.
  /// - Returns: The row.
  private static func exploreRow(_ tools: [Step.Tool], id: String) -> RailRow {
    let reads = tools.filter { $0.tool == "read" }.count
    let searches = tools.count - reads
    let parts = [reads > 0 ? "读了 \(reads) 个文件" : nil, searches > 0 ? "搜索了 \(searches) 次" : nil]
    let live = tools.contains { $0.status == .running }
    var row = RailRow(
      id: id, node: .search, verb: live ? "正在探索代码库" : "探索了代码库",
      object: parts.compactMap(\.self).joined(separator: "，"),
      detail: tools.map { tool in
        let row = toolRow(tool)
        let title = [row.verb, row.object, row.end].compactMap(\.self).filter { !$0.isEmpty }.joined(separator: " · ")
        return [title, row.detail].compactMap(\.self).joined(separator: "\n")
      }.joined(separator: "\n\n"))
    row.partialSteps = tools.filter(\.partial).map(\.id)
    return row
  }

  /// Rows for the events a child's tool call brought back.
  ///
  /// - Remark: Without lanes yet, each is a plain row.
  /// - SideEffects: none
  /// - Parameter tool: The call.
  /// - Returns: The rows.
  private static func agentEvents(_ tool: Step.Tool) -> [RailRow] {
    guard case .agent(let agent) = tool.details else { return [] }
    return agent.events.enumerated().map { index, event in eventRow(event, id: "\(tool.id):\(index)") }
  }

  /// A child's event as a row: "子对话「名字」完成".
  ///
  /// - Remark: The desktop's `EVENT_WORDS`.
  /// - SideEffects: none
  /// - Parameters:
  ///   - event: The event.
  ///   - id: The row's id.
  /// - Returns: The row.
  private static func eventRow(_ event: AgentNoticeEvent, id: String) -> RailRow {
    let words: String =
      switch event.event {
      case .finished: "完成"
      case .failed: "出错"
      case .question: "在问"
      case .needsYou: "在等你"
      case .stopped: "已停下"
      case .ended: "已结束"
      }
    return RailRow(id: id, node: .dot, verb: "子对话「\(event.title)」\(words)", object: event.question ?? "")
  }

  /// Marks the last row live while its thinking or text still streams.
  ///
  /// - Remark: A thought going on reads "思考中".
  /// - SideEffects: none
  /// - Parameters:
  ///   - row: The row.
  ///   - step: Its step.
  /// - Returns: The live row.
  private static func live(_ row: RailRow, step: Step) -> RailRow {
    RailRow(
      id: row.id, node: .live, verb: isThinking(step) ? "思考中" : row.verb, object: row.object,
      detail: row.detail)
  }

  /// Tells whether a step is thinking or text, the steps that stream into one row.
  ///
  /// - Remark: Tools say themselves whether they run.
  /// - SideEffects: none
  /// - Parameter step: The step.
  /// - Returns: Whether it streams.
  private static func isThought(_ step: Step) -> Bool {
    switch step {
    case .thinking, .text: true
    default: false
    }
  }

  /// Tells whether a step is thinking.
  ///
  /// - Remark: For the live verb.
  /// - SideEffects: none
  /// - Parameter step: The step.
  /// - Returns: Whether it is.
  private static func isThinking(_ step: Step) -> Bool {
    if case .thinking = step { return true }
    return false
  }

  /// A step's id.
  ///
  /// - Remark: Every kind has one.
  /// - SideEffects: none
  /// - Parameter step: The step.
  /// - Returns: The id.
  private static func stepID(_ step: Step) -> String {
    switch step {
    case .thinking(let value): value.id
    case .text(let value): value.id
    case .tool(let value): value.id
    case .steer(let value): value.id
    case .agent(let value): value.id
    case .retry(let value): value.id
    case .compaction(let value): value.id
    }
  }

  /// The folded header's words after "用时 …": "读了 3 个文件 · 跑了 2 条命令".
  ///
  /// - Remark: The desktop's `countProcess` and `processParts`: only what happened, in a fixed
  ///   order; a failed command in words ("N 条命令没走通"), not red; compactions last.
  /// - SideEffects: none
  /// - Parameter turn: The turn.
  /// - Returns: The parts.
  static func summary(_ turn: Turn) -> [String] {
    var reads = 0
    var searches = 0
    var commands = 0
    var failed = 0
    var compactions = 0
    var questions = 0
    for step in turn.steps {
      if case .compaction = step { compactions += 1 }
      guard case .tool(let tool) = step else { continue }
      if case .askUser(let ask) = tool.details { questions += ask.questions.count }
      if tool.tool == "read" {
        reads += 1
      } else if exploreTools.contains(tool.tool) {
        searches += 1
      } else if tool.tool == "bash" {
        commands += 1
        if tool.status == .failed { failed += 1 }
      }
    }
    let parts: [(Int, String)] = [
      (reads, "读了 \(reads) 个文件"), (searches, "搜索了 \(searches) 次"), (commands, "跑了 \(commands) 条命令"),
      (turn.changes.count, "改了 \(turn.changes.count) 个文件"), (questions, "问了你 \(questions) 个问题"),
      (failed, "\(failed) 条命令没走通"), (compactions, "压缩了 \(compactions) 次上下文"),
    ]
    return parts.filter { $0.0 > 0 }.map(\.1)
  }

  /// How long something took, in words: "48 秒", "2 分 13 秒".
  ///
  /// - Remark: The desktop's `formatDuration`; under a second says so rather than "0 秒".
  /// - SideEffects: none
  /// - Parameter ms: Milliseconds.
  /// - Returns: The words.
  static func formatDuration(_ ms: Int) -> String {
    if ms < 1000 { return "不到 1 秒" }
    let seconds = ms / 1000
    if seconds < 60 { return "\(seconds) 秒" }
    let minutes = seconds / 60
    if minutes < 60 { return "\(minutes) 分 \(seconds % 60) 秒" }
    return "\(minutes / 60) 小时 \(minutes % 60) 分"
  }

  /// The first line of a text, shortened to what a row shows.
  ///
  /// - Remark: The desktop's `opening`: the whole first line with spaces collapsed, "…" when cut
  ///   or when more lines follow.
  /// - SideEffects: none
  /// - Parameters:
  ///   - text: The text.
  ///   - max: The most characters to keep.
  /// - Returns: The opening.
  static func opening(_ text: String, max: Int = 160) -> String {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let firstLine = trimmed.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
    let line = (firstLine.first.map(String.init) ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ")
    if line.count > max { return String(line.prefix(max)) + "…" }
    return firstLine.count > 1 ? line + "…" : line
  }

  /// A token count, short: "152K", "1.3M".
  ///
  /// - Remark: The desktop's `formatTokens`.
  /// - SideEffects: none
  /// - Parameter tokens: The count.
  /// - Returns: The text.
  static func formatTokens(_ tokens: Int) -> String {
    if tokens < 1000 { return String(tokens) }
    let (value, unit) = tokens < 1_000_000 ? (Double(tokens) / 1000, "K") : (Double(tokens) / 1_000_000, "M")
    if value >= 100 { return "\(Int(value.rounded()))\(unit)" }
    let tenths = (value * 10).rounded() / 10
    return tenths == tenths.rounded() ? "\(Int(tenths))\(unit)" : "\(tenths)\(unit)"
  }
}
