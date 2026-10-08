import type { MergeState, MergeUnknownReason } from "@atrium/protocol";
import type { GitRunner } from "../platform/git";

/** A worktree whose merge state is wanted. */
export interface MergeTarget {
  /** The project's directory, where refs are looked up. */
  readonly repo: string;
  /** The worktree's directory. */
  readonly dir: string;
  /** The worktree's directory exists and git does not mark it prunable. */
  readonly present: boolean;
  /** The branch checked out; `null` when detached. */
  readonly branch: string | null;
  /** The commit checked out. */
  readonly head: string;
  /** The commit Atrium created the worktree at; `null` for an external worktree. */
  readonly baseCommit: string | null;
  /** The main branch's ref, such as `refs/remotes/origin/main`; `null` when there is none. */
  readonly mainRef: string | null;
  /**
   * Whether the worktree is dirty, when known from a moment ago; `git status` is then skipped
   * (after a fetch only the main branch moved, SPEC-0001, "worktree 合并状态").
   */
  readonly dirty?: boolean;
}

/** Tells a worktree's merge state. */
export interface MergeInspector {
  /**
   * Works out one worktree's merge state.
   *
   * @remarks
   * See `createMergeInspector`.
   */
  inspect(target: MergeTarget, signal?: AbortSignal): Promise<MergeState>;
}

/** The first git version with `merge-tree --write-tree`. */
const MERGE_TREE_VERSION: readonly [number, number] = [2, 38];

/** Reflog entries that record a commit made on the branch itself. */
const OWN_COMMIT = /^(?:commit|cherry-pick|revert)\b|^merge .*: Merge made by/;

/**
 * A verdict that cannot be told, with why.
 *
 * @remarks
 * Nothing is ahead as far as anyone can tell.
 *
 * @sideEffects none
 * @param reason - Why.
 * @returns The verdict.
 */
function unknown(reason: MergeUnknownReason): Pick<MergeState, "ahead" | "verdict" | "reason"> {
  return { ahead: 0, verdict: "unknown", reason };
}

/**
 * Reads git's version from `git --version`.
 *
 * @remarks
 * Apple's git adds its own suffix, such as `git version 2.50.1 (Apple Git-155)`.
 *
 * @sideEffects none
 * @param output - What `git --version` printed.
 * @returns The major and minor version, or `null` when there is none.
 */
export function parseGitVersion(output: string): [number, number] | null {
  const match = /^git version (\d+)\.(\d+)/.exec(output);
  return match === null ? null : [Number(match[1]), Number(match[2])];
}

/**
 * Creates the merge inspector.
 *
 * @remarks
 * Follows SPEC-0001 ("worktree 合并状态"):
 * - a worktree whose directory is gone is `removed`;
 * - `dirty` is whether `git status` is clean; it is worked out every time unless the caller knows it;
 * - `ahead` counts the branch's commits the main branch lacks;
 * - a branch already in the main branch's history is `merged` once it has left where it
 *   started, else `noChange`. Where it started is the recorded base commit for a worktree Atrium
 *   created; for an external one, the branch's reflog shows whether commits were ever made on it;
 * - otherwise `git merge-tree --write-tree` simulates merging it: a result equal to the main
 *   branch's tree means its changes are in already (squash, rebase, cherry-pick), so `merged`;
 *   anything else, conflicts included, is `pending`.
 *
 * Without a main branch, with git older than 2.38, or when git fails, the verdict is `unknown`
 * with the reason. Each worktree keeps its last verdict with the branch, its commit, the main
 * commit and the base it came from, since it cannot change while those stay the same
 * (domain-model §1); a failure of git is not kept.
 *
 * @sideEffects none until `inspect`; then runs git.
 * @param options - The git runner and git's version.
 * @returns The inspector.
 */
export function createMergeInspector(options: {
  readonly git: GitRunner;
  readonly version: readonly [number, number] | null;
}): MergeInspector {
  /** The last verdict of each worktree, with what it was worked out from. */
  const verdicts = new Map<
    string,
    { readonly key: string; readonly result: Pick<MergeState, "ahead" | "verdict" | "reason"> }
  >();
  const oldGit =
    options.version === null ||
    options.version[0] < MERGE_TREE_VERSION[0] ||
    (options.version[0] === MERGE_TREE_VERSION[0] && options.version[1] < MERGE_TREE_VERSION[1]);

  /**
   * Works out the verdict and ahead count once the worktree is known to be there.
   *
   * @remarks
   * See `createMergeInspector`.
   *
   * @sideEffects Runs git.
   * @param target - The worktree.
   * @param signal - Stops git.
   * @returns The verdict, its reason and the ahead count.
   */
  async function judge(
    target: MergeTarget,
    signal: AbortSignal | undefined,
  ): Promise<Pick<MergeState, "ahead" | "verdict" | "reason">> {
    if (target.mainRef === null) return unknown("no_main_branch");
    /**
     * Runs git in the project.
     *
     * @remarks
     * Refs are looked up in the project's directory.
     *
     * @sideEffects Runs git.
     * @param args - git's arguments.
     * @returns git's result.
     */
    const run = (...args: string[]) => options.git.run(args, { cwd: target.repo, signal });
    const main = await run("rev-parse", "--verify", "--quiet", `${target.mainRef}^{commit}`);
    if (main.code !== 0) return unknown("no_main_branch");
    const mainCommit = main.stdout.trim();
    // The branch counts too: its reflog decides between merged and unchanged (`startedOrMerged`).
    const key = `${target.branch ?? ""}:${target.head}:${mainCommit}:${target.baseCommit ?? ""}`;
    const known = verdicts.get(target.dir);
    if (known?.key === key) return known.result;
    const count = await run("rev-list", "--count", `${mainCommit}..${target.head}`);
    if (count.code !== 0) return unknown("git_failed");
    const ahead = Number(count.stdout.trim());
    let verdict: MergeState["verdict"] | MergeUnknownReason;
    const ancestor = await run("merge-base", "--is-ancestor", target.head, mainCommit);
    if (ancestor.code === 0) {
      verdict = await startedOrMerged(target, signal);
    } else if (ancestor.code !== 1) {
      verdict = "git_failed";
    } else if (oldGit) {
      verdict = "git_too_old";
    } else {
      verdict = await simulateMerge(target.repo, mainCommit, target.head, signal);
    }
    const result =
      verdict === "noChange" || verdict === "merged" || verdict === "pending"
        ? { ahead, verdict, reason: null }
        : { ...unknown(verdict), ahead };
    // A failure may not happen again; anything else holds while the commits stay the same.
    if (verdict !== "git_failed") verdicts.set(target.dir, { key, result });
    return result;
  }

  /**
   * Tells a branch that never left where it started from one merged back.
   *
   * @remarks
   * Both are in the main branch's history; see `createMergeInspector`.
   *
   * @sideEffects Runs git.
   * @param target - The worktree.
   * @param signal - Stops git.
   * @returns `noChange`, `merged`, or why it cannot be told.
   */
  async function startedOrMerged(
    target: MergeTarget,
    signal: AbortSignal | undefined,
  ): Promise<"noChange" | "merged" | MergeUnknownReason> {
    if (target.baseCommit !== null) return target.head === target.baseCommit ? "noChange" : "merged";
    if (target.branch === null) return "base_unknown";
    const reflog = await options.git.run(["reflog", "show", "--format=%gs", `refs/heads/${target.branch}`, "--"], {
      cwd: target.repo,
      signal,
    });
    const entries = reflog.stdout.split("\n").filter((line) => line !== "");
    if (reflog.code !== 0 || entries.length === 0) return "base_unknown";
    return entries.some((entry) => OWN_COMMIT.test(entry)) ? "merged" : "noChange";
  }

  /**
   * Merges a branch into the main branch in git's object store only.
   *
   * @remarks
   * `merge-tree --write-tree` changes neither working tree nor index, but writes objects
   * (domain-model §6). Exit 0 is a clean merge whose tree is the first line; 1 is conflicts.
   *
   * @sideEffects Runs git, which writes objects into the repository.
   * @param repo - The project's directory.
   * @param mainCommit - The main branch's commit.
   * @param head - The branch's commit.
   * @param signal - Stops git.
   * @returns `merged`, `pending`, or `git_failed`.
   */
  async function simulateMerge(
    repo: string,
    mainCommit: string,
    head: string,
    signal: AbortSignal | undefined,
  ): Promise<"merged" | "pending" | "git_failed"> {
    const merged = await options.git.run(["merge-tree", "--write-tree", "--no-messages", mainCommit, head], {
      cwd: repo,
      signal,
    });
    if (merged.code === 1) return "pending";
    if (merged.code !== 0) return "git_failed";
    const tree = await options.git.run(["rev-parse", `${mainCommit}^{tree}`], { cwd: repo, signal });
    if (tree.code !== 0) return "git_failed";
    return merged.stdout.split("\n")[0] === tree.stdout.trim() ? "merged" : "pending";
  }

  return {
    async inspect(target, signal) {
      if (!target.present) return { dirty: false, ahead: 0, verdict: "removed", reason: null };
      if (target.dirty !== undefined) return { dirty: target.dirty, ...(await judge(target, signal)) };
      const status = await options.git.run(["status", "--porcelain"], { cwd: target.dir, signal });
      if (status.code !== 0) return { dirty: false, ahead: 0, verdict: "unknown", reason: "git_failed" };
      return { dirty: status.stdout !== "", ...(await judge(target, signal)) };
    },
  };
}
