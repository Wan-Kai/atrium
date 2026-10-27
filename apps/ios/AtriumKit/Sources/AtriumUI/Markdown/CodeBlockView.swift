import AtriumRender
import SwiftUI

/// A quiet code surface with horizontally scrolling, syntax-coloured source.
///
/// - Remark: Highlighting runs on the shared actor and is cancelled with the view. While waiting,
///   or for unknown languages, source remains visible. Appearance changes only recolour tokens.
struct CodeBlockView: View {
  /// Exact code text without the parser's synthetic terminal newline.
  let code: String
  /// Fence language, if present.
  let language: String?
  /// Highlighted runs from the worker.
  @State private var tokens: [CodeToken]?
  /// The source those runs describe, to prevent showing stale code on a task change.
  @State private var highlightedSource: String?
  /// Current colours.
  @Environment(\.colorScheme) private var scheme

  /// The code and its unobtrusive language label.
  var body: some View {
    let palette = Palette(scheme: scheme)
    ScrollView(.horizontal) {
      Text(rendered)
        .font(Typography.code).lineSpacing(7.5)
        .fixedSize(horizontal: true, vertical: true)
        .padding(.vertical, 12).padding(.horizontal, 14)
        .textSelection(.enabled)
    }
    .background(palette.code, in: RoundedRectangle(cornerRadius: Metrics.radiusMedium))
    .overlay(alignment: .topTrailing) {
      if let language {
        Text(language).font(.system(size: 11, design: .monospaced))
          .foregroundStyle(palette.secondary).padding(4).background(palette.code)
          .padding(4).allowsHitTesting(false)
      }
    }
    .task(id: code + "\u{0}" + (language ?? "")) {
      guard let language, !DiagramFence.isDiagram(language) else { return }
      let result = await CodeHighlighter.shared.highlight(code, language: language)
      guard !Task.isCancelled else { return }
      tokens = result
      highlightedSource = code
    }
  }

  /// The current code, coloured only if the worker result still describes this snapshot.
  private var rendered: AttributedString {
    if highlightedSource == code, let tokens { return CodeTheme.attributed(tokens, scheme: scheme) }
    var plain = AttributedString(code)
    plain.foregroundColor = Palette(scheme: scheme).text2
    return plain
  }
}
