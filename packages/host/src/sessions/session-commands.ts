import type {
  CommandResult,
  ContainerId,
  FetchStepCommand,
  FetchTranscriptCommand,
  PromptCommand,
} from "@atrium/protocol";

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
  /** Creates a session in a workspace, starts its pi and opens it as the client's active tab. */
  createSession(clientId: string, workspaceId: string): Promise<CommandResult<"create_session">>;
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
  /** Replaces the sessions a connection watches, sending a snapshot of each new one first. */
  subscribe(connectionId: string, sessionIds: readonly string[]): Promise<CommandResult<"subscribe_sessions">>;
  /** Sends a message to a session, starting a restored draft's pi first. */
  prompt(command: PromptCommand): Promise<CommandResult<"prompt">>;
  /** Items of a session's transcript before one the client has. */
  fetchTranscript(command: FetchTranscriptCommand): Promise<CommandResult<"fetch_transcript">>;
  /** One step of a session's transcript, whole. */
  fetchStep(command: FetchStepCommand): Promise<CommandResult<"fetch_step">>;
}
