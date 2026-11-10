import { CommandError } from "@atrium/client";
import type { PendingReview, ReviewAction, ReviewProblem } from "@atrium/protocol";
import { describeSendError } from "../chat/conversation-area";
import type { ReviewEnv } from "../chat/review-env";
import { MERGE_BLOCK_WORDS, knownTaskError } from "./task-words";

/** The names a task's review card uses for facts: the code and the parameters the host sent (SPEC-0006, "T8a"). */
const FACT_WORDS: Readonly<
  Record<string, (params: Readonly<Record<string, string | number | boolean | null>>) => string>
> = {
  worktree_clean: () => "没有未提交的改动",
  worktree_dirty: () => "worktree 里有没提交的改动",
  worktree_merged: (params) => `${String(params["name"] ?? "这个分支")} 已合并进主干`,
  worktree_not_merged: (params) => `${String(params["name"] ?? "这个分支")} 还没合并进主干，提交只在这个分支上`,
  worktree_merge_unknown: () => "合没合并进主干，查不出来",
  commits_ahead: (params) => `${String(params["count"] ?? 0)} 个提交`,
};

/**
 * The words of a task review's problem: why the last try did not go through.
 *
 * @remarks
 * The six reasons a merge is held back (设计稿第 7 屏 35); a conflict says how many files when it lists them, and
 * the one that could leave the main directory unclean is the red kind.
 *
 * @sideEffects none
 * @param problem - The problem.
 * @returns The sentence and whether it is the red kind.
 */
function problemWords(problem: ReviewProblem): { readonly text: string; readonly danger: boolean } {
  const known = (MERGE_BLOCK_WORDS as Readonly<Record<string, string>>)[problem.code];
  if (known === undefined) return { text: "上次没有执行成功", danger: false };
  const files = problem.files?.length ?? 0;
  const text = problem.code === "merge_conflict" && files > 0 ? `${String(files)} 个文件冲突` : known;
  return { text: `合并被挡住：${text}`, danger: problem.code === "merge_abort_failed" };
}

/**
 * The words on a task review's button.
 *
 * @remarks
 * A button that opens a form ends in the ellipsis, as the draft has them ("不批准…", "打回到 N2…"); with one
 * target the target is named.
 *
 * @sideEffects none
 * @param action - The button.
 * @param review - The review.
 * @param name - A node's name, if known.
 * @returns The label.
 */
function actionWords(action: ReviewAction, review: PendingReview, name: (node: string) => string | undefined): string {
  const merge = "params" in review.subject && review.subject.params["merge"] === true;
  switch (action.id) {
    case "approve":
      return "批准，接着跑";
    case "reject":
      return "不批准…";
    case "pass":
      return merge ? "通过并合并" : "通过";
    case "retry":
      return "重试合并";
    case "send_back": {
      const only = action.targets.length === 1 ? action.targets[0] : undefined;
      const label =
        only === undefined
          ? "打回到…"
          : `打回到 ${only.id}${name(only.id) === undefined ? "" : ` ${String(name(only.id))}`}…`;
      return label;
    }
    case "archive":
      return "归档";
    case "keep":
      return "先留着";
    default:
      return action.id;
  }
}

/**
 * The small print at the right of a task review's buttons.
 *
 * @remarks
 * 设计稿第 7 屏: how many times a node can still be sent back ("还能打回 2 次", the most any target has left, from
 * the "打回" button), and that a worktree kept for now can be archived later.
 *
 * @sideEffects none
 * @param review - The review.
 * @returns The line, or `null`.
 */
function noteWords(review: PendingReview): string | null {
  const back = review.actions.find((action) => action.id === "send_back");
  if (back !== undefined && back.targets.length > 0) {
    const left = Math.max(...back.targets.map((target) => target.remaining ?? 0));
    return left > 0 ? `还能打回 ${String(left)} 次` : "打回的次数用完了";
  }
  if (review.source.kind === "gate" && review.source.gate === "task_archive") return "留着以后也能归档";
  return null;
}

/**
 * The environment a review card above a task conversation reads: the words for the four task gates and the links.
 *
 * @remarks
 * The card is generic (ADR-0018); everything task-specific about it is the code-to-words mapping here, so an agent's
 * review later reuses the card unchanged. A subject is named by the node the review is about, with its name.
 *
 * @sideEffects none; the callbacks are the caller's.
 * @param links - How to name a node, open a workspace's changes and show a proposed graph.
 * @returns The environment.
 */
export function taskReviewEnv(links: Pick<ReviewEnv, "nodeName" | "openChanges" | "showOnGraph">): ReviewEnv {
  return {
    ...links,
    source: () => "任务",
    subject: (review) => {
      if ("text" in review.subject) return review.subject.text;
      const { code, params } = review.subject;
      if (code === "task_graph_change") return `图 v${String(params["version"] ?? "")} 等你批准`;
      if (code === "task_archive") return "要归档 worktree 吗";
      if (code === "task_human_node") {
        const node = String(params["node"] ?? "");
        const name = links.nodeName(node);
        return name === undefined ? node : `${node} ${name}`;
      }
      return code;
    },
    fact: (fact) => FACT_WORDS[fact.code]?.(fact.params) ?? fact.code,
    problem: problemWords,
    action: (action, review) => actionWords(action, review, links.nodeName),
    icon: (action, review) =>
      action.id === "pass" && "params" in review.subject && review.subject.params["merge"] === true
        ? "merge"
        : action.id === "send_back"
          ? "back"
          : action.id === "retry"
            ? "retry"
            : null,
    note: noteWords,
    confirm: (action) => (action.id === "reject" ? "确认不批准" : action.id === "send_back" ? "确认打回" : "确定"),
  };
}

/**
 * The words for what went wrong when a task command or a review's verdict failed.
 *
 * @remarks
 * The task codes first (a verdict is carried out by the task commands, so it fails with theirs: a state that
 * changed, a back edge used up, a worktree with changes), then the general wording for a send. The host sends only
 * codes and parameters; this is the UI's sentence for them.
 *
 * @sideEffects none
 * @param error - What the command rejected with.
 * @returns The sentence.
 */
export function describeTaskCommandError(error: unknown): string {
  if (error instanceof CommandError) {
    const known = knownTaskError(error.code);
    if (known !== null) return known;
  }
  return describeSendError(error);
}
