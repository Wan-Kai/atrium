import { CommandError, type ProjectId, type WorkspaceId } from "@atrium/protocol";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { GitRunner } from "../platform/git";
import type { IndexFile } from "../store/index-file";
import type { ProjectRecord, ProjectsDocument, WorkspaceArchive, WorkspaceRecord } from "../store/index-schema";

export type { ProjectRecord };

/** Registers projects and their workspaces. */
export interface ProjectService {
  projects(): readonly ProjectRecord[];
  workspaces(): readonly WorkspaceRecord[];
  /** Registers a directory as a project with its local workspace. */
  add(path: string): Promise<ProjectId>;
  /** Forgets a project and its workspaces; returns the workspaces forgotten. */
  remove(projectId: string): Promise<WorkspaceId[]>;
  rename(projectId: string, name: string): Promise<void>;
  /** Names a workspace, or with `null` goes back to its branch's name. */
  renameWorkspace(workspaceId: string, alias: string | null): Promise<void>;
  /** Marks a workspace archived, as given, or with `null` not archived. */
  setArchived(workspaceId: string, archived: WorkspaceArchive | null): Promise<void>;
  /** The branches on a project's `origin`, by name, and the one `origin/HEAD` points at. */
  branches(projectId: string): Promise<{ branches: string[]; head: string | null }>;
  /** Chooses a project's main branch on `origin`, or with `null` follows `origin/HEAD` again. */
  setMainBranch(projectId: string, branch: string | null): Promise<void>;
  /** Registers worktrees found in a project that have no record yet, as external. */
  recordWorktrees(projectId: string, dirs: readonly string[]): Promise<void>;
  /** Registers a worktree Atrium just created, with the commit it started at; returns its workspace. */
  addWorktree(projectId: string, dir: string, baseCommit: string): Promise<WorkspaceId>;
  /** Calls `listener` after every change; returns a function that stops it. */
  onChange(listener: () => void): () => void;
}

/**
 * Creates the project service over `projects.json`.
 *
 * @remarks
 * Follows domain-model §1 and SPEC-0001 ("项目、工作区与会话"):
 * - a project's path is its real path; adding a directory that is a registered project or one
 *   of its workspaces, or a worktree of a registered repository, fails with `project_exists`;
 * - a project is a git project only when its directory is the top of a repository; any other
 *   directory, a subdirectory of a repository included, is a plain one without worktrees;
 * - a project's name defaults to its directory's, numbered `app (1)` when taken; renaming to a
 *   taken name fails with `name_taken`;
 * - removing a project forgets it and its workspaces; nothing on disk changes;
 * - a worktree Atrium created is recorded with its starting commit; a scan may have recorded it
 *   as external just before, and that record becomes Atrium's (SPEC-0001, "M1.11 的新建工作区").
 *
 * Each change is written before the call returns.
 *
 * @sideEffects none until a call; then reads directories, runs git and writes `projects.json`.
 * @param options - The loaded file, the git runner (or `null` without git), and an id source.
 * @returns The service.
 */
export function createProjectService(options: {
  readonly file: IndexFile<ProjectsDocument>;
  readonly git: Promise<GitRunner | null>;
  readonly newId: (prefix: "prj" | "wks") => string;
}): ProjectService {
  const listeners = new Set<() => void>();

  /**
   * Writes a new document and tells the listeners.
   *
   * @remarks
   * Every change goes through here.
   *
   * @sideEffects Writes `projects.json`; calls the listeners.
   * @param document - The new document.
   */
  async function save(document: ProjectsDocument): Promise<void> {
    const saving = options.file.save(document);
    for (const listener of listeners) listener();
    await saving;
  }

  /**
   * Finds a project.
   *
   * @remarks
   * An unknown id is the client's mistake.
   *
   * @sideEffects none
   * @param projectId - The id.
   * @returns The project.
   * @throws {CommandError} `project_not_found`.
   */
  function projectOf(projectId: string): ProjectRecord {
    const project = options.file.read().projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new CommandError("project_not_found", { projectId });
    return project;
  }

  /**
   * The branches on a project's `origin`, and the one `origin/HEAD` points at.
   *
   * @remarks
   * For choosing the main branch in the settings (SPEC-0001, "设置 · 接口"): what was last
   * fetched, without `HEAD`. A folder that is not a repository, or no git, has none.
   *
   * @sideEffects Runs git.
   * @param projectId - The project.
   * @returns The branches by name, and `origin/HEAD`'s, or `null`.
   * @throws {CommandError} `project_not_found`.
   */
  async function branchesOf(projectId: string): Promise<{ branches: string[]; head: string | null }> {
    const { path } = projectOf(projectId);
    const git = await options.git;
    if (git === null) return { branches: [], head: null };
    const prefix = "refs/remotes/origin/";
    const [refs, head] = await Promise.all([
      // Stryker disable next-line ArrowFunction: `?.` below treats `undefined` as it does `null`.
      git.run(["for-each-ref", "--format=%(refname)", prefix], { cwd: path }).catch(() => null),
      // Stryker disable next-line ArrowFunction: `?.` below treats `undefined` as it does `null`.
      git.run(["symbolic-ref", "--quiet", `${prefix}HEAD`], { cwd: path }).catch(() => null),
    ]);
    const branches =
      refs?.code === 0
        ? refs.stdout
            .split("\n")
            .filter((ref) => ref.startsWith(prefix))
            .map((ref) => ref.slice(prefix.length))
            .filter((branch) => branch !== "HEAD")
            .toSorted()
        : [];
    // Stryker disable next-line StringLiteral: any text outside the prefix means no head, as "" does.
    const target = head?.code === 0 ? head.stdout.trim() : "";
    return { branches, head: target.startsWith(prefix) ? target.slice(prefix.length) : null };
  }

  /**
   * Changes some fields of a workspace's record.
   *
   * @remarks
   * Its name and whether it is archived are kept in the index alone.
   *
   * @sideEffects Writes `projects.json`; calls the listeners.
   * @param workspaceId - The workspace.
   * @param change - The fields to set.
   * @throws {CommandError} `workspace_not_found`.
   */
  async function changeWorkspace(
    workspaceId: string,
    change: Partial<Pick<WorkspaceRecord, "alias" | "archived">>,
  ): Promise<void> {
    const document = options.file.read();
    if (!document.workspaces.some((workspace) => workspace.id === workspaceId)) {
      throw new CommandError("workspace_not_found", { workspaceId });
    }
    await save({
      ...document,
      workspaces: document.workspaces.map((workspace) =>
        workspace.id === workspaceId ? { ...workspace, ...change } : workspace,
      ),
    });
  }

  /** The last add, which the next one waits for. */
  let adding: Promise<unknown> = Promise.resolve();

  /**
   * Registers a directory as a project, once earlier adds have finished.
   *
   * @remarks
   * See `createProjectService`. A linked worktree registers the repository it belongs to, and
   * shows up as one of its workspaces once scanned (SPEC-0001, "项目、工作区与会话").
   *
   * @sideEffects Reads directories; runs git; writes `projects.json`.
   * @param requested - The directory asked for.
   * @returns The new project's id.
   * @throws {CommandError} `path_not_found` or `project_exists`.
   */
  async function addNow(requested: string): Promise<ProjectId> {
    const chosen = await realpath(requested).catch(() => null);
    const info = chosen === null ? null : await stat(chosen).catch(() => null);
    if (
      // Stryker disable next-line ConditionalExpression: `info` is null whenever `chosen` is, so the test below alone throws the same error.
      chosen === null ||
      // Stryker disable next-line OptionalChaining: `stat` fails on a path `realpath` just resolved only if it is removed in between, a race no test can set up.
      info?.isDirectory() !== true
    ) {
      throw new CommandError("path_not_found", { path: requested });
    }
    const git = await options.git;
    const repository = git === null ? null : await repositoryOf(git, chosen);
    const path = repository?.main ?? chosen;
    const others = new Map<string, string | null>();
    if (git !== null && repository !== null) {
      for (const project of options.file.read().projects)
        others.set(project.id, (await repositoryOf(git, project.path))?.common ?? null);
    }
    // Checked after every wait, so two adds of one directory cannot both pass.
    const document = options.file.read();
    const known =
      document.workspaces.find((workspace) => workspace.dir === path)?.projectId ??
      document.projects.find((project) => repository !== null && others.get(project.id) === repository.common)?.id;
    if (known !== undefined) throw new CommandError("project_exists", { projectId: known });
    const names = new Set(document.projects.map((project) => project.name));
    const base = basename(path);
    let name = base;
    for (let number = 1; names.has(name); number += 1) name = `${base} (${number})`;
    const id = options.newId("prj");
    const local = { id: options.newId("wks"), projectId: id, kind: "local" as const, dir: path };
    await save({
      ...document,
      projects: [...document.projects, { id, path, name, mainBranch: null }],
      workspaces: [...document.workspaces, { ...local, alias: null, baseCommit: null, external: false }],
    });
    return id;
  }

  return {
    projects: () => options.file.read().projects,
    workspaces: () => options.file.read().workspaces,
    add(requested) {
      // One at a time, so two adds of one repository cannot both pass its checks.
      const added = adding.then(() => addNow(requested));
      adding = added.catch(() => undefined);
      return added;
    },
    async remove(projectId) {
      projectOf(projectId);
      const document = options.file.read();
      const removed = document.workspaces.filter((workspace) => workspace.projectId === projectId);
      await save({
        ...document,
        projects: document.projects.filter((project) => project.id !== projectId),
        workspaces: document.workspaces.filter((workspace) => workspace.projectId !== projectId),
      });
      return removed.map((workspace) => workspace.id);
    },
    async rename(projectId, name) {
      projectOf(projectId);
      const document = options.file.read();
      if (document.projects.some((project) => project.id !== projectId && project.name === name)) {
        throw new CommandError("name_taken", { name });
      }
      await save({
        ...document,
        projects: document.projects.map((project) => (project.id === projectId ? { ...project, name } : project)),
      });
    },
    renameWorkspace: (workspaceId, alias) => changeWorkspace(workspaceId, { alias }),
    setArchived: (workspaceId, archived) => changeWorkspace(workspaceId, { archived }),
    branches: branchesOf,
    async setMainBranch(projectId, branch) {
      if (branch !== null && !(await branchesOf(projectId)).branches.includes(branch)) {
        throw new CommandError("branch_not_found", { branch });
      }
      projectOf(projectId);
      const document = options.file.read();
      await save({
        ...document,
        projects: document.projects.map((project) =>
          project.id === projectId ? { ...project, mainBranch: branch } : project,
        ),
      });
    },
    async recordWorktrees(projectId, dirs) {
      const document = options.file.read();
      if (!document.projects.some((project) => project.id === projectId)) return;
      const known = new Set(document.workspaces.map((workspace) => workspace.dir));
      const added = dirs.filter((dir) => !known.has(dir));
      if (added.length === 0) return;
      await save({
        ...document,
        workspaces: [
          ...document.workspaces,
          ...added.map((dir) => ({
            id: options.newId("wks"),
            projectId,
            kind: "worktree" as const,
            dir,
            alias: null,
            baseCommit: null,
            external: true,
          })),
        ],
      });
    },
    async addWorktree(projectId, dir, baseCommit) {
      projectOf(projectId);
      const document = options.file.read();
      const scanned = document.workspaces.find((workspace) => workspace.dir === dir);
      const id = scanned?.id ?? options.newId("wks");
      const record = { id, projectId, kind: "worktree" as const, dir, alias: null, baseCommit, external: false };
      await save({
        ...document,
        workspaces:
          scanned === undefined
            ? [...document.workspaces, record]
            : document.workspaces.map((workspace) =>
                workspace.id === id ? { ...workspace, baseCommit, external: false } : workspace,
              ),
      });
      return id;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The repository a directory is the top of: where it keeps its objects, and its main worktree.
 *
 * @remarks
 * Every worktree of a repository shares the common directory, so it identifies the repository.
 * The main worktree is the directory holding `.git`; a bare repository has none, and the
 * directory itself stands in.
 *
 * @sideEffects Runs git; reads the main worktree's real path.
 * @param git - The git runner.
 * @param dir - The directory.
 * @returns The common directory and main worktree, or `null` for a directory that is not a
 * repository's top.
 */
async function repositoryOf(git: GitRunner, dir: string): Promise<{ common: string; main: string } | null> {
  const result = await git
    .run(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { cwd: dir })
    .catch(() => null);
  if (result?.code !== 0) return null;
  const [top, common] = result.stdout.trim().split("\n");
  if (top !== dir || common === undefined) return null;
  const main = basename(common) === ".git" ? await realpath(dirname(common)).catch(() => dir) : dir;
  return { common, main };
}
