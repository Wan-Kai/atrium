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
  /** The last run failed, or pi kept crashing; cleared when the next run starts (SPEC-0001, "运行控制"). */
  failed: z.boolean(),
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
 * later shows as its own default says (SPEC-0001, "状态栏（M1.8）").
 */
export const Preferences = z.strictObject({
  appearance: Appearance,
  displayMode: DisplayMode,
  lastModel: ModelRef.nullable(),
  thinkingByModel: z.record(z.string().max(1024), ThinkingLevel),
  statusBar: StatusBarChoices,
});
export type Preferences = z.infer<typeof Preferences>;

/** Files of the index that were reset because they were damaged (domain-model §1, "索引的存储"). */
export const IndexFileName = z.enum(["projects", "sessions", "layouts", "preferences"]);
export type IndexFileName = z.infer<typeof IndexFileName>;

/**
 * The whole list, sent to a client that subscribed to it and again after every change.
 *
 * @remarks
 * M1.5 sends only snapshots; M1.9 adds changes after a cursor (SPEC-0001, "项目、工作区与会话").
 */
export const IndexSnapshotEvent = z.strictObject({
  type: z.literal("index_snapshot"),
  /** The host instance; changes when the host restarts. */
  generation: z.string().min(1),
  /** Increases by one with every snapshot within a generation. */
  seq: z.number().int().nonnegative(),
  projects: z.array(Project),
  workspaces: z.array(Workspace),
  sessions: z.array(SessionSummary),
  layout: Layout,
  preferences: Preferences,
  /** Files reset at this host's start because they were damaged; the UI tells the user once. */
  resets: z.array(IndexFileName),
});
export type IndexSnapshotEvent = z.infer<typeof IndexSnapshotEvent>;
