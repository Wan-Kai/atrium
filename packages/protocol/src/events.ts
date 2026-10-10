import { z } from "zod";
import { Control } from "./control";
import { SessionId } from "./ids";
import { SessionModel } from "./models";
import { Notice, Step, TranscriptItem, Turn } from "./transcript";

/** A trace id: 32 lowercase hex characters. */
const TraceId = z.string().regex(/^[0-9a-f]{32}$/);

/** How many turns a snapshot carries; older ones come through `fetch_transcript` (SPEC-0001, "快照与分页"). */
export const SNAPSHOT_TURNS = 20;

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
  /** The latest turns, up to `SNAPSHOT_TURNS`, with the notices among and after them; a running turn as far as it has come. */
  items: z.array(TranscriptItem),
  /** Whether earlier items exist, for `fetch_transcript`. */
  hasOlder: z.boolean(),
  run: RunInfo.nullable(),
  /** pi has exited; nothing more will happen in this session until it starts again. */
  exited: z.boolean(),
  /** The queue, steers, stop, interactions and failure (SPEC-0001, "运行控制"). */
  control: Control,
  /** The model and thinking level pi uses; `null` before pi has started. */
  model: SessionModel.nullable(),
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

/** A turn began: pi echoed the user message that opens it (SPEC-0001, "对话记录"). */
export const TurnStartedEvent = z.strictObject({ type: z.literal("turn_started"), ...sessionEventFields, turn: Turn });
export type TurnStartedEvent = z.infer<typeof TurnStartedEvent>;

/** A step joined a turn: a block started, a tool call is complete, a steer or a retry happened. */
export const StepAddedEvent = z.strictObject({
  type: z.literal("step_added"),
  ...sessionEventFields,
  turnId: z.string().min(1),
  step: Step,
});
export type StepAddedEvent = z.infer<typeof StepAddedEvent>;

/** More text of a thinking or text step. */
export const StepDeltaEvent = z.strictObject({
  type: z.literal("step_delta"),
  ...sessionEventFields,
  turnId: z.string().min(1),
  stepId: z.string().min(1),
  delta: z.string(),
});
export type StepDeltaEvent = z.infer<typeof StepDeltaEvent>;

/** A step changed: its message finished, or a tool has output, a result or no result at the end. */
export const StepUpdatedEvent = z.strictObject({
  type: z.literal("step_updated"),
  ...sessionEventFields,
  turnId: z.string().min(1),
  step: Step,
});
export type StepUpdatedEvent = z.infer<typeof StepUpdatedEvent>;

/** A turn ended with its run. */
export const TurnFinishedEvent = z.strictObject({
  type: z.literal("turn_finished"),
  ...sessionEventFields,
  turnId: z.string().min(1),
  outcome: Turn.shape.outcome.exclude(["running"]),
  error: Turn.shape.error,
  durationMs: z.number().int().nonnegative(),
  usage: Turn.shape.usage,
  changes: Turn.shape.changes,
});
export type TurnFinishedEvent = z.infer<typeof TurnFinishedEvent>;

/** A notice joined the transcript, found when the host re-read pi's entries. */
export const NoticeAddedEvent = z.strictObject({
  type: z.literal("notice_added"),
  ...sessionEventFields,
  notice: Notice,
  /** The id of the item it goes before; `null` for the end. */
  before: z.string().min(1).nullable(),
});
export type NoticeAddedEvent = z.infer<typeof NoticeAddedEvent>;

/** The session's run control changed; carries it whole. */
export const ControlUpdatedEvent = z.strictObject({
  type: z.literal("control_updated"),
  ...sessionEventFields,
  control: Control,
});
export type ControlUpdatedEvent = z.infer<typeof ControlUpdatedEvent>;

/** An extension consumed a message without a run; the client drops its pending copy. */
export const PromptHandledEvent = z.strictObject({
  type: z.literal("prompt_handled"),
  ...sessionEventFields,
  clientMessageId: z.string().min(1),
});
export type PromptHandledEvent = z.infer<typeof PromptHandledEvent>;

/** The session's model or thinking level changed (SPEC-0001, "模型与输入框"). */
export const ModelUpdatedEvent = z.strictObject({
  type: z.literal("model_updated"),
  ...sessionEventFields,
  model: SessionModel.nullable(),
});
export type ModelUpdatedEvent = z.infer<typeof ModelUpdatedEvent>;

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
  TurnStartedEvent,
  StepAddedEvent,
  StepDeltaEvent,
  StepUpdatedEvent,
  TurnFinishedEvent,
  NoticeAddedEvent,
  SessionExitedEvent,
  ControlUpdatedEvent,
  PromptHandledEvent,
  ModelUpdatedEvent,
]);
export type SessionEvent = z.infer<typeof SessionEvent>;
