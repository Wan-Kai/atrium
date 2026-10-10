import { z } from "zod";
import { WorkspaceId } from "./ids";

/**
 * A workspace's git changes, as the capsule above the input box shows them (SPEC-0001, "工作区改动").
 *
 * @remarks
 * Lines added and removed from the merge base to the working tree, untracked files counted too.
 */
export const DiffStat = z.strictObject({
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
});
export type DiffStat = z.infer<typeof DiffStat>;

/** What a workspace's changes are, sent whole each time they change. */
export const ChangesUpdatedEvent = z.strictObject({
  type: z.literal("changes_updated"),
  workspaceId: WorkspaceId,
  /** `null` when nothing is shown: no changes, no git, no branch, or nothing to compare with. */
  stat: DiffStat.nullable(),
  /** Whether the working tree has uncommitted changes, untracked files included. */
  dirty: z.boolean(),
  /** Commits on the branch past the merge base. */
  ahead: z.number().int().nonnegative(),
  /** The branch checked out; `null` when detached or not a git repository. */
  branch: z.string().min(1).max(1024).nullable(),
  /** What the branch is compared with, such as `origin/main`; `null` when nothing is. */
  base: z.string().min(1).max(1024).nullable(),
});
export type ChangesUpdatedEvent = z.infer<typeof ChangesUpdatedEvent>;

/** What the changes panel compares: the working tree with HEAD, or the branch's commits with the merge base. */
export const DiffMode = z.enum(["uncommitted", "base"]);
export type DiffMode = z.infer<typeof DiffMode>;

/** One line of a hunk; a removed line has no new number, an added one no old number. */
export const DiffLine = z.strictObject({
  kind: z.enum(["add", "del", "context"]),
  oldNumber: z.number().int().positive().nullable(),
  newNumber: z.number().int().positive().nullable(),
  text: z.string(),
});
export type DiffLine = z.infer<typeof DiffLine>;

/** One `@@` hunk of a file's diff. */
export const DiffHunk = z.strictObject({
  oldStart: z.number().int().nonnegative(),
  oldCount: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newCount: z.number().int().nonnegative(),
  lines: z.array(DiffLine),
});
export type DiffHunk = z.infer<typeof DiffHunk>;

/**
 * One changed file in the changes panel.
 *
 * @remarks
 * A binary file, or one whose diff is too large to show, has no hunks; the counts still stand
 * (SPEC-0001, "工作区改动").
 */
export const DiffFile = z.strictObject({
  /** Relative to the repository's top. */
  path: z.string().min(1).max(4096),
  /** The path before a rename; `null` otherwise. */
  oldPath: z.string().min(1).max(4096).nullable(),
  status: z.enum(["added", "deleted", "modified", "renamed"]),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  content: z.enum(["text", "binary", "too_large"]),
  hunks: z.array(DiffHunk),
});
export type DiffFile = z.infer<typeof DiffFile>;

/** The changes panel's files, sent whole each time they change. */
export const DiffUpdatedEvent = z.strictObject({
  type: z.literal("diff_updated"),
  workspaceId: WorkspaceId,
  mode: DiffMode,
  /** By path. */
  files: z.array(DiffFile),
  /** git's diff was too large to show at all. */
  tooLarge: z.boolean(),
  /** `not_git` for a directory that is not a git repository, `failed` when git could not answer. */
  error: z.enum(["not_git", "failed"]).nullable(),
});
export type DiffUpdatedEvent = z.infer<typeof DiffUpdatedEvent>;

/** What the changes panel looks at. */
export const DiffTarget = z.strictObject({ workspaceId: WorkspaceId, mode: DiffMode });
export type DiffTarget = z.infer<typeof DiffTarget>;
