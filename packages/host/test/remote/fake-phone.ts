import { PROTOCOL_VERSION } from "@atrium/protocol";
import {
  type Clock,
  type ControlMessage,
  type KeyPair,
  type Pattern,
  type Received,
  firstFrame,
  fromBase64Url,
  fromUtf8,
  generateKeyPair,
  HandshakeState,
  HOST_TO_PHONE_LIMIT,
  PHONE_TO_HOST_LIMIT,
  prologue,
  sas,
  SecureChannel,
  utf8,
} from "@atrium/remote-crypto";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import { systemClock } from "../../src/platform/clock";
import { Inbox, type WaitOptions } from "./inbox";

/** In-memory phone host record, including a pairing still awaiting acknowledgement. */
export interface PhoneHost {
  readonly hostId: string;
  readonly relay: string;
  readonly hostKey: string;
  readonly deviceId: string | null;
}

/** Handshake variations for rejection tests. */
export interface HandshakeOptions extends WaitOptions {
  readonly protocolVersion?: number;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly confirm?: boolean;
}

/**
 * Converts ws's supported binary representations into one byte array.
 * @remarks Tests do not assume ws always delivers Buffer rather than Buffer[].
 * @sideEffects none
 * @param data - A ws frame.
 * @returns Its bytes.
 */
function bytes(data: RawData): Uint8Array {
  return data instanceof ArrayBuffer ? new Uint8Array(data) : Buffer.isBuffer(data) ? data : Buffer.concat(data);
}

/**
 * Rejects any remote address outside this test machine before opening a socket.
 * @remarks Even a mistakenly supplied production pairing link must never contact the user's server.
 * @sideEffects none
 * @param relay - Relay base URL.
 * @returns The validated URL.
 */
function localRelay(relay: string): URL {
  const url = new URL(relay);
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.port === "" || url.username || url.password) {
    throw new Error("fake phone requires a loopback test relay");
  }
  return url;
}

/**
 * Creates a valid W3C trace identifier for a test message.
 * @remarks Remote hello and commands require the same tracing envelope as local messages.
 * @sideEffects Reads the random source.
 * @returns A traceparent.
 */
function traceparent(): string {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}

/**
 * Owns a real socket and the phone half of its Noise session.
 * @remarks The message listener is installed before the handshake, so transport frames arriving
 * immediately after message two cannot be lost. Closing a session rejects pending receives.
 * @sideEffects Listens to socket events and sends encrypted frames.
 */
export class PhoneSession {
  readonly channel: SecureChannel;
  readonly sas: string;
  readonly deviceId: string | null;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly #socket: WebSocket;
  readonly #inbox: Inbox<Received>;
  readonly #clock: Clock;

  /**
   * Takes ownership of a completed handshake and its socket.
   * @remarks Only FakePhone constructs sessions; callers use channel for raw wire probes.
   * @sideEffects Installs socket listeners and creates a secure channel.
   * @param socket - Connected local relay socket.
   * @param handshake - Completed Noise handshake.
   * @param deviceId - Authenticated daily connection identity, or null while pairing.
   * @param clock - Deadline and chunk timer clock.
   * @param onControl - Updates in-memory host records after authenticated controls.
   */
  constructor(
    socket: WebSocket,
    handshake: HandshakeState,
    deviceId: string | null,
    clock: Clock,
    onControl: (value: ControlMessage) => void,
  ) {
    this.#socket = socket;
    this.#clock = clock;
    this.deviceId = deviceId;
    this.#inbox = new Inbox(clock);
    this.channel = new SecureChannel(handshake.finish(), {
      clock,
      sendLimit: PHONE_TO_HOST_LIMIT,
      receiveLimit: HOST_TO_PHONE_LIMIT,
      write: (frame) => socket.send(frame),
      onReceive: (item) => {
        if (item.kind === "control") onControl(item.value);
        this.#inbox.push(item);
      },
      onClose: (reason) => {
        this.#inbox.fail(new Error(reason));
        if (socket.readyState === WebSocket.OPEN) socket.close(1000);
      },
    });
    this.sas = sas(this.channel.handshakeHash);
    this.closed = new Promise((resolve) =>
      socket.once("close", (code, reason) => {
        this.channel.close(`socket_closed:${code}:${reason.toString()}`);
        resolve({ code, reason: reason.toString() });
      }),
    );
  }

  /**
   * Waits for a selected channel arrival without losing unrelated arrivals.
   * @remarks Controls, heartbeats and Atrium messages share the same ordered inbox.
   * @sideEffects Consumes an arrival or registers a cancellable deadline.
   * @param matches - Selection predicate.
   * @param options - Deadline and cancellation.
   * @returns The matching arrival.
   */
  next(matches: (item: Received) => boolean, options: WaitOptions = {}): Promise<Received> {
    return this.#inbox.next(matches, options);
  }

  /**
   * Waits for one of the named authenticated controls.
   * @remarks Used for paired, pair_rejected and revoked assertions.
   * @sideEffects Consumes a control or registers a cancellable deadline.
   * @param kinds - Accepted kinds.
   * @param options - Deadline and cancellation.
   * @returns The full control payload.
   */
  async control(kinds: readonly string[], options: WaitOptions = {}): Promise<ControlMessage> {
    const item = await this.next((value) => value.kind === "control" && kinds.includes(value.value.kind), options);
    if (item.kind !== "control") throw new Error("expected control");
    return item.value;
  }

  /**
   * Waits for a JSON Atrium message satisfying a predicate.
   * @remarks Unlike the application client this helper allows arbitrary envelope assertions.
   * @sideEffects Consumes a message or registers a cancellable deadline.
   * @param matches - Selection predicate over JSON objects.
   * @param options - Deadline and cancellation.
   * @returns The decoded message.
   */
  async message(
    matches: (value: Record<string, unknown>) => boolean = () => true,
    options: WaitOptions = {},
  ): Promise<Record<string, unknown>> {
    const item = await this.next(
      (value) => value.kind === "message" && matches(JSON.parse(value.text) as Record<string, unknown>),
      options,
    );
    if (item.kind !== "message") throw new Error("expected message");
    return JSON.parse(item.text) as Record<string, unknown>;
  }

  /**
   * Sends an arbitrary JSON message without waiting for an answer.
   * @remarks Malformed-envelope tests must be able to bypass application-client validation.
   * @sideEffects Sends encrypted frames.
   * @param value - JSON payload.
   */
  send(value: unknown): void {
    this.channel.sendMessage(JSON.stringify(value));
  }

  /**
   * Sends a hello with explicit identity or version overrides.
   * @remarks Separating send from receive lets tests inspect rejected hellos via closed.
   * @sideEffects Sends encrypted frames.
   * @param clientId - Usually the authenticated device id.
   * @param overrides - Fields to replace or add, including protocolVersion or token.
   */
  sendHello(clientId: string, overrides: Readonly<Record<string, unknown>> = {}): void {
    this.send({ type: "hello", protocolVersion: PROTOCOL_VERSION, clientId, traceparent: traceparent(), ...overrides });
  }

  /**
   * Sends a hello and awaits welcome.
   * @remarks Pairing sessions can pass the device id from their paired control.
   * @sideEffects Sends a hello and waits with a cancellable deadline.
   * @param clientId - Authenticated device id.
   * @param overrides - Custom hello fields.
   * @param options - Deadline and cancellation.
   * @returns The welcome object.
   */
  async hello(
    clientId: string,
    overrides: Readonly<Record<string, unknown>> = {},
    options: WaitOptions = {},
  ): Promise<Record<string, unknown>> {
    this.sendHello(clientId, overrides);
    return this.message((value) => value.type === "welcome", options);
  }

  /**
   * Sends a command and correlates its response by request id.
   * @remarks Unrelated events stay buffered for subsequent assertions.
   * @sideEffects Sends encrypted frames and registers a cancellable wait.
   * @param command - Command fields; requestId and traceparent may be supplied explicitly.
   * @param options - Deadline and cancellation.
   * @returns The matching response.
   */
  async request(
    command: Readonly<Record<string, unknown>>,
    options: WaitOptions = {},
  ): Promise<Record<string, unknown>> {
    const requestId = command.requestId ?? randomUUID();
    this.send({ traceparent: traceparent(), ...command, requestId });
    return this.message((value) => value.requestId === requestId, options);
  }

  /**
   * Closes gracefully, or immediately terminates to simulate a dropped connection.
   * @remarks A bounded fallback ensures teardown cannot leave an unresponsive peer alive.
   * @sideEffects Closes the socket and briefly schedules a termination deadline.
   * @param options - Immediate termination or custom WebSocket close code and reason.
   * @returns Once the actual socket is closed.
   */
  async close(options: { terminate?: boolean; code?: number; reason?: string } = {}): Promise<void> {
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    const cancel = this.#clock.setTimeout(() => this.#socket.terminate(), 1_000);
    try {
      if (options.terminate) this.#socket.terminate();
      else this.#socket.close(options.code ?? 1000, options.reason ?? "");
      await this.closed;
    } finally {
      cancel();
    }
  }
}

/** Configuration of an in-memory phone identity. */
export interface FakePhoneOptions {
  readonly clock?: Clock;
  readonly staticKey?: KeyPair;
  readonly deviceName?: string;
  readonly model?: string;
}

/**
 * Implements the test phone's pairing and daily connection flows over real WebSockets.
 * @remarks Uses production remote-crypto, but no host remote service or pi imports. Host records
 * survive socket loss; only authenticated revocation or device_unknown removes them.
 * @sideEffects Owns generated keys, host records and sessions until dispose.
 */
export class FakePhone {
  readonly #options: FakePhoneOptions;
  readonly #clock: Clock;
  readonly #key: KeyPair;
  readonly #hosts = new Map<string, PhoneHost>();
  readonly #sockets = new Map<WebSocket, Promise<void>>();

  /**
   * Creates an isolated phone identity.
   * @remarks Tests may reuse a static key to emulate relaunch without writing real credentials.
   * @sideEffects Reads randomness unless a static key is supplied.
   * @param options - Clock, identity and device metadata.
   */
  constructor(options: FakePhoneOptions = {}) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#key = options.staticKey ?? generateKeyPair();
  }

  /**
   * Returns copies of remembered host records.
   * @remarks Tests inspect pending-pairing recovery without mutating phone state.
   * @sideEffects none
   * @returns All remembered hosts.
   */
  get hosts(): PhoneHost[] {
    return [...this.#hosts.values()].map((value) => ({ ...value }));
  }

  /**
   * Starts IKpsk2 pairing from a test relay QR payload.
   * @remarks confirm:false leaves key confirmation under test control for races and expiration.
   * @sideEffects Opens a socket, remembers a pending host and optionally sends pair_confirm.
   * @param link - atrium://pair v1 link.
   * @param options - Handshake fields, cancellation and confirmation control.
   * @returns The session and its SAS before the desktop decides.
   */
  async pair(link: string, options: HandshakeOptions = {}): Promise<PhoneSession> {
    const url = new URL(link);
    if (url.protocol !== "atrium:" || url.hostname !== "pair" || url.searchParams.get("v") !== "1")
      throw new Error("invalid pairing link");
    /**
     * Reads a required QR field.
     * @remarks Missing fields must fail before connecting.
     * @sideEffects none
     * @param name - Query field.
     * @returns Its value.
     */
    const get = (name: string): string => {
      const value = url.searchParams.get(name);
      if (value === null) throw new Error(`missing pairing field: ${name}`);
      return value;
    };
    const host: PhoneHost = { relay: get("relay"), hostId: get("host"), hostKey: get("key"), deviceId: null };
    localRelay(host.relay);
    fromBase64Url(host.hostKey, 32);
    const psk = fromBase64Url(get("psk"), 32);
    this.#hosts.set(host.hostId, host);
    const session = await this.#handshake(
      host,
      "IKpsk2",
      {
        kind: "pair",
        pairingId: get("pairing"),
        deviceName: this.#options.deviceName ?? "Fake iPhone",
        model: this.#options.model ?? "test",
        appVersion: "0.0.0-test",
        protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
        ...options.payload,
      },
      psk,
      options,
    );
    if (options.confirm !== false) session.channel.sendControl({ kind: "pair_confirm" });
    return session;
  }

  /**
   * Opens a daily IK channel, including recovery of a lost paired control.
   * @remarks The caller sends hello explicitly to exercise identity and protocol failures.
   * @sideEffects Opens a socket and updates the authenticated device id.
   * @param hostId - Remembered host, defaulting to the first.
   * @param options - Handshake fields and cancellation.
   * @returns The established session before hello.
   */
  async connect(hostId?: string, options: HandshakeOptions = {}): Promise<PhoneSession> {
    const host = hostId === undefined ? this.hosts[0] : this.#hosts.get(hostId);
    if (host === undefined) throw new Error("no remembered host");
    return this.#handshake(
      host,
      "IK",
      {
        kind: "connect",
        appVersion: "0.0.0-test",
        protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
        ...options.payload,
      },
      undefined,
      options,
    );
  }

  /**
   * Completes both Noise messages without a listener handoff gap.
   * @remarks Transport frames may follow message two in the same socket read.
   * @sideEffects Opens and owns a socket; failures terminate it before returning.
   * @param host - Target host.
   * @param pattern - Pairing or daily Noise pattern.
   * @param payload - Handshake request.
   * @param psk - Pairing PSK, when applicable.
   * @param options - Deadline and cancellation.
   * @returns The authenticated session.
   */
  async #handshake(
    host: PhoneHost,
    pattern: Pattern,
    payload: Record<string, unknown>,
    psk: Uint8Array | undefined,
    options: WaitOptions,
  ): Promise<PhoneSession> {
    options.signal?.throwIfAborted();
    const url = localRelay(host.relay);
    url.pathname += "/v1/client";
    url.search = new URLSearchParams({ host: host.hostId }).toString();
    const handshake = HandshakeState.initiator({
      pattern,
      prologue: prologue(host.hostId),
      staticKey: this.#key,
      remoteStatic: fromBase64Url(host.hostKey, 32),
      ...(psk === undefined ? {} : { psk }),
    });
    const first = firstFrame(pattern, handshake.writeMessage(utf8(JSON.stringify(payload))));
    const socket = new WebSocket(url);
    const established = new Inbox<PhoneSession>(this.#clock);
    const socketClosed = new Promise<void>((resolve) =>
      socket.once("close", () => {
        this.#sockets.delete(socket);
        resolve();
      }),
    );
    this.#sockets.set(socket, socketClosed);
    let session: PhoneSession | undefined;
    socket.once("open", () => socket.send(first));
    socket.on("error", (error) => established.fail(error));
    socket.once("close", (code, reason) => established.fail(new Error(`socket_closed:${code}:${reason.toString()}`)));
    socket.on("message", (data, binary) => {
      try {
        if (!binary) throw new Error("text_frame");
        if (session !== undefined) {
          session.channel.receive(bytes(data));
          return;
        }
        const answer = JSON.parse(fromUtf8(handshake.readMessage(bytes(data)))) as Record<string, unknown>;
        if (answer.ok !== true) {
          if (answer.reason === "device_unknown") this.#hosts.delete(host.hostId);
          throw new Error(String(answer.reason));
        }
        const deviceId = pattern === "IK" && typeof answer.deviceId === "string" ? answer.deviceId : null;
        if (pattern === "IK" && deviceId === null) throw new Error("missing deviceId");
        if (deviceId !== null) this.#hosts.set(host.hostId, { ...host, deviceId });
        session = new PhoneSession(socket, handshake, deviceId, this.#clock, (control) => {
          if (control.kind === "revoked" || (control.kind === "pair_rejected" && host.deviceId === null)) {
            this.#hosts.delete(host.hostId);
          }
          if (control.kind === "paired" && typeof control.deviceId === "string")
            this.#hosts.set(host.hostId, { ...host, deviceId: control.deviceId });
        });
        established.push(session);
      } catch (error) {
        established.fail(error instanceof Error ? error : new Error("bad handshake"));
        socket.terminate();
      }
    });
    try {
      return await established.next(() => true, options);
    } catch (error) {
      socket.terminate();
      await socketClosed;
      throw error;
    }
  }

  /**
   * Closes every session created by this phone.
   * @remarks Teardown works after partial pairing failures and does not erase remembered hosts.
   * @sideEffects Terminates owned sockets and releases their channel timers.
   * @returns When all sockets are closed.
   */
  async dispose(): Promise<void> {
    const sockets = [...this.#sockets];
    for (const [socket] of sockets) socket.terminate();
    await Promise.all(sockets.map(([, closed]) => closed));
  }
}
