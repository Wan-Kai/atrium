import { type RawData, WebSocket } from "ws";
import { type Clock, trackedTimeout } from "../platform/clock";
import type { Logger } from "../platform/logger";
import type { ResourceTracker } from "../platform/resources";
import type { RelayEndpoint } from "./relay-line";

/** Why the last attempt to reach the relay failed. */
export type RelayError = "relay_unreachable" | "relay_rejected";

/** The control connection as the "手机" page shows it. */
export interface LinkState {
  readonly status: "connecting" | "connected" | "error";
  readonly error: RelayError | null;
  readonly lastConnectedAt: number | null;
}

/** What a relay link needs. */
export interface RelayLinkOptions {
  readonly endpoint: RelayEndpoint;
  readonly clock: Clock;
  readonly resources: ResourceTracker;
  readonly logger: Logger;
  /** Told every change of the link's state. */
  readonly onState: (state: LinkState) => void;
  /** Told each phone the relay announces. */
  readonly onStream: (streamId: string) => void;
}

/** The first reconnect waits this long, doubling each time up to `MAX_BACKOFF_MS` (SPEC-0005, "宿主"). */
const FIRST_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
/** The relay must answer `ready` this soon after the connection opens. */
export const READY_TIMEOUT_MS = 10_000;
/** How often the host pings the control connection; an unanswered ping by the next one drops it. */
export const LINK_PING_MS = 30_000;
/** The relay's close code for a host it does not accept (SPEC-0005, "关闭码"). */
const UNAUTHORIZED = 4401;
/** A relay stream id: 128 random bits in hex. */
const STREAM_ID = /^[0-9a-f]{32}$/;

/**
 * The host's control connection to its relay: connects, proves itself, hears of phones and
 * reconnects when it drops.
 *
 * @remarks
 * SPEC-0005, "relay 的线路协议" and "MP3a 定的细节". The host only connects out; the relay never
 * sees content. A dropped or refused connection is tried again after 1 s, doubling up to 60 s, and
 * the wait starts over once the relay said `ready`. The host pings every 30 s and drops a
 * connection whose last ping went unanswered, since a network that vanished closes nothing. The
 * open connection counts as `remote.control`, every timer as `timer`, so leak tests see them.
 *
 * @sideEffects Connects to the relay once started; schedules timers; logs connection outcomes.
 */
export class RelayLink {
  readonly #options: RelayLinkOptions;
  #socket: WebSocket | null = null;
  #stopped = true;
  #backoff = FIRST_BACKOFF_MS;
  #lastConnectedAt: number | null = null;
  #state: LinkState = { status: "connecting", error: null, lastConnectedAt: null };
  #cancelRetry: (() => void) | null = null;
  #closed: Promise<void> = Promise.resolve();
  #waiters: ((state: LinkState) => void)[] = [];
  #checking: Promise<RelayError | null> | null = null;

  /**
   * Makes a link; nothing connects until `start`.
   *
   * @remarks
   * One link per relay line; a new line makes a new link.
   *
   * @sideEffects none
   * @param options - Where to connect and whom to tell.
   */
  constructor(options: RelayLinkOptions) {
    this.#options = options;
  }

  /**
   * The link's state now.
   *
   * @remarks
   * `connecting` until the first attempt ends.
   *
   * @sideEffects none
   * @returns The state.
   */
  get state(): LinkState {
    return this.#state;
  }

  /**
   * Connects, and keeps reconnecting until `stop`.
   *
   * @remarks
   * Starting a started link does nothing.
   *
   * @sideEffects Opens the control connection.
   */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  /**
   * Connects again now, with the wait reset, and tells how the attempt went.
   *
   * @remarks
   * For `test_relay` while remote access is on (SPEC-0005, "MP3a 定的细节"). A link that is
   * connected waits for a fresh pong on the same socket, without displacing any phone.
   *
   * @sideEffects May drop the waiting retry and connect now.
   * @returns `null` once connected, or why not.
   */
  retryNow(): Promise<RelayError | null> {
    if (this.#stopped) return Promise.resolve("relay_unreachable");
    if (this.#state.status === "connected") {
      if (this.#socket?.readyState !== WebSocket.OPEN) return Promise.resolve("relay_unreachable");
      this.#checking ??= this.#checkPong(this.#socket).finally(() => {
        this.#checking = null;
      });
      return this.#checking;
    }
    const settled = new Promise<RelayError | null>((resolve) => {
      this.#waiters.push((state) => resolve(state.status === "connected" ? null : state.error));
    });
    this.#backoff = FIRST_BACKOFF_MS;
    if (this.#socket === null && !this.#stopped) {
      this.#cancelRetry?.();
      this.#cancelRetry = null;
      this.#connect();
    }
    return settled;
  }

  /**
   * Verifies a live control connection without dropping its data streams.
   * @remarks Concurrent checks share a fresh ping; shutdown or the ten-second deadline settles them.
   * @sideEffects Sends a ping and owns two listeners and a tracked deadline until settled.
   * @param socket - The currently open control connection.
   * @returns Null for a pong, otherwise a relay failure code.
   */
  #checkPong(socket: WebSocket): Promise<RelayError | null> {
    return new Promise((resolve) => {
      const cancel = trackedTimeout(
        this.#options.clock,
        this.#options.resources,
        () => socket.terminate(),
        READY_TIMEOUT_MS,
      );
      /**
       * Releases the check before answering it.
       * @remarks Both pong and close must remove the other's listener.
       * @sideEffects Cancels the deadline and removes listeners.
       * @param result - Verified success or close failure.
       */
      const finish = (result: RelayError | null): void => {
        cancel();
        socket.off("pong", pong);
        socket.off("close", closed);
        resolve(result);
      };
      /** Answers a successful check. @remarks A fresh pong proves the relay is reachable. @sideEffects Settles and cleans the check. */
      const pong = (): void => finish(null);
      /**
       * Answers a closed check.
       * @remarks Authentication rejection is distinct from network loss.
       * @sideEffects Settles and cleans the check.
       * @param code - Relay close code.
       */
      const closed = (code: number): void => finish(code === UNAUTHORIZED ? "relay_rejected" : "relay_unreachable");
      socket.once("pong", pong);
      socket.once("close", closed);
      socket.ping();
    });
  }

  /**
   * Tells the relay to drop a phone's stream.
   *
   * @remarks
   * When the host already has as many handshakes under way as it allows (SPEC-0005, "宿主自己也设限").
   *
   * @sideEffects Sends a `refuse`.
   * @param streamId - The stream.
   */
  refuse(streamId: string): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify({ type: "refuse", streamId }));
    }
  }

  /**
   * Closes the control connection and stops reconnecting.
   *
   * @remarks
   * Data connections are the channels' own; their owner closes them.
   *
   * @sideEffects Closes the socket; cancels the retry; tells waiting callers it failed.
   * @returns Once the socket has closed.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    this.#socket?.terminate();
    await this.#closed;
    for (const waiter of this.#waiters.splice(0))
      waiter({ ...this.#state, status: "error", error: "relay_unreachable" });
  }

  /**
   * One attempt: open, say hello, wait for `ready`, then listen for phones.
   *
   * @remarks
   * See the class.
   *
   * @sideEffects Opens a socket; schedules its timers; logs.
   */
  #connect(): void {
    const { endpoint, clock, resources, logger } = this.#options;
    this.#setState({ status: "connecting", error: this.#state.error, lastConnectedAt: this.#lastConnectedAt });
    const socket = new WebSocket(`${endpoint.url}/v1/host`, { perMessageDeflate: false, maxPayload: 70 * 1024 });
    this.#socket = socket;
    const release = resources.acquire("remote.control");
    let ready = false;
    let answered = true;
    let cancelPing: (() => void) | null = null;
    const cancelReady = trackedTimeout(
      clock,
      resources,
      () => {
        logger.warn({ host_id: endpoint.hostId }, "relay did not say ready in time");
        socket.terminate();
      },
      READY_TIMEOUT_MS,
    );

    /**
     * Pings the relay, or drops the connection when the last ping went unanswered.
     *
     * @remarks
     * See the class.
     *
     * @sideEffects Pings or terminates; schedules the next ping.
     */
    const ping = (): void => {
      if (!answered) {
        logger.warn({ host_id: endpoint.hostId }, "relay did not answer a ping");
        socket.terminate();
        return;
      }
      answered = false;
      socket.ping();
      cancelPing = trackedTimeout(clock, resources, ping, LINK_PING_MS);
    };

    const closed = Promise.withResolvers<void>();
    this.#closed = closed.promise;
    socket.on("open", () => {
      socket.send(JSON.stringify({ v: 1, type: "hello", hostId: endpoint.hostId, token: endpoint.token }));
    });
    socket.on("pong", () => {
      answered = true;
    });
    socket.on("message", (data: RawData, isBinary: boolean) => {
      const message = isBinary ? null : parseControl(data);
      if (message?.type === "ready" && !ready) {
        ready = true;
        cancelReady();
        this.#backoff = FIRST_BACKOFF_MS;
        this.#lastConnectedAt = clock.now();
        logger.info({ host_id: endpoint.hostId }, "relay connected");
        this.#setState({ status: "connected", error: null, lastConnectedAt: this.#lastConnectedAt });
        cancelPing = trackedTimeout(clock, resources, ping, LINK_PING_MS);
      } else if (
        message?.type === "open" &&
        ready &&
        typeof message.streamId === "string" &&
        STREAM_ID.test(message.streamId)
      ) {
        this.#options.onStream(message.streamId);
      }
    });
    // Errors are followed by `close`, which decides what happens next.
    socket.on("error", () => {});
    socket.once("close", (code: number) => {
      cancelReady();
      cancelPing?.();
      release();
      this.#socket = null;
      const error: RelayError = code === UNAUTHORIZED ? "relay_rejected" : "relay_unreachable";
      logger.info({ host_id: endpoint.hostId, code, ready }, "relay connection closed");
      if (!this.#stopped) {
        this.#setState({ status: "error", error, lastConnectedAt: this.#lastConnectedAt });
        const wait = this.#backoff;
        this.#backoff = Math.min(this.#backoff * 2, MAX_BACKOFF_MS);
        this.#cancelRetry = trackedTimeout(
          clock,
          resources,
          () => {
            this.#cancelRetry = null;
            this.#connect();
          },
          wait,
        );
      }
      closed.resolve();
    });
  }

  /**
   * Keeps and reports a new state, settling whoever waits for an attempt's end.
   *
   * @remarks
   * `connecting` is not an end.
   *
   * @sideEffects Calls `onState`; settles waiting `retryNow` calls.
   * @param state - The new state.
   */
  #setState(state: LinkState): void {
    this.#state = state;
    this.#options.onState(state);
    if (state.status !== "connecting") for (const waiter of this.#waiters.splice(0)) waiter(state);
  }
}

/**
 * Parses a text frame of the control connection.
 *
 * @remarks
 * The relay sends `ready` and `open`; anything else is ignored rather than trusted.
 *
 * @sideEffects none
 * @param data - The frame.
 * @returns The object, or `null`.
 */
function parseControl(data: RawData): Record<string, unknown> | null {
  try {
    const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    const value: unknown = JSON.parse(buffer.toString("utf8"));
    return typeof value === "object" && value !== null ? { ...value } : null;
  } catch {
    return null;
  }
}

/**
 * Connects once with a relay line and says whether the relay accepts it, then closes.
 *
 * @remarks
 * `test_relay` while remote access is off (SPEC-0005, "部署 relay" item 5). A fresh control
 * connection would push out the host's own if one were open, so this is only used when none is.
 *
 * @sideEffects Opens and closes a connection; schedules the time limit.
 * @param endpoint - The relay.
 * @param options - Clock and resources.
 * @returns `null` when the relay said `ready`, else why not.
 */
export function probeRelay(
  endpoint: RelayEndpoint,
  options: { readonly clock: Clock; readonly resources: ResourceTracker; readonly signal: AbortSignal },
): Promise<RelayError | null> {
  if (options.signal.aborted) return Promise.resolve("relay_unreachable");
  return new Promise((resolve) => {
    const socket = new WebSocket(`${endpoint.url}/v1/host`, { perMessageDeflate: false, maxPayload: 70 * 1024 });
    const release = options.resources.acquire("remote.control");
    let result: RelayError | null = "relay_unreachable";
    const cancel = trackedTimeout(options.clock, options.resources, () => socket.terminate(), READY_TIMEOUT_MS);
    /** Ends an abandoned probe. @remarks Prevents a late authentication from evicting the active link. @sideEffects Terminates the socket. */
    const abort = (): void => socket.terminate();
    options.signal.addEventListener("abort", abort, { once: true });
    socket.on("open", () => {
      socket.send(JSON.stringify({ v: 1, type: "hello", hostId: endpoint.hostId, token: endpoint.token }));
    });
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary || parseControl(data)?.type !== "ready") return;
      result = null;
      socket.terminate();
    });
    socket.on("error", () => {});
    socket.once("close", (code: number) => {
      cancel();
      options.signal.removeEventListener("abort", abort);
      release();
      resolve(result === null ? null : code === UNAUTHORIZED ? "relay_rejected" : "relay_unreachable");
    });
  });
}
