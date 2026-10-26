import Observation
import Synchronization
import Testing

@testable import AtriumUI

@Suite("Timeline row projection")
struct TimelineRowsTests {
  @Test("180 tail updates notify 180 row changes and zero collection changes across a thousand rows")
  func tailGrowth() {
    let projection = TimelineRows()
    var rows = (0..<1000).map { TimelineRow(id: String($0), user: "question", blocks: []) }
    projection.apply(rows)
    let first = projection.items[0]
    let last = projection.items[999]
    let collections = Mutex(0)
    let values = Mutex(0)
    withObservationTracking {
      _ = projection.items
    } onChange: {
      collections.withLock { $0 += 1 }
    }
    for tick in 0..<180 {
      withObservationTracking {
        _ = last.value
      } onChange: {
        values.withLock { $0 += 1 }
      }
      rows[999] = TimelineRow(id: "999", user: "updated \(tick)", blocks: [])
      projection.apply(rows)
    }
    #expect(projection.items[0] === first)
    #expect(projection.items[999] === last)
    #expect(last.value == rows[999])
    #expect(collections.withLock { $0 } == 0)
    #expect(values.withLock { $0 } == 180)
  }

  @Test("identical snapshots publish nothing")
  func identical() {
    let projection = TimelineRows()
    let rows = [TimelineRow(id: "a", user: "same", blocks: [])]
    projection.apply(rows)
    let changes = Mutex(0)
    withObservationTracking {
      _ = projection.items[0].value
    } onChange: {
      changes.withLock { $0 += 1 }
    }
    projection.apply(rows)
    #expect(changes.withLock { $0 } == 0)
  }

  @Test("insertions removals and reorderings replace order but preserve surviving row identities")
  func structure() {
    let projection = TimelineRows()
    let a = TimelineRow(id: "a", user: "a", blocks: [])
    let b = TimelineRow(id: "b", user: "b", blocks: [])
    let c = TimelineRow(id: "c", user: "c", blocks: [])
    projection.apply([a, b])
    let originalA = projection.items[0]
    let originalB = projection.items[1]
    projection.apply([b, a])
    #expect(projection.items.map(\.id) == ["b", "a"])
    #expect(projection.items[0] === originalB)
    #expect(projection.items[1] === originalA)
    projection.apply([c, b, a])
    #expect(projection.items.map(\.id) == ["c", "b", "a"])
    #expect(projection.items[1] === originalB)
    #expect(projection.items[2] === originalA)
    projection.apply([a])
    #expect(projection.items.count == 1)
    #expect(projection.items[0] === originalA)
    projection.apply([c])
    #expect(projection.items.map(\.id) == ["c"])
    #expect(projection.items[0].value == c)
    projection.apply([])
    #expect(projection.items.isEmpty)
  }

  @Test("removed rows are released rather than retained in a history cache")
  func release() {
    let projection = TimelineRows()
    projection.apply([TimelineRow(id: "a", user: "a", blocks: [])])
    weak let row = projection.items.first
    projection.apply([])
    #expect(row == nil)
  }
}
