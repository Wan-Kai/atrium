import { type Context, ROOT_CONTEXT, type Tracer, context } from "@opentelemetry/api";
import { CloseCode, HelloMessage, PROTOCOL_VERSION, type WelcomeMessage } from "@atrium/protocol";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { type Clock, trackedTimeout } from "../platform/clock";
import type { Logger } from "../platform/logger";
import type { ResourceTracker } from "../platform/resources";
import { contextFromTraceparent, inSpan } from "../platform/tracing";
import { tokensMatch } from "./auth";
import { serveStatic } from "./static-files";

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
  readonly hostVersion: string;
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly clock: Clock;
  readonly resources: ResourceTracker;
}

/** A listening server. */
export interface RunningServer {
  readonly port: number;
  /** The host's own origin, `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** Disconnects every client and stops listening. */
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
 * from non-browser clients, which a web page cannot impersonate, so they only need the token.
 *
 * @sideEffects Listens on a TCP port; counts each connection and handshake timer as resources;
 * logs connection outcomes; starts a `ws.connect` span per handshake.
 * @param options - Server configuration and shared services.
 * @returns The bound port, origin and a close function.
 */
export async function startWsServer(options: WsServerOptions): Promise<RunningServer> {
  const allowedOrigins = new Set<string>(options.extraOrigins);
  const sockets = new Set<WebSocket>();
  const httpServer = createServer((request, response) => {
    if (options.uiDir === undefined) {
      response.writeHead(404).end();
      return;
    }
    // Stryker disable all: serveStatic turns every expected failure into 404 or 405; this only catches a future bug.
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
      sockets.add(ws);
      ws.once("close", () => sockets.delete(ws));
      acceptConnection(ws, options);
    });
  });

  const port = await listen(httpServer, options.port);
  const origin = `http://127.0.0.1:${port}`;
  allowedOrigins.add(origin);
  allowedOrigins.add(`http://localhost:${port}`);
  options.logger.info({ port }, "host listening");

  return {
    port,
    origin,
    close: async () => {
      // Stryker disable next-line ArrowFunction: the close events currently arrive before httpServer.close resolves anyway; waiting makes the order a guarantee, so no log is written after the log file closes.
      const closed = [...sockets].map((ws) => new Promise<void>((done) => ws.once("close", () => done())));
      for (const ws of sockets) ws.terminate();
      await Promise.all(closed);
      await new Promise<void>((done) => wss.close(() => done()));
      await new Promise<void>((done, fail) => httpServer.close((error) => (error ? fail(error) : done())));
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
 * @returns The bound port.
 */
function listen(server: Server, port: number): Promise<number> {
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => {
      // Stryker disable next-line all: once listening, the promise is settled and a stray `fail` call has no effect.
      server.off("error", fail);
      const address: AddressInfo | string | null = server.address();
      // Stryker disable next-line all: a TCP listener always reports an AddressInfo; this only narrows the type.
      if (address === null || typeof address === "string") fail(new Error("server is not bound to a TCP port"));
      else done(address.port);
    });
  });
}

/**
 * Runs the handshake for one new socket and tracks it until it closes.
 *
 * @remarks
 * Only the first message is read as `hello`; messages that arrive while it is being checked are
 * dropped, and a rejected client is closed, so nothing else is processed before success. Command
 * routing arrives in M1.3, so authenticated messages are only logged for now.
 *
 * @sideEffects Counts the connection and its handshake timer as resources; may close the socket
 * with a protocol close code; logs the outcome.
 * @param ws - The upgraded socket.
 * @param options - Server configuration and shared services.
 */
function acceptConnection(ws: WebSocket, options: WsServerOptions): void {
  const releaseConnection = options.resources.acquire("ws.connection");
  let phase: "awaiting-hello" | "checking" | "open" = "awaiting-hello";
  /** Trace of the accepted handshake; later records of this connection join it. */
  let connectionTrace: Context = ROOT_CONTEXT;
  const cancelHandshakeTimer = trackedTimeout(
    options.clock,
    options.resources,
    () => {
      // Stryker disable next-line all: the timer is cancelled when the hello arrives, so it only fires while awaiting it.
      if (phase !== "awaiting-hello") return;
      options.logger.warn("client dropped: no hello before timeout");
      ws.close(CloseCode.HandshakeTimeout, "handshake timeout");
    },
    options.handshakeTimeoutMs,
  );

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (phase === "open") {
      context.with(connectionTrace, () =>
        options.logger.debug({ bytes: rawLength(data) }, "message ignored: no command routing yet"),
      );
      return;
    }
    // Stryker disable next-line all: a second frame only lands while the first is being checked when both arrive in one TCP read, which a test cannot force.
    if (phase === "checking" || ws.readyState !== ws.OPEN) return;
    phase = "checking";
    cancelHandshakeTimer();
    void checkHello(data, isBinary);
  });
  /**
   * Runs the handshake for the first message and opens the connection on success.
   *
   * @remarks
   * Wrapped so an unexpected failure closes the socket instead of leaving it half-open.
   *
   * @sideEffects Updates the connection phase; may close the socket and log.
   * @param data - The first message.
   * @param isBinary - Whether it arrived as a binary frame.
   */
  async function checkHello(data: RawData, isBinary: boolean): Promise<void> {
    try {
      const accepted = await handleHello(ws, data, isBinary, options);
      if (accepted !== null) {
        phase = "open";
        connectionTrace = accepted;
      }
    } catch (error) {
      // Stryker disable all: handleHello has no throwing path; this guards against a future bug leaving the socket half-open.
      options.logger.error({ err: error }, "handshake failed unexpectedly");
      ws.close(CloseCode.BadHandshake, "handshake failed");
    }
  }

  // Stryker restore all

  // Stryker disable next-line all: socket errors cannot be provoked from a test without a broken network stack.
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
async function handleHello(
  ws: WebSocket,
  data: RawData,
  isBinary: boolean,
  options: WsServerOptions,
): Promise<Context | null> {
  const hello = isBinary ? null : HelloMessage.safeParse(parseJson(data));
  const parent = hello?.success === true ? contextFromTraceparent(hello.data.traceparent) : ROOT_CONTEXT;
  return inSpan(options.tracer, "ws.connect", parent, (span) => {
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
    // Stryker disable next-line all: returning undefined instead of null is rejected by the schema the same way.
    return null;
  }
}

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
