import AtriumUI
import SwiftUI

/// The app's entry point: one window showing the home screen.
///
/// - Remark: The app target only assembles (coding-standards "Swift（手机端）"); everything with
///   logic lives in AtriumKit, so it can be tested on macOS with `swift test`.
@main
struct AtriumApp: App {
  /// The single window.
  var body: some Scene {
    WindowGroup { HomeView() }
  }
}
