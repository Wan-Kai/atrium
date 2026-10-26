import AtriumUI
import SwiftUI

/// The app's entry point: one window showing the home screen.
///
/// - Remark: The app target only assembles (coding-standards "Swift（手机端）"); everything with
///   logic lives in AtriumKit, so it can be tested on macOS with `swift test`. Debug builds open the
///   design gallery instead when launched with `ATRIUM_GALLERY` set (see `DesignGallery`).
@main
struct AtriumApp: App {
  /// The single window.
  var body: some Scene {
    WindowGroup {
      #if DEBUG
        if let section = ProcessInfo.processInfo.environment["ATRIUM_GALLERY"] {
          DesignGallery(section: section)
        } else {
          HomeView()
        }
      #else
        HomeView()
      #endif
    }
  }
}
