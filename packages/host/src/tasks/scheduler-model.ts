import fc from "fast-check";
import { expect } from "vitest";
import { type GraphProblem, validateGraph } from "./graph-validator";
import { BACK_LIMIT, NODE_SLOTS, activeGraphOf, latestRun, sinksOf, stateOf, upstreamOf } from "./graph";
import { backUses, step } from "./scheduler";
import { deriveStatus } from "./status";
import { Sim, agent, human, newTask } from "./test-support";
import type { Action, GraphEdge, GraphNode, NodeRole, Task, TaskEventInput, TaskStatus } from "./types";

/** What the generator decides about a graph before it is built. */
interface GraphPlan {
  readonly size: number;
  readonly roles: readonly NodeRole[];
  readonly humans: readonly boolean[];
  readonly edgeBits: readonly boolean[];
  readonly backBits: readonly boolean[];
  readonly mergeBits: readonly boolean[];
  readonly ready: boolean;
}

/** A random graph plan: up to 8 nodes, edges only from lower to higher index so there is no cycle. */
const planArb: fc.Arbitrary<GraphPlan> = fc.record({
  size: fc.integer({ min: 1, max: 8 }),
  roles: fc.array(fc.constantFrom<NodeRole>("explore", "work", "check", "advise", "work"), {
    minLength: 8,
    maxLength: 8,
  }),
  humans: fc.array(fc.constantFrom(true, true, false), { minLength: 8, maxLength: 8 }),
  edgeBits: fc.array(fc.constantFrom(true, false, false), { minLength: 28, maxLength: 28 }),
  backBits: fc.array(fc.constantFrom(true, false, false), { minLength: 28, maxLength: 28 }),
  mergeBits: fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
  ready: fc.boolean(),
});

/**
 * Builds the nodes and edges of a plan.
 *
 * @remarks
 * Human nodes sit at odd positions and are less common than agent ones; a back edge needs an earlier node that reaches the human node, so every graph made here is acyclic.
 *
 * @sideEffects none
 * @param plan - The plan.
 * @returns The nodes and edges.
 */
function build(plan: GraphPlan): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const edges: GraphEdge[] = [];
  let bit = 0;
  for (let to = 1; to < plan.size; to += 1) {
    for (let from = 0; from < to; from += 1, bit += 1) {
      if (plan.edgeBits[bit]) edges.push({ from: `N${from + 1}`, to: `N${to + 1}`, kind: "seq" });
    }
  }
  /**
   * Whether the node at an index is a human node.
   *
   * @remarks
   * Odd positions only, and never the first node.
   *
   * @sideEffects none
   * @param i - The index.
   * @returns Whether it is human.
   */
  const isHuman = (i: number): boolean => plan.humans[i] === true && i > 0 && i % 2 === 1;
  bit = 0;
  for (let to = 1; to < plan.size; to += 1) {
    for (let from = 0; from < to; from += 1, bit += 1) {
      // A back edge runs from a later human node to an earlier node that reaches it.
      if (plan.backBits[bit] && isHuman(to) && reaches(edges, `N${from + 1}`, `N${to + 1}`)) {
        edges.push({ from: `N${to + 1}`, to: `N${from + 1}`, kind: "back" });
      }
    }
  }
  const nodes = Array.from({ length: plan.size }, (_, i) => {
    const id = `N${i + 1}`;
    if (!isHuman(i)) return agent(id, plan.roles[i] ?? "explore");
    const sink = !edges.some((e) => e.kind === "seq" && e.from === id);
    return human(id, sink && plan.mergeBits[i] === true && plan.ready ? { merge: true } : {});
  });
  return { nodes, edges };
}

/**
 * Whether `to` can be reached from `from` along sequential edges.
 *
 * @remarks
 * Back edges are only drawn to ancestors, so the generator needs reach to place them.
 *
 * @sideEffects none
 * @param edges - The edges so far.
 * @param from - Where to start.
 * @param to - The node looked for.
 * @returns Whether it is reachable.
 */
function reaches(edges: readonly GraphEdge[], from: string, to: string): boolean {
  const visited = new Set([from]);
  const queue = [from];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (id === to) return true;
    for (const e of edges) {
      if (e.kind !== "seq" || e.from !== id || visited.has(e.to)) continue;
      visited.add(e.to);
      queue.push(e.to);
    }
  }
  return false;
}

/**
 * The validator's verdict on a plan.
 *
 * @remarks
 * Plans that make no valid graph are left out of the walks.
 *
 * @sideEffects none
 * @param plan - The plan.
 * @returns The problems; empty for a valid graph.
 */
function problems(plan: GraphPlan): GraphProblem[] {
  const { nodes, edges } = build(plan);
  return validateGraph({ nodes, edges }, { projectless: false, localReadonly: false });
}

/**
 * Every event a person, a runner or a stale session could send in the task's present state.
 *
 * @remarks
 * Mostly events that fit the state of the node they name, so a walk gets deep into the machine; a few late or misplaced ones are mixed in, which the scheduler has to ignore without breaking.
 *
 * @sideEffects none
 * @param task - The task as it is.
 * @returns The events, some listed twice to make them likelier.
 */
function candidates(task: Task): TaskEventInput[] {
  const graph = activeGraphOf(task);
  if (graph === undefined || graph.approvedAt === null)
    return [{ type: "started" }, { type: "abandoned" }, { type: "paused" }];
  const out: TaskEventInput[] = [];
  if (task.workspaceState === "creating") {
    out.push(
      { type: "workspace_created", workspaceId: "w", baseCommit: "c" },
      { type: "workspace_created", workspaceId: "w", baseCommit: "c" },
    );
  }
  if (task.pendingGraph !== null) out.push({ type: "graph_approved" });
  else if (graph.nodes.length < 9) {
    const id = `N${graph.nodes.length + 1}`;
    const from = graph.nodes[graph.nodes.length - 1];
    const nodes = [...graph.nodes, agent(id, "explore")];
    const edges = [...graph.edges, ...(from === undefined ? [] : [{ from: from.id, to: id, kind: "seq" as const }])];
    const verdict = validateGraph({ nodes, edges }, { projectless: false, localReadonly: false, started: task });
    if (verdict.length === 0) out.push({ type: "graph_proposed", author: "agent", note: "n", nodes, edges });
  }
  for (const node of graph.nodes) {
    const run = latestRun(task, node.id);
    if (run === undefined) continue;
    const ref = { node: node.id, attempt: run.attempt };
    const late = { node: node.id, attempt: run.attempt + 1 };
    out.push({ type: "node_settled", ...late }, { type: "human_passed", node: node.id });
    if (run.state === "running") {
      out.push(
        { type: "node_started", ...ref, sessionId: `s_${node.id}_${run.attempt}`, startCommit: null },
        { type: "node_waiting", ...ref, waitingFor: "question" },
        { type: "node_waiting", ...ref, waitingFor: "graph_change" },
        { type: "node_done_pending", ...ref, ok: true, summary: "s" },
        { type: "node_done_pending", ...ref, ok: true, summary: "s" },
        { type: "node_done_pending", ...ref, ok: false, reason: "r" },
        { type: "node_done_void", ...ref },
        { type: "node_settled", ...ref },
        { type: "node_settled", ...ref },
        { type: "node_settled", ...ref },
        { type: "node_failed", ...ref, reason: "crashed" },
        { type: "node_stopped", ...ref },
        { type: "node_held", ...ref },
      );
    } else if (run.state === "waiting" && run.waitingFor === "question") {
      out.push(
        { type: "node_resumed", ...ref },
        { type: "node_resumed", ...ref },
        { type: "node_stopped", ...ref },
        { type: "node_failed", ...ref, reason: "model_error" },
      );
    } else if (run.state === "stopped" || run.state === "held") {
      out.push({ type: "node_resumed", ...ref }, { type: "node_failed", ...ref, reason: "crashed" });
    } else if (run.state === "failed") {
      out.push({ type: "rerun_requested", node: node.id }, { type: "rerun_requested", node: node.id });
    } else if (run.state === "passed") {
      out.push({ type: "committed", ...ref, commit: "k" });
    } else if (run.state === "waiting" && node.kind === "human") {
      out.push({ type: "human_passed", node: node.id });
      if (run.merging === true)
        out.push({ type: "merged", node: node.id }, { type: "merge_blocked", node: node.id, reason: "merge_conflict" });
      for (const edge of graph.edges) {
        if (edge.kind !== "back" || edge.from !== node.id) continue;
        const sendBack: TaskEventInput = { type: "human_sent_back", node: node.id, to: edge.to, reason: "again" };
        out.push(sendBack, sendBack, sendBack, sendBack);
      }
    }
  }
  return out;
}

/**
 * Events that end or interrupt a walk.
 *
 * @remarks
 * They are kept rare so walks get deep: a pause or a cancel at every other step would leave little to test.
 *
 * @sideEffects none
 * @param task - The task as it is.
 * @param pick - A number from the generator; one in six picks adds a cancel.
 * @returns The events.
 */
function rareEvents(task: Task, pick: number): TaskEventInput[] {
  const out: TaskEventInput[] = [
    { type: "paused" },
    { type: "resumed" },
    { type: "host_restarted" },
    { type: "workspace_failed" },
    { type: "graph_rejected" },
  ];
  if (pick % 6 === 0) out.push({ type: "cancelled" });
  return out.concat(task.pendingGraph === null ? [] : [{ type: "graph_rejected" }]);
}

/**
 * The cooperative move that gets a task closer to its end.
 *
 * @remarks
 * Used between random events to go deep, and at the end of a walk to show that the task can always be finished.
 *
 * @sideEffects none
 * @param task - The task as it is.
 * @param passHumans - Whether to pass a waiting human node; off during the walk so the random events get to send back.
 * @returns An event, or `null` when the task is over or has nothing more to do.
 */
function cooperate(task: Task, passHumans = true): TaskEventInput | null {
  const graph = activeGraphOf(task);
  if (task.cancelled || task.endedAt !== null) return null;
  if (graph === undefined || graph.approvedAt === null) return { type: "started" };
  if (task.paused) return { type: "resumed" };
  if (task.workspaceState === "creating") return { type: "workspace_created", workspaceId: "w", baseCommit: "c" };
  for (const node of graph.nodes) {
    const run = latestRun(task, node.id);
    if (run === undefined || run.void === true) continue;
    const ref = { node: node.id, attempt: run.attempt };
    if (run.state === "failed") return { type: "rerun_requested", node: node.id };
    if (run.state === "stopped") return { type: "node_resumed", ...ref };
    if (run.state === "waiting" && run.waitingFor === "question") return { type: "node_resumed", ...ref };
    if (run.state === "waiting" && run.waitingFor === "graph_change") {
      return task.pendingGraph === null
        ? { type: "graph_proposed", author: "agent", note: "same", nodes: graph.nodes, edges: graph.edges }
        : { type: "graph_approved" };
    }
    if (run.state === "waiting" && run.merging !== true && !passHumans) continue;
    if (run.state === "waiting")
      return run.merging === true ? { type: "merged", node: node.id } : { type: "human_passed", node: node.id };
  }
  for (const node of graph.nodes) {
    const run = latestRun(task, node.id);
    if (run?.state !== "running") continue;
    const ref = { node: node.id, attempt: run.attempt };
    return run.pendingDone === null
      ? { type: "node_done_pending", ...ref, ok: true, summary: "s" }
      : { type: "node_settled", ...ref };
  }
  return null;
}

/**
 * What the task's status should be, written out apart from `deriveStatus`.
 *
 * @remarks
 * A second statement of the table in SPEC-0006, "任务", using "every node passed" for done instead of "every end node passed"; the two must agree on every reachable state.
 *
 * @sideEffects none
 * @param task - The task.
 * @returns The status.
 */
function oracleStatus(task: Task): TaskStatus {
  const graph = activeGraphOf(task);
  if (task.cancelled) return "cancelled";
  if (graph === undefined || graph.approvedAt === null) return "designing";
  const states = graph.nodes.map((node) => stateOf(task, node.id));
  /**
   * Whether any node is in a state.
   *
   * @remarks
   * Reads the status table the way the spec writes it.
   *
   * @sideEffects none
   * @param state - The state.
   * @returns Whether some node has it.
   */
  const has = (state: string): boolean => states.some((s) => s === state);
  if (task.paused || has("failed") || has("stopped")) return "stopped";
  if (has("waiting")) return "waiting";
  if (has("running") || has("held") || has("pending"))
    return has("running") || has("held")
      ? "running"
      : states.every((s) => s === "pending" || s === "passed") && states.some((s) => s === "pending")
        ? "running"
        : "done";
  return "done";
}

/**
 * Lists the events of a walk, for a failure message.
 *
 * @remarks
 * A failing property shows the sequence that led to it.
 *
 * @sideEffects none
 * @param sim - The simulation.
 * @returns One line per event.
 */
function trace(sim: Sim): string {
  return sim.log.map(({ event }) => `${event.seq} ${event.type}${"node" in event ? ` ${event.node}` : ""}`).join("\n");
}

/**
 * Checks everything a state must satisfy after a step.
 *
 * @remarks
 * These are SPEC-0006's properties for the scheduler: the status agrees with the nodes, a work node has its worktree alone, a stopped task starts nothing, a back edge is used at most twice, the worktree is asked for from `none` only, plus slots, dependencies and the end.
 *
 * @sideEffects Calls `expect`.
 * @param before - The task before the step.
 * @param sim - The simulation after it.
 * @param actions - The actions the step produced.
 */
function checkInvariants(before: Task, sim: Sim, actions: readonly Action[]): void {
  const task = sim.task;
  const graph = activeGraphOf(task);
  /**
   * The walk so far, as a message suffix.
   *
   * @remarks
   * Every assertion below carries it.
   *
   * @sideEffects none
   * @returns The text.
   */
  const where = (): string => `\n${trace(sim)}`;
  const status = deriveStatus(task);
  expect(status, `status${where()}`).toBe(oracleStatus(task));
  if (graph === undefined) return;

  // A work node in the worktree is alone there.
  for (const node of graph.nodes) {
    if (node.kind === "agent" && node.role === "work" && stateOf(task, node.id) === "running") {
      const others = graph.nodes.filter(
        (o) => o.kind === "agent" && o.id !== node.id && ["running", "waiting", "held"].includes(stateOf(task, o.id)),
      );
      expect(
        others.map((o) => o.id),
        `${node.id} is a running work node${where()}`,
      ).toEqual([]);
    }
  }

  // A stopped task starts nothing.
  if (status === "stopped" || status === "designing" || status === "cancelled") {
    expect(
      actions.filter((a) => a.kind === "start_node" || a.kind === "ensure_workspace"),
      `starts while ${status}${where()}`,
    ).toEqual([]);
  }

  // No send-back is used more than twice.
  for (const edge of graph.edges) {
    if (edge.kind === "back")
      expect(backUses(task, edge.from, edge.to), `back ${edge.from}>${edge.to}${where()}`).toBeLessThanOrEqual(
        BACK_LIMIT,
      );
  }

  // The worktree is asked for from "none" only.
  const asks = actions.filter((a) => a.kind === "ensure_workspace").length;
  expect(asks, `ensure_workspace count${where()}`).toBeLessThanOrEqual(1);
  if (asks === 1) {
    expect(before.workspaceState, `ensure_workspace from${where()}`).toBe("none");
    expect(task.workspaceState).toBe("creating");
  }

  // Slots.
  const used = graph.nodes.filter(
    (n) => n.kind === "agent" && ["running", "waiting", "held", "stopped"].includes(stateOf(task, n.id)),
  );
  expect(used.length, `slots${where()}`).toBeLessThanOrEqual(NODE_SLOTS);

  // A node that began, passed or waits has everything it waits for passed (a human run that was voided does not count).
  for (const node of graph.nodes) {
    const state = stateOf(task, node.id);
    if (
      ["running", "held", "stopped", "passed", "waiting"].includes(state) ||
      (state === "failed" && latestRun(task, node.id)?.sessionId !== null)
    ) {
      const open = upstreamOf(graph, node.id).filter((up) => stateOf(task, up) !== "passed");
      expect(open, `${node.id} is ${state} with unfinished upstream${where()}`).toEqual([]);
    }
  }

  // Done means every end node passed and the task has its end time.
  if (status === "done") {
    expect(sinksOf(graph).every((id) => stateOf(task, id) === "passed")).toBe(true);
    expect(task.endedAt, `endedAt${where()}`).not.toBeNull();
  }
}

/** A graph with its task's setup. */
export interface Setup {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  readonly ready: boolean;
  readonly owns: boolean;
}

/** A random graph from `planArb`. */
export const anyGraphArb: fc.Arbitrary<Setup> = planArb
  .filter((plan) => problems(plan).length === 0)
  .map((plan) => ({ ...build(plan), ready: plan.ready, owns: plan.mergeBits[0] === true }));

/**
 * A graph shaped like the tasks the design is for: agent nodes in a random DAG and a closing human node
 * after every end node, able to send back to any of the nodes before it.
 */
export const reviewGraphArb: fc.Arbitrary<Setup> = fc
  .record({
    size: fc.integer({ min: 1, max: 6 }),
    roles: fc.array(fc.constantFrom<NodeRole>("explore", "work", "check", "advise", "work"), {
      minLength: 6,
      maxLength: 6,
    }),
    edgeBits: fc.array(fc.constantFrom(true, false), { minLength: 15, maxLength: 15 }),
    backBits: fc.array(fc.constantFrom(true, false), { minLength: 6, maxLength: 6 }),
    merge: fc.boolean(),
    ready: fc.boolean(),
    owns: fc.boolean(),
    middle: fc.boolean(),
  })
  .map((plan) => {
    const edges: GraphEdge[] = [];
    let bit = 0;
    for (let to = 1; to < plan.size; to += 1) {
      for (let from = 0; from < to; from += 1, bit += 1) {
        if (plan.edgeBits[bit]) edges.push({ from: `N${from + 1}`, to: `N${to + 1}`, kind: "seq" });
      }
    }
    const agents = Array.from({ length: plan.size }, (_, i) => agent(`N${i + 1}`, plan.roles[i] ?? "explore"));
    const ends = agents.filter((n) => !edges.some((e) => e.from === n.id));
    for (const end of ends) edges.push({ from: end.id, to: "H1", kind: "seq" });
    // A human node in the middle too: it gates the node after it, and cannot merge.
    const nodes = [...agents, human("H1", plan.merge && plan.ready ? { merge: true } : {})];
    for (const [i, node] of agents.entries()) {
      if (plan.backBits[i]) edges.push({ from: "H1", to: node.id, kind: "back" });
    }
    return { nodes, edges, ready: plan.ready, owns: plan.owns };
  })
  .filter((setup) => validateGraph(setup, { projectless: false, localReadonly: false }).length === 0);

/** One step of a walk: which event, whether to send it twice, how many cooperative moves follow. */
export const walkArb = fc.array(fc.tuple(fc.nat(), fc.boolean(), fc.nat({ max: 5 })), { minLength: 0, maxLength: 70 });

/**
 * Walks a task through random events, checking every invariant after each, then drives it to its end.
 *
 * @remarks
 * Events mostly fit the state, some are late or misplaced, some are sent twice; between them cooperative moves carry the walk deep. At the end the cooperative moves alone must finish the task: whatever happened, there is a way out.
 *
 * @sideEffects Calls `expect`; adds to `covered`.
 * @param setup - The graph and the task's worktree.
 * @param choices - Per step: which event, whether to send it twice, how many cooperative moves follow.
 */
export function walk(setup: Setup, choices: readonly (readonly [number, boolean, number])[]): void {
  const sim = new Sim(
    newTask(setup.nodes, setup.edges, { workspaceState: setup.ready ? "ready" : "none", ownsWorkspace: setup.owns }),
  );
  const startedBy = new Map<string, number>();
  const reruns = new Set<string>();
  /**
   * Sends one event and checks what came of it.
   *
   * @remarks
   * Also counts `start_node` per run: a second start of one run is only allowed after a rerun.
   *
   * @sideEffects Changes `sim`; calls `expect`.
   * @param input - The event.
   */
  const apply = (input: TaskEventInput): void => {
    const before = sim.task;
    const actions = sim.send(input);
    checkInvariants(before, sim, actions);
    if (input.type === "rerun_requested") reruns.add(input.node);
    for (const action of actions) {
      if (action.kind !== "start_node") continue;
      const key = `${action.node}:${action.attempt}`;
      const count = (startedBy.get(key) ?? 0) + 1;
      // A second start of one run is the rerun of a node that failed before it had a session.
      if (count > 1)
        expect(reruns.has(action.node), `start_node ${key} twice without a rerun\n${trace(sim)}`).toBe(true);
      startedBy.set(key, count);
    }
  };
  apply({ type: "started" });
  for (const [pick, twice, drive] of choices) {
    const rare = pick % 12 === 0;
    const options = rare ? rareEvents(sim.task, pick) : candidates(sim.task);
    const input = options[Math.floor(pick / 12) % options.length];
    if (input === undefined) break;
    apply(input);
    if (twice) apply(input);
    for (
      let move = cooperate(sim.task, false), left = drive;
      move !== null && left > 0;
      move = cooperate(sim.task, false), left -= 1
    ) {
      apply(move);
    }
  }
  for (let moves = 0; moves < 400; moves += 1) {
    const move = cooperate(sim.task);
    if (move === null) break;
    apply(move);
  }
  const status = deriveStatus(sim.task);
  expect(["done", "cancelled"], `not finished: ${status}\n${trace(sim)}\n${sim.states()}`).toContain(status);
  record(sim);
}

/** Counters of what the walks covered, asserted at the end so a generator that stops reaching a rule fails the suite. */
const covered = new Map<string, number>();

/**
 * Adds what a finished walk did to `covered`.
 *
 * @remarks
 * The suite asserts that every kind of event and action it cares about was reached, so a generator that stops getting there fails instead of passing idle.
 *
 * @sideEffects Changes `covered`.
 * @param sim - The finished simulation.
 */
function record(sim: Sim): void {
  for (const { event, actions } of sim.log) {
    covered.set(`event:${event.type}`, (covered.get(`event:${event.type}`) ?? 0) + 1);
    for (const action of actions) covered.set(`action:${action.kind}`, (covered.get(`action:${action.kind}`) ?? 0) + 1);
  }
  const backs = sim.task.runs.filter((run) => run.backFrom !== undefined).length;
  covered.set("send-backs", (covered.get("send-backs") ?? 0) + backs);
  covered.set("runs", (covered.get("runs") ?? 0) + 1);
}

/**
 * How often a kind of event or action was seen in the walks so far.
 *
 * @remarks
 * Lets a test assert coverage without optional chaining.
 *
 * @sideEffects none
 * @param key - `event:<type>`, `action:<kind>`, `send-backs` or `runs`.
 * @returns The count; 0 if never seen.
 */
export function seen(key: string): number {
  return covered.get(key) ?? 0;
}

/**
 * Walks random events and applies each one twice to the same task, expecting the same result.
 *
 * @remarks
 * `step` must depend on its inputs only, so a replay of the log gives the same actions.
 *
 * @sideEffects Calls `expect`.
 * @param setup - The graph and the task's worktree.
 * @param picks - Which event to send at each step.
 */
export function stepsAreDeterministic(setup: Setup, picks: readonly number[]): void {
  const sim = new Sim(newTask(setup.nodes, setup.edges, { workspaceState: setup.ready ? "ready" : "none" }));
  sim.send({ type: "started" });
  for (const pick of picks) {
    const options = candidates(sim.task);
    const input = options[pick % options.length];
    if (input === undefined) return;
    const event = { ...input, seq: sim.log.length + 1, at: 1_000_000 + sim.log.length };
    const once = step(sim.task, event);
    expect(step(sim.task, event)).toStrictEqual(once);
    sim.send(input);
  }
}

/**
 * Forgets what the walks covered so far.
 *
 * @remarks
 * Lets a test count only its own walks.
 *
 * @sideEffects Empties `covered`.
 */
export function resetSeen(): void {
  covered.clear();
}
