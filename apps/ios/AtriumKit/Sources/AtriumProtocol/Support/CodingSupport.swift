import Foundation

/// A coding key made from any string, so generated code can name JSON keys directly.
///
/// - Remark: The generated types read and write the exact keys of the JSON Schema, some of which
///   are not valid enum case names; one string-backed key type avoids a `CodingKeys` enum per type.
public struct AnyKey: CodingKey, ExpressibleByStringLiteral, Sendable {
  /// The JSON key.
  public var stringValue: String
  /// Always `nil`: protocol objects have no integer keys.
  public var intValue: Int? { nil }

  /// Makes a key from its JSON name.
  ///
  /// - Remark: Required by `CodingKey`.
  /// - SideEffects: none
  /// - Parameter stringValue: The JSON key.
  public init(stringValue: String) { self.stringValue = stringValue }

  /// Refuses integer keys.
  ///
  /// - Remark: Required by `CodingKey`; protocol objects only have string keys.
  /// - SideEffects: none
  /// - Parameter intValue: Ignored.
  public init?(intValue: Int) { nil }

  /// Makes a key from a string literal, as generated code writes them.
  ///
  /// - Remark: Lets generated code say `forKey: "sessionId"`.
  /// - SideEffects: none
  /// - Parameter value: The JSON key.
  public init(stringLiteral value: String) { self.stringValue = value }
}

extension KeyedDecodingContainer where Key == AnyKey {
  /// Reads a field that must be there and may be `null`.
  ///
  /// - Remark: `decodeIfPresent` would also accept the key being left out, which the protocol
  ///   does not allow for these fields.
  /// - SideEffects: none
  /// - Parameters:
  ///   - type: The type of a value that is not `null`.
  ///   - key: The JSON key.
  /// - Returns: `nil` for `null`, else the value.
  /// - Throws: `DecodingError.keyNotFound` when the key is missing; whatever decoding the value throws.
  public func decodeNullable<T: Decodable>(_ type: T.Type, forKey key: AnyKey) throws -> T? {
    guard contains(key) else {
      throw DecodingError.keyNotFound(
        key, DecodingError.Context(codingPath: codingPath, debugDescription: "missing \(key.stringValue)"))
    }
    return try decodeNil(forKey: key) ? nil : decode(type, forKey: key)
  }

  /// Reads a field that may be left out.
  ///
  /// - Remark: Unlike `decodeIfPresent`, which reads `null` as left out, this lets `decode` refuse
  ///   `null` for every type that has no `null` of its own, so a host that sends something the schema
  ///   forbids is noticed. `JSONValue` has one, so an open field (`z.unknown().optional()`) keeps it.
  /// - SideEffects: none
  /// - Parameters:
  ///   - type: The type of the value.
  ///   - key: The JSON key.
  /// - Returns: `nil` when the key is missing, else the value.
  /// - Throws: `DecodingError.valueNotFound` for `null` where the type has none; whatever decoding
  ///   the value throws.
  public func decodeOmittable<T: Decodable>(_ type: T.Type, forKey key: AnyKey) throws -> T? {
    guard contains(key) else { return nil }
    return try decode(type, forKey: key)
  }

  /// Reads a field that may be left out or `null`, keeping the two apart.
  ///
  /// - Remark: See `Nullable`.
  /// - SideEffects: none
  /// - Parameters:
  ///   - type: The type of a value that is not `null`.
  ///   - key: The JSON key.
  /// - Returns: `nil` when the key is missing, `.null` for `null`, else the value.
  /// - Throws: Whatever decoding the value throws.
  public func decodeOmittableNullable<T: Decodable & Sendable & Equatable>(
    _ type: T.Type, forKey key: AnyKey
  ) throws -> Nullable<T>? {
    guard contains(key) else { return nil }
    return try decodeNil(forKey: key) ? .null : .value(decode(type, forKey: key))
  }

  /// Reads an optional field that, when present, must hold the one value the schema allows.
  ///
  /// - Remark: `fork_session` answers `noteSent: false` only when the note was not sent; the
  ///   generated type keeps it as an optional so its presence is not lost.
  /// - SideEffects: none
  /// - Parameters:
  ///   - value: The only allowed value.
  ///   - key: The JSON key.
  /// - Returns: `nil` when the key is missing, else the value.
  /// - Throws: `DecodingError.dataCorrupted` for any other value, including `null`.
  public func decodeOmittableConstant<T: Decodable & Equatable>(_ value: T, forKey key: AnyKey) throws -> T? {
    guard contains(key) else { return nil }
    guard try decode(T.self, forKey: key) == value else {
      throw DecodingError.dataCorruptedError(forKey: key, in: self, debugDescription: "expected \(value)")
    }
    return value
  }

  /// Checks that a field holds the one string the schema allows.
  ///
  /// - Remark: Constant fields (`type: "ping"`) are not stored in the generated types; checking
  ///   them still stops a message of another kind from being read as this one.
  /// - SideEffects: none
  /// - Parameters:
  ///   - key: The JSON key.
  ///   - value: The only allowed value.
  /// - Throws: `DecodingError.dataCorrupted` for any other value; `keyNotFound` when missing.
  public func expect(_ key: AnyKey, _ value: String) throws {
    let found = try decode(String.self, forKey: key)
    guard found == value else {
      throw DecodingError.dataCorruptedError(
        forKey: key, in: self, debugDescription: "expected \(value), found \(found)")
    }
  }

  /// Checks that a field holds the one boolean the schema allows.
  ///
  /// - Remark: As `expect(_:_:)` for strings; used by `ok` and flags like `cancelled: true`.
  /// - SideEffects: none
  /// - Parameters:
  ///   - key: The JSON key.
  ///   - value: The only allowed value.
  /// - Throws: `DecodingError.dataCorrupted` for the other value; `keyNotFound` when missing.
  public func expect(_ key: AnyKey, _ value: Bool) throws {
    guard try decode(Bool.self, forKey: key) == value else {
      throw DecodingError.dataCorruptedError(forKey: key, in: self, debugDescription: "expected \(value)")
    }
  }

  /// Fails decoding a union whose discriminating field held a value no member has.
  ///
  /// - Remark: Generated unions end their `switch` with this, so an unknown kind of message is an
  ///   error that names the field and the value instead of a silent fallback.
  /// - SideEffects: none
  /// - Parameters:
  ///   - key: The discriminating key.
  ///   - value: What it held.
  ///   - type: The union's name, for the message.
  /// - Returns: Never returns.
  /// - Throws: Always `DecodingError.dataCorrupted`.
  public func unknown(_ key: AnyKey, _ value: String, in type: String) throws -> Never {
    throw DecodingError.dataCorruptedError(
      forKey: key, in: self, debugDescription: "unknown \(type) \(key.stringValue): \(value)")
  }

  /// Fails decoding an untagged union when none of its members' keys is there.
  ///
  /// - Remark: Unions told apart by which key they have (`InteractionAnswer`) end with this.
  /// - SideEffects: none
  /// - Parameter type: The union's name, for the message.
  /// - Returns: Never returns.
  /// - Throws: Always `DecodingError.dataCorrupted`.
  public func noMember(of type: String) throws -> Never {
    throw DecodingError.dataCorrupted(
      DecodingError.Context(codingPath: codingPath, debugDescription: "no member of \(type) matches"))
  }
}

extension KeyedEncodingContainer where Key == AnyKey {
  /// Writes a field that must be there, as `null` when the value is `nil`.
  ///
  /// - Remark: `encodeIfPresent` would leave the key out, which the protocol does not allow for
  ///   these fields.
  /// - SideEffects: Writes to the encoder.
  /// - Parameters:
  ///   - value: The value, or `nil` for `null`.
  ///   - key: The JSON key.
  /// - Throws: Whatever the encoder throws.
  public mutating func encodeNullable<T: Encodable>(_ value: T?, forKey key: AnyKey) throws {
    if let value { try encode(value, forKey: key) } else { try encodeNil(forKey: key) }
  }

  /// Writes an optional field that, when present, must hold the one value the schema allows.
  ///
  /// - Remark: The generated type keeps such a field as a plain optional (`noteSent: Bool?`), which
  ///   can hold values the schema forbids; refusing them here keeps encoding as strict as decoding.
  /// - SideEffects: Writes to the encoder.
  /// - Parameters:
  ///   - value: `nil` to leave the key out, else the value.
  ///   - constant: The only allowed value.
  ///   - key: The JSON key.
  /// - Throws: `EncodingError.invalidValue` for any other value; whatever the encoder throws.
  public mutating func encodeOmittableConstant<T: Encodable & Equatable>(
    _ value: T?, _ constant: T, forKey key: AnyKey
  ) throws {
    guard let value else { return }
    guard value == constant else {
      throw EncodingError.invalidValue(
        value, EncodingError.Context(codingPath: codingPath + [key], debugDescription: "only \(constant) is allowed"))
    }
    try encode(value, forKey: key)
  }

  /// Writes a field that may be left out or `null`, as `Nullable` says.
  ///
  /// - Remark: See `Nullable`.
  /// - SideEffects: Writes to the encoder.
  /// - Parameters:
  ///   - value: `nil` to leave the key out, `.null` for `null`, else the value.
  ///   - key: The JSON key.
  /// - Throws: Whatever the encoder throws.
  public mutating func encodeOmittableNullable<T: Encodable & Sendable & Equatable>(
    _ value: Nullable<T>?, forKey key: AnyKey
  ) throws {
    switch value {
    case nil: return
    case .null: try encodeNil(forKey: key)
    case .value(let value): try encode(value, forKey: key)
    }
  }
}
