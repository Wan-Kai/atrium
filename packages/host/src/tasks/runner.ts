import { type LogEntry, type PiEvent, type ResumeKind, readTaskRequest, taskCommandText } from "@atrium/pi";
import { quoted } from "./quote";
import type { Clock } from "../platform/clock";
import type { GitRunner } from "../platform/git";
import type { Logger } from "../platform/logger";
import type { ResourceTracker } from "../platform/resources";
import { CommandError, type ReviewRecord, type SessionEvent } from "@atrium/protocol";
import type { TaskSessionSignal, TaskSessions } from "../sessions/task-sessions";
import { type Caller, checkCall, checkConversationCall, replyText } from "./channel";
import { type Answer, type ConversationCall, answerConversation, isConversationCall } from "./conversation";
import { commitSubject, commitWork, trailerValue } from "./commit";
import { CONTRACT_OPENING, buildContract, graphChangedText } from "./contract";
import type { MergeOutcome } from "./merge";
import { activeGraphOf, liveRun, placeOf, runAt } from "./graph";
import { type Ending, JUDGE_START, type JudgeState, judge } from "./judge";
import type { TaskWorkspaces } from "./node-ports";
import { CONTINUE_NODE, RESUME_GRAPH_APPROVED, RESUME_GRAPH_REJECTED, RESUME_RESTARTED } from "./texts";
import type { TaskStore } from "./task-store";
import type { Action, GraphNode, NodeId, NodeRun, ProgressLine, Task, TaskEvent, TaskEventInput } from "./types";

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
   * event is taken (SPEC-0006, "调度器"). With `guard`, the task is checked on the queue's turn, right before the
   * event is recorded: if it throws, nothing is recorded, so a check on a state another event may change is not
   * open to a race.
   */
  submit(taskId: string, input: TaskEventInput, guard?: (task: Task) => void): Promise<Task>;
  /** The task as it is. */
  task(taskId: string): Task | undefined;
  /** Every task looked after, in the order they were attached. */
  all(): Task[];
  /**
   * Picks a task up after the host restarted, doing again what was lost and telling the scheduler.
   *
   * @remarks
   * SPEC-0006, "宿主重启" and "T9 定下的细节": events were written before their actions were carried out, so a
   * crash can lose the actions. Those recognised by what the task's own record shows (a worktree that was
   * being made, a node that was starting, a finished node whose commit is missing) are done again, each by its
   * idempotent rule. A node whose `node_done` was pending and whose turn ended before the restart (its session
   * file ends with the call's result) is settled first (`node_settled`); then `host_restarted` goes to the
   * scheduler. A task that ended gets its worktree unlocked again; one that did not, locked again.
   */
  recover(taskId: string): Promise<void>;
  /**
   * Lifts the locks tasks left on worktrees that are over, when the host starts.
   *
   * @remarks
   * SPEC-0006, "加锁" and "T9 / T10 审查后用户定": a lock this home took for a task that is done or cancelled, or whose
   * directory is gone. A task whose directory is there but that was not attached (it could not be read) may still be
   * going, so its lock stays. Call it once every task on disk has been attached, or an active task's lock is taken
   * for a stale one. Resolves to how many locks were lifted.
   *
   * @param present - The names of the task directories that exist.
   */
  clearStaleLocks(present: ReadonlySet<string>): Promise<number>;
  /**
   * Lets a node the user stopped go on: a message in its own conversation, as the user could send (SPEC-0006,
   * "节点"). The run it starts is what puts the node back to `running`.
   *
   * @remarks
   * Fails with `task_state_invalid` when the node is not `stopped` or has no session.
   */
  continueNode(taskId: string, node: NodeId): Promise<void>;
  /**
   * Writes the record of a review whose verdict took effect into the task conversation (ADR-0018, decision 2).
   *
   * @remarks
   * The hidden command `review`, which the extension writes as an `atrium-review` custom message without a model
   * call and drops when it has the id already. It goes on the task's line of conversation commands, apart from the
   * task's queue, so it follows the progress lines written before it. A task whose conversation the host did not
   * start gets nothing.
   */
  recordReview(
    taskId: string,
    line: { readonly id: string; readonly text: string; readonly record: ReviewRecord },
  ): void;
  /**
   * Forgets a task whose record was deleted (a design that was abandoned), once its queue is done.
   *
   * @remarks
   * Nothing of it is written after this; the files are the caller's to remove.
   */
  detach(taskId: string): Promise<void>;
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
  /** The crash was already reported; forgotten when the node goes on or its pi starts again. */
  crashed: boolean;
  /** When the host sent pi something that begins a turn, until the turn is seen to begin. */
  startingAt: number | null;
  /** The host starts this pi itself, so the first new epoch it sees is expected, not a crash and a restart. */
  ownStart: boolean;
}

/** How long a turn the host asked for may take to begin before a node is taken to be idle. */
const STARTING_MS = 15_000;

/** The pi events the judge reads. */
const JUDGED = new Set(["agent_start", "turn_start", "auto_retry_end", "agent_end", "agent_settled"]);

/** What the runner remembers of a task conversation's session. */
interface ConversationContext {
  readonly sessionId: string;
  readonly taskId: string;
  /** Which start of pi the newest request came from; an older one is dropped. */
  epoch: number;
  /** The call ids already answered; the same id again is not answered twice. */
  readonly answered: Set<string>;
  /** The calls the extension gave up on. */
  readonly cancelled: Set<string>;
}

/** One task the runner looks after. */
interface TaskEntry {
  readonly store: TaskStore;
  queue: Promise<unknown>;
  /** The lines and wake-ups for the task conversation, one after the other, apart from the task's queue. */
  lines: Promise<unknown>;
  /**
   * The sessions of the task's nodes this process has spoken to (contract, resume, continue, nudge, an answered
   * question), until `recover` has used them.
   *
   * @remarks
   * `host_restarted` is news to a node only if nothing of this process reached it before: a user who answered first, or
   * a node the recovery itself started, must not hear that the host restarted. `recover` hands the nodes among them
   * to the event (`live`) and drops the set, which is how it stays small (SPEC-0006, "T9 / T10 审查后用户定").
   */
  spoken: Set<string> | undefined;
}

/** The longest a node's suggestion for a graph change may be in the note that wakes the task conversation. */
const WAKE_SUGGESTION_CHARS = 12_000;

/**
 * The words of a progress line, for the model that reads the task conversation's context.
 *
 * @remarks
 * The user sees what the UI draws from the line's `what` and `node`; this is plain.
 *
 * @sideEffects none
 * @param line - The line.
 * @returns The text.
 */
function progressText(line: ProgressLine): string {
  return `Atrium task event: ${line.kind}${line.node === undefined ? "" : ` ${line.node}`}`;
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
      return {
        type: "node_waiting",
        ...run,
        waitingFor: "graph_change",
        ...(context.graphRequest === null ? {} : { request: context.graphRequest }),
      };
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
 * Whether a node's worktree is new: it is the first writing node to have a session in it.
 *
 * @remarks
 * SPEC-0006, "第一条消息：契约": "no work node has had a session in this worktree yet", so a work node after an
 * `explore` still gets the line, and a single work node's second attempt does not.
 *
 * @sideEffects none
 * @param task - The task.
 * @param node - The node.
 * @param run - Its run.
 * @returns Whether to tell the node the worktree has no dependencies yet.
 */
function freshWorktreeFor(task: Task, node: GraphNode, run: NodeRun): boolean {
  if (node.role !== "work" || !task.ownsWorkspace) return false;
  const known = task.graphs.flatMap((graph) => graph.nodes);
  return !task.runs.some(
    (other) =>
      !(other.node === run.node && other.attempt === run.attempt) &&
      other.sessionId !== null &&
      known.find((candidate) => candidate.id === other.node)?.role === "work",
  );
}

/**
 * The last message of a session's file: what was said last, leaving out the entries that say nothing.
 *
 * @remarks
 * A file can end in entries the transcript does not show (labels, model changes); the turn's end is read from the
 * last user, assistant or tool-result message.
 *
 * @sideEffects none
 * @param entries - The session's entries, in file order.
 * @returns The last message, or `undefined` for a file with none.
 */
function lastMessage(entries: readonly LogEntry[]): LogEntry | undefined {
  return entries.findLast(
    (entry) => entry.kind === "user" || entry.kind === "assistant" || entry.kind === "toolResult",
  );
}

/**
 * Whether a session's file ends with a `node_done` that the host accepted, the result that ended the turn.
 *
 * @remarks
 * SPEC-0006, "T9 定下的细节": the extension answers an accepted call with a result that has `terminate`, so pi
 * asks the model for nothing after it and it is the last thing in the file. A refused call is an error result and
 * the model goes on; anything written after the result means the turn went on. Every tool call of the assistant
 * message that made the call must have its result, not only `node_done`: a message whose other calls were cut off by
 * the restart did not finish its turn (SPEC-0006, "T9 / T10 审查后用户定").
 *
 * @sideEffects none
 * @param entries - The session's entries, in file order.
 * @returns Whether the node's turn ended on its `node_done`.
 */
function endedOnNodeDone(entries: readonly LogEntry[]): boolean {
  const last = lastMessage(entries);
  if (last?.kind !== "toolResult" || last.tool !== "node_done" || last.isError) return false;
  const at = entries.findLastIndex((entry) => entry.kind === "assistant");
  const assistant = entries[at];
  if (assistant?.kind !== "assistant") return false;
  const answered = new Set(
    entries.slice(at + 1).flatMap((entry) => (entry.kind === "toolResult" ? [entry.callId] : [])),
  );
  const calls = assistant.parts.flatMap((part) => (part.type === "toolCall" ? [part.callId] : []));
  return calls.includes(last.callId) && calls.every((callId) => answered.has(callId));
}

/**
 * Whether a session's file already begins with the node's contract.
 *
 * @remarks
 * The first user message of a node's session is its contract (SPEC-0006, "第一条消息：契约"). pi writes the file
 * with the first reply, so a contract that reached pi but not its reply is not on file, and is sent again.
 *
 * @sideEffects none
 * @param entries - The session's entries, in file order.
 * @returns Whether it does.
 */
function beginsWithContract(entries: readonly LogEntry[]): boolean {
  const first = entries.find((entry) => entry.kind === "user");
  return first?.kind === "user" && first.text.startsWith(CONTRACT_OPENING);
}

/** The most characters the note that wakes the task conversation may have: under the command's 32 000, with room for the shell. */
const WAKE_LIMIT = 30_000;

/** The marker where a request's words were cut short. */
const CUT = "…（已截断）";

/**
 * The note that wakes the task conversation, within what the command takes.
 *
 * @remarks
 * SPEC-0006, "T9 / T10 审查后用户定": the nodes waiting for a graph change each bring a reason (up to 4 000) and a
 * suggestion (up to 32 000), quoted. The whole note, wrappers and escapes counted, must stay within what
 * `/atrium-task resume` takes, or the extension refuses it and the conversation is never woken. So the suggestions
 * are cut to a share each, a smaller one until it fits, with a marker where they were cut; if even the reasons do not
 * fit, only the nodes are named, and the model reads the rest with `task_status`.
 *
 * @sideEffects none
 * @param text - What the scheduler says.
 * @param asking - The nodes waiting for a graph change, with what they wrote (nothing if it was lost).
 * @returns The note, at most `WAKE_LIMIT` characters.
 */
function wakeWords(
  text: string,
  asking: readonly { readonly id: string; readonly label: string; readonly request: NodeRun["graphRequest"] }[],
): string {
  const tail =
    "先用 task_status 看现状，想清楚新图，再用 task_propose_graph 提交。新图要等用户批准才生效；提交后用一两句话告诉用户改了什么、为什么。";
  /**
   * Composes the note with each suggestion cut to `share` characters (`null`: the words left out altogether).
   *
   * @remarks
   * One composition per share the loop below tries, so the same pieces are put together again, smaller.
   *
   * @sideEffects none
   * @param share - The most characters of each suggestion, or `null`.
   * @returns The note.
   */
  const compose = (share: number | null): string =>
    [
      text,
      ...asking.flatMap((one) => {
        if (one.request === undefined) return [`节点 ${one.id} 申请改图。`];
        if (share === null) return [`节点 ${one.id} 申请改图（理由和建议太长，已省略；用 task_status 看现状）。`];
        const suggestion = one.request.suggestion;
        const kept = suggestion.length > share ? `${suggestion.slice(0, share)}${CUT}` : suggestion;
        return [
          `节点 ${one.id} 申请改图。`,
          `理由：${quoted(one.label, one.request.reason)}`,
          `它的建议：${quoted(one.label, kept)}`,
        ];
      }),
      tail,
    ].join("\n");
  const base = Math.min(WAKE_SUGGESTION_CHARS, Math.floor(WAKE_LIMIT / Math.max(1, asking.length)));
  for (let share = base; share >= 100; share = Math.floor(share / 2)) {
    const words = compose(share);
    if (words.length <= WAKE_LIMIT) return words;
  }
  return compose(null);
}

/**
 * Creates the task runner.
 *
 * @remarks
 * SPEC-0006, "调度器" and "一个 agent 节点怎么跑": every task has a serial queue; `step` (inside the store's
 * `record`) is pure and this carries out its actions, each recognising work done before (a session by its
 * record, a commit by its trailer, a worktree by the workspace port), and turns what happens into events
 * that go back through the queue. Of the actions, `progress_line` and `wake_task_conversation` go to the task
 * conversation (T6); `notify` belongs to the UI (T7) and `ask_archive` is a state of the task (`archive`): they are
 * only logged. The calls of the task conversation's tools are answered here too (`conversation.ts`). A node's session is read
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
  const conversations = new Map<string, ConversationContext>();
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
      startingAt: null,
      ownStart: false,
    };
    contexts.set(sessionId, made);
    return made;
  }

  /**
   * Notes that the host has just asked pi for a turn.
   *
   * @remarks
   * Until `agent_start` the judge sees an idle pi; a stop after the turn asked for in that window must wait
   * for the turn, not cut it (the node is `starting`).
   *
   * @sideEffects Resets the judge.
   * @param context - The node's session.
   */
  function expectTurn(context: NodeContext): void {
    context.judge = JUDGE_START;
    context.startingAt = options.clock.now();
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
        (run.state === "waiting" && run.waitingFor === "graph_change") ||
        (run.state === "running" && run.commitPending === true);
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
   * The entries of a session's file, or none when it cannot be read.
   *
   * @remarks
   * Read to tell what happened before a restart; a file that is not there or is damaged tells nothing, which the
   * callers take as "pi never wrote it". Logs the error's name only.
   *
   * @sideEffects Reads the file; may log.
   * @param sessionId - The session.
   * @returns The entries, in file order.
   */
  async function entriesOf(sessionId: string): Promise<LogEntry[]> {
    return sessions.transcript(sessionId).catch((error: unknown) => {
      logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "task node session file not read");
      // Stryker disable next-line ArrayDeclaration: one entry that is no message reads like a file with none.
      return [];
    });
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
    // Stryker disable next-line all: only frees memory; a session of an ended task is let go of, and its late signals are dropped.
    if (recorded.task.endedAt !== null) {
      for (const run of recorded.task.runs) if (run.sessionId !== null) contexts.delete(run.sessionId);
    }
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
   * SPEC-0006, "调度器": the actions of T4 and the merge (T5). The rest are logged with their kind only.
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
      case "merge":
        return mergeNode(entry, action.node);
      case "progress_line":
        return writeProgress(entry, action.line);
      case "wake_task_conversation":
        return wakeConversation(entry, action.text, seq);
      case "ask_archive":
      case "notify":
        // The question about archiving is the task's own state (`archive`, T5); the UI (T7) takes `notify`.
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
      // A host that is closing leaves the worktree it made for the next start to find (`workspace.json`).
      if (closing.signal.aborted) return;
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
   * Hands a node its contract as the first message, and records that it went.
   *
   * @remarks
   * SPEC-0006, "动作要幂等": `node_started` is recorded before this, so a node whose prompt failed, or whose host
   * died in between, has a session and no `contract_sent`; whatever would be sent it next is this instead. If the
   * session's file already begins with the contract, the host died after pi took it: it is recorded as sent and
   * not sent a second time (T9).
   *
   * @sideEffects Reads the session's file; sends the prompt; records `contract_sent`.
   * @param entry - The task.
   * @param nodeId - The node.
   * @returns Whether the contract was on the session's file already, so that nothing was sent.
   * @throws {Error} When pi does not take the prompt.
   */
  async function deliverContract(entry: TaskEntry, nodeId: NodeId): Promise<boolean> {
    const task = entry.store.current();
    const node = task === null ? undefined : activeGraphOf(task)?.nodes.find((candidate) => candidate.id === nodeId);
    const run = task === null ? undefined : liveRun(task, nodeId);
    if (task === null || node === undefined || run?.sessionId == null) return false;
    if (beginsWithContract(await entriesOf(run.sessionId))) {
      await dispatch(entry, { type: "contract_sent", node: nodeId, attempt: run.attempt });
      return true;
    }
    const context = contextOf(run.sessionId);
    if (context !== undefined) expectTurn(context);
    await sessions.prompt(
      run.sessionId,
      buildContract({ task, node, run, freshWorktree: freshWorktreeFor(task, node, run) }),
      closing.signal,
    );
    entry.spoken?.add(run.sessionId);
    await dispatch(entry, { type: "contract_sent", node: nodeId, attempt: run.attempt });
    return false;
  }

  /**
   * Starts a node: its session, the event that records it, and the contract as the first message.
   *
   * @remarks
   * SPEC-0006, "一个 agent 节点怎么跑" and "动作要幂等": a session recorded for this node and attempt is taken
   * back, not made again; the contract goes out unless `contract_sent` says it did or the session's file already
   * begins with it. Failing to start is `node_failed(crashed)`.
   *
   * @sideEffects Starts pi; sends the contract; records `node_started` and `contract_sent`.
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
      const context = contextOf(sessionId);
      if (context !== undefined) context.ownStart = true;
      await dispatch(entry, {
        type: "node_started",
        node: nodeId,
        attempt,
        sessionId,
        startCommit: await headOf(cwd),
      });
      await deliverContract(entry, nodeId);
    } catch (error) {
      await sessionFailed(entry, run, error);
    }
  }

  /**
   * Tells a node that has a session to go on: the contract if it never got it, else a line.
   *
   * @remarks
   * The hidden command `resume`, whose shell the extension puts around the words. After an approved graph
   * change the words carry the new graph. A node that never received its contract is sent the contract
   * instead: carrying on is a line about something it has not seen. A contract found on the session's file
   * (the host died before recording it) is recorded as sent, and the line goes as for any node.
   *
   * @sideEffects Reads the session's file; sends a prompt or the command; may record `contract_sent`.
   * @param entry - The task.
   * @param nodeId - The node.
   * @param text - What the scheduler says.
   * @param id - The command's id, which stays the same when the same reason sends it again.
   * @throws {Error} When pi does not take it.
   */
  async function sendBack(entry: TaskEntry, nodeId: NodeId, text: string, id: string): Promise<void> {
    const task = entry.store.current();
    const run = task === null ? undefined : liveRun(task, nodeId);
    if (task === null || run?.sessionId == null) return;
    if (run.contractSent !== true) {
      // If the contract is on file already (the host died after pi took it), it is recorded and the line is due.
      if (!(await deliverContract(entry, nodeId))) return;
    }
    const context = contextOf(run.sessionId);
    if (context !== undefined) expectTurn(context);
    const kind = resumeKind(text);
    await sessions.command(
      run.sessionId,
      taskCommandText("resume", {
        v: 1,
        id,
        kind,
        text: kind === "graph_changed" ? graphChangedText(task, nodeId) : text,
      }),
      closing.signal,
    );
  }

  /**
   * Sends a node that has a session back to work.
   *
   * @remarks
   * SPEC-0006, "调度器" (rerun, held, graph change, restart): the same session goes on, its pi started again
   * if it was stopped. Its judge starts afresh.
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
    if (task === null || run?.sessionId == null) return;
    const { sessionId } = run;
    entry.spoken?.add(sessionId);
    try {
      const context = contextOf(sessionId);
      if (context !== undefined) {
        context.judge = JUDGE_START;
        context.hold = false;
        context.killed = false;
        context.graphRequest = null;
        context.crashed = false;
        context.startingAt = null;
        context.ownStart = true;
      }
      await sessions.open(sessionId);
      await sendBack(entry, nodeId, text, `r${String(seq)}.${nodeId}`);
    } catch (error) {
      await sessionFailed(entry, run, error);
    }
  }

  /**
   * Stops a node, now or after its turn.
   *
   * @remarks
   * SPEC-0006, "调度器": `now` ends its pi at once; `after_turn` lets the turn finish and holds the node then
   * (`node_held`, sent when the turn ends with nothing that stands), or at once if no turn is going and none
   * is about to begin. Runs inside the task's queue, like the judge's steps, so it never reads a judge state
   * that a turn already settled in the queue ahead of it would change.
   *
   * @sideEffects Stops pi; may record `node_held`.
   * @param entry - The task.
   * @param nodeId - The node.
   * @param when - When.
   */
  async function stopNode(entry: TaskEntry, nodeId: NodeId, when: "now" | "after_turn"): Promise<void> {
    const task = entry.store.current();
    const run = task === null ? undefined : liveRun(task, nodeId);
    if (run?.sessionId == null) return;
    const context = contextOf(run.sessionId);
    if (context === undefined) return;
    if (when === "now") {
      context.killed = true;
      await sessions.stop(run.sessionId);
      return;
    }
    context.hold = true;
    const starting = context.startingAt !== null && options.clock.now() - context.startingAt < STARTING_MS;
    if (!context.judge.running && context.judge.pending === null && !starting) {
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
    if (run?.sessionId == null) return;
    const context = contextOf(run.sessionId);
    if (context !== undefined) expectTurn(context);
    entry.spoken?.add(run.sessionId);
    try {
      await sessions.command(
        run.sessionId,
        taskCommandText("nudge", { v: 1, id: `n${String(seq)}.${nodeId}` }),
        closing.signal,
      );
    } catch (error) {
      await sessionFailed(entry, run, error);
    }
  }

  /**
   * Commits what a writing node changed, and settles the node's commit.
   *
   * @remarks
   * SPEC-0006, "结束" 4 and "动作要幂等": `git add -A` and a commit with the trailer in the node's worktree.
   * Committed is `committed`; nothing changed is `commit_checked` (so "nothing to commit" is told from "not
   * done yet"); git failing is `commit_failed`, which fails the node with `commit` (a rerun retries just this).
   * Only the one run the action names is committed.
   *
   * @sideEffects Runs git; records `committed`, `commit_checked` or `commit_failed`.
   * @param entry - The task.
   * @param nodeId - The node.
   * @param attempt - The attempt.
   */
  async function commitNode(entry: TaskEntry, nodeId: NodeId, attempt: number): Promise<void> {
    const task = entry.store.current();
    const run = task === null ? undefined : runAt(task, nodeId, attempt);
    const node = task === null ? undefined : activeGraphOf(task)?.nodes.find((candidate) => candidate.id === nodeId);
    if (task === null || run?.commitPending !== true || node === undefined) return;
    const ref = { node: nodeId, attempt };
    try {
      const dir = task.workspaceId === null ? undefined : workspaces.dirOf(task.workspaceId);
      if (dir === undefined) throw new Error("the task has no worktree");
      const result = await commitWork(await gitOf(), dir, {
        subject: commitSubject(task.name, node.name, run.summary ?? ""),
        trailer: trailerValue(task.id, nodeId, attempt),
      });
      await dispatch(
        entry,
        result.kind === "committed"
          ? { type: "committed", ...ref, commit: result.commit }
          : { type: "commit_checked", ...ref },
      );
    } catch (error) {
      if (closing.signal.aborted) return;
      logger.error({ err: error instanceof Error ? error.name : "unknown" }, "task node commit failed");
      await dispatch(entry, { type: "commit_failed", ...ref });
    }
  }

  /**
   * Merges the task's branch for a closing human node that was passed.
   *
   * @remarks
   * SPEC-0006, "合并": the worktree port does the checks and the merge; `merged` passes the node, anything
   * blocking it is `merge_blocked` with the reason (and the conflicting files), and the node waits for another
   * "pass". A merge that throws (no worktree, no git) is `merge_git_failed`, so the node is never left
   * merging. A host that is closing records nothing: the node is still `merging`, and `host_restarted` sends the
   * merge again, which recognises one that was done.
   *
   * @sideEffects Runs git in the main checkout; records `merged` or `merge_blocked`.
   * @param entry - The task.
   * @param nodeId - The human node.
   */
  async function mergeNode(entry: TaskEntry, nodeId: NodeId): Promise<void> {
    const task = entry.store.current();
    if (task === null || liveRun(task, nodeId)?.merging !== true) return;
    let outcome: MergeOutcome;
    try {
      outcome = await workspaces.merge(task, closing.signal);
    } catch (error) {
      if (closing.signal.aborted) return;
      logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "task merge could not be made");
      outcome = { kind: "blocked", reason: "merge_git_failed" };
    }
    if (outcome.kind === "merged") {
      logger.info("task branch merged");
      await dispatch(entry, { type: "merged", node: nodeId });
      return;
    }
    logger.info({ reason: outcome.reason }, "task merge blocked");
    await dispatch(entry, {
      type: "merge_blocked",
      node: nodeId,
      reason: outcome.reason,
      ...(outcome.files === undefined ? {} : { files: [...outcome.files] }),
    });
  }

  /**
   * The task conversation's session, when the task has one the host started.
   *
   * @remarks
   * A task made by hand (a test, `task:try`) names a session that does not exist; nothing is written to it.
   *
   * @sideEffects none
   * @param task - The task.
   * @returns The session id, or `undefined`.
   */
  function conversationOf(task: Task): string | undefined {
    const record = sessions.recordOf(task.taskSessionId);
    return record?.role === "conversation" && record.taskId === task.id ? task.taskSessionId : undefined;
  }

  /**
   * Puts something for the task conversation on the task's line, apart from its queue.
   *
   * @remarks
   * One after the other so progress lines keep their order, but never inside the task's queue: opening a pi may
   * take seconds and must not hold up the scheduler. A failure is logged.
   *
   * @sideEffects Runs `work` later.
   * @param entry - The task.
   * @param what - What it is, for the log.
   * @param work - What to do.
   */
  function onLine(entry: TaskEntry, what: string, work: () => Promise<void>): void {
    /**
     * Does the work, unless the host is closing.
     *
     * @remarks
     * A host that is closing calls off the command under way; that is no failure to log.
     *
     * @sideEffects As `work`.
     */
    const attempt = async (): Promise<void> => {
      if (closing.signal.aborted) return;
      try {
        await work();
      } catch (error) {
        if (!closing.signal.aborted) throw error;
      }
    };
    const turn = entry.lines.then(attempt);
    entry.lines = turn.catch(() => undefined);
    track(turn, what);
  }

  /**
   * Writes a progress line into the task conversation, without a model call.
   *
   * @remarks
   * SPEC-0006, "任务对话 · 进度行": the hidden command `progress`, which the extension writes as a custom message
   * and drops when it has the line's id already.
   *
   * @sideEffects Opens the conversation's pi if it is not running; sends the command.
   * @param entry - The task.
   * @param line - The line.
   */
  function writeProgress(entry: TaskEntry, line: ProgressLine): void {
    const task = entry.store.current();
    const sessionId = task === null ? undefined : conversationOf(task);
    if (sessionId === undefined) return;
    onLine(entry, "progress line", async () => {
      await sessions.open(sessionId);
      await sessions.command(
        sessionId,
        taskCommandText("progress", {
          v: 1,
          id: line.id,
          at: options.clock.now(),
          text: progressText(line),
          what: line.kind,
          ...(line.node === undefined ? {} : { node: line.node }),
        }),
        closing.signal,
      );
    });
  }

  /**
   * Wakes the task conversation after a node asked for the graph to change.
   *
   * @remarks
   * SPEC-0006, "中途": the one system input that makes the conversation's model run. The note names every node
   * waiting for a graph change and, from the run (`graphRequest`, kept with the event, so a restart has it), its
   * reason and suggestion, quoted as the node's words.
   *
   * @sideEffects Opens the conversation's pi if it is not running; sends the command.
   * @param entry - The task.
   * @param text - What the scheduler says.
   * @param seq - The `seq` of the event that asked, which makes the command's id.
   */
  function wakeConversation(entry: TaskEntry, text: string, seq: number): void {
    const task = entry.store.current();
    const sessionId = task === null ? undefined : conversationOf(task);
    if (task === null || sessionId === undefined) return;
    const asking = (activeGraphOf(task)?.nodes ?? []).flatMap((node) => {
      const run = liveRun(task, node.id);
      if (run?.state !== "waiting" || run.waitingFor !== "graph_change") return [];
      return [{ id: node.id, label: `${node.id} · ${node.name}`, request: run.graphRequest }];
    });
    const words = wakeWords(text, asking);
    onLine(entry, "wake of the task conversation", async () => {
      await sessions.open(sessionId);
      await sessions.command(
        sessionId,
        taskCommandText("resume", { v: 1, id: `w${String(seq)}`, kind: "wake", text: words }),
        closing.signal,
      );
    });
  }

  /**
   * Settles the nodes whose `node_done` turn ended before the host went down.
   *
   * @remarks
   * SPEC-0006, "宿主重启" 2. `step` is pure and cannot read a session's file, so this does: a `running` node whose
   * `node_done` is pending, and whose file ends with that call's result (the turn that ended on it), gets
   * `node_settled` as if pi had said `agent_settled`, before `host_restarted` would tell it to look at its work
   * again. A node that is waiting to commit, or whose file goes on past the result, is left to the restart. A file
   * that cannot be read leaves the node to the restart too.
   *
   * @sideEffects Reads session files; records `node_settled` (and what it brings, such as a commit).
   * @param entry - The task.
   */
  async function settleEndedTurns(entry: TaskEntry): Promise<void> {
    // Stryker disable next-line OptionalChaining,ArrayDeclaration: the task is there; the fallback only satisfies the type.
    for (const run of entry.store.current()?.runs ?? []) {
      // A node waiting to commit has no `node_done` pending any more; one waiting for an answer is not settled.
      // Stryker disable next-line ConditionalExpression: a pending `node_done` always belongs to a node with a session.
      if (run.state !== "running" || run.pendingDone === null || run.sessionId === null) continue;
      if (endedOnNodeDone(await entriesOf(run.sessionId))) {
        await dispatch(entry, { type: "node_settled", node: run.node, attempt: run.attempt });
      }
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
   * Takes a request the extension made on its status line.
   *
   * @remarks
   * SPEC-0006, "扩展与通道": runs inside the task's queue, so the check of the caller, the event that records
   * the call and the judge's note of it are one step; the state it checks is the state after every event ahead
   * of it, such as a question just answered. An accepted `node_done` is recorded as pending before the answer
   * goes (the extension ends the turn on it); an accepted graph-change request waits in the judge and voids a
   * `node_done` of the same turn. A call the extension gave up on is dropped. The same call id is answered
   * once. Logs name the operation only.
   *
   * @sideEffects Records events; sends the reply.
   * @param entry - The task.
   * @param context - The session it came from.
   * @param text - The status text.
   */
  async function handleRequest(entry: TaskEntry, context: NodeContext, text: string): Promise<void> {
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
    if (context.cancelled.has(request.id)) return;
    if (isConversationCall(request)) {
      // The task conversation's tools are not a node's, whatever the node's session says it is.
      logger.info({ op: request.op, code: "task_caller_invalid" }, "task call refused");
      send(context.sessionId, replyText(request.id, { ok: false, code: "task_caller_invalid" }));
      return;
    }
    const verdict = checkCall(entry.store.current() ?? undefined, context, request);
    if (!verdict.ok) {
      logger.info({ op: request.op, code: verdict.code }, "task call refused");
      send(context.sessionId, replyText(request.id, verdict));
      return;
    }
    const run = { node: context.node, attempt: context.attempt };
    try {
      if (request.op === "node_done") {
        const { ok, summary, reason } = request.args;
        await dispatch(entry, {
          type: "node_done_pending",
          ...run,
          ok,
          ...(summary === "" ? {} : { summary }),
          ...(reason === undefined ? {} : { reason }),
        });
        if (context.cancelled.has(request.id)) {
          await dispatch(entry, { type: "node_done_void", ...run });
          return;
        }
        context.judge = judge(context.judge, { kind: "accepted", call: "done" }).state;
      } else {
        if (context.cancelled.has(request.id)) return;
        context.graphRequest = { reason: request.args.reason, suggestion: request.args.suggestion };
        const step = judge(context.judge, { kind: "accepted", call: "graph_change" });
        context.judge = step.state;
        for (const replaced of step.verdicts) {
          if (replaced.kind === "void") await dispatch(entry, { type: "node_done_void", ...run });
        }
      }
      send(context.sessionId, replyText(request.id, { ok: true }));
    } catch (error) {
      logger.warn({ op: request.op, err: error instanceof Error ? error.name : "unknown" }, "task call failed");
      send(context.sessionId, replyText(request.id, { ok: false, code: "task_failed" }));
    }
  }

  /**
   * The context of a task conversation's session, made from its record the first time.
   *
   * @remarks
   * The caller is found by the session, never by what a request says.
   *
   * @sideEffects Remembers the context.
   * @param sessionId - The session.
   * @returns The context, or `undefined` for a session that is not a task conversation.
   */
  function conversationContext(sessionId: string): ConversationContext | undefined {
    const known = conversations.get(sessionId);
    if (known !== undefined) return known;
    const record = sessions.recordOf(sessionId);
    if (record?.role !== "conversation") return undefined;
    const made: ConversationContext = {
      sessionId,
      taskId: record.taskId,
      epoch: 0,
      answered: new Set(),
      cancelled: new Set(),
    };
    conversations.set(sessionId, made);
    return made;
  }

  /**
   * Sends the answer to a call of the task conversation.
   *
   * @remarks
   * An accepted call carries the result the tool reads; a refused one its code and parameters.
   *
   * @sideEffects Sends the command.
   * @param context - The conversation.
   * @param id - The call's id.
   * @param answer - The answer.
   */
  function answerTo(context: ConversationContext, id: string, answer: Answer): void {
    send(
      context.sessionId,
      answer.ok
        ? replyText(id, { ok: true }, answer.result)
        : replyText(id, {
            ok: false,
            code: answer.code,
            ...(answer.params === undefined ? {} : { params: answer.params }),
          }),
    );
  }

  /**
   * Takes a request the task conversation made on its status line.
   *
   * @remarks
   * SPEC-0006, "扩展与通道" and "任务对话": runs inside the task's queue. Only the session whose record says
   * `conversation` and that is this task's `taskSessionId` may call (`task_caller_invalid`), and a node's tool
   * from here is refused the same way. Then `answerConversation` reads or records. A call the extension gave up
   * on is dropped; the same call id is answered once. Logs name the operation only.
   *
   * @sideEffects Records events; reads files and git; sends the reply.
   * @param entry - The task.
   * @param context - The session it came from.
   * @param text - The status text.
   */
  async function handleConversationRequest(
    entry: TaskEntry,
    context: ConversationContext,
    text: string,
  ): Promise<void> {
    const read = readTaskRequest(text);
    if ("bad" in read) {
      if (read.bad !== null && read.kind === "call" && !context.answered.has(read.bad)) {
        context.answered.add(read.bad);
        answerTo(context, read.bad, { ok: false, code: "task_bad_request" });
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
    if (context.cancelled.has(request.id)) return;
    const task = entry.store.current() ?? undefined;
    const verdict = checkConversationCall(task, {
      sessionId: context.sessionId,
      taskId: context.taskId,
      role: "conversation",
    });
    if (!verdict.ok || task === undefined || !isConversationCall(request)) {
      const code = verdict.ok ? "task_caller_invalid" : verdict.code;
      logger.info({ op: request.op, code }, "task call refused");
      answerTo(context, request.id, { ok: false, code });
      return;
    }
    let answer: Answer;
    try {
      answer = await answerConversation({
        task,
        call: request satisfies ConversationCall,
        ports: {
          transcript: (sessionId) => sessions.transcript(sessionId),
          deliver: (sessionId, words, signal) => sessions.deliver(sessionId, words, signal),
          git: () => options.git,
          dirOf: (workspaceId) => workspaces.dirOf(workspaceId),
        },
        signal: closing.signal,
        submit: (input) => dispatch(entry, input),
      });
    } catch (error) {
      logger.warn({ op: request.op, err: error instanceof Error ? error.name : "unknown" }, "task call failed");
      answer = { ok: false, code: "task_failed" };
    }
    if (context.cancelled.has(request.id)) return;
    if (!answer.ok) logger.info({ op: request.op, code: answer.code }, "task call refused");
    answerTo(context, request.id, answer);
  }

  /**
   * Feeds one of pi's events to the judge and records what it decides.
   *
   * @remarks
   * Runs inside the task's queue (SPEC-0006, "T4a 定下的细节"): the judge's decisions and the stop of a node
   * that reads its state are in one order.
   *
   * @sideEffects Records events.
   * @param entry - The task.
   * @param context - The node's session.
   * @param event - The pi event.
   */
  async function judgeEvent(entry: TaskEntry, context: NodeContext, event: PiEvent): Promise<void> {
    const run = { node: context.node, attempt: context.attempt };
    const step = judge(context.judge, { kind: "pi", event });
    context.judge = step.state;
    if (event.type === "agent_start" || event.type === "turn_start" || event.type === "agent_settled") {
      context.startingAt = null;
    }
    for (const verdict of step.verdicts) {
      if (verdict.kind === "void") {
        await dispatch(entry, { type: "node_done_void", ...run });
        continue;
      }
      const input = eventOf(verdict.ending, context);
      context.hold = false;
      context.killed = false;
      if (input !== null) await dispatch(entry, input);
    }
  }

  /**
   * Takes what a task session's control state or runs say.
   *
   * @remarks
   * A question open or answered becomes `node_waiting` / `node_resumed`; the controller giving up on a crashing
   * pi becomes `node_failed(crashed)`, once for each failure; a run starting on a node the user stopped (a message
   * or "继续" in its conversation) is `node_resumed`, recorded before any call of the node is taken.
   *
   * @sideEffects Records events.
   * @param entry - The task.
   * @param context - The node's session.
   * @param event - The session event.
   */
  async function sessionEvent(entry: TaskEntry, context: NodeContext, event: SessionEvent): Promise<void> {
    const run = { node: context.node, attempt: context.attempt };
    if (event.type === "run_started") {
      const task = entry.store.current();
      const live = task === null ? undefined : liveRun(task, context.node);
      if (live?.attempt === context.attempt && live.sessionId === context.sessionId && live.state === "stopped") {
        entry.spoken?.add(context.sessionId);
        await dispatch(entry, { type: "node_resumed", ...run });
      }
    } else if (event.type === "control_updated") {
      const { question, failure } = event.control;
      if (question !== null && !context.asking) {
        context.asking = true;
        await dispatch(entry, { type: "node_waiting", ...run, waitingFor: "question" });
      } else if (question === null && context.asking) {
        context.asking = false;
        entry.spoken?.add(context.sessionId);
        await dispatch(entry, { type: "node_resumed", ...run });
      }
      if (failure?.reason === "crashed" && !context.crashed) {
        context.crashed = true;
        await dispatch(entry, { type: "node_failed", ...run, reason: "crashed" });
      }
    }
  }

  /**
   * Takes note that a node's pi started again, and sends the node back to work if it was cut off.
   *
   * @remarks
   * A pi the host did not restart itself, new while a turn was going or about to begin, is one the session
   * controller restarted after a crash. It re-sends only what it kept of the user's messages, which is none of
   * the host's prompts, so the node would sit idle `running`: the turn's `node_done` is void and the node is
   * told, as after a host restart (SPEC-0006, "宿主重启"), or sent its contract if that never went.
   *
   * @sideEffects Resets the judge; may record `node_done_void`; may send a prompt or a command.
   * @param entry - The task.
   * @param context - The node's session.
   * @param epoch - The new start of pi.
   */
  async function newEpoch(entry: TaskEntry, context: NodeContext, epoch: number): Promise<void> {
    const interrupted = !context.ownStart && !context.killed && (context.judge.running || context.startingAt !== null);
    context.epoch = epoch;
    context.ownStart = false;
    context.judge = JUDGE_START;
    context.startingAt = null;
    context.crashed = false;
    if (!interrupted) return;
    const task = entry.store.current();
    const run = task === null ? undefined : liveRun(task, context.node);
    if (
      run?.state !== "running" ||
      run.commitPending === true ||
      run.sessionId !== context.sessionId ||
      run.attempt !== context.attempt
    ) {
      return;
    }
    try {
      if (run.pendingDone !== null)
        await dispatch(entry, { type: "node_done_void", node: run.node, attempt: run.attempt });
      await sendBack(entry, run.node, RESUME_RESTARTED, `e${String(epoch)}.${run.node}`);
    } catch (error) {
      await sessionFailed(entry, run, error);
    }
  }

  /**
   * Takes one signal of a task session, in the task's queue.
   *
   * @remarks
   * A signal from an older start of pi than the one the context knows is dropped; a newer one starts a new
   * epoch (see `newEpoch`).
   *
   * @sideEffects As the handlers'.
   * @param entry - The task.
   * @param context - The node's session.
   * @param signal - What it told.
   */
  async function handleSignal(entry: TaskEntry, context: NodeContext, signal: TaskSessionSignal): Promise<void> {
    if (closing.signal.aborted || entry.store.current()?.endedAt != null) return;
    if (signal.kind !== "session" && signal.epoch < context.epoch) return;
    if (signal.epoch > context.epoch) await newEpoch(entry, context, signal.epoch);
    if (signal.kind === "request") await handleRequest(entry, context, signal.text);
    else if (signal.kind === "pi") await judgeEvent(entry, context, signal.event);
    else await sessionEvent(entry, context, signal.event);
  }

  /**
   * Takes what a task session tells: a request, a pi event or a session event.
   *
   * @remarks
   * Only what the runner reads is put on the task's queue; the rest of pi's events (most of them) are let go.
   * A note that the extension gave up on a call is taken at once, so it reaches a call still in the queue.
   *
   * @sideEffects Queues work; may remember a call as given up.
   * @param sessionId - The session.
   * @param signal - What it told.
   */
  function onSignal(sessionId: string, signal: TaskSessionSignal): void {
    const conversation = signal.kind === "request" ? conversationContext(sessionId) : undefined;
    if (conversation !== undefined && signal.kind === "request") {
      const home = tasks.get(conversation.taskId);
      if (home === undefined || signal.epoch < conversation.epoch) return;
      conversation.epoch = signal.epoch;
      const read = readTaskRequest(signal.text);
      if (!("bad" in read) && read.request.kind === "note") {
        conversation.cancelled.add(read.request.args.id);
        return;
      }
      track(
        enqueue(home, () => handleConversationRequest(home, conversation, signal.text)),
        "conversation request",
      );
      return;
    }
    const context = contextOf(sessionId);
    const entry = context === undefined ? undefined : tasks.get(context.taskId);
    if (context === undefined || entry === undefined) return;
    if (entry.store.current()?.endedAt != null) {
      // Stryker disable next-line all: only frees memory; see `dispatch`.
      contexts.delete(sessionId);
      return;
    }
    if (signal.kind === "request") {
      const read = readTaskRequest(signal.text);
      if (!("bad" in read) && read.request.kind === "note") {
        context.cancelled.add(read.request.args.id);
        return;
      }
    } else if (signal.kind === "pi" && !JUDGED.has(signal.event.type)) {
      return;
    } else if (
      signal.kind === "session" &&
      signal.event.type !== "control_updated" &&
      signal.event.type !== "run_started"
    ) {
      return;
    }
    track(
      enqueue(entry, () => handleSignal(entry, context, signal)),
      "signal",
    );
  }

  const unsubscribe = sessions.subscribe(onSignal);

  return {
    attach(taskId, store) {
      if (!tasks.has(taskId))
        tasks.set(taskId, { store, queue: Promise.resolve(), lines: Promise.resolve(), spoken: new Set() });
    },
    submit(taskId, input, guard) {
      const entry = tasks.get(taskId);
      if (entry === undefined) return Promise.reject(new Error(`task ${taskId} is not attached`));
      return enqueue(entry, () => {
        const task = entry.store.current();
        if (guard !== undefined && task !== null) guard(task);
        return dispatch(entry, input);
      });
    },
    task: (taskId) => tasks.get(taskId)?.store.current() ?? undefined,
    all: () => [...tasks.values()].flatMap((entry) => entry.store.current() ?? []),
    recover(taskId) {
      const entry = tasks.get(taskId);
      if (entry === undefined) return Promise.reject(new Error(`task ${taskId} is not attached`));
      return enqueue(entry, async () => {
        const task = entry.store.current();
        // Stryker disable next-line ConditionalExpression: a task that is attached has a record.
        if (task === null || task.startedAt === null) return;
        if (task.endedAt !== null) {
          // The task ended, but the worktree's lock may not have been let go before the host went down.
          if (task.workspaceState === "ready") await lockWorkspace(entry, false);
          return;
        }
        // A task locks its worktree from the event that made it; the host may have died before the lock was put on.
        if (task.workspaceState === "ready") await lockWorkspace(entry, true);
        if (task.workspaceState === "creating") await ensureWorkspace(entry);
        // `startNode` takes only a running node that has no session yet.
        // Stryker disable next-line OptionalChaining,ArrayDeclaration: the task is there; the fallback only satisfies the type.
        for (const run of entry.store.current()?.runs ?? []) await startNode(entry, run.node, run.attempt);
        await settleEndedTurns(entry);
        // The nodes this process has already spoken to (the user answered first; the recovery started them itself)
        // are not told the host restarted, and a question they were answered is not void.
        const spoken = entry.spoken;
        entry.spoken = undefined;
        const live = (entry.store.current()?.runs ?? []).flatMap((run) =>
          run.sessionId !== null && spoken?.has(run.sessionId) === true ? [run.node] : [],
        );
        // A writing node whose commit was pending gets its `commit_node` from this event, for that run only.
        await dispatch(entry, { type: "host_restarted", ...(live.length === 0 ? {} : { live }) });
      });
    },
    clearStaleLocks: (present) =>
      workspaces.clearStaleLocks((taskId) => {
        const entry = tasks.get(taskId);
        // A task held is over when it ended; one not held is over only if its directory is gone, not when it cannot be read.
        if (entry !== undefined) return entry.store.current()?.endedAt != null;
        return !present.has(taskId);
      }),
    continueNode(taskId, nodeId) {
      const entry = tasks.get(taskId);
      if (entry === undefined) return Promise.reject(new Error(`task ${taskId} is not attached`));
      return enqueue(entry, async () => {
        const task = entry.store.current();
        const run = task === null ? undefined : liveRun(task, nodeId);
        if (run?.state !== "stopped" || run.sessionId === null) throw new CommandError("task_state_invalid");
        const context = contextOf(run.sessionId);
        if (context !== undefined) {
          context.judge = JUDGE_START;
          context.hold = false;
          context.killed = false;
          context.crashed = false;
          context.ownStart = true;
          expectTurn(context);
        }
        await sessions.open(run.sessionId);
        entry.spoken?.add(run.sessionId);
        await sessions.prompt(run.sessionId, CONTINUE_NODE, closing.signal);
      });
    },
    recordReview(taskId, line) {
      const entry = tasks.get(taskId);
      const task = entry?.store.current() ?? null;
      const sessionId = task === null ? undefined : conversationOf(task);
      if (entry === undefined || sessionId === undefined) return;
      onLine(entry, "review record", async () => {
        await sessions.open(sessionId);
        await sessions.command(
          sessionId,
          taskCommandText("review", {
            v: 1,
            id: line.id,
            at: options.clock.now(),
            text: line.text,
            review: line.record,
          }),
          closing.signal,
        );
      });
    },
    async detach(taskId) {
      const entry = tasks.get(taskId);
      if (entry === undefined) return;
      await entry.queue;
      await entry.lines;
      tasks.delete(taskId);
      for (const [sessionId, context] of conversations) if (context.taskId === taskId) conversations.delete(sessionId);
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
      contexts.clear();
      conversations.clear();
      release();
    },
  };
}
