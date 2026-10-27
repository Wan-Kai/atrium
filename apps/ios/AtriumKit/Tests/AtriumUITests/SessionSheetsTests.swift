import AtriumProtocol
import Foundation
import Testing

@testable import AtriumUI

@Suite("Session sheets")
struct SessionSheetsTests {
  @Test("counts a dialog's deadline down in whole seconds, never below zero")
  func countdown() {
    #expect(InteractionSheet.countdown(deadline: 10_000, now: 0) == "10 秒后按默认继续")
    #expect(InteractionSheet.countdown(deadline: 10_000, now: 9_001) == "1 秒后按默认继续")
    #expect(InteractionSheet.countdown(deadline: 10_000, now: 12_000) == "0 秒后按默认继续")
  }

  @Test("names a child's role and says whether it asks, runs or is done")
  func children() throws {
    #expect(ChildrenSheet.roleName(.work) == "可写")
    #expect(ChildrenSheet.roleName(.explore) == "只读")
    #expect(ChildrenSheet.roleName(.advise) == "顾问")
    let summary = {
      try JSONDecoder().decode(
        SessionSummary.self,
        from: Data(
          """
          {"sessionId":"c","containerId":"w","name":null,"prompt":null,"file":null,"state":"persisted","updatedAt":1,\
          "archived":false,"running":false,"attention":null,"asking":null,"handedOff":false,"model":null,\
          "parent":null,"agent":null,"heldDeliveries":0}
          """.utf8))
    }
    let asking = try summary().replacing(asking: 5)
    #expect(ChildrenSheet.line(of: asking) == "在等你回答")
    #expect(ChildrenSheet.state(of: asking) == .asking)
    let idle = try summary()
    #expect(ChildrenSheet.line(of: idle) == "完成")
    #expect(ChildrenSheet.state(of: idle) == .idle)
  }

  @Test("notices what waits for an answer: the question, then each dialog")
  func waiting() throws {
    #expect(SessionPage.waiting(nil) == [])
    #expect(SessionPage.waiting(try control()) == [])
    let question = try pendingQuestion(id: "q9")
    let encoded = String(decoding: try JSONEncoder().encode(question), as: UTF8.self)
    let dialog =
      #"[{"id":"i1","kind":"confirm","title":"继续？","message":null,"options":null,"placeholder":null,"prefill":null,"deadline":null}]"#
    #expect(SessionPage.waiting(try control(["question": encoded, "interactions": dialog])) == ["q9", "i1"])
  }
}

extension SessionSummary {
  /// The same summary, asking since a time.
  ///
  /// - Remark: For tests of the child list.
  /// - SideEffects: none
  /// - Parameter asking: Since when it asks.
  /// - Returns: The summary.
  fileprivate func replacing(asking: Int) -> SessionSummary {
    var copy = self
    copy.asking = asking
    return copy
  }
}
