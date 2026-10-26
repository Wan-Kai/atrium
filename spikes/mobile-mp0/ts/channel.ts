/**
 * Atrium's wire layer around Noise (SPEC-0005, "Noise 通道"): the phone's first frame, the
 * prologue, the SAS, and the framing of plaintexts inside transport messages.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import {
  concat,
  decryptTransport,
  encryptTransport,
  MAX_TRANSPORT_PLAINTEXT,
  type Pattern,
  type Transport,
} from "./noise.ts";
import { fromUtf8, utf8 } from "./bytes.ts";

/** First byte of the phone's first frame: ASCII `A`. */
export const MAGIC = 0x41;
/** Wire version; the host closes on anything else, without falling back. */
export const WIRE_VERSION = 0x01;
/** The mode byte of each pattern. */
export const MODE_BYTE: Record<Pattern, number> = { IK: 0x01, IKpsk2: 0x02 };

/** Plaintext frame types: the first byte of every transport plaintext. */
export const FrameType = {
  /** The last (or only) chunk of an Atrium message. */
  Last: 0x00,
  /** A chunk with more to come. */
  More: 0x01,
  Ping: 0x02,
  Pong: 0x03,
  /** One channel control message, JSON, single chunk. */
  Control: 0x04,
} as const;

/** Largest Atrium message from the phone (same as the local socket). */
export const PHONE_TO_HOST_LIMIT = 1024 * 1024;
/** Largest Atrium message to the phone. */
export const HOST_TO_PHONE_LIMIT = 8 * 1024 * 1024;
/** A message whose first chunk came this long ago and still is not complete closes the channel. */
export const CHUNK_TIMEOUT_MS = 30_000;
/** Body bytes per chunk: the largest transport plaintext minus the type byte. */
export const MAX_CHUNK = MAX_TRANSPORT_PLAINTEXT - 1;

/** Why the wire layer closed a channel. */
export type ChannelFailure =
  | "bad_first_frame"
  | "unknown_version"
  | "unknown_mode"
  | "bad_frame"
  | "unknown_frame_type"
  | "bad_control"
  | "bad_utf8"
  | "message_too_large"
  | "chunk_timeout";

/** A wire-layer failure. */
export class ChannelError extends Error {
  readonly reason: ChannelFailure;

  /**
   * Makes the error.
   *
   * @sideEffects none
   * @param reason - Why.
   */
  constructor(reason: ChannelFailure) {
    super(`channel: ${reason}`);
    this.reason = reason;
  }
}

/**
 * The prologue both sides mix in: `atrium-remote/1`, 0x00, the hostId, 0x00.
 *
 * @sideEffects none
 * @param hostId - `hst_<16hex>`, ASCII.
 * @returns The bytes.
 * @throws Error on a non-ASCII or NUL-containing id.
 */
export function prologue(hostId: string): Uint8Array {
  if (!/^[\x21-\x7e]+$/.test(hostId)) throw new Error("hostId must be printable ASCII");
  return concat(utf8("atrium-remote/1"), Uint8Array.of(0), utf8(hostId), Uint8Array.of(0));
}

/**
 * The phone's first frame: magic, version, mode, then handshake message 1.
 *
 * @sideEffects none
 * @param pattern - IK or IKpsk2.
 * @param message1 - Handshake message 1.
 * @returns The frame.
 */
export function firstFrame(pattern: Pattern, message1: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(MAGIC, WIRE_VERSION, MODE_BYTE[pattern]), message1);
}

/**
 * Reads the phone's first frame.
 *
 * @sideEffects none
 * @param frame - The first binary frame from the phone.
 * @returns The pattern and handshake message 1.
 * @throws ChannelError bad_first_frame, unknown_version or unknown_mode.
 */
export function parseFirstFrame(frame: Uint8Array): { pattern: Pattern; message: Uint8Array } {
  if (frame.length < 3 || frame[0] !== MAGIC) throw new ChannelError("bad_first_frame");
  if (frame[1] !== WIRE_VERSION) throw new ChannelError("unknown_version");
  const pattern = frame[2] === MODE_BYTE.IK ? "IK" : frame[2] === MODE_BYTE.IKpsk2 ? "IKpsk2" : null;
  if (pattern === null) throw new ChannelError("unknown_mode");
  return { pattern, message: frame.subarray(3) };
}

/**
 * The 6-digit SAS: SHA-256("atrium-sas-v1" ‖ h), first 4 bytes big-endian, mod 10^6, zero-padded.
 *
 * @sideEffects none
 * @param handshakeHash - h at the end of the handshake.
 * @returns Six digits.
 */
export function sas(handshakeHash: Uint8Array): string {
  const digest = sha256(concat(utf8("atrium-sas-v1"), handshakeHash));
  const value = new DataView(digest.buffer, digest.byteOffset, 4).getUint32(0, false);
  return String(value % 1_000_000).padStart(6, "0");
}

/**
 * Splits one Atrium message into plaintext frames: `0x01` chunks, then a `0x00` one.
 *
 * @sideEffects none
 * @param text - The encoded message.
 * @param limit - The direction's message limit in bytes.
 * @returns The plaintexts, each at most 65519 bytes.
 * @throws ChannelError message_too_large.
 */
export function encodeMessage(text: string, limit: number): Uint8Array[] {
  const bytes = utf8(text);
  if (bytes.length > limit) throw new ChannelError("message_too_large");
  const frames: Uint8Array[] = [];
  for (let offset = 0; ; offset += MAX_CHUNK) {
    const end = Math.min(offset + MAX_CHUNK, bytes.length);
    const last = end === bytes.length;
    frames.push(concat(Uint8Array.of(last ? FrameType.Last : FrameType.More), bytes.subarray(offset, end)));
    if (last) return frames;
  }
}

/**
 * One control message (`0x04`, JSON object with a string `kind`).
 *
 * @sideEffects none
 * @param value - The message.
 * @returns The plaintext.
 */
export function encodeControl(value: { kind: string } & Record<string, unknown>): Uint8Array {
  return concat(Uint8Array.of(FrameType.Control), utf8(JSON.stringify(value)));
}

/** The heartbeat and its answer are exactly one byte. */
export const PING = Uint8Array.of(FrameType.Ping);
export const PONG = Uint8Array.of(FrameType.Pong);

/** What a plaintext frame turned out to be, once a message is complete. */
export type Received =
  | { kind: "message"; text: string }
  | { kind: "ping" }
  | { kind: "pong" }
  | { kind: "control"; value: { kind: string } & Record<string, unknown> };

/** Schedules the chunk timeout; returns a cancel function. Injected so tests control time. */
export type SetTimer = (ms: number, run: () => void) => () => void;

/**
 * The real timer.
 *
 * @sideEffects Starts a timer.
 * @param ms - Delay.
 * @param run - What to run.
 * @returns Cancel.
 */
export const realTimer: SetTimer = (ms, run) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/**
 * Reassembles plaintext frames of one direction into Atrium messages.
 *
 * @remarks
 * Chunks of one message are consecutive; pings, pongs and control messages may come between
 * them. The 30-second clock starts at the first `0x01` of a message.
 */
export class FrameReader {
  readonly #limit: number;
  readonly #setTimer: SetTimer;
  readonly #onTimeout: () => void;
  #chunks: Uint8Array[] = [];
  #size = 0;
  #cancelTimer: (() => void) | null = null;

  /**
   * Makes a reader.
   *
   * @sideEffects none
   * @param limit - Largest message in bytes for this direction.
   * @param setTimer - Timer source.
   * @param onTimeout - Called once when a message stays incomplete for 30 seconds.
   */
  constructor(limit: number, setTimer: SetTimer, onTimeout: () => void) {
    this.#limit = limit;
    this.#setTimer = setTimer;
    this.#onTimeout = onTimeout;
  }

  /**
   * Takes one decrypted plaintext.
   *
   * @sideEffects Buffers chunks; starts or stops the chunk timer.
   * @param plaintext - One transport plaintext.
   * @returns What completed, or null while a message is still coming.
   * @throws ChannelError on anything malformed or too large.
   */
  push(plaintext: Uint8Array): Received | null {
    const body = plaintext.subarray(1);
    switch (plaintext[0]) {
      case FrameType.Ping:
      case FrameType.Pong:
        if (body.length !== 0) throw new ChannelError("bad_frame");
        return { kind: plaintext[0] === FrameType.Ping ? "ping" : "pong" };
      case FrameType.Control:
        return { kind: "control", value: parseControl(body) };
      case FrameType.More:
      case FrameType.Last: {
        this.#size += body.length;
        if (this.#size > this.#limit) throw new ChannelError("message_too_large");
        this.#chunks.push(body);
        if (plaintext[0] === FrameType.More) {
          this.#cancelTimer ??= this.#setTimer(CHUNK_TIMEOUT_MS, this.#onTimeout);
          return null;
        }
        const bytes = concat(...this.#chunks);
        this.dispose();
        try {
          return { kind: "message", text: fromUtf8(bytes) };
        } catch {
          throw new ChannelError("bad_utf8");
        }
      }
      case undefined:
        throw new ChannelError("bad_frame");
      default:
        throw new ChannelError("unknown_frame_type");
    }
  }

  /**
   * Drops a half-received message and its timer.
   *
   * @sideEffects Stops the chunk timer.
   */
  dispose(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    this.#chunks = [];
    this.#size = 0;
  }
}

/**
 * Parses a control message body.
 *
 * @sideEffects none
 * @param body - UTF-8 JSON.
 * @returns The object.
 * @throws ChannelError bad_control.
 */
function parseControl(body: Uint8Array): { kind: string } & Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fromUtf8(body));
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as { kind?: unknown }).kind === "string"
    ) {
      return value as { kind: string } & Record<string, unknown>;
    }
  } catch {
    // Falls through to the error below.
  }
  throw new ChannelError("bad_control");
}

/** What a channel needs from its owner. */
export interface ChannelOptions {
  /** Sends one ciphertext as one binary frame. */
  readonly write: (ciphertext: Uint8Array) => void;
  /** Our outgoing message limit. */
  readonly sendLimit: number;
  /** The incoming message limit. */
  readonly receiveLimit: number;
  readonly onReceive: (received: Received) => void;
  /** Called once, with the reason, when the channel fails or is closed. */
  readonly onClose: (reason: string) => void;
  readonly setTimer?: SetTimer;
}

/**
 * An established channel: encrypts and frames what we send, decrypts and reassembles what comes.
 *
 * @remarks
 * Any failure closes it for good (SPEC-0005: "失败就关闭通道"); pongs to pings are sent here.
 */
export class SecureChannel {
  readonly handshakeHash: Uint8Array;
  readonly remoteStatic: Uint8Array;
  readonly #transport: Transport;
  readonly #options: ChannelOptions;
  readonly #reader: FrameReader;
  #closed = false;

  /**
   * Wraps a finished handshake.
   *
   * @sideEffects none
   * @param transport - From `HandshakeState.finish()`.
   * @param options - Where bytes go and limits.
   */
  constructor(transport: Transport, options: ChannelOptions) {
    this.#transport = transport;
    this.#options = options;
    this.handshakeHash = transport.handshakeHash;
    this.remoteStatic = transport.remoteStatic;
    this.#reader = new FrameReader(options.receiveLimit, options.setTimer ?? realTimer, () =>
      this.close("chunk_timeout"),
    );
  }

  /**
   * Whether the channel is closed.
   *
   * @sideEffects none
   * @returns True after close or failure.
   */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Sends one Atrium message, in as many chunks as it takes.
   *
   * @sideEffects Writes frames.
   * @param text - The encoded message.
   * @throws ChannelError message_too_large (the channel stays open; the caller sends something smaller).
   */
  sendMessage(text: string): void {
    for (const frame of encodeMessage(text, this.#options.sendLimit)) this.#send(frame);
  }

  /**
   * Sends one control message.
   *
   * @sideEffects Writes a frame.
   * @param value - The message.
   */
  sendControl(value: { kind: string } & Record<string, unknown>): void {
    this.#send(encodeControl(value));
  }

  /**
   * Sends a heartbeat.
   *
   * @sideEffects Writes a frame.
   */
  ping(): void {
    this.#send(PING);
  }

  /**
   * Takes one ciphertext frame from the other side.
   *
   * @sideEffects Calls `onReceive`, answers pings, closes on any failure.
   * @param ciphertext - One binary frame.
   */
  receive(ciphertext: Uint8Array): void {
    if (this.#closed) return;
    let received: Received | null;
    try {
      received = this.#reader.push(decryptTransport(this.#transport.receive, ciphertext));
    } catch (error) {
      this.close((error as { reason?: string }).reason ?? "error");
      return;
    }
    if (received === null) return;
    if (received.kind === "ping") this.#send(PONG);
    this.#options.onReceive(received);
  }

  /**
   * Closes the channel and drops its state.
   *
   * @sideEffects Stops the chunk timer; calls `onClose` the first time.
   * @param reason - Why, for logs.
   */
  close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#reader.dispose();
    this.#transport.send.invalidate();
    this.#transport.receive.invalidate();
    this.#options.onClose(reason);
  }

  /**
   * Encrypts and writes one plaintext frame.
   *
   * @sideEffects Writes a frame; closes on failure.
   * @param plaintext - The frame.
   */
  #send(plaintext: Uint8Array): void {
    if (this.#closed) return;
    let ciphertext: Uint8Array;
    try {
      ciphertext = encryptTransport(this.#transport.send, plaintext);
    } catch (error) {
      this.close((error as { reason?: string }).reason ?? "error");
      return;
    }
    this.#options.write(ciphertext);
  }
}
