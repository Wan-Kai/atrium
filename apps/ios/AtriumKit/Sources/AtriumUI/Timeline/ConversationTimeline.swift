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
  /// Stable row references keep content growth from invalidating the whole collection.
  @State private var projection = TimelineRows()
  /// Scroll policy.
  @State private var follow = TimelineFollow()
  /// Whether a finger is held without having begun a scroll.
  @State private var trackingTouch = false
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
              ForEach(projection.items) { row in
                #if DEBUG && os(iOS)
                  let _ = GalleryTimelineStats.rowBuilt()
                #endif
                ObservedTimelineRow(row: row).id(row.id)
              }
            }.padding(.horizontal, Metrics.page)
          }
        } else {
          List(projection.items) { row in
            #if DEBUG && os(iOS)
              let _ = GalleryTimelineStats.rowBuilt()
            #endif
            ObservedTimelineRow(row: row).id(row.id)
              .listRowSeparator(.hidden).listRowBackground(Color.clear)
              .listRowInsets(EdgeInsets(top: 12, leading: Metrics.page, bottom: 12, trailing: Metrics.page))
          }
          .listStyle(.plain).scrollContentBackground(.hidden)
        }
      }
      .onScrollPhaseChange { _, phase in
        trackingTouch = phase == .tracking
        scrollingByPerson = phase == .interacting || phase == .decelerating
        if phase == .idle, follow.interactionEnded(hasRows: !projection.items.isEmpty) {
          proxy.scrollTo(projection.items.last?.id, anchor: .bottom)
        }
      }
      .onScrollGeometryChange(for: Geometry.self) { geometry in
        Geometry(
          contentHeight: geometry.contentSize.height + geometry.contentInsets.bottom,
          viewportHeight: geometry.visibleRect.height,
          distanceFromEnd: geometry.contentSize.height + geometry.contentInsets.bottom - geometry.visibleRect.maxY)
      } action: { old, new in
        let resized = old.contentHeight != new.contentHeight || old.viewportHeight != new.viewportHeight
        if trackingTouch || scrollingByPerson {
          follow.deferLayout(sizeChanged: resized)
          if scrollingByPerson { follow.scrolledByPerson(distanceFromEnd: new.distanceFromEnd) }
        } else if follow.laidOut(hasRows: !projection.items.isEmpty, sizeChanged: resized) {
          proxy.scrollTo(projection.items.last?.id, anchor: .bottom)
        }
      }
      .onChange(of: rows, initial: true) { projection.apply(rows) }
      .onChange(of: revision) {
        // Mark unseen content immediately; actual positioning waits for completed layout above.
        _ = follow.contentGrew()
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

  /// Only geometry that affects the follow policy.
  ///
  /// - Remark: Position-only callbacks from our own scrolling must not issue another scroll.
  private struct Geometry: Equatable {
    let contentHeight: CGFloat
    let viewportHeight: CGFloat
    let distanceFromEnd: CGFloat
  }
}

/// Reads changing content inside the row graph, not in List's identity-building closure.
///
/// - Remark: Reading the observable value in the row builder makes the whole identity traversal
///   depend on it. This boundary lets one row change without rebuilding all siblings.
private struct ObservedTimelineRow: View {
  /// The stable identity and independently observed value.
  let row: TimelineRows.Row

  /// Only this row observes its changing display content.
  var body: some View { TimelineRowView(row: row.value).equatable() }
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
    #if DEBUG && os(iOS)
      let _ = GalleryTimelineStats.bodyEvaluated()
    #endif
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
