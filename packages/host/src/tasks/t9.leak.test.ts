import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { type TaskHost, startTaskHost } from "../../test/task-harness";
import { agent } from "./test-support";

vi.setConfig({ testTimeout: 90_000 });

/** A reply that holds until the test releases it, then ends the node. */
const holding = (name: string) => ({
  waitFor: name,
  blocks: [{ type: "toolCall" as const, id: `d-${name}`, name: "node_done", arguments: { ok: true, summary: "done" } }],
});

/**
 * The pids of the processes this test process started that still run, `ps` itself aside.
 *
 * @remarks
 * pi leads its own process group but stays this process's child until it exits.
 *
 * @sideEffects Runs `ps`.
 * @returns The pids, sorted.
 */
function children(): number[] {
  return execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([, ppid, comm]) => Number(ppid) === process.pid && comm !== "ps")
    .map(([pid]) => Number(pid))
    .toSorted((a, b) => a - b);
}

/**
 * A resource count, zero for a kind never seen.
 *
 * @remarks
 * The tracker lists only the kinds that were ever held.
 *
 * @sideEffects none
 * @param harness - The host.
 * @param kind - The kind.
 * @returns The count.
 */
function held(harness: TaskHost, kind: string): number {
  return harness.host.host.resources.snapshot()[kind] ?? 0;
}

/**
 * A task with a node running, and the host restarted under it.
 *
 * @remarks
 * The host takes the task up by itself; the node's reply is held until `release("hold")`.
 *
 * @sideEffects Starts hosts and pi processes, removed when the test finishes.
 * @returns The harness and the task.
 */
async function recovered() {
  const harness = await startTaskHost({ N1: [holding("hold")] });
  const task = await harness.start([agent("N1", "work")], []);
  await harness.until(task.id, (now) => now.runs[0]?.sessionId != null);
  await harness.restart();
  await vi.waitFor(() => expect(held(harness, "pi-process")).toBe(1), { timeout: 15_000 });
  return { harness, task };
}

describe('a task taken up after a restart leaves nothing behind (testing.md, "泄漏测试")', () => {
  it("lets go of its pi, controller and recovery when the task finishes", async () => {
    const { harness, task } = await recovered();
    const processes = children();

    await harness.release("hold");
    await harness.until(task.id, (now) => now.endedAt !== null);

    await vi.waitFor(
      () => {
        expect([held(harness, "pi-process"), held(harness, "session.controller")]).toStrictEqual([0, 0]);
        expect(held(harness, "git.process")).toBe(0);
        expect(held(harness, "task.runner")).toBe(1);
      },
      { timeout: 10_000 },
    );
    await vi.waitFor(() => expect(children().length).toBeLessThan(processes.length), { timeout: 10_000 });
    await vi.waitFor(() => expect(children()).toStrictEqual([]), { timeout: 10_000 });
  });

  it("lets go of its pi and controller when the task is cancelled", async () => {
    const { harness, task } = await recovered();

    await harness.host.host.tasks.cancel(task.id);
    await harness.until(task.id, (now) => now.cancelled);

    await vi.waitFor(
      () => {
        expect([held(harness, "pi-process"), held(harness, "session.controller")]).toStrictEqual([0, 0]);
        expect(held(harness, "git.process")).toBe(0);
      },
      { timeout: 10_000 },
    );
    await vi.waitFor(() => expect(children()).toStrictEqual([]), { timeout: 10_000 });
  });

  it("lets go of the runner and every pi when the host closes with the node running", async () => {
    const { harness } = await recovered();

    await harness.host.dispose();

    expect([held(harness, "task.runner"), held(harness, "pi-process")]).toStrictEqual([0, 0]);
    await vi.waitFor(() => expect(children()).toStrictEqual([]), { timeout: 10_000 });
  });

  it("lets go of everything when the host closes while it is still taking its tasks up", async () => {
    const harness = await startTaskHost({ N1: [holding("hold")] });
    const task = await harness.start([agent("N1", "work")], []);
    await harness.until(task.id, (now) => now.runs[0]?.sessionId != null);

    // Closed as soon as the new host listens: the recovery is under way, or about to be.
    await harness.restart();
    await harness.host.dispose();

    expect([held(harness, "task.runner"), held(harness, "pi-process")]).toStrictEqual([0, 0]);
    await vi.waitFor(() => expect(children()).toStrictEqual([]), { timeout: 10_000 });
  });
});
