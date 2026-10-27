import AtriumProtocol
import AtriumRemote
import AtriumSync
import Foundation
import Observation

/// Drives one connection's sync and holds what the screens show.
///
/// - Remark: The assembly between ``RemoteConnection`` and ``SyncCore`` (overview.md "iOS 工程":
///   AtriumSync does not know connections). Messages are decoded and handed to the core with their
///   generation; what the core asks for goes through one queue, so commands leave in the order the
///   core produced them, and `markSynced` follows the commands before it. A send refused because the
///   connection was replaced is dropped: the next generation subscribes again (SPEC-0005 "MP4a 定的
///   细节" 4). One model per ``RemoteConnection``: a new connection object starts its generations
///   again, so it gets a new model.
@MainActor
@Observable
public final class SyncModel {
  /// The list and the open sessions.
  public private(set) var core: SyncCore
  /// How the connection stands, as it last said.
  public private(set) var status = ConnectionStatus.connecting
  /// The Mac's name, for the connection pill.
  public let hostName: String

  @ObservationIgnored private let connection: RemoteConnection
  @ObservationIgnored private let outputs: AsyncStream<SyncOutput>
  @ObservationIgnored private let queue: AsyncStream<SyncOutput>.Continuation

  /// Makes the model for a connection.
  ///
  /// - Remark: Ids, traces and time come from the assembly.
  /// - SideEffects: none
  /// - Parameters:
  ///   - connection: The connection, started or not.
  ///   - hostName: The Mac's name.
  ///   - traceparent: Makes a command's traceparent.
  ///   - now: The time since some fixed origin, for the retry window.
  ///   - requestId: Makes a request id; random UUIDs in the app (SPEC-0005 "协议改动" 4).
  public init(
    connection: RemoteConnection, hostName: String, traceparent: @escaping @Sendable () -> String,
    now: @escaping @Sendable () -> Duration, requestId: @escaping () -> String
  ) {
    self.connection = connection
    self.hostName = hostName
    core = SyncCore(requestId: requestId, traceparent: traceparent, now: now)
    (outputs, queue) = AsyncStream.makeStream(of: SyncOutput.self)
  }

  /// What the home screen lists.
  ///
  /// - Remark: Worked out from the list each time it changes.
  public var home: HomeList { HomeList(core.index) }

  /// Reads messages and carries out what the core asks, until cancelled.
  ///
  /// - Remark: The two loops run side by side; cancelling the caller ends both.
  /// - SideEffects: Sends on the connection; marks it synced.
  public func run() async {
    await withTaskGroup(of: Void.self) { group in
      group.addTask { await self.carryOut() }
      group.addTask { await self.listen() }
      group.addTask { await self.followOpenings() }
    }
  }

  /// Takes a status the connection reported.
  ///
  /// - Remark: "正在同步" on a channel already open is the foreground probe of that channel: the
  ///   core syncs it again. "正在同步" without an open channel waits for one: ``followOpenings()``
  ///   starts its sync once it is up, never before (SPEC-0005 "MP4a 定的细节" 5).
  /// - SideEffects: Reads the connection's open generation; queues commands.
  /// - Parameter status: The status.
  public func statusChanged(_ status: ConnectionStatus) async {
    self.status = status
    guard status == .syncing, let generation = await connection.openGeneration else { return }
    enqueue(core.connected(generation: generation))
  }

  /// Starts syncing each channel as it opens.
  ///
  /// - Remark: See ``statusChanged(_:)``; the core ignores a generation already being synced.
  /// - SideEffects: Queues commands.
  private func followOpenings() async {
    for await generation in connection.openings {
      enqueue(core.connected(generation: generation))
    }
  }

  /// Opens a session's page.
  ///
  /// - Remark: See ``SyncCore/open(_:)``.
  /// - SideEffects: Queues commands.
  /// - Parameter sessionId: The session.
  public func open(_ sessionId: SessionId) {
    enqueue(core.open(sessionId))
  }

  /// Closes a session's page.
  ///
  /// - Remark: See ``SyncCore/close(_:)``.
  /// - SideEffects: Queues commands.
  /// - Parameter sessionId: The session.
  public func close(_ sessionId: SessionId) {
    enqueue(core.close(sessionId))
  }

  /// Whether a session's input may be sent now.
  ///
  /// - Remark: The connection says it is connected, and the core agrees (``SyncCore/canSend(_:)``).
  /// - SideEffects: none
  /// - Parameter sessionId: The session.
  /// - Returns: Whether the send button works.
  public func canSend(_ sessionId: SessionId) -> Bool {
    status == .connected && core.canSend(sessionId)
  }

  /// Changes what a session's input holds.
  ///
  /// - Remark: See ``SyncCore/setDraft(_:for:)``.
  /// - SideEffects: Updates the core.
  /// - Parameters:
  ///   - text: The input.
  ///   - sessionId: The session.
  public func setDraft(_ text: String, for sessionId: SessionId) {
    core.setDraft(text, for: sessionId)
  }

  /// Sends a session's input.
  ///
  /// - Remark: See ``SyncCore/send(_:)``.
  /// - SideEffects: Queues the command.
  /// - Parameter sessionId: The session.
  public func send(_ sessionId: SessionId) {
    guard status == .connected else { return }
    enqueue(core.send(sessionId))
  }

  /// Sends an uncertain message again, as a new one.
  ///
  /// - Remark: See ``SyncCore/resend(_:)``.
  /// - SideEffects: Queues the command.
  /// - Parameter requestId: The message.
  public func resend(_ requestId: RequestId) {
    guard status == .connected else { return }
    enqueue(core.resend(requestId))
  }

  /// Hands each message to the core.
  ///
  /// - Remark: A message that does not decode is from a host this app cannot read; it is skipped,
  ///   and the session it was about resyncs at its next event.
  /// - SideEffects: Updates the core; queues commands.
  private func listen() async {
    let decoder = JSONDecoder()
    for await message in connection.messages {
      guard let decoded = try? decoder.decode(HostMessage.self, from: message.data) else { continue }
      enqueue(core.receive(decoded, generation: message.generation))
    }
  }

  /// Carries out the queue in order.
  ///
  /// - Remark: See the type.
  /// - SideEffects: Sends on the connection; marks it synced.
  private func carryOut() async {
    let encoder = JSONEncoder()
    for await output in outputs {
      switch output {
      case .send(let command, let generation):
        guard let data = try? encoder.encode(command) else { continue }
        do {
          try await connection.send(data, generation: generation)
        } catch {
          // A message that never left goes back to its input (SPEC-0005 "MP4b 定的细节").
          if case .prompt(let prompt) = command { core.notWritten(prompt.requestId) }
        }
      case .markSynced(let generation):
        await connection.markSynced(generation: generation)
      }
    }
  }

  /// Queues outputs for ``carryOut()``.
  ///
  /// - Remark: The queue keeps every output; nothing is dropped.
  /// - SideEffects: Yields to the queue.
  /// - Parameter outputs: The outputs, in order.
  private func enqueue(_ outputs: [SyncOutput]) {
    for output in outputs { queue.yield(output) }
  }
}
