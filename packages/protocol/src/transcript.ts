import { z } from "zod";
import { AgentNoticeEvent, AgentRole, AgentSource } from "./agent";

/** Milliseconds since the Unix epoch. */
const Timestamp = z.number().int().nonnegative();

/**
 * The longest text of a tool step that travels in full with events, snapshots and pages.
 *
 * @remarks
 * Longer ones travel as a preview and the step is marked `partial`; `fetch_step` returns it whole
 * (SPEC-0001, "大内容").
 */
export const STEP_TEXT_LIMIT = 16 * 1024;

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
  /**
   * A main-agent tool's answer (SPEC-0002, "显示 · 过程轨道"): the child it started, which opens a
   * lane, and the events it brought back, which merge lanes.
   */
  z.strictObject({
    tool: z.literal("agent"),
    spawned: z
      .strictObject({
        sessionId: z.string().min(1).max(128),
        name: z.string().max(64),
        taskId: z.string().max(128),
        role: AgentRole,
        /** Its new worktree's branch; `null` in the same place. */
        branch: z.string().max(256).nullable(),
      })
      .nullable(),
    events: z.array(AgentNoticeEvent),
  }),
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
    /** What the tool printed so far, or its result. */
    output: z.string().nullable(),
    details: ToolDetails.nullable(),
    /** Some long text is only a preview here; `fetch_step` returns the step whole. */
    partial: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("steer"), ...stepFields, text: z.string() }),
  /** Notices or a task that came in during the run, drawn as a steer is (SPEC-0002, "显示"). */
  z.strictObject({ kind: z.literal("agent"), ...stepFields, source: AgentSource }),
  z.strictObject({
    kind: z.literal("retry"),
    ...stepFields,
    attempt: z.number().int().positive(),
    /** pi's limit, seen live; null when rebuilt from its file, which does not keep it. */
    maxAttempts: z.number().int().positive().nullable(),
    error: z.string(),
  }),
]);
export type Step = z.infer<typeof Step>;

/** A file the turn changed through a tool; `write` has no line counts. */
export const FileChange = z.strictObject({
  path: z.string(),
  added: z.number().int().nonnegative().nullable(),
  removed: z.number().int().nonnegative().nullable(),
});
export type FileChange = z.infer<typeof FileChange>;

/**
 * The command a user message started with, when the message still says which (SPEC-0001,
 * "M1.11 的 `/` 命令"): only a skill's, which pi keeps as a block the host can read back.
 */
export const MessageCommand = z.strictObject({
  kind: z.literal("skill"),
  /** The skill's name, without `skill:`. */
  name: z.string().min(1).max(256),
});
export type MessageCommand = z.infer<typeof MessageCommand>;

/**
 * A user message and everything up to the next one (SPEC-0001, "对话记录"), or a run notices or a
 * task opened, with `source` saying which and `user` empty (SPEC-0002, "对话记录里的自定义消息").
 */
export const Turn = z.strictObject({
  kind: z.literal("turn"),
  id: z.string().min(1),
  /** What opened the turn when it was not you; `null` for your message. */
  source: AgentSource.nullable(),
  user: z.strictObject({
    text: z.string(),
    images: z.number().int().nonnegative(),
    /** The `requestId` of the `prompt` that sent it, so the client can replace its pending copy. */
    clientMessageId: z.string().nullable(),
    /** Sent by the host to have the agent go on after an interrupted run (SPEC-0001, "运行控制"). */
    auto: z.boolean(),
    /** The skill the message started with; `text` is then only what followed its name. */
    command: MessageCommand.nullable(),
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

/**
 * A system event between turns: the context was compacted, the host restarted a crashed pi, an
 * extension asked something, or the host told the model something (SPEC-0002, `note`).
 */
export const Notice = z.discriminatedUnion("notice", [
  z.strictObject({
    kind: z.literal("notice"),
    id: z.string().min(1),
    notice: z.literal("compacted"),
    tokensBefore: z.number().int().nonnegative(),
    summary: z.string(),
    timestamp: Timestamp,
  }),
  /** Seen only by the host that restarted pi; gone after the host restarts (SPEC-0001, "运行控制"). */
  z.strictObject({
    kind: z.literal("notice"),
    id: z.string().min(1),
    notice: z.literal("restarted"),
    /** Which restart in a row, from 1 to 3. */
    attempt: z.number().int().positive(),
    timestamp: Timestamp,
  }),
  /** An extension's question and how it ended; seen only by the host that asked (SPEC-0001, "运行控制"). */
  z.strictObject({
    kind: z.literal("notice"),
    id: z.string().min(1),
    notice: z.literal("interaction"),
    title: z.string(),
    outcome: z.enum(["answered", "cancelled", "timed_out", "stale"]),
    /** The value given to a selection, input or editor. */
    value: z.string().nullable(),
    /** The answer to a confirmation. */
    confirmed: z.boolean().nullable(),
    timestamp: Timestamp,
  }),
  /**
   * The host's note to the model, an `atrium-agent` custom message: a child conversation forked
   * into a new worktree works in `to`, though its history names `from` (SPEC-0002).
   */
  z.strictObject({
    kind: z.literal("notice"),
    id: z.string().min(1),
    notice: z.literal("note"),
    note: z.literal("worktree_moved"),
    from: z.string().min(1).max(4096),
    to: z.string().min(1).max(4096),
    timestamp: Timestamp,
  }),
]);
export type Notice = z.infer<typeof Notice>;

/** What the conversation area shows, in order. */
export const TranscriptItem = z.discriminatedUnion("kind", [Turn, Notice]);
export type TranscriptItem = z.infer<typeof TranscriptItem>;
