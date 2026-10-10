import { z } from "zod";
import { ContainerId, ProjectId, SessionId, WorkspaceId } from "./ids";
import { StatusGroupId } from "./metrics";
import { ModelRef, ThinkingLevel } from "./models";

/** An absolute path on the host's machine. */
const Path = z.string().min(1).max(4096);

/** Milliseconds since the Unix epoch. */
const Timestamp = z.number().int().nonnegative();

/** A registered project (SPEC-0001, "项目、工作区与会话"). */
export const Project = z.strictObject({
  id: ProjectId,
  /** The real path, symbolic links resolved. */
  path: Path,
  name: z.string().min(1).max(256),
});
export type Project = z.infer<typeof Project>;

/** Why a worktree's merge state cannot be told. */
export const MergeUnknownReason = z.enum(["git_too_old", "no_main_branch", "git_failed", "base_unknown"]);
export type MergeUnknownReason = z.infer<typeof MergeUnknownReason>;

/** Whether a worktree's changes have been wrapped up (SPEC-0001, "worktree 合并状态"). */
export const MergeState = z.strictObject({
  /** `git status` in the worktree is not clean. */
  dirty: z.boolean(),
  /** Commits on the branch that the main branch does not have. */
  ahead: z.number().int().nonnegative(),
  verdict: z.enum(["noChange", "pending", "merged", "removed", "unknown"]),
  /** Why the verdict is `unknown`; `null` otherwise. */
  reason: MergeUnknownReason.nullable(),
});
export type MergeState = z.infer<typeof MergeState>;

/** A workspace: a project's directory or one of its worktrees. */
export const Workspace = z.strictObject({
  id: WorkspaceId,
  projectId: ProjectId,
  kind: z.enum(["local", "worktree"]),
  dir: Path,
  /** The name the user gave it; `null` for none. */
  alias: z.string().min(1).max(256).nullable(),
  /** The branch checked out; `null` when HEAD is detached or the project is not a git repository. */
  branch: z.string().min(1).max(1024).nullable(),
  /** The short commit HEAD is at when detached; `null` otherwise. */
  head: z.string().min(1).max(64).nullable(),
  /** A worktree Atrium did not create. */
  external: z.boolean(),
  /** When the worktree was created; `null` for the local workspace. */
  createdAt: Timestamp.nullable(),
  /** The merge state; `null` for the local workspace and projects that are not git repositories. */
  merge: MergeState.nullable(),
});
export type Workspace = z.infer<typeof Workspace>;

/**
 * Why a session needs you, kept in the index until its next run starts (SPEC-0001, "并行、同步与关注").
 *
 * @remarks
 * `error` is cleared once a client showed the session, and stays as the error icon until the next
 * run; `auth` is not cleared by a look, only by a run starting.
 */
export const Attention = z.strictObject({
  reason: z.enum(["error", "auth"]),
  /** When it was set. */
  at: Timestamp,
  cleared: z.boolean(),
});
export type Attention = z.infer<typeof Attention>;

/** A session as the sidebar, tabs and history list it. */
export const SessionSummary = z.strictObject({
  sessionId: SessionId,
  containerId: ContainerId,
  /** pi's session name; `null` when it has none. */
  name: z.string().max(1024).nullable(),
  /** The first line of the first user message, Markdown stripped, at most 200 characters; `null` without text. */
  prompt: z.string().max(200).nullable(),
  /** The session file; `null` before pi has written it. */
  file: Path.nullable(),
  /** `draft` before the file exists; `missing` when its file has gone. */
  state: z.enum(["draft", "persisted", "missing"]),
  updatedAt: Timestamp,
  archived: z.boolean(),
  /** A run is in progress. */
  running: z.boolean(),
  /** The last run failed, or pi kept crashing; `null` once the next run starts. */
  attention: Attention.nullable(),
  /** Since when the oldest unanswered dialog has waited; `null` without one. */
  asking: Timestamp.nullable(),
  /** Handed to pi in a terminal; Atrium starts no pi for it until taken back. */
  handedOff: z.boolean(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

/** The open tabs of one container, in order, and the active one. */
export const ContainerTabs = z.strictObject({
  open: z.array(SessionId),
  active: SessionId.nullable(),
});
export type ContainerTabs = z.infer<typeof ContainerTabs>;

/** One client's layout (domain-model, "已决定 4"). */
export const Layout = z.strictObject({
  /** Where the client is: a workspace, the chats, or nowhere yet. */
  container: ContainerId.nullable(),
  tabs: z.record(ContainerId, ContainerTabs),
});
export type Layout = z.infer<typeof Layout>;

/** How the app looks. */
export const Appearance = z.enum(["system", "light", "dark"]);
export type Appearance = z.infer<typeof Appearance>;

/** How much of a turn's process shows (SPEC-0001, "显示模式"). */
export const DisplayMode = z.enum(["summary", "thinking", "detailed"]);
export type DisplayMode = z.infer<typeof DisplayMode>;

/** The status bar groups switched on or off, by id. */
export const StatusBarChoices = z.record(StatusGroupId, z.boolean());
export type StatusBarChoices = z.infer<typeof StatusBarChoices>;

/**
 * Global preferences, the same for every client.
 *
 * @remarks
 * `lastModel` and `thinkingByModel` (keyed `providerId/modelId`) follow every model or thinking
 * level chosen in any session, and new sessions start with them (SPEC-0001, "模型与输入框").
 * `statusBar` holds only the status bar groups you switched from their default, so a group added
 * later shows as its own default says (SPEC-0001, "状态栏（M1.8）"). `setupDone` says first launch
 * was gone through; `titleModel` names the model that names sessions, `null` for each session's own
 * (SPEC-0001, "首次启动", "设置").
 */
export const Preferences = z.strictObject({
  setupDone: z.boolean(),
  appearance: Appearance,
  displayMode: DisplayMode,
  lastModel: ModelRef.nullable(),
  thinkingByModel: z.record(z.string().max(1024), ThinkingLevel),
  statusBar: StatusBarChoices,
  titleModel: ModelRef.nullable(),
});
export type Preferences = z.infer<typeof Preferences>;

/** Files of the index that were reset because they were damaged (domain-model §1, "索引的存储"). */
export const IndexFileName = z.enum(["projects", "sessions", "layouts", "preferences"]);
export type IndexFileName = z.infer<typeof IndexFileName>;

/** Why the host sent the whole list rather than changes after the client's cursor. */
export const SnapshotReason = z.enum(["no_cursor", "generation_changed", "cursor_expired", "too_many_changes"]);
export type SnapshotReason = z.infer<typeof SnapshotReason>;

/** The host instance; changes when the host restarts. */
const Generation = z.string().min(1);

/** Increases by one with every batch of changes within a generation; a client's cursor. */
const ListSeq = z.number().int().nonnegative();

/**
 * The whole list, sent to a client that subscribed without a cursor the host can serve.
 *
 * @remarks
 * After it come `index_changes` (SPEC-0001, "并行、同步与关注").
 */
export const IndexSnapshotEvent = z.strictObject({
  type: z.literal("index_snapshot"),
  generation: Generation,
  seq: ListSeq,
  reason: SnapshotReason,
  projects: z.array(Project),
  workspaces: z.array(Workspace),
  sessions: z.array(SessionSummary),
  layout: Layout,
  preferences: Preferences,
  /** Files reset at this host's start because they were damaged; the UI tells the user once. */
  resets: z.array(IndexFileName),
});
export type IndexSnapshotEvent = z.infer<typeof IndexSnapshotEvent>;

/**
 * The changes to one collection: items that changed, whole, and the ids of those that went.
 *
 * @remarks
 * The three collections change alike.
 *
 * @sideEffects none
 * @param item - An item's schema.
 * @param id - An id's schema.
 * @returns The changes' schema.
 */
function collectionChanges<T extends z.ZodType, I extends z.ZodType>(item: T, id: I) {
  return z.strictObject({ upsert: z.array(item), remove: z.array(id) });
}

/**
 * What changed in the list since the client's cursor, or since the last batch.
 *
 * @remarks
 * Upserted items replace the client's whole; new ones go at the end. `layout` is the receiving
 * client's own, and `layout` and `preferences` are `null` when unchanged (SPEC-0001, "并行、同步与关注").
 */
export const IndexChangesEvent = z.strictObject({
  type: z.literal("index_changes"),
  generation: Generation,
  seq: ListSeq,
  projects: collectionChanges(Project, ProjectId),
  workspaces: collectionChanges(Workspace, WorkspaceId),
  sessions: collectionChanges(SessionSummary, SessionId),
  layout: Layout.nullable(),
  preferences: Preferences.nullable(),
});
export type IndexChangesEvent = z.infer<typeof IndexChangesEvent>;
