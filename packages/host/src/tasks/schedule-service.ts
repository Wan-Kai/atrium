import { CommandError } from "@atrium/protocol";
import { randomUUID } from "node:crypto";
import type { Clock } from "../platform/clock";
import { trackedTimeout } from "../platform/clock";
import type { Logger } from "../platform/logger";
import type { ResourceTracker } from "../platform/resources";
import { lastDue, localTimeZone, nextDue, wallOf } from "./cadence";
import { type ScheduleRule, readRules, writeRules } from "./schedule-rules";
import { deriveStatus } from "./status";
import type { Task } from "./types";

/*
 * The schedule rules and the clock that triggers them (SPEC-0006, "定时（ScheduleService）" and "T10 定下的细节").
 */

/** The longest the service sleeps: it looks at the clock again at least this often, which is how a Mac that slept, or a clock set back, is noticed. */
export const HEARTBEAT_MS = 60_000;

/** What the service needs from the tasks. */
export interface ScheduleTasks {
  /** A task by id, taken up from disk if it is there and not held; `undefined` when there is none. */
  lookup(taskId: string): Promise<Task | undefined>;
  /** Makes a started task of the rule and answers its id; see `TaskService.createScheduled`. */
  createScheduled(rule: ScheduleRule, name: string, firedAt: number, signal: AbortSignal): Promise<string>;
  /** Removes a template task and its conversation; a task that is not there is not an error. */
  discardTemplate(taskId: string): Promise<void>;
}

/** The rules, as the rest of the host uses them. */
export interface ScheduleService {
  /** The rules, in the order they were made. */
  list(): readonly ScheduleRule[];
  /** One rule; `undefined` if there is none. */
  rule(ruleId: string): ScheduleRule | undefined;
  /** When the rule fires next; `null` while it is paused. */
  nextAt(rule: ScheduleRule): number | null;
  /**
   * Reads the rules from the file.
   *
   * @remarks
   * The host calls it as soon as the service exists, so the commands of a window that connects before pi is found see
   * the rules. A rules file that cannot be read is logged and treated as no rules, and is not written over. Asked
   * again, it does nothing.
   */
  load(): Promise<void>;
  /**
   * Makes up for the triggers missed while the host was off (once per rule), and starts the clock.
   *
   * @remarks
   * Reads the rules first if `load` has not. Resolves when the catch-up is done.
   */
  start(): Promise<void>;
  /**
   * Saves the rule a template task stands for: a new one, or the changed one when a rule was saved from this template.
   *
   * @remarks
   * Nothing runs now. A changed rule keeps its place in time (when it last fired, whether it is paused).
   */
  confirm(template: Task, container: string): Promise<ScheduleRule>;
  /** Whether a rule was saved from this template task. */
  saved(templateTaskId: string): boolean;
  /** Pauses a rule; `task_state_invalid` if it is paused. */
  pause(ruleId: string): Promise<void>;
  /** Lets a paused rule go on from now; `task_state_invalid` if it is not paused. */
  resume(ruleId: string): Promise<void>;
  /** Makes a task of the rule now, whatever the last one is doing; answers its id. */
  runNow(ruleId: string): Promise<string>;
  /** Deletes a rule and its template task. */
  remove(ruleId: string): Promise<void>;
  /** Calls `listener` after a rule is added, changed or removed; returns a function that stops it. */
  onChange(listener: () => void): () => void;
  /** Resolves once every step under way, and the ones queued behind it, is done. */
  idle(): Promise<void>;
  /** Stops the clock and waits for the trigger under way. */
  close(): Promise<void>;
}

/**
 * The name of the task a trigger makes: "规则名 · 日期".
 *
 * @remarks
 * SPEC-0006, "界面 · 任务列表". The date is the day on the machine's clocks, "11 月 9 日". A rule that fires several
 * times a day (an interval) adds the time, "11 月 9 日 14:05", so that its tasks can be told apart. The host builds
 * this name because it is the task's data, not a message.
 *
 * @sideEffects none
 * @param rule - The rule.
 * @param at - When it fired.
 * @param timeZone - The zone whose clocks give the date.
 * @returns The name.
 */
export function scheduledTaskName(rule: Pick<ScheduleRule, "name" | "when">, at: number, timeZone: string): string {
  const wall = wallOf(at, timeZone);
  const date = `${String(wall.month)} 月 ${String(wall.date)} 日`;
  const time =
    rule.when.every === "interval"
      ? ` ${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`
      : "";
  return `${rule.name} · ${date}${time}`;
}

/**
 * The time after which a trigger of the rule counts.
 *
 * @remarks
 * A rule never makes up a trigger from before it was made or before its last one.
 *
 * @sideEffects none
 * @param rule - The rule.
 * @returns The later of its last trigger and its creation.
 */
function sinceOf(rule: ScheduleRule): number {
  return Math.max(rule.lastFiredAt ?? 0, rule.createdAt);
}

/**
 * Creates the schedule service.
 *
 * @remarks
 * One timer at most, counted as a `timer` resource, while some rule is not paused; it sleeps until the next trigger
 * or `HEARTBEAT_MS`, whichever is sooner, and on waking asks the clock what is due, so a clock set back or a Mac
 * that slept needs no special case. Everything that changes a rule or makes a task runs one at a time, in order.
 * All time comes from the injected clock; the zone is a parameter so that tests can use any.
 *
 * @sideEffects none until `start`; then reads and writes `file`, arms a timer, and makes tasks.
 * @param options - The file, the clock, the zone, the tasks and the logger.
 * @returns The service.
 */
export function createScheduleService(options: {
  readonly file: string;
  readonly clock: Clock;
  readonly resources: ResourceTracker;
  readonly logger: Logger;
  readonly tasks: ScheduleTasks;
  /** An IANA zone name; the machine's when left out. */
  readonly timeZone?: string;
  /** A fresh rule id; `rul_` and a name. */
  readonly newId?: () => string;
}): ScheduleService {
  const { clock, logger, tasks } = options;
  const timeZone = options.timeZone ?? localTimeZone();
  const newId = options.newId ?? ((): string => `rul_${randomUUID().replaceAll("-", "").slice(0, 16)}`);
  const stopping = new AbortController();
  const listeners = new Set<() => void>();
  let rules: ScheduleRule[] = [];
  let rest: unknown[] = [];
  /** The file could not be read: nothing is written over it. */
  let unreadable = false;
  let loaded = false;
  let cancelTimer: (() => void) | null = null;
  let closed = false;
  let chain: Promise<unknown> = Promise.resolve();

  /**
   * Runs a step after the ones before it.
   *
   * @remarks
   * A failed step does not stop the next.
   *
   * @sideEffects Whatever the step does.
   * @param step - The step.
   * @returns What the step gives.
   */
  function enqueue<T>(step: () => Promise<T>): Promise<T> {
    const result = chain.then(step);
    chain = result.catch(() => undefined);
    return result;
  }

  /**
   * Writes the rules down, unless the file was unreadable.
   *
   * @remarks
   * A file that could not be read is not written over, so a bad file is kept for the user to look at.
   *
   * @sideEffects Replaces the file.
   */
  async function save(): Promise<void> {
    if (unreadable) return;
    await writeRules(options.file, rules, rest);
  }

  /**
   * Tells the listeners.
   *
   * @remarks
   * The commands layer listens, to push the rows to the windows that watch.
   *
   * @sideEffects Calls them.
   */
  function changed(): void {
    for (const listener of listeners) listener();
  }

  /**
   * Replaces a rule in the list, in place.
   *
   * @remarks
   * The list keeps its order, which is the order the rules were made and the order of the tab's rows.
   *
   * @sideEffects Changes `rules`.
   * @param next - The changed rule.
   */
  function put(next: ScheduleRule): void {
    rules = rules.map((rule) => (rule.id === next.id ? next : rule));
  }

  /**
   * Whether the task of a rule's last trigger is still going.
   *
   * @remarks
   * SPEC-0006: not `done` and not `cancelled` is going, a task waiting for the user or stopped included; a task that
   * is gone counts as ended.
   *
   * @sideEffects Reads the task's files if it is not held.
   * @param rule - The rule.
   * @returns Whether the last task has not ended.
   */
  async function lastIsGoing(rule: ScheduleRule): Promise<boolean> {
    if (rule.lastTaskId === null) return false;
    const last = await tasks.lookup(rule.lastTaskId);
    return last !== undefined && !["done", "cancelled"].includes(deriveStatus(last));
  }

  /**
   * Handles one due trigger of a rule: skips it if the last task is going, else makes a task.
   *
   * @remarks
   * The time is recorded before the task is made: a crash in between loses one run, where the other order would
   * make two. A task that cannot be made is logged and the trigger is spent (`lastFiredAt` moves on), so a rule that
   * cannot run does not retry at every heartbeat.
   *
   * @sideEffects Writes the rules; makes a task.
   * @param rule - The rule.
   * @param due - When it should have fired.
   */
  async function fire(rule: ScheduleRule, due: number): Promise<void> {
    if (await lastIsGoing(rule)) {
      put({ ...rule, lastFiredAt: due, skipped: rule.skipped + 1 });
      await save();
      logger.info({ ruleId: rule.id }, "schedule trigger skipped: the last task is going");
      return;
    }
    put({ ...rule, lastFiredAt: due });
    await save();
    try {
      const taskId = await tasks.createScheduled(rule, scheduledTaskName(rule, due, timeZone), due, stopping.signal);
      put({ ...rule, lastFiredAt: due, lastTaskId: taskId, skipped: 0 });
      await save();
      logger.info({ ruleId: rule.id, taskId }, "schedule triggered");
    } catch (error) {
      logger.warn(
        { ruleId: rule.id, err: error instanceof Error ? error.name : "unknown" },
        "schedule trigger could not make its task",
      );
    }
  }

  /**
   * Makes up what is due now: for each rule that is not paused, at most one trigger.
   *
   * @remarks
   * However many triggers a rule missed (the host was off, the Mac slept), the latest one is run once
   * (SPEC-0006, "定时 · 错过"). On time or late, it is the same question: is there a trigger in (last, now].
   *
   * @sideEffects As `fire`.
   */
  async function dueNow(): Promise<void> {
    let any = false;
    for (const rule of rules) {
      if (closed) break;
      const current = rules.find((candidate) => candidate.id === rule.id);
      if (current === undefined || current.paused) continue;
      const due = lastDue(current.when, sinceOf(current), clock.now(), current.createdAt, timeZone);
      if (due === null) continue;
      any = true;
      await fire(current, due);
    }
    if (any) changed();
  }

  /**
   * Sets the timer for the next trigger, or for none.
   *
   * @remarks
   * There is a timer only while some rule is not paused and the service is open.
   *
   * @sideEffects Cancels and sets the timer.
   */
  function arm(): void {
    cancelTimer?.();
    cancelTimer = null;
    if (closed) return;
    const next = rules
      .filter((rule) => !rule.paused)
      .map((rule) => nextDue(rule.when, sinceOf(rule), rule.createdAt, timeZone));
    if (next.length === 0) return;
    const wait = Math.min(Math.max(Math.min(...next) - clock.now(), 1), HEARTBEAT_MS);
    cancelTimer = trackedTimeout(clock, options.resources, wake, wait);
  }

  /**
   * The timer rang: make up what is due, then set the timer again.
   *
   * @remarks
   * The step goes in the chain, which `close` waits for.
   *
   * @sideEffects As `dueNow` and `arm`.
   */
  function wake(): void {
    cancelTimer = null;
    void enqueue(async () => {
      await dueNow();
      arm();
    }).catch((error: unknown) => {
      logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "schedule check failed");
      arm();
    });
  }

  /**
   * Reads the file, the first time it is asked.
   *
   * @remarks
   * A file that cannot be read is logged once and leaves no rules; `unreadable` keeps the file from being written over.
   *
   * @sideEffects Reads the file; sets the rules.
   */
  async function readOnce(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
      ({ rules, rest } = await readRules(options.file));
    } catch (error) {
      unreadable = true;
      logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "schedules file not read");
    }
  }

  /**
   * Finds a rule or fails.
   *
   * @remarks
   * Every command that names a rule starts here, so the unknown one is always the same error.
   *
   * @sideEffects none
   * @param ruleId - The rule.
   * @returns The rule.
   * @throws {CommandError} `schedule_not_found`.
   */
  function need(ruleId: string): ScheduleRule {
    const found = rules.find((rule) => rule.id === ruleId);
    if (found === undefined) throw new CommandError("schedule_not_found", { scheduleId: ruleId });
    return found;
  }

  const service: ScheduleService = {
    list: () => rules,
    rule: (ruleId) => rules.find((rule) => rule.id === ruleId),
    nextAt: (rule) => (rule.paused ? null : nextDue(rule.when, sinceOf(rule), rule.createdAt, timeZone)),
    saved: (templateTaskId) => rules.some((rule) => rule.templateTaskId === templateTaskId),
    load: () => enqueue(readOnce),
    start() {
      return enqueue(async () => {
        await readOnce();
        await dueNow();
        arm();
      });
    },
    confirm(template, container) {
      return enqueue(async () => {
        const draft = template.scheduleDraft;
        const graph = template.graphs.find((one) => one.version === template.activeGraph);
        if (draft === null || graph === undefined || template.projectId === null) {
          throw new CommandError("task_state_invalid");
        }
        const known = rules.find((rule) => rule.templateTaskId === template.id);
        const made: ScheduleRule = {
          id: known?.id ?? newId(),
          name: template.name,
          projectId: template.projectId,
          containerId: container,
          sourceDir: template.sourceDir,
          when: draft.when,
          place: draft.place,
          summary: template.summary,
          graph: { nodes: graph.nodes, edges: graph.edges },
          model: template.model,
          templateTaskId: template.id,
          taskSessionId: template.taskSessionId,
          paused: known?.paused ?? false,
          createdAt: known?.createdAt ?? clock.now(),
          lastFiredAt: known?.lastFiredAt ?? null,
          lastTaskId: known?.lastTaskId ?? null,
          skipped: known?.skipped ?? 0,
        };
        rules = known === undefined ? [...rules, made] : rules.map((rule) => (rule.id === made.id ? made : rule));
        await save();
        arm();
        changed();
        return made;
      });
    },
    pause(ruleId) {
      return enqueue(async () => {
        const rule = need(ruleId);
        if (rule.paused) throw new CommandError("task_state_invalid");
        put({ ...rule, paused: true });
        await save();
        arm();
        changed();
      });
    },
    resume(ruleId) {
      return enqueue(async () => {
        const rule = need(ruleId);
        if (!rule.paused) throw new CommandError("task_state_invalid");
        // What fell due while it was paused is not made up: the rule goes on from now.
        put({ ...rule, paused: false, lastFiredAt: Math.max(rule.lastFiredAt ?? 0, clock.now()) });
        await save();
        arm();
        changed();
      });
    },
    runNow(ruleId) {
      return enqueue(async () => {
        const rule = need(ruleId);
        const now = clock.now();
        const taskId = await tasks.createScheduled(rule, scheduledTaskName(rule, now, timeZone), now, stopping.signal);
        const current = rules.find((candidate) => candidate.id === ruleId) ?? rule;
        put({ ...current, lastTaskId: taskId, skipped: 0 });
        await save();
        changed();
        return taskId;
      });
    },
    remove(ruleId) {
      return enqueue(async () => {
        const rule = need(ruleId);
        rules = rules.filter((candidate) => candidate.id !== ruleId);
        await save();
        arm();
        changed();
        await tasks.discardTemplate(rule.templateTaskId).catch((error: unknown) => {
          logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "template task not removed");
        });
      });
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async idle() {
      await chain;
    },
    async close() {
      closed = true;
      cancelTimer?.();
      cancelTimer = null;
      stopping.abort();
      await chain;
      listeners.clear();
    },
  };
  return service;
}
