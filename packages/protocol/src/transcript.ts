import { z } from "zod";

/** Milliseconds since the Unix epoch. */
const Timestamp = z.number().int().nonnegative();

/** Most of a tool's output that travels in the transcript (SPEC-0001, "对话记录"). */
export const TOOL_OUTPUT_LIMIT = 16 * 1024;

/** What a tool step shows besides its output, by tool. */
export const ToolDetails = z.discriminatedUnion("tool", [
  z.strictObject({ tool: z.literal("bash"), command: z.string() }),
  z.strictObject({
    tool: z.literal("read"),
    path: z.string(),
    offset: z.number().int().nullable(),
    limit: z.number().int().nullable(),
  }),
  z.strictObject({
    tool: z.literal("edit"),
    path: z.string(),
    /** pi's display diff: lines `+NN text`, `-NN text`, ` NN text` and ` ...`. */
    diff: z.string().nullable(),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
  }),
  /** The written content comes from the call's arguments; pi's result has none. */
  z.strictObject({ tool: z.literal("write"), path: z.string(), content: z.string() }),
]);
export type ToolDetails = z.infer<typeof ToolDetails>;

/** Where a step sits in its turn; the same position live and after a rebuild. */
const stepFields = { id: z.string().min(1) };

/** One step of a turn, in order (domain-model §2). */
export const Step = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("thinking"),
    ...stepFields,
    text: z.string(),
    /** Only when timed live; otherwise null and shown as "思考过程". */
    durationMs: z.number().int().nonnegative().nullable(),
  }),
  z.strictObject({ kind: z.literal("text"), ...stepFields, text: z.string() }),
  z.strictObject({
    kind: z.literal("tool"),
    ...stepFields,
    callId: z.string(),
    tool: z.string(),
    args: z.record(z.string(), z.unknown()),
    /** `unfinished`: the turn ended without a result, as when it was stopped. */
    status: z.enum(["running", "done", "failed", "unfinished"]),
    output: z.strictObject({ text: z.string(), truncated: z.boolean() }).nullable(),
    details: ToolDetails.nullable(),
  }),
  z.strictObject({ kind: z.literal("steer"), ...stepFields, text: z.string() }),
  z.strictObject({ kind: z.literal("retry"), ...stepFields, attempt: z.number().int().positive(), error: z.string() }),
]);
export type Step = z.infer<typeof Step>;

/** A file the turn changed through a tool; `write` has no line counts. */
export const FileChange = z.strictObject({
  path: z.string(),
  added: z.number().int().nonnegative().nullable(),
  removed: z.number().int().nonnegative().nullable(),
});
export type FileChange = z.infer<typeof FileChange>;

/** A user message and everything up to the next one (SPEC-0001, "对话记录"). */
export const Turn = z.strictObject({
  kind: z.literal("turn"),
  id: z.string().min(1),
  user: z.strictObject({
    text: z.string(),
    images: z.number().int().nonnegative(),
    /** The `requestId` of the `prompt` that sent it, so the client can replace its pending copy. */
    clientMessageId: z.string().nullable(),
    timestamp: Timestamp,
  }),
  steps: z.array(Step),
  outcome: z.enum(["running", "done", "stopped", "failed"]),
  /** pi's own error text when the turn failed. */
  error: z.string().nullable(),
  startedAt: Timestamp,
  /** From the messages' timestamps; null while running. */
  durationMs: z.number().int().nonnegative().nullable(),
  usage: z.strictObject({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }).nullable(),
  changes: z.array(FileChange),
});
export type Turn = z.infer<typeof Turn>;

/** A system event between turns: the context was compacted. */
export const Notice = z.strictObject({
  kind: z.literal("notice"),
  id: z.string().min(1),
  notice: z.literal("compacted"),
  tokensBefore: z.number().int().nonnegative(),
  summary: z.string(),
  timestamp: Timestamp,
});
export type Notice = z.infer<typeof Notice>;

/** What the conversation area shows, in order. */
export const TranscriptItem = z.discriminatedUnion("kind", [Turn, Notice]);
export type TranscriptItem = z.infer<typeof TranscriptItem>;
