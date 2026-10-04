import { type Context, ROOT_CONTEXT, type Tracer, context } from "@opentelemetry/api";
import { CloseCode, HelloMessage, PROTOCOL_VERSION, type WelcomeMessage } from "@atrium/protocol";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { type Clock, trackedTimeout } from "../platform/clock";
import type { Logger } from "../platform/logger";
import type { ResourceTracker } from "../platform/resources";
import { contextFromTraceparent, inSyncSpan } from "../platform/tracing";
import { tokensMatch } from "./auth";
import { serveStatic } from "./static-files";

/** Limits that keep one local process from exhausting the host (security.md, "WebSocket 与鉴权"). */
interface ConnectionLimits {
  /** Simultaneous connections, authenticated or not. */
  readonly maxConnections: number;
  /** Messages one connection may send within any one-second window. */
  readonly messagesPerSecond: number;
  /** Bytes one connection may send within any one-second window. */
  readonly bytesPerSecond: number;
}

/** Options for {@link startWsServer}. */
export interface WsServerOptions {
  /** Token clients must present in `hello`. */
  readonly token: string;
  /** Port to listen on; 0 picks a free one. */
  readonly port: number;
  /** Directory with the built UI; when absent, HTTP requests get 404. */
  readonly uiDir: string | undefined;
  /** Origins allowed besides the host's own, such as the Vite dev server. */
  readonly extraOrigins: readonly string[];
  /** How long a client has to authenticate after connecting. */
  readonly handshakeTimeoutMs: number;
  /** Largest accepted message. */
  readonly maxPayloadBytes: number;
  readonly limits: ConnectionLimits;
  readonly hostVersion: string;
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly clock: Clock;
  readonly resources: ResourceTracker;
}

/** A listening server. */
export interface RunningServer {
  readonly port: number;
  /** IP address the server is bound to. */
  readonly address: string;
  /** The host's own origin, `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** Stops accepting connections, disconnects every client and stops listening. */
  readonly close: () => Promise<void>;
}

/**
 * Starts the HTTP and WebSocket server on 127.0.0.1.
 *
 * @remarks
 * Implements the connection rules in security.md ("WebSocket 与鉴权"): only loopback; browsers
 * from foreign origins are refused at the upgrade, before any message is read; the token travels
 * in the first message, never in the URL; nothing but `hello` is handled until it succeeds, and a
 * silent client is dropped after the handshake timeout. Requests without an `Origin` header come
 * from non-browser local processes, which a web page cannot impersonate, so they only need the
 * token. Connection count and per-connection message rate are capped. Closing stops listening and
 * drops every HTTP connection first, including one that has sent only part of an upgrade, so no
 * WebSocket can appear after shutdown began and keep `close` waiting.
 *
 * @sideEffects Listens on a TCP port; counts each connection and handshake timer as resources;
 * logs connection outcomes; starts a `ws.connect` span per handshake.
 * @param options - Server configuration and shared services.
 * @returns The bound port and address, the origin, and a close function.
 */
export async function startWsServer(options: WsServerOptions): Promise<RunningServer> {
  const allowedOrigins = new Set<string>(options.extraOrigins);
  const sockets = new Set<WebSocket>();
  const httpServer = createServer((request, response) => {
    if (options.uiDir === undefined) {
      response.writeHead(404).end();
      return;
    }
    // Stryker disable all: serveStatic answers every failure itself; this only catches a future bug.
    serveStatic(request, response, options.uiDir).catch((error: unknown) => {
      options.logger.error({ err: error, url: request.url }, "static file request failed");
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  // Stryker restore all
  const wss = new WebSocketServer({ noServer: true, maxPayload: options.maxPayloadBytes });

  httpServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      options.logger.warn({ origin }, "websocket upgrade rejected: origin not allowed");
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (sockets.size >= options.limits.maxConnections) {
        options.logger.warn({ limit: options.limits.maxConnections }, "client rejected: too many connections");
        ws.close(CloseCode.TooManyConnections, "too many connections");
        return;
      }
      sockets.add(ws);
      ws.once("close", () => sockets.delete(ws));
      acceptConnection(ws, options);
    });
  });

  const { port, address } = await listen(httpServer, options.port);
  const origin = `http://127.0.0.1:${port}`;
  allowedOrigins.add(origin);
  allowedOrigins.add(`http://localhost:${port}`);
  options.logger.info({ port }, "host listening");

  return {
    port,
    address,
    origin,
    close: async () => {
      const stopped = new Promise<void>((done, fail) => httpServer.close((error) => (error ? fail(error) : done())));
      httpServer.closeAllConnections();
      // Stryker disable next-line ArrowFunction,ArrayDeclaration: the close events currently arrive before wss.close returns anyway; waiting makes the order a guarantee, so no log is written after the log file closes.
      const closed = [...sockets].map((ws) => new Promise<void>((done) => ws.once("close", () => done())));
      for (const ws of sockets) ws.terminate();
      await Promise.all(closed);
      await new Promise<void>((done) => wss.close(() => done()));
      await stopped;
    },
  };
}

/**
 * Binds the server to loopback and waits until it is listening.
 *
 * @remarks
 * Loopback only (security.md); listening on other interfaces will be an explicit setting later.
 *
 * @sideEffects Opens a listening socket.
 * @param server - HTTP server to bind.
 * @param port - Requested port, 0 for any free port.
 * @returns The bound port and address.
 */
function listen(server: Server, port: number): Promise<{ port: number; address: string }> {
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      // Stryker disable next-line all: once listening, the promise is settled and a stray `fail` call has no effect.
      server.off("error", fail);
      const bound: AddressInfo | string | null = server.address();
      // Stryker disable next-line all: a TCP listener always reports an AddressInfo; this only narrows the type.
      if (bound === null || typeof bound === "string") fail(new Error("server is not bound to a TCP port"));
      else done({ port: bound.port, address: bound.address });
    });
  });
}

/**
 * Runs the handshake for one new socket and tracks it until it closes.
 *
 * @remarks
 * The first message must be `hello`, and it is decided synchronously, so a frame that arrives in
 * the same TCP read is already handled as an authenticated message. A rejected client is closed
 * and anything it still sends is ignored. Every message, before or after the handshake, counts
 * against the per-second limits. Command routing arrives in M1.3, so authenticated messages are
 * only logged for now.
 *
 * @sideEffects Counts the connection and its handshake timer as resources; may close the socket
 * with a protocol close code; logs the outcome.
 * @param ws - The upgraded socket.
 * @param options - Server configuration and shared services.
 */
function acceptConnection(ws: WebSocket, options: WsServerOptions): void {
  const releaseConnection = options.resources.acquire("ws.connection");
  let phase: "awaiting-hello" | "open" | "closed" = "awaiting-hello";
  /** Trace of the accepted handshake; later records of this connection join it. */
  let connectionTrace: Context = ROOT_CONTEXT;
  let windowStart = options.clock.now();
  let windowMessages = 0;
  let windowBytes = 0;
  const cancelHandshakeTimer = trackedTimeout(
    options.clock,
    options.resources,
    () => {
      // Stryker disable next-line all: the timer is cancelled when the hello arrives, so it only fires while awaiting it.
      if (phase !== "awaiting-hello") return;
      phase = "closed";
      options.logger.warn("client dropped: no hello before timeout");
      ws.close(CloseCode.HandshakeTimeout, "handshake timeout");
    },
    options.handshakeTimeoutMs,
  );

  /**
   * Counts one message against the current one-second window.
   *
   * @remarks
   * A fixed window per connection is enough to stop a flood; it does not need to be smooth.
   *
   * @sideEffects Updates the window counters.
   * @param bytes - Size of the message.
   * @returns Whether the connection is still within its limits.
   */
  function withinLimits(bytes: number): boolean {
    const now = options.clock.now();
    if (now - windowStart >= 1_000) {
      windowStart = now;
      windowMessages = 0;
      windowBytes = 0;
    }
    windowMessages += 1;
    windowBytes += bytes;
    return windowMessages <= options.limits.messagesPerSecond && windowBytes <= options.limits.bytesPerSecond;
  }

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (phase === "closed") return;
    const bytes = rawLength(data);
    if (!withinLimits(bytes)) {
      phase = "closed";
      context.with(connectionTrace, () => options.logger.warn("client dropped: message rate limit exceeded"));
      ws.close(CloseCode.RateLimited, "rate limited");
      return;
    }
    if (phase === "open") {
      context.with(connectionTrace, () => options.logger.debug({ bytes }, "message ignored: no command routing yet"));
      return;
    }
    cancelHandshakeTimer();
    const accepted = handleHello(ws, data, isBinary, options);
    if (accepted === null) {
      phase = "closed";
    } else {
      phase = "open";
      connectionTrace = accepted;
    }
  });
  ws.on("error", (error) => options.logger.warn({ err: error }, "websocket error"));
  ws.once("close", (code: number) => {
    cancelHandshakeTimer();
    releaseConnection();
    if (phase === "open") context.with(connectionTrace, () => options.logger.info({ code }, "client disconnected"));
  });
}

/**
 * Validates a `hello` message and either welcomes the client or closes the socket.
 *
 * @remarks
 * Runs inside a `ws.connect` span parented by the client's `traceparent`, so the client's action
 * and the host's acceptance or rejection share one trace (observability.md). Rejections use the
 * close codes the protocol defines so the client can explain them to the user.
 *
 * @sideEffects Sends `welcome` or closes the socket; starts and ends a span; logs the outcome.
 * @param ws - The socket that sent the message.
 * @param data - The raw first message.
 * @param isBinary - Whether the frame was binary; `hello` must be text.
 * @param options - Server configuration and shared services.
 * @returns The trace context of the accepted handshake, so later records of the connection can
 * join the same trace; `null` when the client was rejected.
 */
function handleHello(ws: WebSocket, data: RawData, isBinary: boolean, options: WsServerOptions): Context | null {
  const hello = isBinary ? null : HelloMessage.safeParse(parseJson(data));
  const parent = hello?.success === true ? contextFromTraceparent(hello.data.traceparent) : ROOT_CONTEXT;
  return inSyncSpan(options.tracer, "ws.connect", parent, (span) => {
    if (hello?.success !== true) {
      options.logger.warn("client rejected: malformed hello");
      ws.close(CloseCode.BadHandshake, "bad handshake");
      return null;
    }
    span.setAttribute("client.id", hello.data.clientId);
    if (hello.data.protocolVersion !== PROTOCOL_VERSION) {
      options.logger.warn({ client_version: hello.data.protocolVersion }, "client rejected: protocol version mismatch");
      ws.close(CloseCode.VersionMismatch, "protocol version mismatch");
      return null;
    }
    if (!tokensMatch(options.token, hello.data.token)) {
      options.logger.warn({ client_id: hello.data.clientId }, "client rejected: wrong token");
      ws.close(CloseCode.Unauthorized, "unauthorized");
      return null;
    }
    const welcome: WelcomeMessage = {
      type: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      hostVersion: options.hostVersion,
    };
    ws.send(JSON.stringify(welcome));
    options.logger.info({ client_id: hello.data.clientId }, "client connected");
    return context.active();
  });
}

// Stryker disable BlockStatement: an emptied catch returns undefined, which the schema rejects exactly like null.
/**
 * Parses a text frame as JSON.
 *
 * @remarks
 * Malformed input from the network is expected, so it yields `null` instead of throwing.
 *
 * @sideEffects none
 * @param data - Raw frame payload.
 * @returns The parsed value, or `null` if it is not valid JSON.
 */
function parseJson(data: RawData): unknown {
  try {
    return JSON.parse(Buffer.concat(toBuffers(data)).toString());
  } catch {
    return null;
  }
}

// Stryker restore BlockStatement

/**
 * Normalizes the payload shapes `ws` may deliver into a list of buffers.
 *
 * @remarks
 * `ws` hands over a Buffer, an ArrayBuffer or fragments depending on how the frame arrived.
 *
 * @sideEffects none
 * @param data - Raw payload.
 * @returns The payload as buffers.
 */
function toBuffers(data: RawData): Buffer[] {
  // Stryker disable next-line ConditionalExpression: arrays arrive only with binaryType "fragments", which the host never sets.
  if (Array.isArray(data)) return data;
  return [Buffer.isBuffer(data) ? data : Buffer.from(data)];
}

/**
 * Measures a raw payload.
 *
 * @remarks
 * Logged instead of the content, which must not be logged (observability.md, "脱敏").
 *
 * @sideEffects none
 * @param data - Raw payload.
 * @returns Its size in bytes.
 */
function rawLength(data: RawData): number {
  return toBuffers(data).reduce((total, buffer) => total + buffer.length, 0);
}
