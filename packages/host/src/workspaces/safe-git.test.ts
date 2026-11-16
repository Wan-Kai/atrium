import { CommandError } from "@atrium/protocol";
import { GIT_SCENE_ENV, type GitScene, createGitScene, plantTraps } from "@atrium/testkit";
import { access, chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { systemClock } from "../platform/clock";
import { createGitRunner } from "../platform/git";
import { ResourceTracker } from "../platform/resources";
import { runSafeGit, safeGitOptions } from "./safe-git";

vi.setConfig({ testTimeout: 30_000 });

const git = createGitRunner({ env: GIT_SCENE_ENV, clock: systemClock, resources: new ResourceTracker() });

/**
 * Puts hooks in a scene's repository that leave a marker file each when git runs them.
 *
 * @sideEffects Writes the hooks, and a folder for the markers.
 * @param scene - The scene.
 * @param names - The hooks.
 * @returns A function listing the hooks that have run.
 */
async function plantHooks(scene: GitScene, names: readonly string[]): Promise<() => Promise<string[]>> {
  const markers = join(scene.root, "hook-markers");
  await mkdir(markers, { recursive: true });
  await mkdir(join(scene.repo, ".git", "hooks"), { recursive: true });
  for (const name of names) {
    const path = join(scene.repo, ".git", "hooks", name);
    await writeFile(path, `#!/bin/sh\ntouch '${join(markers, name)}'\n`);
    await chmod(path, 0o755);
  }
  return async () => (await readdir(markers)).toSorted();
}

/**
 * Makes a file whose merge is done by a driver that leaves a marker when git runs it.
 *
 * @remarks
 * The driver resolves any merge by keeping the current side, as a program the agent planted would.
 *
 * @sideEffects Writes the script, `.gitattributes` and a file in the scene's repository, commits, and sets the driver.
 * @param scene - The scene.
 * @returns A function telling whether the driver has run.
 */
async function plantMergeDriver(scene: GitScene): Promise<() => Promise<boolean>> {
  const marker = join(scene.root, "driver-ran");
  const script = join(scene.root, "driver.sh");
  await writeFile(script, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`, { mode: 0o755 });
  await writeFile(join(scene.repo, ".gitattributes"), "driven.txt merge=evil\n");
  await scene.commit(scene.repo, "driven.txt", "base\n");
  await scene.git(scene.repo, "add", ".gitattributes");
  await scene.git(scene.repo, "commit", "--quiet", "-m", "attributes");
  await scene.git(scene.repo, "config", "merge.evil.driver", `${script} %O %A %B`);
  return () =>
    access(marker).then(
      () => true,
      () => false,
    );
}

describe("runSafeGit", () => {
  it("commits without the repository's hooks, filters and fsmonitor, though plain git runs them", async () => {
    const scene = await createGitScene("safe-commit");
    onTestFinished(scene.cleanup);
    const traps = await plantTraps(scene, ["hook", "filter", "process", "fsmonitor"]);
    const hooks = await plantHooks(scene, ["pre-commit", "post-commit"]);
    const work = await scene.worktree("work");
    // The worktree above ran the traps; only what happens from here counts.
    await traps.reset();
    await writeFile(join(work, "filtered.txt"), "changed\n");
    await writeFile(join(work, "processed.txt"), "changed\n");

    const added = await runSafeGit(git, ["add", "-A"], { cwd: work }, { rejectIncludes: false });
    const committed = await runSafeGit(
      git,
      ["commit", "--quiet", "-m", "safe"],
      { cwd: work },
      { rejectIncludes: false },
    );

    expect([added.code, committed.code]).toStrictEqual([0, 0]);
    expect(await scene.git(work, "log", "-1", "--format=%s")).toBe("safe");
    expect(await hooks()).toStrictEqual([]);
    expect(await traps.ran()).toStrictEqual([]);

    await writeFile(join(work, "filtered.txt"), "changed again\n");
    await scene.git(work, "add", "-A");
    await scene.git(work, "commit", "--quiet", "-m", "plain");
    expect(await hooks()).toStrictEqual(["post-commit", "pre-commit"]);
  });

  it("merges without the repository's hooks and filters, though plain git runs them", async () => {
    const scene = await createGitScene("safe-merge");
    onTestFinished(scene.cleanup);
    const traps = await plantTraps(scene, ["filter", "process"]);
    const hooks = await plantHooks(scene, ["post-merge", "pre-merge-commit"]);
    const work = await scene.worktree("work");
    await scene.commit(work, "filtered.txt", "from work\n");
    await scene.commit(work, "processed.txt", "from work\n");
    await traps.reset();
    // The merge changes both files in the repository, so a plain one would run the filters.
    const merged = await runSafeGit(
      git,
      ["merge", "--quiet", "--no-ff", "-m", "merge", "--", "work"],
      { cwd: scene.repo },
      { rejectIncludes: false },
    );

    expect(merged.code).toBe(0);
    expect(await hooks()).toStrictEqual([]);
    expect(await traps.ran()).toStrictEqual([]);

    await scene.commit(work, "more.txt", "more\n");
    await scene.git(scene.repo, "merge", "--quiet", "--no-ff", "-m", "plain", "work");
    expect(await hooks()).toStrictEqual(["post-merge", "pre-merge-commit"]);
  });

  it("merges without running a merge driver the repository names: the file conflicts, though plain git lets the driver resolve it", async () => {
    const scene = await createGitScene("safe-merge-driver");
    onTestFinished(scene.cleanup);
    const ran = await plantMergeDriver(scene);
    const work = await scene.worktree("work");
    await scene.commit(work, "driven.txt", "from work\n");
    await scene.commit(scene.repo, "driven.txt", "from main\n");

    const merged = await runSafeGit(
      git,
      ["merge", "--quiet", "--no-ff", "--no-edit", "--", "work"],
      { cwd: scene.repo },
      { rejectIncludes: false },
    );

    expect(merged.code).toBe(1);
    expect(await scene.git(scene.repo, "diff", "--name-only", "--diff-filter=U")).toBe("driven.txt");
    expect(await ran()).toBe(false);

    await scene.git(scene.repo, "merge", "--abort");
    await git.run(["merge", "--quiet", "--no-ff", "--no-edit", "--", "work"], { cwd: scene.repo });
    expect(await ran()).toBe(true);
  });

  it("refuses includes only when asked to", async () => {
    const scene = await createGitScene("safe-include");
    onTestFinished(scene.cleanup);
    await scene.git(scene.repo, "config", "include.path", "elsewhere.gitconfig");

    await expect(runSafeGit(git, ["status"], { cwd: scene.repo }, { rejectIncludes: true })).rejects.toMatchObject({
      code: "worktree_config_unsafe",
      params: { reason: "include" },
    });
    await expect(runSafeGit(git, ["status"], { cwd: scene.repo }, { rejectIncludes: false })).resolves.toMatchObject({
      code: 0,
    });
  });

  it("refuses a filter name it cannot turn off, even when includes are allowed", async () => {
    const scene = await createGitScene("safe-filter-name");
    onTestFinished(scene.cleanup);
    await scene.git(scene.repo, "config", "filter.a=b.clean", "cat");

    const error = await runSafeGit(git, ["status"], { cwd: scene.repo }, { rejectIncludes: false }).catch(
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ code: "worktree_config_unsafe", params: { reason: "filter_name" } });
  });
});

describe("safeGitOptions", () => {
  it("turns off hooks and fsmonitor, and every configured filter's commands, whatever dots its name has", async () => {
    const scene = await createGitScene("safe-options");
    onTestFinished(scene.cleanup);
    await scene.git(scene.repo, "config", "filter.lfs.smudge", "git-lfs smudge");
    await scene.git(scene.repo, "config", "filter.My.Filter.clean", "cat");
    await scene.git(scene.repo, "config", "filter.smudge", "ignored: no name");

    expect(await safeGitOptions(git, scene.repo, { rejectIncludes: true })).toStrictEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "log.showSignature=false",
      "-c",
      "merge.verifySignatures=false",
      "-c",
      "commit.gpgsign=false",
      ...["lfs", "My.Filter"].flatMap((name) => [
        "-c",
        `filter.${name}.smudge=`,
        "-c",
        `filter.${name}.clean=`,
        "-c",
        `filter.${name}.process=`,
        "-c",
        `filter.${name}.required=false`,
      ]),
    ]);
  });

  it("empties every configured merge driver's command, whatever dots its name has", async () => {
    const scene = await createGitScene("safe-options-driver");
    onTestFinished(scene.cleanup);
    await scene.git(scene.repo, "config", "merge.mergiraf.driver", "mergiraf merge %O %A %B");
    await scene.git(scene.repo, "config", "merge.My.Driver.driver", "x");
    await scene.git(scene.repo, "config", "merge.driver", "ignored: no name");
    await scene.git(scene.repo, "config", "merge.mergiraf.name", "only the driver's command runs");

    const options = await safeGitOptions(git, scene.repo, { rejectIncludes: true });

    expect(options.slice(10)).toStrictEqual(["-c", "merge.mergiraf.driver=", "-c", "merge.My.Driver.driver="]);
  });

  it("refuses a merge driver name it cannot empty, whether or not includes are allowed", async () => {
    const scene = await createGitScene("safe-driver-name");
    onTestFinished(scene.cleanup);
    await scene.git(scene.repo, "config", "merge.a=b.driver", "true");

    for (const rejectIncludes of [true, false]) {
      await expect(safeGitOptions(git, scene.repo, { rejectIncludes })).rejects.toMatchObject({
        code: "worktree_config_unsafe",
        params: { reason: "driver_name" },
      });
    }
  });

  it("reads a per-worktree configuration only when the repository has one, though it is set off", async () => {
    const scene = await createGitScene("safe-options-off");
    onTestFinished(scene.cleanup);
    await scene.git(scene.repo, "config", "extensions.worktreeConfig", "false");
    // With several worktrees, `git config --worktree` is an error unless the extension is on.
    await scene.worktree("other");

    await expect(safeGitOptions(git, scene.repo, { rejectIncludes: true })).resolves.toHaveLength(10);
  });

  it("fails as git does when the directory is no repository", async () => {
    const scene = await createGitScene("safe-options-none");
    onTestFinished(scene.cleanup);

    await expect(safeGitOptions(git, scene.root, { rejectIncludes: true })).rejects.toMatchObject({
      name: "GitError",
      reason: "exit",
    });
  });
});
