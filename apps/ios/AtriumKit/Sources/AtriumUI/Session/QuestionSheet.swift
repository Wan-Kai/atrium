import AtriumProtocol
import AtriumSync
import SwiftUI

/// The sheet that answers the agent's `ask_user` questions.
///
/// - Remark: The paper redesign (design-language "手机端 · 提问 sheet"), after the desktop's question
///   card: "agent" in Syne with its letters hopping in turn, "/ 在问你", "已答 N / M"; the questions'
///   titles as chips; the question with "单选" or "多选 · 已选 N"; its options without borders, a
///   numbered badge each (round for one choice, square for several), the picked ones deep beige with
///   a tick; "其他" with a text field; "跳过", "下一题 ›" and "提交回答". A single choice moves on to
///   the next question 0.22 s later. When the Mac answered first, the sheet says "已在 Mac 上回答" and keeps
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
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        AgentWord()
        Text("/").font(.system(size: 13)).foregroundStyle(palette.attn)
        Text("在问你").font(.system(size: 14, weight: .medium)).foregroundStyle(palette.text)
        Text(elsewhere ? "已在 Mac 上回答" : "已答 \(draft.answered) / \(questions.count)")
          .font(.system(size: 12.5)).monospacedDigit().foregroundStyle(palette.secondary)
          .padding(.leading, 2)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 22)
      .padding(.top, 22)
      .padding(.bottom, 10)
      .accessibilityElement(children: .combine)
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
          Text(asked.question).font(.system(size: 18, weight: .semibold)).foregroundStyle(palette.text)
            .lineSpacing(4)
            .padding(.horizontal, 22)
          kindTag(
            multi: asked.multiSelect, picked: draft.selected[page].count + (draft.otherOn[page] ? 1 : 0),
            palette: palette
          )
          .padding(.horizontal, 22)
          .padding(.top, 2)
          .padding(.bottom, 8)
          ForEach(Array(asked.options.enumerated()), id: \.offset) { index, option in
            optionRow(
              number: index + 1, option.label, detail: option.description, recommended: option.recommended,
              on: draft.selected[page].contains(index), multi: asked.multiSelect, palette: palette
            ) {
              let next = draft.choose(index, in: page)
              if next { advance() }
            }
          }
          optionRow(
            number: asked.options.count + 1, "其他", detail: "都不合适？写你自己的回答", recommended: false,
            on: draft.otherOn[page],
            multi: asked.multiSelect, palette: palette
          ) {
            draft.chooseOther(in: page)
          }
          if draft.otherOn[page] {
            TextField("写下你的回答…", text: $draft.others[page], axis: .vertical)
              .lineLimit(2...6)
              .font(.system(size: 15.5))
              .padding(Metrics.sm)
              .background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
              .padding(.leading, 58)
              .padding(.trailing, 22)
          }
          if !elsewhere {
            Text("也可以关掉这里，在输入框里直接回复，发出后代替回答。")
              .font(.system(size: 13)).foregroundStyle(palette.secondary)
              .padding(.horizontal, 22).padding(.top, Metrics.sm)
          }
        }
        .disabled(elsewhere)
        .opacity(elsewhere ? 0.45 : 1)
        .id(page)
        .transition(.opacity)
      }
      buttons(palette)
    }
    .background(palette.note)
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

  /// The questions' titles as chips, the one shown on a quiet ground, a tick once answered.
  ///
  /// - Remark: The desktop card's title chips: 26pt, an open dot before an unanswered one's name, a
  ///   green tick before an answered one's; a tap turns to it.
  /// - SideEffects: none
  /// - Parameter palette: The colours.
  /// - Returns: The chips.
  private func tabs(_ palette: Palette) -> some View {
    HStack(spacing: 4) {
      ForEach(Array(draft.question.questions.enumerated()), id: \.offset) { index, asked in
        Button {
          turning = nil
          withAnimation(reduceMotion ? nil : MotionToken.bouncy.resolved(reduceMotion: false).animation) {
            page = index
          }
        } label: {
          HStack(spacing: 5) {
            if draft.isAnswered(index) {
              Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(palette.ok)
            } else {
              Circle().strokeBorder(palette.secondary, lineWidth: 1).frame(width: 6, height: 6)
            }
            Text(asked.header).lineLimit(1)
          }
          .font(.system(size: 12, weight: page == index ? .medium : .regular))
          .foregroundStyle(page == index ? palette.text : palette.secondary)
          .padding(.horizontal, 9)
          .frame(height: 26)
          .background(page == index ? palette.surface : .clear, in: Capsule())
        }
        .buttonStyle(.plain)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 22)
    .padding(.bottom, 14)
  }

  /// "单选", or "多选 · 已选 N" in the tint.
  ///
  /// - Remark: design-language "手机端 · 提问 sheet": the kind is always written.
  /// - SideEffects: none
  /// - Parameters:
  ///   - multi: Whether several may be picked.
  ///   - picked: How many are picked.
  ///   - palette: The colours.
  /// - Returns: The tag.
  private func kindTag(multi: Bool, picked: Int, palette: Palette) -> some View {
    Text(multi ? "多选 · 已选 \(picked)" : "单选")
      .font(.system(size: 11, weight: .semibold))
      .monospacedDigit()
      .foregroundStyle(multi ? palette.tint : palette.secondary)
      .padding(.horizontal, 6)
      .frame(height: 19)
      .background(multi ? palette.tintSoft : palette.surface, in: RoundedRectangle(cornerRadius: 5))
  }

  /// One option, without a border: its numbered badge, its label and what it means.
  ///
  /// - Remark: The badge is round for a single choice, a rounded square for several; picked, it is
  ///   deep beige with a tick. "推荐" follows the agent's pick.
  /// - SideEffects: none
  /// - Parameters:
  ///   - number: Its place, from 1.
  ///   - label: The label.
  ///   - detail: What it means.
  ///   - recommended: Whether the agent recommends it.
  ///   - on: Whether it is picked.
  ///   - multi: Whether several may be picked.
  ///   - palette: The colours.
  ///   - pick: What a tap does.
  /// - Returns: The row.
  private func optionRow(
    number: Int, _ label: String, detail: String, recommended: Bool, on: Bool, multi: Bool, palette: Palette,
    pick: @escaping () -> Void
  ) -> some View {
    Button(action: pick) {
      HStack(alignment: .top, spacing: 12) {
        let badge: AnyShape = multi ? AnyShape(RoundedRectangle(cornerRadius: 7)) : AnyShape(Circle())
        ZStack {
          badge.fill(on ? palette.tint : palette.surface)
          if on {
            Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(palette.onInk)
          } else {
            Text("\(number)").font(.system(size: 12, weight: .semibold)).monospacedDigit()
              .foregroundStyle(palette.secondary)
          }
        }
        .frame(width: 24, height: 24)
        VStack(alignment: .leading, spacing: 1) {
          HStack(spacing: 6) {
            Text(label).font(.system(size: 15.5, weight: .semibold)).foregroundStyle(palette.text)
            if recommended {
              Text("推荐").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(palette.tint)
                .padding(.horizontal, 5).frame(height: 17).background(
                  palette.tintSoft, in: RoundedRectangle(cornerRadius: 4))
            }
          }
          .frame(minHeight: 24)
          if !detail.isEmpty {
            Text(detail).font(.system(size: 13)).foregroundStyle(palette.secondary).multilineTextAlignment(.leading)
          }
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 22)
      .padding(.vertical, 10)
      .contentShape(Rectangle())
    }
    .buttonStyle(PressStyle(scale: 0.98))
    .accessibilityAddTraits(on ? .isSelected : [])
  }

  /// The buttons at the bottom: "跳过" and "下一题" / "提交回答", or only "好".
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter palette: The colours.
  /// - Returns: The buttons.
  private func buttons(_ palette: Palette) -> some View {
    HStack(spacing: 10) {
      if elsewhere {
        Button("好") { dismiss() }
          .frame(maxWidth: .infinity, minHeight: 46).background(palette.ink, in: Capsule()).foregroundStyle(
            palette.onInk)
      } else {
        Button("跳过") {
          sync.perform(.answerQuestion(draft.question.id, .skipped), in: sessionId)
          dismiss()
        }
        .font(.system(size: 14))
        .foregroundStyle(palette.secondary)
        .padding(.horizontal, 6)
        Spacer(minLength: 0)
        let last = draft.complete || page == draft.question.questions.count - 1
        if !last {
          Button("下一题 ›") { advance() }
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(palette.text)
            .padding(.horizontal, 18).frame(height: 46)
            .overlay(Capsule().strokeBorder(palette.line, lineWidth: 1))
        }
        Button("提交回答") {
          if let reply = draft.reply {
            sync.perform(.answerQuestion(draft.question.id, reply), in: sessionId)
            dismiss()
          }
        }
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(draft.complete ? palette.onInk : palette.secondary)
        .padding(.horizontal, 22).frame(height: 46)
        .background(draft.complete ? palette.ink : palette.surface, in: Capsule())
        .disabled(!draft.complete)
        .accessibilityIdentifier("question.submit")
      }
    }
    .font(.system(size: 16, weight: .semibold))
    .buttonStyle(PressStyle())
    .padding(.horizontal, 22)
    .padding(.top, 12)
    .padding(.bottom, Metrics.md)
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

/// "agent" on the question sheet, its letters hopping one after another.
///
/// - Remark: The desktop card's word (design-language "手机端 · 提问 sheet"): Syne 700 in the
///   attention colour; every 1.8 s each letter jumps 4pt and settles, 0.08 s after the one before.
///   Still under Reduce Motion.
struct AgentWord: View {
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether Reduce Motion is on.
  @Environment(\.atriumReduceMotion) private var reduceMotion

  /// The word.
  var body: some View {
    let palette = Palette(scheme: scheme)
    TimelineView(.animation(paused: reduceMotion)) { context in
      let time = context.date.timeIntervalSinceReferenceDate
      HStack(spacing: 0) {
        ForEach(Array("agent".enumerated()), id: \.offset) { place, letter in
          Text(String(letter)).offset(y: reduceMotion ? 0 : Self.hop(time - Double(place) * 0.08))
        }
      }
    }
    .font(Typography.agent(size: 14))
    .foregroundStyle(palette.attn)
    .accessibilityLabel("agent")
  }

  /// How high a letter is at a moment of its 1.8 s cycle.
  ///
  /// - Remark: The desktop's `hop` keyframes: up 4pt by 14%, a touch below at 26%, rest from 40%.
  /// - SideEffects: none
  /// - Parameter time: Seconds, shifted by the letter's delay.
  /// - Returns: The offset, negative upwards.
  static func hop(_ time: Double) -> CGFloat {
    let part = (time.truncatingRemainder(dividingBy: 1.8) + 1.8).truncatingRemainder(dividingBy: 1.8) / 1.8
    switch part {
    case ..<0.14: return -4 * part / 0.14
    case ..<0.26: return -4 + 4.5 * (part - 0.14) / 0.12
    case ..<0.40: return 0.5 - 0.5 * (part - 0.26) / 0.14
    default: return 0
    }
  }
}
