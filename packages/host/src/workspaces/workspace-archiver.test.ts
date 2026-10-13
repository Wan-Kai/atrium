import { CommandError } from "@atrium/protocol";
import { FakeClock, GIT_SCENE_ENV, type GitScene, createGitScene, createTempDir, present } from "@atrium/testkit";
import { access, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import { type GitRunner, createGitRunner } from "../platform/git";
import { ResourceTracker } from "../platform/resources";
import { createProjectService } from "../projects/project-service";
import { PROJECTS_FILE } from "../store/index-schema";
import { loadIndexFile } from "../store/index-file";
import { createWorkspaceArchiver } from "./workspace-archiver";
import { type WorktreeQueue, createWorktreeQueue } from "./worktree-queue";

// Each test builds real repositories and runs git; next to the other test files running at once,
// that takes well over the default 5 seconds.
vi.setConfig({ testTimeout: 30_000 });

/**
 * A repository with a remote, at its real path.
 *
 * @remarks
 * Projects keep real paths; the system's temporary folder is reached through a link on macOS.
 *
 * @sideEffects Creates the repositories, removed when the test ends.
 * @returns The scene with real paths.
 */
async function scene(): Promise<GitScene> {
  const built = await createGitScene("archive");
  onTestFinished(built.cleanup);
  const root = await realpath(built.root);
  return {
    ...built,
    root,
    repo: join(root, "repo"),
    origin: join(root, "origin.git"),
    worktree: async (branch, from) => realpath(await built.worktree(branch, from)),
  };
}

/**
 * An archiver over a project registered at the scene's repository, its worktrees recorded, after
 * a plain folder's project.
 *
 * @remarks
 * git and the index are real; the sessions record what was asked of them, and whether the
 * worktree's directory was there at that moment.
 *
 * @sideEffects Creates the index directory.
 * @param repo - The scene.
 * @param worktrees - The worktrees to record as workspaces.
 * @param git - git, or `null` for none.
 * @param stopping - What else happens while a workspace's sessions stop, as a running pi might do.
 * @param queue - The queue of worktree changes it shares, if any.
 * @returns The archiver, the services, the sessions' calls, the scans asked for, the clock and logs.
 */
async function archiver(
  repo: GitScene,
  worktrees: readonly string[],
  git: GitRunner | null = realGit(),
  stopping: (dir: string) => Promise<unknown> = async () => undefined,
  queue?: WorktreeQueue,
) {
  const index = await createTempDir("index");
  onTestFinished(index.cleanup);
  const { file } = await loadIndexFile(index.path, PROJECTS_FILE, 0);
  let next = 0;
  const projects = createProjectService({
    file,
    git: Promise.resolve(git),
    newId: (prefix) => `${prefix}_${String((next += 1)).padStart(16, "0")}`,
  });
  // Another project first, so git has to run in the right one.
  const other = join(repo.root, "other");
  await mkdir(other, { recursive: true });
  await projects.add(other);
  const projectId = await projects.add(repo.repo);
  await projects.recordWorktrees(projectId, worktrees);
  const calls: string[] = [];
  const refreshed: string[] = [];
  const clock = new FakeClock(1_000);
  const { logger, records } = recordingTracing();
  const ids = Object.fromEntries(projects.workspaces().map((record) => [record.dir, record.id]));
  const dirOf = (workspaceId: string) =>
    present(
      projects.workspaces().find((record) => record.id === workspaceId),
      "the workspace",
    ).dir;
  const archive = createWorkspaceArchiver({
    projects,
    git: Promise.resolve(git),
    sessions: {
      stopWorkspace: async (workspaceId) => {
        calls.push(`stop ${workspaceId} ${(await there(dirOf(workspaceId))) ? "there" : "gone"}`);
        await stopping(dirOf(workspaceId));
      },
      archiveWorkspace: async (workspaceId) => {
        calls.push(`archive ${workspaceId} ${(await there(dirOf(workspaceId))) ? "there" : "gone"}`);
      },
    },
    refresh: (workspaceId) => refreshed.push(workspaceId),
    clock,
    logger,
    ...(queue === undefined ? {} : { queue }),
  });
  return { archive, projects, ids, calls, refreshed, clock, records };
}

/** Real git with the scenes' environment. */
const realGit = (): GitRunner =>
  createGitRunner({ env: GIT_SCENE_ENV, clock: systemClock, resources: new ResourceTracker() });

/**
 * Whether anything is at a path.
 *
 * @sideEffects Reads the file system.
 * @param path - The path.
 * @returns Whether it is there.
 */
async function there(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * The archive record of a workspace.
 *
 * @sideEffects none
 * @param projects - The project service.
 * @param workspaceId - The workspace.
 * @returns Its `archived`, `null` when it is not.
 */
function archivedOf(projects: ReturnType<typeof createProjectService>, workspaceId: string) {
  return (
    present(
      projects.workspaces().find((record) => record.id === workspaceId),
      "the workspace",
    ).archived ?? null
  );
}

describe("WorkspaceArchiver.archive", () => {
  it("removes a clean worktree's directory after stopping its sessions, keeps its branch, then archives it and its sessions", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    const commit = await repo.commit(feature, "a.txt", "a");
    // Ignored files go with the directory.
    await mkdir(join(repo.repo, ".git", "info"), { recursive: true });
    await writeFile(join(repo.repo, ".git", "info", "exclude"), "node_modules/\n.env\n");
    await mkdir(join(feature, "node_modules"));
    await writeFile(join(feature, "node_modules", "x.js"), "");
    await writeFile(join(feature, ".env"), "");
    const { archive, projects, ids, calls } = await archiver(repo, [feature]);
    const id = present(ids[feature], "feature");

    await archive.archive(id);

    expect(calls).toStrictEqual([`stop ${id} there`, `archive ${id} gone`]);
    expect(await there(feature)).toBe(false);
    expect(await repo.git(repo.repo, "rev-parse", "refs/heads/feature")).toBe(commit);
    expect(await repo.git(repo.repo, "worktree", "list", "--porcelain")).not.toContain(feature);
    expect(archivedOf(projects, id)).toStrictEqual({ at: 1_000, branch: "feature", head: commit });
  });

  it("archives a worktree detached at a commit a branch, remote branch or tag holds, or only a local branch", async () => {
    const repo = await scene();
    const onMain = await repo.worktree("one");
    await repo.git(onMain, "checkout", "--quiet", "--detach", "main");
    const tagged = await repo.worktree("two");
    const tag = await repo.commit(tagged, "t.txt", "t");
    await repo.git(tagged, "tag", "v1");
    await repo.git(tagged, "checkout", "--quiet", "--detach", "v1");
    await repo.git(repo.repo, "branch", "--quiet", "-D", "two");
    const remote = await repo.worktree("three");
    const pushed = await repo.commit(remote, "r.txt", "r");
    await repo.git(remote, "push", "--quiet", "origin", "three");
    await repo.git(remote, "checkout", "--quiet", "--detach");
    await repo.git(repo.repo, "branch", "--quiet", "-D", "three");
    const local = await repo.worktree("four");
    const kept = await repo.commit(local, "k.txt", "k");
    await repo.git(local, "checkout", "--quiet", "--detach");
    const all = [onMain, tagged, remote, local];
    const { archive, projects, ids } = await archiver(repo, all);
    const main = await repo.git(repo.repo, "rev-parse", "main");

    for (const dir of all) await archive.archive(present(ids[dir], dir));

    expect(all.map((dir) => archivedOf(projects, present(ids[dir], dir)))).toStrictEqual([
      { at: 1_000, branch: null, head: main },
      { at: 1_000, branch: null, head: tag },
      { at: 1_000, branch: null, head: pushed },
      { at: 1_000, branch: null, head: kept },
    ]);
  });

  it("refuses a worktree with changes or untracked files, or detached at a commit nothing holds, doing nothing", async () => {
    const repo = await scene();
    const changed = await repo.worktree("changed");
    await writeFile(join(changed, "README.md"), "changed");
    const untracked = await repo.worktree("untracked");
    await writeFile(join(untracked, "new.txt"), "new");
    const loose = await repo.worktree("loose");
    await repo.git(loose, "checkout", "--quiet", "--detach");
    await repo.commit(loose, "l.txt", "l");
    const { archive, projects, ids, calls } = await archiver(repo, [changed, untracked, loose]);

    const failures = await Promise.all(
      [changed, untracked, loose].map((dir) =>
        archive.archive(present(ids[dir], dir)).catch((error: unknown) => error),
      ),
    );

    expect(failures).toStrictEqual([
      new CommandError("workspace_dirty"),
      new CommandError("workspace_dirty"),
      new CommandError("workspace_unsaved_commits"),
    ]);
    expect(calls).toStrictEqual([]);
    expect(await Promise.all([changed, untracked, loose].map((dir) => there(dir)))).toStrictEqual([true, true, true]);
    expect(projects.workspaces().map((record) => archivedOf(projects, record.id))).toStrictEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("refuses the local workspace and an unknown one, and does nothing for one archived already", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    const { archive, ids, calls } = await archiver(repo, [feature]);
    const id = present(ids[feature], "feature");
    const local = present(ids[repo.repo], "local");
    await archive.archive(id);

    const failures = await Promise.all(
      [local, "wks_ffffffffffffffff"].map((workspaceId) =>
        archive.archive(workspaceId).catch((error: unknown) => error),
      ),
    );
    await archive.archive(id);

    expect(failures).toStrictEqual([
      new CommandError("workspace_is_local", { workspaceId: local }),
      new CommandError("workspace_not_found", { workspaceId: "wks_ffffffffffffffff" }),
    ]);
    expect(calls).toStrictEqual([`stop ${id} there`, `archive ${id} gone`]);
  });

  it("archives a worktree whose directory went without asking git to remove it, keeping what git still lists", async () => {
    const repo = await scene();
    const gone = await repo.worktree("gone");
    const pruned = await repo.worktree("pruned");
    const locked = await repo.worktree("locked");
    await repo.git(repo.repo, "worktree", "lock", "--", locked);
    const { archive, projects, ids, calls } = await archiver(repo, [gone, pruned, locked]);
    const head = await repo.git(gone, "rev-parse", "HEAD");
    await rm(gone, { recursive: true });
    await rm(pruned, { recursive: true });
    await repo.git(repo.repo, "worktree", "prune", "--expire=now");
    // `prune` cleared both; `gone` is registered again, its directory still missing.
    await repo.git(repo.repo, "worktree", "add", "--quiet", "--", gone, "gone");
    await rm(gone, { recursive: true });

    // git keeps listing a locked worktree whose directory went, without marking it prunable.
    await rm(locked, { recursive: true });
    await archive.archive(present(ids[gone], "gone"));
    await archive.archive(present(ids[pruned], "pruned"));
    await archive.archive(present(ids[locked], "locked"));

    expect(calls).toStrictEqual([
      `stop ${String(ids[gone])} gone`,
      `archive ${String(ids[gone])} gone`,
      `stop ${String(ids[pruned])} gone`,
      `archive ${String(ids[pruned])} gone`,
      `stop ${String(ids[locked])} gone`,
      `archive ${String(ids[locked])} gone`,
    ]);
    expect([
      archivedOf(projects, present(ids[gone], "gone")),
      archivedOf(projects, present(ids[pruned], "pruned")),
    ]).toStrictEqual([
      { at: 1_000, branch: "gone", head },
      { at: 1_000, branch: null, head: null },
    ]);
  });

  it("stops the sessions but archives nothing when git will not remove the worktree, logging only git's exit code", async () => {
    const repo = await scene();
    const locked = await repo.worktree("locked");
    await repo.git(repo.repo, "worktree", "lock", "--", locked);
    const { archive, projects, ids, calls, records } = await archiver(repo, [locked]);
    const id = present(ids[locked], "locked");

    await expect(archive.archive(id)).rejects.toStrictEqual(new CommandError("worktree_remove_failed"));

    expect(calls).toStrictEqual([`stop ${id} there`]);
    expect(await there(locked)).toBe(true);
    expect(archivedOf(projects, id)).toBeNull();
    expect(logged(records)).toStrictEqual([["worktree remove failed", id, 128]]);
    expect(JSON.stringify(records)).not.toContain(locked);
  });

  it("checks again once the sessions have stopped, refusing what changed meanwhile and keeping the commit then", async () => {
    const repo = await scene();
    const changed = await repo.worktree("changed");
    const loose = await repo.worktree("loose");
    await repo.git(loose, "checkout", "--quiet", "--detach");
    const moved = await repo.worktree("moved");
    const all = [changed, loose, moved];
    const { archive, projects, ids, calls } = await archiver(repo, all, realGit(), async (dir) =>
      writeFile(join(dir, "late.txt"), "late"),
    );
    const latest: string[] = [];
    // Committing what the late write left, as pi might after the check, in two of them.
    const committing = await archiver(repo, all, realGit(), async (dir) => {
      await writeFile(join(dir, "late.txt"), "late");
      latest.push(await repo.commit(dir, "late.txt", "late"));
    });

    const failure = await archive.archive(present(ids[changed], "changed")).catch((error: unknown) => error);
    const later = await Promise.all(
      [loose, moved].map((dir) => committing.archive.archive(present(ids[dir], dir)).catch((error: unknown) => error)),
    );

    expect([failure, ...later]).toStrictEqual([
      new CommandError("workspace_dirty"),
      new CommandError("workspace_unsaved_commits"),
      undefined,
    ]);
    expect(calls).toStrictEqual([`stop ${String(ids[changed])} there`]);
    expect(await Promise.all(all.map((dir) => there(dir)))).toStrictEqual([true, true, false]);
    expect([
      archivedOf(projects, present(ids[changed], "changed")),
      archivedOf(committing.projects, present(ids[loose], "loose")),
    ]).toStrictEqual([null, null]);
    expect(archivedOf(committing.projects, present(ids[moved], "moved"))).toStrictEqual({
      at: 1_000,
      branch: "moved",
      head: latest[1],
    });
  });

  it("marks the workspace archived before removing the directory, and unmarks it when git will not remove it", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    const locked = await repo.worktree("locked");
    await repo.git(repo.repo, "worktree", "lock", "--", locked);
    const seen: unknown[] = [];
    let look = nothing;
    const { archive, projects, ids } = await archiver(
      repo,
      [feature, locked],
      watchingGit(["worktree", "remove"], () => look()),
    );
    const head = await repo.git(feature, "rev-parse", "HEAD");
    look = () =>
      seen.push(
        archivedOf(projects, present(ids[feature], "feature")),
        archivedOf(projects, present(ids[locked], "locked")),
      );

    await archive.archive(present(ids[feature], "feature"));
    const failure = await archive.archive(present(ids[locked], "locked")).catch((error: unknown) => error);

    expect(failure).toStrictEqual(new CommandError("worktree_remove_failed"));
    expect(seen).toStrictEqual([
      { at: 1_000, branch: "feature", head },
      null,
      { at: 1_000, branch: "feature", head },
      { at: 1_000, branch: "locked", head },
    ]);
    expect(archivedOf(projects, present(ids[locked], "locked"))).toBeNull();
  });

  it("gives git ten minutes to remove or add a worktree's directory, and its usual time for the rest", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    const seen: unknown[][] = [];
    const { archive, ids } = await archiver(repo, [feature], timedGit(seen));
    const id = present(ids[feature], "feature");
    // Registering the project ran git too.
    seen.splice(0);

    await archive.archive(id);
    await archive.restore(id);

    expect(seen).toStrictEqual([
      ["worktree list", null],
      ["status --porcelain", null],
      ["worktree list", null],
      ["status --porcelain", null],
      ["worktree remove", 600_000],
      ["worktree list", null],
      ["worktree prune", null],
      ["show-ref --verify", null],
      ["worktree add", 600_000],
    ]);
  });

  it("fails without git, or when git cannot list worktrees, read the worktree's status or find what holds its commit", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    const loose = await repo.worktree("loose");
    await repo.git(loose, "checkout", "--quiet", "--detach");
    const withoutGit = await archiver(repo, [feature, loose], null);
    const id = present(withoutGit.ids[feature], "feature");
    const looseId = present(withoutGit.ids[loose], "loose");
    const failing = await archiver(repo, [feature, loose], failingGit(["worktree", "list"]));
    const unreadable = await archiver(repo, [feature, loose], failingGit(["status"]));
    const unheld = await archiver(repo, [feature, loose], failingGit(["for-each-ref"]));

    const failures = await Promise.all([
      ...[withoutGit, failing, unreadable].map(({ archive }) => archive.archive(id).catch((error: unknown) => error)),
      unheld.archive.archive(looseId).catch((error: unknown) => error),
    ]);

    expect(failures).toStrictEqual(Array.from({ length: 4 }, () => new CommandError("worktree_remove_failed")));
    expect([failing.records, unreadable.records, unheld.records].map(logged)).toStrictEqual([
      [["worktree list failed", id, 128]],
      [["worktree status failed", id, 128]],
      [["worktree holders failed", looseId, 128]],
    ]);
    expect(await Promise.all([feature, loose].map((dir) => there(dir)))).toStrictEqual([true, true]);
  });
});

/**
 * What was logged: each record's message, workspace and git's exit code.
 *
 * @sideEffects none
 * @param records - The log records.
 * @returns One entry per record.
 */
function logged(records: readonly Record<string, unknown>[]): unknown[][] {
  return records.map((record) => [record["msg"], record["workspaceId"], record["code"]]);
}

/**
 * Real git, except that commands starting with `failing` exit with 128 and print nothing.
 *
 * @remarks
 * As git does when it cannot read a repository.
 *
 * @sideEffects none until run; then runs git.
 * @param failing - The first arguments of the commands that fail.
 * @returns The runner.
 */
function failingGit(failing: readonly string[]): GitRunner {
  const git = realGit();
  return {
    run: (args, options) =>
      failing.every((arg, at) => args[at] === arg)
        ? Promise.resolve({ code: 128, stdout: "", stderr: "" })
        : git.run(args, options),
  };
}

/**
 * Does nothing; what a test looks at before it says what to look at.
 *
 * @sideEffects none
 */
function nothing(): void {}

/**
 * Real git that calls `look` just before running commands starting with `watched`.
 *
 * @sideEffects none until run; then calls `look` and runs git.
 * @param watched - The first arguments of the commands to watch.
 * @param look - What to do before them.
 * @returns The runner.
 */
function watchingGit(watched: readonly string[], look: () => void): GitRunner {
  const git = realGit();
  return {
    run: (args, options) => {
      if (watched.every((arg, at) => args[at] === arg)) look();
      return git.run(args, options);
    },
  };
}

/**
 * Real git that notes each command's first two arguments and the time it was given.
 *
 * @sideEffects none until run; then appends to `seen` and runs git.
 * @param seen - Where to note them; `null` for git's usual time.
 * @returns The runner.
 */
function timedGit(seen: unknown[][]): GitRunner {
  const git = realGit();
  return {
    run: (args, options) => {
      seen.push([args.slice(0, 2).join(" "), options.timeoutMs ?? null]);
      return git.run(args, options);
    },
  };
}

describe("WorkspaceArchiver.restore", () => {
  it("adds an archived worktree back on its branch, or detached at its commit, and shows it again", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    const commit = await repo.commit(feature, "a.txt", "a");
    const detached = await repo.worktree("detached");
    await repo.git(detached, "checkout", "--quiet", "--detach", "main");
    const { archive, projects, ids, refreshed } = await archiver(repo, [feature, detached]);
    const [featureId, detachedId] = [present(ids[feature], "feature"), present(ids[detached], "detached")];
    await archive.archive(featureId);
    await archive.archive(detachedId);

    await archive.restore(featureId);
    await archive.restore(detachedId);

    expect(await repo.git(feature, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
    expect(await repo.git(feature, "rev-parse", "HEAD")).toBe(commit);
    expect(await repo.git(detached, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(await repo.git(detached, "rev-parse", "HEAD")).toBe(await repo.git(repo.repo, "rev-parse", "main"));
    expect([archivedOf(projects, featureId), archivedOf(projects, detachedId)]).toStrictEqual([null, null]);
    expect(refreshed).toStrictEqual([featureId, detachedId]);
  });

  it("adds a worktree back where git still had it registered, its directory gone", async () => {
    const repo = await scene();
    const gone = await repo.worktree("gone");
    const { archive, ids } = await archiver(repo, [gone]);
    const id = present(ids[gone], "gone");
    await rm(gone, { recursive: true });
    await archive.archive(id);

    await archive.restore(id);

    expect(await repo.git(gone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("gone");
  });

  it("only shows again a worktree already back, and does nothing for one not archived", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    const { archive, projects, ids, refreshed } = await archiver(repo, [feature]);
    const id = present(ids[feature], "feature");
    await archive.archive(id);
    await repo.git(repo.repo, "worktree", "add", "--quiet", "--", feature, "feature");
    await writeFile(join(feature, "kept.txt"), "kept");

    await archive.restore(id);
    await archive.restore(id);

    expect(await there(join(feature, "kept.txt"))).toBe(true);
    expect(archivedOf(projects, id)).toBeNull();
    expect(refreshed).toStrictEqual([id]);
  });

  it("refuses, saying why, a directory something else took, a branch gone even if a remote has one of its name, one checked out elsewhere, and a worktree it knows nothing of", async () => {
    const repo = await scene();
    const taken = await repo.worktree("taken");
    const deleted = await repo.worktree("deleted");
    const pushed = await repo.worktree("pushed");
    await repo.git(pushed, "push", "--quiet", "origin", "pushed");
    await repo.git(repo.repo, "fetch", "--quiet", "origin");
    const busy = await repo.worktree("busy");
    const unknown = await repo.worktree("unknown");
    const all = [taken, deleted, pushed, busy, unknown];
    const { archive, projects, ids, records } = await archiver(repo, all);
    const id = (dir: string) => present(ids[dir], dir);
    for (const dir of [taken, deleted, pushed, busy]) await archive.archive(id(dir));
    await mkdir(taken);
    await repo.git(repo.repo, "branch", "--quiet", "-D", "deleted");
    await repo.git(repo.repo, "branch", "--quiet", "-D", "pushed");
    await repo.git(repo.repo, "worktree", "add", "--quiet", "--", join(repo.root, "elsewhere"), "busy");
    await rm(unknown, { recursive: true });
    await projects.setArchived(id(unknown), { at: 1, branch: null, head: null });

    const failures = await Promise.all(all.map((dir) => archive.restore(id(dir)).catch((error: unknown) => error)));

    expect(failures).toStrictEqual([
      new CommandError("worktree_restore_failed", { reason: "dir_taken" }),
      new CommandError("worktree_restore_failed", { reason: "branch_gone" }),
      new CommandError("worktree_restore_failed", { reason: "branch_gone" }),
      new CommandError("worktree_restore_failed"),
      new CommandError("worktree_restore_failed", { reason: "no_branch" }),
    ]);
    expect(all.map((dir) => archivedOf(projects, id(dir)) !== null)).toStrictEqual([true, true, true, true, true]);
    expect(await Promise.all([deleted, pushed].map((dir) => there(dir)))).toStrictEqual([false, false]);
    expect(await repo.git(repo.repo, "branch", "--list", "pushed")).toBe("");
    expect(logged(records)).toStrictEqual([["worktree add failed", id(busy), 128]]);
  });

  it("refuses an unknown workspace, and fails without git or when git cannot list worktrees", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    const { archive, projects, ids } = await archiver(repo, [feature]);
    const id = present(ids[feature], "feature");
    await archive.archive(id);
    const archived = present(archivedOf(projects, id), "the archive");
    const withoutGit = await archiver(repo, [feature], null);
    const failing = await archiver(repo, [feature], failingGit(["worktree", "list"]));
    for (const other of [withoutGit, failing]) await other.projects.setArchived(id, archived);

    const failures = await Promise.all([
      archive.restore("wks_ffffffffffffffff").catch((error: unknown) => error),
      withoutGit.archive.restore(id).catch((error: unknown) => error),
      failing.archive.restore(id).catch((error: unknown) => error),
    ]);

    expect(failures).toStrictEqual([
      new CommandError("workspace_not_found", { workspaceId: "wks_ffffffffffffffff" }),
      new CommandError("worktree_restore_failed"),
      new CommandError("worktree_restore_failed"),
    ]);
  });
});

describe("WorkspaceArchiver one at a time", () => {
  it("closes once the archive or restore under way has ended, failed or not", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    const { archive, projects, ids } = await archiver(repo, [feature]);
    const local = present(ids[repo.repo], "local");
    const id = present(ids[feature], "feature");
    const failed = archive.archive(local).catch((error: unknown) => error);
    const archived = archive.archive(id);

    await archive.close();

    expect(archivedOf(projects, id)).not.toBeNull();
    expect(await there(feature)).toBe(false);
    await archived;
    await failed;
  });

  it("restores a workspace asked to be restored while it was being archived", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    const { archive, projects, ids } = await archiver(repo, [feature]);
    const id = present(ids[feature], "feature");

    await Promise.all([archive.archive(id), archive.restore(id)]);

    expect(archivedOf(projects, id)).toBeNull();
    expect(await there(feature)).toBe(true);
  });

  it("waits for a worktree change before it in the queue it shares, and closes after it", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    const queue = createWorktreeQueue();
    const { archive, projects, ids } = await archiver(repo, [feature], realGit(), undefined, queue);
    const id = present(ids[feature], "feature");
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const before = queue.run(() => held);

    const archiving = archive.archive(id);
    const closing = archive.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(archivedOf(projects, id)).toBeNull();
    release();
    await before;
    await closing;
    expect(archivedOf(projects, id)).not.toBeNull();
    await archiving;
  });

  it("goes on after one that failed", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    const { archive, projects, ids } = await archiver(repo, [feature]);
    const local = present(ids[repo.repo], "local");
    const id = present(ids[feature], "feature");

    const [failed] = await Promise.all([archive.archive(local).catch((error: unknown) => error), archive.archive(id)]);

    expect(failed).toStrictEqual(new CommandError("workspace_is_local", { workspaceId: local }));
    expect(archivedOf(projects, id)).not.toBeNull();
  });
});
