import AtriumRemote
import AtriumTestSupport
import Synchronization
import Testing

/// A weak actor reference that can safely be inspected from an asynchronous test.
///
/// - Remark: Does not keep the connection alive while checking task-cycle teardown.
actor WeakConnection {
  weak var value: RemoteConnection?

  /// Remembers the actor without owning it.
  ///
  /// - Remark: Initialized before strong test ownership is released.
  /// - SideEffects: none
  /// - Parameter value: The connection.
  init(_ value: RemoteConnection) { self.value = value }
}

/// Resources created by one Swift Testing case.
///
/// - Remark: A task-local scope also catches early thrown assertions, unlike trailing stop calls.
final class ConnectionTestResources: Sendable {
  @TaskLocal static var current: ConnectionTestResources?
  private let entries = Mutex<[(RemoteConnection, ManualClock)]>([])

  /// Registers a newly created connection for mandatory scope teardown.
  ///
  /// - Remark: Registration is synchronous, before the test can start actor tasks.
  /// - SideEffects: Retains the resources until teardown.
  /// - Parameters:
  ///   - connection: The test's connection.
  ///   - clock: Its injected clock.
  func register(_ connection: RemoteConnection, clock: ManualClock) {
    entries.withLock { $0.append((connection, clock)) }
  }

  /// Releases case-owned references after stopping all registered actors.
  ///
  /// - Remark: Separate function ensures temporary strong entries are gone before weak assertions.
  /// - SideEffects: Drains owned references.
  /// - Returns: Weak references and clocks to verify.
  private func release() async -> [(WeakConnection, ManualClock)] {
    let owned = entries.withLock { entries in
      let values = entries
      entries = []
      return values
    }
    let checks = owned.map { (WeakConnection($0.0), $0.1) }
    for (connection, _) in owned { await connection.stop() }
    return checks
  }

  /// Runs a body with guaranteed resource cleanup even when it throws.
  ///
  /// - Remark: Also directly exercised with a deliberately throwing test body.
  /// - SideEffects: Installs the task-local registry and stops registered resources.
  /// - Parameter body: The scoped test body.
  /// - Throws: The body error or a resource verification failure.
  func run(_ body: @concurrent @Sendable () async throws -> Void) async throws {
    try await Self.$current.withValue(self) {
      do { try await body() } catch {
        try await stopAndVerify()
        throw error
      }
      try await stopAndVerify()
    }
  }

  /// Stops and verifies resource release after a case returns or throws.
  ///
  /// - Remark: Live actor task cycles and sleepers are regressions, not ignored diagnostics.
  /// - SideEffects: Stops connections and records failures.
  /// - Throws: A timeout if resources cannot be released.
  func stopAndVerify() async throws {
    let checks = await release()
    for (reference, clock) in checks {
      try await eventually { clock.sleeperCount == 0 }
      try await eventually { await reference.value == nil }
    }
  }
}

/// Guarantees teardown for every case in the remote connection suite.
///
/// - Remark: Applies independently to parameterized cases and also runs after thrown assertions.
struct ConnectionResourceScope: TestTrait, SuiteTrait, TestScoping {
  let isRecursive = true

  /// Wraps a case in registered connection ownership.
  ///
  /// - Remark: Suite-level scopes do not share resources between concurrent test cases.
  /// - SideEffects: Stops all registered connections after the body, success or failure.
  /// - Parameters:
  ///   - test: The current test.
  ///   - testCase: The current parameterized case, if any.
  ///   - function: The test body.
  /// - Throws: The original body error, or a teardown failure.
  func provideScope(
    for test: Test, testCase: Test.Case?, performing function: @concurrent @Sendable () async throws -> Void
  ) async throws {
    guard testCase != nil else {
      try await function()
      return
    }
    try await ConnectionTestResources().run(function)
  }
}
