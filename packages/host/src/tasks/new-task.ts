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
 * first node that needs it is ready, and belongs to the task. T6 makes tasks from `/task`; until then
 * `task:try` and the host's tests make them here.
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
    guide: { id: "default", version: 1 },
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
