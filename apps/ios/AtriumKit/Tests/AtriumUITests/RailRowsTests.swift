#if DEBUG
  import Testing

  @testable import AtriumUI

  /// Checks the protocol-to-rail mapping against the agreed process presentation.
  ///
  /// - Remark: JSON fixtures use the host's actual protocol schema.
  @Suite("Process rail rows")
  struct RailRowsTests {
    /// Checks the complete finished rail.
    /// - Remark: Includes details as well as the one-line summaries.
    /// - SideEffects: none
    @Test("lays out the prototype's turn as the desktop does")
    func finished() {
      let (rows, reply) = RailRows.layout(SampleTurns.finished)
      #expect(reply == "原因是 `expiresAt` 存的是秒。")
      #expect(
        rows == [
          RailRow(id: "s0", node: .dot, verb: "思考了 3 秒", object: "先看看 ttl.ts", detail: "先看看 ttl.ts"),
          RailRow(
            id: "s1", node: .search, verb: "探索了代码库", object: "读了 2 个文件，搜索了 1 次",
            detail: "读了 · src/ttl.ts\n\n读了 · src/store.ts\n\ngrep"),
          RailRow(
            id: "s4", node: .dead, verb: "运行了", object: "pnpm test cache", objectIsCode: true, end: "失败",
            endTone: .bad),
          RailRow(id: "s5", node: .steer, verb: "你插话", object: "顺便看看为什么缓存永远不失效", detail: "顺便看看为什么缓存永远不失效"),
          RailRow(
            id: "s6", node: .dot, verb: "编辑了", object: "src/ttl.ts", end: "+9 −4",
            endTone: .counts(added: 9, removed: 4), detail: "+1 x"),
          RailRow(id: "s7", node: .dot, verb: "运行了", object: "pnpm test cache", objectIsCode: true, end: "通过"),
          RailRow(id: "s8", node: .compaction, verb: "压缩了上下文", object: "152K → 41K", detail: "…"),
        ])
      #expect(rows.filter(\.isBranch).map(\.id) == ["s4", "s5"])
    }

    /// Checks the ungrouped read case.
    /// - Remark: Grouping starts only with two consecutive read-only calls.
    /// - SideEffects: none
    @Test("keeps a single read-only call as its own row")
    func singleRead() {
      let (rows, _) = RailRows.layout(
        SampleTurns.turn([SampleTurns.read("a", "README.md"), SampleTurns.bash("b", "ls")]))
      #expect(rows.map(\.verb) == ["读了", "运行了"])
      #expect(rows.first?.object == "README.md")
    }

    /// Checks live tool and thinking nodes.
    /// - Remark: Finished steps remain quiet.
    /// - SideEffects: none
    @Test("marks what goes on while the turn runs")
    func running() {
      let (rows, reply) = RailRows.layout(SampleTurns.running)
      #expect(reply == nil)
      #expect(rows.map(\.node) == [.search, .dot, .live])
      #expect(rows.last?.verb == "正在运行")
      #expect(rows.last?.end == nil)
      let thinking = SampleTurns.turn(
        [SampleTurns.read("a", "x"), #"{"kind":"thinking","id":"b","text":"想想","durationMs":null}"#],
        outcome: "running")
      #expect(
        RailRows.layout(thinking).rows.last == RailRow(id: "b", node: .live, verb: "思考中", object: "想想", detail: "想想"))
    }

    /// Keeps completed thinking quiet while the original last step streams the reply.
    ///
    /// - Remark: Removing the reply must not change which step is live.
    /// - SideEffects: none
    @Test("does not revive completed thinking after removing the streaming reply")
    func thinkingBeforeReply() {
      let turn = SampleTurns.turn(
        [
          #"{"kind":"thinking","id":"a","text":"想好了","durationMs":3000}"#,
          #"{"kind":"text","id":"b","text":"最终回复"}"#,
        ], outcome: "running")
      let (rows, reply) = RailRows.layout(turn)
      #expect(reply == "最终回复")
      #expect(rows.first?.node == .dot)
      #expect(rows.first?.verb == "思考了 3 秒")
    }

    /// Checks blank filtering and intermediate prose.
    /// - Remark: Only the final visible text becomes the reply.
    /// - SideEffects: none
    @Test("leaves out blank thinking and text, and a text before more work is a step")
    func blanks() {
      let turn = SampleTurns.turn([
        #"{"kind":"thinking","id":"a","text":"  ","durationMs":null}"#,
        #"{"kind":"text","id":"b","text":"先跑一下测试\n再看"}"#,
        SampleTurns.bash("c", "pnpm test"),
        #"{"kind":"text","id":"d","text":" \n"}"#,
      ])
      let (rows, reply) = RailRows.layout(turn)
      #expect(reply == nil)
      #expect(rows.map(\.id) == ["b", "c"])
      #expect(rows.first == RailRow(id: "b", node: .said, verb: "说明", object: "先跑一下测试…", detail: "先跑一下测试\n再看"))
    }

    /// Checks summary counts and their order.
    /// - Remark: Failed commands remain represented in the folded summary.
    /// - SideEffects: none
    @Test("sums up what the process did, in the desktop's order")
    func summary() {
      let turn = SampleTurns.turn(
        [
          SampleTurns.read("a", "x"), SampleTurns.tool("b", "grep"), SampleTurns.bash("c", "make", "failed"),
          SampleTurns.bash("d", "make"),
          #"{"kind":"compaction","id":"e","tokensBefore":1500,"tokensAfter":null,"summary":"","reason":null}"#,
        ], changed: ["x"])
      #expect(RailRows.summary(turn) == ["读了 1 个文件", "搜索了 1 次", "跑了 2 条命令", "改了 1 个文件", "1 条命令没走通", "压缩了 1 次上下文"])
      #expect(RailRows.layout(turn).rows.last?.object == "压缩前 1.5K")
    }

    /// Checks the rail's formatting boundaries.
    /// - Remark: Labels match the desktop presentation.
    /// - SideEffects: none
    @Test("writes durations and token counts as the desktop does")
    func words() {
      #expect(RailRows.formatDuration(400) == "不到 1 秒")
      #expect(RailRows.formatDuration(48_000) == "48 秒")
      #expect(RailRows.formatDuration(133_000) == "2 分 13 秒")
      #expect(RailRows.formatDuration(3_720_000) == "1 小时 2 分")
      #expect(RailRows.formatTokens(999) == "999")
      #expect(RailRows.formatTokens(152_000) == "152K")
      #expect(RailRows.formatTokens(41_000) == "41K")
      #expect(RailRows.formatTokens(1_340_000) == "1.3M")
      #expect(RailRows.opening("  第一行  有  空格\n第二行") == "第一行 有 空格…")
      #expect(RailRows.opening(String(repeating: "长", count: 170)) == String(repeating: "长", count: 160) + "…")
    }
  }
#endif
