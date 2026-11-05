import type { GitRunner } from "../platform/git";
import type { MergeInspector } from "../workspaces/merge-inspector";
import { runSafeGit } from "../workspaces/safe-git";
import { assertOwnTree, authorOptions } from "./commit";
import { MAX_CONFLICT_FILES } from "./graph";
import type { MergeBlockReason } from "./types";

/** How long one of the merge's quick git commands may take. */
const QUICK_MS = 60_000;

/** How long the merge itself may take: it writes the files of both sides into the main checkout. */
const MERGE_MS = 300_000;

/** What `mergeTaskBranch` needs. */
export interface MergeTaskOptions {
  readonly git: GitRunner;
  /** Tells a branch that is already merged; `null` when git cannot (older than 2.38), which skips that check. */
  readonly inspector: MergeInspector | null;
  /** The project's main checkout, where the merge is made. */
  readonly mainDir: string;
  /** The task's worktree, on the branch to merge. */
  readonly worktreeDir: string;
  /** The commit the worktree was made at, which tells a branch that never moved from one merged back. */
  readonly baseCommit: string | null;
  /** The trunk branch's name, such as `main`; `null` when the project has none (SPEC-0006, "合并" 2). */
  readonly trunk: string | null;
  /** Stops the checks before the merge starts; the merge and the clean-up after it are not stopped by it. */
  readonly signal?: AbortSignal | undefined;
}

/** How a merge came out (SPEC-0006, "合并"). */
export type MergeOutcome =
  | { readonly kind: "merged" }
  | { readonly kind: "blocked"; readonly reason: MergeBlockReason; readonly files?: readonly string[] };

/**
 * Runs one of the host's git commands in a checkout, pinned to that checkout's own tree.
 *
 * @remarks
 * Through `runSafeGit` (no hooks, fsmonitor, filters or merge drivers, no gpg program), with
 * `--work-tree=<dir>` on every command (SPEC-0006, "宿主自己跑的 git"). Includes are not refused: a
 * worktree shares its repository's configuration, and a merge driver or filter an include adds is in the
 * full listing `runSafeGit` turns off.
 *
 * @sideEffects Runs git.
 * @param options - The merge's options.
 * @param dir - The checkout.
 * @param args - git's arguments after the pin.
 * @param extra - A timeout, whether the caller's signal applies, and options for before the pin.
 * @param extra.timeoutMs - How long it may take.
 * @param extra.stoppable - Whether the caller's signal stops it.
 * @param extra.before - Options that go before the pin, such as `-c` for an author.
 * @returns What git did.
 * @throws {GitError} When git cannot run, time out, or list its configuration.
 * @throws {CommandError} `worktree_config_unsafe`.
 */
function git(
  options: MergeTaskOptions,
  dir: string,
  args: readonly string[],
  extra: { readonly timeoutMs?: number; readonly stoppable?: boolean; readonly before?: readonly string[] } = {},
): ReturnType<GitRunner["run"]> {
  return runSafeGit(
    options.git,
    [...(extra.before ?? []), `--work-tree=${dir}`, ...args],
    {
      cwd: dir,
      timeoutMs: extra.timeoutMs ?? QUICK_MS,
      signal: extra.stoppable === false ? undefined : options.signal,
    },
    { rejectIncludes: false },
  );
}

/**
 * Whether a checkout has changes: modified, staged or untracked files.
 *
 * @remarks
 * `git status --porcelain` prints nothing for a clean tree (SPEC-0006, "合并" 1, 2).
 *
 * @sideEffects Runs git.
 * @param options - The merge's options.
 * @param dir - The checkout.
 * @param stoppable - Whether the caller's signal stops git.
 * @returns Whether it is dirty.
 * @throws {Error} When git does not answer.
 */
async function isDirty(options: MergeTaskOptions, dir: string, stoppable = true): Promise<boolean> {
  const status = await git(options, dir, ["status", "--porcelain"], { stoppable });
  if (status.code !== 0) throw new Error("git status failed");
  return status.stdout !== "";
}

/**
 * The commit a checkout's HEAD is at.
 *
 * @remarks
 * Compared before and after a merge that was backed out.
 *
 * @sideEffects Runs git.
 * @param options - The merge's options.
 * @param dir - The checkout.
 * @param stoppable - Whether the caller's signal stops git.
 * @returns The full commit id.
 * @throws {Error} When git does not answer.
 */
async function headOf(options: MergeTaskOptions, dir: string, stoppable = true): Promise<string> {
  const head = await git(options, dir, ["rev-parse", "--verify", "HEAD"], { stoppable });
  if (head.code !== 0) throw new Error("git rev-parse failed");
  return head.stdout.trim();
}

/**
 * Backs a failed merge out and says what it was.
 *
 * @remarks
 * SPEC-0006, "合并" 4. A merge stopped half way leaves unmerged files: they are the conflict, and
 * `git merge --abort` ends it (an abort that fails on a conflict is `merge_abort_failed`). Whatever git did,
 * the main checkout must then be at the commit it was at before and clean; if it is not, or git cannot say,
 * nothing more is done to it: `merge_abort_failed`. A merge that failed without a conflict (git refused it) is
 * `merge_git_failed` once the checkout is shown to be as it was. The caller's signal does not stop these commands: a checkout left half merged because the host
 * was closing is worse than waiting a moment.
 *
 * @sideEffects Runs git; aborts the merge in the main checkout.
 * @param options - The merge's options.
 * @param before - The commit the main checkout was at before the merge.
 * @returns The blocked outcome.
 */
async function backOut(options: MergeTaskOptions, before: string): Promise<MergeOutcome> {
  const dir = options.mainDir;
  try {
    // Unmerged files are the conflict: a merge that stopped at one leaves them in the index.
    const listed = await git(
      options,
      dir,
      ["diff", "--name-only", "--diff-filter=U", "--no-ext-diff", "--no-textconv", "-z"],
      { stoppable: false },
    );
    const files = listed.stdout.split("\0").filter((name) => name !== "");
    const conflicted = files.length > 0;
    // A merge git refused to start has nothing to abort, and its abort fails; the checkout is checked all the same.
    const aborted = await git(options, dir, ["merge", "--abort"], { stoppable: false });
    if (conflicted && aborted.code !== 0) return { kind: "blocked", reason: "merge_abort_failed" };
    const back = (await headOf(options, dir, false)) === before && !(await isDirty(options, dir, false));
    if (!back) return { kind: "blocked", reason: "merge_abort_failed" };
    return conflicted
      ? { kind: "blocked", reason: "merge_conflict", files: files.slice(0, MAX_CONFLICT_FILES) }
      : { kind: "blocked", reason: "merge_git_failed" };
  } catch {
    return { kind: "blocked", reason: "merge_abort_failed" };
  }
}

/**
 * Merges a task's branch into the trunk in the project's main checkout, or says why it did not.
 *
 * @remarks
 * SPEC-0006, "合并": the checks come in the SPEC's order and nothing is changed until they pass.
 * 1. The task's worktree must be clean (`merge_worktree_dirty`); nothing is added for the user.
 * 2. A branch already in the trunk (or whose changes are, or that never moved) is `merged` at once, which
 *    makes the action safe to run again after a crash (SPEC-0006, "动作要幂等"). It comes after check 1 and
 *    before the checks on the main checkout, which a merged branch no longer depends on.
 * 3. The main checkout must be clean (`merge_main_dirty`) and on the trunk (`merge_main_not_trunk`, also when
 *    the project has no trunk).
 * 4. `git merge --no-ff` through `runSafeGit`: no hooks, fsmonitor, filters or merge drivers. A conflict is
 *    backed out (`backOut`) and reported with its files; nothing is pushed.
 *
 * Both checkouts are asked for their top-level directory first: a node can write `core.worktree` into the
 * repository's configuration, and git would then work on a tree elsewhere. A checkout that is not what the
 * host expects, or a git that fails, is `merge_git_failed` (T5).
 *
 * @sideEffects Runs git; merges in the main checkout.
 * @param options - The git runner, inspector, directories, base commit, trunk and signal.
 * @returns `merged`, or `blocked` with the reason (and the conflicting files for a conflict).
 * @throws {Error} When the signal stopped it before the merge started.
 */
export async function mergeTaskBranch(options: MergeTaskOptions): Promise<MergeOutcome> {
  const { mainDir, worktreeDir } = options;
  try {
    await assertOwnTree(options.git, worktreeDir);
    if (await isDirty(options, worktreeDir)) return { kind: "blocked", reason: "merge_worktree_dirty" };
    const branch = await git(options, worktreeDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (branch.code !== 0) return { kind: "blocked", reason: "merge_git_failed" };
    const branchName = branch.stdout.trim();
    await assertOwnTree(options.git, mainDir);
    if (options.trunk !== null && options.inspector !== null) {
      const head = await headOf(options, worktreeDir);
      const state = await options.inspector.inspect(
        {
          repo: mainDir,
          dir: worktreeDir,
          present: true,
          branch: branchName,
          head,
          baseCommit: options.baseCommit,
          mainRef: `refs/heads/${options.trunk}`,
          dirty: false,
        },
        options.signal,
      );
      if (state.verdict === "merged" || state.verdict === "noChange") return { kind: "merged" };
    }
    if (await isDirty(options, mainDir)) return { kind: "blocked", reason: "merge_main_dirty" };
    const onBranch = await git(options, mainDir, ["symbolic-ref", "--quiet", "HEAD"]);
    if (options.trunk === null || onBranch.code !== 0 || onBranch.stdout.trim() !== `refs/heads/${options.trunk}`) {
      return { kind: "blocked", reason: "merge_main_not_trunk" };
    }
    const before = await headOf(options, mainDir);
    const tip = await headOf(options, worktreeDir);
    // The merge starts here; from now on nothing stops it half way.
    options.signal?.throwIfAborted();
    const merged = await mergeNow(options, branchName, tip);
    return merged === 0 ? { kind: "merged" } : await backOut(options, before);
  } catch (error) {
    if (options.signal?.aborted === true) throw error;
    return { kind: "blocked", reason: "merge_git_failed" };
  }
}

/**
 * Runs `git merge --no-ff` for the branch in the main checkout.
 *
 * @remarks
 * No editor (`--no-edit`) and no diffstat (`--no-stat`). The commit is merged, not the branch's name: a tag
 * of the same name would win over the branch in git's lookup, and an agent can make tags. The message names
 * the branch, as git's own would. A git that could not run to an exit code counts as a failed merge, for
 * `backOut` to look at the checkout.
 *
 * @sideEffects Runs git; merges in the main checkout.
 * @param options - The merge's options.
 * @param branch - The task's branch, for the message.
 * @param tip - The commit the branch is at.
 * @returns git's exit code, or -1 when it did not run to one.
 */
async function mergeNow(options: MergeTaskOptions, branch: string, tip: string): Promise<number> {
  try {
    const author = await authorOptions(options.git, options.mainDir, QUICK_MS);
    const result = await git(
      options,
      options.mainDir,
      ["merge", "--no-ff", "--no-edit", "--no-stat", "-m", `Merge branch '${branch}'`, "--", tip],
      { timeoutMs: MERGE_MS, stoppable: false, before: author },
    );
    return result.code;
  } catch {
    return -1;
  }
}
