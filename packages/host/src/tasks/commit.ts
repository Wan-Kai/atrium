import type { GitRunner } from "../platform/git";
import { runSafeGit } from "../workspaces/safe-git";
import { firstSentence } from "./quote";

/** How long one of the commit's git commands may take. */
const COMMIT_TIMEOUT_MS = 60_000;

/** The trailer that marks the commit a node's attempt made (SPEC-0006, "一个 agent 节点怎么跑 · 结束"). */
const TRAILER_KEY = "Atrium-Task";

/**
 * The trailer's value for one attempt of a node.
 *
 * @remarks
 * `<taskId>/<node>/<attempt>` (SPEC-0006, "动作要幂等").
 *
 * @sideEffects none
 * @param taskId - The task.
 * @param node - The node.
 * @param attempt - The attempt.
 * @returns The value.
 */
export function trailerValue(taskId: string, node: string, attempt: number): string {
  return `${taskId}/${node}/${String(attempt)}`;
}

/**
 * The subject line of a node's commit.
 *
 * @remarks
 * `<任务名> · <节点名>：<摘要第一句>` (SPEC-0006, "结束" 4), on one line and cut to a length git logs read.
 *
 * @sideEffects none
 * @param taskName - The task's name.
 * @param nodeName - The node's name.
 * @param summary - The hand-over summary.
 * @returns The subject.
 */
export function commitSubject(taskName: string, nodeName: string, summary: string): string {
  const line = `${taskName} · ${nodeName}：${firstSentence(summary)}`.replaceAll(/\s+/gu, " ").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** The result of committing a node's work. */
export type CommitResult =
  /** A commit with the node's trailer is at the head: made now, or by an earlier run of this action. */
  | { readonly kind: "committed"; readonly commit: string }
  /** The node changed nothing. */
  | { readonly kind: "nothing" };

/**
 * Whether the head commit carries a trailer.
 *
 * @remarks
 * The idempotence of `commit_node` (SPEC-0006, "动作要幂等"): a crash after the commit but before the event
 * leaves the commit, and the replayed action finds it.
 *
 * @sideEffects Runs git.
 * @param git - git.
 * @param cwd - The worktree.
 * @param value - The trailer's value.
 * @returns The head's id when it carries the trailer, else `null`.
 */
async function headWithTrailer(git: GitRunner, cwd: string, value: string): Promise<string | null> {
  const log = await runSafeGit(
    git,
    ["log", "-1", `--format=%H%n%(trailers:key=${TRAILER_KEY},valueonly)`, "HEAD"],
    { cwd, timeoutMs: COMMIT_TIMEOUT_MS },
    { rejectIncludes: false },
  );
  if (log.code !== 0) return null;
  const [head, ...trailers] = log.stdout.split("\n");
  return head !== undefined && head !== "" && trailers.some((line) => line.trim() === value) ? head.trim() : null;
}

/**
 * Commits what a writing node changed in its worktree.
 *
 * @remarks
 * SPEC-0006, "结束" 4 and "宿主自己跑的 git": `git add -A`, then `git commit` with the trailer
 * `Atrium-Task: <taskId>/<node>/<attempt>`, both through `runSafeGit` with `rejectIncludes: false`, so the
 * repository's hooks, fsmonitor and filters do not run, and nothing is pushed. A head that already carries
 * the trailer is the answer without committing again. Nothing staged is no commit. The commit gets an
 * author of Atrium's own when the repository names none, and is never signed.
 *
 * @sideEffects Runs git; stages and commits in the worktree.
 * @param git - git.
 * @param cwd - The worktree.
 * @param message - The subject and the trailer's value.
 * @param message.subject - The commit's first line.
 * @param message.trailer - The value of the `Atrium-Task` trailer.
 * @returns What came of it.
 * @throws {Error} When git does not stage or commit.
 */
export async function commitWork(
  git: GitRunner,
  cwd: string,
  message: { readonly subject: string; readonly trailer: string },
): Promise<CommitResult> {
  const done = await headWithTrailer(git, cwd, message.trailer);
  if (done !== null) return { kind: "committed", commit: done };
  const timeoutMs = COMMIT_TIMEOUT_MS;
  const guard = { rejectIncludes: false };
  const added = await runSafeGit(git, ["add", "-A"], { cwd, timeoutMs }, guard);
  if (added.code !== 0) throw new Error("git add failed");
  // Exit code 1 means something is staged.
  const staged = await runSafeGit(git, ["diff", "--cached", "--quiet"], { cwd, timeoutMs }, guard);
  if (staged.code === 0) return { kind: "nothing" };
  const named = await git.run(["config", "user.email"], { cwd, timeoutMs });
  const author =
    named.code === 0 && named.stdout.trim() !== ""
      ? []
      : ["-c", "user.name=Atrium", "-c", "user.email=atrium@localhost"];
  const committed = await runSafeGit(
    git,
    [
      ...author,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      message.subject,
      "-m",
      `${TRAILER_KEY}: ${message.trailer}`,
    ],
    { cwd, timeoutMs },
    guard,
  );
  if (committed.code !== 0) throw new Error("git commit failed");
  const head = await runSafeGit(git, ["rev-parse", "HEAD"], { cwd, timeoutMs }, guard);
  if (head.code !== 0) throw new Error("git rev-parse failed");
  return { kind: "committed", commit: head.stdout.trim() };
}
