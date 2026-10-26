import { once, type EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer, type Socket } from "node:net";
import { FakeClock } from "@atrium/testkit";
import type { RemoteRelayDiagnostics } from "@atrium/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ResourceTracker } from "../platform/resources";
import { RelayDiagnostics, liveDiagnostics } from "./relay-diagnostics";
import { probeRelay, READY_TIMEOUT_MS } from "./relay-link";

const cert = readFileSync(new URL("./fixtures/localhost-cert.pem", import.meta.url));
const key = readFileSync(new URL("./fixtures/localhost-key.pem", import.meta.url));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/** Creates an entirely local relay-shaped TLS/HTTP or stalled TCP endpoint. @remarks No external DNS or server is contacted. @sideEffects Opens a listener, owned until afterEach. */
async function fixture(
  mode: "ready" | "rejected" | "http" | "silent" | "reset" | "bad-accept" | "bad-header" | "closed",
  tls = false,
) {
  const peers = new Set<Socket>();
  const bytes = Promise.withResolvers<void>();
  const http =
    mode === "silent" || mode === "reset" || mode === "bad-accept" || mode === "bad-header"
      ? null
      : tls
        ? createHttpsServer({ cert, key }, (_req, res) => {
            res.writeHead(503);
            res.end("not a token decision");
          })
        : createHttpServer((_req, res) => {
            res.writeHead(503);
            res.end("not a token decision");
          });
  const server =
    http ??
    createTcpServer((socket) => {
      socket.once("data", () => {
        bytes.resolve();
        if (mode === "reset") socket.destroy();
        else if (mode === "bad-accept")
          socket.end(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: invalid\r\n\r\n",
          );
        else if (mode === "bad-header") socket.end("HTTP/1.1 101 Switching Protocols\r\nInvalid Header\r\n\r\n");
      });
    });
  server.on("connection", (socket: Socket) => {
    peers.add(socket);
    socket.on("close", () => peers.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("unexpected local server address");
  const ws =
    (mode === "ready" || mode === "rejected" || mode === "closed") && http !== null
      ? new WebSocketServer({ server: http })
      : null;
  ws?.on("connection", (socket) => {
    socket.once("message", () => {
      if (mode === "ready") socket.send('{"type":"ready"}');
      else socket.close(mode === "closed" ? 1000 : 4401);
    });
  });
  cleanup.push(async () => {
    for (const socket of ws?.clients ?? []) socket.terminate();
    for (const socket of peers) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    ws?.close();
  });
  const clock = new FakeClock(100);
  const resources = new ResourceTracker();
  const controller = new AbortController();
  cleanup.push(async () => {
    controller.abort();
  });
  const results: RemoteRelayDiagnostics[] = [];
  const endpoint = {
    url: `${tls ? "wss" : "ws"}://127.0.0.1:${address.port}`,
    hostId: "hst_0123456789abcdef",
    token: "a".repeat(43),
  };
  const options = {
    clock,
    resources,
    signal: controller.signal,
    onDiagnostics: (value: RemoteRelayDiagnostics) => results.push(value),
  };
  return { endpoint, options, results, controller, clock, resources, bytes: bytes.promise };
}

/** One listener owned by the collector rather than ws or the test harness. */
interface ObservedListener {
  readonly emitter: EventEmitter;
  readonly event: string;
  readonly listener: ReturnType<EventEmitter["listeners"]>[number];
}

/** Runs a real TLS handshake while tracking every collector-owned listener. @remarks Only this test certificate is trusted; hostname verification remains enabled. @sideEffects Opens a TLS client, exchanges relay frames and registers cleanup. @param mode - Trusted, hostname-rejected, or explicitly abandoned observation. */
async function tlsEvidence(mode: "trusted" | "wrong-host" | "cancelled") {
  const f = await fixture("ready", true);
  const url = f.endpoint.url.replace("127.0.0.1", "localhost");
  const diagnostics = new RelayDiagnostics(url, f.clock);
  const owned: ObservedListener[] = [];
  const client = new WebSocket(`${url}/v1/host`, {
    ca: cert,
    family: 4,
    ...(mode === "wrong-host" ? { servername: "wrong.invalid" } : {}),
    finishRequest: (req) => {
      let beforeSocket = new Map<string, ReturnType<EventEmitter["listeners"]>>();
      req.once("socket", (socket) => {
        beforeSocket = new Map(["lookup", "connect", "secureConnect"].map((event) => [event, socket.listeners(event)]));
      });
      const beforeRequest = new Map(
        ["socket", "error", "response", "upgrade"].map((event) => [event, req.listeners(event)]),
      );
      diagnostics.observe(req);
      for (const [event, before] of beforeRequest)
        for (const listener of req.listeners(event))
          if (!before.includes(listener)) owned.push({ emitter: req, event, listener });
      req.once("socket", (socket) => {
        for (const [event, before] of beforeSocket)
          for (const listener of socket.listeners(event))
            if (!before.includes(listener)) owned.push({ emitter: socket, event, listener });
        if (mode === "cancelled") diagnostics.dispose();
      });
      req.end();
    },
  });
  client.on("error", () => {});
  client.on("open", () => diagnostics.opened());
  cleanup.push(async () => {
    diagnostics.dispose();
    if (client.readyState === WebSocket.CLOSED) return;
    const closed = once(client, "close");
    client.terminate();
    await closed;
  });
  if (mode === "wrong-host") {
    await new Promise<void>((resolve) => client.once("close", () => resolve()));
    return { owned, message: null, snapshot: diagnostics.finish("relay_unreachable") };
  }
  await once(client, "open");
  const ready = once(client, "message");
  client.send('{"type":"hello"}');
  const [message] = await ready;
  return {
    owned,
    message: message.toString() as string,
    snapshot: mode === "trusted" ? diagnostics.finish(null) : null,
  };
}

describe("actual relay connection evidence", () => {
  it.each([
    { mode: "bad-accept", failure: "websocket_upgrade_failed" },
    { mode: "bad-header", failure: "websocket_upgrade_failed" },
    { mode: "closed", failure: "connection_closed" },
  ] as const)("classifies $mode before relay ready without inventing token evidence", async ({ mode, failure }) => {
    const f = await fixture(mode);
    expect(await probeRelay(f.endpoint, f.options)).toBe("relay_unreachable");
    expect(f.results).toStrictEqual([
      {
        kind: "connect",
        checkedAt: 100,
        network: "passed",
        resolution: "not_applicable",
        tls: "not_applicable",
        token: "unknown",
        failure,
      },
    ]);
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
  });

  it.each([
    { mode: "ready", error: null, token: "passed", failure: null },
    { mode: "rejected", error: "relay_rejected", token: "failed", failure: "token_rejected" },
    { mode: "http", error: "relay_unreachable", token: "unknown", failure: "websocket_upgrade_failed" },
  ] as const)("distinguishes $mode from an address or TLS failure", async ({ mode, error, token, failure }) => {
    const f = await fixture(mode);
    expect(await probeRelay(f.endpoint, f.options)).toBe(error);
    expect(f.results).toStrictEqual([
      {
        kind: "connect",
        checkedAt: 100,
        network: "passed",
        resolution: "not_applicable",
        tls: "not_applicable",
        token,
        failure,
      },
    ]);
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
  });

  it("reports a refused local TCP connection, not a global Internet outage", async () => {
    const clock = new FakeClock(20);
    const resources = new ResourceTracker();
    const results: RemoteRelayDiagnostics[] = [];
    expect(
      await probeRelay(
        { url: "ws://127.0.0.1:0", hostId: "hst_0123456789abcdef", token: "a".repeat(43) },
        {
          clock,
          resources,
          signal: new AbortController().signal,
          onDiagnostics: (value) => results.push(value),
        },
      ),
    ).toBe("relay_unreachable");
    expect(results).toStrictEqual([
      {
        kind: "connect",
        checkedAt: 20,
        network: "failed",
        resolution: "not_applicable",
        tls: "not_applicable",
        token: "unknown",
        failure: "tcp_connect_failed",
      },
    ]);
    expect(resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
  });

  it("observes a resolver failure through a real request without querying external DNS", async () => {
    const diagnostics = new RelayDiagnostics("ws://unresolved.invalid", new FakeClock(30));
    const req = request("http://unresolved.invalid", {
      lookup: (_hostname, _options, callback) =>
        callback(Object.assign(new Error("private resolver text"), { code: "ENOTFOUND" }), "", 4),
    });
    diagnostics.observe(req);
    const failed = once(req, "error");
    req.end();
    await failed;
    expect(diagnostics.finish("relay_unreachable")).toStrictEqual({
      kind: "connect",
      checkedAt: 30,
      network: "unknown",
      resolution: "failed",
      tls: "not_applicable",
      token: "unknown",
      failure: "resolution_failed",
    });
  });

  it("rejects an untrusted local certificate without weakening production TLS", async () => {
    const f = await fixture("ready", true);
    expect(await probeRelay(f.endpoint, f.options)).toBe("relay_unreachable");
    expect(f.results).toStrictEqual([
      {
        kind: "connect",
        checkedAt: 100,
        network: "passed",
        resolution: "not_applicable",
        tls: "failed",
        token: "unknown",
        failure: "tls_failed",
      },
    ]);
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
  });

  it.each([
    { mode: "silent", advanceMs: READY_TIMEOUT_MS, checkedAt: 10100, failure: "timeout" },
    { mode: "reset", advanceMs: 0, checkedAt: 100, failure: "unknown" },
  ] as const)(
    "does not blame TLS or the network for a $mode TLS peer",
    async ({ mode, advanceMs, checkedAt, failure }) => {
      const f = await fixture(mode, true);
      const done = probeRelay(f.endpoint, f.options);
      await f.bytes;
      f.clock.advance(advanceMs);
      expect(await done).toBe("relay_unreachable");
      expect(f.results).toStrictEqual([
        {
          kind: "connect",
          checkedAt,
          network: "passed",
          resolution: "not_applicable",
          tls: "unknown",
          token: "unknown",
          failure,
        },
      ]);
      expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
    },
  );

  it("does not publish an abandoned attempt after TCP connects", async () => {
    const f = await fixture("silent", true);
    const done = probeRelay(f.endpoint, f.options);
    await f.bytes;
    f.controller.abort();
    expect(await done).toBe("relay_unreachable");
    f.clock.advance(READY_TIMEOUT_MS);
    expect(f.results).toStrictEqual([]);
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
  });

  it.each([
    {
      mode: "trusted",
      message: '{"type":"ready"}',
      snapshot: {
        kind: "connect",
        checkedAt: 100,
        network: "passed",
        resolution: "passed",
        tls: "passed",
        token: "passed",
        failure: null,
      },
    },
    {
      mode: "wrong-host",
      message: null,
      snapshot: {
        kind: "connect",
        checkedAt: 100,
        network: "passed",
        resolution: "passed",
        tls: "failed",
        token: "unknown",
        failure: "tls_failed",
      },
    },
    { mode: "cancelled", message: '{"type":"ready"}', snapshot: null },
  ] as const)("releases every observational listener after $mode TLS", async ({ mode, message, snapshot }) => {
    const actual = await tlsEvidence(mode);
    expect(actual.message).toBe(message);
    expect(actual.snapshot).toStrictEqual(snapshot);
    expect(actual.owned.map(({ event }) => event)).toStrictEqual([
      "socket",
      "error",
      "response",
      "upgrade",
      "lookup",
      "connect",
      "secureConnect",
    ]);
    for (const { emitter, event, listener } of actual.owned) expect(emitter.listeners(event)).not.toContain(listener);
  });

  it("labels live evidence as only this socket's reachability, without recycling prior authentication", () => {
    expect(liveDiagnostics("wss://relay.invalid", new FakeClock(40), null)).toStrictEqual({
      kind: "live",
      checkedAt: 40,
      network: "passed",
      resolution: "unknown",
      tls: "unknown",
      token: "unknown",
      failure: null,
    });
    expect(liveDiagnostics("ws://[::1]:8787", new FakeClock(50), "timeout")).toStrictEqual({
      kind: "live",
      checkedAt: 50,
      network: "unknown",
      resolution: "not_applicable",
      tls: "not_applicable",
      token: "unknown",
      failure: "timeout",
    });
  });
});
