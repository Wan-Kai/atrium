import { z } from "zod";
import { SessionAgent } from "./agent";
import { ChatId, ContainerId, ProjectId, SessionId, WorkspaceId } from "./ids";
import { StatusGroupId } from "./metrics";
import { ModelRef, ThinkingLevel } from "./models";

/** An absolute path on the host's machine. */
const Path = z.string().min(1).max(4096);

/** Milliseconds since the Unix epoch. */
const Timestamp = z.number().int().nonnegative();

/** A git branch's name, without `refs/heads/` or `origin/`. */
export const BranchName = z.string().min(1).max(1024);

/** A registered project (SPEC-0001, "项目、工作区与会话"). */
export const Project = z.strictObject({
  id: ProjectId,
  /** The real path, symbolic links resolved. */
  path: Path,
  name: z.string().min(1).max(256),
  /** The main branch the user chose, on `origin`; `null` follows `origin/HEAD` (SPEC-0001, "设置 · 接口"). */
  mainBranch: BranchName.nullable(),
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
  branch: BranchName.nullable(),
  /** The short commit HEAD is at when detached; `null` otherwise. */
  head: z.string().min(1).max(64).nullable(),
  /** A worktree Atrium did not create. */
  external: z.boolean(),
  /** When the worktree was created; `null` for the local workspace. */
  createdAt: Timestamp.nullable(),
  /** The merge state; `null` for the local workspace and projects that are not git repositories. */
  merge: MergeState.nullable(),
  /**
   * When it was archived; `null` when it is not. An archived workspace's `branch` and `head` are
   * those it had then (SPEC-0001, "M1.11 的工作区归档").
   */
  archivedAt: Timestamp.nullable(),
});
export type Workspace = z.infer<typeof Workspace>;

/** A chat: a directory of its own with sessions in it, and no git (domain-model §1, Chat). */
export const Chat = z.strictObject({
  id: ChatId,
  dir: Path,
  /** The name the user gave it; `null` for none. */
  alias: z.string().min(1).max(256).nullable(),
  /**
   * Its session created first, not archived; `null` for none. The chat is named after it unless
   * aliased. An archived chat's is the one it had then, so it keeps its name.
   */
  firstSessionId: SessionId.nullable(),
  /** When it was archived; `null` when it is not (SPEC-0001, "M1.11 的对话归档"). */
  archivedAt: Timestamp.nullable(),
});
export type Chat = z.infer<typeof Chat>;

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

/** pi's texts of a failure that comes from credentials (pi-internals.md §3, "一次性调用"). */
const AUTH_FAILURE = /no api key|oauth|\b401\b|unauthorized|authentication|invalid[ _]api[ _]key|\/login/i;

/**
 * Whether a failure looks like a credentials problem.
 *
 * @remarks
 * A best guess on pi's own text (SPEC-0001, "会话状态"): a wrong guess only changes the icon. The
 * host sets `auth` attention by it and the conversation's error card shows the key by it, so the
 * sidebar and the card agree (SPEC-0001, "运行出错与停止").
 *
 * @sideEffects none
 * @param text - pi's text.
 * @returns Whether to ask the user to sign in.
 */
export function isAuthFailure(text: string): boolean {
  return AUTH_FAILURE.test(text);
}

/** The session a child conversation belongs to, and who opened it (SPEC-0002, "概念"). */
export const ChildParent = z.strictObject({
  sessionId: SessionId,
  /** `user` from a reply or a menu; `agent` from the parent's agent (step two). */
  by: z.enum(["user", "agent"]),
});
export type ChildParent = z.infer<typeof ChildParent>;

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
  /** The session it is a child conversation of; `null` for an ordinary session (SPEC-0002). */
  parent: ChildParent.nullable(),
  /** What a child the agent opened shows in its parent's child list; `null` for any other (SPEC-0002). */
  agent: SessionAgent.nullable(),
  /** How many of its deliveries wait since the host restarted, until you let them go (SPEC-0002, "送达"). */
  heldDeliveries: z.number().int().nonnegative(),
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
  /** Where the client is: a workspace, a chat, or nowhere yet. */
  container: ContainerId.nullable(),
  tabs: z.record(ContainerId, ContainerTabs),
});
export type Layout = z.infer<typeof Layout>;

/** How the app looks. */
export const Appearance = z.enum(["system", "light", "dark"]);
export type Appearance = z.infer<typeof Appearance>;

/** The status bar groups switched on or off, by id. */
export const StatusBarChoices = z.record(StatusGroupId, z.boolean());
export type StatusBarChoices = z.infer<typeof StatusBarChoices>;

/**
 * The network proxy set in the settings: where requests go, and which hosts go direct.
 *
 * @remarks
 * The host checks the address itself and answers `proxy_invalid` (SPEC-0001, "设置 · 接口"); the
 * schema only bounds the sizes.
 */
export const ProxySetting = z.strictObject({
  url: z.string().max(2048),
  noProxy: z.array(z.string().max(255)).max(100),
});
export type ProxySetting = z.infer<typeof ProxySetting>;

/**
 * Global preferences, the same for every client.
 *
 * @remarks
 * `lastModel` and `thinkingByModel` (keyed `providerId/modelId`) follow every model or thinking
 * level chosen in any session, and new sessions start with them (SPEC-0001, "模型与输入框"); so
 * does `lastFast`, Fast switched on or off (SPEC-0001, "Fast").
 * `statusBar` holds only the status bar groups you switched from their default, so a group added
 * later shows as its own default says (SPEC-0001, "状态栏（M1.8）"). `setupDone` says first launch
 * was gone through; `titleModel` names the model that names sessions, `null` for each session's own
 * (SPEC-0001, "首次启动", "设置"). `proxy` is the network proxy pi and the host's own requests go
 * through, `null` for the login shell's (SPEC-0001, "设置 · pi"). `inbox` says whether the sidebar
 * shows "等你处理" (SPEC-0001, "侧栏 · 收件箱").
 */
export const Preferences = z.strictObject({
  setupDone: z.boolean(),
  appearance: Appearance,
  lastModel: ModelRef.nullable(),
  thinkingByModel: z.record(z.string().max(1024), ThinkingLevel),
  lastFast: z.boolean(),
  statusBar: StatusBarChoices,
  titleModel: ModelRef.nullable(),
  proxy: ProxySetting.nullable(),
  inbox: z.boolean(),
});
export type Preferences = z.infer<typeof Preferences>;

/** Files of the index that were reset because they were damaged (domain-model §1, "索引的存储"). */
export const IndexFileName = z.enum(["projects", "chats", "sessions", "layouts", "preferences"]);
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
  chats: z.array(Chat),
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
 * The collections change alike.
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
  chats: collectionChanges(Chat, ChatId),
  sessions: collectionChanges(SessionSummary, SessionId),
  layout: Layout.nullable(),
  preferences: Preferences.nullable(),
});
export type IndexChangesEvent = z.infer<typeof IndexChangesEvent>;
