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

/// Forgets the Mac connected now, when there is one.
///
/// - Remark: Set by `PairingHome`, which owns the host store; the drawer's "忘掉这台 Mac" calls it.
nonisolated private struct ForgetMacKey: EnvironmentKey {
  static let defaultValue: (@MainActor () -> Void)? = nil
}

extension EnvironmentValues {
  /// Forgets the Mac connected now; `nil` without a connection.
  var forgetMac: (@MainActor () -> Void)? {
    get { self[ForgetMacKey.self] }
    set { self[ForgetMacKey.self] = newValue }
  }
}

/// What the drawer says about this pairing: the relay, this phone and the App.
///
/// - Remark: SPEC-0005 "MP6 定的细节 · MP6b"; set by `PairingHome`, which knows the stored host and
///   the device.
struct PairingDetails: Equatable, Sendable {
  /// The relay's host name.
  let relay: String
  /// This phone's name.
  let deviceName: String
  /// The App's version.
  let appVersion: String
}

/// The pairing's details for the drawer, when connected.
///
/// - Remark: See ``PairingDetails``.
nonisolated private struct PairingDetailsKey: EnvironmentKey {
  static let defaultValue: PairingDetails? = nil
}

extension EnvironmentValues {
  /// The pairing's details; `nil` without a connection.
  var pairingDetails: PairingDetails? {
    get { self[PairingDetailsKey.self] }
    set { self[PairingDetailsKey.self] = newValue }
  }
}
