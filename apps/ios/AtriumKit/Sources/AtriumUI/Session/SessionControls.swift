import AtriumProtocol
import AtriumSync

/// What a session's run control shows around the input: its placeholder, the stop key, the banner
/// and the queue.
///
/// - Remark: SPEC-0005 "MP5 定的细节 · MP5b" after the final prototype, with the states the prototype
///   left out worded there. Worked out from the session's `control` alone, so the page only lays it
///   out. A session without a snapshot yet has no control and shows as idle.
struct SessionControls: Equatable {
  /// The banner over the input.
  ///
  /// - Remark: At most one; a held queue comes before held deliveries.
  enum Banner: Equatable {
    /// You stopped the run and messages wait in the queue.
    case stopped(queued: Int)
    /// pi crashed and messages wait in the queue.
    case crashed(queued: Int)
    /// Notices and tasks wait to be let go.
    case deliveriesHeld(Int)

    /// The banner's words.
    var text: String {
      switch self {
      case .stopped(let queued): "已停止 · 排队的 \(queued) 条暂停了"
      case .crashed(let queued): "pi 崩溃了 · 排队的 \(queued) 条暂停了"
      case .deliveriesHeld(let count): "有 \(count) 项通知暂停了"
      }
    }
  }

  /// The input's placeholder.
  let placeholder: String
  /// Whether the stop key shows.
  let showsStop: Bool
  /// Whether a stop is on its way: the stop key spins and cannot be pressed again.
  let stopping: Bool
  /// Whether a long press on send offers "立即插话".
  let canSteer: Bool
  /// The banner, if any.
  let banner: Banner?
  /// How many messages wait in the host's queue.
  let queued: Int
  /// The crash failure's words, if pi gave up.
  let failure: String?
  /// Whether pi is being started again.
  let restarting: Bool

  /// Works out the controls.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameters:
  ///   - control: The session's run control, `nil` before its snapshot.
  ///   - running: Whether a run goes on.
  ///   - connected: Whether the connection is up and synced.
  init(control: Control?, running: Bool, connected: Bool) {
    let queue = control?.queue.count ?? 0
    queued = queue
    stopping = control?.stopping ?? false
    showsStop = running || stopping
    canSteer = running
    restarting = control?.restarting ?? false
    failure = control?.failure.map { Self.failureText(attempts: $0.attempts) }
    placeholder =
      if !connected { "先写着，连上后再发" } else if control?.question != nil { "直接回复也行：发出后代替回答" } else if running {
        "发送进排队 · 长按插话"
      } else { "发消息" }
    let held = control?.deliveries.count ?? 0
    banner =
      switch control?.paused {
      case .stopped? where queue > 0: .stopped(queued: queue)
      case .crashed? where queue > 0: .crashed(queued: queue)
      default: control?.deliveriesHeld != nil && held > 0 ? .deliveriesHeld(held) : nil
      }
  }

  /// The error card's words when pi crashed too many times in a row.
  ///
  /// - Remark: SPEC-0005 "MP5 定的细节 · MP5b"; the host sends only the count.
  /// - SideEffects: none
  /// - Parameter attempts: How many times it crashed.
  /// - Returns: The words.
  static func failureText(attempts: Int) -> String {
    "pi 连续崩溃 \(attempts) 次，已停下"
  }

  /// Why an action failed, in words: the action and the host's code.
  ///
  /// - Remark: The host sends no words of its own (AGENTS.md).
  /// - SideEffects: none
  /// - Parameter problem: The failure.
  /// - Returns: The toast's words.
  static func problemText(_ problem: ActionProblem) -> String {
    let action =
      switch problem.action {
      case .stop: "停止"
      case .resumeQueue: "继续发送"
      case .clearQueue: "清空排队"
      case .removeQueued: "删除"
      case .steerQueued: "改成插话"
      case .updateQueued: "保存"
      case .retryRun: "重试"
      case .resumeDeliveries: "继续"
      }
    return "\(action)没成功（\(problem.code.rawValue)）"
  }
}
