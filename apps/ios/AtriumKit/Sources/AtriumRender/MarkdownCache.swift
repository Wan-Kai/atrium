import Synchronization

/// Parsed replies by their text, so a reply parsed ahead lays out whole the moment it shows.
///
/// - Remark: Older turns fetched on scrolling up are parsed here before they are put in front of
///   the conversation; otherwise their replies show empty and grow a frame later, moving what you
///   read (SPEC-0005 "MP4a 定的细节" 9). Bounded: the oldest text goes past `limit`.
public final class MarkdownCache: Sendable {
  /// The one the app uses.
  public static let shared = MarkdownCache(limit: 64)
  /// The most texts kept.
  public let limit: Int
  /// Texts in the order stored, and their blocks.
  private let state = Mutex<(order: [String], blocks: [String: [MarkdownBlock]])>(([], [:]))

  /// Makes an empty cache.
  ///
  /// - Remark: Tests make small ones.
  /// - SideEffects: none
  /// - Parameter limit: The most texts kept.
  public init(limit: Int) {
    self.limit = limit
  }

  /// The blocks of a text parsed before, if any.
  ///
  /// - Remark: Any thread.
  /// - SideEffects: none
  /// - Parameter text: The full reply.
  /// - Returns: Its blocks, or `nil`.
  public func blocks(for text: String) -> [MarkdownBlock]? {
    state.withLock { $0.blocks[text] }
  }

  /// Keeps a text's blocks.
  ///
  /// - Remark: Storing a text again keeps its place.
  /// - SideEffects: Stores; drops the oldest past the limit.
  /// - Parameters:
  ///   - blocks: The parsed blocks.
  ///   - text: The full reply.
  public func store(_ blocks: [MarkdownBlock], for text: String) {
    state.withLock { state in
      if state.blocks.updateValue(blocks, forKey: text) == nil { state.order.append(text) }
      while state.order.count > limit { state.blocks[state.order.removeFirst()] = nil }
    }
  }

  /// Parses the texts not kept yet, off the caller's actor, and keeps them.
  ///
  /// - Remark: The same parse a finished reply gets (`StreamingMarkdown.parse`).
  /// - SideEffects: Parses on a background task; stores.
  /// - Parameter texts: Full replies.
  public func warm(_ texts: [String]) async {
    let missing = texts.filter { blocks(for: $0) == nil }
    guard !missing.isEmpty else { return }
    let parsing = Task.detached(priority: .userInitiated) { missing.map { ($0, StreamingMarkdown.parse($0)) } }
    let parsed = await parsing.value
    for (text, blocks) in parsed { store(blocks, for: text) }
  }
}
