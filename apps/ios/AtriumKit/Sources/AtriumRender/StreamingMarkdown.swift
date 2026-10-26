import Markdown

/// Parses growing reply snapshots while retaining blocks before the parser's stable tail boundary.
///
/// - Remark: Source ranges come from cmark, never a home-grown fence splitter. A block can still
///   absorb the preceding block (a partial table row or list marker), so its preceding line must be
///   blank and its own first line complete before earlier blocks freeze. References can resolve
///   backwards; any bracket disables freezing. Completion and replacement reparse everything.
///   This value has no UI dependency; a worker actor owns it, not a SwiftUI body.
public struct StreamingMarkdown: Sendable {
  /// The previous full snapshot.
  private var source = ""
  /// Converted blocks before the mutable tail.
  private var frozen: [MarkdownBlock] = []
  /// Bytes before the mutable tail, measured in the complete snapshot.
  public private(set) var frozenByteCount = 0
  /// Bytes passed to cmark in the latest update, exposed for cache regression tests.
  public private(set) var lastParsedByteCount = 0

  /// Starts with an empty document.
  ///
  /// - Remark: Each reply owns one parser so caches cannot cross messages.
  /// - SideEffects: none
  public init() {}

  /// Parses a complete snapshot received so far.
  ///
  /// - Remark: Retains only stable converted blocks, not a cmark tree or mutable attributed strings.
  /// - SideEffects: Updates this value's source and frozen-block cache.
  /// - Parameters:
  ///   - text: The complete source so far, not a delta.
  ///   - complete: Whether no more source will arrive.
  /// - Returns: Every visible block in source order.
  public mutating func update(_ text: String, complete: Bool = false) -> [MarkdownBlock] {
    let hasReferences = text.contains("[")
    if complete || hasReferences || !text.hasPrefix(source) {
      frozen = []
      frozenByteCount = 0
    }
    source = text
    let bytes = Array(text.utf8)
    let tail = bytes[frozenByteCount...]
    lastParsedByteCount = tail.count
    let starts = Self.lineStarts(tail)
    let document = Document(parsing: String(decoding: tail, as: UTF8.self), options: [.disableSmartOpts])
    let nodes = Array(document.children)
    let blocks = nodes.map { MarkdownBlock($0, source: tail, lineStarts: starts) }
    let result = frozen + blocks
    if !complete && !hasReferences, let boundary = Self.boundary(nodes, tail, starts) {
      frozen += blocks.prefix(boundary.block)
      frozenByteCount += boundary.byte
    }
    return result
  }

  /// Parses without a cache, for static replies and differential tests.
  ///
  /// - Remark: Uses exactly the same options and conversion as incremental parsing.
  /// - SideEffects: none
  /// - Parameter text: The full source.
  /// - Returns: Its blocks.
  public static func parse(_ text: String) -> [MarkdownBlock] {
    var parser = Self()
    return parser.update(text, complete: true)
  }

  /// Computes byte offsets of source lines.
  ///
  /// - Remark: cmark accepts LF, CR and CRLF as line endings. Offsets are UTF-8 bytes, not Swift
  ///   Characters or UTF-16 units; CRLF contributes one source line, never two.
  /// - SideEffects: none
  /// - Parameter bytes: The mutable tail.
  /// - Returns: Zero-based offsets relative to the tail.
  private static func lineStarts(_ bytes: ArraySlice<UInt8>) -> [Int] {
    var starts = [0]
    for index in bytes.indices {
      let byte = bytes[index]
      if byte == 10 {
        starts.append(index - bytes.startIndex + 1)
      } else if byte == 13, index + 1 == bytes.endIndex || bytes[index + 1] != 10 {
        starts.append(index - bytes.startIndex + 1)
      }
    }
    return starts
  }

  /// Finds the last safe top-level block whose predecessors can freeze.
  ///
  /// - Remark: See the type; both the blank predecessor and complete first line are required.
  /// - SideEffects: none
  /// - Parameters:
  ///   - nodes: Top-level cmark nodes.
  ///   - bytes: Tail source bytes.
  ///   - starts: Relative line offsets.
  /// - Returns: The block index and relative byte offset, if a stable boundary exists.
  private static func boundary(_ nodes: [any Markup], _ bytes: ArraySlice<UInt8>, _ starts: [Int])
    -> (block: Int, byte: Int)?
  {
    for index in nodes.indices.reversed() where index > 0 {
      guard let location = nodes[index].range?.lowerBound,
        location.line >= 2, location.line < starts.count
      else { continue }
      let previous = (bytes.startIndex + starts[location.line - 2])..<(bytes.startIndex + starts[location.line - 1])
      if bytes[previous].allSatisfy({ $0 == 32 || $0 == 9 || $0 == 10 || $0 == 13 }) {
        // Preserve indentation: cmark's column for indented code starts after its four spaces.
        return (index, starts[location.line - 1])
      }
    }
    return nil
  }
}
