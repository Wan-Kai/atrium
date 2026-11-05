import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { GitRunner } from "../platform/git";
import type { ProjectService } from "../projects/project-service";
import { writeAtomically } from "../store/index-file";
import type { WorktreeCreator } from "../workspaces/worktree-creator";
import { lockWorktree, unlockWorktree } from "../workspaces/worktree-lock";
import type { TaskWorkspaces } from "./node-ports";
import type { Task } from "./types";

/** What the task's directory remembers of the worktree it made (`workspace.json`). */
const Marker = z.strictObject({ workspaceId: z.string().min(1) });

/**
 * Creates the task runner's view of workspaces from the worktree creator, the projects and git.
 *
 * @remarks
 * SPEC-0006, "工作区" and "加锁". `ensure` creates the worktree like a child conversation's
 * (`createFrom`, branch `atrium/<name from the task's name>`, from where the source workspace is now) and
 * writes `workspace.json` in the task's directory; run again after a crash it finds the file and the
 * workspace and answers with them instead of creating a second one. SPEC-0006 puts this mark in the
 * workspace index ("由任务 X 创建"); a crash between the creator's return and the file's write still leaves
 * a worktree nobody marks. Locking uses `lockWorktree`, which reads the lock first, so it can be done twice.
 *
 * @sideEffects none until a call; then creates worktrees, writes files in the task's directory and runs git.
 * @param options - The creator, the projects, git, the tasks' root directory, and which container a task's
 * source directory is in.
 * @returns The workspaces.
 */
export function createTaskWorkspaces(options: {
  readonly creator: Pick<WorktreeCreator, "createFrom">;
  readonly projects: Pick<ProjectService, "projects" | "workspaces">;
  readonly git: Promise<GitRunner | null>;
  readonly root: string;
  readonly sourceContainer: (task: Task) => string | undefined;
  readonly dirOf: (workspaceId: string) => string | undefined;
}): TaskWorkspaces {
  /**
   * The worktree and the repository it belongs to.
   *
   * @remarks
   * `lockWorktree` runs in the repository.
   *
   * @sideEffects none
   * @param task - The task.
   * @returns The worktree's directory and its project's, or `undefined` when the task has none.
   */
  function locationOf(task: Task): { dir: string; repo: string } | undefined {
    const workspace = options.projects.workspaces().find((candidate) => candidate.id === task.workspaceId);
    const project = options.projects.projects().find((candidate) => candidate.id === workspace?.projectId);
    return workspace === undefined || project === undefined ? undefined : { dir: workspace.dir, repo: project.path };
  }

  return {
    async ensure(task, signal) {
      const directory = join(options.root, task.id);
      const markerPath = join(directory, "workspace.json");
      const marked = await readFile(markerPath, "utf8").then(
        (text) => Marker.safeParse(JSON.parse(text)),
        () => null,
      );
      const known = marked?.success === true ? marked.data.workspaceId : undefined;
      const found = options.projects.workspaces().find((workspace) => workspace.id === known);
      if (found?.baseCommit != null) return { workspaceId: found.id, baseCommit: found.baseCommit };
      // A worktree the mark names is the task's; one without a base commit is not made again beside it.
      if (found !== undefined) throw new Error("the task's worktree has no base commit");
      signal.throwIfAborted();
      const source = options.sourceContainer(task);
      if (source === undefined) throw new Error("the task's source has no workspace");
      const made = await options.creator.createFrom(source, task.name, "atrium/", task.name, signal);
      const record = options.projects.workspaces().find((workspace) => workspace.id === made.workspaceId);
      if (record?.baseCommit == null) throw new Error("the new worktree has no base commit");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeAtomically(markerPath, `${JSON.stringify({ workspaceId: made.workspaceId })}\n`);
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
  };
}
