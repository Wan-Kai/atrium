import { CloseCode, type HostMessage, type SessionSnapshotEvent } from "@atrium/protocol";
import type { Context } from "@opentelemetry/api";
import type { Logger } from "../platform/logger";
import { forPhone, pushedToPhone } from "./remote-policy";
import type { ClientTransport } from "./transport";

/** The part of a transport a connection needs; tests pass a stand-in. */
export type SocketLike = Pick<ClientTransport, "bufferedAmount" | "send" | "close">;

/** One authenticated client connection. */
export interface Connection {
  /** Opaque id the session layer knows the connection by (domain-model §6). */
  readonly id: string;
  /** The id the client chose for itself in `hello`; a phone's is its `deviceId`. */
  readonly clientId: string;
  /** Trace context of the accepted handshake; command spans link to it. */
  readonly trace: Context;
  /** The local window, or a paired phone; set by the transport, never by the client. */
  readonly origin: "local" | "remote";
  /** The paired phone behind a remote connection; `null` for a local one. */
  readonly deviceId: string | null;
  /**
   * Sends one message, unless the client has fallen too far behind.
   *
   * @returns Whether the message was sent.
   */
  send(message: HostMessage): boolean;
}

/** What a phone's connection does differently (SPEC-0005, "Noise 通道 · 大小"). */
export interface RemoteSending {
  readonly deviceId: string;
  /** Largest encoded message to the phone. */
  readonly maxMessageBytes: number;
  /** A session's current snapshot, for an event too large to send; `null` when there is none. */
  readonly snapshotOf: (sessionId: string) => SessionSnapshotEvent | null;
}

/**
 * Wraps an authenticated transport as a connection.
 *
 * @remarks
 * Every message to a client goes through `send`, which looks at how much is still waiting to be
 * sent first: past `maxBufferedBytes` the client is reading too slowly, so the connection is closed
 * with 4507 and nothing more is queued for it, rather than letting the host's memory grow without
 * bound. The client reconnects and catches up from its cursors (SPEC-0001, "发送端背压").
 *
 * A phone's connection also drops what is not for the phone, whoever sent it, sends the list
 * without what the phone never shows (`forPhone`), and keeps to its
 * message limit: a response too large becomes a `response_too_large` failure, a session event too
 * large becomes that session's snapshot, and anything else too large is dropped and logged
 * (SPEC-0005, "给手机推什么", "大小"). Sizes are of the encoded message, envelope included.
 *
 * @sideEffects none until `send` is called.
 * @param socket - The authenticated transport.
 * @param options - Ids, the handshake's trace, the backlog limit, the logger and, for a phone, its rules.
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
    readonly remote?: RemoteSending;
  },
): Connection {
  const { remote } = options;
  let dropped = false;

  /**
   * Sends one encoded message unless the client fell behind.
   *
   * @remarks
   * The backlog is checked before each message, as `send` describes.
   *
   * @sideEffects Sends, or closes the socket once and logs.
   * @param text - The encoded message.
   * @returns Whether it was sent.
   */
  function write(text: string): boolean {
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
    socket.send(text);
    return true;
  }

  /**
   * Sends a phone what fits, or what stands in for what does not.
   *
   * @remarks
   * See `createConnection`.
   *
   * @sideEffects Sends; logs what was dropped.
   * @param rules - The phone's rules.
   * @param original - The message, as every client gets it.
   * @returns Whether something was sent.
   */
  function sendToPhone(rules: RemoteSending, original: HostMessage): boolean {
    if (!pushedToPhone(original)) return false;
    const message = forPhone(original);
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) <= rules.maxMessageBytes) return write(text);
    if (message.type === "response") {
      return write(
        JSON.stringify({
          type: "response",
          requestId: message.requestId,
          ok: false,
          error: { code: "response_too_large", params: { limit: rules.maxMessageBytes } },
        } satisfies HostMessage),
      );
    }
    // A visual of a direction names no session; phones never get one (SPEC-0008, ML4).
    const snapshot =
      "sessionId" in message && message.sessionId !== undefined ? rules.snapshotOf(message.sessionId) : null;
    if (snapshot !== null) {
      const replacement = JSON.stringify(snapshot);
      if (Buffer.byteLength(replacement) <= rules.maxMessageBytes) return write(replacement);
    }
    options.logger.warn(
      { device_id: rules.deviceId, type: message.type, bytes: Buffer.byteLength(text) },
      "message too large for the phone dropped",
    );
    return false;
  }

  return {
    id: options.id,
    clientId: options.clientId,
    trace: options.trace,
    origin: remote === undefined ? "local" : "remote",
    deviceId: remote?.deviceId ?? null,
    send(message) {
      return remote === undefined ? write(JSON.stringify(message)) : sendToPhone(remote, message);
    },
  };
}
