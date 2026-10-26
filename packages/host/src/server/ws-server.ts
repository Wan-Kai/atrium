import { type Context, ROOT_CONTEXT, type Tracer, context } from "@opentelemetry/api";
import {
  CloseCode,
  HelloMessage,
  type InstallUpdatedEvent,
  type LoginUpdatedEvent,
  PROTOCOL_VERSION,
  type PlansUpdatedEvent,
  type WelcomeMessage,
} from "@atrium/protocol";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { type Clock, trackedTimeout } from "../platform/clock";
import type { Logger } from "../platform/logger";
import type { ResourceTracker } from "../platform/resources";
import { contextFromTraceparent, inSyncSpan } from "../platform/tracing";
import type { IndexCommands } from "../sessions/index-commands";
import type { SessionCommands } from "../sessions/session-commands";
import type { SubscriptionRegistry } from "../sync/subscriptions";
import { tokensMatch } from "./auth";
import { type Connection, createConnection } from "./connection";
import type { ClientTransport, TransportOrigin } from "./transport";
import type { ChangesService } from "../changes/changes-service";
import type { AttachmentStore } from "./attachments";
import { type Route, type RouterOptions, createRouter } from "./router";
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
  /** Random per host start; tells a reconnecting client whether the host restarted. */
  readonly hostInstanceId: string;
  /** How often clients ping and how long they wait for the answer; also the host's ping interval. */
  readonly heartbeatMs: number;
  /** The seed of this install's dot pattern, sent in the welcome. */
  readonly installSeed: number;
  /** The folder of the host's logs, sent in the welcome. */
  readonly logDir: string;
  /** Bytes that may wait to be sent to one client before it is dropped as too slow. */
  readonly maxBufferedBytes: number;
  /** Largest encoded message to a phone (SPEC-0005, "Noise 通道 · 大小"). */
  readonly maxPhoneMessageBytes: number;
  /** Where connections register to receive session events. */
  readonly subscriptions: SubscriptionRegistry;
  /** Handles session commands. */
  readonly sessions: SessionCommands;
  /** A disconnected connection's translations are cancelled, never transferred to a reconnect. */
  readonly translations: RouterOptions["translations"] & { disconnect(connectionId: string): void };
  readonly index: IndexCommands;
  /** First launch and the settings. */
  readonly setup: RouterOptions["setup"];
  readonly piConfig: RouterOptions["piConfig"];
  /** Signing in and out through pi. */
  readonly logins: RouterOptions["logins"];
  /** Installing and updating pi and Node. */
  readonly installs: RouterOptions["installs"];
  /**
   * What a connection is told right after the welcome: the install job and the login under way or
   * last ended, so a window that was away sees how they went (SPEC-0001, "首次启动 · 接口"), and
   * every subscription's usage (SPEC-0001, "M1.14 的套餐总览").
   */
  readonly catchUp: () => readonly (InstallUpdatedEvent | LoginUpdatedEvent | PlansUpdatedEvent)[];
  /** The latest pi. */
  readonly piLatest: RouterOptions["piLatest"];
  /** Remote access, for the local "手机" page; a closed connection stops watching it. */
  readonly remote: RouterOptions["remote"];
  /** Images uploaded ahead of their messages; a closed connection's go. */
  readonly attachments: AttachmentStore;
  /** Workspaces' git changes; a closed connection stops showing them. */
  readonly changes: Pick<ChangesService, "watchChanges" | "watchDiff" | "disconnect">;
  /** A workspace's files, for the right panel's file tree and the viewer tabs. */
  readonly files: RouterOptions["files"];
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
  /**
   * Serves a phone's channel like a local connection, once its Noise handshake is done.
   *
   * @returns Whether it was taken; a full host closes it with 4503 and answers `false`.
   */
  readonly accept: (transport: ClientTransport, origin: TransportOrigin) => boolean;
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
  /** Channels of phones, counted against the same connection limit (SPEC-0005, "客户端传输"). */
  const channels = new Set<ClientTransport>();
  let closing = false;
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
  const route = createRouter({
    sessions: options.sessions,
    translations: options.translations,
    index: options.index,
    setup: options.setup,
    piConfig: options.piConfig,
    logins: options.logins,
    installs: options.installs,
    piLatest: options.piLatest,
    remote: options.remote,
    attachments: options.attachments,
    changes: options.changes,
    files: options.files,
    tracer: options.tracer,
    logger: options.logger,
  });
  let nextConnectionId = 0;

  /**
   * Whether another connection fits, logging the refusal when it does not.
   *
   * @remarks
   * Local sockets and phones' channels share the limit of 32.
   *
   * @sideEffects Logs a refusal.
   * @returns Whether there is room.
   */
  function room(): boolean {
    if (sockets.size + channels.size < options.limits.maxConnections) return true;
    options.logger.warn({ limit: options.limits.maxConnections }, "client rejected: too many connections");
    return false;
  }

  /**
   * The next connection's opaque id.
   *
   * @remarks
   * Unique within this host run.
   *
   * @sideEffects Advances the counter.
   * @returns The id.
   */
  function nextId(): string {
    // Stryker disable next-line AssignmentOperator: counting down gives unique ids just the same.
    nextConnectionId += 1;
    return `connection-${nextConnectionId}`;
  }

  httpServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      options.logger.warn({ origin }, "websocket upgrade rejected: origin not allowed");
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      if (!room()) {
        ws.close(CloseCode.TooManyConnections, "too many connections");
        return;
      }
      sockets.add(ws);
      const release = options.resources.acquire("ws.connection");
      ws.once("close", () => {
        sockets.delete(ws);
        release();
      });
      let trace: Context = ROOT_CONTEXT;
      const transport = localTransport(ws, options, () => trace);
      serveTransport(transport, nextId(), { origin: "local" }, route, options, (accepted) => {
        trace = accepted;
      });
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
    accept: (transport, from) => {
      if (closing || !room()) {
        transport.close(CloseCode.TooManyConnections, "too many connections");
        return false;
      }
      channels.add(transport);
      transport.onClose(() => channels.delete(transport));
      serveTransport(transport, nextId(), from, route, options);
      return true;
    },
    close: async () => {
      closing = true;
      for (const channel of channels) channel.close(1001, "host closing");
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
 * Wraps an upgraded local socket as a transport, keeping the per-second limits on this path.
 *
 * @remarks
 * Every message, before or after the handshake, counts against the per-second limits
 * (security.md, "WebSocket 与鉴权"); a client past them is closed and anything it still sends is
 * ignored. The probe is a WebSocket ping: browsers answer pings by themselves, so only a client
 * that is really gone (asleep, or its network dropped) leaves one unanswered, and it is terminated
 * without a closing handshake (SPEC-0001, "握手与心跳").
 *
 * @sideEffects Listens on the socket; may close or terminate it; logs socket errors and rate-limit drops.
 * @param ws - The upgraded socket.
 * @param options - Limits, clock and logger.
 * @param trace - The connection's trace once it has one, for its log lines.
 * @returns The transport.
 */
function localTransport(ws: WebSocket, options: WsServerOptions, trace: () => Context): ClientTransport {
  let limited = false;
  let answered = true;
  let windowStart = options.clock.now();
  let windowMessages = 0;
  let windowBytes = 0;

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

  ws.on("pong", () => {
    answered = true;
  });
  ws.on("error", (error) => options.logger.warn({ err: error }, "websocket error"));
  return {
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    send: (text) => ws.send(text),
    close: (code, reason) => ws.close(code, reason),
    onMessage(listener) {
      ws.on("message", (data: RawData, isBinary: boolean) => {
        if (limited) return;
        if (!withinLimits(rawLength(data))) {
          limited = true;
          context.with(trace(), () => options.logger.warn("client dropped: message rate limit exceeded"));
          ws.close(CloseCode.RateLimited, "rate limited");
          return;
        }
        listener(isBinary ? null : Buffer.concat(toBuffers(data)).toString());
      });
    },
    onClose(listener) {
      ws.once("close", (code: number) => listener(code));
    },
    checkAlive() {
      if (!answered) {
        ws.terminate();
        return false;
      }
      answered = false;
      ws.ping();
      return true;
    },
  };
}

/**
 * Runs the handshake for one new transport, then serves it until it closes.
 *
 * @remarks
 * The first message must be `hello`, and it is decided synchronously, so a frame that arrives in
 * the same read is already handled as an authenticated message. A rejected client is closed and
 * anything it still sends is ignored. Once accepted, the transport becomes a `Connection`
 * registered for session events, each message goes to the router, and the host probes it every
 * `heartbeatMs`; a client that has not answered the previous probe by the next one is gone and is
 * dropped by its transport (SPEC-0001, "握手与心跳"). Local and remote transports share all of
 * this; who the transport belongs to comes from its own code, never from the client (SPEC-0005,
 * "日常连接" item 4).
 *
 * @sideEffects Counts the handshake and heartbeat timers as resources; may close the transport;
 * registers and unregisters the connection for session events; logs the outcome.
 * @param transport - The transport.
 * @param connectionId - Opaque id for the connection.
 * @param origin - Who the transport belongs to.
 * @param route - Handles each message after the handshake.
 * @param options - Server configuration and shared services.
 * @param onTrace - Told the accepted handshake's trace, for the transport's own log lines.
 */
function serveTransport(
  transport: ClientTransport,
  connectionId: string,
  origin: TransportOrigin,
  route: Route,
  options: WsServerOptions,
  onTrace: (trace: Context) => void = () => {},
): void {
  /** Set once the client was rejected; nothing it sends is handled after that. */
  let closed = false;
  /** Set once the hello is accepted. */
  let connection: Connection | undefined;
  /** Trace of the accepted handshake; the connection's log lines join it. */
  let connectionTrace: Context = ROOT_CONTEXT;
  let cancelHeartbeat: (() => void) | undefined;
  const cancelHandshakeTimer = trackedTimeout(
    options.clock,
    options.resources,
    () => {
      // Stryker disable next-line all: the timer is cancelled when the hello arrives, so it only fires while awaiting it.
      if (connection !== undefined || closed) return;
      closed = true;
      options.logger.warn("client dropped: no hello before timeout");
      transport.close(CloseCode.HandshakeTimeout, "handshake timeout");
    },
    options.handshakeTimeoutMs,
  );

  /**
   * Probes the client, or logs that it is gone when its transport dropped it.
   *
   * @remarks
   * The first beat only probes; see `serveTransport`.
   *
   * @sideEffects Probes through the transport; schedules the next beat; logs a dropped client.
   */
  function beat(): void {
    if (!transport.checkAlive()) {
      context.with(connectionTrace, () => options.logger.warn("client dropped: no pong before the next ping"));
      return;
    }
    cancelHeartbeat = trackedTimeout(options.clock, options.resources, beat, options.heartbeatMs);
  }

  transport.onMessage((text) => {
    if (closed) return;
    if (connection !== undefined) {
      // Fire and forget: the router answers every message itself and never rejects.
      void route(connection, text === null ? undefined : parseJson(text));
      return;
    }
    cancelHandshakeTimer();
    const accepted = handleHello(transport, text, origin, options);
    if (accepted === null) {
      closed = true;
      return;
    }
    connectionTrace = accepted.trace;
    onTrace(accepted.trace);
    connection = createConnection(transport, {
      id: connectionId,
      clientId: accepted.clientId,
      trace: accepted.trace,
      maxBufferedBytes: options.maxBufferedBytes,
      logger: options.logger,
      ...(origin.origin === "remote"
        ? {
            remote: {
              deviceId: origin.deviceId,
              maxMessageBytes: options.maxPhoneMessageBytes,
              snapshotOf: (sessionId: string) => options.sessions.currentSnapshot(sessionId),
            },
          }
        : {}),
    });
    const open = connection;
    options.subscriptions.connect(connectionId, (event) => open.send(event), accepted.clientId);
    for (const event of options.catchUp()) open.send(event);
    beat();
  });
  transport.onClose((code) => {
    cancelHandshakeTimer();
    cancelHeartbeat?.();
    if (connection === undefined) return;
    options.subscriptions.disconnect(connectionId);
    options.attachments.drop(connectionId);
    options.translations.disconnect(connectionId);
    options.changes.disconnect(connectionId);
    options.remote.unwatch(connectionId);
    context.with(connectionTrace, () => options.logger.info({ code }, "client disconnected"));
  });
}

/**
 * Validates a `hello` message and either welcomes the client or closes the transport.
 *
 * @remarks
 * Runs inside a `ws.connect` span parented by the client's `traceparent`, so the client's action
 * and the host's acceptance or rejection share one trace (observability.md). Rejections use the
 * close codes the protocol defines so the client can explain them to the user. A local client must
 * present the token; a phone, authenticated by its channel already, must not, and its `clientId`
 * must be its `deviceId` (SPEC-0005, "协议改动" item 1).
 *
 * @sideEffects Sends `welcome` or closes the transport; starts and ends a span; logs the outcome.
 * @param transport - The transport that sent the message.
 * @param text - The first message, or `null` when it was not text; `hello` must be text.
 * @param origin - Who the transport belongs to.
 * @param options - Server configuration and shared services.
 * @returns The client's id and the trace context of the accepted handshake, so later records of the
 * connection can join or link to the same trace; `null` when the client was rejected.
 */
function handleHello(
  transport: ClientTransport,
  text: string | null,
  origin: TransportOrigin,
  options: WsServerOptions,
): { readonly clientId: string; readonly trace: Context } | null {
  const hello = text === null ? null : HelloMessage.safeParse(parseJson(text));
  const parent = hello?.success === true ? contextFromTraceparent(hello.data.traceparent) : ROOT_CONTEXT;
  return inSyncSpan(options.tracer, "ws.connect", parent, (span) => {
    // The local socket must carry a token, and a phone's channel must not (SPEC-0005, "协议改动").
    const wellFormed =
      hello?.success === true &&
      (origin.origin === "local"
        ? hello.data.token !== undefined
        : hello.data.token === undefined && hello.data.clientId === origin.deviceId);
    if (hello?.success !== true || !wellFormed) {
      options.logger.warn(
        origin.origin === "local" ? {} : { device_id: origin.deviceId },
        "client rejected: malformed hello",
      );
      transport.close(CloseCode.BadHandshake, "bad handshake");
      return null;
    }
    span.setAttribute("client.id", hello.data.clientId);
    if (hello.data.protocolVersion !== PROTOCOL_VERSION) {
      options.logger.warn({ client_version: hello.data.protocolVersion }, "client rejected: protocol version mismatch");
      transport.close(CloseCode.VersionMismatch, "protocol version mismatch");
      return null;
    }
    if (origin.origin === "local" && !tokensMatch(options.token, hello.data.token ?? "")) {
      options.logger.warn({ client_id: hello.data.clientId }, "client rejected: wrong token");
      transport.close(CloseCode.Unauthorized, "unauthorized");
      return null;
    }
    const welcome: WelcomeMessage = {
      type: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      hostVersion: options.hostVersion,
      hostInstanceId: options.hostInstanceId,
      heartbeatMs: options.heartbeatMs,
      installSeed: options.installSeed,
      logDir: options.logDir,
    };
    transport.send(JSON.stringify(welcome));
    options.logger.info({ client_id: hello.data.clientId, origin: origin.origin }, "client connected");
    return { clientId: hello.data.clientId, trace: context.active() };
  });
}

// Stryker disable BlockStatement: an emptied catch returns undefined, which the schema rejects exactly like null.
/**
 * Parses a text message as JSON.
 *
 * @remarks
 * Malformed input from the network is expected, so it yields `null` instead of throwing.
 *
 * @sideEffects none
 * @param text - The message.
 * @returns The parsed value, or `null` if it is not valid JSON.
 */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
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
