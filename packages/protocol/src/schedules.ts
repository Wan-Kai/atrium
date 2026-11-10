import { z } from "zod";
import { ProjectId } from "./ids";
import { Cadence, SchedulePlace } from "./schedule-cadence";
import { TaskId, TaskStatus } from "./tasks";

// Schedules (SPEC-0006, "定时（ScheduleService）" and "T10 定下的细节"). The host sends the rules and what became of the
// last trigger; the words ("每天凌晨 2:00", "上次失败") are the UI's.

/** A schedule rule's id: `rul_` and a name. */
export const ScheduleId = z.string().regex(/^rul_[0-9A-Za-z_-]{1,64}$/);
export type ScheduleId = z.infer<typeof ScheduleId>;

/** What became of the task the last trigger made. */
export const ScheduleLast = z.strictObject({
  taskId: TaskId,
  /** The task's status now. */
  status: TaskStatus,
  /** Some node of it failed. */
  failed: z.boolean(),
});
export type ScheduleLast = z.infer<typeof ScheduleLast>;

/** One row of the 定时 tab. */
export const ScheduleSummary = z.strictObject({
  id: ScheduleId,
  name: z.string().max(512),
  projectId: ProjectId,
  place: SchedulePlace,
  when: Cadence,
  paused: z.boolean(),
  /** When it fires next; `null` while it is paused. */
  nextAt: z.number().int().nonnegative().nullable(),
  /** The task of the last trigger, `null` before the first. A task that is gone is `null` too. */
  last: ScheduleLast.nullable(),
  /** How many triggers were skipped since a task was last made. */
  skipped: z.number().int().nonnegative(),
  /** The task whose conversation "修改" opens. */
  templateTaskId: TaskId,
  createdAt: z.number().int().nonnegative(),
});
export type ScheduleSummary = z.infer<typeof ScheduleSummary>;

/**
 * The rules changed; sent whole to the connections that watch them (`list_schedules({ watch: true })`).
 *
 * @remarks
 * `seq` counts the host's sends, so a client drops one older than what it has, as for `tasks_updated`.
 */
export const SchedulesUpdatedEvent = z.strictObject({
  type: z.literal("schedules_updated"),
  seq: z.number().int().nonnegative(),
  schedules: z.array(ScheduleSummary).max(1000),
});
export type SchedulesUpdatedEvent = z.infer<typeof SchedulesUpdatedEvent>;
