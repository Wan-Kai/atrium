import AtriumProtocol
import Foundation
import Testing

@testable import AtriumUI

/// A pending question with a single-choice and a multi-choice question.
///
/// - Remark: As `control.question` carries it.
/// - SideEffects: none
/// - Returns: The question.
/// - Throws: When the JSON does not decode.
func pendingQuestion(id: String = "qq") throws -> PendingQuestion {
  let option = { (label: String) in #"{"label":"\#(label)","description":"","preview":null,"recommended":false}"# }
  let json = """
    {"id":"\(id)","askedAt":1,"questions":[\
    {"header":"位置","question":"缓存放哪？","multiSelect":false,"options":[\(option("内存")),\(option("磁盘"))]},\
    {"header":"清理","question":"什么时候清？","multiSelect":true,"options":[\(option("启动")),\(option("退出")),\(option("每天"))]}]}
    """
  return try JSONDecoder().decode(PendingQuestion.self, from: Data(json.utf8))
}

@Suite("Question draft")
struct QuestionDraftTests {
  @Test("picks one choice of a single-choice question, and says to go on to the next")
  func single() throws {
    var draft = QuestionDraft(try pendingQuestion())
    #expect(!draft.isAnswered(0))
    let moved10 = draft.choose(1, in: 0)
    #expect(moved10)
    let moved00 = draft.choose(0, in: 0)
    #expect(moved00)
    #expect(draft.selected[0] == [0])
    #expect(draft.isAnswered(0))
    #expect(draft.answered == 1)
    #expect(!draft.complete)
  }

  @Test("toggles choices of a multi-choice question and stays on it")
  func multi() throws {
    var draft = QuestionDraft(try pendingQuestion())
    let first = draft.choose(0, in: 1)
    let second = draft.choose(2, in: 1)
    let again = draft.choose(0, in: 1)
    #expect([first, second, again] == [false, false, false])
    #expect(draft.selected[1] == [2])
    #expect(draft.isAnswered(1))
  }

  @Test("counts another answer only when it has words, and a single choice drops the choice for it")
  func other() throws {
    var draft = QuestionDraft(try pendingQuestion())
    _ = draft.choose(0, in: 0)
    draft.chooseOther(in: 0)
    #expect(draft.selected[0] == [])
    #expect(!draft.isAnswered(0))
    draft.others[0] = "  "
    #expect(!draft.isAnswered(0))
    draft.others[0] = "都不要"
    #expect(draft.isAnswered(0))
  }

  @Test("makes the reply once every question is answered, choices in order and other text trimmed")
  func reply() throws {
    var draft = QuestionDraft(try pendingQuestion())
    #expect(draft.reply == nil)
    _ = draft.choose(1, in: 0)
    _ = draft.choose(2, in: 1)
    _ = draft.choose(0, in: 1)
    draft.chooseOther(in: 1)
    draft.others[1] = " 关机时 "
    #expect(draft.complete)
    #expect(
      draft.reply
        == .answers(
          .init(answers: [
            QuestionAnswer(selected: [1], other: nil), QuestionAnswer(selected: [0, 2], other: "关机时"),
          ])))
  }
}
