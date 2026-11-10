import type { MergeOutcome } from "./merge";
import type { Task } from "./types";

/**
 * Where the runner gets and keeps a task's worktree (SPEC-0006, "工作区").
 *
 * @remarks
 * The runner knows no projects or git repositories; the host's wiring (`task-workspaces.ts`) answers with
 * the worktree creator and the lock.
 */
export interface TaskWorkspaces {
  /**
   * Makes the task's worktree, or finds the one an earlier run of this action made.
   *
   * @remarks
   * Idempotent (SPEC-0006, "动作要幂等"). Fails with an error when git cannot make it.
   */
  ensure(task: Task, signal: AbortSignal): Promise<{ readonly workspaceId: string; readonly baseCommit: string }>;
  /** The directory of a workspace. */
  dirOf(workspaceId: string): string | undefined;
  /**
   * The container that sessions working in the task's worktree (`inWorktree`), or in its source directory,
   * are filed under.
   */
  containerOf(task: Task, inWorktree: boolean): string | undefined;
  /** Locks the task's worktree for the task (SPEC-0006, "加锁"); locking a locked one changes nothing. */
  lock(task: Task): Promise<void>;
  /** Unlocks it; unlocking one not locked for the task changes nothing. */
  unlock(task: Task): Promise<void>;
  /**
   * Merges the task's branch into the trunk of the project's main checkout, or says why it did not.
   *
   * @remarks
   * SPEC-0006, "合并"; safe to run again (a branch already merged answers `merged`). Throws when the task has
   * no worktree or the host no git; the runner turns that into `merge_git_failed`.
   */
  merge(task: Task, signal: AbortSignal): Promise<MergeOutcome>;
  /**
   * Lifts the locks tasks left on worktrees, when the host starts (SPEC-0006, "加锁").
   *
   * @remarks
   * Only a lock this home took (its reason names the home) for a task that `isOver` says is over; the user's own locks,
   * another home's and the older reason that names no home stay. Looks in every project's repository. A repository git
   * cannot list is skipped. Resolves to how many locks were lifted.
   */
  clearStaleLocks(isOver: (taskId: string) => boolean): Promise<number>;
}
