import { z } from "zod";
import { CommandResult } from "./commands";
import * as protocol from "./index";
import { PROTOCOL_VERSION } from "./version";

/** The protocol as JSON Schema, one named schema per export, for the Swift generator. */
export interface ProtocolJsonSchema {
  /** The wire protocol version these schemas belong to. */
  readonly protocolVersion: number;
  /** Each schema by name; `$ref` values are these names. */
  readonly schemas: Readonly<Record<string, Record<string, unknown>>>;
  /** The name of each command's result schema, by the command's `type`. */
  readonly commandResults: Readonly<Record<string, string>>;
}

/**
 * Exports every schema of the protocol as JSON Schema, named as it is exported.
 *
 * @remarks
 * The iOS app's `Codable` types are generated from this (ADR-0015, `pnpm protocol:swift`). Naming
 * each schema by its export makes the generated Swift types carry the same names as the
 * TypeScript ones, and references between them stay references instead of being inlined. The
 * results of commands are not exports of their own (`CommandResult` is a plain object), so each
 * is named after its command, `prompt` → `PromptResult`, and listed by command so the app can
 * decode the result of the command it sent. Unrepresentable schemas throw rather
 * than being silently widened.
 *
 * @sideEffects none
 * @returns The protocol version, the result schema of each command, and the schemas, without each schema's `$schema` and `$id`, which the name already says.
 */
export function protocolJsonSchema(): ProtocolJsonSchema {
  const registry = z.registry<{ id: string }>();
  for (const [name, value] of Object.entries(protocol)) {
    if (value instanceof z.ZodType) registry.add(value, { id: name });
  }
  const commandResults: Record<string, string> = {};
  for (const [type, result] of Object.entries(CommandResult)) {
    commandResults[type] = `${pascalCase(type)}Result`;
    registry.add(result, { id: commandResults[type] });
  }
  // Stryker disable next-line StringLiteral,ObjectLiteral: both are zod 4.6.5's defaults, written out so a changed default cannot widen or rename anything unseen.
  const { schemas } = z.toJSONSchema(registry, { unrepresentable: "throw", uri: (id) => id });
  const named: Record<string, Record<string, unknown>> = {};
  for (const [name, schema] of Object.entries(schemas)) {
    const { $schema: _dialect, $id: _id, ...rest } = schema;
    named[name] = rest;
  }
  return { protocolVersion: PROTOCOL_VERSION, schemas: named, commandResults };
}

/**
 * Turns a command type into the name of its result type.
 *
 * @remarks
 * Command types are snake case (`create_chat`); Swift type names are upper camel case.
 *
 * @sideEffects none
 * @param type - The command type.
 * @returns It in upper camel case.
 */
function pascalCase(type: string): string {
  return type.replaceAll(/(?:^|_)([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}
