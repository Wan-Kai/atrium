import { GIT_SCENE_ENV, type GitScene, createGitScene, present } from "@atrium/testkit";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { systemClock } from "../platform/clock";
import { type GitRunner, createGitRunner } from "../platform/git";
import { ResourceTracker } from "../platform/resources";
import { createMergeInspector } from "../workspaces/merge-inspector";
import { type MergeTaskOptions, mergeTaskBranch } from "./merge";

vi.setConfig({ testTimeout: 30_000 });

/**
 * A git runner that refuses a command without a directory.
 *
 * @remarks
 * Without `cwd` git would run in the test process's own directory, which is the repository under test (or
 * a copy of it in a mutation run) and would merge into it. A mutant that drops `cwd` must fail the test,
 * not make the merge (this happened once with the commit, in T4b).
 *
 * @sideEffects none
 * @param runner - The runner.
 * @returns The same runner, strict about `cwd`.
 */
function strict(runner: GitRunner): GitRunner {
  return {
    run(args, options) {
      if (typeof options.cwd !== "string" || options.cwd === "") throw new Error("git was run without a directory");
      return runner.run(args, options);
    },
  };
}

const real = strict(createGitRunner({ env: GIT_SCENE_ENV, clock: systemClock, resources: new ResourceTracker() }));

/** Whether anything is at a path. */
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * A git runner whose abort leaves a stray file in the main checkout.
 *
 * @remarks
 * For a merge that is backed out and not quite put back.
 *
 * @sideEffects Writes a file after the abort.
 * @returns The runner.
 */
function messyAbort(): GitRunner {
  return watching(async (args, cwd) => {
    await leaveFile(args, cwd);
    return undefined;
  });
}

/** Writes a file in the directory after an abort. */
async function leaveFile(args: readonly string[], cwd: string): Promise<void> {
  await Promise.all(args.includes("--abort") ? [writeFile(join(cwd, "left-behind.txt"), "x\n")] : []);
}

/**
 * A git runner whose abort leaves the main checkout on a new commit.
 *
 * @remarks
 * For a merge that is backed out and not put back.
 *
 * @sideEffects Commits after the abort.
 * @returns The runner.
 */
function movingAbort(): GitRunner {
  return watching(async (args, cwd) => {
    await Promise.all(
      args.includes("--abort")
        ? [real.run(["-c", "user.email=a@b", "-c", "user.name=n", "commit", "--allow-empty", "-m", "moved"], { cwd })]
        : [],
    );
    return undefined;
  });
}

/**
 * A git runner that answers any abort with a failure and leaves everything else to git.
 *
 * @remarks
 * For a merge that cannot be backed out.
 *
 * @sideEffects none
 * @returns The runner.
 */
function refusingAbort(): GitRunner {
  return {
    run: (args, options) =>
      args.includes("--abort") ? Promise.resolve({ code: 128, stdout: "" }) : real.run(args, options),
  };
}

/**
 * A git runner that does the abort and then says it failed.
 *
 * @remarks
 * For an exit code that disagrees with the checkout.
 *
 * @sideEffects none beyond git's.
 * @returns The runner.
 */
function failingAbort(): GitRunner {
  return {
    async run(args, options) {
      const result = await real.run(args, options);
      return args.includes("--abort") ? { code: 1, stdout: result.stdout } : result;
    },
  };
}

/** A scene with a task worktree on `atrium/task`, and the options to merge it. */
async function setup(git: GitRunner = real) {
  const scene = await createGitScene("task-merge");
  onTestFinished(scene.cleanup);
  const dir = await scene.worktree("atrium/task");
  const base = await scene.git(scene.repo, "rev-parse", "main");
  const options: MergeTaskOptions = {
    git,
    inspector: createMergeInspector({ git, version: [2, 50] }),
    mainDir: scene.repo,
    worktreeDir: dir,
    baseCommit: base,
    trunk: "main",
  };
  return { scene, dir, base, options };
}

/** Commits a file in the task's worktree, as a node would. */
async function work(scene: GitScene, dir: string, file = "task.txt", content = "from the task\n") {
  await scene.commit(dir, file, content);
}

/**
 * A runner that lets a test change what happens after a given git command.
 *
 * @remarks
 * Stands in for a git that misbehaves at one point; everything else is the real git.
 *
 * @sideEffects none
 * @param after - Called after each real command with its arguments; may return a result to put in its place.
 * @returns The runner.
 */
function watching(
  after: (args: readonly string[], cwd: string) => Promise<{ code: number; stdout: string } | undefined>,
): GitRunner {
  return {
    async run(args, options) {
      const result = await real.run(args, options);
      return (await after(args, options.cwd)) ?? result;
    },
  };
}

describe('mergeTaskBranch (SPEC-0006, "合并")', () => {
  it("merges the task's branch into the trunk with a merge commit, and pushes nothing", async () => {
    const { scene, dir, options } = await setup();
    await work(scene, dir);
    const originBefore = await scene.git(scene.repo, "rev-parse", "origin/main");
    const before = await scene.git(scene.repo, "rev-parse", "main");

    const result = await mergeTaskBranch(options);

    expect(result).toStrictEqual({ kind: "merged" });
    // A merge commit: the old trunk and the task's branch are its parents.
    const [, ...parents] = (await scene.git(scene.repo, "rev-list", "--parents", "-1", "main")).split(" ");
    expect(parents).toStrictEqual([before, await scene.git(dir, "rev-parse", "HEAD")]);
    expect(await scene.git(scene.repo, "show", "main:task.txt")).toBe("from the task");
    expect(await scene.git(scene.repo, "log", "-1", "--format=%s", "main")).toBe("Merge branch 'atrium/task'");
    expect(await scene.git(scene.repo, "status", "--porcelain")).toBe("");
    expect(await scene.git(scene.repo, "rev-parse", "origin/main")).toBe(originBefore);
    expect(await scene.git(scene.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("merges the commit the branch is at, though a tag of the same name points elsewhere", async () => {
    const { scene, dir, options } = await setup();
    await work(scene, dir);
    const planted = await scene.commit(scene.repo, "planted.txt", "from a tag\n");
    await scene.git(scene.repo, "reset", "--quiet", "--hard", "HEAD~1");
    await scene.git(scene.repo, "tag", "atrium/task", planted);

    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "merged" });

    expect(await scene.git(scene.repo, "show", "main:task.txt")).toBe("from the task");
    await expect(scene.git(scene.repo, "cat-file", "-e", "main:planted.txt")).rejects.toBeInstanceOf(Error);
  });

  it("blocks when the task's worktree has changes that are not committed, and does not touch the trunk", async () => {
    const { scene, dir, options } = await setup();
    await work(scene, dir);
    await writeFile(join(dir, "loose.txt"), "not added\n");
    const before = await scene.git(scene.repo, "rev-parse", "main");

    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "blocked", reason: "merge_worktree_dirty" });

    expect(await scene.git(scene.repo, "rev-parse", "main")).toBe(before);
    // Nothing was staged on the user's behalf.
    expect(await scene.git(dir, "status", "--porcelain")).toBe("?? loose.txt");
  });

  it("blocks while the main checkout has changes, and merges once they are dealt with", async () => {
    const { scene, dir, options } = await setup();
    await work(scene, dir);
    await writeFile(join(scene.repo, "README.md"), "edited by hand\n");
    const before = await scene.git(scene.repo, "rev-parse", "main");

    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "blocked", reason: "merge_main_dirty" });
    expect(await scene.git(scene.repo, "rev-parse", "main")).toBe(before);
    expect(await scene.git(scene.repo, "status", "--porcelain")).toBe("M README.md");

    await scene.git(scene.repo, "checkout", "--", "README.md");
    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "merged" });
    expect(await scene.git(scene.repo, "show", "main:task.txt")).toBe("from the task");
  });

  it("counts an untracked file in the main checkout as changes", async () => {
    const { scene, dir, options } = await setup();
    await work(scene, dir);
    await writeFile(join(scene.repo, "scratch.txt"), "x\n");

    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "blocked", reason: "merge_main_dirty" });
  });

  it("blocks while the main checkout is on another branch, and merges once it is back on the trunk", async () => {
    const { scene, dir, options } = await setup();
    await work(scene, dir);
    await scene.git(scene.repo, "checkout", "--quiet", "-b", "side");
    const sideHead = await scene.git(scene.repo, "rev-parse", "HEAD");

    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "blocked", reason: "merge_main_not_trunk" });
    expect(await scene.git(scene.repo, "rev-parse", "HEAD")).toBe(sideHead);

    await scene.git(scene.repo, "checkout", "--quiet", "main");
    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "merged" });
  });

  it("blocks with a detached head in the main checkout, which is on no trunk", async () => {
    const { scene, dir, options } = await setup();
    await work(scene, dir);
    await scene.git(scene.repo, "checkout", "--quiet", "--detach");

    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "blocked", reason: "merge_main_not_trunk" });
  });

  it("blocks when the project has no trunk to merge into", async () => {
    const { scene, dir, options } = await setup();
    await work(scene, dir);
    const before = await scene.git(scene.repo, "rev-parse", "main");

    expect(await mergeTaskBranch({ ...options, trunk: null })).toStrictEqual({
      kind: "blocked",
      reason: "merge_main_not_trunk",
    });
    expect(await scene.git(scene.repo, "rev-parse", "main")).toBe(before);
  });

  it("reports the files of a conflict, leaves the main checkout exactly as it was, and merges after the conflict is fixed", async () => {
    const { scene, dir, options } = await setup();
    await scene.commit(dir, "README.md", "the task's version\n");
    await scene.commit(dir, "other.txt", "other\n");
    await scene.commit(scene.repo, "README.md", "main's version\n");
    const before = await scene.git(scene.repo, "rev-parse", "main");

    expect(await mergeTaskBranch(options)).toStrictEqual({
      kind: "blocked",
      reason: "merge_conflict",
      files: ["README.md"],
    });

    expect(await scene.git(scene.repo, "rev-parse", "HEAD")).toBe(before);
    expect(await scene.git(scene.repo, "status", "--porcelain")).toBe("");
    expect(await exists(join(scene.repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(await scene.git(scene.repo, "show", "HEAD:README.md")).toBe("main's version");

    // The fix a work node would make: merge the trunk into the task's branch and settle the file.
    await scene.git(dir, "merge", "--no-commit", "main").catch(() => "");
    await writeFile(join(dir, "README.md"), "settled\n");
    await scene.git(dir, "add", "README.md");
    await scene.git(dir, "commit", "--quiet", "-m", "settle");
    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "merged" });
    expect(await scene.git(scene.repo, "show", "main:README.md")).toBe("settled");
  });

  it("names every conflicting file, and not the files that merged", async () => {
    const { scene, dir, options } = await setup();
    await scene.commit(dir, "a.txt", "task a\n");
    await scene.commit(dir, "b.txt", "task b\n");
    await scene.commit(dir, "c.txt", "task c\n");
    await scene.commit(scene.repo, "a.txt", "main a\n");
    await scene.commit(scene.repo, "b.txt", "main b\n");

    expect(await mergeTaskBranch(options)).toStrictEqual({
      kind: "blocked",
      reason: "merge_conflict",
      files: ["a.txt", "b.txt"],
    });
  });

  it("answers merge_abort_failed and leaves the main checkout alone when git will not abort", async () => {
    const stubborn = refusingAbort();
    const { scene, dir, options } = await setup(stubborn);
    await scene.commit(dir, "README.md", "the task's version\n");
    await scene.commit(scene.repo, "README.md", "main's version\n");

    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "blocked", reason: "merge_abort_failed" });

    // Not touched again: the merge is still where git left it, for the user to look at.
    await access(join(scene.repo, ".git", "MERGE_HEAD"));
  });

  it("answers merge_abort_failed when the abort leaves the main checkout with a change", async () => {
    const messy = messyAbort();
    const { scene, dir, options } = await setup(messy);
    await scene.commit(dir, "README.md", "the task's version\n");
    await scene.commit(scene.repo, "README.md", "main's version\n");

    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "blocked", reason: "merge_abort_failed" });
  });

  it("answers merge_abort_failed when the abort leaves the main checkout on another commit", async () => {
    const moved = movingAbort();
    const { scene, dir, options } = await setup(moved);
    await scene.commit(dir, "README.md", "the task's version\n");
    await scene.commit(scene.repo, "README.md", "main's version\n");

    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "blocked", reason: "merge_abort_failed" });
  });

  it("answers merge_git_failed, with the main checkout as it was, when git refuses for another reason", async () => {
    const { scene, options } = await setup();
    // A branch with a history of its own cannot be merged: git refuses, and there is nothing to abort.
    await scene.git(scene.repo, "checkout", "--quiet", "--orphan", "unrelated");
    await scene.git(scene.repo, "rm", "-rf", "--quiet", ".");
    await writeFile(join(scene.repo, "x.txt"), "x\n");
    await scene.git(scene.repo, "add", "x.txt");
    await scene.git(scene.repo, "commit", "--quiet", "-m", "unrelated root");
    await scene.git(scene.repo, "branch", "-M", "orphan-trunk");
    const before = await scene.git(scene.repo, "rev-parse", "HEAD");

    const result = await mergeTaskBranch({ ...options, trunk: "orphan-trunk" });

    expect(result).toStrictEqual({ kind: "blocked", reason: "merge_git_failed" });
    expect(await scene.git(scene.repo, "rev-parse", "HEAD")).toBe(before);
    expect(await scene.git(scene.repo, "status", "--porcelain")).toBe("");
  });

  it("recognises a branch that is already merged and answers merged without merging again", async () => {
    const { scene, dir, options } = await setup();
    await work(scene, dir);
    await mergeTaskBranch(options);
    const merged = await scene.git(scene.repo, "rev-parse", "main");

    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "merged" });

    expect(await scene.git(scene.repo, "rev-parse", "main")).toBe(merged);
  });

  it("answers merged for an already merged branch even when the main checkout has moved off the trunk", async () => {
    const { scene, dir, options } = await setup();
    await work(scene, dir);
    await mergeTaskBranch(options);
    await scene.git(scene.repo, "checkout", "--quiet", "-b", "elsewhere");

    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "merged" });
  });

  it("still asks for a clean worktree before it answers merged", async () => {
    const { scene, dir, options } = await setup();
    await work(scene, dir);
    await mergeTaskBranch(options);
    await writeFile(join(dir, "after.txt"), "later\n");

    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "blocked", reason: "merge_worktree_dirty" });
  });

  it("answers merged for a task that changed nothing, without making a commit", async () => {
    const { scene, options } = await setup();
    const before = await scene.git(scene.repo, "rev-parse", "main");

    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "merged" });

    expect(await scene.git(scene.repo, "rev-parse", "main")).toBe(before);
  });

  it("answers merged for a task that changed nothing even while the main checkout has changes", async () => {
    const { scene, options } = await setup();
    await writeFile(join(scene.repo, "README.md"), "edited by hand\n");

    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "merged" });
  });

  it("answers merge_abort_failed when git says the abort failed, though it did put the checkout back", async () => {
    const lying = failingAbort();
    const { scene, dir, options } = await setup(lying);
    await scene.commit(dir, "README.md", "the task's version\n");
    await scene.commit(scene.repo, "README.md", "main's version\n");

    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "blocked", reason: "merge_abort_failed" });
    expect(await scene.git(scene.repo, "status", "--porcelain")).toBe("");
  });

  it("merges all the same without a merge inspector, when git cannot simulate one", async () => {
    const { scene, dir, options } = await setup();
    await work(scene, dir);

    expect(await mergeTaskBranch({ ...options, inspector: null })).toStrictEqual({ kind: "merged" });
    expect(await scene.git(scene.repo, "show", "main:task.txt")).toBe("from the task");
  });

  it("never runs a merge driver the repository configures: the file conflicts instead", async () => {
    const { scene, dir, options } = await setup();
    const marker = join(scene.root, "driver-ran");
    const script = join(scene.root, "driver.sh");
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
    await chmod(script, 0o755);
    await writeFile(join(scene.repo, ".gitattributes"), "driven.txt merge=evil\n");
    await scene.commit(scene.repo, "driven.txt", "base\n");
    await scene.git(scene.repo, "add", ".gitattributes");
    await scene.git(scene.repo, "commit", "--quiet", "-m", "attributes");
    await scene.git(scene.repo, "config", "merge.evil.driver", `${script} %O %A %B`);
    // The worktree starts from where it was made; bring the file to it, then change it on both sides.
    await scene.git(dir, "merge", "--quiet", "--ff-only", "main");
    const base = await scene.git(scene.repo, "rev-parse", "main");
    await scene.commit(dir, "driven.txt", "from the task\n");
    await scene.commit(scene.repo, "driven.txt", "from main\n");

    const result = await mergeTaskBranch({ ...options, baseCommit: base });

    expect(result).toStrictEqual({ kind: "blocked", reason: "merge_conflict", files: ["driven.txt"] });
    expect(await exists(marker)).toBe(false);
    expect(await scene.git(scene.repo, "status", "--porcelain")).toBe("");
  });

  it("runs none of the repository's hooks", async () => {
    const { scene, dir, options } = await setup();
    await work(scene, dir);
    const marker = join(scene.root, "hook-ran");
    await mkdir(join(scene.repo, ".git", "hooks"), { recursive: true });
    for (const name of ["pre-merge-commit", "post-merge", "commit-msg", "post-commit"]) {
      const hook = join(scene.repo, ".git", "hooks", name);
      await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
      await chmod(hook, 0o755);
    }

    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "merged" });

    expect(await exists(marker)).toBe(false);
  });

  it("refuses a main checkout whose configuration points git at another tree, and merges nothing", async () => {
    const { scene, dir, options } = await setup();
    await work(scene, dir);
    const elsewhere = await mkdtemp(join(tmpdir(), "task-merge-elsewhere-"));
    onTestFinished(() => rm(elsewhere, { recursive: true, force: true }));
    await scene.git(scene.repo, "config", "core.worktree", elsewhere);
    const before = await scene.git(scene.repo, "rev-parse", "main");

    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "blocked", reason: "merge_git_failed" });

    expect(await scene.git(scene.repo, "rev-parse", "main")).toBe(before);
  });

  it("refuses a task worktree whose configuration points git at another tree", async () => {
    const { scene, dir, options } = await setup();
    await work(scene, dir);
    await scene.git(scene.repo, "config", "extensions.worktreeConfig", "true");
    const elsewhere = await mkdtemp(join(tmpdir(), "task-merge-elsewhere-"));
    onTestFinished(() => rm(elsewhere, { recursive: true, force: true }));
    await scene.git(dir, "config", "--worktree", "core.worktree", elsewhere);

    expect(await mergeTaskBranch(options)).toStrictEqual({ kind: "blocked", reason: "merge_git_failed" });
  });

  it("makes the merge commit with an author of its own when the repository names none", async () => {
    const scene = await createGitScene("task-merge-author");
    onTestFinished(scene.cleanup);
    const dir = await scene.worktree("atrium/task");
    await work(scene, dir);
    await scene.commit(scene.repo, "main-side.txt", "main\n");
    const bare = strict(
      createGitRunner({
        env: {
          PATH: present(GIT_SCENE_ENV["PATH"], "PATH"),
          HOME: scene.root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        clock: systemClock,
        resources: new ResourceTracker(),
      }),
    );
    // Without this the repository's own configuration names the author the scene made it with.
    await scene.git(scene.repo, "config", "--unset", "user.email").catch(() => "");
    await scene.git(scene.repo, "config", "--unset", "user.name").catch(() => "");

    const result = await mergeTaskBranch({
      git: bare,
      inspector: null,
      mainDir: scene.repo,
      worktreeDir: dir,
      baseCommit: null,
      trunk: "main",
    });

    expect(result).toStrictEqual({ kind: "merged" });
    expect(await scene.git(scene.repo, "log", "-1", "--format=%an <%ae>", "main")).toBe("Atrium <atrium@localhost>");
  });

  it("stops with the caller's signal instead of answering", async () => {
    const { scene, dir, options } = await setup();
    await work(scene, dir);
    const before = await scene.git(scene.repo, "rev-parse", "main");

    await expect(mergeTaskBranch({ ...options, signal: AbortSignal.abort() })).rejects.toBeInstanceOf(Error);

    expect(await scene.git(scene.repo, "rev-parse", "main")).toBe(before);
  });
});
