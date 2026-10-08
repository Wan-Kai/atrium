import { createTempDir, present } from "@atrium/testkit";
import { spawn } from "node:child_process";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { HostLockedError, type HostLockDeps, acquireHostLock, processStartedAt } from "./host-lock";

const BOOTED_AT = 1_000_000;

/**
 * The lock's dependencies for a process that started after boot.
 *
 * @remarks
 * By default every process id belongs to a process that started at boot, so any recorded holder
 * is live; tests override the start times to describe the holder they need.
 *
 * @sideEffects none
 * @param overrides - Fields to change.
 * @returns The dependencies.
 */
function deps(overrides: Partial<HostLockDeps> = {}): HostLockDeps {
  return {
    pid: 4242,
    now: BOOTED_AT + 5_000,
    bootedAt: BOOTED_AT,
    processStartedAt: async () => BOOTED_AT,
    ...overrides,
  };
}

/**
 * Start times of the processes that exist; every other id has none.
 *
 * @remarks
 * Describes which holders are alive.
 *
 * @sideEffects none
 * @param started - Start times by process id.
 * @returns The lookup.
 */
function startTimes(started: Record<number, number>): HostLockDeps["processStartedAt"] {
  return async (pid) => started[pid] ?? null;
}

/**
 * Creates a home directory for one test.
 *
 * @remarks
 * Real files, as everywhere in the store's tests.
 *
 * @sideEffects Creates a temporary directory, removed when the test ends.
 * @returns Its path.
 */
async function home(): Promise<string> {
  const dir = await createTempDir("lock");
  onTestFinished(dir.cleanup);
  return dir.path;
}

/**
 * Writes a lock file as another host would have.
 *
 * @remarks
 * Describes the holder whose lock is found.
 *
 * @sideEffects Writes the file.
 * @param directory - The home directory.
 * @param record - What the file holds.
 * @param name - The file's name.
 */
async function writeLock(directory: string, record: unknown, name = "host.lock"): Promise<void> {
  await writeFile(join(directory, name), typeof record === "string" ? record : JSON.stringify(record));
}

describe("acquireHostLock", () => {
  it("writes this process's id and start time, owner-only, leaving nothing else behind", async () => {
    const directory = await home();

    await acquireHostLock(directory, deps());

    expect(await readdir(directory)).toStrictEqual(["host.lock"]);
    expect(JSON.parse(await readFile(join(directory, "host.lock"), "utf8"))).toStrictEqual({
      pid: 4242,
      startedAt: BOOTED_AT + 5_000,
      token: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  });

  it("refuses while the host that wrote the lock still runs", async () => {
    const directory = await home();
    const held = { pid: 77, startedAt: BOOTED_AT + 2_000, token: "other" };
    await writeLock(directory, held);
    const asked: number[] = [];

    const acquiring = acquireHostLock(
      directory,
      deps({
        processStartedAt: async (pid) => {
          asked.push(pid);
          // Reported a second after it wrote the lock, which the slack for whole seconds covers.
          return startTimes({ 77: BOOTED_AT + 3_000 })(pid);
        },
      }),
    );

    await expect(acquiring).rejects.toThrow(HostLockedError);
    await expect(acquiring).rejects.toMatchObject({ pid: 77 });
    expect(asked).toStrictEqual([77]);
    expect(JSON.parse(await readFile(join(directory, "host.lock"), "utf8"))).toStrictEqual(held);
    expect(await readdir(directory)).toStrictEqual(["host.lock"]);
  });

  it.each([
    ["a holder whose process is gone", { pid: 77, startedAt: BOOTED_AT + 1, token: "old" }, null],
    [
      "a holder whose id now belongs to a later process",
      { pid: 77, startedAt: BOOTED_AT + 1, token: "old" },
      BOOTED_AT + 1_002,
    ],
    ["a holder from before the system started", { pid: 77, startedAt: BOOTED_AT - 1, token: "old" }, BOOTED_AT],
    ["a damaged file", "{ pid", BOOTED_AT],
    ["a file of another shape", { pid: "77", startedAt: BOOTED_AT + 1, token: "old" }, BOOTED_AT],
    ["a process group's id", { pid: 0, startedAt: BOOTED_AT + 1, token: "old" }, BOOTED_AT],
    ["a negative id", { pid: -5, startedAt: BOOTED_AT + 1, token: "old" }, BOOTED_AT],
    ["a fractional id", { pid: 7.5, startedAt: BOOTED_AT + 1, token: "old" }, BOOTED_AT],
    ["no start time", { pid: 77, token: "old" }, BOOTED_AT],
    ["no token", { pid: 77, startedAt: BOOTED_AT + 1 }, BOOTED_AT],
    ["JSON null", "null", BOOTED_AT],
  ])("takes over %s, leaving no takeover lock", async (_case, record, started) => {
    const directory = await home();
    await writeLock(directory, record);

    await acquireHostLock(directory, deps({ processStartedAt: async () => started }));

    expect(JSON.parse(await readFile(join(directory, "host.lock"), "utf8"))).toMatchObject({ pid: 4242 });
    expect(await readdir(directory)).toStrictEqual(["host.lock"]);
  });

  it("refuses to take over while another live host is taking over, naming the holder", async () => {
    const directory = await home();
    await writeLock(directory, { pid: 77, startedAt: BOOTED_AT + 1, token: "old" });
    await writeLock(directory, { pid: 88, startedAt: BOOTED_AT + 10, token: "taking" }, "host.lock.takeover");

    const acquiring = acquireHostLock(directory, deps({ processStartedAt: startTimes({ 88: BOOTED_AT + 5 }) }));

    await expect(acquiring).rejects.toMatchObject({ pid: 77 });
    expect((await readdir(directory)).toSorted()).toStrictEqual(["host.lock", "host.lock.takeover"]);
  });

  it("takes over a takeover lock left by a host that died while taking over", async () => {
    const directory = await home();
    await writeLock(directory, { pid: 77, startedAt: BOOTED_AT + 1, token: "old" });
    await writeLock(directory, "{ damaged", "host.lock.takeover");

    await acquireHostLock(directory, deps({ processStartedAt: async () => null }));

    expect(await readdir(directory)).toStrictEqual(["host.lock"]);
  });

  it("lets only one of two hosts taking over the same dead lock at once win", async () => {
    const directory = await home();
    await writeLock(directory, { pid: 77, startedAt: BOOTED_AT + 1, token: "old" });
    // Process 77 is gone; the two hosts are alive, started at boot.
    const both = deps({ processStartedAt: startTimes({ 1: BOOTED_AT, 2: BOOTED_AT }) });

    const results = await Promise.allSettled([
      acquireHostLock(directory, { ...both, pid: 1 }),
      acquireHostLock(directory, { ...both, pid: 2 }),
    ]);

    expect(results.map((result) => result.status).toSorted()).toStrictEqual(["fulfilled", "rejected"]);
    expect(await readdir(directory)).toStrictEqual(["host.lock"]);
  });

  it("refuses a second host in the same home", async () => {
    const directory = await home();
    await acquireHostLock(directory, deps({ pid: 1 }));

    await expect(acquireHostLock(directory, deps({ pid: 2 }))).rejects.toMatchObject({ pid: 1 });
  });

  it("throws when the home cannot be written", async () => {
    const directory = await home();
    await chmod(directory, 0o500);
    onTestFinished(() => chmod(directory, 0o700));

    await expect(acquireHostLock(directory, deps())).rejects.toMatchObject({ code: "EACCES" });
  });
});

describe("HostLock.release", () => {
  it("removes the lock, so the next host takes it", async () => {
    const directory = await home();
    const lock = await acquireHostLock(directory, deps({ pid: 1 }));

    await lock.release();

    expect(await readdir(directory)).toStrictEqual([]);
    await acquireHostLock(directory, deps({ pid: 2 }));
  });

  it("leaves a lock another host has taken over", async () => {
    const directory = await home();
    const lock = await acquireHostLock(directory, deps({ pid: 1 }));
    await acquireHostLock(directory, deps({ pid: 2, processStartedAt: async () => null }));

    await lock.release();

    expect(JSON.parse(await readFile(join(directory, "host.lock"), "utf8"))).toMatchObject({ pid: 2 });
  });
});

describe("HostLockedError", () => {
  it("names the holder, or says it is unknown", () => {
    expect(new HostLockedError(77).message).toBe("another Atrium host (pid 77) is using this home directory");
    expect(new HostLockedError(null).message).toBe("another Atrium host (pid unknown) is using this home directory");
    expect(new HostLockedError(null).name).toBe("HostLockedError");
  });
});

describe("processStartedAt", () => {
  it("tells when this process started, and nothing for one that has ended", async () => {
    const child = spawn(process.execPath, ["-e", ""]);
    const pid = present(child.pid, "child pid");
    await new Promise((done) => child.once("exit", done));

    const mine = present(await processStartedAt(process.pid), "this process's start");

    expect(mine).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - mine).toBeLessThan(10 * 60_000);
    expect(await processStartedAt(pid)).toBeNull();
  });
});
