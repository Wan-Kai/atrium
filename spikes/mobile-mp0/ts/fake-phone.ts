/**
 * A fake phone in TypeScript for the MP0 spike: pairs from a link (IKpsk2 plus key confirmation),
 * shows the SAS, then reconnects over IK and says `hello` (SPEC-0005, "配对流程", "日常连接").
 *
 * Run: `node fake-phone.ts pair '<atrium://pair?…>'` or `node fake-phone.ts connect`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { WebSocket } from "ws";
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from "./bytes.ts";
import {
  firstFrame,
  HOST_TO_PHONE_LIMIT,
  PHONE_TO_HOST_LIMIT,
  prologue,
  type Received,
  sas,
  SecureChannel,
} from "./channel.ts";
import { PROTOCOL_VERSION } from "./fake-host.ts";
import { generateKeyPair, HandshakeState, type KeyPair, keyPairFrom, type Pattern } from "./noise.ts";

/** A host this phone knows, as the iOS app keeps it in the keychain. */
export interface HostRecord {
  hostId: string;
  relay: string;
  /** The host's static public key, base64url. */
  hostKey: string;
  hostName: string;
  /** Null while the pairing is still "待确认". */
  deviceId: string | null;
}

/** What the fake phone keeps between runs. */
interface PhoneState {
  secretKey: string;
  hosts: HostRecord[];
}

/** The fields of an `atrium://pair` link. */
export interface PairingLink {
  relay: string;
  hostId: string;
  hostKey: Uint8Array;
  pairingId: string;
  psk: Uint8Array;
  name: string;
}

/** The host or the channel said no; `reason` is what it said (or the close reason). */
export class PhoneRejected extends Error {
  readonly reason: string;

  /**
   * Makes the error.
   *
   * @sideEffects none
   * @param reason - Why.
   */
  constructor(reason: string) {
    super(`rejected: ${reason}`);
    this.reason = reason;
  }
}

/**
 * Reads a pairing link.
 *
 * @sideEffects none
 * @param link - `atrium://pair?v=1&relay=…&host=…&key=…&pairing=…&psk=…&name=…`.
 * @returns The fields.
 * @throws Error when it is not a v1 pairing link.
 */
export function parsePairingLink(link: string): PairingLink {
  const url = new URL(link);
  if (url.protocol !== "atrium:" || url.hostname !== "pair") throw new Error("not an atrium://pair link");
  const get = (name: string) => {
    const value = url.searchParams.get(name);
    if (value === null) throw new Error(`link has no ${name}`);
    return value;
  };
  if (get("v") !== "1") throw new Error("unknown link version");
  return {
    relay: get("relay"),
    hostId: get("host"),
    hostKey: fromBase64Url(get("key"), 32),
    pairingId: get("pairing"),
    psk: fromBase64Url(get("psk"), 32),
    name: get("name"),
  };
}

/**
 * An established channel to the host, with request/response helpers.
 *
 * @remarks
 * Everything that arrives is queued; `next` takes the first item matching a test, so callers can
 * wait for a `welcome`, a response or a control message in any order.
 */
export class PhoneSession {
  readonly deviceId: string | null;
  readonly sas: string;
  readonly channel: SecureChannel;
  /** Resolves with the reason when the channel or the socket closes. */
  readonly closed: Promise<string>;
  readonly #socket: WebSocket;
  readonly #inbox: Received[] = [];
  #waiters: {
    test: (received: Received) => boolean;
    resolve: (received: Received) => void;
    reject: (error: Error) => void;
  }[] = [];
  #closeReason: string | null = null;

  /**
   * Wraps a finished handshake.
   *
   * @sideEffects Takes over the socket's message and close handlers.
   * @param socket - The connection to the relay.
   * @param handshake - After message 2.
   * @param deviceId - From message 2 (IK) or null until `paired`.
   * @param onControl - Sees every control message first (to drop the host on `revoked`).
   */
  constructor(
    socket: WebSocket,
    handshake: HandshakeState,
    deviceId: string | null,
    onControl: (value: Record<string, unknown>) => void,
  ) {
    this.#socket = socket;
    this.deviceId = deviceId;
    let settle: (reason: string) => void = () => {};
    this.closed = new Promise((resolve) => (settle = resolve));
    this.channel = new SecureChannel(handshake.finish(), {
      write: (bytes) => socket.send(bytes),
      sendLimit: PHONE_TO_HOST_LIMIT,
      receiveLimit: HOST_TO_PHONE_LIMIT,
      onReceive: (received) => {
        if (received.kind === "control") onControl(received.value);
        const index = this.#waiters.findIndex((waiter) => waiter.test(received));
        if (index === -1) this.#inbox.push(received);
        else this.#waiters.splice(index, 1)[0]?.resolve(received);
      },
      onClose: (reason) => this.#finish(reason, settle),
    });
    this.sas = sas(this.channel.handshakeHash);
    socket.on("message", (data, isBinary) => {
      if (!isBinary) return this.channel.close("text_frame");
      const buffer = data as Buffer;
      this.channel.receive(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length));
    });
    // Errors are followed by `close`, which is what ends the session.
    socket.on("error", () => {});
    socket.on("close", (code) => {
      this.channel.close(`socket_closed:${code}`);
      this.#finish(`socket_closed:${code}`, settle);
    });
  }

  /**
   * Waits for the first received item that passes a test.
   *
   * @sideEffects Takes the item out of the inbox.
   * @param test - Which item.
   * @param timeoutMs - How long to wait.
   * @returns The item.
   * @throws PhoneRejected when the channel closes first or time runs out.
   */
  next(test: (received: Received) => boolean, timeoutMs = 5_000): Promise<Received> {
    const index = this.#inbox.findIndex(test);
    if (index !== -1) return Promise.resolve(this.#inbox.splice(index, 1)[0] as Received);
    if (this.#closeReason !== null) return Promise.reject(new PhoneRejected(this.#closeReason));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((waiter) => waiter.resolve !== done);
        reject(new PhoneRejected("timeout"));
      }, timeoutMs);
      const done = (received: Received) => {
        clearTimeout(timer);
        resolve(received);
      };
      this.#waiters.push({
        test,
        resolve: done,
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  /**
   * Waits for a control message of one kind.
   *
   * @sideEffects Takes it out of the inbox.
   * @param kinds - Acceptable kinds.
   * @param timeoutMs - How long to wait.
   * @returns The control message.
   */
  async control(kinds: string[], timeoutMs = 5_000): Promise<Record<string, unknown>> {
    const received = await this.next((item) => item.kind === "control" && kinds.includes(item.value.kind), timeoutMs);
    return (received as Extract<Received, { kind: "control" }>).value;
  }

  /**
   * Sends `hello` (no token, clientId = deviceId) and waits for `welcome`.
   *
   * @sideEffects Sends a message.
   * @param deviceId - The id the host gave this phone.
   * @returns The welcome.
   */
  async hello(deviceId: string): Promise<Record<string, unknown>> {
    this.channel.sendMessage(
      JSON.stringify({
        type: "hello",
        protocolVersion: PROTOCOL_VERSION,
        clientId: deviceId,
        traceparent: traceparent(),
      }),
    );
    return this.#json(await this.next((item) => item.kind === "message" && this.#json(item).type === "welcome"));
  }

  /**
   * Sends one command and waits for its response.
   *
   * @sideEffects Sends a message.
   * @param command - Without requestId and traceparent.
   * @returns The response.
   */
  async request(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = randomUUID();
    this.channel.sendMessage(JSON.stringify({ ...command, requestId, traceparent: traceparent() }));
    return this.#json(await this.next((item) => item.kind === "message" && this.#json(item).requestId === requestId));
  }

  /**
   * Sends a channel heartbeat and waits for the answer (15 seconds, SPEC-0005 "心跳").
   *
   * @sideEffects Sends a frame.
   * @returns When the pong came.
   */
  async heartbeat(): Promise<void> {
    this.channel.ping();
    await this.next((item) => item.kind === "pong", 15_000);
  }

  /**
   * Closes the connection.
   *
   * @sideEffects Closes the socket.
   * @returns When it is closed.
   */
  async close(): Promise<void> {
    if (this.#socket.readyState !== WebSocket.CLOSED) this.#socket.close(1000);
    await this.closed;
  }

  /**
   * Parses a received message as JSON.
   *
   * @sideEffects none
   * @param received - A message item.
   * @returns The object, or an empty one.
   */
  #json(received: Received): Record<string, unknown> {
    if (received.kind !== "message") return {};
    try {
      return JSON.parse(received.text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /**
   * Settles `closed` and fails everyone waiting.
   *
   * @sideEffects Rejects waiters.
   * @param reason - Why.
   * @param settle - Resolves `closed`.
   */
  #finish(reason: string, settle: (reason: string) => void): void {
    if (this.#closeReason !== null) return;
    this.#closeReason = reason;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(new PhoneRejected(reason));
    settle(reason);
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.close(1000);
  }
}

/**
 * A W3C traceparent with random ids.
 *
 * @sideEffects Reads the random source.
 * @returns The header value.
 */
function traceparent(): string {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}

/** Options of the fake phone. */
export interface FakePhoneOptions {
  /** JSON file for the key and hosts; null keeps them in memory. */
  readonly statePath: string | null;
  readonly deviceName?: string;
  readonly model?: string;
  /** Use this static key instead of a stored or new one. */
  readonly staticKey?: KeyPair;
}

/** The fake phone. */
export class FakePhone {
  readonly #options: FakePhoneOptions;
  readonly #key: KeyPair;
  #hosts: HostRecord[];

  /**
   * Loads or makes the phone's key.
   *
   * @sideEffects Reads and maybe writes the state file.
   * @param options - Storage and names.
   */
  constructor(options: FakePhoneOptions) {
    this.#options = options;
    const path = options.statePath;
    const state: PhoneState =
      path !== null && existsSync(path)
        ? (JSON.parse(readFileSync(path, "utf8")) as PhoneState)
        : { secretKey: toBase64Url((options.staticKey ?? generateKeyPair()).secretKey), hosts: [] };
    this.#key = options.staticKey ?? keyPairFrom(fromBase64Url(state.secretKey, 32));
    this.#hosts = state.hosts;
    this.#save();
  }

  /**
   * The hosts this phone knows.
   *
   * @sideEffects none
   * @returns A copy.
   */
  get hosts(): HostRecord[] {
    return this.#hosts.map((host) => ({ ...host }));
  }

  /**
   * Pairs from a link: IKpsk2, then `pair_confirm`. Returns as soon as the SAS is known; the
   * session's `control(["paired", "pair_rejected"])` tells how the Mac answered.
   *
   * @sideEffects Connects; records the host as "待确认"; on `paired` records the deviceId.
   * @param link - The QR code's text.
   * @param options - `confirm: false` holds back `pair_confirm`, so a test can race two phones.
   * @returns The session (with its SAS).
   * @throws PhoneRejected when the host answers `ok: false` or the handshake fails.
   */
  async pair(link: string, options: { confirm?: boolean } = {}): Promise<PhoneSession> {
    const parsed = parsePairingLink(link);
    const record: HostRecord = {
      hostId: parsed.hostId,
      relay: parsed.relay,
      hostKey: toBase64Url(parsed.hostKey),
      hostName: parsed.name,
      deviceId: null,
    };
    this.#putHost(record);
    const payload = {
      kind: "pair",
      pairingId: parsed.pairingId,
      deviceName: this.#options.deviceName ?? "Fake iPhone",
      model: this.#options.model ?? "spike",
      appVersion: "0.0.0-mp0-spike",
      protocolVersion: PROTOCOL_VERSION,
    };
    const session = await this.#handshake(record, "IKpsk2", payload, parsed.psk, (answer) => {
      if (answer.ok !== true) throw new PhoneRejected(String(answer.reason));
      return null;
    });
    if (options.confirm !== false) session.channel.sendControl({ kind: "pair_confirm" });
    return session;
  }

  /**
   * Connects to a known host over IK.
   *
   * @sideEffects Connects; forgets the host on `device_unknown` or `revoked`; completes a pending pairing.
   * @param hostId - Which host; defaults to the only one.
   * @returns The session, before `hello`.
   * @throws PhoneRejected with the host's reason.
   */
  async connect(hostId?: string): Promise<PhoneSession> {
    const record = hostId === undefined ? this.#hosts[0] : this.#hosts.find((host) => host.hostId === hostId);
    if (record === undefined) throw new Error("no such host; pair first");
    const payload = { kind: "connect", appVersion: "0.0.0-mp0-spike", protocolVersion: PROTOCOL_VERSION };
    return this.#handshake(record, "IK", payload, undefined, (answer) => {
      if (answer.ok === true && typeof answer.deviceId === "string") {
        // Also how a "待确认" pairing whose `paired` got lost is completed.
        this.#putHost({ ...record, deviceId: answer.deviceId });
        return answer.deviceId;
      }
      if (answer.reason === "device_unknown") this.#dropHost(record.hostId);
      throw new PhoneRejected(String(answer.reason));
    });
  }

  /**
   * Opens the relay connection and runs the two handshake messages.
   *
   * @sideEffects Connects to the relay.
   * @param record - The host.
   * @param pattern - IK or IKpsk2.
   * @param payload - Message 1's payload.
   * @param psk - For IKpsk2.
   * @param check - Reads message 2's payload; returns the deviceId or throws.
   * @returns The session.
   */
  async #handshake(
    record: HostRecord,
    pattern: Pattern,
    payload: Record<string, unknown>,
    psk: Uint8Array | undefined,
    check: (answer: Record<string, unknown>) => string | null,
  ): Promise<PhoneSession> {
    const handshake = HandshakeState.initiator({
      pattern,
      prologue: prologue(record.hostId),
      staticKey: this.#key,
      remoteStatic: fromBase64Url(record.hostKey, 32),
      ...(psk === undefined ? {} : { psk }),
    });
    const socket = new WebSocket(`${record.relay}/v1/client?host=${encodeURIComponent(record.hostId)}`);
    socket.binaryType = "nodebuffer";
    // Frames that arrive while we are still reading message 2 are kept for the session.
    const frames: Buffer[] = [];
    let wake: () => void = () => {};
    socket.on("message", (data) => {
      frames.push(data as Buffer);
      wake();
    });
    await new Promise<void>((resolve, reject) => {
      wake = resolve;
      socket.once("open", () =>
        socket.send(firstFrame(pattern, handshake.writeMessage(utf8(JSON.stringify(payload))))),
      );
      socket.once("error", (error) => reject(new PhoneRejected(`socket_error:${error.message}`)));
      socket.once("close", (code, reason) => reject(new PhoneRejected(`socket_closed:${code}:${String(reason)}`)));
    });
    const message2 = frames.shift() as Buffer;
    let deviceId: string | null;
    try {
      const answer = JSON.parse(fromUtf8(handshake.readMessage(new Uint8Array(message2)))) as Record<string, unknown>;
      deviceId = check(answer);
    } catch (error) {
      socket.close(1000);
      if (error instanceof PhoneRejected) throw error;
      throw new PhoneRejected((error as { reason?: string }).reason ?? "bad_answer");
    }
    socket.removeAllListeners();
    const session = new PhoneSession(socket, handshake, deviceId, (value) => {
      // Only an authenticated `revoked` drops the host; relay close codes never do.
      if (value.kind === "revoked") this.#dropHost(record.hostId);
      if (value.kind === "paired" && typeof value.deviceId === "string") {
        this.#putHost({ ...record, deviceId: value.deviceId });
      }
      if (value.kind === "pair_rejected" && record.deviceId === null) this.#dropHost(record.hostId);
    });
    for (const frame of frames) session.channel.receive(new Uint8Array(frame));
    return session;
  }

  /**
   * Adds or replaces a host record.
   *
   * @sideEffects Writes the state file.
   * @param record - The record.
   */
  #putHost(record: HostRecord): void {
    this.#hosts = [...this.#hosts.filter((host) => host.hostId !== record.hostId), record];
    this.#save();
  }

  /**
   * Forgets a host (revoked or unknown to it).
   *
   * @sideEffects Writes the state file.
   * @param hostId - The host.
   */
  #dropHost(hostId: string): void {
    this.#hosts = this.#hosts.filter((host) => host.hostId !== hostId);
    this.#save();
  }

  /**
   * Writes the state file.
   *
   * @sideEffects Writes the file, 0600.
   */
  #save(): void {
    const path = this.#options.statePath;
    if (path === null) return;
    mkdirSync(dirname(path), { recursive: true });
    const state: PhoneState = { secretKey: toBase64Url(this.#key.secretKey), hosts: this.#hosts };
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }
}

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { state: { type: "string", default: new URL(".state/phone.json", import.meta.url).pathname } },
  });
  const phone = new FakePhone({ statePath: values.state });
  const [command, link] = positionals;
  let session: PhoneSession;
  let deviceId: string;
  if (command === "pair" && link !== undefined) {
    session = await phone.pair(link);
    console.log(`校验码 ${session.sas.slice(0, 3)} ${session.sas.slice(3)} · 在 Mac 上确认`);
    const answer = await session.control(["paired", "pair_rejected"], 130_000);
    if (answer.kind !== "paired") throw new PhoneRejected(String(answer.reason));
    deviceId = String(answer.deviceId);
    console.log(`paired as ${deviceId}`);
  } else if (command === "connect") {
    session = await phone.connect();
    deviceId = session.deviceId as string;
  } else {
    throw new Error("usage: fake-phone.ts pair '<link>' | connect");
  }
  console.log("welcome:", await session.hello(deviceId));
  console.log("ping:", await session.request({ type: "ping" }));
  await session.heartbeat();
  console.log("heartbeat answered");
  await session.close();
}
