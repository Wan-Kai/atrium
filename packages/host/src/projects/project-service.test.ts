import { CommandError } from "@atrium/protocol";
import { GIT_SCENE_ENV, createGitScene, createTempDir, present } from "@atrium/testkit";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { systemClock } from "../platform/clock";
import { type GitRunner, GitError, createGitRunner } from "../platform/git";
import { ResourceTracker } from "../platform/resources";
import { loadIndexFile } from "../store/index-file";
import { PROJECTS_FILE } from "../store/index-schema";
import { createProjectService } from "./project-service";

/**
 * A temporary directory removed after the test.
 *
 * @remarks
 * Holds the index and the directories added as projects.
 *
 * @sideEffects Creates the directory.
 * @param prefix - Readable prefix.
 * @returns Its real path.
 */
async function tempDir(prefix: string): Promise<string> {
  const dir = await createTempDir(prefix);
  onTestFinished(dir.cleanup);
  // The system's temporary folder is reached through a link on macOS; projects keep real paths.
  return realpath(dir.path);
}

/** Real git with the scenes' environment. */
const realGit = (): GitRunner =>
  createGitRunner({ env: GIT_SCENE_ENV, clock: systemClock, resources: new ResourceTracker() });

/**
 * A project service over a fresh index, with ids counted up.
 *
 * @remarks
 * Ids are predictable so assertions can name them.
 *
 * @sideEffects Creates the index directory.
 * @param git - The git runner, or `null` without git.
 * @returns The service, the index directory and the change count.
 */
async function service(git: GitRunner | null = realGit()) {
  const index = await tempDir("index");
  const { file } = await loadIndexFile(index, PROJECTS_FILE, 0);
  let next = 0;
  const projects = createProjectService({
    file,
    git: Promise.resolve(git),
    newId: (prefix) => `${prefix}_${String((next += 1)).padStart(16, "0")}`,
  });
  const changes = { count: 0 };
  projects.onChange(() => (changes.count += 1));
  return { projects, index, changes };
}

/**
 * Makes a plain directory to add.
 *
 * @remarks
 * Named so tests can check the project's default name.
 *
 * @sideEffects Creates the directory.
 * @param parent - Where.
 * @param name - Its name.
 * @returns Its path.
 */
async function folder(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  await mkdir(path, { recursive: true });
  return path;
}

describe("ProjectService.add", () => {
  it("registers a directory with its local workspace, named after it, and writes the index", async () => {
    const { projects, index, changes } = await service();
    const dir = await folder(await tempDir("work"), "app");

    const id = await projects.add(dir);

    expect(id).toBe("prj_0000000000000001");
    expect(projects.projects()).toStrictEqual([{ id, path: dir, name: "app", mainBranch: null }]);
    expect(projects.workspaces()).toStrictEqual([
      {
        id: "wks_0000000000000002",
        projectId: id,
        kind: "local",
        dir,
        alias: null,
        baseCommit: null,
        external: false,
      },
    ]);
    expect(changes.count).toBe(1);
    expect(JSON.parse(await readFile(join(index, "projects.json"), "utf8"))).toStrictEqual({
      version: 1,
      projects: projects.projects(),
      workspaces: projects.workspaces(),
    });
  });

  it("keeps the real path of a directory reached through a link", async () => {
    const { projects } = await service();
    const work = await tempDir("work");
    const dir = await folder(work, "real");
    await symlink(dir, join(work, "link"));

    await projects.add(join(work, "link"));

    expect(projects.projects().map((project) => [project.path, project.name])).toStrictEqual([[dir, "real"]]);
  });

  it("refuses a path that is missing or not a directory", async () => {
    const { projects, changes } = await service();
    const work = await tempDir("work");
    await writeFile(join(work, "file"), "");

    await expect(projects.add(join(work, "missing"))).rejects.toStrictEqual(
      new CommandError("path_not_found", { path: join(work, "missing") }),
    );
    await expect(projects.add(join(work, "file"))).rejects.toStrictEqual(
      new CommandError("path_not_found", { path: join(work, "file") }),
    );
    expect(changes.count).toBe(0);
  });

  it("refuses a directory that is a project already, even when two adds race", async () => {
    const { projects } = await service();
    const dir = await folder(await tempDir("work"), "app");
    const first = await projects.add(dir);

    await expect(projects.add(dir)).rejects.toStrictEqual(new CommandError("project_exists", { projectId: first }));
    const raced = await Promise.allSettled([projects.add(await folder(dir, "..")), projects.add(join(dir, ".."))]);
    expect(raced.map((result) => result.status).toSorted()).toStrictEqual(["fulfilled", "rejected"]);
  });

  it("refuses a worktree of a registered repository", async () => {
    const repo = await createGitScene("projects");
    onTestFinished(repo.cleanup);
    const worktree = await repo.worktree("feature");
    const { projects } = await service();
    const id = await projects.add(repo.repo);

    await expect(projects.add(worktree)).rejects.toStrictEqual(new CommandError("project_exists", { projectId: id }));
  });

  it("registers the repository a chosen worktree belongs to, and refuses that repository afterwards", async () => {
    const repo = await createGitScene("projects");
    onTestFinished(repo.cleanup);
    const worktree = await repo.worktree("feature");
    const main = await realpath(repo.repo);
    const { projects } = await service();

    const id = await projects.add(worktree);

    expect(projects.projects()).toStrictEqual([{ id, path: main, name: "repo", mainBranch: null }]);
    expect(projects.workspaces().map((workspace) => [workspace.kind, workspace.dir])).toStrictEqual([["local", main]]);
    await expect(projects.add(repo.repo)).rejects.toStrictEqual(new CommandError("project_exists", { projectId: id }));
  });

  it("registers one project when a repository and its worktree are added at once", async () => {
    const repo = await createGitScene("projects");
    onTestFinished(repo.cleanup);
    const worktree = await repo.worktree("feature");
    const { projects } = await service();
    await projects.add(await folder(await tempDir("work"), "other"));

    const results = await Promise.allSettled([projects.add(repo.repo), projects.add(worktree)]);

    expect(results.map((result) => result.status)).toStrictEqual(["fulfilled", "rejected"]);
    expect(projects.projects().map((project) => project.name)).toStrictEqual(["other", "repo"]);
  });

  it("refuses a worktree already recorded as a workspace, without asking git", async () => {
    const { projects } = await service(null);
    const work = await tempDir("work");
    const id = await projects.add(await folder(work, "app"));
    await projects.recordWorktrees(id, [await folder(work, "app-feature")]);

    await expect(projects.add(join(work, "app-feature"))).rejects.toStrictEqual(
      new CommandError("project_exists", { projectId: id }),
    );
  });

  it("takes a subdirectory of a repository, or any directory when git is missing or fails, as a plain one", async () => {
    const repo = await createGitScene("projects");
    onTestFinished(repo.cleanup);
    const sub = await folder(repo.repo, "packages");
    const { projects } = await service();
    await projects.add(repo.repo);

    await projects.add(sub);
    const without = await service(null);
    await without.projects.add(repo.repo);
    await without.projects.add(await repo.worktree("feature"));
    const failing = await service({ run: () => Promise.reject(new GitError("rev-parse", "spawn")) });
    await failing.projects.add(repo.repo);

    expect(projects.projects().map((project) => project.name)).toStrictEqual(["repo", "packages"]);
    expect(without.projects.projects()).toHaveLength(2);
    expect(failing.projects.projects()).toHaveLength(1);
  });

  it("numbers a name that is taken", async () => {
    const { projects } = await service();
    const work = await tempDir("work");

    for (const parent of ["a", "b", "c"]) await projects.add(await folder(join(work, parent), "app"));

    expect(projects.projects().map((project) => project.name)).toStrictEqual(["app", "app (1)", "app (2)"]);
  });
});

describe("ProjectService.remove", () => {
  it("forgets a project and its workspaces, returning them, and leaves the disk alone", async () => {
    const { projects, changes } = await service(null);
    const work = await tempDir("work");
    const keep = await projects.add(await folder(work, "keep"));
    const gone = await projects.add(await folder(work, "gone"));
    await projects.recordWorktrees(gone, [await folder(work, "gone-feature")]);

    const removed = await projects.remove(gone);

    expect(removed).toStrictEqual(["wks_0000000000000004", "wks_0000000000000005"]);
    expect(projects.projects().map((project) => project.id)).toStrictEqual([keep]);
    expect(projects.workspaces().map((workspace) => workspace.projectId)).toStrictEqual([keep]);
    expect(changes.count).toBe(4);
    await expect(readFile(join(work, "gone-feature"), "utf8")).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("refuses an unknown project", async () => {
    const { projects } = await service(null);

    await expect(projects.remove("prj_ffffffffffffffff")).rejects.toStrictEqual(
      new CommandError("project_not_found", {
        projectId: "prj_ffffffffffffffff",
      }),
    );
  });
});

describe("ProjectService.rename", () => {
  it("renames a project, to its own name too, but not to another's", async () => {
    const { projects } = await service(null);
    const work = await tempDir("work");
    const app = await projects.add(await folder(work, "app"));
    await projects.add(await folder(work, "web"));

    await projects.rename(app, "应用");
    await projects.rename(app, "应用");

    await expect(projects.rename(app, "web")).rejects.toStrictEqual(new CommandError("name_taken", { name: "web" }));
    await expect(projects.rename("prj_ffffffffffffffff", "x")).rejects.toStrictEqual(
      new CommandError("project_not_found", {
        projectId: "prj_ffffffffffffffff",
      }),
    );
    expect(projects.projects().map((project) => project.name)).toStrictEqual(["应用", "web"]);
  });
});

describe("ProjectService.renameWorkspace", () => {
  it("names a workspace and clears the name", async () => {
    const { projects } = await service(null);
    const id = await projects.add(await folder(await tempDir("work"), "app"));
    const local = present(projects.workspaces()[0], "the local workspace").id;

    await projects.renameWorkspace(local, "侧栏");
    expect(projects.workspaces().map((workspace) => workspace.alias)).toStrictEqual(["侧栏"]);
    await projects.renameWorkspace(local, null);
    expect(projects.workspaces().map((workspace) => [workspace.projectId, workspace.alias])).toStrictEqual([
      [id, null],
    ]);
  });

  it("refuses an unknown workspace", async () => {
    const { projects } = await service(null);

    await expect(projects.renameWorkspace("wks_ffffffffffffffff", "x")).rejects.toStrictEqual(
      new CommandError("workspace_not_found", {
        workspaceId: "wks_ffffffffffffffff",
      }),
    );
  });
});

describe("ProjectService.recordWorktrees", () => {
  it("records worktrees it has not seen as external, once, and only for a registered project", async () => {
    const { projects, changes } = await service(null);
    const work = await tempDir("work");
    const id = await projects.add(await folder(work, "app"));

    await projects.recordWorktrees(id, [join(work, "app"), join(work, "wt-a"), join(work, "wt-b")]);
    await projects.recordWorktrees(id, [join(work, "wt-a")]);
    await projects.recordWorktrees("prj_ffffffffffffffff", [join(work, "wt-c")]);

    expect(projects.workspaces().map((workspace) => [workspace.kind, workspace.dir, workspace.external])).toStrictEqual(
      [
        ["local", join(work, "app"), false],
        ["worktree", join(work, "wt-a"), true],
        ["worktree", join(work, "wt-b"), true],
      ],
    );
    expect(changes.count).toBe(2);
  });
});

describe("ProjectService.onChange", () => {
  it("stops calling a listener that unsubscribed", async () => {
    const { projects } = await service(null);
    let calls = 0;
    const stop = projects.onChange(() => (calls += 1));
    const work = await tempDir("work");

    await projects.add(await folder(work, "a"));
    stop();
    await projects.add(await folder(work, "b"));

    expect(calls).toBe(1);
  });
});
