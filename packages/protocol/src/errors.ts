import { z } from "zod";

/**
 * Why a command failed; the UI turns each code into its own wording.
 *
 * @remarks
 * The host never produces user-facing text (AGENTS.md), so failures travel as codes with
 * parameters. Codes are added as milestones need them (SPEC-0001, "应答").
 */
export const ErrorCode = z.enum([
  /** Not JSON, or does not match any message's schema. */
  "invalid_message",
  /** Well-formed, but the `type` names no command. */
  "unknown_command",
  /** The `sessionId` names no session the host knows. */
  "session_not_found",
  /** pi cannot be used: missing, outdated, unusable, exited or unresponsive, as `params.status` says. */
  "pi_unavailable",
  /** pi is running or compacting and takes no new message now. */
  "session_busy",
  /** `fetch_transcript` or `fetch_step` named an epoch that has passed; the client subscribes again for a snapshot. */
  "transcript_changed",
  /** The session to open recorded a working directory that no longer exists; `params.cwd` names it. */
  "session_cwd_missing",
  /** The `projectId` names no registered project. */
  "project_not_found",
  /** The `workspaceId` names no workspace of a registered project. */
  "workspace_not_found",
  /** The `chatId` names no chat: its directory under `~/.atrium/chats/` is gone, or never was. */
  "chat_not_found",
  /** The directory is a registered project or one of its workspaces already; `params.projectId` names the project. */
  "project_exists",
  /** Another project has that name; `params.name` repeats it. */
  "name_taken",
  /** The path is not a directory, or does not exist; `params.path` repeats it. */
  "path_not_found",
  /** The session has had no message yet, so pi has no file to keep its name in. */
  "session_is_draft",
  /** A stop is waiting for pi to confirm; the session takes no new message until then. */
  "session_stopping",
  /** The `itemId` names nothing in the session's queue. */
  "queue_item_not_found",
  /** The interaction was answered, timed out, or went away with its pi. */
  "interaction_closed",
  /** pi could not list its models, as when no provider has credentials; `params.detail` is pi's own text. */
  "models_unavailable",
  /** `@` needs `fd`, found neither where pi keeps it nor on the login shell's PATH. */
  "fd_missing",
  /** The client's uploaded images would pass 32 MiB or 20 images (SPEC-0001, "附件"). */
  "attachment_limit",
  /** An image a message names was never uploaded, or was let go after 30 minutes unused. */
  "attachment_missing",
  /** The session's pi did not load Atrium's Fast extension, so Fast cannot be switched there (ADR-0008). */
  "fast_unavailable",
  /** pi refused the command; `params.detail` is pi's own text, for "展开看原始报错". */
  "pi_rejected",
  /** The session was handed to pi in a terminal; take it back first (SPEC-0001, "并行、同步与关注"). */
  "session_handed_off",
  /** Atrium cannot sign in through pi now: the login program cannot load the pi found, or pi is not usable. */
  "login_unavailable",
  /** The `loginId` names no login under way. */
  "login_not_found",
  /** pi did not remove the credential; `params.reason` says why and `params.detail` is pi's own text. */
  "logout_failed",
  /** Another install job is under way; one runs at a time. */
  "install_busy",
  /** The job's tool is missing: no tools found yet, no Homebrew for Node, or no pi to update. */
  "install_unavailable",
  /** The `jobId` names no install job under way. */
  "install_not_found",
  /** `origin` has no branch of that name; `params.branch` repeats it. */
  "branch_not_found",
  /** The proxy setting was refused; `params.reason` is `malformed`, `scheme`, `credentials` or `no_proxy`. */
  "proxy_invalid",
  /** The host failed unexpectedly; details are in the host's log under the command's trace. */
  "internal_error",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Values an error may carry for the UI to fill into its wording. */
export const ErrorParams = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
export type ErrorParams = z.infer<typeof ErrorParams>;

/** A failure as it travels in a response. */
export const ErrorInfo = z.strictObject({ code: ErrorCode, params: ErrorParams.optional() });
export type ErrorInfo = z.infer<typeof ErrorInfo>;

/**
 * A command that failed with a protocol error code.
 *
 * @remarks
 * The host throws it from a command handler to answer with that code; the client rejects with it
 * when a response fails. The message names only the code, never user-facing text (AGENTS.md).
 *
 * @sideEffects none
 */
export class CommandError extends Error {
  override readonly name = "CommandError";

  /**
   * Creates the error.
   *
   * @remarks
   * `params` are values the UI fills into its wording, such as the pi status.
   *
   * @sideEffects none
   * @param code - Why the command failed.
   * @param params - Values for the UI's wording.
   */
  constructor(
    readonly code: ErrorCode,
    readonly params?: ErrorParams,
  ) {
    super(`command failed: ${code}`);
  }
}
