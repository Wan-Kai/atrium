import type { AtriumClient } from "@atrium/client";
import { CommandError, type PendingReview, type ReviewRecord } from "@atrium/protocol";
import type { NodeRun, Task } from "../src/tasks/types";

/**
 * The latest run of a node.
 *
 * @remarks
 * Test support for the review tests: the highest attempt wins, as the board reads it.
 *
 * @sideEffects none
 * @param task - The task.
 * @param node - The node.
 * @returns The run, or `undefined`.
 */
export function latestRunOf(task: Task, node: string) {
  return task.runs.filter((run) => run.node === node).toSorted((a, b) => b.attempt - a.attempt)[0];
}

/**
 * Whether a node's latest run is the attempt given and waits.
 *
 * @remarks
 * Test support: a condition for `until`, kept out of the test bodies, which hold no conditionals.
 *
 * @sideEffects none
 * @param task - The task.
 * @param node - The node.
 * @param attempt - The attempt.
 * @returns Whether it is.
 */
export function waitsAtAttempt(task: Task, node: string, attempt: number): boolean {
  const run = latestRunOf(task, node);
  return run?.attempt === attempt && run.state === "waiting";
}

/**
 * The review records (steps on the rail) in a conversation, as the client has them.
 *
 * @remarks
 * Test support.
 *
 * @sideEffects none
 * @param client - The client.
 * @param sessionId - The conversation.
 * @returns The records, oldest first.
 */
export function reviewRecords(client: AtriumClient, sessionId: string): ReviewRecord[] {
  return (client.session(sessionId)?.getState().items ?? []).flatMap((item) =>
    item.kind === "notice" && item.notice === "review" ? [item.review] : [],
  );
}

/**
 * The review records as short lines: `task_human: send_back N1`.
 *
 * @remarks
 * Test support.
 *
 * @sideEffects none
 * @param client - The client.
 * @param sessionId - The conversation.
 * @returns One line per record.
 */
export function recordLines(client: AtriumClient, sessionId: string): string[] {
  return reviewRecords(client, sessionId).map(
    (record) =>
      `${record.source.kind === "gate" ? record.source.gate : "agent"}: ${record.verdict.action}${
        record.verdict.target === undefined ? "" : ` ${record.verdict.target}`
      }`,
  );
}

/**
 * The reviews a conversation's control carries, as the client has them.
 *
 * @remarks
 * Test support.
 *
 * @sideEffects none
 * @param client - The client.
 * @param sessionId - The conversation.
 * @returns The reviews.
 */
export function controlReviews(client: AtriumClient, sessionId: string): PendingReview[] {
  return [...(client.session(sessionId)?.getState().control.reviews ?? [])];
}

/**
 * What a settled promise failed with, as a code.
 *
 * @remarks
 * Test support: `""` for one that did not fail or failed with something that is not a command error.
 *
 * @sideEffects none
 * @param settled - The outcome.
 * @returns The code.
 */
export function failedCode(settled: PromiseSettledResult<unknown>): string {
  return settled.status === "rejected" && settled.reason instanceof CommandError ? settled.reason.code : "";
}

/**
 * A task with the fields of one node's runs changed.
 *
 * @remarks
 * Test support: sets up states a task is hard to drive into, such as a voided run or a merge block with no reason.
 *
 * @sideEffects none
 * @param task - The task.
 * @param node - The node whose runs change.
 * @param changes - The fields to set.
 * @returns The task.
 */
export function withRunChanges(task: Task, node: string, changes: Partial<NodeRun>): Task {
  return { ...task, runs: task.runs.map((run) => (run.node === node ? { ...run, ...changes } : run)) };
}
