import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GIT_SCENE_ENV, present } from "@atrium/testkit";
import { startTaskHost } from "../../test/task-harness";
import { agent, edges, human, need } from "./test-support";
import type { Task } from "./types";

/**
 * Runs git in a directory and returns what it printed.
 *
 * @remarks
 * The scene's environment, so the machine's own git configuration does not matter.
 *
 * @sideEffects Runs git.
 * @param cwd - The directory.
 * @param args - git's arguments.
 * @returns Its output, trimmed.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_SCENE_ENV, encoding: "utf8" }).trim();
}

/** A reply that calls a tool. */
const call = (name: string, id: string, args: Record<string, unknown>) => ({
  blocks: [{ type: "toolCall" as const, id, name, arguments: args as Record<string, never> }],
});

/** A reply that only talks. */
const say = (text: string) => ({ blocks: [{ type: "text" as const, text }] });

/** `node_done` with a summary. */
const done = (id: string, summary: string) => call("node_done", id, { ok: true, summary });

/**
 * The messages of the model conversations whose text holds some words.
 *
 * @remarks
 * Every request the faux model got is a context; the node's contract is in the first message of its own.
 *
 * @sideEffects none
 * @param contexts - What the model was asked.
 * @param words - The words.
 * @returns The texts of the messages.
 */
function mentioning(contexts: readonly { readonly messages: readonly unknown[] }[], words: string): string[] {
  return contexts.map((context) => JSON.stringify(context.messages)).filter((text) => text.includes(words));
}

/**
 * Whether the first node has come to an end of its step: passed, failed or held.
 *
 * @sideEffects none
 * @param task - The task.
 * @returns Whether it has.
 */
function over(task: Task): boolean {
  return ["passed", "failed", "held"].includes(task.runs[0]?.state ?? "");
}

/**
 * The node's run, by node and attempt.
 *
 * @sideEffects none
 * @param task - The task.
 * @param node - The node.
 * @param attempt - The attempt.
 * @returns The run.
 */
function runOf(task: Task, node: string, attempt = 1) {
  return need(task.runs.find((run) => run.node === node && run.attempt === attempt));
}

describe("T4 review fixes: what a node is told (SPEC-0006, 第一条消息：契约)", () => {
  it("tells the first work node the worktree is new, though an explore node ran there before it", async () => {
    const harness = await startTaskHost({
      N1: [done("d1", "explored")],
      N2: [call("write", "w1", { path: "./a.txt", content: "a" }), done("d2", "wrote")],
    });
    const task = await harness.start([agent("N1", "explore"), agent("N2", "work")], edges(["N1", "N2"]));
    await harness.until(task.id, (now) => now.endedAt !== null);

    const contexts = await harness.contexts();
    expect(mentioning(contexts, "节点 N2 ·")[0]).toContain("这是新建的 worktree");
    expect(mentioning(contexts, "节点 N1 ·")[0]).not.toContain("这是新建的 worktree");
  });

  it("does not tell a work node's second attempt that the worktree is new", async () => {
    const harness = await startTaskHost({
      N1: [call("write", "w1", { path: "./a.txt", content: "a" }), done("d1", "wrote v1")],
    });
    const task = await harness.start([agent("N1", "work"), human("H")], edges(["N1", "H"], ["H", "N1", "back"]));
    await harness.until(task.id, (now) => now.runs.find((run) => run.node === "H")?.state === "waiting");

    await harness.send(task.id, { type: "human_sent_back", node: "H", to: "N1", reason: "again please" });
    await vi.waitFor(async () =>
      expect(mentioning(await harness.contexts(), "上次被打回的原因").length).toBeGreaterThan(0),
    );

    const contexts = await harness.contexts();
    // The first attempt's requests have the line; none of the second attempt's, which has the reason, does.
    expect(mentioning(contexts, "这是新建的 worktree").length).toBeGreaterThan(0);
    for (const text of mentioning(contexts, "上次被打回的原因")) expect(text).not.toContain("这是新建的 worktree");
    for (const text of mentioning(contexts, "这是新建的 worktree")) expect(text).not.toContain("上次被打回的原因");
  });

  it("sends the contract, not a line about carrying on, to a node whose contract never reached pi's file", async () => {
    const harness = await startTaskHost({ N1: [done("d1", "told by the contract")] });
    const task = await harness.start([agent("N1", "explore")], []);
    await harness.until(task.id, (now) => now.endedAt !== null);
    const file = await harness.filePath(present(runOf(harness.task(task.id), "N1").sessionId, "the node's session"));

    // The host went down after `node_started`, and pi before it wrote the contract: the log ends there and the
    // session's file has only its header, as if the contract never went.
    await harness.restart(async () => {
      const path = join(harness.home, "tasks", task.id, "events.jsonl");
      const lines = (await readFile(path, "utf8")).split("\n").filter((line) => line !== "");
      const at = lines.findIndex((line) => line.includes('"type":"contract_sent"'));
      expect(at).toBeGreaterThan(0);
      await writeFile(path, `${lines.slice(0, at).join("\n")}\n`);
      const header = present((await readFile(file, "utf8")).split("\n")[0], "the header");
      await writeFile(file, `${header}\n`);
    });
    const finished = await harness.until(task.id, (now) => now.endedAt !== null);

    expect(runOf(finished, "N1")).toMatchObject({ state: "passed", summary: "told by the contract" });
    expect(runOf(finished, "N1").contractSent).toBe(true);
    // The model was asked twice, and the second time it began with the contract again: the file had lost it.
    const asked = (await harness.contexts()).map((context) => JSON.stringify(context.messages));
    expect(asked).toHaveLength(2);
    const last = present(asked.at(-1), "the last request");
    expect(last.match(/<atrium-task-node>\\n你在任务/gu)).toHaveLength(1);
    expect(last).not.toContain("宿主重启了");
  });
});

describe("T4 review fixes: calls, turns and stops", () => {
  it("lets a node the user stopped go on when the user writes to it, and takes its node_done", async () => {
    const harness = await startTaskHost({
      N1: [
        { waitFor: "stay", blocks: [{ type: "text", text: "working" }] },
        say("noted"),
        done("d1", "done after the stop"),
      ],
    });
    const task = await harness.start([agent("N1", "explore")], []);
    const running = await harness.until(task.id, (now) => now.runs[0]?.sessionId != null);
    const sessionId = present(running.runs[0]?.sessionId, "the session");
    await vi.waitFor(async () => expect(await harness.contexts()).toHaveLength(1));

    await harness.client.stop(sessionId);
    await harness.until(task.id, (now) => now.runs[0]?.state === "stopped");
    await harness.client.prompt(sessionId, "please go on");
    await vi.waitFor(() => expect(harness.task(task.id).runs[0]?.state).not.toBe("stopped"));

    const finished = await harness.until(task.id, over);
    expect(runOf(finished, "N1")).toMatchObject({ state: "passed", summary: "done after the stop" });
  });

  it("does not pass a node on a node_done that a graph-change request in the same batch replaced", async () => {
    const harness = await startTaskHost({
      N1: [
        {
          blocks: [
            ...done("d1", "STALE summary").blocks,
            ...call("request_graph_change", "g1", { reason: "A step is missing.", suggestion: "Add one." }).blocks,
          ],
        },
        say("I looked at it again."),
        done("d2", "FRESH summary"),
      ],
    });
    const task = await harness.start([agent("N1", "explore")], []);
    await harness.until(task.id, (now) => now.runs[0]?.waitingFor === "graph_change");
    expect(harness.task(task.id).runs[0]?.pendingDone).toBeNull();

    await harness.send(task.id, {
      type: "graph_proposed",
      author: "agent",
      note: "",
      nodes: [agent("N1", "explore")],
      edges: [],
    });
    await harness.send(task.id, { type: "graph_rejected" });
    const finished = await harness.until(task.id, (now) => now.endedAt !== null);

    expect(runOf(finished, "N1")).toMatchObject({ state: "passed", summary: "FRESH summary", nudged: true });
  });

  it("passes a node whose node_done stands when a pause asks it to hold during the same turn", async () => {
    const harness = await startTaskHost({
      N1: [{ waitFor: "go", blocks: done("d1", "Done during the pause.").blocks }],
      N2: [done("d2", "unused")],
    });
    const task = await harness.start([agent("N1", "explore"), agent("N2", "explore")], edges(["N1", "N2"]));
    await harness.until(task.id, (now) => now.runs[0]?.sessionId != null);
    await vi.waitFor(async () => expect(await harness.contexts()).toHaveLength(1));

    await harness.send(task.id, { type: "paused" });
    await harness.release("go");
    const passed = await harness.until(task.id, over);

    expect(runOf(passed, "N1")).toMatchObject({ state: "passed", summary: "Done during the pause." });
  });

  it("tells a node its pi was restarted after a crash in the middle of its turn, and the node goes on", async () => {
    const harness = await startTaskHost({
      N1: [
        { waitFor: "stay", blocks: [{ type: "text", text: "thinking" }] },
        done("d1", "Finished after the restart."),
      ],
    });
    harness.host.expectLog({ level: "warn", msg: "pi exited" });
    const task = await harness.start([agent("N1", "explore")], []);
    await harness.until(task.id, (now) => now.runs[0]?.sessionId != null);
    await vi.waitFor(async () => expect(await harness.contexts()).toHaveLength(1));

    process.kill(await harness.pid(), "SIGKILL");
    await harness.release("stay");
    const finished = await harness.until(task.id, (now) => now.endedAt !== null);

    expect(runOf(finished, "N1")).toMatchObject({ state: "passed", summary: "Finished after the restart." });
    expect(JSON.stringify((await harness.contexts()).at(-1)?.messages)).toContain("宿主重启了");
  });
});

describe("T4 review fixes: a commit that fails (SPEC-0006, 失败)", () => {
  it("fails the node with `commit`, starts nothing after it, and finishes the same attempt when it is rerun", async () => {
    const harness = await startTaskHost({
      N1: [
        call("write", "w1", { path: "./out.txt", content: "hello\n" }),
        call("bash", "b1", { command: 'touch "$(git rev-parse --git-path index.lock)"' }),
        done("d1", "Wrote out.txt."),
      ],
      N2: [done("d2", "checked")],
    });
    harness.host.expectLog({ level: "error", msg: "task node commit failed", times: 1 });
    const task = await harness.start([agent("N1", "work"), agent("N2", "check")], edges(["N1", "N2"]));

    const failed = await harness.until(task.id, (now) => now.runs[0]?.state === "failed");
    expect(runOf(failed, "N1")).toMatchObject({ failure: "commit", commit: null, attempt: 1, commitPending: true });
    expect(failed.runs.some((run) => run.node === "N2")).toBe(false);
    expect(failed.endedAt).toBeNull();
    const dir = await harness.worktree(task.id);
    await rm(join(git(dir, "rev-parse", "--absolute-git-dir"), "index.lock"));
    await harness.send(task.id, { type: "rerun_requested", node: "N1" });
    const finished = await harness.until(task.id, (now) => now.endedAt !== null);

    expect(finished.runs.map((run) => [run.node, run.state, run.attempt])).toStrictEqual([
      ["N1", "passed", 1],
      ["N2", "passed", 1],
    ]);
    expect(runOf(finished, "N1").commit).toBe(git(dir, "rev-parse", "HEAD"));
    expect(git(dir, "log", "-1", "--format=%(trailers:key=Atrium-Task,valueonly)")).toBe(`${task.id}/N1/1`);
    expect(git(dir, "show", "HEAD:out.txt")).toBe("hello");
  });
});
