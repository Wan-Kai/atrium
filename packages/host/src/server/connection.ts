import { CloseCode, type HostMessage } from "@atrium/protocol";
import type { Context } from "@opentelemetry/api";
import type { Logger } from "../platform/logger";

/** The part of a WebSocket a connection needs; tests pass a stand-in. */
export interface SocketLike {
  /** Bytes queued for sending that the peer has not taken yet. */
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code: number, reason: string): void;
}

/** One authenticated client connection. */
export interface Connection {
  /** Opaque id the session layer knows the connection by (domain-model §6). */
  readonly id: string;
  /** The id the client chose for itself in `hello`. */
  readonly clientId: string;
  /** Trace context of the accepted handshake; command spans link to it. */
  readonly trace: Context;
  /**
   * Sends one message, unless the client has fallen too far behind.
   *
   * @returns Whether the message was sent.
   */
  send(message: HostMessage): boolean;
}

/**
 * Wraps an authenticated socket as a connection.
 *
 * @remarks
 * Every message to a client goes through `send`, which looks at how much is still waiting to be
 * sent first: past `maxBufferedBytes` the client is reading too slowly, so the connection is closed
 * with 4507 and nothing more is queued for it, rather than letting the host's memory grow without
 * bound. The client reconnects and catches up from its cursors (SPEC-0001, "发送端背压").
 *
 * @sideEffects none until `send` is called.
 * @param socket - The authenticated socket.
 * @param options - Ids, the handshake's trace, the backlog limit and the logger.
 * @returns The connection.
 */
export function createConnection(
  socket: SocketLike,
  options: {
    readonly id: string;
    readonly clientId: string;
    readonly trace: Context;
    readonly maxBufferedBytes: number;
    readonly logger: Logger;
  },
): Connection {
  let dropped = false;
  return {
    id: options.id,
    clientId: options.clientId,
    trace: options.trace,
    send(message) {
      if (dropped) return false;
      if (socket.bufferedAmount > options.maxBufferedBytes) {
        dropped = true;
        options.logger.warn(
          { client_id: options.clientId, buffered_bytes: socket.bufferedAmount },
          "client dropped: reading too slowly",
        );
        socket.close(CloseCode.SlowConsumer, "slow consumer");
        return false;
      }
      socket.send(JSON.stringify(message));
      return true;
    },
  };
}
