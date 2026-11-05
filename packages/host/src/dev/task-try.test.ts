import { createTempDir } from "@atrium/testkit";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { agent, edges, need, newTask } from "../tasks/test-support";
import { Sim } from "../tasks/test-support";
import {
  askFromStream,
  describeArchive,
  describeHumanNode,
  describeProgress,
  modelFor,
  parseArchiveChoice,
  parseHumanChoice,
  parseTaskTryArgs,
  pendingQuestion,
  readGraphFile,
  stopReason,
  taskIdFor,
} from "./task-try";
import { viewOf } from "../tasks/task-view";
import { Readable } from "node:stream";

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

  it("reads the example with a closing human node that merges and a back edge to the work node", async () => {
    const file = await readGraphFile(new URL("../../examples/explore-work-check-merge.json", import.meta.url).pathname);

    expect(file.nodes.map((node) => [node.id, node.kind, node.merge])).toStrictEqual([
      ["N1", "agent", undefined],
      ["N2", "agent", undefined],
      ["N3", "agent", undefined],
      ["N4", "human", true],
    ]);
    expect(file.edges.filter((edge) => edge.kind === "back")).toStrictEqual([{ from: "N4", to: "N2", kind: "back" }]);
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

/** A started task N1 -> H (merging), H -> N1 back, with a worktree, driven until H waits. */
function waitingAtHuman() {
  const run = new Sim(
    newTask(
      [agent("N1", "explore"), { ...agent("H"), kind: "human" as const, merge: true as const }],
      edges(["N1", "H"], ["H", "N1", "back"]),
      { workspaceState: "ready" },
    ),
  );
  run.send({ type: "started" });
  run.send({ type: "node_started", node: "N1", attempt: 1, sessionId: "s", startCommit: null });
  run.send({ type: "node_done_pending", node: "N1", attempt: 1, ok: true, summary: "Looked.\nSecond line." });
  run.send({ type: "node_settled", node: "N1", attempt: 1 });
  return run;
}

describe("answering a human node and the archive question", () => {
  it("reads pass, send-back (with the reason or without) and quit, and not a send-back along an edge there is not", () => {
    const run = waitingAtHuman();
    const node = need(viewOf(run.task, null).nodes.find((one) => one.id === "H"));

    expect(parseHumanChoice("p", node)).toStrictEqual({ kind: "pass" });
    expect(parseHumanChoice(" pass ", node)).toStrictEqual({ kind: "pass" });
    expect(parseHumanChoice("b N1 the test is missing  ", node)).toStrictEqual({
      kind: "back",
      to: "N1",
      reason: "the test is missing",
    });
    expect(parseHumanChoice("back N1", node)).toStrictEqual({ kind: "back", to: "N1", reason: null });
    expect(parseHumanChoice("q", node)).toStrictEqual({ kind: "quit" });
    for (const line of ["", "b", "b N9 why", "b H why", "go"]) {
      expect([line, parseHumanChoice(line, node)]).toStrictEqual([line, { kind: "unknown" }]);
    }
    // Only the first word decides a pass.
    expect(parseHumanChoice("p q", node)).toStrictEqual({ kind: "pass" });
  });

  it("shows the job, what counts as done, what the node before said, the changes and the choices with the back edge's uses", () => {
    const run = waitingAtHuman();
    const view = viewOf(run.task, null);
    const node = need(view.nodes.find((one) => one.id === "H"));

    expect(describeHumanNode(view, node, "2 files changed, 3 insertions(+)")).toStrictEqual([
      "[H] node H (attempt 1) waits for you",
      "  job: do H",
      "  done when: H done",
      "  N1 said: Looked.",
      "  changes: 2 files changed, 3 insertions(+)",
      "  choices: p = pass and merge, b N1 [reason] = send back to N1 (used 0 of 2), q = quit",
    ]);
    expect(describeHumanNode(view, node, null)).toContain("  changes: (none)");
  });

  it("says why a merge is blocked, with the files of a conflict", () => {
    const run = waitingAtHuman();
    run.send({ type: "human_passed", node: "H" });
    run.send({ type: "merge_blocked", node: "H", reason: "merge_conflict", files: ["a.txt", "b.txt"] });
    const view = viewOf(run.task, null);

    expect(describeHumanNode(view, need(view.nodes.find((one) => one.id === "H")), null)).toContain(
      "  the merge is blocked: merge_conflict (a.txt, b.txt); deal with it, then pass again",
    );
    run.send({ type: "human_passed", node: "H" });
    run.send({ type: "merge_blocked", node: "H", reason: "merge_main_dirty" });
    const dirty = viewOf(run.task, null);
    expect(describeHumanNode(dirty, need(dirty.nodes.find((one) => one.id === "H")), null)).toContain(
      "  the merge is blocked: merge_main_dirty; deal with it, then pass again",
    );
  });

  it("asks for a waiting human node, then for the archive once the task ended, and for nothing otherwise", () => {
    const run = waitingAtHuman();
    expect(pendingQuestion(run.task)).toStrictEqual({ kind: "human", node: "H" });
    run.send({ type: "human_passed", node: "H" });
    expect(pendingQuestion(run.task)).toBeNull();
    run.send({ type: "merge_blocked", node: "H", reason: "merge_main_dirty" });
    expect(pendingQuestion(run.task)).toStrictEqual({ kind: "human", node: "H" });
    run.send({ type: "human_passed", node: "H" });
    run.send({ type: "merged", node: "H" });
    expect(pendingQuestion(run.task)).toStrictEqual({ kind: "archive" });
    run.send({ type: "archive_answered", answer: "keep" });
    expect(pendingQuestion(run.task)).toBeNull();
    expect(pendingQuestion(started().task)).toBeNull();
  });

  it("goes on past a human node and an unanswered archive question when it can ask, and stops otherwise", () => {
    const run = waitingAtHuman();
    expect(stopReason(run.task, true)).toBeNull();
    expect(stopReason(run.task)).toMatchObject({ code: 0, line: expect.stringContaining("human node H") });
    run.send({ type: "human_passed", node: "H" });
    run.send({ type: "merge_blocked", node: "H", reason: "merge_main_dirty" });
    expect(stopReason(run.task, true)).toBeNull();
    run.send({ type: "human_passed", node: "H" });
    run.send({ type: "merged", node: "H" });
    expect(run.task.archive).toBe("asked");
    expect(stopReason(run.task, true)).toBeNull();
    expect(stopReason(run.task)).toStrictEqual({ code: 0, line: "the task is done" });
    run.send({ type: "archive_answered", answer: "archive" });
    expect(stopReason(run.task, true)).toStrictEqual({ code: 0, line: "the task is done" });
  });

  it("still stops at a failure or a question when it can ask", () => {
    const run = waitingAtHuman();
    const asking = started();
    asking.send({ type: "node_started", node: "N1", attempt: 1, sessionId: "s", startCommit: null });
    asking.send({ type: "node_waiting", node: "N1", attempt: 1, waitingFor: "question" });
    expect(stopReason(asking.task, true)).toMatchObject({ code: 3 });
    const cancelled = { ...run.task, cancelled: true, archive: "asked" as const };
    expect(stopReason(cancelled, true)).toBeNull();
    expect(stopReason({ ...cancelled, archive: undefined }, true)).toMatchObject({ code: 1 });
  });

  it("reads archive, keep and quit", () => {
    expect([" a", "archive", "k", "keep ", "q", "quit", "", "x"].map(parseArchiveChoice)).toStrictEqual([
      "archive",
      "archive",
      "keep",
      "keep",
      "quit",
      "quit",
      "unknown",
      "unknown",
    ]);
  });

  it("shows the worktree's facts, and warns when it has changes", () => {
    expect(describeArchive({ name: "hello", merged: true, dirty: false, commits: 2 })).toStrictEqual([
      "worktree hello: merged yes, uncommitted changes no, 2 commit(s) since the start",
      "  a = archive, k = keep it, q = quit",
    ]);
    expect(describeArchive({ name: "hello", merged: null, dirty: true, commits: 0 })[0]).toContain(
      "merged unknown, uncommitted changes yes",
    );
    expect(describeArchive({ name: "hello", merged: false, dirty: true, commits: 1 })[1]).toContain("refused while");
    expect(describeArchive(null)).toStrictEqual(["the task's worktree is gone or archived already"]);
  });

  it("answers the questions with the lines it is given, in order, and with null when they are used up or it is interrupted", async () => {
    const written: string[] = [];
    const reader = askFromStream(Readable.from(["p\n", "k\n"]), { write: (text) => written.push(text) });
    const signal = new AbortController().signal;

    expect(await reader.ask("one> ", signal)).toBe("p");
    expect(await reader.ask("two> ", signal)).toBe("k");
    expect(await reader.ask("three> ", signal)).toBeNull();
    reader.close();
    expect(written).toStrictEqual(["one> ", "two> ", "three> "]);

    const idle = askFromStream(new Readable({ read() {} }), { write: () => undefined });
    const stop = new AbortController();
    const waiting = idle.ask("> ", stop.signal);
    stop.abort();
    expect(await waiting).toBeNull();
    expect(await idle.ask("> ", stop.signal)).toBeNull();
    idle.close();
  });
});
