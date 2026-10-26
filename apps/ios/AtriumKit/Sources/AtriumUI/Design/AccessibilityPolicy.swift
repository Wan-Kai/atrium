import SwiftUI

/// Additional accessibility reductions requested by a component preview.
///
/// - Remark: SwiftUI's system accessibility environment keys are read-only. The Debug gallery can
///   request stricter settings through this value without changing simulator-wide preferences or
///   overriding a person's enabled system setting. Production defaults to the system alone.
nonisolated struct AccessibilityReductions: Sendable {
  /// Suppresses spatial motion in addition to the system preference.
  var motion = false
  /// Uses solid surfaces in addition to the system preference.
  var transparency = false
}

/// Stores optional extra reductions in the view environment.
///
/// - Remark: The default adds no restriction to the system settings.
nonisolated private struct AccessibilityReductionsKey: EnvironmentKey {
  static let defaultValue = AccessibilityReductions()
}

extension EnvironmentValues {
  /// Extra reductions used by the Debug gallery; ordinary screens leave this alone.
  var atriumAccessibilityReductions: AccessibilityReductions {
    get { self[AccessibilityReductionsKey.self] }
    set { self[AccessibilityReductionsKey.self] = newValue }
  }

  /// The effective motion preference; a preview can only reduce motion further.
  var atriumReduceMotion: Bool { accessibilityReduceMotion || atriumAccessibilityReductions.motion }

  /// The effective transparency preference; a preview cannot undo a person's system choice.
  var atriumReduceTransparency: Bool { accessibilityReduceTransparency || atriumAccessibilityReductions.transparency }
}
