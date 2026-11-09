import type { LogEntry } from "@atrium/pi";
import { createTempDir } from "@atrium/testkit";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import type { TaskSessions } from "../sessions/task-sessions";
import type { TaskWorkspaces } from "./node-ports";
import { createTaskRunner } from "./runner";
import type { ScheduleRule } from "./schedule-rules";
import { createTaskService } from "./task-service";
import { agent, newTask } from "./test-support";
import type { Task } from "./types";

/** A rule, made of what `createScheduled` reads. */
const RULE: ScheduleRule = {
  id: "rul_a",
  name: "Nightly",
  projectId: "prj_0123456789abcdef",
  containerId: "wsp_7",
  sourceDir: "/work/atrium",
  when: { every: "day", at: "2:00" },
  place: "new_worktree",
  summary: { goal: "check", decisions: [], constraints: [], nonGoals: [], openQuestions: [], acceptance: [] },
  graph: { nodes: [agent("N1", "explore")], edges: [] },
  model: { providerId: "p", modelId: "m", thinking: "high" },
  templateTaskId: "tsk_tpl",
  taskSessionId: "ses_tpl",
  paused: false,
  createdAt: 1,
  lastFiredAt: null,
  lastTaskId: null,
  skipped: 0,
};

/** What the fake session layer was asked. */
interface Asked {
  readonly created: { containerId: string; cwd: string; name: string; task: unknown }[];
  readonly retired: string[];
}

/**
 * A service over fake sessions and worktrees, with the real runner, store and scheduler.
 *
 * @remarks
 * The session layer starts no pi; it answers the ids it is asked for, and records what it was asked.
 *
 * @sideEffects Creates a temporary directory; the service is closed when the test finishes.
 * @param options - `retire` to replace how a conversation is let go of.
 * @returns The service, the directory of the tasks, what was asked, and the log.
 */
async function built(
  options: {
    retire?: (sessionId: string) => Promise<void>;
    dir?: string;
    schedules?: Parameters<typeof createTaskService>[0]["schedules"];
  } = {},
) {
  const dir = options.dir === undefined ? await createTempDir("t10-service") : { path: options.dir };
  if ("cleanup" in dir) onTestFinished(dir.cleanup);
  const { logger, records } = recordingTracing();
  const asked: Asked = { created: [], retired: [] };
  let made = 0;
  const sessions: TaskSessions = {
    create(session) {
      asked.created.push(session);
      made += 1;
      return Promise.resolve(`ses_made${String(made)}`);
    },
    find: () => undefined,
    recordOf: () => undefined,
    open: () => Promise.resolve(),
    prompt: () => Promise.resolve(),
    command: () => Promise.resolve(),
    source: () => undefined,
    transcript: () => Promise.resolve([] as LogEntry[]),
    deliver: () => Promise.resolve(),
    retire(sessionId) {
      asked.retired.push(sessionId);
      return options.retire?.(sessionId) ?? Promise.resolve();
    },
    alive: () => false,
    stop: () => Promise.resolve(),
    subscribe: () => () => undefined,
  };
  const workspaces: TaskWorkspaces = {
    ensure: () => Promise.resolve({ workspaceId: "w", baseCommit: "c" }),
    dirOf: () => "/tmp",
    containerOf: () => "c1",
    lock: () => Promise.resolve(),
    unlock: () => Promise.resolve(),
    merge: () => Promise.resolve({ kind: "merged" }),
    clearStaleLocks: () => Promise.resolve(0),
  };
  const runner = createTaskRunner({
    sessions,
    workspaces,
    git: Promise.resolve(null),
    clock: systemClock,
    logger,
    resources: recordingTracing().resources,
  });
  const root = join(dir.path, "tasks");
  const service = createTaskService({
    runner,
    root,
    clock: systemClock,
    logger,
    ...(options.schedules === undefined ? {} : { schedules: options.schedules }),
    archiving: {
      facts: () => Promise.resolve(null),
      changes: () => Promise.resolve(null),
      archive: () => Promise.resolve(),
    },
    design: {
      sessions: {
        source: () => undefined,
        create: (session) => sessions.create(session),
        open: () => Promise.resolve(),
        prompt: () => Promise.resolve(),
        command: () => Promise.resolve(),
        retire: (sessionId) => sessions.retire(sessionId),
        recordOf: () => undefined,
      },
      placement: () => ({ projectId: null, borrowed: null }),
    },
  });
  onTestFinished(() => service.close());
  return { service, root, asked, records, dir: dir.path };
}

/** A template task: designing, with a cadence. */
const TEMPLATE: Task = {
  ...newTask([agent("N1", "explore")], []),
  id: "tsk_tpl",
  taskSessionId: "ses_tpl",
  scheduleDraft: { when: RULE.when, place: "new_worktree" },
};

describe("TaskService.lookup", () => {
  it("finds a held task, and one only on disk, which it then holds", async () => {
    const first = await built();
    await first.service.create(TEMPLATE);
    expect((await first.service.lookup("tsk_tpl"))?.id).toBe("tsk_tpl");
    await first.service.close();

    // A service over the same files, as after a restart: the task is on disk and not held.
    const second = await built({ dir: first.dir });
    expect(second.service.task("tsk_tpl")).toBeUndefined();
    expect((await second.service.lookup("tsk_tpl"))?.id).toBe("tsk_tpl");
    expect(second.service.task("tsk_tpl")?.id).toBe("tsk_tpl");
  });

  it("says undefined for a task that is not there, has a bad id or cannot be read, and leaves nothing behind", async () => {
    const ctx = await built();
    expect(await ctx.service.lookup("tsk_nope")).toBeUndefined();
    expect(await ctx.service.lookup("../etc")).toBeUndefined();
    expect(await ctx.service.lookup("tsk_a/../b")).toBeUndefined();
    await expect(readdir(ctx.root)).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(join(ctx.root, "tsk_bad"), { recursive: true });
    await writeFile(join(ctx.root, "tsk_bad", "events.jsonl"), "");
    expect(await ctx.service.lookup("tsk_bad")).toBeUndefined();
  });
});

describe("TaskService.createScheduled (SPEC-0006, 定时 · 到点)", () => {
  it("makes a started task of the rule with a conversation of its own, in the rule's container and directory, on its model", async () => {
    const { service, asked } = await built();

    const taskId = await service.createScheduled(RULE, "Nightly · 11 月 9 日", 777, new AbortController().signal);

    expect(taskId).toMatch(/^tsk_[0-9a-f]{16}$/u);
    expect(asked.created[0]).toMatchObject({
      containerId: "wsp_7",
      cwd: "/work/atrium",
      name: taskId,
      task: {
        taskId,
        role: "conversation",
        startOn: { providerId: "p", modelId: "m", thinkingLevel: "high" },
      },
    });
    const task = service.task(taskId);
    expect(task).toMatchObject({
      name: "Nightly · 11 月 9 日",
      origin: { kind: "schedule", ruleId: "rul_a", firedAt: 777 },
      projectId: RULE.projectId,
      sourceDir: "/work/atrium",
      taskSessionId: "ses_made1",
      scheduleDraft: null,
      model: RULE.model,
    });
    expect(task?.startedAt).not.toBeNull();
    expect(task?.summary.goal).toBe("check");
  });

  it("checks the graph against the rule's place: read-only refuses a work node, a worktree rule takes it", async () => {
    const withWork = { ...RULE.graph, nodes: [agent("N1", "work")] };
    const ctx = await built();

    await expect(
      ctx.service.createScheduled(
        { ...RULE, place: "local_readonly", graph: withWork },
        "n",
        1,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "task_graph_invalid", params: { code: "readonly_rule_has_work", node: "N1" } });
    expect(ctx.asked.created).toStrictEqual([]);

    const taskId = await ctx.service.createScheduled(
      { ...RULE, place: "new_worktree", graph: withWork },
      "n",
      1,
      new AbortController().signal,
    );
    expect(ctx.service.task(taskId)?.id).toBe(taskId);
  });

  it("does nothing once the signal is aborted", async () => {
    const ctx = await built();
    const stop = new AbortController();
    stop.abort();
    await expect(ctx.service.createScheduled(RULE, "n", 1, stop.signal)).rejects.toThrow(/./u);
    expect(ctx.asked.created).toStrictEqual([]);
  });

  it("takes everything back when the task cannot be recorded: no directory, the conversation let go of", async () => {
    const ctx = await built();
    await mkdir(ctx.root, { recursive: true });
    await chmod(ctx.root, 0o500);
    onTestFinished(() => chmod(ctx.root, 0o700));

    await expect(ctx.service.createScheduled(RULE, "n", 1, new AbortController().signal)).rejects.toThrow(/./u);

    expect(ctx.asked.retired).toStrictEqual(["ses_made1"]);
    expect(await readdir(ctx.root)).toStrictEqual([]);
  });
});

describe("TaskService.discardTemplate", () => {
  it("removes the template's files and lets go of its conversation; a second time, and an unknown task, are no error", async () => {
    const ctx = await built();
    await ctx.service.create(TEMPLATE);
    expect(await readdir(ctx.root)).toStrictEqual(["tsk_tpl"]);

    await ctx.service.discardTemplate("tsk_tpl");

    expect(await readdir(ctx.root)).toStrictEqual([]);
    expect(ctx.asked.retired).toStrictEqual(["ses_tpl"]);
    expect(ctx.service.task("tsk_tpl")).toBeUndefined();
    await ctx.service.discardTemplate("tsk_tpl");
    await ctx.service.discardTemplate("tsk_unknown");
    expect(ctx.asked.retired).toStrictEqual(["ses_tpl"]);
  });

  it("logs a conversation that could not be let go of, by the kind of error, and still removes the files", async () => {
    const ctx = await built({ retire: () => Promise.reject(new RangeError("busy")) });
    await ctx.service.create(TEMPLATE);

    await ctx.service.discardTemplate("tsk_tpl");

    expect(await readdir(ctx.root)).toStrictEqual([]);
    expect(
      ctx.records.filter((record) => record.level === "warn").map((record) => [record.msg, record["err"]]),
    ).toStrictEqual([["task conversation not archived", "RangeError"]]);
  });
});

/**
 * A saver of rules that remembers what it was asked.
 *
 * @remarks
 * The task service's view of the schedule service: it saves a template's rule and says whether one was saved.
 *
 * @sideEffects none
 * @param saved - The ids of the templates saved so far.
 * @returns The ids and the port.
 */
function saver(saved: string[] = []) {
  return {
    saved,
    schedules: {
      confirm: async (task: Task) => void saved.push(task.id),
      saved: (id: string) => saved.includes(id),
    },
  };
}

describe("a template task and the start button (SPEC-0006, T10)", () => {
  it("saves the rule instead of starting the task, and leaves it designing", async () => {
    const rules = saver();
    const ctx = await built({ schedules: rules.schedules });
    await ctx.service.create(TEMPLATE);

    await ctx.service.start("tsk_tpl");

    expect(rules.saved).toStrictEqual(["tsk_tpl"]);
    expect(ctx.service.task("tsk_tpl")?.startedAt).toBeNull();
    expect(ctx.asked.created).toStrictEqual([]);
    // Again after a change: it saves again.
    await ctx.service.start("tsk_tpl");
    expect(rules.saved).toStrictEqual(["tsk_tpl", "tsk_tpl"]);
  });

  it("checks the graph by the template's place before saving", async () => {
    const rules = saver();
    const ctx = await built({ schedules: rules.schedules });
    await ctx.service.create({
      ...newTask([agent("N1", "work")], []),
      id: "tsk_tpl",
      scheduleDraft: { when: RULE.when, place: "local_readonly" },
    });

    await expect(ctx.service.start("tsk_tpl")).rejects.toMatchObject({ code: "task_graph_invalid" });
    expect(rules.saved).toStrictEqual([]);
  });

  it("refuses a template that has no project, and one when rules cannot be saved here", async () => {
    const rules = saver();
    const noProject = await built({ schedules: rules.schedules });
    await noProject.service.create({ ...TEMPLATE, projectId: null });
    await expect(noProject.service.start("tsk_tpl")).rejects.toMatchObject({ code: "task_state_invalid" });
    expect(rules.saved).toStrictEqual([]);

    const none = await built();
    await none.service.create(TEMPLATE);
    await none.service.start("tsk_tpl").then(
      () => undefined,
      (error: unknown) => expect(error).toMatchObject({ code: "task_state_invalid" }),
    );
    expect(none.service.task("tsk_tpl")?.startedAt).toBeNull();
  });

  it("cannot be given up once a rule was saved from it, but can before", async () => {
    const rules = saver();
    const ctx = await built({ schedules: rules.schedules });
    await ctx.service.create(TEMPLATE);
    await ctx.service.create({ ...TEMPLATE, id: "tsk_tpl2", taskSessionId: "ses_tpl2" });
    await ctx.service.start("tsk_tpl");

    await expect(ctx.service.abandon("tsk_tpl")).rejects.toMatchObject({ code: "task_state_invalid" });
    expect(ctx.service.task("tsk_tpl")?.id).toBe("tsk_tpl");
    await ctx.service.abandon("tsk_tpl2");
    expect(ctx.service.task("tsk_tpl2")).toBeUndefined();
  });

  it("shows whether a rule was saved from the template, on the view", async () => {
    const rules = saver();
    const ctx = await built({ schedules: rules.schedules });
    await ctx.service.create(TEMPLATE);
    const stop = new AbortController().signal;
    expect((await ctx.service.view("tsk_tpl", stop)).scheduleDraft).toStrictEqual({
      when: RULE.when,
      place: "new_worktree",
      saved: false,
    });
    await ctx.service.start("tsk_tpl");
    expect((await ctx.service.view("tsk_tpl", stop)).scheduleDraft?.saved).toBe(true);
  });

  it.each([
    { name: "rules can be saved", options: (rules: ReturnType<typeof saver>) => ({ schedules: rules.schedules }) },
    { name: "rules cannot be saved", options: () => ({}) },
  ])("starts a task that is no template as before ($name)", async ({ options }) => {
    const rules = saver();
    const ctx = await built(options(rules));
    await ctx.service.create({ ...TEMPLATE, scheduleDraft: null, id: "tsk_plain" });
    await ctx.service.start("tsk_plain");
    expect(ctx.service.task("tsk_plain")?.startedAt).not.toBeNull();
    expect(rules.saved).toStrictEqual([]);
  });

  it("lets a worktree rule keep a work node, and a template outside any project say why it cannot be saved", async () => {
    const rules = saver();
    const ctx = await built({ schedules: rules.schedules });
    await ctx.service.create({
      ...newTask([agent("N1", "work")], []),
      id: "tsk_w",
      scheduleDraft: TEMPLATE.scheduleDraft,
    });
    await ctx.service.start("tsk_w");
    expect(rules.saved).toStrictEqual(["tsk_w"]);

    await ctx.service.create({
      ...newTask([agent("N1", "work")], [], { projectId: null }),
      id: "tsk_nowhere",
      scheduleDraft: TEMPLATE.scheduleDraft,
    });
    await expect(ctx.service.start("tsk_nowhere")).rejects.toMatchObject({ code: "task_no_project_for_work" });
  });

  it("gives up a template that was never saved, also where rules cannot be saved", async () => {
    const ctx = await built();
    await ctx.service.create(TEMPLATE);
    await ctx.service.abandon("tsk_tpl");
    expect(ctx.service.task("tsk_tpl")).toBeUndefined();
  });
});
