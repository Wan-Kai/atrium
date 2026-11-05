import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { type TaskHost, startTaskHost } from "../../test/task-harness";
import { agent, edges } from "./test-support";

/** A reply that finishes a node. */
const finish = (id: string) => ({
  blocks: [{ type: "toolCall" as const, id, name: "node_done", arguments: { ok: true, summary: "done" } }],
});

/**
 * Node's live child processes, pipes, sockets and timers.
 *
 * @remarks
 * A count released without `clearTimeout`, or a child whose pipes stay open, shows up only here
 * (testing.md, "泄漏测试").
 *
 * @sideEffects none
 * @returns The counts by kind.
 */
function liveHandles(): Record<"ProcessWrap" | "PipeWrap" | "TCPWrap" | "Timeout", number> {
  const resources = process.getActiveResourcesInfo();
  const count = (kind: string): number => resources.filter((resource) => resource === kind).length;
  return {
    ProcessWrap: count("ProcessWrap"),
    PipeWrap: count("PipeWrap"),
    TCPWrap: count("TCPWrap"),
    Timeout: count("Timeout"),
  };
}

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
 * @param snapshot - The counts.
 * @param kind - The kind.
 * @returns The count.
 */
function countOf(snapshot: Readonly<Record<string, number>>, kind: string): number {
  return snapshot[kind] ?? 0;
}

/**
 * Waits until nothing the host does on its own is pending, and takes the counts.
 *
 * @remarks
 * The list's push, a scan and the first look at the workspaces end within a moment; until then their timers
 * and git processes count.
 *
 * @sideEffects Waits.
 * @param host - The host.
 * @returns The host's counts, Node's handles and the child processes.
 */
async function baseline(host: TaskHost) {
  await vi.waitFor(() => {
    const now = host.host.host.resources.snapshot();
    // The conversation tasks are made from has its pi up, and nothing else is in flight.
    expect([now["pi-process"], now["session.controller"], now["git.process"] ?? 0]).toStrictEqual([1, 1, 0]);
  });
  // What the list's push and the first scan started has ended after a moment (its spans and timers).
  await new Promise<void>((done) => {
    setTimeout(done, 1500);
  });
  return { before: host.host.host.resources.snapshot(), handles: liveHandles(), processes: children() };
}

describe('running tasks leaves nothing behind (testing.md, "泄漏测试")', () => {
  it("starts and stops many nodes with no pi, controller, listener or timer left over", async () => {
    const harness = await startTaskHost({ N1: [finish("d1")], N2: [finish("d2")] });
    const { before, handles, processes } = await baseline(harness);

    for (let round = 0; round < 5; round += 1) {
      const task = await harness.start([agent("N1", "explore"), agent("N2", "check")], edges(["N1", "N2"]));
      await harness.until(task.id, (now) => now.endedAt !== null);
    }

    await vi.waitFor(() => expect(harness.host.host.resources.snapshot()).toStrictEqual(before), { timeout: 10_000 });
    await vi.waitFor(() => expect(children()).toStrictEqual(processes), { timeout: 10_000 });
    await vi.waitFor(
      () => {
        const after = liveHandles();
        expect({ ...after, Timeout: Math.min(after.Timeout, handles.Timeout) }).toStrictEqual(handles);
      },
      { timeout: 10_000 },
    );
  });

  it("releases the runner and every pi, the node's included, when the host closes with a node running", async () => {
    const harness = await startTaskHost({ N1: [{ waitFor: "never", blocks: finish("d1").blocks }] });
    await baseline(harness);
    const task = await harness.start([agent("N1", "explore")], []);
    await harness.until(task.id, (now) => now.runs[0]?.sessionId != null);
    expect(harness.host.host.resources.snapshot()["pi-process"]).toBe(2);

    await harness.host.dispose();

    const after = harness.host.host.resources.snapshot();
    expect(countOf(after, "task.runner")).toBe(0);
    expect(countOf(after, "pi-process")).toBe(0);
    await vi.waitFor(() => expect(children()).toStrictEqual([]), { timeout: 10_000 });
  });
});
