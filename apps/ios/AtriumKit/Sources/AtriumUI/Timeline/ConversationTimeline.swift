import AtriumRender
import SwiftUI

/// One cached conversation row, identified independently of its changing text.
///
/// - Remark: A screen maps transcript items to rows off the UI body; the renderer does not own sync
///   state. Stable ids preserve scroll identity when the current reply grows.
struct TimelineRow: Identifiable, Equatable, Sendable {
  /// The transcript item's id.
  let id: String
  /// The user's text, if this row starts a turn.
  let user: String
  /// Pre-parsed response blocks.
  let blocks: [MarkdownBlock]
}

/// A recycled List timeline with placing, following and reading-history scroll states.
///
/// - Remark: List is the provisional native choice in SPEC-0005. The debug gallery can compare
///   the same rows in LazyVStack. User scroll phases, not content-driven scroll geometry changes,
///   switch follow state. A screen supplies prepared rows and a revision when the tail grows.
struct ConversationTimeline: View {
  /// The prepared transcript rows.
  let rows: [TimelineRow]
  /// Changes whenever visible content grows, even inside the last row.
  let revision: Int
  /// Whether to use the comparison container, only set by the Debug benchmark.
  var compareStack = false
  /// Scroll policy.
  @State private var follow = TimelineFollow()
  /// Whether a scroll gesture or its deceleration is in progress.
  @State private var scrollingByPerson = false
  /// Current colours.
  @Environment(\.colorScheme) private var scheme

  /// The timeline and its return-to-end affordance.
  var body: some View {
    ScrollViewReader { proxy in
      Group {
        if compareStack {
          ScrollView {
            LazyVStack(spacing: 24) {
              ForEach(rows) { row in TimelineRowView(row: row).equatable().id(row.id) }
            }.padding(.horizontal, Metrics.page)
          }
        } else {
          List(rows) { row in
            TimelineRowView(row: row).equatable().id(row.id)
              .listRowSeparator(.hidden).listRowBackground(Color.clear)
              .listRowInsets(EdgeInsets(top: 12, leading: Metrics.page, bottom: 12, trailing: Metrics.page))
          }
          .listStyle(.plain).scrollContentBackground(.hidden)
        }
      }
      .onScrollPhaseChange { _, phase in
        scrollingByPerson = phase == .tracking || phase == .interacting || phase == .decelerating
      }
      .onScrollGeometryChange(for: CGFloat.self) { geometry in
        geometry.contentSize.height + geometry.contentInsets.bottom - geometry.visibleRect.maxY
      } action: { _, distance in
        if scrollingByPerson { follow.scrolledByPerson(distanceFromEnd: distance) }
      }
      .task {
        await Task.yield()
        proxy.scrollTo(rows.last?.id, anchor: .bottom)
        follow.placed()
      }
      .onChange(of: revision) {
        if follow.contentGrew() { proxy.scrollTo(rows.last?.id, anchor: .bottom) }
      }
      .overlay(alignment: .bottomTrailing) {
        if follow.mode == .reading {
          GlassCircleButton(systemImage: "arrow.down", label: follow.unseen ? "有新内容，回到底部" : "回到底部") {
            follow.jumpedToEnd()
            proxy.scrollTo(rows.last?.id, anchor: .bottom)
          }.padding(Metrics.page)
        }
      }
    }
    .background(Palette(scheme: scheme).page)
  }
}

/// A stable, equatable transcript row that paints only when its model or environment changes.
///
/// - Remark: The user bubble and reply share the page, without a containing card or divider.
private struct TimelineRowView: View, Equatable {
  /// The complete row model.
  let row: TimelineRow
  /// Current colours.
  @Environment(\.colorScheme) private var scheme

  /// Compares row input while leaving environment invalidation to SwiftUI.
  ///
  /// - Remark: Environment wrappers are not Equatable.
  /// - SideEffects: none
  /// - Parameters:
  ///   - lhs: One row.
  ///   - rhs: The other row.
  /// - Returns: Whether their models are equal.
  static func == (lhs: Self, rhs: Self) -> Bool { lhs.row == rhs.row }

  /// The bubble followed by the response.
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if !row.user.isEmpty {
        HStack {
          Spacer(minLength: 40)
          Text(row.user).font(Typography.reply).padding(14)
            .background(Palette(scheme: scheme).surface, in: RoundedRectangle(cornerRadius: Metrics.radiusBubble))
        }
      }
      MarkdownView(blocks: row.blocks)
    }.foregroundStyle(Palette(scheme: scheme).text)
  }
}
