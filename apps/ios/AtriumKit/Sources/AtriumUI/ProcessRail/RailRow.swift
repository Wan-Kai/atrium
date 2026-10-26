/// One row of a turn's process as the rail draws it (design-language "消息流 · 过程轨道").
///
/// - Remark: The display model between the protocol's steps and the view, so the view knows
///   nothing of tools and the mapping is tested on its own (`RailRows`). Same rows, nodes and words
///   as the desktop (`packages/ui/src/chat/turn-layout.ts`, `steps.tsx`).
nonisolated struct RailRow: Identifiable, Equatable, Sendable {
  /// What stands on the rail for the row.
  ///
  /// - Remark: The desktop's `RailNode`, without the new-workspace ones the phone does not show.
  enum Node: Equatable, Sendable {
    /// Done: a 6pt dot in `--node`.
    case dot
    /// Text the agent said mid-turn: a 7pt accent dot.
    case said
    /// Read-only calls folded into one row: a 14pt magnifier.
    case search
    /// Going on: an accent dot with a turning, open arc.
    case live
    /// A failed call: × off the main line, x = 19.5.
    case dead
    /// You or the main agent cut in: a hollow accent ring off the main line, x = 19.5.
    case steer
    /// The context was compacted: two ticks across the line.
    case compaction
    /// The agent asked you: an orange dot.
    case ask
    /// The agent waits for your answer: an orange dot with a ring spreading out.
    case asking
  }

  /// How the right-hand end reads.
  ///
  /// - Remark: An edit's counts are coloured; a failure is red; the rest is quiet.
  enum EndTone: Equatable, Sendable {
    /// `--l2`.
    case quiet
    /// `--danger`.
    case bad
    /// "+N −M": added green, removed red.
    case counts(added: Int, removed: Int)
  }

  /// The step's id, or the first one's for a folded group.
  let id: String
  /// The node.
  let node: Node
  /// What was done: "运行了", "编辑了".
  let verb: String
  /// To what: a path, a command, the opening of a text; may be empty.
  var object: String = ""
  /// Whether the object is code (commands), shown in mono.
  var objectIsCode = false
  /// How it ended, on the right: "通过", "失败", or counts.
  var end: String?
  /// How the end reads.
  var endTone: EndTone = .quiet

  /// Full plain-text content, revealed by opening this row.
  var detail: String?
  /// Each question and its answer, always visible while the rail is open.
  var answers: [String] = []

  /// Whether the node sits off the main line, at x = 19.5.
  var isBranch: Bool { node == .dead || node == .steer }
}
