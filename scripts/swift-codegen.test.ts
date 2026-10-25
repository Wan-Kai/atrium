import { describe, expect, it } from "vitest";
import { generateSwift } from "./swift-codegen.mjs";

/**
 * Generates Swift for a bundle of schemas at protocol version 1.
 *
 * @remarks
 * Most cases only differ in the schemas.
 *
 * @sideEffects none
 * @param schemas - The named schemas.
 * @param caseNames - Case names for boolean discriminators, by union.
 * @returns The generated source.
 */
function swift(schemas: Record<string, unknown>, caseNames: Record<string, Record<string, string>> = {}): string {
  return generateSwift({ protocolVersion: 1, schemas }, { caseNames });
}

const strictObject = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

describe("generateSwift", () => {
  it("writes an object as a struct that keeps required, nullable, omittable and constant fields apart", () => {
    const source = swift({
      Id: { type: "string", minLength: 1 },
      Thing: strictObject(
        {
          type: { type: "string", const: "thing" },
          id: { $ref: "Id" },
          count: { type: "integer", minimum: 0 },
          ratio: { type: ["number", "null"] },
          note: { type: "string" },
          model: { anyOf: [{ $ref: "Id" }, { type: "null" }] },
          args: { type: "object", propertyNames: { type: "string" }, additionalProperties: {} },
          status: { type: "string", enum: ["running", "too_large"] },
          windows: { type: "array", items: strictObject({ seconds: { type: "integer" } }, ["seconds"]) },
        },
        ["type", "id", "count", "ratio", "status", "windows", "args"],
      ),
    });

    expect(source).toContain("public let protocolVersion = 1\n");
    expect(source).toContain("public typealias Id = String\n");
    expect(source).toContain(
      [
        "public struct Thing: Codable, Sendable, Equatable {",
        "  public var id: Id",
        "  public var count: Int",
        "  public var ratio: Double?",
        "  public var note: String?",
        "  public var model: Nullable<Id>?",
        "  public var args: [String: JSONValue]",
        "  public var status: Status",
        "  public var windows: [Window]",
      ].join("\n"),
    );
    expect(source).toContain(
      "  public init(\n    id: Id,\n    count: Int,\n    ratio: Double?,\n    note: String? = nil,\n    model: Nullable<Id>? = nil,\n",
    );
    expect(source).toContain('    try container.expect("type", "thing")\n');
    expect(source).toContain('    self.ratio = try container.decodeNullable(Double.self, forKey: "ratio")\n');
    expect(source).toContain('    self.note = try container.decodeOmittable(String.self, forKey: "note")\n');
    expect(source).toContain('    self.model = try container.decodeOmittableNullable(Id.self, forKey: "model")\n');
    expect(source).toContain('    try container.encode("thing", forKey: "type")\n');
    expect(source).toContain('    try container.encodeNullable(self.ratio, forKey: "ratio")\n');
    expect(source).toContain('    try container.encodeIfPresent(self.note, forKey: "note")\n');
    expect(source).toContain('    try container.encodeOmittableNullable(self.model, forKey: "model")\n');
    expect(source).toContain(
      '  public enum Status: String, Codable, Sendable, Equatable, CaseIterable {\n    case running\n    case tooLarge = "too_large"\n  }\n',
    );
    expect(source).toContain("  public struct Window: Codable, Sendable, Equatable {\n    public var seconds: Int\n");
  });

  it("writes a discriminated union as an enum that reads the discriminator first, members without fields as bare cases", () => {
    const source = swift({
      PingCommand: strictObject({ type: { type: "string", const: "ping" } }, ["type"]),
      StopCommand: strictObject({ type: { type: "string", const: "stop_run" }, sessionId: { type: "string" } }, [
        "type",
        "sessionId",
      ]),
      Command: { oneOf: [{ $ref: "PingCommand" }, { $ref: "StopCommand" }] },
      Hello: strictObject({ type: { type: "string", const: "hello" } }, ["type"]),
      Client: { anyOf: [{ $ref: "Hello" }, { $ref: "Command" }] },
      File: {
        oneOf: [
          strictObject({ kind: { type: "string", const: "text" }, text: { type: "string" } }, ["kind", "text"]),
          strictObject({ kind: { type: "string", enum: ["binary", "too_large"] } }, ["kind"]),
          strictObject({ kind: { type: "string", const: "gone" } }, ["kind"]),
        ],
      },
    });

    expect(source).toContain(
      "public enum Command: Codable, Sendable, Equatable {\n  case ping(PingCommand)\n  case stopRun(StopCommand)\n",
    );
    expect(source).toContain('    switch try container.decode(String.self, forKey: "type") {\n');
    expect(source).toContain('    case "stop_run": self = .stopRun(try StopCommand(from: decoder))\n');
    expect(source).toContain('    case let other: try container.unknown("type", other, in: "Command")\n');
    // A member that is itself a union is named after it and dispatched on all its values.
    expect(source).toContain("  case hello(Hello)\n  case command(Command)\n");
    expect(source).toContain('    case "ping", "stop_run": self = .command(try Command(from: decoder))\n');
    expect(source).toContain("  case text(Text)\n  case binary\n  case tooLarge\n  case gone\n");
    expect(source).toContain('    case "too_large": self = .tooLarge\n');
    expect(source).toContain(
      '    case .tooLarge:\n      var container = encoder.container(keyedBy: AnyKey.self)\n      try container.encode("too_large", forKey: "kind")\n',
    );
    expect(source).toContain("  public struct Text: Codable, Sendable, Equatable {\n    public var text: String\n");
  });

  it("names a boolean discriminator's cases as told, and refuses one it was not told about", () => {
    const schemas = {
      Response: {
        oneOf: [
          strictObject({ ok: { type: "boolean", const: true }, result: {} }, ["ok"]),
          strictObject({ ok: { type: "boolean", const: false }, code: { type: "string" } }, ["ok", "code"]),
        ],
      },
    };
    const source = swift(schemas, { Response: { true: "success", false: "failure" } });

    expect(source).toContain("  case success(Success)\n  case failure(Failure)\n");
    expect(source).toContain('    switch try container.decode(Bool.self, forKey: "ok") {\n');
    expect(source).toContain("    case true: self = .success(try Success(from: decoder))\n");
    expect(source).toContain('      self.result = try container.decodeOmittable(JSONValue.self, forKey: "result")\n');
    expect(() => swift(schemas)).toThrow('#/Response/oneOf/0: name the case for ok = true in caseNames["Response"]');
  });

  it("tells objects apart by a key only one of them has, and scalars by their kind", () => {
    const source = swift({
      Answer: {
        anyOf: [
          strictObject({ value: { type: "string" } }, ["value"]),
          strictObject({ cancelled: { type: "boolean", const: true } }, ["cancelled"]),
        ],
      },
      Reserve: { anyOf: [{ anyOf: [{ type: "integer" }, { type: "string", const: "off" }] }, { type: "null" }] },
      Metrics: strictObject({ reserve: { $ref: "Reserve" } }, ["reserve"]),
      Container: {
        anyOf: [
          { type: "string", pattern: "^a" },
          { type: "string", pattern: "^b" },
        ],
      },
    });

    expect(source).toContain(
      "public enum Answer: Codable, Sendable, Equatable {\n  case value(Value)\n  case cancelled\n",
    );
    expect(source).toContain(
      '    if container.contains("value") {\n      self = .value(try Value(from: decoder))\n    } else if container.contains("cancelled") {\n      try container.expect("cancelled", true)\n      self = .cancelled\n    } else {\n      try container.noMember(of: "Answer")\n    }\n',
    );
    expect(source).toContain("public enum Reserve: Codable, Sendable, Equatable {\n  case int(Int)\n  case off\n");
    expect(source).toContain("  public var reserve: Reserve?\n");
    expect(source).toContain('    self.reserve = try container.decodeNullable(Reserve.self, forKey: "reserve")\n');
    expect(source).toContain("public typealias Container = String\n");
  });

  it("keeps nested names clear of top-level types and Swift's own, and escapes keywords", () => {
    const source = swift({
      Step: { type: "string" },
      Item: strictObject(
        {
          step: strictObject({ default: { type: "string" } }, ["default"]),
          type: { type: "string", enum: ["in", "1x"] },
        },
        ["step", "type"],
      ),
    });

    expect(source).toContain("  public var step: StepValue\n  public var type: TypeValue\n");
    expect(source).toContain("    public var `default`: String\n");
    expect(source).toContain('    case `in`\n    case v1x = "1x"\n');
  });

  it("keeps an optional constant as an optional value that must be the constant when present", () => {
    const source = swift({ Forked: strictObject({ noteSent: { type: "boolean", const: false } }, []) });

    expect(source).toContain("  public var noteSent: Bool?\n");
    expect(source).toContain('    self.noteSent = try container.decodeOmittableConstant(false, forKey: "noteSent")\n');
    expect(source).toContain('    try container.encodeIfPresent(self.noteSent, forKey: "noteSent")\n');
  });

  it("refuses what the protocol does not use, saying where", () => {
    expect(() => swift({ A: { allOf: [{ type: "string" }] } })).toThrow("#/A: unsupported schema (allOf)");
    expect(() => swift({ A: { type: "array", prefixItems: [{ type: "string" }] } })).toThrow(
      "#/A: unsupported schema (prefixItems)",
    );
    expect(() => swift({ A: strictObject({ n: { type: "number", const: 1 } }, ["n"]) })).toThrow(
      "#/A/properties/n: unsupported constant 1",
    );
    expect(() =>
      swift({
        A: {
          oneOf: [
            strictObject({ kind: { type: "string", const: "a" }, x: { type: "string" } }, ["kind", "x"]),
            strictObject({ kind: { type: "string", const: "a" }, x: { type: "integer" } }, ["kind", "x"]),
          ],
        },
      }),
    ).toThrow("#/A: no discriminator and no key only one member has");
    expect(() => swift({ A: { $ref: "Missing" } })).toThrow("#/A: unknown reference Missing");
  });

  it("writes the same output for the same input, types in name order", () => {
    const schemas = { B: { type: "string" }, A: { type: "integer" } };

    expect(swift(schemas)).toBe(swift(schemas));
    expect(swift(schemas).indexOf("typealias A")).toBeLessThan(swift(schemas).indexOf("typealias B"));
  });
});
