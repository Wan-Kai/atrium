import { CommandError, type ProxySetting } from "@atrium/protocol";
import { EnvHttpProxyAgent, fetch as proxiedFetch } from "undici";

/** Hosts that never go through the set proxy: pi reaching services on this machine (security.md). */
const LOOPBACK = ["localhost", "127.0.0.1", "::1"];

/** Why a proxy setting is refused, as `proxy_invalid` says (SPEC-0001, "设置 · 接口"). */
export type ProxyProblem = "malformed" | "scheme" | "credentials" | "no_proxy";

/** A `fetch` for the host's own requests, as much of it as they use. */
export type HttpFetch = (
  url: string | URL,
  init: { readonly headers?: Record<string, string>; readonly redirect: "manual"; readonly signal: AbortSignal },
) => Promise<Response>;

/**
 * Says what is wrong with a proxy setting, if anything.
 *
 * @remarks
 * Only `http` and `https` addresses of a host and port: a user name or password would sit in pi's
 * environment, where the log's redaction does not look for it (security.md). A host that goes
 * direct is one entry, so it holds no space or comma, which would split it.
 *
 * @sideEffects none
 * @param proxy - The setting.
 * @returns The problem, or `null` when there is none.
 */
export function proxyProblem(proxy: ProxySetting): ProxyProblem | null {
  let url: URL;
  try {
    url = new URL(proxy.url);
  } catch {
    return "malformed";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "scheme";
  if (url.username !== "" || url.password !== "") return "credentials";
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return "malformed";
  if (proxy.noProxy.some((host) => host === "" || /[\s,]/u.test(host))) return "no_proxy";
  return null;
}

/**
 * Checks a proxy setting and writes its address in one form.
 *
 * @remarks
 * The address keeps only its scheme, host and port, so what reaches pi has no stray space or
 * slash (SPEC-0001, "设置 · 接口").
 *
 * @sideEffects none
 * @param proxy - The setting a client sent.
 * @returns The setting to keep.
 * @throws {CommandError} `proxy_invalid`, with `params.reason`, when it is refused.
 */
export function checkProxy(proxy: ProxySetting): ProxySetting {
  const problem = proxyProblem(proxy);
  if (problem !== null) throw new CommandError("proxy_invalid", { reason: problem });
  return { url: new URL(proxy.url).origin, noProxy: proxy.noProxy };
}

/**
 * The environment with the set proxy in place of the login shell's.
 *
 * @remarks
 * Both cases of each name, since tools read one or the other (curl only the lower case of
 * `http_proxy`). The hosts that go direct always include this machine's (SPEC-0001, "设置 · pi").
 * With no proxy set the environment stays as the login shell gave it.
 *
 * @sideEffects none
 * @param env - The tools' environment.
 * @param proxy - The setting, `null` for none.
 * @returns The environment to hand on.
 */
export function proxyEnvironment(
  env: Readonly<Record<string, string>>,
  proxy: ProxySetting | null,
): Readonly<Record<string, string>> {
  if (proxy === null) return env;
  const noProxy = [...new Set([...LOOPBACK, ...proxy.noProxy])].join(",");
  return {
    ...env,
    HTTPS_PROXY: proxy.url,
    https_proxy: proxy.url,
    HTTP_PROXY: proxy.url,
    http_proxy: proxy.url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

/**
 * Whether an environment names a proxy.
 *
 * @remarks
 * For the log, which says where the proxy comes from and never what it is (security.md).
 *
 * @sideEffects none
 * @param env - The environment.
 * @returns Whether any of the proxy variables is set.
 */
export function hasProxy(env: Readonly<Record<string, string>>): boolean {
  return ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].some((name) => Boolean(env[name]));
}

/**
 * Runs the host's own requests through the proxy an environment names, as pi's would go.
 *
 * @remarks
 * pi sends its requests through undici's `EnvHttpProxyAgent`; the host does the same with the
 * environment it hands pi, not its own, which a Finder launch leaves without the shell's proxy
 * (SPEC-0001, "第 1 步：安装 pi"). The agent is closed once `use` settles, so no connection
 * outlives the requests.
 *
 * @sideEffects Opens connections while `use` runs; closes them after.
 * @param env - The environment, with or without proxy variables.
 * @param use - Makes the requests with the `fetch` it is given.
 * @returns What `use` returns.
 */
export async function withProxy<T>(
  env: Readonly<Record<string, string>>,
  use: (fetch: HttpFetch) => Promise<T>,
): Promise<T> {
  // Empty rather than absent, so undici never falls back to the host's own environment.
  const agent = new EnvHttpProxyAgent({
    httpProxy: env["http_proxy"] ?? env["HTTP_PROXY"] ?? "",
    httpsProxy: env["https_proxy"] ?? env["HTTPS_PROXY"] ?? "",
    noProxy: env["no_proxy"] ?? env["NO_PROXY"] ?? "",
  });
  try {
    return await use((url, init) => proxiedFetch(url, { ...init, dispatcher: agent }));
  } finally {
    await agent.destroy();
  }
}
