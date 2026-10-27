import AtriumProtocol
import AtriumSync
import SwiftUI

/// One session, read-only: its messages and replies as they come.
///
/// - Remark: MP4a's plainest page (SPEC-0005 "MP4a 定的细节 · 界面"): your messages in bubbles,
///   replies as plain text, every other step one line of its kind and name, notices one grey line.
///   Opening the page opens the session on the Mac and subscribes to it; leaving closes it. At the
///   bottom an input sends text with its receipt (MP4b): unsettled messages show as bubbles marked
///   "发送中" or "没能确认是否送到 · 重发". Markdown, the process rail and the cat come in MP5.
struct SessionPage: View {
  /// The session.
  let sessionId: SessionId
  /// The connection's sync.
  @Environment(SyncModel.self) private var sync: SyncModel?
  /// Goes back to the home.
  @Environment(\.dismiss) private var dismiss
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The page.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let state = sync?.core.sessions[sessionId]
    ScrollView {
      LazyVStack(alignment: .leading, spacing: Metrics.md) {
        Text(title)
          .font(.system(size: 22, weight: .semibold))
          .foregroundStyle(palette.text)
          .padding(.top, Metrics.glassButton + Metrics.sm)
          .accessibilityIdentifier("session.title")
        if sync?.core.stale == true {
          Text("不是最新").font(Typography.meta).foregroundStyle(palette.tertiary)
        }
        if state?.hasOlder == true {
          Text("更早的在 Mac 上看").font(Typography.meta).foregroundStyle(palette.tertiary)
        }
        ForEach(state?.items ?? [], id: \.id) { item in
          ItemView(item: item)
        }
        ForEach(sync?.core.outbox.filter { $0.sessionId == sessionId } ?? []) { message in
          PendingBubble(message: message) { sync?.resend(message.id) }
        }
        if let line = Self.statusLine(state?.status) {
          Text(line)
            .font(Typography.meta)
            .foregroundStyle(palette.secondary)
            .accessibilityIdentifier("session.status")
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, Metrics.page)
      .padding(.bottom, Metrics.xl)
    }
    .defaultScrollAnchor(.bottom)
    .background(palette.page.ignoresSafeArea())
    .overlay(alignment: .topLeading) {
      GlassCircleButton(systemImage: "chevron.left", label: "返回") { dismiss() }
        .padding(.leading, Metrics.md)
        .accessibilityIdentifier("session.back")
    }
    .hidingNavigationBar()
    .safeAreaInset(edge: .bottom) {
      if let sync { Composer(sessionId: sessionId, sync: sync) }
    }
    .onAppear { sync?.open(sessionId) }
    .onDisappear { sync?.close(sessionId) }
  }

  /// The session's title, from the list.
  ///
  /// - Remark: As the home's rows; a session the list does not have yet has none.
  private var title: String {
    guard let summary = sync?.core.index.sessions.first(where: { $0.sessionId == sessionId }) else { return "" }
    return HomeList.title(of: summary)
  }

  /// The line under the items for where the session stands.
  ///
  /// - Remark: Loading, exited or refused; nothing when up to date. A refusal shows only its code:
  ///   the host sends no words of its own (AGENTS.md).
  /// - SideEffects: none
  /// - Parameter status: The session's status, `nil` before the page opened it.
  /// - Returns: The line, if any.
  static func statusLine(_ status: SessionState.Status?) -> String? {
    switch status {
    case nil, .loading: "正在加载…"
    case .ready: nil
    case .exited: "pi 已退出"
    case .failed(let code): "打不开这个会话（\(code.rawValue)）"
    case .handedOff: "这个会话交给终端里的 pi 了"
    }
  }
}

/// One item of a session: a turn or a notice.
///
/// - Remark: See ``SessionPage``.
struct ItemView: View {
  /// The item.
  let item: TranscriptItem
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The item.
  var body: some View {
    let palette = Palette(scheme: scheme)
    switch item {
    case .notice(let notice):
      Text(Self.label(notice)).font(Typography.meta).foregroundStyle(palette.tertiary)
    case .turn(let turn):
      VStack(alignment: .leading, spacing: Metrics.sm) {
        Text(Self.userText(turn.user))
          .font(Typography.reply)
          .foregroundStyle(palette.text)
          .padding(.horizontal, Metrics.md)
          .padding(.vertical, Metrics.sm)
          .background(palette.surface, in: RoundedRectangle(cornerRadius: Metrics.radiusBubble))
          .frame(maxWidth: .infinity, alignment: .trailing)
        ForEach(turn.steps, id: \.id) { step in
          if case .text(let text) = step {
            Text(text.text)
              .font(Typography.reply)
              .lineSpacing(5)
              .foregroundStyle(palette.text)
              .textSelection(.enabled)
          } else {
            Text(Self.label(step)).font(Typography.step).foregroundStyle(palette.secondary)
          }
        }
        if let error = turn.error {
          Text(error).font(Typography.step).foregroundStyle(palette.danger)
        }
      }
    }
  }

  /// What a user message shows: its text, and how many images came with it.
  ///
  /// - Remark: Images are not fetched in MP4a.
  /// - SideEffects: none
  /// - Parameter user: The message.
  /// - Returns: The text.
  static func userText(_ user: Turn.User) -> String {
    let images = user.images > 0 ? "［\(user.images) 张图片］" : ""
    return [user.text, images].filter { !$0.isEmpty }.joined(separator: " ")
  }

  /// One line for a step that is not reply text: its kind, and its name when it has one.
  ///
  /// - Remark: "过程只列步骤" (roadmap MP4).
  /// - SideEffects: none
  /// - Parameter step: The step.
  /// - Returns: The line.
  static func label(_ step: Step) -> String {
    switch step {
    case .thinking: "思考"
    case .text: "回复"
    case .tool(let tool): "工具 · \(tool.tool)"
    case .steer: "插话"
    case .agent: "子代理"
    case .retry: "重试"
    case .compaction: "压缩上下文"
    }
  }

  /// One grey line for a notice.
  ///
  /// - Remark: Its kind only.
  /// - SideEffects: none
  /// - Parameter notice: The notice.
  /// - Returns: The line.
  static func label(_ notice: Notice) -> String {
    switch notice {
    case .compacted: "上下文已压缩"
    case .restarted: "pi 重启了"
    case .interaction: "对话框"
    case .note: "说明"
    }
  }
}

/// A message the phone sent that is not settled yet, as a bubble with its state under it.
///
/// - Remark: design-language "手机端 · 对话": "发送中" and "没能确认是否送到 · 重发" under the bubble.
struct PendingBubble: View {
  /// The message.
  let message: Outgoing
  /// Sends an uncertain message again.
  let resend: () -> Void
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The bubble.
  var body: some View {
    let palette = Palette(scheme: scheme)
    VStack(alignment: .trailing, spacing: Metrics.xxs) {
      Text(message.text)
        .font(Typography.reply)
        .foregroundStyle(palette.text)
        .padding(.horizontal, Metrics.md)
        .padding(.vertical, Metrics.sm)
        .background(palette.surface, in: RoundedRectangle(cornerRadius: Metrics.radiusBubble))
      switch message.state {
      case .sending:
        Text("发送中").font(Typography.meta).foregroundStyle(palette.tertiary)
      case .accepted:
        EmptyView()
      case .uncertain:
        Button(action: resend) {
          Text("没能确认是否送到 · 重发").font(Typography.meta).foregroundStyle(palette.attnText)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("session.resend")
      }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
  }
}

/// The input at the bottom of a session: one line of text and the send button.
///
/// - Remark: SPEC-0005 "MP4b 定的细节": sending only when connected, synced and nothing of the
///   session still unsettled; while disconnected the placeholder says "先写着，连上后再发". A
///   message that did not go comes back here with why.
struct Composer: View {
  /// The session.
  let sessionId: SessionId
  /// The connection's sync.
  let sync: SyncModel
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The input.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let text = Binding(
      get: { sync.core.drafts[sessionId] ?? "" }, set: { sync.setDraft($0, for: sessionId) })
    let empty = text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    let ready = sync.canSend(sessionId)
    VStack(alignment: .leading, spacing: Metrics.xxs) {
      if let problem = sync.core.problems[sessionId] {
        Text(Self.problemLine(problem))
          .font(Typography.meta)
          .foregroundStyle(palette.danger)
          .accessibilityIdentifier("session.problem")
      }
      HStack(alignment: .bottom, spacing: Metrics.sm) {
        TextField(Self.placeholder(connected: sync.status == .connected), text: text, axis: .vertical)
          .lineLimit(1...5)
          .font(Typography.reply)
          .accessibilityIdentifier("session.input")
        Button {
          sync.send(sessionId)
        } label: {
          Image(systemName: "arrow.up.circle.fill").font(.system(size: 30))
        }
        .disabled(!ready || empty)
        .accessibilityLabel("发送")
        .accessibilityIdentifier("session.send")
      }
      .padding(.horizontal, Metrics.md)
      .padding(.vertical, Metrics.sm)
      .atriumGlass(in: RoundedRectangle(cornerRadius: Metrics.radiusBubble), interactive: false)
    }
    .padding(.horizontal, Metrics.md)
    .padding(.bottom, Metrics.xs)
  }

  /// The input's placeholder.
  ///
  /// - Remark: design-language "手机端 · 对话": while the connection is down, write now, send later.
  /// - SideEffects: none
  /// - Parameter connected: Whether the connection is up and synced.
  /// - Returns: The placeholder.
  static func placeholder(connected: Bool) -> String {
    connected ? "发消息" : "先写着，连上后再发"
  }

  /// Why the last message did not go, in words.
  ///
  /// - Remark: The host's refusal shows only as its code (AGENTS.md: the host sends no words).
  /// - SideEffects: none
  /// - Parameter problem: Why.
  /// - Returns: The line.
  static func problemLine(_ problem: SendProblem) -> String {
    switch problem {
    case .notSent: "没发出去"
    case .refused(let code): "没发出去（\(code.rawValue)）"
    }
  }
}
