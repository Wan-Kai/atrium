import { z } from "zod";

// When a schedule rule fires and where it runs (SPEC-0006, "T10 定下的细节"); apart from `schedules.ts` so that `tasks.ts` can use them.

/** A clock time of day, `H:MM` or `HH:MM`, 24-hour. */
const TimeOfDay = z.string().regex(/^(?:[01]?\d|2[0-3]):[0-5]\d$/);

/** The longest interval of an interval cadence, in minutes: a day. */
export const INTERVAL_MAX_MINUTES = 1440;

/**
 * When a schedule rule fires, in the machine's time zone.
 *
 * @remarks
 * `day` and `week` are clock times on the local calendar (`week`'s `day` is 0 for Sunday to 6 for Saturday);
 * `interval` is every so many minutes counted from the moment the rule was made (SPEC-0006, "T10 定下的细节").
 */
export const Cadence = z.union([
  z.strictObject({ every: z.literal("day"), at: TimeOfDay }),
  z.strictObject({ every: z.literal("week"), day: z.number().int().min(0).max(6), at: TimeOfDay }),
  z.strictObject({ every: z.literal("interval"), minutes: z.number().int().min(1).max(INTERVAL_MAX_MINUTES) }),
]);
export type Cadence = z.infer<typeof Cadence>;

/** Where a scheduled task runs: in a worktree it makes each time, or read-only in the project's own directory. */
export const SchedulePlace = z.enum(["new_worktree", "local_readonly"]);
export type SchedulePlace = z.infer<typeof SchedulePlace>;
