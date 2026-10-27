/**
 * Deterministic handshake records for TS ↔ Swift interop (format: `interop/FORMAT.md`).
 *
 * @remarks
 * `interop.test.ts` compares `interop/ts-ik.json` and `ts-ikpsk2.json` with what `buildRecord`
 * makes now (`UPDATE_INTEROP_RECORDS=1` rewrites them); `replayRecord` checks a record from either
 * side byte for byte. The records were made in MP0 and the Swift ones by the Swift side, so their
 * payloads say protocol 25.
 */
import { createHash } from "node:crypto";
import { fromHex, fromUtf8, toHex, utf8 } from "../src/bytes";
import { encodeControl, encodeMessage, FrameReader, PING, PONG, type Received } from "../src/framing";
import {
  firstFrame,
  HOST_TO_PHONE_LIMIT,
  MAX_CHUNK,
  MODE_BYTE,
  parseFirstFrame,
  PHONE_TO_HOST_LIMIT,
  prologue,
  sas,
} from "../src/wire";
import {
  decryptTransport,
  encryptTransport,
  HandshakeState,
  keyPairFrom,
  type Pattern,
  PROTOCOL_NAMES,
  type Transport,
} from "../src/noise";

/** Who sent a message. */
export type Side = "phone" | "host";

/** One handshake message. */
export interface HandshakeEntry {
  from: Side;
  /** The payload, UTF-8 JSON, as hex. */
  payload: string;
  /** The payload as text, for people; not checked. */
  payload_text: string;
  /** The Noise handshake message. */
  noise_message: string;
  /** The WebSocket frame: for message 1, `41 01 <mode>` before it; for message 2, the same as noise_message. */
  wire: string;
}

/** One transport message after split. */
export interface TransportEntry {
  from: Side;
  /** The sender's nonce for this message (each direction counts from 0). */
  nonce: number;
  /** The framed plaintext: type byte, then the body. */
  plaintext: string;
  /** The WebSocket frame: the Noise transport message. */
  ciphertext: string;
}

/** What the receiver's frame reader yields, in order. */
export type DecodedEntry =
  | { from: Side; kind: "message"; text: string }
  | { from: Side; kind: "control"; value: Record<string, unknown> }
  | { from: Side; kind: "ping" | "pong" };

/** A whole record (FORMAT.md). */
export interface InteropRecord {
  format: 1;
  generator: string;
  protocol_name: string;
  mode: number;
  host_id: string;
  prologue: string;
  psk: string | null;
  phone_static: string;
  phone_ephemeral: string;
  host_static: string;
  host_ephemeral: string;
  phone_static_public: string;
  host_static_public: string;
  handshake: [HandshakeEntry, HandshakeEntry];
  handshake_hash: string;
  sas: string;
  transport: TransportEntry[];
  decoded: DecodedEntry[];
}

/** The inputs of a record: keys, payloads and the plaintext frames in order. */
export interface RecordInputs {
  generator: string;
  pattern: Pattern;
  hostId: string;
  psk: Uint8Array | null;
  phoneStatic: Uint8Array;
  phoneEphemeral: Uint8Array;
  hostStatic: Uint8Array;
  hostEphemeral: Uint8Array;
  payloads: [Uint8Array, Uint8Array];
  frames: { from: Side; plaintext: Uint8Array }[];
}

/**
 * Runs both sides from fixed inputs and writes down every byte.
 *
 * @remarks
 * Fixed ephemeral keys make the record the same on every run, so the other side can replay it.
 *
 * @sideEffects none
 * @param inputs - Keys, payloads and frames.
 * @returns The record.
 */
export function buildRecord(inputs: RecordInputs): InteropRecord {
  const hostPrologue = prologue(inputs.hostId);
  const phoneKey = keyPairFrom(inputs.phoneStatic);
  const hostKey = keyPairFrom(inputs.hostStatic);
  const psk = inputs.psk === null ? {} : { psk: inputs.psk };
  const phone = HandshakeState.initiator(
    { pattern: inputs.pattern, prologue: hostPrologue, staticKey: phoneKey, remoteStatic: hostKey.publicKey, ...psk },
    { ephemeral: keyPairFrom(inputs.phoneEphemeral) },
  );
  const host = HandshakeState.responder(
    { pattern: inputs.pattern, prologue: hostPrologue, staticKey: hostKey, ...psk },
    { ephemeral: keyPairFrom(inputs.hostEphemeral) },
  );
  const message1 = phone.writeMessage(inputs.payloads[0]);
  host.readMessage(message1);
  const message2 = host.writeMessage(inputs.payloads[1]);
  phone.readMessage(message2);
  const sides: Record<Side, Transport> = { phone: phone.finish(), host: host.finish() };
  const nonces: Record<Side, number> = { phone: 0, host: 0 };
  const transport = inputs.frames.map(({ from, plaintext }) => ({
    from,
    nonce: nonces[from]++,
    plaintext: toHex(plaintext),
    ciphertext: toHex(encryptTransport(sides[from].send, plaintext)),
  }));
  return {
    format: 1,
    generator: inputs.generator,
    protocol_name: PROTOCOL_NAMES[inputs.pattern],
    mode: MODE_BYTE[inputs.pattern],
    host_id: inputs.hostId,
    prologue: toHex(hostPrologue),
    psk: inputs.psk === null ? null : toHex(inputs.psk),
    phone_static: toHex(inputs.phoneStatic),
    phone_ephemeral: toHex(inputs.phoneEphemeral),
    host_static: toHex(inputs.hostStatic),
    host_ephemeral: toHex(inputs.hostEphemeral),
    phone_static_public: toHex(phoneKey.publicKey),
    host_static_public: toHex(hostKey.publicKey),
    handshake: [
      handshakeEntry("phone", inputs.payloads[0], message1, firstFrame(inputs.pattern, message1)),
      handshakeEntry("host", inputs.payloads[1], message2, message2),
    ],
    handshake_hash: toHex(sides.phone.handshakeHash),
    sas: sas(sides.phone.handshakeHash),
    transport,
    decoded: decode(inputs.frames),
  };
}

/**
 * One handshake message as a record writes it.
 *
 * @remarks
 * Message 1's `wire` has the first-frame header in front; message 2's is the message itself.
 *
 * @sideEffects none
 * @param from - The sender.
 * @param payload - The payload.
 * @param noiseMessage - The Noise message.
 * @param wire - The WebSocket frame.
 * @returns The entry.
 */
function handshakeEntry(from: Side, payload: Uint8Array, noiseMessage: Uint8Array, wire: Uint8Array): HandshakeEntry {
  return {
    from,
    payload: toHex(payload),
    payload_text: fromUtf8(payload),
    noise_message: toHex(noiseMessage),
    wire: toHex(wire),
  };
}

/**
 * What each receiver's frame reader makes of the frames, in order.
 *
 * @remarks
 * `0x01` chunks yield nothing on their own, so `decoded` is shorter than `transport`.
 *
 * @sideEffects none
 * @param frames - Plaintext frames with their sender.
 * @returns The decoded entries.
 */
function decode(frames: { from: Side; plaintext: Uint8Array }[]): DecodedEntry[] {
  const clock = { now: () => 0, setTimeout: () => () => {} };
  // The phone's reader sees what the host sends (8 MiB limit) and the other way round.
  const readers: Record<Side, FrameReader> = {
    host: new FrameReader(HOST_TO_PHONE_LIMIT, clock, () => {}),
    phone: new FrameReader(PHONE_TO_HOST_LIMIT, clock, () => {}),
  };
  const decoded: DecodedEntry[] = [];
  for (const { from, plaintext } of frames) {
    const received: Received | null = readers[from].push(plaintext);
    if (received !== null) decoded.push({ from, ...received });
  }
  return decoded;
}

/**
 * The inputs of a record, read back from it.
 *
 * @remarks
 * So a record from the other side can be regenerated here.
 *
 * @sideEffects none
 * @param record - A record.
 * @returns Its inputs.
 */
function inputsOf(record: InteropRecord): RecordInputs {
  const pattern = (Object.keys(PROTOCOL_NAMES) as Pattern[]).find(
    (one) => PROTOCOL_NAMES[one] === record.protocol_name,
  );
  if (pattern === undefined) throw new Error(`unknown protocol ${record.protocol_name}`);
  return {
    generator: record.generator,
    pattern,
    hostId: record.host_id,
    psk: record.psk === null ? null : fromHex(record.psk),
    phoneStatic: fromHex(record.phone_static),
    phoneEphemeral: fromHex(record.phone_ephemeral),
    hostStatic: fromHex(record.host_static),
    hostEphemeral: fromHex(record.host_ephemeral),
    payloads: [fromHex(record.handshake[0].payload), fromHex(record.handshake[1].payload)],
    frames: record.transport.map((entry) => ({ from: entry.from, plaintext: fromHex(entry.plaintext) })),
  };
}

/**
 * Checks a record against this implementation, two ways.
 *
 * @remarks
 * 1. Regenerates the whole record from its keys, payloads and plaintexts: every byte must match.
 * 2. Independently reads the other side's bytes: the host reads message 1 from `wire` (first
 *    frame included), the phone reads message 2, and each side decrypts the other's ciphertexts
 *    and reassembles them; payloads, plaintexts and decoded messages must match.
 *
 * @sideEffects none
 * @param record - A record, from either generator.
 * @returns The mismatches; empty when it all agrees.
 */
export function replayRecord(record: InteropRecord): string[] {
  const problems: string[] = [];
  const inputs = inputsOf(record);
  const regenerated = buildRecord(inputs);
  /**
   * Notes a mismatch.
   *
   * @remarks
   * Every difference is listed, not just the first, so one run shows all that is off.
   *
   * @sideEffects Adds to `problems`.
   * @param path - Where in the record.
   * @param ours - What this implementation made.
   * @param theirs - What the record says.
   */
  function compare(path: string, ours: unknown, theirs: unknown): void {
    if (JSON.stringify(ours) !== JSON.stringify(theirs)) {
      problems.push(`${path}: ours ${JSON.stringify(ours)?.slice(0, 200)}`);
    }
  }
  for (const key of Object.keys(regenerated) as (keyof InteropRecord)[]) {
    if (key === "generator") continue;
    if (key === "handshake" || key === "transport") {
      regenerated[key].forEach((entry, index) => {
        for (const [field, value] of Object.entries(entry)) {
          compare(
            `${key}[${index}].${field}`,
            value,
            (record[key][index] as unknown as Record<string, unknown> | undefined)?.[field],
          );
        }
      });
      compare(`${key}.length`, regenerated[key].length, record[key].length);
    } else {
      compare(key, regenerated[key], record[key]);
    }
  }

  try {
    const hostPrologue = prologue(record.host_id);
    const psk = inputs.psk === null ? {} : { psk: inputs.psk };
    const { pattern, message } = parseFirstFrame(fromHex(record.handshake[0].wire));
    compare("wire mode", pattern, inputs.pattern);
    const host = HandshakeState.responder(
      { pattern, prologue: hostPrologue, staticKey: keyPairFrom(inputs.hostStatic), ...psk },
      { ephemeral: keyPairFrom(inputs.hostEphemeral) },
    );
    compare("host reads message 1", toHex(host.readMessage(message)), record.handshake[0].payload);
    const phone = HandshakeState.initiator(
      {
        pattern,
        prologue: hostPrologue,
        staticKey: keyPairFrom(inputs.phoneStatic),
        remoteStatic: fromHex(record.host_static_public),
        ...psk,
      },
      { ephemeral: keyPairFrom(inputs.phoneEphemeral) },
    );
    phone.writeMessage(inputs.payloads[0]);
    compare(
      "phone reads message 2",
      toHex(phone.readMessage(fromHex(record.handshake[1].wire))),
      record.handshake[1].payload,
    );
    host.writeMessage(inputs.payloads[1]);
    const sides: Record<Side, Transport> = { phone: phone.finish(), host: host.finish() };
    compare("host sees the phone's static key", toHex(sides.host.remoteStatic), record.phone_static_public);
    const frames = record.transport.map((entry, index) => {
      const receiver: Side = entry.from === "phone" ? "host" : "phone";
      const plaintext = decryptTransport(sides[receiver].receive, fromHex(entry.ciphertext));
      compare(`transport[${index}] decrypted`, toHex(plaintext), entry.plaintext);
      return { from: entry.from, plaintext };
    });
    compare("decoded (independent)", decode(frames), record.decoded);
  } catch (error) {
    problems.push(`independent read failed: ${(error as Error).message}`);
  }
  return problems;
}

/**
 * A fixed 32-byte value from a label, so the inputs are reproducible and easy to write down.
 *
 * @remarks
 * FORMAT.md, "生成时的约定".
 *
 * @sideEffects none
 * @param label - What it is for.
 * @returns SHA-256 of the label.
 */
export function fixedKey(label: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(label).digest());
}

const HOST_ID = "hst_0123456789abcdef";
const DEVICE_ID = "dev_0123456789abcdef";
const PROTOCOL_VERSION = 25;
const TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

/**
 * Encodes JSON as UTF-8.
 *
 * @remarks
 * Payloads and messages are JSON text.
 *
 * @sideEffects none
 * @param value - Any JSON value.
 * @returns The bytes.
 */
function json(value: unknown): Uint8Array {
  return utf8(JSON.stringify(value));
}

/**
 * The frames of one Atrium message, as single-direction plaintexts.
 *
 * @remarks
 * Chunked as the channel would send it.
 *
 * @sideEffects none
 * @param from - Sender.
 * @param value - The message.
 * @returns Its chunks.
 */
function framesOf(from: Side, value: unknown): { from: Side; plaintext: Uint8Array }[] {
  const limit = from === "phone" ? PHONE_TO_HOST_LIMIT : HOST_TO_PHONE_LIMIT;
  return encodeMessage(JSON.stringify(value), limit).map((plaintext) => ({ from, plaintext }));
}

const hello = { type: "hello", protocolVersion: PROTOCOL_VERSION, clientId: DEVICE_ID, traceparent: TRACEPARENT };
const welcome = {
  type: "welcome",
  protocolVersion: PROTOCOL_VERSION,
  hostVersion: "0.0.0-mp0-spike",
  hostInstanceId: "spike",
  heartbeatMs: 10000,
  installSeed: 1,
  logDir: "/tmp/atrium-mp0-spike",
};

/**
 * The inputs of TypeScript's two records.
 *
 * @remarks
 * FORMAT.md lists what each record should cover.
 *
 * @sideEffects none
 * @returns IK and IKpsk2 inputs.
 */
export function tsInputs(): { ik: RecordInputs; ikpsk2: RecordInputs } {
  const keys = {
    generator: "ts",
    hostId: HOST_ID,
    phoneStatic: fixedKey("atrium-mp0 ts phone static"),
    phoneEphemeral: fixedKey("atrium-mp0 ts phone ephemeral"),
    hostStatic: fixedKey("atrium-mp0 ts host static"),
    hostEphemeral: fixedKey("atrium-mp0 ts host ephemeral"),
  };
  const big = framesOf("host", { type: "pad", data: "a".repeat(MAX_CHUNK) });
  return {
    ikpsk2: {
      ...keys,
      pattern: "IKpsk2",
      psk: fixedKey("atrium-mp0 ts psk"),
      payloads: [
        json({
          kind: "pair",
          pairingId: "pair_0123456789abcdef",
          deviceName: "Test iPhone",
          model: "iPhone17,1",
          appVersion: "0.0.0",
          protocolVersion: PROTOCOL_VERSION,
        }),
        json({ ok: true }),
      ],
      frames: [
        { from: "phone", plaintext: encodeControl({ kind: "pair_confirm" }) },
        { from: "host", plaintext: encodeControl({ kind: "paired", deviceId: DEVICE_ID, hostName: "Test Mac" }) },
        ...framesOf("phone", hello),
        ...framesOf("host", welcome),
        { from: "phone", plaintext: PING },
        { from: "host", plaintext: PONG },
      ],
    },
    ik: {
      ...keys,
      pattern: "IK",
      psk: null,
      payloads: [
        json({ kind: "connect", appVersion: "0.0.0", protocolVersion: PROTOCOL_VERSION }),
        json({ ok: true, deviceId: DEVICE_ID }),
      ],
      frames: [
        ...framesOf("phone", hello),
        ...framesOf("host", welcome),
        ...framesOf("phone", { type: "ping", requestId: "r1", traceparent: TRACEPARENT }),
        ...framesOf("host", { type: "response", requestId: "r1", ok: true }),
        { from: "phone", plaintext: PING },
        // A two-chunk host message with the heartbeat answer between its chunks.
        big[0] as { from: Side; plaintext: Uint8Array },
        { from: "host", plaintext: PONG },
        big[1] as { from: Side; plaintext: Uint8Array },
        { from: "host", plaintext: encodeControl({ kind: "revoked" }) },
      ],
    },
  };
}
