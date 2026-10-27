/** Where the host reaches its relay, and how it proves who it is. */
export interface RelayEndpoint {
  /** `wss://<publicHost><pathPrefix>`, or `ws://` for a relay on this machine; no token in it. */
  readonly url: string;
  readonly hostId: string;
  /** The host token; never logged, never sent to a client. */
  readonly token: string;
}

/** Hosts that are this machine, where a relay is reached without TLS (tests, development). */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Reads the line `atrium-relay add-host` printed: `atrium-relay://<hostId>:<token>@<host[:port]>[/prefix]`.
 *
 * @remarks
 * SPEC-0005, "部署 relay" item 4. The relay sits behind a proxy that ends TLS, so every relay is
 * `wss://` except one on this machine (SPEC-0005, "MP3a 定的细节"). The protocol checks the line's
 * shape already; this splits it, and still refuses anything else.
 *
 * @sideEffects none
 * @param line - The line.
 * @returns The endpoint, or `null` when it is not such a line.
 */
export function parseRelayLine(line: string): RelayEndpoint | null {
  const match =
    /^atrium-relay:\/\/(hst_[0-9a-f]{16}):([A-Za-z0-9_-]{43})@((?:[A-Za-z0-9.-]+|\[::1\])(?::\d{1,5})?)((?:\/[A-Za-z0-9._~-]+)*)$/.exec(
      line,
    );
  if (match === null) return null;
  const [, hostId = "", token = "", where = "", prefix = ""] = match;
  const name = where.replace(/:\d+$/, "");
  const url = `${LOOPBACK.has(name) ? "ws" : "wss"}://${where}${prefix}`;
  if (!URL.canParse(url)) return null;
  return { url, hostId, token };
}
