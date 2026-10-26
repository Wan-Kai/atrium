import { createTempDir, FakeClock } from "@atrium/testkit";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { DailyLog } from "./daily-log";
import { ResourceTracker } from "./resources";

const DAY = 86_400_000;

/**
 * A log in a temporary directory on a fake clock at 2026-10-25 23:59:59 UTC.
 *
 * @remarks
 * One second before midnight, so a test can step into the next day.
 *
 * @sideEffects Creates a directory.
 * @returns The log and what the test checks.
 */
async function logIn(): Promise<{
  log: DailyLog;
  dir: string;
  clock: FakeClock;
  resources: ResourceTracker;
  errors: Error[];
}> {
  const temp = await createTempDir("relay-log");
  onTestFinished(temp.cleanup);
  const dir = join(temp.path, "logs");
  const clock = new FakeClock(Date.parse("2026-10-25T23:59:59.000Z"));
  const resources = new ResourceTracker();
  const errors: Error[] = [];
  return { log: new DailyLog(dir, clock, resources, (error) => errors.push(error)), dir, clock, resources, errors };
}

/**
 * The parsed lines of one file.
 *
 * @remarks
 * Every line must be JSON.
 *
 * @sideEffects Reads the file.
 * @param path - The file.
 * @returns The records.
 */
async function lines(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  return text
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

describe("DailyLog", () => {
  it("appends JSON lines with the time first to a 0600 file named by the UTC day", async () => {
    const { log, dir } = await logIn();
    await log.open();

    log.write({ event: "a", n: 1 });
    log.write({ event: "b" });
    await log.close();

    const path = join(dir, "relay-2026-10-25.jsonl");
    expect(await lines(path)).toStrictEqual([
      { time: "2026-10-25T23:59:59.000Z", event: "a", n: 1 },
      { time: "2026-10-25T23:59:59.000Z", event: "b" },
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("starts the next day's file with the first line after midnight", async () => {
    const { log, dir, clock, resources } = await logIn();
    await log.open();
    log.write({ event: "before" });

    clock.advance(1_000);
    log.write({ event: "after" });
    await log.close();

    expect(await lines(join(dir, "relay-2026-10-25.jsonl"))).toStrictEqual([
      { time: "2026-10-25T23:59:59.000Z", event: "before" },
    ]);
    expect(await lines(join(dir, "relay-2026-10-26.jsonl"))).toStrictEqual([
      { time: "2026-10-26T00:00:00.000Z", event: "after" },
    ]);
    expect(resources.snapshot()).toStrictEqual({ "log.file": 0 });
  });

  it("keeps 14 days of files and deletes older ones of its own only", async () => {
    const { log, dir } = await logIn();
    await mkdir(dir, { recursive: true });
    const names = [
      "relay-2026-10-11.jsonl",
      "relay-2026-10-12.jsonl",
      "relay-2025-01-01.jsonl",
      "other-2026-01-01.jsonl",
      "relay-x.jsonl",
      "xrelay-2025-01-01.jsonl",
      "relay-2025-01-01.jsonl.bak",
    ];
    for (const name of names) await writeFile(join(dir, name), "");

    await log.open();
    await log.close();

    expect((await readdir(dir)).toSorted()).toStrictEqual([
      "other-2026-01-01.jsonl",
      "relay-2025-01-01.jsonl.bak",
      "relay-2026-10-12.jsonl",
      "relay-2026-10-25.jsonl",
      "relay-x.jsonl",
      "xrelay-2025-01-01.jsonl",
    ]);
  });

  it("prunes again when the day changes", async () => {
    const { log, dir, clock } = await logIn();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "relay-2026-10-12.jsonl"), "");
    await log.open();

    clock.advance(1_000 + DAY);
    log.write({ event: "x" });
    await log.close();

    expect((await readdir(dir)).toSorted()).toStrictEqual(["relay-2026-10-25.jsonl", "relay-2026-10-27.jsonl"]);
  });

  it("opens no new file for lines written after close, even on a new day", async () => {
    const { log, dir, clock, resources } = await logIn();
    await log.open();
    await log.close();

    clock.advance(DAY);
    log.write({ event: "late" });

    expect(await readdir(dir)).toStrictEqual(["relay-2026-10-25.jsonl"]);
    expect(resources.snapshot()).toStrictEqual({ "log.file": 0 });
  });

  it("reports a directory it cannot list and keeps logging", async () => {
    const { log, dir, errors } = await logIn();
    await mkdir(dir, { recursive: true, mode: 0o300 });
    onTestFinished(() => chmod(dir, 0o700));

    await log.open();
    log.write({ event: "a" });
    await log.close();

    expect(errors.map((error) => (error as NodeJS.ErrnoException).code)).toStrictEqual(["EACCES"]);
    await chmod(dir, 0o700);
    expect(await lines(join(dir, "relay-2026-10-25.jsonl"))).toStrictEqual([
      { time: "2026-10-25T23:59:59.000Z", event: "a" },
    ]);
  });

  it("drops lines written after close", async () => {
    const { log, dir } = await logIn();
    await log.open();
    log.write({ event: "kept" });
    await log.close();

    log.write({ event: "dropped" });

    expect(await lines(join(dir, "relay-2026-10-25.jsonl"))).toStrictEqual([
      { time: "2026-10-25T23:59:59.000Z", event: "kept" },
    ]);
  });

  it("reports a file it cannot open once and keeps going", async () => {
    const { log, dir, errors, resources } = await logIn();
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o500);
    onTestFinished(() => chmod(dir, 0o700));

    await log.open();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    log.write({ event: "a" });
    log.write({ event: "b" });
    await log.close();

    expect(errors.map((error) => (error as NodeJS.ErrnoException).code)).toStrictEqual(["EACCES"]);
    expect(resources.snapshot()).toStrictEqual({ "log.file": 0 });
  });

  it("fails to open when the directory cannot be created", async () => {
    const { dir, clock, resources } = await logIn();
    await writeFile(join(dir, "..", "blocker"), "");
    const log = new DailyLog(join(dir, "..", "blocker", "logs"), clock, resources, () => {});

    await expect(log.open()).rejects.toThrow("ENOTDIR");
  });
});
