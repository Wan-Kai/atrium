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
  private let flow: PairingFlow
  private var task: Task<Void, Never>?
  private var generation = 0
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
    generation += 1
    let attempt = generation
    let flow = flow
    task = Task { [weak self] in
      let result = await flow.run(link) { [weak self] state in
        await self?.receive(state, generation: attempt)
      }
      guard let self, self.generation == attempt, !Task.isCancelled else {
        result.channel?.abort()
        return
      }
      self.state = result.state
      self.task = nil
      if case .paired = result.state { self.onPaired(result) }
    }
  }

  /// Cancels this screen's work and returns it to link entry.
  ///
  /// - Remark: Incrementing the generation invalidates already queued callbacks.
  /// - SideEffects: Cancels the attempt; a successful channel is unaffected.
  public func cancel() {
    generation += 1
    task?.cancel()
    task = nil
    state = nil
    invalidLink = false
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
