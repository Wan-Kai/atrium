/// Serializes one reply's mutable parser away from the main actor.
///
/// - Remark: The UI awaits Sendable block values, not a parser tree, and discards cancelled work.
///   One worker per reply avoids sharing a tail cache across conversations.
public actor MarkdownWorker {
  /// This reply's incremental parser.
  private var parser = StreamingMarkdown()

  /// Creates an empty reply worker.
  ///
  /// - Remark: Its owner is the reply view; there are no tasks or timers to release.
  /// - SideEffects: none
  public init() {}

  /// Parses one visible prefix on the worker's executor.
  ///
  /// - Remark: A cancelled caller must not publish this result after a new snapshot arrives.
  /// - SideEffects: Advances the worker's cache.
  /// - Parameters:
  ///   - text: The visible source prefix.
  ///   - complete: Whether the reply is complete.
  /// - Returns: Sendable display blocks.
  /// - Throws: CancellationError if cancelled before parsing.
  public func parse(_ text: String, complete: Bool) throws -> [MarkdownBlock] {
    try Task.checkCancellation()
    return parser.update(text, complete: complete)
  }
}
