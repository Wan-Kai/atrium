import AtriumProtocol
import SwiftUI

/// One turn on the session page: your message, its process, its reply and what it changed.
///
/// - Remark: SPEC-0005 "MP5 定的细节 · MP5a" after the final prototype. The rail is open while the
///   turn runs and folds 1 s after it ends (design-language); a turn already finished when it
///   appears starts folded. The running time ticks each second from the host's start time. The
///   reply streams through ``StreamingReplyView``; a long press offers "复制".
struct TurnView: View {
  /// The turn's layout.
  let layout: TurnLayout
  /// Retries the run, for the latest turn only.
  let retry: (() -> Void)?
  /// Opens the change list from "改了 N 个文件"; `nil` for a session that is not in a workspace.
  var openChanges: (() -> Void)?
  /// Whether the rail is open.
  @State private var expanded: Bool
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// The clock the fold waits on.
  @Environment(\.atriumClock) private var clock

  /// Shows a turn.
  ///
  /// - Remark: A running turn starts with its rail open.
  /// - SideEffects: none
  /// - Parameters:
  ///   - layout: The turn's layout.
  ///   - retry: Retries the run; `nil` for an older turn.
  ///   - openChanges: Opens the change list from "改了 N 个文件", if it can.
  init(layout: TurnLayout, retry: (() -> Void)? = nil, openChanges: (() -> Void)? = nil) {
    self.layout = layout
    self.retry = retry
    self.openChanges = openChanges
    _expanded = State(initialValue: layout.running)
  }

  /// The turn.
  var body: some View {
    let palette = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: Metrics.xs) {
      if layout.showsBubble {
        UserBubble(text: layout.user, images: layout.images) {
          Text(TurnLayout.clock(layout.sentAt)).monospacedDigit()
        }
      }
      if layout.showsRail {
        // Only a running turn's time ticks; a finished one is drawn once.
        if layout.running {
          TimelineView(.periodic(from: .now, by: 1)) { context in
            ProcessRailView(
              rows: layout.rows, running: true,
              duration: layout.headline(now: Int(context.date.timeIntervalSince1970 * 1000)), summary: layout.summary,
              expanded: $expanded)
          }
        } else {
          ProcessRailView(
            rows: layout.rows, running: false, duration: layout.headline(now: 0), summary: layout.summary,
            expanded: $expanded)
        }
      }
      if let reply = layout.reply {
        StreamingReplyView(source: reply, streaming: layout.running, clock: ContinuousClock())
          .contextMenu {
            Button("复制", systemImage: "doc.on.doc") { Pasteboard.copy(reply) }
          }
      }
      if let failure = layout.failure {
        // pi's text goes only into the details: the card's words are the app's (AGENTS.md).
        ErrorCard(text: "这一轮出错了", detail: failure, retry: retry)
      }
      if let changed = layout.changes {
        if let openChanges {
          Button(action: openChanges) { ChangesLine(changes: changed, palette: palette) }.buttonStyle(PressStyle())
        } else {
          ChangesLine(changes: changed, palette: palette)
        }
      }
    }
    .task(id: layout.running) {
      // Folds a second after the turn ends, so the last step can be seen settling.
      guard !layout.running, expanded else { return }
      try? await clock.sleep(for: .seconds(1))
      expanded = false
    }
  }
}

/// Your message, as a slip of paper on the right, with a line under it.
///
/// - Remark: design-language "手机端 · 对话页": a `--note` slip (radius 18, 4 at the bottom right, a
///   hairline and a faint shadow) holding only the words, at most 82% wide; under it, right-aligned,
///   the time, or "发送中" / "没能确认是否送到 · 重发" while it is not settled. Images are a small tag.
struct UserBubble<Under: View>: View {
  /// The text.
  let text: String
  /// How many images came with it.
  let images: Int
  /// The line under the bubble.
  @ViewBuilder let under: Under
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The bubble.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let slip = UnevenRoundedRectangle(
      cornerRadii: RectangleCornerRadii(topLeading: 18, bottomLeading: 18, bottomTrailing: 4, topTrailing: 18))
    VStack(alignment: .trailing, spacing: 4) {
      if images > 0 {
        MonoTag(text: "\(images) 张图")
      }
      if !text.isEmpty {
        Text(text)
          .font(.system(size: 15.5))
          .lineSpacing(3)
          .foregroundStyle(palette.text)
          .textSelection(.enabled)
          .padding(.horizontal, 14)
          .padding(.vertical, 10)
          .background(palette.note, in: slip)
          .overlay(slip.strokeBorder(palette.line, lineWidth: 0.5))
          .shadow(color: Color(red: 0.24, green: 0.16, blue: 0.04).opacity(scheme == .dark ? 0 : 0.08), radius: 5, y: 3)
      }
      under
        .font(.system(size: 11.5))
        .foregroundStyle(palette.secondary)
        .padding(.trailing, 4)
    }
    .containerRelativeFrame(.horizontal, alignment: .trailing) { width, _ in width * 0.82 }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .padding(.top, 14)
  }
}

/// The line under a reply that says what the turn changed.
///
/// - Remark: The prototype's `.info` pill: "改了 N 个文件 +A −D". The change list it opens is MP6.
private struct ChangesLine: View {
  /// What changed.
  let changes: TurnLayout.Changes
  /// The colours.
  let palette: Palette

  /// The pill.
  var body: some View {
    HStack(spacing: 6) {
      Text("改了 \(changes.files) 个文件").foregroundStyle(palette.text2)
      if changes.added > 0 { Text("+\(changes.added)").foregroundStyle(palette.okText) }
      if changes.removed > 0 { Text("−\(changes.removed)").foregroundStyle(palette.danger) }
    }
    .font(.system(size: 13))
    .monospacedDigit()
    .padding(.horizontal, Metrics.sm)
    .frame(height: 32)
    .background(palette.fill, in: Capsule())
    .accessibilityElement(children: .combine)
  }
}
