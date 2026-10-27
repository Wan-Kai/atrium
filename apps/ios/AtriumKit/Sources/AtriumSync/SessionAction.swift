import AtriumProtocol

/// Something the session page asks of a session's run, besides sending a message.
///
/// - Remark: SPEC-0005 "MP5 定的细节 · MP5b": the stop key, the queue sheet, the stopped banner,
///   the error card and the held-deliveries banner. None goes through a receipt: each is safe to
///   send again, and a reconnect resyncs the control it changed.
public enum SessionAction: Sendable, Equatable {
  /// `stop`.
  case stop
  /// `resume_queue`: "继续发送".
  case resumeQueue
  /// `clear_queue`: "清空".
  case clearQueue
  /// `remove_queued` of an item.
  case removeQueued(String)
  /// `steer_queued` of an item: "改成插话".
  case steerQueued(String)
  /// `update_queued` of an item with new text.
  case updateQueued(String, String)
  /// `retry_run`: the error card's "重试".
  case retryRun
  /// `resume_deliveries` of this session only: "继续".
  case resumeDeliveries
}

/// Why the last action on a session failed.
///
/// - Remark: Shown until dismissed or the next action on the session; the host's code only, as the
///   host sends no words of its own (AGENTS.md).
public struct ActionProblem: Sendable, Equatable {
  /// The action.
  public let action: SessionAction
  /// The host's code.
  public let code: ErrorCode

  /// Makes a problem.
  ///
  /// - Remark: Public for tests.
  /// - SideEffects: none
  /// - Parameters:
  ///   - action: The action.
  ///   - code: The host's code.
  public init(action: SessionAction, code: ErrorCode) {
    self.action = action
    self.code = code
  }
}
