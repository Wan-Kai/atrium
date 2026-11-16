import { advance, endTask } from "./advance";
import { type Draft, emit, freshRun, notify, progress } from "./draft";
import {
  BACK_LIMIT,
  MAX_CONFLICT_FILES,
  activeGraphOf,
  latestRun,
  liveRun,
  nodeStates,
  placeOf,
  reachableFrom,
  runAt,
  stateOf,
  topologicalOrder,
  upstreamOf,
} from "./graph";
import { isHeldBack } from "./status";
import {
  RESUME_GRAPH_APPROVED,
  RESUME_GRAPH_REJECTED,
  RESUME_QUESTION_VOID,
  RESUME_RESTARTED,
  resumeAfterFailure,
  wakeForGraphChange,
} from "./texts";
import type { FailureReason, NodeId, NodeRun, StepResult, Task, TaskEvent } from "./types";

/** An event of the type `T`. */
type Of<T extends TaskEvent["type"]> = Extract<TaskEvent, { type: T }>;

/**
 * The run an event of a node's session is about, if it is still the live one.
 *
 * @remarks
 * A send-back replaces a node's runs and the old session's late events arrive afterwards; they name
 * the attempt, and one that is not the latest, or was voided, is dropped.
 *
 * @sideEffects none
 * @param task - The task.
 * @param event - An event with `node` and `attempt`.
 * @returns The run, or `undefined` when the event is stale.
 */
function liveAttempt(task: Task, event: { readonly node: NodeId; readonly attempt: number }): NodeRun | undefined {
  const run = runAt(task, event.node, event.attempt);
  return run !== undefined && run === liveRun(task, event.node) ? run : undefined;
}

/**
 * Asks every running node to stop once its turn ends.
 *
 * @remarks
 * Used when the task is paused or a node failed (SPEC-0006, "失败", "暂停和恢复"). A node already
 * asked in this step is not asked twice.
 *
 * @sideEffects Changes the draft's actions.
 * @param draft - The step.
 */
function holdRunning(draft: Draft): void {
  for (const { node, state } of nodeStates(draft.task)) {
    if (state !== "running") continue;
    const asked = draft.actions.some(
      (action) => action.kind === "stop_node" && action.node === node.id && action.when === "after_turn",
    );
    if (!asked) emit(draft, { kind: "stop_node", node: node.id, when: "after_turn" });
  }
}

/**
 * Fails a run: records why, holds the siblings that are running and asks for the user.
 *
 * @remarks
 * SPEC-0006, "调度器 · 失败". The task becomes `stopped` through the node's state; nothing here
 * sets it.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @param run - The run that failed.
 * @param reason - Why.
 */
function failRun(draft: Draft, run: NodeRun, reason: FailureReason): void {
  run.state = "failed";
  run.failure = reason;
  run.waitingFor = null;
  delete run.graphRequest;
  run.endedAt = draft.event.at;
  holdRunning(draft);
  notify(draft, { kind: "failed", node: run.node, reason });
  progress(draft, "node_failed", run.node);
}

/**
 * Sets a node back to work after something it waited for was settled, or leaves it held.
 *
 * @remarks
 * If the task is paused or a node failed, a node that comes back would run on against the hold, so it
 * is `held` and the next advance resumes it with the generic line. Otherwise it runs again at once.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @param run - The waiting run.
 * @param text - What to tell the node.
 * @param voided - The question was voided by a restart: if the node is held, it is told so when it is resumed.
 */
function releaseWaiting(draft: Draft, run: NodeRun, text: string, voided = false): void {
  run.waitingFor = null;
  run.pendingDone = null;
  delete run.graphRequest;
  if (isHeldBack(draft.task)) {
    run.state = "held";
    // The line it would have had is kept for when it is resumed.
    if (voided) run.afterRestart = { ...run.afterRestart, questionVoid: true };
    return;
  }
  run.state = "running";
  emit(draft, { kind: "resume_node", node: run.node, text });
}

/**
 * Applies `graph_proposed`: a new version, in force at once while designing, else waiting for approval.
 *
 * @remarks
 * SPEC-0006, "改图 · 生效时机". A second proposal before the first is approved replaces it as the
 * pending one.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onGraphProposed(draft: Draft, event: Of<"graph_proposed">): boolean {
  const { task } = draft;
  const version = task.graphs.length + 1;
  task.graphs.push({
    version,
    nodes: event.nodes,
    edges: event.edges,
    author: event.author,
    note: event.note,
    createdAt: event.at,
    approvedAt: null,
  });
  if (task.startedAt === null) {
    task.activeGraph = version;
    if (event.guide !== undefined) task.guide = { ...event.guide };
  } else {
    task.pendingGraph = version;
    notify(draft, { kind: "graph_approval" });
  }
  return true;
}

/**
 * Applies `summary_set`: the requirement summary the task conversation wrote.
 *
 * @remarks
 * SPEC-0006, "任务对话": only while the task is being designed; the service answers `task_state_invalid` to
 * the tool after it started (a changed summary then would be a changed graph), and the event is ignored here.
 *
 * @sideEffects Changes the draft's task.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onSummarySet(draft: Draft, event: Of<"summary_set">): boolean {
  if (draft.task.startedAt !== null) return false;
  draft.task.summary = event.summary;
  return true;
}

/**
 * Applies `started`: approves the initial graph and starts the task.
 *
 * @remarks
 * "确认并启动" (SPEC-0006, "/task 与创建"). A worktree that already exists (the source conversation
 * was in one) is locked from here (SPEC-0006, "加锁").
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @returns Whether it applied.
 */
function onStarted(draft: Draft): boolean {
  const { task } = draft;
  const graph = activeGraphOf(task);
  if (task.startedAt !== null || graph === undefined || task.cancelled) return false;
  task.startedAt = draft.event.at;
  graph.approvedAt = draft.event.at;
  if (task.workspaceState === "ready") emit(draft, { kind: "lock_workspace" });
  return true;
}

/**
 * Applies `abandoned`: the task is dropped while still designing.
 *
 * @remarks
 * The record is deleted after this event (SPEC-0006, "放弃任务"); marking it cancelled and ended
 * lets the same status rules call it finished.
 *
 * @sideEffects Changes the draft's task.
 * @param draft - The step.
 * @returns Whether it applied.
 */
function onAbandoned(draft: Draft): boolean {
  const { task } = draft;
  if (task.startedAt !== null) return false;
  task.cancelled = true;
  task.endedAt = draft.event.at;
  return true;
}

/**
 * Applies `graph_approved`: the pending version takes over.
 *
 * @remarks
 * SPEC-0006, "改图 · 批准后": a waiting human node that gained an unfinished upstream is voided, and
 * the nodes that asked for the change go on (or stay held).
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @returns Whether it applied.
 */
function onGraphApproved(draft: Draft): boolean {
  const { task } = draft;
  const pending = task.graphs.find((graph) => graph.version === task.pendingGraph);
  if (task.startedAt === null || pending === undefined) return false;
  pending.approvedAt = draft.event.at;
  task.activeGraph = pending.version;
  task.pendingGraph = null;
  for (const node of pending.nodes) {
    const run = liveRun(task, node.id);
    if (node.kind !== "human" || run?.state !== "waiting" || run.merging === true) continue;
    if (!upstreamOf(pending, node.id).every((upstream) => stateOf(task, upstream) === "passed")) run.void = true;
  }
  releaseGraphWaiters(draft, RESUME_GRAPH_APPROVED);
  return true;
}

/**
 * Applies `graph_rejected`: the pending version is dropped.
 *
 * @remarks
 * The nodes that asked for it carry on with the old graph (SPEC-0006, "中途").
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @returns Whether it applied.
 */
function onGraphRejected(draft: Draft): boolean {
  const { task } = draft;
  if (task.startedAt === null || task.pendingGraph === null) return false;
  task.pendingGraph = null;
  releaseGraphWaiters(draft, RESUME_GRAPH_REJECTED);
  return true;
}

/**
 * Sends every node waiting for a graph change back to work.
 *
 * @remarks
 * Approval and refusal both end the wait.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @param text - What to tell them.
 */
function releaseGraphWaiters(draft: Draft, text: string): void {
  for (const { node } of nodeStates(draft.task)) {
    const run = liveRun(draft.task, node.id);
    if (run?.state === "waiting" && run.waitingFor === "graph_change") releaseWaiting(draft, run, text);
  }
}

/**
 * Applies `meta_changed`: the task's name or model.
 *
 * @remarks
 * A model change reaches only nodes that have not started: they read it when they do.
 *
 * @sideEffects Changes the draft's task.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether anything changed.
 */
function onMetaChanged(draft: Draft, event: Of<"meta_changed">): boolean {
  const { task } = draft;
  let changed = false;
  if (event.name !== undefined && event.name !== task.name) {
    task.name = event.name;
    changed = true;
  }
  if (event.model !== undefined && JSON.stringify(event.model) !== JSON.stringify(task.model)) {
    task.model = event.model;
    changed = true;
  }
  return changed;
}

/**
 * Applies `schedule_set`: the task becomes a schedule rule's template, or its cadence or place changes.
 *
 * @remarks
 * Only while the task is being designed (T10); the service checks, and a stray event after the start changes nothing.
 *
 * @sideEffects Changes the draft's task.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether anything changed.
 */
function onScheduleSet(draft: Draft, event: Of<"schedule_set">): boolean {
  const { task } = draft;
  if (task.startedAt !== null) return false;
  const next = { when: event.when, place: event.place };
  if (JSON.stringify(task.scheduleDraft) === JSON.stringify(next)) return false;
  task.scheduleDraft = next;
  return true;
}

/**
 * Applies `node_started`: the session is up.
 *
 * @remarks
 * The run is `running` since the action was sent; this records the session and the commit the
 * node began at.
 *
 * @sideEffects Changes the draft's task.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onNodeStarted(draft: Draft, event: Of<"node_started">): boolean {
  const run = liveAttempt(draft.task, event);
  if (run?.state !== "running" || run.sessionId !== null) return false;
  run.sessionId = event.sessionId;
  run.startCommit = event.startCommit;
  return true;
}

/**
 * Applies `node_waiting`: the node asked a question or for a graph change.
 *
 * @remarks
 * A question goes to the user's attention; a graph change wakes the task conversation, whose
 * agent proposes the graph (SPEC-0006, "中途").
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onNodeWaiting(draft: Draft, event: Of<"node_waiting">): boolean {
  const run = liveAttempt(draft.task, event);
  if (run?.state !== "running") return false;
  run.state = "waiting";
  run.waitingFor = event.waitingFor;
  // A graph change asked for after a `node_done` in the same turn replaces it.
  if (event.waitingFor === "graph_change") {
    run.pendingDone = null;
    if (event.request !== undefined) run.graphRequest = event.request;
  }
  progress(draft, "node_waiting", run.node);
  if (event.waitingFor === "question") notify(draft, { kind: "question", node: run.node });
  else emit(draft, { kind: "wake_task_conversation", text: wakeForGraphChange(run.node) });
  return true;
}

/**
 * Applies `node_resumed`: a node left the wait or the stop without the scheduler's help.
 *
 * @remarks
 * The user answered its question, or sent a message or pressed "继续" in a stopped node's
 * conversation. If the task is held back, the answered node still stops after the turn it is in.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onNodeResumed(draft: Draft, event: Of<"node_resumed">): boolean {
  const run = liveAttempt(draft.task, event);
  if (run === undefined) return false;
  const answered = run.state === "waiting" && run.waitingFor === "question";
  if (!answered && run.state !== "stopped") return false;
  run.state = "running";
  run.waitingFor = null;
  if (answered && isHeldBack(draft.task)) emit(draft, { kind: "stop_node", node: run.node, when: "after_turn" });
  return true;
}

/**
 * Applies `node_done_pending`: a `node_done` call waits for the turn to end.
 *
 * @remarks
 * Only the last one counts (SPEC-0006, "结束").
 *
 * @sideEffects Changes the draft's task.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onNodeDonePending(draft: Draft, event: Of<"node_done_pending">): boolean {
  const run = liveAttempt(draft.task, event);
  if (run?.state !== "running") return false;
  run.pendingDone = {
    ok: event.ok,
    ...(event.summary === undefined ? {} : { summary: event.summary }),
    ...(event.reason === undefined ? {} : { reason: event.reason }),
  };
  return true;
}

/**
 * Applies `node_done_void`: the waiting `node_done` no longer counts.
 *
 * @remarks
 * Another request began, or the turn ended in an error or a stop (SPEC-0006, "结束" 3).
 *
 * @sideEffects Changes the draft's task.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onNodeDoneVoid(draft: Draft, event: Of<"node_done_void">): boolean {
  const run = liveAttempt(draft.task, event);
  if (run?.state !== "running" || run.pendingDone === null) return false;
  run.pendingDone = null;
  return true;
}

/**
 * Applies `node_settled`: a turn ended normally.
 *
 * @remarks
 * SPEC-0006, "结束" 4 and the `no_done` row of "失败": a waiting `node_done` takes effect (a writing
 * node passes only once its commit is settled, so the next node starts on top of it); with none,
 * the node is reminded once and fails the second time. The runner sends `node_held` instead of this
 * when the turn ended because it was asked to hold and nothing was pending.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onNodeSettled(draft: Draft, event: Of<"node_settled">): boolean {
  const { task } = draft;
  const run = liveAttempt(task, event);
  if (run?.state !== "running" || run.commitPending === true) return false;
  const done = run.pendingDone;
  if (done === null) {
    if (run.nudged) failRun(draft, run, "no_done");
    else {
      run.nudged = true;
      emit(draft, { kind: "nudge_node", node: run.node });
    }
    return true;
  }
  if (!done.ok) {
    failRun(draft, run, "gave_up");
    return true;
  }
  run.summary = done.summary ?? null;
  run.pendingDone = null;
  const graphNode = activeGraphOf(task)?.nodes.find((node) => node.id === run.node);
  if (graphNode?.role === "work") {
    // A writing node passes when its commit is settled; until then it stays running, so nothing after it starts.
    run.commitPending = true;
    emit(draft, { kind: "commit_node", node: run.node, attempt: run.attempt });
    return true;
  }
  run.state = "passed";
  run.endedAt = draft.event.at;
  progress(draft, "node_passed", run.node);
  return true;
}

/**
 * Applies `node_failed`: the session crashed, the model failed, or the node could not start.
 *
 * @remarks
 * A node with a session fails from running, waiting for the user's answer or a graph change, held or
 * stopped; a human node, a passed node and a node already failed do not.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onNodeFailed(draft: Draft, event: Of<"node_failed">): boolean {
  const run = liveAttempt(draft.task, event);
  if (run === undefined || !["running", "waiting", "held", "stopped"].includes(run.state)) return false;
  if (run.commitPending === true) return false;
  if (run.state === "waiting" && run.waitingFor !== "question" && run.waitingFor !== "graph_change") return false;
  failRun(draft, run, event.reason);
  return true;
}

/**
 * Applies `node_stopped`: the user stopped the node's turn by hand.
 *
 * @remarks
 * `stopped`, not `held`: only the user lets it go on (SPEC-0006, "节点").
 *
 * @sideEffects Changes the draft's task.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onNodeStopped(draft: Draft, event: Of<"node_stopped">): boolean {
  const run = liveAttempt(draft.task, event);
  const waitingOnUser = run?.state === "waiting" && run.waitingFor === "question";
  if (run === undefined || (run.state !== "running" && !waitingOnUser)) return false;
  run.state = "stopped";
  run.waitingFor = null;
  run.pendingDone = null;
  return true;
}

/**
 * Applies `node_held`: a node asked to hold has finished its turn.
 *
 * @remarks
 * The scheduler resumes it when the task goes on (SPEC-0006, "调度器").
 *
 * @sideEffects Changes the draft's task.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onNodeHeld(draft: Draft, event: Of<"node_held">): boolean {
  const run = liveAttempt(draft.task, event);
  // A node whose `node_done` took effect passes (or commits) rather than holds.
  if (run?.state !== "running" || run.pendingDone !== null || run.commitPending === true) return false;
  run.state = "held";
  return true;
}

/**
 * Applies `human_passed`: the user passes a human node, which merges first if it is the closing one.
 *
 * @remarks
 * SPEC-0006, "human 节点", "合并". While a merge is under way a second "pass" is ignored; after a
 * blocked merge a new "pass" tries again.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onHumanPassed(draft: Draft, event: Of<"human_passed">): boolean {
  const { task } = draft;
  const run = liveRun(task, event.node);
  const node = activeGraphOf(task)?.nodes.find((candidate) => candidate.id === event.node);
  if (node?.kind !== "human" || run?.state !== "waiting" || run.merging === true) return false;
  if (node.merge === true && task.workspaceState === "ready") {
    run.merging = true;
    run.waitingFor = "human";
    run.blocked = null;
    delete run.blockedFiles;
    emit(draft, { kind: "merge", node: node.id });
    return true;
  }
  run.state = "passed";
  run.waitingFor = null;
  run.blocked = null;
  run.endedAt = draft.event.at;
  progress(draft, "node_passed", node.id);
  return true;
}

/**
 * How many times the back edge from a human node to a node has been used.
 *
 * @remarks
 * Each send-back leaves `backFrom` on the new run of its target, so counting those counts uses
 * (SPEC-0006, "打回"). The service uses this to answer `task_back_limit` and the UI to grey the option.
 *
 * @sideEffects none
 * @param task - The task.
 * @param human - The human node the edge leaves.
 * @param target - The node it points at.
 * @returns The number of uses.
 */
export function backUses(task: Task, human: NodeId, target: NodeId): number {
  return task.runs.filter((run) => run.node === target && run.backFrom?.node === human).length;
}

/**
 * Applies `human_sent_back`: the user sends the task back to an earlier node.
 *
 * @remarks
 * SPEC-0006, "调度器 · 打回": everything reachable from the target is reset, side branches and the
 * human node itself included. A node with a live session is stopped at once; each reset node gets a
 * fresh `pending` run, one attempt higher, and the target's carries why. A reset node that never
 * started has nothing to reset. A third use of the same edge is ignored.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onHumanSentBack(draft: Draft, event: Of<"human_sent_back">): boolean {
  const { task } = draft;
  const graph = activeGraphOf(task);
  const run = liveRun(task, event.node);
  if (graph === undefined || run?.state !== "waiting" || run.merging === true) return false;
  const edge = graph.edges.find((e) => e.kind === "back" && e.from === event.node && e.to === event.to);
  if (edge === undefined || backUses(task, event.node, event.to) >= BACK_LIMIT) return false;
  const reset = reachableFrom(graph, event.to);
  for (const id of topologicalOrder(graph)) {
    if (!reset.has(id)) continue;
    const latest = latestRun(task, id);
    if (latest === undefined || (latest.void !== true && latest.state === "pending")) continue;
    if (latest.void !== true && latest.sessionId !== null && ["running", "waiting", "held"].includes(latest.state)) {
      emit(draft, { kind: "stop_node", node: id, when: "now" });
    }
    const fresh = freshRun(task, id, latest.attempt + 1, "pending", draft.event.at);
    if (id === event.to) fresh.backFrom = { node: event.node, reason: event.reason };
    task.runs.push(fresh);
  }
  return true;
}

/**
 * Applies `rerun_requested`: the user reruns a failed node.
 *
 * @remarks
 * SPEC-0006, "调度器 · 失败": the same run, session and attempt go on, and the node is told why it
 * failed. A node that failed for want of a worktree had no session; it goes back to `pending` and
 * starts as usual once the worktree is there (the spec does not say; this is the only reading that
 * works). Ignored while the task is paused, since a node must not run against the pause.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onRerunRequested(draft: Draft, event: Of<"rerun_requested">): boolean {
  const { task } = draft;
  const run = liveRun(task, event.node);
  if (run?.state !== "failed" || task.paused) return false;
  const reason = run.failure;
  run.failure = null;
  run.endedAt = null;
  run.nudged = false;
  run.pendingDone = null;
  if (run.commitPending === true) {
    // Only the commit failed: the same attempt, no new session; the node passes when the commit does.
    run.state = "running";
    emit(draft, { kind: "commit_node", node: run.node, attempt: run.attempt });
    return true;
  }
  if (run.sessionId === null) {
    run.state = "pending";
  } else {
    run.state = "running";
    emit(draft, { kind: "resume_node", node: run.node, text: resumeAfterFailure(reason) });
  }
  return true;
}

/**
 * Applies `paused`: the running nodes stop after their turn.
 *
 * @remarks
 * SPEC-0006, "暂停和恢复".
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @returns Whether it applied.
 */
function onPaused(draft: Draft): boolean {
  const { task } = draft;
  if (task.startedAt === null || task.paused) return false;
  task.paused = true;
  holdRunning(draft);
  return true;
}

/**
 * Applies `resumed`: the pause ends.
 *
 * @remarks
 * The advance after it resumes the held nodes.
 *
 * @sideEffects Changes the draft's task.
 * @param draft - The step.
 * @returns Whether it applied.
 */
function onResumed(draft: Draft): boolean {
  if (!draft.task.paused) return false;
  draft.task.paused = false;
  return true;
}

/**
 * Applies `cancelled`: the task is over.
 *
 * @remarks
 * Running nodes are stopped at once. Their states stay as they were: the task's status is
 * `cancelled` whatever they say, and SPEC-0006 does not ask for them to change.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @returns Whether it applied.
 */
function onCancelled(draft: Draft): boolean {
  const { task } = draft;
  if (task.startedAt === null) return false;
  task.cancelled = true;
  for (const { node, state } of nodeStates(task)) {
    const run = liveRun(task, node.id);
    if (run === undefined || run.sessionId === null) continue;
    if (state === "running" || (state === "waiting" && run.waitingFor === "question")) {
      emit(draft, { kind: "stop_node", node: node.id, when: "now" });
    }
  }
  endTask(draft);
  return true;
}

/**
 * Applies `workspace_created`: the worktree is there.
 *
 * @remarks
 * Locked from now on (SPEC-0006, "加锁"); the nodes that waited for it start in the advance after.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onWorkspaceCreated(draft: Draft, event: Of<"workspace_created">): boolean {
  const { task } = draft;
  if (task.workspaceState !== "creating") return false;
  task.workspaceState = "ready";
  task.workspaceId = event.workspaceId;
  task.baseCommit = event.baseCommit;
  emit(draft, { kind: "lock_workspace" });
  progress(draft, "workspace_ready");
  return true;
}

/**
 * Applies `workspace_failed`: the worktree could not be made.
 *
 * @remarks
 * Every ready node that needed it fails with `workspace` (SPEC-0006, "怎么建"). Such a node has no
 * run yet, so a failed one is made for it.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @returns Whether it applied.
 */
function onWorkspaceFailed(draft: Draft): boolean {
  const { task } = draft;
  const graph = activeGraphOf(task);
  if (task.workspaceState !== "creating" || graph === undefined) return false;
  task.workspaceState = "none";
  for (const node of graph.nodes) {
    if (node.kind !== "agent" || stateOf(task, node.id) !== "pending") continue;
    if (!upstreamOf(graph, node.id).every((upstream) => stateOf(task, upstream) === "passed")) continue;
    if (placeOf(node) !== "workspace") continue;
    const existing = liveRun(task, node.id);
    const run = existing ?? freshRun(task, node.id, latestRun(task, node.id)?.attempt ?? 1, "pending", draft.event.at);
    if (existing === undefined) task.runs.push(run);
    failRun(draft, run, "workspace");
  }
  return true;
}

/**
 * Passes a writing node whose commit is settled.
 *
 * @remarks
 * SPEC-0006, "结束" 4: the node passes only now, so a successor starts on top of its commit.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @param run - The node's run, `running` with its commit pending.
 */
function passCommitted(draft: Draft, run: NodeRun): void {
  delete run.commitPending;
  run.state = "passed";
  run.endedAt = draft.event.at;
  progress(draft, "node_passed", run.node);
}

/**
 * Applies `committed`: the commit the node's changes went into; the node passes.
 *
 * @remarks
 * Ignored unless the node is waiting for its commit (a repeat, or a late one).
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onCommitted(draft: Draft, event: Of<"committed">): boolean {
  const run = liveAttempt(draft.task, event);
  if (run?.state !== "running" || run.commitPending !== true) return false;
  run.commit = event.commit;
  passCommitted(draft, run);
  return true;
}

/**
 * Applies `commit_checked`: the node changed nothing, so there was nothing to commit; the node passes.
 *
 * @remarks
 * SPEC-0006, "动作要幂等": tells "checked, nothing to commit" from "not done yet".
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onCommitChecked(draft: Draft, event: Of<"commit_checked">): boolean {
  const run = liveAttempt(draft.task, event);
  if (run?.state !== "running" || run.commitPending !== true) return false;
  passCommitted(draft, run);
  return true;
}

/**
 * Applies `commit_failed`: git could not stage or commit the node's work; the node fails with `commit`.
 *
 * @remarks
 * SPEC-0006, "失败": the task stops like for any failure and nothing after the node starts; the mark stays,
 * so a rerun retries only the commit.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onCommitFailed(draft: Draft, event: Of<"commit_failed">): boolean {
  const run = liveAttempt(draft.task, event);
  if (run?.state !== "running" || run.commitPending !== true) return false;
  failRun(draft, run, "commit");
  return true;
}

/**
 * Applies `contract_sent`: the node's first message was handed to its pi.
 *
 * @remarks
 * Until then a node that is started again is sent the contract, not a line about carrying on.
 *
 * @sideEffects Changes the draft's task.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onContractSent(draft: Draft, event: Of<"contract_sent">): boolean {
  const run = liveAttempt(draft.task, event);
  if (run === undefined || run.sessionId === null || run.contractSent === true) return false;
  run.contractSent = true;
  return true;
}

/**
 * Applies `merged`: the branch is merged and the closing human node passes.
 *
 * @remarks
 * SPEC-0006, "合并" 5.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onMerged(draft: Draft, event: Of<"merged">): boolean {
  const run = liveRun(draft.task, event.node);
  if (run?.merging !== true) return false;
  delete run.merging;
  run.state = "passed";
  run.waitingFor = null;
  run.blocked = null;
  run.endedAt = draft.event.at;
  progress(draft, "merged", event.node);
  progress(draft, "node_passed", event.node);
  return true;
}

/**
 * Applies `merge_blocked`: the merge could not be done.
 *
 * @remarks
 * SPEC-0006, "合并": not a failure; the node waits for the user, who fixes things and passes again.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @param event - The event.
 * @returns Whether it applied.
 */
function onMergeBlocked(draft: Draft, event: Of<"merge_blocked">): boolean {
  const run = liveRun(draft.task, event.node);
  if (run?.merging !== true) return false;
  delete run.merging;
  run.state = "waiting";
  run.waitingFor = "merge_blocked";
  run.blocked = event.reason;
  if (event.files === undefined) delete run.blockedFiles;
  else run.blockedFiles = event.files.slice(0, MAX_CONFLICT_FILES);
  notify(draft, { kind: "merge_blocked", node: event.node, reason: event.reason });
  return true;
}

/**
 * Applies `host_restarted`: what was in the air when the host went down is picked up again.
 *
 * @remarks
 * SPEC-0006, "宿主重启" 2. A running node's pi is gone: it resumes (or, if the task is held back, is
 * held, and told when it is really resumed: `afterRestart`). A question that was waiting is void and the node
 * resumes (held and told later, likewise). A graph change that was asked for but not yet proposed wakes the task
 * conversation again, once for all the nodes that wait. A node in `live`, one this process has spoken to since it
 * started, is left alone. A merge in flight is sent again; the runner
 * recognises a branch that is already merged. A `node_done` whose turn had already ended is settled by
 * the runner, with a `node_settled` event before this one.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @param live - The nodes this process had already spoken to, which are left as they are.
 * @returns Whether it applied (always).
 */
function onHostRestarted(draft: Draft, live: readonly string[] = []): boolean {
  const { task } = draft;
  const heldBack = isHeldBack(task);
  let woken = false;
  for (const { node } of nodeStates(task)) {
    const run = liveRun(task, node.id);
    // This process has spoken to the node since it started: the restart is no news, and a question it answered is not void.
    if (run === undefined || live.includes(node.id)) continue;
    if (run.state === "running" && run.commitPending === true) {
      // Its commit was asked for and may be lost; the action recognises a commit already made.
      emit(draft, { kind: "commit_node", node: node.id, attempt: run.attempt });
    } else if (run.state === "running") {
      run.pendingDone = null;
      if (heldBack) {
        run.state = "held";
        run.afterRestart = { ...run.afterRestart, cutOff: true };
      } else emit(draft, { kind: "resume_node", node: node.id, text: RESUME_RESTARTED });
    } else if (run.state === "waiting" && run.waitingFor === "question") {
      releaseWaiting(draft, run, RESUME_QUESTION_VOID, true);
    } else if (run.state === "waiting" && run.waitingFor === "graph_change" && task.pendingGraph === null) {
      // One wake for the lot: it names every node that waits for a graph change (the runner writes the note).
      if (!woken) emit(draft, { kind: "wake_task_conversation", text: wakeForGraphChange(node.id) });
      woken = true;
    } else if (run.merging === true) {
      emit(draft, { kind: "merge", node: node.id });
    }
  }
  return true;
}

/**
 * Applies one event to the draft.
 *
 * @remarks
 * One case per event type; an event that does not fit the state (a late one, a repeat, one the user
 * could not have caused) is ignored and returns `false`. The acknowledgements of actions whose effect
 * the scheduler already made when it sent them (`workspace_creating`, `merge_started`) and the
 * records the scheduler does not use (`archive_asked`, `created`) change nothing; `archive_answered` is taken
 * before this, in `step`.
 *
 * @sideEffects Changes the draft's task and actions.
 * @param draft - The step.
 * @returns Whether the event changed anything.
 */
function apply(draft: Draft): boolean {
  const event = draft.event;
  switch (event.type) {
    case "graph_proposed":
      return onGraphProposed(draft, event);
    case "summary_set":
      return onSummarySet(draft, event);
    case "started":
      return onStarted(draft);
    case "abandoned":
      return onAbandoned(draft);
    case "graph_approved":
      return onGraphApproved(draft);
    case "graph_rejected":
      return onGraphRejected(draft);
    case "meta_changed":
      return onMetaChanged(draft, event);
    case "schedule_set":
      return onScheduleSet(draft, event);
    case "node_started":
      return onNodeStarted(draft, event);
    case "node_waiting":
      return onNodeWaiting(draft, event);
    case "node_resumed":
      return onNodeResumed(draft, event);
    case "node_done_pending":
      return onNodeDonePending(draft, event);
    case "node_done_void":
      return onNodeDoneVoid(draft, event);
    case "node_settled":
      return onNodeSettled(draft, event);
    case "node_failed":
      return onNodeFailed(draft, event);
    case "node_stopped":
      return onNodeStopped(draft, event);
    case "node_held":
      return onNodeHeld(draft, event);
    case "human_passed":
      return onHumanPassed(draft, event);
    case "human_sent_back":
      return onHumanSentBack(draft, event);
    case "rerun_requested":
      return onRerunRequested(draft, event);
    case "paused":
      return onPaused(draft);
    case "resumed":
      return onResumed(draft);
    case "cancelled":
      return onCancelled(draft);
    case "workspace_created":
      return onWorkspaceCreated(draft, event);
    case "workspace_failed":
      return onWorkspaceFailed(draft);
    case "committed":
      return onCommitted(draft, event);
    case "commit_checked":
      return onCommitChecked(draft, event);
    case "commit_failed":
      return onCommitFailed(draft, event);
    case "contract_sent":
      return onContractSent(draft, event);
    case "merged":
      return onMerged(draft, event);
    case "merge_blocked":
      return onMergeBlocked(draft, event);
    case "host_restarted":
      return onHostRestarted(draft, event.live);
    case "created":
    case "workspace_creating":
    case "merge_started":
    case "archive_asked":
    case "archive_answered":
      return false;
  }
  return false;
}

/**
 * Applies `archive_answered`: what the user decided about the worktree the task made.
 *
 * @remarks
 * SPEC-0006, "归档" and "T5 定下的细节". It comes after the task ended, which `step` otherwise ignores
 * altogether, so it is the one event taken then. "Keep" closes the question for now; "archive" is taken
 * after "keep" too (the worktree can be archived later), and nothing is taken after "archive". The scheduler
 * does not archive: the service does that first and records this when it worked.
 *
 * @sideEffects none
 * @param task - The task as it is.
 * @param event - The event.
 * @returns The task after the event, or the same task when the answer does not fit.
 */
function answerArchive(task: Task, event: Of<"archive_answered">): StepResult {
  const open = task.archive === "asked" || (task.archive === "kept" && event.answer === "archive");
  if (!open) return { task, actions: [] };
  return { task: { ...task, archive: event.answer === "archive" ? "archived" : "kept" }, actions: [] };
}

/**
 * Moves a task one event forward: the new task and what the runner must do.
 *
 * @remarks
 * SPEC-0006, "调度器". Pure: the task passed in is not touched, time comes from the event, nothing
 * is read or written. State changes when an action is sent, not when its result arrives, so a second
 * event arriving before the result cannot send it again. An event that does not fit is ignored and the
 * same task comes back with no actions. A finished task (done or cancelled) takes no more events, but the
 * answer about archiving its worktree;
 * a writing node passes, and so can end the task, only when its commit is settled. After an event applies, the
 * task is advanced (resume held nodes, open human nodes, start ready ones) and finished if every end node has passed.
 *
 * @sideEffects none
 * @param task - The task as it is.
 * @param event - The event, with its `seq` and `at`.
 * @returns The task after the event and the actions, in the order they must be carried out.
 */
export function step(task: Task, event: TaskEvent): StepResult {
  if (event.type === "archive_answered") return answerArchive(task, event);
  if (task.cancelled) return { task, actions: [] };
  const draft: Draft = { task: structuredClone(task), actions: [], event, lines: 0 };
  if (task.endedAt !== null) return { task, actions: [] };
  if (!apply(draft)) return { task, actions: [] };
  advance(draft);
  return { task: draft.task, actions: draft.actions };
}
