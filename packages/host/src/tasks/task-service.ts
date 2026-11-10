import { taskCommandText } from "@atrium/pi";
import { CommandError, type ArchiveAnswer, type HumanAnswer, type ReviewRecord, type TaskView } from "@atrium/protocol";
import { randomUUID } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "../platform/clock";
import type { Logger } from "../platform/logger";
import type { TaskSessions } from "../sessions/task-sessions";
import { buildDesignPrompt } from "./design";
import { BACK_LIMIT, activeGraphOf, liveRun } from "./graph";
import { type GraphProblem, validateGraph } from "./graph-validator";
import type { ScheduleRule } from "./schedule-rules";
import { newDesignTask, newScheduledTask } from "./new-task";
import type { TaskRunner } from "./runner";
import { backUses } from "./scheduler";
import { deriveStatus } from "./status";
import type { TaskArchiving } from "./task-archiving";
import { openTaskStore } from "./task-store";
import { needsWorktreeFacts, reviewsOf } from "./task-reviews";
import { viewOf } from "./task-view";
import type { NodeId, NodeRun, Task, TaskEventInput } from "./types";

/** A task's directory name: what `newTaskRecord` and `pnpm task:try` make ids of. */
const TASK_DIRECTORY = /^tsk_[0-9A-Za-z_-]{1,64}$/u;

/**
 * The graph version a verdict was given on, so that it is not carried out on another one.
 *
 * @remarks
 * A review card names the proposal the user saw; the agent can propose again before the click arrives
 * (T8 review fix 2).
 */
interface ReviewedGraph {
  /** The version the user saw. */
  readonly version: number;
  /** The review the verdict answers, for `review_closed`'s parameter. */
  readonly reviewId: string;
}

/** The host's tasks, as the rest of the host and (later) the protocol use them. */
export interface TaskService {
  /** Starts a task: writes its `created` event and looks after it. */
  create(task: Task): Promise<Task>;
  /** Takes up a task that is on disk, replaying its events if its snapshot is behind. */
  open(taskId: string): Promise<Task>;
  /** Records an event for a task and carries out what it brings. */
  submit(taskId: string, input: TaskEventInput): Promise<Task>;
  /**
   * A task by id, taken up from disk if it is there and not held; `undefined` when there is none.
   *
   * @remarks
   * Unlike `open`, a task that does not exist is not an error and leaves nothing behind.
   */
  lookup(taskId: string): Promise<Task | undefined>;
  /**
   * Makes a started task of a schedule rule (SPEC-0006, "定时"): its own conversation, the rule's summary and graph, and
   * the `started` event.
   *
   * @remarks
   * The graph is checked again with the rule's place. A task that could not be started is taken back out, so a
   * failed trigger leaves no half-made task. Answers the task's id.
   */
  createScheduled(rule: ScheduleRule, name: string, firedAt: number, signal: AbortSignal): Promise<string>;
  /**
   * The tasks of a schedule rule that are on disk.
   *
   * @remarks
   * By `origin.ruleId`, whatever the rule's `lastTaskId` says (SPEC-0006, "T9 / T10 审查后用户定").
   */
  ofRule(ruleId: string): Promise<readonly Task[]>;
  /**
   * Removes a schedule rule's template task and its conversation.
   *
   * @remarks
   * For deleting the rule. A task that is not there is not an error.
   */
  discardTemplate(taskId: string): Promise<void>;
  /** The task as it is. */
  task(taskId: string): Task | undefined;
  /** Takes up a task again after the host restarted; see `TaskRunner.recover`. */
  recover(taskId: string): Promise<void>;
  /**
   * Takes up every task of this host that was started and not finished, after the host restarted.
   *
   * @remarks
   * SPEC-0006, "宿主重启" and "T9 定下的细节". First lets go of the task conversations whose task is not on disk and
   * is not being made now (a crash between a conversation and its task), reads every task on disk, lifts the stale
   * locks (`staleLocks`), then `recover`s the tasks in the order they were made. A task a schedule made that was never
   * started (the host died inside `createScheduled`) is started, which is all it lacks. A task that needs pi (it is still going) waits for `ready`,
   * which is asked only when there is one; if pi is not ready they are left as they are, with one warning. One that
   * cannot be recovered is logged and does not stop the rest. Stops early when `signal` aborts.
   */
  recoverAll(options: {
    readonly signal: AbortSignal;
    /** Whether to lift stale locks; not while following another process's tasks, whose locks are not ours. */
    readonly staleLocks: boolean;
    /** Whether pi can run; asked at most once, and only if a task needs it. */
    readonly ready: () => Promise<boolean>;
  }): Promise<void>;
  /**
   * Every task, those on disk that were not taken up yet included.
   *
   * @remarks
   * Taking a task up only reads its files (`open`); it does not start anything. Picking nodes up again after a
   * restart is `recover`'s, which `recoverAll` calls at start for the tasks that were going.
   */
  list(): Promise<Task[]>;
  /** The tasks taken up so far, in the order they were; one abandoned while designing is not among them. */
  held(): readonly Task[];
  /**
   * The task as the board shows it, with the archive question's facts while it is open.
   *
   * @remarks
   * Fails with `task_not_found` for an id that is neither held nor on disk.
   */
  view(taskId: string, signal: AbortSignal): Promise<TaskView>;
  /** Passes a waiting human node or sends the task back from it; see the protocol's `answer_human`. */
  answerHuman(taskId: string, node: NodeId, answer: HumanAnswer): Promise<void>;
  /** Reruns a failed node. */
  rerunNode(taskId: string, node: NodeId): Promise<void>;
  /** Lets a node the user stopped go on. */
  continueNode(taskId: string, node: NodeId): Promise<void>;
  /** Pauses a running task. */
  pause(taskId: string): Promise<void>;
  /** Lets a paused task go on. */
  resume(taskId: string): Promise<void>;
  /** Cancels a started task that has not ended. */
  cancel(taskId: string): Promise<void>;
  /**
   * Answers the question about archiving the task's worktree.
   *
   * @remarks
   * "Archive" archives first, through the same checks as `archive_workspace`, and records the answer only when it
   * worked, so a refusal leaves the question open.
   */
  answerArchive(taskId: string, answer: ArchiveAnswer): Promise<void>;
  /**
   * Makes a task of a conversation: its record (`designing`), its conversation with the design message, and the
   * "converted" line in the source conversation.
   *
   * @remarks
   * SPEC-0006, "/task 与创建". One conversation has one task: another `/task` fails with `task_already_converted`
   * (`params.taskId`), except after the task was abandoned. Fails with `session_not_found` for a conversation that
   * is unknown or archived and `task_state_invalid` for one with no model yet.
   */
  createFromChat(
    sessionId: string,
    scope: string | undefined,
    options?: { readonly model?: Task["model"] },
  ): Promise<{ taskId: string }>;
  /**
   * Confirms the initial graph and starts the task.
   *
   * @remarks
   * The graph is checked again; `task_graph_invalid` or `task_no_project_for_work` if it breaks a rule,
   * `task_state_invalid` unless the task is being designed and has a graph.
   */
  start(taskId: string): Promise<void>;
  /**
   * Gives up a task that has not started: deletes its record, archives its conversation, marks the source
   * conversation, and lets it be made into a task again.
   */
  abandon(taskId: string): Promise<void>;
  /**
   * Approves the graph a started task waits for; checked again, so it can still be `task_graph_invalid`.
   *
   * @remarks
   * With `reviewed`, only that version: when another is waiting by the time the task's queue gets to it, nothing
   * is approved and it fails with `review_closed`.
   */
  approveGraph(taskId: string, reviewed?: ReviewedGraph): Promise<void>;
  /** Refuses the graph a started task waits for; `reviewed` as for `approveGraph`. */
  rejectGraph(taskId: string, reviewed?: ReviewedGraph): Promise<void>;
  /**
   * Writes the record of a review whose verdict took effect into the task conversation (ADR-0018, decision 2).
   *
   * @remarks
   * A custom message, without a model call; the conversation's pi is started if it is not running. A task whose
   * conversation the host did not start (`task:try`, tests) gets none. Failures are logged by the runner.
   */
  recordReview(
    taskId: string,
    line: { readonly id: string; readonly text: string; readonly record: ReviewRecord },
  ): void;
  /**
   * Starts the pi of a session of the task, its conversation or a node's, so that a client watching it gets its
   * snapshot and can write to it (SPEC-0006, "T8a 定下的细节").
   *
   * @remarks
   * Not `open_session`, which makes a tab in the project's container; task sessions are in no list. Fails with
   * `task_not_found`, and with `session_not_found` for a session that is not this task's.
   */
  openSession(taskId: string, sessionId: string): Promise<void>;
  /** Calls `listener` after every event is recorded; returns a function that stops it. */
  onEvent: TaskRunner["onEvent"];
  /** Resolves once every task's queue is done. */
  idle(): Promise<void>;
  /** Stops looking after the tasks. */
  close(): Promise<void>;
}

/**
 * What the task service needs from the schedule rules.
 *
 * @remarks
 * The two are wired in `main.ts`: the service makes the tasks the rules ask for, and asks the rules to save the one
 * a template task stands for.
 */
export interface TaskSchedules {
  /** Saves the rule a template task stands for; see `ScheduleService.confirm`. */
  confirm(template: Task): Promise<void>;
  /** Whether a rule was saved from this template task. */
  saved(templateTaskId: string): boolean;
}

/**
 * The node's latest run, if it is the live one of a node of the graph in force.
 *
 * @remarks
 * Commands name a node; one that is not in the graph is as good as not in the state the command needs.
 *
 * @sideEffects none
 * @param task - The task.
 * @param node - The node.
 * @returns The run, or `undefined`.
 */
function runOf(task: Task, node: NodeId): NodeRun | undefined {
  return activeGraphOf(task)?.nodes.some((candidate) => candidate.id === node) === true
    ? liveRun(task, node)
    : undefined;
}

/**
 * What the service needs to make a task of a conversation.
 *
 * @remarks
 * The service knows no projects or catalog; the wiring answers (`main.ts`).
 */
export interface TaskDesignPorts {
  /** The sessions: the source conversation's facts, the task conversation, and the lines written to both. */
  readonly sessions: Pick<
    TaskSessions,
    "source" | "create" | "open" | "prompt" | "command" | "retire" | "recordOf" | "conversations"
  >;
  /**
   * Where a container is: its project, and the worktree to borrow when it is one Atrium (or git) made.
   *
   * @remarks
   * A chat is no project (`projectId: null`); the project's own directory borrows nothing.
   */
  readonly placement: (containerId: string) => {
    readonly projectId: string | null;
    readonly borrowed: { readonly workspaceId: string; readonly baseCommit: string | null } | null;
  };
  /** A fresh task id; `tsk_` and a name. */
  readonly newId?: () => string;
}

/**
 * Whether a task was abandoned while designing: its record is on its way out.
 *
 * @remarks
 * `abandoned` marks it cancelled and never started; the record is deleted right after, so one found on disk is
 * what a crash between the two left. It counts for nothing: not listed, and the conversation can be made into a task again.
 *
 * @sideEffects none
 * @param task - The task.
 * @returns Whether it is.
 */
export function isAbandoned(task: Task): boolean {
  return task.cancelled && task.startedAt === null;
}

/**
 * The command error for the first problem of a graph.
 *
 * @remarks
 * `no_project_for_work` has its own code (SPEC-0006, "错误码"); any other is `task_graph_invalid` with the problem's code.
 *
 * @sideEffects none
 * @param problem - The problem.
 * @returns The error to throw.
 */
function graphError(problem: GraphProblem): CommandError {
  if (problem.code === "no_project_for_work") return new CommandError("task_no_project_for_work");
  return new CommandError("task_graph_invalid", {
    code: problem.code,
    ...(problem.node === undefined ? {} : { node: problem.node }),
  });
}

/**
 * Checks that the graph waiting is the one the user gave a verdict on.
 *
 * @remarks
 * Nothing to check when the verdict names no version (the plain `approve_graph` / `reject_graph`).
 *
 * @sideEffects none
 * @param task - The task as it is now.
 * @param reviewed - The version the user saw, if the verdict came from a review card.
 * @throws {CommandError} `review_closed` when another version (or none) is waiting.
 */
function sameGraph(task: Task, reviewed: ReviewedGraph | undefined): void {
  if (reviewed !== undefined && task.pendingGraph !== reviewed.version) {
    throw new CommandError("review_closed", { reviewId: reviewed.reviewId });
  }
}

/**
 * Waits for work, or gives up with the signal's reason when the signal comes first.
 *
 * @remarks
 * The work itself is not stopped, only waited for no longer; whatever it does after is its own business and its
 * failure is not an unhandled rejection.
 *
 * @sideEffects Listens to the signal until either is done.
 * @param work - What is under way.
 * @param signal - When to stop waiting.
 * @returns What the work gives.
 * @throws {unknown} The signal's reason when it aborts first.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    // Taken off the signal once the work is over, whichever way, so a long-lived signal keeps no listener.
    const over = new AbortController();
    signal.addEventListener("abort", () => reject(signal.reason), { once: true, signal: over.signal });
    work.then(resolve, reject).finally(() => over.abort());
  });
}

/** The longest a task's first name may be. */
const NAME_CHARS = 120;

/**
 * Creates the task service.
 *
 * @remarks
 * SPEC-0006, "总体结构": a task lives in `<root>/<id>/` (`events.jsonl` and `task.json`, `TaskStore`) and the
 * runner carries out what its events bring. The commands the UI sends (T5) check that the task and node are in
 * a state that takes them and answer `task_not_found` / `task_state_invalid` / `task_back_limit` if not; what
 * they do is record an event. Commands that create and approve tasks and graphs come with T6.
 *
 * @sideEffects none until a call; then reads and writes under `root`.
 * @param options - The runner, the tasks' directory, the clock, the logger and the archive port.
 * @returns The service.
 */
export function createTaskService(options: {
  readonly runner: TaskRunner;
  readonly root: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly archiving: TaskArchiving;
  readonly design: TaskDesignPorts;
  /** The schedule rules; absent while another process's tasks are followed. */
  readonly schedules?: TaskSchedules;
}): TaskService {
  const { runner } = options;
  const stopping = new AbortController();
  /** `createFromChat` goes one at a time, so two `/task` of one conversation cannot both pass the check. */
  let converting: Promise<unknown> = Promise.resolve();
  /** Opens under way, so that the board's list and the recovery reading one task at once open its files once. */
  const opening = new Map<string, Promise<Task>>();
  /** The ids of the tasks being made (a conversation exists, the task may not yet): not orphans to the sweep. */
  const creating = new Set<string>();
  const newId = options.design.newId ?? ((): string => `tsk_${randomUUID().replaceAll("-", "").slice(0, 16)}`);

  /**
   * Finds a task, taking it up from disk if it is there and not held.
   *
   * @remarks
   * The id is checked against the shape of a task's directory first, so no other path is read.
   *
   * @sideEffects Reads the task's files.
   * @param taskId - The task.
   * @returns The task.
   * @throws {CommandError} `task_not_found`.
   */
  async function need(taskId: string): Promise<Task> {
    const held = runner.task(taskId);
    if (held !== undefined) return held;
    if (!TASK_DIRECTORY.test(taskId)) throw new CommandError("task_not_found");
    return service.open(taskId).catch(() => {
      throw new CommandError("task_not_found");
    });
  }

  /**
   * Writes the "converted" or "abandoned" line into the conversation a task was made from.
   *
   * @remarks
   * The hidden command `mark` (SPEC-0006, "/task 与创建"); the source is an ordinary session, so its pi is
   * started if it has none. A failure is logged: the task stands without the line.
   *
   * @sideEffects Starts the source conversation's pi if needed; writes a custom message in its file.
   * @param sessionId - The source conversation.
   * @param taskId - The task.
   * @param state - What happened to it.
   */
  async function markSource(sessionId: string, taskId: string, state: "converted" | "abandoned"): Promise<void> {
    try {
      const { sessions } = options.design;
      await sessions.open(sessionId);
      await sessions.command(
        sessionId,
        taskCommandText("mark", { v: 1, id: `m.${taskId}.${state}`, at: options.clock.now(), taskId, state }),
        stopping.signal,
      );
    } catch (error) {
      options.logger.warn(
        { err: error instanceof Error ? error.name : "unknown", state },
        "source conversation not marked",
      );
    }
  }

  /**
   * Makes the task of a conversation.
   *
   * @remarks
   * See `TaskService.createFromChat`. The task conversation starts first (a session that cannot start fails the
   * command before anything is recorded); then the record, the design message and the line in the source. If the
   * design message does not go, the task is taken back out, so the user is not left with a conversation that
   * was never told what to do.
   *
   * @sideEffects Starts a pi; writes the task's files and a line in the source conversation.
   * @param sessionId - The source conversation.
   * @param scope - What the user typed after `/task`.
   * @param chosen - A model to use in place of the source conversation's.
   * @returns The new task's id.
   * @throws {CommandError} `task_already_converted`, `session_not_found`, `task_state_invalid`.
   */
  async function convert(
    sessionId: string,
    scope: string | undefined,
    chosen: Task["model"] | undefined,
  ): Promise<{ taskId: string }> {
    const known = (await service.list()).find(
      (task) => task.origin.kind === "chat" && task.origin.sessionId === sessionId,
    );
    if (known !== undefined) throw new CommandError("task_already_converted", { taskId: known.id });
    const { sessions } = options.design;
    const source = sessions.source(sessionId);
    if (source === undefined) throw new CommandError("session_not_found", { sessionId });
    // A model asked for (the dev tool's `--model`) stands in for the source conversation's own.
    const model = chosen ?? source.model;
    if (model === null) throw new CommandError("task_state_invalid");
    const place = options.design.placement(source.containerId);
    const taskId = newId();
    creating.add(taskId);
    try {
      const conversation = await sessions.create({
        containerId: source.containerId,
        cwd: source.cwd,
        name: taskId,
        task: {
          taskId,
          role: "conversation",
          startOn: {
            providerId: model.providerId,
            modelId: model.modelId,
            thinkingLevel: model.thinking,
          },
        },
      });
      const task = newDesignTask({
        id: taskId,
        name: (source.name ?? "").slice(0, NAME_CHARS),
        projectId: place.projectId,
        sourceDir: source.cwd,
        originSessionId: sessionId,
        taskSessionId: conversation,
        model,
        borrowed: place.borrowed,
        now: options.clock.now(),
      });
      await service.create(task);
      try {
        await sessions.prompt(
          conversation,
          buildDesignPrompt({
            sourceSessionId: sessionId,
            scope: scope ?? null,
            projectless: place.projectId === null,
          }),
          stopping.signal,
        );
      } catch (error) {
        await runner.submit(taskId, { type: "abandoned" });
        await runner.detach(taskId);
        await rm(join(options.root, taskId), { recursive: true, force: true });
        await sessions.retire(conversation).catch(() => undefined);
        throw error;
      }
      await markSource(sessionId, taskId, "converted");
      return { taskId };
    } finally {
      creating.delete(taskId);
    }
  }

  const service: TaskService = {
    async create(task) {
      const store = await openTaskStore(join(options.root, task.id), options.clock);
      runner.attach(task.id, store);
      options.logger.info({ taskId: task.id }, "task created");
      return runner.submit(task.id, { type: "created", task });
    },
    open(taskId) {
      const held = runner.task(taskId);
      if (held !== undefined) return Promise.resolve(held);
      const under = opening.get(taskId);
      if (under !== undefined) return under;
      const made = (async () => {
        const store = await openTaskStore(join(options.root, taskId), options.clock);
        const task = store.current();
        if (task === null) throw new Error(`task ${taskId} has no events`);
        runner.attach(taskId, store);
        return task;
      })().finally(() => opening.delete(taskId));
      opening.set(taskId, made);
      return made;
    },
    submit: (taskId, input) => runner.submit(taskId, input),
    async lookup(taskId) {
      const held = runner.task(taskId);
      if (held !== undefined) return held;
      if (!TASK_DIRECTORY.test(taskId)) return undefined;
      const there = await stat(join(options.root, taskId, "events.jsonl")).then(
        () => true,
        () => false,
      );
      return there ? service.open(taskId).catch(() => undefined) : undefined;
    },
    async createScheduled(rule, name, firedAt, signal) {
      signal.throwIfAborted();
      const problem = validateGraph(rule.graph, {
        projectless: false,
        localReadonly: rule.place === "local_readonly",
      })[0];
      if (problem !== undefined) throw graphError(problem);
      const taskId = newId();
      const { sessions } = options.design;
      creating.add(taskId);
      try {
        const conversation = await sessions.create({
          containerId: rule.containerId,
          cwd: rule.sourceDir,
          name: taskId,
          task: {
            taskId,
            role: "conversation",
            startOn: {
              providerId: rule.model.providerId,
              modelId: rule.model.modelId,
              thinkingLevel: rule.model.thinking,
            },
          },
        });
        try {
          await service.create(
            newScheduledTask({
              id: taskId,
              name,
              projectId: rule.projectId,
              sourceDir: rule.sourceDir,
              ruleId: rule.id,
              firedAt,
              taskSessionId: conversation,
              model: rule.model,
              summary: rule.summary,
              nodes: rule.graph.nodes,
              edges: rule.graph.edges,
              now: options.clock.now(),
            }),
          );
          // The node's first prompt waits for pi, which may never answer; the host that is closing must not wait for it.
          await untilAborted(runner.submit(taskId, { type: "started" }), signal);
        } catch (error) {
          // A host that is closing leaves the task as it is: the next start finishes what was begun (`recoverAll`).
          if (signal.aborted) throw error;
          await runner.submit(taskId, { type: "abandoned" }).catch(() => undefined);
          await runner.detach(taskId).catch(() => undefined);
          await rm(join(options.root, taskId), { recursive: true, force: true });
          await sessions.retire(conversation).catch(() => undefined);
          throw error;
        }
      } finally {
        creating.delete(taskId);
      }
      return taskId;
    },
    async ofRule(ruleId) {
      return (await service.list()).filter((task) => task.origin.kind === "schedule" && task.origin.ruleId === ruleId);
    },
    async discardTemplate(taskId) {
      const task = await service.lookup(taskId);
      if (task === undefined) return;
      await runner.submit(taskId, { type: "abandoned" }).catch(() => undefined);
      await runner.detach(taskId);
      await rm(join(options.root, taskId), { recursive: true, force: true });
      await options.design.sessions.retire(task.taskSessionId).catch((error: unknown) => {
        options.logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "task conversation not archived");
      });
      // The source conversation is not told: "converted" stays, as the template was made from it and the rule was real.
    },
    task: (taskId) => runner.task(taskId),
    recover: (taskId) => runner.recover(taskId),
    async recoverAll({ signal, staleLocks, ready }) {
      // Conversations and the tasks being made are read before the directory is: a task finished in between is then
      // seen on disk, and one begun in between is not in the conversations.
      const conversations = options.design.sessions.conversations();
      const making = new Set(creating);
      const present = new Set(
        (await readdir(options.root).catch(() => [] as string[])).filter((one) => TASK_DIRECTORY.test(one)),
      );
      for (const conversation of conversations) {
        if (signal.aborted) return;
        if (present.has(conversation.taskId) || making.has(conversation.taskId)) continue;
        await options.design.sessions.retire(conversation.sessionId).catch((error: unknown) => {
          options.logger.warn(
            { err: error instanceof Error ? error.name : "unknown" },
            "orphan conversation not archived",
          );
        });
      }
      const all = (await service.list()).toSorted((a, b) => a.createdAt - b.createdAt);
      if (staleLocks && !signal.aborted) {
        const lifted = await runner.clearStaleLocks(present).catch((error: unknown) => {
          options.logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "stale task locks not cleared");
          return 0;
        });
        if (lifted > 0) options.logger.info({ lifted }, "stale task locks lifted");
      }
      let piReady: Promise<boolean> | undefined;
      let left = 0;
      for (const task of all) {
        if (signal.aborted) return;
        // A task a schedule made has no designing: one that never started is what a crash inside `createScheduled` left.
        const unfinished = task.origin.kind === "schedule" && task.startedAt === null && !task.cancelled;
        if (task.startedAt === null && !unfinished) continue;
        const going = task.endedAt === null;
        if (going && !(await (piReady ??= ready()))) {
          left += 1;
          continue;
        }
        await (unfinished ? service.submit(task.id, { type: "started" }) : service.recover(task.id)).catch(
          (error: unknown) => {
            options.logger.warn(
              { err: error instanceof Error ? error.name : "unknown" },
              "a task could not be recovered",
            );
          },
        );
      }
      if (left > 0) options.logger.warn({ tasks: left }, "tasks not recovered: pi is not ready");
    },
    held: () => runner.all().filter((task) => !isAbandoned(task)),
    async list() {
      const names = await readdir(options.root).catch(() => [] as string[]);
      for (const name of names.filter((one) => TASK_DIRECTORY.test(one))) {
        if (runner.task(name) === undefined) {
          await service.open(name).catch((error: unknown) => {
            options.logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "a task could not be read");
          });
        }
      }
      return names.flatMap((name) => runner.task(name) ?? []).filter((task) => !isAbandoned(task));
    },
    async view(taskId, signal) {
      const task = await need(taskId);
      const asked = task.archive === "asked" || task.archive === "kept";
      const worktree =
        asked || needsWorktreeFacts(task) ? await options.archiving.facts(task, signal).catch(() => null) : null;
      const changes = needsWorktreeFacts(task) ? await options.archiving.changes(task, signal).catch(() => null) : null;
      return viewOf(task, asked ? worktree : null, false, reviewsOf(task, { worktree, changes }), {
        saved: options.schedules?.saved(task.id) ?? false,
      });
    },
    recordReview: (taskId, line) => runner.recordReview(taskId, line),
    async openSession(taskId, sessionId) {
      const task = await need(taskId);
      if (options.design.sessions.recordOf(sessionId)?.taskId !== task.id) {
        throw new CommandError("session_not_found", { sessionId });
      }
      await options.design.sessions.open(sessionId);
    },
    createFromChat(sessionId, scope, extra = {}) {
      const made = converting.then(() => convert(sessionId, scope, extra.model));
      converting = made.catch(() => undefined);
      return made;
    },
    async start(taskId) {
      const task = await need(taskId);
      const graph = activeGraphOf(task);
      if (task.startedAt !== null || task.cancelled || graph === undefined)
        throw new CommandError("task_state_invalid");
      const problem = validateGraph(graph, {
        projectless: task.projectId === null,
        localReadonly: task.scheduleDraft?.place === "local_readonly",
      })[0];
      if (problem !== undefined) throw graphError(problem);
      if (task.scheduleDraft !== null) {
        // A schedule rule's template is never started: saving the rule is what the button does (SPEC-0006, "定时").
        if (options.schedules === undefined || task.projectId === null) throw new CommandError("task_state_invalid");
        await options.schedules.confirm(task);
        return;
      }
      await runner.submit(taskId, { type: "started" });
    },
    async abandon(taskId) {
      const task = await need(taskId);
      if (task.startedAt !== null || task.cancelled) throw new CommandError("task_state_invalid");
      // A template whose rule was saved goes with the rule (`delete_schedule`), not by itself.
      if (options.schedules?.saved(taskId) === true) throw new CommandError("task_state_invalid");
      await runner.submit(taskId, { type: "abandoned" });
      await runner.detach(taskId);
      await rm(join(options.root, taskId), { recursive: true, force: true });
      options.logger.info({ taskId }, "task abandoned");
      await options.design.sessions.retire(task.taskSessionId).catch((error: unknown) => {
        options.logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "task conversation not archived");
      });
      if (task.origin.kind === "chat") await markSource(task.origin.sessionId, taskId, "abandoned");
    },
    async approveGraph(taskId, reviewed) {
      const task = await need(taskId);
      const pending = task.graphs.find((graph) => graph.version === task.pendingGraph);
      if (pending === undefined || task.startedAt === null || task.endedAt !== null) {
        throw new CommandError("task_state_invalid");
      }
      sameGraph(task, reviewed);
      const problem = validateGraph(pending, {
        projectless: task.projectId === null,
        localReadonly: false,
        started: task,
      })[0];
      if (problem !== undefined) throw graphError(problem);
      await runner.submit(taskId, { type: "graph_approved" }, (now) => sameGraph(now, reviewed));
    },
    async rejectGraph(taskId, reviewed) {
      const task = await need(taskId);
      if (task.pendingGraph === null || task.startedAt === null || task.endedAt !== null) {
        throw new CommandError("task_state_invalid");
      }
      sameGraph(task, reviewed);
      await runner.submit(taskId, { type: "graph_rejected" }, (now) => sameGraph(now, reviewed));
    },
    async answerHuman(taskId, node, answer) {
      const task = await need(taskId);
      const run = runOf(task, node);
      const kind = activeGraphOf(task)?.nodes.find((candidate) => candidate.id === node)?.kind;
      const open =
        run?.state === "waiting" && run.merging !== true && ["human", "merge_blocked"].includes(run.waitingFor ?? "");
      if (task.endedAt !== null || kind !== "human" || !open) throw new CommandError("task_state_invalid");
      if (answer.kind === "pass") {
        await runner.submit(taskId, { type: "human_passed", node });
        return;
      }
      const edge = activeGraphOf(task)?.edges.find(
        (one) => one.kind === "back" && one.from === node && one.to === answer.backTo,
      );
      if (edge === undefined) throw new CommandError("task_state_invalid");
      if (backUses(task, node, answer.backTo) >= BACK_LIMIT) throw new CommandError("task_back_limit");
      await runner.submit(taskId, { type: "human_sent_back", node, to: answer.backTo, reason: answer.reason });
    },
    async rerunNode(taskId, node) {
      const task = await need(taskId);
      if (task.endedAt !== null || runOf(task, node)?.state !== "failed" || task.paused) {
        throw new CommandError("task_state_invalid");
      }
      await runner.submit(taskId, { type: "rerun_requested", node });
    },
    async continueNode(taskId, node) {
      await need(taskId);
      await runner.continueNode(taskId, node);
    },
    async pause(taskId) {
      const task = await need(taskId);
      const status = deriveStatus(task);
      if (task.paused || task.endedAt !== null || task.startedAt === null || status === "designing") {
        throw new CommandError("task_state_invalid");
      }
      await runner.submit(taskId, { type: "paused" });
    },
    async resume(taskId) {
      const task = await need(taskId);
      if (!task.paused || task.endedAt !== null) throw new CommandError("task_state_invalid");
      await runner.submit(taskId, { type: "resumed" });
    },
    async cancel(taskId) {
      const task = await need(taskId);
      if (task.startedAt === null || task.endedAt !== null || task.cancelled)
        throw new CommandError("task_state_invalid");
      await runner.submit(taskId, { type: "cancelled" });
    },
    async answerArchive(taskId, answer) {
      const task = await need(taskId);
      const open = task.archive === "asked" || (task.archive === "kept" && answer === "archive");
      if (!open) throw new CommandError("task_state_invalid");
      if (answer === "archive") await options.archiving.archive(task);
      await runner.submit(taskId, { type: "archive_answered", answer });
    },
    onEvent: (listener) => runner.onEvent(listener),
    idle: () => runner.idle(),
    async close() {
      stopping.abort();
      await runner.close();
    },
  };
  return service;
}
