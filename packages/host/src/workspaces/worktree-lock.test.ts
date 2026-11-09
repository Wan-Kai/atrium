import { GIT_SCENE_ENV, createGitScene } from "@atrium/testkit";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { systemClock } from "../platform/clock";
import { createGitRunner } from "../platform/git";
import { ResourceTracker } from "../platform/resources";
import {
  clearStaleLocks,
  homeTagOf,
  lockOf,
  lockOwnerOf,
  lockWorktree,
  lockedTaskOf,
  taskLockReason,
  unlockWorktree,
} from "./worktree-lock";

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

describe("the home in a lock's reason (SPEC-0006, 加锁)", () => {
  it("is 12 hexadecimal digits of the home's path, the same for the same path and different for another", () => {
    expect(homeTagOf("/home/a/.atrium")).toMatch(/^[0-9a-f]{12}$/);
    expect(homeTagOf("/home/a/.atrium")).toBe(homeTagOf("/home/a/.atrium"));
    expect(homeTagOf("/home/a/.atrium")).not.toBe(homeTagOf("/home/b/.atrium"));
  });

  it("is written after the task, and read back with the task; the older reason has no home and still names its task", () => {
    const tag = homeTagOf("/home/a/.atrium");
    expect(taskLockReason("tsk_01", tag)).toBe(`atrium task tsk_01 home ${tag}`);
    expect(lockOwnerOf(`atrium task tsk_01 home ${tag}`)).toStrictEqual({ taskId: "tsk_01", home: tag });
    expect(lockOwnerOf("atrium task tsk_01")).toStrictEqual({ taskId: "tsk_01", home: null });
    expect(lockedTaskOf(`atrium task tsk_01 home ${tag}`)).toBe("tsk_01");
    for (const other of [
      "atrium task tsk_01 home",
      "atrium task tsk_01 home ABCDEF012345",
      "atrium task tsk_01 home 0123456789a",
      "atrium task tsk_01 home 0123456789abc",
      "atrium task tsk_01 home 0123456789ab extra",
      "atrium task tsk_01  home 0123456789ab",
    ]) {
      expect(lockOwnerOf(other)).toBeNull();
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
  const HOME = homeTagOf("/home/a/.atrium");
  const OTHER_HOME = homeTagOf("/home/b/.atrium");

  it("lifts the locks of this home's tasks that are over, and no other", async () => {
    const { scene, repo, one, two, three, real } = await setup();
    await lockWorktree(git, repo, one, "over", HOME);
    await lockWorktree(git, repo, two, "running", HOME);
    await scene.git(repo, "worktree", "lock", "--reason", "mine", three);
    const bare = await real("four");
    await scene.git(repo, "worktree", "lock", bare);

    const lifted = await clearStaleLocks(git, repo, HOME, (taskId) => taskId !== "running");

    expect(lifted).toBe(1);
    expect(await reasonOf(repo, one)).toBeNull();
    expect(await reasonOf(repo, two)).toBe(`atrium task running home ${HOME}`);
    expect(await reasonOf(repo, three)).toBe("mine");
    expect(await reasonOf(repo, bare)).toBe("");
  });

  it("leaves a lock of another home, and the older reason that names no home, though the task is over", async () => {
    const { repo, one, two } = await setup();
    await lockWorktree(git, repo, one, "over", OTHER_HOME);
    await lockWorktree(git, repo, two, "old");

    expect(await clearStaleLocks(git, repo, HOME, () => true)).toBe(0);

    expect(await reasonOf(repo, one)).toBe(`atrium task over home ${OTHER_HOME}`);
    expect(await reasonOf(repo, two)).toBe("atrium task old");
  });

  it("takes the older reason of its own task for a lock it holds, and lifts it with unlock", async () => {
    const { repo, one } = await setup();
    await lockWorktree(git, repo, one, "t1");
    expect(await lockWorktree(git, repo, one, "t1", HOME)).toBe(true);
    expect(await reasonOf(repo, one)).toBe("atrium task t1");
    expect(await unlockWorktree(git, repo, one, "t1", HOME)).toBe(true);
    expect(await reasonOf(repo, one)).toBeNull();
  });

  it("lifts nothing when no lock is a task's", async () => {
    const { repo } = await setup();
    expect(await clearStaleLocks(git, repo, HOME, () => true)).toBe(0);
  });

  it("fails as git does outside a repository", async () => {
    const { scene } = await setup();
    await expect(clearStaleLocks(git, scene.root, HOME, () => true)).rejects.toMatchObject({
      command: "worktree",
      reason: "exit",
    });
  });
});
