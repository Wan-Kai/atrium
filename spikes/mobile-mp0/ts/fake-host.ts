/**
 * A fake Atrium host for the MP0 spike: connects to the relay, pairs phones (SPEC-0005,
 * "配对流程"), accepts known devices over IK ("日常连接"), and answers `hello` and `ping`.
 *
 * Run: `node fake-host.ts --relay atrium-relay://<hostId>:<token>@<host:port> [--pair]
 * [--auto-confirm] [--public-relay ws://<LAN IP>:8787]`, or `--local-relay 8787` to start a relay
 * in the same process. Type `pair`, `y`, `n`, `devices`, `revoke <deviceId>` or `quit`.
 */
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { renderUnicodeCompact } from "uqr";
import { type RawData, WebSocket } from "ws";
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from "./bytes.ts";
import {
  HOST_TO_PHONE_LIMIT,
  parseFirstFrame,
  PHONE_TO_HOST_LIMIT,
  prologue,
  type Received,
  sas,
  SecureChannel,
} from "./channel.ts";
import { generateKeyPair, HandshakeState, type KeyPair, keyPairFrom, type Pattern } from "./noise.ts";
import { lanAddresses, startRelay } from "./relay.ts";

/** Atrium's protocol version when the spike was written (packages/protocol/src/version.ts). */
export const PROTOCOL_VERSION = 25;
/** The QR code is valid this long (SPEC-0005, "配对流程"). */
export const PAIRING_TTL_MS = 5 * 60_000;
/** How long the Mac waits for the user to confirm. */
export const CONFIRM_TIMEOUT_MS = 2 * 60_000;
/** A stream that has not finished its handshake in this time is closed. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** At most this many streams may be mid-handshake. */
const MAX_PENDING_HANDSHAKES = 4;
/** At most this many channels per device; a new one pushes out the oldest. */
const MAX_CHANNELS_PER_DEVICE = 2;

/** A paired phone, as stored. */
export interface Device {
  deviceId: string;
  name: string;
  model: string;
  /** X25519 public key, base64url. */
  publicKey: string;
  pairedAt: number;
}

/** What the fake host keeps between runs (the real one keeps this in the vault). */
interface HostState {
  secretKey: string;
  devices: Device[];
}

/** The states a pairing goes through. */
export type PairingState = "available" | "awaiting_confirmation" | "committed" | "rejected" | "expired";

/** A phone asking to be paired, shown on the Mac with its SAS. */
export interface PairingRequest {
  readonly pairingId: string;
  readonly deviceName: string;
  readonly model: string;
  readonly sas: string;
}

/** The one pairing in progress. */
interface Pairing {
  readonly pairingId: string;
  readonly psk: Uint8Array;
  readonly expiresAt: number;
  state: PairingState;
  request: (PairingRequest & { publicKey: Uint8Array; connection: Connection }) | null;
  refused: number;
  cancelTimer: () => void;
}

/** Options of the fake host. */
export interface FakeHostOptions {
  /** `ws://host:port` the host itself connects to. */
  readonly relayUrl: string;
  /** What goes into the pairing link; defaults to `relayUrl`. */
  readonly publicRelayUrl?: string;
  readonly hostId: string;
  readonly token: string;
  readonly hostName?: string;
  /** JSON file for the key and devices; null keeps them in memory. */
  readonly statePath: string | null;
  readonly log?: (line: string) => void;
}

/** Events the host emits. */
interface FakeHostEvents {
  pairing_request: [PairingRequest];
  pairing_state: [PairingState, string];
  device_connected: [string];
  device_hello: [string];
}

/**
 * The fake host.
 *
 * @remarks
 * Every pairing transition happens inside one synchronous call, as SPEC-0005 asks; the "vault
 * write" is a synchronous file write, so there is no await between the check and the commit.
 */
export class FakeHost extends EventEmitter<FakeHostEvents> {
  readonly hostId: string;
  readonly hostName: string;
  readonly #options: FakeHostOptions;
  readonly #log: (line: string) => void;
  readonly #key: KeyPair;
  readonly #devices: Device[];
  /** Revoked in this run; stays even if the file write fails. */
  readonly #blocked = new Set<string>();
  readonly #connections = new Set<Connection>();
  #control: WebSocket | null = null;
  #pairing: Pairing | null = null;
  #closing = false;

  /**
   * Loads or makes the host key and device list.
   *
   * @sideEffects Reads and maybe writes the state file.
   * @param options - Relay, identity and storage.
   */
  constructor(options: FakeHostOptions) {
    super();
    this.#options = options;
    this.hostId = options.hostId;
    this.hostName = options.hostName ?? hostname();
    this.#log = options.log ?? ((line) => console.log(line));
    const state = this.#load();
    this.#key = keyPairFrom(fromBase64Url(state.secretKey, 32));
    this.#devices = state.devices;
    this.#save();
  }

  /**
   * The host's static public key.
   *
   * @sideEffects none
   * @returns 32 bytes.
   */
  get publicKey(): Uint8Array {
    return this.#key.publicKey;
  }

  /**
   * The paired devices.
   *
   * @sideEffects none
   * @returns A copy of the list.
   */
  get devices(): Device[] {
    return this.#devices.map((device) => ({ ...device }));
  }

  /**
   * The current pairing's state, if any.
   *
   * @sideEffects none
   * @returns The state, or null.
   */
  get pairingState(): PairingState | null {
    return this.#pairing?.state ?? null;
  }

  /**
   * How many phones were turned away from the current pairing because another was confirming.
   *
   * @sideEffects none
   * @returns The count.
   */
  get refusedCount(): number {
    return this.#pairing?.refused ?? 0;
  }

  /**
   * Opens the control connection and waits until the relay accepted it.
   *
   * @sideEffects Connects to the relay.
   * @returns When connected.
   */
  async start(): Promise<void> {
    const socket = new WebSocket(`${this.#options.relayUrl}/v1/host`);
    this.#control = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => {
        socket.send(JSON.stringify({ v: 1, type: "hello", hostId: this.hostId, token: this.#options.token }));
        resolve();
      });
      socket.once("error", reject);
    });
    socket.on("message", (data) => this.#onControl(data));
    socket.on("close", (code) => {
      if (!this.#closing) this.#log(`relay closed the control connection (${code})`);
    });
  }

  /**
   * Starts a pairing, replacing any earlier one.
   *
   * @sideEffects Starts the 5-minute timer; drops the earlier pairing.
   * @returns The link for the QR code.
   */
  startPairing(): { pairingId: string; link: string; expiresAt: number } {
    this.cancelPairing();
    const pairingId = `pair_${randomBytes(8).toString("hex")}`;
    const psk = new Uint8Array(randomBytes(32));
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    const timer = setTimeout(() => this.#expire(pairing), PAIRING_TTL_MS);
    const pairing: Pairing = {
      pairingId,
      psk,
      expiresAt,
      state: "available",
      request: null,
      refused: 0,
      cancelTimer: () => clearTimeout(timer),
    };
    this.#pairing = pairing;
    const query = [
      ["v", "1"],
      ["relay", this.#options.publicRelayUrl ?? this.#options.relayUrl],
      ["host", this.hostId],
      ["key", toBase64Url(this.#key.publicKey)],
      ["pairing", pairingId],
      ["psk", toBase64Url(psk)],
      ["name", this.hostName],
    ]
      .map(([name, value]) => `${name}=${encodeURIComponent(value as string)}`)
      .join("&");
    this.#setPairing(pairing, "available");
    return { pairingId, link: `atrium://pair?${query}`, expiresAt };
  }

  /**
   * Cancels the current pairing (desktop "取消").
   *
   * @sideEffects Closes a waiting phone's channel; drops the pairing.
   */
  cancelPairing(): void {
    const pairing = this.#pairing;
    if (pairing === null) return;
    if (pairing.state === "available" || pairing.state === "awaiting_confirmation") this.#reject(pairing, "cancelled");
    this.#pairing = null;
  }

  /**
   * The user's answer on the Mac (`confirm_pairing`).
   *
   * @sideEffects Writes the device list; sends `paired` or `pair_rejected`.
   * @param pairingId - Which pairing.
   * @param accept - Yes or no.
   * @returns Whether there was such a pairing waiting for an answer.
   */
  confirmPairing(pairingId: string, accept: boolean): boolean {
    const pairing = this.#pairing;
    if (pairing?.pairingId !== pairingId || pairing.state !== "awaiting_confirmation" || pairing.request === null) {
      return false;
    }
    if (!accept) {
      this.#reject(pairing, "rejected");
      return true;
    }
    const { request } = pairing;
    const publicKey = toBase64Url(request.publicKey);
    // A phone that pairs again is known by its key and keeps its deviceId (SPEC-0005, "换 relay").
    const existing = this.#devices.find((device) => device.publicKey === publicKey);
    const device: Device = {
      deviceId: existing?.deviceId ?? `dev_${randomBytes(8).toString("hex")}`,
      name: request.deviceName,
      model: request.model,
      publicKey,
      pairedAt: Date.now(),
    };
    try {
      if (existing !== undefined) this.#devices.splice(this.#devices.indexOf(existing), 1);
      this.#devices.push(device);
      this.#blocked.delete(device.deviceId);
      this.#save();
    } catch {
      this.#reject(pairing, "host_error");
      return true;
    }
    pairing.cancelTimer();
    this.#setPairing(pairing, "committed");
    request.connection.becomeSession(device.deviceId);
    request.connection.channel?.sendControl({ kind: "paired", deviceId: device.deviceId, hostName: this.hostName });
    return true;
  }

  /**
   * Revokes a device: blocks it in memory, tells and closes its channels, then saves.
   *
   * @sideEffects Closes channels; writes the device list.
   * @param deviceId - The device.
   * @returns Whether it existed.
   */
  revoke(deviceId: string): boolean {
    const index = this.#devices.findIndex((device) => device.deviceId === deviceId);
    if (index === -1) return false;
    this.#blocked.add(deviceId);
    for (const connection of this.#connections) {
      if (connection.deviceId === deviceId) {
        connection.channel?.sendControl({ kind: "revoked" });
        connection.close("revoked");
      }
    }
    this.#devices.splice(index, 1);
    this.#save();
    return true;
  }

  /**
   * Closes everything.
   *
   * @sideEffects Closes sockets and timers.
   * @returns When the control connection is closed.
   */
  async close(): Promise<void> {
    this.#closing = true;
    this.cancelPairing();
    for (const connection of this.#connections) connection.close("host_closing");
    const control = this.#control;
    if (control !== null && control.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        control.once("close", () => resolve());
        control.close();
      });
    }
  }

  /**
   * A control message from the relay: only `open` matters.
   *
   * @sideEffects Opens a data connection or refuses the stream.
   * @param data - The frame.
   */
  #onControl(data: RawData): void {
    let message: { type?: unknown; streamId?: unknown };
    try {
      message = JSON.parse(String(data)) as typeof message;
    } catch {
      return;
    }
    if (message.type !== "open" || typeof message.streamId !== "string") return;
    const pending = [...this.#connections].filter((connection) => connection.channel === null).length;
    if (pending >= MAX_PENDING_HANDSHAKES) {
      this.#control?.send(JSON.stringify({ type: "refuse", streamId: message.streamId }));
      return;
    }
    this.#connections.add(new Connection(this, message.streamId));
  }

  /**
   * Handshake message 1 for a pairing (IKpsk2): checks it and answers `{ ok }`.
   *
   * @sideEffects Writes message 2; may close the connection. Does not change the pairing state.
   * @param connection - The stream.
   * @param message1 - Handshake message 1.
   */
  respondToPairing(connection: Connection, message1: Uint8Array): void {
    const pairing = this.#pairing;
    // The PSK is only mixed in at the end of message 2, so message 1 can be read with any PSK;
    // but a phone with another pairing's PSK cannot read our answer, so we just close.
    const handshake = HandshakeState.responder({
      pattern: "IKpsk2",
      prologue: prologue(this.hostId),
      staticKey: this.#key,
      psk: pairing?.psk ?? new Uint8Array(randomBytes(32)),
    });
    const payload = readJson(handshake.readMessage(message1));
    if (pairing === null || payload.kind !== "pair" || payload.pairingId !== pairing.pairingId) {
      connection.close("pairing_not_found");
      return;
    }
    let answer: Record<string, unknown> = { ok: true };
    if (payload.protocolVersion !== PROTOCOL_VERSION) {
      answer = { ok: false, reason: "version_mismatch", hostProtocol: PROTOCOL_VERSION };
    } else if (pairing.state === "expired" || Date.now() > pairing.expiresAt) {
      answer = { ok: false, reason: "pairing_expired" };
    } else if (pairing.state !== "available") {
      answer = { ok: false, reason: "pairing_busy" };
    }
    connection.finishHandshake(handshake, answer, {
      deviceName: typeof payload.deviceName === "string" ? payload.deviceName.slice(0, 64) : "iPhone",
      model: typeof payload.model === "string" ? payload.model.slice(0, 64) : "",
      pairingId: pairing.pairingId,
    });
  }

  /**
   * Handshake message 1 of a daily connection (IK): looks the phone up by its key.
   *
   * @sideEffects Writes message 2; may close the connection.
   * @param connection - The stream.
   * @param message1 - Handshake message 1.
   */
  respondToConnect(connection: Connection, message1: Uint8Array): void {
    const handshake = HandshakeState.responder({
      pattern: "IK",
      prologue: prologue(this.hostId),
      staticKey: this.#key,
    });
    const payload = readJson(handshake.readMessage(message1));
    const publicKey = toBase64Url(handshake.remoteStatic as Uint8Array);
    const device = this.#devices.find((one) => one.publicKey === publicKey && !this.#blocked.has(one.deviceId));
    let answer: Record<string, unknown>;
    if (payload.kind !== "connect") answer = { ok: false, reason: "bad_request" };
    else if (device === undefined) answer = { ok: false, reason: "device_unknown" };
    else if (payload.protocolVersion !== PROTOCOL_VERSION) {
      answer = { ok: false, reason: "version_mismatch", hostProtocol: PROTOCOL_VERSION };
    } else answer = { ok: true, deviceId: device.deviceId };
    connection.finishHandshake(handshake, answer, null);
    if (device !== undefined && answer.ok === true) {
      this.#limitChannels(device.deviceId, connection);
      connection.becomeSession(device.deviceId);
    }
  }

  /**
   * The phone's key confirmation (`pair_confirm`): the atomic `available → awaiting_confirmation`.
   *
   * @sideEffects Moves the pairing; emits `pairing_request`; or refuses with `pairing_busy`.
   * @param connection - The channel it came on.
   * @param info - Name and model from message 1.
   */
  onPairConfirm(connection: Connection, info: { deviceName: string; model: string; pairingId: string }): void {
    const pairing = this.#pairing;
    const channel = connection.channel as SecureChannel;
    if (pairing?.pairingId !== info.pairingId || pairing.state !== "available" || Date.now() > pairing.expiresAt) {
      if (pairing?.pairingId === info.pairingId) pairing.refused += 1;
      channel.sendControl({ kind: "pair_rejected", reason: "pairing_busy" });
      connection.close("pairing_busy");
      return;
    }
    const request = {
      pairingId: pairing.pairingId,
      deviceName: info.deviceName,
      model: info.model,
      sas: sas(channel.handshakeHash),
    };
    pairing.request = { ...request, publicKey: channel.remoteStatic, connection };
    pairing.cancelTimer();
    const timer = setTimeout(() => this.#reject(pairing, "timeout"), CONFIRM_TIMEOUT_MS);
    pairing.cancelTimer = () => clearTimeout(timer);
    this.#setPairing(pairing, "awaiting_confirmation");
    this.emit("pairing_request", request);
  }

  /**
   * A connection went away.
   *
   * @sideEffects Rejects a pairing that was waiting on it.
   * @param connection - The connection.
   */
  onConnectionClosed(connection: Connection): void {
    this.#connections.delete(connection);
    const pairing = this.#pairing;
    if (pairing?.state === "awaiting_confirmation" && pairing.request?.connection === connection) {
      this.#reject(pairing, "disconnected");
    }
  }

  /**
   * The relay URL and credentials a connection needs for its data connection.
   *
   * @sideEffects none
   * @returns URL, hostId and token.
   */
  get relay(): { url: string; hostId: string; token: string } {
    return { url: this.#options.relayUrl, hostId: this.hostId, token: this.#options.token };
  }

  /**
   * Logs a line.
   *
   * @sideEffects Logs.
   * @param line - The line.
   */
  log(line: string): void {
    this.#log(line);
  }

  /**
   * Keeps at most two channels per device, closing the oldest.
   *
   * @sideEffects May close connections.
   * @param deviceId - The device.
   * @param newest - The connection being added.
   */
  #limitChannels(deviceId: string, newest: Connection): void {
    const existing = [...this.#connections].filter((one) => one !== newest && one.deviceId === deviceId);
    while (existing.length >= MAX_CHANNELS_PER_DEVICE) existing.shift()?.close("replaced");
  }

  /**
   * Ends a pairing as rejected, telling a waiting phone.
   *
   * @sideEffects Sends `pair_rejected`; closes the phone's connection; stops timers.
   * @param pairing - The pairing.
   * @param reason - Why.
   */
  #reject(pairing: Pairing, reason: string): void {
    if (pairing.state !== "available" && pairing.state !== "awaiting_confirmation") return;
    pairing.cancelTimer();
    const connection = pairing.request?.connection;
    this.#setPairing(pairing, "rejected", reason);
    if (connection !== undefined && !connection.closed) {
      connection.channel?.sendControl({ kind: "pair_rejected", reason });
      connection.close(`pairing_${reason}`);
    }
  }

  /**
   * Ends an unused pairing after 5 minutes.
   *
   * @sideEffects Moves the pairing to `expired`.
   * @param pairing - The pairing.
   */
  #expire(pairing: Pairing): void {
    if (pairing.state === "available") this.#setPairing(pairing, "expired");
  }

  /**
   * Moves a pairing and reports it.
   *
   * @sideEffects Emits `pairing_state`; logs.
   * @param pairing - The pairing.
   * @param state - The new state.
   * @param reason - Why, if it ended.
   */
  #setPairing(pairing: Pairing, state: PairingState, reason = ""): void {
    pairing.state = state;
    this.#log(`pairing ${pairing.pairingId}: ${state}${reason === "" ? "" : ` (${reason})`}`);
    this.emit("pairing_state", state, reason);
  }

  /**
   * Reads the state file, or makes a new key.
   *
   * @sideEffects Reads the file.
   * @returns The state.
   */
  #load(): HostState {
    const path = this.#options.statePath;
    if (path !== null && existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as HostState;
    return { secretKey: toBase64Url(generateKeyPair().secretKey), devices: [] };
  }

  /**
   * Writes the state file (the spike's stand-in for the vault).
   *
   * @sideEffects Writes the file, 0600.
   */
  #save(): void {
    const path = this.#options.statePath;
    if (path === null) return;
    mkdirSync(dirname(path), { recursive: true });
    const state: HostState = { secretKey: toBase64Url(this.#key.secretKey), devices: this.#devices };
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }
}

/**
 * Parses a handshake payload as a JSON object.
 *
 * @sideEffects none
 * @param bytes - UTF-8 JSON.
 * @returns The object, or an empty one when it is not an object.
 */
function readJson(bytes: Uint8Array): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fromUtf8(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * One phone's stream on the host: the data connection, the handshake, then the channel.
 *
 * @remarks
 * Phases: waiting for the first frame → (pairing) waiting for `pair_confirm` → session (waiting
 * for `hello`, then commands).
 */
class Connection {
  readonly #host: FakeHost;
  readonly #socket: WebSocket;
  readonly #streamId: string;
  channel: SecureChannel | null = null;
  deviceId: string | null = null;
  closed = false;
  #pairInfo: { deviceName: string; model: string; pairingId: string } | null = null;
  #confirmed = false;
  #helloDone = false;
  #handshakeTimer: ReturnType<typeof setTimeout>;

  /**
   * Opens the data connection for a stream.
   *
   * @sideEffects Connects to the relay; starts the 10-second handshake timer.
   * @param host - The host.
   * @param streamId - From the relay's `open`.
   */
  constructor(host: FakeHost, streamId: string) {
    this.#host = host;
    this.#streamId = streamId;
    const { url, hostId, token } = host.relay;
    this.#socket = new WebSocket(`${url}/v1/host/stream`);
    this.#socket.binaryType = "nodebuffer";
    this.#socket.on("open", () => this.#socket.send(JSON.stringify({ v: 1, type: "hello", hostId, token, streamId })));
    this.#socket.on("message", (data, isBinary) => this.#onFrame(data as Buffer, isBinary));
    this.#socket.on("close", () => this.close("socket_closed"));
    this.#socket.on("error", () => this.close("socket_error"));
    this.#handshakeTimer = setTimeout(() => this.close("handshake_timeout"), HANDSHAKE_TIMEOUT_MS);
  }

  /**
   * Writes handshake message 2 and, when the answer is `ok`, sets up the channel.
   *
   * @sideEffects Sends; closes on `ok: false`.
   * @param handshake - After reading message 1.
   * @param answer - The message 2 payload.
   * @param pairInfo - Name and model when this is a pairing; null for IK.
   */
  finishHandshake(
    handshake: HandshakeState,
    answer: Record<string, unknown>,
    pairInfo: { deviceName: string; model: string; pairingId: string } | null,
  ): void {
    this.#socket.send(handshake.writeMessage(utf8(JSON.stringify(answer))));
    clearTimeout(this.#handshakeTimer);
    if (answer.ok !== true) {
      this.close(String(answer.reason));
      return;
    }
    this.#pairInfo = pairInfo;
    this.channel = new SecureChannel(handshake.finish(), {
      write: (bytes) => this.#socket.send(bytes),
      sendLimit: HOST_TO_PHONE_LIMIT,
      receiveLimit: PHONE_TO_HOST_LIMIT,
      onReceive: (received) => this.#onReceive(received),
      onClose: (reason) => this.close(reason),
    });
  }

  /**
   * Marks the channel as belonging to a device, ready for `hello`.
   *
   * @sideEffects none
   * @param deviceId - The device.
   */
  becomeSession(deviceId: string): void {
    this.deviceId = deviceId;
    this.#pairInfo = null;
    this.#host.emit("device_connected", deviceId);
  }

  /**
   * Closes the channel and the data connection.
   *
   * @sideEffects Closes the socket; tells the host.
   * @param reason - For the log.
   */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.#handshakeTimer);
    this.channel?.close(reason);
    if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING) {
      this.#socket.close(1000);
    }
    this.#host.log(`stream ${this.#streamId.slice(0, 8)} closed: ${reason}`);
    this.#host.onConnectionClosed(this);
  }

  /**
   * One binary frame from the phone.
   *
   * @sideEffects Runs the handshake or feeds the channel.
   * @param data - The frame.
   * @param isBinary - Text frames close the stream.
   */
  #onFrame(data: Buffer, isBinary: boolean): void {
    if (this.closed) return;
    if (!isBinary) {
      this.close("text_frame");
      return;
    }
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.length);
    if (this.channel !== null) {
      this.channel.receive(bytes);
      return;
    }
    let pattern: Pattern;
    let message: Uint8Array;
    try {
      ({ pattern, message } = parseFirstFrame(bytes));
      if (pattern === "IKpsk2") this.#host.respondToPairing(this, message);
      else this.#host.respondToConnect(this, message);
    } catch (error) {
      this.close((error as { reason?: string }).reason ?? "handshake_failed");
    }
  }

  /**
   * What came over the channel.
   *
   * @sideEffects Answers `pair_confirm`, `hello` and `ping`; closes on anything out of place.
   * @param received - The frame or message.
   */
  #onReceive(received: Received): void {
    if (received.kind === "ping" || received.kind === "pong") return;
    if (this.#pairInfo !== null) {
      // Before `paired` the only thing a pairing phone may send is the key confirmation, once.
      if (!this.#confirmed && received.kind === "control" && received.value.kind === "pair_confirm") {
        this.#confirmed = true;
        this.#host.onPairConfirm(this, this.#pairInfo);
      } else {
        this.close("unexpected_frame");
      }
      return;
    }
    if (this.deviceId === null || received.kind !== "message") {
      this.close("unexpected_frame");
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(received.text) as Record<string, unknown>;
    } catch {
      this.close("bad_json");
      return;
    }
    if (!this.#helloDone) {
      // SPEC-0005 "日常连接" 3: no token, and clientId must be the deviceId.
      if (message.type !== "hello" || "token" in message || message.clientId !== this.deviceId) {
        this.close("bad_handshake");
        return;
      }
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        this.close("version_mismatch");
        return;
      }
      this.#helloDone = true;
      this.channel?.sendMessage(
        JSON.stringify({
          type: "welcome",
          protocolVersion: PROTOCOL_VERSION,
          hostVersion: "0.0.0-mp0-spike",
          hostInstanceId: "spike",
          heartbeatMs: 10_000,
          installSeed: 1,
          logDir: "/tmp/atrium-mp0-spike",
        }),
      );
      this.#host.emit("device_hello", this.deviceId);
      return;
    }
    const requestId = typeof message.requestId === "string" ? message.requestId : null;
    const response =
      message.type === "ping"
        ? { type: "response", requestId, ok: true }
        : { type: "response", requestId, ok: false, error: { code: "unknown_command" } };
    this.channel?.sendMessage(JSON.stringify(response));
  }
}

/**
 * Splits an `atrium-relay://<hostId>:<token>@<host:port>` line.
 *
 * @remarks
 * The spike speaks plain `ws://`; the real relay sits behind Caddy on `wss://`.
 *
 * @sideEffects none
 * @param line - The line.
 * @returns The ws URL, hostId and token.
 */
export function parseRelayLine(line: string): { relayUrl: string; hostId: string; token: string } {
  const match = /^atrium-relay:\/\/([^:@]+):([^@]+)@(.+)$/.exec(line);
  if (match === null) throw new Error("expected atrium-relay://<hostId>:<token>@<host:port>");
  return { hostId: match[1] as string, token: match[2] as string, relayUrl: `ws://${match[3] as string}` };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      relay: { type: "string" },
      "local-relay": { type: "string" },
      "public-relay": { type: "string" },
      state: { type: "string", default: new URL(".state/host.json", import.meta.url).pathname },
      pair: { type: "boolean", default: false },
      "auto-confirm": { type: "boolean", default: false },
      name: { type: "string" },
    },
  });
  let relayLine = values.relay;
  if (values["local-relay"] !== undefined) {
    const hostId = `hst_${randomBytes(8).toString("hex")}`;
    const token = randomBytes(32).toString("base64url");
    const statePath = new URL(".state/relay.json", import.meta.url).pathname;
    const saved = existsSync(statePath)
      ? (JSON.parse(readFileSync(statePath, "utf8")) as { hostId: string; token: string })
      : null;
    const host = saved ?? { hostId, token };
    if (saved === null) {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, `${JSON.stringify(host, null, 2)}\n`, { mode: 0o600 });
    }
    const relay = await startRelay({
      port: Number(values["local-relay"]),
      hosts: new Map([[host.hostId, host.token]]),
      log: () => {},
    });
    console.log(`relay listening on 0.0.0.0:${relay.port}`);
    relayLine = `atrium-relay://${host.hostId}:${host.token}@127.0.0.1:${relay.port}`;
    const lan = lanAddresses()[0];
    if (values["public-relay"] === undefined && lan !== undefined) values["public-relay"] = `ws://${lan}:${relay.port}`;
  }
  if (relayLine === undefined) throw new Error("pass --relay atrium-relay://… or --local-relay <port>");
  const { relayUrl, hostId, token } = parseRelayLine(relayLine);
  const host = new FakeHost({
    relayUrl,
    hostId,
    token,
    statePath: values.state,
    ...(values["public-relay"] === undefined ? {} : { publicRelayUrl: values["public-relay"] }),
    ...(values.name === undefined ? {} : { hostName: values.name }),
  });
  await host.start();
  console.log(`host ${hostId} online via ${relayUrl}; key ${toBase64Url(host.publicKey)}`);
  const showPairing = () => {
    const { link, expiresAt } = host.startPairing();
    console.log(renderUnicodeCompact(link));
    console.log(link);
    console.log(`valid until ${new Date(expiresAt).toLocaleTimeString()}`);
  };
  let waiting: string | null = null;
  host.on("pairing_request", (request) => {
    console.log(
      `\n${request.deviceName} (${request.model}) 请求配对 · 校验码 ${request.sas.slice(0, 3)} ${request.sas.slice(3)}`,
    );
    if (values["auto-confirm"]) host.confirmPairing(request.pairingId, true);
    else {
      waiting = request.pairingId;
      console.log("确认? [y/n]");
    }
  });
  host.on("device_hello", (deviceId) => console.log(`${deviceId}: hello → welcome`));
  if (values.pair) showPairing();
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const [command, argument] = line.trim().split(/\s+/);
    if ((command === "y" || command === "n") && waiting !== null) {
      host.confirmPairing(waiting, command === "y");
      waiting = null;
    } else if (command === "pair") showPairing();
    else if (command === "devices")
      console.table(host.devices.map(({ deviceId, name, model }) => ({ deviceId, name, model })));
    else if (command === "revoke" && argument !== undefined)
      console.log(host.revoke(argument) ? "revoked" : "no such device");
    else if (command === "quit") {
      input.close();
      void host.close().then(() => process.exit(0));
    } else console.log("commands: pair, y, n, devices, revoke <deviceId>, quit");
  });
}
