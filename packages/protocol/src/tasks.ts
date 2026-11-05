import { z } from "zod";
import { ProjectId, WorkspaceId } from "./ids";

// Tasks and task graphs (SPEC-0006, "协议（给 UI）"; T5). The host sends what the board shows: the graph, the
// state of each node, why a node waits, and the question about archiving. The words are the UI's.

/** Milliseconds since the Unix epoch, from the host's clock. */
const Timestamp = z.number().int().nonnegative();

/** A task's id: `tsk_` and a name (SPEC-0006, "数据"). */
export const TaskId = z.string().regex(/^tsk_[0-9A-Za-z_-]{1,64}$/);
export type TaskId = z.infer<typeof TaskId>;

/** A node's id within a task: `N1`, `N2`…; the same node keeps it across graph versions. */
export const TaskNodeId = z.string().min(1).max(64);
export type TaskNodeId = z.infer<typeof TaskNodeId>;

/** The longest text of a node's job, done line or summary the host sends; longer is cut. */
export const TASK_TEXT_LIMIT = 100_000;

/** How many times a send-back may use the same back edge (SPEC-0006, "打回"). */
export const TASK_BACK_LIMIT = 2;

/** The most conflicting files a blocked merge names. */
export const TASK_CONFLICT_FILES_LIMIT = 50;

/** A task's state, derived from its nodes (SPEC-0006, "任务"). */
export const TaskStatus = z.enum(["designing", "waiting", "running", "stopped", "done", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** A node's state (SPEC-0006, "节点"). */
export const TaskNodeState = z.enum(["pending", "running", "waiting", "held", "stopped", "passed", "failed"]);
export type TaskNodeState = z.infer<typeof TaskNodeState>;

/** What a waiting node waits for. */
export const TaskWaitingFor = z.enum(["question", "graph_change", "human", "merge_blocked"]);
export type TaskWaitingFor = z.infer<typeof TaskWaitingFor>;

/** Why a node failed (SPEC-0006, "失败"). */
export const TaskFailureReason = z.enum(["no_done", "crashed", "model_error", "gave_up", "workspace", "commit"]);
export type TaskFailureReason = z.infer<typeof TaskFailureReason>;

/** Why a merge was held back; not a command's error but a node's `blocked` (SPEC-0006, "错误码"). */
export const TaskMergeBlockReason = z.enum([
  "merge_worktree_dirty",
  "merge_main_dirty",
  "merge_main_not_trunk",
  "merge_conflict",
  "merge_abort_failed",
  "merge_git_failed",
]);
export type TaskMergeBlockReason = z.infer<typeof TaskMergeBlockReason>;

/** Where the question about archiving the task's worktree stands (SPEC-0006, "归档"). */
export const TaskArchiveState = z.enum(["asked", "archived", "kept"]);
export type TaskArchiveState = z.infer<typeof TaskArchiveState>;

/** What the user is wanted for, most urgent first; `null` when for nothing. */
export const TaskAttention = z.enum(["failed", "merge_blocked", "human", "question", "graph_change"]);
export type TaskAttention = z.infer<typeof TaskAttention>;

/**
 * The facts the archive question shows (SPEC-0006, "归档").
 *
 * @remarks
 * Worked out when the task is looked at, not kept: the worktree's name, whether its branch is merged
 * (`null` when git cannot tell), whether it has changes that are not committed, and how many commits it has
 * past where it began.
 */
export const TaskArchiveFacts = z.strictObject({
  name: z.string().max(512),
  merged: z.boolean().nullable(),
  dirty: z.boolean(),
  commits: z.number().int().nonnegative(),
});
export type TaskArchiveFacts = z.infer<typeof TaskArchiveFacts>;

/** One row of the task list. */
export const TaskSummary = z.strictObject({
  id: TaskId,
  name: z.string().max(512),
  status: TaskStatus,
  projectId: ProjectId.nullable(),
  workspaceId: WorkspaceId.nullable(),
  paused: z.boolean(),
  createdAt: Timestamp,
  startedAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
  attention: TaskAttention.nullable(),
  /** The question about the worktree the task made; `null` when there is none. */
  archive: TaskArchiveState.nullable(),
});
export type TaskSummary = z.infer<typeof TaskSummary>;

/** A human node's back edge and how many times it has been used. */
export const TaskBackEdge = z.strictObject({ to: TaskNodeId, uses: z.number().int().nonnegative() });
export type TaskBackEdge = z.infer<typeof TaskBackEdge>;

/** One node of a task's graph, with the state of its latest run. */
export const TaskNode = z.strictObject({
  id: TaskNodeId,
  name: z.string().max(512),
  kind: z.enum(["agent", "human"]),
  /** What it does. */
  job: z.string().max(TASK_TEXT_LIMIT),
  /** What counts as done, one entry per criterion. */
  done: z.array(z.string().max(TASK_TEXT_LIMIT)).max(100),
  role: z.enum(["explore", "work", "check", "advise"]).optional(),
  place: z.enum(["workspace", "readonly"]).optional(),
  /** On a human node: "pass" merges the task's branch. */
  merge: z.literal(true).optional(),
  state: TaskNodeState,
  /** Which try this is; only a send-back adds one. */
  attempt: z.number().int().min(0),
  waitingFor: TaskWaitingFor.nullable(),
  /** Why the merge did not happen, while `waitingFor` is `merge_blocked`. */
  blocked: TaskMergeBlockReason.nullable(),
  /** The files of a `merge_conflict`. */
  blockedFiles: z.array(z.string().max(4096)).max(TASK_CONFLICT_FILES_LIMIT).optional(),
  failure: TaskFailureReason.nullable(),
  /** The hand-over summary of the latest run that gave one. */
  summary: z.string().max(TASK_TEXT_LIMIT).nullable(),
  /** The node's conversation; `null` for a human node and for a node that has not begun. */
  sessionId: z.string().min(1).max(128).nullable(),
  /** Why the node was sent back and from where, when its latest run was. */
  backFrom: z.strictObject({ node: TaskNodeId, reason: z.string().max(TASK_TEXT_LIMIT) }).optional(),
  /** On a human node: each back edge it has and how many times it was used (the limit is `TASK_BACK_LIMIT`). */
  sendBack: z.array(TaskBackEdge).max(20),
});
export type TaskNode = z.infer<typeof TaskNode>;

/** An edge of the graph; a `back` edge runs from a human node to one of its ancestors. */
export const TaskEdge = z.strictObject({ from: TaskNodeId, to: TaskNodeId, kind: z.enum(["seq", "back"]) });
export type TaskEdge = z.infer<typeof TaskEdge>;

/** A task as the board shows it: the summary, the graph in force and the nodes' states. */
export const TaskView = TaskSummary.extend({
  /** The task conversation's session. */
  taskSessionId: z.string().min(1).max(128),
  graphVersion: z.number().int().nonnegative(),
  /** A new graph is waiting for the user's approval. */
  pendingGraph: z.boolean(),
  nodes: z.array(TaskNode).max(20),
  edges: z.array(TaskEdge).max(400),
  /** What the archive question shows, while it is open; `null` otherwise. */
  archiveFacts: TaskArchiveFacts.nullable(),
});
export type TaskView = z.infer<typeof TaskView>;

/**
 * The task list changed; sent whole to the connections that watch it (`list_tasks({ watch: true })`).
 *
 * @remarks
 * `seq` counts the host's sends, so a client drops one older than what it has (SPEC-0006, "协议（给 UI）";
 * the list is whole each time, not a delta, while there are few tasks).
 */
export const TasksUpdatedEvent = z.strictObject({
  type: z.literal("tasks_updated"),
  seq: z.number().int().nonnegative(),
  tasks: z.array(TaskSummary).max(10_000),
});
export type TasksUpdatedEvent = z.infer<typeof TasksUpdatedEvent>;

/** A task changed; sent whole to the connection that opened it (`open_task`). */
export const TaskUpdatedEvent = z.strictObject({ type: z.literal("task_updated"), task: TaskView });
export type TaskUpdatedEvent = z.infer<typeof TaskUpdatedEvent>;

/** What the user answers a human node: pass it, or send the task back to a node with a reason. */
export const HumanAnswer = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pass") }),
  z.strictObject({
    kind: z.literal("send_back"),
    backTo: TaskNodeId,
    reason: z.string().min(1).max(TASK_TEXT_LIMIT),
  }),
]);
export type HumanAnswer = z.infer<typeof HumanAnswer>;

/** What the user decides about the worktree the task made. */
export const ArchiveAnswer = z.enum(["archive", "keep"]);
export type ArchiveAnswer = z.infer<typeof ArchiveAnswer>;
