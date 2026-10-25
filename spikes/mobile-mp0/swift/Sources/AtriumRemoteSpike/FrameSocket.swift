import Foundation

/// A message-oriented binary socket: one call, one WebSocket frame.
///
/// - Remarks: The seam between the channel logic and `URLSessionWebSocketTask`, so tests run the
///   whole client against an in-memory host.
public protocol FrameSocket: Sendable {
    /// Sends one binary frame.
    func send(_ frame: Data) async throws
    /// Waits for the next binary frame.
    func receive() async throws -> Data
    /// Closes the socket; pending and later calls fail.
    func close()
}

/// ``FrameSocket`` over `URLSessionWebSocketTask`, for the relay's `/v1/client` endpoint.
public final class WebSocketFrameSocket: FrameSocket {
    private let task: URLSessionWebSocketTask

    /// Opens a WebSocket to `url`.
    ///
    /// - Remarks: The relay allows 70 KiB per frame (SPEC-0005 "上限"); the task's own limit is
    ///   set to the same so an oversized frame fails here too.
    /// - Side effects: Starts a network connection.
    public init(url: URL, session: URLSession = .shared) {
        task = session.webSocketTask(with: url)
        task.maximumMessageSize = 70 * 1024
        task.resume()
    }

    /// Sends one binary frame.
    ///
    /// - Side effects: Writes to the network.
    public func send(_ frame: Data) async throws {
        try await task.send(.data(frame))
    }

    /// Waits for the next binary frame; a text frame is a protocol error.
    ///
    /// - Side effects: Reads from the network.
    /// - Throws: The task's error, or ``RemoteError/badPayload`` for a text frame.
    public func receive() async throws -> Data {
        switch try await task.receive() {
        case .data(let data): return data
        case .string: throw RemoteError.badPayload
        @unknown default: throw RemoteError.badPayload
        }
    }

    /// Closes with 1000.
    ///
    /// - Side effects: Closes the network connection.
    public func close() {
        task.cancel(with: .normalClosure, reason: nil)
    }

    /// The close code and reason the peer sent, such as relay's `4404 offline:<unix seconds>`.
    ///
    /// - Remarks: Shown as "连接断开" only; it never triggers deleting a pairing, because the relay
    ///   can forge it (SPEC-0005 "撤销").
    public var closeDescription: String? {
        guard task.closeCode != .invalid else { return nil }
        let reason = task.closeReason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        return "\(task.closeCode.rawValue) \(reason)"
    }
}
