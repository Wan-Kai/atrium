import { Cadence, SchedulePlace, ThinkingLevel } from "@atrium/protocol";
import { z } from "zod";

/*
 * The data of a task (SPEC-0006, "接口与数据 · 数据"; domain-model §9).
 *
 * The schemas are the source of the types: `task.json` and every line of `events.jsonl` are read
 * back from disk, so they are checked at that boundary (coding-standards.md, "类型").
 */

/** A task's id, `tsk_…`. */
const TaskId = z.string().min(1);
type TaskId = z.infer<typeof TaskId>;

/** A node's id, `N1`, `N2`…; the same node keeps it across graph versions. */
export const NodeId = z.string().min(1);
export type NodeId = z.infer<typeof NodeId>;

/** A model with its thinking level, as a task or a node names it. */
const ModelChoice = z.strictObject({ providerId: z.string().min(1), modelId: z.string().min(1) });

/** The task's model. */
const TaskModel = ModelChoice.extend({ thinking: ThinkingLevel });
type TaskModel = z.infer<typeof TaskModel>;

/** A node's own model; the level is optional. */
const NodeModel = ModelChoice.extend({ thinking: ThinkingLevel.optional() });
type NodeModel = z.infer<typeof NodeModel>;

/**
 * The requirement summary the task conversation writes.
 *
 * @remarks
 * SPEC-0006 lists its six parts in words only; the field names are this module's.
 */
const RequirementSummary = z.strictObject({
  goal: z.string(),
  decisions: z.array(z.string()),
  constraints: z.array(z.string()),
  nonGoals: z.array(z.string()),
  openQuestions: z.array(z.string()),
  acceptance: z.array(z.string()),
});
type RequirementSummary = z.infer<typeof RequirementSummary>;

/** What a node does for the task. */
export const NodeRole = z.enum(["explore", "work", "check", "advise"]);
export type NodeRole = z.infer<typeof NodeRole>;

/** Where an agent node works. */
export const NodePlace = z.enum(["workspace", "readonly"]);
export type NodePlace = z.infer<typeof NodePlace>;

/** One node of the graph. */
export const GraphNode = z.strictObject({
  id: NodeId,
  name: z.string(),
  kind: z.enum(["agent", "human"]),
  /** What it does. */
  job: z.string(),
  /** What counts as done, one entry per criterion. */
  done: z.array(z.string()),
  role: NodeRole.optional(),
  model: NodeModel.optional(),
  place: NodePlace.optional(),
  inputs: z.array(NodeId).optional(),
  /** On a human node without sequential out-edges: "pass" merges the task's branch. */
  merge: z.literal(true).optional(),
});
export type GraphNode = z.infer<typeof GraphNode>;

/** An edge; `back` runs from a human node to one of its ancestors. */
export const GraphEdge = z.strictObject({ from: NodeId, to: NodeId, kind: z.enum(["seq", "back"]) });
export type GraphEdge = z.infer<typeof GraphEdge>;

/** One version of the graph; versions are only ever added. */
export const GraphVersion = z.strictObject({
  version: z.number().int().min(1),
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
  author: z.enum(["agent", "user"]),
  note: z.string(),
  createdAt: z.number(),
  approvedAt: z.number().nullable(),
});
export type GraphVersion = z.infer<typeof GraphVersion>;

/** The states a node can be in; derived from its latest run. */
export const NodeState = z.enum(["pending", "running", "waiting", "held", "stopped", "passed", "failed"]);
export type NodeState = z.infer<typeof NodeState>;

/** What a waiting node waits for. */
const WaitingFor = z.enum(["question", "graph_change", "human", "merge_blocked"]);
type WaitingFor = z.infer<typeof WaitingFor>;

/**
 * Why a merge was held back (SPEC-0006, "合并").
 *
 * @remarks
 * `merge_git_failed` is T5's (SPEC-0006, "T5 定下的细节"): git could not answer, or the checkout is not
 * the one the host expects; nothing was merged and nothing was left changed.
 */
export const MergeBlockReason = z.enum([
  "merge_worktree_dirty",
  "merge_main_dirty",
  "merge_main_not_trunk",
  "merge_conflict",
  "merge_abort_failed",
  "merge_git_failed",
]);
export type MergeBlockReason = z.infer<typeof MergeBlockReason>;

/** The five ways a node fails (SPEC-0006, "失败"). */
export const FailureReason = z.enum(["no_done", "crashed", "model_error", "gave_up", "workspace", "commit"]);
export type FailureReason = z.infer<typeof FailureReason>;

/** The `node_done` call waiting for the turn to end. */
const PendingDone = z.strictObject({
  ok: z.boolean(),
  summary: z.string().optional(),
  reason: z.string().optional(),
});
type PendingDone = z.infer<typeof PendingDone>;

/**
 * What a node wrote when it asked for the graph to change (`request_graph_change`).
 *
 * @remarks
 * The limits are the channel's own (`TASK_TEXT_LIMITS`); the wake-up of the task conversation quotes it.
 */
const GraphRequest = z.strictObject({ reason: z.string(), suggestion: z.string() });

/** One run of one node. */
export const NodeRun = z.strictObject({
  node: NodeId,
  /** Which try this is: only a send-back adds one; a rerun keeps it. */
  attempt: z.number().int().min(1),
  /** The graph version it began under. */
  graph: z.number().int().min(1),
  state: NodeState,
  waitingFor: WaitingFor.nullable(),
  blocked: MergeBlockReason.nullable(),
  /** Null for a human node and for a run that never got a session. */
  sessionId: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  /** The worktree's HEAD when the node began, to tell whether it changed anything. */
  startCommit: z.string().nullable(),
  pendingDone: PendingDone.nullable(),
  /** The hand-over summary. */
  summary: z.string().nullable(),
  failure: FailureReason.nullable(),
  /** The commit made when it ended, for a writing node that changed something. */
  commit: z.string().nullable(),
  backFrom: z.strictObject({ node: NodeId, reason: z.string() }).optional(),
  /** Voided by a graph change (a human node that gained an unfinished upstream). */
  void: z.literal(true).optional(),
  merging: z.literal(true).optional(),
  /** The files a `merge_conflict` named, for the user to see (at most `MAX_CONFLICT_FILES`). */
  blockedFiles: z.array(z.string()).optional(),
  /** Whether it was already reminded once to call `node_done`. */
  nudged: z.boolean(),
  /**
   * A writing node's `node_done` took effect and its commit is not settled yet: the node stays `running` until
   * `committed` or `commit_checked` passes it (SPEC-0006, "动作要幂等"). Stays set on a node failed with `commit`.
   */
  commitPending: z.literal(true).optional(),
  /** The contract (or, after it, anything) was handed to the node's pi: the first message is not lost. */
  contractSent: z.literal(true).optional(),
  /**
   * The reason and suggestion of the graph change a `waiting(graph_change)` node asked for; gone when the wait ends.
   * Kept on the run, not in memory, so the task conversation woken after a host restart reads them (SPEC-0006, "T9 定下的细节").
   */
  graphRequest: GraphRequest.optional(),
});
export type NodeRun = z.infer<typeof NodeRun>;

/** Where the task came from. */
const TaskOrigin = z.union([
  z.strictObject({ kind: z.literal("chat"), sessionId: z.string() }),
  z.strictObject({ kind: z.literal("schedule"), ruleId: z.string(), firedAt: z.number() }),
]);
type TaskOrigin = z.infer<typeof TaskOrigin>;

/** Where the question about archiving the task's worktree stands. */
const ArchiveState = z.enum(["asked", "archived", "kept"]);
type ArchiveState = z.infer<typeof ArchiveState>;

/** The task record (`task.json`, SPEC-0006 "任务记录"). */
export const Task = z.strictObject({
  id: TaskId,
  name: z.string(),
  projectId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  workspaceState: z.enum(["none", "creating", "ready"]),
  sourceDir: z.string(),
  ownsWorkspace: z.boolean(),
  baseCommit: z.string().nullable(),
  model: TaskModel,
  guide: z.strictObject({ id: z.string(), version: z.number().int() }),
  summary: RequirementSummary,
  origin: TaskOrigin,
  scheduleDraft: z.strictObject({ when: Cadence, place: SchedulePlace }).nullable(),
  taskSessionId: z.string(),
  graphs: z.array(GraphVersion),
  /** The version in force; 0 while no graph has been proposed. */
  activeGraph: z.number().int().min(0),
  pendingGraph: z.number().int().min(1).nullable(),
  runs: z.array(NodeRun),
  paused: z.boolean(),
  cancelled: z.boolean(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  /**
   * The question of what to do with the worktree the task made (SPEC-0006, "归档"; T5): `asked` from the
   * moment the task ends, then what the user answered. Absent for a task that asks nothing.
   */
  archive: ArchiveState.optional(),
});
export type Task = z.infer<typeof Task>;

/** The task's state, derived from its nodes (SPEC-0006, "任务"). */
export type TaskStatus = "designing" | "waiting" | "running" | "stopped" | "done" | "cancelled";

/*
 * Events (`events.jsonl`): `{ seq, at, type, ...payload }` (SPEC-0006, "事件").
 */

/**
 * Builds the schema of one event type.
 *
 * @remarks
 * Every event carries `seq` and `at`; the payload is what differs.
 *
 * @sideEffects none
 * @param type - The event's type.
 * @param payload - The fields beside `seq`, `at` and `type`.
 * @returns The schema.
 */
function event<T extends string, S extends z.ZodRawShape>(type: T, payload: S) {
  return z.strictObject({ seq: z.number().int().min(1), at: z.number(), type: z.literal(type), ...payload });
}

/** The fields that name one run of a node. */
const run = { node: NodeId, attempt: z.number().int().min(1) };

/**
 * One line of `events.jsonl`.
 *
 * @remarks
 * SPEC-0006 lists the types by name only; the payloads are this module's. Events of a node's session
 * carry the `attempt` they are about, so a late event from a run that a send-back replaced is
 * recognised and dropped.
 */
export const TaskEvent = z.discriminatedUnion("type", [
  event("created", { task: Task }),
  event("graph_proposed", {
    author: z.enum(["agent", "user"]),
    note: z.string(),
    nodes: z.array(GraphNode),
    edges: z.array(GraphEdge),
    /** The guide the graph follows (T6); taken while the task is being designed, ignored after it started. */
    guide: z.strictObject({ id: z.string().min(1), version: z.number().int().min(1) }).optional(),
  }),
  /** The requirement summary was written (T6); taken only while the task is being designed. */
  event("summary_set", { summary: RequirementSummary }),
  event("graph_approved", {}),
  event("graph_rejected", {}),
  event("started", {}),
  event("abandoned", {}),
  event("meta_changed", { name: z.string().optional(), model: TaskModel.optional() }),
  /** The task conversation made the task a schedule rule's template, or changed its cadence or place (T10); only while designing. */
  event("schedule_set", { when: Cadence, place: SchedulePlace }),
  event("node_started", { ...run, sessionId: z.string(), startCommit: z.string().nullable() }),
  event("node_waiting", {
    ...run,
    waitingFor: z.enum(["question", "graph_change"]),
    /** What the node wrote, for a graph change (T9); a question has none. */
    request: GraphRequest.optional(),
  }),
  event("node_resumed", run),
  event("node_done_pending", {
    ...run,
    ok: z.boolean(),
    summary: z.string().optional(),
    reason: z.string().optional(),
  }),
  event("node_done_void", run),
  event("node_settled", run),
  event("node_failed", { ...run, reason: FailureReason }),
  event("node_stopped", run),
  event("node_held", run),
  event("human_passed", { node: NodeId }),
  event("human_sent_back", { node: NodeId, to: NodeId, reason: z.string() }),
  event("rerun_requested", { node: NodeId }),
  event("paused", {}),
  event("resumed", {}),
  event("cancelled", {}),
  event("workspace_creating", {}),
  event("workspace_created", { workspaceId: z.string(), baseCommit: z.string() }),
  event("workspace_failed", {}),
  event("committed", { ...run, commit: z.string() }),
  event("commit_checked", run),
  event("commit_failed", run),
  event("contract_sent", run),
  event("merge_started", { node: NodeId }),
  event("merged", { node: NodeId }),
  event("merge_blocked", { node: NodeId, reason: MergeBlockReason, files: z.array(z.string()).optional() }),
  event("archive_asked", {}),
  event("archive_answered", { answer: z.enum(["archive", "keep"]) }),
  event("host_restarted", {}),
]);
export type TaskEvent = z.infer<typeof TaskEvent>;

/** The distributive `Omit`, so that an event minus its `seq` and `at` is still a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before the store gives it its `seq` and `at`. */
export type TaskEventInput = DistributiveOmit<TaskEvent, "seq" | "at">;

/*
 * Actions: what the scheduler asks the runner to do (SPEC-0006, "调度器").
 */

/** A short line for the task conversation; the host sends the kind and ids, the UI writes the words. */
export interface ProgressLine {
  /** Unique per event and position, so a replayed event cannot write the same line twice. */
  readonly id: string;
  readonly kind: "node_started" | "node_passed" | "node_failed" | "node_waiting" | "workspace_ready" | "merged";
  readonly node?: NodeId;
}

/** Why the user is wanted. */
export type Attention =
  | { readonly kind: "question"; readonly node: NodeId }
  | { readonly kind: "graph_approval" }
  | { readonly kind: "human"; readonly node: NodeId }
  | { readonly kind: "merge_blocked"; readonly node: NodeId; readonly reason: MergeBlockReason }
  | { readonly kind: "failed"; readonly node: NodeId; readonly reason: FailureReason };

/** What the runner has to do after a step. */
export type Action =
  | { readonly kind: "ensure_workspace" }
  | { readonly kind: "start_node"; readonly node: NodeId; readonly attempt: number }
  | { readonly kind: "resume_node"; readonly node: NodeId; readonly text: string }
  | { readonly kind: "stop_node"; readonly node: NodeId; readonly when: "now" | "after_turn" }
  | { readonly kind: "nudge_node"; readonly node: NodeId }
  | { readonly kind: "progress_line"; readonly line: ProgressLine }
  | { readonly kind: "wake_task_conversation"; readonly text: string }
  | { readonly kind: "lock_workspace" }
  | { readonly kind: "unlock_workspace" }
  | { readonly kind: "commit_node"; readonly node: NodeId; readonly attempt: number }
  | { readonly kind: "merge"; readonly node: NodeId }
  | { readonly kind: "ask_archive" }
  | { readonly kind: "notify"; readonly attention: Attention };

/** The result of one step. */
export interface StepResult {
  readonly task: Task;
  readonly actions: readonly Action[];
}
