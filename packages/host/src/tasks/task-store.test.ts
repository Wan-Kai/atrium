import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeClock, createTempDir } from "@atrium/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplayError, replayEvents } from "./replay";
import { TaskStoreCorruptError, openTaskStore } from "./task-store";
import { agent, edges, human, need, newTask } from "./test-support";
import type { Task, TaskEventInput } from "./types";

let dir: { path: string; cleanup: () => Promise<void> };
let clock: FakeClock;

beforeEach(async () => {
  dir = await createTempDir("task-store");
  clock = new FakeClock(5000);
});

afterEach(async () => {
  await dir.cleanup();
});

/** The task all tests begin with: N1 then a human node. */
function initial(): Task {
  return newTask([agent("N1"), human("H1")], edges(["N1", "H1"]));
}

/** Opens the store and records a few events: created, started, N1 done and settled. */
async function populated(): Promise<void> {
  const store = await openTaskStore(dir.path, clock);
  const inputs: TaskEventInput[] = [
    { type: "created", task: initial() },
    { type: "started" },
    { type: "node_done_pending", node: "N1", attempt: 1, ok: true, summary: "s" },
    { type: "node_settled", node: "N1", attempt: 1 },
  ];
  for (const input of inputs) {
    clock.advance(10);
    await store.record(input);
  }
}

describe("TaskStore", () => {
  it("starts empty when the directory has nothing", async () => {
    const store = await openTaskStore(join(dir.path, "none"), clock);
    expect(store.current()).toBeNull();
    expect(store.events()).toStrictEqual([]);
    expect(store.recovery).toStrictEqual({ droppedTail: false, snapshot: "missing" });
  });

  it("gives each event its seq and the clock's time, runs it, and writes the log and the snapshot", async () => {
    const store = await openTaskStore(join(dir.path, "tsk_1"), clock);
    const created = await store.record({ type: "created", task: initial() });
    expect(created.event).toMatchObject({ seq: 1, at: 5000, type: "created" });
    clock.advance(25);
    const started = await store.record({ type: "started" });
    expect(started.event).toMatchObject({ seq: 2, at: 5025 });
    expect(started.actions).toContainEqual({ kind: "start_node", node: "N1", attempt: 1 });
    expect(store.current()?.startedAt).toBe(5025);

    const lines = (await readFile(join(dir.path, "tsk_1", "events.jsonl"), "utf8")).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(JSON.parse(need(lines[1]))).toStrictEqual({ seq: 2, at: 5025, type: "started" });
    const snapshot = JSON.parse(await readFile(join(dir.path, "tsk_1", "task.json"), "utf8")) as {
      seq: number;
      task: Task;
    };
    expect(snapshot.seq).toBe(2);
    expect(snapshot.task).toStrictEqual(store.current());
  });

  it("keeps the files private", async () => {
    await populated();
    expect((await stat(join(dir.path, "events.jsonl"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir.path, "task.json"))).mode & 0o777).toBe(0o600);
  });

  it("reads back what it wrote, with no repair needed", async () => {
    await populated();
    const store = await openTaskStore(dir.path, clock);
    expect(store.recovery).toStrictEqual({ droppedTail: false, snapshot: "ok" });
    expect(store.events().map((e) => e.type)).toStrictEqual([
      "created",
      "started",
      "node_done_pending",
      "node_settled",
    ]);
    expect(store.current()?.runs.map((r) => `${r.node}:${r.state}`)).toStrictEqual(["N1:passed", "H1:waiting"]);
  });

  it("numbers on from the log after a reopen", async () => {
    await populated();
    const store = await openTaskStore(dir.path, clock);
    const result = await store.record({ type: "human_passed", node: "H1" });
    expect(result.event.seq).toBe(5);
    expect(store.current()?.runs.at(-1)?.state).toBe("passed");
  });

  it("drops a last line that was cut short, and goes on appending on a clean line", async () => {
    await populated();
    const path = join(dir.path, "events.jsonl");
    await appendFile(path, '{"seq":5,"at":5100,"type":"human_pa');
    const store = await openTaskStore(dir.path, clock);
    expect(store.recovery.droppedTail).toBe(true);
    expect(store.events()).toHaveLength(4);
    expect(await readFile(path, "utf8")).toBe((await readFile(path, "utf8")).trimEnd() + "\n");
    await store.record({ type: "human_passed", node: "H1" });
    const reopened = await openTaskStore(dir.path, clock);
    expect(reopened.recovery).toStrictEqual({ droppedTail: false, snapshot: "ok" });
    expect(reopened.events().map((e) => e.seq)).toStrictEqual([1, 2, 3, 4, 5]);
  });

  it("drops a last line that parses but is not an event, and a cut line that ends with a newline", async () => {
    await populated();
    const path = join(dir.path, "events.jsonl");
    await appendFile(path, '{"seq":5,"at":1,"type":"nonsense"}\n\n');
    const store = await openTaskStore(dir.path, clock);
    expect(store.recovery.droppedTail).toBe(true);
    expect(store.events()).toHaveLength(4);
  });

  it("keeps a last line that is whole but lacks its newline, and does not run the next event into it", async () => {
    await populated();
    const path = join(dir.path, "events.jsonl");
    const text = await readFile(path, "utf8");
    await writeFile(path, text.trimEnd());
    const store = await openTaskStore(dir.path, clock);
    expect(store.recovery.droppedTail).toBe(false);
    expect(store.events()).toHaveLength(4);
    await store.record({ type: "human_passed", node: "H1" });
    expect((await openTaskStore(dir.path, clock)).events()).toHaveLength(5);
  });

  it("ignores blank lines", async () => {
    await populated();
    const path = join(dir.path, "events.jsonl");
    const lines = (await readFile(path, "utf8")).split("\n");
    await writeFile(path, [lines[0], "", ...lines.slice(1)].join("\n"));
    expect((await openTaskStore(dir.path, clock)).events()).toHaveLength(4);
  });

  it("refuses a log damaged anywhere but the last line", async () => {
    await populated();
    const path = join(dir.path, "events.jsonl");
    const lines = (await readFile(path, "utf8")).split("\n");
    lines[1] = "{broken";
    await writeFile(path, lines.join("\n"));
    const error = await openTaskStore(dir.path, clock).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TaskStoreCorruptError);
    expect(error).toMatchObject({ line: 2, path });
  });

  it("refuses a log whose seq skips", async () => {
    await populated();
    const path = join(dir.path, "events.jsonl");
    const lines = (await readFile(path, "utf8")).split("\n");
    lines.splice(2, 1);
    await writeFile(path, lines.join("\n"));
    await expect(openTaskStore(dir.path, clock)).rejects.toBeInstanceOf(ReplayError);
  });

  it("rebuilds task.json from the events when it is missing, damaged or behind", async () => {
    await populated();
    const snapshotPath = join(dir.path, "task.json");
    const good = await readFile(snapshotPath, "utf8");
    const expected = (await openTaskStore(dir.path, clock)).current();

    await writeFile(snapshotPath, "");
    let store = await openTaskStore(dir.path, clock);
    expect(store.recovery.snapshot).toBe("damaged");
    expect(store.current()).toStrictEqual(expected);
    expect(await readFile(snapshotPath, "utf8")).toBe(good);

    await writeFile(snapshotPath, '{"version":1,"seq":4,"task":{"id":1}}');
    store = await openTaskStore(dir.path, clock);
    expect(store.recovery.snapshot).toBe("damaged");
    expect(store.current()).toStrictEqual(expected);

    const stale = JSON.parse(good) as { seq: number };
    stale.seq = 3;
    await writeFile(snapshotPath, JSON.stringify(stale));
    store = await openTaskStore(dir.path, clock);
    expect(store.recovery.snapshot).toBe("stale");
    expect(store.current()).toStrictEqual(expected);
    expect(await readFile(snapshotPath, "utf8")).toBe(good);

    await writeFile(snapshotPath, JSON.stringify({ ...stale, seq: 9 }));
    expect((await openTaskStore(dir.path, clock)).recovery.snapshot).toBe("stale");

    await writeFile(snapshotPath, JSON.stringify([]));
    expect((await openTaskStore(dir.path, clock)).recovery.snapshot).toBe("damaged");

    await rm(snapshotPath);
    store = await openTaskStore(dir.path, clock);
    expect(store.recovery.snapshot).toBe("missing");
    expect(await readFile(snapshotPath, "utf8")).toBe(good);
  });

  it("rebuilds the snapshot when the log lost its tail but the snapshot did not", async () => {
    await populated();
    const path = join(dir.path, "events.jsonl");
    const lines = (await readFile(path, "utf8")).split("\n");
    await writeFile(path, `${lines.slice(0, 3).join("\n")}\n`);
    const store = await openTaskStore(dir.path, clock);
    expect(store.recovery.snapshot).toBe("stale");
    expect(store.current()?.runs[0]?.state).toBe("running");
  });

  it("trusts a current snapshot without replaying", async () => {
    await populated();
    const snapshotPath = join(dir.path, "task.json");
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as { task: Task };
    snapshot.task.name = "kept from the snapshot";
    await writeFile(snapshotPath, JSON.stringify(snapshot));
    expect((await openTaskStore(dir.path, clock)).current()?.name).toBe("kept from the snapshot");
  });

  it("starts from nothing when the log is empty even if a snapshot is left", async () => {
    await populated();
    await writeFile(join(dir.path, "events.jsonl"), "");
    const store = await openTaskStore(dir.path, clock);
    expect(store.current()).toBeNull();
  });

  it("does not write an event the scheduler throws on, nor one that is not valid", async () => {
    const store = await openTaskStore(dir.path, clock);
    await expect(store.record({ type: "started" })).rejects.toBeInstanceOf(ReplayError);
    await store.record({ type: "created", task: initial() });
    await expect(store.record({ type: "created", task: initial() })).rejects.toBeInstanceOf(ReplayError);
    await expect(store.record({ type: "node_settled", node: "", attempt: 0 })).rejects.toThrow(/./);
    expect((await readFile(join(dir.path, "events.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("keeps the order of events recorded without waiting for each other, and goes on after a failure", async () => {
    const store = await openTaskStore(dir.path, clock);
    await store.record({ type: "created", task: initial() });
    const results = await Promise.allSettled([
      store.record({ type: "started" }),
      store.record({ type: "node_settled", node: "", attempt: 0 }),
      store.record({ type: "paused" }),
    ]);
    expect(results.map((r) => r.status)).toStrictEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(store.events().map((e) => e.seq)).toStrictEqual([1, 2, 3]);
    expect(store.current()?.paused).toBe(true);
  });

  it("works from a directory that does not exist yet and creates it private", async () => {
    const nested = join(dir.path, "a", "b");
    const store = await openTaskStore(nested, clock);
    await store.record({ type: "created", task: initial() });
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
  });

  it("tells the scheduler's actions again when the log is replayed (the runner then recognises what is done)", async () => {
    await populated();
    const store = await openTaskStore(dir.path, clock);
    const steps = replayEvents(store.events());
    expect(steps.map((s) => s.actions.map((a) => a.kind).filter((k) => k !== "progress_line"))).toStrictEqual([
      [],
      ["start_node"],
      [],
      ["notify"],
    ]);
    expect(steps.at(-1)?.task).toStrictEqual(store.current());
    // Each action names what it is about, so a replayed one can be matched to work already done.
    expect(steps[1]?.actions[0]).toStrictEqual({ kind: "start_node", node: "N1", attempt: 1 });
  });

  it("fails if the snapshot cannot be written, but the event is already in the log", async () => {
    const store = await openTaskStore(dir.path, clock, () => Promise.reject(new Error("disk full")));
    await expect(store.record({ type: "created", task: initial() })).rejects.toThrow("disk full");
    expect((await readFile(join(dir.path, "events.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
    const reopened = await openTaskStore(dir.path, clock);
    expect(reopened.recovery.snapshot).toBe("missing");
    expect(reopened.current()?.id).toBe("tsk_1");
  });

  it("makes the directory if the first write comes to a store opened on nothing", async () => {
    await mkdir(join(dir.path, "x"), { recursive: true });
    const store = await openTaskStore(join(dir.path, "x"), clock);
    await store.record({ type: "created", task: initial() });
    expect(store.events()).toHaveLength(1);
  });
});

describe("replayEvents", () => {
  it("returns nothing for an empty log", () => {
    expect(replayEvents([])).toStrictEqual([]);
  });

  it("refuses a log that does not begin with `created`, or has a second one", () => {
    expect(() => replayEvents([{ seq: 1, at: 1, type: "started" }])).toThrow(ReplayError);
    const created = { seq: 1, at: 1, type: "created", task: initial() } as const;
    expect(() => replayEvents([created, { ...created, seq: 2 }])).toThrow("after the first");
    expect(() => replayEvents([{ ...created, seq: 2 }])).toThrow("seq 2");
  });
});
