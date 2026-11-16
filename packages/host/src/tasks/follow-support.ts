import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { FakeClock, present } from "@atrium/testkit";
import { newTaskRecord } from "./new-task";
import { openTaskStore } from "./task-store";
import { agent, edges, human } from "./test-support";
import type { Task, TaskEventInput } from "./types";

/**
 * A task as `pnpm task:try` would make it: an explore node, a work node, then a human node.
 *
 * @remarks
 * Test data for the follower: the ids and names are fixed so assertions can write them out.
 *
 * @sideEffects none
 * @param id - The task's id (`tsk_…`).
 * @returns The task record, with its first graph in force and not yet approved.
 */
export function followedTask(id: string): Task {
  return newTaskRecord({
    id,
    name: `followed ${id}`,
    projectId: "prj_0123456789abcdef",
    sourceDir: "/try/repo",
    originSessionId: "ses_try_source",
    taskSessionId: "ses_try_task",
    model: { providerId: "faux", modelId: "faux-1", thinking: "off" },
    goal: "follow me",
    nodes: [agent("N1"), agent("N2", "explore"), human("H1")],
    edges: edges(["N1", "N2"], ["N2", "H1"]),
    now: 1_000,
  });
}

/** The events that take `followedTask` forward one step at a time: the task starts, N1 runs and passes, N2 runs. */
export const FOLLOWED_STEPS: readonly TaskEventInput[] = [
  { type: "started" },
  { type: "node_started", node: "N1", attempt: 1, sessionId: "ses_n1", startCommit: null },
  { type: "node_done_pending", node: "N1", attempt: 1, ok: true, summary: "explored" },
  { type: "node_settled", node: "N1", attempt: 1 },
  { type: "node_started", node: "N2", attempt: 1, sessionId: "ses_n2", startCommit: null },
  { type: "node_done_pending", node: "N2", attempt: 1, ok: true, summary: "explored more" },
  { type: "node_settled", node: "N2", attempt: 1 },
];

/** The other process that writes a task directory: the real store, opened on its own. */
export interface TaskWriter {
  /** Records one event, as `task:try`'s host does. */
  record(input: TaskEventInput): Promise<void>;
}

/**
 * Opens the real task store on a directory and writes its first event, as the writer of a followed directory.
 *
 * @remarks
 * `pnpm task:try` runs in another process; the store it writes with is this one, and what it appends is the same
 * bytes. A test that needs the half-written case writes the bytes by hand.
 *
 * @sideEffects Creates the task's directory and `events.jsonl` and `task.json` in it.
 * @param root - The tasks directory being followed.
 * @param task - The task to create.
 * @returns The writer.
 */
export async function writeTask(root: string, task: Task): Promise<TaskWriter> {
  const clock = new FakeClock(2_000);
  const store = await openTaskStore(join(root, task.id), clock);
  await store.record({ type: "created", task });
  return {
    async record(input) {
      clock.advance(10);
      await store.record(input);
    },
  };
}

/** What a directory holds: each file's content hash, size and modification time. */
export type DirectoryFingerprint = Readonly<Record<string, { readonly sha: string; readonly mtimeMs: number }>>;

/**
 * Hashes every file under a directory and notes its modification time.
 *
 * @remarks
 * Proves a reader never wrote: the same fingerprint before and after means no file was changed, created or
 * touched.
 *
 * @sideEffects Reads the files.
 * @param directory - The directory.
 * @returns The fingerprint, keyed by relative path.
 */
export async function fingerprint(directory: string): Promise<DirectoryFingerprint> {
  const result: Record<string, { sha: string; mtimeMs: number }> = {};
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const [content, info] = await Promise.all([readFile(path), stat(path)]);
    result[path.slice(directory.length + 1)] = {
      sha: createHash("sha256").update(content).digest("hex"),
      mtimeMs: info.mtimeMs,
    };
  }
  return result;
}

/**
 * One of `FOLLOWED_STEPS`.
 *
 * @remarks
 * Lets a test name a step by its place without a fallback for a place that is not there.
 *
 * @sideEffects none
 * @param index - The step's place.
 * @returns The event.
 * @throws {Error} When there is no such step.
 */
export function followedStep(index: number): TaskEventInput {
  return present(FOLLOWED_STEPS[index], `followed step ${String(index)}`);
}

/**
 * A resource count, zero for a kind never held.
 *
 * @remarks
 * The tracker lists only the kinds that were ever held.
 *
 * @sideEffects none
 * @param snapshot - The tracker's counts.
 * @param kind - The kind.
 * @returns The count.
 */
export function countOf(snapshot: Readonly<Record<string, number>>, kind: string): number {
  return snapshot[kind] ?? 0;
}
