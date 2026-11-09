import { CommandError, type CommandResult, type ScheduleSummary, type SchedulesUpdatedEvent } from "@atrium/protocol";
import type { Logger } from "../platform/logger";
import type { ScheduleRule } from "./schedule-rules";
import type { ScheduleService } from "./schedule-service";
import type { TaskService } from "./task-service";
import { summaryOf } from "./task-view";

/**
 * What the router needs from the schedules (SPEC-0006, "协议（给 UI）" and "T10 定下的细节").
 *
 * @remarks
 * Defined by the server layer's needs; `createScheduleCommands` implements it. Failures are thrown as `CommandError`.
 */
export interface ScheduleCommands {
  /** The rules; `watch` starts or stops `schedules_updated` for the connection. */
  list(connectionId: string, watch: boolean | undefined): Promise<CommandResult<"list_schedules">>;
  pause(scheduleId: string): Promise<CommandResult<"pause_schedule">>;
  resume(scheduleId: string): Promise<CommandResult<"resume_schedule">>;
  /** Makes a task of the rule now; answers its id. */
  runNow(scheduleId: string): Promise<CommandResult<"run_schedule_now">>;
  remove(scheduleId: string): Promise<CommandResult<"delete_schedule">>;
  /** Starts the template's conversation and answers the template task, for the client to open. */
  edit(scheduleId: string): Promise<CommandResult<"edit_schedule">>;
  /** A connection closed; it watches nothing more. */
  disconnect(connectionId: string): void;
  /** Stops listening and waits for the push under way. */
  close(): Promise<void>;
}

/** What the commands send to a connection. */
export type SchedulePush = SchedulesUpdatedEvent;

/**
 * Creates the schedule commands: the router's view of the schedules, and the pushes to the connections that watch.
 *
 * @remarks
 * Without a service (the host follows another process's tasks, read-only) every command fails with `task_read_only`
 * and the list is empty. With a rules file that cannot be read, the list and every command fail with
 * `schedule_file_unreadable`. A push goes out after a rule changes and after an event of the task a rule last made (its
 * status is in the row), one at a time in the order they came, each row worked out when its turn comes. The host sends
 * codes and states, never words.
 *
 * @sideEffects none until a connection watches; then listens to the service and the tasks, and sends through `send`.
 * @param options - The service (or none), the tasks, how to send to a connection, and the logger.
 * @returns The commands.
 */
export function createScheduleCommands(options: {
  readonly schedules: ScheduleService | undefined;
  readonly tasks: Pick<TaskService, "lookup" | "onEvent" | "openSession">;
  readonly send: (connectionId: string, event: SchedulePush) => void;
  readonly logger: Logger;
}): ScheduleCommands {
  const { schedules } = options;
  const watchers = new Set<string>();
  let chain: Promise<unknown> = Promise.resolve();
  let seq = 0;

  /**
   * One rule as a row.
   *
   * @remarks
   * The task of the last trigger gives its status and whether a node failed; a task that is gone gives none.
   *
   * @sideEffects Reads the task's files if it is not held.
   * @param service - The service.
   * @param rule - The rule.
   * @returns The row.
   */
  async function rowOf(service: ScheduleService, rule: ScheduleRule): Promise<ScheduleSummary> {
    const last = rule.lastTaskId === null ? undefined : await options.tasks.lookup(rule.lastTaskId);
    const row = last === undefined ? null : summaryOf(last);
    return {
      id: rule.id,
      name: rule.name,
      projectId: rule.projectId,
      place: rule.place,
      when: rule.when,
      paused: rule.paused,
      nextAt: service.nextAt(rule),
      last: row === null ? null : { taskId: row.id, status: row.status, failed: row.attention === "failed" },
      skipped: rule.skipped,
      templateTaskId: rule.templateTaskId,
      createdAt: rule.createdAt,
    };
  }

  /**
   * All the rows.
   *
   * @remarks
   * One row reads its last task, which may be on disk and not held, so the rows are worked out together.
   *
   * @sideEffects As `rowOf`.
   * @param service - The service.
   * @returns The rows, in the order the rules were made.
   */
  async function rows(service: ScheduleService): Promise<ScheduleSummary[]> {
    return Promise.all(service.list().map((rule) => rowOf(service, rule)));
  }

  /**
   * Sends the rows to the connections that watch.
   *
   * @remarks
   * Runs in the push chain; a failure is logged, not thrown, so the next push still goes.
   *
   * @sideEffects Sends.
   */
  async function push(): Promise<void> {
    if (schedules === undefined || watchers.size === 0) return;
    try {
      const list = await rows(schedules);
      seq += 1;
      for (const connectionId of watchers)
        options.send(connectionId, { type: "schedules_updated", seq, schedules: list });
    } catch (error) {
      options.logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "schedule push failed");
    }
  }

  /**
   * Queues a push.
   *
   * @remarks
   * Pushes go one at a time in the order they were asked for, so a window never sees an older list after a newer one.
   *
   * @sideEffects Extends the chain.
   */
  function queuePush(): void {
    chain = chain.then(push);
  }

  const stops: (() => void)[] = [];
  if (schedules !== undefined) {
    stops.push(schedules.onChange(queuePush));
    stops.push(
      options.tasks.onEvent((task) => {
        if (schedules.list().some((rule) => rule.lastTaskId === task.id)) queuePush();
      }),
    );
  }

  /**
   * The service, or the refusal a followed host gives.
   *
   * @remarks
   * A followed host has no service; every command that changes a rule goes through here to be refused alike.
   *
   * @sideEffects none
   * @returns The service.
   * @throws {CommandError} `task_read_only`.
   */
  function writable(): ScheduleService {
    if (schedules === undefined) throw new CommandError("task_read_only");
    return schedules;
  }

  /**
   * Checks a rule exists.
   *
   * @remarks
   * `edit` needs the rule's template before the service would complain, so it checks first.
   *
   * @sideEffects none
   * @param scheduleId - The rule.
   * @returns The rule.
   * @throws {CommandError} `task_read_only`, `schedule_file_unreadable`, `schedule_not_found`.
   */
  function found(scheduleId: string): ScheduleRule {
    const service = writable();
    if (service.unreadable()) throw new CommandError("schedule_file_unreadable");
    const rule = service.rule(scheduleId);
    if (rule === undefined) throw new CommandError("schedule_not_found", { scheduleId });
    return rule;
  }

  return {
    async list(connectionId, watch) {
      // A rules file nobody can read has no rules to show: the window shows the error in their place.
      if (schedules?.unreadable() === true && watch !== false) throw new CommandError("schedule_file_unreadable");
      if (watch === true) watchers.add(connectionId);
      else if (watch === false) watchers.delete(connectionId);
      return { schedules: schedules === undefined ? [] : await rows(schedules) };
    },
    async pause(scheduleId) {
      await writable().pause(scheduleId);
      return {};
    },
    async resume(scheduleId) {
      await writable().resume(scheduleId);
      return {};
    },
    async runNow(scheduleId) {
      return { taskId: await writable().runNow(scheduleId) };
    },
    async remove(scheduleId) {
      await writable().remove(scheduleId);
      return {};
    },
    async edit(scheduleId) {
      const rule = found(scheduleId);
      const template = await options.tasks.lookup(rule.templateTaskId);
      if (template === undefined) throw new CommandError("task_not_found");
      await options.tasks.openSession(template.id, template.taskSessionId);
      return { taskId: template.id };
    },
    disconnect(connectionId) {
      watchers.delete(connectionId);
    },
    async close() {
      for (const stop of stops) stop();
      watchers.clear();
      await chain;
    },
  };
}
