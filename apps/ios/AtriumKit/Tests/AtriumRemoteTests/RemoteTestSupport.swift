import AtriumNoise
import AtriumProtocol
import AtriumTestSupport
import CryptoKit
import Foundation
import Synchronization
import Testing

@testable import AtriumRemote

/// Everything a connection or pairing test needs: a manual clock, an in-memory relay and keychain,
/// a test host and the environment wiring them.
///
/// - Remark: Jitter is fixed at 0, so backoff waits are exactly 1, 2, 4 … s.
final class Harness: Sendable {
  let clock = ManualClock()
  let relay = MemoryRelay()
  let secrets = MemorySecretStore()
  let store: HostStore
  let host = TestHost()
  let environment: RemoteEnvironment
  let stopwatch: Stopwatch
  /// Keeps accepted host sessions alive for the harness lifetime, rather than leaking their writer tasks.
  private let hostSessions = Mutex<[HostSide]>([])

  /// Wires the parts.
  ///
  /// - Remark: The protocol version is the generated one unless a test overrides it.
  /// - SideEffects: none
  /// - Parameter protocolVersion: The version the phone announces.
  init(protocolVersion: Int = AtriumProtocol.protocolVersion) {
    let relay = relay
    store = HostStore(secrets)
    stopwatch = Stopwatch(clock)
    environment = RemoteEnvironment(
      connect: { relay.connect($0) }, stopwatch: stopwatch, jitter: { 0 },
      traceparent: { "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" }, appVersion: "0.1.0",
      protocolVersion: protocolVersion)
  }

  /// A connection to the test host, with a confirmed record already in the keychain.
  ///
  /// - Remark: The record may be overridden, for a pending one.
  /// - SideEffects: Writes the in-memory keychain.
  /// - Parameter record: The record to connect with.
  /// - Returns: The connection, not started.
  /// - Throws: When the keychain fails.
  func connection(record: HostRecord? = nil) throws -> RemoteConnection {
    let record = record ?? host.record
    if record.isPending {
      try store.savePending(record)
    } else {
      try store.confirm(record, deviceId: record.deviceId ?? "")
    }
    let connection = RemoteConnection(
      host: record, deviceKey: try store.deviceKey(), store: store, environment: environment)
    ConnectionTestResources.current?.register(connection, clock: clock)
    return connection
  }

  /// Accepts the next connection as the test host and answers `hello`.
  ///
  /// - Remark: The usual successful daily connection.
  /// - SideEffects: Reads and writes on the connection.
  /// - Parameter protocolVersion: The version the host's `welcome` claims.
  /// - Returns: The host's side and the `hello` it read.
  /// - Throws: When the phone does something else.
  func acceptConnect(protocolVersion: Int = AtriumProtocol.protocolVersion) async throws -> (HostSide, [String: Any]) {
    let connection = await relay.next()
    let side = try await host.accept(connection.host, stopwatch: stopwatch)
    let hello = try await side.answerHello(protocolVersion: protocolVersion)
    hostSessions.withLock { $0.append(side) }
    return (side, hello)
  }
}

extension Harness {
  /// Accepts the next connection, answers `hello` and waits until the phone has the link open.
  ///
  /// - Remark: Afterwards only the heartbeat loop sleeps, so stepping the clock moves it alone.
  /// - SideEffects: Reads and writes on the connection.
  /// - Parameter connection: The phone's connection.
  /// - Returns: The host's side.
  /// - Throws: When the phone does something else.
  @discardableResult
  func open(_ connection: RemoteConnection) async throws -> HostSide {
    let (side, _) = try await acceptConnect()
    try await eventually { await connection.status == .syncing }
    try await eventually { clock.sleeperCount == 1 }
    return side
  }
}

/// Reads statuses one at a time.
///
/// - Remark: Statuses are published in order without repeats, so a test can expect the exact
///   sequence.
struct StatusReader {
  private var iterator: AsyncStream<ConnectionStatus>.Iterator

  /// Starts reading the connection status stream.
  ///
  /// - Remark: The first one is the status at creation, `connecting`.
  /// - SideEffects: none
  /// - Parameter connection: The connection.
  init(_ connection: RemoteConnection) {
    iterator = connection.statuses.makeAsyncIterator()
  }

  /// The next status.
  ///
  /// - Remark: `nil` once the connection stopped.
  /// - SideEffects: Suspends until it comes.
  /// - Returns: The status.
  mutating func next() async -> ConnectionStatus? {
    await iterator.next(isolation: #isolation)
  }
}

/// Waits until `condition` holds, yielding to other tasks in between.
///
/// - Remark: For effects that happen in other tasks without virtual time passing (a heartbeat
///   answer being read). Gives up after many rounds so a broken test fails instead of hanging.
/// - SideEffects: Yields.
/// - Parameter condition: What to wait for.
/// - Throws: When it never holds.
func eventually(_ condition: () async -> Bool) async throws {
  for _ in 0..<100_000 {
    if await condition() { return }
    await Task.yield()
  }
  Issue.record("condition never held")
  throw CancellationError()
}

/// Steps the clock one second at a time, waiting for `sleepers` sleepers before each step.
///
/// - Remark: Loops that sleep again after waking keep pace with the clock this way.
/// - SideEffects: Advances the clock.
/// - Parameters:
///   - clock: The clock.
///   - seconds: How many seconds.
///   - sleepers: How many tasks must be sleeping before each step.
func step(_ clock: ManualClock, seconds: Int, sleepers: Int = 1) async {
  for _ in 0..<seconds {
    await clock.waitForSleepers(sleepers)
    clock.advance(by: .seconds(1))
  }
}
