import { z } from "zod";
import { parseTraceparent } from "./trace";
import { InteractionAnswer } from "./control";
import { ContainerId, ProjectId, SessionId, WorkspaceId } from "./ids";
import { Appearance, DisplayMode } from "./listing";
import { CatalogModel, ModelRef, ThinkingLevel } from "./models";
import { Step, TranscriptItem } from "./transcript";

/** A client-chosen id that ties a response to its command; unique within a connection. */
export const RequestId = z.string().min(1).max(128);

/** A W3C `traceparent` value that `parseTraceparent` accepts. */
export const Traceparent = z
  .string()
  .max(64)
  // No message of its own: a failure only ever becomes `invalid_message`.
  .refine((value) => parseTraceparent(value) !== null);

/** Fields every command carries (SPEC-0001, "信封"). */
const commandFields = { requestId: RequestId, traceparent: Traceparent };

/** Fields every session command carries in addition. */
const sessionCommandFields = { ...commandFields, sessionId: SessionId };

/** A message's text, as typed. */
const MessageText = z
  .string()
  .min(1)
  .max(1024 * 1024);

/** Heartbeat: the client sends one every `heartbeatMs` and expects the response within as long. */
export const PingCommand = z.strictObject({ type: z.literal("ping"), ...commandFields });
export type PingCommand = z.infer<typeof PingCommand>;

/**
 * Creates a chat: a directory under `~/.atrium/chats/` with a session whose pi starts at once,
 * opened as this client's active tab.
 */
export const CreateChatCommand = z.strictObject({ type: z.literal("create_chat"), ...commandFields });
export type CreateChatCommand = z.infer<typeof CreateChatCommand>;

/**
 * Sets which sessions this client receives live events for, replacing the previous set.
 *
 * @remarks
 * A full set rather than add/remove keeps the command idempotent: resending it after a reconnect
 * restores exactly the subscriptions the client wants.
 */
export const SubscribeSessionsCommand = z.strictObject({
  type: z.literal("subscribe_sessions"),
  ...commandFields,
  sessionIds: z.array(SessionId).max(64),
});
export type SubscribeSessionsCommand = z.infer<typeof SubscribeSessionsCommand>;

/** Sends a message to a session; its `requestId` doubles as the user message's `clientMessageId`. */
export const PromptCommand = z.strictObject({
  type: z.literal("prompt"),
  ...sessionCommandFields,
  text: MessageText,
});
export type PromptCommand = z.infer<typeof PromptCommand>;

/**
 * Sends a steer: delivered before the agent's next step while it runs, sent as a message when it
 * is idle (SPEC-0001, "运行控制").
 */
export const SteerCommand = z.strictObject({ type: z.literal("steer"), ...sessionCommandFields, text: MessageText });
export type SteerCommand = z.infer<typeof SteerCommand>;

/** Stops the run: pauses the queue, clears pi's queue and aborts. */
export const StopCommand = z.strictObject({ type: z.literal("stop"), ...sessionCommandFields });
export type StopCommand = z.infer<typeof StopCommand>;

/** Lets a paused queue move again, starting with its first message at once if idle. */
export const ResumeQueueCommand = z.strictObject({ type: z.literal("resume_queue"), ...sessionCommandFields });
export type ResumeQueueCommand = z.infer<typeof ResumeQueueCommand>;

/** Empties the host's queue; pi's own queue is left alone. */
export const ClearQueueCommand = z.strictObject({ type: z.literal("clear_queue"), ...sessionCommandFields });
export type ClearQueueCommand = z.infer<typeof ClearQueueCommand>;

/** A queued message, by its id. */
const QueueItemId = z.string().min(1).max(128);

/** Changes the text of a queued message. */
export const UpdateQueuedCommand = z.strictObject({
  type: z.literal("update_queued"),
  ...sessionCommandFields,
  itemId: QueueItemId,
  text: MessageText,
});
export type UpdateQueuedCommand = z.infer<typeof UpdateQueuedCommand>;

/** Takes a message out of the queue. */
export const RemoveQueuedCommand = z.strictObject({
  type: z.literal("remove_queued"),
  ...sessionCommandFields,
  itemId: QueueItemId,
});
export type RemoveQueuedCommand = z.infer<typeof RemoveQueuedCommand>;

/** Takes a message out of the queue and sends it as a steer. */
export const SteerQueuedCommand = z.strictObject({
  type: z.literal("steer_queued"),
  ...sessionCommandFields,
  itemId: QueueItemId,
});
export type SteerQueuedCommand = z.infer<typeof SteerQueuedCommand>;

/** Answers an extension's question. */
export const AnswerInteractionCommand = z.strictObject({
  type: z.literal("answer_interaction"),
  ...sessionCommandFields,
  interactionId: z.string().min(1).max(256),
  answer: InteractionAnswer,
});
export type AnswerInteractionCommand = z.infer<typeof AnswerInteractionCommand>;

/** The error card's "重试": runs the last turn again, as after an automatic restart. */
export const RetryRunCommand = z.strictObject({ type: z.literal("retry_run"), ...sessionCommandFields });
export type RetryRunCommand = z.infer<typeof RetryRunCommand>;

/**
 * Opens a session as this client's active tab and goes to its container; starts its pi unless
 * it runs, or is a draft restored after a restart, which starts on its first message.
 */
export const OpenSessionCommand = z.strictObject({
  type: z.literal("open_session"),
  ...commandFields,
  sessionId: SessionId,
});
export type OpenSessionCommand = z.infer<typeof OpenSessionCommand>;

/** Subscribes to the list: a snapshot at once, and another after every change (SPEC-0001, "项目、工作区与会话"). */
export const SubscribeIndexCommand = z.strictObject({ type: z.literal("subscribe_index"), ...commandFields });
export type SubscribeIndexCommand = z.infer<typeof SubscribeIndexCommand>;

/** An absolute path on the host's machine. */
const Path = z.string().min(1).max(4096);

/** A name the user types for a project, workspace or session. */
const Name = z.string().trim().min(1).max(256);

/** Registers a directory as a project. */
export const AddProjectCommand = z.strictObject({ type: z.literal("add_project"), ...commandFields, path: Path });
export type AddProjectCommand = z.infer<typeof AddProjectCommand>;

/** Removes a project from the index; nothing on disk changes. */
export const RemoveProjectCommand = z.strictObject({
  type: z.literal("remove_project"),
  ...commandFields,
  projectId: ProjectId,
});
export type RemoveProjectCommand = z.infer<typeof RemoveProjectCommand>;

/** Renames a project. */
export const RenameProjectCommand = z.strictObject({
  type: z.literal("rename_project"),
  ...commandFields,
  projectId: ProjectId,
  name: Name,
});
export type RenameProjectCommand = z.infer<typeof RenameProjectCommand>;

/** Names a workspace, or with `null` goes back to its branch's name. */
export const RenameWorkspaceCommand = z.strictObject({
  type: z.literal("rename_workspace"),
  ...commandFields,
  workspaceId: WorkspaceId,
  name: Name.nullable(),
});
export type RenameWorkspaceCommand = z.infer<typeof RenameWorkspaceCommand>;

/** The window gained focus: the host scans workspaces, merge states and session files again. */
export const WindowFocusedCommand = z.strictObject({ type: z.literal("window_focused"), ...commandFields });
export type WindowFocusedCommand = z.infer<typeof WindowFocusedCommand>;

/** Creates a session in a workspace, starts its pi and opens it as this client's active tab. */
export const CreateSessionCommand = z.strictObject({
  type: z.literal("create_session"),
  ...commandFields,
  workspaceId: WorkspaceId,
});
export type CreateSessionCommand = z.infer<typeof CreateSessionCommand>;

/** Closes this client's tab of a session; a draft without messages is discarded. */
export const CloseTabCommand = z.strictObject({ type: z.literal("close_tab"), ...commandFields, sessionId: SessionId });
export type CloseTabCommand = z.infer<typeof CloseTabCommand>;

/** Goes to a workspace or the chats, or nowhere. */
export const SelectContainerCommand = z.strictObject({
  type: z.literal("select_container"),
  ...commandFields,
  containerId: ContainerId.nullable(),
});
export type SelectContainerCommand = z.infer<typeof SelectContainerCommand>;

/** Hides a session in Atrium and stops its pi; pi's file stays. */
export const ArchiveSessionCommand = z.strictObject({
  type: z.literal("archive_session"),
  ...commandFields,
  sessionId: SessionId,
});
export type ArchiveSessionCommand = z.infer<typeof ArchiveSessionCommand>;

/** Names a session, written back to pi. */
export const RenameSessionCommand = z.strictObject({
  type: z.literal("rename_session"),
  ...commandFields,
  sessionId: SessionId,
  name: Name,
});
export type RenameSessionCommand = z.infer<typeof RenameSessionCommand>;

/** Changes global preferences; fields left out stay as they are. */
export const SetPreferencesCommand = z.strictObject({
  type: z.literal("set_preferences"),
  ...commandFields,
  appearance: Appearance.optional(),
  displayMode: DisplayMode.optional(),
});
export type SetPreferencesCommand = z.infer<typeof SetPreferencesCommand>;

/**
 * Lists the models pi can use in a workspace's directory, or for the chats.
 *
 * @remarks
 * The host asks a short-lived pi once per directory and keeps the answer until `refresh`
 * (SPEC-0001, "模型与输入框").
 */
export const ListModelsCommand = z.strictObject({
  type: z.literal("list_models"),
  ...commandFields,
  containerId: ContainerId,
  refresh: z.boolean().optional(),
});
export type ListModelsCommand = z.infer<typeof ListModelsCommand>;

/** Switches a session's model; it takes effect from the next request to the model. */
export const SetModelCommand = z.strictObject({
  type: z.literal("set_model"),
  ...sessionCommandFields,
  ...ModelRef.shape,
});
export type SetModelCommand = z.infer<typeof SetModelCommand>;

/** Sets how hard a session's model thinks; pi keeps it within what the model supports. */
export const SetThinkingLevelCommand = z.strictObject({
  type: z.literal("set_thinking_level"),
  ...sessionCommandFields,
  level: ThinkingLevel,
});
export type SetThinkingLevelCommand = z.infer<typeof SetThinkingLevelCommand>;

/** The most items one `fetch_transcript` returns. */
export const FETCH_TRANSCRIPT_LIMIT = 100;

/**
 * Fetches the transcript items before one the client has, for scrolling back.
 *
 * @remarks
 * `epoch` is the one the client's items come from; if the host has rebuilt the transcript since,
 * the item ids may no longer line up, so it answers `transcript_changed` (SPEC-0001, "快照与分页").
 */
export const FetchTranscriptCommand = z.strictObject({
  type: z.literal("fetch_transcript"),
  ...sessionCommandFields,
  epoch: z.number().int().nonnegative(),
  /** The id of the earliest item the client has. */
  before: z.string().min(1).max(256),
  limit: z.number().int().min(1).max(FETCH_TRANSCRIPT_LIMIT),
});
export type FetchTranscriptCommand = z.infer<typeof FetchTranscriptCommand>;

/** Fetches one step whole, for a step marked `partial` (SPEC-0001, "大内容"). */
export const FetchStepCommand = z.strictObject({
  type: z.literal("fetch_step"),
  ...sessionCommandFields,
  epoch: z.number().int().nonnegative(),
  turnId: z.string().min(1).max(256),
  stepId: z.string().min(1).max(32),
});
export type FetchStepCommand = z.infer<typeof FetchStepCommand>;

/** Kinds of problems the UI reports to the host's log. */
export const ClientIssueKind = z.enum(["error", "long_task", "slow_frames"]);
export type ClientIssueKind = z.infer<typeof ClientIssueKind>;

/** Writes a UI problem into the host's log; the client truncates both texts to 4 KB first. */
export const ReportClientIssueCommand = z.strictObject({
  type: z.literal("report_client_issue"),
  ...commandFields,
  kind: ClientIssueKind,
  message: z.string().max(4096),
  details: z.string().max(4096).optional(),
});
export type ReportClientIssueCommand = z.infer<typeof ReportClientIssueCommand>;

/** Every command a client may send after the handshake. */
export const Command = z.discriminatedUnion("type", [
  PingCommand,
  CreateChatCommand,
  SubscribeSessionsCommand,
  PromptCommand,
  FetchTranscriptCommand,
  FetchStepCommand,
  OpenSessionCommand,
  SubscribeIndexCommand,
  AddProjectCommand,
  RemoveProjectCommand,
  RenameProjectCommand,
  RenameWorkspaceCommand,
  WindowFocusedCommand,
  CreateSessionCommand,
  CloseTabCommand,
  SelectContainerCommand,
  ArchiveSessionCommand,
  RenameSessionCommand,
  SetPreferencesCommand,
  ReportClientIssueCommand,
  SteerCommand,
  StopCommand,
  ResumeQueueCommand,
  ClearQueueCommand,
  UpdateQueuedCommand,
  RemoveQueuedCommand,
  SteerQueuedCommand,
  AnswerInteractionCommand,
  RetryRunCommand,
  ListModelsCommand,
  SetModelCommand,
  SetThinkingLevelCommand,
]);
export type Command = z.infer<typeof Command>;
export type CommandType = Command["type"];

/** The command types, for telling an unknown command from a malformed one. */
export const COMMAND_TYPES: ReadonlySet<string> = new Set<CommandType>(
  Command.options.map((option) => option.shape.type.value),
);

/**
 * What a successful response carries for each command.
 *
 * @remarks
 * The response itself carries `result` as unknown JSON; the client knows which command it sent
 * and checks the result against this schema.
 */
export const CommandResult = {
  ping: z.strictObject({}),
  create_chat: z.strictObject({ sessionId: SessionId }),
  subscribe_sessions: z.strictObject({}),
  /**
   * `started` runs the message; `handled` means an extension consumed it without a run; `queued`
   * puts it in the host's queue, as `itemId`, behind the run in progress.
   */
  prompt: z.discriminatedUnion("disposition", [
    z.strictObject({ disposition: z.enum(["started", "handled"]) }),
    z.strictObject({ disposition: z.literal("queued"), itemId: QueueItemId }),
  ]),
  fetch_transcript: z.strictObject({
    /** The items just before `before`, oldest first. */
    items: z.array(TranscriptItem),
    hasOlder: z.boolean(),
  }),
  fetch_step: z.strictObject({ step: Step }),
  open_session: z.strictObject({}),
  subscribe_index: z.strictObject({}),
  add_project: z.strictObject({ projectId: ProjectId }),
  remove_project: z.strictObject({}),
  rename_project: z.strictObject({}),
  rename_workspace: z.strictObject({}),
  window_focused: z.strictObject({}),
  create_session: z.strictObject({ sessionId: SessionId }),
  close_tab: z.strictObject({}),
  select_container: z.strictObject({}),
  archive_session: z.strictObject({}),
  rename_session: z.strictObject({}),
  set_preferences: z.strictObject({}),
  report_client_issue: z.strictObject({}),
  /** `queued`: pi took the steer and delivers it before the next step; idle, it ran as a message. */
  steer: z.strictObject({ disposition: z.enum(["started", "queued", "handled"]) }),
  /** Whether pi confirmed it stopped within two seconds; if not, the session stays stopping. */
  stop: z.strictObject({ confirmed: z.boolean() }),
  resume_queue: z.strictObject({}),
  clear_queue: z.strictObject({}),
  update_queued: z.strictObject({}),
  remove_queued: z.strictObject({}),
  steer_queued: z.strictObject({ disposition: z.enum(["started", "queued", "handled"]) }),
  answer_interaction: z.strictObject({}),
  retry_run: z.strictObject({}),
  /** `defaultModel` is the one pi picks by its own settings, `null` when it reported none. */
  list_models: z.strictObject({ models: z.array(CatalogModel), defaultModel: ModelRef.nullable() }),
  set_model: z.strictObject({}),
  set_thinking_level: z.strictObject({}),
} as const satisfies Record<CommandType, z.ZodType>;
export type CommandResult<T extends CommandType> = z.infer<(typeof CommandResult)[T]>;
