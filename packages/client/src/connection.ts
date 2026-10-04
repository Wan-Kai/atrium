import {
  CloseCode,
  type HelloMessage,
  PROTOCOL_VERSION,
  type TraceContext,
  WelcomeMessage,
  createTraceContext,
  formatTraceparent,
} from "@atrium/protocol";
import { type StoreApi, createStore } from "zustand/vanilla";

/** Connection state exposed to the UI. */
export type ConnectionState =
  | { readonly status: "idle" }
  | { readonly status: "connecting"; readonly traceId: string }
  | { readonly status: "connected"; readonly traceId: string; readonly hostVersion: string }
  | { readonly status: "rejected"; readonly reason: RejectionReason }
  | { readonly status: "disconnected"; readonly code: number };

/** Why the host refused the connection; the UI turns these into text. */
export type RejectionReason =
  | "unauthorized"
  | "version-mismatch"
  | "bad-handshake"
  | "handshake-timeout"
  | "rate-limited"
  | "too-many-connections";

/** The minimal WebSocket surface the client needs; the browser and Node globals both match it. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
}

/** Options for {@link createConnection}. */
export interface ConnectionOptions {
  /** WebSocket URL of the host, such as `ws://127.0.0.1:4317`. */
  readonly url: string;
  /** Token to present in `hello`. */
  readonly token: string;
  /** Stable id of this client, used by the host for per-client layout. */
  readonly clientId: string;
  /** Opens a socket; defaults to the global `WebSocket`. */
  readonly openSocket?: (url: string) => SocketLike;
  /** Starts the trace of the connect action; injectable for deterministic tests. */
  readonly createTrace?: () => TraceContext;
}

/** A connection to the host and its observable state. */
export interface Connection {
  /** Zustand vanilla store the UI subscribes to. */
  readonly state: StoreApi<ConnectionState>;
  /** Opens the socket and authenticates; resolves once the host answers or the socket closes. */
  readonly connect: () => Promise<ConnectionState>;
  /** Closes the socket. */
  readonly disconnect: () => void;
}

const REJECTIONS: Partial<Record<number, RejectionReason>> = {
  [CloseCode.Unauthorized]: "unauthorized",
  [CloseCode.VersionMismatch]: "version-mismatch",
  [CloseCode.BadHandshake]: "bad-handshake",
  [CloseCode.HandshakeTimeout]: "handshake-timeout",
  [CloseCode.RateLimited]: "rate-limited",
  [CloseCode.TooManyConnections]: "too-many-connections",
};

/**
 * Builds the `hello` message for a connection attempt.
 *
 * @remarks
 * The connect action starts a trace here so the host's `ws.connect` span joins it
 * (observability.md, "一条链路包含什么").
 *
 * @sideEffects none
 * @param token - Token to present.
 * @param clientId - This client's id.
 * @param trace - Trace context of the connect action.
 * @returns The message to send first.
 */
export function buildHello(token: string, clientId: string, trace: TraceContext): HelloMessage {
  return { type: "hello", protocolVersion: PROTOCOL_VERSION, clientId, token, traceparent: formatTraceparent(trace) };
}

/**
 * Creates a connection to the host whose state lives in a DOM-free Zustand store.
 *
 * @remarks
 * The client package must not depend on the DOM or React (overview.md, "包之间的依赖"), so state
 * is a vanilla store the UI wraps in hooks. The socket factory is injectable so Node tests use
 * the real host with Node's WebSocket. Calling `connect` again closes the previous socket first;
 * events from a replaced socket still settle its own `connect` promise but never touch the store,
 * so a late close cannot overwrite the newer connection's state. Automatic reconnection and
 * command routing come in M1.3.
 *
 * @sideEffects `connect` closes any previous socket, opens a new WebSocket and updates `state` as
 * the handshake progresses; `disconnect` closes the current socket.
 * @param options - Host URL, token, client id and optional factories.
 * @returns The connection.
 */
export function createConnection(options: ConnectionOptions): Connection {
  const state = createStore<ConnectionState>(() => ({ status: "idle" }));
  const openSocket: (url: string) => SocketLike = options.openSocket ?? ((url: string) => new WebSocket(url));
  let socket: SocketLike | undefined;

  return {
    state,
    connect: () =>
      new Promise((settle) => {
        const trace = (options.createTrace ?? createTraceContext)();
        socket?.close(1000, "client reconnecting");
        state.setState({ status: "connecting", traceId: trace.traceId }, true);
        const current = openSocket(options.url);
        socket = current;
        current.addEventListener("open", () => {
          current.send(JSON.stringify(buildHello(options.token, options.clientId, trace)));
        });
        current.addEventListener("message", (event) => {
          // Stryker disable next-line ConditionalExpression: JSON.parse turns a binary payload into a string it cannot parse, so skipping the type check changes nothing.
          const welcome = typeof event.data === "string" ? WelcomeMessage.safeParse(safeJson(event.data)) : null;
          if (socket === current && welcome?.success === true && state.getState().status === "connecting") {
            state.setState(
              { status: "connected", traceId: trace.traceId, hostVersion: welcome.data.hostVersion },
              // Stryker disable next-line BooleanLiteral: merging into "connecting" yields the same keys; replacing states the intent.
              true,
            );
            settle(state.getState());
          }
        });
        current.addEventListener("close", (event) => {
          const reason = REJECTIONS[event.code];
          const ended: ConnectionState = reason
            ? { status: "rejected", reason }
            : { status: "disconnected", code: event.code };
          if (socket === current) state.setState(ended, true);
          settle(ended);
        });
      }),
    disconnect: () => socket?.close(1000, "client closed"),
  };
}

// Stryker disable BlockStatement,ArrowFunction: an emptied catch returns undefined, which the schema rejects exactly like null.
/**
 * Parses JSON without throwing.
 *
 * @remarks
 * Frames from the network may be malformed; the caller treats `null` as "not a welcome".
 *
 * @sideEffects none
 * @param text - Frame text.
 * @returns The parsed value or `null`.
 */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
