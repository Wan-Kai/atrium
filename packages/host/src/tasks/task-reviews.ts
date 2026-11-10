import {
  CommandError,
  REVIEWS_LIMIT,
  REVIEW_EVIDENCE_LIMIT,
  REVIEW_TEXT_LIMIT,
  type Evidence,
  type Fact,
  type PendingReview,
  type ReviewAction,
  type ReviewRecord,
  type TaskArchiveFacts,
  type Verdict,
} from "@atrium/protocol";
import type { ReviewProvider } from "../reviews/review-hub";
import { diffGraphs } from "./graph-diff";
import { BACK_LIMIT, activeGraphOf, liveRun, upstreamOf } from "./graph";
import { backUses } from "./scheduler";
import type { TaskService } from "./task-service";
import type { Task } from "./types";

/** What a worktree changed since the commit it began at: files, and lines added and removed. */
export interface WorktreeChanges {
  readonly files: number;
  readonly added: number;
  readonly removed: number;
}

/** What the host worked out about a task's worktree, for the evidence of the reviews. */
export interface ReviewFacts {
  /** The worktree's name, merged state, dirt and commits; `null` when it has none or git could not say. */
  readonly worktree: TaskArchiveFacts | null;
  /** The change since its start; `null` when there is no worktree, no start commit or git could not say. */
  readonly changes: WorktreeChanges | null;
}

/** The longest an agent's or a node's text is kept in the record a verdict leaves in the conversation. */
const RECORD_TEXT_CHARS = 8000;

/**
 * Cuts a text.
 *
 * @remarks
 * A model-written text can be longer than the protocol takes or than a record should keep; cutting is not an error.
 *
 * @sideEffects none
 * @param text - The text.
 * @param limit - The most characters.
 * @returns The text, cut if it was longer.
 */
function clip(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * The facts about the worktree, as the evidence of a review.
 *
 * @remarks
 * Codes and parameters only; the host writes no words. How bad a dirty tree is depends on the question: a
 * human node can still be passed (a merge will then be held back and say so), but a worktree cannot be archived
 * while it is dirty.
 *
 * @sideEffects none
 * @param worktree - What was worked out.
 * @param dirty - How a dirty tree is graded.
 * @param merged - Whether to say if the branch is merged (the archive question does).
 * @returns The facts, none when there is no worktree.
 */
function worktreeFacts(worktree: TaskArchiveFacts | null, dirty: "warn" | "danger", merged: boolean): Fact[] {
  if (worktree === null) return [];
  const { name } = worktree;
  const facts: Fact[] = [];
  if (merged) {
    facts.push(
      worktree.merged === null
        ? { code: "worktree_merge_unknown", params: { name }, status: "warn" }
        : worktree.merged
          ? { code: "worktree_merged", params: { name }, status: "ok" }
          : { code: "worktree_not_merged", params: { name }, status: "warn" },
    );
  }
  facts.push(
    worktree.dirty
      ? { code: "worktree_dirty", params: { name }, status: dirty }
      : { code: "worktree_clean", params: { name }, status: "ok" },
    { code: "commits_ahead", params: { count: worktree.commits }, status: worktree.commits === 0 ? "warn" : "ok" },
  );
  return facts;
}

/**
 * The evidence about the worktree: the facts and the change it made.
 *
 * @remarks
 * What the host measured goes first, before what people wrote, so that a hand-over cannot sit above a dirty tree.
 *
 * @sideEffects none
 * @param task - The task.
 * @param facts - What was worked out.
 * @param dirty - How a dirty tree is graded.
 * @param merged - Whether to say if the branch is merged.
 * @returns The evidence, none when there is nothing to say.
 */
function worktreeEvidence(task: Task, facts: ReviewFacts, dirty: "warn" | "danger", merged: boolean): Evidence[] {
  const said = worktreeFacts(facts.worktree, dirty, merged);
  return [
    ...(said.length === 0 ? [] : [{ kind: "facts", facts: said } as const]),
    ...(facts.changes === null || task.workspaceId === null
      ? []
      : [{ kind: "changes", workspaceId: task.workspaceId, ...facts.changes } as const]),
  ];
}

/**
 * The review for a graph waiting for approval, if there is one (gate `task_graph`).
 *
 * @remarks
 * SPEC-0006, "改图"; only after the task started (while it is designed the graph takes effect at once, and
 * "确认并启动" is the button on the start page). The evidence is the difference against the version in force and
 * what the agent wrote about it (quoted).
 *
 * @sideEffects none
 * @param task - The task.
 * @returns The review, or none.
 */
function graphReview(task: Task): PendingReview[] {
  const pending = task.graphs.find((graph) => graph.version === task.pendingGraph);
  const active = activeGraphOf(task);
  if (pending === undefined || active === undefined || task.startedAt === null || task.endedAt !== null) return [];
  const { from, added, removed, changed } = diffGraphs(active, pending);
  const evidence: Evidence[] = [{ kind: "graph_diff", from, to: pending.version, added, removed, changed }];
  if (pending.note !== "") {
    evidence.push({ kind: "summary", by: { kind: "agent" }, text: clip(pending.note, REVIEW_TEXT_LIMIT) });
  }
  return [
    {
      id: `${task.id}:graph:v${String(pending.version)}`,
      openedAt: pending.createdAt,
      source: { kind: "gate", gate: "task_graph" },
      subject: { code: "task_graph_change", params: { taskId: task.id, version: pending.version } },
      evidence,
      problem: null,
      actions: [
        { id: "approve", reason: "none", targets: [], recommended: true },
        { id: "reject", reason: "optional", targets: [], recommended: false },
      ],
    },
  ];
}

/**
 * The reviews of the human nodes that wait (gate `task_human`).
 *
 * @remarks
 * SPEC-0006, "human 节点" and "合并": a human node that waits for `human`, or for the merge it asked for to
 * succeed (`merge_blocked`), which is the same card with the reason as its `problem` and "retry" in place of
 * "pass". The id holds the node's attempt, so a send-back and a return make a new review. A node voided by a
 * graph change, or whose merge is under way, asks nothing.
 *
 * @sideEffects none
 * @param task - The task.
 * @param facts - What was worked out about the worktree.
 * @returns The reviews, in graph order.
 */
function humanReviews(task: Task, facts: ReviewFacts): PendingReview[] {
  const graph = activeGraphOf(task);
  if (graph === undefined || task.endedAt !== null) return [];
  return graph.nodes.flatMap((node): PendingReview[] => {
    const run = liveRun(task, node.id);
    if (
      node.kind !== "human" ||
      run?.state !== "waiting" ||
      run.merging === true ||
      (run.waitingFor !== "human" && run.waitingFor !== "merge_blocked")
    ) {
      return [];
    }
    const blocked = run.waitingFor === "merge_blocked";
    const backs = graph.edges.filter((edge) => edge.kind === "back" && edge.from === node.id);
    const sendBack: ReviewAction[] =
      backs.length === 0
        ? []
        : [
            {
              id: "send_back",
              reason: "required",
              targets: backs.map((edge) => ({
                id: edge.to,
                remaining: Math.max(0, BACK_LIMIT - backUses(task, node.id, edge.to)),
              })),
              recommended: false,
            },
          ];
    const dirty = facts.worktree?.dirty === true;
    const summaries = upstreamOf(graph, node.id).flatMap((upstream): Evidence[] => {
      const handed = task.runs
        .filter((one) => one.node === upstream && one.summary !== null)
        .toSorted((a, b) => b.attempt - a.attempt)[0]?.summary;
      return handed === undefined || handed === null
        ? []
        : [{ kind: "summary", by: { kind: "node", node: upstream }, text: clip(handed, REVIEW_TEXT_LIMIT) }];
    });
    return [
      {
        id: `${task.id}:human:${node.id}:${String(run.attempt)}`,
        openedAt: run.startedAt,
        source: { kind: "gate", gate: "task_human" },
        subject: { code: "task_human_node", params: { taskId: task.id, node: node.id, merge: node.merge === true } },
        // What the host measured goes first and what people wrote is cut to fit the protocol (T8 review fix 4).
        evidence: [...worktreeEvidence(task, facts, "warn", false), ...summaries].slice(0, REVIEW_EVIDENCE_LIMIT),
        problem: blocked
          ? {
              code: run.blocked ?? "merge_blocked",
              params: {},
              ...(run.blockedFiles === undefined ? {} : { files: run.blockedFiles }),
            }
          : null,
        actions: [{ id: blocked ? "retry" : "pass", reason: "none", targets: [], recommended: !dirty }, ...sendBack],
      },
    ];
  });
}

/**
 * The review of the question about the worktree a finished task made, while it is open (gate `task_archive`).
 *
 * @remarks
 * SPEC-0006, "归档": only `asked`; once it is answered "keep" the question is not a review (it can still be answered
 * with `answer_archive`). The host recommends archiving only a worktree that is merged and clean, so one that is
 * not merged is kept by default.
 *
 * @sideEffects none
 * @param task - The task.
 * @param facts - What was worked out about the worktree.
 * @returns The review, or none.
 */
function archiveReview(task: Task, facts: ReviewFacts): PendingReview[] {
  if (task.archive !== "asked" || task.endedAt === null) return [];
  const safe = facts.worktree?.merged === true && !facts.worktree.dirty;
  return [
    {
      id: `${task.id}:archive`,
      openedAt: task.endedAt,
      source: { kind: "gate", gate: "task_archive" },
      subject: { code: "task_archive", params: { taskId: task.id } },
      evidence: worktreeEvidence(task, facts, "danger", true),
      problem: null,
      actions: [
        { id: "archive", reason: "none", targets: [], recommended: safe },
        { id: "keep", reason: "none", targets: [], recommended: !safe },
      ],
    },
  ];
}

/**
 * Whether working out the reviews of a task needs the worktree's facts (git).
 *
 * @remarks
 * Git is run only when a card will show what it finds, so a task that waits for nothing costs none.
 *
 * @sideEffects none
 * @param task - The task.
 * @returns Whether a human node waits or the archive question is open.
 */
export function needsWorktreeFacts(task: Task): boolean {
  return task.archive === "asked" || humanReviews(task, { worktree: null, changes: null }).length > 0;
}

/**
 * What waits for the user's verdict in a task (ADR-0018; SPEC-0006, "T8a 定下的细节").
 *
 * @remarks
 * Worked out from the task's durable state every time and kept nowhere, so it is the same after a host restart.
 * Oldest first, and at most `REVIEWS_LIMIT` of them, which is all the protocol takes (T8 review fix 4). A task that has
 * ended or has no graph yet asks nothing but the archive question.
 *
 * @sideEffects none
 * @param task - The task.
 * @param facts - What the host worked out about the worktree, for the evidence.
 * @returns The reviews.
 */
export function reviewsOf(task: Task, facts: ReviewFacts): PendingReview[] {
  return [...graphReview(task), ...humanReviews(task, facts), ...archiveReview(task, facts)]
    .toSorted((a, b) => a.openedAt - b.openedAt)
    .slice(0, REVIEWS_LIMIT);
}

/**
 * The words the model reads when a review has been decided.
 *
 * @remarks
 * Codes and parameters in English, as the progress lines are; what the user wrote as the reason is theirs and
 * follows as it is, cut.
 *
 * @sideEffects none
 * @param record - What was decided.
 * @returns A line.
 */
export function recordText(record: ReviewRecord): string {
  const subject =
    "code" in record.subject
      ? `${record.subject.code}${Object.entries(record.subject.params)
          .map(([key, value]) => ` ${key}=${String(value)}`)
          .join("")}`
      : "request";
  const { action, target, reason } = record.verdict;
  return [
    `Atrium review: the user decided ${subject}: ${action}${target === undefined ? "" : ` ${target}`}.`,
    ...(reason === undefined ? [] : [`The user's reason: ${clip(reason, 4000)}`]),
  ].join(" ");
}

/**
 * The record a verdict leaves in the conversation: the review as it was, with the verdict.
 *
 * @remarks
 * The evidence is a snapshot; texts others wrote in it are cut so the session file does not grow by a node's
 * whole hand-over every time.
 *
 * @sideEffects none
 * @param review - The review that was decided.
 * @param verdict - The verdict.
 * @returns The record.
 */
export function recordOf(review: PendingReview, verdict: Verdict): ReviewRecord {
  return {
    source: review.source,
    subject: review.subject,
    evidence: review.evidence.map((one) =>
      one.kind === "summary" ? { ...one, text: clip(one.text, RECORD_TEXT_CHARS) } : one,
    ),
    verdict,
  };
}

/** What the task gates need from the rest of the host. */
export interface TaskReviewPorts {
  readonly service: Pick<
    TaskService,
    "view" | "held" | "approveGraph" | "rejectGraph" | "answerHuman" | "answerArchive" | "onEvent" | "recordReview"
  >;
  /** The task a session is the conversation of, if it is one (a task already held, else the session's record). */
  readonly taskOf: (sessionId: string) => string | undefined;
}

/**
 * Creates the provider of the task gates (ADR-0018, decision 2).
 *
 * @remarks
 * What waits comes from `TaskService.view`, which works the reviews out of the task's durable state and the
 * worktree; the provider only finds the task of a session. A verdict is carried out through the same business
 * commands the task list and `pnpm task:try` call (`approve_graph`, `reject_graph`, `answer_human`,
 * `answer_archive`), so both entry points run the same state checks. Once the review is gone, the host writes the
 * record into the task conversation.
 *
 * @sideEffects none until used; then reads and changes tasks through the service.
 * @param ports - The task service and how to find a session's task.
 * @returns The provider.
 */
export function createTaskReviewProvider(ports: TaskReviewPorts): ReviewProvider {
  const { service } = ports;

  /**
   * What waits in a task conversation now.
   *
   * @remarks
   * Through the service's `view`, so the board and the card never disagree about what waits.
   *
   * @sideEffects May run git.
   * @param sessionId - The session.
   * @param signal - Stops it.
   * @returns The task's id and its reviews; none for a session that is no task's conversation.
   */
  async function look(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<{ readonly taskId: string; readonly reviews: readonly PendingReview[] } | undefined> {
    const taskId = ports.taskOf(sessionId);
    if (taskId === undefined) return undefined;
    return { taskId, reviews: (await service.view(taskId, signal)).reviews };
  }

  return {
    async pending(sessionId, signal) {
      return (await look(sessionId, signal).catch(swallowMissing))?.reviews ?? [];
    },
    async decide(sessionId, review, verdict, signal) {
      const taskId = ports.taskOf(sessionId);
      if (taskId === undefined || review.source.kind !== "gate")
        throw new CommandError("review_closed", { reviewId: review.id });
      const gate = review.source.gate;
      if (gate === "task_graph") {
        // Only the version the user saw: the agent may have proposed another since the card was made.
        const version = "params" in review.subject ? review.subject.params["version"] : undefined;
        if (typeof version !== "number") throw new CommandError("review_closed", { reviewId: review.id });
        const reviewed = { version, reviewId: review.id };
        if (verdict.action === "approve") await service.approveGraph(taskId, reviewed);
        else await service.rejectGraph(taskId, reviewed);
      } else if (gate === "task_human") {
        const node = "params" in review.subject ? review.subject.params["node"] : undefined;
        if (typeof node !== "string") throw new CommandError("review_closed", { reviewId: review.id });
        await service.answerHuman(
          taskId,
          node,
          verdict.action === "send_back"
            ? { kind: "send_back", backTo: verdict.target ?? "", reason: verdict.reason ?? "" }
            : { kind: "pass" },
        );
      } else {
        await service.answerArchive(taskId, verdict.action === "archive" ? "archive" : "keep");
      }
      // A node still `merging` asks nothing either, but nothing was decided yet: the host is closing under its merge
      // and the restart goes on with it. Only the merge that ends writes the record (T8 review fix 12).
      const node = "params" in review.subject ? review.subject.params["node"] : undefined;
      const held = service.held().find((task) => task.id === taskId);
      if (
        gate === "task_human" &&
        typeof node === "string" &&
        held !== undefined &&
        liveRun(held, node)?.merging === true
      ) {
        return;
      }
      // The review is done when it is no longer there; a merge held back again is the same review with its problem.
      const after = await look(sessionId, signal).catch(() => undefined);
      if (after !== undefined && !after.reviews.some((one) => one.id === review.id)) {
        const record = recordOf(review, verdict);
        service.recordReview(taskId, { id: `review:${review.id}`, text: recordText(record), record });
      }
    },
    subscribe(changed) {
      return service.onEvent((task) => changed(task.taskSessionId));
    },
  };
}

/**
 * Turns a task that is not there into no reviews.
 *
 * @remarks
 * A session's task can be abandoned while its reviews are counted.
 *
 * @sideEffects none
 * @param error - What went wrong.
 * @returns Nothing, for `task_not_found`.
 * @throws The error, for anything else.
 */
function swallowMissing(error: unknown): undefined {
  if (error instanceof CommandError && error.code === "task_not_found") return undefined;
  throw error;
}
