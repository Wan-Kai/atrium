import AtriumNoiseSpike
import Foundation

/// One decrypted transport plaintext: a type byte and a body (SPEC-0005 "分帧").
public enum ChannelFrame: Equatable, Sendable {
    /// 0x00 (`isLast`) or 0x01: a chunk of an Atrium message.
    case chunk(Data, isLast: Bool)
    /// 0x02: heartbeat.
    case heartbeat
    /// 0x03: heartbeat answer.
    case heartbeatAck
    /// 0x04: a channel control message, single-chunk JSON.
    case control(Data)

    /// The largest body one frame can carry: a Noise plaintext minus the type byte.
    public static let maxBody = NoiseTransport.maxPlaintextLength - 1

    /// The plaintext to encrypt.
    ///
    /// - Remarks: Heartbeats carry no body.
    /// - Side effects: none.
    public func encoded() -> Data {
        switch self {
        case .chunk(let body, let isLast): Data([isLast ? 0x00 : 0x01]) + body
        case .heartbeat: Data([0x02])
        case .heartbeatAck: Data([0x03])
        case .control(let body): Data([0x04]) + body
        }
    }

    /// Parses a decrypted plaintext.
    ///
    /// - Remarks: Strict, as agreed with the TS side (interop/FORMAT.md): heartbeats are exactly one
    ///   byte, and a control message must be a JSON object with a string `kind`.
    /// - Side effects: none.
    /// - Throws: ``RemoteError/emptyFrame``, ``RemoteError/badFrame``, ``RemoteError/badControl`` or
    ///   ``RemoteError/unknownFrameType(_:)``.
    public static func decode(_ plaintext: Data) throws(RemoteError) -> ChannelFrame {
        guard let type = plaintext.first else { throw .emptyFrame }
        let body = Data(plaintext.dropFirst())
        switch type {
        case 0x00: return .chunk(body, isLast: true)
        case 0x01: return .chunk(body, isLast: false)
        case 0x02, 0x03:
            guard body.isEmpty else { throw .badFrame }
            return type == 0x02 ? .heartbeat : .heartbeatAck
        case 0x04:
            guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                object["kind"] is String
            else { throw .badControl }
            return .control(body)
        default: throw .unknownFrameType(type)
        }
    }

    /// Splits one Atrium message into chunk frames of at most ``maxBody`` bytes each.
    ///
    /// - Remarks: An empty message is one empty last chunk. The size limit is checked on the
    ///   whole encoded message (SPEC-0005 "大小").
    /// - Side effects: none.
    /// - Throws: ``RemoteError/messageTooLarge(limit:)`` when `message` exceeds `limit`.
    public static func chunks(of message: Data, limit: Int, maxBody: Int = ChannelFrame.maxBody) throws(RemoteError)
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
public enum ChannelLimits {
    /// Largest message a phone sends to the host.
    public static let phoneToHost = 1 << 20
    /// Largest message the host sends to a phone.
    public static let hostToPhone = 8 << 20
    /// How long a chunked message may stay incomplete.
    public static let chunkTimeout = Duration.seconds(30)
}

/// What the receiving side gets out of one frame.
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
/// - Remarks: Pure: time is passed in, so tests drive it with any clock. The timeout runs from
///   the first 0x01 chunk of a message. Heartbeats and control frames may arrive between chunks.
/// - Side effects: none.
public struct FrameReassembler<Instant: InstantProtocol> where Instant.Duration == Duration {
    /// Largest complete message accepted.
    public let limit: Int
    /// How long a chunked message may stay open.
    public let timeout: Duration
    private var buffer = Data()
    private var startedAt: Instant?

    /// Creates a reassembler for one receive direction.
    ///
    /// - Side effects: none.
    public init(limit: Int, timeout: Duration = ChannelLimits.chunkTimeout) {
        self.limit = limit
        self.timeout = timeout
    }

    /// When the open chunked message times out, or `nil` when none is open.
    public var deadline: Instant? { startedAt?.advanced(by: timeout) }

    /// Feeds one decoded frame received at `now`.
    ///
    /// - Side effects: none.
    /// - Returns: The event to act on, or `nil` when a chunk only extended an open message.
    /// - Throws: ``RemoteError/chunkTimeout``, ``RemoteError/messageTooLarge(limit:)`` or
    ///   ``RemoteError/badUTF8``.
    public mutating func receive(_ frame: ChannelFrame, at now: Instant) throws(RemoteError) -> ChannelEvent? {
        try checkTimeout(at: now)
        switch frame {
        case .heartbeat: return .heartbeat
        case .heartbeatAck: return .heartbeatAck
        case .control(let body): return .control(body)
        case .chunk(let body, let isLast):
            guard buffer.count + body.count <= limit else { throw .messageTooLarge(limit: limit) }
            buffer += body
            if isLast {
                let message = buffer
                buffer = Data()
                startedAt = nil
                guard String(data: message, encoding: .utf8) != nil else { throw .badUTF8 }
                return .message(message)
            }
            if startedAt == nil { startedAt = now }
            return nil
        }
    }

    /// Fails when an open chunked message has passed its deadline.
    ///
    /// - Side effects: none.
    /// - Throws: ``RemoteError/chunkTimeout``.
    public func checkTimeout(at now: Instant) throws(RemoteError) {
        if let deadline, now >= deadline { throw .chunkTimeout }
    }
}
