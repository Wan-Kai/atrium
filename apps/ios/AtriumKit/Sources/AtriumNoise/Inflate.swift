import Compression
import Foundation

/// Raw inflate (RFC 1951) of a whole message, as the host deflates it (SPEC-0005 "Noise 通道 · 压缩").
///
/// - Remark: Apple's `COMPRESSION_ZLIB` is raw deflate, the same as Node's `deflateRawSync`. Streams
///   in steps and stops as soon as the output would pass the limit, so a small message cannot
///   inflate without bound.
enum Inflate {
  /// Bytes written per step.
  private static let step = 64 * 1024

  /// Inflates `data`, giving at most `limit` bytes.
  ///
  /// - Remark: Truncated input is corrupt, not short: the stream must reach its end.
  /// - SideEffects: none
  /// - Parameters:
  ///   - data: The deflated bytes.
  ///   - limit: The most bytes the message may have.
  /// - Returns: The message.
  /// - Throws: ``WireError/messageTooLarge(limit:)`` past the limit, ``WireError/badFrame`` when corrupt.
  static func raw(_ data: Data, limit: Int) throws(WireError) -> Data {
    let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
    defer { stream.deallocate() }
    guard compression_stream_init(stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK
    else { throw .badFrame }
    defer { compression_stream_destroy(stream) }
    let input = [UInt8](data)
    var output = Data()
    var buffer = [UInt8](repeating: 0, count: step)
    return try input.withUnsafeBufferPointer { (source) throws(WireError) -> Data in
      stream.pointee.src_ptr = source.baseAddress ?? UnsafePointer(buffer)
      stream.pointee.src_size = source.count
      while true {
        let status = buffer.withUnsafeMutableBufferPointer { target in
          guard let base = target.baseAddress else { return COMPRESSION_STATUS_ERROR }
          stream.pointee.dst_ptr = base
          stream.pointee.dst_size = target.count
          return compression_stream_process(stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
        }
        let written = step - stream.pointee.dst_size
        guard status != COMPRESSION_STATUS_ERROR else { throw .badFrame }
        guard output.count + written <= limit else { throw .messageTooLarge(limit: limit) }
        output.append(contentsOf: buffer.prefix(written))
        if status == COMPRESSION_STATUS_END { return output }
        // Not finished, with all input read and nothing written: the input stops short.
        guard written > 0 || stream.pointee.src_size > 0 else { throw .badFrame }
      }
    }
  }
}
