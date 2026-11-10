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
  /**
   * The tasks a rule made that are on disk, whatever `lastTaskId` says.
   *
   * @remarks
   * A host that died after a task was started and before the rule recorded it leaves a task the rule does not know.
   */
  ofRule(ruleId: string): Promise<readonly Task[]>;
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
   * Reads the rules first if `load` has not; then each rule's `lastTaskId` is made to agree with the tasks on disk
   * (a crash between a task starting and the rule recording it). Until `start`, commands change and save rules but
   * set no timer. Resolves when the catch-up is done. With a rules file that cannot be read it starts nothing.
   */
  start(): Promise<void>;
  /**
   * Saves the rule a template task stands for: a new one, or the changed one when a rule was saved from this template.
   *
   * @remarks
   * Nothing runs now. A changed rule keeps whether it is paused, and counts from the moment of saving: what fell due
   * before is not made up (SPEC-0006, "T9 / T10 审查后用户定"). The template is read again when its turn comes, so a
   * save queued behind a deletion fails with `schedule_not_found` instead of making the rule again. Fails with
   * `schedule_file_unreadable` while the rules file cannot be read.
   */
  confirm(template: Task, container: string): Promise<ScheduleRule>;
  /** Whether a rule was saved from this template task. */
  saved(templateTaskId: string): boolean;
  /** Whether the rules file could not be read: nothing is saved or started until the file is dealt with. */
  unreadable(): boolean;
  /** Pauses a rule; `task_state_invalid` if it is paused. */
  pause(ruleId: string): Promise<void>;
  /** Lets a paused rule go on from now; `task_state_invalid` if it is not paused. */
  resume(ruleId: string): Promise<void>;
  /** Makes a task of the rule now, whatever the last one is doing; answers its id, and it counts as the rule's last task. */
  runNow(ruleId: string): Promise<string>;
  /** Deletes a rule and its template task (the template first, so a crash cannot leave a template nobody can see). */
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
 * A rule never makes up a trigger from before it was made or before its last one. An interval counts from the same
 * moment, so that a rule changed or resumed goes on from then (SPEC-0006, "T9 / T10 审查后用户定").
 *
 * @sideEffects none
 * @param rule - The rule.
 * @returns The later of its last trigger and its creation.
 */
function sinceOf(rule: ScheduleRule): number {
  return Math.max(rule.lastFiredAt ?? 0, rule.createdAt);
}

/**
 * The time a task of a rule was fired for.
 *
 * @remarks
 * What puts a rule's tasks in order when `lastTaskId` is made to agree with the disk; a run now is fired for the
 * moment it was asked.
 *
 * @sideEffects none
 * @param task - A task of a rule.
 * @returns The `firedAt` of its origin; 0 for a task that no rule made.
 */
function firedAtOf(task: Task): number {
  return task.origin.kind === "schedule" ? task.origin.firedAt : 0;
}

/**
 * Whether a task has not ended.
 *
 * @remarks
 * SPEC-0006, "定时 · 到点": `done` and `cancelled` are the two ends; waiting for the user and stopped are not.
 *
 * @sideEffects none
 * @param task - The task.
 * @returns Whether it is still going.
 */
function isGoing(task: Task): boolean {
  return !["done", "cancelled"].includes(deriveStatus(task));
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
  /**
   * Whether pi can run, asked when a trigger is due.
   *
   * @remarks
   * While it cannot, a trigger waits: it is not made and not spent (SPEC-0006, "T9 / T10 审查后用户定"). Always ready when left out.
   */
  readonly ready?: () => Promise<boolean>;
}): ScheduleService {
  const { clock, logger, tasks } = options;
  const timeZone = options.timeZone ?? localTimeZone();
  const newId = options.newId ?? ((): string => `rul_${randomUUID().replaceAll("-", "").slice(0, 16)}`);
  const ready = options.ready ?? ((): Promise<boolean> => Promise.resolve(true));
  const stopping = new AbortController();
  const listeners = new Set<() => void>();
  let rules: ScheduleRule[] = [];
  let rest: unknown[] = [];
  /** The file could not be read: nothing is written over it. */
  let unreadable = false;
  let loaded = false;
  /** `start` has run: only then does a timer run the rules by itself. */
  let started = false;
  /** A trigger was due and pi was not ready, so it waits; the timer then looks again at the heartbeat. */
  let waitingForPi = false;
  /** The warning that triggers wait for pi was logged, until pi is ready again. */
  let warnedAboutPi = false;
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
   * Writes the rules down.
   *
   * @remarks
   * Never reached with a file that could not be read: every command that changes a rule refuses first (`writable`),
   * and `start` does nothing, so a bad file is kept for the user to look at.
   *
   * @sideEffects Replaces the file.
   */
  async function save(): Promise<void> {
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
   * is gone counts as ended. Besides the task `lastTaskId` names, any task on disk made by this rule that has not
   * ended counts (the host died after starting it and before recording it), and so does one "立即跑一次" made.
   *
   * @sideEffects Reads the tasks' files if they are not held.
   * @param rule - The rule.
   * @returns Whether the last task has not ended.
   */
  async function lastIsGoing(rule: ScheduleRule): Promise<boolean> {
    if (rule.lastTaskId !== null) {
      const last = await tasks.lookup(rule.lastTaskId);
      if (last !== undefined && isGoing(last)) return true;
    }
    // A task the rule made but did not get to record (the host died in between) is also its last.
    return (await tasks.ofRule(rule.id)).some(isGoing);
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
   * (SPEC-0006, "定时 · 错过"). On time or late, it is the same question: is there a trigger in (last, now]. A trigger
   * that is due while pi cannot run is left as it is (`waitingForPi`), with one warning until pi is ready again.
   *
   * @sideEffects As `fire`; asks whether pi is ready.
   */
  async function dueNow(): Promise<void> {
    let any = false;
    waitingForPi = false;
    for (const rule of rules) {
      if (closed) break;
      const current = rules.find((candidate) => candidate.id === rule.id);
      if (current === undefined || current.paused) continue;
      const due = lastDue(current.when, sinceOf(current), clock.now(), sinceOf(current), timeZone);
      if (due === null) continue;
      // A trigger needs pi to start the task's conversation. Without it the trigger is not made and not spent:
      // the next start with pi ready makes it up like any missed one.
      if (!(await ready())) {
        waitingForPi = true;
        if (!warnedAboutPi) {
          warnedAboutPi = true;
          logger.warn({ ruleId: current.id }, "schedule trigger waits for pi");
        }
        continue;
      }
      warnedAboutPi = false;
      any = true;
      await fire(current, due);
    }
    if (any) changed();
  }

  /**
   * Sets the timer for the next trigger, or for none.
   *
   * @remarks
   * There is a timer only while some rule is not paused, the service is open and `start` has run.
   *
   * @sideEffects Cancels and sets the timer.
   */
  function arm(): void {
    cancelTimer?.();
    cancelTimer = null;
    // Before `start` the host is still taking its tasks up again; the rules do not run by themselves yet.
    if (closed || !started) return;
    const next = rules
      .filter((rule) => !rule.paused)
      .map((rule) => nextDue(rule.when, sinceOf(rule), sinceOf(rule), timeZone));
    if (next.length === 0) return;
    // A trigger that waits for pi is overdue for good; looking again at once would spin, so it waits for the heartbeat.
    const wait = waitingForPi ? HEARTBEAT_MS : Math.min(Math.max(Math.min(...next) - clock.now(), 1), HEARTBEAT_MS);
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
   * Reads the file if that is not done, and refuses when it cannot be read.
   *
   * @remarks
   * Every command that would change a rule starts here: with a rules file nobody can read, nothing is installed in
   * memory, nothing is saved and no timer is set (SPEC-0006, "T9 / T10 审查后用户定").
   *
   * @sideEffects Reads the file the first time.
   * @throws {CommandError} `schedule_file_unreadable`.
   */
  async function writable(): Promise<void> {
    await readOnce();
    if (unreadable) throw new CommandError("schedule_file_unreadable");
  }

  /**
   * Makes each rule's `lastTaskId` agree with the tasks on disk.
   *
   * @remarks
   * The host can die after a task has started and before the rule records it; the latest task the rule made (by the
   * time it was fired for) is its last, whatever the file says. Writes only if something changed.
   *
   * @sideEffects Reads the tasks' files; writes the rules.
   */
  async function reconcile(): Promise<void> {
    let changedAny = false;
    for (const rule of rules) {
      const mine = await tasks.ofRule(rule.id);
      const newest = mine.toSorted((a, b) => firedAtOf(b) - firedAtOf(a) || b.createdAt - a.createdAt)[0];
      if (newest === undefined || newest.id === rule.lastTaskId) continue;
      // A last task that is not on disk any more gives way to the one that is; one that is as new stays.
      const known = mine.find((task) => task.id === rule.lastTaskId);
      if (known !== undefined && firedAtOf(known) >= firedAtOf(newest)) continue;
      put({ ...rule, lastTaskId: newest.id, skipped: 0 });
      changedAny = true;
    }
    if (changedAny) {
      await save();
      changed();
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
    nextAt: (rule) => (rule.paused ? null : nextDue(rule.when, sinceOf(rule), sinceOf(rule), timeZone)),
    saved: (templateTaskId) => rules.some((rule) => rule.templateTaskId === templateTaskId),
    unreadable: () => unreadable,
    load: () => enqueue(readOnce),
    start() {
      return enqueue(async () => {
        await readOnce();
        if (unreadable || closed) return;
        await reconcile();
        started = true;
        await dueNow();
        arm();
      });
    },
    confirm(template, container) {
      // Whether this template had a rule when it was saved: if one was there and is gone when this turn comes, the
      // rule was deleted in between and must not be made again from a template that is gone too.
      const knewId = rules.find((rule) => rule.templateTaskId === template.id)?.id;
      return enqueue(async () => {
        await writable();
        // The template as it is now, not as the caller held it: a deletion queued ahead of this save took it away.
        const current = await tasks.lookup(template.id);
        const known = rules.find((rule) => rule.templateTaskId === template.id);
        if (current === undefined || (knewId !== undefined && known === undefined)) {
          throw new CommandError("schedule_not_found", { scheduleId: knewId ?? template.id });
        }
        const draft = current.scheduleDraft;
        const graph = current.graphs.find((one) => one.version === current.activeGraph);
        if (draft === null || graph === undefined || current.projectId === null) {
          throw new CommandError("task_state_invalid");
        }
        const made: ScheduleRule = {
          id: known?.id ?? newId(),
          name: current.name,
          projectId: current.projectId,
          containerId: container,
          sourceDir: current.sourceDir,
          when: draft.when,
          place: draft.place,
          summary: current.summary,
          graph: { nodes: graph.nodes, edges: graph.edges },
          model: current.model,
          templateTaskId: current.id,
          taskSessionId: current.taskSessionId,
          paused: known?.paused ?? false,
          createdAt: known?.createdAt ?? clock.now(),
          // A changed rule counts from now: what fell due before the edit is not made up, and saving never fires.
          lastFiredAt: known === undefined ? null : Math.max(known.lastFiredAt ?? 0, clock.now()),
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
        await writable();
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
        await writable();
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
        await writable();
        const rule = need(ruleId);
        const now = clock.now();
        const taskId = await tasks.createScheduled(rule, scheduledTaskName(rule, now, timeZone), now, stopping.signal);
        const current = rules.find((candidate) => candidate.id === ruleId) ?? rule;
        // The task counts as the rule's last: while it goes, the next trigger is skipped like after any other.
        put({ ...current, lastTaskId: taskId, skipped: 0 });
        await save();
        changed();
        return taskId;
      });
    },
    remove(ruleId) {
      return enqueue(async () => {
        await writable();
        const rule = need(ruleId);
        // The template goes first: a crash between the two leaves a rule whose template is gone (which is allowed: the
        // rule still fires and "修改" says so), never a template no rule owns and nobody can see.
        await tasks.discardTemplate(rule.templateTaskId).catch((error: unknown) => {
          logger.warn({ err: error instanceof Error ? error.name : "unknown" }, "template task not removed");
        });
        rules = rules.filter((candidate) => candidate.id !== ruleId);
        await save();
        arm();
        changed();
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
