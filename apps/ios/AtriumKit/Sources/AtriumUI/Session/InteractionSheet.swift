import AtriumProtocol
import AtriumSync
import SwiftUI

/// The sheet that answers an extension's dialog.
///
/// - Remark: The prototype has no phone dialog; SPEC-0005 "MP5 定的细节 · MP5c" sets it in the
///   question sheet's rows and buttons: `select` a list whose row answers at once; `confirm` the
///   message with "取消 / 确定"; `input` one line and `editor` several (starting from `prefill`)
///   with "取消 / 提交". A deadline counts down in the subtitle. When the Mac answered first the
///   sheet says "已在 Mac 上处理" and keeps only "好".
struct InteractionSheet: View {
  /// The session.
  let sessionId: SessionId
  /// The connection's sync.
  let sync: SyncModel
  /// The dialog.
  let interaction: Interaction
  /// The text written, for `input` and `editor`.
  @State private var text: String
  /// Closes the sheet.
  @Environment(\.dismiss) private var dismiss
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// Shows a dialog.
  ///
  /// - Remark: An editor starts from its prefill.
  /// - SideEffects: none
  /// - Parameters:
  ///   - sessionId: The session.
  ///   - sync: The connection's sync.
  ///   - interaction: The dialog.
  init(sessionId: SessionId, sync: SyncModel, interaction: Interaction) {
    self.sessionId = sessionId
    self.sync = sync
    self.interaction = interaction
    _text = State(initialValue: interaction.prefill ?? "")
  }

  /// Whether the dialog was answered elsewhere: the session no longer waits on it.
  private var elsewhere: Bool {
    !(sync.core.sessions[sessionId]?.control?.interactions.contains { $0.id == interaction.id } ?? false)
  }

  /// The sheet.
  var body: some View {
    let palette = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: Metrics.sm) {
      VStack(spacing: 2) {
        Text(interaction.title).font(.system(size: 17, weight: .semibold)).foregroundStyle(palette.text)
          .multilineTextAlignment(.center)
        if elsewhere {
          Text("已在 Mac 上处理").font(.system(size: 12.5)).foregroundStyle(palette.secondary)
        } else if let deadline = interaction.deadline {
          TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(Self.countdown(deadline: deadline, now: Int(context.date.timeIntervalSince1970 * 1000)))
              .font(.system(size: 12.5)).monospacedDigit().foregroundStyle(palette.secondary)
          }
        }
      }
      .frame(maxWidth: .infinity)
      .padding(.top, Metrics.md)
      if let message = interaction.message {
        Text(message).font(.system(size: 16)).foregroundStyle(palette.text2).padding(.horizontal, Metrics.sm)
      }
      Group {
        switch interaction.kind {
        case .select:
          ScrollView {
            VStack(spacing: 4) {
              ForEach(Array((interaction.options ?? []).enumerated()), id: \.offset) { _, option in
                Button {
                  answer(.value(.init(value: option)))
                } label: {
                  Text(option).font(.system(size: 16)).foregroundStyle(palette.text)
                    .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
                    .padding(.horizontal, Metrics.md)
                    .contentShape(RoundedRectangle(cornerRadius: 16))
                }
                .buttonStyle(PressStyle(scale: 0.98))
              }
            }
          }
        case .input, .editor:
          TextField(interaction.placeholder ?? "", text: $text, axis: .vertical)
            .lineLimit(interaction.kind == .editor ? 6...14 : 1...1)
            .font(.system(size: 15.5, design: interaction.kind == .editor ? .monospaced : .default))
            .padding(Metrics.sm)
            .background(palette.page, in: RoundedRectangle(cornerRadius: 12))
        case .confirm:
          EmptyView()
        }
      }
      .disabled(elsewhere)
      .opacity(elsewhere ? 0.45 : 1)
      Spacer(minLength: 0)
      buttons(palette)
    }
    .padding(Metrics.md)
    .background(palette.surface)
    .presentationDetents(interaction.kind == .editor ? [.large] : [.medium, .large])
    .presentationDragIndicator(.visible)
    // A dialog closed by a swipe could not be found again: it ends with "取消" or an answer.
    .interactiveDismissDisabled(!elsewhere)
  }

  /// The buttons at the bottom.
  ///
  /// - Remark: "取消" answers `cancelled`; a select has only it.
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
        Button("取消") { answer(.cancelled) }
          .frame(maxWidth: .infinity, minHeight: 50).background(palette.fill, in: Capsule()).foregroundStyle(
            palette.text)
        switch interaction.kind {
        case .confirm:
          Button("确定") { answer(.confirmed(.init(confirmed: true))) }
            .frame(maxWidth: .infinity, minHeight: 50).background(palette.ink, in: Capsule())
            .foregroundStyle(palette.onInk)
        case .input, .editor:
          Button("提交") { answer(.value(.init(value: text))) }
            .frame(maxWidth: .infinity, minHeight: 50).background(palette.ink, in: Capsule())
            .foregroundStyle(palette.onInk)
        case .select:
          EmptyView()
        }
      }
    }
    .font(.system(size: 16, weight: .semibold))
    .buttonStyle(PressStyle())
  }

  /// Answers the dialog and closes the sheet.
  ///
  /// - Remark: See ``SyncCore/perform(_:in:)``.
  /// - SideEffects: Queues `answer_interaction`; closes the sheet.
  /// - Parameter answer: The answer.
  private func answer(_ answer: InteractionAnswer) {
    sync.perform(.answerInteraction(interaction.id, answer), in: sessionId)
    dismiss()
  }

  /// What the subtitle says while a deadline runs.
  ///
  /// - Remark: "N 秒后按默认继续"; at the deadline pi goes on by itself.
  /// - SideEffects: none
  /// - Parameters:
  ///   - deadline: When pi stops waiting, in milliseconds since the Unix epoch.
  ///   - now: The time now, the same way.
  /// - Returns: The words.
  static func countdown(deadline: Int, now: Int) -> String {
    let seconds = max(0, (deadline - now + 999) / 1000)
    return "\(seconds) 秒后按默认继续"
  }
}

/// The sheet that lists a session's child conversations.
///
/// - Remark: The final prototype's child list: the latest updated first, each with its state, title
///   and role; tapping a row opens its page. The phone cannot open or stop a child.
struct ChildrenSheet: View {
  /// The children.
  let children: [SessionSummary]
  /// Opens a child's page.
  let open: (SessionId) -> Void
  /// Closes the sheet.
  @Environment(\.dismiss) private var dismiss
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The sheet.
  var body: some View {
    let palette = Palette(scheme: scheme)
    ScrollView {
      VStack(alignment: .leading, spacing: 4) {
        VStack(spacing: 2) {
          Text("子对话").font(.system(size: 17, weight: .semibold)).foregroundStyle(palette.text)
          Text("最近更新的在前").font(.system(size: 12.5)).foregroundStyle(palette.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Metrics.md)
        ForEach(children, id: \.sessionId) { child in
          Button {
            dismiss()
            open(child.sessionId)
          } label: {
            HStack(spacing: Metrics.sm) {
              StatusIcon(kind: Self.state(of: child)).frame(width: 22)
              VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                  Text(HomeList.title(of: child)).font(.system(size: 16)).foregroundStyle(palette.text).lineLimit(1)
                  if let role = child.agent?.role {
                    MonoTag(text: Self.roleName(role), tone: role == .work ? .attention : .plain)
                  }
                }
                Text(Self.line(of: child)).font(.system(size: 13)).foregroundStyle(
                  child.asking != nil ? palette.attnText : palette.secondary
                ).lineLimit(1)
              }
              Spacer(minLength: 0)
            }
            .padding(.horizontal, Metrics.md)
            .frame(minHeight: 56)
            .contentShape(Rectangle())
          }
          .buttonStyle(PressStyle(scale: 0.98))
        }
        Text("子对话由 agent 或在 Mac 上开。点一行打开它的对话。")
          .font(.system(size: 13)).foregroundStyle(palette.secondary)
          .padding(Metrics.md)
      }
    }
    .background(palette.surface)
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }

  /// A child's state icon: asking, running, or neither.
  ///
  /// - Remark: As the home's rows.
  /// - SideEffects: none
  /// - Parameter child: The child.
  /// - Returns: The state.
  static func state(of child: SessionSummary) -> StatusIcon.Kind {
    child.asking != nil ? .asking : child.running ? .running : .idle
  }

  /// A child's role as its tag says it.
  ///
  /// - Remark: The prototype's tags: "可写", "只读", "顾问".
  /// - SideEffects: none
  /// - Parameter role: The role.
  /// - Returns: The tag's words.
  static func roleName(_ role: AgentRole) -> String {
    switch role {
    case .work: "可写"
    case .explore: "只读"
    case .advise: "顾问"
    }
  }

  /// A child's second line: that it asks, that it runs, or where it is.
  ///
  /// - Remark: The prototype writes what it asks; the list has only that it does.
  /// - SideEffects: none
  /// - Parameter child: The child.
  /// - Returns: The line.
  static func line(of child: SessionSummary) -> String {
    if child.asking != nil { return "在等你回答" }
    if child.running { return "进行中" }
    return "完成"
  }
}
