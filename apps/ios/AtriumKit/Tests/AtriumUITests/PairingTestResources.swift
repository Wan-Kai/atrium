import AtriumRemote
import AtriumTestSupport
import Testing

/// Weak references used after a test body's strong locals have left scope.
///
/// - Remark: Checking these detects actor task cycles rather than merely a closed socket.
final class WeakPairingResource<T: AnyObject> {
  weak var value: T?

  /// Records a non-owning reference.
  ///
  /// - Remark: The scope must release its own strong references before checking it.
  /// - SideEffects: none
  /// - Parameter value: The resource to observe.
  init(_ value: T) { self.value = value }
}

/// Owns the connections and responder channels created by a UI test case.
///
/// - Remark: Cleanup runs after success and thrown assertions, without introducing production dependencies.
final class PairingTestResources {
  @TaskLocal static var current: PairingTestResources?
  private var connections: [(RemoteConnection, ManualClock)] = []
  private var channels: [SecureChannel] = []

  /// Registers a connection before its first start.
  ///
  /// - Remark: Registration cannot suspend between construction and ownership.
  /// - SideEffects: Retains the connection and clock for teardown.
  /// - Parameters:
  ///   - connection: The tested connection.
  ///   - clock: Its injected clock.
  func register(_ connection: RemoteConnection, clock: ManualClock) {
    connections.append((connection, clock))
  }

  /// Registers a responder channel before another throwing test operation.
  ///
  /// - Remark: Stopping the phone alone does not own the responder's read task.
  /// - SideEffects: Retains the channel for teardown.
  /// - Parameter channel: The channel returned by TestHost.accept.
  func register(_ channel: SecureChannel?) {
    if let channel { channels.append(channel) }
  }

  /// Executes the body with unconditional asynchronous teardown.
  ///
  /// - Remark: The original thrown error is propagated after resources have been checked.
  /// - SideEffects: Installs a case-local registry and tears it down.
  /// - Parameter body: The test body.
  /// - Throws: The body error or a failed cleanup assertion.
  func run(_ body: @concurrent @Sendable () async throws -> Void) async throws {
    try await Self.$current.withValue(self) {
      do { try await body() } catch {
        try await verifyReleased()
        throw error
      }
      try await verifyReleased()
    }
  }

  /// Releases strong ownership before checking weak references and timer drainage.
  ///
  /// - Remark: A separate function prevents its loop temporaries from retaining actors during assertions.
  /// - SideEffects: Stops connections, aborts responder channels, and drops registry ownership.
  /// - Returns: Weak resources and clocks to check.
  private func release() async -> (
    [WeakPairingResource<RemoteConnection>], [WeakPairingResource<SecureChannel>], [ManualClock]
  ) {
    let connectionChecks = connections.map { WeakPairingResource($0.0) }
    let channelChecks = channels.map { WeakPairingResource($0) }
    let clocks = connections.map(\.1)
    for (connection, _) in connections { await connection.stop() }
    for channel in channels { channel.abort() }
    connections = []
    channels = []
    return (connectionChecks, channelChecks, clocks)
  }

  /// Waits for all scoped resources to disappear within a finite scheduling budget.
  ///
  /// - Remark: A retained actor or sleeper is a test failure, including when the test body threw.
  /// - SideEffects: Yields and records resource failures.
  /// - Throws: When resources remain live.
  private func verifyReleased() async throws {
    let (connections, channels, clocks) = await release()
    for _ in 0..<100_000 {
      if connections.allSatisfy({ $0.value == nil }), channels.allSatisfy({ $0.value == nil }),
        clocks.allSatisfy({ $0.sleeperCount == 0 })
      {
        return
      }
      await Task.yield()
    }
    #expect(connections.allSatisfy { $0.value == nil })
    #expect(channels.allSatisfy { $0.value == nil })
    #expect(clocks.allSatisfy { $0.sleeperCount == 0 })
    throw CancellationError()
  }
}

/// Installs resource ownership separately for every UI test case.
///
/// - Remark: Parameterized and throwing cases each receive their own registry.
nonisolated struct PairingResourceScope: TestTrait, SuiteTrait, TestScoping {
  let isRecursive = true

  /// Runs one case with checked teardown.
  ///
  /// - Remark: Suite containers do not themselves allocate resources.
  /// - SideEffects: Cleans registered resources after the test body.
  /// - Parameters:
  ///   - test: The test metadata.
  ///   - testCase: The concrete case, if any.
  ///   - function: The body to execute.
  /// - Throws: The body or cleanup error.
  func provideScope(
    for test: Test, testCase: Test.Case?, performing function: @concurrent @Sendable () async throws -> Void
  ) async throws {
    guard testCase != nil else {
      try await function()
      return
    }
    try await PairingTestResources().run(function)
  }
}
