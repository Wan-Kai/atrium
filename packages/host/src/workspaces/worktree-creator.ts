import { CommandError, type CommandResult } from "@atrium/protocol";
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { GitRunner } from "../platform/git";
import type { Logger } from "../platform/logger";
import type { ProjectRecord, ProjectService } from "../projects/project-service";
import { WORKTREE_TIMEOUT_MS } from "./workspace-archiver";
import { mainBranchRef } from "./workspace-service";
import type { WorktreeQueue } from "./worktree-queue";

/** Creates worktree workspaces (SPEC-0001, "M1.11 的新建工作区"). */
export interface WorktreeCreator {
  /** Where a new worktree of a project may start: its main branch, its local workspace's branch, and every branch. */
  bases(projectId: string): Promise<CommandResult<"list_bases">>;
  /** Creates a worktree on a new branch from a base, next to the project's repository; returns its workspace. */
  create(projectId: string, branch: string, base: string): Promise<string>;
}

/**
 * Creates the worktree creator.
 *
 * @remarks
 * Follows SPEC-0001 ("M1.11 的新建工作区") and security.md ("子进程与文件"):
 * - only a project whose directory is the top of a repository gets worktrees (`not_git`);
 * - the branch must be one git accepts as a new branch's name, which never starts with `-`
 *   (`branch_invalid`), and must not exist yet (`branch_exists`); the base must name a commit
 *   (`base_missing`);
 * - the worktree goes to `<repository's folder>/<repository's name>.worktrees/<branch's last
 *   segment>`, where nothing may be yet, nor a workspace's record, as an archived one keeps its
 *   directory's path (`dir_taken`);
 * - git is given the base's commit rather than its name, so the new branch tracks nothing (a
 *   push never goes to the main branch) and starts where the base was when checked;
 * - the workspace is recorded with that commit, then its project is scanned again;
 * - what the client gives goes to git after `--end-of-options`, or as an option's value once
 *   checked; logs carry ids and git's exit code, never branches or paths.
 *
 * Creating waits in the queue it shares with archiving and restoring.
 *
 * @sideEffects none until a call; then runs git, adds worktrees, writes `projects.json` and logs.
 * @param options - The projects, git (or `null` without it), the queue of worktree changes, how
 * to scan a new workspace's project, and the logger.
 * @returns The creator.
 */
export function createWorktreeCreator(options: {
  readonly projects: Pick<ProjectService, "projects" | "workspaces" | "addWorktree">;
  readonly git: Promise<GitRunner | null>;
  readonly queue: WorktreeQueue;
  readonly refresh: (workspaceId: string) => void;
  readonly logger: Logger;
}): WorktreeCreator {
  /**
   * A project's record.
   *
   * @remarks
   * An unknown id is the client's mistake.
   *
   * @sideEffects none
   * @param projectId - The project.
   * @returns The record.
   * @throws {CommandError} `project_not_found`.
   */
  function projectOf(projectId: string): ProjectRecord {
    const project = options.projects.projects().find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new CommandError("project_not_found", { projectId });
    return project;
  }

  /**
   * Runs git in a project's repository, once it is known to be one.
   *
   * @remarks
   * A folder inside another repository is a plain project (`createProjectService`), and its
   * repository is not the user's to add worktrees to through it.
   *
   * @sideEffects Runs git.
   * @param project - The project.
   * @returns The runner, taking the arguments and how long git may take.
   * @throws {CommandError} `worktree_create_failed`: without git, or `not_git`.
   */
  async function repositoryOf(project: ProjectRecord) {
    const git = await options.git;
    if (git === null) throw new CommandError("worktree_create_failed");
    /**
     * Runs git in the project's directory.
     *
     * @remarks
     * With git's own time limit unless told otherwise.
     *
     * @sideEffects Runs git.
     * @param args - The arguments.
     * @param timeoutMs - How long git may take.
     * @returns What git did.
     */
    const run = (args: string[], timeoutMs?: number) =>
      git.run(args, timeoutMs === undefined ? { cwd: project.path } : { cwd: project.path, timeoutMs });
    const top = await run(["rev-parse", "--show-toplevel"]);
    // Stryker disable next-line ConditionalExpression: git prints no path when it fails, so the second check holds too.
    if (top.code !== 0 || top.stdout.trim() !== project.path) {
      throw new CommandError("worktree_create_failed", { reason: "not_git" });
    }
    return run;
  }

  /**
   * The names of the refs under a prefix, without it.
   *
   * @remarks
   * Full names, rather than git's short ones, which change when two refs look alike.
   *
   * @sideEffects Runs git.
   * @param run - Runs git in the repository.
   * @param prefix - The refs' prefix, ending in `/`.
   * @returns The names, sorted.
   */
  async function refsUnder(run: Awaited<ReturnType<typeof repositoryOf>>, prefix: string): Promise<string[]> {
    const refs = await run(["for-each-ref", "--format=%(refname)", prefix]);
    if (refs.code !== 0) return [];
    return refs.stdout
      .split("\n")
      .filter((ref) => ref.startsWith(prefix))
      .map((ref) => ref.slice(prefix.length))
      .toSorted();
  }

  /**
   * Checks what creating would need, and adds the worktree.
   *
   * @remarks
   * See `createWorktreeCreator`.
   *
   * @sideEffects Runs git; adds the worktree; reads the file system; logs git's failure.
   * @param project - The project.
   * @param branch - The new branch.
   * @param base - Where it starts.
   * @returns The worktree's directory and the commit it started at.
   * @throws {CommandError} `worktree_create_failed`.
   */
  async function add(project: ProjectRecord, branch: string, base: string) {
    const run = await repositoryOf(project);
    // git refuses a name starting with `-` here too, so none reaches `worktree add` as an option.
    const named = await run(["check-ref-format", "--branch", branch]);
    // `--branch` also expands `@{-1}` and the like, which is no new branch's name.
    if (named.code !== 0 || named.stdout.trim() !== branch) {
      throw new CommandError("worktree_create_failed", { reason: "branch_invalid" });
    }
    // `^{commit}` already keeps the base from matching an option; `--end-of-options` makes sure.
    // Stryker disable next-line StringLiteral: no base found reads differently without it, as the comment above says.
    const commit = await run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`]);
    if (commit.code !== 0) throw new CommandError("worktree_create_failed", { reason: "base_missing", base });
    // Stryker disable next-line StringLiteral: without it git matches the name's tail, which only a branch ending in this whole name would.
    const taken = await run(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (taken.code === 0) throw new CommandError("worktree_create_failed", { reason: "branch_exists", branch });
    const dir = join(
      dirname(project.path),
      `${basename(project.path)}.worktrees`,
      branch.slice(branch.lastIndexOf("/") + 1),
    );
    const recorded = options.projects.workspaces().some((workspace) => workspace.dir === dir);
    if (recorded || (await stat(dir).catch(() => null)) !== null) {
      throw new CommandError("worktree_create_failed", { reason: "dir_taken", dir });
    }
    const start = commit.stdout.trim();
    const added = await run(["worktree", "add", "--quiet", "-b", branch, "--", dir, start], WORKTREE_TIMEOUT_MS);
    if (added.code !== 0) {
      options.logger.warn({ projectId: project.id, code: added.code }, "worktree add failed");
      throw new CommandError("worktree_create_failed");
    }
    return { dir, start };
  }

  return {
    async bases(projectId) {
      const project = projectOf(projectId);
      const run = await repositoryOf(project);
      const [local, remote, main, current] = await Promise.all([
        refsUnder(run, "refs/heads/"),
        refsUnder(run, "refs/remotes/"),
        mainBranchRef(project, async (...args) => run(args)),
        run(["symbolic-ref", "--quiet", "HEAD"]),
      ]);
      const listed = remote.filter((name) => !name.endsWith("/HEAD"));
      const mainName = main?.slice("refs/remotes/".length) ?? null;
      // Stryker disable next-line ConditionalExpression,StringLiteral: detached, git prints nothing, and no branch has no name.
      const head = current.code === 0 ? current.stdout.trim().slice("refs/heads/".length) : "";
      return {
        main: listed.find((name) => name === mainName) ?? null,
        // A branch with no commit yet is not listed, and nothing can start there.
        current: local.includes(head) ? head : null,
        local,
        remote: listed,
      };
    },
    create: (projectId, branch, base) =>
      options.queue.run(async () => {
        const project = projectOf(projectId);
        const { dir, start } = await add(project, branch, base);
        const workspaceId = await options.projects.addWorktree(projectId, dir, start);
        options.logger.info({ projectId, workspaceId }, "worktree created");
        options.refresh(workspaceId);
        return workspaceId;
      }),
  };
}
