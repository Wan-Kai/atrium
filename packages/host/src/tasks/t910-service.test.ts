import type { LogEntry } from "@atrium/pi";
import { createTempDir } from "@atrium/testkit";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import { ResourceTracker } from "../platform/resources";
import type { TaskSessions } from "../sessions/task-sessions";
import type { TaskWorkspaces } from "./node-ports";
import { newScheduledTask } from "./new-task";
import { createTaskRunner } from "./runner";
import type { ScheduleRule } from "./schedule-rules";
import { createScheduleService } from "./schedule-service";
import { createTaskCommands } from "./task-commands";
import { createTaskService } from "./task-service";
import { agent, need, newTask } from "./test-support";

/*
 * The fixes of the review of T9 and T10 that live in the task service (SPEC-0006, "T9 / T10 审查后用户定"): which tasks
 * a rule made, what a crash inside `createScheduled` leaves and what the next start does about it, and a host that
 * closes while a trigger waits for a pi that never answers.
 */

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

/** What the session layer is told to do differently. */
interface Behaviour {
  /** A prompt waits until this signal (the runner's) aborts, as a pi that never answers does. */
  readonly promptNeverAnswered?: boolean;
  /** `create` waits for `release` to be called. */
  readonly holdCreate?: boolean;
}

/**
 * A service over fake sessions and worktrees, with the real runner, store and scheduler, on a directory a second
 * host can be built on.
 *
 * @sideEffects Creates a temporary directory (unless one is given); the service is closed when the test finishes.
 * @param options - How the sessions behave, and the directory to use.
 * @returns The service, its tasks directory, the sessions' log, and ways to hold up `create`.
 */
async function built(options: { readonly behaviour?: Behaviour; readonly dir?: string } = {}) {
  const dir = options.dir === undefined ? await createTempDir("t910-service") : { path: options.dir };
  if ("cleanup" in dir) onTestFinished(dir.cleanup);
  const { logger, records } = recordingTracing();
  const asked = { created: [] as { sessionId: string; taskId: string }[], retired: [] as string[], prompts: 0 };
  let made = 0;
  const held = Promise.withResolvers<void>();
  const sessions: TaskSessions = {
    async create(session) {
      made += 1;
      const sessionId = `ses_${dir.path.slice(-4)}${String(made)}`;
      asked.created.push({ sessionId, taskId: session.task.taskId });
      if (options.behaviour?.holdCreate === true) await held.promise;
      return sessionId;
    },
    find: () => undefined,
    recordOf: () => undefined,
    open: () => Promise.resolve(),
    prompt(_sessionId, _text, signal) {
      asked.prompts += 1;
      if (options.behaviour?.promptNeverAnswered !== true) return Promise.resolve();
      return new Promise<void>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("closing")), { once: true });
      });
    },
    command: () => Promise.resolve(),
    source: () => undefined,
    transcript: () => Promise.resolve([] as LogEntry[]),
    deliver: () => Promise.resolve(),
    conversations: () => asked.created.filter((one) => !asked.retired.includes(one.sessionId)),
    retire(sessionId) {
      asked.retired.push(sessionId);
      return Promise.resolve();
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
        conversations: () => sessions.conversations(),
        retire: (sessionId) => sessions.retire(sessionId),
        recordOf: () => undefined,
      },
      placement: () => ({ projectId: null, borrowed: null }),
    },
  });
  onTestFinished(() => service.close());
  return { service, root, asked, records, dir: dir.path, release: held.resolve, sessions };
}

/** The options of a start that has pi. */
const WITH_PI = () => ({ signal: new AbortController().signal, staleLocks: false, ready: () => Promise.resolve(true) });

describe("TaskService.ofRule", () => {
  it("lists the tasks of one rule that are on disk, also those not held yet, and no other", async () => {
    const first = await built();
    const mine = await first.service.createScheduled(RULE, "n1", 10, new AbortController().signal);
    const other = await first.service.createScheduled({ ...RULE, id: "rul_b" }, "n2", 11, new AbortController().signal);
    await first.service.create({ ...newTask([agent("N1")], []), id: "tsk_chat" });
    await first.service.idle();
    await first.service.close();

    const second = await built({ dir: first.dir });
    expect((await second.service.ofRule("rul_a")).map((task) => task.id)).toStrictEqual([mine]);
    expect((await second.service.ofRule("rul_b")).map((task) => task.id)).toStrictEqual([other]);
    expect(await second.service.ofRule("rul_none")).toStrictEqual([]);
  });
});

describe("a host that closes while a trigger waits for a pi that never answers", () => {
  it("lets the schedules close without the tasks closing first, then the tasks close too", async () => {
    const ctx = await built({ behaviour: { promptNeverAnswered: true } });
    const dir = await createTempDir("t910-rules");
    onTestFinished(dir.cleanup);
    const resources = new ResourceTracker();
    const schedules = createScheduleService({
      file: join(dir.path, "schedules.json"),
      clock: systemClock,
      resources,
      logger: recordingTracing().logger,
      tasks: ctx.service,
      timeZone: "UTC",
    });
    await schedules.load();
    // A rule that was saved from a template and is run now: the first node's contract prompt is never answered.
    await ctx.service.create(TEMPLATE);
    const rule = await schedules.confirm(TEMPLATE, "wsp_7");
    const running = schedules.runNow(rule.id).catch((error: unknown) => error);
    await waitFor(() => ctx.asked.prompts > 0);

    // Before the fix this waited for `tasks.close()`, which the host only called after this returned.
    await schedules.close();
    expect(await running).toBeInstanceOf(Error);

    await ctx.service.close();
    expect(Math.max(0, ...Object.values(resources.snapshot()))).toBe(0);
  });

  it("leaves the half-made task on disk for the next start instead of tearing it down", async () => {
    const ctx = await built({ behaviour: { promptNeverAnswered: true } });
    const stop = new AbortController();
    const making = ctx.service.createScheduled(RULE, "n", 5, stop.signal).catch((error: unknown) => error);
    await waitFor(() => ctx.asked.prompts > 0);
    stop.abort();
    expect(await making).toBeInstanceOf(Error);

    expect(await readdir(ctx.root)).toHaveLength(1);
    expect(ctx.asked.retired).toStrictEqual([]);
    await ctx.service.close();
  });
});

describe("what a crash inside createScheduled leaves, and what the next start does (SPEC-0006, T9 / T10 审查后用户定)", () => {
  it("starts a task a schedule made that never started, once pi is ready, and leaves it alone while pi is not", async () => {
    const first = await built();
    await first.service.create({
      ...newScheduledTask({
        id: "tsk_halfmade",
        name: "Nightly · 11 月 9 日",
        projectId: RULE.projectId,
        sourceDir: RULE.sourceDir,
        ruleId: RULE.id,
        firedAt: 9,
        taskSessionId: "ses_half",
        model: RULE.model,
        summary: RULE.summary,
        nodes: RULE.graph.nodes,
        edges: RULE.graph.edges,
        now: 9,
      }),
    });
    await first.service.close();

    const waiting = await built({ dir: first.dir });
    await waiting.service.recoverAll({ ...WITH_PI(), ready: () => Promise.resolve(false) });
    expect(need(waiting.service.task("tsk_halfmade")).startedAt).toBeNull();
    expect(waiting.records.some((record) => record.msg === "tasks not recovered: pi is not ready")).toBe(true);
    await waiting.service.close();

    const second = await built({ dir: first.dir });
    await second.service.recoverAll(WITH_PI());
    await second.service.idle();
    expect(second.service.task("tsk_halfmade")?.startedAt).not.toBeNull();
    expect(second.asked.created).toHaveLength(1);
  });

  it("does not start a task a schedule made that is going already: recovering it is not starting it again", async () => {
    const first = await built();
    const taskId = await first.service.createScheduled(RULE, "n", 1, new AbortController().signal);
    await first.service.idle();
    await first.service.close();

    const second = await built({ dir: first.dir });
    await second.service.recoverAll(WITH_PI());
    await second.service.idle();

    const log = await readFile(join(second.root, taskId, "events.jsonl"), "utf8");
    expect(log.match(/"type":"started"/gu)).toHaveLength(1);
    expect(log.match(/"type":"host_restarted"/gu)).toHaveLength(1);
  });

  it("does not start a task that was given up", async () => {
    const first = await built();
    await first.service.create({
      ...newScheduledTask({
        id: "tsk_given_up",
        name: "n",
        projectId: RULE.projectId,
        sourceDir: RULE.sourceDir,
        ruleId: RULE.id,
        firedAt: 9,
        taskSessionId: "ses_up",
        model: RULE.model,
        summary: RULE.summary,
        nodes: RULE.graph.nodes,
        edges: RULE.graph.edges,
        now: 9,
      }),
    });
    await first.service.submit("tsk_given_up", { type: "abandoned" });
    await first.service.close();

    const second = await built({ dir: first.dir });
    await second.service.recoverAll(WITH_PI());
    expect(need(second.service.task("tsk_given_up")).startedAt).toBeNull();
  });

  it("lets go of a conversation whose task was never written, and of no other", async () => {
    const ctx = await built();
    const taskId = await ctx.service.createScheduled(RULE, "n", 1, new AbortController().signal);
    // A conversation the host made just before it died, and a task it never got to write.
    await ctx.sessions.create({
      containerId: "wsp_7",
      cwd: "/work",
      name: "tsk_never",
      task: { taskId: "tsk_never", role: "conversation", startOn: null },
    });
    await ctx.service.idle();

    await ctx.service.recoverAll(WITH_PI());

    const orphan = ctx.asked.created.find((one) => one.taskId === "tsk_never");
    expect(ctx.asked.retired).toStrictEqual([orphan?.sessionId]);
    expect(need(ctx.service.task(taskId)).id).toBe(taskId);
  });

  it("does not let go of the conversation of a task that is being made right now", async () => {
    const ctx = await built({ behaviour: { holdCreate: true } });
    const making = ctx.service.createScheduled(RULE, "n", 1, new AbortController().signal);
    await waitFor(() => ctx.asked.created.length > 0);

    await ctx.service.recoverAll(WITH_PI());
    expect(ctx.asked.retired).toStrictEqual([]);

    ctx.release();
    await making;
    await ctx.service.recoverAll(WITH_PI());
    expect(ctx.asked.retired).toStrictEqual([]);
  });

  it("keeps the conversation of a task being made out of the sweep whichever of the two comes first", async () => {
    const ctx = await built();
    const taskId = await ctx.service.createScheduled(RULE, "n", 1, new AbortController().signal);
    await ctx.service.idle();
    await ctx.service.recoverAll(WITH_PI());
    expect(ctx.asked.retired).toStrictEqual([]);
    expect(need(ctx.service.task(taskId)).id).toBe(taskId);
  });
});

/** A rule's template: designing, with a cadence and a graph. */
const TEMPLATE = {
  ...newTask([agent("N1", "explore")], []),
  id: "tsk_tpl",
  taskSessionId: "ses_tpl",
  projectId: RULE.projectId,
  sourceDir: RULE.sourceDir,
  scheduleDraft: { when: RULE.when, place: "new_worktree" as const },
};

/**
 * Whether a rule is saved from a task: from the template, once it is.
 *
 * @sideEffects none
 * @param yet - Whether the rule is saved.
 * @param taskId - The task asked about.
 * @returns Whether it is saved from that task.
 */
function savedAs(yet: boolean, taskId: string): boolean {
  return yet && taskId === "tsk_tpl";
}

/**
 * The ids of the tasks a push lists; none for a push of one task.
 *
 * @sideEffects none
 * @param event - The push.
 * @returns The ids.
 */
function listedIds(event: { readonly type: string; readonly tasks?: readonly { readonly id: string }[] }): string[] {
  return event.type === "tasks_updated" ? (event.tasks ?? []).map((task) => task.id) : [];
}

/**
 * Waits until a condition holds, by looking again every few milliseconds.
 *
 * @sideEffects Sets short timers while it waits.
 * @param condition - What to wait for.
 */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !condition(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
}

describe("the task list and a template task (SPEC-0006, T9 / T10 审查后用户定 5)", () => {
  it("lists a template until its rule is saved, then hides it; the push after the save drops it from the list too", async () => {
    const ctx = await built();
    await ctx.service.create(TEMPLATE);
    await ctx.service.create({ ...newTask([agent("N1")], []), id: "tsk_plain" });
    const saved = { yet: false };
    const sent: { type: string; ids: string[] }[] = [];
    const commands = createTaskCommands({
      service: ctx.service,
      saved: (taskId) => savedAs(saved.yet, taskId),
      send: (_to, event) => void sent.push({ type: event.type, ids: listedIds(event) }),
      logger: recordingTracing().logger,
    });
    onTestFinished(() => commands.close());

    expect((await commands.list("c1", true)).tasks.map((task) => task.id).toSorted()).toStrictEqual([
      "tsk_plain",
      "tsk_tpl",
    ]);
    saved.yet = true;
    commands.refresh("tsk_tpl");
    await commands.close();
    expect(sent.at(-1)).toStrictEqual({ type: "tasks_updated", ids: ["tsk_plain"] });
    expect((await commands.list("c2", undefined)).tasks.map((task) => task.id)).toStrictEqual(["tsk_plain"]);
  });
});
