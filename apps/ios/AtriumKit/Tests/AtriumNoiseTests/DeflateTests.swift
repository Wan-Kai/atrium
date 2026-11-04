import Foundation
import Testing

@testable import AtriumNoise

/// A 2258-byte list the host's Node deflated at level 6 into 291 bytes.
///
/// - Remark: Made with `zlib.deflateRawSync`, so this proves the two sides speak the same raw
///   deflate (SPEC-0005 "Noise 通道 · 压缩"). Empty if the text did not decode, which fails every test.
private let fromNode =
  Data(
    base64Encoded:
      "jdVNSgNREMTxq0ivZ2FX5XNu4BmCyOC8kAGdBF8QJeQigmfwAh7HhceQLLKxZlHL9+C/6h/dpzi+H0q0MYx9eXuoY3eou/0xmqil1mE/1mg3p+vjro826m00MXbPl+rn++P36/Pm8tO9PO6G19JHu+2eajk3/6qUKo0KUsGoKBWNaibVzKjmUs2NaiHVwqiWUi2NaiXVyqjWUq2dKSuOtHRM8HB8pAJJR0gqkXSMpCJJR0kqk3ScpEJJR0oqlXSspGJJR0sql3S8QL3A8QL1AmufTCwUxwvUCxwvUC9wvEC9wPEC9QLHC9QLHC9QL3C8QL3A8UL1QscL1QsdL1QvtC7QxAlyvFC90PFC9ULHC9ULHS9UL3S8UL3Q8UL1wikv9+c/"
  ) ?? Data()

@Suite("Deflated messages")
struct DeflateTests {
  @Test("a message the host deflated inflates whole, in one chunk or several")
  func inflatesWhatNodeDeflated() throws {
    var whole = FrameReassembler<ContinuousClock.Instant>(limit: ChannelLimits.hostToPhone, inflates: true)
    guard case .message(let message) = try whole.receive(.deflatedChunk(fromNode, isLast: true), at: instant(0))
    else {
      Issue.record("expected a message")
      return
    }
    #expect(message.count == 2258)
    #expect(
      String(decoding: message, as: UTF8.self).hasPrefix(
        #"{"type":"index_snapshot","sessions":[{"sessionId":"s0","name":"会话 0""#))

    var split = FrameReassembler<ContinuousClock.Instant>(limit: ChannelLimits.hostToPhone, inflates: true)
    #expect(try split.receive(.deflatedChunk(fromNode.prefix(100), isLast: false), at: instant(0)) == nil)
    #expect(split.deadline == instant(30))
    #expect(
      try split.receive(.deflatedChunk(fromNode.dropFirst(100), isLast: true), at: instant(1)) == .message(message))
    #expect(split.deadline == nil)
  }

  @Test("0x05 and 0x06 decode and encode as deflated chunks")
  func frameTypes() throws {
    #expect(try ChannelFrame.decode(Data([0x05, 0xaa])) == .deflatedChunk(Data([0xaa]), isLast: true))
    #expect(try ChannelFrame.decode(Data([0x06, 0xbb])) == .deflatedChunk(Data([0xbb]), isLast: false))
    #expect(ChannelFrame.deflatedChunk(Data([0xaa]), isLast: true).encoded() == Data([0x05, 0xaa]))
    #expect(ChannelFrame.deflatedChunk(Data([0xbb]), isLast: false).encoded() == Data([0x06, 0xbb]))
  }

  @Test("deflated chunks are refused unless asked for, mixed with plain ones, corrupt, or inflating past the limit")
  func refusals() throws {
    var plain = FrameReassembler<ContinuousClock.Instant>(limit: ChannelLimits.hostToPhone)
    #expect(throws: WireError.unknownFrameType(0x05)) {
      try plain.receive(.deflatedChunk(fromNode, isLast: true), at: instant(0))
    }
    var mixed = FrameReassembler<ContinuousClock.Instant>(limit: ChannelLimits.hostToPhone, inflates: true)
    _ = try mixed.receive(.chunk(Data("x".utf8), isLast: false), at: instant(0))
    #expect(throws: WireError.badFrame) { try mixed.receive(.deflatedChunk(fromNode, isLast: true), at: instant(0)) }
    var other = FrameReassembler<ContinuousClock.Instant>(limit: ChannelLimits.hostToPhone, inflates: true)
    _ = try other.receive(.deflatedChunk(fromNode.prefix(10), isLast: false), at: instant(0))
    #expect(throws: WireError.badFrame) { try other.receive(.chunk(Data("x".utf8), isLast: true), at: instant(0)) }
    var corrupt = FrameReassembler<ContinuousClock.Instant>(limit: ChannelLimits.hostToPhone, inflates: true)
    #expect(throws: WireError.badFrame) {
      try corrupt.receive(.deflatedChunk(Data([0xff, 0xff, 0xff]), isLast: true), at: instant(0))
    }
    var truncated = FrameReassembler<ContinuousClock.Instant>(limit: ChannelLimits.hostToPhone, inflates: true)
    #expect(throws: WireError.badFrame) {
      try truncated.receive(.deflatedChunk(fromNode.prefix(100), isLast: true), at: instant(0))
    }
    // Raw deflate always has a block, so nothing at all is corrupt too.
    #expect(throws: WireError.badFrame) { try Inflate.raw(Data(), limit: 2258) }
    var small = FrameReassembler<ContinuousClock.Instant>(limit: 2257, inflates: true)
    #expect(throws: WireError.messageTooLarge(limit: 2257)) {
      try small.receive(.deflatedChunk(fromNode, isLast: true), at: instant(0))
    }
    var exact = FrameReassembler<ContinuousClock.Instant>(limit: 2258, inflates: true)
    #expect(try exact.receive(.deflatedChunk(fromNode, isLast: true), at: instant(0)) != nil)
  }
}
