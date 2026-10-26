/**
 * The framing of plaintexts inside Noise transport messages (SPEC-0005, "Noise 通道 · 分帧").
 */
import { fromUtf8, utf8 } from "./bytes";
import { concat } from "./noise";
import { CHUNK_TIMEOUT_MS, ChannelError, MAX_CHUNK } from "./wire";

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

/** A channel control message: a JSON object with a string `kind`. */
export type ControlMessage = { readonly kind: string } & Readonly<Record<string, unknown>>;

/** What a plaintext frame turned out to be, once a message is complete. */
export type Received =
  | { kind: "message"; text: string }
  | { kind: "ping" }
  | { kind: "pong" }
  | { kind: "control"; value: ControlMessage };

/**
 * Time and timers, as the host's `Clock` has them; injected so tests control time.
 *
 * @remarks
 * Structural, so the host's clock and testkit's `FakeClock` fit without this package importing
 * either (overview.md, "包之间的依赖").
 */
export interface Clock {
  now(): number;
  /** Schedules `callback` after `ms`; returns a function that cancels it. */
  setTimeout(callback: () => void, ms: number): () => void;
}

/** The heartbeat is exactly one byte. */
export const PING = Uint8Array.of(FrameType.Ping);
/** The heartbeat's answer is exactly one byte. */
export const PONG = Uint8Array.of(FrameType.Pong);

/**
 * Splits one Atrium message into plaintext frames: `0x01` chunks, then a `0x00` one.
 *
 * @remarks
 * A Noise message holds at most 65535 bytes, so longer messages go in chunks; the size limit is
 * checked on the encoded message, envelope included (SPEC-0005, "大小").
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
 * @remarks
 * Control messages are single chunks: `pair_confirm`, `paired`, `pair_rejected`, `revoked`.
 *
 * @sideEffects none
 * @param value - The message.
 * @returns The plaintext.
 */
export function encodeControl(value: ControlMessage): Uint8Array {
  return concat(Uint8Array.of(FrameType.Control), utf8(JSON.stringify(value)));
}

/**
 * Reassembles plaintext frames of one direction into Atrium messages.
 *
 * @remarks
 * Chunks of one message are consecutive; pings, pongs and control messages may come between
 * them. The 30-second clock starts at the first `0x01` of a message, so a sender that trickles
 * chunks cannot hold a half message open for ever.
 *
 * @sideEffects Buffers chunks; schedules the chunk timeout on the clock.
 */
export class FrameReader {
  readonly #limit: number;
  readonly #clock: Clock;
  readonly #onTimeout: () => void;
  #chunks: Uint8Array[] = [];
  #size = 0;
  #cancelTimer: (() => void) | null = null;

  /**
   * Makes a reader.
   *
   * @remarks
   * One per direction of a channel.
   *
   * @sideEffects none
   * @param limit - Largest message in bytes for this direction.
   * @param clock - Where the chunk timeout is scheduled.
   * @param onTimeout - Called once when a message stays incomplete for 30 seconds.
   */
  constructor(limit: number, clock: Clock, onTimeout: () => void) {
    this.#limit = limit;
    this.#clock = clock;
    this.#onTimeout = onTimeout;
  }

  /**
   * Takes one decrypted plaintext.
   *
   * @remarks
   * Anything malformed throws; the caller closes the channel (SPEC-0005: "不认识的类型就关闭").
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
          this.#cancelTimer ??= this.#clock.setTimeout(this.#onTimeout, CHUNK_TIMEOUT_MS);
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
   * @remarks
   * After a complete message, and when the channel closes, so no timer outlives it.
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
 * @remarks
 * Only an object with a string `kind`; anything else closes the channel.
 *
 * @sideEffects none
 * @param body - UTF-8 JSON.
 * @returns The object.
 * @throws ChannelError bad_control.
 */
function parseControl(body: Uint8Array): ControlMessage {
  let value: unknown;
  try {
    value = JSON.parse(fromUtf8(body));
  } catch {
    throw new ChannelError("bad_control");
  }
  if (!isControl(value)) throw new ChannelError("bad_control");
  return value;
}

/**
 * Whether a parsed value is a control message.
 *
 * @remarks
 * A type guard, so the parsed JSON is narrowed without a cast.
 *
 * @sideEffects none
 * @param value - Parsed JSON.
 * @returns Whether it is an object with a string `kind`.
 */
function isControl(value: unknown): value is ControlMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof Reflect.get(value, "kind") === "string"
  );
}
