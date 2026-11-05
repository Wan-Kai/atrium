import { type ResumeKind, readTaskRequest, taskCommandText } from "@atrium/pi";
import type { Clock } from "../platform/clock";
import type { GitRunner } from "../platform/git";
import type { Logger } from "../platform/logger";
import type { ResourceTracker } from "../platform/resources";
import type { TaskSessionSignal, TaskSessions } from "../sessions/task-sessions";
import { type Caller, checkCall, replyText } from "./channel";
import { commitSubject, commitWork, trailerValue } from "./commit";
import { buildContract, graphChangedText } from "./contract";
import { activeGraphOf, liveRun, placeOf, runAt } from "./graph";
import { JUDGE_START, type JudgeState, type Ending, judge } from "./judge";
import type { TaskWorkspaces } from "./node-ports";
import { RESUME_GRAPH_APPROVED, RESUME_GRAPH_REJECTED, RESUME_RESTARTED } from "./texts";
import type { TaskStore } from "./task-store";
import type { Action, GraphNode, NodeId, NodeRun, Task, TaskEvent, TaskEventInput } from "./types";

/** What the runner is made of. */
export interface TaskRunnerOptions {
  readonly sessions: TaskSessions;
  readonly workspaces: TaskWorkspaces;
  readonly git: Promise<GitRunner | null>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly resources: ResourceTracker;
}

/** Carries out what the scheduler asks, and turns what happens into events (SPEC-0006, "调度器"). */
export interface TaskRunner {
  /** Starts looking after a task whose store is open; the task's first event may not be recorded yet. */
  attach(taskId: string, store: TaskStore): void;
  /**
   * Records an event and carries out the actions it brings, after the events before it.
   *
   * @remarks
   * One task's events go one at a time: an event's `step` and the actions it produces are done before the next
   * event is taken (SPEC-0006, "调度器").
   */
  submit(taskId: string, input: TaskEventInput): Promise<Task>;
  /** The task as it is. */
  task(taskId: string): Task | undefined;
  /**
   * Picks a task up after the host restarted, doing again what was lost and telling the scheduler.
   *
   * @remarks
   * SPEC-0006, "宿主重启": events were written before their actions were carried out, so a crash can lose the
   * actions. Those recognised by what the task's own record shows (a worktree that was being made, a node
   * that was starting, a finished node whose commit is missing) are done again, each by its idempotent
   * rule, then `host_restarted` goes to the scheduler. The rest of the restart (a `node_done` whose turn had
   * ended before the restart, T9) is not done here: such a node is told to look at its work and call
   * `node_done` again.
   */
  recover(taskId: string): Promise<void>;
  /** Calls `listener` after every event is recorded; returns a function that stops it. */
  onEvent(listener: (task: Task, event: TaskEvent, actions: readonly Action[]) => void): () => void;
  /** Resolves once every task's queue and every reply under way is done. */
  idle(): Promise<void>;
  /** Stops listening and calls off what is under way; resolves once nothing runs for it. */
  close(): Promise<void>;
}

/** What the runner remembers of one node's session. */
interface NodeContext extends Caller {
  readonly taskId: string;
  /** Which start of pi the judge's state is about. */
  epoch: number;
  judge: JudgeState;
  /** The node was asked to hold after its turn (SPEC-0006, "调度器" 失败, 暂停). */
  hold: boolean;
  /** The host stopped the session itself: its stop is not the user's. */
  killed: boolean;
  /** An `ask_user` question is open. */
  asking: boolean;
  /** The call ids already answered; the same id again is not answered twice (SPEC-0006, "T4a 定下的细节"). */
  readonly answered: Set<string>;
  /** The calls the extension gave up on. */
  readonly cancelled: Set<string>;
  /** What the node gave as the reason of the graph change it asked for. */
  graphRequest: { readonly reason: string; readonly suggestion: string } | null;
  /** The crash was already reported. */
  crashed: boolean;
}

/** One task the runner looks after. */
interface TaskEntry {
  readonly store: TaskStore;
  queue: Promise<unknown>;
}

/**
 * Which resume kind the scheduler's words stand for.
 *
 * @remarks
 * The extension puts a different note around each kind (`ResumeKind`); the host knows the words it chose.
 *
 * @sideEffects none
 * @param text - The `resume_node` action's text.
 * @returns The kind.
 */
function resumeKind(text: string): ResumeKind {
  if (text === RESUME_GRAPH_APPROVED) return "graph_changed";
  if (text === RESUME_GRAPH_REJECTED) return "graph_rejected";
  if (text === RESUME_RESTARTED) return "restarted";
  return "continue";
}

/**
 * Turns a node's end into the event the scheduler takes.
 *
 * @remarks
 * SPEC-0006, "结束" and "失败": a standing `node_done` settles the node; a standing graph-change request puts it
 * to wait; a turn that ended with nothing that stands is `node_settled` too (the scheduler reminds the node
 * once, then fails it with `no_done`), or `node_held` when the node was asked to hold; a stop the user made
 * is `node_stopped`, one the host made nothing; an error pi did not get over is `model_error`.
 *
 * @sideEffects none
 * @param ending - How it ended.
 * @param context - The node's session.
 * @returns The event, or `null` for none.
 */
function eventOf(ending: Ending, context: NodeContext): TaskEventInput | null {
  const run = { node: context.node, attempt: context.attempt };
  switch (ending.kind) {
    case "done":
      return { type: "node_settled", ...run };
    case "graph_change":
      return { type: "node_waiting", ...run, waitingFor: "graph_change" };
    case "none":
      return context.hold ? { type: "node_held", ...run } : { type: "node_settled", ...run };
    case "stopped":
      return context.killed ? null : { type: "node_stopped", ...run };
    case "error":
      return { type: "node_failed", ...run, reason: "model_error" };
    default:
      return null;
  }
}

/**
 * Creates the task runner.
 *
 * @remarks
 * SPEC-0006, "调度器" and "一个 agent 节点怎么跑": every task has a serial queue; `step` (inside the store's
 * `record`) is pure and this carries out its actions, each recognising work done before (a session by its
 * record, a commit by its trailer, a worktree by the workspace port), and turns what happens into events
 * that go back through the queue. Of the actions, `merge`, `ask_archive`, `progress_line`, `notify` and
 * `wake_task_conversation` belong to later steps (T5, T6): they are only logged. A node's session is read
 * through the judge (`judge.ts`), which decides from pi's events whether a `node_done` stands.
 *
 * @sideEffects none until a task is attached; then it listens to the sessions of tasks, starts and stops
 * them, runs git in worktrees and writes the task's events. Counted as a `task.runner` resource until closed.
 * @param options - The sessions, workspaces, git, clock, logger and resource tracker.
 * @returns The runner.
 */
export function createTaskRunner(options: TaskRunnerOptions): TaskRunner {
  const { sessions, workspaces, logger } = options;
  const tasks = new Map<string, TaskEntry>();
  const contexts = new Map<string, NodeContext>();
  const background = new Set<Promise<unknown>>();
  const closing = new AbortController();
  const release = options.resources.acquire("task.runner");
  const listeners = new Set<(task: Task, event: TaskEvent, actions: readonly Action[]) => void>();

  /**
   * Keeps a promise in sight so `idle` and `close` wait for it, and logs how it fails.
   *
   * @remarks
   * No dangling promise (coding-standards.md, "异步与取消").
   *
   * @sideEffects Logs a failure.
   * @param work - What is under way.
   * @param what - What it is, for the log.
   */
  function track(work: Promise<unknown>, what: string): void {
    const kept = work.catch((error: unknown) => {
      logger.warn({ err: error instanceof Error ? error.name : "unknown" }, `task runner: ${what} failed`);
    });
    background.add(kept);
    void kept.finally(() => background.delete(kept));
  }

  /**
   * The node context of a session, made from its record the first time.
   *
   * @remarks
   * The caller is found by the session, never by what a request says.
   *
   * @sideEffects Remembers the context.
   * @param sessionId - The session.
   * @returns The context, or `undefined` for a session that is no node's.
   */
  function contextOf(sessionId: string): NodeContext | undefined {
    const known = contexts.get(sessionId);
    if (known !== undefined) return known;
    const record = sessions.recordOf(sessionId);
    if (record?.role !== "node" || record.node === undefined || record.attempt === undefined) return undefined;
    const made: NodeContext = {
      sessionId,
      taskId: record.taskId,
      node: record.node,
      attempt: record.attempt,
      epoch: 0,
      judge: JUDGE_START,
      hold: false,
      killed: false,
      asking: false,
      answered: new Set(),
      cancelled: new Set(),
      graphRequest: null,
      crashed: false,
    };
    contexts.set(sessionId, made);
    return made;
  }

  /**
   * Sends pi a hidden command in the background.
   *
   * @remarks
   * A pi that has gone is no failure of the runner; it is logged.
   *
   * @sideEffects Calls the session; may log.
   * @param sessionId - The session.
   * @param text - The command.
   */
  function send(sessionId: string, text: string): void {
    track(sessions.command(sessionId, text), "command");
  }

  /**
   * Stops the pi of every node whose step is over, before anything else is done for the event.
   *
   * @remarks
   * "做完一轮就停 pi" (SPEC-0006, "结束" 4): a passed, failed or held node, or one waiting for a graph change,
   * has no more to say, and a commit must not run while its pi can still write. A node waiting for the
   * user's answer, or stopped by the user, keeps its pi.
   *
   * @sideEffects Stops pi.
   * @param task - The task.
   */
  async function stopFinished(task: Task): Promise<void> {
    const graph = activeGraphOf(task);
    if (graph === undefined) return;
    for (const node of graph.nodes) {
      const run = liveRun(task, node.id);
      if (run?.sessionId === null || run === undefined) continue;
      const over =
        run.state === "passed" ||
        run.state === "failed" ||
        run.state === "held" ||
        (run.state === "waiting" && run.waitingFor === "graph_change");
      if (over && sessions.alive(run.sessionId)) {
        const context = contexts.get(run.sessionId);
        if (context !== undefined) context.killed = true;
        await sessions.stop(run.sessionId);
      }
    }
  }

  /**
   * The directory a node works in.
   *
   * @remarks
   * SPEC-0006, "一个 agent 节点怎么跑 · 起": the task's worktree for `workspace`, and for `readonly` too once
   * it exists; before, the source directory.
   *
   * @sideEffects none
   * @param task - The task.
   * @param node - The node.
   * @returns The directory, or `undefined` when the worktree is wanted and unknown.
   */
  function directoryOf(task: Task, node: GraphNode): string | undefined {
    const wanted = placeOf(node) === "workspace" || task.workspaceState === "ready";
    if (!wanted) return task.sourceDir;
    return task.workspaceId === null ? undefined : workspaces.dirOf(task.workspaceId);
  }

  /**
   * The git runner.
   *
   * @remarks
   * Without git there is no worktree, no start commit and no commit.
   *
   * @sideEffects none
   * @returns git.
   * @throws {Error} When the host has no git.
   */
  async function gitOf(): Promise<GitRunner> {
    const found = await options.git;
    if (found === null) throw new Error("git is not available");
    return found;
  }

  /**
   * The HEAD of a directory, if it is a repository.
   *
   * @remarks
   * A node's `startCommit` (SPEC-0006, "数据").
   *
   * @sideEffects Runs git.
   * @param cwd - The directory.
   * @returns The commit, or `null`.
   */
  async function headOf(cwd: string): Promise<string | null> {
    const head = await gitOf()
      .then((git) => git.run(["rev-parse", "--verify", "HEAD"], { cwd, signal: closing.signal }))
      .catch(() => null);
    return head?.code === 0 ? head.stdout.trim() : null;
  }

  /**
   * Records an event and carries out its actions, then the events those produce, depth first.
   *
   * @remarks
   * Runs inside the task's queue turn. The pi of nodes that have finished is stopped before the actions, so a
   * commit is made on a quiet worktree.
   *
   * @sideEffects Writes the task's files; whatever the actions do.
   * @param entry - The task.
   * @param input - The event.
   * @returns The task after the event.
   */
  async function dispatch(entry: TaskEntry, input: TaskEventInput): Promise<Task> {
    const recorded = await entry.store.record(input);
    for (const listener of listeners) {
      try {
        listener(recorded.task, recorded.event, recorded.actions);
      } catch (error) {
        logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "task event listener failed");
      }
    }
    await stopFinished(recorded.task);
    for (const action of recorded.actions) {
      if (closing.signal.aborted) break;
      await execute(entry, action, recorded.event.seq);
    }
    return entry.store.current() ?? recorded.task;
  }

  /**
   * Carries out one action.
   *
   * @remarks
   * SPEC-0006, "调度器": the actions of T4. The rest are logged with their kind only.
   *
   * @sideEffects Whatever the action does.
   * @param entry - The task.
   * @param action - The action.
   * @param seq - The `seq` of the event that produced it, for ids that stay the same when it is carried out again.
   */
  async function execute(entry: TaskEntry, action: Action, seq: number): Promise<void> {
    switch (action.kind) {
      case "ensure_workspace":
        return ensureWorkspace(entry);
      case "lock_workspace":
      case "unlock_workspace":
        return lockWorkspace(entry, action.kind === "lock_workspace");
      case "start_node":
        return startNode(entry, action.node, action.attempt);
      case "resume_node":
        return resumeNode(entry, action.node, action.text, seq);
      case "stop_node":
        return stopNode(entry, action.node, action.when);
      case "nudge_node":
        return nudgeNode(entry, action.node, seq);
      case "commit_node":
        return commitNode(entry, action.node, action.attempt);
      case "progress_line":
      case "wake_task_conversation":
      case "merge":
      case "ask_archive":
      case "notify":
        // Later steps (T5: merge, archive; T6: the task conversation) and the UI (notify) take these.
        logger.debug({ action: action.kind }, "task action left to a later step");
    }
  }

  /**
   * Makes the task's worktree.
   *
   * @remarks
   * SPEC-0006, "工作区"; a failure is `workspace_failed`, which fails the nodes waiting for it.
   *
   * @sideEffects Creates a worktree.
   * @param entry - The task.
   */
  async function ensureWorkspace(entry: TaskEntry): Promise<void> {
    const task = entry.store.current();
    if (task === null) return;
    try {
      const made = await workspaces.ensure(task, closing.signal);
      await dispatch(entry, { type: "workspace_created", ...made });
    } catch (error) {
      if (closing.signal.aborted) return;
      logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "task worktree could not be made");
      await dispatch(entry, { type: "workspace_failed" });
    }
  }

  /**
   * Locks or unlocks the task's worktree.
   *
   * @remarks
   * SPEC-0006, "加锁". A lock that fails is logged; the task goes on.
   *
   * @sideEffects Runs git.
   * @param entry - The task.
   * @param lock - Whether to lock.
   */
  async function lockWorkspace(entry: TaskEntry, lock: boolean): Promise<void> {
    const task = entry.store.current();
    if (task === null) return;
    try {
      await (lock ? workspaces.lock(task) : workspaces.unlock(task));
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.name : "unknown", lock }, "task worktree lock failed");
    }
  }

  /**
   * Fails a node that could not get a session.
   *
   * @remarks
   * SPEC-0006, "失败": a session that cannot start is `crashed`.
   *
   * @sideEffects Records the event.
   * @param entry - The task.
   * @param run - The run.
   * @param error - What went wrong, for the log.
   */
  async function sessionFailed(entry: TaskEntry, run: NodeRun, error: unknown): Promise<void> {
    if (closing.signal.aborted) return;
    logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "task node session failed");
    await dispatch(entry, { type: "node_failed", node: run.node, attempt: run.attempt, reason: "crashed" });
  }

  /**
   * Starts a node: its session, the event that records it, and the contract as the first message.
   *
   * @remarks
   * SPEC-0006, "一个 agent 节点怎么跑" and "动作要幂等": a session recorded for this node and attempt is taken
   * back, not made again; the contract goes out only if the run had no session yet. Failing to start is
   * `node_failed(crashed)`.
   *
   * @sideEffects Starts pi; sends the contract; records `node_started`.
   * @param entry - The task.
   * @param nodeId - The node.
   * @param attempt - The attempt.
   */
  async function startNode(entry: TaskEntry, nodeId: NodeId, attempt: number): Promise<void> {
    const task = entry.store.current();
    const node = task === null ? undefined : activeGraphOf(task)?.nodes.find((candidate) => candidate.id === nodeId);
    const run = task === null ? undefined : runAt(task, nodeId, attempt);
    if (task === null || node === undefined || run?.state !== "running" || run.sessionId !== null) return;
    try {
      const cwd = directoryOf(task, node);
      const container = workspaces.containerOf(task, cwd !== undefined && cwd !== task.sourceDir);
      if (cwd === undefined || container === undefined) throw new Error("no directory for the node");
      const existing = sessions.find(task.id, nodeId, attempt);
      let sessionId: string;
      if (existing === undefined) {
        const model = node.model ?? task.model;
        sessionId = await sessions.create({
          containerId: container,
          cwd,
          name: `${node.id} · ${node.name}`,
          task: {
            taskId: task.id,
            role: "node",
            node: nodeId,
            attempt,
            ...(node.role === undefined ? {} : { nodeRole: node.role }),
            startOn: {
              providerId: model.providerId,
              modelId: model.modelId,
              thinkingLevel: model.thinking ?? null,
            },
          },
        });
      } else {
        sessionId = existing;
        await sessions.open(sessionId);
      }
      contextOf(sessionId);
      await dispatch(entry, {
        type: "node_started",
        node: nodeId,
        attempt,
        sessionId,
        startCommit: await headOf(cwd),
      });
      const fresh =
        node.role === "work" &&
        task.ownsWorkspace &&
        !task.runs.some((other) => other.node !== nodeId && other.sessionId !== null);
      await sessions.prompt(sessionId, buildContract({ task, node, run, freshWorktree: fresh }));
    } catch (error) {
      await sessionFailed(entry, run, error);
    }
  }

  /**
   * Sends a node that has a session back to work.
   *
   * @remarks
   * SPEC-0006, "调度器" (rerun, held, graph change, restart): the same session goes on, its pi started again
   * if it was stopped, and told through the hidden command `resume`; the extension puts its own shell around
   * the words. After an approved graph change the words carry the new graph. Its judge starts afresh.
   *
   * @sideEffects Starts pi; sends the command.
   * @param entry - The task.
   * @param nodeId - The node.
   * @param text - What the scheduler says.
   * @param seq - The `seq` of the event that asked, which makes the command's id.
   */
  async function resumeNode(entry: TaskEntry, nodeId: NodeId, text: string, seq: number): Promise<void> {
    const task = entry.store.current();
    const run = task === null ? undefined : liveRun(task, nodeId);
    if (task === null || run?.sessionId === null || run === undefined) return;
    const { sessionId } = run;
    try {
      await sessions.open(sessionId);
      const context = contextOf(sessionId);
      if (context !== undefined) {
        context.judge = JUDGE_START;
        context.hold = false;
        context.killed = false;
        context.graphRequest = null;
      }
      const kind = resumeKind(text);
      await sessions.command(
        sessionId,
        taskCommandText("resume", {
          v: 1,
          id: `r${String(seq)}.${nodeId}`,
          kind,
          text: kind === "graph_changed" ? graphChangedText(task, nodeId) : text,
        }),
      );
    } catch (error) {
      await sessionFailed(entry, run, error);
    }
  }

  /**
   * Stops a node, now or after its turn.
   *
   * @remarks
   * SPEC-0006, "调度器": `now` ends its pi at once; `after_turn` lets the turn finish and holds the node then
   * (`node_held`, sent when the turn ends with nothing that stands), or at once if no turn is going.
   *
   * @sideEffects Stops pi; may record `node_held`.
   * @param entry - The task.
   * @param nodeId - The node.
   * @param when - When.
   */
  async function stopNode(entry: TaskEntry, nodeId: NodeId, when: "now" | "after_turn"): Promise<void> {
    const task = entry.store.current();
    const run = task === null ? undefined : liveRun(task, nodeId);
    if (run?.sessionId === null || run === undefined) return;
    const context = contextOf(run.sessionId);
    if (context === undefined) return;
    if (when === "now") {
      context.killed = true;
      await sessions.stop(run.sessionId);
      return;
    }
    context.hold = true;
    if (!context.judge.running) {
      context.hold = false;
      await dispatch(entry, { type: "node_held", node: nodeId, attempt: run.attempt });
    }
  }

  /**
   * Reminds a node to call `node_done`.
   *
   * @remarks
   * SPEC-0006, "失败" `no_done`: through the hidden command `nudge`, which opens a new turn; the command's
   * id comes from the event, so a replay does not remind twice. pi is idle: the turn has just settled.
   *
   * @sideEffects Sends the command.
   * @param entry - The task.
   * @param nodeId - The node.
   * @param seq - The `seq` of the event that asked.
   */
  async function nudgeNode(entry: TaskEntry, nodeId: NodeId, seq: number): Promise<void> {
    const task = entry.store.current();
    const run = task === null ? undefined : liveRun(task, nodeId);
    if (run?.sessionId === null || run === undefined) return;
    const context = contextOf(run.sessionId);
    if (context !== undefined) context.judge = JUDGE_START;
    try {
      await sessions.command(run.sessionId, taskCommandText("nudge", { v: 1, id: `n${String(seq)}.${nodeId}` }));
    } catch (error) {
      await sessionFailed(entry, run, error);
    }
  }

  /**
   * Commits what a writing node changed.
   *
   * @remarks
   * SPEC-0006, "结束" 4: `git add -A` and a commit with the trailer in the node's worktree; nothing changed,
   * nothing committed and no `committed` event. A commit that fails is logged and leaves the node passed with
   * its changes uncommitted in the worktree.
   *
   * @sideEffects Runs git; records `committed`.
   * @param entry - The task.
   * @param nodeId - The node.
   * @param attempt - The attempt.
   */
  async function commitNode(entry: TaskEntry, nodeId: NodeId, attempt: number): Promise<void> {
    const task = entry.store.current();
    const run = task === null ? undefined : runAt(task, nodeId, attempt);
    const node = task === null ? undefined : activeGraphOf(task)?.nodes.find((candidate) => candidate.id === nodeId);
    const dir = task?.workspaceId == null ? undefined : workspaces.dirOf(task.workspaceId);
    if (task === null || run === undefined || node === undefined || dir === undefined) return;
    try {
      const result = await commitWork(await gitOf(), dir, {
        subject: commitSubject(task.name, node.name, run.summary ?? ""),
        trailer: trailerValue(task.id, nodeId, attempt),
      });
      if (result.kind === "committed") {
        await dispatch(entry, { type: "committed", node: nodeId, attempt, commit: result.commit });
      }
    } catch (error) {
      logger.error({ err: error instanceof Error ? error.name : "unknown" }, "task node commit failed");
    }
  }

  /**
   * Puts work on a task's queue.
   *
   * @remarks
   * One at a time, in the order given; a failure is logged and does not stop the ones after.
   *
   * @sideEffects Runs `work` later.
   * @param entry - The task.
   * @param work - What to do.
   * @returns What `work` returns.
   */
  function enqueue<T>(entry: TaskEntry, work: () => Promise<T>): Promise<T> {
    const turn = entry.queue.then(work);
    entry.queue = turn.catch(() => undefined);
    return turn;
  }

  /**
   * Puts events on the node's task queue without waiting.
   *
   * @remarks
   * For what sessions tell: the order they came in is kept, and the failure is logged.
   *
   * @sideEffects As the events'.
   * @param context - The node's session.
   * @param events - The events, in order.
   */
  function submitLater(context: NodeContext, events: readonly TaskEventInput[]): void {
    const entry = tasks.get(context.taskId);
    if (entry === undefined || events.length === 0) return;
    track(
      enqueue(entry, async () => {
        for (const event of events) await dispatch(entry, event);
      }),
      "event",
    );
  }

  /**
   * Takes a request the extension made on its status line.
   *
   * @remarks
   * SPEC-0006, "扩展与通道": reads it, finds the caller by the session, checks it and answers. An accepted
   * `node_done` is recorded as pending before the answer goes (the extension ends the turn on it); an
   * accepted graph-change request waits in the judge. A note that a call was stopped drops it. The same call
   * id is answered once. Logs name the operation only.
   *
   * @sideEffects Records events; sends the reply.
   * @param context - The session it came from.
   * @param text - The status text.
   */
  async function onRequest(context: NodeContext, text: string): Promise<void> {
    const read = readTaskRequest(text);
    if ("bad" in read) {
      if (read.bad !== null && read.kind === "call" && !context.answered.has(read.bad)) {
        context.answered.add(read.bad);
        send(context.sessionId, replyText(read.bad, { ok: false, code: "task_bad_request" }));
      }
      return;
    }
    const { request } = read;
    if (request.kind === "note") {
      context.cancelled.add(request.args.id);
      return;
    }
    if (context.answered.has(request.id)) return;
    context.answered.add(request.id);
    const entry = tasks.get(context.taskId);
    if (entry === undefined) return;
    const verdict = checkCall(entry.store.current() ?? undefined, context, request);
    if (!verdict.ok) {
      logger.info({ op: request.op, code: verdict.code }, "task call refused");
      send(context.sessionId, replyText(request.id, verdict));
      return;
    }
    try {
      if (request.op === "node_done") {
        const { ok, summary, reason } = request.args;
        await enqueue(entry, () =>
          dispatch(entry, {
            type: "node_done_pending",
            node: context.node,
            attempt: context.attempt,
            ok,
            ...(summary === "" ? {} : { summary }),
            ...(reason === undefined ? {} : { reason }),
          }),
        );
        context.judge = judge(context.judge, { kind: "accepted", call: "done" }).state;
      } else {
        context.graphRequest = { reason: request.args.reason, suggestion: request.args.suggestion };
        context.judge = judge(context.judge, { kind: "accepted", call: "graph_change" }).state;
      }
      if (!context.cancelled.has(request.id)) send(context.sessionId, replyText(request.id, { ok: true }));
    } catch (error) {
      logger.warn({ op: request.op, err: error instanceof Error ? error.name : "unknown" }, "task call failed");
      send(context.sessionId, replyText(request.id, { ok: false, code: "task_failed" }));
    }
  }

  /**
   * Takes what a task session tells: a request, a pi event or a session event.
   *
   * @remarks
   * A signal from an older start of pi than the one the context knows is dropped; a newer one resets the
   * judge (a new process remembers nothing of the old one's turn). Pi events go through the judge, whose
   * verdicts become events in order. A question open or answered becomes `node_waiting` / `node_resumed`; the
   * controller giving up on a crashing pi becomes `node_failed(crashed)`.
   *
   * @sideEffects Records events later; sends replies.
   * @param sessionId - The session.
   * @param signal - What it told.
   */
  function onSignal(sessionId: string, signal: TaskSessionSignal): void {
    const context = contextOf(sessionId);
    if (context === undefined || !tasks.has(context.taskId)) return;
    if (signal.kind !== "session") {
      if (signal.epoch < context.epoch) return;
      if (signal.epoch > context.epoch) {
        context.epoch = signal.epoch;
        context.judge = JUDGE_START;
      }
    }
    const run = { node: context.node, attempt: context.attempt };
    if (signal.kind === "request") {
      track(onRequest(context, signal.text), "request");
    } else if (signal.kind === "pi") {
      const events: TaskEventInput[] = [];
      const step = judge(context.judge, { kind: "pi", event: signal.event });
      context.judge = step.state;
      for (const verdict of step.verdicts) {
        if (verdict.kind === "void") events.push({ type: "node_done_void", ...run });
        else {
          const event = eventOf(verdict.ending, context);
          if (event !== null) events.push(event);
          context.hold = false;
          context.killed = false;
        }
      }
      submitLater(context, events);
    } else if (signal.event.type === "control_updated") {
      const { question, failure } = signal.event.control;
      if (question !== null && !context.asking) {
        context.asking = true;
        submitLater(context, [{ type: "node_waiting", ...run, waitingFor: "question" }]);
      } else if (question === null && context.asking) {
        context.asking = false;
        submitLater(context, [{ type: "node_resumed", ...run }]);
      }
      if (failure?.reason === "crashed" && !context.crashed) {
        context.crashed = true;
        submitLater(context, [{ type: "node_failed", ...run, reason: "crashed" }]);
      }
    }
  }

  const unsubscribe = sessions.subscribe(onSignal);

  return {
    attach(taskId, store) {
      if (!tasks.has(taskId)) tasks.set(taskId, { store, queue: Promise.resolve() });
    },
    submit(taskId, input) {
      const entry = tasks.get(taskId);
      if (entry === undefined) return Promise.reject(new Error(`task ${taskId} is not attached`));
      return enqueue(entry, () => dispatch(entry, input));
    },
    task: (taskId) => tasks.get(taskId)?.store.current() ?? undefined,
    recover(taskId) {
      const entry = tasks.get(taskId);
      if (entry === undefined) return Promise.reject(new Error(`task ${taskId} is not attached`));
      return enqueue(entry, async () => {
        const task = entry.store.current();
        if (task === null || task.endedAt !== null || task.cancelled || task.startedAt === null) return;
        if (task.workspaceState === "creating") await ensureWorkspace(entry);
        for (const run of entry.store.current()?.runs ?? []) {
          const now = entry.store.current();
          if (now === null) return;
          if (run.state === "running" && run.sessionId === null) await startNode(entry, run.node, run.attempt);
          else if (run.state === "passed" && run.commit === null && run.void !== true) {
            if (activeGraphOf(now)?.nodes.find((node) => node.id === run.node)?.role === "work") {
              await commitNode(entry, run.node, run.attempt);
            }
          }
        }
        await dispatch(entry, { type: "host_restarted" });
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async idle() {
      do {
        await Promise.all([...tasks.values()].map((entry) => entry.queue));
        await Promise.all(background);
      } while (background.size > 0);
    },
    async close() {
      closing.abort();
      unsubscribe();
      await Promise.all([...tasks.values()].map((entry) => entry.queue));
      await Promise.all(background);
      release();
    },
  };
}
