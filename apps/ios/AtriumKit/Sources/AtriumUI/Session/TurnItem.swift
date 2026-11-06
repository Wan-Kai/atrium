import AtriumProtocol
import SwiftUI

/// One turn on the session page, redrawn only when what it draws changed.
///
/// - Remark: Every update from the Mac (a streamed fragment ~30 times a second) re-evaluates the
///   page, which makes fresh actions for every turn; closures never compare equal, so without this
///   every turn rebuilt its layout and redrew each time. Compared by the turn, whether it is the
///   latest (it offers retry) and where "改了 N 个文件" leads; the actions are left out.
struct TurnItem: View, Equatable {
  /// The turn.
  let turn: Turn
  /// Whether it is the latest turn, the one that can be retried.
  let latest: Bool
  /// Where "改了 N 个文件" leads; `nil` for a session that is not in a workspace.
  let changes: ChangesRoute?
  /// Retries the run.
  let retry: () -> Void
  /// Opens the change list.
  let openChanges: (ChangesRoute) -> Void

  /// Compares what the turn draws.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameters:
  ///   - lhs: One item.
  ///   - rhs: The other.
  /// - Returns: Whether they draw the same.
  static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.latest == rhs.latest && lhs.changes == rhs.changes && lhs.turn == rhs.turn
  }

  /// The turn.
  var body: some View {
    TurnView(
      layout: TurnLayout(turn), retry: latest ? retry : nil,
      openChanges: changes.map { route in { openChanges(route) } }
    )
    .environment(\.railTurnId, turn.id)
  }
}
