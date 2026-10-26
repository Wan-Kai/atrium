/// Any JSON value: what the protocol leaves open, such as a tool's arguments or a command's result.
///
/// - Remark: The protocol has a few places typed as unknown JSON (`z.unknown()`) or as a mix of
///   scalar types (error parameters); the generated types keep them as this instead of guessing a
///   shape (testing.md, "协议类型的生成与往返测试"). Numbers are kept as `Double`, which holds every
///   integer the protocol sends (up to 2^53) exactly, so `1` and `1.0` compare equal.
public enum JSONValue: Codable, Sendable, Equatable {
  /// JSON `null`.
  case null
  /// `true` or `false`.
  case bool(Bool)
  /// Any number.
  case number(Double)
  /// A string.
  case string(String)
  /// An array.
  case array([JSONValue])
  /// An object; key order is not kept.
  case object([String: JSONValue])

  /// Decodes whichever kind of JSON value comes next.
  ///
  /// - Remark: Booleans are tried before numbers, since some decoders read `true` as `1`.
  /// - SideEffects: none
  /// - Parameter decoder: The decoder positioned at the value.
  /// - Throws: `DecodingError.dataCorrupted` when the value is not JSON.
  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else if let value = try? container.decode([String: JSONValue].self) {
      self = .object(value)
    } else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "not a JSON value")
    }
  }

  /// Encodes the value as it is.
  ///
  /// - Remark: Paired with `init(from:)` so a value survives a round trip.
  /// - SideEffects: Writes to the encoder.
  /// - Parameter encoder: Where the value goes.
  /// - Throws: Whatever the encoder throws.
  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null: try container.encodeNil()
    case .bool(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .string(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .object(let value): try container.encode(value)
    }
  }
}
