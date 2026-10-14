import { PiRequestError } from "@atrium/pi";
import { CommandError } from "@atrium/protocol";
import type { Clock } from "../platform/clock";
import type { TracedPi } from "./traced-pi";

/** How long a fork may take, its pi's start included (SPEC-0001, "M1.11 的 `/` 命令 · 分叉"). */
const FORK_DEADLINE_MS = 30_000;

/**
 * Forks a session's file with a pi of its own, names the new session, and stops that pi.
 *
 * @remarks
 * pi's `fork` and `clone` move the pi that runs them to the new session, so the session's own pi
 * cannot do it: one session, one pi (SPEC-0001, "M1.11 的 `/` 命令 · 分叉"). `pi` was started on
 * the session's file. `at` is the user message the new session ends before; `null` copies the whole
 * branch with `clone`, as pi's `fork` cuts only before a user message. The text pi's `fork` answers
 * with is not used. An extension may call the fork off, which pi answers with `cancelled`.
 *
 * All must be done within `FORK_DEADLINE_MS` of the call, or before `signal` (the host closing)
 * aborts. A failure is reported by its reason only: pi's own words stay out of the log (security.md,
 * "凭据与日志").
 *
 * @sideEffects Calls pi, which writes the new session's file; stops pi; reports a failure.
 * @param options - The pi, where to fork, the new session's name, the clock, the host's signal and
 * where failures go.
 * @returns The new session's id.
 * @throws {CommandError} `fork_failed`.
 */
export async function forkWithPi(options: {
  readonly pi: TracedPi;
  readonly at: string | null;
  readonly name: string;
  readonly clock: Clock;
  readonly signal: AbortSignal;
  readonly onFailed: (reason: string) => void;
}): Promise<{ readonly sessionId: string }> {
  const { pi } = options;
  const deadline = new AbortController();
  const cancelDeadline = options.clock.setTimeout(() => deadline.abort(), FORK_DEADLINE_MS);
  // The deadline is the whole fork's, not each request's.
  const asked = { timeoutMs: null, signal: AbortSignal.any([options.signal, deadline.signal]) };
  try {
    const { cancelled } =
      options.at === null
        ? await pi.request({ type: "clone" }, asked)
        : await pi.request({ type: "fork", entryId: options.at }, asked);
    if (cancelled) {
      options.onFailed("cancelled");
      throw new CommandError("fork_failed");
    }
    const { sessionId } = await pi.request({ type: "get_state" }, asked);
    await pi.request({ type: "set_session_name", name: options.name }, asked);
    return { sessionId };
  } catch (error) {
    if (!(error instanceof PiRequestError)) throw error;
    options.onFailed(deadline.signal.aborted ? "timeout" : error.reason);
    throw new CommandError("fork_failed");
  } finally {
    cancelDeadline();
    await pi.process.stop();
  }
}
