import type { TaskAttention, TaskSummary } from "@atrium/protocol";

/** The list's three groups, in the order they show (SPEC-0006, "界面 · 任务列表"). */
export type TaskGroupKey = "attention" | "running" | "done";

/** The filter's choice for the tasks that belong to no project; any other choice is a project's id. */
export const NO_PROJECT = "~no-project";

/** How long a finished task stays in the list's "已完成", and how many show before "显示全部". */
const DONE_DAYS = 7;
export const DONE_SHOWN = 5;

/** One group of the list: its rows, and how many finished ones "显示全部" holds back. */
export interface TaskGroup {
  readonly key: TaskGroupKey;
  readonly tasks: readonly TaskSummary[];
  /** Only the done group holds any back. */
  readonly hidden: number;
  /** How many the done group holds back while folded, even when `showAll` shows them: what "收起" would fold. */
  readonly foldable: number;
}

/**
 * The group a task is listed in.
 *
 * @remarks
 * By status, as T5 decided (SPEC-0006, "T5 定下的细节"): a task the user is wanted for or has stopped is under
 * "待我介入", one that goes on under "运行中", one that ended under "已完成".
 *
 * @sideEffects none
 * @param task - The row.
 * @returns The group.
 */
export function groupOf(task: TaskSummary): TaskGroupKey {
  if (task.status === "done" || task.status === "cancelled") return "done";
  return task.status === "running" ? "running" : "attention";
}

/** How urgent an attention is, the lowest first; a task designing waits behind them, as it asks least of you. */
const URGENCY: Readonly<Record<TaskAttention | "designing" | "stopped", number>> = {
  failed: 0,
  merge_blocked: 1,
  human: 2,
  question: 3,
  graph_change: 4,
  stopped: 5,
  designing: 6,
};

/**
 * How urgently a task in the first group wants the user.
 *
 * @remarks
 * Failed first, then a blocked merge, a human node, a question, a graph change; a paused or stopped task and one
 * designing last.
 *
 * @sideEffects none
 * @param task - The row.
 * @returns A rank, the lowest first.
 */
function urgencyOf(task: TaskSummary): number {
  if (task.attention !== null) return URGENCY[task.attention];
  return task.status === "designing" ? URGENCY.designing : URGENCY.stopped;
}

/**
 * Orders two rows, the one that was active later first.
 *
 * @remarks
 * For the lists of tasks that go on, where the freshest is what the user looks for.
 *
 * @sideEffects none
 * @param a - A row.
 * @param b - Another.
 * @returns Negative when `a` comes first.
 */
function latestFirst(a: TaskSummary, b: TaskSummary): number {
  return b.activeAt - a.activeAt;
}

/**
 * Orders two finished rows, the one that ended later first.
 *
 * @remarks
 * A task with no end time counts from its last activity.
 *
 * @sideEffects none
 * @param a - A row.
 * @param b - Another.
 * @returns Negative when `a` comes first.
 */
function endedFirst(a: TaskSummary, b: TaskSummary): number {
  return (b.endedAt ?? b.activeAt) - (a.endedAt ?? a.activeAt);
}

/**
 * Whether the project filter lets a task through.
 *
 * @remarks
 * `NO_PROJECT` is the choice for the tasks that belong to none (SPEC-0006, "界面 · 任务列表").
 *
 * @sideEffects none
 * @param task - The row.
 * @param filter - `null` for all, `NO_PROJECT`, or a project's id.
 * @returns Whether it shows.
 */
function passes(task: TaskSummary, filter: string | null): boolean {
  if (filter === null) return true;
  return filter === NO_PROJECT ? task.projectId === null : task.projectId === filter;
}

/**
 * Orders the list into its groups (SPEC-0006, "界面 · 任务列表").
 *
 * @remarks
 * Attention first, then running, then done. Within "待我介入" the most urgent first, then the latest activity;
 * within the others the latest activity first. The done group shows what ended in the last seven days, at most five,
 * the rest behind "显示全部" (`showAll`); `hidden` counts them. Empty groups are left out.
 *
 * @sideEffects none
 * @param tasks - The rows.
 * @param options - The project filter, the time now, and whether all the finished tasks show.
 * @returns The groups, and how many rows pass the filter.
 */
export function arrangeTasks(
  tasks: readonly TaskSummary[],
  options: { readonly filter: string | null; readonly now: number; readonly showAll: boolean },
): { readonly groups: readonly TaskGroup[]; readonly total: number } {
  const shown = tasks.filter((task) => passes(task, options.filter));
  const groups: TaskGroup[] = [];
  const attention = shown.filter((task) => groupOf(task) === "attention");
  attention.sort((a, b) => urgencyOf(a) - urgencyOf(b) || latestFirst(a, b));
  if (attention.length > 0) groups.push({ key: "attention", tasks: attention, hidden: 0, foldable: 0 });
  const running = shown.filter((task) => groupOf(task) === "running").toSorted(latestFirst);
  if (running.length > 0) groups.push({ key: "running", tasks: running, hidden: 0, foldable: 0 });
  const done = shown.filter((task) => groupOf(task) === "done").toSorted(endedFirst);
  if (done.length > 0) {
    const recent = done.filter((task) => options.now - (task.endedAt ?? task.activeAt) <= DONE_DAYS * 86_400_000);
    const folded = recent.slice(0, DONE_SHOWN);
    const visible = options.showAll ? done : folded;
    groups.push({
      key: "done",
      tasks: visible,
      hidden: done.length - visible.length,
      foldable: done.length - folded.length,
    });
  }
  return { groups, total: shown.length };
}
