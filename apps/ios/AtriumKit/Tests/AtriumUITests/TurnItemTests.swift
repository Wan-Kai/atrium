import AtriumProtocol
import Testing

@testable import AtriumUI

/// When a turn on the session page redraws.
///
/// - Remark: A streamed fragment changes one turn; the others must compare equal and skip their
///   bodies, or every turn redraws ~30 times a second.
@Suite("Turn item")
struct TurnItemTests {
  /// Checks two items with the same turn and the same offers compare equal, whatever their actions.
  ///
  /// - Remark: The page makes new closures on every update; they must not make the turn redraw.
  /// - SideEffects: none
  /// - Throws: When the sample turn does not decode.
  @Test func ignoresFreshActions() throws {
    let turn = try layoutTurn(steps: [replyStep])
    let route = ChangesRoute(workspaceId: "w1")
    let one = TurnItem(turn: turn, latest: true, changes: route, retry: {}, openChanges: { _ in })
    let other = TurnItem(turn: turn, latest: true, changes: route, retry: {}, openChanges: { _ in })
    #expect(one == other)
  }

  /// Checks a changed turn, latest flag or change route makes the item differ.
  ///
  /// - Remark: Those are what the turn draws.
  /// - SideEffects: none
  /// - Throws: When the sample turns do not decode.
  @Test func differsWhenWhatItDrawsChanges() throws {
    let turn = try layoutTurn(steps: [replyStep])
    let grown = try layoutTurn(outcome: "running", steps: [replyStep])
    let item = TurnItem(turn: turn, latest: false, changes: nil, retry: {}, openChanges: { _ in })
    #expect(item != TurnItem(turn: grown, latest: false, changes: nil, retry: {}, openChanges: { _ in }))
    #expect(item != TurnItem(turn: turn, latest: true, changes: nil, retry: {}, openChanges: { _ in }))
    #expect(
      item
        != TurnItem(
          turn: turn, latest: false, changes: ChangesRoute(workspaceId: "w1"), retry: {}, openChanges: { _ in }))
  }
}
