import { GitError, type GitRunner } from "../platform/git";
import { parseWorktreeList } from "./worktree-list";

/** The start of the reason of a lock a task puts on a worktree (SPEC-0006, "加锁"). */
const TASK_LOCK_PREFIX = "atrium task ";

/** A task's id as a lock's reason carries it: what ids are made of, so another reason never reads as one. */
const TASK_ID = /^[A-Za-z0-9_-]+$/;

/**
 * The reason of the lock a task puts on a worktree.
 *
 * @remarks
 * `atrium task <taskId>` (SPEC-0006, "加锁").
 *
 * @sideEffects none
 * @param taskId - The task.
 * @returns The reason.
 */
export function taskLockReason(taskId: string): string {
  return `${TASK_LOCK_PREFIX}${taskId}`;
}

/**
 * The task a lock's reason names.
 *
 * @remarks
 * A lock the user put on, or one with any other reason, belongs to no task and is left alone.
 *
 * @sideEffects none
 * @param reason - The reason git lists, or `null` when not locked.
 * @returns The task's id, or `null`.
 */
export function lockedTaskOf(reason: string | null): string | null {
  if (reason === null || !reason.startsWith(TASK_LOCK_PREFIX)) return null;
  const taskId = reason.slice(TASK_LOCK_PREFIX.length);
  return TASK_ID.test(taskId) ? taskId : null;
}

/**
 * The reason a worktree is locked for, as git lists it.
 *
 * @remarks
 * One `git worktree list --porcelain`; a worktree git does not list is not locked.
 *
 * @sideEffects Runs git.
 * @param git - git.
 * @param repo - A directory of the repository.
 * @param dir - The worktree.
 * @returns The reason (empty without one), or `null` when it is not locked or not listed.
 * @throws {GitError} `exit` when git cannot list worktrees.
 */
export async function lockOf(git: GitRunner, repo: string, dir: string): Promise<string | null> {
  const listing = await git.run(["worktree", "list", "--porcelain"], { cwd: repo });
  if (listing.code !== 0) throw new GitError("worktree", "exit");
  return parseWorktreeList(listing.stdout).find((worktree) => worktree.dir === dir)?.locked ?? null;
}

/**
 * Locks a worktree for a task, so archiving and cleaning leave it be.
 *
 * @remarks
 * Done again for the same task it changes nothing; a worktree locked for anything else stays as
 * it is and git refuses the lock, as the other lock is not ours to replace.
 *
 * @sideEffects Runs git; changes the worktree's registration.
 * @param git - git.
 * @param repo - A directory of the repository.
 * @param dir - The worktree.
 * @param taskId - The task.
 * @returns Whether the worktree is now locked for the task.
 * @throws {GitError} `exit` when git cannot list worktrees.
 */
export async function lockWorktree(git: GitRunner, repo: string, dir: string, taskId: string): Promise<boolean> {
  const reason = taskLockReason(taskId);
  if ((await lockOf(git, repo, dir)) === reason) return true;
  // A worktree locked for anything else is refused by git itself, which has no second lock to give.
  const locked = await git.run(["worktree", "lock", "--reason", reason, "--", dir], { cwd: repo });
  return locked.code === 0;
}

/**
 * Unlocks a worktree a task locked.
 *
 * @remarks
 * Only a lock with that task's reason is lifted; the user's own lock stays. Unlocking what is not
 * locked is fine.
 *
 * @sideEffects Runs git; changes the worktree's registration.
 * @param git - git.
 * @param repo - A directory of the repository.
 * @param dir - The worktree.
 * @param taskId - The task.
 * @returns Whether the worktree is now free of the task's lock.
 * @throws {GitError} `exit` when git cannot list worktrees.
 */
export async function unlockWorktree(git: GitRunner, repo: string, dir: string, taskId: string): Promise<boolean> {
  const current = await lockOf(git, repo, dir);
  if (current === null) return true;
  if (current !== taskLockReason(taskId)) return false;
  return (await git.run(["worktree", "unlock", "--", dir], { cwd: repo })).code === 0;
}

/**
 * Lifts the locks of tasks that are over, when the host starts.
 *
 * @remarks
 * A host that died, or a task that ended while it was down, leaves its locks behind and the
 * worktree could never be archived. Only a lock whose reason is `atrium task <id>` for a task
 * `isActive` says is over is lifted; the user's locks and the active tasks' stay.
 *
 * @sideEffects Runs git; changes worktrees' registrations.
 * @param git - git.
 * @param repo - A directory of the repository.
 * @param isActive - Whether a task still runs or waits (is neither done nor cancelled), and exists.
 * @returns How many locks were lifted.
 * @throws {GitError} `exit` when git cannot list worktrees.
 */
export async function clearStaleLocks(
  git: GitRunner,
  repo: string,
  isActive: (taskId: string) => boolean,
): Promise<number> {
  const listing = await git.run(["worktree", "list", "--porcelain"], { cwd: repo });
  if (listing.code !== 0) throw new GitError("worktree", "exit");
  let lifted = 0;
  for (const worktree of parseWorktreeList(listing.stdout)) {
    const taskId = lockedTaskOf(worktree.locked);
    if (taskId === null || isActive(taskId)) continue;
    if ((await git.run(["worktree", "unlock", "--", worktree.dir], { cwd: repo })).code === 0) lifted += 1;
  }
  return lifted;
}
