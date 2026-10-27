import AtriumProtocol
import AtriumSync
import SwiftUI

/// One session: its turns as they come, and the input that sends to it.
///
/// - Remark: SPEC-0005 "MP5 定的细节 · MP5a": each turn is a ``TurnView`` (your bubble, the process
///   rail, the Markdown reply, what it changed); notices are one grey line. A floating top bar holds
///   the back button, the title and "项目 · 分支". Opening the page opens the session on the Mac and
///   subscribes to it; leaving closes it. At the bottom the ``SessionDock`` sends with a receipt
///   (MP4b), queues, steers and stops (MP5b): unsettled messages show as bubbles marked "发送中" or
///   "没能确认是否送到 · 重发". Showing the page clears its error (`clear_attention`), and again
///   when the app comes back to the foreground. Short notes ("已停止", a failed action) show as a
///   toast for 1.9 s.
struct SessionPage: View {
  /// The session.
  let sessionId: SessionId
  /// The connection's sync.
  @Environment(SyncModel.self) private var sync: SyncModel?
  /// Goes back to the home.
  @Environment(\.dismiss) private var dismiss
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether the app is in front.
  @Environment(\.scenePhase) private var phase
  /// Whether the queue sheet is open.
  @State private var showingQueue = false
  /// The toast showing, if any.
  @State private var toast: String?

  /// The page.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let state = sync?.core.sessions[sessionId]
    let controls = SessionControls(
      control: state?.control, running: state?.running ?? false, connected: sync?.status == .connected)
    let lastTurn = state?.items.last { if case .turn = $0 { true } else { false } }?.id
    ScrollView {
      LazyVStack(alignment: .leading, spacing: Metrics.md) {
        if sync?.core.stale == true {
          Text("不是最新").font(Typography.meta).foregroundStyle(palette.tertiary)
        }
        if state?.hasOlder == true {
          Text("更早的在 Mac 上看").font(Typography.meta).foregroundStyle(palette.tertiary)
        }
        ForEach(state?.items ?? [], id: \.id) { item in
          switch item {
          case .turn(let turn):
            TurnView(layout: TurnLayout(turn), retry: turn.id == lastTurn ? { retry() } : nil).id(turn.id)
          case .notice(let notice):
            Text(Self.label(notice)).font(Typography.meta).foregroundStyle(palette.tertiary)
          }
        }
        ForEach(sync?.core.outbox.filter { $0.sessionId == sessionId } ?? []) { message in
          PendingBubble(message: message) { sync?.resend(message.id) }
        }
        if let failure = controls.failure {
          ErrorCard(text: failure, detail: nil) { retry() }
        }
        if controls.restarting {
          Text("正在重启 pi").font(Typography.meta).foregroundStyle(palette.secondary)
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
      .padding(.top, Metrics.glassButton + Metrics.lg)
      .padding(.bottom, Metrics.xl)
    }
    .defaultScrollAnchor(.bottom)
    .background(palette.page.ignoresSafeArea())
    .overlay(alignment: .top) { topBar(palette) }
    .hidingNavigationBar()
    .safeAreaInset(edge: .bottom) {
      if let sync {
        SessionDock(
          sessionId: sessionId, sync: sync, showQueue: { showingQueue = true }, showChildren: nil,
          children: 0, toast: { toast = $0 })
      }
    }
    .overlay(alignment: .top) { toastView(palette) }
    .sheet(isPresented: $showingQueue) {
      if let sync { QueueSheet(sessionId: sessionId, sync: sync) }
    }
    .onAppear {
      sync?.open(sessionId)
      sync?.clearAttention(sessionId)
    }
    .onDisappear { sync?.close(sessionId) }
    .onChange(of: phase) { if phase == .active { sync?.clearAttention(sessionId) } }
    .onChange(of: sync?.status) { sync?.clearAttention(sessionId) }
    .onChange(of: sync?.core.actionProblems[sessionId]) {
      guard let problem = sync?.core.actionProblems[sessionId] else { return }
      toast = SessionControls.problemText(problem)
      sync?.dismissActionProblem(in: sessionId)
    }
    .task(id: toast) {
      guard toast != nil else { return }
      try? await ContinuousClock().sleep(for: .seconds(1.9))
      if !Task.isCancelled { toast = nil }
    }
  }

  /// Retries the session's last run.
  ///
  /// - Remark: The error card's "重试".
  /// - SideEffects: Queues `retry_run`.
  private func retry() {
    sync?.perform(.retryRun, in: sessionId)
  }

  /// The toast at the top, if one shows.
  ///
  /// - Remark: The prototype's toast: glass, 38pt high, 13.5pt, under the top bar.
  /// - SideEffects: none
  /// - Parameter palette: The colours.
  /// - Returns: The toast.
  @ViewBuilder
  private func toastView(_ palette: Palette) -> some View {
    if let toast {
      Text(toast)
        .font(.system(size: 13.5))
        .foregroundStyle(palette.text)
        .padding(.horizontal, Metrics.md)
        .frame(height: 38)
        .atriumGlass(in: Capsule())
        .padding(.top, 62)
        .transition(.opacity.combined(with: .scale(scale: 0.92)))
        .accessibilityIdentifier("session.toast")
    }
  }

  /// The floating bar at the top: back, the title and where the session is.
  ///
  /// - Remark: The prototype's top bar: a 44pt glass back button, the title (15pt semibold) and
  ///   "项目 · 分支" (11.5pt) centred, over a fade of the page colour.
  /// - SideEffects: none
  /// - Parameter palette: The colours.
  /// - Returns: The bar.
  private func topBar(_ palette: Palette) -> some View {
    let summary = sync?.core.index.sessions.first { $0.sessionId == sessionId }
    return ZStack {
      VStack(spacing: 1) {
        Text(summary.map(HomeList.title(of:)) ?? "")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(palette.text)
          .lineLimit(1)
          .accessibilityIdentifier("session.title")
        if let summary, let index = sync?.core.index {
          Text(HomeList.place(of: summary.containerId, in: index))
            .font(.system(size: 11.5))
            .foregroundStyle(palette.secondary)
            .lineLimit(1)
        }
      }
      .padding(.horizontal, Metrics.glassButton + Metrics.md + Metrics.xs)
      GlassCircleButton(systemImage: "chevron.left", label: "返回") { dismiss() }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, Metrics.md)
        .accessibilityIdentifier("session.back")
    }
    .frame(height: 56)
    .background(
      LinearGradient(
        stops: [.init(color: palette.page, location: 0.8), .init(color: palette.page.opacity(0), location: 1)],
        startPoint: .top, endPoint: .bottom
      )
      .padding(.bottom, -Metrics.md)
      .ignoresSafeArea(edges: .top))
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
