import AtriumProtocol
import Foundation
import Testing

@Suite("Coding support")
struct CodingSupportTests {
  @Test("tells a missing setting from one cleared with null")
  func nullable() throws {
    let decoder = JSONDecoder()
    let missing = try decoder.decode(
      SetPreferencesCommand.self, from: Data(#"{"type":"set_preferences","requestId":"r","traceparent":""}"#.utf8))
    let cleared = try decoder.decode(
      SetPreferencesCommand.self,
      from: Data(#"{"type":"set_preferences","requestId":"r","traceparent":"","proxy":null}"#.utf8))
    #expect(missing.proxy == nil)
    #expect(cleared.proxy == .null)
    let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(cleared))
    #expect(
      encoded
        == .object([
          "type": .string("set_preferences"), "requestId": .string("r"), "traceparent": .string(""), "proxy": .null,
        ]))
  }

  @Test("refuses null where a field may only be left out, and a missing field that may only be null")
  func strictNulls() {
    #expect(throws: DecodingError.self) {
      try JSONDecoder().decode(
        SetPreferencesCommand.self,
        from: Data(#"{"type":"set_preferences","requestId":"r","traceparent":"","inbox":null}"#.utf8))
    }
    #expect(throws: DecodingError.self) {
      try JSONDecoder().decode(ContainerTabs.self, from: Data(#"{"open":[]}"#.utf8))
    }
  }

  @Test("keeps null in an open field that may be left out, apart from leaving it out")
  func openNull() throws {
    let json = #"{"type":"response","requestId":"r","ok":true,"result":null}"#
    let response = try JSONDecoder().decode(ResponseMessage.self, from: Data(json.utf8))
    #expect(response == .success(.init(requestId: "r", result: .null)))
    let again = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(response))
    #expect(again == (try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))))
  }

  @Test("keeps an optional constant only when it is there and has its one value")
  func optionalConstant() throws {
    let decoder = JSONDecoder()
    #expect(try decoder.decode(ForkSessionResult.self, from: Data(#"{"sessionId":"s"}"#.utf8)).noteSent == nil)
    #expect(
      try decoder.decode(ForkSessionResult.self, from: Data(#"{"sessionId":"s","noteSent":false}"#.utf8)).noteSent
        == false)
    #expect(throws: DecodingError.self) {
      try decoder.decode(ForkSessionResult.self, from: Data(#"{"sessionId":"s","noteSent":true}"#.utf8))
    }
  }

  @Test("refuses to write an optional constant that is not its one value")
  func optionalConstantEncoding() throws {
    let encoder = JSONEncoder()
    #expect(throws: EncodingError.self) { try encoder.encode(ForkSessionResult(sessionId: "s", noteSent: true)) }
    let written = try JSONDecoder().decode(
      JSONValue.self, from: encoder.encode(ForkSessionResult(sessionId: "s", noteSent: false)))
    #expect(written == .object(["sessionId": .string("s"), "noteSent": .bool(false)]))
  }

  @Test("reads a count or off, and nothing else, for the context reserve")
  func scalarUnion() throws {
    let decoder = JSONDecoder()
    #expect(try decoder.decode(ContextReserve.self, from: Data("12".utf8)) == .int(12))
    #expect(try decoder.decode(ContextReserve.self, from: Data(#""off""#.utf8)) == .off)
    #expect(throws: DecodingError.self) { try decoder.decode(ContextReserve.self, from: Data(#""on""#.utf8)) }
  }

  @Test("tells answers apart by the key only one of them has")
  func untagged() throws {
    let decoder = JSONDecoder()
    #expect(try decoder.decode(InteractionAnswer.self, from: Data(#"{"cancelled":true}"#.utf8)) == .cancelled)
    #expect(throws: DecodingError.self) {
      try decoder.decode(InteractionAnswer.self, from: Data(#"{"cancelled":false}"#.utf8))
    }
    #expect(throws: DecodingError.self) { try decoder.decode(InteractionAnswer.self, from: Data("{}".utf8)) }
  }

  @Test("reads any JSON value back as it was")
  func jsonValue() throws {
    let text = #"{"a":[1,2.5,true,null,"x"],"b":{}}"#
    let value = try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    #expect(
      value == .object(["a": .array([.number(1), .number(2.5), .bool(true), .null, .string("x")]), "b": .object([:])]))
    #expect(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value)) == value)
  }
}
