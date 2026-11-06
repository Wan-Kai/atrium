import Foundation
import Markdown

/// One top-level block of a reply, ready to draw (SPEC-0005 "渲染").
///
/// - Remark: The display model between swift-markdown's tree and the SwiftUI views, so the views
///   know nothing of the parser and frozen blocks compare cheaply (`Equatable`) and skip redrawing.
///   Inline content is an `AttributedString` with Foundation's semantic attributes (emphasis,
///   strong, code, strikethrough, link); AtriumUI picks fonts and colours for them. Mermaid and
///   PlantUML are their own case: the phone shows their source and "在 Mac 上查看".
public indirect enum MarkdownBlock: Equatable, Sendable {
  /// A paragraph.
  case paragraph(AttributedString)
  /// A heading, level 1 to 6.
  case heading(level: Int, AttributedString)
  /// A fenced or indented code block; `closed` is false while its closing fence has not arrived.
  case code(language: String?, code: String, closed: Bool)
  /// A Mermaid or PlantUML block, shown as source.
  case diagram(language: String, source: String)
  /// An inline visual's reference (SPEC-0007): the phone shows a card with the file's name only.
  case visual(name: String)
  /// A list; each item's blocks, and its task checkbox if it has one.
  case list(ordered: Bool, start: Int, items: [ListItem])
  /// A block quote.
  case quote([MarkdownBlock])
  /// A table: the header's cells, the rows' cells, and each column's alignment.
  case table(header: [AttributedString], rows: [[AttributedString]], alignments: [TableAlignment])
  /// A thematic break.
  case rule
  /// Raw HTML, shown as its text (never rendered as HTML).
  case html(String)

  /// One item of a list.
  ///
  /// - Remark: Its blocks may themselves be lists.
  public struct ListItem: Equatable, Sendable {
    /// `nil` for a plain item, else whether its task box is ticked.
    public let checked: Bool?
    /// What the item holds.
    public let blocks: [MarkdownBlock]
  }

  /// How a table column lines up.
  ///
  /// - Remark: GFM's `:---`, `:---:`, `---:`; none is leading.
  public enum TableAlignment: Equatable, Sendable {
    /// Left, the default.
    case leading
    /// Centred.
    case center
    /// Right.
    case trailing
  }

  /// Converts a parsed block.
  ///
  /// - Remark: Unknown block kinds (directives, which are not parsed here) fall back to their text,
  ///   so nothing is lost.
  /// - SideEffects: none
  /// - Parameters:
  ///   - markup: A block from swift-markdown.
  ///   - source: The UTF-8 bytes it was parsed from, to tell whether a code fence closed.
  ///   - lineStarts: Where each line of `source` starts.
  init(_ markup: any Markup, source: ArraySlice<UInt8>, lineStarts: [Int]) {
    switch markup {
    case let paragraph as Paragraph:
      self = .paragraph(Self.inline(paragraph.children))
    case let heading as Heading:
      self = .heading(level: heading.level, Self.inline(heading.children))
    case let code as CodeBlock:
      let language = code.language?.split(separator: " ").first.map(String.init)
      let body = code.code.hasSuffix("\n") ? String(code.code.dropLast()) : code.code
      if let language, ["mermaid", "plantuml", "puml"].contains(language.lowercased()) {
        self = .diagram(language: language.lowercased(), source: body)
      } else if language?.lowercased() == "visual", let name = Self.visualName(body) {
        self = .visual(name: name)
      } else {
        self = .code(
          language: language, code: body, closed: Self.fenceClosed(code, source: source, lineStarts: lineStarts))
      }
    case let list as OrderedList:
      self = .list(ordered: true, start: Int(list.startIndex), items: Self.items(list.children, source, lineStarts))
    case let list as UnorderedList:
      self = .list(ordered: false, start: 1, items: Self.items(list.children, source, lineStarts))
    case let quote as BlockQuote:
      self = .quote(quote.children.map { MarkdownBlock($0, source: source, lineStarts: lineStarts) })
    case let table as Table:
      let header = table.head.children.map { Self.inline($0.children) }
      let rows = table.body.children.map { row in row.children.map { Self.inline($0.children) } }
      let alignments: [TableAlignment] = table.columnAlignments.map {
        switch $0 {
        case .center: .center
        case .right: .trailing
        default: .leading
        }
      }
      self = .table(header: header, rows: rows, alignments: alignments)
    case is ThematicBreak:
      self = .rule
    case let html as HTMLBlock:
      self = .html(html.rawHTML)
    default:
      self = .paragraph(AttributedString(markup.format()))
    }
  }

  /// The file name of a `visual` block's path, if the block is one.
  ///
  /// - Remark: The block is one line of JSON with a `path` (SPEC-0007, "接口与数据"); the phone
  ///   neither renders nor fetches the visual, so only the name is kept. Anything else stays code.
  /// - SideEffects: none
  /// - Parameter body: The block's text.
  /// - Returns: The name, or `nil`.
  private static func visualName(_ body: String) -> String? {
    guard let data = body.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let path = object["path"] as? String, !path.isEmpty
    else { return nil }
    let name = path.split(separator: "/").last.map(String.init) ?? path
    return name.isEmpty ? nil : name
  }

  /// A list's items.
  ///
  /// - Remark: See `init(_:source:lineStarts:)`.
  /// - SideEffects: none
  /// - Parameters:
  ///   - children: The list's children.
  ///   - source: The bytes.
  ///   - lineStarts: Line starts.
  /// - Returns: The items.
  private static func items(_ children: MarkupChildren, _ source: ArraySlice<UInt8>, _ lineStarts: [Int])
    -> [ListItem]
  {
    children.compactMap { child in
      guard let item = child as? Markdown.ListItem else { return nil }
      let checked: Bool? = item.checkbox.map { $0 == .checked }
      return ListItem(
        checked: checked, blocks: item.children.map { MarkdownBlock($0, source: source, lineStarts: lineStarts) })
    }
  }

  /// Whether a code block's closing fence has arrived.
  ///
  /// - Remark: A fenced block's parsed literal excludes the opener and, only when present, the
  ///   closer. Compare its line count with the parser's source span instead of imposing the opener's
  ///   indentation on the closer. Container bounds exclude a following line outside the quote/list.
  ///   A literal covering the whole span is indented code, even when it begins with backticks.
  /// - SideEffects: none
  /// - Parameters:
  ///   - code: The block.
  ///   - source: The bytes.
  ///   - lineStarts: Line starts.
  /// - Returns: Whether it is closed.
  private static func fenceClosed(_ code: CodeBlock, source: ArraySlice<UInt8>, lineStarts: [Int]) -> Bool {
    guard let range = code.range else { return true }
    let column = max(0, range.lowerBound.column - 1)
    let firstBytes = line(range.lowerBound.line, source, lineStarts).utf8.dropFirst(column)
    let first = String(decoding: firstBytes, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    guard first.hasPrefix("```") || first.hasPrefix("~~~") else { return true }
    var endLine = range.upperBound.line
    var parent = code.parent
    while let ancestor = parent {
      if let enclosing = ancestor.range { endLine = min(endLine, enclosing.upperBound.line) }
      parent = ancestor.parent
    }
    let sourceLines = endLine - range.lowerBound.line + 1
    let literalLines = code.code.utf8.filter { $0 == 10 }.count
    return sourceLines <= literalLines || sourceLines == literalLines + 2
  }

  /// One line of the source, 1-based.
  ///
  /// - Remark: Without its newline; empty past the end.
  /// - SideEffects: none
  /// - Parameters:
  ///   - number: The line's number.
  ///   - source: The bytes.
  ///   - lineStarts: Line starts.
  /// - Returns: The line.
  private static func line(_ number: Int, _ source: ArraySlice<UInt8>, _ lineStarts: [Int]) -> String {
    guard number >= 1, number <= lineStarts.count else { return "" }
    let start = source.startIndex + lineStarts[number - 1]
    let end = number < lineStarts.count ? source.startIndex + lineStarts[number] : source.endIndex
    return String(decoding: source[start..<end], as: UTF8.self)
  }

  /// Converts inline content into an attributed string with semantic attributes.
  ///
  /// - Remark: Soft breaks become spaces, as CommonMark renders them; images show their alt text
  ///   (the phone does not load images from replies); inline HTML stays text.
  /// - SideEffects: none
  /// - Parameter children: The inline nodes.
  /// - Returns: The text.
  static func inline(_ children: MarkupChildren) -> AttributedString {
    var result = AttributedString()
    for child in children { result += inline(child) }
    return result
  }

  /// Converts one inline node.
  ///
  /// - Remark: See `inline(_:)` for a sequence.
  /// - SideEffects: none
  /// - Parameter markup: The node.
  /// - Returns: The text.
  private static func inline(_ markup: any Markup) -> AttributedString {
    switch markup {
    case let text as Markdown.Text: return AttributedString(text.string)
    case is SoftBreak: return AttributedString(" ")
    case is LineBreak: return AttributedString("\n")
    case let code as InlineCode: return styled(AttributedString(code.code), .code)
    case let emphasis as Emphasis: return styled(inline(emphasis.children), .emphasized)
    case let strong as Strong: return styled(inline(strong.children), .stronglyEmphasized)
    case let strike as Strikethrough: return styled(inline(strike.children), .strikethrough)
    case let link as Markdown.Link:
      var text = inline(link.children)
      if let destination = link.destination, let url = URL(string: destination),
        ["https", "http"].contains(url.scheme?.lowercased() ?? "")
      {
        text.link = url
      }
      return text
    case let image as Markdown.Image:
      let alt = String(inline(image.children).characters)
      return AttributedString("[图片\(alt.isEmpty ? "" : "：\(alt)")]")
    case let html as InlineHTML: return AttributedString(html.rawHTML)
    default: return AttributedString(markup.format())
    }
  }

  /// Adds an inline intent to every run of a text, keeping the ones it has.
  ///
  /// - Remark: Nested emphasis and strong combine.
  /// - SideEffects: none
  /// - Parameters:
  ///   - text: The text.
  ///   - intent: The intent to add.
  /// - Returns: The text.
  private static func styled(_ text: AttributedString, _ intent: InlinePresentationIntent) -> AttributedString {
    var styled = text
    for run in styled.runs {
      styled[run.range].inlinePresentationIntent = (run.inlinePresentationIntent ?? []).union(intent)
    }
    return styled
  }
}
