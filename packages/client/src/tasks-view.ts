import type { ScheduleSummary, TaskSummary, TaskView } from "@atrium/protocol";

/**
 * The task list as the host last sent it (SPEC-0006, "协议（给 UI）").
 *
 * @remarks
 * `idle` until a window watches it, `loading` while the first answer is on its way, `ready` after.
 * `seq` is the host's count of sends, so a push older than what the view has is dropped; the host's
 * count starts again with each connection, and so does the view's.
 */
export interface TasksView {
  readonly status: "idle" | "loading" | "ready";
  readonly tasks: readonly TaskSummary[];
  readonly seq: number;
}

/** What a window that does not watch the tasks sees. */
export const UNWATCHED_TASKS: TasksView = { status: "idle", tasks: [], seq: -1 };

/**
 * One task as the host last sent it.
 *
 * @remarks
 * `loading` until the first answer, `missing` when the host says there is no such task (`task_not_found`:
 * abandoned, or gone), `failed` for any other failure to ask. `task` keeps the last whole task through a
 * `missing` or `failed` that follows, so the page can say so beside what it knew.
 */
export interface TaskState {
  readonly status: "loading" | "ready" | "missing" | "failed";
  readonly task: TaskView | null;
}

/** What a task nobody has asked about shows. */
export const LOADING_TASK: TaskState = { status: "loading", task: null };

/**
 * The schedule rules as the host last sent them (SPEC-0006, "T10 定下的细节").
 *
 * @remarks
 * Like {@link TasksView}: `idle` until a window watches, `loading` for the first answer, `ready` after; `seq` drops older pushes.
 */
export interface SchedulesView {
  readonly status: "idle" | "loading" | "ready";
  readonly schedules: readonly ScheduleSummary[];
  readonly seq: number;
  /** The host follows another process's tasks and runs no schedules here. */
  readonly followed: boolean;
}

/** What a window that does not watch the schedules sees. */
export const UNWATCHED_SCHEDULES: SchedulesView = { status: "idle", schedules: [], seq: -1, followed: false };
