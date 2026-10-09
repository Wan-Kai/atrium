import { GIT_SCENE_ENV, type GitScene, createGitScene } from "@atrium/testkit";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { systemClock } from "../platform/clock";
import { type GitRunner, createGitRunner } from "../platform/git";
import { ResourceTracker } from "../platform/resources";
import { type MergeTarget, createMergeInspector, parseGitVersion } from "./merge-inspector";

// Each test builds real repositories and runs dozens of git commands; next to the other test
// files running at once, that takes well over the default 5 seconds.
vi.setConfig({ testTimeout: 30_000 });

const MAIN = "refs/remotes/origin/main";

/**
 * A repository with a remote for one test.
 *
 * @remarks
 * Real git, built by the testkit.
 *
 * @sideEffects Creates the repositories, removed when the test ends.
 * @returns The scene.
 */
async function scene(): Promise<GitScene> {
  const built = await createGitScene("merge");
  onTestFinished(built.cleanup);
  return built;
}

/** Runs git with the scenes' environment, counting commands so tests can see what was cached. */
function countingGit(): GitRunner & { readonly commands: string[] } {
  const git = createGitRunner({ env: GIT_SCENE_ENV, clock: systemClock, resources: new ResourceTracker() });
  const commands: string[] = [];
  return {
    commands,
    run(args, options) {
      commands.push(args[0] ?? "");
      return git.run(args, options);
    },
  };
}

/**
 * Describes a worktree as the workspace scan would.
 *
 * @remarks
 * Its commit and branch are read from git; the rest defaults to an external worktree.
 *
 * @sideEffects Runs git.
 * @param repo - The scene.
 * @param dir - The worktree.
 * @param overrides - Fields to change.
 * @returns The target.
 */
async function target(repo: GitScene, dir: string, overrides: Partial<MergeTarget> = {}): Promise<MergeTarget> {
  return {
    repo: repo.repo,
    dir,
    present: true,
    // Detached, git prints no branch.
    branch: (await repo.git(dir, "branch", "--show-current")) || null,
    head: await repo.git(dir, "rev-parse", "HEAD"),
    baseCommit: null,
    mainRef: MAIN,
    ...overrides,
  };
}

/**
 * Pushes the clone's `main` so `origin/main` follows.
 *
 * @remarks
 * Merges happen in the clone and reach the main branch's remote ref by pushing.
 *
 * @sideEffects Pushes.
 * @param repo - The scene.
 */
async function pushMain(repo: GitScene): Promise<void> {
  await repo.git(repo.repo, "push", "--quiet", "origin", "main");
}

/**
 * Real git whose first run of one command fails, as git does when a lock is held.
 *
 * @remarks
 * For telling a failure that passes from a verdict.
 *
 * @sideEffects none until it runs git.
 * @param fails - Whether a command's arguments are those of the command that fails once.
 * @returns The runner.
 */
function failingOnce(fails: (args: readonly string[]) => boolean): GitRunner {
  const real = countingGit();
  let failed = false;
  return {
    run: (args, options) => {
      if (!fails(args) || failed) return real.run(args, options);
      failed = true;
      return Promise.resolve({ code: 128, stdout: "" });
    },
  };
}

const inspector = () => createMergeInspector({ git: countingGit(), version: [2, 50] });

describe("MergeInspector.inspect", () => {
  it("calls a worktree whose directory is gone removed", async () => {
    const repo = await scene();
    const dir = await repo.worktree("gone");

    expect(await inspector().inspect(await target(repo, dir, { present: false }))).toStrictEqual({
      dirty: false,
      ahead: 0,
      verdict: "removed",
      reason: null,
    });
  });

  it("calls a worktree Atrium created and nobody committed in unchanged, and dirty once a file appears", async () => {
    const repo = await scene();
    const dir = await repo.worktree("fresh");
    const fresh = await target(repo, dir);
    const created = { ...fresh, baseCommit: fresh.head };
    const inspect = inspector();

    expect(await inspect.inspect(created)).toStrictEqual({ dirty: false, ahead: 0, verdict: "noChange", reason: null });
    await writeFile(join(dir, "new.txt"), "untracked");
    expect(await inspect.inspect(created)).toStrictEqual({ dirty: true, ahead: 0, verdict: "noChange", reason: null });
  });

  it("counts the commits a branch has that the main branch lacks as pending", async () => {
    const repo = await scene();
    const dir = await repo.worktree("work");
    const base = await repo.git(dir, "rev-parse", "HEAD");
    await repo.commit(dir, "a.txt", "a");
    await repo.commit(dir, "b.txt", "b");

    expect(await inspector().inspect(await target(repo, dir, { baseCommit: base }))).toStrictEqual({
      dirty: false,
      ahead: 2,
      verdict: "pending",
      reason: null,
    });
  });

  it.each([
    ["a merge commit", ["merge", "--quiet", "--no-ff", "-m", "merge work", "work"]],
    ["a fast-forward", ["merge", "--quiet", "--ff-only", "work"]],
  ])("calls a branch merged by %s merged", async (_case, merge) => {
    const repo = await scene();
    const dir = await repo.worktree("work");
    const base = await repo.git(dir, "rev-parse", "HEAD");
    await repo.commit(dir, "a.txt", "a");
    await repo.git(repo.repo, ...merge);
    await pushMain(repo);

    expect(await inspector().inspect(await target(repo, dir, { baseCommit: base }))).toStrictEqual({
      dirty: false,
      ahead: 0,
      verdict: "merged",
      reason: null,
    });
  });

  it("calls a squashed branch merged, even after the main branch moved on elsewhere", async () => {
    const repo = await scene();
    const dir = await repo.worktree("work");
    await repo.commit(dir, "a.txt", "a");
    await repo.commit(dir, "b.txt", "b");
    await repo.git(repo.repo, "merge", "--quiet", "--squash", "work");
    await repo.git(repo.repo, "commit", "--quiet", "-m", "squashed");
    await repo.commit(repo.repo, "other.txt", "elsewhere");
    await pushMain(repo);

    expect(await inspector().inspect(await target(repo, dir))).toStrictEqual({
      dirty: false,
      ahead: 2,
      verdict: "merged",
      reason: null,
    });
  });

  it("calls a branch whose commit was cherry-picked (as rebase merging does) merged", async () => {
    const repo = await scene();
    const dir = await repo.worktree("work");
    const picked = await repo.commit(dir, "a.txt", "a");
    await repo.commit(repo.repo, "other.txt", "first on main");
    await repo.git(repo.repo, "cherry-pick", picked);
    await pushMain(repo);

    expect(await inspector().inspect(await target(repo, dir))).toMatchObject({ verdict: "merged", ahead: 1 });
  });

  it("calls a branch pending again once the main branch reverted its change", async () => {
    const repo = await scene();
    const dir = await repo.worktree("work");
    await repo.commit(dir, "a.txt", "a");
    await repo.git(repo.repo, "merge", "--quiet", "--squash", "work");
    await repo.git(repo.repo, "commit", "--quiet", "-m", "squashed");
    await repo.git(repo.repo, "revert", "--no-edit", "HEAD");
    await pushMain(repo);

    expect(await inspector().inspect(await target(repo, dir))).toMatchObject({ verdict: "pending", ahead: 1 });
  });

  it("calls a branch that conflicts with the main branch pending", async () => {
    const repo = await scene();
    const dir = await repo.worktree("work");
    await repo.commit(dir, "README.md", "from the branch\n");
    await repo.commit(repo.repo, "README.md", "from main\n");
    await pushMain(repo);

    expect(await inspector().inspect(await target(repo, dir))).toMatchObject({ verdict: "pending", ahead: 1 });
  });

  it("calls an external worktree that never committed unchanged, by its branch's reflog", async () => {
    const repo = await scene();
    const dir = await repo.worktree("external");

    expect(await inspector().inspect(await target(repo, dir))).toStrictEqual({
      dirty: false,
      ahead: 0,
      verdict: "noChange",
      reason: null,
    });
  });

  it.each([
    ["committed", ["commit", "--quiet", "--allow-empty", "-m", "again"]],
    ["amended a commit", ["commit", "--quiet", "--amend", "-m", "amended"]],
  ])("calls an external worktree that %s and was merged by fast-forward merged", async (_case, change) => {
    const repo = await scene();
    const dir = await repo.worktree("external");
    await repo.commit(dir, "a.txt", "a");
    await repo.git(dir, ...change);
    await repo.git(repo.repo, "merge", "--quiet", "--ff-only", "external");
    await pushMain(repo);

    expect(await inspector().inspect(await target(repo, dir))).toMatchObject({ verdict: "merged", reason: null });
  });

  it("calls an external worktree that applied a patch with git am and was merged by fast-forward merged", async () => {
    const repo = await scene();
    const topic = await repo.worktree("topic");
    await repo.commit(topic, "a.txt", "a");
    const patch = join(repo.repo, "..", "a.patch");
    await writeFile(patch, await repo.git(topic, "format-patch", "-1", "--stdout"));
    const dir = await repo.worktree("external");
    await repo.git(dir, "am", "--quiet", patch);
    await repo.git(repo.repo, "merge", "--quiet", "--ff-only", "external");
    await pushMain(repo);

    expect(await inspector().inspect(await target(repo, dir))).toMatchObject({ verdict: "merged", reason: null });
  });

  it.each([
    [
      "git pull with options from a named branch",
      ["pull", "--quiet", "--no-rebase", "--no-ff", "--no-edit", ".", "topic"],
    ],
    // Options would follow `pull` in the reflog; set through config, the entry reads `pull: …`.
    ["a bare git pull from its upstream", ["-c", "pull.rebase=false", "-c", "merge.ff=false", "pull"]],
  ])("calls an external worktree where %s made a merge commit, merged by fast-forward, merged", async (_case, pull) => {
    const repo = await scene();
    const topic = await repo.worktree("topic");
    await repo.commit(topic, "a.txt", "a");
    const dir = await repo.worktree("external");
    await repo.git(dir, "branch", "--quiet", "--set-upstream-to", "topic");
    await repo.git(dir, ...pull);
    await repo.git(repo.repo, "merge", "--quiet", "--ff-only", "external");
    await pushMain(repo);

    expect(await inspector().inspect(await target(repo, dir))).toMatchObject({ verdict: "merged", reason: null });
  });

  it("calls an external worktree unchanged after only fast-forwarding to the main branch", async () => {
    const repo = await scene();
    const dir = await repo.worktree("external");
    await repo.commit(repo.repo, "other.txt", "on main");
    await pushMain(repo);
    await repo.git(dir, "merge", "--quiet", "--ff-only", "main");

    expect(await inspector().inspect(await target(repo, dir))).toMatchObject({ verdict: "noChange" });
  });

  it("calls an external worktree that made a merge commit itself and was merged by fast-forward merged", async () => {
    const repo = await scene();
    const topic = await repo.worktree("topic");
    await repo.commit(topic, "a.txt", "a");
    const dir = await repo.worktree("external");
    await repo.git(dir, "merge", "--quiet", "--no-ff", "--no-edit", "topic");
    await repo.git(repo.repo, "merge", "--quiet", "--ff-only", "external");
    await pushMain(repo);

    expect(await inspector().inspect(await target(repo, dir))).toStrictEqual({
      dirty: false,
      ahead: 0,
      verdict: "merged",
      reason: null,
    });
  });

  it.each([
    ["a branch whose name starts like a revert", "revert-typo"],
    ["a commit found by a message that reads like a merge", ":/merge topic: Merge made by"],
  ])("calls an external worktree started from %s, with nothing committed since, unchanged", async (_case, from) => {
    const repo = await scene();
    await repo.commit(repo.repo, "other.txt", "on main", "merge topic: Merge made by hand");
    await pushMain(repo);
    await repo.git(repo.repo, "branch", "revert-typo");
    // The branch's only reflog entry, `branch: Created from <from>`, mentions a commit or a merge.
    const dir = await repo.worktree("external", from);

    expect(await inspector().inspect(await target(repo, dir))).toStrictEqual({
      dirty: false,
      ahead: 0,
      verdict: "noChange",
      reason: null,
    });
  });

  it("does not ask git for a main branch it was not given", async () => {
    const repo = await scene();
    const dir = await repo.worktree("work");
    const git = countingGit();

    const inspected = await createMergeInspector({ git, version: [2, 50] }).inspect(
      await target(repo, dir, { mainRef: null }),
    );

    expect(inspected).toStrictEqual({ dirty: false, ahead: 0, verdict: "unknown", reason: "no_main_branch" });
    expect(git.commands).toStrictEqual(["status"]);
  });

  it("cannot tell where an external worktree started without a branch or a reflog", async () => {
    const repo = await scene();
    const detached = await repo.worktree("detached");
    await repo.git(detached, "checkout", "--quiet", "--detach");
    const expired = await repo.worktree("expired");
    await repo.git(repo.repo, "reflog", "expire", "--expire=now", "--all");

    for (const dir of [detached, expired]) {
      expect(await inspector().inspect(await target(repo, dir))).toStrictEqual({
        dirty: false,
        ahead: 0,
        verdict: "unknown",
        reason: "base_unknown",
      });
    }
  });

  it("has no verdict without a main branch, but still tells whether the worktree is dirty", async () => {
    const repo = await scene();
    const dir = await repo.worktree("work");
    await writeFile(join(dir, "new.txt"), "x");

    for (const mainRef of [null, "refs/remotes/origin/missing"]) {
      expect(await inspector().inspect(await target(repo, dir, { mainRef }))).toStrictEqual({
        dirty: true,
        ahead: 0,
        verdict: "unknown",
        reason: "no_main_branch",
      });
    }
  });

  it.each([
    ["no version", null],
    ["2.37", [2, 37]],
    ["1.40", [1, 40]],
  ] as const)("cannot simulate a merge with git %s, but still counts and tells ancestry", async (_case, version) => {
    const repo = await scene();
    const dir = await repo.worktree("work");
    const base = await repo.git(dir, "rev-parse", "HEAD");
    await repo.commit(dir, "a.txt", "a");
    const old = createMergeInspector({ git: countingGit(), version });

    expect(await old.inspect(await target(repo, dir, { baseCommit: base }))).toStrictEqual({
      dirty: false,
      ahead: 1,
      verdict: "unknown",
      reason: "git_too_old",
    });
    await repo.git(repo.repo, "merge", "--quiet", "--ff-only", "work");
    await pushMain(repo);
    expect(await old.inspect(await target(repo, dir, { baseCommit: base }))).toMatchObject({ verdict: "merged" });
  });

  it.each([
    ["2.38", [2, 38]],
    ["3.0", [3, 0]],
  ] as const)("simulates merges with git %s", async (_case, version) => {
    const repo = await scene();
    const dir = await repo.worktree("work");
    await repo.commit(dir, "a.txt", "a");

    const inspected = await createMergeInspector({ git: countingGit(), version }).inspect(await target(repo, dir));

    expect(inspected).toMatchObject({ verdict: "pending", reason: null });
  });

  it("reports git failing", async () => {
    const repo = await scene();
    const dir = await repo.worktree("work");
    const good = await target(repo, dir);
    // A worktree whose `.git` points nowhere fails `git status`, wherever the test's files are.
    const broken = join(repo.root, "broken");
    await mkdir(broken);
    await writeFile(join(broken, ".git"), "gitdir: /nonexistent/atrium-test\n");

    expect(await inspector().inspect({ ...good, dir: broken })).toStrictEqual({
      dirty: false,
      ahead: 0,
      verdict: "unknown",
      reason: "git_failed",
    });
    expect(await inspector().inspect({ ...good, head: "0".repeat(40) })).toMatchObject({
      verdict: "unknown",
      reason: "git_failed",
    });
  });

  it("works a verdict out once for the same branch and main commits, but checks for changes every time", async () => {
    const repo = await scene();
    const dir = await repo.worktree("work");
    await repo.commit(dir, "a.txt", "a");
    const git = countingGit();
    const inspect = createMergeInspector({ git, version: [2, 50] });
    const work = await target(repo, dir);

    const first = await inspect.inspect(work);
    git.commands.length = 0;
    await writeFile(join(dir, "new.txt"), "x");
    const second = await inspect.inspect(work);

    expect(git.commands).toStrictEqual(["status", "rev-parse"]);
    expect(second).toStrictEqual({ ...first, dirty: true });
    git.commands.length = 0;
    expect(await inspect.inspect({ ...work, dirty: false })).toStrictEqual(first);
    expect(git.commands).toStrictEqual(["rev-parse"]);
    expect(await inspect.inspect({ ...work, baseCommit: work.head })).toMatchObject({ verdict: "pending" });
  });
});

describe("parseGitVersion", () => {
  it("reads the major and minor version, with or without a vendor's suffix", () => {
    expect(parseGitVersion("git version 2.50.1 (Apple Git-155)\n")).toStrictEqual([2, 50]);
    expect(parseGitVersion("git version 2.38.0")).toStrictEqual([2, 38]);
    expect(parseGitVersion("git version 10.2.0")).toStrictEqual([10, 2]);
  });

  it("finds none in other output", () => {
    expect(parseGitVersion("")).toBeNull();
    expect(parseGitVersion("version 2.38")).toBeNull();
    expect(parseGitVersion("jgit version 5.13.0.202109080827-r")).toBeNull();
  });
});

describe("MergeInspector caching (after the review)", () => {
  it("tells apart two branches at the same commit, one merged back and one just started from it", async () => {
    const repo = await scene();
    const merged = await repo.worktree("merged");
    await repo.commit(merged, "a.txt", "a");
    await repo.git(repo.repo, "merge", "--quiet", "--ff-only", "merged");
    await pushMain(repo);
    const fresh = await repo.worktree("fresh");
    const inspect = inspector();

    expect(await inspect.inspect(await target(repo, merged))).toMatchObject({ verdict: "merged" });
    expect(await inspect.inspect(await target(repo, fresh))).toMatchObject({ verdict: "noChange" });
  });

  it.each([
    ["telling ancestry", (args: readonly string[]) => args[0] === "merge-base"],
    ["simulating the merge", (args: readonly string[]) => args[0] === "merge-tree"],
    ["reading the main branch's tree", (args: readonly string[]) => args.at(-1)?.endsWith("^{tree}") === true],
  ])("does not keep a verdict git failed to give while %s, and asks again next time", async (_case, fails) => {
    const repo = await scene();
    const dir = await repo.worktree("work");
    await repo.commit(dir, "a.txt", "a");
    const inspect = createMergeInspector({ git: failingOnce(fails), version: [2, 50] });
    const work = await target(repo, dir);

    expect(await inspect.inspect(work)).toStrictEqual({
      dirty: false,
      ahead: 1,
      verdict: "unknown",
      reason: "git_failed",
    });
    expect(await inspect.inspect(work)).toStrictEqual({ dirty: false, ahead: 1, verdict: "pending", reason: null });
  });
});
