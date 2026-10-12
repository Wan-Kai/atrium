import { once } from "node:events";
import { type Server, createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { CommandError } from "@atrium/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkProxy, hasProxy, proxyEnvironment, proxyProblem, withProxy } from "./proxy";

const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * Starts a server on a free port of 127.0.0.1.
 *
 * @remarks
 * Every server is closed after the test. Idle connections are kept a minute, so one the client
 * leaves open would outlast the test.
 *
 * @sideEffects Listens on a port.
 * @param server - The server.
 * @returns Its address.
 */
async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.keepAliveTimeout = 60_000;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/**
 * A server that answers every request itself, as the site the host asks.
 *
 * @remarks
 * Records its connections, so a test can see them closed.
 *
 * @sideEffects Listens on a port of 127.0.0.1, closed after the test.
 * @returns Its address, the connections made to it, and when each closes.
 */
async function site(): Promise<{
  readonly url: string;
  readonly sockets: Socket[];
  readonly closes: Promise<unknown>[];
}> {
  const sockets: Socket[] = [];
  const closes: Promise<unknown>[] = [];
  const server = createServer((_request, response) => response.end("direct"));
  server.on("connection", (socket) => {
    sockets.push(socket);
    closes.push(once(socket, "close"));
  });
  return { url: await listen(server), sockets, closes };
}

/**
 * A proxy that answers every request itself and refuses every tunnel, recording what it was asked.
 *
 * @remarks
 * It never reaches the site, so no test touches the network: a plain request is answered "proxied",
 * and a tunnel (`CONNECT`, for `https`) is refused once its target is recorded.
 *
 * @sideEffects Listens on a port of 127.0.0.1, closed after the test.
 * @returns Its address and the targets asked for.
 */
async function proxy(): Promise<{ readonly url: string; readonly asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    asked.push(request.url ?? "");
    response.end("proxied");
  });
  server.on("connect", (request, socket: Socket) => {
    asked.push(`CONNECT ${request.url ?? ""}`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  return { url: await listen(server), asked };
}

/**
 * Fetches an address through {@link withProxy}.
 *
 * @remarks
 * The body is read inside, as the host's requests do.
 *
 * @sideEffects Makes an HTTP request.
 * @param env - The environment naming the proxy.
 * @param url - The address.
 * @returns The body.
 */
function fetchText(env: Record<string, string>, url: string): Promise<string> {
  return withProxy(env, async (fetch) => {
    const response = await fetch(url, { redirect: "manual", signal: new AbortController().signal });
    return response.text();
  });
}

describe("proxyProblem", () => {
  it("accepts http and https addresses of a host and port", () => {
    for (const url of ["http://127.0.0.1:7897", "https://proxy.example.com", "http://[::1]:8080/", "HTTP://Proxy:1"]) {
      expect(proxyProblem({ url, noProxy: ["localhost", ".example.com", "10.0.0.0:443", "*"] })).toBeNull();
    }
  });

  it.each([
    ["not an address", "127.0.0.1:7897", "malformed"],
    ["an empty address", "", "malformed"],
    ["a path", "http://127.0.0.1:7897/proxy", "malformed"],
    ["a query", "http://127.0.0.1:7897/?a=1", "malformed"],
    ["a fragment", "http://127.0.0.1:7897/#a", "malformed"],
    ["a socks address", "socks5://127.0.0.1:7897", "scheme"],
    ["a file address", "file:///tmp/proxy", "scheme"],
    ["a user name", "http://me@127.0.0.1:7897", "credentials"],
    ["a password", "http://:secret@127.0.0.1:7897", "credentials"],
  ])("refuses %s", (_name, url, reason) => {
    expect(proxyProblem({ url, noProxy: [] })).toBe(reason);
  });

  it.each([
    ["an empty host", ""],
    ["a space", "a b"],
    ["a tab", "a\tb"],
    ["a comma", "a,b"],
  ])("refuses a host that goes direct with %s", (_name, host) => {
    expect(proxyProblem({ url: "http://127.0.0.1:7897", noProxy: ["localhost", host] })).toBe("no_proxy");
  });
});

describe("checkProxy", () => {
  it("keeps only the scheme, host and port of the address", () => {
    expect(checkProxy({ url: " HTTP://Proxy.Example.com:7897/ ", noProxy: [".example.com"] })).toStrictEqual({
      url: "http://proxy.example.com:7897",
      noProxy: [".example.com"],
    });
  });

  it("refuses with the reason", () => {
    expect(() => checkProxy({ url: "http://me:secret@127.0.0.1:7897", noProxy: [] })).toThrow(
      new CommandError("proxy_invalid", { reason: "credentials" }),
    );
    let thrown: unknown;
    try {
      checkProxy({ url: "http://127.0.0.1:7897", noProxy: [""] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toStrictEqual(new CommandError("proxy_invalid", { reason: "no_proxy" }));
    expect(thrown).toMatchObject({ code: "proxy_invalid", params: { reason: "no_proxy" } });
  });
});

describe("proxyEnvironment", () => {
  it("leaves the environment as it is with no proxy set", () => {
    const env = { PATH: "/bin", HTTPS_PROXY: "http://shell:1" };

    expect(proxyEnvironment(env, null)).toBe(env);
  });

  it("puts the proxy in place of the shell's, in both cases, with this machine always going direct", () => {
    const env = { PATH: "/bin", HTTPS_PROXY: "http://shell:1", no_proxy: "shell.example", ALL_PROXY: "socks5://a:1" };

    expect(
      proxyEnvironment(env, { url: "http://127.0.0.1:7897", noProxy: [".example.com", "localhost", ".example.com"] }),
    ).toStrictEqual({
      PATH: "/bin",
      ALL_PROXY: "socks5://a:1",
      HTTPS_PROXY: "http://127.0.0.1:7897",
      https_proxy: "http://127.0.0.1:7897",
      HTTP_PROXY: "http://127.0.0.1:7897",
      http_proxy: "http://127.0.0.1:7897",
      NO_PROXY: "localhost,127.0.0.1,::1,.example.com",
      no_proxy: "localhost,127.0.0.1,::1,.example.com",
    });
    expect(env).toStrictEqual({
      PATH: "/bin",
      HTTPS_PROXY: "http://shell:1",
      no_proxy: "shell.example",
      ALL_PROXY: "socks5://a:1",
    });
  });
});

describe("hasProxy", () => {
  it("tells whether any proxy variable is set", () => {
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
      expect(hasProxy({ PATH: "/bin", [name]: "http://127.0.0.1:7897" })).toBe(true);
    }
    expect(hasProxy({ PATH: "/bin", HTTPS_PROXY: "", NO_PROXY: "localhost", ALL_PROXY: "socks5://a:1" })).toBe(false);
  });
});

describe("withProxy", () => {
  it("sends requests through the proxy the environment names", async () => {
    const [target, through] = await Promise.all([site(), proxy()]);

    expect(await fetchText({ HTTP_PROXY: through.url }, `${target.url}/latest`)).toBe("proxied");
    expect(through.asked).toStrictEqual([`${target.url}/latest`]);
  });

  it("prefers the lower-case names, as pi's undici does", async () => {
    const [target, lower, upper] = await Promise.all([site(), proxy(), proxy()]);

    expect(await fetchText({ http_proxy: lower.url, HTTP_PROXY: upper.url }, `${target.url}/a`)).toBe("proxied");
    expect(
      await fetchText({ HTTP_PROXY: upper.url, no_proxy: "example.com", NO_PROXY: "127.0.0.1" }, `${target.url}/b`),
    ).toBe("proxied");
    expect(lower.asked).toStrictEqual([`${target.url}/a`]);
    expect(upper.asked).toStrictEqual([`${target.url}/b`]);
  });

  it("tunnels https through the https proxy, falling back to the http one", async () => {
    const [secure, plain] = await Promise.all([proxy(), proxy()]);

    await expect(fetchText({ HTTPS_PROXY: secure.url, HTTP_PROXY: plain.url }, "https://pi.test/a")).rejects.toThrow(
      "fetch failed",
    );
    await expect(fetchText({ HTTP_PROXY: plain.url }, "https://pi.test/b")).rejects.toThrow("fetch failed");
    expect(secure.asked).toStrictEqual(["CONNECT pi.test:443"]);
    expect(plain.asked).toStrictEqual(["CONNECT pi.test:443"]);
  });

  it("goes direct to the hosts that go direct, and with no proxy named, whatever the host's own environment says", async () => {
    const [target, through, hosts] = await Promise.all([site(), proxy(), proxy()]);
    vi.stubEnv("HTTP_PROXY", hosts.url);
    vi.stubEnv("http_proxy", hosts.url);
    vi.stubEnv("NO_PROXY", "");

    expect(await fetchText({ HTTP_PROXY: through.url, NO_PROXY: "localhost,127.0.0.1" }, `${target.url}/a`)).toBe(
      "direct",
    );
    expect(await fetchText({}, `${target.url}/b`)).toBe("direct");
    expect(through.asked).toStrictEqual([]);
    expect(hosts.asked).toStrictEqual([]);
  });

  it("closes its connections once the requests are done, or have failed", async () => {
    const target = await site();

    await fetchText({}, target.url);
    await Promise.all(target.closes);
    await expect(
      withProxy({}, async (fetch) => {
        await fetch(target.url, { redirect: "manual", signal: new AbortController().signal });
        throw new Error("used");
      }),
    ).rejects.toThrow("used");
    await Promise.all(target.closes);

    expect(target.sockets).toHaveLength(2);
    expect(target.sockets.every((socket) => socket.closed)).toBe(true);
  });
});
