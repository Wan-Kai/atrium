import AtriumRemote
import Foundation
import Observation

/// Projects the remote pairing flow into the screen without implementing another protocol state machine.
///
/// - Remark: Owns one cancellable attempt; stale callbacks never overwrite a newer attempt.
@Observable
public final class PairingModel: Identifiable {
  /// Stable identity for one sheet presentation.
  public let id = UUID()
  /// The remote flow's current state, or nil before a valid link is submitted.
  public private(set) var state: PairingState?
  /// A malformed scanned or pasted link needs a new code, without opening a connection.
  public private(set) var invalidLink = false
  /// A local persistence failure, separate from the pairing protocol's final state.
  public private(set) var storageIssue: RemoteStorageIssue?
  private let flow: PairingFlow
  private let store: HostStore
  private var storageRecovery: HostStorageRecovery?
  private var task: Task<Void, Never>?
  /// Whether the previous flow still owns asynchronous work, including cancellation cleanup.
  var isRunning: Bool { task != nil }
  private var generation = 0
  private var appPhase = AppPhase.active
  private let onPaired: (PairingOutcome) -> Void

  /// Prepares a projection using the same injected dependencies as the remote flow.
  ///
  /// - Remark: No keychain or network access until submit.
  /// - SideEffects: none
  /// - Parameters:
  ///   - environment: The remote environment.
  ///   - store: The phone's secret records.
  ///   - device: Device metadata announced to the Mac.
  ///   - onPaired: Immediately receives ownership of the authenticated channel on success.
  public init(
    environment: RemoteEnvironment, store: HostStore, device: DeviceInfo, onPaired: @escaping (PairingOutcome) -> Void
  ) {
    flow = PairingFlow(environment: environment, store: store, device: device)
    self.store = store
    self.onPaired = onPaired
  }

  /// Cancels the attempt when its screen goes away.
  ///
  /// - Remark: A successful channel already belongs to the connection owner.
  /// - SideEffects: Cancels work.
  isolated deinit { task?.cancel() }

  /// Validates a QR payload or explicit paste and starts one pairing attempt.
  ///
  /// - Remark: Invalid input never goes to the network or logs; duplicates while pairing are ignored.
  /// - SideEffects: Starts the remote flow, which writes keychain records and connects.
  /// - Parameter text: The full pairing link.
  public func submit(_ text: String) {
    guard task == nil else { return }
    guard let link = try? PairingLink(text) else {
      invalidLink = true
      return
    }
    invalidLink = false
    storageIssue = nil
    storageRecovery = nil
    generation += 1
    let attempt = generation
    let flow = flow
    task = Task { [weak self] in
      defer { self?.task = nil }
      let result = await flow.run(link) { [weak self] state in
        await self?.receive(state, generation: attempt)
      }
      guard let self, self.generation == attempt, !Task.isCancelled else {
        result.channel?.abort()
        return
      }
      self.finish(result)
    }
  }

  /// Cancels this screen's work and returns it to link entry.
  ///
  /// - Remark: Incrementing the generation invalidates queued callbacks; the task stays owned until
  ///   cleanup returns, so a new submission cannot overlap this model's cancelled flow.
  /// - SideEffects: Cancels the attempt; a successful channel is unaffected.
  public func cancel() {
    generation += 1
    task?.cancel()
    state = nil
    invalidLink = false
    storageIssue = nil
    storageRecovery = nil
  }

  /// Projects a finished outcome and transfers a successful channel to the application.
  ///
  /// - Remark: Called only after the flow has returned and the attempt's generation was checked.
  /// - SideEffects: Updates screen state and hands off an authenticated channel.
  /// - Parameter outcome: The finished flow's result.
  func finish(_ outcome: PairingOutcome) {
    if case .paired(let host) = outcome.state, let ownership = outcome.ownership,
      ownership != store.claim(host.hostId)
    {
      outcome.channel?.abort()
      state = .failed(.superseded)
      storageIssue = nil
      storageRecovery = nil
      return
    }
    state = outcome.state
    storageIssue = outcome.storageIssue
    storageRecovery = outcome.storageRecovery
    if case .paired = outcome.state { onPaired(outcome) }
  }

  /// Retries only the explicitly retained local storage action.
  ///
  /// - Remark: This does not restart pairing or run IK after cancellation.
  /// - SideEffects: Retries a keychain write or cleanup and updates the visible result.
  public func retryStorage() {
    guard task == nil, let recovery = storageRecovery else { return }
    let attempt = generation
    task = Task { [weak self] in
      defer { self?.task = nil }
      let result = await recovery.retry()
      guard let self, self.generation == attempt, !Task.isCancelled else { return }
      switch result {
      case .saved(let host, let ownership):
        self.finish(PairingOutcome(state: .paired(host), channel: nil, ownership: ownership))
      case .removed:
        self.storageIssue = nil
        self.storageRecovery = nil
      case .failed(let issue):
        self.storageIssue = issue
      case .superseded:
        self.storageIssue = nil
        self.storageRecovery = nil
        self.state = .failed(.superseded)
      }
    }
  }

  /// Retries retained persistence once when returning from the background.
  ///
  /// - Remark: Inactive is transitional; cancellation has already discarded its recovery operation.
  /// - SideEffects: May start the existing guarded storage retry.
  /// - Parameter phase: The screen's application lifecycle phase.
  public func setAppPhase(_ phase: AppPhase) {
    guard phase != .inactive else { return }
    let previous = appPhase
    appPhase = phase
    if previous == .background, phase == .active { retryStorage() }
  }

  /// Applies one callback only to the attempt that produced it.
  ///
  /// - Remark: PairingFlow remains the sole authority for the protocol state.
  /// - SideEffects: Updates observable screen state.
  /// - Parameters:
  ///   - state: The protocol state.
  ///   - generation: The attempt that emitted it.
  private func receive(_ state: PairingState, generation: Int) {
    guard self.generation == generation else { return }
    // Publish success with its transferable channel, not before run has returned it.
    if case .paired = state { return }
    self.state = state
  }
}
