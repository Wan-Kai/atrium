import { step } from "./scheduler";
import { deriveStatus } from "./status";
import { latestRun, runAt, stateOf } from "./graph";
import type {
  Action,
  GraphEdge,
  GraphNode,
  NodeRole,
  NodeRun,
  NodeState,
  Task,
  TaskEvent,
  TaskEventInput,
  TaskStatus,
} from "./types";

/**
 * An agent node for a test.
 *
 * @remarks
 * Names, jobs and done lines are fixed from the id so assertions can write them out.
 *
 * @sideEffects none
 * @param id - The node id.
 * @param role - Its role; `explore` unless told otherwise.
 * @param extra - Fields to set or override.
 * @returns The node.
 */
export function agent(id: string, role: NodeRole = "explore", extra: Partial<GraphNode> = {}): GraphNode {
  return { id, name: `node ${id}`, kind: "agent", job: `do ${id}`, done: [`${id} done`], role, ...extra };
}

/**
 * A human node for a test.
 *
 * @remarks
 * Same fixed naming as `agent`.
 *
 * @sideEffects none
 * @param id - The node id.
 * @param extra - Fields to set, such as `merge`.
 * @returns The node.
 */
export function human(id: string, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, name: `node ${id}`, kind: "human", job: `check ${id}`, done: [`${id} ok`], ...extra };
}

/**
 * Edges from `["N1", "N2"]` pairs; a third item `"back"` makes a back edge.
 *
 * @remarks
 * Keeps graph literals in tests short.
 *
 * @sideEffects none
 * @param pairs - The edges as tuples.
 * @returns The edges.
 */
export function edges(
  ...pairs: readonly (readonly [string, string] | readonly [string, string, "back"])[]
): GraphEdge[] {
  return pairs.map(([from, to, kind]) => ({ from, to, kind: kind ?? "seq" }));
}

/** What a test can set when it makes a task. */
export interface TaskOptions {
  readonly projectId?: string | null;
  readonly workspaceState?: Task["workspaceState"];
  readonly ownsWorkspace?: boolean;
}

/**
 * A task still designing, with one unapproved graph.
 *
 * @remarks
 * Test data: names and ids are fixed so assertions can write them out.
 *
 * @sideEffects none
 * @param nodes - The graph's nodes.
 * @param graphEdges - The graph's edges.
 * @param options - Project and worktree.
 * @returns The task.
 */
export function newTask(nodes: GraphNode[], graphEdges: GraphEdge[], options: TaskOptions = {}): Task {
  return {
    id: "tsk_1",
    name: "a task",
    projectId: options.projectId === undefined ? "prj_1" : options.projectId,
    workspaceId: options.workspaceState === "ready" ? "wsp_1" : null,
    workspaceState: options.workspaceState ?? "none",
    sourceDir: "/src",
    ownsWorkspace: options.ownsWorkspace ?? true,
    baseCommit: options.workspaceState === "ready" ? "abc" : null,
    model: { providerId: "p", modelId: "m", thinking: "off" },
    guide: { id: "g", version: 1 },
    summary: { goal: "", decisions: [], constraints: [], nonGoals: [], openQuestions: [], acceptance: [] },
    origin: { kind: "chat", sessionId: "ses_src" },
    scheduleDraft: null,
    taskSessionId: "ses_task",
    graphs: [{ version: 1, nodes, edges: graphEdges, author: "agent", note: "", createdAt: 0, approvedAt: null }],
    activeGraph: 1,
    pendingGraph: null,
    runs: [],
    paused: false,
    cancelled: false,
    createdAt: 0,
    startedAt: null,
    endedAt: null,
  };
}

/**
 * Freezes a value and everything inside it, so a step that writes to its input throws.
 *
 * @remarks
 * `step` is pure; a frozen input turns a hidden write into a failing test.
 *
 * @sideEffects Freezes the value in place.
 * @param value - The value.
 * @returns The same value.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/**
 * The action kinds only, without progress lines and notifications, for short assertions.
 *
 * @remarks
 * `start_node:N1` for actions that name a node.
 *
 * @sideEffects none
 * @param actions - The actions.
 * @returns One short string per action.
 */
export function kinds(actions: readonly Action[]): string[] {
  return actions
    .filter((action) => action.kind !== "progress_line" && action.kind !== "notify")
    .map((action) => ("node" in action ? `${action.kind}:${action.node}` : action.kind));
}

/**
 * Unwraps a value a test knows is there.
 *
 * @remarks
 * Keeps tests free of optional chaining, which hides a missing value as a quiet `undefined`.
 *
 * @sideEffects none
 * @param value - The value, maybe `undefined`.
 * @returns The value.
 * @throws When it is `undefined`.
 */
export function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value, got undefined");
  return value;
}

/**
 * A task being driven by events, with everything the scheduler asked for.
 *
 * @remarks
 * Numbers and times the events by position and freezes every task it holds, so a test reads like a
 * script and a scheduler that writes to its input fails.
 *
 * @sideEffects none
 */
export class Sim {
  task: Task;
  readonly log: { readonly event: TaskEvent; readonly actions: readonly Action[] }[] = [];
  #seq = 0;

  /**
   * Starts from a task.
   *
   * @remarks
   * The task is frozen, so a scheduler that changes its input fails the test.
   *
   * @sideEffects none
   * @param task - The task to start from.
   */
  constructor(task: Task) {
    this.task = deepFreeze(task);
  }

  /**
   * Sends an event, numbering and timing it by position.
   *
   * @remarks
   * Event `n` has `seq` n and `at` n seconds, so assertions can write times out.
   *
   * @sideEffects Replaces `task` and appends to `log`.
   * @param input - The event without `seq` and `at`.
   * @returns The actions it caused.
   */
  send(input: TaskEventInput): readonly Action[] {
    this.#seq += 1;
    const event = { ...input, seq: this.#seq, at: this.#seq * 1000 };
    const result = step(this.task, event);
    this.task = deepFreeze(result.task);
    this.log.push({ event, actions: result.actions });
    return result.actions;
  }

  /**
   * Every action so far, in order.
   *
   * @remarks
   * For asserting what the whole run asked for.
   *
   * @sideEffects none
   * @returns The actions.
   */
  all(): Action[] {
    return this.log.flatMap((entry) => [...entry.actions]);
  }

  /**
   * The task's status.
   *
   * @remarks
   * Shorthand for `deriveStatus(sim.task)`.
   *
   * @sideEffects none
   * @returns The status.
   */
  status(): TaskStatus {
    return deriveStatus(this.task);
  }

  /**
   * The state of a node.
   *
   * @remarks
   * Shorthand for `stateOf(sim.task, node)`.
   *
   * @sideEffects none
   * @param node - The node id.
   * @returns Its state.
   */
  state(node: string): NodeState {
    return stateOf(this.task, node);
  }

  /**
   * The latest attempt of a node.
   *
   * @remarks
   * `undefined` if the node never had a run.
   *
   * @sideEffects none
   * @param node - The node id.
   * @returns The attempt.
   */
  attempt(node: string): number | undefined {
    return latestRun(this.task, node)?.attempt;
  }

  /**
   * All node states of the graph in force, `N1=running N2=pending`.
   *
   * @remarks
   * One string makes a whole-graph assertion readable.
   *
   * @sideEffects none
   * @returns The text.
   */
  states(): string {
    const graph = this.task.graphs.find((candidate) => candidate.version === this.task.activeGraph);
    return (graph?.nodes ?? []).map((node) => `${node.id}=${this.state(node.id)}`).join(" ");
  }
}

/**
 * The run of a node at an attempt, which a test knows is there.
 *
 * @remarks
 * Keeps tests free of `find` callbacks with conditions.
 *
 * @sideEffects none
 * @param task - The task.
 * @param node - The node id.
 * @param attempt - The attempt.
 * @returns The run.
 * @throws When there is none.
 */
export function runOf(task: Task, node: string, attempt: number): NodeRun {
  return need(runAt(task, node, attempt));
}
