import AtriumProtocol
import Foundation
import Testing

@testable import AtriumUI

/// Notices with the given ids, as transcript items.
///
/// - Remark: The cheapest items to make; the place keeping only looks at ids.
/// - SideEffects: none
/// - Parameter ids: The ids, oldest first.
/// - Returns: The items.
/// - Throws: When the sample does not decode.
private func items(_ ids: [String]) throws -> [TranscriptItem] {
  try ids.map { id in
    let json =
      #"{"kind":"notice","id":"\#(id)","notice":"compacted","tokensBefore":1,"tokensAfter":null,"summary":"","timestamp":0}"#
    return try JSONDecoder().decode(TranscriptItem.self, from: Data(json.utf8))
  }
}

/// Loading older turns on the session page: how they are laid out, when they are fetched, and how
/// what you read stays in place (SPEC-0005 "MP4a 定的细节" 9).
@Suite("Older turns on the page")
@MainActor
struct OlderPlaceTests {
  /// Checks each fetched batch becomes one block, newest-fetched first, and the rest stays lazy.
  ///
  /// - Remark: Counts that do not fit leave everything lazy rather than cutting wrongly.
  /// - SideEffects: none
  /// - Throws: When the samples do not decode.
  @Test("each fetched batch is one block, the rest stays lazy")
  func splitsBatches() throws {
    let all = try items(["a", "b", "c", "d", "e", "f"])
    let layout = OlderLayout(items: all, batches: [1, 2])
    #expect(layout.blocks.map { $0.map(\.id) } == [["a"], ["b", "c"]])
    #expect(layout.rest.map(\.id) == ["d", "e", "f"])
    #expect(OlderLayout(items: all, batches: []).rest.count == 6)
    #expect(OlderLayout(items: all, batches: [7]).blocks.isEmpty)
    #expect(OlderLayout(items: all, batches: [7]).rest.count == 6)
    #expect(OlderLayout(items: all, batches: [0, 2]).blocks.isEmpty)
  }

  /// Checks a fetch starts when the top row comes on screen while connected, not otherwise.
  ///
  /// - Remark: The end of a fetch is no reason to fetch again.
  /// - SideEffects: none
  @Test("fetches when the top row shows while connected")
  func fetchesWhenTheRowShows() {
    #expect(OlderWant(visible: true, connected: true).fetches)
    #expect(!OlderWant(visible: false, connected: true).fetches)
    #expect(!OlderWant(visible: true, connected: false).fetches)
  }

  /// Checks the first item is held where it was once a batch comes in front of it, and followed
  /// as the batch grows.
  ///
  /// - Remark: The offset moves by however far the item went down, and only vertically.
  /// - SideEffects: none
  /// - Throws: When the samples do not decode.
  @Test("holds the first item where it was and follows it as the batch grows")
  func holdsTheFirstItem() throws {
    let place = PlaceKeeper()
    let before = try items(["d", "e"])
    let after = try items(["a", "b", "c", "d", "e"])
    place.offset = CGPoint(x: 3, y: -1)
    #expect(place.moved("d", top: 102, items: before) == nil)
    #expect(place.moved("e", top: 900, items: before) == nil)
    #expect(place.moved("a", top: 102, items: after) == nil)
    #expect(place.moved("d", top: 508, items: after) == CGPoint(x: 0, y: 405))
    #expect(place.holding)
    #expect(place.moved("d", top: 102, items: after) == nil)
    #expect(place.moved("d", top: 832, items: after) == CGPoint(x: 0, y: 1135))
    #expect(place.moved("a", top: -700, items: after) == nil)
  }

  /// Checks scrolling with a finger lets go, and so does an item that keeps moving or is gone.
  ///
  /// - Remark: The cap stops a layout that changes with the offset from scrolling for ever.
  /// - SideEffects: none
  /// - Throws: When the samples do not decode.
  @Test("a finger, too many moves or a gone item let go")
  func letsGo() throws {
    let before = try items(["d"])
    let after = try items(["c", "d"])
    let finger = PlaceKeeper()
    _ = finger.moved("d", top: 100, items: before)
    #expect(finger.moved("d", top: 300, items: after) != nil)
    finger.userScrolling = true
    #expect(!finger.holding)
    #expect(finger.moved("d", top: 600, items: after) == nil)

    let busy = PlaceKeeper()
    _ = busy.moved("d", top: 100, items: before)
    _ = busy.moved("d", top: 300, items: after)
    for step in 1...PlaceKeeper.maxMoves {
      #expect(busy.moved("d", top: step.isMultiple(of: 2) ? 200 : 0, items: after) != nil)
    }
    #expect(busy.moved("d", top: 200, items: after) == nil)
    #expect(!busy.holding)

    let gone = PlaceKeeper()
    _ = gone.moved("d", top: 100, items: before)
    _ = gone.moved("d", top: 300, items: after)
    #expect(gone.moved("d", top: 500, items: try items(["x"])) == nil)
    #expect(!gone.holding)
  }

  /// Checks nothing moves when the turns before were replaced, or while a finger scrolls.
  ///
  /// - Remark: A new snapshot drops the old first item; a finger means you are moving it yourself.
  /// - SideEffects: none
  /// - Throws: When the samples do not decode.
  @Test("a replaced list or a scrolling finger moves nothing")
  func leavesOtherChangesAlone() throws {
    let replaced = PlaceKeeper()
    _ = replaced.moved("d", top: 100, items: try items(["d"]))
    #expect(replaced.moved("x", top: 400, items: try items(["x", "y"])) == nil)
    #expect(replaced.moved("d", top: 400, items: try items(["x", "y"])) == nil)
    #expect(!replaced.holding)

    let scrolling = PlaceKeeper()
    _ = scrolling.moved("d", top: 100, items: try items(["d"]))
    scrolling.userScrolling = true
    #expect(scrolling.moved("d", top: 400, items: try items(["c", "d"])) == nil)
    #expect(!scrolling.holding)
  }
}
