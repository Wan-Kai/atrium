import { createTempDir } from "@atrium/testkit";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { settledResources, startTestHost } from "../../test/harness";
import { FOLLOWED_STEPS, followedTask, writeTask } from "./follow-support";

/**
 * Node's live handles of the kinds a watcher leaves.
 *
 * @remarks
 * A watch that was not closed shows up only here; the timers are counted by the host's own `timer` resource instead, since
 * Node's `Timeout` count moves with the test runner's own timers (testing.md, "泄漏测试").
 *
 * @sideEffects none
 * @returns The counts by kind.
 */
function liveHandles(): Record<"FSEvent" | "FSWatcher", number> {
  const resources = process.getActiveResourcesInfo();
  const count = (kind: string): number => resources.filter((resource) => resource === kind).length;
  return { FSEvent: count("FSEvent"), FSWatcher: count("FSWatcher") };
}

describe("following tasks leaks nothing (SPEC-0006, T7.1)", () => {
  it("holds one watch while the host runs, and nothing once it has stopped, round after round", async () => {
    const dir = await createTempDir("followed-leak");
    try {
      const tasks = join(dir.path, "tasks");
      await mkdir(tasks);
      const writer = await writeTask(tasks, followedTask("tsk_try"));
      const baseline = liveHandles();

      for (const step of FOLLOWED_STEPS) {
        const host = await startTestHost({ followTasks: tasks });
        await writer.record(step);
        await vi.waitFor(() => expect(host.host.tasks.held().map((task) => task.id)).toStrictEqual(["tsk_try"]));
        await vi.waitFor(() => expect(host.host.resources.snapshot()["task.follow.watch"]).toBe(1));
        const resources = host.host.resources;
        await host.dispose();

        expect(resources.snapshot()["task.follow.watch"]).toBe(0);
        expect(resources.snapshot()["timer"]).toBe(0);
      }

      await vi.waitFor(() => expect(liveHandles()).toStrictEqual(baseline));
    } finally {
      await dir.cleanup();
    }
  });

  it("keeps the timers and the watch at their count through many appends", async () => {
    const dir = await createTempDir("followed-leak-appends");
    try {
      const tasks = join(dir.path, "tasks");
      await mkdir(tasks);
      const writer = await writeTask(tasks, followedTask("tsk_try"));
      const host = await startTestHost({ followTasks: tasks });
      try {
        await vi.waitFor(() => expect(host.host.tasks.held()).toHaveLength(1));
        const settled = await settledResources(host.host);

        for (let i = 0; i < 30; i += 1) {
          await writer.record({ type: "paused" });
          await writer.record({ type: "resumed" });
        }
        await vi.waitFor(() => expect(host.host.tasks.held()[0]?.paused).toBe(false));
        await vi.waitFor(() => expect(host.host.resources.snapshot()).toStrictEqual(settled));
      } finally {
        await host.dispose();
      }
    } finally {
      await dir.cleanup();
    }
  });
});
