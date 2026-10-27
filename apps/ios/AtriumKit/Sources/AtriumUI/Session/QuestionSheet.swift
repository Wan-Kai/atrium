import AtriumProtocol
import AtriumSync
import SwiftUI

/// The sheet that answers the agent's `ask_user` questions.
///
/// - Remark: The final prototype's question sheet (SPEC-0005 "MP5 定的细节 · MP5c"): "agent 在问你"
///   with "已答 N / M", tabs for the questions, the question with "单选" or "多选", its options and
///   "其他" with a text field; "跳过" and "下一题" / "提交回答". A single choice moves on to the next
///   question 0.22 s later. When the Mac answered first, the sheet says "已在 Mac 上回答" and keeps
///   only "好": what was picked here is not sent.
struct QuestionSheet: View {
  /// The session.
  let sessionId: SessionId
  /// The connection's sync.
  let sync: SyncModel
  /// What is picked so far.
  @State private var draft: QuestionDraft
  /// The question shown.
  @State private var page = 0
  /// The question to turn to after a single choice, once its pause is over.
  @State private var turning: Int?
  /// The clock the page turn waits on.
  @Environment(\.atriumClock) private var clock
  /// Closes the sheet.
  @Environment(\.dismiss) private var dismiss
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether Reduce Motion is on.
  @Environment(\.atriumReduceMotion) private var reduceMotion

  /// Shows a question.
  ///
  /// - Remark: Starts with nothing picked.
  /// - SideEffects: none
  /// - Parameters:
  ///   - sessionId: The session.
  ///   - sync: The connection's sync.
  ///   - question: The pending question.
  init(sessionId: SessionId, sync: SyncModel, question: PendingQuestion) {
    self.sessionId = sessionId
    self.sync = sync
    _draft = State(initialValue: QuestionDraft(question))
  }

  /// Whether the question was answered elsewhere: the session no longer waits on it.
  private var elsewhere: Bool {
    sync.core.sessions[sessionId]?.control?.question?.id != draft.question.id
  }

  /// The sheet.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let questions = draft.question.questions
    let asked = questions[page]
    VStack(alignment: .leading, spacing: 0) {
      VStack(spacing: 2) {
        Text("agent 在问你").font(.system(size: 17, weight: .semibold)).foregroundStyle(palette.text)
        Text(elsewhere ? "已在 Mac 上回答" : "已答 \(draft.answered) / \(questions.count)")
          .font(.system(size: 12.5)).monospacedDigit().foregroundStyle(palette.secondary)
      }
      .frame(maxWidth: .infinity)
      .padding(.top, Metrics.md)
      .padding(.bottom, Metrics.sm)
      if elsewhere {
        HStack(alignment: .top, spacing: Metrics.xs) {
          Image(systemName: "checkmark").font(.system(size: 16, weight: .semibold)).foregroundStyle(palette.okText)
          VStack(alignment: .leading, spacing: 2) {
            Text("已在 Mac 上回答").font(.system(size: 15, weight: .semibold)).foregroundStyle(palette.text)
            Text("这里的选择不会再提交。").font(.system(size: 14)).foregroundStyle(palette.secondary)
          }
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, Metrics.sm)
        .background(palette.fill, in: RoundedRectangle(cornerRadius: 18))
        .padding(.horizontal, Metrics.md)
        .padding(.bottom, Metrics.sm)
        .accessibilityIdentifier("question.elsewhere")
      }
      if questions.count > 1 {
        tabs(palette)
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 4) {
          HStack(alignment: .firstTextBaseline, spacing: Metrics.xs) {
            Text(asked.question).font(.system(size: 18, weight: .semibold)).foregroundStyle(palette.text)
              .lineSpacing(4)
            MonoTag(text: asked.multiSelect ? "多选" : "单选")
          }
          .padding(.horizontal, Metrics.lg)
          .padding(.bottom, 10)
          ForEach(Array(asked.options.enumerated()), id: \.offset) { index, option in
            optionRow(
              option.label, detail: option.description, recommended: option.recommended,
              on: draft.selected[page].contains(index), multi: asked.multiSelect, palette: palette
            ) {
              let next = draft.choose(index, in: page)
              if next { advance() }
            }
          }
          optionRow(
            "其他", detail: "都不合适？写你自己的回答", recommended: false, on: draft.otherOn[page],
            multi: asked.multiSelect, palette: palette
          ) {
            draft.chooseOther(in: page)
          }
          if draft.otherOn[page] {
            TextField("写下你的回答…", text: $draft.others[page], axis: .vertical)
              .lineLimit(2...6)
              .font(.system(size: 15.5))
              .padding(Metrics.sm)
              .background(palette.page, in: RoundedRectangle(cornerRadius: 12))
              .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(palette.tertiary, lineWidth: 1))
              .padding(.horizontal, Metrics.lg)
          }
          if !elsewhere {
            Text("也可以关掉这里，在输入框里直接回复，发出后代替回答。")
              .font(.system(size: 13)).foregroundStyle(palette.secondary)
              .padding(.horizontal, Metrics.lg).padding(.top, Metrics.sm)
          }
        }
        .disabled(elsewhere)
        .opacity(elsewhere ? 0.45 : 1)
        .id(page)
        .transition(.opacity)
      }
      buttons(palette)
    }
    .background(palette.surface)
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .task(id: turning) {
      guard let next = turning else { return }
      // A pause so the pick can be seen; a tab tapped meanwhile wins.
      try? await clock.sleep(for: .seconds(0.22))
      guard !Task.isCancelled, turning == next else { return }
      turning = nil
      withAnimation(reduceMotion ? nil : MotionToken.smooth.resolved(reduceMotion: false).animation) { page = next }
    }
  }

  /// The tabs, one per question, with a dot that fills once answered.
  ///
  /// - Remark: The prototype's `.qseg`, split evenly by the number of questions.
  /// - SideEffects: none
  /// - Parameter palette: The colours.
  /// - Returns: The tabs.
  private func tabs(_ palette: Palette) -> some View {
    HStack(spacing: 0) {
      ForEach(Array(draft.question.questions.enumerated()), id: \.offset) { index, asked in
        Button {
          turning = nil
          withAnimation(reduceMotion ? nil : MotionToken.bouncy.resolved(reduceMotion: false).animation) {
            page = index
          }
        } label: {
          HStack(spacing: 6) {
            Circle()
              .strokeBorder(draft.isAnswered(index) ? palette.ok : palette.tertiary, lineWidth: 1.3)
              .background(Circle().fill(draft.isAnswered(index) ? palette.ok : .clear))
              .frame(width: 7, height: 7)
            Text(asked.header).lineLimit(1)
          }
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(page == index ? palette.text : palette.secondary)
          .frame(maxWidth: .infinity, minHeight: 34)
          .background(page == index ? palette.page : .clear, in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
      }
    }
    .padding(2)
    .background(palette.fill, in: RoundedRectangle(cornerRadius: 12))
    .padding(.horizontal, Metrics.md)
    .padding(.bottom, 18)
  }

  /// One option: its label, what it means, and its mark.
  ///
  /// - Remark: A round mark for a single choice, a square one for several; "推荐" for the agent's pick.
  /// - SideEffects: none
  /// - Parameters:
  ///   - label: The label.
  ///   - detail: What it means.
  ///   - recommended: Whether the agent recommends it.
  ///   - on: Whether it is picked.
  ///   - multi: Whether several may be picked.
  ///   - palette: The colours.
  ///   - pick: What a tap does.
  /// - Returns: The row.
  private func optionRow(
    _ label: String, detail: String, recommended: Bool, on: Bool, multi: Bool, palette: Palette,
    pick: @escaping () -> Void
  ) -> some View {
    Button(action: pick) {
      HStack(spacing: Metrics.sm) {
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 6) {
            Text(label).font(.system(size: 16)).foregroundStyle(palette.text)
            if recommended {
              Text("推荐").font(.system(size: 11.5, weight: .medium)).foregroundStyle(palette.tint)
                .padding(.horizontal, 6).frame(height: 18).background(palette.tint.opacity(0.12), in: Capsule())
            }
          }
          if !detail.isEmpty {
            Text(detail).font(.system(size: 13)).foregroundStyle(palette.secondary).multilineTextAlignment(.leading)
          }
        }
        Spacer(minLength: 0)
        let mark: AnyShape = multi ? AnyShape(RoundedRectangle(cornerRadius: 7)) : AnyShape(Circle())
        ZStack {
          mark.fill(on ? palette.ink : .clear)
          mark.stroke(on ? palette.ink : palette.tertiary, lineWidth: 1.5)
          if on { Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(palette.onInk) }
        }
        .frame(width: 22, height: 22)
      }
      .padding(.horizontal, Metrics.md)
      .frame(minHeight: 56)
      .background(on ? palette.fill : .clear, in: RoundedRectangle(cornerRadius: 16))
      .contentShape(RoundedRectangle(cornerRadius: 16))
    }
    .buttonStyle(PressStyle(scale: 0.98))
    .padding(.horizontal, Metrics.xs)
  }

  /// The buttons at the bottom: "跳过" and "下一题" / "提交回答", or only "好".
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter palette: The colours.
  /// - Returns: The buttons.
  private func buttons(_ palette: Palette) -> some View {
    HStack(spacing: Metrics.sm) {
      if elsewhere {
        Button("好") { dismiss() }
          .frame(maxWidth: .infinity, minHeight: 50).background(palette.ink, in: Capsule()).foregroundStyle(
            palette.onInk)
      } else {
        Button("跳过") {
          sync.perform(.answerQuestion(draft.question.id, .skipped), in: sessionId)
          dismiss()
        }
        .frame(maxWidth: .infinity, minHeight: 50).background(palette.fill, in: Capsule()).foregroundStyle(palette.text)
        let last = draft.complete || page == draft.question.questions.count - 1
        Button(last ? "提交回答" : "下一题") {
          if let reply = draft.reply {
            sync.perform(.answerQuestion(draft.question.id, reply), in: sessionId)
            dismiss()
          } else {
            advance()
          }
        }
        .frame(maxWidth: .infinity, minHeight: 50).background(palette.ink, in: Capsule()).foregroundStyle(palette.onInk)
        .opacity(last && !draft.complete ? 0.35 : 1)
        .disabled(last && !draft.complete)
        .accessibilityIdentifier("question.submit")
      }
    }
    .font(.system(size: 16, weight: .semibold))
    .buttonStyle(PressStyle())
    .padding(Metrics.md)
  }

  /// Goes on to the next unanswered question, a moment after a single choice.
  ///
  /// - Remark: 0.22 s so the pick can be seen (the prototype's timing); the sheet's task waits.
  /// - SideEffects: Sets the page to turn to.
  private func advance() {
    let count = draft.question.questions.count
    guard count > 1 else { return }
    turning = (1..<count).map({ (page + $0) % count }).first(where: { !draft.isAnswered($0) })
  }
}
