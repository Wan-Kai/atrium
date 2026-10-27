import SwiftUI

/// The clock views wait on: a toast's stay, a rail's fold, a question's page turn.
///
/// - Remark: coding-standards "Swift": time comes from an injected clock. The app uses the
///   continuous clock; a test or the gallery can put a manual one in the environment.
nonisolated private struct ViewClockKey: EnvironmentKey {
  static let defaultValue: any Clock<Duration> = ContinuousClock()
}

extension EnvironmentValues {
  /// The clock views wait on.
  var atriumClock: any Clock<Duration> {
    get { self[ViewClockKey.self] }
    set { self[ViewClockKey.self] = newValue }
  }
}
