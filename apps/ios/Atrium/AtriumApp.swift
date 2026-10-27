import AtriumRemote
import AtriumUI
import SwiftUI

/// The app's entry point: one window showing the home screen.
///
/// - Remark: The app target only assembles (coding-standards "Swift（手机端）"); everything with
///   logic lives in AtriumKit, so it can be tested on macOS with `swift test`. Debug-only keychain
///   checks and the design gallery bypass pairing; the ordinary home shares one host store.
@main
struct AtriumApp: App {
  @State private var hostStore = HostStore(KeychainStore())

  /// The single window.
  var body: some Scene {
    WindowGroup {
      #if DEBUG
        if PairingKeychainCheck.isRequested {
          PairingKeychainCheck()
        } else if let section = ProcessInfo.processInfo.environment["ATRIUM_GALLERY"] {
          DesignGallery(section: section)
        } else {
          PairingHome(store: hostStore) { HomeView() }
        }
      #else
        PairingHome(store: hostStore) { HomeView() }
      #endif
    }
  }
}
