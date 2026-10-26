import AtriumNoise
import CryptoKit
import Foundation

/// Where a pairing stands, for the pairing screen (SPEC-0005 "配对流程").
///
/// - Remark: Scanning comes before and is the screen's own business; this starts with a valid link.
public enum PairingState: Equatable, Sendable {
  /// Connecting to the relay and running the handshake.
  case connecting
  /// The code is shown; waiting for the user to confirm on the Mac, with the seconds left of 2 minutes.
  case confirming(code: String, secondsLeft: Int)
  /// The Mac confirmed; the record is saved.
  case paired(HostRecord)
  /// It did not work.
  case failed(PairingFailure)
}

/// Why a pairing did not work, one case per thing the screen says.
///
/// - Remark: Refusals inside Noise give the exact reason; a closed connection before message 2 means
///   the code is not the Mac's current one (SPEC-0005 "配对流程" step 2, MP0).
public enum PairingFailure: Equatable, Sendable {
  /// The user declined on the Mac.
  case declined
  /// Another phone got there first (`pairing_busy`).
  case busy
  /// The code expired, was cancelled or replaced, or belongs to another Mac: "二维码已失效".
  case expired
  /// Nobody confirmed on the Mac within 2 minutes.
  case timedOut
  /// The Mac cancelled the pairing (a new code, closing the sheet).
  case cancelled
  /// The connection dropped while waiting for the Mac; the pending record stays, so the next
  /// connection finds out whether the Mac confirmed (SPEC-0005 "配对流程" step 6).
  case interrupted
  /// The phone cannot get out: no network, or "无线数据" not allowed.
  case noNetwork
  /// The relay says the Mac is not connected.
  case hostOffline(lastSeen: Date?)
  /// The relay could not be reached.
  case relayUnreachable
  /// The Mac speaks another protocol version.
  case versionMismatch(hostProtocol: Int?)
  /// The Mac could not save the pairing (`host_error`).
  case hostError
  /// The keychain refused to store this phone's key or the pending record.
  case keychainUnavailable
  /// Anything else; the reason code, if the Mac sent one, is kept for the log.
  case other(String)
}

/// How a pairing ended.
///
/// - Remark: On success the channel stays open and goes on to `hello` (SPEC-0005 "配对流程" step 5):
///   hand it to ``RemoteConnection`` as its handover.
public struct PairingOutcome: Sendable {
  /// The final state: `paired` or `failed`.
  public let state: PairingState
  /// The open channel after `paired`.
  public let channel: SecureChannel?
}

/// The phone's side of pairing, from a scanned link to `paired` (SPEC-0005 "配对流程").
///
/// - Remark: Writes the pending record before connecting, so a `paired` lost on the way can be
///   completed by the next daily connection; deletes it on every clear refusal. Time comes from the
///   environment's stopwatch, so the 2-minute countdown runs on the manual clock in tests.
public struct PairingFlow: Sendable {
  /// How long the Mac has to confirm (SPEC-0005 "配对流程" step 6).
  public static let confirmWindow = 120
  /// Extra wait after the countdown for the Mac's own `pair_rejected` to arrive.
  public static let grace = Duration.seconds(5)

  private let environment: RemoteEnvironment
  private let store: HostStore
  private let device: DeviceInfo

  /// Makes a flow.
  ///
  /// - Remark: One per pairing attempt is fine; it keeps no state.
  /// - SideEffects: none
  /// - Parameters:
  ///   - environment: Connections, clock, versions.
  ///   - store: The keychain records.
  ///   - device: What to tell the Mac about this phone.
  public init(environment: RemoteEnvironment, store: HostStore, device: DeviceInfo) {
    self.environment = environment
    self.store = store
    self.device = device
  }

  /// Pairs with the Mac in `link`, reporting each state.
  ///
  /// - Remark: Cancelling the calling task closes the connection and drops the pending record.
  /// - SideEffects: Writes and deletes keychain records; opens a connection; calls `report`.
  /// - Parameters:
  ///   - link: The scanned or pasted link.
  ///   - report: Called with every state, including the final one.
  /// - Returns: The final state, with the channel on success.
  public func run(_ link: PairingLink, report: @escaping @Sendable (PairingState) async -> Void) async
    -> PairingOutcome
  {
    await report(.connecting)
    let pending = HostRecord(pending: link)
    let deviceKey: Curve25519.KeyAgreement.PrivateKey
    do {
      deviceKey = try store.deviceKey()
      try store.savePending(pending)
    } catch {
      return await end(.keychainUnavailable, report: report)
    }
    guard let endpoint = clientEndpoint(relay: link.relay, hostId: link.hostId) else {
      return await end(.relayUnreachable, link: link, report: report)
    }
    let transport = environment.connect(endpoint)
    let environment = environment
    let device = device
    let opened: Result<PairingChannel, RemoteError> = await Self.race(
      environment.stopwatch, limit: RemoteConnection.handshakeTimeout, onTimeout: { transport.close() }
    ) { () async throws(RemoteError) -> PairingChannel in
      try await RemoteHandshake.pair(
        link: link, deviceKey: deviceKey, info: device, transport: transport, stopwatch: environment.stopwatch,
        protocolVersion: environment.protocolVersion)
    }
    let pairing: PairingChannel
    switch opened {
    case .success(let value): pairing = value
    case .failure(let error): return await end(Self.handshakeFailure(error), link: link, report: report)
    }
    if Task.isCancelled {
      await pairing.channel.close()
      return await end(.other("cancelled"), link: link, report: report)
    }

    await report(.confirming(code: pairing.code, secondsLeft: Self.confirmWindow))
    let channel = pairing.channel
    let answer: Result<(deviceId: String, hostName: String), RemoteError>? = await withTaskGroup(
      of: Result<(deviceId: String, hostName: String), RemoteError>?.self
    ) { group in
      group.addTask {
        do throws(RemoteError) {
          return .success(try await RemoteHandshake.awaitPaired(channel))
        } catch {
          return .failure(error)
        }
      }
      group.addTask {
        do {
          for left in stride(from: Self.confirmWindow - 1, through: 0, by: -1) {
            try await environment.stopwatch.sleep(for: .seconds(1))
            await report(.confirming(code: pairing.code, secondsLeft: left))
          }
          try await environment.stopwatch.sleep(for: Self.grace)
        } catch {
          return .failure(.closed)
        }
        return nil
      }
      let first = await group.next() ?? nil
      group.cancelAll()
      if case .success = first {} else { await channel.close() }
      return first
    }
    switch answer {
    case .success(let paired)?:
      guard let record = try? store.confirm(pending, deviceId: paired.deviceId, hostName: paired.hostName) else {
        await channel.close()
        return await end(.keychainUnavailable, link: link, report: report)
      }
      await report(.paired(record))
      return PairingOutcome(state: .paired(record), channel: channel)
    case .failure(.rejected(let reason, _))?:
      return await end(Self.rejection(reason), link: link, report: report)
    case .failure(.closed)?:
      return await end(.other("cancelled"), link: link, report: report)
    case .failure?:
      // The Mac may have confirmed; keep the pending record for the next connection.
      return await end(.interrupted, report: report)
    case nil:
      return await end(.timedOut, link: link, report: report)
    }
  }

  /// Reports and returns a failure, dropping the pending record when `link` is given.
  ///
  /// - Remark: Only ``PairingFailure/interrupted`` and a keychain failure keep it (or have none).
  /// - SideEffects: May delete the pending record; calls `report`.
  /// - Parameters:
  ///   - failure: Why.
  ///   - link: The pairing whose pending record goes, or `nil` to keep it.
  ///   - report: The state callback.
  /// - Returns: The outcome.
  private func end(
    _ failure: PairingFailure, link: PairingLink? = nil, report: @Sendable (PairingState) async -> Void
  ) async -> PairingOutcome {
    if let link { try? store.removePending(link.hostId) }
    await report(.failed(failure))
    return PairingOutcome(state: .failed(failure), channel: nil)
  }

  /// Runs `work` with a time limit on the stopwatch.
  ///
  /// - Remark: On timeout `onTimeout` runs (closing the connection, which unblocks the work) and the
  ///   result is ``RemoteError/handshakeTimeout``.
  /// - SideEffects: Whatever `work` and `onTimeout` do.
  /// - Parameters:
  ///   - stopwatch: The clock.
  ///   - limit: The limit.
  ///   - onTimeout: Called when the limit passes first.
  ///   - work: The work.
  /// - Returns: The work's result or the timeout.
  static func race<T: Sendable>(
    _ stopwatch: Stopwatch,
    limit: Duration,
    onTimeout: @escaping @Sendable () -> Void,
    _ work: @escaping @Sendable () async throws(RemoteError) -> T
  ) async -> Result<T, RemoteError> {
    await withTaskGroup(of: Result<T, RemoteError>?.self) { group in
      group.addTask {
        do throws(RemoteError) {
          return .success(try await work())
        } catch {
          return .failure(error)
        }
      }
      group.addTask {
        try? await stopwatch.sleep(for: limit)
        return nil
      }
      let first = await group.next() ?? nil
      if first == nil { onTimeout() }
      group.cancelAll()
      return first ?? .failure(.handshakeTimeout)
    }
  }

  /// What a failure before the code was shown means.
  ///
  /// - Remark: A connection the host closed (1000) or a message 2 we cannot decrypt means the host
  ///   does not have our PSK: the code is not its current one (SPEC-0005 "配对流程" step 2).
  /// - SideEffects: none
  /// - Parameter error: The failure.
  /// - Returns: What to show.
  static func handshakeFailure(_ error: RemoteError) -> PairingFailure {
    switch error {
    case .rejected(let reason, let hostProtocol):
      return reason == "version_mismatch" ? .versionMismatch(hostProtocol: hostProtocol) : rejection(reason)
    case .transport(.closed(code: 4404, let reason)): return .hostOffline(lastSeen: RemoteConnection.lastSeen(reason))
    case .transport(.closed(code: 1000, _)), .noise(.decryptFailed): return .expired
    case .transport(.noNetwork): return .noNetwork
    case .transport(.unreachable): return .relayUnreachable
    case .transport(.closed(let code, _)): return .other("close_\(code)")
    case .handshakeTimeout: return .other("timeout")
    default: return .other("handshake")
    }
  }

  /// What a refusal code from the Mac means.
  ///
  /// - Remark: Accepts the MP0 fake host's codes and MP3a's (`declined`, `vault_failed`), so either
  ///   host works.
  /// - SideEffects: none
  /// - Parameter reason: The code.
  /// - Returns: What to show.
  static func rejection(_ reason: String) -> PairingFailure {
    switch reason {
    case "pairing_busy": .busy
    case "pairing_expired": .expired
    case "rejected", "declined": .declined
    case "timeout": .timedOut
    case "cancelled", "disconnected": .cancelled
    case "host_error", "vault_failed": .hostError
    default: .other(reason)
    }
  }
}
