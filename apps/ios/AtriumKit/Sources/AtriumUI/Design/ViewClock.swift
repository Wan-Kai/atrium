import AtriumProtocol
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

/// Tries the connection again now.
///
/// - Remark: Set by `PairingHome`, which owns the connection; the home's and settings' "重试" call it.
nonisolated private struct ReconnectNowKey: EnvironmentKey {
  static let defaultValue: (@MainActor () -> Void)? = nil
}

extension EnvironmentValues {
  /// Tries the connection again now; `nil` without a connection.
  var reconnectNow: (@MainActor () -> Void)? {
    get { self[ReconnectNowKey.self] }
    set { self[ReconnectNowKey.self] = newValue }
  }
}

/// Opens the settings page, from a conversation or (with `nil`) from the home.
///
/// - Remark: Set by `HomeView`, which owns the navigation path.
nonisolated private struct OpenSettingsKey: EnvironmentKey {
  static let defaultValue: (@MainActor (SessionId?) -> Void)? = nil
}

/// Opens another conversation in place of the one settings was opened from.
///
/// - Remark: Set by `HomeView`: settings and the conversation under it come off the path, the other
///   conversation goes on (SPEC-0005 "界面": switching does not leave the worktree).
nonisolated private struct SwitchConversationKey: EnvironmentKey {
  static let defaultValue: (@MainActor (SessionId) -> Void)? = nil
}

extension EnvironmentValues {
  /// Opens the settings page; `nil` outside the home's navigation.
  var openSettings: (@MainActor (SessionId?) -> Void)? {
    get { self[OpenSettingsKey.self] }
    set { self[OpenSettingsKey.self] = newValue }
  }

  /// Opens another conversation in place of the current one; `nil` outside the home's navigation.
  var switchConversation: (@MainActor (SessionId) -> Void)? {
    get { self[SwitchConversationKey.self] }
    set { self[SwitchConversationKey.self] = newValue }
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
