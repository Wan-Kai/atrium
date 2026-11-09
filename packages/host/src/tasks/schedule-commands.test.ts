import { CommandError, type SchedulesUpdatedEvent } from "@atrium/protocol";
import { createTempDir } from "@atrium/testkit";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { newScheduledTask } from "./new-task";
import { createScheduleCommands } from "./schedule-commands";
import { type ScheduleRule, readRules, writeRules } from "./schedule-rules";
import type { ScheduleService } from "./schedule-service";
import { Sim, agent, newTask } from "./test-support";
import { viewOf } from "./task-view";
import type { Action, Task, TaskEvent } from "./types";

const RULE: ScheduleRule = {
  id: "rul_a",
  name: "Nightly",
  projectId: "prj_0123456789abcdef",
  containerId: "wsp_1",
  sourceDir: "/work/atrium",
  when: { every: "day", at: "2:00" },
  place: "new_worktree",
  summary: { goal: "g", decisions: [], constraints: [], nonGoals: [], openQuestions: [], acceptance: [] },
  graph: { nodes: [agent("N1")], edges: [] },
  model: { providerId: "p", modelId: "m", thinking: "off" },
  templateTaskId: "tsk_t",
  taskSessionId: "ses_t",
  paused: false,
  createdAt: 1000,
  lastFiredAt: null,
  lastTaskId: null,
  skipped: 0,
};

/**
 * A schedule service that holds the rules it is given and lets a test fire its change.
 *
 * @sideEffects none
 * @param rules - The rules.
 * @returns The service, with `change` to call the listeners.
 */
function fakeService(rules: ScheduleRule[]) {
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const service = {
    list: () => rules,
    rule: (id: string) => rules.find((one) => one.id === id),
    nextAt: (rule: ScheduleRule) => (rule.paused ? null : 5000),
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pause: async (id: string) => void calls.push(`pause ${id}`),
    resume: async (id: string) => void calls.push(`resume ${id}`),
    runNow: async (id: string) => {
      calls.push(`runNow ${id}`);
      return "tsk_made";
    },
    remove: async (id: string) => void calls.push(`remove ${id}`),
  } as unknown as ScheduleService;
  return { service, calls, change: () => listeners.forEach((listener) => listener()), listeners };
}

/**
 * The tasks the commands read: a map of tasks, and the events they can fire.
 *
 * @sideEffects none
 * @param tasks - The tasks by id.
 * @returns The port, the sessions opened, and a way to fire an event.
 */
function fakeTasks(tasks: Record<string, Task>) {
  const opened: string[] = [];
  const listeners = new Set<(task: Task, event: TaskEvent, actions: readonly Action[]) => void>();
  const event = { seq: 1, at: 1, type: "resumed" } as const;
  return {
    opened,
    fire: (task: Task) => listeners.forEach((listener) => listener(task, event, [])),
    port: {
      lookup: async (id: string) => tasks[id],
      openSession: async (taskId: string, sessionId: string) => void opened.push(`${taskId} ${sessionId}`),
      onEvent: (listener: (task: Task, event: TaskEvent, actions: readonly Action[]) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

/** A task a rule made, in a state. */
function made(id: string, state: "running" | "failed"): Task {
  const sim = new Sim({ ...newTask([agent("N1")], []), id });
  sim.send({ type: "started" });
  sim.send({ type: "node_started", node: "N1", attempt: 1, sessionId: "s", startCommit: null });
  if (state === "failed") sim.send({ type: "node_failed", node: "N1", attempt: 1, reason: "crashed" });
  return sim.task;
}

describe("the schedule commands", () => {
  it("lists the rules as rows: the cadence, the next time, and how the last task went", async () => {
    const { service } = fakeService([
      { ...RULE, lastTaskId: "tsk_1", skipped: 2 },
      { ...RULE, id: "rul_b", paused: true, lastTaskId: "tsk_gone" },
    ]);
    const tasks = fakeTasks({ tsk_1: made("tsk_1", "failed") });
    const { logger } = recordingTracing();
    const commands = createScheduleCommands({ schedules: service, tasks: tasks.port, send: () => undefined, logger });

    expect(await commands.list("c1", undefined)).toStrictEqual({
      schedules: [
        {
          id: "rul_a",
          name: "Nightly",
          projectId: RULE.projectId,
          place: "new_worktree",
          when: { every: "day", at: "2:00" },
          paused: false,
          nextAt: 5000,
          last: { taskId: "tsk_1", status: "stopped", failed: true },
          skipped: 2,
          templateTaskId: "tsk_t",
          createdAt: 1000,
        },
        expect.objectContaining({ id: "rul_b", paused: true, nextAt: null, last: null }),
      ],
    });
    await commands.close();
  });

  it("pushes the rows whole, in order, to the connections that watch, after a change or an event of a last task", async () => {
    const fake = fakeService([{ ...RULE, lastTaskId: "tsk_1" }]);
    const tasks = fakeTasks({ tsk_1: made("tsk_1", "running") });
    const sent: { to: string; event: SchedulesUpdatedEvent }[] = [];
    const { logger } = recordingTracing();
    const commands = createScheduleCommands({
      schedules: fake.service,
      tasks: tasks.port,
      send: (to, event) => void sent.push({ to, event }),
      logger,
    });
    await commands.list("c1", true);
    await commands.list("c2", true);
    await commands.list("c2", false);

    fake.change();
    tasks.fire(made("tsk_1", "failed"));
    tasks.fire(made("tsk_other", "running"));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    await commands.close();

    expect(sent.map((one) => [one.to, one.event.seq, one.event.schedules[0]?.last?.status])).toStrictEqual([
      ["c1", 1, "running"],
      ["c1", 2, "running"],
    ]);
    expect(fake.listeners.size).toBe(0);
    // Closed: nothing more.
    fake.change();
    expect(sent).toHaveLength(2);
  });

  it("stops pushing to a connection that went away", async () => {
    const fake = fakeService([RULE]);
    const sent: string[] = [];
    const commands = createScheduleCommands({
      schedules: fake.service,
      tasks: fakeTasks({}).port,
      send: (to) => void sent.push(to),
      logger: recordingTracing().logger,
    });
    await commands.list("c1", true);
    commands.disconnect("c1");
    fake.change();
    await commands.close();
    expect(sent).toStrictEqual([]);
  });

  it("passes the commands on, and 修改 starts the template's conversation and answers the template", async () => {
    const fake = fakeService([RULE]);
    const tasks = fakeTasks({ tsk_t: { ...newTask([agent("N1")], []), id: "tsk_t", taskSessionId: "ses_t" } });
    const commands = createScheduleCommands({
      schedules: fake.service,
      tasks: tasks.port,
      send: () => undefined,
      logger: recordingTracing().logger,
    });

    await commands.pause("rul_a");
    await commands.resume("rul_a");
    expect(await commands.runNow("rul_a")).toStrictEqual({ taskId: "tsk_made" });
    await commands.remove("rul_a");
    expect(fake.calls).toStrictEqual(["pause rul_a", "resume rul_a", "runNow rul_a", "remove rul_a"]);

    expect(await commands.edit("rul_a")).toStrictEqual({ taskId: "tsk_t" });
    expect(tasks.opened).toStrictEqual(["tsk_t ses_t"]);
    await expect(commands.edit("rul_nope")).rejects.toStrictEqual(
      new CommandError("schedule_not_found", { scheduleId: "rul_nope" }),
    );
    await commands.close();
  });

  it("says the template is gone when it is", async () => {
    const commands = createScheduleCommands({
      schedules: fakeService([RULE]).service,
      tasks: fakeTasks({}).port,
      send: () => undefined,
      logger: recordingTracing().logger,
    });
    await expect(commands.edit("rul_a")).rejects.toStrictEqual(new CommandError("task_not_found"));
    await commands.close();
  });

  it("is read-only while another process's tasks are followed: an empty list, and every command refused", async () => {
    const commands = createScheduleCommands({
      schedules: undefined,
      tasks: fakeTasks({}).port,
      send: () => undefined,
      logger: recordingTracing().logger,
    });
    expect(await commands.list("c1", true)).toStrictEqual({ schedules: [] });
    for (const run of [
      (id: string) => commands.pause(id),
      (id: string) => commands.resume(id),
      (id: string) => commands.runNow(id),
      (id: string) => commands.remove(id),
      (id: string) => commands.edit(id),
    ]) {
      await expect(run("rul_a")).rejects.toStrictEqual(new CommandError("task_read_only"));
    }
    await commands.close();
  });
});

describe("a task a rule makes", () => {
  it("is an ordinary started task: the rule's summary and graph, a schedule origin, no source conversation", () => {
    const task = newScheduledTask({
      id: "tsk_s",
      name: "Nightly · 11 月 9 日",
      projectId: RULE.projectId,
      sourceDir: RULE.sourceDir,
      ruleId: RULE.id,
      firedAt: 77,
      taskSessionId: "ses_s",
      model: RULE.model,
      summary: { ...RULE.summary, goal: "check" },
      nodes: RULE.graph.nodes,
      edges: RULE.graph.edges,
      now: 99,
    });
    expect(task).toMatchObject({
      name: "Nightly · 11 月 9 日",
      origin: { kind: "schedule", ruleId: "rul_a", firedAt: 77 },
      summary: { goal: "check" },
      taskSessionId: "ses_s",
      scheduleDraft: null,
      startedAt: null,
      workspaceState: "none",
      ownsWorkspace: true,
      activeGraph: 1,
    });
    const view = viewOf(task, null);
    expect(view).toMatchObject({ scheduled: true, sourceSessionId: null, scheduleDraft: null });
  });

  it("shows a template's cadence, place and whether a rule was saved from it", () => {
    const template = { ...newTask([agent("N1")], []), scheduleDraft: { when: RULE.when, place: RULE.place } };
    expect(viewOf(template, null).scheduleDraft).toStrictEqual({
      when: RULE.when,
      place: "new_worktree",
      saved: false,
    });
    expect(viewOf(template, null, false, [], { saved: true }).scheduleDraft?.saved).toBe(true);
  });
});

describe("the rules file", () => {
  it("round-trips the rules, and keeps an entry it cannot read", async () => {
    const dir = await createTempDir("rules-");
    onTestFinished(dir.cleanup);
    const file = join(dir.path, "schedules.json");
    expect(await readRules(file)).toStrictEqual({ rules: [], rest: [] });

    await writeRules(file, [RULE], [{ id: "rul_future", extra: true }]);
    const back = await readRules(file);
    expect(back.rules).toStrictEqual([RULE]);
    expect(back.rest).toStrictEqual([{ id: "rul_future", extra: true }]);
    expect(await readFile(file, "utf8")).toMatch(/\n$/u);
  });

  it("refuses a file that is not a rules file, so nothing writes over it", async () => {
    const dir = await createTempDir("rules-");
    onTestFinished(dir.cleanup);
    const file = join(dir.path, "schedules.json");
    for (const text of ["", "[]", '{"v":2,"rules":[]}', '{"v":1}']) {
      await writeFile(file, text);
      await expect(readRules(file)).rejects.toThrow(/./u);
    }
  });

  it("leaves out a rule whose id or count is not valid, and keeps it for writing back", async () => {
    const dir = await createTempDir("rules-");
    onTestFinished(dir.cleanup);
    const file = join(dir.path, "schedules.json");
    const bad = [
      { ...RULE, id: "xrul_a" },
      { ...RULE, id: "rul_a!" },
      { ...RULE, id: "rul_b", skipped: -1 },
    ];
    await writeFile(file, JSON.stringify({ v: 1, rules: [...bad, { ...RULE, id: "rul_ok", skipped: 3 }] }));

    const back = await readRules(file);

    expect(back.rules.map((rule) => [rule.id, rule.skipped])).toStrictEqual([["rul_ok", 3]]);
    expect(back.rest).toStrictEqual(bad);
  });

  it("does not take any other failure to read it for a missing file", async () => {
    const dir = await createTempDir("rules-");
    onTestFinished(dir.cleanup);
    // A directory where the file should be: reading it fails, and is not "no rules".
    await expect(readRules(dir.path)).rejects.toMatchObject({ code: "EISDIR" });
  });
});
