/** One worktree as `git worktree list --porcelain` describes it. */
export interface ListedWorktree {
  readonly dir: string;
  /** The commit checked out; empty for a bare repository. */
  readonly head: string;
  /** The branch checked out, without `refs/heads/`; `null` when detached. */
  readonly branch: string | null;
  /** git marks it prunable: its directory is gone. */
  readonly prunable: boolean;
  readonly bare: boolean;
}

/**
 * Parses `git worktree list --porcelain`.
 *
 * @remarks
 * Records are separated by empty lines; each starts with `worktree <path>` and has `HEAD <sha>`,
 * then `branch <ref>` or `detached`, and may add `bare`, `locked` or `prunable` with a reason
 * (git-worktree(1), "Porcelain Format"). The first record is the main worktree. Lines this
 * parser does not know are skipped, so a newer git's additions do not break it.
 *
 * @sideEffects none
 * @param output - What git printed.
 * @returns The worktrees, main first.
 */
export function parseWorktreeList(output: string): ListedWorktree[] {
  const worktrees: ListedWorktree[] = [];
  for (const block of output.split("\n\n")) {
    const lines = block.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "));
    if (path === undefined) continue;
    /**
     * The value of one attribute line of the record.
     *
     * @remarks
     * Lines are `<key> <value>`.
     *
     * @sideEffects none
     * @param key - The attribute.
     * @returns Its value, or `undefined`.
     */
    const valueOf = (key: string) => lines.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1);
    const branch = valueOf("branch");
    worktrees.push({
      dir: path.slice("worktree ".length),
      head: valueOf("HEAD") ?? "",
      branch: branch === undefined ? null : branch.replace(/^refs\/heads\//, ""),
      prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")),
      bare: lines.includes("bare"),
    });
  }
  return worktrees;
}
