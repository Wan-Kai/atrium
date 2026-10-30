import AtriumProtocol
import SwiftUI

/// The top row of a conversation that has older turns on the Mac: a small spinner and "正在载入更早的"
/// while they load, empty otherwise.
///
/// - Remark: SPEC-0005 "MP4a 定的细节" 9 (prototype A). The page fetches when this row shows, so it
///   keeps its height when empty and the content does not jump when the spinner comes.
struct OlderRow: View {
  /// Whether older turns are on their way.
  let loading: Bool
  @Environment(\.colorScheme) private var scheme

  /// The row.
  ///
  /// - Remark: Centred, in the meta size, like the page's other notices.
  /// - SideEffects: none
  var body: some View {
    let palette = Palette(scheme: scheme)
    HStack(spacing: 6) {
      if loading {
        ProgressView().controlSize(.mini).frame(width: 12, height: 12)
        Text("正在载入更早的").font(Typography.meta).foregroundStyle(palette.tertiary)
      }
    }
    .frame(maxWidth: .infinity, minHeight: 18)
    .accessibilityElement(children: .combine)
  }
}

/// When the page fetches older turns: the top row shows while connected and up to date.
///
/// - Remark: A change of any field starts a fetch when it `fetches`. The end of a fetch does not,
///   so turns that came in front and pushed the row off screen are not followed by another fetch at
///   once. A new copy of the conversation does: a fetch sent from the phone's cached copy is
///   refused once the Mac's snapshot replaces it, and the row is still on screen (SPEC-0005 "MP4a
///   定的细节" 9).
struct OlderWant: Equatable {
  /// Whether the top row is on screen.
  let visible: Bool
  /// Whether the phone is connected.
  let connected: Bool
  /// Whether the conversation is up to date: not loading, not waiting to resume.
  let settled: Bool
  /// The epoch of the copy the phone has; `nil` before one.
  let epoch: Int?
  /// Whether to fetch.
  var fetches: Bool { visible && connected && settled }
}

/// Keeps the conversation's first item in place on screen when older turns are put in front of it.
///
/// - Remark: The scroll view keeps its offset from the top, so turns put in front would push what
///   you read down and leave the top row on screen to fetch again (SPEC-0005 "MP4a 定的细节" 9).
///   The first item's top is recorded while it is first; once a batch is in front of it, it is held
///   at that top: every time it moves, the offset follows, until you scroll yourself. Held, not
///   moved once, because the turns put in front keep growing for a few frames as their Markdown is
///   laid out. A class, not state: it changes on every scroll frame and draws nothing.
@MainActor
final class PlaceKeeper {
  /// The first item while nothing had been put in front of it.
  private var first: String?
  /// Its top in the scroll view, last measured while it was first.
  private var top: CGFloat?
  /// The item being held, and the top it is held at.
  private var held: (id: String, top: CGFloat)?
  /// Moves made for the held item; past `maxMoves` it is let go, so a layout that keeps changing
  /// with the offset cannot keep it scrolling.
  private var moves = 0
  /// The most moves for one held item.
  static let maxMoves = 30
  /// Where the scroll view is, as a scroll position's point: the content offset without the insets.
  var offset = CGPoint.zero
  /// Whether an item is being held in place.
  var holding: Bool { held != nil }
  /// Whether your finger is scrolling; that lets go of the held item.
  var userScrolling = false {
    didSet { if userScrolling { held = nil } }
  }

  /// Takes one item's top as measured and says where to scroll to keep the held item in place.
  ///
  /// - Remark: Only the tracked and held items count. A first item that is gone, as after a new
  ///   snapshot, starts afresh. The offset is taken as moved at once, so a second measure before
  ///   the scroll view reports does not move it twice.
  /// - SideEffects: Records the measure.
  /// - Parameters:
  ///   - id: The measured item.
  ///   - top: Its top in the scroll view.
  ///   - items: The conversation's items now.
  /// - Returns: The point to scroll to, or `nil` to leave it.
  func moved(_ id: String, top: CGFloat, items: [TranscriptItem]) -> CGPoint? {
    if let held, held.id == id {
      moves += 1
      guard items.contains(where: { $0.id == id }), moves <= Self.maxMoves else {
        self.held = nil
        return nil
      }
      return follow(top - held.top)
    }
    let current = items.first?.id
    if first == nil || !items.contains(where: { $0.id == first }) {
      first = current
      self.top = nil
    }
    guard id == first else { return nil }
    if current == first {
      self.top = top
      return nil
    }
    first = current
    defer { self.top = nil }
    guard let before = self.top, !userScrolling else { return nil }
    held = (id, before)
    moves = 0
    return follow(top - before)
  }

  /// The point that moves the content by `distance`, if it is more than a rounding error.
  ///
  /// - Remark: Records the new offset at once.
  /// - SideEffects: Records the offset.
  /// - Parameter distance: How far the held item went down.
  /// - Returns: The point, or `nil`.
  private func follow(_ distance: CGFloat) -> CGPoint? {
    guard abs(distance) > 0.5 else { return nil }
    offset = CGPoint(x: 0, y: offset.y + distance)
    return offset
  }
}

/// The conversation's items as laid out: each fetched batch of older ones as one block, then the rest.
///
/// - Remark: Blocks newest-fetched first, as `SessionState.olderBatches` counts them; counts that do
///   not fit the items leave everything in `rest`.
struct OlderLayout {
  /// The fetched batches, each laid out whole.
  let blocks: [[TranscriptItem]]
  /// The items after them, laid out lazily.
  let rest: [TranscriptItem]

  /// Splits the items by the batch sizes.
  ///
  /// - Remark: Pure.
  /// - SideEffects: none
  /// - Parameters:
  ///   - items: The conversation's items, oldest first.
  ///   - batches: How many items each fetch put in front, the latest first.
  init(items: [TranscriptItem], batches: [Int]) {
    guard batches.allSatisfy({ $0 > 0 }), batches.reduce(0, +) <= items.count else {
      blocks = []
      rest = items
      return
    }
    var start = 0
    var blocks: [[TranscriptItem]] = []
    for count in batches {
      blocks.append(Array(items[start..<start + count]))
      start += count
    }
    self.blocks = blocks
    rest = Array(items[start...])
  }
}
