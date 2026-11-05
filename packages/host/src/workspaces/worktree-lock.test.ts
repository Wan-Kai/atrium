import { GIT_SCENE_ENV, createGitScene } from "@atrium/testkit";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { systemClock } from "../platform/clock";
import { createGitRunner } from "../platform/git";
import { ResourceTracker } from "../platform/resources";
import { clearStaleLocks, lockOf, lockWorktree, lockedTaskOf, taskLockReason, unlockWorktree } from "./worktree-lock";

vi.setConfig({ testTimeout: 30_000 });

const git = createGitRunner({ env: GIT_SCENE_ENV, clock: systemClock, resources: new ResourceTracker() });

/**
 * A scene with three worktrees.
 *
 * @sideEffects Creates the repositories, removed when the test ends.
 * @returns The scene and its worktrees.
 */
async function setup() {
  const scene = await createGitScene("lock");
  onTestFinished(scene.cleanup);
  // git lists real paths; the temporary folder is reached through a link on macOS.
  const real = async (branch: string) => realpath(await scene.worktree(branch));
  const [one, two, three] = [await real("one"), await real("two"), await real("three")];
  return { scene, repo: scene.repo, one, two, three, real };
}

/**
 * The reason git lists a worktree locked for.
 *
 * @sideEffects Runs git.
 * @param repo - The repository.
 * @param dir - The worktree.
 * @returns The reason, empty without one, or `null` when it is not locked.
 */
const reasonOf = (repo: string, dir: string) => lockOf(git, repo, dir);

describe("taskLockReason and lockedTaskOf", () => {
  it("name the task in the reason git keeps, and read only that form back", () => {
    expect(taskLockReason("tsk_01")).toBe("atrium task tsk_01");
    expect(lockedTaskOf("atrium task tsk_01")).toBe("tsk_01");
    for (const other of [
      null,
      "",
      "my own lock",
      "atrium task ",
      "atrium task a b",
      "atrium task a\nb",
      "Atrium task t",
      "x atrium task t",
    ]) {
      expect(lockedTaskOf(other)).toBeNull();
    }
  });
});

describe("lockWorktree and unlockWorktree", () => {
  it("lock a worktree for a task with git's own lock, and lift it", async () => {
    const { repo, one } = await setup();

    expect(await lockWorktree(git, repo, one, "t1")).toBe(true);
    expect(await reasonOf(repo, one)).toBe("atrium task t1");
    expect(await unlockWorktree(git, repo, one, "t1")).toBe(true);
    expect(await reasonOf(repo, one)).toBeNull();
  });

  it("lock twice for the same task without a change, and unlock what is not locked", async () => {
    const { repo, one } = await setup();

    expect(await lockWorktree(git, repo, one, "t1")).toBe(true);
    expect(await lockWorktree(git, repo, one, "t1")).toBe(true);
    expect(await unlockWorktree(git, repo, one, "t1")).toBe(true);
    expect(await unlockWorktree(git, repo, one, "t1")).toBe(true);
    expect(await reasonOf(repo, one)).toBeNull();
  });

  it("leave a lock of another task or of the user alone", async () => {
    const { scene, repo, one, two } = await setup();
    await scene.git(repo, "worktree", "lock", "--reason", "mine", two);
    await lockWorktree(git, repo, one, "t1");

    expect(await lockWorktree(git, repo, one, "t2")).toBe(false);
    expect(await unlockWorktree(git, repo, one, "t2")).toBe(false);
    expect(await lockWorktree(git, repo, two, "t1")).toBe(false);
    expect(await unlockWorktree(git, repo, two, "t1")).toBe(false);

    expect(await reasonOf(repo, one)).toBe("atrium task t1");
    expect(await reasonOf(repo, two)).toBe("mine");
  });

  it("say not locked for a directory git does not list", async () => {
    const { repo, scene } = await setup();
    expect(await lockOf(git, repo, join(scene.root, "nowhere"))).toBeNull();
  });

  it("fail as git does outside a repository", async () => {
    const { scene } = await setup();
    await expect(lockWorktree(git, scene.root, scene.root, "t1")).rejects.toMatchObject({ reason: "exit" });
  });
});

describe("clearStaleLocks", () => {
  it("lifts the locks of tasks that are over, and no other", async () => {
    const { scene, repo, one, two, three, real } = await setup();
    await lockWorktree(git, repo, one, "over");
    await lockWorktree(git, repo, two, "running");
    await scene.git(repo, "worktree", "lock", "--reason", "mine", three);
    const bare = await real("four");
    await scene.git(repo, "worktree", "lock", bare);

    const lifted = await clearStaleLocks(git, repo, (taskId) => taskId === "running");

    expect(lifted).toBe(1);
    expect(await reasonOf(repo, one)).toBeNull();
    expect(await reasonOf(repo, two)).toBe("atrium task running");
    expect(await reasonOf(repo, three)).toBe("mine");
    expect(await reasonOf(repo, bare)).toBe("");
  });

  it("lifts nothing when no lock is a task's", async () => {
    const { repo } = await setup();
    expect(await clearStaleLocks(git, repo, () => false)).toBe(0);
  });

  it("fails as git does outside a repository", async () => {
    const { scene } = await setup();
    await expect(clearStaleLocks(git, scene.root, () => false)).rejects.toMatchObject({
      command: "worktree",
      reason: "exit",
    });
  });
});
