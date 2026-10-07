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
  /** pi refused the command; `params.detail` is pi's own text, for "展开看原始报错". */
  "pi_rejected",
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
