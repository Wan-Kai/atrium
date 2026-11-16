import { CommandError } from "@atrium/protocol";
import { GIT_SCENE_ENV } from "@atrium/testkit";
import { execFileSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type TaskHost, startTaskHost } from "../../test/task-harness";
import { agent, edges, human } from "./test-support";
import type { NodeRun, Task } from "./types";

vi.setConfig({ testTimeout: 90_000 });

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

/** The scripts of a work node that writes `out.txt`. */
const writing = [
  call("write", "w1", { path: "./out.txt", content: "from the task\n" }),
  call("node_done", "d1", { ok: true, summary: "Wrote out.txt." }),
];

/** Whether anything is at a path. */
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** The closing node's latest run. */
function closing(task: Task): NodeRun {
  const runs = task.runs.filter((run) => run.node === "H");
  const latest = runs.toSorted((a, b) => b.attempt - a.attempt).at(0);
  if (latest === undefined) throw new Error("the closing node has no run");
  return latest;
}

/**
 * Starts a task of one work node and a closing human node, and waits for the human node.
 *
 * @remarks
 * `merge: true` on the human node makes "pass" merge the task's branch.
 *
 * @sideEffects Starts a host.
 * @returns The harness, the task and its worktree.
 */
async function waitingToMerge() {
  const harness = await startTaskHost({ N1: writing });
  const task = await harness.start([agent("N1", "work"), human("H", { merge: true })], edges(["N1", "H"]));
  await harness.until(task.id, (now) => closing(now).state === "waiting");
  return { harness, task, dir: await harness.worktree(task.id) };
}

/** Passes the closing node and waits until it is no longer being merged. */
async function pass(harness: TaskHost, taskId: string): Promise<Task> {
  await harness.host.host.tasks.answerHuman(taskId, "H", { kind: "pass" });
  return harness.until(taskId, (now) => closing(now).merging !== true);
}

describe("merging at the closing human node (SPEC-0006, T5)", () => {
  it("is blocked while the worktree is dirty, the main checkout is dirty, or it is off the trunk, and merges once each is dealt with", async () => {
    const { harness, task, dir } = await waitingToMerge();
    const before = git(harness.repo, "rev-parse", "main");

    await writeFile(join(dir, "loose.txt"), "not committed\n");
    let now = await pass(harness, task.id);
    expect(closing(now)).toMatchObject({
      state: "waiting",
      waitingFor: "merge_blocked",
      blocked: "merge_worktree_dirty",
    });
    await writeFile(join(dir, "loose.txt"), "");
    git(dir, "clean", "-fdq");

    await writeFile(join(harness.repo, "README.md"), "edited by hand\n");
    now = await pass(harness, task.id);
    expect(closing(now)).toMatchObject({ waitingFor: "merge_blocked", blocked: "merge_main_dirty" });
    git(harness.repo, "checkout", "--", "README.md");

    git(harness.repo, "checkout", "--quiet", "-b", "side");
    now = await pass(harness, task.id);
    expect(closing(now)).toMatchObject({ waitingFor: "merge_blocked", blocked: "merge_main_not_trunk" });
    expect(git(harness.repo, "rev-parse", "main")).toBe(before);
    expect(now.endedAt).toBeNull();
    git(harness.repo, "checkout", "--quiet", "main");

    now = await pass(harness, task.id);

    expect(now.endedAt).not.toBeNull();
    expect(closing(now)).toMatchObject({ state: "passed", blocked: null, waitingFor: null });
    expect(git(harness.repo, "show", "main:out.txt")).toBe("from the task");
    expect(git(harness.repo, "log", "-1", "--format=%P", "main").split(" ")).toHaveLength(2);
    expect(git(harness.repo, "status", "--porcelain")).toBe("");
    // Nothing was pushed.
    expect(git(harness.repo, "rev-parse", "origin/main")).toBe(before);
  });

  it("leaves the main checkout exactly as it was on a conflict, names the file, and merges after the conflicting commit is gone", async () => {
    const { harness, task } = await waitingToMerge();
    await writeFile(join(harness.repo, "out.txt"), "from main\n");
    git(harness.repo, "add", "out.txt");
    git(harness.repo, "commit", "--quiet", "-m", "main wrote out.txt too");
    const conflicting = git(harness.repo, "rev-parse", "HEAD");

    const blocked = await pass(harness, task.id);

    expect(closing(blocked)).toMatchObject({
      state: "waiting",
      waitingFor: "merge_blocked",
      blocked: "merge_conflict",
      blockedFiles: ["out.txt"],
    });
    expect(blocked.endedAt).toBeNull();
    expect(git(harness.repo, "rev-parse", "HEAD")).toBe(conflicting);
    expect(git(harness.repo, "status", "--porcelain")).toBe("");
    expect(await exists(join(harness.repo, ".git", "MERGE_HEAD"))).toBe(false);
    const view = await harness.host.host.tasks.view(task.id, new AbortController().signal);
    expect(view.attention).toBe("merge_blocked");
    expect(view.nodes.find((node) => node.id === "H")).toMatchObject({
      blocked: "merge_conflict",
      blockedFiles: ["out.txt"],
    });

    git(harness.repo, "reset", "--quiet", "--hard", "HEAD~1");
    const merged = await pass(harness, task.id);

    expect(closing(merged).state).toBe("passed");
    expect(git(harness.repo, "show", "main:out.txt")).toBe("from the task");
  });

  it("answers merged without merging again when the branch is already in the trunk", async () => {
    const { harness, task, dir } = await waitingToMerge();
    git(harness.repo, "merge", "--no-ff", "--no-edit", "--quiet", git(dir, "symbolic-ref", "--short", "HEAD"));
    const merged = git(harness.repo, "rev-parse", "main");

    const finished = await pass(harness, task.id);

    expect(closing(finished).state).toBe("passed");
    expect(git(harness.repo, "rev-parse", "main")).toBe(merged);
  });

  it("does not run a merge driver the branch's repository configures", async () => {
    const { harness, task, dir } = await waitingToMerge();
    const marker = join(harness.home, "driver-ran");
    const script = join(harness.home, "driver.sh");
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o755 });
    // As a node could plant: a driver in the shared configuration and a file that names it, changed on both sides.
    git(harness.repo, "config", "merge.evil.driver", `${script} %O %A %B`);
    await writeFile(join(dir, ".gitattributes"), "out.txt merge=evil\n");
    git(dir, "add", ".gitattributes");
    git(dir, "commit", "--quiet", "-m", "attributes");
    await writeFile(join(harness.repo, "out.txt"), "from main\n");
    git(harness.repo, "add", "out.txt");
    git(harness.repo, "commit", "--quiet", "-m", "main wrote out.txt too");

    const blocked = await pass(harness, task.id);

    expect(closing(blocked)).toMatchObject({ blocked: "merge_conflict", blockedFiles: ["out.txt"] });
    expect(await exists(marker)).toBe(false);
  });

  it("asks about archiving when the task ends, and keeps or archives the worktree as answered", async () => {
    const { harness, task, dir } = await waitingToMerge();
    const tasks = harness.host.host.tasks;
    const signal = new AbortController().signal;
    expect(harness.task(task.id).archive).toBeUndefined();

    const done = await pass(harness, task.id);

    expect(done.archive).toBe("asked");
    const asked = await tasks.view(task.id, signal);
    expect(asked.archive).toBe("asked");
    expect(asked.archiveFacts).toStrictEqual({
      name: expect.stringMatching(/\S/u),
      merged: true,
      dirty: false,
      commits: 1,
    });
    // Archiving is refused while the worktree has changes, and the question stays open.
    await writeFile(join(dir, "stray.txt"), "x\n");
    await expect(tasks.answerArchive(task.id, "archive")).rejects.toMatchObject({ code: "workspace_dirty" });
    expect(harness.task(task.id).archive).toBe("asked");
    expect((await tasks.view(task.id, signal)).archiveFacts?.dirty).toBe(true);

    await tasks.answerArchive(task.id, "keep");
    expect(harness.task(task.id).archive).toBe("kept");
    expect(await exists(dir)).toBe(true);
    // Keeping again is not a thing; archiving later is.
    await expect(tasks.answerArchive(task.id, "keep")).rejects.toBeInstanceOf(CommandError);
    await writeFile(join(dir, "stray.txt"), "");
    git(dir, "clean", "-fdq");
    await tasks.answerArchive(task.id, "archive");

    expect(harness.task(task.id).archive).toBe("archived");
    expect(await exists(dir)).toBe(false);
    const workspace = harness.host.host.projects.workspaces().find((one) => one.id === done.workspaceId);
    expect(workspace?.archived).toMatchObject({ at: expect.any(Number) });
    expect((await tasks.view(task.id, signal)).archiveFacts).toBeNull();
    await expect(tasks.answerArchive(task.id, "archive")).rejects.toMatchObject({ code: "task_state_invalid" });
  });

  it("asks about archiving a cancelled task whose branch was never merged, and says so", async () => {
    const { harness, task } = await waitingToMerge();
    const tasks = harness.host.host.tasks;

    await tasks.cancel(task.id);

    const view = await tasks.view(task.id, new AbortController().signal);
    expect(view).toMatchObject({ status: "cancelled", archive: "asked" });
    expect(view.archiveFacts).toStrictEqual({
      name: expect.stringMatching(/\S/u),
      merged: false,
      dirty: false,
      commits: 1,
    });
    await tasks.answerArchive(task.id, "archive");
    expect(harness.task(task.id).archive).toBe("archived");
  });

  it("remembers the archive question across a restart, and the answer", async () => {
    const { harness, task } = await waitingToMerge();
    await pass(harness, task.id);
    await harness.restart();
    const reopened = await harness.host.host.tasks.open(task.id);
    expect(reopened.archive).toBe("asked");

    await harness.host.host.tasks.answerArchive(task.id, "keep");
    await harness.restart();

    expect((await harness.host.host.tasks.open(task.id)).archive).toBe("kept");
    const log = await readFile(join(harness.home, "tasks", task.id, "events.jsonl"), "utf8");
    expect(log).toContain('"type":"archive_answered"');
  });
});
