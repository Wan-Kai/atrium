import { CommandError, type ArchiveAnswer, type HumanAnswer, type TaskView } from "@atrium/protocol";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "../platform/clock";
import type { Logger } from "../platform/logger";
import { BACK_LIMIT, activeGraphOf, liveRun } from "./graph";
import type { TaskRunner } from "./runner";
import { backUses } from "./scheduler";
import { deriveStatus } from "./status";
import type { TaskArchiving } from "./task-archiving";
import { openTaskStore } from "./task-store";
import { viewOf } from "./task-view";
import type { NodeId, NodeRun, Task, TaskEventInput } from "./types";

/** A task's directory name: what `newTaskRecord` and `pnpm task:try` make ids of. */
const TASK_DIRECTORY = /^tsk_[0-9A-Za-z_-]{1,64}$/u;

/** The host's tasks, as the rest of the host and (later) the protocol use them. */
export interface TaskService {
  /** Starts a task: writes its `created` event and looks after it. */
  create(task: Task): Promise<Task>;
  /** Takes up a task that is on disk, replaying its events if its snapshot is behind. */
  open(taskId: string): Promise<Task>;
  /** Records an event for a task and carries out what it brings. */
  submit(taskId: string, input: TaskEventInput): Promise<Task>;
  /** The task as it is. */
  task(taskId: string): Task | undefined;
  /** Takes up a task again after the host restarted; see `TaskRunner.recover`. */
  recover(taskId: string): Promise<void>;
  /**
   * Every task, those on disk that were not taken up yet included.
   *
   * @remarks
   * Taking a task up only reads its files (`open`); it does not start anything. Picking nodes up again after a
   * restart is `recover`'s, which T9 calls for the tasks that were running.
   */
  list(): Promise<Task[]>;
  /** The tasks taken up so far, in the order they were. */
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
  /** Calls `listener` after every event is recorded; returns a function that stops it. */
  onEvent: TaskRunner["onEvent"];
  /** Resolves once every task's queue is done. */
  idle(): Promise<void>;
  /** Stops looking after the tasks. */
  close(): Promise<void>;
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
}): TaskService {
  const { runner } = options;

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

  const service: TaskService = {
    async create(task) {
      const store = await openTaskStore(join(options.root, task.id), options.clock);
      runner.attach(task.id, store);
      options.logger.info({ taskId: task.id }, "task created");
      return runner.submit(task.id, { type: "created", task });
    },
    async open(taskId) {
      const store = await openTaskStore(join(options.root, taskId), options.clock);
      const task = store.current();
      if (task === null) throw new Error(`task ${taskId} has no events`);
      runner.attach(taskId, store);
      return task;
    },
    submit: (taskId, input) => runner.submit(taskId, input),
    task: (taskId) => runner.task(taskId),
    recover: (taskId) => runner.recover(taskId),
    held: () => runner.all(),
    async list() {
      const names = await readdir(options.root).catch(() => [] as string[]);
      for (const name of names.filter((one) => TASK_DIRECTORY.test(one))) {
        if (runner.task(name) === undefined) {
          await service.open(name).catch((error: unknown) => {
            options.logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "a task could not be read");
          });
        }
      }
      return names.flatMap((name) => runner.task(name) ?? []);
    },
    async view(taskId, signal) {
      const task = await need(taskId);
      const asked = task.archive === "asked" || task.archive === "kept";
      const facts = asked ? await options.archiving.facts(task, signal).catch(() => null) : null;
      return viewOf(task, facts);
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
    close: () => runner.close(),
  };
  return service;
}
