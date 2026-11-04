import AtriumProtocol
import SwiftUI

extension EnvironmentValues {
  /// The session the page shows, for rows that fetch a step whole (SPEC-0005 "给手机推什么").
  @Entry var conversationId: SessionId?
  /// The turn whose rail this is, for the same.
  @Entry var railTurnId: String?
}
