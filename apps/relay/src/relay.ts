import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { clientAddress } from "./client-address";
import { type Clock, trackedTimeout } from "./clock";
import type { RelayConfig } from "./config";
import { HOST_ID, type HostRecord } from "./hosts";
import { SlidingWindowLimit } from "./rate-limit";
import type { ResourceTracker } from "./resources";

/** Close codes (SPEC-0005, "relay 的线路协议 · 关闭码"). */
export const RelayClose = {
  /** The other end of a pair closed. */
  PeerClosed: 1000,
  /** The relay is shutting down. */
  GoingAway: 1001,
  BadRequest: 4400,
  Unauthorized: 4401,
  /** The host refused the stream. */
  Refused: 4403,
  /** The host is offline (phone, reason `offline:<seconds>`), or no such stream (data connection). */
  Offline: 4404,
  Timeout: 4408,
  /** A newer control connection of the same host took over. */
  Replaced: 4409,
  TooMany: 4429,
  Overloaded: 4507,
} as const;

/** The relay's limits; the defaults are SPEC-0005's, tests shrink some to stay fast. */
export interface RelayLimits {
  readonly helloTimeoutMs: number;
  readonly dataTimeoutMs: number;
  readonly pingIntervalMs: number;
  readonly pongTimeoutMs: number;
  readonly maxFrameBytes: number;
  readonly maxStreamsPerHost: number;
  readonly maxUnauthenticated: number;
  readonly earlyFrames: number;
  readonly earlyBytes: number;
  readonly backlogBytes: number;
  readonly totalBufferBytes: number;
  /** How long `close` waits for peers to answer the close frame before cutting them off. */
  readonly shutdownGraceMs: number;
}

/** SPEC-0005, "relay 的线路协议". */
const DEFAULT_LIMITS: RelayLimits = {
  helloTimeoutMs: 5_000,
  dataTimeoutMs: 10_000,
  pingIntervalMs: 20_000,
  pongTimeoutMs: 60_000,
  maxFrameBytes: 70 * 1024,
  maxStreamsPerHost: 16,
  maxUnauthenticated: 64,
  earlyFrames: 8,
  earlyBytes: 256 * 1024,
  backlogBytes: 4 * 1024 * 1024,
  totalBufferBytes: 256 * 1024 * 1024,
  shutdownGraceMs: 2_000,
};

/** Which entry point a connection came in through. */
type Route = "control" | "data" | "phone";

/**
 * One line of the relay's log: metadata only (SPEC-0005, "relay 的线路协议 · 日志").
 *
 * @remarks
 * Typed so that no event can carry a payload, a `hello` frame, a token or a raw IP; `hostId`
 * appears only once it matches `hst_<16hex>` or names a known host.
 */
export type RelayEvent =
  | { readonly level: "info"; readonly event: "host_online"; readonly hostId: string; readonly generation: number }
  | {
      readonly level: "info";
      readonly event: "host_offline";
      readonly hostId: string;
      readonly generation: number;
      readonly reason: "closed" | "replaced" | "unresponsive" | "revoked";
    }
  | {
      readonly level: "warn";
      readonly event: "auth_failed";
      readonly route: "control" | "data";
      readonly hostId?: string;
    }
  | { readonly level: "warn"; readonly event: "connection_rejected"; readonly route: Route; readonly code: number }
  | {
      readonly level: "info";
      readonly event: "phone_rejected";
      readonly hostId?: string;
      readonly ipHash: string;
      readonly code: number;
    }
  | {
      readonly level: "info";
      readonly event: "stream_opened";
      readonly hostId: string;
      readonly streamId: string;
      readonly ipHash: string;
    }
  | { readonly level: "info"; readonly event: "stream_joined"; readonly hostId: string; readonly streamId: string }
  | {
      readonly level: "info";
      readonly event: "stream_closed";
      readonly hostId: string;
      readonly streamId: string;
      readonly code: number;
      readonly up: number;
      readonly down: number;
      readonly durationMs: number;
    };

/** What `startRelay` needs. */
export interface RelayOptions {
  readonly config: RelayConfig;
  readonly hosts: readonly HostRecord[];
  readonly clock: Clock;
  readonly resources: ResourceTracker;
  readonly log: (event: RelayEvent) => void;
  /** Address to listen on; port 0 picks a free one. */
  readonly listen: { readonly host: string; readonly port: number };
  readonly limits?: Partial<RelayLimits>;
}

/** A running relay. */
export interface Relay {
  /** The port it listens on. */
  readonly port: number;
  /**
   * Replaces the host table; hosts removed or given a new token are cut off.
   *
   * @sideEffects May close connections and streams.
   */
  updateHosts(hosts: readonly HostRecord[]): void;
  /**
   * Stops listening, closes every connection with 1001 and cancels its timers.
   *
   * @sideEffects Closes sockets and the server.
   */
  close(): Promise<void>;
}

/** What the relay keeps for a host it knows. */
interface HostEntry {
  record: HostRecord;
  tokenDigest: Buffer;
  control: WebSocket | null;
  generation: number;
  /** Unix seconds the control connection last went away; 0 if never online since start. */
  lastSeen: number;
  readonly streams: Map<string, Stream>;
}

/** One phone's connection and, once it came, the host's data connection for it. */
interface Stream {
  readonly entry: HostEntry;
  readonly streamId: string;
  readonly generation: number;
  readonly phone: WebSocket;
  readonly openedAt: number;
  data: WebSocket | null;
  early: Buffer[];
  earlyBytes: number;
  up: number;
  down: number;
  ended: boolean;
  cancelTimer: () => void;
  readonly release: () => void;
}

const helloSchema = z.object({
  v: z.literal(1),
  type: z.literal("hello"),
  hostId: z.string().max(64),
  token: z.string().max(256),
  streamId: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .optional(),
});

const refuseSchema = z.object({ type: z.literal("refuse"), streamId: z.string().max(64) });

/** Compared against when the host id is unknown, so the time taken does not tell which ids exist. */
const UNKNOWN_HOST_DIGEST = createHash("sha256").update("atrium-relay unknown host").digest();

/**
 * Raw `ws` data as one Buffer.
 *
 * @remarks
 * `ws` hands over a Buffer, an array of fragments or an ArrayBuffer depending on settings.
 *
 * @sideEffects none
 * @param data - What `ws` delivered.
 * @returns The bytes.
 */
function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

/**
 * Builds the table entry of a host record.
 *
 * @remarks
 * The stored digest is kept as bytes for `timingSafeEqual`.
 *
 * @sideEffects none
 * @param record - The record.
 * @returns A fresh, offline entry.
 */
function newEntry(record: HostRecord): HostEntry {
  return {
    record,
    tokenDigest: Buffer.from(record.tokenSha256, "hex"),
    control: null,
    generation: 0,
    lastSeen: 0,
    streams: new Map(),
  };
}

/**
 * Closes a socket if it is still open.
 *
 * @remarks
 * Ends of a pair close each other; the second close of a socket must not throw or send twice.
 *
 * @sideEffects Sends a close frame.
 * @param socket - The socket, or null.
 * @param code - Close code.
 * @param reason - Close reason.
 */
function closeSocket(socket: WebSocket | null, code: number, reason = ""): void {
  if (socket?.readyState === WebSocket.OPEN) socket.close(code, reason);
}

/**
 * Starts the relay: the three WebSocket entry points and `/healthz` under the path prefix.
 *
 * @remarks
 * SPEC-0005, "relay 的线路协议". Bytes are passed through untouched; the relay never parses what a
 * phone or a data connection sends. Every timer runs on the injected clock and is counted, and
 * every socket is counted until it closes, so the leak test can check both return to baseline
 * (testing.md, "性能与资源泄漏").
 *
 * @sideEffects Listens on a port; opens, forwards on and closes sockets; schedules timers; logs.
 * @param options - Configuration, hosts, clock, counters, log and listen address.
 * @returns The running relay.
 */
export async function startRelay(options: RelayOptions): Promise<Relay> {
  const limits: RelayLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const { clock, resources, log, config } = options;
  const prefix = config.pathPrefix;
  const salt = randomBytes(16);
  const trusted = new Set(config.trustedProxies);
  const newStreams = new SlidingWindowLimit(clock, resources, config.newStreamsPerIpPerMinute, 60_000);
  const hosts = new Map<string, HostEntry>();
  const stopPings = new Set<() => void>();
  let unauthenticated = 0;
  let closing = false;

  for (const record of options.hosts) hosts.set(record.hostId, newEntry(record));

  /**
   * Salted hash of an address, for the log and the `open` message.
   *
   * @remarks
   * The salt lives only in memory, so hashes cannot be reversed by trying addresses after a
   * restart and do not link across restarts (security.md, "relay").
   *
   * @sideEffects none
   * @param address - The address.
   * @returns 16 hex digits.
   */
  const hashAddress = (address: string): string =>
    createHash("sha256").update(salt).update(address).digest("hex").slice(0, 16);

  /**
   * Ends a stream: closes both ends, cancels its timer and forgets it.
   *
   * @remarks
   * Runs once per stream however many ways it ends at the same time.
   *
   * @sideEffects Closes sockets; releases the stream's count; logs.
   * @param stream - The stream.
   * @param phoneCode - Close code for the phone.
   * @param phoneReason - Close reason for the phone.
   * @param dataCode - Close code for the data connection.
   */
  const endStream = (stream: Stream, phoneCode: number, phoneReason: string, dataCode: number): void => {
    if (stream.ended) return;
    stream.ended = true;
    if (stream.entry.streams.get(stream.streamId) === stream) stream.entry.streams.delete(stream.streamId);
    stream.cancelTimer();
    stream.early = [];
    stream.earlyBytes = 0;
    closeSocket(stream.phone, phoneCode, phoneReason);
    closeSocket(stream.data, dataCode);
    stream.release();
    log({
      level: "info",
      event: "stream_closed",
      hostId: stream.entry.record.hostId,
      streamId: stream.streamId,
      code: phoneCode,
      up: stream.up,
      down: stream.down,
      durationMs: clock.now() - stream.openedAt,
    });
  };

  /**
   * Sends one frame on, or ends the pair when the receiver is too far behind.
   *
   * @remarks
   * `bufferedAmount` counts what `ws` and the socket hold unsent, so one slow reader is cut off
   * at 4 MiB without holding up any other phone (SPEC-0005, "上限").
   *
   * @sideEffects Sends; may end the stream.
   * @param stream - The stream.
   * @param target - The receiving socket.
   * @param bytes - The frame.
   */
  const forward = (stream: Stream, target: WebSocket, bytes: Buffer): void => {
    if (target.bufferedAmount + bytes.length > limits.backlogBytes) {
      endStream(stream, RelayClose.Overloaded, "", RelayClose.Overloaded);
      return;
    }
    target.send(bytes, { binary: true });
  };

  /**
   * Bytes the relay holds: frames waiting for a data connection, plus every pair's unsent backlog.
   *
   * @remarks
   * Checked when a phone comes, against the 256 MiB total (SPEC-0005, "上限").
   *
   * @sideEffects none
   * @returns The total.
   */
  const totalBuffered = (): number => {
    let total = 0;
    for (const entry of hosts.values()) {
      for (const stream of entry.streams.values()) {
        total += stream.earlyBytes + stream.phone.bufferedAmount + (stream.data?.bufferedAmount ?? 0);
      }
    }
    return total;
  };

  /**
   * Cuts a host off: its control connection and all its streams.
   *
   * @remarks
   * For `remove-host` and `rotate-host`. Bumping the generation makes the closing control
   * connection's own close handler a no-op, so it cannot clean up after a newer connection.
   *
   * @sideEffects Closes sockets; logs.
   * @param entry - The host.
   */
  const revoke = (entry: HostEntry): void => {
    const generation = entry.generation;
    const control = entry.control;
    entry.generation += 1;
    entry.control = null;
    if (control !== null) entry.lastSeen = Math.floor(clock.now() / 1000);
    closeSocket(control, RelayClose.Unauthorized);
    for (const stream of entry.streams.values()) {
      endStream(stream, RelayClose.Offline, `offline:${entry.lastSeen}`, RelayClose.Unauthorized);
    }
    if (control !== null) {
      log({ level: "info", event: "host_offline", hostId: entry.record.hostId, generation, reason: "revoked" });
    }
  };

  /**
   * Parses and checks a host's `hello`.
   *
   * @remarks
   * The token's digest is compared in constant time, against a fixed digest when the host is
   * unknown (SPEC-0005, "认证").
   *
   * @sideEffects none
   * @param data - The first frame.
   * @param isBinary - Whether it was binary.
   * @param route - Which entry point; `data` requires a `streamId`.
   * @returns The host and the stream id, or the host id worth logging when it failed.
   */
  const authenticate = (
    data: RawData,
    isBinary: boolean,
    route: "control" | "data",
  ): { ok: true; entry: HostEntry; streamId: string | undefined } | { ok: false; hostId: string | undefined } => {
    if (isBinary) return { ok: false, hostId: undefined };
    let json: unknown;
    try {
      json = JSON.parse(toBuffer(data).toString("utf8"));
    } catch {
      return { ok: false, hostId: undefined };
    }
    const parsed = helloSchema.safeParse(json);
    if (!parsed.success) return { ok: false, hostId: undefined };
    const hello = parsed.data;
    const loggable = HOST_ID.test(hello.hostId) ? hello.hostId : undefined;
    if (route === "data" && hello.streamId === undefined) return { ok: false, hostId: loggable };
    const entry = hosts.get(hello.hostId);
    const digest = createHash("sha256").update(hello.token, "utf8").digest();
    const matches = timingSafeEqual(entry?.tokenDigest ?? UNKNOWN_HOST_DIGEST, digest);
    if (entry === undefined || !matches) return { ok: false, hostId: loggable };
    return { ok: true, entry, streamId: hello.streamId };
  };

  /**
   * A host's control connection after its `hello`.
   *
   * @remarks
   * The newest control connection of a host wins; the one it replaces and that one's streams are
   * closed with 4409, and everything the older one's close handler does is guarded by the
   * generation, so it never touches the new one (SPEC-0005, "代数").
   *
   * @sideEffects Marks the host online; sends `ready`; pings every 20 seconds; logs.
   * @param socket - The connection.
   * @param entry - The host.
   */
  const onControl = (socket: WebSocket, entry: HostEntry): void => {
    const hostId = entry.record.hostId;
    const previous = entry.control;
    const previousGeneration = entry.generation;
    const generation = previousGeneration + 1;
    entry.generation = generation;
    entry.control = socket;
    if (previous !== null) {
      closeSocket(previous, RelayClose.Replaced);
      for (const stream of entry.streams.values()) {
        endStream(stream, RelayClose.Replaced, "", RelayClose.Replaced);
      }
      log({ level: "info", event: "host_offline", hostId, generation: previousGeneration, reason: "replaced" });
    }
    socket.send(JSON.stringify({ type: "ready" }));
    log({ level: "info", event: "host_online", hostId, generation });

    let lastPong = clock.now();
    let unresponsive = false;
    let cancelPing: (() => void) | null = null;
    /**
     * Pings, or gives up on a host that has not answered for 60 seconds.
     *
     * @remarks
     * A host behind a dead network keeps its streams open until this notices.
     *
     * @sideEffects Sends a ping or terminates the socket; schedules the next tick.
     */
    const tick = (): void => {
      if (clock.now() - lastPong >= limits.pongTimeoutMs) {
        unresponsive = true;
        socket.terminate();
        return;
      }
      socket.ping();
      cancelPing = trackedTimeout(clock, resources, tick, limits.pingIntervalMs);
    };
    cancelPing = trackedTimeout(clock, resources, tick, limits.pingIntervalMs);
    /**
     * Stops this connection's pings.
     *
     * @remarks
     * On close, and when the relay shuts down.
     *
     * @sideEffects Cancels the timer.
     */
    const stopPing = (): void => cancelPing?.();
    stopPings.add(stopPing);
    socket.on("pong", () => {
      lastPong = clock.now();
    });

    socket.on("message", (data, isBinary) => {
      if (entry.control !== socket) return;
      let refuse: z.infer<typeof refuseSchema> | null = null;
      if (!isBinary) {
        try {
          const parsed = refuseSchema.safeParse(JSON.parse(toBuffer(data).toString("utf8")));
          refuse = parsed.success ? parsed.data : null;
        } catch {
          refuse = null;
        }
      }
      if (refuse === null) {
        closeSocket(socket, RelayClose.BadRequest);
        return;
      }
      const stream = entry.streams.get(refuse.streamId);
      if (stream !== undefined) endStream(stream, RelayClose.Refused, "", RelayClose.Refused);
    });

    socket.on("close", () => {
      stopPing();
      stopPings.delete(stopPing);
      if (entry.control !== socket || entry.generation !== generation) return;
      entry.control = null;
      entry.lastSeen = Math.floor(clock.now() / 1000);
      for (const stream of entry.streams.values()) {
        endStream(stream, RelayClose.Offline, `offline:${entry.lastSeen}`, RelayClose.PeerClosed);
      }
      log({
        level: "info",
        event: "host_offline",
        hostId,
        generation,
        reason: unresponsive ? "unresponsive" : "closed",
      });
    });
  };

  /**
   * A host's data connection after its `hello`: joins it to the waiting phone.
   *
   * @remarks
   * Only a stream of the current generation that still waits can be joined; frames the phone
   * sent early go first, in order.
   *
   * @sideEffects Forwards the early frames; wires both directions; logs.
   * @param socket - The connection.
   * @param entry - The host.
   * @param streamId - Which stream.
   */
  const onData = (socket: WebSocket, entry: HostEntry, streamId: string): void => {
    const stream = entry.streams.get(streamId);
    if (
      stream === undefined ||
      stream.data !== null ||
      stream.generation !== entry.generation ||
      entry.control === null
    ) {
      closeSocket(socket, RelayClose.Offline);
      return;
    }
    stream.cancelTimer();
    stream.cancelTimer = () => {};
    stream.data = socket;
    const early = stream.early;
    stream.early = [];
    stream.earlyBytes = 0;
    for (const bytes of early) {
      if (stream.ended) break;
      forward(stream, socket, bytes);
    }
    socket.on("message", (data, isBinary) => {
      if (stream.ended) return;
      if (!isBinary) {
        endStream(stream, RelayClose.BadRequest, "", RelayClose.BadRequest);
        return;
      }
      const bytes = toBuffer(data);
      stream.down += bytes.length;
      forward(stream, stream.phone, bytes);
    });
    socket.on("close", () => endStream(stream, RelayClose.PeerClosed, "", RelayClose.PeerClosed));
    log({ level: "info", event: "stream_joined", hostId: entry.record.hostId, streamId });
  };

  /**
   * Either host entry point, until its `hello` arrives.
   *
   * @remarks
   * At most 64 such connections at once, each given 5 seconds (SPEC-0005, "上限").
   *
   * @sideEffects Schedules the hello timer; may close the socket; logs.
   * @param socket - The connection.
   * @param route - `control` or `data`.
   */
  const acceptHost = (socket: WebSocket, route: "control" | "data"): void => {
    if (unauthenticated >= limits.maxUnauthenticated) {
      closeSocket(socket, RelayClose.TooMany);
      log({ level: "warn", event: "connection_rejected", route, code: RelayClose.TooMany });
      return;
    }
    unauthenticated += 1;
    const releasePending = resources.acquire("ws.pending");
    let settled = false;
    let cancelHello: (() => void) | null = null;
    /**
     * Leaves the unauthenticated state, once.
     *
     * @remarks
     * Reached by the hello, its timeout or the socket closing first.
     *
     * @sideEffects Decrements the count; cancels the timer.
     */
    const settle = (): void => {
      if (settled) return;
      settled = true;
      unauthenticated -= 1;
      releasePending();
      cancelHello?.();
    };
    cancelHello = trackedTimeout(
      clock,
      resources,
      () => {
        settle();
        closeSocket(socket, RelayClose.Timeout);
      },
      limits.helloTimeoutMs,
    );
    socket.once("close", settle);
    socket.once("message", (data, isBinary) => {
      if (settled) return;
      settle();
      const auth = authenticate(data, isBinary, route);
      if (!auth.ok) {
        closeSocket(socket, RelayClose.Unauthorized);
        log({
          level: "warn",
          event: "auth_failed",
          route,
          ...(auth.hostId === undefined ? {} : { hostId: auth.hostId }),
        });
        return;
      }
      if (route === "control") onControl(socket, auth.entry);
      else onData(socket, auth.entry, auth.streamId ?? "");
    });
  };

  /**
   * A phone's connection: announces a new stream to its host and holds frames until the data
   * connection comes.
   *
   * @remarks
   * The per-address budget is taken last, so a phone turned away for another reason does not use
   * it up (SPEC-0005, "上限").
   *
   * @sideEffects Sends `open` on the control connection; schedules the 10-second timer; logs.
   * @param socket - The connection.
   * @param request - The upgrade request, for `?host=` and the address.
   */
  const acceptPhone = (socket: WebSocket, request: IncomingMessage): void => {
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    const hostId = url.searchParams.get("host") ?? "";
    const address = clientAddress(request.socket.remoteAddress, request.headers, trusted);
    const ipHash = hashAddress(address);
    /**
     * Turns the phone away.
     *
     * @remarks
     * One place for the close and its log line.
     *
     * @sideEffects Closes the socket; logs.
     * @param code - Close code.
     * @param reason - Close reason.
     */
    const reject = (code: number, reason = ""): void => {
      closeSocket(socket, code, reason);
      log({ level: "info", event: "phone_rejected", ...(HOST_ID.test(hostId) ? { hostId } : {}), ipHash, code });
    };
    if (!HOST_ID.test(hostId)) return reject(RelayClose.BadRequest);
    const entry = hosts.get(hostId);
    if (entry?.control == null) return reject(RelayClose.Offline, `offline:${entry?.lastSeen ?? 0}`);
    if (entry.streams.size >= limits.maxStreamsPerHost) return reject(RelayClose.TooMany);
    if (totalBuffered() > limits.totalBufferBytes) return reject(RelayClose.Overloaded);
    if (!newStreams.take(address)) return reject(RelayClose.TooMany);

    const streamId = randomBytes(16).toString("hex");
    const stream: Stream = {
      entry,
      streamId,
      generation: entry.generation,
      phone: socket,
      openedAt: clock.now(),
      data: null,
      early: [],
      earlyBytes: 0,
      up: 0,
      down: 0,
      ended: false,
      cancelTimer: () => {},
      release: resources.acquire("stream"),
    };
    stream.cancelTimer = trackedTimeout(
      clock,
      resources,
      () => endStream(stream, RelayClose.Timeout, "", RelayClose.PeerClosed),
      limits.dataTimeoutMs,
    );
    entry.streams.set(streamId, stream);
    socket.on("message", (data, isBinary) => {
      if (stream.ended) return;
      if (!isBinary) {
        endStream(stream, RelayClose.BadRequest, "", RelayClose.BadRequest);
        return;
      }
      const bytes = toBuffer(data);
      stream.up += bytes.length;
      if (stream.data !== null) {
        forward(stream, stream.data, bytes);
        return;
      }
      stream.early.push(bytes);
      stream.earlyBytes += bytes.length;
      if (stream.early.length > limits.earlyFrames || stream.earlyBytes > limits.earlyBytes) {
        endStream(stream, RelayClose.Overloaded, "", RelayClose.Overloaded);
      }
    });
    socket.on("close", () => endStream(stream, RelayClose.PeerClosed, "", RelayClose.PeerClosed));
    entry.control.send(JSON.stringify({ type: "open", streamId, ipHash }));
    log({ level: "info", event: "stream_opened", hostId, streamId, ipHash });
  };

  /**
   * Which entry point a path is, under the prefix.
   *
   * @remarks
   * Exact matches only; anything else under or outside the prefix is a 404 (SPEC-0005).
   *
   * @sideEffects none
   * @param request - The request.
   * @returns The route, `healthz`, or null.
   */
  const routeOf = (request: IncomingMessage): Route | "healthz" | null => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://relay.invalid").pathname;
    } catch {
      return null;
    }
    switch (pathname) {
      case `${prefix}/v1/host`:
        return "control";
      case `${prefix}/v1/host/stream`:
        return "data";
      case `${prefix}/v1/client`:
        return "phone";
      case `${prefix}/healthz`:
        return "healthz";
      default:
        return null;
    }
  };

  const server = createServer((request, response) => {
    if (request.method === "GET" && routeOf(request) === "healthz") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end("ok\n");
    } else {
      response.writeHead(404).end();
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxFrameBytes, perMessageDeflate: false });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => {});
    const route = routeOf(request);
    if (closing || route === null || route === "healthz") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      // `ws` reports bad frames as an error before closing; the close does the cleanup.
      ws.on("error", () => {});
      ws.once("close", resources.acquire(route === "phone" ? "ws.phone" : "ws.host"));
      if (route === "phone") acceptPhone(ws, request);
      else acceptHost(ws, route);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.listen.port, options.listen.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const bound: AddressInfo | string | null = server.address();
  // Stryker disable next-line all: a TCP listener always reports an AddressInfo; this only narrows the type.
  if (bound === null || typeof bound === "string") throw new Error("relay is not bound to a TCP port");

  return {
    port: bound.port,
    updateHosts(records) {
      const next = new Map(records.map((record) => [record.hostId, record]));
      for (const [hostId, entry] of hosts) {
        const record = next.get(hostId);
        if (record === undefined) {
          revoke(entry);
          hosts.delete(hostId);
        } else if (record.tokenSha256 !== entry.record.tokenSha256) {
          revoke(entry);
          entry.record = record;
          entry.tokenDigest = Buffer.from(record.tokenSha256, "hex");
        } else {
          entry.record = record;
        }
      }
      for (const [hostId, record] of next) if (!hosts.has(hostId)) hosts.set(hostId, newEntry(record));
    },
    async close() {
      closing = true;
      for (const stopPing of stopPings) stopPing();
      stopPings.clear();
      newStreams.clear();
      for (const entry of hosts.values()) {
        for (const stream of entry.streams.values()) {
          endStream(stream, RelayClose.GoingAway, "", RelayClose.GoingAway);
        }
      }
      const clients = [...wss.clients];
      const allClosed = Promise.all(
        clients.map(
          (client) =>
            new Promise<void>((resolve) => {
              if (client.readyState === WebSocket.CLOSED) resolve();
              else client.once("close", () => resolve());
            }),
        ),
      );
      for (const client of clients) closeSocket(client, RelayClose.GoingAway);
      const cancelGrace = trackedTimeout(
        clock,
        resources,
        () => {
          for (const client of clients) client.terminate();
        },
        limits.shutdownGraceMs,
      );
      await allClosed;
      cancelGrace();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
