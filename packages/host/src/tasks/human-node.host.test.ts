import { CommandError, TaskView } from "@atrium/protocol";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startTaskHost } from "../../test/task-harness";
import { runAt } from "./graph";
import { edges, human } from "./test-support";
import type { Task } from "./types";

vi.setConfig({ testTimeout: 60_000 });

/** The state and attempt of every node's latest run, as `H1=waiting#2`; a node that never began is `H1=-`. */
function states(task: Task, nodes: readonly string[]): string {
  return nodes
    .map((node) => {
      const latest = task.runs.filter((run) => run.node === node).toSorted((a, b) => b.attempt - a.attempt)[0];
      return `${node}=${latest === undefined ? "-" : `${latest.state}#${String(latest.attempt)}`}`;
    })
    .join(" ");
}

/** What a rejected promise was rejected with. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  return error instanceof CommandError ? error.code : String(error);
}

describe("human nodes (SPEC-0006, T5)", () => {
  // Human nodes need no pi, so a graph of them runs the scheduler, the store and the service for real, fast.
  const ids = ["H1", "H2", "H3", "H4"];
  const graph = () => ({
    nodes: ids.map((id) => human(id)),
    edges: edges(["H1", "H2"], ["H2", "H3"], ["H1", "H4"], ["H3", "H1", "back"]),
  });

  it("resets the side branch and everything downstream when the task is sent back, and refuses the third use of the edge", async () => {
    const harness = await startTaskHost({});
    const tasks = harness.host.host.tasks;
    const { nodes, edges: graphEdges } = graph();
    const task = await harness.start(nodes, graphEdges);
    await tasks.answerHuman(task.id, "H1", { kind: "pass" });
    await harness.until(task.id, (now) => states(now, ids) === "H1=passed#1 H2=waiting#1 H3=- H4=waiting#1");
    await tasks.answerHuman(task.id, "H2", { kind: "pass" });
    await tasks.answerHuman(task.id, "H4", { kind: "pass" });
    await harness.until(task.id, (now) => states(now, ids) === "H1=passed#1 H2=passed#1 H3=waiting#1 H4=passed#1");

    await tasks.answerHuman(task.id, "H3", { kind: "send_back", backTo: "H1", reason: "the second look" });

    // H1 is back to be answered, with why; H2, H3 and the side branch H4 are reset, and no old pass counts.
    const first = await harness.until(
      task.id,
      (now) => states(now, ids) === "H1=waiting#2 H2=pending#2 H3=pending#2 H4=pending#2",
    );
    expect(runAt(first, "H1", 2)?.backFrom).toStrictEqual({
      node: "H3",
      reason: "the second look",
    });
    const view = await tasks.view(task.id, new AbortController().signal);
    expect(TaskView.parse(view).nodes.find((node) => node.id === "H3")).toMatchObject({
      state: "pending",
      sendBack: [{ to: "H1", uses: 1 }],
    });

    /** Answers the four nodes in order until the closing one waits again, for the given attempt. */
    const through = async (attempt: number) => {
      await tasks.answerHuman(task.id, "H1", { kind: "pass" });
      await harness.until(task.id, (now) => states(now, ids).includes(`H2=waiting#${String(attempt)}`));
      await tasks.answerHuman(task.id, "H2", { kind: "pass" });
      await tasks.answerHuman(task.id, "H4", { kind: "pass" });
      await harness.until(task.id, (now) => states(now, ids).includes(`H3=waiting#${String(attempt)}`));
    };
    await through(2);
    await tasks.answerHuman(task.id, "H3", { kind: "send_back", backTo: "H1", reason: "and again" });
    await harness.until(task.id, (now) => states(now, ids).startsWith("H1=waiting#3"));
    await through(3);

    expect(
      await codeOf(tasks.answerHuman(task.id, "H3", { kind: "send_back", backTo: "H1", reason: "a third time" })),
    ).toBe("task_back_limit");
    expect(states(harness.task(task.id), ids)).toBe("H1=passed#3 H2=passed#3 H3=waiting#3 H4=passed#3");
    // Passing is still possible, and ends the task.
    await tasks.answerHuman(task.id, "H3", { kind: "pass" });
    expect((await harness.until(task.id, (now) => now.endedAt !== null)).endedAt).not.toBeNull();
  });

  it("keeps all of it across a restart: the events replay to the same nodes", async () => {
    const harness = await startTaskHost({});
    const { nodes, edges: graphEdges } = graph();
    const task = await harness.start(nodes, graphEdges);
    await harness.host.host.tasks.answerHuman(task.id, "H1", { kind: "pass" });
    await harness.until(task.id, (now) => states(now, ids) === "H1=passed#1 H2=waiting#1 H3=- H4=waiting#1");
    const before = harness.task(task.id);

    await harness.restart();
    const reopened = await harness.host.host.tasks.open(task.id);

    expect(reopened).toStrictEqual(before);
    const log = await readFile(join(harness.home, "tasks", task.id, "events.jsonl"), "utf8");
    expect(log).toContain('"type":"human_passed"');
  });

  it("answers task_not_found for a task that is not there or an id that is not a task's", async () => {
    const harness = await startTaskHost({});
    const tasks = harness.host.host.tasks;

    for (const id of ["tsk_missing", "../escaped", "tsk_a/../../escaped", ""]) {
      expect([id, await codeOf(tasks.answerHuman(id, "H1", { kind: "pass" }))]).toStrictEqual([id, "task_not_found"]);
    }
    // No directory was made for an id that is not a task's.
    expect((await readdir(harness.home)).filter((name) => name.startsWith("escaped"))).toStrictEqual([]);
    expect(await codeOf(tasks.view("tsk_missing", new AbortController().signal))).toBe("task_not_found");
  });

  it("answers task_state_invalid for what the state does not take", async () => {
    const harness = await startTaskHost({});
    const tasks = harness.host.host.tasks;
    const { nodes, edges: graphEdges } = graph();
    const task = await harness.start(nodes, graphEdges);
    const answer = (node: string, to = "H1") =>
      tasks.answerHuman(task.id, node, { kind: "send_back", backTo: to, reason: "r" });

    // H2 has not begun; H1 is waiting but has no edge to H2; a node that is not in the graph.
    expect(await codeOf(tasks.answerHuman(task.id, "H2", { kind: "pass" }))).toBe("task_state_invalid");
    expect(await codeOf(answer("H1", "H2"))).toBe("task_state_invalid");
    expect(await codeOf(tasks.answerHuman(task.id, "H9", { kind: "pass" }))).toBe("task_state_invalid");
    expect(await codeOf(tasks.rerunNode(task.id, "H1"))).toBe("task_state_invalid");
    expect(await codeOf(tasks.continueNode(task.id, "H1"))).toBe("task_state_invalid");
    expect(await codeOf(tasks.resume(task.id))).toBe("task_state_invalid");
    expect(await codeOf(tasks.answerArchive(task.id, "keep"))).toBe("task_state_invalid");
    // Nothing was recorded for any of it.
    expect(harness.task(task.id).runs).toHaveLength(1);
  });

  it("pauses, resumes and cancels, each only when the state allows", async () => {
    const harness = await startTaskHost({});
    const tasks = harness.host.host.tasks;
    const { nodes, edges: graphEdges } = graph();
    const task = await harness.start(nodes, graphEdges);

    await tasks.pause(task.id);
    expect(harness.task(task.id).paused).toBe(true);
    expect(await codeOf(tasks.pause(task.id))).toBe("task_state_invalid");
    await tasks.resume(task.id);
    expect(harness.task(task.id).paused).toBe(false);
    await tasks.cancel(task.id);
    expect(harness.task(task.id)).toMatchObject({ cancelled: true });
    expect(harness.task(task.id).endedAt).not.toBeNull();
    for (const again of [tasks.cancel(task.id), tasks.pause(task.id), tasks.resume(task.id)]) {
      expect(await codeOf(again)).toBe("task_state_invalid");
    }
    expect(await codeOf(tasks.answerHuman(task.id, "H1", { kind: "pass" }))).toBe("task_state_invalid");
  });

  it("lists the tasks on disk, those taken up and those not", async () => {
    const harness = await startTaskHost({});
    const { nodes, edges: graphEdges } = graph();
    const first = await harness.start(nodes, graphEdges);
    const second = await harness.start(nodes, graphEdges);
    await harness.restart();

    const listed = await harness.host.host.tasks.list();

    expect(listed.map((task) => task.id).toSorted()).toStrictEqual([first.id, second.id].toSorted());
  });
});
