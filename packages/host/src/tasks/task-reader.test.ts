import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDir, present } from "@atrium/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOLLOWED_STEPS, fingerprint, followedStep, followedTask, writeTask } from "./follow-support";
import { replayEvents } from "./replay";
import { readTaskDirectory, stampOf } from "./task-reader";
import { TaskStoreCorruptError, parseEvents } from "./task-store";

let dir: { path: string; cleanup: () => Promise<void> };

beforeEach(async () => {
  dir = await createTempDir("task-reader");
});

afterEach(async () => {
  await dir.cleanup();
});

describe("reading a task directory another process writes (SPEC-0006, T7.1)", () => {
  it("replays the whole log to the task the store would have", async () => {
    const writer = await writeTask(dir.path, followedTask("tsk_a"));
    for (const step of FOLLOWED_STEPS) await writer.record(step);
    const text = await readFile(join(dir.path, "tsk_a", "events.jsonl"), "utf8");
    const expected = replayEvents(parseEvents(text, "x").events).at(-1);

    const read = await readTaskDirectory(join(dir.path, "tsk_a"));

    expect(read).toMatchObject({ count: 1 + FOLLOWED_STEPS.length, partialTail: false });
    expect(read?.task).toStrictEqual(expected?.task);
    expect(read?.last.seq).toBe(1 + FOLLOWED_STEPS.length);
    expect(read?.task.runs.map((run) => [run.node, run.state])).toStrictEqual([
      ["N1", "passed"],
      ["N2", "passed"],
      ["H1", "waiting"],
    ]);
  });

  it("ignores a last line that is not written out yet, and reads it once it is", async () => {
    const writer = await writeTask(dir.path, followedTask("tsk_a"));
    await writer.record(followedStep(0));
    const events = join(dir.path, "tsk_a", "events.jsonl");
    const whole = JSON.stringify({
      seq: 3,
      at: 3,
      type: "node_started",
      node: "N1",
      attempt: 1,
      sessionId: "ses_n1",
      startCommit: null,
    });
    await appendFile(events, whole.slice(0, 40));

    const half = await readTaskDirectory(join(dir.path, "tsk_a"));
    await appendFile(events, `${whole.slice(40)}\n`);
    const complete = await readTaskDirectory(join(dir.path, "tsk_a"));

    expect(half).toMatchObject({ count: 2, partialTail: true });
    expect(half?.task.runs.map((run) => [run.node, run.sessionId])).toStrictEqual([["N1", null]]);
    expect(complete).toMatchObject({ count: 3, partialTail: false });
    expect(complete?.task.runs.map((run) => [run.node, run.sessionId])).toStrictEqual([["N1", "ses_n1"]]);
  });

  it("writes nothing: every file keeps its hash and its time, a half line left as it is and no snapshot made", async () => {
    const writer = await writeTask(dir.path, followedTask("tsk_a"));
    for (const step of FOLLOWED_STEPS.slice(0, 3)) await writer.record(step);
    const task = join(dir.path, "tsk_a");
    await appendFile(join(task, "events.jsonl"), '{"seq":5,"at":9,"type":"node_sta');
    // A snapshot that is behind, and one task with none at all: a reader must not repair either.
    await writeFile(join(task, "task.json"), "{}\n");
    const bare = join(dir.path, "tsk_b");
    await mkdir(bare);
    await writeFile(
      join(bare, "events.jsonl"),
      (await readFile(join(task, "events.jsonl"), "utf8")).replace(/tsk_a/gu, "tsk_b"),
    );
    const before = await fingerprint(dir.path);

    await readTaskDirectory(task);
    await readTaskDirectory(bare);
    await stampOf(task);

    expect(await fingerprint(dir.path)).toStrictEqual(before);
    expect((await readdir(bare)).toSorted()).toStrictEqual(["events.jsonl"]);
  });

  it("finds no task in a directory with no event yet", async () => {
    await mkdir(join(dir.path, "tsk_empty"));
    expect(await readTaskDirectory(join(dir.path, "tsk_empty"))).toBeNull();
    await writeFile(join(dir.path, "tsk_empty", "events.jsonl"), "");
    expect(await readTaskDirectory(join(dir.path, "tsk_empty"))).toBeNull();
    await writeFile(join(dir.path, "tsk_empty", "events.jsonl"), '{"seq":1,"at":1,"type":"cre');
    expect(await readTaskDirectory(join(dir.path, "tsk_empty"))).toBeNull();
    expect(await readTaskDirectory(join(dir.path, "tsk_missing"))).toBeNull();
    expect(await stampOf(join(dir.path, "tsk_missing"))).toBeNull();
  });

  it("refuses a log damaged anywhere but its last line", async () => {
    const writer = await writeTask(dir.path, followedTask("tsk_a"));
    for (const step of FOLLOWED_STEPS.slice(0, 2)) await writer.record(step);
    const events = join(dir.path, "tsk_a", "events.jsonl");
    const lines = (await readFile(events, "utf8")).split("\n");
    lines[1] = "not json";
    await writeFile(events, lines.join("\n"));

    await expect(readTaskDirectory(join(dir.path, "tsk_a"))).rejects.toBeInstanceOf(TaskStoreCorruptError);
  });

  it("tells a changed log by its size and time", async () => {
    const writer = await writeTask(dir.path, followedTask("tsk_a"));
    const first = await stampOf(join(dir.path, "tsk_a"));
    await writer.record(followedStep(0));
    const second = await stampOf(join(dir.path, "tsk_a"));

    expect(first?.size).toBeGreaterThan(0);
    expect(second?.size).toBeGreaterThan(present(first, "the first stamp").size);
  });
});
