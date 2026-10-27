#if DEBUG
  import AtriumProtocol
  import Foundation

  /// Made-up turns in the protocol's own JSON, for the gallery and the tests.
  ///
  /// - Remark: Written as the host sends them (`Turn` decoded from JSON), so the rail is fed what
  ///   `fetch_transcript` gives, not a hand-built model. Sample words only, no real projects.
  enum SampleTurns {
    /// A tool step's JSON.
    ///
    /// - Remark: Fills the fields every tool step has.
    /// - SideEffects: none
    /// - Parameters:
    ///   - id: The step's id.
    ///   - tool: The tool's name.
    ///   - status: `running`, `done`, `failed` or `unfinished`.
    ///   - details: The details' JSON, or `null`.
    /// - Returns: The JSON.
    static func tool(_ id: String, _ tool: String, _ status: String = "done", details: String = "null") -> String {
      #"{"kind":"tool","id":"\#(id)","callId":"c-\#(id)","tool":"\#(tool)","args":{},"status":"\#(status)","output":null,"details":\#(details),"partial":false}"#
    }

    /// A `read` step.
    ///
    /// - Remark: See `tool(_:_:_:details:)`.
    /// - SideEffects: none
    /// - Parameters:
    ///   - id: The step's id.
    ///   - path: The file.
    ///   - status: How it stands.
    /// - Returns: The JSON.
    static func read(_ id: String, _ path: String, _ status: String = "done") -> String {
      tool(id, "read", status, details: #"{"tool":"read","path":"\#(path)","offset":null,"limit":null}"#)
    }

    /// A `bash` step.
    ///
    /// - Remark: See `tool(_:_:_:details:)`.
    /// - SideEffects: none
    /// - Parameters:
    ///   - id: The step's id.
    ///   - command: The command.
    ///   - status: How it stands.
    /// - Returns: The JSON.
    static func bash(_ id: String, _ command: String, _ status: String = "done") -> String {
      tool(id, "bash", status, details: #"{"tool":"bash","command":"\#(command)"}"#)
    }

    /// An `edit` step with a diff.
    ///
    /// - Remark: See `tool(_:_:_:details:)`.
    /// - SideEffects: none
    /// - Parameters:
    ///   - id: The step's id.
    ///   - path: The file.
    ///   - added: Lines added.
    ///   - removed: Lines removed.
    /// - Returns: The JSON.
    static func edit(_ id: String, _ path: String, added: Int, removed: Int) -> String {
      tool(
        id, "edit",
        details: #"{"tool":"edit","path":"\#(path)","diff":"+1 x","added":\#(added),"removed":\#(removed)}"#)
    }

    /// A turn's JSON around some steps.
    ///
    /// - Remark: The user's message and the other fields are fixed; only steps, outcome, duration
    ///   and changed files vary.
    /// - SideEffects: none
    /// - Parameters:
    ///   - steps: The steps' JSON.
    ///   - outcome: `running`, `done`, `stopped` or `failed`.
    ///   - durationMs: How long it took.
    ///   - changed: Paths of the files it changed.
    /// - Returns: The turn.
    static func turn(_ steps: [String], outcome: String = "done", durationMs: Int = 48_000, changed: [String] = [])
      -> Turn
    {
      let changes = changed.map { #"{"path":"\#($0)","added":1,"removed":0}"# }
      let json = #"""
        {"kind":"turn","id":"t1","source":null,"user":{"text":"给 ttl.ts 加上过期的测试","images":0,"clientMessageId":null,"auto":false,"command":null,"timestamp":0},
         "steps":[\#(steps.joined(separator: ","))],"outcome":"\#(outcome)","error":null,"startedAt":0,
         "durationMs":\#(durationMs),"usage":null,"changes":[\#(changes.joined(separator: ","))]}
        """#
      do {
        return try JSONDecoder().decode(Turn.self, from: Data(json.utf8))
      } catch {
        preconditionFailure("sample turn does not decode: \(error)")
      }
    }

    /// The prototype's finished turn: an exploration, a failed run, an edit, a passing run.
    static var finished: Turn {
      turn([
        #"{"kind":"thinking","id":"s0","text":"先看看 ttl.ts","durationMs":3200}"#,
        read("s1", "src/ttl.ts"), read("s2", "src/store.ts"), tool("s3", "grep"),
        bash("s4", "pnpm test cache", "failed"),
        #"{"kind":"steer","id":"s5","text":"顺便看看为什么缓存永远不失效"}"#,
        edit("s6", "src/ttl.ts", added: 9, removed: 4),
        bash("s7", "pnpm test cache"),
        #"{"kind":"compaction","id":"s8","tokensBefore":152000,"tokensAfter":41000,"summary":"…","reason":"threshold"}"#,
        #"{"kind":"text","id":"s9","text":"原因是 `expiresAt` 存的是秒。"}"#,
      ])
    }

    /// The same turn while it still runs, its last command going on.
    static var running: Turn {
      turn(
        [
          read("s1", "src/ttl.ts"), read("s2", "src/store.ts"), edit("s6", "src/ttl.ts", added: 9, removed: 4),
          bash("s7", "pnpm test cache", "running"),
        ], outcome: "running")
    }
  }
#endif
