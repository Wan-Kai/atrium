import AtriumNoise

/// Why pairing, a connection or a channel ended.
///
/// - Remark: Codes and parameters only, no user-facing text (AGENTS.md: the interface owns the
///   wording). Only ``rejected(reason:hostProtocol:)`` with `device_unknown` and a `revoked` control
///   message come from inside Noise and may delete data (SPEC-0005 "撤销").
public enum RemoteError: Error, Equatable, Sendable {
  /// The connection to the relay failed.
  case transport(TransportError)
  /// Noise refused a message.
  case noise(NoiseError)
  /// Atrium's framing refused a frame.
  case wire(WireError)
  /// A handshake payload, control message or `welcome` is not the JSON we expect.
  case badPayload
  /// The host refused in handshake message 2 or with `pair_rejected`.
  case rejected(reason: String, hostProtocol: Int?)
  /// The host sent something not valid at this point, such as a message before `paired`.
  case unexpected
  /// The handshake, `hello` and `welcome` did not finish in time.
  case handshakeTimeout
  /// Two heartbeats in a row went unanswered.
  case heartbeatTimeout
  /// The host's `welcome` speaks another protocol version.
  case versionMismatch(hostProtocol: Int)
  /// The client-side cumulative buffer budget was exceeded.
  case backpressure
  /// The channel was closed on our side.
  case closed
}
