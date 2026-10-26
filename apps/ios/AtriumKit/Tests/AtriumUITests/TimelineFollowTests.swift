import Testing

@testable import AtriumUI

@Suite("Timeline follow")
struct TimelineFollowTests {
  @Test("positions only after rows have layout, and follows size changes without interrupting history")
  func layoutTiming() {
    var follow = TimelineFollow()
    let empty = follow.laidOut(hasRows: false, sizeChanged: true)
    #expect(!empty && follow.mode == .placing)
    let first = follow.laidOut(hasRows: true, sizeChanged: true)
    #expect(first && follow.mode == .following)
    let unchanged = follow.laidOut(hasRows: true, sizeChanged: false)
    #expect(!unchanged)
    let grew = follow.laidOut(hasRows: true, sizeChanged: true)
    #expect(grew)
    follow.scrolledByPerson(distanceFromEnd: 200)
    let reading = follow.laidOut(hasRows: true, sizeChanged: true)
    #expect(!reading && follow.mode == .reading)
  }

  @Test("a layout deferred while a finger is held is processed on release unless history was entered")
  func heldFinger() {
    var follow = TimelineFollow()
    let beforeLayout = follow.interactionEnded(hasRows: true)
    #expect(!beforeLayout && follow.mode == .placing)
    follow.deferLayout(sizeChanged: true)
    let released = follow.interactionEnded(hasRows: true)
    #expect(released && follow.mode == .following)
    follow.deferLayout(sizeChanged: true)
    follow.deferLayout(sizeChanged: false)
    let resize = follow.interactionEnded(hasRows: true)
    #expect(resize)
    follow.deferLayout(sizeChanged: true)
    follow.scrolledByPerson(distanceFromEnd: 200)
    let history = follow.interactionEnded(hasRows: true)
    #expect(!history && follow.mode == .reading)
  }

  @Test("places itself first, ignoring growth and scrolls until placed")
  func placing() {
    var follow = TimelineFollow()
    #expect(follow.mode == .placing)
    let grewWhilePlacing = follow.contentGrew()
    #expect(!grewWhilePlacing)
    follow.scrolledByPerson(distanceFromEnd: 500)
    #expect(follow.mode == .placing)
    follow.placed()
    #expect(follow.mode == .following)
  }

  @Test("follows the tail until the person scrolls away, then notes unseen growth")
  func reading() {
    var follow = TimelineFollow()
    follow.placed()
    let grewWhileFollowing = follow.contentGrew()
    #expect(grewWhileFollowing)
    follow.scrolledByPerson(distanceFromEnd: 24)
    #expect(follow.mode == .following)
    follow.scrolledByPerson(distanceFromEnd: 25)
    #expect(follow.mode == .reading)
    #expect(!follow.unseen)
    let grewWhileReading = follow.contentGrew()
    #expect(!grewWhileReading)
    #expect(follow.unseen)
    follow.placed()
    #expect(follow.mode == .reading)
  }

  @Test("follows again when the person comes back to the end or taps 回到底部")
  func back() {
    var follow = TimelineFollow()
    follow.placed()
    follow.scrolledByPerson(distanceFromEnd: 300)
    _ = follow.contentGrew()
    follow.scrolledByPerson(distanceFromEnd: 3)
    #expect(follow.mode == .following && !follow.unseen)
    follow.scrolledByPerson(distanceFromEnd: 300)
    _ = follow.contentGrew()
    follow.jumpedToEnd()
    #expect(follow.mode == .following && !follow.unseen)
  }
}
