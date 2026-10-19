import { AgentEventKind, AgentRole, ThinkingLevel } from "@atrium/protocol";
import { z } from "zod";

/**
 * One task the parent's agent gave a child, as its record keeps it (SPEC-0002, "任务").
 *
 * @remarks
 * `open` until it reaches a final event. `originTask` is the task of the child's own parent that
 * was running when this one was given, so a grandchild's notices go up under it; `followUpOf` marks
 * a task made for notices that came after that one had ended.
 */
export const AgentTask = z.strictObject({
  taskId: z.string().min(1),
  originTask: z.string().optional(),
  followUpOf: z.string().optional(),
  state: z.enum(["open", "done"]),
  /** When it was given. */
  at: z.number(),
  /** The entry of its last reply, once it ended (SPEC-0002, `agent_read`). */
  replyEntry: z.string().nullable().optional(),
});
export type AgentTask = z.infer<typeof AgentTask>;

/** What Atrium keeps of a child the agent opened (SPEC-0002, "接口与数据 · 第二步"). */
export const AgentRecord = z.strictObject({
  /** Its handle, which never changes (SPEC-0002, "句柄与显示名"). */
  handle: z.string().min(1),
  role: AgentRole,
  /** Where its tools are limited: pi's flags, or Atrium's extension (SPEC-0002, "带上下文的子对话（agent 开的）"). */
  toolGuard: z.enum(["flags", "extension"]),
  /** The model and level it starts on, until pi has written the session. */
  startOn: z
    .strictObject({ providerId: z.string(), modelId: z.string(), thinkingLevel: ThinkingLevel.nullable() })
    .nullable(),
  /** In its own new worktree. */
  worktree: z.boolean(),
  tasks: z.array(AgentTask),
});
export type AgentRecord = z.infer<typeof AgentRecord>;

/**
 * Something waiting to go to a session: a notice up from a child, or a task down from the parent's
 * agent (SPEC-0002, "送达").
 *
 * @remarks
 * A notice keeps no text, only where to read it (`replyEntry`, `questionId`, `toolCallId`); a task
 * keeps its text until pi wrote it. `claimed` by a wait (`claimedBy` its tool call), `sending` once
 * handed to pi, `deleted` once you removed it.
 */
export const DeliveryRecord = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["report", "task"]),
  /** The session it comes from. */
  from: z.string().min(1),
  taskId: z.string().min(1),
  event: AgentEventKind.optional(),
  reason: z.string().optional(),
  followUpOf: z.string().optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  questionId: z.string().optional(),
  /** A question's `ask_parent` call, in the child's file. */
  toolCallId: z.string().optional(),
  /** A notice's reply, in the child's file. */
  replyEntry: z.string().nullable().optional(),
  /** A task's text, until pi wrote it. */
  text: z.string().optional(),
  at: z.number(),
  state: z.enum(["waiting", "claimed", "sending", "deleted"]),
  /** The wait's tool call that took it. */
  claimedBy: z.string().optional(),
});
export type DeliveryRecord = z.infer<typeof DeliveryRecord>;

/**
 * A record's agent fields, read leniently.
 *
 * @remarks
 * The index keeps them as anything (`index-schema.ts`), so one a hand broke loses only itself, not
 * the whole index: a malformed agent record is none, a malformed delivery or handle is left out.
 *
 * @sideEffects none
 * @param record - The record's raw fields.
 * @returns What could be read.
 */
export function agentFieldsOf(record: {
  readonly agent?: unknown;
  readonly usedHandles?: unknown;
  readonly deliveries?: unknown;
}): {
  readonly agent: AgentRecord | null;
  readonly usedHandles: readonly string[];
  readonly deliveries: readonly DeliveryRecord[];
} {
  const agent = AgentRecord.safeParse(record.agent);
  const handles = Array.isArray(record.usedHandles) ? record.usedHandles : [];
  // Stryker disable next-line ArrayDeclaration: whatever stands in for none is no delivery, and is left out below.
  const deliveries = Array.isArray(record.deliveries) ? record.deliveries : [];
  return {
    agent: agent.success ? agent.data : null,
    usedHandles: handles.filter((handle): handle is string => typeof handle === "string"),
    deliveries: deliveries.flatMap((delivery: unknown) => {
      const read = DeliveryRecord.safeParse(delivery);
      return read.success ? [read.data] : [];
    }),
  };
}
