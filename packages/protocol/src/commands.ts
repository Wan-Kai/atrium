import { z } from "zod";
import { parseTraceparent } from "./trace";
import { TranscriptItem } from "./transcript";

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
export type PingCommand = z.infer<typeof PingCommand>;

/** Creates a chat: a directory under `~/.atrium/chats/` with a session whose pi starts at once. */
export const CreateChatCommand = z.strictObject({ type: z.literal("create_chat"), ...commandFields });
export type CreateChatCommand = z.infer<typeof CreateChatCommand>;

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
export type SubscribeSessionsCommand = z.infer<typeof SubscribeSessionsCommand>;

/** Sends a message to a session; its `requestId` doubles as the user message's `clientMessageId`. */
export const PromptCommand = z.strictObject({
  type: z.literal("prompt"),
  ...sessionCommandFields,
  text: z.string().min(1),
});
export type PromptCommand = z.infer<typeof PromptCommand>;

/** The most sessions one `list_recent_sessions` returns. */
export const RECENT_SESSIONS_LIMIT = 50;

/**
 * Lists the sessions in pi's session directory changed most recently, for M1.4's temporary
 * "最近会话" list (SPEC-0001, "打开历史会话").
 */
export const ListRecentSessionsCommand = z.strictObject({
  type: z.literal("list_recent_sessions"),
  ...commandFields,
  limit: z.number().int().min(1).max(RECENT_SESSIONS_LIMIT),
});
export type ListRecentSessionsCommand = z.infer<typeof ListRecentSessionsCommand>;

/** Opens a session from its file: starts pi on it, or returns it if it is already open. */
export const OpenSessionCommand = z.strictObject({
  type: z.literal("open_session"),
  ...commandFields,
  sessionId: SessionId,
});
export type OpenSessionCommand = z.infer<typeof OpenSessionCommand>;

/** One session in the recent list. */
export const RecentSession = z.strictObject({
  sessionId: SessionId,
  /** The first question asked in it, if the start of the file holds one. */
  firstPrompt: z.string().nullable(),
  /** When its file last changed, in milliseconds since the epoch. */
  modifiedAt: z.number().int().nonnegative(),
});
export type RecentSession = z.infer<typeof RecentSession>;

/** The most items one `fetch_transcript` returns. */
export const FETCH_TRANSCRIPT_LIMIT = 100;

/**
 * Fetches the transcript items before one the client has, for scrolling back.
 *
 * @remarks
 * `epoch` is the one the client's items come from; if the host has rebuilt the transcript since,
 * the item ids may no longer line up, so it answers `transcript_changed` (SPEC-0001, "快照与分页").
 */
export const FetchTranscriptCommand = z.strictObject({
  type: z.literal("fetch_transcript"),
  ...sessionCommandFields,
  epoch: z.number().int().nonnegative(),
  /** The id of the earliest item the client has. */
  before: z.string().min(1).max(256),
  limit: z.number().int().min(1).max(FETCH_TRANSCRIPT_LIMIT),
});
export type FetchTranscriptCommand = z.infer<typeof FetchTranscriptCommand>;

/** Kinds of problems the UI reports to the host's log. */
export const ClientIssueKind = z.enum(["error", "long_task", "slow_frames"]);
export type ClientIssueKind = z.infer<typeof ClientIssueKind>;

/** Writes a UI problem into the host's log; the client truncates both texts to 4 KB first. */
export const ReportClientIssueCommand = z.strictObject({
  type: z.literal("report_client_issue"),
  ...commandFields,
  kind: ClientIssueKind,
  message: z.string().max(4096),
  details: z.string().max(4096).optional(),
});
export type ReportClientIssueCommand = z.infer<typeof ReportClientIssueCommand>;

/** Every command a client may send after the handshake. */
export const Command = z.discriminatedUnion("type", [
  PingCommand,
  CreateChatCommand,
  SubscribeSessionsCommand,
  PromptCommand,
  FetchTranscriptCommand,
  ListRecentSessionsCommand,
  OpenSessionCommand,
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
    /**
     * `started` runs the message; `queued` waits for the run in progress; `handled` means an
     * extension consumed it without a run.
     */
    disposition: z.enum(["started", "queued", "handled"]),
  }),
  fetch_transcript: z.strictObject({
    /** The items just before `before`, oldest first. */
    items: z.array(TranscriptItem),
    hasOlder: z.boolean(),
  }),
  list_recent_sessions: z.strictObject({ sessions: z.array(RecentSession) }),
  open_session: z.strictObject({ sessionId: SessionId }),
  report_client_issue: z.strictObject({}),
} as const satisfies Record<CommandType, z.ZodType>;
export type CommandResult<T extends CommandType> = z.infer<(typeof CommandResult)[T]>;
