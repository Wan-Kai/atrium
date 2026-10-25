import AtriumNoiseSpike

/// Why the Atrium layer around Noise refused a frame or ended a connection.
///
/// - Remarks: Codes and parameters only, no user-facing text (AGENTS.md: the UI owns wording).
public enum RemoteError: Error, Equatable, Sendable {
    /// The first frame's magic, version or mode is unknown, or it is shorter than the header.
    case badFirstFrame
    /// A decrypted plaintext was empty, so it has no frame type.
    case emptyFrame
    /// A decrypted plaintext starts with a frame type outside 0x00–0x04.
    case unknownFrameType(UInt8)
    /// A heartbeat or its answer carried a body; both are exactly one byte.
    case badFrame
    /// A control message is not a JSON object with a string `kind`.
    case badControl
    /// A complete Atrium message is not valid UTF-8.
    case badUTF8
    /// The socket closed before handshake message 2 arrived; when pairing, the host does this for a
    /// pairing id that is not the current one (shown as "二维码已失效").
    case closedDuringHandshake
    /// A chunked message was not completed within 30 seconds of its first chunk.
    case chunkTimeout
    /// A message is larger than the limit for its direction.
    case messageTooLarge(limit: Int)
    /// A handshake payload or control message is not the JSON we expect.
    case badPayload
    /// The pairing link is not a valid `atrium://pair` link.
    case badPairingLink
    /// The host answered the handshake or the key confirmation with a refusal.
    case rejected(reason: String)
    /// The host's control message is not valid at this point of the flow.
    case unexpectedControl(kind: String)
    /// The host did not answer heartbeats in time.
    case heartbeatTimeout
    /// The socket closed or failed.
    case socketClosed
    /// Noise refused a message.
    case noise(NoiseError)
}
