import { FakeClock } from "@atrium/testkit";
import { randomBytes } from "node:crypto";
import { connect as connectTcp, type Socket } from "node:net";
import { type ClientOptions, WebSocket } from "ws";
import type { RelayConfig } from "../src/config";
import { type HostRecord, hashToken, newCredentials } from "../src/hosts";
import { type Relay, type RelayEvent, type RelayLimits, startRelay } from "../src/relay";
import { ResourceTracker } from "../src/resources";

/** One message a peer received. */
export interface Received {
  readonly data: Buffer;
  readonly binary: boolean;
}

/** How a peer's connection ended. */
export interface Closed {
  readonly code: number;
  readonly reason: string;
}

/**
 * A real `ws` client with its messages queued and its close as a promise.
 *
 * @remarks
 * The relay tests talk to a real relay over loopback (SPEC-0005, "验证 · relay"); this keeps each
 * test to "send, then await the next message or the close" without listeners in the test body.
 *
 * @sideEffects Opens a WebSocket; holds received messages.
 */
export class Peer {
  readonly socket: WebSocket;
  /** Resolves once open; rejects when the upgrade is refused. */
  readonly opened: Promise<void>;
  /** Resolves when the connection ends, however it ends. */
  readonly closed: Promise<Closed>;
  readonly #queue: Received[] = [];
  readonly #waiting: Array<(message: Received) => void> = [];

  /**
   * Connects to `url`.
   *
   * @remarks
   * `opened` is handled here too, so a refused upgrade that a test does not await is not an
   * unhandled rejection.
   *
   * @sideEffects Opens a connection.
   * @param url - The WebSocket address.
   * @param options - `ws` client options, such as headers or `autoPong`.
   */
  constructor(url: string, options: ClientOptions = {}) {
    this.socket = new WebSocket(url, { perMessageDeflate: false, ...options });
    this.opened = new Promise<void>((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("unexpected-response", (_request, response) => {
        reject(new Error(`upgrade refused: ${response.statusCode ?? 0}`));
        this.socket.terminate();
      });
      this.socket.once("error", reject);
    });
    this.opened.catch(() => {});
    this.socket.on("error", () => {});
    this.closed = new Promise<Closed>((resolve) => {
      this.socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
    });
    this.socket.on("message", (data, binary) => {
      const message = { data: Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer), binary };
      const waiter = this.#waiting.shift();
      if (waiter === undefined) this.#queue.push(message);
      else waiter(message);
    });
  }

  /**
   * The next message, waiting for it if none is queued.
   *
   * @remarks
   * Messages come in the order the socket received them.
   *
   * @sideEffects Takes a message off the queue.
   * @returns The message.
   */
  async next(): Promise<Received> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return queued;
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  /**
   * The next message, parsed as JSON text.
   *
   * @remarks
   * For the relay's control messages.
   *
   * @sideEffects Takes a message off the queue.
   * @returns The parsed value.
   */
  async json(): Promise<Record<string, unknown>> {
    const message = await this.next();
    return JSON.parse(message.data.toString("utf8")) as Record<string, unknown>;
  }

  /**
   * How many messages are queued, not yet taken.
   *
   * @remarks
   * To assert that nothing else arrived.
   *
   * @sideEffects none
   * @returns The count.
   */
  get queued(): number {
    return this.#queue.length;
  }

  /**
   * Sends a value as a JSON text frame.
   *
   * @remarks
   * Hosts speak JSON on the control connection and in `hello`.
   *
   * @sideEffects Sends.
   * @param value - The value.
   */
  sendJson(value: unknown): void {
    this.socket.send(JSON.stringify(value));
  }

  /**
   * Waits until the relay has handled everything this peer sent so far.
   *
   * @remarks
   * The relay answers pings in order with the frames before them, so its pong means the earlier
   * frames, and pongs, were read. Resolves as well when the connection ends instead.
   *
   * @sideEffects Sends a ping.
   * @returns Once the pong is back.
   */
  async roundTrip(): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    await Promise.race([
      new Promise<void>((resolve) => {
        this.socket.once("pong", () => resolve());
        this.socket.ping();
      }),
      this.closed,
    ]);
  }
}

/**
 * A phone that completes the WebSocket upgrade and then never reads.
 *
 * @remarks
 * A paused raw TCP socket: what the relay sends piles up in its own buffers, which is how a slow
 * phone on a bad network looks to it (SPEC-0005, "读得慢的手机").
 *
 * @sideEffects Opens a TCP connection.
 * @param port - The relay's port.
 * @param path - Path and query of the phone entry point.
 * @returns The socket once upgraded and paused.
 */
export async function slowPhone(port: number, path: string): Promise<Socket> {
  const socket = connectTcp(port, "127.0.0.1");
  socket.on("error", () => {});
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
  );
  let head = "";
  await new Promise<void>((resolve) => {
    /**
     * Collects the response head, then stops reading for good.
     *
     * @remarks
     * Pausing right after the 101 is what makes this phone slow.
     *
     * @sideEffects Pauses the socket.
     * @param chunk - Received bytes.
     */
    const onData = (chunk: Buffer): void => {
      head += chunk.toString("latin1");
      if (head.includes("\r\n\r\n")) {
        socket.off("data", onData);
        socket.pause();
        resolve();
      }
    };
    socket.on("data", onData);
  });
  return socket;
}

/** A relay started for one test, with what the test needs to talk to it. */
export interface TestRelay {
  readonly relay: Relay;
  readonly clock: FakeClock;
  readonly resources: ResourceTracker;
  readonly events: RelayEvent[];
  readonly port: number;
  /** `ws://127.0.0.1:<port><prefix>`. */
  readonly base: string;
  readonly prefix: string;
  /** A host the relay knows. */
  readonly host: { readonly hostId: string; readonly token: string; readonly record: HostRecord };
  /** Every peer opened through `peer`, closed after the test. */
  readonly peers: Peer[];
  /**
   * Opens a peer and remembers it for cleanup.
   *
   * @sideEffects Opens a connection.
   */
  peer(path: string, options?: ClientOptions): Peer;
  /**
   * Closes the peers and the relay.
   *
   * @sideEffects Closes sockets and the server.
   */
  dispose(): Promise<void>;
}

/**
 * A host record with a fresh id and token.
 *
 * @remarks
 * As `add-host` makes it.
 *
 * @sideEffects Reads the system's random source.
 * @param name - The host's name.
 * @returns The record and the token.
 */
export function newHost(name = "Mac"): { hostId: string; token: string; record: HostRecord } {
  const { hostId, token } = newCredentials();
  return {
    hostId,
    token,
    record: { hostId, name, tokenSha256: hashToken(token), createdAt: "2026-10-25T00:00:00.000Z" },
  };
}

/**
 * Starts a relay on a free loopback port with a fake clock and one known host.
 *
 * @remarks
 * The prefix is `/atrium` by default, as on the user's VPS, so every test goes through it.
 *
 * @sideEffects Listens on a port.
 * @param options - Limits and configuration to override.
 * @returns The relay and helpers.
 */
export async function startTestRelay(
  options: { limits?: Partial<RelayLimits>; config?: Partial<RelayConfig> } = {},
): Promise<TestRelay> {
  const clock = new FakeClock(1_800_000_000_000);
  const resources = new ResourceTracker();
  const events: RelayEvent[] = [];
  const host = newHost();
  const config: RelayConfig = {
    publicHost: "relay.test",
    pathPrefix: "/atrium",
    trustedProxies: [],
    newStreamsPerIpPerMinute: 30,
    ...options.config,
  };
  const relay = await startRelay({
    config,
    hosts: [host.record],
    clock,
    resources,
    log: (event) => events.push(event),
    listen: { host: "127.0.0.1", port: 0 },
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  const peers: Peer[] = [];
  const base = `ws://127.0.0.1:${relay.port}${config.pathPrefix}`;
  return {
    relay,
    clock,
    resources,
    events,
    port: relay.port,
    base,
    prefix: config.pathPrefix,
    host,
    peers,
    peer(path, peerOptions) {
      const peer = new Peer(`${base}${path}`, peerOptions);
      peers.push(peer);
      return peer;
    },
    async dispose() {
      for (const peer of peers) peer.socket.terminate();
      await Promise.all(peers.map((peer) => peer.closed));
      await relay.close();
    },
  };
}

/**
 * Brings a host online: control connection, `hello`, `ready`.
 *
 * @remarks
 * What the desktop's RelayLink will do first.
 *
 * @sideEffects Opens a connection.
 * @param relay - The relay.
 * @param host - Which host, default the relay's own.
 * @returns The control connection.
 */
export async function onlineHost(
  relay: TestRelay,
  host: { hostId: string; token: string } = relay.host,
): Promise<Peer> {
  const control = relay.peer("/v1/host");
  await control.opened;
  control.sendJson({ v: 1, type: "hello", hostId: host.hostId, token: host.token });
  const ready = await control.json();
  if (ready["type"] !== "ready") throw new Error(`expected ready, got ${JSON.stringify(ready)}`);
  return control;
}

/**
 * Connects a phone, waits for the `open` on the control connection and joins a data connection.
 *
 * @remarks
 * The whole "接线" of SPEC-0005 in one step, for tests about what comes after.
 *
 * @sideEffects Opens two connections.
 * @param relay - The relay.
 * @param control - The host's control connection.
 * @param host - Which host, default the relay's own.
 * @param phoneOptions - Client options for the phone, such as headers.
 * @returns The phone, the data connection and the stream id.
 */
export async function openStream(
  relay: TestRelay,
  control: Peer,
  host: { hostId: string; token: string } = relay.host,
  phoneOptions: ClientOptions = {},
): Promise<{ phone: Peer; data: Peer; streamId: string }> {
  const phone = relay.peer(`/v1/client?host=${host.hostId}`, phoneOptions);
  await phone.opened;
  const open = await control.json();
  const streamId = String(open["streamId"]);
  const data = relay.peer("/v1/host/stream");
  await data.opened;
  data.sendJson({ v: 1, type: "hello", hostId: host.hostId, token: host.token, streamId });
  await data.roundTrip();
  return { phone, data, streamId };
}
