import { createTempDir, present } from "@atrium/testkit";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { HostLockedError, type HostLockDeps, acquireHostLock, processExists } from "./host-lock";

const BOOTED_AT = 1_000_000;

/**
 * The lock's dependencies for a process that started after boot, with every process alive.
 *
 * @remarks
 * Tests override the liveness check and times to describe the holder they need.
 *
 * @sideEffects none
 * @param overrides - Fields to change.
 * @returns The dependencies.
 */
function deps(overrides: Partial<HostLockDeps> = {}): HostLockDeps {
  return { pid: 4242, now: BOOTED_AT + 5_000, bootedAt: BOOTED_AT, isAlive: () => true, ...overrides };
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
 * @sideEffects Writes `host.lock`.
 * @param directory - The home directory.
 * @param record - What the file holds.
 */
async function writeLock(directory: string, record: unknown): Promise<void> {
  await writeFile(join(directory, "host.lock"), typeof record === "string" ? record : JSON.stringify(record));
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

  it("refuses while a live host started since boot holds it", async () => {
    const directory = await home();
    const held = { pid: 77, startedAt: BOOTED_AT, token: "other" };
    await writeLock(directory, held);
    const checked: number[] = [];

    const acquiring = acquireHostLock(directory, deps({ isAlive: (pid) => (checked.push(pid), true) }));

    await expect(acquiring).rejects.toThrow(HostLockedError);
    await expect(acquiring).rejects.toMatchObject({ pid: 77 });
    expect(checked).toStrictEqual([77]);
    expect(JSON.parse(await readFile(join(directory, "host.lock"), "utf8"))).toStrictEqual(held);
    expect(await readdir(directory)).toStrictEqual(["host.lock"]);
  });

  it.each([
    ["a holder whose process is gone", { pid: 77, startedAt: BOOTED_AT + 1, token: "old" }, false],
    ["a holder from before the system started", { pid: 77, startedAt: BOOTED_AT - 1, token: "old" }, true],
    ["a damaged file", "{ pid", true],
    ["a file of another shape", { pid: "77", startedAt: BOOTED_AT + 1, token: "old" }, true],
    ["a process group's id", { pid: 0, startedAt: BOOTED_AT + 1, token: "old" }, true],
    ["a negative id", { pid: -5, startedAt: BOOTED_AT + 1, token: "old" }, true],
    ["a fractional id", { pid: 7.5, startedAt: BOOTED_AT + 1, token: "old" }, true],
    ["no start time", { pid: 77, token: "old" }, true],
    ["no token", { pid: 77, startedAt: BOOTED_AT + 1 }, true],
    ["JSON null", "null", true],
  ])("takes over %s", async (_case, record, alive) => {
    const directory = await home();
    await writeLock(directory, record);

    await acquireHostLock(directory, deps({ isAlive: () => alive }));

    expect(JSON.parse(await readFile(join(directory, "host.lock"), "utf8"))).toMatchObject({ pid: 4242 });
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
    await acquireHostLock(directory, deps({ pid: 2, isAlive: () => false }));

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

describe("processExists", () => {
  it("finds this process and not one that has ended", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", ""]);
    const pid = present(child.pid, "child pid");
    await new Promise((done) => child.once("exit", done));

    expect(processExists(process.pid)).toBe(true);
    expect(processExists(pid)).toBe(false);
  });

  it("counts a process of another user as existing", () => {
    // launchd, pid 1, belongs to root; signalling it is refused with EPERM.
    expect(processExists(1)).toBe(true);
  });
});
