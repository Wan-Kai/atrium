import type { Workspace } from "@atrium/protocol";
import { FakeClock, GIT_SCENE_ENV, type GitScene, createGitScene, createTempDir, present } from "@atrium/testkit";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import { GitError, type GitRunner, createGitRunner } from "../platform/git";
import { ResourceTracker } from "../platform/resources";
import { type ProjectService, createProjectService } from "../projects/project-service";
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

/** One git command a test saw, with the deadline it was given. */
interface SeenRun {
  readonly command: string;
  readonly timeoutMs: number | undefined;
}

/** Real git with the scenes' environment, counting each subcommand run and its deadline. */
function countingGit(clock = systemClock): GitRunner & { readonly commands: string[]; readonly runs: SeenRun[] } {
  const git = createGitRunner({ env: GIT_SCENE_ENV, clock, resources: new ResourceTracker() });
  const commands: string[] = [];
  const runs: SeenRun[] = [];
  return {
    commands,
    runs,
    run(args, options) {
      commands.push(args[0] ?? "");
      runs.push({ command: args[0] ?? "", timeoutMs: options.timeoutMs });
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
  const { workspaces, records, resources } = watch(projects, git, clock);
  let changes = 0;
  workspaces.onChange(() => (changes += 1));
  return { projects, workspaces, file, clock, records, resources, git, changes: () => changes };
}

/**
 * A workspace service over a project service, with the given git.
 *
 * @remarks
 * A second one over the same projects stands for the host started again.
 *
 * @sideEffects Subscribes to the projects; the service is closed when the test ends.
 * @param projects - The project service.
 * @param git - git, or `null` for none.
 * @param clock - The clock.
 * @returns The service, its log records and its resource tracker.
 */
function watch(projects: ProjectService, git: GitRunner | null, clock: FakeClock) {
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
  return { workspaces, records, resources };
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

/**
 * Orders workspaces by when they were archived, those not archived first.
 *
 * @remarks
 * git lists worktrees in no order a test can count on.
 *
 * @sideEffects none
 * @param a - One workspace.
 * @param b - Another.
 * @returns Their order.
 */
function byArchivedAt(a: Workspace, b: Workspace): number {
  return (a.archivedAt ?? 0) - (b.archivedAt ?? 0);
}

const clean = (verdict: string, ahead = 0) => ({ dirty: false, ahead, verdict, reason: null });

/**
 * Real git that can be made to fail, as when it hangs past its deadline.
 *
 * @remarks
 * Every command fails once broken: with a timeout, or with the error given, as a host bug would.
 *
 * @sideEffects none until it runs git.
 * @returns The runner and how to break it.
 */
function breakableGit(): GitRunner & { break(error?: Error): void } {
  const real = countingGit();
  let failure: ((command: string) => Error) | null = null;
  return {
    run: (args, options) => (failure === null ? real.run(args, options) : Promise.reject(failure(args[0] ?? ""))),
    break: (error) => {
      failure = (command) => error ?? new GitError(command, "timeout");
    },
  };
}

/**
 * Real git that runs an action just before a given command starts.
 *
 * @remarks
 * Lets a test act at an exact point of a scan or a fetch, such as closing the service.
 *
 * @sideEffects none until it runs git; then runs the actions.
 * @returns The runner, its commands and how to add an action.
 */
function interceptingGit(): GitRunner & {
  readonly commands: string[];
  before(command: string, action: () => void): void;
} {
  const real = countingGit();
  const actions = new Map<string, () => void>();
  return {
    commands: real.commands,
    run: (args, options) => {
      actions.get(args[0] ?? "")?.();
      return real.run(args, options);
    },
    before: (command, action) => {
      actions.set(command, action);
    },
  };
}

/**
 * Sets a project's own main branch in `projects.json`, as the settings page will.
 *
 * @remarks
 * There is no command for it before M1.10.
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

    for (const { workspaces, records } of [withGit, without]) {
      workspaces.windowFocused();
      await workspaces.idle();
      expect(
        workspaces.list().map(({ branch, head, createdAt, merge }) => [branch, head, createdAt, merge]),
      ).toStrictEqual(workspaces.list().map(() => [null, null, null, null]));
      // Neither the scans nor the fetches failed: there was nothing to read.
      expect(records).toStrictEqual([]);
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

  it("tells a branch merged into the local main branch, not pushed, merged", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    await repo.commit(feature, "a.txt", "a");
    const { projects, workspaces } = await services();
    await projects.add(repo.repo);
    workspaces.start();
    await workspaces.idle();
    expect(workspaces.list()[1]?.merge).toStrictEqual(clean("pending", 1));

    await repo.git(repo.repo, "merge", "--quiet", "--no-ff", "-m", "merge feature", "feature");
    workspaces.windowFocused();
    await workspaces.idle();

    expect(workspaces.list()[1]?.merge).toStrictEqual(clean("merged"));
  });

  it("keeps a branch merged only on origin pending until the local main branch has it", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    await repo.commit(feature, "a.txt", "a");
    await repo.git(feature, "push", "--quiet", "origin", "feature");
    const other = join(repo.root, "other");
    await repo.git(repo.root, "clone", "--quiet", repo.origin, other);
    await repo.git(other, "merge", "--quiet", "--no-ff", "-m", "merge feature", "origin/feature");
    await repo.git(other, "push", "--quiet", "origin", "main");
    await repo.git(repo.repo, "fetch", "--quiet", "origin");
    const { projects, workspaces } = await services();
    await projects.add(repo.repo);
    workspaces.start();
    await workspaces.idle();
    expect(workspaces.list()[1]?.merge).toStrictEqual(clean("pending", 1));

    await repo.git(repo.repo, "merge", "--quiet", "--ff-only", "origin/main");
    workspaces.windowFocused();
    await workspaces.idle();

    expect(workspaces.list()[1]?.merge).toStrictEqual(clean("merged"));
  });

  it("fetches every few minutes and works merge states out again without git status, against origin without a local main branch", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    await repo.commit(feature, "a.txt", "a");
    await repo.git(feature, "push", "--quiet", "origin", "feature");
    await repo.git(repo.repo, "checkout", "--quiet", "-b", "work");
    await repo.git(repo.repo, "branch", "--quiet", "-D", "main");
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
    // Every few minutes: not within the first minute.
    clock.advance(FOCUS_FETCH_GAP_MS);
    await workspaces.idle();
    expect(git.commands).not.toContain("fetch");
    clock.advance(FETCH_INTERVAL_MS - FOCUS_FETCH_GAP_MS - 1);
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

  it("does not fetch the repository a plain folder project sits in, only a repository's own", async () => {
    const repo = await scene();
    const inner = join(repo.repo, "docs");
    await mkdir(inner);
    const git = countingGit();
    const { projects, workspaces } = await services({ git });
    await projects.add(inner);
    await projects.add(repo.repo);

    workspaces.windowFocused();
    await workspaces.idle();

    expect(git.commands.filter((command) => ["remote", "fetch"].includes(command))).toStrictEqual(["remote", "fetch"]);
  });

  it("fetches a repository whose directory name ends in a space", async () => {
    const repo = await scene();
    const spaced = join(repo.root, "spaced ");
    await repo.git(repo.root, "clone", "--quiet", repo.origin, spaced);
    const git = countingGit();
    const { projects, workspaces } = await services({ git });
    await projects.add(spaced);

    workspaces.windowFocused();
    await workspaces.idle();

    expect(git.commands.filter((command) => command === "fetch")).toStrictEqual(["fetch"]);
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
    expect(records.filter((record) => record["msg"] === "fetch failed")).toMatchObject([
      { level: "info", projectId: id, command: "rev-parse", reason: "timeout" },
    ]);
  });

  it("logs whole anything else that fails a scan or a fetch, as a host bug", async () => {
    const repo = await scene();
    const git = breakableGit();
    const { projects, workspaces, records } = await services({ git });
    const id = await projects.add(repo.repo);
    workspaces.start();
    await workspaces.idle();

    git.break(new TypeError("a bug"));
    workspaces.windowFocused();
    await workspaces.idle();

    const bug = { type: "TypeError", message: "a bug" };
    expect(records.filter((record) => record["msg"] === "workspace scan failed")).toMatchObject([
      { level: "warn", projectId: id, err: bug },
    ]);
    expect(records.filter((record) => record["msg"] === "fetch failed")).toMatchObject([
      { level: "info", projectId: id, err: bug },
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

  it("lists an archived worktree as it was checked out then, works out no merge state for it, and gives no directory for it", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    const detached = await repo.worktree("detached");
    await repo.git(detached, "checkout", "--quiet", "--detach");
    const head = await repo.git(detached, "rev-parse", "HEAD");
    // A worktree whose directory had gone before it was archived: neither branch nor commit.
    const gone = await repo.worktree("gone");
    const git = countingGit();
    const { projects, workspaces } = await services({ git });
    await projects.add(repo.repo);
    workspaces.start();
    await workspaces.idle();
    const idOf = (dir: string) =>
      present(
        workspaces.list().find((workspace) => workspace.dir === dir),
        dir,
      ).id;
    const [local, featureId, detachedId, goneId] = [idOf(repo.repo), idOf(feature), idOf(detached), idOf(gone)];

    await projects.setArchived(featureId, { at: 5, branch: "feature", head });
    await projects.setArchived(detachedId, { at: 6, branch: null, head });
    await projects.setArchived(goneId, { at: 7, branch: null, head: null });
    await repo.git(repo.repo, "worktree", "remove", "--", feature);
    const before = git.commands.length;
    workspaces.windowFocused();
    await workspaces.idle();

    expect(workspaces.list().slice(1).toSorted(byArchivedAt)).toStrictEqual([
      {
        id: featureId,
        projectId: expect.any(String),
        kind: "worktree",
        dir: feature,
        alias: null,
        branch: "feature",
        head: null,
        external: true,
        createdAt: null,
        merge: null,
        archivedAt: 5,
      },
      {
        id: detachedId,
        projectId: expect.any(String),
        kind: "worktree",
        dir: detached,
        alias: null,
        branch: null,
        head: head.slice(0, 7),
        external: true,
        createdAt: null,
        merge: null,
        archivedAt: 6,
      },
      {
        id: goneId,
        projectId: expect.any(String),
        kind: "worktree",
        dir: gone,
        alias: null,
        branch: null,
        head: null,
        external: true,
        createdAt: null,
        merge: null,
        archivedAt: 7,
      },
    ]);
    expect(workspaces.list()[0]?.archivedAt).toBeNull();
    expect(git.commands.slice(before)).not.toContain("status");
    expect([local, featureId].map((id) => workspaces.dirOf(id))).toStrictEqual([repo.repo, undefined]);
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
      { level: "info", projectId: id, code: 128 },
    ]);
    await rename(join(repo.repo, ".git-away"), join(repo.repo, ".git"));
  });

  it("keeps what it knew of a repository git now reads as part of the one around it", async () => {
    const repo = await scene();
    await repo.worktree("feature");
    const { projects, workspaces, records } = await services();
    const id = await projects.add(repo.repo);
    workspaces.start();
    await workspaces.idle();
    const before = workspaces.list();

    await rename(join(repo.repo, ".git"), join(repo.repo, ".git-away"));
    await repo.git(repo.root, "init", "--quiet");
    workspaces.refresh(present(before[0], "workspace").id);
    await workspaces.idle();

    expect(workspaces.list()).toStrictEqual(before);
    // Skipped, not failed: the only record.
    expect(records).toMatchObject([{ level: "info", msg: "workspace scan skipped", projectId: id, code: 0 }]);
  });
});

describe("WorkspaceService at its edges", () => {
  it("scans only a project just added, not those it already knew", async () => {
    const repo = await scene();
    const plain = join(repo.root, "plain");
    await mkdir(plain);
    const git = countingGit();
    const { projects, workspaces } = await services({ git });
    await projects.add(repo.repo);
    workspaces.start();
    await workspaces.idle();
    const before = git.commands.length;

    await projects.add(plain);
    await workspaces.idle();

    // One to tell what the folder is when adding it, one to scan it.
    expect(git.commands.slice(before)).toStrictEqual(["rev-parse", "rev-parse"]);
  });

  it("lists a bare repository's worktrees, but not the bare repository itself", async () => {
    const repo = await scene();
    const first = join(repo.root, "first");
    const second = join(repo.root, "second");
    await repo.git(repo.origin, "worktree", "add", "--quiet", first, "main");
    await repo.git(repo.origin, "worktree", "add", "--quiet", "-b", "other", second, "main");
    const { projects, workspaces } = await services();
    await projects.add(first);

    workspaces.start();
    await workspaces.idle();

    expect(workspaces.list().map(({ kind, dir, branch, createdAt }) => [kind, dir, branch, createdAt])).toStrictEqual([
      ["local", first, "main", null],
      ["worktree", second, "other", expect.any(Number)],
    ]);
  });

  it("finds when worktrees were made in a repository whose folder name ends in a space", async () => {
    const repo = await scene();
    const bare = join(repo.root, "bare ");
    await repo.git(repo.root, "clone", "--quiet", "--bare", repo.origin, bare);
    const first = join(repo.root, "first");
    const second = join(repo.root, "second");
    await repo.git(bare, "worktree", "add", "--quiet", first, "main");
    await repo.git(bare, "worktree", "add", "--quiet", "-b", "other", second, "main");
    const { projects, workspaces } = await services();
    await projects.add(first);

    workspaces.start();
    await workspaces.idle();

    expect(workspaces.list()[1]?.createdAt).toStrictEqual(expect.any(Number));
  });

  it("shows as removed a worktree git no longer lists, and a locked one whose directory went", async () => {
    const repo = await scene();
    const unlisted = await repo.worktree("unlisted");
    const locked = await repo.worktree("locked");
    await repo.git(repo.repo, "worktree", "lock", locked);
    const { projects, workspaces } = await services();
    await projects.add(repo.repo);
    workspaces.start();
    await workspaces.idle();

    await rm(join(repo.repo, ".git", "worktrees", "wt-unlisted"), { recursive: true });
    await rm(locked, { recursive: true });
    workspaces.refresh(present(workspaces.list()[0], "workspace").id);
    await workspaces.idle();

    // In the order git first listed them.
    expect(shape(workspaces.list()).slice(1)).toStrictEqual([
      { kind: "worktree", dir: locked, branch: "locked", head: null, external: true, merge: clean("removed") },
      { kind: "worktree", dir: unlisted, branch: null, head: null, external: true, merge: clean("removed") },
    ]);
  });

  it("works out whether a worktree is dirty after a fetch when it is new or has come back", async () => {
    const repo = await scene();
    const back = await repo.worktree("back");
    const clock = new FakeClock();
    const { projects, workspaces } = await services({ clock });
    await projects.add(repo.repo);
    workspaces.start();
    await workspaces.idle();
    await rename(back, `${back}-away`);
    workspaces.refresh(present(workspaces.list()[1], "workspace").id);
    await workspaces.idle();
    expect(workspaces.list()[1]?.merge).toStrictEqual(clean("removed"));

    await rename(`${back}-away`, back);
    await writeFile(join(back, "edit.txt"), "x");
    const fresh = await repo.worktree("fresh");
    await writeFile(join(fresh, "edit.txt"), "x");
    clock.advance(FETCH_INTERVAL_MS);
    await workspaces.idle();

    const dirty = { dirty: true, ahead: 0, verdict: "noChange", reason: null };
    expect(workspaces.list().map(({ dir, merge }) => [dir, merge])).toStrictEqual([
      [repo.repo, null],
      [back, dirty],
      [fresh, dirty],
    ]);
  });

  it("works merge states out in full after a fetch when, started again, it could not read the repository at first", async () => {
    const repo = await scene();
    const feature = await repo.worktree("feature");
    await writeFile(join(feature, "edit.txt"), "x");
    const clock = new FakeClock();
    const before = await services({ clock });
    await before.projects.add(repo.repo);
    await before.workspaces.idle();
    await before.workspaces.close();

    await rename(join(repo.repo, ".git"), join(repo.repo, ".git-away"));
    const { workspaces } = watch(before.projects, countingGit(), clock);
    workspaces.start();
    await workspaces.idle();
    await rename(join(repo.repo, ".git-away"), join(repo.repo, ".git"));
    clock.advance(FETCH_INTERVAL_MS);
    await workspaces.idle();

    expect(shape(workspaces.list())).toStrictEqual([
      { kind: "local", dir: repo.repo, branch: "main", head: null, external: false, merge: null },
      {
        kind: "worktree",
        dir: feature,
        branch: "feature",
        head: null,
        external: true,
        merge: { dirty: true, ahead: 0, verdict: "noChange", reason: null },
      },
    ]);
  });

  it("runs one fetch at a time, and fetches again every interval", async () => {
    const repo = await scene();
    const clock = new FakeClock();
    const git = countingGit();
    const { projects, workspaces } = await services({ clock, git });
    await projects.add(repo.repo);
    workspaces.start();
    await workspaces.idle();
    const fetches = () => git.commands.filter((command) => command === "fetch").length;

    workspaces.windowFocused();
    clock.advance(FETCH_INTERVAL_MS);
    await workspaces.idle();
    expect(fetches()).toBe(1);
    clock.advance(FETCH_INTERVAL_MS);
    await workspaces.idle();
    expect(fetches()).toBe(2);
  });

  it("gives a fetch two minutes, and git's usual deadline to the rest", async () => {
    const repo = await scene();
    const git = countingGit();
    const { projects, workspaces } = await services({ git });
    await projects.add(repo.repo);

    workspaces.windowFocused();
    await workspaces.idle();

    expect(git.runs.filter(({ command }) => ["remote", "fetch"].includes(command))).toStrictEqual([
      { command: "remote", timeoutMs: undefined },
      { command: "fetch", timeoutMs: 120_000 },
    ]);
  });

  it("logs nothing of a scan it stopped by closing", async () => {
    const repo = await scene();
    const git = interceptingGit();
    const { projects, workspaces, records } = await services({ git });
    let closing = Promise.resolve();
    git.before("worktree", () => {
      closing = workspaces.close();
    });

    await projects.add(repo.repo);
    await workspaces.idle();
    await closing;

    expect(workspaces.list()[0]?.branch).toBeNull();
    expect(records).toStrictEqual([]);
  });

  it("logs nothing of a fetch it stopped by closing", async () => {
    const repo = await scene();
    const clock = new FakeClock();
    const git = interceptingGit();
    const { projects, workspaces, records } = await services({ clock, git });
    await projects.add(repo.repo);
    workspaces.start();
    await workspaces.idle();
    let closing = Promise.resolve();
    git.before("remote", () => {
      closing = workspaces.close();
    });

    clock.advance(FETCH_INTERVAL_MS);
    await workspaces.idle();
    await closing;

    expect(git.commands.filter((command) => command === "fetch")).toStrictEqual([]);
    expect(records).toStrictEqual([]);
  });

  it("runs no git for a fetch that was about to start when it closed", async () => {
    const repo = await scene();
    const clock = new FakeClock();
    const git = countingGit();
    const { projects, workspaces } = await services({ clock, git });
    await projects.add(repo.repo);
    workspaces.start();
    await workspaces.idle();
    const before = git.commands.length;

    clock.advance(FETCH_INTERVAL_MS);
    await workspaces.close();

    expect(git.commands.slice(before)).toStrictEqual([]);
  });
});
