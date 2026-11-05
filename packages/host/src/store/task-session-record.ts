import { ThinkingLevel } from "@atrium/protocol";
import { z } from "zod";

/**
 * What Atrium keeps of a session that belongs to a task (SPEC-0006, "一个 agent 节点怎么跑 · 起").
 *
 * @remarks
 * A node's or a task conversation's session is not a child conversation of SPEC-0002: its record has this
 * and no `agent` field. The fields beyond SPEC-0006's (`nodeRole`, `startOn`) are what the launch rules read,
 * so a session starts again with the same tools and model from its record alone.
 */
export const TaskSessionRecord = z.strictObject({
  taskId: z.string().min(1),
  role: z.enum(["node", "conversation"]),
  /** The node, for a node session. */
  node: z.string().min(1).optional(),
  /** The attempt of the run, for a node session. */
  attempt: z.number().int().min(1).optional(),
  /** The node's role, which decides its tools; absent for a task conversation. */
  nodeRole: z.enum(["explore", "work", "check", "advise"]).optional(),
  /** The model and level it starts on, until pi has written the session. */
  startOn: z
    .strictObject({ providerId: z.string(), modelId: z.string(), thinkingLevel: ThinkingLevel.nullable() })
    .nullable(),
});
export type TaskSessionRecord = z.infer<typeof TaskSessionRecord>;

/**
 * A record's task field, read leniently.
 *
 * @remarks
 * The index keeps it as anything (`index-schema.ts`), so one a hand broke loses only itself, not the index.
 *
 * @sideEffects none
 * @param record - The record's raw fields.
 * @returns The task field, or `null` for a session that belongs to no task.
 */
export function taskFieldOf(record: { readonly task?: unknown }): TaskSessionRecord | null {
  const parsed = TaskSessionRecord.safeParse(record.task);
  return parsed.success ? parsed.data : null;
}
