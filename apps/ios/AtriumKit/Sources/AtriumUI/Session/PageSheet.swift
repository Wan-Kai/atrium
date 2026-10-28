import AtriumProtocol
import SwiftUI

/// The sheet a session page shows, one at a time.
///
/// - Remark: SPEC-0005 "MP5 定的细节": the queue, a question, a dialog, the child list.
enum PageSheet: Identifiable {
  /// The queue.
  case queue
  /// The agent's questions.
  case question(PendingQuestion)
  /// An extension's dialog.
  case interaction(Interaction)
  /// The child conversations.
  case children([SessionSummary])
  /// The model, its level and Fast.
  case model

  /// What tells sheets apart.
  var id: String {
    switch self {
    case .queue: "queue"
    case .question(let question): "question-\(question.id)"
    case .interaction(let interaction): "interaction-\(interaction.id)"
    case .children: "children"
    case .model: "model"
    }
  }
}

/// The card a question leaves in the conversation once its sheet is closed.
///
/// - Remark: The final prototype's `qcard`: an orange question mark, "agent 在问你 N 个问题" and the
///   first question, and "回答"; the whole card opens the sheet again.
struct QuestionCard: View {
  /// The question.
  let question: PendingQuestion
  /// Opens the sheet.
  let open: () -> Void
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The card.
  var body: some View {
    let palette = Palette(scheme: scheme)
    Button(action: open) {
      HStack(spacing: Metrics.sm) {
        Image(systemName: "questionmark.circle.fill").font(.system(size: 20)).foregroundStyle(palette.attn)
        VStack(alignment: .leading, spacing: 2) {
          Text("agent 在问你 \(question.questions.count) 个问题").font(.system(size: 15.5, weight: .semibold))
            .foregroundStyle(palette.text)
          Text(question.questions.first?.question ?? "").font(.system(size: 13.5)).foregroundStyle(palette.secondary)
            .lineLimit(1)
        }
        Spacer(minLength: 0)
        Text("回答").font(.system(size: 14, weight: .semibold)).foregroundStyle(palette.onInk)
          .padding(.horizontal, 14).frame(height: 36).background(palette.ink, in: Capsule())
      }
      .padding(.leading, Metrics.md)
      .padding(.trailing, 10)
      .padding(.vertical, Metrics.sm)
      .background(palette.attnSoft, in: RoundedRectangle(cornerRadius: 20))
    }
    .buttonStyle(PressStyle(scale: 0.98))
    .accessibilityIdentifier("session.questionCard")
  }
}
