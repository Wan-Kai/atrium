import type { Agent } from "node:http";
import type { ProxySetting } from "@atrium/protocol";
import { HttpsProxyAgent } from "https-proxy-agent";

/** The proxy the host's connections to the relay may go through. */
export interface RelayProxy {
  /** `http://` or `https://` host and port, as the proxy setting keeps it. */
  readonly url: string;
  /** Hosts that go direct. */
  readonly noProxy: readonly string[];
}

/** Hosts that are this machine: a relay there is never reached through a proxy. */
const LOOPBACK = ["localhost", "127.0.0.1", "::1"];

/**
 * The proxy for the relay, from the proxy setting.
 *
 * @remarks
 * SPEC-0005, "连 relay 走代理": the setting pi uses too, and only it; the login shell's proxy is
 * known only once the tools are found, which connecting to the relay should not wait for.
 *
 * @sideEffects none
 * @param setting - The proxy setting, `null` for none.
 * @returns The proxy, or `null` to go direct.
 */
export function relayProxy(setting: ProxySetting | null): RelayProxy | null {
  return setting === null ? null : { url: setting.url, noProxy: [...LOOPBACK, ...setting.noProxy] };
}

/** Which way a connection to the relay goes. */
export type RelayVia = "proxy" | "direct";

/**
 * Whether a host is in a no-proxy list.
 *
 * @remarks
 * As curl and undici read `NO_PROXY`: an entry matches the host itself and its subdomains, with
 * or without a leading dot; `*` matches every host. Brackets around an IPv6 address are ignored.
 *
 * @sideEffects none
 * @param host - The host, as `URL.hostname` gives it.
 * @param noProxy - The entries.
 * @returns Whether the host goes direct.
 */
export function bypasses(host: string, noProxy: readonly string[]): boolean {
  const bare = host.replace(/^\[|\]$/gu, "").toLowerCase();
  return noProxy.some((entry) => {
    const domain = entry
      .replace(/^\[|\]$/gu, "")
      .replace(/^\./u, "")
      .toLowerCase();
    return domain === "*" || bare === domain || bare.endsWith(`.${domain}`);
  });
}

/**
 * The `ws` option that sends a socket the way a route chose.
 *
 * @remarks
 * No option at all for direct, so `ws` uses its own default agent.
 *
 * @sideEffects none
 * @param route - The route, if any.
 * @returns `{ agent }` through the proxy, or nothing.
 */
export function socketAgent(route: RelayRoute | undefined): { agent?: Agent } {
  const agent = route?.agent();
  return agent === undefined ? {} : { agent };
}

/**
 * Chooses, for each attempt of the control connection, whether the relay is reached through the
 * proxy, and lends that choice to the data connections.
 *
 * @remarks
 * SPEC-0005, "连 relay 走代理": through the proxy whenever one is set and the relay's host is not
 * in its no-proxy list, except for the one attempt after an attempt through it failed, so a proxy
 * that is not running costs one quick failure. TLS to the relay runs inside the `CONNECT` tunnel
 * and still checks the relay's certificate (security.md).
 *
 * @sideEffects none until used; the agent opens connections when a socket uses it.
 */
export class RelayRoute {
  readonly #proxy: () => RelayProxy | null;
  #via: RelayVia = "direct";
  #proxyFailed = false;
  #agent: Agent | undefined;

  /**
   * Makes a route that reads the proxy afresh at every attempt.
   *
   * @remarks
   * The proxy setting can change while the host runs.
   *
   * @sideEffects none
   * @param proxy - The proxy now, or `null` for none.
   */
  constructor(proxy: () => RelayProxy | null) {
    this.#proxy = proxy;
  }

  /**
   * Which way the latest attempt went.
   *
   * @remarks
   * `direct` before any attempt.
   *
   * @sideEffects none
   * @returns The way.
   */
  get via(): RelayVia {
    return this.#via;
  }

  /**
   * Chooses the way for a new attempt of the control connection.
   *
   * @remarks
   * See the class.
   *
   * @sideEffects Records the choice; makes a new agent for it.
   * @param relayUrl - The relay's address.
   * @returns The way chosen.
   */
  begin(relayUrl: string): RelayVia {
    const proxy = this.#proxy();
    const usable = proxy !== null && !bypasses(new URL(relayUrl).hostname, proxy.noProxy);
    this.#via = usable && !this.#proxyFailed ? "proxy" : "direct";
    this.#proxyFailed = false;
    this.#agent = this.#via === "proxy" && proxy !== null ? new HttpsProxyAgent(proxy.url) : undefined;
    return this.#via;
  }

  /**
   * Notes that the latest attempt ended before the relay said `ready`.
   *
   * @remarks
   * Only an attempt through the proxy sends the next one direct.
   *
   * @sideEffects Records the failure.
   */
  failed(): void {
    if (this.#via === "proxy") this.#proxyFailed = true;
  }

  /**
   * The agent for a socket to the relay, the way the latest attempt went.
   *
   * @remarks
   * `undefined` is direct.
   *
   * @sideEffects none
   * @returns The agent, if through the proxy.
   */
  agent(): Agent | undefined {
    return this.#agent;
  }
}
