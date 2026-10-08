import type { IndexView } from "@atrium/client";
import type { SessionSummary, Workspace } from "@atrium/protocol";

/**
 * A workspace's name.
 *
 * @remarks
 * `alias ?? branch ?? 目录名` (domain-model §4, SPEC-0001 "命名"): a renamed workspace keeps its
 * name, a detached one or one in a plain directory shows its directory's name.
 *
 * @sideEffects none
 * @param workspace - The workspace.
 * @returns The name.
 */
export function workspaceName(workspace: Pick<Workspace, "alias" | "branch" | "dir">): string {
  return (
    workspace.alias ?? workspace.branch ?? workspace.dir.split("/").findLast((part) => part !== "") ?? workspace.dir
  );
}

/**
 * A session's title.
 *
 * @remarks
 * pi's session name, else the first line of the first prompt (SPEC-0001, "命名"); with neither,
 * a draft is a new session or chat, anything else held only images.
 *
 * @sideEffects none
 * @param session - The session.
 * @returns The title.
 */
export function sessionTitle(session: Pick<SessionSummary, "name" | "prompt" | "state" | "containerId">): string {
  if (session.name !== null) return session.name;
  if (session.prompt !== null) return session.prompt;
  if (session.state === "draft") return session.containerId === "chats" ? "新对话" : "新会话";
  return "图片";
}

/** A worktree's merge state as the sidebar labels it. */
export type MergeLabel =
  | { readonly kind: "dirty" }
  | { readonly kind: "ahead"; readonly count: number }
  | { readonly kind: "merged" }
  | { readonly kind: "removed" };

/**
 * The label of a workspace's merge state, if any.
 *
 * @remarks
 * Uncommitted changes come first; then commits not yet in the main branch; then merged or
 * removed. A worktree with no changes, the local workspace and an unknown state show nothing
 * (SPEC-0001, "worktree 合并状态"; domain-model §1).
 *
 * @sideEffects none
 * @param workspace - The workspace.
 * @returns The labels to show, in order.
 */
export function mergeLabels(workspace: Pick<Workspace, "merge">): MergeLabel[] {
  const merge = workspace.merge;
  if (merge === null) return [];
  if (merge.verdict === "removed") return [{ kind: "removed" }];
  if (merge.verdict === "merged") return merge.dirty ? [{ kind: "dirty" }] : [{ kind: "merged" }];
  const labels: MergeLabel[] = [];
  if (merge.verdict === "pending" && merge.ahead > 0) labels.push({ kind: "ahead", count: merge.ahead });
  if (merge.dirty) labels.push({ kind: "dirty" });
  return labels;
}

/**
 * Whether a worktree's changes are wrapped up, so it fades and goes last.
 *
 * @remarks
 * Merged or removed (SPEC-0001, "项目与工作区").
 *
 * @sideEffects none
 * @param workspace - The workspace.
 * @returns Whether it is done.
 */
export function isDone(workspace: Pick<Workspace, "merge">): boolean {
  return workspace.merge?.verdict === "merged" || workspace.merge?.verdict === "removed";
}

/**
 * Whether a worktree has changes waiting to be merged.
 *
 * @remarks
 * Counted on a collapsed project's row (SPEC-0001, "项目与工作区").
 *
 * @sideEffects none
 * @param workspace - The workspace.
 * @returns Whether it waits.
 */
export function isPending(workspace: Pick<Workspace, "merge">): boolean {
  return mergeLabels(workspace).some((label) => label.kind === "dirty" || label.kind === "ahead");
}

/**
 * A project's workspaces in the order the sidebar shows them.
 *
 * @remarks
 * The local workspace first; then worktrees newest first, so they do not move as runs end; then
 * the ones wrapped up, also newest first (SPEC-0001, "项目与工作区").
 *
 * @sideEffects none
 * @param workspaces - The project's workspaces.
 * @returns The sorted workspaces.
 */
export function sortWorkspaces<T extends Pick<Workspace, "kind" | "createdAt" | "merge">>(
  workspaces: readonly T[],
): T[] {
  /**
   * Orders two workspaces newest first.
   *
   * @remarks
   * A workspace without a creation time counts as oldest.
   *
   * @sideEffects none
   * @param a - One workspace.
   * @param b - The other.
   * @returns The sort order.
   */
  const newest = (a: T, b: T) => (b.createdAt ?? 0) - (a.createdAt ?? 0);
  return [
    ...workspaces.filter((workspace) => workspace.kind === "local"),
    ...workspaces.filter((workspace) => workspace.kind === "worktree" && !isDone(workspace)).toSorted(newest),
    ...workspaces.filter((workspace) => workspace.kind === "worktree" && isDone(workspace)).toSorted(newest),
  ];
}

/**
 * Where a session lives, in words: "项目 · 工作区", or "对话".
 *
 * @remarks
 * The second line of a session in search results (SPEC-0001, "搜索").
 *
 * @sideEffects none
 * @param index - The list.
 * @param containerId - The session's container.
 * @returns The place.
 */
export function placeOf(index: Pick<IndexView, "projects" | "workspaces">, containerId: string): string {
  if (containerId === "chats") return "对话";
  const workspace = index.workspaces.find((candidate) => candidate.id === containerId);
  const project = index.projects.find((candidate) => candidate.id === workspace?.projectId);
  return workspace === undefined ? "" : `${project?.name ?? ""} · ${workspaceName(workspace)}`;
}

/**
 * When something last changed, in words, relative to now.
 *
 * @remarks
 * "刚刚", "N 分钟前", "N 小时前", "昨天", else the date (SPEC-0001's sidebar shows "12 分钟前").
 *
 * @sideEffects none
 * @param at - Milliseconds since the epoch.
 * @param now - The time now.
 * @returns The time.
 */
export function timeAgo(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (at >= today.getTime() - 24 * 60 * 60 * 1000) return "昨天";
  const when = new Date(at);
  return `${when.getMonth() + 1}月${when.getDate()}日`;
}
