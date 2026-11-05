import {
  CommandError,
  type CommandResult,
  type HumanAnswer,
  type TaskUpdatedEvent,
  type TasksUpdatedEvent,
} from "@atrium/protocol";
import type { Logger } from "../platform/logger";
import type { TaskService } from "./task-service";
import { summaryOf } from "./task-view";

/**
 * What the router needs from tasks (SPEC-0006, "协议（给 UI）").
 *
 * @remarks
 * Defined by the server layer's needs; `createTaskCommands` implements it. Failures are thrown as
 * `CommandError`.
 */
export interface TaskCommands {
  /** The tasks; `watch` starts or stops `tasks_updated` for the connection. */
  list(connectionId: string, watch: boolean | undefined): Promise<CommandResult<"list_tasks">>;
  /** One task whole; the connection gets `task_updated` for it from then on, instead of for the one it had open. */
  open(connectionId: string, taskId: string): Promise<CommandResult<"open_task">>;
  /** Makes a task of a conversation, answering its id; see the protocol's `create_task`. */
  create(sessionId: string, scope: string | undefined): Promise<CommandResult<"create_task">>;
  start(taskId: string): Promise<CommandResult<"start_task">>;
  abandon(taskId: string): Promise<CommandResult<"abandon_task">>;
  approveGraph(taskId: string): Promise<CommandResult<"approve_graph">>;
  rejectGraph(taskId: string): Promise<CommandResult<"reject_graph">>;
  answerHuman(taskId: string, node: string, answer: HumanAnswer): Promise<CommandResult<"answer_human">>;
  rerunNode(taskId: string, node: string): Promise<CommandResult<"rerun_node">>;
  continueNode(taskId: string, node: string): Promise<CommandResult<"continue_node">>;
  pause(taskId: string): Promise<CommandResult<"pause_task">>;
  resume(taskId: string): Promise<CommandResult<"resume_task">>;
  cancel(taskId: string): Promise<CommandResult<"cancel_task">>;
  answerArchive(taskId: string, answer: "archive" | "keep"): Promise<CommandResult<"answer_archive">>;
  /** A connection closed; it watches nothing more. */
  disconnect(connectionId: string): void;
  /** Stops listening to the tasks and waits for the pushes under way. */
  close(): Promise<void>;
}

/** What the commands send to a connection. */
export type TaskPush = TasksUpdatedEvent | TaskUpdatedEvent;

/**
 * Creates the task commands: the router's view of the task service, and the pushes to the connections that watch.
 *
 * @remarks
 * SPEC-0006, "协议（给 UI）". After each event a task records, the connections that watch the list get
 * `tasks_updated` (all the rows, whole) and those that opened the task get `task_updated` (the task, whole).
 * Pushes go one at a time in the order the events came, each worked out when its turn comes (the archive
 * facts need git), so a client never sees an older state after a newer one. A task a connection opened that
 * is gone is not pushed. The host sends codes and states, never words.
 *
 * @sideEffects none until a connection watches; then listens to the service and sends through `send`.
 * @param options - The service, how to send to a connection, and the logger.
 * @returns The commands.
 */
export function createTaskCommands(options: {
  readonly service: TaskService;
  readonly send: (connectionId: string, event: TaskPush) => void;
  readonly logger: Logger;
}): TaskCommands {
  const { service } = options;
  const listWatchers = new Set<string>();
  const opened = new Map<string, string>();
  const stopping = new AbortController();
  let chain: Promise<unknown> = Promise.resolve();
  let seq = 0;

  /**
   * Sends the list to the connections that watch it.
   *
   * @remarks
   * Whole each time.
   *
   * @sideEffects Sends.
   */
  function pushList(): void {
    if (listWatchers.size === 0) return;
    seq += 1;
    const tasks = service.held().map(summaryOf);
    for (const connectionId of listWatchers) options.send(connectionId, { type: "tasks_updated", seq, tasks });
  }

  /**
   * Works out and sends what one recorded event changed.
   *
   * @remarks
   * Runs in the push chain. A failure is logged, not thrown: a push that cannot be made must not stop the next.
   *
   * @sideEffects Sends; may run git.
   * @param taskId - The task the event was about.
   */
  async function push(taskId: string): Promise<void> {
    try {
      pushList();
      const watchers = [...opened].filter(([, id]) => id === taskId).map(([connectionId]) => connectionId);
      if (watchers.length === 0) return;
      const task = await service.view(taskId, stopping.signal);
      for (const connectionId of watchers) {
        if (opened.get(connectionId) === taskId) options.send(connectionId, { type: "task_updated", task });
      }
    } catch (error) {
      // A task that was abandoned is gone on purpose; the list went out above, and there is nothing to push for it.
      if (error instanceof CommandError && error.code === "task_not_found") return;
      options.logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "task push failed");
    }
  }

  const unsubscribe = service.onEvent((task) => {
    chain = chain.then(() => push(task.id));
  });

  return {
    async list(connectionId, watch) {
      const tasks = await service.list();
      if (watch === true) listWatchers.add(connectionId);
      else if (watch === false) listWatchers.delete(connectionId);
      return { tasks: tasks.map(summaryOf) };
    },
    async open(connectionId, taskId) {
      const task = await service.view(taskId, stopping.signal);
      opened.set(connectionId, taskId);
      return { task };
    },
    create: (sessionId, scope) => service.createFromChat(sessionId, scope),
    async start(taskId) {
      await service.start(taskId);
      return {};
    },
    async abandon(taskId) {
      await service.abandon(taskId);
      return {};
    },
    async approveGraph(taskId) {
      await service.approveGraph(taskId);
      return {};
    },
    async rejectGraph(taskId) {
      await service.rejectGraph(taskId);
      return {};
    },
    async answerHuman(taskId, node, answer) {
      await service.answerHuman(taskId, node, answer);
      return {};
    },
    async rerunNode(taskId, node) {
      await service.rerunNode(taskId, node);
      return {};
    },
    async continueNode(taskId, node) {
      await service.continueNode(taskId, node);
      return {};
    },
    async pause(taskId) {
      await service.pause(taskId);
      return {};
    },
    async resume(taskId) {
      await service.resume(taskId);
      return {};
    },
    async cancel(taskId) {
      await service.cancel(taskId);
      return {};
    },
    async answerArchive(taskId, answer) {
      await service.answerArchive(taskId, answer);
      return {};
    },
    disconnect(connectionId) {
      listWatchers.delete(connectionId);
      opened.delete(connectionId);
    },
    async close() {
      unsubscribe();
      stopping.abort();
      await chain;
      listWatchers.clear();
      opened.clear();
    },
  };
}
