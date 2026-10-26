import { describe, expect, it } from "vitest";
import { z } from "zod";
import { COMMAND_TYPES } from "./commands";
import * as protocol from "./index";
import { protocolJsonSchema } from "./json-schema";
import { PROTOCOL_VERSION } from "./version";

/**
 * Lists every `$ref` in a JSON Schema document, depth first.
 *
 * @remarks
 * The Swift generator resolves references by name, so each must name a schema in the bundle.
 *
 * @sideEffects none
 * @param node - Any part of the document.
 * @returns The referenced names.
 */
function refs(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(refs);
  if (typeof node !== "object" || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) =>
    key === "$ref" && typeof value === "string" ? [value] : refs(value),
  );
}

describe("protocolJsonSchema", () => {
  it("names every exported schema by its export, and each command's result by the command", () => {
    const { schemas } = protocolJsonSchema();
    const exported = Object.entries(protocol)
      .filter(([, value]) => value instanceof z.ZodType)
      .map(([name]) => name);
    const results = [...COMMAND_TYPES].map(
      (type) => `${type.replaceAll(/(?:^|_)([a-z])/gu, (_match, letter: string) => letter.toUpperCase())}Result`,
    );

    expect(Object.keys(schemas).toSorted()).toStrictEqual([...exported, ...results].toSorted());
    expect(schemas["PromptResult"]).toBeInstanceOf(Object);
    expect(schemas["SessionId"]).toStrictEqual({ type: "string", minLength: 1, maxLength: 128 });
  });

  it("names the result schema of every command, by the command's type", () => {
    const { schemas, commandResults } = protocolJsonSchema();

    expect(Object.keys(commandResults).toSorted()).toStrictEqual([...COMMAND_TYPES].toSorted());
    expect(commandResults["prompt"]).toBe("PromptResult");
    expect(commandResults["fetch_transcript"]).toBe("FetchTranscriptResult");
    expect(Object.values(commandResults).filter((name) => schemas[name] === undefined)).toStrictEqual([]);
  });

  it("refers to other schemas only by names in the bundle, and carries the protocol version", () => {
    const bundle = protocolJsonSchema();
    const names = new Set(Object.keys(bundle.schemas));

    expect(refs(bundle.schemas).filter((name) => !names.has(name))).toStrictEqual([]);
    expect(refs(bundle.schemas["Command"])).toContain("PromptCommand");
    expect(bundle.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});
