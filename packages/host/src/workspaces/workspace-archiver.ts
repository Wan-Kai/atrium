import { CommandError } from "@atrium/protocol";
import { stat } from "node:fs/promises";
import type { Clock } from "../platform/clock";
import type { GitRunner } from "../platform/git";
import type { Logger } from "../platform/logger";
import type { ProjectService } from "../projects/project-service";
import type { WorkspaceRecord } from "../store/index-schema";
import { type ListedWorktree, parseWorktreeList } from "./worktree-list";
import { type WorktreeQueue, createWorktreeQueue } from "./worktree-queue";

/** Archives worktree workspaces and brings them back (SPEC-0001, "M1.11 的工作区归档"). */
export interface WorkspaceArchiver {
  /** Removes a worktree workspace's directory, keeping its branch, and archives it with its sessions. */
  archive(workspaceId: string): Promise<void>;
  /** Adds an archived workspace's worktree back where it was, and shows the workspace again. */
  restore(workspaceId: string): Promise<void>;
  /** Waits for the archive or restore under way, for the host to stop after it. */
  close(): Promise<void>;
}

/** How long git may take to remove or add a worktree's directory, which may hold a large `node_modules`. */
export const WORKTREE_TIMEOUT_MS = 600_000;

/** What archiving a workspace does to the sessions in it. */
export interface WorkspaceSessions {
  /**
   * Keeps the workspace's sessions from starting, and new ones from being created in it, until
   * released; stops their pi; resolves to those not archived.
   */
  stopWorkspace(workspaceId: string): Promise<string[]>;
  /** Lets the workspace's sessions start again. */
  releaseWorkspace(workspaceId: string): void;
  /** Archives every session in the workspace, stopping its pi, and drops the workspace from every layout. */
  archiveWorkspace(workspaceId: string): Promise<void>;
  /** Unarchives the sessions given, or with `null` all archived in the workspace. */
  restoreWorkspace(workspaceId: string, sessionIds: readonly string[] | null): Promise<void>;
}

/**
 * Creates the workspace archiver.
 *
 * @remarks
 * Follows SPEC-0001 ("M1.11 的工作区归档") and security.md ("子进程与文件"):
 * - only a worktree is archived; its directory goes by `git worktree remove` without `--force`,
 *   and its branch and commits stay in the repository;
 * - nothing is lost: a worktree with changes, untracked files included, or detached at a commit
 *   no branch, remote branch or tag holds is refused, checked by git on the spot rather than by
 *   the last scan: before anything happens, and again once its sessions' pi have stopped, as they
 *   may have changed it meanwhile;
 * - from their pi stopping until it is done or failed, nothing starts the sessions or creates one
 *   in the workspace;
 * - the index marks the workspace archived, with the branch and commit of the second check and
 *   the sessions it archives, before the directory goes, and unmarks it if git will not remove
 *   it; a crash between leaves it archived with its directory there, which restoring only shows
 *   again;
 * - the sessions are archived only once the directory is gone; a worktree whose directory had
 *   already gone is archived without git; restoring unarchives them before unmarking, or all
 *   archived in it for an archive that recorded none;
 * - restoring adds the worktree back on its branch, or detached at its commit, after pruning
 *   registrations whose directories are gone; a branch deleted since is not restored, as git
 *   would start it afresh from a remote one of that name; one already back is only shown again;
 * - removing and adding a directory may take git ten minutes;
 * - the directory only ever comes from the index, after `--`; logs carry the workspace's id and
 *   git's exit code, never paths or branches.
 *
 * One archive or restore runs at a time, and none while a worktree is created when the queue is
 * shared with the creator.
 *
 * @sideEffects none until a call; then runs git, removes or adds worktrees, stops and archives
 * sessions, writes `projects.json` and logs.
 * @param options - The projects, git (or `null` without it), the sessions, how to scan a
 * workspace's project again, the clock, the logger, and the queue of worktree changes (its own
 * unless given).
 * @returns The archiver.
 */
export function createWorkspaceArchiver(options: {
  readonly projects: ProjectService;
  readonly git: Promise<GitRunner | null>;
  readonly sessions: WorkspaceSessions;
  readonly refresh: (workspaceId: string) => void;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly queue?: WorktreeQueue;
}): WorkspaceArchiver {
  const queue = options.queue ?? createWorktreeQueue();

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
   * @returns The runner, taking the arguments, the directory and how long git may take.
   */
  function runnerOf(record: WorkspaceRecord, git: GitRunner) {
    // A workspace's record goes with its project's, so the project is always there.
    // Stryker disable next-line StringLiteral,OptionalChaining: never used, as the line above says.
    const path = options.projects.projects().find((project) => project.id === record.projectId)?.path ?? "";
    return (args: string[], cwd = path, timeoutMs?: number) =>
      git.run(args, timeoutMs === undefined ? { cwd } : { cwd, timeoutMs });
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
    run: ReturnType<typeof runnerOf>,
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

  /**
   * Lists the workspace's worktree and refuses it if archiving would lose anything.
   *
   * @remarks
   * Run before the sessions stop and again after, as they may have changed it meanwhile; see
   * `createWorkspaceArchiver`.
   *
   * @sideEffects Runs git; reads the file system; logs git's failures.
   * @param record - The workspace.
   * @param run - Runs git.
   * @returns The listed worktree, if any, and it again when present.
   * @throws {CommandError} `workspace_dirty`, `workspace_unsaved_commits` or `worktree_remove_failed`.
   */
  async function checked(record: WorkspaceRecord, run: ReturnType<typeof runnerOf>) {
    const listing = await listedOf(record, run, "worktree_remove_failed");
    const { present } = listing;
    if (present === undefined) return listing;
    const status = await run(["status", "--porcelain"], record.dir);
    if (status.code !== 0) {
      options.logger.warn({ workspaceId: record.id, code: status.code }, "worktree status failed");
      throw new CommandError("worktree_remove_failed");
    }
    if (status.stdout !== "") throw new CommandError("workspace_dirty");
    // Stryker disable next-line ConditionalExpression: a branch holds its own commit, so asking changes nothing.
    if (present.branch === null) {
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
      if (holders.code !== 0) {
        options.logger.warn({ workspaceId: record.id, code: holders.code }, "worktree holders failed");
        throw new CommandError("worktree_remove_failed");
      }
      if (holders.stdout === "") throw new CommandError("workspace_unsaved_commits");
    }
    return listing;
  }

  /**
   * Adds an archived workspace's worktree back, refusing what cannot be.
   *
   * @remarks
   * See `createWorkspaceArchiver`; `params.reason` says why for the UI (SPEC-0001, "M1.11 的工作区
   * 归档"), and is absent when git failed.
   *
   * @sideEffects Runs git; adds the worktree; reads the file system; logs git's failures.
   * @param record - The workspace.
   * @param archived - What its archiving recorded.
   * @param run - Runs git.
   * @throws {CommandError} `worktree_restore_failed`.
   */
  async function addBack(
    record: WorkspaceRecord,
    archived: NonNullable<WorkspaceRecord["archived"]>,
    run: ReturnType<typeof runnerOf>,
  ): Promise<void> {
    const target = archived.branch ?? archived.head;
    if (target === null) throw new CommandError("worktree_restore_failed", { reason: "no_branch" });
    if (await exists(record.dir)) throw new CommandError("worktree_restore_failed", { reason: "dir_taken" });
    // A registration whose directory went would keep git from adding one at the same path.
    await run(["worktree", "prune"]);
    if (archived.branch !== null) {
      const branch = await run(["show-ref", "--verify", "--quiet", `refs/heads/${archived.branch}`]);
      if (branch.code !== 0) throw new CommandError("worktree_restore_failed", { reason: "branch_gone" });
    }
    // Given a commit rather than a branch, git adds the worktree detached at it.
    const added = await run(["worktree", "add", "--quiet", "--", record.dir, target], undefined, WORKTREE_TIMEOUT_MS);
    if (added.code !== 0) {
      options.logger.warn({ workspaceId: record.id, code: added.code }, "worktree add failed");
      throw new CommandError("worktree_restore_failed");
    }
  }

  return {
    archive: (workspaceId) =>
      queue.run(async () => {
        const record = recordOf(workspaceId);
        if (record.kind === "local") throw new CommandError("workspace_is_local", { workspaceId });
        if ((record.archived ?? null) !== null) return;
        const run = runnerOf(record, await gitOr("worktree_remove_failed"));
        await checked(record, run);
        const sessions = await options.sessions.stopWorkspace(workspaceId);
        try {
          const { listed, present } = await checked(record, run);
          await options.projects.setArchived(workspaceId, {
            at: options.clock.now(),
            branch: listed?.branch ?? null,
            head: listed?.head ?? null,
            sessions,
          });
          if (present !== undefined) {
            const removed = await run(["worktree", "remove", "--", record.dir], undefined, WORKTREE_TIMEOUT_MS);
            if (removed.code !== 0) {
              options.logger.warn({ workspaceId, code: removed.code }, "worktree remove failed");
              await options.projects.setArchived(workspaceId, null);
              throw new CommandError("worktree_remove_failed");
            }
          }
          await options.sessions.archiveWorkspace(workspaceId);
        } finally {
          options.sessions.releaseWorkspace(workspaceId);
        }
      }),
    restore: (workspaceId) =>
      queue.run(async () => {
        const record = recordOf(workspaceId);
        const archived = record.archived ?? null;
        if (archived === null) return;
        const run = runnerOf(record, await gitOr("worktree_restore_failed"));
        const { present } = await listedOf(record, run, "worktree_restore_failed");
        if (present === undefined) await addBack(record, archived, run);
        await options.sessions.restoreWorkspace(workspaceId, archived.sessions ?? null);
        await options.projects.setArchived(workspaceId, null);
        options.refresh(workspaceId);
      }),
    close: () => queue.idle(),
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
