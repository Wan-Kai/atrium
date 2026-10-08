import type { CommandResult, FetchStepCommand, FetchTranscriptCommand, PromptCommand } from "@atrium/protocol";

/**
 * The session commands the server hands to the session layer.
 *
 * @remarks
 * Defined here rather than in `server/` because business modules must not depend on the server
 * (overview.md, "宿主内部的依赖"); the server only knows this interface. Failures are thrown as
 * `CommandError` with a protocol error code.
 */
export interface SessionCommands {
  /** Creates a chat and starts its pi. */
  createChat(connectionId: string): Promise<CommandResult<"create_chat">>;
  /** Replaces the sessions a connection watches, sending a snapshot of each new one first. */
  subscribe(connectionId: string, sessionIds: readonly string[]): Promise<CommandResult<"subscribe_sessions">>;
  /** Sends a message to a session. */
  prompt(command: PromptCommand): Promise<CommandResult<"prompt">>;
  /** The sessions in pi's session directory changed most recently. */
  listRecentSessions(limit: number): Promise<CommandResult<"list_recent_sessions">>;
  /** Opens a session from its file, unless it is open already. */
  openSession(sessionId: string): Promise<CommandResult<"open_session">>;
  /** Items of a session's transcript before one the client has. */
  fetchTranscript(command: FetchTranscriptCommand): Promise<CommandResult<"fetch_transcript">>;
  /** One step of a session's transcript, whole. */
  fetchStep(command: FetchStepCommand): Promise<CommandResult<"fetch_step">>;
}
