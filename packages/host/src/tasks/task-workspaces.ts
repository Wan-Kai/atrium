import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { GitError, type GitRunner } from "../platform/git";
import type { ProjectService } from "../projects/project-service";
import { writeAtomically } from "../store/index-file";
import type { MergeInspector } from "../workspaces/merge-inspector";
import { mainBranchRef } from "../workspaces/workspace-service";
import type { WorktreeCreator } from "../workspaces/worktree-creator";
import { clearStaleLocks, lockWorktree, taskLockReason, unlockWorktree } from "../workspaces/worktree-lock";
import { mergeTaskBranch } from "./merge";
import type { TaskWorkspaces } from "./node-ports";
import type { Task } from "./types";

/** What the task's directory remembers of the worktree it is making: where it will be, written before git adds it. */
const Plan = z.strictObject({
  source: z.string().min(1),
  branch: z.string().min(1),
  dir: z.string().min(1),
  start: z.string().min(1),
});

/**
 * What the task's directory remembers of the worktree it made (`workspace.json`).
 *
 * @remarks
 * Either the worktree's workspace, once it is made and recorded, or only the plan, before it is (SPEC-0006,
 * "T9 定下的细节"). They never appear together.
 */
const Marker = z.union([z.strictObject({ workspaceId: z.string().min(1) }), z.strictObject({ planned: Plan })]);

/**
 * Creates the task runner's view of workspaces from the worktree creator, the projects and git.
 *
 * @remarks
 * SPEC-0006, "工作区" and "加锁". `ensure` creates the worktree like a child conversation's
 * (`createFrom`, branch `atrium/<name from the task's name>`, from where the source workspace is now) and
 * writes `workspace.json` in the task's directory; run again after a crash it finds the file and the
 * workspace and answers with them instead of creating a second one. The file is first written as the plan
 * (the creator tells it before git adds anything), so a crash between git and the file leaves a plan that
 * `adopt` can hold the worktree against: it is taken up only if it is exactly what the plan said, never
 * otherwise (SPEC-0006, "T9 定下的细节"). Locking uses `lockWorktree`, which reads the lock first, so it can
 * be done twice. `clearStaleLocks` lifts, when the host starts, the locks of tasks that are over.
 *
 * @sideEffects none until a call; then creates worktrees, writes files in the task's directory and runs git.
 * @param options - The creator, the projects, git, the tasks' root directory, and which container a task's
 * source directory is in.
 * @returns The workspaces.
 */
export function createTaskWorkspaces(options: {
  readonly creator: Pick<WorktreeCreator, "createFrom" | "adopt">;
  readonly projects: Pick<ProjectService, "projects" | "workspaces">;
  readonly git: Promise<GitRunner | null>;
  readonly root: string;
  readonly sourceContainer: (task: Task) => string | undefined;
  readonly dirOf: (workspaceId: string) => string | undefined;
  /** Tells a branch that is already merged; `null` without it (git before 2.38 or none). */
  readonly inspector: Promise<MergeInspector | null>;
}): TaskWorkspaces {
  /**
   * The worktree and the repository it belongs to.
   *
   * @remarks
   * `lockWorktree` runs in the repository.
   *
   * @sideEffects none
   * @param task - The task.
   * @returns The worktree's directory, its project's, the project's own main branch and the commit the
   * worktree was made at, or `undefined` when the task has none.
   */
  function locationOf(task: Task) {
    const workspace = options.projects.workspaces().find((candidate) => candidate.id === task.workspaceId);
    const project = options.projects.projects().find((candidate) => candidate.id === workspace?.projectId);
    return workspace === undefined || project === undefined
      ? undefined
      : { dir: workspace.dir, repo: project.path, mainBranch: project.mainBranch, baseCommit: workspace.baseCommit };
  }

  return {
    async ensure(task, signal) {
      const directory = join(options.root, task.id);
      const markerPath = join(directory, "workspace.json");
      const marked = await readFile(markerPath, "utf8").then(
        (text) => Marker.safeParse(JSON.parse(text)),
        () => null,
      );
      const marker = marked?.success === true ? marked.data : undefined;
      const known = marker !== undefined && "workspaceId" in marker ? marker.workspaceId : undefined;
      const found = options.projects.workspaces().find((workspace) => workspace.id === known);
      if (found?.baseCommit != null) return { workspaceId: found.id, baseCommit: found.baseCommit };
      // A worktree the mark names is the task's; one without a base commit is not made again beside it.
      if (found !== undefined) throw new Error("the task's worktree has no base commit");
      signal.throwIfAborted();
      /**
       * Writes what the marker holds.
       *
       * @remarks
       * Atomically, so a crash leaves the old content or the new, never half.
       *
       * @sideEffects Creates the task's directory if needed; writes `workspace.json`.
       * @param content - The marker.
       */
      const mark = async (content: z.infer<typeof Marker>): Promise<void> => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeAtomically(markerPath, `${JSON.stringify(content)}\n`);
      };
      let made: { readonly workspaceId: string } | null = null;
      if (marker !== undefined && "planned" in marker) {
        // The host died with a worktree under way: it is the task's if, and only if, it is what the plan said.
        made = await options.creator.adopt(marker.planned, {
          alias: task.name,
          allowedLock: taskLockReason(task.id),
          signal,
        });
      }
      if (made === null) {
        const source = options.sourceContainer(task);
        if (source === undefined) throw new Error("the task's source has no workspace");
        made = await options.creator.createFrom(source, task.name, "atrium/", task.name, signal, (plan) =>
          mark({ planned: plan }),
        );
      }
      const record = options.projects.workspaces().find((workspace) => workspace.id === made?.workspaceId);
      if (record?.baseCommit == null) throw new Error("the new worktree has no base commit");
      await mark({ workspaceId: made.workspaceId });
      return { workspaceId: made.workspaceId, baseCommit: record.baseCommit };
    },
    dirOf: options.dirOf,
    containerOf: (task, inWorktree) => (inWorktree ? (task.workspaceId ?? undefined) : options.sourceContainer(task)),
    async lock(task) {
      const where = locationOf(task);
      const git = await options.git;
      if (where !== undefined && git !== null) await lockWorktree(git, where.repo, where.dir, task.id);
    },
    async unlock(task) {
      const where = locationOf(task);
      const git = await options.git;
      if (where !== undefined && git !== null) await unlockWorktree(git, where.repo, where.dir, task.id);
    },
    async clearStaleLocks(isActive) {
      const git = await options.git;
      if (git === null) return 0;
      let lifted = 0;
      for (const project of options.projects.projects()) {
        // A repository git cannot list (gone, or not one any longer) has no locks of ours to lift.
        lifted += await clearStaleLocks(git, project.path, isActive).catch((error: unknown) => {
          if (error instanceof GitError) return 0;
          throw error;
        });
      }
      return lifted;
    },
    async merge(task, signal) {
      const where = locationOf(task);
      const git = await options.git;
      if (where === undefined || git === null) throw new Error("the task has no worktree, or there is no git");
      // The trunk is named as the merge inspector names it: the project's own setting, else `origin/HEAD`.
      const ref = await mainBranchRef({ mainBranch: where.mainBranch }, async (...args) =>
        git.run(args, { cwd: where.repo, signal }).catch(() => null),
      );
      return mergeTaskBranch({
        git,
        inspector: await options.inspector,
        mainDir: where.repo,
        worktreeDir: where.dir,
        baseCommit: where.baseCommit ?? task.baseCommit,
        trunk: ref === null ? null : ref.replace(/^refs\/remotes\/origin\//u, ""),
        signal,
      });
    },
  };
}
