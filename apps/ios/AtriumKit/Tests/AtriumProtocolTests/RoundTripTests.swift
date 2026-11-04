import AtriumProtocol
import Foundation
import Testing

/// Reads one fixture file as a list of raw JSON messages.
///
/// - Remark: The fixtures are written from `envelope.test.ts` (testing.md, "协议类型的生成与往返测试").
/// - SideEffects: Reads a file from the test bundle.
/// - Parameter name: The file's name without `.json`.
/// - Returns: Each message's JSON.
/// - Throws: When the file is missing or not a JSON array.
func fixtureMessages(_ name: String) throws -> [Data] {
  let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
  let list = try JSONDecoder().decode([JSONValue].self, from: Data(contentsOf: url))
  return try list.map { try JSONEncoder().encode($0) }
}

/// Decodes a message as `T`, encodes it again, and compares the two as JSON values.
///
/// - Remark: Compared as `JSONValue`, so key order and `1` against `1.0` do not count.
/// - SideEffects: none
/// - Parameters:
///   - type: The message type.
///   - json: The message.
/// - Throws: Whatever decoding or encoding throws; records an issue when the two differ.
func expectRoundTrip<T: Codable>(_ type: T.Type, _ json: Data) throws {
  let decoded = try JSONDecoder().decode(type, from: json)
  let again = try JSONEncoder().encode(decoded)
  let before = try JSONDecoder().decode(JSONValue.self, from: json)
  let after = try JSONDecoder().decode(JSONValue.self, from: again)
  #expect(after == before, "\(String(decoding: json, as: UTF8.self))")
}

@Suite("Protocol round trip")
struct RoundTripTests {
  @Test("decodes and re-encodes every example the client sends, unchanged")
  func clientMessages() throws {
    let messages = try fixtureMessages("client-messages")
    #expect(messages.count > 100)
    for message in messages { try expectRoundTrip(ClientMessage.self, message) }
  }

  @Test("decodes and re-encodes every example the host sends, unchanged")
  func hostMessages() throws {
    let messages = try fixtureMessages("host-messages")
    #expect(messages.count > 100)
    for message in messages { try expectRoundTrip(HostMessage.self, message) }
  }

  @Test("decodes and re-encodes every command's result as the type of its own result, unchanged")
  func commandResults() throws {
    let url = try #require(
      Bundle.module.url(forResource: "command-results", withExtension: "json", subdirectory: "Fixtures"))
    let results = try JSONDecoder().decode([String: [JSONValue]].self, from: Data(contentsOf: url))
    #expect(results.count > 70)
    for (command, examples) in results {
      let type = try #require(commandResultType(command), "no result type for \(command)")
      #expect(!examples.isEmpty, "no example of \(command)'s result")
      for example in examples { try expectRoundTrip(type, JSONEncoder().encode(example)) }
    }
  }

  @Test("knows no result type for a command that does not exist")
  func unknownCommand() {
    #expect(commandResultType("pong") == nil)
  }

  @Test("reads each message as the kind its type says")
  func dispatch() throws {
    let ping = try JSONDecoder().decode(
      ClientMessage.self, from: Data(#"{"type":"ping","requestId":"r1","traceparent":""}"#.utf8))
    #expect(ping == .command(.ping(PingCommand(requestId: "r1", traceparent: ""))))
    let failure = try JSONDecoder().decode(
      HostMessage.self,
      from: Data(#"{"type":"response","requestId":null,"ok":false,"error":{"code":"invalid_message"}}"#.utf8))
    #expect(
      failure == .responseMessage(.failure(.init(requestId: nil, error: ErrorInfo(code: .invalidMessage)))))
  }

  @Test("refuses an unknown message type, a wrong constant and a missing field")
  func refusals() {
    let decoder = JSONDecoder()
    #expect(throws: DecodingError.self) {
      try decoder.decode(ClientMessage.self, from: Data(#"{"type":"pong","requestId":"r1"}"#.utf8))
    }
    #expect(throws: DecodingError.self) {
      try decoder.decode(PingCommand.self, from: Data(#"{"type":"stop","requestId":"r1","traceparent":""}"#.utf8))
    }
    #expect(throws: DecodingError.self) {
      try decoder.decode(PingCommand.self, from: Data(#"{"type":"ping","traceparent":""}"#.utf8))
    }
  }

  @Test("carries the protocol version the types were generated from")
  func version() {
    #expect(protocolVersion == 30)
  }
}
