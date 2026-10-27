#if DEBUG
  import AtriumRender
  import SwiftUI

  /// A small timeline fixture for scroll-policy checks without a timed performance run.
  ///
  /// - Remark: Explicit buttons grow the tail or append a row; tests can exercise observation,
  ///   insertion and history preservation without polling a continuously streaming app.
  struct GalleryTimelineInteraction: View {
    /// Authoritative display snapshot, as a screen would supply it.
    @State private var rows = (0..<40).map { index in
      TimelineRow(id: String(index), user: "问题 \(index)", blocks: [.paragraph(AttributedString("回复 \(index)"))])
    }
    /// A content-change revision for following the tail.
    @State private var revision = 0

    /// The controls remain outside the scroll container.
    var body: some View {
      VStack {
        HStack {
          Button("更新尾行") {
            guard let last = rows.indices.last else { return }
            let grown = (0..<30).map { MarkdownBlock.paragraph(AttributedString("新增内容 \($0)")) }
            rows[last] = TimelineRow(
              id: rows[last].id, user: "最后的问题", blocks: grown + [.paragraph(AttributedString("尾行已更新"))])
            revision += 1
          }.accessibilityIdentifier("timeline.update")
          Button("追加一轮") {
            let id = String(rows.count)
            rows.append(TimelineRow(id: id, user: "新问题 \(id)", blocks: [.paragraph(AttributedString("新回复 \(id)"))]))
            revision += 1
          }.accessibilityIdentifier("timeline.append")
        }.font(Typography.meta).padding(12)
        ConversationTimeline(rows: rows, revision: revision)
      }
    }
  }
#endif
