import { UNCHOSEN_GUIDE } from "./guides";
import type { GraphEdge, GraphNode, Task } from "./types";

/** What a new task record is made from. */
export interface NewTaskInput {
  readonly id: string;
  readonly name: string;
  /** The project the task belongs to; `null` for none. */
  readonly projectId: string | null;
  /** The directory the task was started from. */
  readonly sourceDir: string;
  /** The session the task was made from. */
  readonly originSessionId: string;
  /** The task conversation's session. */
  readonly taskSessionId: string;
  readonly model: Task["model"];
  readonly goal: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly now: number;
}

/**
 * A new task, with its first graph in force and not yet approved.
 *
 * @remarks
 * SPEC-0006, "任务记录": starting it (the `started` event) approves the graph. The worktree is made when the
 * first node that needs it is ready, and belongs to the task. `task:try` and the host's tests make tasks here;
 * `/task` makes them with `newDesignTask`.
 *
 * @sideEffects none
 * @param input - The task's parts.
 * @returns The task.
 */
export function newTaskRecord(input: NewTaskInput): Task {
  return {
    id: input.id,
    name: input.name,
    projectId: input.projectId,
    workspaceId: null,
    workspaceState: "none",
    sourceDir: input.sourceDir,
    ownsWorkspace: true,
    baseCommit: null,
    model: input.model,
    guide: { ...UNCHOSEN_GUIDE },
    summary: { goal: input.goal, decisions: [], constraints: [], nonGoals: [], openQuestions: [], acceptance: [] },
    origin: { kind: "chat", sessionId: input.originSessionId },
    scheduleDraft: null,
    taskSessionId: input.taskSessionId,
    graphs: [
      {
        version: 1,
        nodes: [...input.nodes],
        edges: [...input.edges],
        author: "agent",
        note: "",
        createdAt: input.now,
        approvedAt: null,
      },
    ],
    activeGraph: 1,
    pendingGraph: null,
    runs: [],
    paused: false,
    cancelled: false,
    createdAt: input.now,
    startedAt: null,
    endedAt: null,
  };
}

/** What a task made from `/task` is built from. */
export interface DesignTaskInput {
  readonly id: string;
  /** The first name: the source conversation's, until the task conversation names the task. */
  readonly name: string;
  /** The project the source conversation is in; `null` for none. */
  readonly projectId: string | null;
  /** The directory the source conversation runs in. */
  readonly sourceDir: string;
  /** The conversation the task is made from. */
  readonly originSessionId: string;
  /** The task conversation's session. */
  readonly taskSessionId: string;
  /** The source conversation's current model. */
  readonly model: Task["model"];
  /** The worktree the source conversation is in, if it is in one the task did not make. */
  readonly borrowed: { readonly workspaceId: string; readonly baseCommit: string | null } | null;
  readonly now: number;
}

/**
 * A new task made from a conversation: designing, with no graph yet.
 *
 * @remarks
 * SPEC-0006, "/task 与创建": the task conversation writes the summary and proposes the graph, so both start
 * empty and no guide is chosen (`activeGraph` is 0). A source conversation in a worktree lends it: the task
 * records the workspace as ready and does not own it, so it is neither made nor archived by the task; one in
 * the project's own directory makes a worktree when the first node needs it.
 *
 * @sideEffects none
 * @param input - The task's parts.
 * @returns The task.
 */
export function newDesignTask(input: DesignTaskInput): Task {
  const base = newTaskRecord({
    id: input.id,
    name: input.name,
    projectId: input.projectId,
    sourceDir: input.sourceDir,
    originSessionId: input.originSessionId,
    taskSessionId: input.taskSessionId,
    model: input.model,
    goal: "",
    nodes: [],
    edges: [],
    now: input.now,
  });
  return {
    ...base,
    guide: { ...UNCHOSEN_GUIDE },
    graphs: [],
    activeGraph: 0,
    ...(input.borrowed === null
      ? {}
      : {
          workspaceId: input.borrowed.workspaceId,
          workspaceState: "ready" as const,
          ownsWorkspace: false,
          baseCommit: input.borrowed.baseCommit,
        }),
  };
}

/** What a task a schedule rule made is built from. */
export interface ScheduledTaskInput {
  readonly id: string;
  /** "规则名 · 日期". */
  readonly name: string;
  readonly projectId: string;
  readonly sourceDir: string;
  /** The rule that made it, and the time it should have fired. */
  readonly ruleId: string;
  readonly firedAt: number;
  /** The task's own conversation. */
  readonly taskSessionId: string;
  readonly model: Task["model"];
  readonly summary: Task["summary"];
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly now: number;
}

/**
 * A new task a schedule rule makes: the rule's summary and graph, with no designing.
 *
 * @remarks
 * SPEC-0006, "定时": `origin.kind` is `schedule`, and the graph is in force from the start (the `started` event
 * approves it). No source conversation. The worktree, if a node needs one, is made when that node is ready, as for any
 * task; a read-only rule's graph has no such node.
 *
 * @sideEffects none
 * @param input - The task's parts.
 * @returns The task.
 */
export function newScheduledTask(input: ScheduledTaskInput): Task {
  const base = newTaskRecord({
    id: input.id,
    name: input.name,
    projectId: input.projectId,
    sourceDir: input.sourceDir,
    originSessionId: "",
    taskSessionId: input.taskSessionId,
    model: input.model,
    goal: "",
    nodes: input.nodes,
    edges: input.edges,
    now: input.now,
  });
  return {
    ...base,
    summary: input.summary,
    origin: { kind: "schedule", ruleId: input.ruleId, firedAt: input.firedAt },
  };
}
