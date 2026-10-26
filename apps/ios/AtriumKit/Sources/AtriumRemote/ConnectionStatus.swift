import Foundation

/// What the connection line shows (SPEC-0005 需求 6, "断线与恢复").
///
/// - Remark: Each failure the user can act on differently has its own case: a Mac that is offline
///   (start it), a relay that cannot be reached (check the server), a phone that cannot get out
///   (allow "无线数据", find a network), versions that differ (update), a revoked phone (pair again).
public enum ConnectionStatus: Equatable, Sendable {
  /// The first attempt after start.
  case connecting
  /// The encrypted channel is up; the open sessions are catching up. Sending is not allowed yet.
  case syncing
  /// Everything open is up to date.
  case connected
  /// The link dropped or an attempt failed for a reason without its own case; retrying.
  case reconnecting
  /// The relay says the Mac is not connected (`4404 offline:<s>`); `nil` when it never saw it.
  case hostOffline(lastSeen: Date?)
  /// The relay could not be reached.
  case relayUnreachable
  /// The phone cannot get out: no network, or the app is not allowed to use it.
  case noNetwork
  /// The Mac speaks another protocol version; no retries.
  case versionMismatch(hostProtocol: Int?)
  /// The Mac revoked this phone, said so inside Noise; the pairing is deleted, no retries.
  case revoked
  /// A pairing the Mac never confirmed: the host does not know this phone; the pending record is deleted.
  case pairingIncomplete

  /// Whether the connection has stopped for good.
  public var isTerminal: Bool {
    switch self {
    case .versionMismatch, .revoked, .pairingIncomplete: true
    default: false
    }
  }

  /// Whether messages may be sent: only once synced (SPEC-0005 "'已连接'分两步").
  public var canSend: Bool { self == .connected }
}

/// The app's lifecycle as the connection sees it, mirroring SwiftUI's `ScenePhase`.
///
/// - Remark: Its own type so AtriumRemote does not import SwiftUI.
public enum AppPhase: Sendable {
  /// In front and taking input.
  case active
  /// Visible but interrupted: Control Centre, a system alert. Leaves the connection alone.
  case inactive
  /// Not visible.
  case background
}

/// One Atrium message from the host, tagged with the connection it came on.
///
/// - Remark: Callers hand the generation back with ``RemoteConnection/markSynced(generation:)`` and
///   ``RemoteConnection/send(_:generation:)``, so work for a connection that has since been replaced
///   is refused (mobile-remote.md §7: every async callback checks its generation).
public struct RemoteMessage: Sendable, Equatable {
  /// Which connection.
  public let generation: Int
  /// The encoded host message.
  public let data: Data
}
