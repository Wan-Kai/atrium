import AtriumRender
import SwiftUI

/// Draws pre-parsed reply blocks directly on the page, with stable equatable block rows.
///
/// - Remark: Parsing belongs to AtriumRender's worker. This view never invokes a parser in body;
///   unchanged blocks compare by value and do not rerender during streaming.
struct MarkdownView: View {
  /// The converted document.
  let blocks: [MarkdownBlock]

  /// The reply, in source order.
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
        MarkdownBlockView(block: block).equatable()
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// Draws one semantic Markdown block using the phone's type and colour tokens.
///
/// - Remark: Blocks are not cards. Code uses the quiet code surface, lists their own 5pt bullet,
///   raw HTML remains text, diagrams stay source. The parser has already removed unsafe links.
private struct MarkdownBlockView: View, Equatable {
  /// Compares model input; SwiftUI independently tracks environment updates.
  ///
  /// - Remark: Environment property wrappers are not Equatable.
  /// - SideEffects: none
  /// - Parameters:
  ///   - lhs: One block view.
  ///   - rhs: The other.
  /// - Returns: Whether their source models agree.
  static func == (lhs: Self, rhs: Self) -> Bool { lhs.block == rhs.block }

  /// The block.
  let block: MarkdownBlock
  /// Current colours.
  @Environment(\.colorScheme) private var scheme

  /// The block's native view.
  var body: some View {
    let palette = Palette(scheme: scheme)
    switch block {
    case .paragraph(let text): inline(text)
    case .heading(let level, let text):
      Text(text).font(.system(size: max(17, 28 - CGFloat(level) * 2), weight: .semibold))
        .foregroundStyle(palette.text)
    case .code(let language, let code, _): CodeBlockView(code: code, language: language)
    case .diagram(let language, let source):
      VStack(alignment: .leading, spacing: 8) {
        CodeBlockView(code: source, language: language)
        Text("在 Mac 上查看").font(Typography.meta).foregroundStyle(palette.secondary)
      }
    case .visual(let name): VisualPlaceholderCard(name: name)
    case .list(let ordered, let start, let items):
      VStack(alignment: .leading, spacing: 4) {
        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
          HStack(alignment: .top, spacing: 8) {
            Group {
              if let checked = item.checked {
                Image(systemName: checked ? "checkmark.square.fill" : "square")
                  .foregroundStyle(checked ? palette.tint : palette.secondary)
              } else if ordered {
                Text("\(start + index).").monospacedDigit()
              } else {
                Circle().frame(width: 5, height: 5).padding(.top, 10)
              }
            }
            .frame(width: 14, alignment: .trailing)
            MarkdownView(blocks: item.blocks)
          }
        }
      }.font(Typography.reply).foregroundStyle(palette.text)
    case .quote(let blocks):
      MarkdownView(blocks: blocks).padding(.leading, 12)
        .overlay(alignment: .leading) { palette.line.frame(width: 2) }
    case .table(let header, let rows, let alignments):
      MarkdownTableView(header: header, rows: rows, alignments: alignments)
    case .rule: palette.line.frame(height: 0.5).padding(.vertical, 8)
    case .html(let source): inline(AttributedString(source))
    }
  }

  /// Applies the reply's inline fonts, preserving nested emphasis and safe links.
  ///
  /// - Remark: Code uses SF Mono; semantic intents remain on other runs for SwiftUI to render.
  /// - SideEffects: none
  /// - Parameter source: Inline semantic text.
  /// - Returns: The text view.
  private func inline(_ source: AttributedString) -> some View {
    var text = source
    let palette = Palette(scheme: scheme)
    for run in source.runs where run.inlinePresentationIntent?.contains(.code) == true {
      text[run.range].font = .system(size: 14, design: .monospaced)
      text[run.range].backgroundColor = palette.surface
    }
    return Text(text).font(Typography.reply)
      .foregroundStyle(palette.text).tint(palette.tint)
      .lineSpacing(16.5 * (Typography.replyLineHeight - 1))
      .frame(maxWidth: .infinity, alignment: .leading)
      .textSelection(.enabled)
  }
}

/// A horizontally scrollable, borderless table with a bounded initial row count.
///
/// - Remark: Long tables expand into the surrounding conversation, never a second vertical scroller.
///   The first 12 rows are shown until expanded; exact 640pt clipping is left to screen integration.
private struct MarkdownTableView: View {
  /// Header cells.
  let header: [AttributedString]
  /// Body cells.
  let rows: [[AttributedString]]
  /// GFM alignments.
  let alignments: [MarkdownBlock.TableAlignment]
  /// Whether all rows are shown.
  @State private var expanded = false
  /// Current colours.
  @Environment(\.colorScheme) private var scheme

  /// The table and its expansion control.
  var body: some View {
    let palette = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: 8) {
      ScrollView(.horizontal) {
        Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 8) {
          GridRow {
            ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
              Text(cell).fontWeight(.semibold).foregroundStyle(palette.secondary)
            }
          }
          palette.line.frame(height: 1).gridCellUnsizedAxes(.horizontal)
          ForEach(Array(rows.prefix(expanded ? rows.count : 12).enumerated()), id: \.offset) { _, row in
            GridRow {
              ForEach(Array(row.enumerated()), id: \.offset) { index, cell in
                Text(cell).gridColumnAlignment(alignment(index))
              }
            }
          }
        }.font(Typography.meta).foregroundStyle(palette.text2)
      }
      if rows.count > 12 {
        Button(expanded ? "收起" : "还有 \(rows.count - 12) 行") { expanded.toggle() }
          .font(Typography.meta).foregroundStyle(palette.secondary)
      }
    }
  }

  /// Maps the protocol-independent alignment to SwiftUI.
  ///
  /// - Remark: Missing alignments are leading, as GFM specifies.
  /// - SideEffects: none
  /// - Parameter index: Column index.
  /// - Returns: The grid alignment.
  private func alignment(_ index: Int) -> HorizontalAlignment {
    guard index < alignments.count else { return .leading }
    return switch alignments[index] {
    case .leading: .leading
    case .center: .center
    case .trailing: .trailing
    }
  }
}
