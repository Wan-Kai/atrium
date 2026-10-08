import {
  CloseCode,
  type ClientIssueKind,
  type Command,
  CommandError,
  CommandResult,
  type CommandType,
  type HelloMessage,
  HostMessage,
  PROTOCOL_VERSION,
  type SessionEvent,
  type TraceContext,
  createTraceContext,
  formatTraceparent,
} from "@atrium/protocol";
import { type StoreApi, createStore } from "zustand/vanilla";
import { type SessionView, applySessionEvent, loadingView, prependOlder, withWholeStep } from "./session-view";

/** Connection state exposed to the UI. */
export type ConnectionState =
  | { readonly status: "idle" }
  | { readonly status: "connecting"; readonly traceId: string }
  | {
      readonly status: "connected";
      readonly traceId: string;
      readonly hostVersion: string;
      /** Changes when the host restarts. */
      readonly hostInstanceId: string;
    }
  /** The connection dropped; another attempt is scheduled. */
  | { readonly status: "reconnecting"; readonly attempt: number; readonly code: number }
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

/**
 * The WebSocket surface the client uses; the browser's and Node's both match it.
 *
 * @remarks
 * Not exported from the package. `globals.d.ts` types the global `WebSocket` with it, which
 * knip cannot see, hence the tag.
 *
 * @public
 */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
}

/** Timers the client schedules; tests pass a fake clock. */
export interface ClientClock {
  setTimeout(callback: () => void, ms: number): () => void;
}

/** Options for {@link createAtriumClient}. */
export interface AtriumClientOptions {
  /** WebSocket URL of the host, such as `ws://127.0.0.1:4317`. */
  readonly url: string;
  /** Token to present in `hello`. */
  readonly token: string;
  /** Stable id of this client, used by the host for per-client layout. */
  readonly clientId: string;
  /** Opens a socket; defaults to the global `WebSocket`. */
  readonly openSocket?: (url: string) => SocketLike;
  /** Starts a trace for an action; injectable for deterministic tests. */
  readonly createTrace?: () => TraceContext;
  /** Defaults to the global timers. */
  readonly clock?: ClientClock;
  /** Waits before each reconnect attempt, in order, the last repeating; empty turns reconnecting off. */
  readonly reconnectDelaysMs?: readonly number[];
}

/** The one entry point to the host: connection state, session views and commands. */
export interface AtriumClient {
  /** Connection state, as a Zustand vanilla store the UI subscribes to. */
  readonly connection: StoreApi<ConnectionState>;
  /** Opens the socket and authenticates; resolves with the first outcome. Reconnects on its own afterwards. */
  connect(): Promise<ConnectionState>;
  /** Closes the socket and stops reconnecting. */
  disconnect(): void;
  /** The view of a watched session; `undefined` for one not watched. */
  session(sessionId: string): StoreApi<SessionView> | undefined;
  /** Sets the sessions to receive live events for; views are created for new ones and dropped for the rest. */
  watch(sessionIds: readonly string[]): Promise<void>;
  /** Creates a chat and returns its session id. */
  createChat(): Promise<CommandResult<"create_chat">>;
  /** The sessions in pi's session directory changed most recently. */
  listRecentSessions(limit: number): Promise<CommandResult<"list_recent_sessions">>;
  /** Opens a session from its file; `watch` it to see it. */
  openSession(sessionId: string): Promise<CommandResult<"open_session">>;
  /** Sends a message, showing it at once as pending. */
  prompt(sessionId: string, text: string): Promise<CommandResult<"prompt">>;
  /**
   * Fetches the page before the earliest item of a watched session; does nothing when there is
   * none, and joins a fetch already on its way.
   */
  loadOlder(sessionId: string): Promise<void>;
  /** Fetches a step that arrived as a preview and puts it whole in the session's view. */
  loadStep(sessionId: string, turnId: string, stepId: string): Promise<void>;
  /** Reports a UI problem to the host's log. */
  reportIssue(kind: ClientIssueKind, message: string, details?: string): Promise<void>;
}

/**
 * A command that cannot get an answer because the connection is gone.
 *
 * @remarks
 * Its result is unknown, so it is not resent (domain-model §7); the caller decides what to tell
 * the user.
 *
 * @sideEffects none
 */
export class ConnectionLostError extends Error {
  override readonly name = "ConnectionLostError";

  /**
   * Creates the error.
   *
   * @remarks
   * Names the command type, never user-facing text.
   *
   * @sideEffects none
   * @param command - The command type.
   */
  constructor(readonly command: string) {
    super(`connection lost before ${command} was answered`);
  }
}

const REJECTIONS: Partial<Record<number, RejectionReason>> = {
  [CloseCode.Unauthorized]: "unauthorized",
  [CloseCode.VersionMismatch]: "version-mismatch",
  [CloseCode.BadHandshake]: "bad-handshake",
  [CloseCode.HandshakeTimeout]: "handshake-timeout",
  [CloseCode.RateLimited]: "rate-limited",
  [CloseCode.TooManyConnections]: "too-many-connections",
};

const DEFAULT_RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000];
/** Close code the client uses when the host stops answering pings. */
const HEARTBEAT_LOST = 4000;
const MAX_ISSUE_LENGTH = 4096;

/** How many items one scroll back fetches. */
const OLDER_PAGE_ITEMS = 50;

/** A command as callers give it, without the envelope the client fills in. */
type CommandFields<T extends CommandType> = Omit<Extract<Command, { type: T }>, "type" | "requestId" | "traceparent">;

/** The platform's timers. */
const systemClock: ClientClock = {
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

// Stryker disable ConditionalExpression,BlockStatement: a binary frame or broken JSON fails the schema check just like `undefined`.
/**
 * Parses JSON without throwing.
 *
 * @remarks
 * Frames from the network may be malformed; the caller treats `undefined` as "ignore".
 *
 * @sideEffects none
 * @param data - Frame payload.
 * @returns The parsed value, or `undefined`.
 */
function parseFrame(data: unknown): unknown {
  if (typeof data !== "string") return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}
// Stryker restore ConditionalExpression,BlockStatement

/**
 * Creates the client: the only way the UI talks to the host.
 *
 * @remarks
 * Owns the socket, the connection state and one SessionView store per watched session, and
 * exposes only stores and command methods (domain-model §7). Every command gets a fresh trace
 * and request id and waits for its one response (SPEC-0001, "应答"); a failure rejects with
 * `CommandError`. A dropped connection fails the commands still waiting with
 * `ConnectionLostError` and is retried with backoff; on reconnecting the watched sessions are
 * subscribed again, and the new connection sends each one's snapshot. A refused handshake is not
 * retried. After the welcome the client pings every `heartbeatMs` and treats a ping unanswered
 * within as long as a dead connection (SPEC-0001, "握手与心跳"). Calling `connect` again replaces
 * the socket; a replaced socket's late events are ignored. The client does not use the DOM.
 *
 * @sideEffects none until `connect`; then opens sockets, schedules timers and updates stores.
 * @param options - Host URL, token, client id, and injectable socket, trace, clock and delays.
 * @returns The client.
 */
export function createAtriumClient(options: AtriumClientOptions): AtriumClient {
  const connection = createStore<ConnectionState>(() => ({ status: "idle" }));
  const openSocket: (url: string) => SocketLike = options.openSocket ?? ((url: string) => new WebSocket(url));
  const createTrace = options.createTrace ?? createTraceContext;
  const clock = options.clock ?? systemClock;
  const delays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  const views = new Map<string, StoreApi<SessionView>>();
  /** Fetches of older items on their way, by session. */
  const olderLoading = new Map<string, Promise<void>>();
  let watched: readonly string[] = [];
  const pending = new Map<
    string,
    { readonly type: CommandType; resolve(result: unknown): void; reject(error: Error): void }
  >();
  /** The socket of the latest attempt. */
  let socket: SocketLike | undefined;
  /** That socket once its handshake succeeded; commands go only here. */
  let live: SocketLike | undefined;
  // Stryker disable next-line BooleanLiteral: `connect` sets it before anything reads it.
  let stopped = false;
  /** The host instance of the last welcome; a different one means the host restarted. */
  let hostInstance: string | undefined;
  let attempt = 0;
  let nextRequest = 0;
  let cancelTimer: (() => void) | undefined;

  /**
   * Fails every command still waiting for an answer.
   *
   * @remarks
   * Their results are unknown once the connection is gone, and they are not resent.
   *
   * @sideEffects Rejects pending commands.
   */
  function failPending(): void {
    const waiting = [...pending.values()];
    // Stryker disable next-line CallExpression: request ids are never reused, so clearing only frees memory.
    pending.clear();
    for (const command of waiting) command.reject(new ConnectionLostError(command.type));
  }

  /**
   * Sends a command and waits for its response.
   *
   * @remarks
   * The request id is chosen by the caller when it must be known before sending, as for a pending
   * message.
   *
   * @sideEffects Sends on the socket.
   * @param type - The command type.
   * @param fields - Its fields.
   * @param requestId - Its request id.
   * @returns The result, checked against the command's schema.
   * @throws {CommandError} When the host answers with an error.
   * @throws {ConnectionLostError} When there is no connection, or it drops first.
   */
  function request<T extends CommandType>(
    type: T,
    fields: CommandFields<T>,
    requestId = `${options.clientId}-${++nextRequest}`,
  ): Promise<CommandResult<T>> {
    if (live === undefined) return Promise.reject(new ConnectionLostError(type));
    const answer = Promise.withResolvers<CommandResult<T>>();
    pending.set(requestId, {
      type,
      resolve: (result) => {
        // A result that does not match its schema fails the command rather than the message handler.
        const checked = CommandResult[type].safeParse(result ?? {});
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `CommandResult[type]` is the schema of `CommandResult<T>`.
        if (checked.success) answer.resolve(checked.data as CommandResult<T>);
        else answer.reject(checked.error);
      },
      reject: answer.reject,
    });
    live.send(JSON.stringify({ type, requestId, traceparent: formatTraceparent(createTrace()), ...fields }));
    return answer.promise;
  }

  /**
   * Asks for fresh snapshots of every watched session.
   *
   * @remarks
   * On a new connection the host has no subscriptions yet, so each watched session counts as new
   * and gets its snapshot.
   *
   * @sideEffects Sends `subscribe_sessions`.
   */
  async function subscribeWatched(): Promise<void> {
    if (watched.length > 0) await request("subscribe_sessions", { sessionIds: [...watched] });
  }

  /**
   * Marks every watched session as lost after the host restarted.
   *
   * @remarks
   * A restarted host knows none of the old sessions (SPEC-0001, "事件"); their views keep the
   * items already shown, drop the run and unconfirmed messages, and are no longer subscribed. A
   * lost session can be opened again from pi's file (`open_session`).
   *
   * @sideEffects Updates every view; clears the watched set.
   */
  function loseSessions(): void {
    for (const view of views.values()) {
      view.setState({ status: "lost", run: null, pending: [] });
    }
    watched = [];
  }

  /**
   * Gets a fresh snapshot of one session after the client missed an event.
   *
   * @remarks
   * The host sends snapshots only for sessions newly subscribed on the connection, so the session
   * is dropped from the set and added again.
   *
   * @sideEffects Resets the view; sends two `subscribe_sessions`.
   * @param sessionId - The session.
   */
  async function resync(sessionId: string): Promise<void> {
    // Stryker disable next-line OptionalChaining,BooleanLiteral: only a watched session's event starts a resync, and the loading view sets every field.
    views.get(sessionId)?.setState(loadingView(sessionId), true);
    await request("subscribe_sessions", { sessionIds: watched.filter((id) => id !== sessionId) });
    await request("subscribe_sessions", { sessionIds: [...watched] });
  }

  /**
   * Hands one event to its session's view.
   *
   * @remarks
   * Events for sessions no longer watched are dropped.
   *
   * @sideEffects Updates a view; may start a resync.
   * @param event - The event.
   */
  function deliver(event: SessionEvent): void {
    const view = views.get(event.sessionId);
    if (view === undefined) return;
    const next = applySessionEvent(view.getState(), event);
    if (next === "resync") {
      // Fire and forget: a failed resync leaves the view loading until the next reconnect.
      resync(event.sessionId).catch(() => undefined);
      return;
    }
    // Stryker disable next-line BooleanLiteral: the new view sets every field, so merging equals replacing.
    view.setState(next, true);
  }

  /**
   * Handles one message on the open connection.
   *
   * @remarks
   * Messages that do not match the protocol are ignored.
   *
   * @sideEffects Settles a command or updates a view.
   * @param message - The parsed message.
   */
  function receive(message: HostMessage): void {
    // Stryker disable next-line ConditionalExpression,StringLiteral: a second welcome names no session, so no view would take it.
    if (message.type === "welcome") return;
    if (message.type !== "response") {
      deliver(message);
      return;
    }
    // A failure the host could not tie to a command; nothing waits for it.
    // Stryker disable next-line ConditionalExpression: no command is waiting under a null id either.
    if (message.requestId === null) return;
    const waiting = pending.get(message.requestId);
    if (waiting === undefined) return;
    // Stryker disable next-line CallExpression: request ids are never reused, so the entry could only free memory.
    pending.delete(message.requestId);
    if (message.ok) waiting.resolve(message.result);
    else waiting.reject(new CommandError(message.error.code, message.error.params));
  }

  /**
   * Pings the host and checks the answer arrived before the next ping.
   *
   * @remarks
   * A ping that is still unanswered when the next one is due means the connection is dead even
   * if the socket has not noticed, as after the computer slept.
   *
   * @sideEffects Sends `ping`; schedules the next beat; may close the socket.
   * @param current - The socket the heartbeat belongs to.
   * @param heartbeatMs - The interval from the welcome.
   */
  function beat(current: SocketLike, heartbeatMs: number): void {
    let answered = false;
    // Fire and forget: a lost connection fails the ping, and the next beat notices it was not answered.
    void request("ping", {}).then(
      () => {
        answered = true;
        return answered;
      },
      // Stryker disable next-line ArrowFunction,BooleanLiteral: the value is ignored; only success sets `answered`.
      () => false,
    );
    cancelTimer = clock.setTimeout(() => {
      // Stryker disable next-line ConditionalExpression: replacing or closing the socket cancels this timer first.
      if (live !== current) return;
      if (answered) {
        beat(current, heartbeatMs);
        return;
      }
      // Give up on this socket now: the browser may take a minute to notice it is dead, and
      // meanwhile commands would vanish into it. Its close event then changes nothing.
      socket = undefined;
      lost(HEARTBEAT_LOST);
      current.close(HEARTBEAT_LOST, "heartbeat lost");
    }, heartbeatMs);
  }

  /**
   * Opens one socket and runs the handshake.
   *
   * @remarks
   * See `createAtriumClient`.
   *
   * @sideEffects Opens a socket; updates the connection state; schedules timers.
   * @returns The outcome of this attempt.
   */
  function attemptConnection(): Promise<ConnectionState> {
    return new Promise((settle) => {
      const trace = createTrace();
      cancelTimer?.();
      live = undefined;
      // Answers to commands sent on the old socket can no longer arrive.
      failPending();
      socket?.close(1000, "client reconnecting");
      connection.setState({ status: "connecting", traceId: trace.traceId }, true);
      const current = openSocket(options.url);
      socket = current;
      current.addEventListener("open", () => {
        const hello: HelloMessage = {
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          clientId: options.clientId,
          token: options.token,
          traceparent: formatTraceparent(trace),
        };
        current.send(JSON.stringify(hello));
      });
      current.addEventListener("message", (event) => {
        if (socket !== current) return;
        const parsed = HostMessage.safeParse(parseFrame(event.data));
        if (!parsed.success) return;
        if (live === current) {
          receive(parsed.data);
          return;
        }
        if (parsed.data.type !== "welcome") return;
        live = current;
        attempt = 0;
        const { hostVersion, hostInstanceId, heartbeatMs } = parsed.data;
        if (hostInstance !== undefined && hostInstance !== hostInstanceId) loseSessions();
        hostInstance = hostInstanceId;
        // Stryker disable next-line BooleanLiteral: "connected" has every key "connecting" has, so merging equals replacing.
        connection.setState({ status: "connected", traceId: trace.traceId, hostVersion, hostInstanceId }, true);
        beat(current, heartbeatMs);
        subscribeWatched().catch(() => undefined);
        settle(connection.getState());
      });
      current.addEventListener("close", (event) => {
        const ended = closed(current, event.code);
        settle(ended);
      });
    });
  }

  /**
   * Handles a socket closing: rejected, stopped, or dropped and to be retried.
   *
   * @remarks
   * A replaced socket's close changes nothing but its own attempt's outcome.
   *
   * @sideEffects Fails waiting commands; updates the connection state; may schedule a reconnect.
   * @param current - The socket that closed.
   * @param code - Its close code.
   * @returns The outcome to report for that socket's attempt.
   */
  function closed(current: SocketLike, code: number): ConnectionState {
    const reason = REJECTIONS[code];
    if (socket !== current)
      return reason === undefined ? { status: "disconnected", code } : { status: "rejected", reason };
    socket = undefined;
    return lost(code);
  }

  /**
   * Handles losing the current socket: refused, stopped, or dropped and to be retried.
   *
   * @remarks
   * Shared by a close event and by a heartbeat that went unanswered.
   *
   * @sideEffects Fails waiting commands; updates the connection state; may schedule a reconnect.
   * @param code - Why the socket ended.
   * @returns The new connection state.
   */
  function lost(code: number): ConnectionState {
    const reason = REJECTIONS[code];
    live = undefined;
    cancelTimer?.();
    failPending();
    if (reason !== undefined) {
      connection.setState({ status: "rejected", reason }, true);
    } else if (stopped || delays.length === 0) {
      connection.setState({ status: "disconnected", code }, true);
    } else {
      attempt += 1;
      connection.setState({ status: "reconnecting", attempt, code }, true);
      const delay = delays[Math.min(attempt, delays.length) - 1] ?? 0;
      cancelTimer = clock.setTimeout(() => {
        // Fire and forget: the outcome lands in the connection store.
        void attemptConnection();
      }, delay);
    }
    return connection.getState();
  }

  return {
    connection,
    connect() {
      stopped = false;
      attempt = 0;
      return attemptConnection();
    },
    disconnect() {
      stopped = true;
      cancelTimer?.();
      if (socket !== undefined) {
        socket.close(1000, "client closed");
        return;
      }
      // Waiting to reconnect: no socket will close, so nothing else would end the wait.
      if (connection.getState().status === "reconnecting")
        connection.setState({ status: "disconnected", code: 1000 }, true);
    },
    session: (sessionId) => views.get(sessionId),
    async watch(sessionIds) {
      watched = [...new Set(sessionIds)];
      for (const sessionId of views.keys()) if (!watched.includes(sessionId)) views.delete(sessionId);
      for (const sessionId of watched)
        if (!views.has(sessionId))
          views.set(
            sessionId,
            createStore(() => loadingView(sessionId)),
          );
      if (live !== undefined) await request("subscribe_sessions", { sessionIds: [...watched] });
    },
    createChat: () => request("create_chat", {}),
    listRecentSessions: (limit) => request("list_recent_sessions", { limit }),
    openSession: (sessionId) => request("open_session", { sessionId }),
    async prompt(sessionId, text) {
      const requestId = `${options.clientId}-${++nextRequest}`;
      const view = views.get(sessionId);
      const shown = { clientMessageId: requestId, text };
      view?.setState({ pending: [...view.getState().pending, shown] });
      /**
       * Takes the optimistic copy back out.
       *
       * @remarks
       * pi will never echo a message it rejected or an extension consumed.
       *
       * @sideEffects Updates the session's view.
       */
      const withdraw = (): void =>
        view?.setState({ pending: view.getState().pending.filter((item) => item !== shown) });
      try {
        const result = await request("prompt", { sessionId, text }, requestId);
        // An extension consumed it; pi never echoes it.
        if (result.disposition === "handled") withdraw();
        return result;
      } catch (error) {
        withdraw();
        throw error;
      }
    },
    loadOlder(sessionId) {
      const going = olderLoading.get(sessionId);
      if (going !== undefined) return going;
      const view = views.get(sessionId);
      if (view === undefined) return Promise.resolve();
      const state = view.getState();
      const before = state.items[0]?.id;
      // A view still loading has no items, so nothing to fetch before.
      if (before === undefined || !state.hasOlder || state.status === "lost") return Promise.resolve();
      /**
       * Fetches one page and puts it in front of the view's items.
       *
       * @remarks
       * When the host rebuilt the transcript, a fresh snapshot replaces what the view has.
       *
       * @sideEffects Sends `fetch_transcript`, or `subscribe_sessions` to resync; updates the view.
       */
      const fetchPage = async (): Promise<void> => {
        try {
          const page = await request("fetch_transcript", {
            sessionId,
            epoch: state.epoch,
            before,
            limit: OLDER_PAGE_ITEMS,
          });
          view.setState(prependOlder(view.getState(), page, state.epoch, before));
        } catch (error) {
          if (!(error instanceof CommandError && error.code === "transcript_changed")) throw error;
          await resync(sessionId);
        }
      };
      const fetching = fetchPage().finally(() => olderLoading.delete(sessionId));
      olderLoading.set(sessionId, fetching);
      return fetching;
    },
    async loadStep(sessionId, turnId, stepId) {
      const view = views.get(sessionId);
      if (view === undefined) return;
      const state = view.getState();
      if (state.status === "loading" || state.status === "lost") return;
      try {
        const { step } = await request("fetch_step", { sessionId, epoch: state.epoch, turnId, stepId });
        view.setState(withWholeStep(view.getState(), turnId, step, state.epoch));
      } catch (error) {
        // The host rebuilt the transcript; a fresh snapshot replaces what the view has.
        if (!(error instanceof CommandError && error.code === "transcript_changed")) throw error;
        await resync(sessionId);
      }
    },
    async reportIssue(kind, message, details) {
      await request("report_client_issue", {
        kind,
        message: message.slice(0, MAX_ISSUE_LENGTH),
        ...(details === undefined ? {} : { details: details.slice(0, MAX_ISSUE_LENGTH) }),
      });
    },
  };
}
