/// Why Atrium's framing around Noise refused a frame.
///
/// - Remark: Codes and parameters only, no user-facing text (AGENTS.md: the interface owns the
///   wording). Every case ends the channel: SPEC-0005 "分帧" closes on anything it does not know.
public enum WireError: Error, Equatable, Sendable {
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
  /// A chunked message was not completed within 30 seconds of its first chunk.
  case chunkTimeout
  /// A message is larger than the limit for its direction.
  case messageTooLarge(limit: Int)
}
