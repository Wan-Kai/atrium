/** Runs the host's changes to worktrees one at a time: creating, archiving and restoring them. */
export interface WorktreeQueue {
  /** Runs `work` once the changes before it have ended, and returns what it returns. */
  run<T>(work: () => Promise<T>): Promise<T>;
  /** Resolves once the changes queued so far have ended, for the host to stop after them. */
  idle(): Promise<void>;
}

/**
 * Creates the worktree queue.
 *
 * @remarks
 * Two changes at once could both pass their checks for one directory or branch (SPEC-0001,
 * "M1.11 的工作区归档", "M1.11 的新建工作区"). A change that fails does not hold up the next.
 *
 * @sideEffects none
 * @returns The queue.
 */
export function createWorktreeQueue(): WorktreeQueue {
  /** The last change queued, which the next one waits for. */
  let last: Promise<unknown> = Promise.resolve();
  return {
    run(work) {
      const next = last.then(work);
      last = next.catch(() => undefined);
      return next;
    },
    idle: () => last.then(() => undefined),
  };
}
