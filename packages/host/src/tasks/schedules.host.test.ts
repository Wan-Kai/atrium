import { CommandError } from "@atrium/protocol";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type TaskHost, startTaskHost } from "../../test/task-harness";
import { agent } from "./test-support";

vi.setConfig({ testTimeout: 120_000 });

/** A reply that calls a tool. */
const call = (name: string, id: string, args: Record<string, unknown>) => ({
  blocks: [{ type: "toolCall" as const, id, name, arguments: args as Record<string, never> }],
});

/** A reply that only talks. */
const say = (text: string) => ({ blocks: [{ type: "text" as const, text }] });

/** The beginning of the contract of any node of a task a rule made: its name starts with the rule's. */
const RULE_TASK = "<atrium-task-node>\n你在任务「Poll the logs · ";

/** The summary the task conversation writes. */
const SUMMARY = {
  goal: "look at the logs",
  decisions: [],
  constraints: [],
  nonGoals: [],
  openQuestions: [],
  acceptance: ["a short report"],
};

/** The task conversation's script: a summary, a name, a rule for every 5 minutes, one read-only node. */
const DESIGN = [
  call("task_set_summary", "t1", { summary: SUMMARY }),
  call("task_set_meta", "t2", { name: "Poll the logs" }),
  call("task_set_schedule", "t3", { when: { every: "interval", minutes: 5 }, place: "local_readonly" }),
  call("task_propose_graph", "t4", {
    nodes: [agent("N1", "explore")],
    edges: [],
    note: "one node",
    guide: "research",
  }),
  say("A rule for every 5 minutes, read-only."),
];

/**
 * Where the host keeps the rules.
 *
 * @sideEffects Reads the home's directory.
 * @param home - The host's home.
 * @returns The path of `schedules.json`.
 */
async function rulesFile(home: string): Promise<string> {
  const found = (await readdir(home, { recursive: true })).find((name) => name.endsWith("schedules.json"));
  return join(home, found ?? "schedules.json");
}

/**
 * The only item of a list that has one.
 *
 * @remarks
 * Tests read a row they have just made; a list of another length is the failure.
 *
 * @sideEffects none
 * @param items - The list.
 * @returns Its one item.
 * @throws {Error} When the list does not hold exactly one.
 */
function only<T>(items: readonly T[]): T {
  const [first, ...more] = items;
  if (first === undefined || more.length > 0) throw new Error(`expected one item, got ${String(items.length)}`);
  return first;
}

/**
 * The task a rule last made, or an empty string when it has made none.
 *
 * @sideEffects none
 * @param harness - The host.
 * @param ruleId - The rule.
 * @returns The task's id.
 */
function lastTaskOf(harness: TaskHost, ruleId: string): string {
  return harness.host.host.schedules?.rule(ruleId)?.lastTaskId ?? "";
}

/**
 * A host whose task conversation has made a rule's template, and the template's id.
 *
 * @sideEffects Starts a host.
 * @returns The harness and the template task.
 */
async function withTemplate() {
  const harness = await startTaskHost(
    { [RULE_TASK]: [call("node_done", "d1", { ok: true, summary: "Looked; nothing wrong." })] },
    { source: [say("Plan: poll the logs.")], design: DESIGN },
  );
  await harness.discuss();
  const { taskId } = await harness.host.host.tasks.createFromChat(harness.origin, undefined);
  await harness.until(
    taskId,
    (task) => task.scheduleDraft !== null && task.activeGraph === 1 && task.name === "Poll the logs",
  );
  return { harness, taskId };
}

/**
 * The rules the client sees once they arrive.
 *
 * @sideEffects Watches the rules.
 * @param harness - The host.
 * @param count - How many rules to wait for.
 * @returns The rows.
 */
async function rows(harness: TaskHost, count: number) {
  await harness.client.watchSchedules(true);
  await vi.waitFor(() => expect(harness.client.schedules.getState().schedules).toHaveLength(count));
  return harness.client.schedules.getState().schedules;
}

describe("a schedule rule from a conversation (SPEC-0006, 定时; T10)", () => {
  it("the conversation sets the schedule, saving the rule is the start button, and the template is in the task list until the rule is saved", async () => {
    const { harness, taskId } = await withTemplate();
    const { client } = harness;
    expect(harness.task(taskId).scheduleDraft).toStrictEqual({
      when: { every: "interval", minutes: 5 },
      place: "local_readonly",
    });
    await client.watchTasks(true);
    await vi.waitFor(() => expect(client.tasks.getState().status).toBe("ready"));
    // Until the rule is saved the template is a task being designed like any other, so that it cannot be lost.
    expect(client.tasks.getState().tasks.map((task) => task.id)).toContain(taskId);
    await client.openTask(taskId);
    await vi.waitFor(() => expect(client.task(taskId).getState().task?.scheduleDraft).toMatchObject({ saved: false }));

    // "确认并保存规则" is `start_task`: it saves the rule and starts nothing.
    await client.startTask(taskId);
    const row = only(await rows(harness, 1));
    expect(row).toMatchObject({
      name: "Poll the logs",
      place: "local_readonly",
      when: { every: "interval", minutes: 5 },
      paused: false,
      last: null,
      skipped: 0,
      templateTaskId: taskId,
    });
    expect(row.nextAt).toBeGreaterThan(Date.now());
    expect(harness.task(taskId).startedAt).toBeNull();
    // Once it is saved the template is out of the list (the rule's tab opens it).
    await vi.waitFor(() => expect(client.tasks.getState().tasks.map((task) => task.id)).not.toContain(taskId));
    await vi.waitFor(() => expect(client.task(taskId).getState().task?.scheduleDraft).toMatchObject({ saved: true }));
    expect(JSON.parse(await readFile(await rulesFile(harness.home), "utf8"))).toMatchObject({
      v: 1,
      rules: [{ name: "Poll the logs", templateTaskId: taskId, taskSessionId: harness.task(taskId).taskSessionId }],
    });
    // A saved template cannot be abandoned on its own; deleting the rule takes it.
    await expect(client.abandonTask(taskId)).rejects.toMatchObject({ code: "task_state_invalid" });
  });

  it("立即跑一次 makes an ordinary task: named after the rule, from a schedule, with its own conversation, and it runs to the end", async () => {
    const { harness, taskId } = await withTemplate();
    const { client } = harness;
    await client.startTask(taskId);
    const row = only(await rows(harness, 1));
    await client.watchTasks(true);

    const made = await client.runScheduleNow(row.id);
    const task = await harness.until(made.taskId, (now) => now.endedAt !== null);
    expect(task).toMatchObject({
      origin: { kind: "schedule", ruleId: row.id },
      projectId: harness.task(taskId).projectId,
      summary: SUMMARY,
    });
    expect(task.name).toMatch(/^Poll the logs · \d{1,2} 月 \d{1,2} 日 \d{2}:\d{2}$/u);
    expect(task.taskSessionId).not.toBe(harness.task(taskId).taskSessionId);
    // It is in the list like any task, marked as scheduled; the rule's row shows how it went.
    await vi.waitFor(() =>
      expect(client.tasks.getState().tasks.find((one) => one.id === made.taskId)).toMatchObject({
        scheduled: true,
        status: "done",
      }),
    );
    await vi.waitFor(() =>
      expect(client.schedules.getState().schedules[0]?.last).toStrictEqual({
        taskId: made.taskId,
        status: "done",
        failed: false,
      }),
    );
  });

  it("pauses, resumes and deletes: the template goes with the rule, the tasks it made stay; unknown rules are not found", async () => {
    const { harness, taskId } = await withTemplate();
    const { client } = harness;
    await client.startTask(taskId);
    const row = only(await rows(harness, 1));
    const id = row.id;
    const made = await client.runScheduleNow(id);
    await harness.until(made.taskId, (now) => now.endedAt !== null);

    await client.pauseSchedule(id);
    await vi.waitFor(() =>
      expect(client.schedules.getState().schedules[0]).toMatchObject({ paused: true, nextAt: null }),
    );
    await client.resumeSchedule(id);
    await vi.waitFor(() => expect(client.schedules.getState().schedules[0]?.paused).toBe(false));
    expect(await client.editSchedule(id)).toStrictEqual({ taskId });

    await client.deleteSchedule(id);
    await vi.waitFor(() => expect(client.schedules.getState().schedules).toHaveLength(0));
    expect(await harness.host.host.tasks.lookup(taskId)).toBeUndefined();
    expect(harness.host.host.tasks.task(made.taskId)).toMatchObject({ id: made.taskId });
    await expect(client.deleteSchedule(id)).rejects.toMatchObject({ code: "schedule_not_found" });
    await expect(client.editSchedule(id)).rejects.toBeInstanceOf(CommandError);
  });

  it("修改 of a rule whose template is gone says so", async () => {
    const { harness, taskId } = await withTemplate();
    await harness.client.startTask(taskId);
    const row = only(await rows(harness, 1));
    await harness.host.host.tasks.discardTemplate(taskId);
    await expect(harness.client.editSchedule(row.id)).rejects.toMatchObject({ code: "task_not_found" });
    // The rule keeps its own summary and graph: it still makes a task.
    const made = await harness.client.runScheduleNow(row.id);
    await harness.until(made.taskId, (now) => now.endedAt !== null);
  });

  it("after the host was off for 15 minutes, a restart makes exactly one task (the next time is the unit test's, on an injected clock)", async () => {
    const { harness, taskId } = await withTemplate();
    await harness.client.startTask(taskId);
    const row = only(await rows(harness, 1));
    const past = Date.now() - 15 * 60_000;
    await harness.restart(async () => {
      const file = await rulesFile(harness.home);
      const text = JSON.parse(await readFile(file, "utf8")) as { rules: Record<string, unknown>[] };
      // As if the rule had been made 15 minutes before and its last trigger was then.
      text.rules = text.rules.map((rule) => ({ ...rule, createdAt: past, lastFiredAt: past }));
      await writeFile(file, JSON.stringify(text));
    });
    await vi.waitFor(() => expect(lastTaskOf(harness, row.id)).not.toBe(""), { timeout: 60_000 });
    const first = lastTaskOf(harness, row.id);
    await harness.until(first, (now) => now.endedAt !== null);
    const tasks = (await harness.host.host.tasks.list()).filter((task) => task.origin.kind === "schedule");
    expect(tasks.map((task) => task.id)).toStrictEqual([first]);
    expect(tasks[0]?.origin).toMatchObject({ kind: "schedule", firedAt: expect.any(Number) as number });
  });

  it("makes no task, and leaves nothing half-made, from a rule whose graph breaks the rules of its place", async () => {
    const { harness, taskId } = await withTemplate();
    await harness.client.startTask(taskId);
    const row = only(await rows(harness, 1));
    await harness.restart(async () => {
      const file = await rulesFile(harness.home);
      const text = JSON.parse(await readFile(file, "utf8")) as { rules: { graph: { nodes: unknown[] } }[] };
      // A write node in a rule that runs read-only: edited by hand.
      text.rules[0]?.graph.nodes.push(agent("N2", "work"));
      await writeFile(file, JSON.stringify(text));
    });
    await harness.client.watchSchedules(true);
    await expect(harness.client.runScheduleNow(row.id)).rejects.toMatchObject({ code: "task_graph_invalid" });
    expect((await harness.host.host.tasks.list()).filter((task) => task.origin.kind === "schedule")).toStrictEqual([]);
  });
});
