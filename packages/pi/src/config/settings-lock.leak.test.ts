import { createTempDir } from "@atrium/testkit";
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { acquirePiSettingsLock } from "./settings-lock";

it("releases settings lock heartbeat timers and directories on repeated success and failure", async () => {
  const temp = await createTempDir("settings-lock-leak");
  onTestFinished(temp.cleanup);
  const dir = await realpath(temp.path);
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const baseline = vi.getTimerCount();
  for (let count = 0; count < 20; count += 1) {
    const lock = await acquirePiSettingsLock(join(dir, "settings.json"));
    try {
      expect(vi.getTimerCount()).toBe(baseline + 1);
      await expect(acquirePiSettingsLock(join(dir, "settings.json"))).rejects.toMatchObject({ code: "ELOCKED" });
      expect(vi.getTimerCount()).toBe(baseline + 1);
    } finally {
      await lock.release();
    }
    expect(vi.getTimerCount()).toBe(baseline);
    expect(await readdir(dir)).toStrictEqual([]);
  }
});
