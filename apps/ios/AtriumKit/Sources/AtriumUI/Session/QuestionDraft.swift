import AtriumProtocol
import Foundation

/// Your answers to an `ask_user` call while you pick them, before they are sent.
///
/// - Remark: SPEC-0003 and the final prototype's question sheet (SPEC-0005 "MP5 定的细节 · MP5c"): a
///   single-choice question takes one option or "其他"; a multi-choice one any options and "其他";
///   "其他" counts only with words in it. The reply goes out once every question is answered.
struct QuestionDraft: Equatable {
  /// The questions.
  let question: PendingQuestion
  /// The options picked, per question.
  private(set) var selected: [Set<Int>]
  /// Whether "其他" is picked, per question.
  private(set) var otherOn: [Bool]
  /// The words written for "其他", per question.
  var others: [String]

  /// Starts with nothing picked.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter question: The pending question.
  init(_ question: PendingQuestion) {
    self.question = question
    let count = question.questions.count
    selected = Array(repeating: [], count: count)
    otherOn = Array(repeating: false, count: count)
    others = Array(repeating: "", count: count)
  }

  /// Picks an option, or for a multi-choice question picks or unpicks it.
  ///
  /// - Remark: A single choice replaces what was picked, "其他" too; the sheet then moves on.
  /// - SideEffects: none
  /// - Parameters:
  ///   - option: The option's index.
  ///   - index: The question's index.
  /// - Returns: Whether to go on to the next question: after a single choice.
  mutating func choose(_ option: Int, in index: Int) -> Bool {
    if question.questions[index].multiSelect {
      if selected[index].contains(option) { selected[index].remove(option) } else { selected[index].insert(option) }
      return false
    }
    selected[index] = [option]
    otherOn[index] = false
    return true
  }

  /// Picks "其他", or for a multi-choice question picks or unpicks it.
  ///
  /// - Remark: For a single choice it replaces the option picked.
  /// - SideEffects: none
  /// - Parameter index: The question's index.
  mutating func chooseOther(in index: Int) {
    if question.questions[index].multiSelect {
      otherOn[index].toggle()
    } else {
      selected[index] = []
      otherOn[index] = true
    }
  }

  /// Whether a question is answered.
  ///
  /// - Remark: "其他" picked with nothing written does not count.
  /// - SideEffects: none
  /// - Parameter index: The question's index.
  /// - Returns: Whether it is.
  func isAnswered(_ index: Int) -> Bool {
    if otherOn[index], Self.trimmed(others[index]).isEmpty { return false }
    return !selected[index].isEmpty || otherOn[index]
  }

  /// How many questions are answered.
  var answered: Int { question.questions.indices.filter(isAnswered).count }
  /// Whether every question is answered.
  var complete: Bool { answered == question.questions.count }

  /// The reply to send, once every question is answered.
  var reply: QuestionReply? {
    guard complete else { return nil }
    return .answers(
      .init(
        answers: question.questions.indices.map { index in
          QuestionAnswer(selected: selected[index].sorted(), other: otherOn[index] ? Self.trimmed(others[index]) : nil)
        }))
  }

  /// Text without the spaces and new lines around it.
  ///
  /// - Remark: What "其他" sends.
  /// - SideEffects: none
  /// - Parameter text: The text.
  /// - Returns: The trimmed text.
  private static func trimmed(_ text: String) -> String {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
