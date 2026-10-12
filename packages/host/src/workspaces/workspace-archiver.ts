import { CommandError } from "@atrium/protocol";
import { stat } from "node:fs/promises";
import type { Clock } from "../platform/clock";
import type { GitRunner } from "../platform/git";
import type { Logger } from "../platform/logger";
import type { ProjectService } from "../projects/project-service";
import type { WorkspaceRecord } from "../store/index-schema";
import { type ListedWorktree, parseWorktreeList } from "./worktree-list";

/** Archives worktree workspaces and brings them back (SPEC-0001, "M1.11 的工作区归档"). */
export interface WorkspaceArchiver {
  /** Removes a worktree workspace's directory, keeping its branch, and archives it with its sessions. */
  archive(workspaceId: string): Promise<void>;
  /** Adds an archived workspace's worktree back where it was, and shows the workspace again. */
  restore(workspaceId: string): Promise<void>;
}

/** What archiving a workspace does to the sessions in it. */
export interface WorkspaceSessions {
  /** Stops the pi of every session in the workspace. */
  stopWorkspace(workspaceId: string): Promise<void>;
  /** Archives every session in the workspace, stopping its pi, and drops the workspace from every layout. */
  archiveWorkspace(workspaceId: string): Promise<void>;
}

/**
 * Creates the workspace archiver.
 *
 * @remarks
 * Follows SPEC-0001 ("M1.11 的工作区归档") and security.md ("子进程与文件"):
 * - only a worktree is archived; its directory goes by `git worktree remove` without `--force`,
 *   and its branch and commits stay in the repository;
 * - nothing is lost: a worktree with changes, untracked files included, or detached at a commit
 *   no branch, remote branch or tag holds is refused before anything happens, checked by git on
 *   the spot rather than by the last scan;
 * - its sessions' pi stop before the removal, and the sessions are archived only once the
 *   directory is gone; a worktree whose directory had already gone is archived without git;
 * - restoring adds the worktree back on its branch, or detached at its commit, after pruning
 *   registrations whose directories are gone; one already back is only shown again;
 * - the directory only ever comes from the index, after `--`; logs carry the workspace's id and
 *   git's exit code, never paths or branches.
 *
 * One archive or restore runs at a time.
 *
 * @sideEffects none until a call; then runs git, removes or adds worktrees, stops and archives
 * sessions, writes `projects.json` and logs.
 * @param options - The projects, git (or `null` without it), the sessions, how to scan a
 * workspace's project again, the clock and the logger.
 * @returns The archiver.
 */
export function createWorkspaceArchiver(options: {
  readonly projects: ProjectService;
  readonly git: Promise<GitRunner | null>;
  readonly sessions: WorkspaceSessions;
  readonly refresh: (workspaceId: string) => void;
  readonly clock: Clock;
  readonly logger: Logger;
}): WorkspaceArchiver {
  /** The last archive or restore, which the next one waits for. */
  let last: Promise<unknown> = Promise.resolve();

  /**
   * Runs one archive or restore once those before it have ended.
   *
   * @remarks
   * Two at once could both pass their checks for one workspace.
   *
   * @sideEffects Runs `work` later.
   * @param work - The archive or restore.
   * @returns What it returns.
   */
  function oneAtATime(work: () => Promise<void>): Promise<void> {
    const next = last.then(work);
    last = next.catch(() => undefined);
    return next;
  }

  /**
   * A workspace's record.
   *
   * @remarks
   * An unknown id is the client's mistake.
   *
   * @sideEffects none
   * @param workspaceId - The workspace.
   * @returns The record.
   * @throws {CommandError} `workspace_not_found`.
   */
  function recordOf(workspaceId: string): WorkspaceRecord {
    const record = options.projects.workspaces().find((candidate) => candidate.id === workspaceId);
    if (record === undefined) throw new CommandError("workspace_not_found", { workspaceId });
    return record;
  }

  /**
   * Runs git for a workspace, in its project's directory unless told otherwise.
   *
   * @remarks
   * Worktrees are listed, removed and added from the repository.
   *
   * @sideEffects none until called; then runs git.
   * @param record - The workspace.
   * @param git - git.
   * @returns The runner.
   */
  function runnerOf(record: WorkspaceRecord, git: GitRunner) {
    // A workspace's record goes with its project's, so the project is always there.
    // Stryker disable next-line StringLiteral,OptionalChaining: never used, as the line above says.
    const path = options.projects.projects().find((project) => project.id === record.projectId)?.path ?? "";
    return (args: string[], cwd = path) => git.run(args, { cwd });
  }

  /**
   * git, or the failure given without it.
   *
   * @remarks
   * Without git no worktree can be checked, removed or added.
   *
   * @sideEffects none
   * @param failure - The error code without git.
   * @returns git.
   * @throws {CommandError} `failure`.
   */
  async function gitOr(failure: "worktree_remove_failed" | "worktree_restore_failed"): Promise<GitRunner> {
    const git = await options.git;
    if (git === null) throw new CommandError(failure);
    return git;
  }

  /**
   * Where git lists the workspace's worktree, and the same again if its directory is there.
   *
   * @remarks
   * A worktree git does not list has lost its directory; so has one git lists without it, which
   * git marks prunable unless it is locked.
   *
   * @sideEffects Runs git; reads the file system.
   * @param record - The workspace.
   * @param run - Runs git.
   * @param failure - The error code when git cannot list worktrees.
   * @returns The listed worktree, if any, and it again when present.
   * @throws {CommandError} `failure`.
   */
  async function listedOf(
    record: WorkspaceRecord,
    run: (args: string[]) => Promise<{ readonly code: number; readonly stdout: string }>,
    failure: "worktree_remove_failed" | "worktree_restore_failed",
  ): Promise<{ listed: ListedWorktree | undefined; present: ListedWorktree | undefined }> {
    const listing = await run(["worktree", "list", "--porcelain"]);
    if (listing.code !== 0) {
      options.logger.warn({ workspaceId: record.id, code: listing.code }, "worktree list failed");
      throw new CommandError(failure);
    }
    const listed = parseWorktreeList(listing.stdout).find((worktree) => worktree.dir === record.dir);
    return { listed, present: listed !== undefined && (await isDirectory(record.dir)) ? listed : undefined };
  }

  return {
    archive: (workspaceId) =>
      oneAtATime(async () => {
        const record = recordOf(workspaceId);
        if (record.kind === "local") throw new CommandError("workspace_is_local", { workspaceId });
        if ((record.archived ?? null) !== null) return;
        const run = runnerOf(record, await gitOr("worktree_remove_failed"));
        const { listed, present } = await listedOf(record, run, "worktree_remove_failed");
        if (present !== undefined) {
          const status = await run(["status", "--porcelain"], record.dir);
          if (status.code !== 0) {
            options.logger.warn({ workspaceId, code: status.code }, "worktree status failed");
            throw new CommandError("worktree_remove_failed");
          }
          if (status.stdout !== "") throw new CommandError("workspace_dirty");
          // Stryker disable next-line ConditionalExpression: a branch holds its own commit, so asking changes nothing.
          if (present.branch === null) {
            // Git prints nothing when no ref holds the commit, and when it fails.
            const holders = await run([
              "for-each-ref",
              // Stryker disable next-line StringLiteral: only keeps git from listing every holder.
              "--count=1",
              "--contains",
              present.head,
              "refs/heads",
              "refs/remotes",
              "refs/tags",
            ]);
            if (holders.stdout === "") throw new CommandError("workspace_unsaved_commits");
          }
        }
        await options.sessions.stopWorkspace(workspaceId);
        if (present !== undefined) {
          const removed = await run(["worktree", "remove", "--", record.dir]);
          if (removed.code !== 0) {
            options.logger.warn({ workspaceId, code: removed.code }, "worktree remove failed");
            throw new CommandError("worktree_remove_failed");
          }
        }
        await options.sessions.archiveWorkspace(workspaceId);
        await options.projects.setArchived(workspaceId, {
          at: options.clock.now(),
          branch: listed?.branch ?? null,
          head: listed?.head ?? null,
        });
      }),
    restore: (workspaceId) =>
      oneAtATime(async () => {
        const record = recordOf(workspaceId);
        const archived = record.archived ?? null;
        if (archived === null) return;
        const run = runnerOf(record, await gitOr("worktree_restore_failed"));
        const { present } = await listedOf(record, run, "worktree_restore_failed");
        if (present === undefined) {
          const target = archived.branch ?? archived.head;
          if (target === null || (await exists(record.dir))) throw new CommandError("worktree_restore_failed");
          // A registration whose directory went would keep git from adding one at the same path.
          await run(["worktree", "prune"]);
          // Given a commit rather than a branch, git adds the worktree detached at it.
          const added = await run(["worktree", "add", "--quiet", "--", record.dir, target]);
          if (added.code !== 0) {
            options.logger.warn({ workspaceId, code: added.code }, "worktree add failed");
            throw new CommandError("worktree_restore_failed");
          }
        }
        await options.projects.setArchived(workspaceId, null);
        options.refresh(workspaceId);
      }),
  };
}

/**
 * Whether a path is an existing directory.
 *
 * @remarks
 * A worktree git still lists may have lost its directory.
 *
 * @sideEffects Reads the file system.
 * @param path - The path.
 * @returns Whether it is a directory.
 */
async function isDirectory(path: string): Promise<boolean> {
  // Stryker disable next-line ArrowFunction: undefined, like null, has no directory.
  return (await stat(path).catch(() => null))?.isDirectory() === true;
}

/**
 * Whether anything is at a path.
 *
 * @remarks
 * A worktree is only added back where nothing is.
 *
 * @sideEffects Reads the file system.
 * @param path - The path.
 * @returns Whether something is there.
 */
async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}
