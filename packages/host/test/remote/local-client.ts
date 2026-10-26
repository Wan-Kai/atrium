import { PROTOCOL_VERSION } from "@atrium/protocol";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { systemClock } from "../../src/platform/clock";
import { Inbox } from "./inbox";

/**
 * Records the complete wire of a local desktop client, including events ignored by UI stores.
 * @remarks Remote-management tests need to compare watched, unwatched and phone event streams.
 * @sideEffects Opens a local socket and records received envelopes.
 */
export class LocalClient {
  readonly received: Array<Record<string, unknown>> = [];
  readonly #socket: WebSocket;
  readonly #inbox = new Inbox<Record<string, unknown>>(systemClock);
  readonly #closed: Promise<void>;

  /**
   * Opens the local host socket and sends its authenticated hello.
   * @remarks The host fixture provides an isolated URL and token.
   * @sideEffects Opens a socket and registers message listeners.
   * @param url - Test host URL.
   * @param token - Test host token.
   */
  constructor(url: string, token: string) {
    this.#socket = new WebSocket(url);
    this.#socket.once("open", () =>
      this.#socket.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          token,
          clientId: randomUUID(),
          traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        }),
      ),
    );
    this.#socket.on("message", (data) => {
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      const value = JSON.parse(buffer.toString()) as Record<string, unknown>;
      this.received.push(value);
      this.#inbox.push(value);
    });
    this.#socket.on("error", (error) => this.#inbox.fail(error));
    this.#closed = new Promise((resolve) =>
      this.#socket.once("close", () => {
        this.#inbox.fail(new Error("local socket closed"));
        resolve();
      }),
    );
  }

  /**
   * Waits for a selected envelope.
   * @remarks Already delivered events remain available in the inbox.
   * @sideEffects Consumes an envelope or registers a timeout.
   * @param matches - Envelope predicate.
   * @returns The selected envelope.
   */
  next(matches: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    return this.#inbox.next(matches);
  }

  /**
   * Sends a command and waits for its correlated response.
   * @remarks Management events may interleave responses and must not be lost.
   * @sideEffects Sends a local command and registers a receive timeout.
   * @param command - Command fields.
   * @returns Its response envelope.
   */
  async request(command: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const requestId = randomUUID();
    this.#socket.send(
      JSON.stringify({ ...command, requestId, traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01" }),
    );
    return this.next((value) => value.requestId === requestId);
  }

  /**
   * Closes the owned socket and waits for its actual release.
   * @remarks Idempotent teardown also handles a rejected handshake.
   * @sideEffects Terminates the socket.
   * @returns When the socket has closed.
   */
  async close(): Promise<void> {
    this.#socket.terminate();
    await this.#closed;
  }
}
