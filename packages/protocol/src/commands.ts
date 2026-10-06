import { z } from "zod";
import { parseTraceparent } from "./trace";

/** A client-chosen id that ties a response to its command; unique within a connection. */
export const RequestId = z.string().min(1).max(128);

/** A session's id: pi's session id, or the id of a draft that has no file yet. */
export const SessionId = z.string().min(1).max(128);

/** A W3C `traceparent` value that `parseTraceparent` accepts. */
export const Traceparent = z
  .string()
  .max(64)
  // No message of its own: a failure only ever becomes `invalid_message`.
  .refine((value) => parseTraceparent(value) !== null);

/** Fields every command carries (SPEC-0001, "信封"). */
const commandFields = { requestId: RequestId, traceparent: Traceparent };

/** Fields every session command carries in addition. */
const sessionCommandFields = { ...commandFields, sessionId: SessionId };

/** Heartbeat: the client sends one every `heartbeatMs` and expects the response within as long. */
export const PingCommand = z.strictObject({ type: z.literal("ping"), ...commandFields });

/** Creates a chat: a directory under `~/.atrium/chats/` with a session whose pi starts at once. */
export const CreateChatCommand = z.strictObject({ type: z.literal("create_chat"), ...commandFields });

/**
 * Sets which sessions this client receives live events for, replacing the previous set.
 *
 * @remarks
 * A full set rather than add/remove keeps the command idempotent: resending it after a reconnect
 * restores exactly the subscriptions the client wants.
 */
export const SubscribeSessionsCommand = z.strictObject({
  type: z.literal("subscribe_sessions"),
  ...commandFields,
  sessionIds: z.array(SessionId).max(64),
});

/** Sends a message to a session; its `requestId` doubles as the user message's `clientMessageId`. */
export const PromptCommand = z.strictObject({
  type: z.literal("prompt"),
  ...sessionCommandFields,
  text: z.string().min(1),
});

/** Kinds of problems the UI reports to the host's log. */
export const ClientIssueKind = z.enum(["error", "long_task", "slow_frames"]);

/** Writes a UI problem into the host's log; the client truncates both texts to 4 KB first. */
export const ReportClientIssueCommand = z.strictObject({
  type: z.literal("report_client_issue"),
  ...commandFields,
  kind: ClientIssueKind,
  message: z.string().max(4096),
  details: z.string().max(4096).optional(),
});

/** Every command a client may send after the handshake. */
export const Command = z.discriminatedUnion("type", [
  PingCommand,
  CreateChatCommand,
  SubscribeSessionsCommand,
  PromptCommand,
  ReportClientIssueCommand,
]);
export type Command = z.infer<typeof Command>;
export type CommandType = Command["type"];

/** The command types, for telling an unknown command from a malformed one. */
export const COMMAND_TYPES: ReadonlySet<string> = new Set<CommandType>(
  Command.options.map((option) => option.shape.type.value),
);

/**
 * What a successful response carries for each command.
 *
 * @remarks
 * The response itself carries `result` as unknown JSON; the client knows which command it sent
 * and checks the result against this schema.
 */
export const CommandResult = {
  ping: z.strictObject({}),
  create_chat: z.strictObject({ sessionId: SessionId }),
  subscribe_sessions: z.strictObject({}),
  prompt: z.strictObject({
    /** `started` runs the message; `handled` means an extension consumed it without a run. */
    disposition: z.enum(["started", "handled"]),
  }),
  report_client_issue: z.strictObject({}),
} as const satisfies Record<CommandType, z.ZodType>;
export type CommandResult<T extends CommandType> = z.infer<(typeof CommandResult)[T]>;
