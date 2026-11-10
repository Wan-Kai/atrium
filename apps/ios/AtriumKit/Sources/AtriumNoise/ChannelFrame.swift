import Foundation

/// One decrypted transport plaintext: a type byte and a body (SPEC-0005 "分帧").
///
/// - Remark: Strict, as agreed with the TS side (`spikes/mobile-mp0/interop/FORMAT.md`): heartbeats
///   are exactly one byte, and a control message must be a JSON object with a string `kind`.
public enum ChannelFrame: Equatable, Sendable {
  /// 0x00 (`isLast`) or 0x01: a chunk of an Atrium message.
  case chunk(Data, isLast: Bool)
  /// 0x02: heartbeat.
  case heartbeat
  /// 0x03: heartbeat answer.
  case heartbeatAck
  /// 0x04: a channel control message, single-chunk JSON.
  case control(Data)
  /// A chunk of a deflated message (0x05 last, 0x06 more), only once the phone asked for them.
  case deflatedChunk(Data, isLast: Bool)

  /// The largest body one frame can carry: a Noise plaintext minus the type byte.
  public static let maxBody = NoiseTransport.maxPlaintextLength - 1

  /// The plaintext to encrypt.
  ///
  /// - Remark: Heartbeats carry no body.
  /// - SideEffects: none
  /// - Returns: The type byte and the body.
  public func encoded() -> Data {
    switch self {
    case .chunk(let body, let isLast): Data([isLast ? 0x00 : 0x01]) + body
    case .heartbeat: Data([0x02])
    case .heartbeatAck: Data([0x03])
    case .control(let body): Data([0x04]) + body
    case .deflatedChunk(let body, let isLast): Data([isLast ? 0x05 : 0x06]) + body
    }
  }

  /// Parses a decrypted plaintext.
  ///
  /// - Remark: See the type's remark; anything else closes the channel.
  /// - SideEffects: none
  /// - Parameter plaintext: The decrypted bytes.
  /// - Returns: The frame; bodies start at index 0.
  /// - Throws: ``WireError/emptyFrame``, ``WireError/badFrame``, ``WireError/badControl`` or
  ///   ``WireError/unknownFrameType(_:)``.
  public static func decode(_ plaintext: Data) throws(WireError) -> ChannelFrame {
    guard let type = plaintext.first else { throw .emptyFrame }
    let body = Data(plaintext.dropFirst())
    switch type {
    case 0x00: return .chunk(body, isLast: true)
    case 0x01: return .chunk(body, isLast: false)
    case 0x02, 0x03:
      guard body.isEmpty else { throw .badFrame }
      return type == 0x02 ? .heartbeat : .heartbeatAck
    case 0x04:
      guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any], object["kind"] is String
      else { throw .badControl }
      return .control(body)
    case 0x05: return .deflatedChunk(body, isLast: true)
    case 0x06: return .deflatedChunk(body, isLast: false)
    default: throw .unknownFrameType(type)
    }
  }

  /// Splits one Atrium message into chunk frames of at most `maxBody` bytes each.
  ///
  /// - Remark: An empty message is one empty last chunk. The size limit is checked on the whole
  ///   encoded message (SPEC-0005 "大小").
  /// - SideEffects: none
  /// - Parameters:
  ///   - message: The encoded Atrium message.
  ///   - limit: The largest message allowed in this direction.
  ///   - maxBody: The largest chunk; tests shrink it.
  /// - Returns: The frames in order; only the last has `isLast`.
  /// - Throws: ``WireError/messageTooLarge(limit:)`` when `message` exceeds `limit`.
  public static func chunks(of message: Data, limit: Int, maxBody: Int = ChannelFrame.maxBody) throws(WireError)
    -> [ChannelFrame]
  {
    guard message.count <= limit else { throw .messageTooLarge(limit: limit) }
    guard !message.isEmpty else { return [.chunk(Data(), isLast: true)] }
    var frames: [ChannelFrame] = []
    var offset = message.startIndex
    while offset < message.endIndex {
      let end = message.index(offset, offsetBy: maxBody, limitedBy: message.endIndex) ?? message.endIndex
      frames.append(.chunk(Data(message[offset..<end]), isLast: end == message.endIndex))
      offset = end
    }
    return frames
  }
}

/// Limits of the channel (SPEC-0005 "分帧", "大小").
///
/// - Remark: One place for the numbers both directions and the tests use.
public enum ChannelLimits {
  /// Largest message a phone sends to the host.
  public static let phoneToHost = 1 << 20
  /// Largest message the host sends to a phone.
  public static let hostToPhone = 8 << 20
  /// How long a chunked message may stay incomplete.
  public static let chunkTimeout = Duration.seconds(30)
}

/// What the receiving side gets out of one frame.
///
/// - Remark: Chunks never surface on their own; only complete messages do.
public enum ChannelEvent: Equatable, Sendable {
  /// A complete Atrium message.
  case message(Data)
  /// The peer sent a heartbeat; answer it.
  case heartbeat
  /// The peer answered our heartbeat.
  case heartbeatAck
  /// A channel control message.
  case control(Data)
}

/// Reassembles chunked messages and enforces the size limit and the 30-second chunk timeout.
///
/// - Remark: Pure: time is passed in, so tests drive it with any clock. The timeout runs from the
///   first 0x01 chunk of a message. Heartbeats and control frames may arrive between chunks.
public struct FrameReassembler<Instant: InstantProtocol> where Instant.Duration == Duration {
  /// Largest complete message accepted.
  public let limit: Int
  /// How long a chunked message may stay open.
  public let timeout: Duration
  /// Whether deflated chunks are accepted: the phone asked the host for them.
  public let inflates: Bool
  private var buffer = Data()
  /// Whether the open message is deflated; `nil` with none open.
  private var deflated: Bool?
  private var startedAt: Instant?

  /// Creates a reassembler for one receive direction.
  ///
  /// - Remark: The phone receives with the 8 MiB host → phone limit.
  /// - SideEffects: none
  /// - Parameters:
  ///   - limit: Largest complete message.
  ///   - timeout: How long a chunked message may stay open.
  ///   - inflates: Whether deflated chunks are accepted; otherwise they are an unknown frame type.
  public init(limit: Int, timeout: Duration = ChannelLimits.chunkTimeout, inflates: Bool = false) {
    self.limit = limit
    self.timeout = timeout
    self.inflates = inflates
  }

  /// When the open chunked message times out, or `nil` when none is open.
  public var deadline: Instant? { startedAt?.advanced(by: timeout) }

  /// Feeds one decoded frame received at `now`.
  ///
  /// - Remark: Checks the deadline first, so a late frame of any kind ends an expired message.
  /// - SideEffects: none
  /// - Parameters:
  ///   - frame: The decoded frame.
  ///   - now: When it arrived.
  /// - Returns: The event to act on, or `nil` when a chunk only extended an open message.
  /// - Throws: ``WireError/chunkTimeout``, ``WireError/messageTooLarge(limit:)`` or ``WireError/badUTF8``.
  public mutating func receive(_ frame: ChannelFrame, at now: Instant) throws(WireError) -> ChannelEvent? {
    try checkTimeout(at: now)
    switch frame {
    case .heartbeat: return .heartbeat
    case .heartbeatAck: return .heartbeatAck
    case .control(let body): return .control(body)
    case .chunk(let body, let isLast): return try chunk(body, deflated: false, isLast: isLast, at: now)
    case .deflatedChunk(let body, let isLast):
      guard inflates else { throw .unknownFrameType(isLast ? 0x05 : 0x06) }
      return try chunk(body, deflated: true, isLast: isLast, at: now)
    }
  }

  /// Takes one chunk of a plain or deflated message.
  ///
  /// - Remark: All chunks of a message are of one kind. Both the deflated bytes and the inflated
  ///   message are held to the limit (SPEC-0005 "Noise 通道 · 压缩").
  /// - SideEffects: none
  /// - Parameters:
  ///   - body: The chunk's bytes.
  ///   - deflated: Whether it is a deflated message's.
  ///   - isLast: Whether it ends the message.
  ///   - now: When it arrived.
  /// - Returns: The message once complete, else `nil`.
  /// - Throws: ``WireError/badFrame``, ``WireError/messageTooLarge(limit:)`` or ``WireError/badUTF8``.
  private mutating func chunk(_ body: Data, deflated: Bool, isLast: Bool, at now: Instant) throws(WireError)
    -> ChannelEvent?
  {
    if let open = self.deflated, open != deflated { throw .badFrame }
    guard buffer.count + body.count <= limit else { throw .messageTooLarge(limit: limit) }
    buffer += body
    guard isLast else {
      self.deflated = deflated
      if startedAt == nil { startedAt = now }
      return nil
    }
    let joined = buffer
    buffer = Data()
    startedAt = nil
    self.deflated = nil
    let message = deflated ? try Inflate.raw(joined, limit: limit) : joined
    guard String(data: message, encoding: .utf8) != nil else { throw .badUTF8 }
    return .message(message)
  }

  /// Fails when an open chunked message has passed its deadline.
  ///
  /// - Remark: The channel also calls it when its wait for the next frame runs out.
  /// - SideEffects: none
  /// - Parameter now: The current time.
  /// - Throws: ``WireError/chunkTimeout``.
  public func checkTimeout(at now: Instant) throws(WireError) {
    if let deadline, now >= deadline { throw .chunkTimeout }
  }
}
