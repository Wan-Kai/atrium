import { appendFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDir } from "@atrium/testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import { FOLLOWED_STEPS, countOf, fingerprint, followedStep, followedTask, writeTask } from "./follow-support";
import { type TaskFollower, startTaskFollower } from "./task-follower";
import type { Task } from "./types";

let dir: { path: string; cleanup: () => Promise<void> };
let followed: string;
let own: string;
const opened: TaskFollower[] = [];

beforeEach(async () => {
  dir = await createTempDir("task-follower");
  followed = join(dir.path, "try", "tasks");
  own = join(dir.path, "atrium", "tasks");
  await mkdir(followed, { recursive: true });
  await mkdir(own, { recursive: true });
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((follower) => follower.close()));
  await dir.cleanup();
});

/** Starts a follower on `followed` with short intervals, closed after the test. */
async function follow(extra: Partial<Parameters<typeof startTaskFollower>[0]> = {}, tracing = recordingTracing()) {
  const follower = await startTaskFollower({
    directory: followed,
    ownRoot: own,
    isOwned: async () => false,
    clock: systemClock,
    resources: tracing.resources,
    logger: tracing.logger,
    debounceMs: 20,
    pollMs: 30,
    retryMs: 30,
    safetyMs: 50,
    ...extra,
  });
  opened.push(follower);
  return { follower, ...tracing };
}

/** The states of a task's nodes, `N1:passed`. */
function states(task: Task | undefined): string[] {
  return (task?.runs ?? []).map((run) => `${run.node}:${run.state}`);
}

describe("following a task directory (SPEC-0006, T7.1)", () => {
  it("lists the tasks that are there, and tells of each step the writer takes afterwards", async () => {
    const writer = await writeTask(followed, followedTask("tsk_a"));
    const { follower } = await follow();
    const seen: string[][] = [];
    follower.onChange((task) => seen.push(states(task)));
    expect(follower.tasks().map((task) => task.id)).toStrictEqual(["tsk_a"]);
    expect(seen).toStrictEqual([]);

    await writer.record({ type: "started" });
    await vi.waitFor(() => expect(seen.at(-1)).toStrictEqual(["N1:running"]));
    for (const step of FOLLOWED_STEPS.slice(1, 4)) await writer.record(step);
    await vi.waitFor(() => expect(seen.at(-1)).toStrictEqual(["N1:passed", "N2:running"]));
    for (const step of FOLLOWED_STEPS.slice(4)) await writer.record(step);
    await vi.waitFor(() => expect(seen.at(-1)).toStrictEqual(["N1:passed", "N2:passed", "H1:waiting"]));

    expect(states(follower.task("tsk_a"))).toStrictEqual(["N1:passed", "N2:passed", "H1:waiting"]);
  });

  it("finds a task whose directory appears later, and one that goes away", async () => {
    const { follower } = await follow();
    const changes: string[] = [];
    follower.onChange((task) => changes.push(task.id));

    await writeTask(followed, followedTask("tsk_late"));
    await vi.waitFor(() => expect(follower.tasks().map((task) => task.id)).toStrictEqual(["tsk_late"]));
    expect(changes).toStrictEqual(["tsk_late"]);

    await rm(join(followed, "tsk_late"), { recursive: true });
    await vi.waitFor(() => expect(follower.tasks()).toStrictEqual([]));
    expect(changes).toStrictEqual(["tsk_late", "tsk_late"]);
  });

  it("ignores a line the writer has not finished, never writes to the directory, and reads the line once it is whole", async () => {
    const writer = await writeTask(followed, followedTask("tsk_a"));
    await writer.record({ type: "started" });
    const { follower } = await follow();
    const events = join(followed, "tsk_a", "events.jsonl");
    const line = JSON.stringify({
      seq: 3,
      at: 3,
      type: "node_started",
      node: "N1",
      attempt: 1,
      sessionId: "ses_n1",
      startCommit: null,
    });
    const before = await fingerprint(followed);
    const changes: Task[] = [];
    follower.onChange((task) => changes.push(task));

    await appendFile(events, line.slice(0, 30));
    const withHalf = await fingerprint(followed);
    await new Promise((done) => setTimeout(done, 200));
    await follower.idle();

    expect(changes).toStrictEqual([]);
    expect(follower.task("tsk_a")?.runs[0]?.sessionId).toBeNull();
    expect(await fingerprint(followed)).toStrictEqual(withHalf);
    expect(Object.keys(withHalf)).toStrictEqual(Object.keys(before));

    await appendFile(events, `${line.slice(30)}\n`);
    await vi.waitFor(() => expect(follower.task("tsk_a")?.runs[0]?.sessionId).toBe("ses_n1"));
    expect(changes).toHaveLength(1);
    expect((await readFile(events, "utf8")).endsWith("\n")).toBe(true);
  });

  it("follows by polling when the watch cannot be had", async () => {
    const writer = await writeTask(followed, followedTask("tsk_a"));
    const { follower, resources } = await follow({
      watch: (_directory, _onEvent, onError) => {
        queueMicrotask(onError);
        return () => undefined;
      },
    });
    await writer.record({ type: "started" });

    await vi.waitFor(() => expect(states(follower.task("tsk_a"))).toStrictEqual(["N1:running"]));
    expect(resources.snapshot()["task.follow.watch"]).toBe(0);
  });

  it("finds a change the watch never told of, with a look now and then", async () => {
    const writer = await writeTask(followed, followedTask("tsk_a"));
    const { follower } = await follow({ watch: () => () => undefined });
    await writer.record({ type: "started" });

    await vi.waitFor(() => expect(states(follower.task("tsk_a"))).toStrictEqual(["N1:running"]));
  });

  it("warns once about a missing directory, tries again, and follows when it appears", async () => {
    await rm(followed, { recursive: true });
    const { follower, records } = await follow();
    await new Promise((done) => setTimeout(done, 150));

    const warnings = records.filter((record) => record["msg"] === "task follow unavailable");
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain(dir.path);
    expect(follower.tasks()).toStrictEqual([]);

    await mkdir(followed, { recursive: true });
    await writeTask(followed, followedTask("tsk_a"));
    await vi.waitFor(() => expect(follower.tasks().map((task) => task.id)).toStrictEqual(["tsk_a"]));
  });

  it("tells the listeners of a task that appears after the directory was missing at the start", async () => {
    await rm(followed, { recursive: true });
    const { follower } = await follow();
    const changes: string[] = [];
    follower.onChange((task) => changes.push(task.id));

    await mkdir(followed, { recursive: true });
    await writeTask(followed, followedTask("tsk_a"));

    await vi.waitFor(() => expect(changes).toStrictEqual(["tsk_a"]));
  });

  it("lets an own task win an id, and says so once", async () => {
    await writeTask(followed, followedTask("tsk_same"));
    await writeTask(followed, followedTask("tsk_other"));
    const { follower, records } = await follow({ isOwned: async (id) => id === "tsk_same" });
    await new Promise((done) => setTimeout(done, 100));

    expect(follower.tasks().map((task) => task.id)).toStrictEqual(["tsk_other"]);
    expect(records.filter((record) => record["msg"] === "followed task id is an own task's; skipped")).toHaveLength(1);
  });

  it("refuses to follow the host's own tasks directory, also through a link", async () => {
    await writeTask(own, followedTask("tsk_own"));
    const link = join(dir.path, "link-to-own");
    await symlink(own, link);
    const { follower, resources, records } = await follow({ directory: link });

    expect(follower.tasks()).toStrictEqual([]);
    expect(
      records.some((record) => record["msg"] === "task follow refused: it is the host's own tasks directory"),
    ).toBe(true);
    expect(countOf(resources.snapshot(), "task.follow.watch")).toBe(0);
  });

  it("keeps the last good state of a task whose log is damaged in the middle, and logs it once", async () => {
    const writer = await writeTask(followed, followedTask("tsk_a"));
    await writer.record({ type: "started" });
    await writeTask(followed, followedTask("tsk_b"));
    const { follower, records } = await follow();
    const events = join(followed, "tsk_a", "events.jsonl");
    const lines = (await readFile(events, "utf8")).split("\n");
    lines[0] = "not json";
    await writeFile(events, lines.join("\n"));
    await vi.waitFor(() =>
      expect(records.filter((record) => record["msg"] === "a followed task could not be read")).toHaveLength(1),
    );
    await new Promise((done) => setTimeout(done, 150));

    expect(states(follower.task("tsk_a"))).toStrictEqual(["N1:running"]);
    expect(follower.task("tsk_b")?.id).toBe("tsk_b");
    expect(records.filter((record) => record["msg"] === "a followed task could not be read")).toHaveLength(1);
  });

  it("cancels a look it was waiting to make when closed", async () => {
    const writer = await writeTask(followed, followedTask("tsk_a"));
    const { follower, resources } = await follow({ debounceMs: 60_000, safetyMs: 60_000 });
    await writer.record({ type: "started" });
    await vi.waitFor(() => expect(resources.snapshot()["timer"]).toBe(2));

    await follower.close();

    expect(resources.snapshot()["timer"]).toBe(0);
  });

  it("releases its watch and timers when closed, and tells no one afterwards", async () => {
    const writer = await writeTask(followed, followedTask("tsk_a"));
    const { follower, resources } = await follow();
    const changes: Task[] = [];
    follower.onChange((task) => changes.push(task));
    await writer.record({ type: "started" });
    await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0));
    const count = changes.length;
    expect(resources.snapshot()["task.follow.watch"]).toBe(1);

    await follower.close();
    await writer.record(followedStep(1));
    await new Promise((done) => setTimeout(done, 150));

    expect(resources.snapshot()["task.follow.watch"]).toBe(0);
    expect(resources.snapshot()["timer"]).toBe(0);
    expect(changes).toHaveLength(count);
  });
});
