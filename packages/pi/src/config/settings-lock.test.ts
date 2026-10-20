import { createTempDir } from "@atrium/testkit";
import { readdir, realpath, rmdir } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { expect, it, onTestFinished, vi } from "vitest";
import { acquirePiSettingsLock } from "./settings-lock";

it("interoperates with pi's proper-lockfile options and removes lock resources on release", async () => {
  const temp = await createTempDir("settings-lock");
  onTestFinished(temp.cleanup);
  const dir = await realpath(temp.path);
  const path = join(dir, "settings.json");
  const piRelease = lockfile.lockSync(path, { realpath: false });
  try {
    await expect(acquirePiSettingsLock(path)).rejects.toMatchObject({ code: "ELOCKED" });
  } finally {
    piRelease();
  }
  const lock = await acquirePiSettingsLock(path);
  try {
    expect(lock.check()).toBeUndefined();
    expect(() => lockfile.lockSync(path, { realpath: false })).toThrow(expect.objectContaining({ code: "ELOCKED" }));
    expect(await readdir(dir)).toStrictEqual(["settings.json.lock"]);
  } finally {
    await lock.release();
  }
  expect(await readdir(dir)).toStrictEqual([]);
  const again = lockfile.lockSync(path, { realpath: false });
  again();
});

it("reports a compromised lock without throwing from the heartbeat or deleting another owner's lock", async () => {
  const temp = await createTempDir("settings-compromised");
  onTestFinished(temp.cleanup);
  const dir = await realpath(temp.path);
  const path = join(dir, "settings.json");
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const lock = await acquirePiSettingsLock(path);
  await rmdir(`${path}.lock`);
  await vi.advanceTimersByTimeAsync(5_000);
  await vi.waitFor(() => expect(() => lock.check()).toThrow(expect.objectContaining({ code: "ECOMPROMISED" })));
  const other = await acquirePiSettingsLock(path);
  try {
    await lock.release();
    expect(await readdir(dir)).toStrictEqual(["settings.json.lock"]);
    expect(other.check()).toBeUndefined();
  } finally {
    await other.release();
  }
  expect(vi.getTimerCount()).toBe(0);
});
