import type {
  CommandResult,
  ContainerId,
  FetchImageCommand,
  FetchStepCommand,
  FetchTranscriptCommand,
  InteractionAnswer,
  ModelRef,
  PromptCommand,
  SteerCommand,
  ThinkingLevel,
} from "@atrium/protocol";
import type { PromptImage } from "./session-controller";

/**
 * The session commands the server hands to the session layer.
 *
 * @remarks
 * Defined here rather than in `server/` because business modules must not depend on the server
 * (overview.md, "宿主内部的依赖"); the server only knows this interface. Commands that change a
 * client's layout take its client id (domain-model, "已决定 4"). Failures are thrown as
 * `CommandError` with a protocol error code.
 */
export interface SessionCommands {
  /** Creates a chat, starts its pi and opens it as the client's active tab. */
  createChat(clientId: string): Promise<CommandResult<"create_chat">>;
  /** Creates a session in a workspace or chat, starts its pi and opens it as the client's active tab. */
  createSession(clientId: string, containerId: ContainerId): Promise<CommandResult<"create_session">>;
  /** Opens a session as the client's active tab, starting its pi unless it runs or is a restored draft. */
  openSession(clientId: string, sessionId: string): Promise<CommandResult<"open_session">>;
  /** Closes the client's tab of a session; a draft without messages is discarded. */
  closeTab(clientId: string, sessionId: string): Promise<CommandResult<"close_tab">>;
  /** Goes to a container, or nowhere. */
  selectContainer(clientId: string, containerId: ContainerId | null): Promise<CommandResult<"select_container">>;
  /** Hides a session in Atrium and stops its pi. */
  archiveSession(sessionId: string): Promise<CommandResult<"archive_session">>;
  /** Names a session in pi. */
  renameSession(sessionId: string, name: string): Promise<CommandResult<"rename_session">>;
  /** Marks a session's error as seen; a sign-in problem stays until the next run (SPEC-0001, "会话状态"). */
  clearAttention(sessionId: string): Promise<CommandResult<"clear_attention">>;
  /** Hands a session to pi in a terminal: records it, stops its pi and answers its file. */
  handOff(sessionId: string): Promise<CommandResult<"hand_off">>;
  /** Takes a session handed off back into Atrium and starts its pi. */
  takeBack(sessionId: string): Promise<CommandResult<"take_back">>;
  /** Replaces the sessions a connection watches, sending a snapshot of each new one first. */
  subscribe(connectionId: string, sessionIds: readonly string[]): Promise<CommandResult<"subscribe_sessions">>;
  /** Sends a message with its images to a session, starting a restored draft's pi first. */
  prompt(command: PromptCommand, images?: readonly PromptImage[]): Promise<CommandResult<"prompt">>;
  /** Sends a steer, or a message when the session is idle, starting a restored draft's pi first. */
  steer(command: SteerCommand, images?: readonly PromptImage[]): Promise<CommandResult<"steer">>;
  /** Stops a session's run (SPEC-0001, "运行控制"). */
  stop(sessionId: string): Promise<CommandResult<"stop">>;
  resumeQueue(sessionId: string): Promise<CommandResult<"resume_queue">>;
  clearQueue(sessionId: string): Promise<CommandResult<"clear_queue">>;
  updateQueued(sessionId: string, itemId: string, text: string): Promise<CommandResult<"update_queued">>;
  removeQueued(sessionId: string, itemId: string): Promise<CommandResult<"remove_queued">>;
  steerQueued(sessionId: string, itemId: string): Promise<CommandResult<"steer_queued">>;
  answerInteraction(
    sessionId: string,
    interactionId: string,
    answer: InteractionAnswer,
  ): Promise<CommandResult<"answer_interaction">>;
  /** Switches a session's model, starting its pi first if it has none. */
  setModel(sessionId: string, model: ModelRef): Promise<CommandResult<"set_model">>;
  /** Sets how hard a session's model thinks, starting its pi first if it has none. */
  setThinkingLevel(sessionId: string, level: ThinkingLevel): Promise<CommandResult<"set_thinking_level">>;
  /** Switches a session's Fast, starting its pi first if it has none (SPEC-0001, "Fast"). */
  setFast(sessionId: string, enabled: boolean): Promise<CommandResult<"set_fast">>;
  /** The `/` commands of a session's pi, starting its pi first if it has none (SPEC-0001, "模型与输入框"). */
  listCommands(sessionId: string): Promise<CommandResult<"list_commands">>;
  /** Files and directories for `@` in a session's directory; a newer search calls off an older one. */
  searchFiles(sessionId: string, query: string): Promise<CommandResult<"search_files">>;
  /** The error card's "重试", starting the session's pi first if it has none. */
  retryRun(sessionId: string): Promise<CommandResult<"retry_run">>;
  /** Items of a session's transcript before one the client has. */
  fetchTranscript(command: FetchTranscriptCommand): Promise<CommandResult<"fetch_transcript">>;
  /** One step of a session's transcript, whole. */
  fetchStep(command: FetchStepCommand): Promise<CommandResult<"fetch_step">>;
  /** One image of a turn's user message, read from the session file (SPEC-0001, "M1.11 的消息图片"). */
  fetchImage(command: FetchImageCommand): Promise<CommandResult<"fetch_image">>;
}
