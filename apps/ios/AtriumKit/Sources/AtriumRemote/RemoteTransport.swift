import Foundation

/// A message-oriented binary connection to the relay: one call, one WebSocket frame.
///
/// - Remark: The seam between the channel logic and `URLSessionWebSocketTask`, so tests run the
///   whole client against an in-memory host (testing.md: inject connections, do not mock modules).
public protocol RemoteTransport: Sendable {
  /// Sends one binary frame.
  ///
  /// - Remark: Waits until the connection is open when called first.
  /// - SideEffects: Writes to the connection.
  /// - Parameter frame: The bytes.
  /// - Throws: ``TransportError``.
  func send(_ frame: Data) async throws(TransportError)

  /// Waits for the next binary frame.
  ///
  /// - Remark: A text frame is a protocol error (SPEC-0005 "帧": phones only send binary).
  /// - SideEffects: Reads from the connection.
  /// - Returns: The frame.
  /// - Throws: ``TransportError``, with the close code once the peer closed.
  func receive() async throws(TransportError) -> Data

  /// Closes the connection; pending and later calls fail.
  ///
  /// - Remark: Idempotent.
  /// - SideEffects: Closes the connection.
  func close()
}

/// Why a transport call failed, sorted the way the connection status needs it.
///
/// - Remark: SPEC-0005 "断线与恢复" and design-language "手机端" tell apart a host that is offline,
///   a relay that cannot be reached and a phone that cannot get out at all (MP0 on a real iPhone:
///   before "无线数据" is allowed, every connection fails). Close codes only ever change what is
///   shown, never what is deleted, since the relay can forge them (SPEC-0005 "撤销").
public enum TransportError: Error, Equatable, Sendable {
  /// The other end closed the WebSocket with this code and reason, such as relay's `4404 offline:<s>`.
  case closed(code: Int, reason: String)
  /// The phone has no usable network: offline, or the app is not allowed to use it.
  case noNetwork
  /// The relay could not be reached or did not upgrade to a WebSocket (DNS, TCP, TLS, HTTP).
  case unreachable
  /// The connection failed or ended in some other way, including our own `close()`.
  case failed
}
