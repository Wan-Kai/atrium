import { FakeClock, GIT_SCENE_ENV, type GitScene, createGitScene, createTempDir, present } from "@atrium/testkit";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import { GitError, type GitRunner, createGitRunner } from "../platform/git";
import { ResourceTracker } from "../platform/resources";
import { createProjectService } from "../projects/project-service";
import { PROJECTS_FILE, type ProjectsDocument } from "../store/index-schema";
import { type IndexFile, loadIndexFile } from "../store/index-file";
import { createMergeInspector } from "./merge-inspector";
import { FETCH_INTERVAL_MS, FOCUS_FETCH_GAP_MS, createWorkspaceService } from "./workspace-service";

// Each test builds real repositories and runs dozens of git commands; next to the other test
// files running at once, that takes well over the default 5 seconds.
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
  const built = await createGitScene("workspaces");
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

/** Real git with the scenes' environment, counting each subcommand run. */
function countingGit(clock = systemClock): GitRunner & { readonly commands: string[] } {
  const git = createGitRunner({ env: GIT_SCENE_ENV, clock, resources: new ResourceTracker() });
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
 * A workspace service over a fresh index, with real git.
 *
 * @remarks
 * The parts are real; only time is fake where a test needs to move it.
 *
 * @sideEffects Creates the index directory; the service is closed when the test ends.
 * @param options - The clock, and git (`null` for none).
 * @returns The services, the git runner, the log records and the resource tracker.
 */
async function services(options: { clock?: FakeClock; git?: GitRunner | null } = {}) {
  const index = await createTempDir("index");
  onTestFinished(index.cleanup);
  const { file } = await loadIndexFile(index.path, PROJECTS_FILE, 0);
  const clock = options.clock ?? new FakeClock();
  const git = options.git === undefined ? countingGit() : options.git;
  let next = 0;
  const projects = createProjectService({
    file,
    git: Promise.resolve(git),
    newId: (prefix) => `${prefix}_${String((next += 1)).padStart(16, "0")}`,
  });
  const { logger, records } = recordingTracing();
  const resources = new ResourceTracker();
  const workspaces = createWorkspaceService({
    projects,
    git: Promise.resolve(git),
    inspector: Promise.resolve(git === null ? null : createMergeInspector({ git, version: [2, 50] })),
    clock,
    resources,
    logger,
  });
  onTestFinished(() => workspaces.close());
  let changes = 0;
  workspaces.onChange(() => (changes += 1));
  return { projects, workspaces, file, clock, records, resources, git, changes: () => changes };
}

/**
 * The parts of the list a test compares.
 *
 * @remarks
 * Leaves out ids and times, which tests check on their own.
 *
 * @sideEffects none
 * @param list - The workspaces.
 * @returns Kind, directory, branch, head, external and merge of each.
 */
function shape(list: ReturnType<ReturnType<typeof createWorkspaceService>["list"]>) {
  return list.map(({ kind, dir, branch, head, external, merge }) => ({ kind, dir, branch, head, external, merge }));
}

const clean = (verdict: string, ahead = 0) => ({ dirty: false, ahead, verdict, reason: null });

/**
 * Real git that can be made to fail, as when it hangs past its deadline.
 *
 * @remarks
 * Every command fails with a timeout once broken.
 *
 * @sideEffects none until it runs git.
 * @returns The runner and how to break it.
 */
function breakableGit(): GitRunner & { break(): void } {
  const real = countingGit();
  let broken = false;
  return {
    run: (args, options) => (broken ? Promise.reject(new GitError(args[0] ?? "", "timeout")) : real.run(args, options)),
    break: () => {
      broken = true;
    },
  };
}

/**
 * Sets a project's own main branch in `projects.json`, as the settings page will.
 *
 * @remarks
 * There is no command for it before M1.8.
 *
 * @sideEffects Writes the file.
 * @param file - The loaded file.
 * @param projectId - The project.
 * @param branch - Its main branch.
 */
async function setMainBranch(file: IndexFile<ProjectsDocument>, projectId: string, branch: string): Promise<void> {
  const document = file.read();
  await file.save({
    ...document,
    projects: document.projects.map((project) =>
      project.id === projectId ? { ...project, mainBranch: branch } : project,
    ),
  });
}

describe("WorkspaceService", () => {
  it("lists a repository's local workspace and its worktrees, recording those it had not seen", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    await repo.commit(feature, "a.txt", "a");
    const fresh = await repo.worktree("fresh");
    const { projects, workspaces, changes } = await services();
    await projects.add(repo.repo);

    workspaces.start();
    await workspaces.idle();

    expect(shape(workspaces.list())).toStrictEqual([
      { kind: "local", dir: repo.repo, branch: "main", head: null, external: false, merge: null },
      { kind: "worktree", dir: feature, branch: "feature", head: null, external: true, merge: clean("pending", 1) },
      { kind: "worktree", dir: fresh, branch: "fresh", head: null, external: true, merge: clean("noChange") },
    ]);
    const [local, ...worktrees] = workspaces.list();
    expect(local?.createdAt).toBeNull();
    expect(worktrees.map((worktree) => typeof worktree.createdAt)).toStrictEqual(["number", "number"]);
    expect(projects.workspaces().map((record) => record.dir)).toStrictEqual([repo.repo, feature, fresh]);
    expect(changes()).toBeGreaterThan(0);
  });

  it("shows a detached worktree's short commit, and one whose directory went as removed", async () => {
    const repo = await scene();
    const detached = await repo.worktree("detached");
    await repo.git(detached, "checkout", "--quiet", "--detach");
    const gone = await repo.worktree("gone");
    const { projects, workspaces } = await services();
    await projects.add(repo.repo);
    workspaces.start();
    await workspaces.idle();

    await rm(gone, { recursive: true, force: true });
    workspaces.windowFocused();
    await workspaces.idle();
    const head = (await repo.git(detached, "rev-parse", "HEAD")).slice(0, 7);

    expect(shape(workspaces.list()).slice(1)).toStrictEqual([
      { kind: "worktree", dir: detached, branch: null, head, external: true, merge: expect.anything() },
      { kind: "worktree", dir: gone, branch: "gone", head: null, external: true, merge: clean("removed") },
    ]);
    await repo.git(repo.repo, "worktree", "prune");
    workspaces.windowFocused();
    await workspaces.idle();
    expect(shape(workspaces.list())[2]).toStrictEqual({
      kind: "worktree",
      dir: gone,
      branch: null,
      head: null,
      external: true,
      merge: clean("removed"),
    });
  });

  it("treats a plain directory, a subdirectory of a repository, and any project without git as plain", async () => {
    const repo = await scene();
    const plain = join(repo.root, "plain");
    await mkdir(plain);
    const sub = join(repo.repo, "sub");
    await mkdir(sub);
    const withGit = await services();
    await withGit.projects.add(plain);
    await withGit.projects.add(sub);
    const without = await services({ git: null });
    await without.projects.add(repo.repo);

    for (const { workspaces } of [withGit, without]) {
      workspaces.start();
      await workspaces.idle();
      expect(
        workspaces.list().map(({ branch, head, createdAt, merge }) => [branch, head, createdAt, merge]),
      ).toStrictEqual(workspaces.list().map(() => [null, null, null, null]));
    }
  });

  it("has no main branch without origin/HEAD, and follows the project's own main branch", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    await repo.git(repo.repo, "push", "--quiet", "origin", "main:dev");
    await repo.git(repo.repo, "fetch", "--quiet", "origin");
    // After the fetch, which recreates origin/HEAD on git 2.48 and later.
    await repo.git(repo.repo, "remote", "set-head", "origin", "--delete");
    const { projects, workspaces, file } = await services();
    const id = await projects.add(repo.repo);
    workspaces.start();
    await workspaces.idle();

    expect(workspaces.list()[1]?.merge).toStrictEqual({
      dirty: false,
      ahead: 0,
      verdict: "unknown",
      reason: "no_main_branch",
    });
    await setMainBranch(file, id, "dev");
    workspaces.refresh(present(workspaces.list()[1], "workspace").id);
    await workspaces.idle();
    expect(workspaces.list()[1]?.merge).toStrictEqual(clean("noChange"));
    expect(feature).toBe(workspaces.list()[1]?.dir);
  });

  it("works a workspace's project out again after a run, and tells listeners only of changes", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    const { projects, workspaces, changes } = await services();
    await projects.add(repo.repo);
    workspaces.start();
    await workspaces.idle();
    const before = changes();

    workspaces.refresh(present(workspaces.list()[1], "workspace").id);
    await workspaces.idle();
    expect(changes()).toBe(before);

    await repo.commit(feature, "a.txt", "a");
    workspaces.refresh(present(workspaces.list()[1], "workspace").id);
    workspaces.refresh("wks_ffffffffffffffff");
    await workspaces.idle();
    expect(workspaces.list()[1]?.merge).toStrictEqual(clean("pending", 1));
    expect(changes()).toBe(before + 1);
  });

  it("fetches every few minutes and works merge states out again without git status", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    await repo.commit(feature, "a.txt", "a");
    await repo.git(feature, "push", "--quiet", "origin", "feature");
    const clock = new FakeClock();
    const git = countingGit();
    const { projects, workspaces } = await services({ clock, git });
    await projects.add(repo.repo);
    workspaces.start();
    await workspaces.idle();
    expect(workspaces.list()[1]?.merge).toStrictEqual(clean("pending", 1));

    // Merged on the remote, as on GitHub, while the worktree picks up an edit.
    const other = join(repo.root, "other");
    await repo.git(repo.root, "clone", "--quiet", repo.origin, other);
    await repo.git(other, "merge", "--quiet", "--squash", "origin/feature");
    await repo.git(other, "commit", "--quiet", "-m", "squashed");
    await repo.git(other, "push", "--quiet", "origin", "main");
    await writeFile(join(feature, "edit.txt"), "x");
    clock.advance(FETCH_INTERVAL_MS - 1);
    await workspaces.idle();
    expect(git.commands).not.toContain("fetch");
    clock.advance(1);
    await workspaces.idle();

    expect(git.commands.filter((command) => command === "fetch")).toStrictEqual(["fetch"]);
    expect(workspaces.list()[1]?.merge).toStrictEqual(clean("merged", 1));
    workspaces.windowFocused();
    await workspaces.idle();
    expect(workspaces.list()[1]?.merge).toStrictEqual({ dirty: true, ahead: 1, verdict: "merged", reason: null });
  });

  it("fetches when the window gains focus, at most once a minute", async () => {
    const repo = await scene();
    const clock = new FakeClock(10 * FOCUS_FETCH_GAP_MS);
    const git = countingGit();
    const { projects, workspaces } = await services({ clock, git });
    await projects.add(repo.repo);
    const fetches = () => git.commands.filter((command) => command === "fetch").length;

    workspaces.windowFocused();
    await workspaces.idle();
    clock.advance(FOCUS_FETCH_GAP_MS - 1);
    workspaces.windowFocused();
    await workspaces.idle();
    expect(fetches()).toBe(1);
    clock.advance(1);
    workspaces.windowFocused();
    await workspaces.idle();
    expect(fetches()).toBe(2);
  });

  it("skips projects without an origin and logs a fetch that fails", async () => {
    const repo = await scene();
    const plain = join(repo.root, "local-only");
    await mkdir(plain);
    await repo.git(plain, "init", "--quiet");
    await repo.git(repo.repo, "remote", "set-url", "origin", join(repo.root, "nowhere.git"));
    const git = countingGit();
    const { projects, workspaces, records } = await services({ git });
    const id = await projects.add(repo.repo);
    await projects.add(plain);

    workspaces.windowFocused();
    await workspaces.idle();

    expect(git.commands.filter((command) => command === "fetch")).toStrictEqual(["fetch"]);
    expect(records.filter((record) => record["msg"] === "fetch failed")).toMatchObject([
      { level: "info", projectId: id, code: 128 },
    ]);
  });

  it("scans a project as soon as it is added, and forgets a removed one", async () => {
    const repo = await scene();
    await repo.worktree("feature");
    const { projects, workspaces } = await services();
    workspaces.start();
    await workspaces.idle();

    const id = await projects.add(repo.repo);
    await workspaces.idle();
    expect(workspaces.list().map((workspace) => workspace.branch)).toStrictEqual(["main", "feature"]);
    await projects.remove(id);
    expect(workspaces.list()).toStrictEqual([]);
    expect(workspaces.dirOf("wks_0000000000000002")).toBeUndefined();
  });

  it("logs a scan git could not run by its reason, keeping what it knew", async () => {
    const repo = await scene();
    const git = breakableGit();
    const { projects, workspaces, records } = await services({ git });
    const id = await projects.add(repo.repo);
    workspaces.start();
    await workspaces.idle();

    git.break();
    workspaces.windowFocused();
    await workspaces.idle();

    expect(workspaces.list()[0]?.branch).toBe("main");
    expect(records.filter((record) => record["msg"] === "workspace scan failed")).toMatchObject([
      { level: "warn", projectId: id, command: "rev-parse", reason: "timeout" },
    ]);
  });

  it("stops its fetch timer and git when closed", async () => {
    const repo = await scene();
    const clock = new FakeClock();
    const { projects, workspaces, resources } = await services({ clock });
    await projects.add(repo.repo);
    workspaces.start();
    expect(resources.snapshot()["timer"]).toBe(1);

    await workspaces.close();
    workspaces.windowFocused();
    workspaces.refresh(present(workspaces.list()[0], "workspace").id);
    await workspaces.idle();

    expect(resources.snapshot()["timer"]).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("finds a workspace's directory", async () => {
    const { projects, workspaces } = await services({ git: null });
    const temp = await createTempDir("plain");
    onTestFinished(temp.cleanup);
    const dir = await realpath(temp.path);
    await projects.add(dir);

    expect(workspaces.dirOf(present(workspaces.list()[0], "workspace").id)).toBe(dir);
  });
});

describe("WorkspaceService after the review", () => {
  it("lists the main worktree and the chosen one when a project was added through its worktree", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    const { projects, workspaces } = await services();
    await projects.add(feature);

    workspaces.start();
    await workspaces.idle();

    expect(workspaces.list().map(({ kind, dir, branch }) => [kind, dir, branch])).toStrictEqual([
      ["local", repo.repo, "main"],
      ["worktree", feature, "feature"],
    ]);
  });

  it("keeps what it knew of a repository git cannot read for now, as with its drive away", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    await repo.commit(feature, "a.txt", "a");
    const { projects, workspaces, records } = await services();
    const id = await projects.add(repo.repo);
    workspaces.start();
    await workspaces.idle();
    const before = workspaces.list();

    await rename(join(repo.repo, ".git"), join(repo.repo, ".git-away"));
    workspaces.windowFocused();
    await workspaces.idle();

    expect(workspaces.list()).toStrictEqual(before);
    expect(records.filter((record) => record["msg"] === "workspace scan skipped")).toMatchObject([
      { level: "info", projectId: id },
    ]);
    await rename(join(repo.repo, ".git-away"), join(repo.repo, ".git"));
  });
});
