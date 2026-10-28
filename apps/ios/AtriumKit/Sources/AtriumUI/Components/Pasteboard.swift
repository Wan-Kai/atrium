#if os(iOS)
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

/// The system pasteboard, for "复制".
///
/// - Remark: The package also builds for macOS, where its tests run.
enum Pasteboard {
  /// Puts text on the pasteboard.
  ///
  /// - Remark: Replaces what was there.
  /// - SideEffects: Writes the system pasteboard.
  /// - Parameter text: The text.
  @MainActor
  static func copy(_ text: String) {
    #if os(iOS)
      UIPasteboard.general.string = text
    #elseif os(macOS)
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
    #endif
  }
}
