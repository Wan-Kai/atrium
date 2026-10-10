import { z } from "zod";
import { parseTraceparent } from "./trace";
import { DiffTarget } from "./changes";
import { FileCandidate, SlashCommand } from "./composer";
import { InteractionAnswer } from "./control";
import { ContainerId, ProjectId, SessionId, WorkspaceId } from "./ids";
import { Appearance, DisplayMode, StatusBarChoices } from "./listing";
import { CatalogModel, MODEL_LIMITS, ModelRef, ThinkingLevel } from "./models";
import { DiscoveredDirectory, LoginMethod, PiLatest, SetupState } from "./setup";
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

/** A message's text when images may carry it; empty only with an image. */
const PromptText = z.string().max(1024 * 1024);

/** Uploaded images a message goes with, at most 20 (SPEC-0001, "附件"). */
const AttachmentIds = z.array(z.string().min(1).max(128)).max(20).optional();

/**
 * Whether a message has something to send.
 *
 * @remarks
 * An image may go without text; nothing at all is not a message.
 *
 * @sideEffects none
 * @param message - The text and the images.
 * @returns Whether it has either.
 */
function hasContent(message: {
  readonly text: string;
  readonly attachmentIds?: readonly string[] | undefined;
}): boolean {
  return message.text !== "" || (message.attachmentIds?.length ?? 0) > 0;
}

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
export const PromptCommand = z
  .strictObject({
    type: z.literal("prompt"),
    ...sessionCommandFields,
    text: PromptText,
    attachmentIds: AttachmentIds,
  })
  // No message of its own: a failure only ever becomes `invalid_message`.
  .refine(hasContent);
export type PromptCommand = z.infer<typeof PromptCommand>;

/**
 * Sends a steer: delivered before the agent's next step while it runs, sent as a message when it
 * is idle (SPEC-0001, "运行控制").
 */
export const SteerCommand = z
  .strictObject({ type: z.literal("steer"), ...sessionCommandFields, text: PromptText, attachmentIds: AttachmentIds })
  // No message of its own: a failure only ever becomes `invalid_message`.
  .refine(hasContent);
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

/**
 * Subscribes to the list: the changes after `cursor`, or a snapshot, at once, and changes after
 * that (SPEC-0001, "并行、同步与关注").
 */
export const SubscribeIndexCommand = z.strictObject({
  type: z.literal("subscribe_index"),
  ...commandFields,
  /** The last list position the client has. */
  cursor: z.strictObject({ generation: z.string().min(1), seq: z.number().int().nonnegative() }).optional(),
});
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

/** Marks a session's error as seen, which takes it out of the inbox (SPEC-0001, "并行、同步与关注"). */
export const ClearAttentionCommand = z.strictObject({
  type: z.literal("clear_attention"),
  ...commandFields,
  sessionId: SessionId,
});
export type ClearAttentionCommand = z.infer<typeof ClearAttentionCommand>;

/** Stops a session's pi so pi in a terminal can go on with it; Atrium starts none until taken back. */
export const HandOffCommand = z.strictObject({ type: z.literal("hand_off"), ...commandFields, sessionId: SessionId });
export type HandOffCommand = z.infer<typeof HandOffCommand>;

/** Goes on with a session handed to a terminal: reads its file again and starts pi. */
export const TakeBackCommand = z.strictObject({ type: z.literal("take_back"), ...commandFields, sessionId: SessionId });
export type TakeBackCommand = z.infer<typeof TakeBackCommand>;

/** Names a session, written back to pi. */
export const RenameSessionCommand = z.strictObject({
  type: z.literal("rename_session"),
  ...commandFields,
  sessionId: SessionId,
  name: Name,
});
export type RenameSessionCommand = z.infer<typeof RenameSessionCommand>;

/** Changes global preferences; fields left out stay as they are, and `statusBar` is replaced whole. */
export const SetPreferencesCommand = z.strictObject({
  type: z.literal("set_preferences"),
  ...commandFields,
  setupDone: z.boolean().optional(),
  appearance: Appearance.optional(),
  displayMode: DisplayMode.optional(),
  statusBar: StatusBarChoices.optional(),
  titleModel: ModelRef.nullable().optional(),
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

/**
 * Uploads one compressed image for a later `prompt` or `steer` (SPEC-0001, "附件").
 *
 * @remarks
 * Base64 within a million characters, so the message stays under the 1 MiB a WebSocket message
 * may have; the client compresses to fit.
 */
export const UploadAttachmentCommand = z.strictObject({
  type: z.literal("upload_attachment"),
  ...commandFields,
  mimeType: z.enum(["image/webp", "image/png", "image/jpeg", "image/gif"]),
  data: z.string().min(1).max(1_000_000),
});
export type UploadAttachmentCommand = z.infer<typeof UploadAttachmentCommand>;

/** Lists the `/` commands of a session's pi, starting it if it has none (SPEC-0001, "模型与输入框"). */
export const ListCommandsCommand = z.strictObject({ type: z.literal("list_commands"), ...sessionCommandFields });
export type ListCommandsCommand = z.infer<typeof ListCommandsCommand>;

/** Finds files and directories for `@` in a session's directory, as pi's terminal does with `fd`. */
export const SearchFilesCommand = z.strictObject({
  type: z.literal("search_files"),
  ...sessionCommandFields,
  /** What follows `@`; empty lists the directory's own entries first. */
  query: z.string().max(1024),
});
export type SearchFilesCommand = z.infer<typeof SearchFilesCommand>;

/**
 * Says which workspaces this connection shows, whose git changes the host then sends (SPEC-0001, "工作区改动").
 *
 * @remarks
 * Replaces the set given before; the host watches only workspaces someone shows.
 */
export const WatchChangesCommand = z.strictObject({
  type: z.literal("watch_changes"),
  ...commandFields,
  workspaceIds: z.array(WorkspaceId).max(64),
});
export type WatchChangesCommand = z.infer<typeof WatchChangesCommand>;

/** Opens the changes panel on a workspace and mode, or closes it with `null`; one per connection. */
export const WatchDiffCommand = z.strictObject({
  type: z.literal("watch_diff"),
  ...commandFields,
  target: DiffTarget.nullable(),
});
export type WatchDiffCommand = z.infer<typeof WatchDiffCommand>;

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

/**
 * Checks pi, Node, Homebrew, fd, the logins and the projects, for first launch and the settings.
 *
 * @remarks
 * `refresh` reads the login shell's environment again first: installing pi or Node may have
 * changed it (SPEC-0001, "首次启动 · 接口").
 */
export const CheckSetupCommand = z.strictObject({
  type: z.literal("check_setup"),
  ...commandFields,
  refresh: z.boolean().optional(),
});
export type CheckSetupCommand = z.infer<typeof CheckSetupCommand>;

/**
 * Signs in to a provider through pi; one login at a time, so a new one cancels the one under way.
 *
 * @remarks
 * `key` is only for `api_key`, and goes to pi's first secret question (SPEC-0001, "首次启动 · 接口").
 */
export const LoginCommand = z.strictObject({
  type: z.literal("login"),
  ...commandFields,
  providerId: z.string().min(1).max(MODEL_LIMITS.providerId),
  method: LoginMethod,
  key: z.string().min(1).max(16_384).optional(),
});
export type LoginCommand = z.infer<typeof LoginCommand>;

/** Answers one of pi's questions in the login under way. */
export const AnswerLoginCommand = z.strictObject({
  type: z.literal("answer_login"),
  ...commandFields,
  loginId: z.string().min(1).max(64),
  promptId: z.number().int().nonnegative(),
  value: z.string().max(16_384),
});
export type AnswerLoginCommand = z.infer<typeof AnswerLoginCommand>;

/** Cancels the login under way. */
export const CancelLoginCommand = z.strictObject({
  type: z.literal("cancel_login"),
  ...commandFields,
  loginId: z.string().min(1).max(64),
});
export type CancelLoginCommand = z.infer<typeof CancelLoginCommand>;

/** Removes the credential pi stored for a provider. */
export const LogoutCommand = z.strictObject({
  type: z.literal("logout"),
  ...commandFields,
  providerId: z.string().min(1).max(MODEL_LIMITS.providerId),
});
export type LogoutCommand = z.infer<typeof LogoutCommand>;

/**
 * Runs pi's official install script.
 *
 * @remarks
 * One install job at a time (SPEC-0001, "首次启动 · 接口").
 */
export const InstallPiCommand = z.strictObject({
  type: z.literal("install_pi"),
  ...commandFields,
});
export type InstallPiCommand = z.infer<typeof InstallPiCommand>;

/** Installs Node.js with the Homebrew found. */
export const InstallNodeCommand = z.strictObject({
  type: z.literal("install_node"),
  ...commandFields,
});
export type InstallNodeCommand = z.infer<typeof InstallNodeCommand>;

/** Runs `pi update`, once no session is running. */
export const UpdatePiCommand = z.strictObject({
  type: z.literal("update_pi"),
  ...commandFields,
});
export type UpdatePiCommand = z.infer<typeof UpdatePiCommand>;

/** Cancels the install job under way, ending its whole process tree. */
export const CancelInstallCommand = z.strictObject({
  type: z.literal("cancel_install"),
  ...commandFields,
  jobId: z.string().min(1).max(64),
});
export type CancelInstallCommand = z.infer<typeof CancelInstallCommand>;

/** Looks for the latest pi now, sharing a check under way. */
export const CheckPiUpdateCommand = z.strictObject({
  type: z.literal("check_pi_update"),
  ...commandFields,
});
export type CheckPiUpdateCommand = z.infer<typeof CheckPiUpdateCommand>;

/** Lists the working directories of pi's past sessions that could become projects. */
export const DiscoverProjectsCommand = z.strictObject({
  type: z.literal("discover_projects"),
  ...commandFields,
});
export type DiscoverProjectsCommand = z.infer<typeof DiscoverProjectsCommand>;

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
  ClearAttentionCommand,
  HandOffCommand,
  TakeBackCommand,
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
  ListCommandsCommand,
  SearchFilesCommand,
  UploadAttachmentCommand,
  WatchChangesCommand,
  WatchDiffCommand,
  CheckSetupCommand,
  LoginCommand,
  AnswerLoginCommand,
  CancelLoginCommand,
  LogoutCommand,
  InstallPiCommand,
  InstallNodeCommand,
  UpdatePiCommand,
  CancelInstallCommand,
  CheckPiUpdateCommand,
  DiscoverProjectsCommand,
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
  clear_attention: z.strictObject({}),
  /** The session file, for `pi --session`. */
  hand_off: z.strictObject({ file: z.string().min(1).max(4096) }),
  take_back: z.strictObject({}),
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
  list_commands: z.strictObject({ commands: z.array(SlashCommand) }),
  /** The best matches first, at most 20. */
  search_files: z.strictObject({ files: z.array(FileCandidate) }),
  upload_attachment: z.strictObject({ attachmentId: z.string().min(1).max(128) }),
  watch_changes: z.strictObject({}),
  watch_diff: z.strictObject({}),
  check_setup: SetupState,
  login: z.strictObject({ loginId: z.string().min(1).max(64) }),
  answer_login: z.strictObject({}),
  cancel_login: z.strictObject({}),
  logout: z.strictObject({}),
  install_pi: z.strictObject({ jobId: z.string().min(1).max(64) }),
  install_node: z.strictObject({ jobId: z.string().min(1).max(64) }),
  update_pi: z.strictObject({ jobId: z.string().min(1).max(64) }),
  cancel_install: z.strictObject({}),
  check_pi_update: PiLatest,
  discover_projects: z.strictObject({ directories: z.array(DiscoveredDirectory) }),
} as const satisfies Record<CommandType, z.ZodType>;
export type CommandResult<T extends CommandType> = z.infer<(typeof CommandResult)[T]>;
