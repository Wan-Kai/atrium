import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import { type Clock, trackedTimeout } from "../platform/clock";
import type { ResourceTracker } from "../platform/resources";
import type { RelayError } from "./relay-link";

/** A finished live check, with only safe failure categories. */
export interface RelayPongResult {
  readonly error: RelayError | null;
  readonly failure: "token_rejected" | "timeout" | "connection_closed" | null;
}

/**
 * Checks one already-open control socket with a unique non-secret ping payload.
 * @remarks Only the corresponding pong succeeds; a write callback and unrelated pongs prove nothing.
 * The caller owns authentication and coalesces concurrent requests. Close or deadline always settles the check.
 * A missed probe is not a control-connection lifecycle decision; normal heartbeat and close remain the caller's responsibility.
 * @sideEffects Sends one ping; owns two listeners and a tracked deadline until settled.
 * @param socket - The already-open authenticated control connection.
 * @param options - The host's clock and resource accounting.
 * @param timeoutMs - The bounded check deadline.
 */
export function checkRelayPong(
  socket: WebSocket,
  options: { readonly clock: Clock; readonly resources: ResourceTracker },
  timeoutMs: number,
): Promise<RelayPongResult> {
  const payload = randomBytes(16);
  return new Promise((resolve) => {
    const cancel = trackedTimeout(
      options.clock,
      options.resources,
      () => {
        finish({ error: "relay_unreachable", failure: "timeout" });
      },
      timeoutMs,
    );
    /** Releases the check before settling it. @remarks Unrelated pongs must not consume the listener. @sideEffects Cancels the timer and removes listeners.
     * @param result - The check's safe outcome.
     */
    const finish = (result: RelayPongResult): void => {
      cancel();
      socket.off("pong", pong);
      socket.off("close", closed);
      resolve(result);
    };
    /** Matches this check's payload. @remarks Ordinary heartbeat and previous-check pongs are ignored. @sideEffects Finishes only the corresponding check.
     * @param data - The actual pong payload.
     */
    const pong = (data: Buffer): void => {
      if (data.equals(payload)) finish({ error: null, failure: null });
    };
    /** Settles a disconnected check. @remarks The relay may explicitly reject this identity. @sideEffects Removes the check's resources.
     * @param code - The socket close code.
     */
    const closed = (code: number): void =>
      finish({
        error: code === 4401 ? "relay_rejected" : "relay_unreachable",
        failure: code === 4401 ? "token_rejected" : "connection_closed",
      });
    socket.on("pong", pong);
    socket.once("close", closed);
    socket.ping(payload);
  });
}
