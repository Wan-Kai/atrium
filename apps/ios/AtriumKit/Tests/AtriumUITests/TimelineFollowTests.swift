import Testing

@testable import AtriumUI

@Suite("Timeline follow")
struct TimelineFollowTests {
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
