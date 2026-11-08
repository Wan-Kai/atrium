import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { type TaskHost, startTaskHost } from "../../test/task-harness";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { recordingTracing } from "../../test/recording-tracing";
import { runAt } from "./graph";
import { createTaskCommands } from "./task-commands";
import { agent, edges, human, need } from "./test-support";

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

/**
 * What the first round does before passing: its branch has a commit, so a dirty main checkout blocks the merge,
 * and the task is sent back once.
 *
 * @sideEffects Writes and removes a file in the repository; answers commands.
 * @param harness - The task host.
 * @param taskId - The task.
 */
async function blockAndSendBack(harness: TaskHost, taskId: string): Promise<void> {
  const tasks = harness.host.host.tasks;
  await writeFile(join(harness.repo, "loose.txt"), "x\n");
  await tasks.answerHuman(taskId, "H", { kind: "pass" });
  await rm(join(harness.repo, "loose.txt"));
  await tasks.answerHuman(taskId, "H", { kind: "send_back", backTo: "N1", reason: "once more" });
  await vi.waitFor(() => expect(runAt(need(tasks.task(taskId)), "H", 2)?.state).toBe("waiting"));
}

/** Nothing to do before passing. */
async function nothing(): Promise<void> {}

/** What each round answers the archive question, and what it does before passing. */
const ROUNDS = [
  ["archive", blockAndSendBack],
  ["keep", nothing],
  ["archive", nothing],
  ["keep", nothing],
] as const;

/**
 * The baseline once the tasks that ended have left their archive question open.
 *
 * @remarks
 * Nobody answers it here, and an open review is kept by the reviews' hub for its session (all the harness's tasks
 * share one conversation id), so that one session is counted as held (`review.session`, T8 review fix 13).
 *
 * @sideEffects none
 * @param before - The counts before the tasks.
 * @returns The counts expected after them.
 */
function withOpenQuestion(before: Readonly<Record<string, number>>): Record<string, number> {
  return { ...before, "review.session": (before["review.session"] ?? 0) + 1 };
}

describe('running tasks leaves nothing behind (testing.md, "泄漏测试")', () => {
  it("starts and stops many nodes with no pi, controller, listener or timer left over", async () => {
    const harness = await startTaskHost({ N1: [finish("d1")], N2: [finish("d2")] });
    const { before, handles, processes } = await baseline(harness);

    for (let round = 0; round < 5; round += 1) {
      const task = await harness.start([agent("N1", "explore"), agent("N2", "check")], edges(["N1", "N2"]));
      await harness.until(task.id, (now) => now.endedAt !== null);
    }

    await vi.waitFor(() => expect(harness.host.host.resources.snapshot()).toStrictEqual(withOpenQuestion(before)), {
      timeout: 10_000,
    });
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

  it("merges, blocks, sends back and archives many tasks, and watches and unwatches, with nothing left over", async () => {
    const write = {
      blocks: [
        { type: "toolCall" as const, id: "w1", name: "write", arguments: { path: "./out.txt", content: "x\n" } },
      ],
    };
    const harness = await startTaskHost({ N1: [write, finish("d1")] });
    const { before, handles, processes } = await baseline(harness);
    const { logger } = recordingTracing();
    const commands = createTaskCommands({ service: harness.host.host.tasks, send: () => undefined, logger });

    for (const [round, [answer, beforePass]] of ROUNDS.entries()) {
      const task = await harness.start(
        [agent("N1", "work"), human("H", { merge: true })],
        edges(["N1", "H"], ["H", "N1", "back"]),
      );
      await harness.until(task.id, (now) => runAt(now, "H", 1)?.state === "waiting");
      const tasks = harness.host.host.tasks;
      await commands.list(`c${String(round)}`, true);
      await commands.open(`c${String(round)}`, task.id);
      await beforePass(harness, task.id);
      await tasks.answerHuman(task.id, "H", { kind: "pass" });
      await harness.until(task.id, (now) => now.endedAt !== null);
      await tasks.answerArchive(task.id, answer);
      commands.disconnect(`c${String(round)}`);
    }
    await commands.close();

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

  it("makes and abandons many tasks from a conversation with no pi, controller, listener or timer left over (SPEC-0006, T6)", async () => {
    const design = [{ blocks: [{ type: "text" as const, text: "Waiting for you." }] }];
    const harness = await startTaskHost({}, { design });
    await harness.discuss();
    const { before, handles, processes } = await baseline(harness);

    for (let round = 0; round < 3; round += 1) {
      const { taskId } = await harness.host.host.tasks.createFromChat(harness.origin, undefined);
      // The conversation's pi is up and has its first turn.
      expect(harness.host.host.resources.snapshot()["pi-process"]).toBe(2);
      await harness.host.host.tasks.abandon(taskId);
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

  it("releases the runner and the task conversation's pi when the host closes while a task is being designed", async () => {
    const harness = await startTaskHost({}, { design: [{ blocks: [{ type: "text" as const, text: "Hello." }] }] });
    await harness.discuss();
    await baseline(harness);
    await harness.host.host.tasks.createFromChat(harness.origin, undefined);
    expect(harness.host.host.resources.snapshot()["pi-process"]).toBe(2);

    await harness.host.dispose();

    const after = harness.host.host.resources.snapshot();
    expect(countOf(after, "task.runner")).toBe(0);
    expect(countOf(after, "pi-process")).toBe(0);
    await vi.waitFor(() => expect(children()).toStrictEqual([]), { timeout: 10_000 });
  });
});
