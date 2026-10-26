/**
 * A minimal relay for the MP0 spike (SPEC-0005, "relay 的线路协议"): one control connection per
 * host, one data connection per phone, bytes passed through untouched.
 *
 * Enough to run the handshake end to end on a laptop, a simulator or a phone on the same Wi-Fi.
 * Not done here (MP2): per-IP rate limits, the global caps on unauthenticated connections and
 * buffers, `add-host` / `rotate-host`, log rotation.
 *
 * Run: `node relay.ts [--port 8787] [--host <hostId>:<token>]`. Without `--host` it keeps one
 * host in `.state/relay.json` and prints its `atrium-relay://` line.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { type RawData, WebSocket, WebSocketServer } from "ws";

/** Close codes the relay uses (SPEC-0005 names 4401, 4404, 4408, 4507; the rest are the spike's). */
export const RelayClose = {
  BadRequest: 4400,
  Unauthorized: 4401,
  /** The host refused the stream (`refuse`). */
  Refused: 4403,
  /** The host is offline; the reason is `offline:<last seen, Unix seconds>`. */
  Offline: 4404,
  /** A host's `hello` or its data connection did not arrive in time. */
  Timeout: 4408,
  /** A newer control connection of the same host took over. */
  Replaced: 4409,
  /** The host already has 16 streams. */
  TooManyStreams: 4429,
  /** A direction's backlog, or the pre-connection buffer, ran over. */
  Overloaded: 4507,
} as const;

const HELLO_TIMEOUT_MS = 5_000;
const DATA_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 60_000;
const MAX_FRAME = 70 * 1024;
const MAX_STREAMS_PER_HOST = 16;
const MAX_EARLY_FRAMES = 8;
const MAX_EARLY_BYTES = 256 * 1024;
const MAX_BACKLOG = 4 * 1024 * 1024;

/** One line of the relay's log: metadata only, never payloads or `hello` frames. */
export type RelayLog = Record<string, string | number>;

/** Options of `startRelay`. */
export interface RelayOptions {
  /** 0 picks a free port. */
  readonly port: number;
  /** Interface to listen on; `0.0.0.0` so simulators and phones on the Wi-Fi reach it. */
  readonly listen?: string;
  /** Tokens by hostId. */
  readonly hosts: ReadonlyMap<string, string>;
  readonly log?: (entry: RelayLog) => void;
}

/** A running relay. */
export interface Relay {
  readonly port: number;
  /**
   * Closes every connection and the listener.
   *
   * @sideEffects Closes sockets and the server.
   */
  close(): Promise<void>;
}

/** A phone's stream, from its connection until either side closes. */
interface Stream {
  readonly streamId: string;
  readonly phone: WebSocket;
  data: WebSocket | null;
  early: Buffer[];
  earlyBytes: number;
  cancelTimer: () => void;
}

/** What the relay keeps per host. */
interface HostEntry {
  readonly tokenHash: Buffer;
  control: WebSocket | null;
  generation: number;
  lastSeen: number;
  readonly streams: Map<string, Stream>;
}

/**
 * SHA-256 of a token.
 *
 * @sideEffects none
 * @param token - The token.
 * @returns The digest.
 */
function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/**
 * Raw `ws` data as one Buffer.
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
 * Starts the relay.
 *
 * @sideEffects Listens on a port; opens and closes sockets; logs.
 * @param options - Port, hosts and log sink.
 * @returns The running relay.
 */
export async function startRelay(options: RelayOptions): Promise<Relay> {
  const log = options.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const salt = randomBytes(16);
  const hosts = new Map<string, HostEntry>();
  for (const [hostId, token] of options.hosts) {
    hosts.set(hostId, { tokenHash: hashToken(token), control: null, generation: 0, lastSeen: 0, streams: new Map() });
  }
  const ipHash = (request: IncomingMessage) =>
    createHash("sha256")
      .update(salt)
      .update(request.socket.remoteAddress ?? "")
      .digest("hex")
      .slice(0, 16);

  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    } else {
      response.writeHead(404).end();
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });

  /**
   * Checks a host's `hello`: right shape, known host, right token (constant time).
   *
   * @sideEffects none
   * @param data - The first frame.
   * @param isBinary - Whether it was binary.
   * @param withStream - Whether a `streamId` is required.
   * @returns The host entry and the parsed hello, or null.
   */
  const authenticate = (data: RawData, isBinary: boolean, withStream: boolean) => {
    if (isBinary) return null;
    let hello: { v?: unknown; type?: unknown; hostId?: unknown; token?: unknown; streamId?: unknown };
    try {
      hello = JSON.parse(toBuffer(data).toString("utf8")) as typeof hello;
    } catch {
      return null;
    }
    if (
      hello.v !== 1 ||
      hello.type !== "hello" ||
      typeof hello.hostId !== "string" ||
      typeof hello.token !== "string"
    ) {
      return null;
    }
    if (withStream && typeof hello.streamId !== "string") return null;
    const entry = hosts.get(hello.hostId);
    if (entry === undefined || !timingSafeEqual(entry.tokenHash, hashToken(hello.token))) return null;
    return { entry, hostId: hello.hostId, streamId: hello.streamId as string };
  };

  /**
   * Ends a stream: closes both ends and forgets it.
   *
   * @sideEffects Closes sockets; logs.
   * @param hostId - Its host.
   * @param stream - The stream.
   * @param code - Close code for the phone (the data connection gets 1000).
   * @param reason - Close reason for the phone.
   */
  const endStream = (hostId: string, stream: Stream, code: number, reason = "") => {
    const entry = hosts.get(hostId);
    if (entry?.streams.get(stream.streamId) !== stream) return;
    entry.streams.delete(stream.streamId);
    stream.cancelTimer();
    if (stream.phone.readyState === WebSocket.OPEN) stream.phone.close(code, reason);
    if (stream.data !== null && stream.data.readyState === WebSocket.OPEN) stream.data.close(1000);
    log({ event: "stream_closed", hostId, streamId: stream.streamId, code });
  };

  /**
   * Forwards one binary frame, closing the pair when the receiving side is too far behind.
   *
   * @sideEffects Sends; may close the stream.
   * @param hostId - The host.
   * @param stream - The stream.
   * @param target - Where it goes.
   * @param bytes - The frame.
   */
  const forward = (hostId: string, stream: Stream, target: WebSocket, bytes: Buffer) => {
    if (target.bufferedAmount + bytes.length > MAX_BACKLOG) {
      endStream(hostId, stream, RelayClose.Overloaded);
      return;
    }
    target.send(bytes, { binary: true });
  };

  /**
   * A host's control connection.
   *
   * @sideEffects Registers the host as online; pings it; closes its streams when it goes.
   * @param socket - The connection.
   */
  const acceptControl = (socket: WebSocket) => {
    const helloTimer = setTimeout(() => socket.close(RelayClose.Timeout), HELLO_TIMEOUT_MS);
    socket.once("message", (data, isBinary) => {
      clearTimeout(helloTimer);
      const auth = authenticate(data, isBinary, false);
      if (auth === null) {
        socket.close(RelayClose.Unauthorized);
        return;
      }
      const { entry, hostId } = auth;
      const generation = ++entry.generation;
      const previous = entry.control;
      entry.control = socket;
      if (previous !== null) previous.close(RelayClose.Replaced);
      log({ event: "host_online", hostId, generation });
      let lastPong = Date.now();
      socket.on("pong", () => (lastPong = Date.now()));
      const pinger = setInterval(() => {
        if (Date.now() - lastPong > PONG_TIMEOUT_MS) socket.terminate();
        else socket.ping();
      }, PING_INTERVAL_MS);
      socket.on("message", (message, binary) => {
        if (binary) return;
        try {
          const parsed = JSON.parse(toBuffer(message).toString("utf8")) as { type?: unknown; streamId?: unknown };
          const stream = typeof parsed.streamId === "string" ? entry.streams.get(parsed.streamId) : undefined;
          if (parsed.type === "refuse" && stream !== undefined) endStream(hostId, stream, RelayClose.Refused);
        } catch {
          // Ignore what the spike does not understand.
        }
      });
      socket.on("close", () => {
        clearInterval(pinger);
        // Only clean up what belongs to this generation: a newer control connection may be live.
        if (entry.generation !== generation) return;
        entry.control = null;
        entry.lastSeen = Math.floor(Date.now() / 1000);
        for (const stream of [...entry.streams.values()])
          endStream(hostId, stream, RelayClose.Offline, `offline:${entry.lastSeen}`);
        log({ event: "host_offline", hostId, generation });
      });
    });
  };

  /**
   * A host's data connection for one stream.
   *
   * @sideEffects Joins it to the waiting phone and flushes what the phone sent early.
   * @param socket - The connection.
   */
  const acceptData = (socket: WebSocket) => {
    const helloTimer = setTimeout(() => socket.close(RelayClose.Timeout), HELLO_TIMEOUT_MS);
    socket.once("message", (data, isBinary) => {
      clearTimeout(helloTimer);
      const auth = authenticate(data, isBinary, true);
      if (auth === null) {
        socket.close(RelayClose.Unauthorized);
        return;
      }
      const { entry, hostId, streamId } = auth;
      const stream = entry.streams.get(streamId);
      if (stream === undefined || stream.data !== null) {
        socket.close(RelayClose.BadRequest);
        return;
      }
      stream.cancelTimer();
      stream.cancelTimer = () => {};
      stream.data = socket;
      for (const bytes of stream.early) forward(hostId, stream, socket, bytes);
      stream.early = [];
      socket.on("message", (message, binary) => {
        if (!binary) endStream(hostId, stream, RelayClose.BadRequest);
        else forward(hostId, stream, stream.phone, toBuffer(message));
      });
      socket.on("close", () => endStream(hostId, stream, 1000));
      log({ event: "stream_joined", hostId, streamId });
    });
  };

  /**
   * A phone's connection.
   *
   * @sideEffects Announces the stream on the host's control connection; buffers until the data connection comes.
   * @param socket - The connection.
   * @param hostId - From `?host=`.
   * @param request - The upgrade request, for the IP hash.
   */
  const acceptPhone = (socket: WebSocket, hostId: string, request: IncomingMessage) => {
    const entry = hosts.get(hostId);
    if (entry === undefined || entry.control === null) {
      socket.close(RelayClose.Offline, `offline:${entry?.lastSeen ?? 0}`);
      return;
    }
    if (entry.streams.size >= MAX_STREAMS_PER_HOST) {
      socket.close(RelayClose.TooManyStreams);
      return;
    }
    const streamId = randomBytes(16).toString("hex");
    const timer = setTimeout(() => endStream(hostId, stream, RelayClose.Timeout), DATA_TIMEOUT_MS);
    const stream: Stream = {
      streamId,
      phone: socket,
      data: null,
      early: [],
      earlyBytes: 0,
      cancelTimer: () => clearTimeout(timer),
    };
    entry.streams.set(streamId, stream);
    let bytes = 0;
    socket.on("message", (message, binary) => {
      if (!binary) {
        endStream(hostId, stream, RelayClose.BadRequest);
        return;
      }
      const buffer = toBuffer(message);
      bytes += buffer.length;
      if (stream.data !== null) {
        forward(hostId, stream, stream.data, buffer);
        return;
      }
      stream.early.push(buffer);
      stream.earlyBytes += buffer.length;
      if (stream.early.length > MAX_EARLY_FRAMES || stream.earlyBytes > MAX_EARLY_BYTES) {
        endStream(hostId, stream, RelayClose.Overloaded);
      }
    });
    socket.on("close", (code) => {
      log({ event: "phone_closed", hostId, streamId, code, bytes });
      endStream(hostId, stream, 1000);
    });
    const hash = ipHash(request);
    entry.control.send(JSON.stringify({ type: "open", streamId, ipHash: hash }));
    log({ event: "stream_opened", hostId, streamId, ipHash: hash });
  };

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://relay");
    const route =
      url.pathname === "/v1/host"
        ? "control"
        : url.pathname === "/v1/host/stream"
          ? "data"
          : url.pathname === "/v1/client"
            ? "phone"
            : null;
    if (route === null) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (route === "control") acceptControl(ws);
      else if (route === "data") acceptData(ws);
      else acceptPhone(ws, url.searchParams.get("host") ?? "", request);
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port, options.listen ?? "0.0.0.0", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;
  return {
    port,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * The IPv4 addresses a phone on the same network can use.
 *
 * @sideEffects Reads the network interfaces.
 * @returns Non-internal IPv4 addresses.
 */
export function lanAddresses(): string[] {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((address) => address !== undefined && address.family === "IPv4" && !address.internal)
    .map((address) => (address as { address: string }).address);
  return [...new Set(addresses)];
}

/**
 * Loads the spike's one host, or makes and saves it.
 *
 * @sideEffects Reads and maybe writes the file.
 * @param path - `.state/relay.json`.
 * @returns hostId and token.
 */
function loadOrCreateHost(path: string): { hostId: string; token: string } {
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as { hostId: string; token: string };
  const host = { hostId: `hst_${randomBytes(8).toString("hex")}`, token: randomBytes(32).toString("base64url") };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(host, null, 2)}\n`, { mode: 0o600 });
  return host;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { port: { type: "string", default: "8787" }, host: { type: "string", multiple: true } },
  });
  const hosts = new Map<string, string>();
  for (const pair of values.host ?? []) {
    const [hostId, token] = pair.split(":");
    if (hostId === undefined || token === undefined) throw new Error(`--host wants <hostId>:<token>, got ${pair}`);
    hosts.set(hostId, token);
  }
  if (hosts.size === 0) {
    const host = loadOrCreateHost(new URL(".state/relay.json", import.meta.url).pathname);
    hosts.set(host.hostId, host.token);
  }
  const relay = await startRelay({ port: Number(values.port), hosts });
  console.log(`relay listening on 0.0.0.0:${relay.port}`);
  for (const address of ["127.0.0.1", ...lanAddresses()]) console.log(`  ws://${address}:${relay.port}`);
  for (const [hostId, token] of hosts)
    console.log(`host line: atrium-relay://${hostId}:${token}@127.0.0.1:${relay.port}`);
}
