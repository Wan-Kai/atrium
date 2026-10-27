/**
 * Atrium's wire layer around Noise (SPEC-0005, "Noise 通道"): the phone's first frame, the
 * prologue, the SAS and the size limits.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, MAX_TRANSPORT_PLAINTEXT, type Pattern } from "./noise";
import { utf8 } from "./bytes";

/** First byte of the phone's first frame: ASCII `A`. */
const MAGIC = 0x41;
/** Wire version; the host closes on anything else, without falling back. */
const WIRE_VERSION = 0x01;
/** The mode byte of each pattern. */
export const MODE_BYTE: Readonly<Record<Pattern, number>> = { IK: 0x01, IKpsk2: 0x02 };

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

/**
 * A wire-layer failure, with a reason that can be logged without the bytes.
 *
 * @remarks
 * Logs carry only the reason, never what was received (observability.md, "脱敏").
 *
 * @sideEffects none
 */
export class ChannelError extends Error {
  readonly reason: ChannelFailure;

  /**
   * Makes the error.
   *
   * @remarks
   * The message names only the reason.
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
 * @remarks
 * Binds the handshake to this host on this relay, so a handshake meant for another host fails
 * (SPEC-0005, "prologue").
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
 * @remarks
 * The host reads the mode before it knows which handshake to run (SPEC-0005, "手机的第一帧").
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
 * @remarks
 * An unknown version or mode is refused outright, never downgraded (SPEC-0005, "安全").
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
 * @remarks
 * Shown on both screens for a person to compare; about 20 bits, so it adds to the PSK and the key
 * confirmation rather than replacing them (SPEC-0005, "配对流程" step 4).
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
