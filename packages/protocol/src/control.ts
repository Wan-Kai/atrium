import { z } from "zod";

/** Milliseconds since the Unix epoch, from the host's clock. */
const Timestamp = z.number().int().nonnegative();

/** A message waiting in the host's queue for the run in progress to end (SPEC-0001, "运行控制"). */
export const QueuedPrompt = z.strictObject({
  id: z.string().min(1),
  text: z.string().min(1),
  createdAt: Timestamp,
});
export type QueuedPrompt = z.infer<typeof QueuedPrompt>;

/** A steer pi has taken but not yet delivered to the model. */
export const PendingSteer = z.strictObject({ id: z.string().min(1), text: z.string() });
export type PendingSteer = z.infer<typeof PendingSteer>;

/** An extension's question waiting for an answer (domain-model §3, PendingInteraction). */
export const Interaction = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["select", "confirm", "input", "editor"]),
  title: z.string(),
  /** What a confirmation asks about. */
  message: z.string().nullable(),
  /** A selection's choices. */
  options: z.array(z.string()).nullable(),
  placeholder: z.string().nullable(),
  /** An editor's starting text. */
  prefill: z.string().nullable(),
  /** When pi stops waiting and goes on with its default; null for no limit. */
  deadline: Timestamp.nullable(),
});
export type Interaction = z.infer<typeof Interaction>;

/** An answer to an interaction, as pi's `extension_ui_response` takes it. */
export const InteractionAnswer = z.union([
  z.strictObject({ value: z.string().max(1024 * 1024) }),
  z.strictObject({ confirmed: z.boolean() }),
  z.strictObject({ cancelled: z.literal(true) }),
]);
export type InteractionAnswer = z.infer<typeof InteractionAnswer>;

/**
 * What a session's run control looks like now, sent whole when it changes.
 *
 * @remarks
 * Small enough to send whole every time (SPEC-0001, "运行控制").
 */
export const Control = z.strictObject({
  /** The host's queue, in the order the messages were sent. */
  queue: z.array(QueuedPrompt),
  /** Why the queue does not move on its own: you stopped the run, or pi crashed and has not recovered. */
  paused: z.enum(["stopped", "crashed"]).nullable(),
  /** Steers pi has taken and not yet delivered. */
  steers: z.array(PendingSteer),
  /** A stop was sent and pi has not confirmed it yet. */
  stopping: z.boolean(),
  /** Questions from extensions waiting for an answer, oldest first. */
  interactions: z.array(Interaction),
  /** Set once pi crashed three times in a row; cleared when the next run starts. */
  failure: z.strictObject({ reason: z.literal("crashed"), attempts: z.number().int().positive() }).nullable(),
});
export type Control = z.infer<typeof Control>;

/** A session's control with nothing going on. */
export const IDLE_CONTROL: Control = {
  queue: [],
  paused: null,
  steers: [],
  stopping: false,
  interactions: [],
  failure: null,
};
