import type { ClientRequest, IncomingMessage } from "node:http";
import { isIP, type Socket } from "node:net";
import { TLSSocket } from "node:tls";
import type { RemoteDiagnosticCheck, RemoteDiagnosticFailure, RemoteRelayDiagnostics } from "@atrium/protocol";
import type { Clock } from "../platform/clock";

const TLS_ERRORS = new Set([
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_SIGNATURE_FAILURE",
  "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
]);
const CONNECT_ERRORS = new Set(["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL", "EACCES", "EPERM"]);

/**
 * Collects bounded evidence from one actual relay connection attempt.
 * @remarks It observes public request/socket events, never changes TLS validation or owns request termination.
 * @sideEffects Registers listeners until finish or dispose; no extra probes or timers.
 */
export class RelayDiagnostics {
  readonly #clock: Clock;
  readonly #url: URL;
  readonly #cleanup: (() => void)[] = [];
  #network: RemoteDiagnosticCheck = "unknown";
  #resolution: RemoteDiagnosticCheck;
  #tls: RemoteDiagnosticCheck;
  #failure: RemoteDiagnosticFailure | null = null;
  #disposed = false;
  #upgradeSeen = false;
  #opened = false;

  /** Creates an attempt collector. @remarks IP literals and ws require no lookup or TLS. @sideEffects none */
  constructor(url: string, clock: Clock) {
    this.#url = new URL(url);
    this.#clock = clock;
    this.#resolution = isIP(this.#url.hostname.replace(/^\[|\]$/g, "")) === 0 ? "unknown" : "not_applicable";
    this.#tls = this.#url.protocol === "ws:" ? "not_applicable" : "unknown";
  }

  /**
   * Observes the request supplied by ws's public finishRequest hook.
   * @remarks The hook's caller must still call request.end(); observing response does not take over ws's rejection handling.
   * @sideEffects Adds request and socket listeners, all removed by dispose.
   * @param request - The actual outbound request supplied by ws.
   */
  observe(request: ClientRequest): void {
    if (this.#disposed) return;
    /** Observes socket establishment. @remarks No private ws fields are read. @sideEffects Registers socket listeners.
     * @param socket - The assigned socket.
     */
    const onSocket = (socket: Socket): void => this.#observeSocket(socket);
    /** Records explicit request failures. @remarks Error text is never retained. @sideEffects Updates this attempt's evidence.
     * @param error - The native request error.
     */
    const onError = (error: Error): void => this.#error(error);
    /** Records a non-upgrade HTTP response. @remarks It proves no token decision. @sideEffects Updates this attempt's failure.
     * @param _response - An HTTP response, not a successful upgrade.
     */
    const onResponse = (_response: IncomingMessage): void => {
      this.#failure = "websocket_upgrade_failed";
    };
    /** Records entry into WebSocket upgrade validation. @remarks ws may reject a malformed 101 without a request error. @sideEffects Records this attempt's stage. */
    const onUpgrade = (): void => {
      this.#upgradeSeen = true;
    };
    request.on("socket", onSocket);
    // ws can emit close synchronously from its request handlers; capture evidence before it finalizes the check.
    request.prependListener("error", onError);
    request.prependListener("response", onResponse);
    request.prependListener("upgrade", onUpgrade);
    this.#cleanup.push(() => {
      request.off("socket", onSocket);
      request.off("error", onError);
      request.off("response", onResponse);
      request.off("upgrade", onUpgrade);
    });
  }

  /** Records a validated WebSocket upgrade. @remarks A 101 response alone is insufficient. @sideEffects Advances this attempt's evidence unless disposed. */
  opened(): void {
    if (!this.#disposed) this.#opened = true;
  }

  /** Records the overall deadline. @remarks A timeout proves no particular stage failed. @sideEffects Updates the failure category. */
  timeout(): void {
    this.#failure ??= "timeout";
  }

  /**
   * Ends an attempt with its safe evidence snapshot.
   * @remarks Ready and 4401 are relay-protocol evidence; unfinished stages stay unknown.
   * @sideEffects Removes every observational listener.
   * @param error - The final control-handshake outcome.
   */
  finish(error: "relay_unreachable" | "relay_rejected" | null): RemoteRelayDiagnostics {
    this.dispose();
    return {
      kind: "connect",
      checkedAt: this.#clock.now(),
      network: this.#network,
      resolution: this.#resolution,
      tls: this.#tls,
      token: error === null ? "passed" : error === "relay_rejected" ? "failed" : "unknown",
      failure:
        error === null
          ? null
          : error === "relay_rejected"
            ? "token_rejected"
            : (this.#failure ??
              (this.#upgradeSeen && !this.#opened ? "websocket_upgrade_failed" : "connection_closed")),
    };
  }

  /** Releases observations without publishing a cancelled result. @remarks Safe to call more than once. @sideEffects Removes listeners. */
  dispose(): void {
    this.#disposed = true;
    for (const release of this.#cleanup.splice(0)) release();
  }

  /** Observes one assigned socket. @remarks Only verified secureConnect counts as TLS success. @sideEffects Adds listeners and records evidence.
   * @param socket - The actual connection socket.
   */
  #observeSocket(socket: Socket): void {
    if (this.#disposed) return;
    /** Records address resolution. @remarks Lookup errors do not establish Internet availability. @sideEffects Updates resolution evidence.
     * @param error - The resolver result.
     */
    const lookup = (error: Error | null): void => {
      this.#resolution = error === null ? "passed" : "failed";
      if (error !== null) this.#failure = "resolution_failed";
    };
    /** Records TCP connectivity. @remarks This says nothing about other Internet destinations. @sideEffects Updates network evidence. */
    const connect = (): void => {
      this.#network = "passed";
    };
    /** Records authenticated TLS establishment. @remarks Never accepts a socket with bypassed certificate validation. @sideEffects Updates TLS evidence. */
    const secure = (): void => {
      if (socket instanceof TLSSocket && socket.authorized) this.#tls = "passed";
    };
    socket.on("lookup", lookup);
    socket.on("connect", connect);
    socket.on("secureConnect", secure);
    this.#cleanup.push(() => {
      socket.off("lookup", lookup);
      socket.off("connect", connect);
      socket.off("secureConnect", secure);
    });
  }

  /** Classifies explicit error codes. @remarks Resets and generic timeouts are not evidence of a failed network or TLS stage. @sideEffects Updates evidence.
   * @param error - The native error, never exposed as text.
   */
  #error(error: Error): void {
    if (this.#failure !== null) return;
    const code: unknown = Reflect.get(error, "code");
    if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_FAIL") {
      this.#resolution = "failed";
      this.#failure = "resolution_failed";
    } else if (typeof code === "string" && code.startsWith("HPE_")) {
      this.#failure = "websocket_upgrade_failed";
    } else if (typeof code === "string" && TLS_ERRORS.has(code)) {
      this.#tls = "failed";
      this.#failure = "tls_failed";
    } else {
      const errors: unknown = Reflect.get(error, "errors");
      const causes: unknown[] = Array.isArray(errors) && errors.length > 0 ? errors : [error];
      const refused = causes.every((cause) => {
        if (!(cause instanceof Error)) return false;
        const causeCode: unknown = Reflect.get(cause, "code");
        return (
          Reflect.get(cause, "syscall") === "connect" && typeof causeCode === "string" && CONNECT_ERRORS.has(causeCode)
        );
      });
      if (this.#network !== "passed" && refused) {
        this.#network = "failed";
        this.#failure = "tcp_connect_failed";
      } else this.#failure = "unknown";
    }
  }
}

/**
 * Describes one correlated pong check on an existing control socket.
 * @remarks DNS, TLS and token acceptance were not retested; inapplicable stages remain inapplicable.
 * @sideEffects none
 * @param url - The configured relay URL.
 * @param clock - The host's injected clock.
 * @param failure - The correlated ping's safe outcome.
 */
export function liveDiagnostics(
  url: string,
  clock: Clock,
  failure: "token_rejected" | "timeout" | "connection_closed" | null,
): RemoteRelayDiagnostics {
  const endpoint = new URL(url);
  return {
    kind: "live",
    checkedAt: clock.now(),
    network: failure === null ? "passed" : "unknown",
    resolution: isIP(endpoint.hostname.replace(/^\[|\]$/g, "")) === 0 ? "unknown" : "not_applicable",
    tls: endpoint.protocol === "ws:" ? "not_applicable" : "unknown",
    token: "unknown",
    failure,
  };
}
