import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stateOf } from "./graph";
import { replayEvents } from "./replay";
import { deriveStatus } from "./status";
import { parseEvents } from "./task-store";
import { need, runOf } from "./test-support";

/** Replays one of the event files `pnpm task:replay` is shown. */
async function replay(name: string) {
  const path = join(import.meta.dirname, "fixtures", name);
  const parsed = parseEvents(await readFile(path, "utf8"), path);
  expect(parsed.droppedTail).toBe(false);
  return replayEvents(parsed.events);
}

describe("the event files shown by pnpm task:replay", () => {
  it("sibling-failed-then-rerun: a failure holds the running sibling, the rerun lets it go on, and the task ends done", async () => {
    const steps = await replay("sibling-failed-then-rerun.jsonl");
    const at = (seq: number) => need(steps[seq - 1]);
    expect(at(8).actions).toContainEqual({ kind: "stop_node", node: "N2", when: "after_turn" });
    expect(deriveStatus(at(8).task)).toBe("stopped");
    expect(stateOf(at(9).task, "N2")).toBe("held");
    expect(at(10).actions.map((a) => a.kind)).toStrictEqual(["resume_node", "resume_node"]);
    expect(stateOf(at(10).task, "N2")).toBe("running");
    expect(deriveStatus(need(steps.at(-1)).task)).toBe("done");
  });

  it("send-back-resets-branches: the side branch is stopped and every node reachable from the target runs again, one attempt up", async () => {
    const steps = await replay("send-back-resets-branches.jsonl");
    const back = need(steps.find((s) => s.event.type === "human_sent_back"));
    expect(back.actions).toContainEqual({ kind: "stop_node", node: "N4", when: "now" });
    expect(back.task.runs.filter((r) => r.attempt === 2).map((r) => r.node)).toStrictEqual([
      "N1",
      "N2",
      "N3",
      "N4",
      "H1",
    ]);
    expect(runOf(back.task, "N1", 2).backFrom).toStrictEqual({
      node: "H1",
      reason: "还漏了错误码",
    });
    const last = need(steps.at(-1)).task;
    expect(deriveStatus(last)).toBe("done");
    expect(stateOf(last, "H1")).toBe("passed");
  });

  it("merge-blocked-then-graph-change: the blocked merge waits for the user, a new node voids the human run, and the task merges at the end", async () => {
    const steps = await replay("merge-blocked-then-graph-change.jsonl");
    const blocked = need(steps.find((s) => s.event.type === "merge_blocked"));
    expect(deriveStatus(blocked.task)).toBe("waiting");
    const approved = need(steps.find((s) => s.event.type === "graph_approved"));
    expect(stateOf(approved.task, "H1")).toBe("pending");
    expect(approved.actions).toContainEqual({ kind: "start_node", node: "N2", attempt: 1 });
    expect(deriveStatus(need(steps.at(-1)).task)).toBe("done");
    expect(steps.filter((s) => s.actions.some((a) => a.kind === "merge"))).toHaveLength(2);
  });
});
