import {
  type Clock,
  type ControlMessage,
  type Deflate,
  encodeControl,
  encodeMessage,
  FrameReader,
  type Inflate,
  PING,
  PONG,
  type Received,
} from "./framing";
import { decryptTransport, encryptTransport, NoiseError, type Transport } from "./noise";
import { ChannelError } from "./wire";

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
  /** Where the chunk timeout is scheduled. */
  readonly clock: Clock;
  /** Compresses large outgoing messages; only when the other side asked (SPEC-0005, "压缩"). */
  readonly deflate?: Deflate;
  /** Decompresses incoming deflated messages; without it they close the channel. */
  readonly inflate?: Inflate;
}

/**
 * An established channel: encrypts and frames what we send, decrypts and reassembles what comes.
 *
 * @remarks
 * Any failure closes it for good (SPEC-0005: "失败就关闭通道"); pings are answered here, so both
 * sides' heartbeats work without the owner's help. It knows nothing of sockets: the owner writes
 * the ciphertexts and feeds in what arrives.
 *
 * @sideEffects Writes through the owner's `write`; schedules the chunk timeout.
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
   * @remarks
   * The transport's ciphers belong to the channel from now on.
   *
   * @sideEffects none
   * @param transport - From `HandshakeState.finish()`.
   * @param options - Where bytes go, limits and the clock.
   */
  constructor(transport: Transport, options: ChannelOptions) {
    this.#transport = transport;
    this.#options = options;
    this.handshakeHash = transport.handshakeHash;
    this.remoteStatic = transport.remoteStatic;
    this.#reader = new FrameReader(
      options.receiveLimit,
      options.clock,
      () => this.close("chunk_timeout"),
      options.inflate,
    );
  }

  /**
   * Whether the channel is closed.
   *
   * @remarks
   * Sends after close are dropped.
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
   * @remarks
   * A message over the limit is refused before anything is written, so the channel stays usable
   * and the caller can send something smaller instead (SPEC-0005, "大小").
   *
   * @sideEffects Writes frames.
   * @param text - The encoded message.
   * @throws ChannelError message_too_large.
   */
  sendMessage(text: string): void {
    for (const frame of encodeMessage(text, this.#options.sendLimit, this.#options.deflate)) this.#send(frame);
  }

  /**
   * Sends one control message.
   *
   * @remarks
   * `paired`, `pair_rejected`, `revoked` from the host; `pair_confirm` from the phone.
   *
   * @sideEffects Writes a frame.
   * @param value - The message.
   */
  sendControl(value: ControlMessage): void {
    this.#send(encodeControl(value));
  }

  /**
   * Sends a heartbeat.
   *
   * @remarks
   * The other side's channel answers it with a pong.
   *
   * @sideEffects Writes a frame.
   */
  ping(): void {
    this.#send(PING);
  }

  /**
   * Takes one ciphertext frame from the other side.
   *
   * @remarks
   * A frame that fails to decrypt (tampered, replayed, dropped or reordered) closes the channel.
   *
   * @sideEffects Calls `onReceive`, answers pings, closes on any failure.
   * @param ciphertext - One binary frame.
   */
  receive(ciphertext: Uint8Array): void {
    // Stryker disable next-line ConditionalExpression: equivalent, close() killed the receive cipher, so decrypting throws and close() returns at once.
    if (this.#closed) return;
    let received: Received | null;
    try {
      received = this.#reader.push(decryptTransport(this.#transport.receive, ciphertext));
    } catch (error) {
      this.close(reasonOf(error));
      return;
    }
    if (received === null) return;
    if (received.kind === "ping") this.#send(PONG);
    this.#options.onReceive(received);
  }

  /**
   * Closes the channel and drops its state.
   *
   * @remarks
   * Both ciphers are killed, so nothing more can be sent or read with these keys.
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
   * @remarks
   * Running out of nonces closes the channel (SPEC-0005, "不做 rekey").
   *
   * @sideEffects Writes a frame; closes on failure.
   * @param plaintext - The frame.
   */
  #send(plaintext: Uint8Array): void {
    // Stryker disable next-line ConditionalExpression: equivalent, close() killed the send cipher, so encrypting throws and close() returns at once.
    if (this.#closed) return;
    let ciphertext: Uint8Array;
    try {
      ciphertext = encryptTransport(this.#transport.send, plaintext);
    } catch (error) {
      this.close(reasonOf(error));
      return;
    }
    this.#options.write(ciphertext);
  }
}

/**
 * The reason a Noise or wire error carries.
 *
 * @remarks
 * Both error classes have a `reason`; anything else would be a bug, reported as `error`.
 *
 * @sideEffects none
 * @param error - What was thrown.
 * @returns The reason.
 */
function reasonOf(error: unknown): string {
  return error instanceof NoiseError || error instanceof ChannelError ? error.reason : "error";
}
