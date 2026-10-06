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
  /** pi is missing, outdated or cannot run; `params.status` says which. */
  "pi_unavailable",
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
