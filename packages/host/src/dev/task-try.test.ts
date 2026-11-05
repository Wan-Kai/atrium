import { createTempDir } from "@atrium/testkit";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { agent, edges, need, newTask } from "../tasks/test-support";
import { Sim } from "../tasks/test-support";
import { describeProgress, modelFor, parseTaskTryArgs, readGraphFile, stopReason, taskIdFor } from "./task-try";

describe("parseTaskTryArgs", () => {
  it("reads the graph file, the repository, the model and the home, relative to where it was typed", () => {
    expect(
      parseTaskTryArgs(["g.json", "--repo", "../r", "--model", "p/m:high", "--home", "h"], "/work/dir"),
    ).toStrictEqual({ graphFile: "/work/dir/g.json", repo: "/work/r", model: "p/m:high", home: "/work/dir/h" });
  });

  it("defaults to the current directory, no model and a home beside the repository", () => {
    expect(parseTaskTryArgs(["/g.json"], "/work/repo")).toStrictEqual({
      graphFile: "/g.json",
      repo: "/work/repo",
      model: null,
      home: "/work/repo.task-try",
    });
  });

  it.each([[[]], [["a", "b"]], [["a", "--nope"]], [["a", "--repo"]], [["a", "--model"]], [["a", "--home"]]])(
    "refuses %j with the usage",
    (argv) => {
      expect(parseTaskTryArgs(argv, "/w")).toStrictEqual({ error: expect.stringContaining("usage: pnpm task:try") });
    },
  );
});

describe("taskIdFor", () => {
  it("is the same for the same graph and repository, and differs otherwise", () => {
    expect(taskIdFor("/g", "/r")).toBe(taskIdFor("/g", "/r"));
    expect(taskIdFor("/g", "/r")).not.toBe(taskIdFor("/g", "/r2"));
    expect(taskIdFor("/g", "/r")).not.toBe(taskIdFor("/g2", "/r"));
    expect(taskIdFor("/g", "/r")).toMatch(/^tsk_try_[0-9a-f]{10}$/u);
  });
});

/**
 * Writes a graph file in a temporary directory.
 *
 * @remarks
 * Removed when the test finishes.
 *
 * @sideEffects Creates and writes a file.
 * @param content - The file's content.
 * @returns Its path.
 */
async function graphFile(content: unknown): Promise<string> {
  const dir = await createTempDir("task-try-graph");
  onTestFinished(dir.cleanup);
  await mkdir(dir.path, { recursive: true });
  const path = join(dir.path, "graph.json");
  await writeFile(path, JSON.stringify(content));
  return path;
}

describe("readGraphFile", () => {
  it("reads the example graph the repository ships", async () => {
    const file = await readGraphFile(new URL("../../examples/explore-work-check.json", import.meta.url).pathname);

    expect(file.nodes.map((node) => [node.id, node.role])).toStrictEqual([
      ["N1", "explore"],
      ["N2", "work"],
      ["N3", "check"],
    ]);
  });

  it("refuses a graph that breaks a rule, naming the first problem's code", async () => {
    const path = await graphFile({
      name: "x",
      goal: "y",
      nodes: [{ id: "N1", name: "a", kind: "agent", role: "work", job: "j", done: ["d"] }],
      edges: [{ from: "N1", to: "N9", kind: "seq" }],
    });

    await expect(readGraphFile(path)).rejects.toThrow(/the graph is not valid: unknown_node/u);
  });

  it("refuses a file that is not a graph file", async () => {
    await expect(readGraphFile(await graphFile({ nodes: [] }))).rejects.toThrow(/./u);
  });
});

describe("modelFor", () => {
  it("reads provider/model and a thinking level, off by default", async () => {
    expect(await modelFor("anthropic/claude-x", {})).toStrictEqual({
      providerId: "anthropic",
      modelId: "claude-x",
      thinking: "off",
    });
    expect(await modelFor("p/a/b:high", {})).toStrictEqual({ providerId: "p", modelId: "a/b", thinking: "high" });
  });

  it.each(["nomodel", "/x", "p/"])("refuses %j", async (flag) => {
    await expect(modelFor(flag, {})).rejects.toThrow(/provider\/model/u);
  });

  it("takes pi's default from its settings when no model is given", async () => {
    const dir = await createTempDir("task-try-pi");
    onTestFinished(dir.cleanup);
    await writeFile(
      join(dir.path, "settings.json"),
      JSON.stringify({ defaultProvider: "p", defaultModel: "m", defaultThinkingLevel: "low" }),
    );

    expect(await modelFor(null, { PI_CODING_AGENT_DIR: dir.path })).toStrictEqual({
      providerId: "p",
      modelId: "m",
      thinking: "low",
    });
    await expect(modelFor(null, { PI_CODING_AGENT_DIR: join(dir.path, "none") })).rejects.toThrow(/--model/u);
  });
});

/**
 * A started task with N1 -> H, to drive to the point a test wants.
 *
 * @remarks
 * H is a human node.
 *
 * @sideEffects none
 * @returns The simulator.
 */
function started() {
  const run = new Sim(newTask([agent("N1", "explore"), { ...agent("H"), kind: "human" as const }], edges(["N1", "H"])));
  run.send({ type: "started" });
  return run;
}

describe("what it prints and when it stops", () => {
  it("shows a settled node's summary and a commit, one line each at least", () => {
    const run = started();
    run.send({ type: "node_started", node: "N1", attempt: 1, sessionId: "s", startCommit: null });
    run.send({ type: "node_done_pending", node: "N1", attempt: 1, ok: true, summary: "line one\nline two" });
    run.send({ type: "node_settled", node: "N1", attempt: 1 });
    const settled = need(run.log.at(-1)).event;

    expect(describeProgress(run.task, settled)).toStrictEqual([
      expect.stringContaining("node_settled node=N1 attempt=1"),
      "    | line one",
      "    | line two",
    ]);
    expect(
      describeProgress(run.task, { seq: 9, at: 0, type: "committed", node: "N1", attempt: 1, commit: "abc" }),
    ).toContain("    commit abc");
  });

  it("stops at a human node, a failure, a question, a graph change, the end", () => {
    const run = started();
    expect(stopReason(run.task)).toBeNull();
    run.send({ type: "node_started", node: "N1", attempt: 1, sessionId: "s", startCommit: null });
    run.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "question" });
    expect(stopReason(run.task)).toMatchObject({ code: 3, line: expect.stringContaining("asked a question") });
    run.send({ type: "node_resumed", node: "N1", attempt: 1 });
    run.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "graph_change" });
    expect(stopReason(run.task)).toMatchObject({ code: 3, line: expect.stringContaining("graph") });
    run.send({ type: "node_failed", node: "N1", attempt: 1, reason: "no_done" });
    expect(stopReason(run.task)).toMatchObject({ code: 1, line: "N1 failed: no_done" });

    const next = started();
    next.send({ type: "node_started", node: "N1", attempt: 1, sessionId: "s", startCommit: null });
    next.send({ type: "node_done_pending", node: "N1", attempt: 1, ok: true, summary: "s" });
    next.send({ type: "node_settled", node: "N1", attempt: 1 });
    expect(stopReason(next.task)).toMatchObject({ code: 0, line: expect.stringContaining("human node H") });
    next.send({ type: "human_passed", node: "H" });
    expect(stopReason(next.task)).toStrictEqual({ code: 0, line: "the task is done" });
    expect(stopReason({ ...next.task, cancelled: true })).toMatchObject({ code: 1 });
  });
});
