#if DEBUG
  import AtriumProtocol
  import Testing

  @testable import AtriumUI

  /// Regression cases for the content behind the rail's one-line summaries.
  ///
  /// - Remark: Uses the protocol's actual steps and question answers, not UI-only fixtures.
  @Suite("Process rail details")
  struct RailDetailTests {
    /// Keeps streaming and completed prose intact.
    ///
    /// - Remark: An opening is only a preview, not the stored content.
    /// - SideEffects: none
    @Test("retains full thinking and intermediate text")
    func prose() {
      var turn = SampleTurns.turn([], outcome: "running")
      turn.steps = [.thinking(.init(id: "thought", text: "首行\n第二行", durationMs: nil))]
      #expect(RailRows.layout(turn).rows.first?.detail == "首行\n第二行")
      turn.steps = [
        .text(.init(id: "text", text: "说明\n完整说明")),
        .tool(tool("command", "bash", output: "第一行\n第二行")),
      ]
      let rows = RailRows.layout(turn).rows
      #expect(rows[0].detail == "说明\n完整说明")
      #expect(rows[1].detail == "第一行\n第二行")
    }

    /// Keeps each read/search and its output in a grouped exploration.
    ///
    /// - Remark: Grouping must not erase the steps that produced its counts.
    /// - SideEffects: none
    @Test("retains exploration step text and output")
    func exploration() {
      var turn = SampleTurns.turn([])
      var read = tool("read", "read", output: "file content")
      read.details = .read(.init(path: "src/main.swift", offset: nil, limit: nil))
      var search = tool("search", "grep", output: "match line")
      search.args = ["pattern": .string("needle")]
      turn.steps = [.tool(read), .tool(search)]
      let row = RailRows.layout(turn).rows[0]
      #expect(row.detail?.contains("src/main.swift") == true)
      #expect(row.detail?.contains("file content") == true)
      #expect(row.detail?.contains("grep") == true)
      #expect(row.detail?.contains("needle") == true)
      #expect(row.detail?.contains("match line") == true)
    }

    /// Shows every question's selected labels and free-text answer.
    ///
    /// - Remark: Answers are outside the optional detail disclosure.
    /// - SideEffects: none
    @Test("retains question text, options, previews and every answer")
    func questions() {
      var turn = SampleTurns.turn([])
      var ask = tool("ask", "ask_user", output: nil)
      let options = [
        QuestionOption(label: "甲", description: "方案甲", preview: "预览\n原文", recommended: true),
        QuestionOption(label: "乙", description: "方案乙", preview: nil, recommended: false),
      ]
      ask.details = .askUser(
        .init(
          questions: [
            .init(header: "选择", question: "用哪个方案？", multiSelect: true, options: options),
            .init(header: "补充", question: "还有什么？", multiSelect: false, options: options),
          ],
          outcome: .answered(
            .init(answers: [
              .init(selected: [0, 1], other: "补充\n文字"),
              .init(selected: [], other: "保留现状"),
            ]))))
      turn.steps = [.tool(ask)]
      let row = RailRows.layout(turn).rows[0]
      #expect(row.answers == ["选择 · 甲、乙、其他：“补充\n文字”", "补充 · 其他：“保留现状”"])
      #expect(row.detail?.contains("✓ 甲") == true)
      #expect(row.detail?.contains("✓ 乙") == true)
      #expect(row.detail?.contains("方案甲") == true)
      #expect(row.detail?.contains("预览\n原文") == true)
      #expect(row.detail?.contains("还有什么？") == true)
    }

    @Test("write disclosure uses the protocol body after the host removes it from args")
    func writeContent() throws {
      let turn = SampleTurns.turn([
        SampleTurns.tool(
          "write", "write", details: #"{"tool":"write","path":"src/main.swift","content":"let value = 1\n// 中文\n\n"}"#)
      ])
      guard case .tool(let write) = try #require(turn.steps.first) else {
        Issue.record("expected a protocol tool step")
        return
      }
      #expect(write.args.isEmpty)
      let row = try #require(RailRows.layout(turn).rows.first)
      #expect(row.object == "src/main.swift")
      #expect(row.detail == "let value = 1\n// 中文\n\n")
    }

    @Test(
      "overflow changes only the title and keeps known token counts with the full summary", arguments: [false, true])
    func overflowCounts(_ hasAfter: Bool) throws {
      var turn = SampleTurns.turn([])
      let after: Int? = hasAfter ? 41001 : nil
      let summary = "完整摘要\n第二行\n"
      turn.steps = [
        .compaction(.init(id: "compact", tokensBefore: 152345, tokensAfter: after, summary: summary, reason: .overflow))
      ]
      let row = try #require(RailRows.layout(turn).rows.first)
      let expected =
        hasAfter
        ? "压缩前 152345 tokens · 压缩后 41001 tokens\n\n完整摘要\n第二行\n"
        : "压缩前 152345 tokens\n\n完整摘要\n第二行\n"
      #expect(row.verb == "上下文超出窗口，已压缩")
      #expect(row.detail == expected)
      turn.steps = [
        .compaction(
          .init(id: "compact", tokensBefore: 152345, tokensAfter: after, summary: summary, reason: .threshold))
      ]
      #expect(RailRows.layout(turn).rows.first?.detail == expected)
    }

    /// Makes a real tool step with the common protocol fields.
    ///
    /// - Remark: Each test supplies only the fields relevant to its regression.
    /// - SideEffects: none
    private func tool(_ id: String, _ name: String, output: String?) -> Step.Tool {
      .init(id: id, callId: id, tool: name, args: [:], status: .done, output: output, details: nil, partial: false)
    }
  }
#endif
