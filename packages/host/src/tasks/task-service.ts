import { join } from "node:path";
import type { Clock } from "../platform/clock";
import type { Logger } from "../platform/logger";
import type { TaskRunner } from "./runner";
import { openTaskStore } from "./task-store";
import type { Task, TaskEventInput } from "./types";

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
  /** Calls `listener` after every event is recorded; returns a function that stops it. */
  onEvent: TaskRunner["onEvent"];
  /** Resolves once every task's queue is done. */
  idle(): Promise<void>;
  /** Stops looking after the tasks. */
  close(): Promise<void>;
}

/**
 * Creates the task service.
 *
 * @remarks
 * SPEC-0006, "总体结构": a task lives in `<root>/<id>/` (`events.jsonl` and `task.json`, `TaskStore`) and the
 * runner carries out what its events bring. T4 has no commands over the protocol yet (T5, T6): this is the
 * handle the host's tests and `task:try` use.
 *
 * @sideEffects none until a call; then writes under `root`.
 * @param options - The runner, the tasks' directory, the clock and the logger.
 * @returns The service.
 */
export function createTaskService(options: {
  readonly runner: TaskRunner;
  readonly root: string;
  readonly clock: Clock;
  readonly logger: Logger;
}): TaskService {
  const { runner } = options;
  return {
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
    onEvent: (listener) => runner.onEvent(listener),
    idle: () => runner.idle(),
    close: () => runner.close(),
  };
}
