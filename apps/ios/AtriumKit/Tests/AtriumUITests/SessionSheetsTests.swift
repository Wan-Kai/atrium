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

@Suite("Session page: what opens by itself")
struct SessionPresentTests {
  /// A dialog, as JSON.
  static let dialog =
    #"[{"id":"i1","kind":"confirm","title":"继续？","message":null,"options":null,"placeholder":null,"prefill":null,"deadline":null}]"#

  @Test("opens the question first, then the oldest dialog, each once, and nothing before the sync")
  func order() throws {
    let question = String(decoding: try JSONEncoder().encode(try pendingQuestion(id: "q9")), as: UTF8.self)
    let both = try control(["question": question, "interactions": Self.dialog])
    #expect(SessionPage.nextToPresent(both, presented: [], synced: false) == nil)
    #expect(SessionPage.nextToPresent(both, presented: [], synced: true)?.id == "question-q9")
    #expect(SessionPage.nextToPresent(both, presented: ["q9"], synced: true)?.id == "interaction-i1")
    #expect(SessionPage.nextToPresent(both, presented: ["q9", "i1"], synced: true) == nil)
    #expect(SessionPage.nextToPresent(nil, presented: [], synced: true) == nil)
  }

  @Test("says a child page belongs to its parent instead of where it is")
  func childSubtitle() {
    #expect(SessionPage.subtitle(place: "proj · main", parentTitle: nil) == "proj · main")
    #expect(SessionPage.subtitle(place: "proj · main", parentTitle: "修缓存") == "↳ 修缓存")
  }

  @Test("words a dialog or question the other end answered first")
  func elsewhere() {
    #expect(
      SessionControls.problemText(.init(action: .answerQuestion("q", .skipped), code: .questionClosed)) == "已在别处回答")
    #expect(
      SessionControls.problemText(.init(action: .answerInteraction("i", .cancelled), code: .interactionClosed))
        == "已在别处回答")
  }

  @Test("keeps the session watched under a child or the change list pushed over it")
  func staysUnderPush() {
    #expect(SessionPage.closes(child: nil, changes: nil))
    #expect(!SessionPage.closes(child: "c1", changes: nil))
    #expect(!SessionPage.closes(child: nil, changes: ChangesRoute(workspaceId: "w1")))
  }
}
