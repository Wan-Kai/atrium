import { CommandError } from "@atrium/protocol";
import { GIT_SCENE_ENV, type GitScene, createGitScene, createTempDir, present } from "@atrium/testkit";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import { type GitRunner, createGitRunner } from "../platform/git";
import { ResourceTracker } from "../platform/resources";
import { createProjectService } from "../projects/project-service";
import { PROJECTS_FILE } from "../store/index-schema";
import { loadIndexFile } from "../store/index-file";
import { WORKTREE_TIMEOUT_MS } from "./workspace-archiver";
import { createWorktreeCreator } from "./worktree-creator";
import { createWorktreeQueue } from "./worktree-queue";

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
  const built = await createGitScene("create");
  onTestFinished(built.cleanup);
  const root = await realpath(built.root);
  return { ...built, root, repo: join(root, "repo"), origin: join(root, "origin.git") };
}

/** Real git with the scenes' environment. */
const realGit = (): GitRunner =>
  createGitRunner({ env: GIT_SCENE_ENV, clock: systemClock, resources: new ResourceTracker() });

/**
 * A creator over a project registered at the scene's repository, after a plain folder's project.
 *
 * @remarks
 * git and the index are real; the scans asked for are recorded.
 *
 * @sideEffects Creates the index directory and the plain folder.
 * @param repo - The scene.
 * @param git - git, or `null` for none.
 * @returns The creator, the services, the projects' ids, the queue, the scans asked for and logs.
 */
async function creator(repo: GitScene, git: GitRunner | null = realGit()) {
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
  const plainId = await projects.add(other);
  const projectId = await projects.add(repo.repo);
  const refreshed: string[] = [];
  const queue = createWorktreeQueue();
  const { logger, records } = recordingTracing();
  const create = createWorktreeCreator({
    projects,
    git: Promise.resolve(git),
    queue,
    refresh: (workspaceId) => refreshed.push(workspaceId),
    logger,
  });
  return { create, projects, projectId, plainId, queue, refreshed, records };
}

/**
 * The error a promise rejects with.
 *
 * @sideEffects none
 * @param promise - The promise.
 * @returns Its error's code and parameters.
 */
async function failure(promise: Promise<unknown>): Promise<{ code: string; params: unknown }> {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CommandError);
  const { code, params } = error as CommandError;
  return { code, params };
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

describe("createWorktreeCreator: create", () => {
  it("adds a worktree on a new branch next to the repository, from the base's commit, and records it as Atrium's", async () => {
    const repo = await scene();
    // The local main moves on, so starting from origin/main is seen to start there.
    const upstream = await repo.git(repo.repo, "rev-parse", "origin/main");
    await repo.commit(repo.repo, "local.txt", "local\n");
    const { create, projects, projectId, refreshed, records } = await creator(repo);

    const workspaceId = await create.create(projectId, "atrium/brave-otter", "origin/main");

    const dir = join(repo.root, "repo.worktrees", "brave-otter");
    expect(projects.workspaces().find((record) => record.id === workspaceId)).toStrictEqual({
      id: workspaceId,
      projectId,
      kind: "worktree",
      dir,
      alias: null,
      baseCommit: upstream,
      external: false,
    });
    expect(await repo.git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("atrium/brave-otter");
    expect(await repo.git(dir, "rev-parse", "HEAD")).toBe(upstream);
    // Started from a commit, the branch tracks nothing: a push never goes to main.
    expect(await repo.git(repo.repo, "config", "--get-regexp", "^branch\\.atrium/").catch(() => "")).toBe("");
    expect(refreshed).toStrictEqual([workspaceId]);
    expect(records.filter((record) => record["msg"] === "worktree created")).toMatchObject([
      { projectId, workspaceId },
    ]);
    expect(JSON.stringify(records)).not.toContain("brave-otter");
  });

  it("gives git as long to add the worktree as to remove one, and its usual time to everything else", async () => {
    const repo = await scene();
    const seen: unknown[][] = [];
    const { create, projectId } = await creator(repo, timedGit(seen));
    // Adding the projects ran git too.
    const before = seen.length;

    await create.create(projectId, "fix", "main");

    expect(seen.slice(before)).toStrictEqual([
      ["rev-parse --show-toplevel", null],
      ["check-ref-format --branch", null],
      ["rev-parse --verify", null],
      ["show-ref --verify", null],
      ["worktree add", WORKTREE_TIMEOUT_MS],
    ]);
  });

  it("starts from a local branch, and names the folder after the branch's last segment", async () => {
    const repo = await scene();
    const local = await repo.commit(repo.repo, "local.txt", "local\n");
    const { create, projects, projectId } = await creator(repo);

    const workspaceId = await create.create(projectId, "fix", "main");

    const record = present(
      projects.workspaces().find((one) => one.id === workspaceId),
      "the workspace",
    );
    expect(record.dir).toBe(join(repo.root, "repo.worktrees", "fix"));
    expect(record.baseCommit).toBe(local);
  });

  it("makes the record a scan just made of the worktree Atrium's own", async () => {
    const repo = await scene();
    const { projects, projectId } = await creator(repo);
    const dir = join(repo.root, "repo.worktrees", "a");
    await projects.recordWorktrees(projectId, [dir]);
    const scanned = present(
      projects.workspaces().find((one) => one.dir === dir),
      "the record",
    ).id;

    expect(await projects.addWorktree(projectId, dir, "abc")).toBe(scanned);
    expect(projects.workspaces().filter((one) => one.dir === dir)).toStrictEqual([
      { id: scanned, projectId, kind: "worktree", dir, alias: null, baseCommit: "abc", external: false },
    ]);
  });

  it.each([
    ["two dots", "a..b"],
    ["a leading dash", "-b"],
    ["the previous branch", "@{-1}"],
    ["a trailing slash", "atrium/"],
  ])("refuses a branch named with %s", async (_case, branch) => {
    const repo = await scene();
    const { create, projectId } = await creator(repo);
    // `@{-1}` names a branch once one was checked out before.
    await repo.git(repo.repo, "checkout", "--quiet", "-b", "other");
    await repo.git(repo.repo, "checkout", "--quiet", "main");

    expect(await failure(create.create(projectId, branch, "main"))).toStrictEqual({
      code: "worktree_create_failed",
      params: { reason: "branch_invalid" },
    });
  });

  it("refuses a base that names no commit, an existing branch, and a taken folder", async () => {
    const repo = await scene();
    const { create, projectId } = await creator(repo);
    await repo.git(repo.repo, "branch", "taken");
    await mkdir(join(repo.root, "repo.worktrees", "here"), { recursive: true });

    expect(await failure(create.create(projectId, "a", "origin/nothing"))).toStrictEqual({
      code: "worktree_create_failed",
      params: { reason: "base_missing", base: "origin/nothing" },
    });
    expect(await failure(create.create(projectId, "a", "--all"))).toStrictEqual({
      code: "worktree_create_failed",
      params: { reason: "base_missing", base: "--all" },
    });
    expect(await failure(create.create(projectId, "taken", "main"))).toStrictEqual({
      code: "worktree_create_failed",
      params: { reason: "branch_exists", branch: "taken" },
    });
    expect(await failure(create.create(projectId, "atrium/here", "main"))).toStrictEqual({
      code: "worktree_create_failed",
      params: { reason: "dir_taken", dir: join(repo.root, "repo.worktrees", "here") },
    });
  });

  it("refuses the folder of a workspace on record, as an archived one keeps it", async () => {
    const repo = await scene();
    const { create, projects, projectId } = await creator(repo);
    const dir = join(repo.root, "repo.worktrees", "gone");
    await projects.recordWorktrees(projectId, [dir]);

    expect(await failure(create.create(projectId, "gone", "main"))).toStrictEqual({
      code: "worktree_create_failed",
      params: { reason: "dir_taken", dir },
    });
  });

  it("refuses a project that is no repository's top, an unknown project, and creating without git", async () => {
    const repo = await scene();
    const { create, projects, plainId } = await creator(repo);

    expect(await failure(create.create(plainId, "a", "main"))).toStrictEqual({
      code: "worktree_create_failed",
      params: { reason: "not_git" },
    });
    expect(await failure(create.create("prj_ffffffffffffffff", "a", "main"))).toStrictEqual({
      code: "project_not_found",
      params: { projectId: "prj_ffffffffffffffff" },
    });
    // A folder inside the repository is a plain project, whose repository is not its own.
    await mkdir(join(repo.repo, "sub"));
    const inside = await projects.add(join(repo.repo, "sub"));
    expect(await failure(create.create(inside, "a", "main"))).toStrictEqual({
      code: "worktree_create_failed",
      params: { reason: "not_git" },
    });
    const without = await creator(repo, null);
    expect(await failure(without.create.create(without.projectId, "a", "main"))).toStrictEqual({
      code: "worktree_create_failed",
      params: undefined,
    });
  });

  it("says git failed when it cannot add the worktree, logging only its exit code", async () => {
    const repo = await scene();
    const { create, projects, projectId, refreshed, records } = await creator(repo);
    // A file where the worktrees' folder goes: nothing is at the worktree's path, but git cannot make it.
    await writeFile(join(repo.root, "repo.worktrees"), "");

    expect(await failure(create.create(projectId, "a", "main"))).toStrictEqual({
      code: "worktree_create_failed",
      params: undefined,
    });
    expect(projects.workspaces()).toHaveLength(2);
    expect(refreshed).toStrictEqual([]);
    expect(records.filter((record) => record["msg"] === "worktree add failed")).toMatchObject([
      { projectId, code: 128 },
    ]);
  });

  it("waits for the worktree change before it", async () => {
    const repo = await scene();
    const { create, projects, projectId, queue } = await creator(repo);
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const before = queue.run(() => held);

    const creating = create.create(projectId, "a", "main");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(projects.workspaces()).toHaveLength(2);
    release();
    await before;
    await creating;
    expect(projects.workspaces()).toHaveLength(3);
  });
});

describe("createWorktreeCreator: bases", () => {
  it("lists the main branch on origin, the local workspace's branch, and every branch but origin's HEAD", async () => {
    const repo = await scene();
    await repo.git(repo.repo, "branch", "zeta");
    await repo.git(repo.repo, "branch", "alpha");
    await repo.git(repo.repo, "push", "--quiet", "origin", "alpha");
    await repo.git(repo.repo, "fetch", "--quiet", "origin");
    const { create, projectId } = await creator(repo);

    expect(await create.bases(projectId)).toStrictEqual({
      main: "origin/main",
      current: "main",
      local: ["alpha", "main", "zeta"],
      remote: ["origin/alpha", "origin/main"],
    });
  });

  it("follows the project's own main branch, and has none when it is not on origin", async () => {
    const repo = await scene();
    await repo.git(repo.repo, "push", "--quiet", "origin", "main:release");
    await repo.git(repo.repo, "fetch", "--quiet", "origin");
    const { create, projects, projectId } = await creator(repo);

    await projects.setMainBranch(projectId, "release");
    expect((await create.bases(projectId)).main).toBe("origin/release");
    await repo.git(repo.repo, "update-ref", "-d", "refs/remotes/origin/release");
    expect((await create.bases(projectId)).main).toBeNull();
  });

  it("has no main branch without origin/HEAD, and no current branch when detached or before the first commit", async () => {
    const repo = await scene();
    await repo.git(repo.repo, "remote", "set-head", "origin", "--delete");
    await repo.git(repo.repo, "checkout", "--quiet", "--detach");
    const { create, projectId } = await creator(repo);

    expect(await create.bases(projectId)).toStrictEqual({
      main: null,
      current: null,
      local: ["main"],
      remote: ["origin/main"],
    });
    await repo.git(repo.repo, "checkout", "--quiet", "--orphan", "fresh");
    expect((await create.bases(projectId)).current).toBeNull();
  });

  it("refuses a project that is no repository's top", async () => {
    const repo = await scene();
    const { create, plainId } = await creator(repo);

    expect(await failure(create.bases(plainId))).toStrictEqual({
      code: "worktree_create_failed",
      params: { reason: "not_git" },
    });
  });
});
