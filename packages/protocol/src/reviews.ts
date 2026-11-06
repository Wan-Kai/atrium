import { z } from "zod";
import { ErrorParams } from "./errors";
import { WorkspaceId } from "./ids";

// Reviews (ADR-0017; SPEC-0006, "界面 · 审核卡片"). One shape for everything the user is asked to judge: the gates
// of a task (the host's flow, carried out by the host) and, later, a request the agent makes in a conversation.
// The host sends codes and parameters, never words; the words are the UI's. Text an agent wrote travels only as
// quoted text (`Evidence.summary`, `subject.text`), never as a fact.

/** The longest quoted text a review carries: an agent's summary or title. */
export const REVIEW_TEXT_LIMIT = 100_000;

/** The most reviews one session has open at a time. */
export const REVIEWS_LIMIT = 16;

/**
 * Which gate of the host's flow raised a review (ADR-0017, decision 1).
 *
 * @remarks
 * `task_graph`: a graph change waits for approval; `task_human`: a human node waits, and a merge that was held
 * back is a `problem` on this same review, not another gate (SPEC-0006, "审核卡片"); `task_archive`: the question
 * about the worktree a finished task made. Later gates (a tool that needs review before it runs) add values here.
 */
export const GateKind = z.enum(["task_graph", "task_human", "task_archive"]);
export type GateKind = z.infer<typeof GateKind>;

/** Who raised a review: a gate of the host's flow, or the agent through a tool call (a later SPEC). */
export const ReviewSource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("gate"), gate: GateKind }),
  z.strictObject({ kind: z.literal("agent"), toolCallId: z.string().min(1).max(256) }),
]);
export type ReviewSource = z.infer<typeof ReviewSource>;

/**
 * What is being reviewed: a code and parameters the UI words (a gate), or the agent's own title (quoted).
 *
 * @remarks
 * A gate's codes: `task_graph_change` (`taskId`, `version`), `task_human_node` (`taskId`, `node`, `merge`),
 * `task_archive` (`taskId`).
 */
export const ReviewSubject = z.union([
  z.strictObject({ code: z.string().min(1).max(64), params: ErrorParams }),
  z.strictObject({ text: z.string().max(REVIEW_TEXT_LIMIT) }),
]);
export type ReviewSubject = z.infer<typeof ReviewSubject>;

/** How a fact reads: fine, worth a look, or bad. Only the host's own facts carry one. */
export const FactStatus = z.enum(["ok", "warn", "danger"]);
export type FactStatus = z.infer<typeof FactStatus>;

/**
 * One thing the host found out, as a code and parameters with a status.
 *
 * @remarks
 * Codes: `worktree_clean`, `worktree_dirty`, `worktree_merged`, `worktree_not_merged`, `worktree_merge_unknown`
 * (all with `name`), `commits_ahead` (`count`).
 */
export const Fact = z.strictObject({
  code: z.string().min(1).max(64),
  params: ErrorParams,
  status: FactStatus,
});
export type Fact = z.infer<typeof Fact>;

/**
 * A node id in a review, as the task's graph names it.
 *
 * @remarks
 * Plain text here so that this file does not depend on the tasks'; the length is the same.
 */
const NodeRef = z.string().min(1).max(64);

/**
 * What a review shows to judge by (ADR-0017, decision 1).
 *
 * @remarks
 * - `facts`: what the host worked out, each with a status;
 * - `changes`: files and lines changed in a worktree, with the workspace the changes panel opens;
 * - `graph_diff`: the nodes a graph version added, removed and changed against the one in force (`from` is that
 *   version, `null` when there was none);
 * - `summary`: text somebody wrote (an upstream node's hand-over, or the agent), quoted, never a fact.
 */
export const Evidence = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("facts"), facts: z.array(Fact).max(32) }),
  z.strictObject({
    kind: z.literal("changes"),
    workspaceId: WorkspaceId,
    files: z.number().int().nonnegative(),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("graph_diff"),
    from: z.number().int().nonnegative().nullable(),
    to: z.number().int().positive(),
    added: z.array(NodeRef).max(20),
    removed: z.array(NodeRef).max(20),
    changed: z.array(NodeRef).max(20),
  }),
  z.strictObject({
    kind: z.literal("summary"),
    by: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("node"), node: NodeRef }),
      z.strictObject({ kind: z.literal("agent") }),
    ]),
    text: z.string().max(REVIEW_TEXT_LIMIT),
  }),
]);
export type Evidence = z.infer<typeof Evidence>;

/** Why the last attempt to carry out a verdict did not work: a code, parameters and, for a merge, the files. */
export const ReviewProblem = z.strictObject({
  code: z.string().min(1).max(64),
  params: ErrorParams,
  files: z.array(z.string().max(4096)).max(50).optional(),
});
export type ReviewProblem = z.infer<typeof ReviewProblem>;

/** Where an action can point, and how many more times it may (`null` when it has no limit). */
export const ReviewTarget = z.strictObject({
  id: NodeRef,
  remaining: z.number().int().nonnegative().nullable(),
});
export type ReviewTarget = z.infer<typeof ReviewTarget>;

/**
 * One button of a review.
 *
 * @remarks
 * `reason` says whether the verdict takes a reason; `targets` is empty unless the verdict must name one (a send-back
 * names the node to go back to, and a target with `remaining: 0` is listed so the card can grey it; the host still
 * refuses it); `recommended` is the host's default from the facts. A gate's action ids: `approve`, `reject`
 * (`task_graph`); `pass`, `retry`, `send_back` (`task_human`: `retry` replaces `pass` while a merge is held back);
 * `archive`, `keep` (`task_archive`).
 */
export const ReviewAction = z.strictObject({
  id: z.string().min(1).max(32),
  reason: z.enum(["none", "optional", "required"]),
  targets: z.array(ReviewTarget).max(20),
  recommended: z.boolean(),
});
export type ReviewAction = z.infer<typeof ReviewAction>;

/**
 * A review waiting for the user's verdict (ADR-0017, decision 1).
 *
 * @remarks
 * Worked out from the host's durable state for a gate, so it is the same after a restart. `id` is stable while the
 * review is the same one (a node's attempt, a graph version) and different once a new one takes its place.
 */
export const PendingReview = z.strictObject({
  id: z.string().min(1).max(256),
  /** When what is judged began to wait, in milliseconds since the Unix epoch. */
  openedAt: z.number().int().nonnegative(),
  source: ReviewSource,
  subject: ReviewSubject,
  evidence: z.array(Evidence).max(8),
  problem: ReviewProblem.nullable(),
  actions: z.array(ReviewAction).min(1).max(8),
});
export type PendingReview = z.infer<typeof PendingReview>;

/** The user's verdict on a review: an action, the target it needs, and the reason it takes. */
export const Verdict = z.strictObject({
  action: z.string().min(1).max(32),
  target: NodeRef.optional(),
  reason: z.string().max(REVIEW_TEXT_LIMIT).optional(),
});
export type Verdict = z.infer<typeof Verdict>;

/**
 * A review's outcome as the conversation keeps it (the `atrium-review` custom message; ADR-0017, decision 2).
 *
 * @remarks
 * The evidence is the snapshot from when the verdict was given.
 */
export const ReviewRecord = z.strictObject({
  source: ReviewSource,
  subject: ReviewSubject,
  evidence: z.array(Evidence).max(8),
  verdict: Verdict,
});
export type ReviewRecord = z.infer<typeof ReviewRecord>;
