/**
 * The two Noise handshakes Atrium uses (SPEC-0005, "Noise 通道"), written out by hand.
 *
 * @remarks
 * Only `Noise_IK_25519_ChaChaPoly_SHA256` and `Noise_IKpsk2_25519_ChaChaPoly_SHA256`, with the
 * phone as initiator. No general pattern parser: the token order of both patterns is spelled out
 * in `writeMessage` / `readMessage`. Primitives come from `@noble/*`, because the Node inside
 * Electron 44 has no ChaCha20-Poly1305.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

/** The two patterns, by the byte that names them in the phone's first frame. */
export type Pattern = "IK" | "IKpsk2";

/** Full Noise protocol names; they go into the handshake hash. */
export const PROTOCOL_NAMES: Record<Pattern, string> = {
  IK: "Noise_IK_25519_ChaChaPoly_SHA256",
  IKpsk2: "Noise_IKpsk2_25519_ChaChaPoly_SHA256",
};

/** Largest Noise message, handshake or transport (Noise spec §3). */
export const MAX_MESSAGE = 65_535;
/** Largest handshake payload Atrium accepts (SPEC-0005, "握手载荷"). */
export const MAX_HANDSHAKE_PAYLOAD = 1024;
/** Poly1305 tag length. */
const TAG_LENGTH = 16;
/** Largest plaintext of one transport message. */
export const MAX_TRANSPORT_PLAINTEXT = MAX_MESSAGE - TAG_LENGTH;

const KEY_LENGTH = 32;
/** n = 2^64 - 1 is reserved by the spec; reaching it means the channel must close. */
const MAX_NONCE = 2n ** 64n - 1n;
const EMPTY = new Uint8Array(0);

/** Why a Noise operation failed; the state that threw is dead afterwards. */
export type NoiseFailure =
  | "decrypt_failed"
  | "low_order_key"
  | "message_too_long"
  | "message_too_short"
  | "payload_too_long"
  | "nonce_exhausted"
  | "wrong_turn"
  | "dead";

/**
 * A Noise failure with a reason the caller can log without the bytes.
 *
 * @remarks
 * The state that threw is dead afterwards; the reason is all that leaves it.
 *
 * @sideEffects none
 */
export class NoiseError extends Error {
  readonly reason: NoiseFailure;

  /**
   * Makes the error.
   *
   * @remarks
   * The message names only the reason, so it can be logged without the bytes.
   *
   * @sideEffects none
   * @param reason - Why it failed.
   */
  constructor(reason: NoiseFailure) {
    super(`noise: ${reason}`);
    this.reason = reason;
  }
}

/** An X25519 key pair. */
export interface KeyPair {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

/**
 * Builds the key pair of a private key.
 *
 * @remarks
 * For keys read back from storage or fixed in tests and records.
 *
 * @sideEffects none
 * @param secretKey - 32 bytes.
 * @returns The pair.
 */
export function keyPairFrom(secretKey: Uint8Array): KeyPair {
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/**
 * Makes a fresh random key pair.
 *
 * @remarks
 * Static keys on first use, ephemeral keys in every handshake.
 *
 * @sideEffects Reads the system's random source.
 * @returns The pair.
 */
export function generateKeyPair(): KeyPair {
  return keyPairFrom(x25519.utils.randomSecretKey());
}

/**
 * X25519, aborting on low-order public keys.
 *
 * @remarks
 * noble already refuses the known low-order points before the ladder; the all-zero check is the
 * one the spec asks for and stays even if noble changes.
 *
 * @sideEffects none
 * @param secretKey - Ours.
 * @param publicKey - Theirs.
 * @returns The shared secret.
 * @throws NoiseError low_order_key.
 */
function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(secretKey, publicKey);
  } catch {
    throw new NoiseError("low_order_key");
  }
  if (shared.every((byte) => byte === 0)) throw new NoiseError("low_order_key");
  return shared;
}

/**
 * Concatenates byte arrays.
 *
 * @remarks
 * Noise builds messages and hashes from pieces.
 *
 * @sideEffects none
 * @param parts - The arrays.
 * @returns One new array.
 */
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Noise's HKDF with three outputs (Noise spec §4.3).
 *
 * @remarks
 * HMAC-SHA256 as the spec defines it. MixKey and Split use the first two outputs and
 * MixKeyAndHash all three; each output depends only on the ones before it, so computing the third
 * every time changes nothing but one HMAC.
 *
 * @sideEffects none
 * @param chainingKey - ck.
 * @param inputKeyMaterial - The ikm.
 * @returns The three outputs, 32 bytes each.
 */
function hkdf(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array): [Uint8Array, Uint8Array, Uint8Array] {
  const tempKey = hmac(sha256, chainingKey, inputKeyMaterial);
  const out1 = hmac(sha256, tempKey, Uint8Array.of(1));
  const out2 = hmac(sha256, tempKey, concat(out1, Uint8Array.of(2)));
  return [out1, out2, hmac(sha256, tempKey, concat(out2, Uint8Array.of(3)))];
}

/**
 * A value the handshake has set by the step that reads it.
 *
 * @remarks
 * `#guard` runs the steps in order, so these values are always there; this narrows the type
 * without an unchecked cast.
 *
 * @sideEffects none
 * @param value - The value.
 * @returns It.
 * @throws Error when it is missing, which would be a bug in this file.
 */
function known<T>(value: T | null): T {
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable, `#guard` orders the steps.
  if (value === null) throw new Error("noise: handshake value missing");
  return value;
}

/**
 * The 12-byte ChaChaPoly nonce: 4 zero bytes, then the counter as 8 bytes little-endian.
 *
 * @remarks
 * Noise spec §12.3; the counter is implicit and never travels (SPEC-0005, "传输").
 *
 * @sideEffects none
 * @param n - The counter.
 * @returns The nonce.
 */
function nonceBytes(n: bigint): Uint8Array {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, n, true);
  return nonce;
}

/**
 * Noise's CipherState: a key and an implicit counter.
 *
 * @remarks
 * Stricter than the spec: any failure (bad tag, exhausted nonce) kills the state, because Atrium
 * closes the channel then anyway (SPEC-0005, "传输").
 *
 * @sideEffects Holds a key and a counter in memory.
 */
export class CipherState {
  #key: Uint8Array | null;
  #nonce = 0n;
  #dead = false;

  /**
   * Makes a cipher state.
   *
   * @remarks
   * Without a key, as the handshake starts, it passes plaintext through (Noise spec §5.1).
   *
   * @sideEffects none
   * @param key - 32 bytes, or null for "no key yet" (plaintext passes through).
   */
  constructor(key: Uint8Array | null = null) {
    this.#key = key;
  }

  /**
   * Whether a key is set.
   *
   * @remarks
   * Noise spec §5.1 `HasKey`.
   *
   * @sideEffects none
   * @returns True once keyed.
   */
  hasKey(): boolean {
    return this.#key !== null;
  }

  /**
   * The next nonce this state will use, for tests and records.
   *
   * @remarks
   * The interop records write it down for each transport message.
   *
   * @sideEffects none
   * @returns The counter.
   */
  get nonce(): bigint {
    return this.#nonce;
  }

  /**
   * Encrypts one message with associated data.
   *
   * @remarks
   * Noise spec §5.1 `EncryptWithAd`.
   *
   * @sideEffects Advances the nonce; kills the state on failure.
   * @param ad - Associated data.
   * @param plaintext - The message.
   * @returns The ciphertext with tag, or the plaintext when there is no key.
   * @throws NoiseError dead or nonce_exhausted.
   */
  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    this.#check();
    if (this.#key === null) return plaintext;
    const ciphertext = chacha20poly1305(this.#key, nonceBytes(this.#nonce), ad).encrypt(plaintext);
    this.#nonce += 1n;
    return ciphertext;
  }

  /**
   * Decrypts one message with associated data.
   *
   * @remarks
   * Noise spec §5.1 `DecryptWithAd`; a bad tag kills the state, unlike the spec, because Atrium closes the channel then anyway.
   *
   * @sideEffects Advances the nonce; kills the state on failure.
   * @param ad - Associated data.
   * @param ciphertext - The message with tag.
   * @returns The plaintext.
   * @throws NoiseError dead, nonce_exhausted or decrypt_failed.
   */
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    this.#check();
    if (this.#key === null) return ciphertext;
    try {
      const plaintext = chacha20poly1305(this.#key, nonceBytes(this.#nonce), ad).decrypt(ciphertext);
      this.#nonce += 1n;
      return plaintext;
    } catch {
      this.#dead = true;
      throw new NoiseError("decrypt_failed");
    }
  }

  /**
   * Kills the state, for failures found outside it (a message of the wrong size).
   *
   * @remarks
   * So a caller that ignores the error cannot go on with these keys.
   *
   * @sideEffects Every later call throws `dead`.
   */
  invalidate(): void {
    this.#dead = true;
  }

  /**
   * Sets the counter, only for the nonce-limit test.
   *
   * @remarks
   * Reaching 2^64 - 1 by counting is not possible in a test.
   *
   * @sideEffects Changes the counter.
   * @param n - The new counter.
   */
  setNonceForTest(n: bigint): void {
    this.#nonce = n;
  }

  /**
   * Refuses to run once dead or out of nonces.
   *
   * @remarks
   * The spec reserves 2^64 - 1; Atrium closes the channel instead of rekeying (SPEC-0005, "传输").
   *
   * @sideEffects Kills the state when the nonces ran out.
   * @throws NoiseError dead or nonce_exhausted.
   */
  #check(): void {
    if (this.#dead) throw new NoiseError("dead");
    if (this.#nonce >= MAX_NONCE) {
      this.#dead = true;
      throw new NoiseError("nonce_exhausted");
    }
  }
}

/**
 * Noise's SymmetricState: chaining key, handshake hash and the current cipher.
 *
 * @remarks
 * Noise spec §5.2, for SHA-256 and ChaChaPoly only.
 *
 * @sideEffects Holds keys and the handshake hash in memory.
 */
class SymmetricState {
  chainingKey: Uint8Array;
  hash: Uint8Array;
  cipher = new CipherState();

  /**
   * InitializeSymmetric: names of 32 bytes or less are padded, longer ones hashed.
   *
   * @remarks
   * Noise spec §5.2; both of Atrium's names are longer than 32 bytes.
   *
   * @sideEffects none
   * @param protocolName - The full Noise name.
   */
  constructor(protocolName: string) {
    const name = new TextEncoder().encode(protocolName);
    if (name.length <= 32) {
      this.hash = new Uint8Array(32);
      this.hash.set(name);
    } else {
      this.hash = sha256(name);
    }
    this.chainingKey = this.hash;
  }

  /**
   * MixKey.
   *
   * @remarks
   * Noise spec §5.2.
   *
   * @sideEffects Replaces ck and the cipher.
   * @param inputKeyMaterial - Usually a DH output.
   */
  mixKey(inputKeyMaterial: Uint8Array): void {
    const [chainingKey, key] = hkdf(this.chainingKey, inputKeyMaterial);
    this.chainingKey = chainingKey;
    this.cipher = new CipherState(key);
  }

  /**
   * MixHash.
   *
   * @remarks
   * Noise spec §5.2.
   *
   * @sideEffects Replaces h.
   * @param data - What to hash in.
   */
  mixHash(data: Uint8Array): void {
    this.hash = sha256(concat(this.hash, data));
  }

  /**
   * MixKeyAndHash, used for the PSK token.
   *
   * @remarks
   * Noise spec §5.2; only IKpsk2 uses it, at the end of message 2.
   *
   * @sideEffects Replaces ck, h and the cipher.
   * @param inputKeyMaterial - The PSK.
   */
  mixKeyAndHash(inputKeyMaterial: Uint8Array): void {
    const [chainingKey, tempHash, key] = hkdf(this.chainingKey, inputKeyMaterial);
    this.chainingKey = chainingKey;
    this.mixHash(tempHash);
    this.cipher = new CipherState(key);
  }

  /**
   * EncryptAndHash.
   *
   * @remarks
   * Noise spec §5.2.
   *
   * @sideEffects Advances the cipher; replaces h.
   * @param plaintext - What to encrypt.
   * @returns The ciphertext.
   */
  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.hash, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  /**
   * DecryptAndHash.
   *
   * @remarks
   * Noise spec §5.2.
   *
   * @sideEffects Advances the cipher; replaces h.
   * @param ciphertext - What to decrypt.
   * @returns The plaintext.
   */
  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.hash, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  /**
   * Split: the two transport ciphers, initiator-to-responder first.
   *
   * @remarks
   * Noise spec §5.2.
   *
   * @sideEffects none
   * @returns Both cipher states.
   */
  split(): [CipherState, CipherState] {
    const [key1, key2] = hkdf(this.chainingKey, EMPTY);
    return [new CipherState(key1), new CipherState(key2)];
  }
}

/** The result of a finished handshake. */
export interface Transport {
  /** Encrypts what we send. */
  readonly send: CipherState;
  /** Decrypts what we receive. */
  readonly receive: CipherState;
  /** h at the end of the handshake, for the SAS. */
  readonly handshakeHash: Uint8Array;
  /** The other side's static public key (for the host: the phone's, read from message 1). */
  readonly remoteStatic: Uint8Array;
}

/** What both roles need to start. */
interface HandshakeOptions {
  readonly pattern: Pattern;
  readonly prologue: Uint8Array;
  readonly staticKey: KeyPair;
  /** 32 bytes, required for IKpsk2 and refused for IK. */
  readonly psk?: Uint8Array;
}

/** Options of the initiator (the phone). */
export interface InitiatorOptions extends HandshakeOptions {
  /** The host's static public key, from the QR code. */
  readonly remoteStatic: Uint8Array;
}

/** The test-only way to fix the ephemeral key, so records and vectors come out the same each time. */
export interface TestOnlyOptions {
  readonly ephemeral?: KeyPair;
}

/**
 * Noise's HandshakeState for IK and IKpsk2, either role.
 *
 * @remarks
 * Two messages: the initiator writes 1 and reads 2, the responder reads 1 and writes 2. After
 * message 2 both call `finish()`. Any failure kills the state; so does calling out of turn.
 *
 * @sideEffects Holds keys in memory until `finish()`.
 */
export class HandshakeState {
  readonly #initiator: boolean;
  readonly #pattern: Pattern;
  readonly #symmetric: SymmetricState;
  readonly #static: KeyPair;
  readonly #ephemeralForTest: KeyPair | undefined;
  #psk: Uint8Array | undefined;
  #ephemeral: KeyPair | null = null;
  #remoteStatic: Uint8Array | null;
  #remoteEphemeral: Uint8Array | null = null;
  /** Messages handled so far: 0, 1 or 2. */
  #step = 0;
  #dead = false;

  /**
   * Starts a handshake.
   *
   * @remarks
   * Private: callers say which side they are with `initiator` or `responder`. The PSK must be given exactly for IKpsk2.
   *
   * @sideEffects none
   * @param initiator - Whether this side is the phone.
   * @param options - Pattern, prologue, keys, PSK.
   * @param remoteStatic - The responder's public key (initiator only).
   * @param testOnly - Fixed ephemeral key, only from tests and record generation.
   */
  private constructor(
    initiator: boolean,
    options: HandshakeOptions,
    remoteStatic: Uint8Array | null,
    testOnly: TestOnlyOptions,
  ) {
    if ((options.pattern === "IKpsk2") !== (options.psk !== undefined)) throw new Error("psk iff IKpsk2");
    if (options.psk !== undefined && options.psk.length !== KEY_LENGTH) throw new Error("psk must be 32 bytes");
    this.#initiator = initiator;
    this.#pattern = options.pattern;
    this.#psk = options.psk;
    this.#static = options.staticKey;
    this.#remoteStatic = remoteStatic;
    this.#ephemeralForTest = testOnly.ephemeral;
    this.#symmetric = new SymmetricState(PROTOCOL_NAMES[options.pattern]);
    this.#symmetric.mixHash(options.prologue);
    // Pre-message `<- s`: the responder's static key, which the initiator knows from the QR code.
    this.#symmetric.mixHash(initiator ? known(remoteStatic) : options.staticKey.publicKey);
  }

  /**
   * The phone's side.
   *
   * @remarks
   * The phone knows the host's key from the QR code, so it can start.
   *
   * @sideEffects none
   * @param options - Pattern, prologue, keys, PSK.
   * @param testOnly - Fixed ephemeral key; production callers leave it out.
   * @returns A state ready to write message 1.
   */
  static initiator(options: InitiatorOptions, testOnly: TestOnlyOptions = {}): HandshakeState {
    return new HandshakeState(true, options, options.remoteStatic, testOnly);
  }

  /**
   * The host's side.
   *
   * @remarks
   * The host learns the phone's key from message 1.
   *
   * @sideEffects none
   * @param options - Pattern, prologue, keys, PSK.
   * @param testOnly - Fixed ephemeral key; production callers leave it out.
   * @returns A state ready to read message 1.
   */
  static responder(options: HandshakeOptions, testOnly: TestOnlyOptions = {}): HandshakeState {
    return new HandshakeState(false, options, null, testOnly);
  }

  /**
   * The handshake hash so far.
   *
   * @remarks
   * A copy, so the caller cannot change the state through it.
   *
   * @sideEffects none
   * @returns A copy of h.
   */
  get handshakeHash(): Uint8Array {
    return this.#symmetric.hash.slice();
  }

  /**
   * The initiator's static key, once the responder has read message 1.
   *
   * @remarks
   * The host looks the phone up by it before writing message 2 (SPEC-0005, "日常连接").
   *
   * @sideEffects none
   * @returns The key, or null before.
   */
  get remoteStatic(): Uint8Array | null {
    return this.#remoteStatic;
  }

  /**
   * Writes the next message: 1 for the initiator, 2 for the responder.
   *
   * @remarks
   * The token order of both patterns is written out here instead of parsed from a pattern string.
   *
   * @sideEffects Advances the state; kills it on failure.
   * @param payload - At most 1 KiB.
   * @returns The message bytes.
   * @throws NoiseError.
   */
  writeMessage(payload: Uint8Array): Uint8Array {
    return this.#guard(this.#initiator ? 0 : 1, () => {
      if (payload.length > MAX_HANDSHAKE_PAYLOAD) throw new NoiseError("payload_too_long");
      const s = this.#symmetric;
      const ephemeral = this.#ephemeralForTest ?? generateKeyPair();
      this.#ephemeral = ephemeral;
      const parts: Uint8Array[] = [ephemeral.publicKey];
      s.mixHash(ephemeral.publicKey);
      if (this.#pattern === "IKpsk2") s.mixKey(ephemeral.publicKey);
      if (this.#initiator) {
        const remoteStatic = known(this.#remoteStatic);
        s.mixKey(dh(ephemeral.secretKey, remoteStatic)); // es
        parts.push(s.encryptAndHash(this.#static.publicKey)); // s
        s.mixKey(dh(this.#static.secretKey, remoteStatic)); // ss
      } else {
        const remoteEphemeral = known(this.#remoteEphemeral);
        s.mixKey(dh(ephemeral.secretKey, remoteEphemeral)); // ee
        s.mixKey(dh(ephemeral.secretKey, known(this.#remoteStatic))); // se
        if (this.#psk !== undefined) s.mixKeyAndHash(this.#psk); // psk
      }
      parts.push(s.encryptAndHash(payload));
      return concat(...parts);
    });
  }

  /**
   * Reads the next message: 1 for the responder, 2 for the initiator.
   *
   * @remarks
   * Sizes are checked before anything is decrypted, so a huge or tiny message costs nothing.
   *
   * @sideEffects Advances the state; kills it on failure.
   * @param message - The message bytes.
   * @returns The payload.
   * @throws NoiseError.
   */
  readMessage(message: Uint8Array): Uint8Array {
    return this.#guard(this.#initiator ? 1 : 0, () => {
      if (message.length > MAX_MESSAGE) throw new NoiseError("message_too_long");
      // Message 1 carries e, the encrypted s (32 + 16) and the payload tag; message 2 e and the tag.
      const fixed = this.#initiator ? 32 + TAG_LENGTH : 32 + 32 + TAG_LENGTH + TAG_LENGTH;
      if (message.length < fixed) throw new NoiseError("message_too_short");
      if (message.length - fixed > MAX_HANDSHAKE_PAYLOAD) throw new NoiseError("payload_too_long");
      const s = this.#symmetric;
      const remoteEphemeral = message.subarray(0, 32);
      this.#remoteEphemeral = remoteEphemeral;
      s.mixHash(remoteEphemeral);
      if (this.#pattern === "IKpsk2") s.mixKey(remoteEphemeral);
      let rest = message.subarray(32);
      if (this.#initiator) {
        const ephemeral = known(this.#ephemeral);
        s.mixKey(dh(ephemeral.secretKey, remoteEphemeral)); // ee
        s.mixKey(dh(this.#static.secretKey, remoteEphemeral)); // se
        if (this.#psk !== undefined) s.mixKeyAndHash(this.#psk); // psk
      } else {
        s.mixKey(dh(this.#static.secretKey, remoteEphemeral)); // es
        const remoteStatic = s.decryptAndHash(rest.subarray(0, 32 + TAG_LENGTH)); // s
        rest = rest.subarray(32 + TAG_LENGTH);
        this.#remoteStatic = remoteStatic;
        s.mixKey(dh(this.#static.secretKey, remoteStatic)); // ss
      }
      return s.decryptAndHash(rest);
    });
  }

  /**
   * Ends the handshake after message 2 and hands out the transport ciphers.
   *
   * @remarks
   * The PSK is forgotten here; the transport ciphers carry on alone.
   *
   * @sideEffects Kills this state: it cannot be used again.
   * @returns Send and receive ciphers, h, and the other side's static key.
   * @throws NoiseError wrong_turn before message 2, dead after a failure.
   */
  finish(): Transport {
    return this.#guard(2, () => {
      const [initiatorToResponder, responderToInitiator] = this.#symmetric.split();
      this.#dead = true;
      this.#psk = undefined;
      return {
        send: this.#initiator ? initiatorToResponder : responderToInitiator,
        receive: this.#initiator ? responderToInitiator : initiatorToResponder,
        handshakeHash: this.#symmetric.hash.slice(),
        remoteStatic: known(this.#remoteStatic),
      };
    });
  }

  /**
   * Runs one step if it is this step's turn, and kills the state if it throws.
   *
   * @remarks
   * One place for "dead after any failure, and calls out of turn are failures".
   *
   * @sideEffects Advances the step; kills the state on failure.
   * @param step - Which step this is: 0 and 1 are the messages, 2 is finish.
   * @param run - The step.
   * @returns What the step returns.
   * @throws NoiseError dead, wrong_turn, or what the step threw.
   */
  #guard<T>(step: number, run: () => T): T {
    if (this.#dead) throw new NoiseError("dead");
    if (this.#step !== step) {
      this.#dead = true;
      throw new NoiseError("wrong_turn");
    }
    try {
      const result = run();
      this.#step += 1;
      return result;
    } catch (error) {
      this.#dead = true;
      throw error;
    }
  }
}

/**
 * Encrypts one transport message.
 *
 * @remarks
 * Transport messages have empty associated data (Noise spec §5).
 *
 * @sideEffects Advances the cipher; kills it on failure.
 * @param cipher - The send cipher.
 * @param plaintext - At most 65519 bytes.
 * @returns The ciphertext.
 * @throws NoiseError message_too_long, or the cipher's errors.
 */
export function encryptTransport(cipher: CipherState, plaintext: Uint8Array): Uint8Array {
  if (plaintext.length > MAX_TRANSPORT_PLAINTEXT) {
    cipher.invalidate();
    throw new NoiseError("message_too_long");
  }
  return cipher.encryptWithAd(EMPTY, plaintext);
}

/**
 * Decrypts one transport message.
 *
 * @remarks
 * A ciphertext shorter than its tag or longer than a Noise message is refused without decrypting.
 *
 * @sideEffects Advances the cipher; kills it on failure.
 * @param cipher - The receive cipher.
 * @param ciphertext - At most 65535 bytes.
 * @returns The plaintext.
 * @throws NoiseError.
 */
export function decryptTransport(cipher: CipherState, ciphertext: Uint8Array): Uint8Array {
  if (ciphertext.length > MAX_MESSAGE || ciphertext.length < TAG_LENGTH) {
    cipher.invalidate();
    throw new NoiseError(ciphertext.length > MAX_MESSAGE ? "message_too_long" : "message_too_short");
  }
  return cipher.decryptWithAd(EMPTY, ciphertext);
}
