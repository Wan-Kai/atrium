import { z } from "zod";

/** Milliseconds since the Unix epoch. */
const Timestamp = z.number().int().nonnegative();

/** The roles of a child the agent opens (SPEC-0002, "角色与限制"). */
export const AgentRole = z.enum(["explore", "work", "advise"]);
export type AgentRole = z.infer<typeof AgentRole>;

/** What happened to a task, as its parent is told (SPEC-0002, "通知父会话的事件"). */
export const AgentEventKind = z.enum(["finished", "failed", "question", "needs_you", "stopped", "ended"]);
export type AgentEventKind = z.infer<typeof AgentEventKind>;

/** A child the agent opened, as `agent_list` and the child list show it (SPEC-0002, `agent_list`). */
export const AgentStatus = z.enum([
  "creating",
  "running",
  "queued",
  "waiting_for_you",
  "waiting_for_parent",
  "idle",
  "stopped",
  "failed",
  "handed_off",
  "ended",
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

/** One event a notice brings, as the transcript shows it: who, which task, what (SPEC-0002, "显示"). */
export const AgentNoticeEvent = z.strictObject({
  sessionId: z.string().min(1).max(128),
  /** The child's handle. */
  name: z.string().max(64),
  /** Its display name when the notice was sent. */
  title: z.string().max(1024),
  taskId: z.string().max(128),
  event: AgentEventKind,
  reason: z.string().max(64).nullable(),
  /** How long the task took, until this event. */
  elapsedMs: z.number().int().nonnegative().nullable(),
  /** A question's text. */
  question: z.string().max(4000).nullable(),
  /** A `work` child's branch, with its delivery (SPEC-0002, "交付"). */
  branch: z.string().max(256).nullable(),
  /** What a `work` child changed in its own worktree, with its delivery. */
  changes: z
    .strictObject({
      files: z.number().int().nonnegative(),
      added: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type AgentNoticeEvent = z.infer<typeof AgentNoticeEvent>;

/**
 * What a turn opened with, or a step brought, when it was not you: notices from children, or a
 * task from the parent's agent (SPEC-0002, "对话记录里的自定义消息").
 */
export const AgentSource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("report"), events: z.array(AgentNoticeEvent).min(1) }),
  z.strictObject({
    kind: z.literal("task"),
    /** The parent's display name when the task was sent. */
    fromTitle: z.string().max(1024),
    taskId: z.string().max(128),
    /** What the parent's agent asked, whole. */
    text: z.string(),
  }),
]);
export type AgentSource = z.infer<typeof AgentSource>;

/** A delivery waiting in a session's queue panel (SPEC-0002, "送达"). */
export const DeliveryItem = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["report", "task"]),
  /** The child's display name for a notice; the parent's for a task. */
  fromTitle: z.string().max(1024),
  /** A notice's event; `null` for a task. */
  event: AgentEventKind.nullable(),
  /** `sending` once handed to pi: it can no longer be removed. */
  state: z.enum(["waiting", "sending"]),
});
export type DeliveryItem = z.infer<typeof DeliveryItem>;

/** What a session the agent opened shows in its parent's child list (SPEC-0002, "显示 · 子对话条"). */
export const SessionAgent = z.strictObject({
  /** Its handle, which never changes. */
  handle: z.string().max(64),
  role: AgentRole,
  status: AgentStatus,
  /** Its latest progress. */
  progress: z.string().max(2000).nullable(),
  /** The first question it is waiting for the parent's agent to answer. */
  question: z.string().max(4000).nullable(),
  /** The task it has open; `null` without one. */
  taskId: z.string().max(128).nullable(),
  /** When the task it has open was handed down; `null` without one (SPEC-0002, "显示 · 过程轨道"). */
  taskStartedAt: Timestamp.nullable(),
});
export type SessionAgent = z.infer<typeof SessionAgent>;
