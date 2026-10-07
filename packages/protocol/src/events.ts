import { z } from "zod";
import { SessionId } from "./commands";

/** A trace id: 32 lowercase hex characters. */
const TraceId = z.string().regex(/^[0-9a-f]{32}$/);

/** A position in a session's event stream (SPEC-0001, "事件"). */
const sessionEventFields = {
  sessionId: SessionId,
  /** Changes whenever the host rebuilds the session's state, such as after pi restarts. */
  epoch: z.number().int().nonnegative(),
  /** Increases by one with every event of the session within an epoch. */
  seq: z.number().int().nonnegative(),
  /** The trace of the run the event belongs to; `null` outside a run. */
  traceId: TraceId.nullable(),
};

/** Milliseconds since the Unix epoch, from the host's clock. */
const Timestamp = z.number().int().nonnegative();

/** One block of an assistant message; tool calls join in M1.4. */
export const AssistantBlock = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({ type: z.literal("reasoning"), text: z.string() }),
]);
export type AssistantBlock = z.infer<typeof AssistantBlock>;

/** Why an assistant message ended, as pi reports it. */
export const StopReason = z.enum(["stop", "length", "toolUse", "error", "aborted"]);
export type StopReason = z.infer<typeof StopReason>;

/** A user message as the transcript shows it. */
export const UserMessage = z.strictObject({
  id: z.string().min(1),
  role: z.literal("user"),
  text: z.string(),
  /** The `requestId` of the `prompt` that sent it, so the client can replace its optimistic copy. */
  clientMessageId: z.string().nullable(),
  timestamp: Timestamp,
});
export type UserMessage = z.infer<typeof UserMessage>;

/** A finished assistant message. */
export const AssistantMessage = z.strictObject({
  id: z.string().min(1),
  role: z.literal("assistant"),
  content: z.array(AssistantBlock),
  stopReason: StopReason,
  /** pi's own error text when `stopReason` is `error`, for the "展开看原始报错" view. */
  errorMessage: z.string().nullable(),
  timestamp: Timestamp,
});
export type AssistantMessage = z.infer<typeof AssistantMessage>;

/** A message in a session's transcript. */
export const TranscriptMessage = z.discriminatedUnion("role", [UserMessage, AssistantMessage]);
export type TranscriptMessage = z.infer<typeof TranscriptMessage>;

/** The run in progress, for "进行中 · 12s". */
const RunInfo = z.strictObject({ runId: z.string().min(1), startedAt: Timestamp });

/**
 * A session's whole current state, sent when a client subscribes.
 *
 * @remarks
 * Generated from the same runtime state as the live events, so the client applies only events
 * with a higher `seq` afterwards (domain-model §7).
 */
export const SessionSnapshotEvent = z.strictObject({
  type: z.literal("session_snapshot"),
  ...sessionEventFields,
  messages: z.array(TranscriptMessage),
  /** The assistant message still streaming, as far as it has come. */
  streaming: z.strictObject({ messageId: z.string().min(1), content: z.array(AssistantBlock) }).nullable(),
  run: RunInfo.nullable(),
  /** pi has exited; nothing more will happen in this session. */
  exited: z.boolean(),
});
export type SessionSnapshotEvent = z.infer<typeof SessionSnapshotEvent>;

/** A run began: pi accepted a message and is working on it. */
export const RunStartedEvent = z.strictObject({
  type: z.literal("run_started"),
  ...sessionEventFields,
  ...RunInfo.shape,
});
export type RunStartedEvent = z.infer<typeof RunStartedEvent>;

/** A run ended for good: pi will not continue on its own. */
export const RunSettledEvent = z.strictObject({
  type: z.literal("run_settled"),
  ...sessionEventFields,
  runId: z.string().min(1),
  outcome: z.enum(["completed", "stopped", "failed"]),
  settledAt: Timestamp,
});
export type RunSettledEvent = z.infer<typeof RunSettledEvent>;

/** An assistant message started streaming. */
export const MessageStartedEvent = z.strictObject({
  type: z.literal("message_started"),
  ...sessionEventFields,
  messageId: z.string().min(1),
});
export type MessageStartedEvent = z.infer<typeof MessageStartedEvent>;

/** Fields of a streamed piece of text. */
const deltaFields = {
  ...sessionEventFields,
  messageId: z.string().min(1),
  /** Index of the block in the Atrium message's `content`. */
  contentIndex: z.number().int().nonnegative(),
  delta: z.string(),
};

/** More reply text. */
export const TextDeltaEvent = z.strictObject({ type: z.literal("text_delta"), ...deltaFields });
export type TextDeltaEvent = z.infer<typeof TextDeltaEvent>;

/** More reasoning text. */
export const ReasoningDeltaEvent = z.strictObject({ type: z.literal("reasoning_delta"), ...deltaFields });
export type ReasoningDeltaEvent = z.infer<typeof ReasoningDeltaEvent>;

/** A message is complete: an assistant message that streamed, or a user message pi accepted. */
export const MessageFinishedEvent = z.strictObject({
  type: z.literal("message_finished"),
  ...sessionEventFields,
  message: TranscriptMessage,
});
export type MessageFinishedEvent = z.infer<typeof MessageFinishedEvent>;

/** The session's pi process ended. */
export const SessionExitedEvent = z.strictObject({
  type: z.literal("session_exited"),
  ...sessionEventFields,
  /** `requested` when the host stopped it, `crashed` otherwise. */
  reason: z.enum(["requested", "crashed"]),
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
});
export type SessionExitedEvent = z.infer<typeof SessionExitedEvent>;

/** Every event about one session. */
export const SessionEvent = z.discriminatedUnion("type", [
  SessionSnapshotEvent,
  RunStartedEvent,
  RunSettledEvent,
  MessageStartedEvent,
  TextDeltaEvent,
  ReasoningDeltaEvent,
  MessageFinishedEvent,
  SessionExitedEvent,
]);
export type SessionEvent = z.infer<typeof SessionEvent>;
