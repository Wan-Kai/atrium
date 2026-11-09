import { CommandError } from "@atrium/protocol";
import { createTempDir } from "@atrium/testkit";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import type { Clock } from "../platform/clock";
import { ResourceTracker } from "../platform/resources";
import { type ScheduleRule, readRules } from "./schedule-rules";
import { HEARTBEAT_MS, type ScheduleTasks, createScheduleService, scheduledTaskName } from "./schedule-service";
import { Sim, agent, newTask } from "./test-support";
import type { Task } from "./types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** An instant from its parts in UTC. */
const utc = (y: number, m: number, d: number, h = 0, min = 0): number => Date.UTC(y, m - 1, d, h, min);

/**
 * A clock the test sets, forwards or back, with timers that fire when it is told to.
 *
 * @remarks
 * `FakeClock` only moves forward; the system clock being set back is one of the cases.
 *
 * @sideEffects none
 */
class TestClock implements Clock {
  t: number;
  timers: { readonly dueAt: number; readonly callback: () => void }[] = [];

  /**
   * Starts at an instant.
   *
   * @sideEffects none
   * @param start - Epoch milliseconds.
   */
  constructor(start: number) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(callback: () => void, ms: number): () => void {
    const timer = { dueAt: this.t + Math.max(0, ms), callback };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((one) => one !== timer);
    };
  }
}

/** What the fake tasks were asked. */
interface Made {
  readonly ruleId: string;
  readonly name: string;
  readonly firedAt: number;
  readonly taskId: string;
}

/**
 * The tasks port: tasks that exist have the status the test gave them.
 *
 * @sideEffects none
 */
interface FakeTasks extends ScheduleTasks {
  readonly made: Made[];
  readonly discarded: string[];
  /** Task id to what it is; a missing id is a task that is gone. */
  readonly states: Map<string, "running" | "done" | "cancelled" | "stopped">;
  failNext: boolean;
  /** The signal of each task the service made. */
  readonly signals: AbortSignal[];
}

/**
 * A task in a status, for `deriveStatus` to read.
 *
 * @sideEffects none
 * @param id - The task id.
 * @param state - The status wanted.
 * @returns The task.
 */
function taskIn(id: string, state: "running" | "done" | "cancelled" | "stopped"): Task {
  const sim = new Sim({ ...newTask([agent("N1")], []), id });
  sim.send({ type: "started" });
  if (state === "cancelled") return { ...sim.task, cancelled: true };
  if (state === "stopped") {
    sim.send({ type: "paused" });
    return sim.task;
  }
  if (state === "done") {
    sim.send({ type: "node_started", node: "N1", attempt: 1, sessionId: "s", startCommit: null });
    sim.send({ type: "node_done_pending", node: "N1", attempt: 1, ok: true, summary: "s" });
    sim.send({ type: "node_settled", node: "N1", attempt: 1 });
  }
  return sim.task;
}

/**
 * Fake tasks.
 *
 * @sideEffects none
 * @returns The port.
 */
function fakeTasks(): FakeTasks {
  const states = new Map<string, "running" | "done" | "cancelled" | "stopped">();
  const made: Made[] = [];
  const port: FakeTasks = {
    made,
    discarded: [],
    states,
    failNext: false,
    signals: [],
    async lookup(taskId) {
      const state = states.get(taskId);
      return state === undefined ? undefined : taskIn(taskId, state);
    },
    async createScheduled(rule, name, firedAt, signal) {
      port.signals.push(signal);
      if (port.failNext) {
        port.failNext = false;
        throw new Error("no pi");
      }
      const taskId = `tsk_made${String(made.length + 1)}`;
      made.push({ ruleId: rule.id, name, firedAt, taskId });
      states.set(taskId, "running");
      return taskId;
    },
    async discardTemplate(taskId) {
      port.discarded.push(taskId);
    },
  };
  return port;
}

/**
 * A template task for a rule.
 *
 * @sideEffects none
 * @param when - The cadence.
 * @param place - Where it runs.
 * @returns The task.
 */
function template(
  when: NonNullable<Task["scheduleDraft"]>["when"],
  place: "new_worktree" | "local_readonly" = "new_worktree",
): Task {
  return {
    ...newTask([agent("N1")], []),
    id: "tsk_template",
    name: "Nightly check",
    taskSessionId: "ses_template",
    scheduleDraft: { when, place },
  };
}

/**
 * A schedule service over a clock, a zone and a directory.
 *
 * @sideEffects Creates a temporary directory; closes the service when the test finishes.
 * @param options - The clock, the zone, the directory (to restart on the same files) and the tasks.
 * @returns The service and what it was given.
 */
async function setUp(options: {
  clock: TestClock;
  timeZone: string;
  dir?: string;
  tasks?: FakeTasks;
  defaultIds?: boolean;
}) {
  const dir =
    options.dir ??
    (await (async () => {
      const made = await createTempDir("schedules-");
      onTestFinished(made.cleanup);
      return made.path;
    })());
  const tasks = options.tasks ?? fakeTasks();
  const resources = new ResourceTracker();
  const { logger, records } = recordingTracing();
  const file = join(dir, "schedules.json");
  let made = 0;
  const service = createScheduleService({
    file,
    clock: options.clock,
    resources,
    logger,
    tasks,
    timeZone: options.timeZone,
    ...(options.defaultIds === true ? {} : { newId: () => `rul_${["one", "two", "three"][made++] ?? "more"}` }),
  });
  onTestFinished(() => service.close());
  return { service, tasks, resources, file, dir, records, clock: options.clock };
}

/**
 * Moves the clock forward, firing the timers on the way and letting each trigger finish.
 *
 * @sideEffects Runs the service's timers.
 * @param ctx - The set-up.
 * @param to - The instant to reach.
 */
async function runTo(ctx: Awaited<ReturnType<typeof setUp>>, to: number): Promise<void> {
  const { clock, service } = ctx;
  for (;;) {
    const next = clock.timers.toSorted((a, b) => a.dueAt - b.dueAt)[0];
    if (next === undefined || next.dueAt > to) break;
    clock.timers = clock.timers.filter((one) => one !== next);
    clock.t = Math.max(clock.t, next.dueAt);
    next.callback();
    await service.idle();
  }
  clock.t = to;
}

describe("a rule fires at its time", () => {
  it("makes a task named after the rule and the day, on the machine's clocks, and records it", async () => {
    // 2026-11-08 18:00 UTC is 11-09 02:00 in Shanghai.
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 8, 10, 0)), timeZone: "Asia/Shanghai" });
    await ctx.service.start();
    await ctx.service.confirm(template({ every: "day", at: "2:00" }), "wsp_1");
    expect(ctx.tasks.made).toStrictEqual([]);

    await runTo(ctx, utc(2026, 11, 8, 18, 0));
    expect(ctx.tasks.made).toStrictEqual([
      { ruleId: "rul_one", name: "Nightly check · 11 月 9 日", firedAt: utc(2026, 11, 8, 18, 0), taskId: "tsk_made1" },
    ]);
    expect(ctx.service.rule("rul_one")).toMatchObject({
      lastFiredAt: utc(2026, 11, 8, 18, 0),
      lastTaskId: "tsk_made1",
      skipped: 0,
    });
    expect(ctx.service.nextAt(ctx.service.list()[0] as ScheduleRule)).toBe(utc(2026, 11, 9, 18, 0));
    const onDisk = await readRules(ctx.file);
    expect(onDisk.rules[0]).toMatchObject({ lastTaskId: "tsk_made1", lastFiredAt: utc(2026, 11, 8, 18, 0) });
  });

  it("adds the time to the name when the rule fires several times a day", () => {
    expect(
      scheduledTaskName(
        { name: "Poll", when: { every: "interval", minutes: 5 } },
        utc(2026, 11, 9, 6, 5),
        "Asia/Shanghai",
      ),
    ).toBe("Poll · 11 月 9 日 14:05");
    expect(
      scheduledTaskName({ name: "Poll", when: { every: "day", at: "2:00" } }, utc(2026, 11, 9, 6, 5), "Asia/Shanghai"),
    ).toBe("Poll · 11 月 9 日");
  });

  it("makes a task every 5 minutes for an interval rule, and not before the first one is due", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 10, 0)), timeZone: "UTC" });
    await ctx.service.start();
    await ctx.service.confirm(template({ every: "interval", minutes: 5 }), "wsp_1");
    await runTo(ctx, utc(2026, 11, 9, 10, 4));
    expect(ctx.tasks.made).toHaveLength(0);
    ctx.tasks.states.set("tsk_made1", "done");
    await runTo(ctx, utc(2026, 11, 9, 10, 5));
    expect(ctx.tasks.made.map((one) => one.firedAt)).toStrictEqual([utc(2026, 11, 9, 10, 5)]);
    ctx.tasks.states.set("tsk_made1", "done");
    await runTo(ctx, utc(2026, 11, 9, 10, 10));
    expect(ctx.tasks.made.map((one) => one.firedAt)).toStrictEqual([utc(2026, 11, 9, 10, 5), utc(2026, 11, 9, 10, 10)]);
  });

  it("does not run a trigger from before the rule was made", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 5, 0)), timeZone: "UTC" });
    await ctx.service.start();
    await ctx.service.confirm(template({ every: "day", at: "2:00" }), "wsp_1");
    await ctx.service.close();
    const again = await setUp({ clock: new TestClock(utc(2026, 11, 9, 5, 30)), timeZone: "UTC", dir: ctx.dir });
    await again.service.start();
    expect(again.tasks.made).toStrictEqual([]);
  });
});

describe("the last run has not ended", () => {
  it("skips the trigger, counts it and moves the time on; the next one after it ended makes a task", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 10, 0)), timeZone: "UTC" });
    await ctx.service.start();
    await ctx.service.confirm(template({ every: "interval", minutes: 5 }), "wsp_1");
    await runTo(ctx, utc(2026, 11, 9, 10, 5));
    expect(ctx.tasks.made).toHaveLength(1);

    await runTo(ctx, utc(2026, 11, 9, 10, 10));
    expect(ctx.tasks.made).toHaveLength(1);
    expect(ctx.service.rule("rul_one")).toMatchObject({
      skipped: 1,
      lastFiredAt: utc(2026, 11, 9, 10, 10),
      lastTaskId: "tsk_made1",
    });

    // A task waiting for the user, or stopped, has not ended either.
    ctx.tasks.states.set("tsk_made1", "stopped");
    await runTo(ctx, utc(2026, 11, 9, 10, 15));
    expect(ctx.service.rule("rul_one")?.skipped).toBe(2);

    ctx.tasks.states.set("tsk_made1", "cancelled");
    await runTo(ctx, utc(2026, 11, 9, 10, 20));
    expect(ctx.tasks.made).toHaveLength(2);
    expect(ctx.service.rule("rul_one")).toMatchObject({ skipped: 0, lastTaskId: "tsk_made2" });
  });

  it("counts a last task that is gone as ended", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 10, 0)), timeZone: "UTC" });
    await ctx.service.start();
    await ctx.service.confirm(template({ every: "interval", minutes: 5 }), "wsp_1");
    await runTo(ctx, utc(2026, 11, 9, 10, 5));
    ctx.tasks.states.delete("tsk_made1");
    await runTo(ctx, utc(2026, 11, 9, 10, 10));
    expect(ctx.tasks.made).toHaveLength(2);
  });
});

/**
 * A rule made on the 1st at 10:00 that last fired on the 2nd at 2:00, and a host that comes back after a gap.
 *
 * @remarks
 * The first host is closed; the second reads the same file, with fake tasks in which the last task is as given.
 *
 * @sideEffects Creates a temporary directory and two services.
 * @param gap - How long the host was off after that trigger.
 * @param last - What the last task is doing, or `null` when it is gone.
 * @returns The set-up of the host that came back.
 */
async function offFor(gap: number, last: "running" | "done" | null) {
  const first = await setUp({ clock: new TestClock(utc(2026, 11, 1, 10, 0)), timeZone: "UTC" });
  await first.service.start();
  await first.service.confirm(template({ every: "day", at: "2:00" }), "wsp_1");
  await runTo(first, utc(2026, 11, 2, 2, 0));
  expect(first.tasks.made).toHaveLength(1);
  await first.service.close();
  const tasks = fakeTasks();
  if (last !== null) tasks.states.set("tsk_made1", last);
  return setUp({ clock: new TestClock(utc(2026, 11, 2, 2, 0) + gap), timeZone: "UTC", dir: first.dir, tasks });
}

describe("the host was off (SPEC-0006, 定时 · 错过)", () => {
  it("runs once to catch up, however many triggers were missed, and records the latest one", async () => {
    const ctx = await offFor(3 * DAY + 5 * HOUR, "done");
    await ctx.service.start();
    expect(ctx.tasks.made).toHaveLength(1);
    expect(ctx.tasks.made[0]?.firedAt).toBe(utc(2026, 11, 5, 2, 0));
    expect(ctx.service.rule("rul_one")?.lastFiredAt).toBe(utc(2026, 11, 5, 2, 0));
    // And then it goes on at the usual time.
    ctx.tasks.states.set("tsk_made1", "done");
    await runTo(ctx, utc(2026, 11, 6, 2, 0));
    expect(ctx.tasks.made).toHaveLength(2);
  });

  it("runs nothing when no trigger fell in the gap", async () => {
    const ctx = await offFor(HOUR, "done");
    await ctx.service.start();
    expect(ctx.tasks.made).toStrictEqual([]);
  });

  it("catches up and skips together: several missed, the last run still going, one skip and no task", async () => {
    const ctx = await offFor(3 * DAY + 5 * HOUR, "running");
    await ctx.service.start();
    expect(ctx.tasks.made).toStrictEqual([]);
    expect(ctx.service.rule("rul_one")).toMatchObject({ skipped: 1, lastFiredAt: utc(2026, 11, 5, 2, 0) });
  });

  it("catches up an interval rule once after 15 minutes off", async () => {
    const first = await setUp({ clock: new TestClock(utc(2026, 11, 9, 10, 0)), timeZone: "UTC" });
    await first.service.start();
    await first.service.confirm(template({ every: "interval", minutes: 5 }), "wsp_1");
    await first.service.close();
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 10, 16)), timeZone: "UTC", dir: first.dir });
    await ctx.service.start();
    expect(ctx.tasks.made.map((one) => one.firedAt)).toStrictEqual([utc(2026, 11, 9, 10, 15)]);
  });
});

describe("time zones and daylight saving time", () => {
  it("fires 2:00 at different instants in different zones", async () => {
    const a = await setUp({ clock: new TestClock(utc(2026, 11, 8, 0, 0)), timeZone: "Asia/Shanghai" });
    const b = await setUp({ clock: new TestClock(utc(2026, 11, 8, 0, 0)), timeZone: "America/New_York" });
    for (const ctx of [a, b]) {
      await ctx.service.start();
      await ctx.service.confirm(template({ every: "day", at: "2:00" }), "wsp_1");
      await runTo(ctx, utc(2026, 11, 8, 23, 0));
    }
    expect(a.tasks.made.map((one) => one.firedAt)).toStrictEqual([utc(2026, 11, 7, 18, 0) + DAY]);
    expect(b.tasks.made.map((one) => one.firedAt)).toStrictEqual([utc(2026, 11, 8, 7, 0)]);
  });

  it("runs a rule on the spring-forward day once, at the first minute that exists", async () => {
    // 2026-03-08 in New York: 02:00 EST jumps to 03:00 EDT at 07:00 UTC, so 2:30 does not exist that day.
    const ctx = await setUp({ clock: new TestClock(utc(2026, 3, 7, 12, 0)), timeZone: "America/New_York" });
    await ctx.service.start();
    await ctx.service.confirm(template({ every: "day", at: "2:30" }), "wsp_1");
    await runTo(ctx, utc(2026, 3, 8, 6, 59));
    expect(ctx.tasks.made).toStrictEqual([]);
    await runTo(ctx, utc(2026, 3, 8, 7, 0));
    expect(ctx.tasks.made.map((one) => one.firedAt)).toStrictEqual([utc(2026, 3, 8, 7, 0)]);
    // Not again at the 2:30 the clocks did have an hour later on a plain day: the next is tomorrow's 2:30 EDT.
    ctx.tasks.states.set("tsk_made1", "done");
    await runTo(ctx, utc(2026, 3, 9, 6, 29));
    expect(ctx.tasks.made).toHaveLength(1);
    await runTo(ctx, utc(2026, 3, 9, 6, 30));
    expect(ctx.tasks.made.map((one) => one.firedAt)).toStrictEqual([utc(2026, 3, 8, 7, 0), utc(2026, 3, 9, 6, 30)]);
  });

  it("runs a rule on the fall-back day once, though the time comes twice", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 10, 31, 12, 0)), timeZone: "America/New_York" });
    await ctx.service.start();
    await ctx.service.confirm(template({ every: "day", at: "1:30" }), "wsp_1");
    await runTo(ctx, utc(2026, 11, 1, 5, 30));
    expect(ctx.tasks.made.map((one) => one.firedAt)).toStrictEqual([utc(2026, 11, 1, 5, 30)]);
    ctx.tasks.states.set("tsk_made1", "done");
    await runTo(ctx, utc(2026, 11, 1, 7, 0));
    expect(ctx.tasks.made).toHaveLength(1);
    await runTo(ctx, utc(2026, 11, 2, 6, 30));
    expect(ctx.tasks.made.map((one) => one.firedAt)).toStrictEqual([utc(2026, 11, 1, 5, 30), utc(2026, 11, 2, 6, 30)]);
  });
});

describe("the system clock is set back", () => {
  it("neither makes up nor repeats a trigger, and waits for the next time", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC" });
    await ctx.service.start();
    await ctx.service.confirm(template({ every: "day", at: "10:00" }), "wsp_1");
    await runTo(ctx, utc(2026, 11, 9, 10, 0));
    expect(ctx.tasks.made).toHaveLength(1);
    ctx.tasks.states.set("tsk_made1", "done");

    // An hour back, and the old 10:00 comes round again.
    ctx.clock.t = utc(2026, 11, 9, 9, 0);
    await runTo(ctx, utc(2026, 11, 9, 9, 30));
    await runTo(ctx, utc(2026, 11, 9, 10, 30));
    expect(ctx.tasks.made).toHaveLength(1);

    await runTo(ctx, utc(2026, 11, 10, 10, 0));
    expect(ctx.tasks.made).toHaveLength(2);
  });

  it("makes a rule made in the future by a clock set back wait until its own time", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 12, 0)), timeZone: "UTC" });
    await ctx.service.start();
    await ctx.service.confirm(template({ every: "interval", minutes: 5 }), "wsp_1");
    ctx.clock.t = utc(2026, 11, 9, 10, 0);
    await runTo(ctx, utc(2026, 11, 9, 11, 0));
    expect(ctx.tasks.made).toStrictEqual([]);
    await runTo(ctx, utc(2026, 11, 9, 12, 5));
    expect(ctx.tasks.made).toHaveLength(1);
  });
});

describe("the template task is gone", () => {
  it("does not stop the rule, which keeps its own summary and graph", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC" });
    await ctx.service.start();
    await ctx.service.confirm(template({ every: "day", at: "10:00" }), "wsp_1");
    // The fake knows no `tsk_template`: it is gone.
    expect(await ctx.tasks.lookup("tsk_template")).toBeUndefined();
    await runTo(ctx, utc(2026, 11, 9, 10, 0));
    expect(ctx.tasks.made).toHaveLength(1);
  });

  it("is removed with the rule, and the rule goes even if the template cannot be removed", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC" });
    await ctx.service.start();
    await ctx.service.confirm(template({ every: "day", at: "10:00" }), "wsp_1");
    ctx.tasks.discardTemplate = async () => {
      throw new Error("disk");
    };
    await ctx.service.remove("rul_one");
    expect(ctx.service.list()).toStrictEqual([]);
    expect((await readRules(ctx.file)).rules).toStrictEqual([]);
    expect(ctx.records.some((record) => record.msg === "template task not removed")).toBe(true);
  });
});

describe("pausing, resuming, running now and deleting", () => {
  it("fires nothing while paused, makes up nothing on resume, and holds no timer when nothing is active", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC" });
    await ctx.service.start();
    await ctx.service.confirm(template({ every: "interval", minutes: 5 }), "wsp_1");
    expect(ctx.resources.snapshot()["timer"]).toBe(1);

    await ctx.service.pause("rul_one");
    expect(ctx.resources.snapshot()["timer"]).toBe(0);
    expect(ctx.clock.timers).toHaveLength(0);
    await runTo(ctx, utc(2026, 11, 9, 11, 0));
    expect(ctx.tasks.made).toStrictEqual([]);
    expect(ctx.service.nextAt(ctx.service.list()[0] as ScheduleRule)).toBeNull();

    await ctx.service.resume("rul_one");
    expect(ctx.resources.snapshot()["timer"]).toBe(1);
    expect(ctx.tasks.made).toStrictEqual([]);
    await runTo(ctx, utc(2026, 11, 9, 11, 5));
    expect(ctx.tasks.made.map((one) => one.firedAt)).toStrictEqual([utc(2026, 11, 9, 11, 5)]);
  });

  it("refuses to pause a paused rule, to resume a running one, and any command for an unknown rule", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC" });
    await ctx.service.start();
    await ctx.service.confirm(template({ every: "day", at: "10:00" }), "wsp_1");
    await expect(ctx.service.resume("rul_one")).rejects.toMatchObject({ code: "task_state_invalid" });
    await ctx.service.pause("rul_one");
    await expect(ctx.service.pause("rul_one")).rejects.toMatchObject({ code: "task_state_invalid" });
    for (const command of [
      (id: string) => ctx.service.pause(id),
      (id: string) => ctx.service.resume(id),
      (id: string) => ctx.service.runNow(id),
      (id: string) => ctx.service.remove(id),
    ]) {
      await expect(command("rul_nope")).rejects.toStrictEqual(
        new CommandError("schedule_not_found", { scheduleId: "rul_nope" }),
      );
    }
  });

  it("runs now whatever the last run is doing, without moving the rule's own times", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC" });
    await ctx.service.start();
    await ctx.service.confirm(template({ every: "day", at: "10:00" }), "wsp_1");
    await runTo(ctx, utc(2026, 11, 9, 10, 0));
    const before = ctx.service.rule("rul_one");
    ctx.clock.t = utc(2026, 11, 9, 12, 0);
    const taskId = await ctx.service.runNow("rul_one");
    expect(taskId).toBe("tsk_made2");
    expect(ctx.tasks.made[1]).toMatchObject({ firedAt: utc(2026, 11, 9, 12, 0), name: "Nightly check · 11 月 9 日" });
    expect(ctx.service.rule("rul_one")).toStrictEqual({ ...before, lastTaskId: "tsk_made2", skipped: 0 });
  });

  it("keeps a paused rule paused through a restart, and does not run it", async () => {
    const first = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC" });
    await first.service.start();
    await first.service.confirm(template({ every: "interval", minutes: 5 }), "wsp_1");
    await first.service.pause("rul_one");
    await first.service.close();
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 13, 0)), timeZone: "UTC", dir: first.dir });
    await ctx.service.start();
    expect(ctx.tasks.made).toStrictEqual([]);
    expect(ctx.resources.snapshot()).toStrictEqual({});
  });
});

describe("saving a rule from its template", () => {
  it("saves a changed rule over the same one, keeping its place in time", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC" });
    await ctx.service.start();
    await ctx.service.confirm(template({ every: "interval", minutes: 5 }), "wsp_1");
    // One task made, one trigger skipped, then paused.
    await runTo(ctx, utc(2026, 11, 9, 9, 10));
    await ctx.service.pause("rul_one");
    const saved = await ctx.service.confirm(
      { ...template({ every: "day", at: "11:00" }, "local_readonly"), name: "Renamed" },
      "wsp_1",
    );
    expect(ctx.service.list()).toHaveLength(1);
    expect(saved).toMatchObject({
      id: "rul_one",
      name: "Renamed",
      paused: true,
      place: "local_readonly",
      when: { every: "day", at: "11:00" },
      createdAt: utc(2026, 11, 9, 9, 0),
      lastFiredAt: utc(2026, 11, 9, 9, 10),
      lastTaskId: "tsk_made1",
      skipped: 1,
    });
    expect(ctx.service.saved("tsk_template")).toBe(true);
    expect(ctx.service.saved("tsk_other")).toBe(false);
  });

  it("refuses a task that is no template or has no project or graph", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC" });
    await ctx.service.start();
    const base = template({ every: "day", at: "10:00" });
    for (const bad of [
      { ...base, scheduleDraft: null },
      { ...base, projectId: null },
      { ...base, graphs: [], activeGraph: 0 },
    ]) {
      await expect(ctx.service.confirm(bad, "wsp_1")).rejects.toMatchObject({ code: "task_state_invalid" });
    }
    expect(ctx.service.list()).toStrictEqual([]);
  });
});

describe("failures", () => {
  it("spends a trigger whose task could not be made, logs it, and tries again at the next", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC" });
    await ctx.service.start();
    await ctx.service.confirm(template({ every: "interval", minutes: 5 }), "wsp_1");
    ctx.tasks.failNext = true;
    await runTo(ctx, utc(2026, 11, 9, 9, 5));
    expect(ctx.tasks.made).toStrictEqual([]);
    expect(ctx.service.rule("rul_one")).toMatchObject({ lastFiredAt: utc(2026, 11, 9, 9, 5), lastTaskId: null });
    expect(ctx.records.some((record) => record.msg === "schedule trigger could not make its task")).toBe(true);
    await runTo(ctx, utc(2026, 11, 9, 9, 10));
    expect(ctx.tasks.made).toHaveLength(1);
  });

  it("leaves a rules file it cannot read as it is, and keeps the entries it does not understand when it writes", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC" });
    await writeFile(ctx.file, "not json");
    await ctx.service.start();
    await ctx.service.confirm(template({ every: "day", at: "10:00" }), "wsp_1");
    expect(await readFile(ctx.file, "utf8")).toBe("not json");
    expect(ctx.records.some((record) => record.msg === "schedules file not read")).toBe(true);

    const other = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC" });
    await writeFile(other.file, JSON.stringify({ v: 1, rules: [{ from: "a newer Atrium" }] }));
    await other.service.start();
    await other.service.confirm(template({ every: "day", at: "10:00" }), "wsp_1");
    const text = JSON.parse(await readFile(other.file, "utf8")) as { rules: unknown[] };
    expect(text.rules).toHaveLength(2);
    expect(text.rules[1]).toStrictEqual({ from: "a newer Atrium" });
  });
});

describe("the timer", () => {
  it("is one timer at most, set for the next trigger or the heartbeat, and gone after close", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC" });
    await ctx.service.start();
    expect(ctx.clock.timers).toHaveLength(0);
    await ctx.service.confirm(template({ every: "interval", minutes: 5 }), "wsp_1");
    await ctx.service.confirm({ ...template({ every: "day", at: "23:00" }), id: "tsk_template2" }, "wsp_1");
    // The next trigger is 5 minutes away, but the service looks at the clock at least every HEARTBEAT_MS.
    expect(ctx.clock.timers.map((timer) => timer.dueAt - ctx.clock.t)).toStrictEqual([HEARTBEAT_MS]);
    await runTo(ctx, utc(2026, 11, 9, 9, 3));
    await ctx.service.remove("rul_one");
    expect(ctx.clock.timers).toHaveLength(1);
    expect(ctx.clock.timers[0]?.dueAt).toBe(utc(2026, 11, 9, 9, 4));
    await ctx.service.close();
    expect(ctx.clock.timers).toHaveLength(0);
    expect(ctx.resources.snapshot()["timer"]).toBe(0);
  });
});

describe("load and start", () => {
  it("shows the rules after load, before the catch-up and the clock start; asked again, load reads nothing", async () => {
    const first = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC" });
    await first.service.start();
    await first.service.confirm(template({ every: "interval", minutes: 5 }), "wsp_1");
    await first.service.close();

    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 30)), timeZone: "UTC", dir: first.dir });
    expect(ctx.service.list()).toStrictEqual([]);
    await ctx.service.load();
    expect(ctx.service.list().map((rule) => rule.id)).toStrictEqual(["rul_one"]);
    expect(ctx.tasks.made).toStrictEqual([]);
    expect(ctx.clock.timers).toHaveLength(0);
    // A command that names the rule finds it, though nothing has started.
    await ctx.service.pause("rul_one");
    await writeFile(ctx.file, JSON.stringify({ v: 1, rules: [] }));
    await ctx.service.load();
    expect(ctx.service.rule("rul_one")?.paused).toBe(true);

    await ctx.service.start();
    expect(ctx.tasks.made).toStrictEqual([]);
  });
});

describe("what the service tells and logs", () => {
  it("tells its listeners after a rule is saved, paused, resumed, run now and removed, and after a trigger; not after a quiet check, nor once stopped", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC" });
    let told = 0;
    const stop = ctx.service.onChange(() => void (told += 1));
    await ctx.service.start();
    expect(told).toBe(0);
    await ctx.service.confirm(template({ every: "interval", minutes: 5 }), "wsp_1");
    expect(told).toBe(1);
    await runTo(ctx, utc(2026, 11, 9, 9, 3));
    expect(told).toBe(1);
    await runTo(ctx, utc(2026, 11, 9, 9, 5));
    expect(told).toBe(2);
    await ctx.service.pause("rul_one");
    await ctx.service.resume("rul_one");
    await ctx.service.runNow("rul_one");
    expect(told).toBe(5);
    stop();
    await ctx.service.remove("rul_one");
    expect(told).toBe(5);
    const other = ctx.service.onChange(() => void (told += 1));
    await ctx.service.confirm(template({ every: "day", at: "10:00" }), "wsp_1");
    expect(told).toBe(6);
    other();
    await ctx.service.close();
    expect(ctx.tasks.signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("logs a skipped trigger, a made task, and a task that could not be made, with the rule and no words of the user's", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC" });
    await ctx.service.start();
    await ctx.service.confirm(template({ every: "interval", minutes: 5 }), "wsp_1");
    await runTo(ctx, utc(2026, 11, 9, 9, 5));
    await runTo(ctx, utc(2026, 11, 9, 9, 10));
    ctx.tasks.states.set("tsk_made1", "done");
    ctx.tasks.failNext = true;
    await runTo(ctx, utc(2026, 11, 9, 9, 15));
    const logged = ctx.records
      .filter((record) => String(record.msg).startsWith("schedule"))
      .map((record) => [record.level, record.msg, record["ruleId"], record["taskId"], record["err"]]);
    expect(logged).toStrictEqual([
      ["info", "schedule triggered", "rul_one", "tsk_made1", undefined],
      ["info", "schedule trigger skipped: the last task is going", "rul_one", undefined, undefined],
      ["warn", "schedule trigger could not make its task", "rul_one", undefined, "Error"],
    ]);
  });

  it("logs a rules file it could not read and a template it could not remove, by the kind of error", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC" });
    await writeFile(ctx.file, "not json");
    await ctx.service.start();
    const other = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC" });
    await other.service.start();
    await other.service.confirm(template({ every: "day", at: "10:00" }), "wsp_1");
    other.tasks.discardTemplate = async () => {
      throw new TypeError("disk");
    };
    await other.service.remove("rul_one");
    const warned = (records: typeof ctx.records) =>
      records.filter((record) => record.level === "warn").map((record) => [record.msg, record["err"]]);
    expect(warned(ctx.records)).toStrictEqual([["schedules file not read", "SyntaxError"]]);
    expect(warned(other.records)).toStrictEqual([["template task not removed", "TypeError"]]);
  });

  it("makes its own rule ids when it is given none: rul_ and sixteen hex digits, a new one each time", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC", defaultIds: true });
    await ctx.service.start();
    const a = await ctx.service.confirm(template({ every: "day", at: "10:00" }), "wsp_1");
    const b = await ctx.service.confirm({ ...template({ every: "day", at: "10:00" }), id: "tsk_other" }, "wsp_1");
    expect(a.id).toMatch(/^rul_[0-9a-f]{16}$/u);
    expect(b.id).toMatch(/^rul_[0-9a-f]{16}$/u);
    expect(a.id).not.toBe(b.id);
  });

  it("keeps several rules apart: a command changes one, a lookup finds one, and a trigger of one leaves the other", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC" });
    await ctx.service.start();
    await ctx.service.confirm(template({ every: "interval", minutes: 5 }), "wsp_1");
    await ctx.service.confirm({ ...template({ every: "day", at: "23:00" }), id: "tsk_other", name: "Other" }, "wsp_1");
    expect(ctx.service.rule("rul_two")?.name).toBe("Other");
    expect(ctx.service.saved("tsk_other")).toBe(true);
    expect(ctx.service.saved("tsk_none")).toBe(false);

    await ctx.service.pause("rul_two");
    expect(ctx.service.list().map((rule) => [rule.id, rule.paused])).toStrictEqual([
      ["rul_one", false],
      ["rul_two", true],
    ]);
    await runTo(ctx, utc(2026, 11, 9, 9, 5));
    expect(ctx.service.list().map((rule) => [rule.id, rule.lastTaskId])).toStrictEqual([
      ["rul_one", "tsk_made1"],
      ["rul_two", null],
    ]);
    // Saving the second again changes only it.
    await ctx.service.confirm(
      { ...template({ every: "day", at: "22:00" }), id: "tsk_other", name: "Other 2" },
      "wsp_1",
    );
    expect(ctx.service.list().map((rule) => rule.name)).toStrictEqual(["Nightly check", "Other 2"]);
  });

  it("takes the graph in force, not the first one, and writes nothing but its rules", async () => {
    const ctx = await setUp({ clock: new TestClock(utc(2026, 11, 9, 9, 0)), timeZone: "UTC" });
    await ctx.service.start();
    const base = template({ every: "day", at: "10:00" });
    const second = { ...base.graphs[0]!, version: 2, nodes: [agent("N1"), agent("N2")] };
    const saved = await ctx.service.confirm({ ...base, graphs: [...base.graphs, second], activeGraph: 2 }, "wsp_1");
    expect(saved.graph.nodes.map((node) => node.id)).toStrictEqual(["N1", "N2"]);
    expect(JSON.parse(await readFile(ctx.file, "utf8"))).toStrictEqual({
      v: 1,
      rules: [JSON.parse(JSON.stringify(saved))],
    });
  });
});
