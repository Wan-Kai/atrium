import {
  type ControlMessage,
  HOST_TO_PHONE_LIMIT,
  PHONE_TO_HOST_LIMIT,
  type Pattern,
  parseFirstFrame,
  type Received,
  SecureChannel,
  type Transport,
} from "@atrium/remote-crypto";
import { type RawData, WebSocket } from "ws";
import { type Clock, trackedTimeout } from "../platform/clock";
import type { ResourceTracker } from "../platform/resources";
import type { ClientTransport } from "../server/transport";
import type { RelayEndpoint } from "./relay-line";

/** A stream that has not finished its Noise handshake this long after it opened is closed (SPEC-0005). */
export const HANDSHAKE_TIMEOUT_MS = 10_000;
/** A channel that has heard nothing from the phone this long is gone (SPEC-0005, "心跳"). */
export const SILENCE_MS = 30_000;

/** What a stream tells its owner. */
export interface StreamEvents {
  /** The phone's first frame, parsed; the owner runs the handshake and calls `secure` or `close`. */
  readonly onFirstFrame: (stream: PhoneStream, pattern: Pattern, message: Uint8Array) => void;
  /** A channel control message (`pair_confirm`). */
  readonly onControl: (stream: PhoneStream, value: ControlMessage) => void;
  /** Called once, when the stream has closed. */
  readonly onClosed: (stream: PhoneStream, reason: string) => void;
  /** Counts ciphertext only while a local page watches traffic. */
  readonly onBytes: (stream: PhoneStream, direction: "up" | "down", bytes: number) => void;
}

/**
 * One phone's stream on the host: its data connection to the relay, the Noise handshake, then the
 * encrypted channel (SPEC-0005, "relay 的线路协议", "Noise 通道").
 *
 * @remarks
 * The owner decides the handshake (it has the keys, the pairing and the devices); the stream only
 * carries bytes, keeps time and frames. The Noise handshake must be done within 10 s of the stream
 * opening. Once the channel is up, Atrium messages go to whoever took `transport` (the server);
 * control messages go to the owner; heartbeats are answered by the channel. Bytes are counted on
 * the data connection, as ciphertext, for the "手机" page's traffic. The data connection counts as
 * `remote.data` until it closes.
 *
 * @sideEffects Opens a data connection to the relay; schedules the handshake timer.
 */
export class PhoneStream {
  readonly streamId: string;
  /** The paired phone this stream belongs to, once it is a session. */
  deviceId: string | null = null;
  readonly #socket: WebSocket;
  readonly #clock: Clock;
  readonly #events: StreamEvents;
  readonly #releaseData: () => void;
  readonly done: Promise<void>;
  #cancelClose: (() => void) | null = null;
  readonly #resources: ResourceTracker;
  #cancelHandshake: (() => void) | null;
  #channel: SecureChannel | null = null;
  #firstFrameSeen = false;
  #closed = false;
  #lastHeard: number;
  #messageListener: ((text: string | null) => void) | null = null;
  readonly #closeListeners: ((code: number) => void)[] = [];

  /**
   * Opens the data connection for a stream the relay announced.
   *
   * @remarks
   * The data connection proves itself with the host's token and names the stream (SPEC-0005,
   * "relay 的线路协议").
   *
   * @sideEffects Connects to the relay; starts the handshake timer.
   * @param streamId - From the relay's `open`.
   * @param endpoint - The relay and the host's credentials.
   * @param options - Clock, resources and what to tell the owner.
   */
  constructor(
    streamId: string,
    endpoint: RelayEndpoint,
    options: { readonly clock: Clock; readonly resources: ResourceTracker; readonly events: StreamEvents },
  ) {
    this.streamId = streamId;
    this.#clock = options.clock;
    this.#resources = options.resources;
    this.#events = options.events;
    this.#lastHeard = options.clock.now();
    this.#releaseData = options.resources.acquire("remote.data");
    this.#socket = new WebSocket(`${endpoint.url}/v1/host/stream`, { perMessageDeflate: false, maxPayload: 70 * 1024 });
    this.done = new Promise((resolve) => {
      this.#socket.once("close", () => {
        this.close("socket_closed");
        this.#cancelClose?.();
        this.#releaseData();
        resolve();
      });
    });
    this.#socket.binaryType = "nodebuffer";
    this.#socket.on("open", () => {
      this.#socket.send(
        JSON.stringify({ v: 1, type: "hello", hostId: endpoint.hostId, token: endpoint.token, streamId }),
      );
    });
    this.#socket.on("message", (data: RawData, isBinary: boolean) => this.#onFrame(data, isBinary));
    // Errors are followed by `close`.
    this.#socket.on("error", () => {});
    this.#cancelHandshake = trackedTimeout(
      options.clock,
      options.resources,
      () => this.close("handshake_timeout"),
      HANDSHAKE_TIMEOUT_MS,
    );
  }

  /**
   * Whether the stream has closed.
   *
   * @remarks
   * A closed stream sends nothing more.
   *
   * @sideEffects none
   * @returns True once closed.
   */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Whether the stream got past its handshake: it is a session, or a phone that claimed a pairing.
   *
   * @remarks
   * The host counts streams not yet settled against its limit of handshakes under way, and closes
   * them 10 s after they opened (SPEC-0005, "宿主自己也设限"); a pairing phone that never sends its
   * key confirmation counts as one too.
   *
   * @sideEffects none
   * @returns True once `settle` was called.
   */
  get settled(): boolean {
    return this.#cancelHandshake === null && !this.#closed;
  }

  /**
   * The phone's static public key, once the channel is up.
   *
   * @remarks
   * Read from handshake message 1; the host knows a device by it.
   *
   * @sideEffects none
   * @returns The key, or `null` before.
   */
  get remoteStatic(): Uint8Array | null {
    return this.#channel?.remoteStatic ?? null;
  }

  /**
   * Ends the handshake's time limit: the phone is a session, or waits for the Mac's answer.
   *
   * @remarks
   * See `settled`.
   *
   * @sideEffects Cancels the handshake timer.
   */
  settle(): void {
    this.#cancelHandshake?.();
    this.#cancelHandshake = null;
  }

  /**
   * The channel's handshake hash, for the SAS.
   *
   * @remarks
   * Only after `secure`.
   *
   * @sideEffects none
   * @returns h, or `null` before.
   */
  get handshakeHash(): Uint8Array | null {
    return this.#channel?.handshakeHash ?? null;
  }

  /**
   * Writes handshake message 2 as it is, before the channel exists.
   *
   * @remarks
   * The host's first frame is message 2 itself (SPEC-0005, "手机的第一帧").
   *
   * @sideEffects Sends a frame.
   * @param message - Handshake message 2.
   */
  sendRaw(message: Uint8Array): void {
    this.#write(message);
  }

  /**
   * Starts the encrypted channel after the handshake.
   *
   * @remarks
   * The handshake's time limit runs on until `settle`.
   *
   * @sideEffects none until messages flow.
   * @param transport - From the finished handshake.
   */
  secure(transport: Transport): void {
    if (this.#closed) return;
    this.#channel = new SecureChannel(transport, {
      write: (bytes) => this.#write(bytes),
      sendLimit: HOST_TO_PHONE_LIMIT,
      receiveLimit: PHONE_TO_HOST_LIMIT,
      onReceive: (received) => this.#onReceive(received),
      onClose: (reason) => this.close(reason),
      clock: {
        now: () => this.#clock.now(),
        setTimeout: (callback, ms) => trackedTimeout(this.#clock, this.#resources, callback, ms),
      },
    });
  }

  /**
   * Sends one channel control message.
   *
   * @remarks
   * `paired`, `pair_rejected`, `revoked`.
   *
   * @sideEffects Sends a frame.
   * @param value - The message.
   */
  sendControl(value: ControlMessage): void {
    this.#channel?.sendControl(value);
  }

  /**
   * The channel as a client transport, for the server once the phone is a session.
   *
   * @remarks
   * Messages too large for the phone are kept from here by the connection (SPEC-0005, "大小"); one
   * that still gets here closes the channel rather than going out. The backlog is the phone's own
   * data connection's, so one slow phone backs up only itself (SPEC-0005, "relay 的线路协议"). The
   * probe is a channel heartbeat, and a phone silent for 30 s is dropped.
   *
   * @sideEffects none until used.
   * @returns The transport.
   */
  transport(): ClientTransport {
    const socket = this.#socket;
    return {
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
      send: (text) => {
        try {
          this.#channel?.sendMessage(text);
        } catch {
          this.close("message_too_large");
        }
      },
      close: (_code, reason) => this.close(reason),
      onMessage: (listener) => {
        this.#messageListener = listener;
      },
      onClose: (listener) => {
        if (this.#closed) listener(1000);
        else this.#closeListeners.push(listener);
      },
      checkAlive: () => {
        if (this.#clock.now() - this.#lastHeard >= SILENCE_MS) {
          this.close("heartbeat_timeout");
          return false;
        }
        this.#channel?.ping();
        return true;
      },
    };
  }

  /**
   * Closes the channel and the data connection, once.
   *
   * @remarks
   * Whoever listens hears of it after the stream is marked closed, so nothing more is sent.
   * A peer may send Close without ending TCP; CLOSING sockets need the same forced-close deadline.
   *
   * @sideEffects Closes the socket; stops timers; tells the owner and the server.
   * @param reason - Why, for the log.
   */
  close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelHandshake?.();
    this.#cancelHandshake = null;
    this.#channel?.close(reason);
    if (this.#socket.readyState === WebSocket.CONNECTING) this.#socket.terminate();
    else if (this.#socket.readyState !== WebSocket.CLOSED) {
      this.#socket.close(1000);
      this.#cancelClose = trackedTimeout(this.#clock, this.#resources, () => this.#socket.terminate(), 1000);
    }
    for (const listener of this.#closeListeners.splice(0)) listener(1000);
    this.#events.onClosed(this, reason);
  }

  /**
   * Sends one binary frame and counts it.
   *
   * @remarks
   * Counts what goes out for the traffic.
   *
   * @sideEffects Sends.
   * @param bytes - The frame.
   */
  #write(bytes: Uint8Array): void {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) return;
    this.#events.onBytes(this, "down", bytes.length);
    this.#socket.send(bytes);
  }

  /**
   * One frame from the phone.
   *
   * @remarks
   * Text frames are refused, as the relay does (SPEC-0005, "帧").
   *
   * @sideEffects Runs the handshake through the owner, or feeds the channel; may close.
   * @param data - The frame.
   * @param isBinary - Whether it was binary.
   */
  #onFrame(data: RawData, isBinary: boolean): void {
    if (this.#closed) return;
    if (!isBinary) {
      this.close("text_frame");
      return;
    }
    const bytes = toBytes(data);
    this.#events.onBytes(this, "up", bytes.length);
    this.#lastHeard = this.#clock.now();
    if (this.#channel !== null) {
      this.#channel.receive(bytes);
      return;
    }
    if (this.#firstFrameSeen) {
      this.close("unexpected_frame");
      return;
    }
    this.#firstFrameSeen = true;
    let first: { pattern: Pattern; message: Uint8Array };
    try {
      first = parseFirstFrame(bytes);
    } catch (error) {
      this.close(reasonOf(error));
      return;
    }
    this.#events.onFirstFrame(this, first.pattern, first.message);
  }

  /**
   * What the channel decoded.
   *
   * @remarks
   * Heartbeats are handled by the channel itself.
   *
   * @sideEffects Hands messages to the server and controls to the owner.
   * @param received - The frame or message.
   */
  #onReceive(received: Received): void {
    if (received.kind === "control") this.#events.onControl(this, received.value);
    else if (received.kind === "message") {
      if (this.#messageListener === null) this.close("unexpected_message");
      else this.#messageListener(received.text);
    }
  }
}

/**
 * The bytes of a frame.
 *
 * @remarks
 * The data connection is set to `nodebuffer`, but `ws` may still hand over fragments.
 *
 * @sideEffects none
 * @param data - The frame.
 * @returns Its bytes.
 */
function toBytes(data: RawData): Uint8Array {
  const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
}

/**
 * The reason a refused frame carries.
 *
 * @remarks
 * Errors of the crypto package have one; anything else is logged as `handshake_failed`.
 *
 * @sideEffects none
 * @param error - What was thrown.
 * @returns The reason.
 */
export function reasonOf(error: unknown): string {
  const reason: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "reason") : undefined;
  return typeof reason === "string" ? reason : "handshake_failed";
}
