import { createHash } from "node:crypto";
import { GitError, type GitRunner } from "../platform/git";
import { parseWorktreeList } from "./worktree-list";

/** The start of the reason of a lock a task puts on a worktree (SPEC-0006, "加锁"). */
const TASK_LOCK_PREFIX = "atrium task ";

/** The reason as Atrium writes it: the task, then which home took the lock (12 hexadecimal digits). Older Atriums wrote no home. */
const TASK_LOCK_REASON = /^atrium task ([A-Za-z0-9_-]+)(?: home ([0-9a-f]{12}))?$/;

/** Who took a task lock: the task, and the Atrium home that put it on, `null` for the older reason that names none. */
export interface TaskLockOwner {
  readonly taskId: string;
  readonly home: string | null;
}

/**
 * Names an Atrium home in a lock's reason.
 *
 * @remarks
 * The first 12 hexadecimal digits of the SHA-256 of the home's path (SPEC-0006, "T9 / T10 审查后用户定"): enough to
 * tell two homes on one machine apart, and no path in a reason that `git worktree list` shows to anyone.
 *
 * @sideEffects none
 * @param root - The home's directory.
 * @returns The 12 digits.
 */
export function homeTagOf(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 12);
}

/**
 * The reason of the lock a task puts on a worktree.
 *
 * @remarks
 * `atrium task <taskId> home <tag>` (SPEC-0006, "加锁"); without a home tag it is the older `atrium task <taskId>`,
 * which is still read but no longer written.
 *
 * @sideEffects none
 * @param taskId - The task.
 * @param home - The home's tag, from `homeTagOf`.
 * @returns The reason.
 */
export function taskLockReason(taskId: string, home?: string): string {
  return home === undefined ? `${TASK_LOCK_PREFIX}${taskId}` : `${TASK_LOCK_PREFIX}${taskId} home ${home}`;
}

/**
 * Who a lock's reason says took the lock.
 *
 * @remarks
 * A lock the user put on, or one with any other reason, belongs to no task and is left alone.
 *
 * @sideEffects none
 * @param reason - The reason git lists, or `null` when not locked.
 * @returns The task and home, or `null`.
 */
export function lockOwnerOf(reason: string | null): TaskLockOwner | null {
  const match = reason === null ? null : TASK_LOCK_REASON.exec(reason);
  return match === null ? null : { taskId: match[1] ?? "", home: match[2] ?? null };
}

/**
 * The task a lock's reason names.
 *
 * @remarks
 * Either way of writing the reason names a task, so archiving stops for both.
 *
 * @sideEffects none
 * @param reason - The reason git lists, or `null` when not locked.
 * @returns The task's id, or `null`.
 */
export function lockedTaskOf(reason: string | null): string | null {
  return lockOwnerOf(reason)?.taskId ?? null;
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
 * @param home - The tag of the home that locks.
 * @returns Whether the worktree is now locked for the task.
 * @throws {GitError} `exit` when git cannot list worktrees.
 */
export async function lockWorktree(
  git: GitRunner,
  repo: string,
  dir: string,
  taskId: string,
  home?: string,
): Promise<boolean> {
  const reason = taskLockReason(taskId, home);
  const current = await lockOf(git, repo, dir);
  // The older reason of the same task is as good as this one; it is not rewritten.
  if (current === reason || current === taskLockReason(taskId)) return true;
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
 * @param home - The tag of the home that unlocks.
 * @returns Whether the worktree is now free of the task's lock.
 * @throws {GitError} `exit` when git cannot list worktrees.
 */
export async function unlockWorktree(
  git: GitRunner,
  repo: string,
  dir: string,
  taskId: string,
  home?: string,
): Promise<boolean> {
  const current = await lockOf(git, repo, dir);
  if (current === null) return true;
  if (current !== taskLockReason(taskId, home) && current !== taskLockReason(taskId)) return false;
  return (await git.run(["worktree", "unlock", "--", dir], { cwd: repo })).code === 0;
}

/**
 * Lifts the locks of tasks that are over, when the host starts.
 *
 * @remarks
 * A host that died, or a task that ended while it was down, leaves its locks behind and the
 * worktree could never be archived. Only a lock this home took (`atrium task <id> home <tag>` with this tag), for a task
 * `isOver` says is over, is lifted (SPEC-0006, "T9 / T10 审查后用户定"): the user's locks, another home's, the older
 * reason that names no home, and the locks of tasks that are still going or cannot be read stay.
 *
 * @sideEffects Runs git; changes worktrees' registrations.
 * @param git - git.
 * @param repo - A directory of the repository.
 * @param home - The tag of this home.
 * @param isOver - Whether a task of this home is done, cancelled or gone, so that nothing is going on in the worktree.
 * @returns How many locks were lifted.
 * @throws {GitError} `exit` when git cannot list worktrees.
 */
export async function clearStaleLocks(
  git: GitRunner,
  repo: string,
  home: string,
  isOver: (taskId: string) => boolean,
): Promise<number> {
  const listing = await git.run(["worktree", "list", "--porcelain"], { cwd: repo });
  if (listing.code !== 0) throw new GitError("worktree", "exit");
  let lifted = 0;
  for (const worktree of parseWorktreeList(listing.stdout)) {
    const owner = lockOwnerOf(worktree.locked);
    if (owner === null || owner.home !== home || !isOver(owner.taskId)) continue;
    if ((await git.run(["worktree", "unlock", "--", worktree.dir], { cwd: repo })).code === 0) lifted += 1;
  }
  return lifted;
}
