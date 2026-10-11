import { z } from "zod";
import { COMMAND_TYPES, Command, RequestId } from "./commands";
import { ErrorInfo } from "./errors";
import { SessionEvent } from "./events";
import { ChangesUpdatedEvent, DiffUpdatedEvent } from "./changes";
import { IndexChangesEvent, IndexSnapshotEvent } from "./listing";
import { HelloMessage, WelcomeMessage } from "./handshake";
import {
  CredentialsChangedEvent,
  InstallOutputEvent,
  InstallUpdatedEvent,
  LoginUpdatedEvent,
  PiLatestEvent,
} from "./setup";

/** A response to a command that succeeded; `result` is checked against `CommandResult`. */
const SuccessResponse = z.strictObject({
  type: z.literal("response"),
  requestId: RequestId,
  ok: z.literal(true),
  result: z.unknown().optional(),
});

/** A response to a command that failed; `requestId` is `null` when it could not be read. */
const FailureResponse = z.strictObject({
  type: z.literal("response"),
  requestId: RequestId.nullable(),
  ok: z.literal(false),
  error: ErrorInfo,
});

/** The host's single answer to each command (SPEC-0001, "应答"). */
export const ResponseMessage = z.discriminatedUnion("ok", [SuccessResponse, FailureResponse]);
export type ResponseMessage = z.infer<typeof ResponseMessage>;

/** Everything a client sends: the handshake, then commands. */
export const ClientMessage = z.union([HelloMessage, Command]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Everything the host sends: the handshake reply, responses and events. */
export const HostMessage = z.union([
  WelcomeMessage,
  ResponseMessage,
  SessionEvent,
  IndexSnapshotEvent,
  IndexChangesEvent,
  ChangesUpdatedEvent,
  DiffUpdatedEvent,
  LoginUpdatedEvent,
  InstallUpdatedEvent,
  InstallOutputEvent,
  PiLatestEvent,
  CredentialsChangedEvent,
]);
export type HostMessage = z.infer<typeof HostMessage>;

/** What `parseClientMessage` makes of one message. */
export type ParsedCommand =
  | { readonly ok: true; readonly command: Command }
  | { readonly ok: false; readonly requestId: string | null; readonly code: "invalid_message" | "unknown_command" };

/**
 * Checks a decoded message from a client against the command schemas.
 *
 * @remarks
 * Every command gets exactly one response, including ones that cannot be run (SPEC-0001, "应答"),
 * so a failure says whether the `type` was unknown or the message malformed, and carries the
 * `requestId` whenever one can be read, letting the client match the error to what it sent.
 *
 * @sideEffects none
 * @param value - The message as decoded from JSON; `undefined` when it was not JSON.
 * @returns The command, or why it was refused.
 */
export function parseClientMessage(value: unknown): ParsedCommand {
  const parsed = Command.safeParse(value);
  if (parsed.success) return { ok: true, command: parsed.data };
  // Stryker disable next-line ConditionalExpression,LogicalOperator: spreading null or a primitive yields no `requestId` or `type` either.
  const fields: Record<string, unknown> = typeof value === "object" && value !== null ? { ...value } : {};
  const requestId = RequestId.safeParse(fields["requestId"]);
  const type = fields["type"];
  return {
    ok: false,
    requestId: requestId.success ? requestId.data : null,
    code: typeof type === "string" && !COMMAND_TYPES.has(type) ? "unknown_command" : "invalid_message",
  };
}
