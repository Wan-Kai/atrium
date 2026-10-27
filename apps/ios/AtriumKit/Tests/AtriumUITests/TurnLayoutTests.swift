import AtriumProtocol
import Foundation
import Testing

@testable import AtriumUI

/// A turn decoded from JSON.
///
/// - Remark: Steps and changes are given as JSON.
/// - SideEffects: none
/// - Parameters:
///   - outcome: How it ended, or `running`.
///   - steps: Its steps, as JSON.
///   - changes: Its file changes, as JSON.
///   - error: pi's error text.
///   - durationMs: How long it took.
///   - auto: Whether the host sent the message.
/// - Returns: The turn.
/// - Throws: When the JSON does not decode.
func layoutTurn(
  outcome: String = "done", steps: [String] = [], changes: [String] = [], error: String? = nil,
  durationMs: Int? = 48_000, auto: Bool = false
) throws -> Turn {
  let json = """
    {"kind":"turn","id":"t1","source":null,"user":{"text":"修一下","images":1,"clientMessageId":null,"auto":\(auto),\
    "command":null,"timestamp":1},"steps":[\(steps.joined(separator: ","))],"outcome":"\(outcome)",\
    "error":\(error.map { "\"\($0)\"" } ?? "null"),"startedAt":10000,\
    "durationMs":\(durationMs.map(String.init) ?? "null"),"usage":null,"changes":[\(changes.joined(separator: ","))]}
    """
  return try JSONDecoder().decode(Turn.self, from: Data(json.utf8))
}

/// A reply text step, as JSON.
let replyStep = #"{"kind":"text","id":"9","text":"好了"}"#
/// A finished `bash` call, as JSON.
let bashStep =
  #"{"kind":"tool","id":"1","callId":"c","tool":"bash","args":{"command":"pnpm test"},"status":"done","output":null,"details":null,"partial":false}"#

@Suite("Turn layout")
struct TurnLayoutTests {
  @Test("splits a finished turn into its message, its process and its reply, with the time it took")
  func finished() throws {
    let layout = TurnLayout(try layoutTurn(steps: [bashStep, replyStep]))
    #expect(layout.user == "修一下")
    #expect(layout.images == 1)
    #expect(layout.reply == "好了")
    #expect(layout.rows.count == 1)
    #expect(layout.showsRail)
    #expect(!layout.running)
    #expect(layout.headline(now: 0) == "用时 48 秒")
    #expect(layout.summary == ["跑了 1 条命令"])
    #expect(layout.failure == nil)
  }

  @Test("counts the time so far of a running turn from when it started")
  func running() throws {
    let layout = TurnLayout(try layoutTurn(outcome: "running", steps: [bashStep], durationMs: nil))
    #expect(layout.running)
    #expect(layout.showsRail)
    #expect(layout.reply == nil)
    #expect(layout.headline(now: 10_000 + 72_000) == "1:12")
    #expect(layout.headline(now: 10_000 + 3_725_000) == "1:02:05")
    #expect(layout.headline(now: 5_000) == "0:00")
  }

  @Test("says a turn stopped or failed in its headline, and keeps pi's error for the card")
  func ended() throws {
    #expect(TurnLayout(try layoutTurn(outcome: "stopped", durationMs: 100_000)).headline(now: 0) == "已停止，用时 1 分 40 秒")
    let failed = TurnLayout(try layoutTurn(outcome: "failed", error: "HTTP 529", durationMs: 52_000))
    #expect(failed.headline(now: 0) == "出错，用时 52 秒")
    #expect(failed.failure == "HTTP 529")
    #expect(TurnLayout(try layoutTurn(outcome: "failed", error: nil)).failure == "")
  }

  @Test("shows no process for a turn that only replied, and no bubble for a message the host sent")
  func plain() throws {
    let replied = TurnLayout(try layoutTurn(steps: [replyStep]))
    #expect(!replied.showsRail)
    #expect(replied.showsBubble)
    #expect(!TurnLayout(try layoutTurn(steps: [replyStep], auto: true)).showsBubble)
  }

  @Test("sums the files a turn changed for the line under its reply")
  func changes() throws {
    let layout = TurnLayout(
      try layoutTurn(
        steps: [replyStep],
        changes: [
          #"{"path":"a.ts","added":9,"removed":4}"#, #"{"path":"b.ts","added":1,"removed":null}"#,
        ]))
    #expect(layout.changes == TurnLayout.Changes(files: 2, added: 10, removed: 4))
    #expect(TurnLayout(try layoutTurn(steps: [replyStep])).changes == nil)
  }
}
