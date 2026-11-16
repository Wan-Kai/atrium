import type { LogEntry } from "@atrium/pi";
import { createTempDir } from "@atrium/testkit";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import type { TaskSessions } from "../sessions/task-sessions";
import type { TaskWorkspaces } from "./node-ports";
import { createTaskRunner } from "./runner";
import { createTaskService } from "./task-service";
import { openTaskStore } from "./task-store";
import { agent, newTask } from "./test-support";
import type { Task, TaskEventInput } from "./types";

/**
 * What the fakes were asked, in order.
 *
 * @remarks
 * The session layer and the worktree port are the boundary; the service, the runner, the stores and the scheduler
 * are the real ones.
 */
interface Seen {
  /** `lock:<task>`, `unlock:<task>` and `stale` in the order they happened. */
  readonly worktree: string[];
  /** The sessions pi was started for. */
  readonly opened: string[];
  /** The tasks `recover` reached, as the contract prompts show. */
  readonly prompts: string[];
}

/**
 * A service over tasks on disk, as a host that just started finds them.
 *
 * @remarks
 * Each task is a record of `newTask` with its own id and name, written to `<root>/<id>` through the real store
 * with the events given; no action is carried out when they are written.
 *
 * @sideEffects Creates a temporary directory; the service is closed when the test finishes.
 * @param tasks - The tasks: id, creation time, and the events after `created`.
 * @returns The service, what the fakes saw, and a way to count the stale-lock sweeps.
 */
async function startedHost(
  tasks: readonly { readonly id: string; readonly createdAt: number; readonly events: readonly TaskEventInput[] }[],
  stale: number | "fails" = 3,
) {
  const dir = await createTempDir("t9-service");
  onTestFinished(dir.cleanup);
  const { logger, records } = recordingTracing();
  const seen: Seen = { worktree: [], opened: [], prompts: [] };
  let sweeps = 0;
  const sessions: TaskSessions = {
    create: () => Promise.resolve("ses_made"),
    find: () => undefined,
    recordOf: () => undefined,
    open(sessionId) {
      seen.opened.push(sessionId);
      return Promise.resolve();
    },
    prompt(sessionId, text) {
      seen.prompts.push(`${sessionId}:${text.slice(0, 30)}`);
      return Promise.resolve();
    },
    command: () => Promise.resolve(),
    source: () => undefined,
    transcript: () => Promise.resolve([] as LogEntry[]),
    deliver: () => Promise.resolve(),
    retire: () => Promise.resolve(),
    conversations: () => [],
    alive: () => false,
    stop: () => Promise.resolve(),
    subscribe: () => () => undefined,
  };
  const workspaces: TaskWorkspaces = {
    ensure: () => Promise.resolve({ workspaceId: "w", baseCommit: "c" }),
    dirOf: () => "/tmp",
    containerOf: () => "c1",
    lock(task) {
      seen.worktree.push(`lock:${task.id}`);
      return Promise.resolve();
    },
    unlock(task) {
      seen.worktree.push(`unlock:${task.id}`);
      return Promise.resolve();
    },
    merge: () => Promise.resolve({ kind: "merged" }),
    clearStaleLocks(isOver) {
      sweeps += 1;
      seen.worktree.push(
        `stale:${["tsk_a", "tsk_b", "tsk_broken", "tsk_done", "tsk_finished", "tsk_ghost"].map((id) => `${id}=${String(isOver(id))}`).join(",")}`,
      );
      return stale === "fails" ? Promise.reject(new RangeError("git is gone")) : Promise.resolve(stale);
    },
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
  for (const spec of tasks) {
    const store = await openTaskStore(join(root, spec.id), systemClock);
    const base: Task = newTask([agent("N1", "explore")], [], { workspaceState: "ready" });
    await store.record({ type: "created", task: { ...base, id: spec.id, createdAt: spec.createdAt } });
    for (const event of spec.events) await store.record(event);
  }
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
        create: () => Promise.resolve("ses_made"),
        open: () => Promise.resolve(),
        prompt: () => Promise.resolve(),
        command: () => Promise.resolve(),
        retire: () => Promise.resolve(),
        conversations: () => [],
        recordOf: () => undefined,
      },
      placement: () => ({ projectId: null, borrowed: null }),
    },
  });
  onTestFinished(() => service.close());
  return { service, seen, records, root, sweeps: () => sweeps };
}

/** A task that started and whose node began. */
const GOING: TaskEventInput[] = [
  { type: "started" },
  { type: "node_started", node: "N1", attempt: 1, sessionId: "ses_n1", startCommit: null },
  { type: "contract_sent", node: "N1", attempt: 1 },
];

/** What a node does to finish: `node_done`, then the end of its turn. */
const DONE: TaskEventInput = { type: "node_done_pending", node: "N1", attempt: 1, ok: true, summary: "done" };
const SETTLED: TaskEventInput = { type: "node_settled", node: "N1", attempt: 1 };

/** The options of a start that has pi. */
const WITH_PI = (staleLocks = true) => ({
  signal: new AbortController().signal,
  staleLocks,
  ready: () => Promise.resolve(true),
});

describe("recoverAll takes up the tasks the host left going (SPEC-0006, T9)", () => {
  it("recovers started tasks in the order they were made, and leaves a task still being designed alone", async () => {
    const { service, seen } = await startedHost([
      { id: "tsk_a", createdAt: 20, events: GOING },
      { id: "tsk_designing", createdAt: 5, events: [] },
      { id: "tsk_b", createdAt: 10, events: GOING },
    ]);

    await service.recoverAll(WITH_PI());
    await service.idle();

    // Each running node's pi was started for the restart line, the one made first goes first, whatever its name.
    expect(seen.opened).toStrictEqual(["ses_n1", "ses_n1"]);
    expect(seen.worktree.filter((entry) => entry.startsWith("lock:"))).toStrictEqual(["lock:tsk_b", "lock:tsk_a"]);
    expect(service.task("tsk_designing")?.startedAt).toBeNull();
  });

  it("lifts stale locks first, for the tasks that are over or whose directory is gone but not for one that cannot be read, and not at all when told not to", async () => {
    const withLocks = await startedHost([
      { id: "tsk_a", createdAt: 1, events: GOING },
      { id: "tsk_done", createdAt: 2, events: [...GOING, { type: "cancelled" }] },
      { id: "tsk_finished", createdAt: 3, events: [...GOING, DONE, SETTLED] },
    ]);
    // A directory that is there but whose events cannot be read: the task may be going, so it is not over.
    await mkdir(join(withLocks.root, "tsk_broken"), { recursive: true });
    await writeFile(join(withLocks.root, "tsk_broken", "events.jsonl"), "this is not an event\n{\n");
    await withLocks.service.recoverAll(WITH_PI(true));
    const without = await startedHost([{ id: "tsk_a", createdAt: 1, events: GOING }]);
    await without.service.recoverAll(WITH_PI(false));

    expect(withLocks.seen.worktree[0]).toBe(
      "stale:tsk_a=false,tsk_b=true,tsk_broken=false,tsk_done=true,tsk_finished=true,tsk_ghost=true",
    );
    expect(withLocks.sweeps()).toBe(1);
    expect(without.sweeps()).toBe(0);
    expect(withLocks.records.some((record) => record["msg"] === "stale task locks lifted")).toBe(true);
  });

  it("says how many stale locks it lifted, nothing when none, and goes on when the sweep fails", async () => {
    const lifted = await startedHost([{ id: "tsk_a", createdAt: 1, events: GOING }], 3);
    const none = await startedHost([{ id: "tsk_a", createdAt: 1, events: GOING }], 0);
    const failing = await startedHost([{ id: "tsk_a", createdAt: 1, events: GOING }], "fails");

    await lifted.service.recoverAll(WITH_PI());
    await none.service.recoverAll(WITH_PI());
    await failing.service.recoverAll(WITH_PI());
    await failing.service.idle();

    expect(lifted.records.filter((record) => record["msg"] === "stale task locks lifted")).toMatchObject([
      { level: "info", lifted: 3 },
    ]);
    expect(none.records.filter((record) => record["msg"] === "stale task locks lifted")).toStrictEqual([]);
    expect(failing.records.filter((record) => record["msg"] === "stale task locks not cleared")).toMatchObject([
      { level: "warn", err: "RangeError" },
    ]);
    // The tasks are taken up all the same.
    expect(failing.seen.opened).toStrictEqual(["ses_n1"]);
  });

  it("asks whether pi is ready only when a task needs it, leaves those tasks as they are when it is not, and warns once", async () => {
    const asked: string[] = [];
    const { service, seen, records } = await startedHost([
      { id: "tsk_a", createdAt: 1, events: GOING },
      { id: "tsk_b", createdAt: 2, events: GOING },
      { id: "tsk_done", createdAt: 3, events: [...GOING, { type: "cancelled" }] },
    ]);

    await service.recoverAll({
      signal: new AbortController().signal,
      staleLocks: false,
      ready() {
        asked.push("ready?");
        return Promise.resolve(false);
      },
    });
    await service.idle();

    expect(asked).toStrictEqual(["ready?"]);
    // The cancelled task needs no pi: its worktree was unlocked. The two that were going were not touched.
    expect(seen.worktree).toStrictEqual(["unlock:tsk_done"]);
    expect(seen.opened).toStrictEqual([]);
    expect(records.filter((record) => record["msg"] === "tasks not recovered: pi is not ready")).toMatchObject([
      { level: "warn", tasks: 2 },
    ]);
  });

  it("does not ask for pi, or warn, when no task is going", async () => {
    const { service, records } = await startedHost([
      { id: "tsk_designing", createdAt: 1, events: [] },
      { id: "tsk_done", createdAt: 2, events: [...GOING, { type: "cancelled" }] },
    ]);

    await service.recoverAll({
      signal: new AbortController().signal,
      staleLocks: false,
      ready: () => Promise.reject(new Error("pi was asked about")),
    });

    expect(records.filter((record) => record["level"] === "warn")).toStrictEqual([]);
  });

  it("stops at once when the host is closing, taking up no task", async () => {
    const { service, seen } = await startedHost([{ id: "tsk_a", createdAt: 1, events: GOING }]);

    await service.recoverAll({ signal: AbortSignal.abort(), staleLocks: true, ready: () => Promise.resolve(true) });

    expect(seen.worktree).toStrictEqual([]);
    expect(seen.opened).toStrictEqual([]);
  });

  it("goes on to the next task when one cannot be recovered, and logs it without naming anything", async () => {
    const { service, seen, records, root } = await startedHost([
      { id: "tsk_a", createdAt: 1, events: GOING },
      { id: "tsk_b", createdAt: 2, events: GOING },
    ]);
    // Its log cannot be written, so the restart cannot be recorded for it.
    await chmod(join(root, "tsk_a", "events.jsonl"), 0o444);

    await service.recoverAll(WITH_PI(false));
    await service.idle();

    expect(records.filter((record) => record["msg"] === "a task could not be recovered")).toMatchObject([
      { level: "warn", err: "Error" },
    ]);
    expect(seen.opened).toStrictEqual(["ses_n1"]);
    expect(service.task("tsk_b")?.runs[0]?.state).toBe("running");
  });
});

describe("opening a task twice at once", () => {
  it("opens its files once and gives both the same task", async () => {
    const { service } = await startedHost([{ id: "tsk_a", createdAt: 1, events: GOING }]);

    const [first, second] = await Promise.all([service.open("tsk_a"), service.open("tsk_a")]);

    expect(first).toBe(second);
    expect(service.held()).toHaveLength(1);
  });
});
