import type { TaskArchiveFacts } from "@atrium/protocol";
import { basename } from "node:path";
import type { GitRunner } from "../platform/git";
import type { ProjectService } from "../projects/project-service";
import type { MergeInspector } from "../workspaces/merge-inspector";
import { runSafeGit } from "../workspaces/safe-git";
import type { WorkspaceArchiver } from "../workspaces/workspace-archiver";
import { comparedMainRef } from "../workspaces/workspace-service";
import type { Task } from "./types";

/**
 * What the question about archiving a finished task's worktree needs from the host (SPEC-0006, "归档").
 *
 * @remarks
 * The service knows no projects or git; the wiring (`createTaskArchiving`) answers with the workspace archiver.
 */
export interface TaskArchiving {
  /**
   * The facts the question shows, or `null` when the task has no worktree to ask about (it is gone or
   * archived already).
   */
  facts(task: Task, signal: AbortSignal): Promise<TaskArchiveFacts | null>;
  /**
   * Archives the task's worktree through the same path as `archive_workspace`, with its checks.
   *
   * @remarks
   * Fails with that command's codes (`workspace_dirty`, `workspace_unsaved_commits`, …). A worktree that is
   * archived already is not an error.
   */
  archive(task: Task): Promise<void>;
}

/** How long one of the facts' git commands may take. */
const FACT_TIMEOUT_MS = 30_000;

/**
 * Runs one of the facts' git commands in the worktree, without the repository's hooks, filters or fsmonitor.
 *
 * @remarks
 * The worktree is the agent's: `git status` would run a clean filter or an fsmonitor it configured.
 *
 * @sideEffects Runs git.
 * @param git - git.
 * @param cwd - The worktree.
 * @param args - git's arguments.
 * @param signal - Stops git.
 * @returns What git did.
 * @throws {GitError} When git cannot run or time out.
 */
function safely(git: GitRunner, cwd: string, args: readonly string[], signal: AbortSignal) {
  return runSafeGit(git, args, { cwd, signal, timeoutMs: FACT_TIMEOUT_MS }, { rejectIncludes: false });
}

/**
 * Creates the task archiving port.
 *
 * @remarks
 * SPEC-0006, "归档": the facts are the worktree's name, whether its branch is merged (the merge inspector's
 * verdict: merged, or no change at all, is "merged"; pending is not; anything else is not known), whether it has
 * changes that are not committed (`git status` through `runSafeGit`, which runs no fsmonitor or filter) and how
 * many commits it has past where it began. They are worked out when asked, not kept.
 *
 * @sideEffects none until a call; then runs git.
 * @param options - The projects, git, the merge inspector and the workspace archiver.
 * @returns The port.
 */
export function createTaskArchiving(options: {
  readonly projects: Pick<ProjectService, "projects" | "workspaces">;
  readonly git: Promise<GitRunner | null>;
  readonly inspector: Promise<MergeInspector | null>;
  readonly archiver: Pick<WorkspaceArchiver, "archive">;
}): TaskArchiving {
  return {
    async facts(task, signal) {
      const workspace = options.projects.workspaces().find((candidate) => candidate.id === task.workspaceId);
      const project = options.projects.projects().find((candidate) => candidate.id === workspace?.projectId);
      const git = await options.git;
      if (workspace === undefined || project === undefined || git === null || (workspace.archived ?? null) !== null) {
        return null;
      }
      const dir = workspace.dir;
      const status = await safely(git, dir, ["status", "--porcelain"], signal).catch(() => null);
      if (status === null || status.code !== 0) return null;
      const head = await safely(git, dir, ["rev-parse", "--verify", "HEAD"], signal).catch(() => null);
      const branch = await safely(git, dir, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal).catch(() => null);
      const base = workspace.baseCommit ?? task.baseCommit;
      const counted =
        base === null || head?.code !== 0
          ? null
          : await safely(git, dir, ["rev-list", "--count", `${base}..HEAD`], signal).catch(() => null);
      const inspector = await options.inspector;
      const mainRef = await comparedMainRef(project, async (...args) =>
        git.run(args, { cwd: project.path, signal, timeoutMs: FACT_TIMEOUT_MS }).catch(() => null),
      );
      const state =
        inspector === null || head?.code !== 0
          ? null
          : await inspector.inspect(
              {
                repo: project.path,
                dir,
                present: true,
                branch: branch?.code === 0 ? branch.stdout.trim() : null,
                head: head.stdout.trim(),
                baseCommit: base,
                mainRef,
                dirty: status.stdout !== "",
              },
              signal,
            );
      return {
        name: workspace.alias ?? basename(dir),
        merged:
          state === null
            ? null
            : state.verdict === "merged" || state.verdict === "noChange"
              ? true
              : state.verdict === "pending"
                ? false
                : null,
        dirty: status.stdout !== "",
        commits: counted?.code === 0 ? Number(counted.stdout.trim()) || 0 : 0,
      };
    },
    async archive(task) {
      if (task.workspaceId !== null) await options.archiver.archive(task.workspaceId);
    },
  };
}
