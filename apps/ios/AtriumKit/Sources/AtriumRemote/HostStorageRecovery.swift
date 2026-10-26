import Synchronization

/// The one local persistence action that still needs attention.
///
/// - Remark: Independent of network state: authenticated revocation remains terminal even if deletion fails.
public enum RemoteStorageOperation: Sendable, Equatable {
  case confirmPairing
  case removeHost
  case removePending
}

/// A non-secret, observable persistence failure.
///
/// - Remark: UI maps the operation to generic save/cleanup wording, never displays raw NSError text.
public struct RemoteStorageIssue: Sendable, Equatable {
  public let operation: RemoteStorageOperation
  public let error: StoreError
}

/// The result of one explicitly requested persistence attempt.
///
/// - Remark: Superseded is a resolved old operation, not another retryable failure.
public enum HostStorageResult: Sendable {
  case saved(HostRecord, HostStore.Claim)
  case removed
  case failed(RemoteStorageIssue)
  case superseded
}

/// Retries one version-owned confirmation or cleanup, keeping no persistent queue or timer.
///
/// - Remark: UI retry executes off MainActor. RemoteConnection performs the same synchronous step
///   on its own actor so a revocation cannot interleave with its confirmation receipt. The shared
///   HostStore remains the sole record writer and decides whether a claim is current.
public final class HostStorageRecovery: Sendable {
  /// The operation used for observable failure wording.
  public nonisolated let operation: RemoteStorageOperation
  private let store: HostStore
  private let action: Mutex<Action?>

  /// Remaining work and its original or partially updated ownership.
  ///
  /// - Remark: Confirmation may have written host before pending deletion failed.
  private enum Action: Sendable {
    case confirm(HostRecord, String, String?, HostStore.Claim)
    case remove(HostStore.Removal)
  }

  /// Prepares an authenticated pending confirmation.
  ///
  /// - Remark: Construction does no keychain work.
  /// - SideEffects: none
  /// - Parameters:
  ///   - store: Shared writer authority.
  ///   - pending: Record to confirm.
  ///   - deviceId: Authenticated assigned id.
  ///   - hostName: Optional authenticated name.
  ///   - claim: Original record versions.
  init(store: HostStore, pending: HostRecord, deviceId: String, hostName: String? = nil, claim: HostStore.Claim) {
    self.store = store
    operation = .confirmPairing
    action = Mutex(.confirm(pending, deviceId, hostName, claim))
  }

  /// Prepares authenticated cleanup.
  ///
  /// - Remark: The plan excludes device-key and scopes each record to its original version and key.
  /// - SideEffects: none
  /// - Parameters:
  ///   - store: Shared writer authority.
  ///   - removal: Finite cleanup plan.
  ///   - operation: User-facing operation category.
  init(store: HostStore, removal: HostStore.Removal, operation: RemoteStorageOperation) {
    self.store = store
    self.operation = operation
    action = Mutex(.remove(removal))
  }

  /// Attempts the remaining operation once, without networking or scheduled retries.
  ///
  /// - Remark: A completed or superseded action cannot subsequently affect a new pairing.
  /// - SideEffects: Reads/writes version-owned keychain records; updates remaining work.
  /// - Returns: Saved, removed, superseded or a visible failure.
  @concurrent public func retry() async -> HostStorageResult { perform() }

  /// Updated ownership after a partially successful confirmation.
  var currentClaim: HostStore.Claim? {
    action.withLock { current in
      if case .confirm(_, _, _, let claim) = current { return claim }
      return nil
    }
  }

  /// Performs one synchronous step on an already non-main actor or executor.
  ///
  /// - Remark: The caller can apply its ownership receipt without an actor reentrancy window.
  /// - SideEffects: Mutates the scoped records and remaining action; no awaits or callbacks.
  /// - Returns: The persistence result.
  func perform() -> HostStorageResult {
    action.withLock { remaining in
      guard let current = remaining else { return .superseded }
      switch current {
      case .confirm(let pending, let deviceId, let hostName, let claim):
        switch store.confirm(pending, deviceId: deviceId, hostName: hostName, owner: claim) {
        case .saved(let record, let owner):
          remaining = nil
          return .saved(record, owner)
        case .superseded:
          remaining = nil
          return .superseded
        case .failed(let error, let owner):
          remaining = .confirm(pending, deviceId, hostName, owner)
          return .failed(RemoteStorageIssue(operation: operation, error: error))
        }
      case .remove(let plan):
        switch store.remove(plan) {
        case .superseded:
          remaining = nil
          return .superseded
        case .complete:
          remaining = nil
          return .removed
        case .failed(let error, let plan):
          remaining = .remove(plan)
          return .failed(RemoteStorageIssue(operation: operation, error: error))
        }
      }
    }
  }
}
