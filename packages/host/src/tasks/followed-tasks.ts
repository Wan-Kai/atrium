import { CommandError } from "@atrium/protocol";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "../platform/clock";
import type { Logger } from "../platform/logger";
import type { ResourceTracker } from "../platform/resources";
import { type TaskFollower, startTaskFollower } from "./task-follower";
import { type TaskService, isAbandoned } from "./task-service";
import { viewOf } from "./task-view";
import type { Task } from "./types";

/**
 * Adds the tasks another process writes to the host's own, read-only.
 *
 * @remarks
 * SPEC-0006, "T7.1 定下的细节". The followed tasks appear in `list`, `held`, `view` and `onEvent` like the
 * host's own, so the board needs no path of its own; every command that would change one fails with
 * `task_read_only` before it reaches the service, so the scheduler never runs, recovers or carries out anything
 * for it and no pi starts. A followed task is never attached to the runner. An own task wins when an id is the
 * same (the follower skips the other). The wrapped service's `close` also stops the follower.
 *
 * @sideEffects Reads and watches `directory`, as `startTaskFollower` does; logs warnings.
 * @param options - The service to wrap, the directory to follow and what the follower needs.
 * @returns The service with the followed tasks added.
 */
export async function followTasks(options: {
  readonly owned: TaskService;
  /** The host's own tasks directory. */
  readonly ownRoot: string;
  /** `task:try`'s `<home>/tasks`. */
  readonly directory: string;
  readonly clock: Clock;
  readonly resources: ResourceTracker;
  readonly logger: Logger;
  readonly follower?: Partial<
    Pick<Parameters<typeof startTaskFollower>[0], "watch" | "debounceMs" | "pollMs" | "retryMs">
  >;
}): Promise<TaskService> {
  const { owned } = options;
  const follower: TaskFollower = await startTaskFollower({
    directory: options.directory,
    ownRoot: options.ownRoot,
    isOwned: async (taskId) =>
      owned.task(taskId) !== undefined ||
      (await access(join(options.ownRoot, taskId)).then(
        () => true,
        () => false,
      )),
    clock: options.clock,
    resources: options.resources,
    logger: options.logger,
    ...options.follower,
  });

  /**
   * The followed task with this id, when there is one and no own task has it.
   *
   * @remarks
   * Own tasks are looked at first, so the commands' routing is never ambiguous.
   *
   * @sideEffects none
   * @param taskId - The id.
   * @returns The task, or `undefined`.
   */
  const followed = (taskId: string): Task | undefined =>
    owned.task(taskId) === undefined ? follower.task(taskId) : undefined;

  /**
   * Refuses a command on a followed task.
   *
   * @remarks
   * Called first by every command that changes a task, so nothing of it is read, recorded or started.
   *
   * @sideEffects none
   * @param taskId - The task the command names.
   * @throws {CommandError} `task_read_only` when the task is followed.
   */
  const refuseIfFollowed = (taskId: string): void => {
    if (followed(taskId) !== undefined) throw new CommandError("task_read_only");
  };

  return {
    ...owned,
    task: (taskId) => owned.task(taskId) ?? followed(taskId),
    async open(taskId) {
      return followed(taskId) ?? owned.open(taskId);
    },
    async list() {
      const own = await owned.list();
      const ids = new Set(own.map((task) => task.id));
      return [...own, ...follower.tasks().filter((task) => !ids.has(task.id) && !isAbandoned(task))];
    },
    held() {
      const own = owned.held();
      const ids = new Set(own.map((task) => task.id));
      return [...own, ...follower.tasks().filter((task) => !ids.has(task.id) && !isAbandoned(task))];
    },
    async view(taskId, signal) {
      const task = followed(taskId);
      return task === undefined ? owned.view(taskId, signal) : viewOf(task, null, true);
    },
    async submit(taskId, input) {
      refuseIfFollowed(taskId);
      return owned.submit(taskId, input);
    },
    async recover(taskId) {
      refuseIfFollowed(taskId);
      await owned.recover(taskId);
    },
    async recoverAll(request) {
      // Only this host's own tasks are on its disk to find; the followed ones are another process's and are never read here.
      await owned.recoverAll({ ...request, staleLocks: false });
    },
    async answerHuman(taskId, node, answer) {
      refuseIfFollowed(taskId);
      await owned.answerHuman(taskId, node, answer);
    },
    async rerunNode(taskId, node) {
      refuseIfFollowed(taskId);
      await owned.rerunNode(taskId, node);
    },
    async continueNode(taskId, node) {
      refuseIfFollowed(taskId);
      await owned.continueNode(taskId, node);
    },
    async pause(taskId) {
      refuseIfFollowed(taskId);
      await owned.pause(taskId);
    },
    async resume(taskId) {
      refuseIfFollowed(taskId);
      await owned.resume(taskId);
    },
    async cancel(taskId) {
      refuseIfFollowed(taskId);
      await owned.cancel(taskId);
    },
    async answerArchive(taskId, answer) {
      refuseIfFollowed(taskId);
      await owned.answerArchive(taskId, answer);
    },
    async openSession(taskId, sessionId) {
      refuseIfFollowed(taskId);
      await owned.openSession(taskId, sessionId);
    },
    async start(taskId) {
      refuseIfFollowed(taskId);
      await owned.start(taskId);
    },
    async abandon(taskId) {
      refuseIfFollowed(taskId);
      await owned.abandon(taskId);
    },
    async approveGraph(taskId, reviewed) {
      refuseIfFollowed(taskId);
      await owned.approveGraph(taskId, reviewed);
    },
    async rejectGraph(taskId, reviewed) {
      refuseIfFollowed(taskId);
      await owned.rejectGraph(taskId, reviewed);
    },
    onEvent(listener) {
      const stopOwn = owned.onEvent(listener);
      // Nothing was carried out for a followed task's events: the actions are always empty.
      const stopFollowed = follower.onChange((task, event) => listener(task, event, []));
      return () => {
        stopOwn();
        stopFollowed();
      };
    },
    async close() {
      await follower.close();
      await owned.close();
    },
  };
}
