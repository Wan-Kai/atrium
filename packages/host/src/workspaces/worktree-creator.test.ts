import { CommandError } from "@atrium/protocol";
import {
  GIT_SCENE_ENV,
  type GitScene,
  type GitTrap,
  createGitScene,
  createTempDir,
  plantTraps,
  present,
} from "@atrium/testkit";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import { GitError, type GitRunner, createGitRunner } from "../platform/git";
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
 * @param randomWord - The random word a child's branch falls back on, if a test needs one.
 * @returns The creator, the services, the projects' ids, the queue, the scans asked for and logs.
 */
async function creator(repo: GitScene, git: GitRunner | null = realGit(), randomWord?: () => string) {
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
    ...(randomWord === undefined ? {} : { randomWord }),
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
 * A git command's arguments without the `-c name=value` options in front of the subcommand.
 *
 * @remarks
 * The host puts its safety options there (`runSafeGit`); these tests read the subcommand.
 *
 * @sideEffects none
 * @param args - The arguments.
 * @returns The subcommand and what follows.
 */
function unprefixed(args: readonly string[]): readonly string[] {
  let start = 0;
  while (args[start] === "-c") start += 2;
  return args.slice(start);
}

/**
 * Real git that times out adding a worktree.
 *
 * @sideEffects none until run; then runs git.
 * @returns The runner.
 */
function timingOutWorktree(): GitRunner {
  const git = realGit();
  return {
    run: (args, options) =>
      unprefixed(args)[0] === "worktree" ? Promise.reject(new GitError("worktree", "timeout")) : git.run(args, options),
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
      seen.push([unprefixed(args).slice(0, 2).join(" "), options.timeoutMs ?? null]);
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

    const workspaceId = await create.create(
      projectId,
      "atrium/brave-otter",
      "refs/remotes/origin/main",
      "修复登录超时",
    );

    const dir = join(repo.root, "repo.worktrees", "brave-otter");
    expect(projects.workspaces().find((record) => record.id === workspaceId)).toStrictEqual({
      id: workspaceId,
      projectId,
      kind: "worktree",
      dir,
      alias: "修复登录超时",
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
    expect(JSON.stringify(records)).not.toMatch(/brave-otter|修复登录超时/);
  });

  it("gives git as long to add the worktree as to remove one, and its usual time to everything else", async () => {
    const repo = await scene();
    const seen: unknown[][] = [];
    const { create, projectId } = await creator(repo, timedGit(seen));
    // Adding the projects ran git too.
    const before = seen.length;

    await create.create(projectId, "fix", "refs/heads/main");

    expect(seen.slice(before)).toStrictEqual([
      // The top level is asked through `runSafeGit`, which lists the configuration first.
      ["config --name-only", null],
      ["rev-parse --show-toplevel", null],
      ["check-ref-format --branch", null],
      ["rev-parse --verify", null],
      ["show-ref --verify", null],
      ["config --local", null],
      ["config --local", null],
      ["config --name-only", null],
      ["worktree add", WORKTREE_TIMEOUT_MS],
      ["rev-parse --verify", null],
    ]);
  });

  it("starts from a local branch, and names the folder after the branch's last segment", async () => {
    const repo = await scene();
    const local = await repo.commit(repo.repo, "local.txt", "local\n");
    const { create, projects, projectId } = await creator(repo);

    const workspaceId = await create.create(projectId, "fix", "refs/heads/main");

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

  it("refuses a base that is no full branch name or names no commit, an existing branch, and a taken folder", async () => {
    const repo = await scene();
    const { create, projectId } = await creator(repo);
    await repo.git(repo.repo, "branch", "taken");
    await mkdir(join(repo.root, "repo.worktrees", "here"), { recursive: true });

    // A short name, even of a branch, could be a tag of that name; `--all` is git's option.
    const missing = ["refs/remotes/origin/nothing", "refs/tags/v1", "main", "origin/main", "--all"];
    expect(await Promise.all(missing.map((base) => failure(create.create(projectId, "a", base))))).toStrictEqual(
      missing.map((base) => ({ code: "worktree_create_failed", params: { reason: "base_missing", base } })),
    );
    expect(await failure(create.create(projectId, "taken", "refs/heads/main"))).toStrictEqual({
      code: "worktree_create_failed",
      params: { reason: "branch_exists", branch: "taken" },
    });
    expect(await failure(create.create(projectId, "atrium/here", "refs/heads/main"))).toStrictEqual({
      code: "worktree_create_failed",
      params: { reason: "dir_taken", dir: join(repo.root, "repo.worktrees", "here") },
    });
  });

  it("refuses the folder of a workspace on record, as an archived one keeps it", async () => {
    const repo = await scene();
    const { create, projects, projectId } = await creator(repo);
    const dir = join(repo.root, "repo.worktrees", "gone");
    await projects.recordWorktrees(projectId, [dir]);

    expect(await failure(create.create(projectId, "gone", "refs/heads/main"))).toStrictEqual({
      code: "worktree_create_failed",
      params: { reason: "dir_taken", dir },
    });
  });

  it("refuses a project that is no repository's top, an unknown project, and creating without git", async () => {
    const repo = await scene();
    const { create, projects, plainId } = await creator(repo);

    expect(await failure(create.create(plainId, "a", "refs/heads/main"))).toStrictEqual({
      code: "worktree_create_failed",
      params: { reason: "not_git" },
    });
    expect(await failure(create.create("prj_ffffffffffffffff", "a", "refs/heads/main"))).toStrictEqual({
      code: "project_not_found",
      params: { projectId: "prj_ffffffffffffffff" },
    });
    // A folder inside the repository is a plain project, whose repository is not its own.
    await mkdir(join(repo.repo, "sub"));
    const inside = await projects.add(join(repo.repo, "sub"));
    expect(await failure(create.create(inside, "a", "refs/heads/main"))).toStrictEqual({
      code: "worktree_create_failed",
      params: { reason: "not_git" },
    });
    const without = await creator(repo, null);
    expect(await failure(without.create.create(without.projectId, "a", "refs/heads/main"))).toStrictEqual({
      code: "worktree_create_failed",
      params: undefined,
    });
  });

  it("says git failed when it cannot add the worktree, logging only its exit code", async () => {
    const repo = await scene();
    const { create, projects, projectId, refreshed, records } = await creator(repo);
    // A file where the worktrees' folder goes: nothing is at the worktree's path, but git cannot make it.
    await writeFile(join(repo.root, "repo.worktrees"), "");

    expect(await failure(create.create(projectId, "a", "refs/heads/main"))).toStrictEqual({
      code: "worktree_create_failed",
      params: undefined,
    });
    expect(projects.workspaces()).toHaveLength(2);
    expect(refreshed).toStrictEqual([]);
    expect(records.filter((record) => record["msg"] === "worktree add failed")).toMatchObject([
      { projectId, code: 128 },
    ]);
  });

  it("starts from HEAD", async () => {
    const repo = await scene();
    const head = await repo.commit(repo.repo, "local.txt", "local\n");
    const { create, projects, projectId } = await creator(repo);

    const workspaceId = await create.create(projectId, "fix", "HEAD");

    expect(projects.workspaces().find((record) => record.id === workspaceId)?.baseCommit).toBe(head);
  });

  it("says git failed when git times out, logging only why", async () => {
    const repo = await scene();
    const { create, projects, projectId, records } = await creator(repo, timingOutWorktree());

    expect(await failure(create.create(projectId, "a", "refs/heads/main"))).toStrictEqual({
      code: "worktree_create_failed",
      params: undefined,
    });
    expect(projects.workspaces()).toHaveLength(2);
    expect(records.filter((record) => record["msg"] === "worktree add failed")).toMatchObject([
      { projectId, reason: "timeout" },
    ]);
  });

  it("waits for the worktree change before it", async () => {
    const repo = await scene();
    const { create, projects, projectId, queue } = await creator(repo);
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const before = queue.run(() => held);

    const creating = create.create(projectId, "a", "refs/heads/main");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(projects.workspaces()).toHaveLength(2);
    release();
    await before;
    await creating;
    expect(projects.workspaces()).toHaveLength(3);
  });
});

describe("createWorktreeCreator: bases", () => {
  it("lists the local main branch, the local workspace's branch, and every branch but origin's HEAD", async () => {
    const repo = await scene();
    await repo.git(repo.repo, "branch", "zeta");
    await repo.git(repo.repo, "branch", "alpha");
    await repo.git(repo.repo, "push", "--quiet", "origin", "alpha");
    await repo.git(repo.repo, "fetch", "--quiet", "origin");
    const { create, projectId } = await creator(repo);

    expect(await create.bases(projectId)).toStrictEqual({
      main: "refs/heads/main",
      current: "main",
      local: ["alpha", "main", "zeta"],
      remote: ["origin/alpha", "origin/main"],
    });
  });

  it("lists origin's main branch when there is no local one", async () => {
    const repo = await scene();
    await repo.git(repo.repo, "checkout", "--quiet", "-b", "work");
    await repo.git(repo.repo, "branch", "--quiet", "-D", "main");
    const { create, projectId } = await creator(repo);

    expect(await create.bases(projectId)).toStrictEqual({
      main: "refs/remotes/origin/main",
      current: "work",
      local: ["work"],
      remote: ["origin/main"],
    });
  });

  it("follows the project's own main branch, local first, and has none when it is neither here nor on origin", async () => {
    const repo = await scene();
    await repo.git(repo.repo, "push", "--quiet", "origin", "main:release");
    await repo.git(repo.repo, "fetch", "--quiet", "origin");
    const { create, projects, projectId } = await creator(repo);

    await projects.setMainBranch(projectId, "release");
    expect((await create.bases(projectId)).main).toBe("refs/remotes/origin/release");
    await repo.git(repo.repo, "branch", "--quiet", "release", "origin/release");
    expect((await create.bases(projectId)).main).toBe("refs/heads/release");
    await repo.git(repo.repo, "update-ref", "-d", "refs/remotes/origin/release");
    expect((await create.bases(projectId)).main).toBe("refs/heads/release");
    await repo.git(repo.repo, "branch", "--quiet", "-D", "release");
    expect((await create.bases(projectId)).main).toBeNull();
  });

  it("has no main branch without origin/HEAD, and no current branch when detached or before the first commit", async () => {
    const repo = await scene();
    // A branch on origin named like nothing is no main branch either.
    await repo.git(repo.repo, "push", "--quiet", "origin", "main:null");
    await repo.git(repo.repo, "fetch", "--quiet", "origin");
    await repo.git(repo.repo, "remote", "set-head", "origin", "--delete");
    await repo.git(repo.repo, "checkout", "--quiet", "--detach");
    const { create, projectId } = await creator(repo);

    expect(await create.bases(projectId)).toStrictEqual({
      main: null,
      current: null,
      local: ["main"],
      remote: ["origin/main", "origin/null"],
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

/**
 * The local workspace of a project.
 *
 * @sideEffects none
 * @param projects - The project service.
 * @param projectId - The project.
 * @returns The workspace's id.
 */
const localOf = (projects: Awaited<ReturnType<typeof creator>>["projects"], projectId: string) =>
  present(
    projects.workspaces().find((record) => record.projectId === projectId && record.kind === "local"),
    "the local workspace",
  ).id;

describe("createWorktreeCreator: createFrom", () => {
  it("adds a child the agent opens on an agent/ branch named after its handle (SPEC-0002, 新建 worktree)", async () => {
    const repo = await scene();
    const { create, projects, projectId } = await creator(repo);

    const made = await create.createFrom(localOf(projects, projectId), "audit", "agent/", "审查登录逻辑");

    const dir = join(repo.root, "repo.worktrees", "audit");
    expect(made).toStrictEqual({ workspaceId: expect.any(String), dir, branch: "agent/audit" });
    expect(await repo.git(dir, "branch", "--show-current")).toBe("agent/audit");
    expect(projects.workspaces().find((workspace) => workspace.id === made.workspaceId)?.alias).toBe("审查登录逻辑");
  });

  it("adds a child's worktree from where the workspace is now, on a tidied atrium/ branch, without what it has not committed", async () => {
    const repo = await scene();
    await repo.commit(repo.repo, "local.txt", "local\n");
    const head = await repo.git(repo.repo, "rev-parse", "HEAD");
    await writeFile(join(repo.repo, "dirty.txt"), "not committed\n");
    const { create, projects, projectId, refreshed, records } = await creator(repo);

    const made = await create.createFrom(localOf(projects, projectId), "Fix the Login flow!");

    const dir = join(repo.root, "repo.worktrees", "fix-the-login-flow");
    expect(made).toStrictEqual({ workspaceId: expect.any(String), dir, branch: "atrium/fix-the-login-flow" });
    expect(projects.workspaces().find((record) => record.id === made.workspaceId)).toMatchObject({
      kind: "worktree",
      dir,
      baseCommit: head,
    });
    expect(await repo.git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("atrium/fix-the-login-flow");
    expect(await repo.git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(await repo.git(dir, "status", "--porcelain")).toBe("");
    expect(refreshed).toStrictEqual([made.workspaceId]);
    expect(records.filter((record) => record["msg"] === "worktree created")).toMatchObject([
      { projectId, workspaceId: made.workspaceId },
    ]);
  });

  it("starts from a detached HEAD too", async () => {
    const repo = await scene();
    const first = await repo.git(repo.repo, "rev-parse", "HEAD");
    await repo.commit(repo.repo, "later.txt", "later\n");
    await repo.git(repo.repo, "checkout", "--quiet", "--detach", first);
    const { create, projects, projectId } = await creator(repo);

    const made = await create.createFrom(localOf(projects, projectId), "tests");

    expect(await repo.git(made.dir, "rev-parse", "HEAD")).toBe(first);
  });

  it("goes past a branch or folder taken with -2 to -9, and refuses when all are", async () => {
    const repo = await scene();
    await repo.git(repo.repo, "branch", "atrium/tests");
    await mkdir(join(repo.root, "repo.worktrees", "tests-2"), { recursive: true });
    const { create, projects, projectId } = await creator(repo);
    const local = localOf(projects, projectId);

    expect((await create.createFrom(local, "tests")).dir).toBe(join(repo.root, "repo.worktrees", "tests-3"));
    for (let suffix = 4; suffix <= 8; suffix += 1)
      await repo.git(repo.repo, "branch", `atrium/tests-${String(suffix)}`);
    expect((await create.createFrom(local, "tests")).dir).toBe(join(repo.root, "repo.worktrees", "tests-9"));
    expect(await failure(create.createFrom(local, "tests"))).toStrictEqual({
      code: "worktree_create_failed",
      params: { reason: "branch_exists", branch: "atrium/tests" },
    });
  });

  it("names the branch child- and a random word when the name leaves fewer than 2 characters", async () => {
    const repo = await scene();
    const { create, projects, projectId } = await creator(repo, realGit(), () => "abc123");

    const made = await create.createFrom(localOf(projects, projectId), "补测试");

    expect(await repo.git(made.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("atrium/child-abc123");
  });

  it("goes past a folder a workspace is registered at though it is not on disk, as an archived one's", async () => {
    const repo = await scene();
    const { create, projects, projectId } = await creator(repo);
    await projects.addWorktree(
      projectId,
      join(repo.root, "repo.worktrees", "tests"),
      await repo.git(repo.repo, "rev-parse", "HEAD"),
    );

    expect((await create.createFrom(localOf(projects, projectId), "tests")).dir).toBe(
      join(repo.root, "repo.worktrees", "tests-2"),
    );
  });

  it("names the branch child- and six random hexadecimal digits by itself", async () => {
    const repo = await scene();
    const { create, projects, projectId } = await creator(repo);

    const made = await create.createFrom(localOf(projects, projectId), "补测试");

    expect(await repo.git(made.dir, "rev-parse", "--abbrev-ref", "HEAD")).toMatch(/^atrium\/child-[0-9a-f]{6}$/);
  });

  it("says git failed without git, for a workspace with no commit to start from, and when it cannot add the worktree", async () => {
    const repo = await scene();
    const without = await creator(repo, null);
    expect(
      await failure(without.create.createFrom(localOf(without.projects, without.projectId), "tests")),
    ).toStrictEqual({
      code: "worktree_create_failed",
      params: undefined,
    });

    const timing = await creator(repo, timingOutWorktree());
    expect(await failure(timing.create.createFrom(localOf(timing.projects, timing.projectId), "tests"))).toStrictEqual({
      code: "worktree_create_failed",
      params: undefined,
    });
    expect(timing.records.filter((record) => record["msg"] === "worktree add failed")).toMatchObject([
      { projectId: timing.projectId, reason: "timeout" },
    ]);

    await repo.git(repo.repo, "checkout", "--quiet", "--orphan", "fresh");
    const { create, projects, projectId } = await creator(repo);
    expect(await failure(create.createFrom(localOf(projects, projectId), "tests"))).toStrictEqual({
      code: "worktree_create_failed",
      params: { reason: "base_missing", base: "HEAD" },
    });
  });

  it("refuses a workspace of a plain folder's project and an unknown one as no place for a child", async () => {
    const repo = await scene();
    const { create, projects, plainId } = await creator(repo);

    expect(await failure(create.createFrom(localOf(projects, plainId), "tests"))).toStrictEqual({
      code: "child_place_invalid",
      params: undefined,
    });
    expect(await failure(create.createFrom("wks_unknown", "tests"))).toStrictEqual({
      code: "child_place_invalid",
      params: undefined,
    });
  });
});

/**
 * Real git that runs a step just before the first `worktree` command, and another just after it.
 *
 * @sideEffects none until run; then runs the steps and git.
 * @param before - Done before `worktree add`.
 * @param after - Done after it, with git's reply.
 * @returns The runner.
 */
function aroundWorktreeAdd(before: () => Promise<void>, after: () => Promise<void>): GitRunner {
  const git = realGit();
  return {
    run: async (args, options) => {
      if (unprefixed(args)[0] !== "worktree") return git.run(args, options);
      await before();
      const done = await git.run(args, options);
      await after();
      return done;
    },
  };
}

describe("createWorktreeCreator: hooks, filters and fsmonitor (SPEC-0006, 工作区)", () => {
  const traps: readonly GitTrap[] = ["hook", "filter", "process", "fsmonitor"];

  it.each(traps)("does not run the repository's %s when it creates a worktree", async (trap) => {
    const repo = await scene();
    const planted = await plantTraps(repo, [trap]);
    const { create, projects, projectId } = await creator(repo);

    const workspaceId = await create.create(projectId, "safe", "refs/heads/main");

    expect(await planted.ran()).toStrictEqual([]);
    const record = present(
      projects.workspaces().find((one) => one.id === workspaceId),
      "the workspace",
    );
    expect(await repo.git(record.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("safe");
  });

  it("does not run them when it creates a child's worktree either", async () => {
    const repo = await scene();
    const planted = await plantTraps(repo, traps);
    const { create, projects, projectId } = await creator(repo);

    const made = await create.createFrom(localOf(projects, projectId), "child");

    expect(await planted.ran()).toStrictEqual([]);
    expect(await readFile(join(made.dir, "filtered.txt"), "utf8")).toBe("filtered\n");
  });

  it("does not run a filter only the user's global configuration defines", async () => {
    const repo = await scene();
    const marker = join(repo.root, "global-filter-ran");
    const script = join(repo.root, "global-filter.sh");
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
    const global = join(repo.root, "global.gitconfig");
    await writeFile(global, `[filter "everywhere"]\n\tsmudge = ${script}\n\tclean = ${script}\n`);
    await writeFile(join(repo.repo, ".gitattributes"), "*.md filter=everywhere\n");
    // Committed without the global configuration, so the filter has not run yet.
    await repo.git(repo.repo, "add", "-A");
    await repo.git(repo.repo, "commit", "--quiet", "-m", "attributes");
    const git = createGitRunner({
      env: { ...GIT_SCENE_ENV, GIT_CONFIG_GLOBAL: global },
      clock: systemClock,
      resources: new ResourceTracker(),
    });
    const { create, projectId } = await creator(repo, git);

    await create.create(projectId, "global", "refs/heads/main");

    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

/**
 * Tries to create a worktree and returns the error code, checking nothing was created.
 *
 * @sideEffects Creates a worktree if it is allowed.
 * @param repo - The scene.
 * @returns The error and its parameters.
 */
async function refused(repo: GitScene) {
  const { create, projects, projectId } = await creator(repo);
  const result = await failure(create.create(projectId, "no", "refs/heads/main"));
  expect(projects.workspaces()).toHaveLength(2);
  await expect(stat(join(repo.root, "repo.worktrees", "no"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await repo.git(repo.repo, "branch", "--list", "no")).toBe("");
  return result;
}

describe("createWorktreeCreator: a repository that includes other configuration (SPEC-0006, 工作区)", () => {
  it("refuses include.path", async () => {
    const repo = await scene();
    await repo.git(repo.repo, "config", "include.path", "../elsewhere.gitconfig");
    expect(await refused(repo)).toStrictEqual({ code: "worktree_config_unsafe", params: { reason: "include" } });
  });

  it("refuses includeIf", async () => {
    const repo = await scene();
    await repo.git(repo.repo, "config", `includeIf.gitdir:${repo.repo}/.path`, "../elsewhere.gitconfig");
    expect(await refused(repo)).toStrictEqual({ code: "worktree_config_unsafe", params: { reason: "include" } });
  });

  it("refuses an include in the per-worktree configuration", async () => {
    const repo = await scene();
    await repo.git(repo.repo, "config", "extensions.worktreeConfig", "true");
    await writeFile(join(repo.repo, ".git", "config.worktree"), "[include]\n\tpath = ../elsewhere.gitconfig\n");
    expect(await refused(repo)).toStrictEqual({ code: "worktree_config_unsafe", params: { reason: "include" } });
  });

  it("refuses a filter whose name cannot be turned off", async () => {
    const repo = await scene();
    await repo.git(repo.repo, "config", "filter.a=b.smudge", "cat");
    expect(await refused(repo)).toStrictEqual({ code: "worktree_config_unsafe", params: { reason: "filter_name" } });
  });

  it("refuses for a child's worktree too, saying the same", async () => {
    const repo = await scene();
    await repo.git(repo.repo, "config", "include.path", "../elsewhere.gitconfig");
    const { create, projects, projectId } = await creator(repo);
    expect(await failure(create.createFrom(localOf(projects, projectId), "child"))).toStrictEqual({
      code: "worktree_config_unsafe",
      params: { reason: "include" },
    });
  });

  it("allows a repository that includes nothing, even with the per-worktree configuration on", async () => {
    const repo = await scene();
    await repo.git(repo.repo, "config", "extensions.worktreeConfig", "true");
    await writeFile(join(repo.repo, ".git", "config.worktree"), "[core]\n\tignorecase = true\n");
    const { create, projectId } = await creator(repo);
    await expect(create.create(projectId, "fine", "refs/heads/main")).resolves.toStrictEqual(expect.any(String));
  });

  it("does not mind the user's own global include", async () => {
    const repo = await scene();
    const global = join(repo.root, "global.gitconfig");
    await writeFile(global, "[include]\n\tpath = other.gitconfig\n");
    await writeFile(join(repo.root, "other.gitconfig"), "[core]\n\tignorecase = true\n");
    const git = createGitRunner({
      env: { ...GIT_SCENE_ENV, GIT_CONFIG_GLOBAL: global },
      clock: systemClock,
      resources: new ResourceTracker(),
    });
    const { create, projectId } = await creator(repo, git);
    await expect(create.create(projectId, "fine", "refs/heads/main")).resolves.toStrictEqual(expect.any(String));
  });
});

describe("createWorktreeCreator: the start (SPEC-0006, 工作区)", () => {
  it("starts from the commit the base was when checked, though the branch moves before git adds the worktree", async () => {
    const repo = await scene();
    const first = await repo.git(repo.repo, "rev-parse", "main");
    const git = aroundWorktreeAdd(
      async () => {
        await repo.commit(repo.repo, "moved.txt", "moved\n");
      },
      async () => {},
    );
    const { create, projects, projectId } = await creator(repo, git);

    const workspaceId = await create.create(projectId, "pinned", "refs/heads/main");

    const record = present(
      projects.workspaces().find((one) => one.id === workspaceId),
      "the workspace",
    );
    expect(await repo.git(repo.repo, "rev-parse", "main")).not.toBe(first);
    expect(await repo.git(record.dir, "rev-parse", "HEAD")).toBe(first);
    expect(record.baseCommit).toBe(first);
  });

  it("starts a child from the commit its workspace was at, though that moves before git adds the worktree", async () => {
    const repo = await scene();
    const first = await repo.git(repo.repo, "rev-parse", "HEAD");
    const git = aroundWorktreeAdd(
      async () => {
        await repo.commit(repo.repo, "moved.txt", "moved\n");
      },
      async () => {},
    );
    const { create, projects, projectId } = await creator(repo, git);

    const made = await create.createFrom(localOf(projects, projectId), "pinned");

    expect(await repo.git(made.dir, "rev-parse", "HEAD")).toBe(first);
  });

  it("fails as head_mismatch, leaving the directory and recording nothing, when the worktree is not at its start", async () => {
    const repo = await scene();
    let added = "";
    const git = aroundWorktreeAdd(
      async () => {},
      async () => {
        added = join(repo.root, "repo.worktrees", "off");
        await repo.commit(added, "off.txt", "off\n");
      },
    );
    const { create, projects, projectId, records } = await creator(repo, git);

    expect(await failure(create.create(projectId, "off", "refs/heads/main"))).toStrictEqual({
      code: "worktree_create_failed",
      params: { reason: "head_mismatch" },
    });

    expect(projects.workspaces()).toHaveLength(2);
    expect((await stat(added)).isDirectory()).toBe(true);
    expect(records.filter((record) => record["msg"] === "worktree not at its start")).toMatchObject([{ projectId }]);
  });
});

describe("createWorktreeCreator: .worktreeinclude (SPEC-0006, 工作区)", () => {
  it("takes the ignored files it lists along, and nothing else, whether the worktree is made by a user or for a child", async () => {
    const repo = await scene();
    await writeFile(join(repo.repo, ".gitignore"), ".env\n");
    await writeFile(join(repo.repo, ".worktreeinclude"), ".env\nnot-ignored.txt\n");
    await writeFile(join(repo.repo, ".env"), "SECRET=1\n");
    await writeFile(join(repo.repo, "not-ignored.txt"), "x\n");
    const { create, projects, projectId } = await creator(repo);

    const workspaceId = await create.create(projectId, "env", "refs/heads/main");
    const made = await create.createFrom(localOf(projects, projectId), "env-child");

    const record = present(
      projects.workspaces().find((one) => one.id === workspaceId),
      "the workspace",
    );
    for (const dir of [record.dir, made.dir]) {
      expect(await readFile(join(dir, ".env"), "utf8")).toBe("SECRET=1\n");
      await expect(stat(join(dir, "not-ignored.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("reads .worktreeinclude where the child's workspace is, not in the project's folder", async () => {
    const repo = await scene();
    const { create, projects, projectId } = await creator(repo);
    const parentId = await create.create(projectId, "parent", "refs/heads/main");
    const parent = present(
      projects.workspaces().find((one) => one.id === parentId),
      "the parent",
    );
    await writeFile(join(parent.dir, ".gitignore"), ".env\n");
    await writeFile(join(parent.dir, ".worktreeinclude"), ".env\n");
    await writeFile(join(parent.dir, ".env"), "PARENT=1\n");
    await writeFile(join(repo.repo, ".env"), "PROJECT=1\n");

    const made = await create.createFrom(parentId, "kid");

    expect(await readFile(join(made.dir, ".env"), "utf8")).toBe("PARENT=1\n");
  });

  it("creates the worktree without it when there is no .worktreeinclude", async () => {
    const repo = await scene();
    await writeFile(join(repo.repo, ".gitignore"), ".env\n");
    await writeFile(join(repo.repo, ".env"), "SECRET=1\n");
    const { create, projects, projectId } = await creator(repo);

    const workspaceId = await create.create(projectId, "bare", "refs/heads/main");

    const record = present(
      projects.workspaces().find((one) => one.id === workspaceId),
      "the workspace",
    );
    await expect(stat(join(record.dir, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

/**
 * A creator that goes down when it records the worktree it has just added, the way the host does when it dies there.
 *
 * @remarks
 * Shares the projects of an ordinary creator; only `addWorktree` is cut. The queue is the ordinary creator's, so
 * the two take turns as they would in one host.
 *
 * @sideEffects none until a call.
 * @param made - The ordinary creator's pieces.
 * @param git - git.
 * @returns A creator whose `createFrom` throws "crash" after `git worktree add` and the copying of includes.
 */
function crashingBeforeRecord(made: Awaited<ReturnType<typeof creator>>, git: GitRunner) {
  return createWorktreeCreator({
    projects: {
      projects: () => made.projects.projects(),
      workspaces: () => made.projects.workspaces(),
      addWorktree: () => Promise.reject(new Error("crash")),
    },
    git: Promise.resolve(git),
    queue: made.queue,
    refresh: () => undefined,
    logger: recordingTracing().logger,
  });
}

/**
 * A git that is killed the moment it is asked to add a worktree, while `on` is set.
 *
 * @remarks
 * Everything else is the real git, so the directory and the plan are as a kill leaves them.
 *
 * @sideEffects Runs git.
 * @param state - Whether the kill is on.
 * @returns The runner.
 */
function killingAdd(state: { on: boolean }): GitRunner {
  return {
    async run(args, options) {
      if (state.on && args.includes("worktree") && args.includes("add")) throw new Error("killed");
      return realGit().run(args, options);
    },
  };
}

/** A crash between `git worktree add` and the record: the plan, and the creator that never saw the worktree. */
async function afterCrashedAdd(repo: GitScene) {
  const ordinary = await creator(repo);
  const crashing = crashingBeforeRecord(ordinary, realGit());
  let planned: Parameters<NonNullable<Parameters<typeof ordinary.create.createFrom>[5]>>[0] | undefined;
  await crashing
    .createFrom(localOf(ordinary.projects, ordinary.projectId), "Fix it", "atrium/", null, undefined, (plan) => {
      planned = plan;
      return Promise.resolve();
    })
    .catch(() => undefined);
  return { ...ordinary, plan: present(planned, "the plan") };
}

describe("createWorktreeCreator: planning and adopting (SPEC-0006, T9)", () => {
  it("tells the plan before it adds the worktree: the source, the branch, the directory and the start", async () => {
    const repo = await scene();
    const { create, projects, projectId } = await creator(repo);
    const source = localOf(projects, projectId);
    const plans: { plan: unknown; existed: boolean }[] = [];

    const made = await create.createFrom(source, "Fix it", "atrium/", "Fix it", undefined, async (plan) => {
      plans.push({
        plan,
        existed: await stat(plan.dir).then(
          () => true,
          () => false,
        ),
      });
    });

    expect(plans).toStrictEqual([
      {
        plan: {
          source,
          branch: "atrium/fix-it",
          dir: made.dir,
          start: await repo.git(repo.repo, "rev-parse", "HEAD"),
        },
        existed: false,
      },
    ]);
  });

  it("adds nothing when the plan cannot be written", async () => {
    const repo = await scene();
    const { create, projects, projectId } = await creator(repo);

    await expect(
      create.createFrom(localOf(projects, projectId), "Fix it", "atrium/", null, undefined, () =>
        Promise.reject(new Error("disk full")),
      ),
    ).rejects.toThrow("disk full");

    expect(await repo.git(repo.repo, "worktree", "list", "--porcelain")).not.toContain("fix-it");
    expect(lineCount(await repo.git(repo.repo, "branch", "--list", "atrium/*"))).toBe(0);
  });

  it("finds the worktree again after a crash between adding it and recording it, and records it without making a second", async () => {
    const repo = await scene();
    await writeFile(join(repo.repo, ".gitignore"), ".env\n");
    await writeFile(join(repo.repo, ".worktreeinclude"), ".env\n");
    await writeFile(join(repo.repo, ".env"), "SECRET=1\n");
    const ordinary = await creator(repo);
    const source = localOf(ordinary.projects, ordinary.projectId);
    let planned: Parameters<NonNullable<Parameters<typeof ordinary.create.createFrom>[5]>>[0] | undefined;
    const crashing = crashingBeforeRecord(ordinary, realGit());
    await expect(
      crashing.createFrom(source, "Fix it", "atrium/", null, undefined, (plan) => {
        planned = plan;
        return Promise.resolve();
      }),
    ).rejects.toThrow("crash");
    expect(ordinary.projects.workspaces()).toHaveLength(2);
    const plan = present(planned, "the plan");
    // Whatever the include copy did not finish is made good by the adoption.
    await rm(join(plan.dir, ".env"), { force: true });

    const adopted = await ordinary.create.adopt(plan, { alias: "Fix it" });

    expect(adopted).toStrictEqual({ workspaceId: expect.any(String), dir: plan.dir, branch: "atrium/fix-it" });
    expect(ordinary.projects.workspaces().find((one) => one.dir === plan.dir)).toMatchObject({
      id: present(adopted, "adopted").workspaceId,
      kind: "worktree",
      alias: "Fix it",
      baseCommit: plan.start,
      external: false,
    });
    expect(ordinary.projects.workspaces()).toHaveLength(3);
    expect(ordinary.refreshed).toStrictEqual([present(adopted, "adopted").workspaceId]);
    expect(await readFile(join(plan.dir, ".env"), "utf8")).toBe("SECRET=1\n");
    expect((await repo.git(repo.repo, "worktree", "list", "--porcelain")).match(/^worktree /gmu)).toHaveLength(2);
  });

  it("returns the record that is there after a crash between recording it and writing the task's mark", async () => {
    const repo = await scene();
    const { create, projects, projectId } = await creator(repo);
    let planned: Parameters<NonNullable<Parameters<typeof create.createFrom>[5]>>[0] | undefined;
    const made = await create.createFrom(localOf(projects, projectId), "Fix it", "atrium/", null, undefined, (plan) => {
      planned = plan;
      return Promise.resolve();
    });

    const adopted = await create.adopt(present(planned, "the plan"), {});

    expect(adopted).toStrictEqual(made);
    expect(projects.workspaces()).toHaveLength(3);
  });

  it("adopts a worktree whose lock is the task's own, and refuses one locked for anything else", async () => {
    const repo = await scene();
    const { create, projects, projectId } = await creator(repo);
    let planned: Parameters<NonNullable<Parameters<typeof create.createFrom>[5]>>[0] | undefined;
    const made = await create.createFrom(localOf(projects, projectId), "Fix it", "atrium/", null, undefined, (plan) => {
      planned = plan;
      return Promise.resolve();
    });
    const plan = present(planned, "the plan");
    await repo.git(repo.repo, "worktree", "lock", "--reason", "atrium task tsk_1", made.dir);

    expect(await create.adopt(plan, { allowedLocks: ["atrium task tsk_1"] })).toStrictEqual(made);
    expect(await create.adopt(plan, { allowedLocks: ["atrium task tsk_2"] })).toBeNull();
    expect(await create.adopt(plan, {})).toBeNull();
  });

  it("does not adopt what is not exactly the plan, and a new worktree then goes beside it", async () => {
    const repo = await scene();
    const { create, projects, projectId } = await creator(repo);
    const source = localOf(projects, projectId);
    const crashing = crashingBeforeRecord(await creator(repo), realGit());
    const plans: Parameters<NonNullable<Parameters<typeof create.createFrom>[5]>>[0][] = [];
    await crashing
      .createFrom(source, "Fix it", "atrium/", null, undefined, (plan) => {
        plans.push(plan);
        return Promise.resolve();
      })
      .catch(() => undefined);
    const plan = present(plans[0], "the plan");

    // Nothing is at a directory that was never made.
    expect(await create.adopt({ ...plan, dir: `${plan.dir}-never` }, {})).toBeNull();
    // The branch is not the one planned.
    expect(await create.adopt({ ...plan, branch: "atrium/other" }, {})).toBeNull();
    // It is not at the commit planned.
    expect(await create.adopt({ ...plan, start: "0".repeat(40) }, {})).toBeNull();
    // It has a commit.
    await repo.commit(plan.dir, "extra.txt", "extra\n");
    expect(await create.adopt(plan, {})).toBeNull();
    // A commit undone, but a change not committed.
    await repo.git(plan.dir, "reset", "--hard", "--quiet", plan.start);
    await writeFile(join(plan.dir, "loose.txt"), "x\n");
    expect(await create.adopt(plan, {})).toBeNull();
    expect(projects.workspaces()).toHaveLength(2);

    const next = await create.createFrom(source, "Fix it");

    expect(next.dir).toBe(join(repo.root, "repo.worktrees", "fix-it-2"));
    expect(next.branch).toBe("atrium/fix-it-2");
  });

  it("does not adopt a directory whose checkout belongs to another repository, though the source still lists the worktree (SPEC-0006, T9 / T10 审查后用户定)", async () => {
    const repo = await scene();
    const { create, plan, projects } = await afterCrashedAdd(repo);
    // The source's registration still names the directory, the branch and the start; the checkout there is a clone.
    await rm(plan.dir, { recursive: true, force: true });
    await repo.git(repo.root, "clone", "--quiet", repo.repo, plan.dir);
    await repo.git(plan.dir, "checkout", "--quiet", "-b", plan.branch);
    expect(await repo.git(plan.dir, "rev-parse", "HEAD")).toBe(plan.start);
    expect(await repo.git(plan.dir, "status", "--porcelain")).toBe("");
    expect(await repo.git(repo.repo, "worktree", "list", "--porcelain")).toContain(`worktree ${plan.dir}`);

    expect(await create.adopt(plan, {})).toBeNull();

    expect(projects.workspaces()).toHaveLength(2);
  });

  it("does not adopt a checkout whose work tree git was told to find elsewhere, and does not take that other directory's status for it", async () => {
    const repo = await scene();
    const { create, plan, projects } = await afterCrashedAdd(repo);
    const elsewhere = join(repo.root, "elsewhere");
    await mkdir(elsewhere);
    await repo.git(plan.dir, "config", "extensions.worktreeConfig", "true");
    await repo.git(plan.dir, "config", "--worktree", "core.worktree", elsewhere);
    // The directory is clean as the plan left it; the other directory is not.
    await writeFile(join(elsewhere, "stray.txt"), "x\n");

    expect(await create.adopt(plan, {})).toBeNull();

    expect(projects.workspaces()).toHaveLength(2);
  });

  it("asks git for the worktree list, the top level, the status and the files to copy without running the repository's fsmonitor or filters", async () => {
    const repo = await scene();
    await writeFile(join(repo.repo, ".gitignore"), ".env\n");
    await writeFile(join(repo.repo, ".worktreeinclude"), ".env\n");
    await writeFile(join(repo.repo, ".env"), "SECRET=1\n");
    const { create, plan } = await afterCrashedAdd(repo);
    // The copy that the crashed creation made is gone, as if it had not got that far.
    await rm(join(plan.dir, ".env"), { force: true });
    const planted = await plantTraps(repo, ["fsmonitor", "filter", "process", "hook"]);
    await planted.reset();

    const adopted = await create.adopt(plan, { alias: "Fix it" });

    expect(adopted).not.toBeNull();
    expect(await planted.ran()).toStrictEqual([]);
    expect(await readFile(join(plan.dir, ".env"), "utf8")).toBe("SECRET=1\n");
  });

  it("logs that it adopted a worktree, by project and workspace ids and nothing of the branch or the path", async () => {
    const repo = await scene();
    const { create, plan, records, projectId } = await afterCrashedAdd(repo);

    const adopted = present(await create.adopt(plan, { alias: "Fix it" }), "the adopted worktree");

    expect(records.filter((record) => record["msg"] === "worktree adopted")).toMatchObject([
      { level: "info", projectId, workspaceId: adopted.workspaceId },
    ]);
    expect(JSON.stringify(records)).not.toContain(plan.branch);
  });

  it("does not adopt what a killed `git worktree add` left: a directory git never registered, or one with half a checkout; a new worktree goes beside it", async () => {
    const repo = await scene();
    const killing = { on: true };
    const killedAdd = killingAdd(killing);
    const { create, projects, projectId } = await creator(repo, killedAdd);
    const source = localOf(projects, projectId);
    const plans: Parameters<NonNullable<Parameters<typeof create.createFrom>[5]>>[0][] = [];
    await create
      .createFrom(source, "Fix it", "atrium/", null, undefined, (plan) => {
        plans.push(plan);
        return Promise.resolve();
      })
      .catch(() => undefined);
    killing.on = false;
    const plan = present(plans[0], "the plan");
    expect(await create.adopt(plan, {})).toBeNull();
    // Git got as far as making the directory, and then was killed.
    await mkdir(join(plan.dir, "src"), { recursive: true });
    await writeFile(join(plan.dir, "src", "half.txt"), "half");
    expect(await create.adopt(plan, {})).toBeNull();
    expect(projects.workspaces()).toHaveLength(2);

    const next = await create.createFrom(source, "Fix it");

    expect(next.dir).toBe(join(repo.root, "repo.worktrees", "fix-it-2"));
    // What was left is not removed: it may be the user's.
    expect(await readFile(join(plan.dir, "src", "half.txt"), "utf8")).toBe("half");
  });

  it("does not adopt a worktree that was not made from the planned source, or when there is no git", async () => {
    const repo = await scene();
    const { create, projects, projectId } = await creator(repo);
    const source = localOf(projects, projectId);
    const crashing = crashingBeforeRecord(await creator(repo), realGit());
    let planned: Parameters<NonNullable<Parameters<typeof create.createFrom>[5]>>[0] | undefined;
    await crashing
      .createFrom(source, "Fix it", "atrium/", null, undefined, (plan) => {
        planned = plan;
        return Promise.resolve();
      })
      .catch(() => undefined);
    const plan = present(planned, "the plan");
    const withoutGit = await creator(repo, null);

    expect(await create.adopt({ ...plan, source: "wks_unknown" }, {})).toBeNull();
    expect(await withoutGit.create.adopt(plan, {})).toBeNull();
    expect(await create.adopt({ ...plan, source: "wks_unknown" }, { signal: new AbortController().signal })).toBeNull();
    // Closing stops it before it looks at anything, even a plan it could not have adopted.
    await expect(create.adopt({ ...plan, source: "wks_unknown" }, { signal: AbortSignal.abort() })).rejects.toThrow(
      "aborted",
    );
  });
});

/**
 * How many lines a listing has.
 *
 * @sideEffects none
 * @param listing - git's output.
 * @returns The count.
 */
function lineCount(listing: string): number {
  return listing === "" ? 0 : listing.split("\n").length;
}
