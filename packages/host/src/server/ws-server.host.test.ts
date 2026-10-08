import { createAtriumClient } from "@atrium/client";
import { CloseCode, PROTOCOL_VERSION } from "@atrium/protocol";
import { FakeClock, createTempDir, present } from "@atrium/testkit";
import { chmod, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi, onTestFinished } from "vitest";
import { WebSocket } from "ws";
import { type TestHost, startTestHost } from "../../test/harness";
import { startHost } from "../main";
import { HostLockedError } from "../store/host-lock";

const trace = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true };
const wrongToken = "wrong-token-0123456789abcdefghijklmnop";

let testHost: TestHost | undefined;

afterEach(async () => {
  await testHost?.dispose();
  testHost = undefined;
});

/** Opens a raw `ws` socket, optionally with an Origin header or without answering pings; records what it receives and how it ended. */
function openRaw(url: string, options: { origin?: string; autoPong?: boolean } = {}) {
  const socket = new WebSocket(url, {
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    autoPong: options.autoPong ?? true,
  });
  const messages: string[] = [];
  socket.on("message", (data: Buffer) => messages.push(data.toString("utf8")));
  const ended = new Promise<{ status?: number; code?: number; reason?: string }>((done) => {
    socket.once("unexpected-response", (_request, response) => done({ status: response.statusCode ?? 0 }));
    socket.once("close", (code, reason) => done({ code, reason: reason.toString() }));
  });
  const opened = new Promise<void>((done) => socket.once("open", () => done()));
  return { socket, ended, opened, messages };
}

/** Starts a host, says hello over a raw socket and returns the parsed welcome. */
async function welcomeOf(): Promise<unknown> {
  testHost = await startTestHost();
  const { socket, opened, messages } = openRaw(testHost.url);
  await opened;
  socket.send(hello({ token: testHost.token }));
  await vi.waitFor(() => expect(messages).toHaveLength(1));
  socket.close();
  await testHost.dispose();
  testHost = undefined;
  return JSON.parse(present(messages[0], "welcome"));
}

/** Writes a small UI build with one file per served content type. */
async function uiFixture(): Promise<string> {
  const ui = await createTempDir("ui");
  onTestFinished(ui.cleanup);
  await mkdir(`${ui.path}/assets`);
  await mkdir(`${ui.path}/assets.d`);
  const files: Record<string, string> = {
    "index.html": "<!doctype html>",
    "assets/app.js": "js",
    "assets/app.css": "css",
    "assets/data.json": "{}",
    "assets/icon.svg": "svg",
    "assets/icon.png": "png",
    "assets/font.woff2": "woff2",
    "favicon.ico": "ico",
    "manifest.webmanifest": "{}",
    "assets/blob.bin": "bin",
  };
  for (const [name, content] of Object.entries(files)) await writeFile(`${ui.path}/${name}`, content);
  return ui.path;
}

/** Tries a plain TCP connection and reports "connected" or the error code. */
function probeTcp(host: string, port: number): Promise<string> {
  return new Promise((done) => {
    const probe = connect({ host, port });
    probe.once("connect", () => {
      probe.destroy();
      done("connected");
    });
    probe.once("error", (error: NodeJS.ErrnoException) => done(error.code ?? "unknown error"));
  });
}

/** Counts log records with the given message. */
async function countLog(host: TestHost | undefined, msg: string): Promise<number> {
  return ((await host?.readLog()) ?? []).filter((record) => record["msg"] === msg).length;
}

/** A hello message as a raw client would send it. */
function hello(fields: Record<string, unknown>): string {
  return JSON.stringify({
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    clientId: "raw",
    traceparent: "",
    ...fields,
  });
}

/** The `ws.connect` span record in a log with one handshake. */
function handshakeSpan(log: readonly Record<string, unknown>[]): Record<string, unknown> {
  return present(
    log.find((record) => record["kind"] === "span" && record["name"] === "ws.connect"),
    "ws.connect span",
  );
}

/** Trace id a test's hello carries when the test checks which trace the connection's logs join. */
const helloTraceId = "6bf92f3577b34da6a3ce929d0e0e4738";

/** A `ping` command with the given request id. */
function ping(requestId: string): string {
  return JSON.stringify({
    type: "ping",
    requestId,
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  });
}

describe("host connection handshake", () => {
  it("records the whole connection, from handshake to disconnect, under the client's trace", async () => {
    testHost = await startTestHost();
    const connection = createAtriumClient({
      url: testHost.url,
      token: testHost.token,
      clientId: "traced-client",
      createTrace: () => trace,
      reconnectDelaysMs: [],
    });

    const state = await connection.connect();

    expect(state).toStrictEqual({
      status: "connected",
      traceId: trace.traceId,
      hostVersion: "0.0.0",
      hostInstanceId: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    connection.disconnect();
    await vi.waitFor(() => expect(testHost?.host.resources.snapshot()["ws.connection"]).toBe(0));
    const log = await testHost.readLog();
    expect(log).toContainEqual(expect.objectContaining({ msg: "client disconnected", trace_id: trace.traceId }));
    expect(log).toContainEqual(
      expect.objectContaining({ msg: "client connected", client_id: "traced-client", trace_id: trace.traceId }),
    );
    expect(log).toContainEqual(
      expect.objectContaining({
        kind: "span",
        name: "ws.connect",
        trace_id: trace.traceId,
        parent_span_id: trace.spanId,
        status: "ok",
        attributes: { "client.id": "traced-client" },
      }),
    );
  });

  it("rejects a wrong token with the unauthorized close code and never logs the real token", async () => {
    testHost = await startTestHost();

    const state = await testHost.connect({ token: wrongToken }).connect();

    expect(state).toStrictEqual({ status: "rejected", reason: "unauthorized" });
    const raw = JSON.stringify(await testHost.readLog());
    expect(raw).toContain("client rejected: wrong token");
    expect(raw).not.toContain(testHost.token);
  });

  it("refuses a browser from a foreign origin before the WebSocket opens", async () => {
    testHost = await startTestHost();

    const { ended } = openRaw(testHost.url, { origin: "https://evil.example" });

    expect(await ended).toStrictEqual({ status: 403 });
    expect(await testHost.readLog()).toContainEqual(
      expect.objectContaining({
        msg: "websocket upgrade rejected: origin not allowed",
        origin: "https://evil.example",
      }),
    );
  });

  it("lets a page served by the host itself connect, but still requires the token", async () => {
    testHost = await startTestHost();
    const { socket, opened, ended } = openRaw(testHost.url, { origin: testHost.host.origin });

    await opened;
    socket.send(hello({ token: wrongToken }));

    expect(await ended).toStrictEqual({ code: CloseCode.Unauthorized, reason: "unauthorized" });
  });

  it.each([
    [
      "a message that is not JSON",
      "not json",
      { code: CloseCode.BadHandshake, reason: "bad handshake" },
      { msg: "client rejected: malformed hello" },
    ],
    [
      "a hello without a token",
      hello({}),
      { code: CloseCode.BadHandshake, reason: "bad handshake" },
      { msg: "client rejected: malformed hello" },
    ],
    [
      "a hello from another protocol version",
      hello({ protocolVersion: PROTOCOL_VERSION + 1, token: "t" }),
      { code: CloseCode.VersionMismatch, reason: "protocol version mismatch" },
      { msg: "client rejected: protocol version mismatch", client_version: PROTOCOL_VERSION + 1 },
    ],
    [
      "a hello with the wrong token",
      hello({ token: wrongToken }),
      { code: CloseCode.Unauthorized, reason: "unauthorized" },
      { msg: "client rejected: wrong token", client_id: "raw" },
    ],
  ])("closes the socket on %s and says why in the log", async (_label, firstMessage, expected, logRecord) => {
    testHost = await startTestHost();
    const { socket, opened, ended } = openRaw(testHost.url);

    await opened;
    socket.send(firstMessage);

    expect(await ended).toStrictEqual(expected);
    expect(await testHost.readLog()).toContainEqual(expect.objectContaining(logRecord));
  });

  it("also accepts the host's own origin spelled with localhost", async () => {
    testHost = await startTestHost();
    const { socket, opened, ended } = openRaw(testHost.url, { origin: `http://localhost:${testHost.host.port}` });

    await opened;
    socket.close(1000);

    expect(await ended).toStrictEqual({ code: 1000, reason: "" });
  });

  it("listens on IPv4 loopback only", async () => {
    testHost = await startTestHost();

    expect(testHost.host.address).toBe("127.0.0.1");
    expect(await probeTcp("::1", testHost.host.port)).toBe("ECONNREFUSED");
  });

  it("treats a frame that arrives together with the hello as an authenticated message", async () => {
    testHost = await startTestHost();
    const { socket, opened, messages } = openRaw(testHost.url);
    await opened;

    socket.send(hello({ token: testHost.token }));
    socket.send(ping("r1"));

    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(JSON.parse(present(messages[1], "response"))).toStrictEqual({
      type: "response",
      requestId: "r1",
      ok: true,
      result: {},
    });
  });

  it("allows exactly 200 messages per second, starts a fresh window after one second, and drops the 201st", async () => {
    const clock = new FakeClock();
    testHost = await startTestHost({ clock });
    const { socket, opened, ended, messages } = openRaw(testHost.url);
    await opened;
    socket.send(hello({ token: testHost.token }));
    // Every message within the limit gets its answer, here `invalid_message`; the welcome comes first.
    for (let count = 1; count < 200; count++) socket.send("x");
    await vi.waitFor(() => expect(messages).toHaveLength(200));

    clock.advance(1_000);
    for (let count = 0; count < 200; count++) socket.send("x");
    await vi.waitFor(() => expect(messages).toHaveLength(400));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    for (let count = 0; count < 5; count++) socket.send("over the limit");

    expect(await ended).toStrictEqual({ code: CloseCode.RateLimited, reason: "rate limited" });
    const log = await testHost.readLog();
    // The line joins the connection's handshake trace.
    expect(log.filter((record) => record["msg"] === "client dropped: message rate limit exceeded")).toStrictEqual([
      expect.objectContaining({ trace_id: handshakeSpan(log)["trace_id"] }),
    ]);
    expect(messages).toHaveLength(400);
    expect(new Set(messages.slice(1))).toStrictEqual(
      new Set([JSON.stringify({ type: "response", requestId: null, ok: false, error: { code: "invalid_message" } })]),
    );
  });

  it("allows exactly 8 MiB per second and drops the next byte", async () => {
    testHost = await startTestHost({ clock: new FakeClock() });
    const { socket, opened, ended, messages } = openRaw(testHost.url);
    await opened;
    const first = hello({ token: testHost.token });
    const mib = 1024 * 1024;
    socket.send(first);
    for (let count = 0; count < 7; count++) socket.send("y".repeat(mib));
    socket.send("y".repeat(mib - Buffer.byteLength(first)));
    await vi.waitFor(() => expect(messages).toHaveLength(9));
    expect(socket.readyState).toBe(WebSocket.OPEN);

    socket.send("y");

    expect(await ended).toStrictEqual({ code: CloseCode.RateLimited, reason: "rate limited" });
  });

  it("ignores everything a rejected client still sends", async () => {
    testHost = await startTestHost();
    const { socket, opened, ended } = openRaw(testHost.url);
    await opened;

    socket.send("not json");
    socket.send("still talking");
    socket.send(hello({ token: testHost.token }));

    expect(await ended).toStrictEqual({ code: CloseCode.BadHandshake, reason: "bad handshake" });
    expect(await countLog(testHost, "client rejected: malformed hello")).toBe(1);
    expect(await countLog(testHost, "client connected")).toBe(0);
  });

  it("rejects a binary first message as a bad handshake", async () => {
    testHost = await startTestHost();
    const { socket, opened, ended } = openRaw(testHost.url);
    await opened;

    socket.send(Buffer.from(hello({ token: testHost.token })));

    expect(await ended).toStrictEqual({ code: CloseCode.BadHandshake, reason: "bad handshake" });
  });

  it("closes a connection that sends a message over 1 MiB and keeps serving others", async () => {
    testHost = await startTestHost();
    const { socket, opened, ended } = openRaw(testHost.url);
    await opened;

    socket.send("z".repeat(1024 * 1024 + 1));

    expect(await ended).toMatchObject({ code: 1009 });
    expect(await testHost.connect().connect()).toMatchObject({ status: "connected" });
    expect(await testHost.readLog()).toContainEqual(
      expect.objectContaining({
        msg: "websocket error",
        err: expect.objectContaining({ code: "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" }),
      }),
    );
  });

  it("refuses connections beyond 32 at once", async () => {
    testHost = await startTestHost();
    const { url } = testHost;
    const held = Array.from({ length: 32 }, () => openRaw(url));
    await Promise.all(held.map((raw) => raw.opened));

    const extra = openRaw(testHost.url);

    expect(await extra.ended).toStrictEqual({ code: CloseCode.TooManyConnections, reason: "too many connections" });
    expect(await testHost.readLog()).toContainEqual(
      expect.objectContaining({ msg: "client rejected: too many connections", limit: 32 }),
    );
    for (const raw of held) raw.socket.close();
  });

  it("drops a client that never says hello once the handshake timeout passes", async () => {
    const clock = new FakeClock();
    testHost = await startTestHost({ clock, handshakeTimeoutMs: 5_000 });
    const { opened, ended } = openRaw(testHost.url);
    await opened;
    await vi.waitFor(() => expect(testHost?.host.resources.snapshot()["ws.connection"]).toBe(1));

    clock.advance(4_999);
    expect(testHost.host.resources.snapshot()["ws.connection"]).toBe(1);
    clock.advance(1);

    expect(await ended).toStrictEqual({ code: CloseCode.HandshakeTimeout, reason: "handshake timeout" });
    expect(await testHost.readLog()).toContainEqual(
      expect.objectContaining({ msg: "client dropped: no hello before timeout" }),
    );
  });

  it("ignores a hello that arrives after the handshake timed out", async () => {
    const clock = new FakeClock();
    testHost = await startTestHost({ clock, handshakeTimeoutMs: 5_000 });
    const { socket, opened, ended } = openRaw(testHost.url);
    await opened;
    await vi.waitFor(() => expect(testHost?.host.resources.snapshot()["ws.connection"]).toBe(1));

    clock.advance(5_000);
    socket.send(hello({ token: testHost.token }));

    expect(await ended).toStrictEqual({ code: CloseCode.HandshakeTimeout, reason: "handshake timeout" });
    expect(await countLog(testHost, "client connected")).toBe(0);
    expect(await countLog(testHost, "client rejected: malformed hello")).toBe(0);
  });

  it("releases the handshake timer when a client leaves before saying hello", async () => {
    testHost = await startTestHost({ clock: new FakeClock() });
    const { socket, opened, ended } = openRaw(testHost.url);
    await opened;

    socket.close(1000);
    await ended;

    // The timers left are the host's resource report and the workspaces' background fetch.
    await vi.waitFor(() => expect(testHost?.host.resources.snapshot()).toMatchObject({ timer: 2, "ws.connection": 0 }));
  });

  it("releases the handshake timer as soon as the hello is accepted", async () => {
    testHost = await startTestHost({ clock: new FakeClock() });

    await testHost.connect().connect();

    // The timers left are the host's resource report, the workspaces' background fetch and the
    // connection's heartbeat.
    expect(testHost.host.resources.snapshot()).toMatchObject({ timer: 3, "ws.connection": 1 });
  });

  it("welcomes with the heartbeat and an instance id that is new on every host start", async () => {
    const first = await welcomeOf();
    const second = await welcomeOf();

    const shape = {
      type: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      hostVersion: "0.0.0",
      hostInstanceId: expect.stringMatching(/^[0-9a-f]{16}$/),
      heartbeatMs: 15_000,
    };
    expect(first).toStrictEqual(shape);
    expect(second).toStrictEqual(shape);
    expect((first as { hostInstanceId: string }).hostInstanceId).not.toBe(
      (second as { hostInstanceId: string }).hostInstanceId,
    );
  });

  it("pings clients on the injected clock and drops one that has not answered by the next ping", async () => {
    const clock = new FakeClock();
    testHost = await startTestHost({ clock });
    const alive = openRaw(testHost.url);
    const silent = openRaw(testHost.url, { autoPong: false });
    await Promise.all([alive.opened, silent.opened]);
    const pinged = (raw: ReturnType<typeof openRaw>) => new Promise((done) => raw.socket.once("ping", done));
    const firstPings = [pinged(alive), pinged(silent)];
    alive.socket.send(hello({ token: testHost.token }));
    silent.socket.send(hello({ token: testHost.token, traceparent: `00-${helloTraceId}-00f067aa0ba902b7-01` }));
    await Promise.all(firstPings);
    // The host reads the pong before this command, so once the answer is back the pong has arrived.
    alive.socket.send(ping("r1"));
    await vi.waitFor(() => expect(alive.messages).toHaveLength(2));

    const secondPing = pinged(alive);
    clock.advance(15_000);

    expect(await silent.ended).toStrictEqual({ code: 1006, reason: "" });
    expect(alive.socket.readyState).toBe(WebSocket.OPEN);
    const log = await testHost.readLog();
    const dropped = log.filter((record) => record["msg"] === "client dropped: no pong before the next ping");
    // The line joins the dropped client's own handshake trace.
    expect(dropped).toStrictEqual([expect.objectContaining({ trace_id: helloTraceId })]);
    await vi.waitFor(() => expect(testHost?.host.resources.snapshot()).toMatchObject({ "sync.connection": 1 }));
    // The one still connected keeps being pinged.
    await secondPing;
  });

  it("answers only the first of two hellos", async () => {
    testHost = await startTestHost();
    const { socket, opened, messages } = openRaw(testHost.url);

    await opened;
    socket.send(hello({ token: testHost.token }));
    socket.send(hello({ token: testHost.token }));
    socket.send("after welcome");

    await vi.waitFor(() => expect(messages).toHaveLength(3));
    expect(messages.slice(1).map((message) => JSON.parse(message))).toStrictEqual([
      // After the handshake, `hello` is not a command; its `requestId` cannot be read.
      { type: "response", requestId: null, ok: false, error: { code: "unknown_command" } },
      { type: "response", requestId: null, ok: false, error: { code: "invalid_message" } },
    ]);
    expect(JSON.parse(present(messages[0], "welcome"))).toMatchObject({ type: "welcome" });
  });

  it("logs a disconnect only for clients that were let in", async () => {
    testHost = await startTestHost();
    const accepted = testHost.connect();
    await accepted.connect();
    await testHost.connect({ token: wrongToken }).connect();
    for (const first of ["not json", hello({ protocolVersion: PROTOCOL_VERSION + 1, token: "t" })]) {
      const raw = openRaw(testHost.url);
      await raw.opened;
      raw.socket.send(first);
      await raw.ended;
    }

    accepted.disconnect();

    await vi.waitFor(() => expect(testHost?.host.resources.snapshot()["ws.connection"]).toBe(0));
    const disconnects = (await testHost.readLog()).filter((record) => record["msg"] === "client disconnected");
    expect(disconnects).toStrictEqual([expect.objectContaining({ code: 1000 })]);
  });

  it("logs the port it listens on", async () => {
    testHost = await startTestHost();

    expect(await testHost.readLog()).toContainEqual(
      expect.objectContaining({ msg: "host listening", port: testHost.host.port }),
    );
  });
});

describe("host lifecycle", () => {
  it("has every client disconnected by the time close resolves", async () => {
    const own = await startTestHost();
    await own.connect().connect();

    await own.dispose();

    expect(own.host.resources.snapshot()["ws.connection"]).toBe(0);
  });

  it("closes promptly even while an HTTP keep-alive connection is open", async () => {
    const ui = await createTempDir("ui");
    onTestFinished(ui.cleanup);
    await writeFile(`${ui.path}/index.html`, "<!doctype html>");
    const own = await startTestHost({ uiDir: ui.path });
    await (await fetch(`${own.host.origin}/`)).text();

    const started = performance.now();
    await own.dispose();

    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("fails to start when the port is already taken, and leaves the failure in its log", async () => {
    testHost = await startTestHost();
    const home = await createTempDir("failed-home");
    onTestFinished(home.cleanup);

    const started = startHost({ home: home.path, token: testHost.token, port: testHost.host.port });

    await expect(started).rejects.toThrow(/EADDRINUSE/);
    const log = await readFile(`${home.path}/logs/current.log`, "utf8");
    expect(log).toContain('"msg":"host failed to start"');
    expect(await readdir(home.path)).toStrictEqual(["logs"]);
  });

  it("refuses to start on a home another live host is using, and starts once that host has closed", async () => {
    const home = await createTempDir("shared-home");
    onTestFinished(home.cleanup);
    const token = "test-token-0123456789abcdefghijklmnopqrstuvwxyz";
    const first = await startHost({ home: home.path, token, toolEnv: { PATH: "" } });
    onTestFinished(first.close);

    const second = startHost({ home: home.path, token, toolEnv: { PATH: "" } });

    await expect(second).rejects.toThrow(HostLockedError);
    await expect(second).rejects.toMatchObject({ pid: process.pid });
    await first.close();
    const third = await startHost({ home: home.path, token, toolEnv: { PATH: "" } });
    await third.close();
    expect(await readdir(home.path)).toStrictEqual(["logs"]);
  });

  it("closes promptly while a client has paused in the middle of a download", async () => {
    const ui = await uiFixture();
    await writeFile(`${ui}/assets/big.bin`, Buffer.alloc(64 * 1024 * 1024));
    const own = await startTestHost({ uiDir: ui });
    const response = await fetch(`${own.host.origin}/assets/big.bin`);
    await response.body?.getReader().read();

    const started = performance.now();
    await own.dispose();

    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("drops a half-sent upgrade when closing, so no WebSocket can appear afterwards", async () => {
    const own = await startTestHost();
    await own.connect().connect();
    const early = connect({ host: "127.0.0.1", port: own.host.port });
    early.on("error", () => undefined);
    await new Promise((done) => early.once("connect", done));
    early.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\n");
    const dropped = new Promise<void>((done) => early.once("close", () => done()));

    const started = performance.now();
    await own.dispose();
    await dropped;

    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe("host static files", () => {
  it("answers 404 to every request when no UI directory is configured", async () => {
    testHost = await startTestHost();

    expect((await fetch(`${testHost.host.origin}/`)).status).toBe(404);
  });

  it.each([
    ["/", "text/html; charset=utf-8", "no-cache", "<!doctype html>"],
    ["/assets/app.js", "text/javascript; charset=utf-8", "public, max-age=31536000, immutable", "js"],
    ["/assets/app.css", "text/css; charset=utf-8", "public, max-age=31536000, immutable", "css"],
    ["/assets/data.json", "application/json; charset=utf-8", "public, max-age=31536000, immutable", "{}"],
    ["/assets/icon.svg", "image/svg+xml", "public, max-age=31536000, immutable", "svg"],
    ["/assets/icon.png", "image/png", "public, max-age=31536000, immutable", "png"],
    ["/assets/font.woff2", "font/woff2", "public, max-age=31536000, immutable", "woff2"],
    ["/favicon.ico", "image/x-icon", "public, max-age=31536000, immutable", "ico"],
    ["/manifest.webmanifest", "application/manifest+json", "public, max-age=31536000, immutable", "{}"],
    ["/assets/blob.bin", "application/octet-stream", "public, max-age=31536000, immutable", "bin"],
  ])("serves %s as %s with cache policy %s", async (path, contentType, cacheControl, body) => {
    testHost = await startTestHost({ uiDir: await uiFixture() });

    const response = await fetch(`${testHost.host.origin}${path}`);

    expect({
      status: response.status,
      type: response.headers.get("content-type"),
      cache: response.headers.get("cache-control"),
      sniff: response.headers.get("x-content-type-options"),
      body: await response.text(),
    }).toStrictEqual({ status: 200, type: contentType, cache: cacheControl, sniff: "nosniff", body });
  });

  it("answers HEAD with headers only and refuses other methods", async () => {
    testHost = await startTestHost({ uiDir: await uiFixture() });

    const head = await fetch(`${testHost.host.origin}/assets/app.js`, { method: "HEAD" });
    const post = await fetch(`${testHost.host.origin}/assets/app.js`, { method: "POST" });

    expect([head.status, head.headers.get("content-length"), await head.text()]).toStrictEqual([200, "2", ""]);
    expect([post.status, post.headers.get("allow")]).toStrictEqual([405, "GET, HEAD"]);
  });

  it("does not follow a symlink out of the UI directory, but serves one that stays inside", async () => {
    const outside = await createTempDir("outside");
    onTestFinished(outside.cleanup);
    await writeFile(`${outside.path}/secret.json`, "secret");
    const ui = await uiFixture();
    await symlink(`${outside.path}/secret.json`, `${ui}/assets/leak.json`);
    await symlink(`${ui}/assets/app.js`, `${ui}/assets/alias.js`);
    testHost = await startTestHost({ uiDir: ui });

    const leak = await fetch(`${testHost.host.origin}/assets/leak.json`);
    const alias = await fetch(`${testHost.host.origin}/assets/alias.js`);

    expect([leak.status, alias.status, await alias.text()]).toStrictEqual([404, 200, "js"]);
  });

  it("answers 404 for a file it cannot read and keeps running", async () => {
    const ui = await uiFixture();
    await chmod(`${ui}/assets/app.js`, 0o000);
    testHost = await startTestHost({ uiDir: ui });

    const unreadable = await fetch(`${testHost.host.origin}/assets/app.js`);
    const next = await fetch(`${testHost.host.origin}/assets/app.css`);

    expect([unreadable.status, next.status]).toStrictEqual([404, 200]);
    await chmod(`${ui}/assets/app.js`, 0o644);
  });

  it("survives a client that disconnects in the middle of a download", async () => {
    const ui = await uiFixture();
    await writeFile(`${ui}/assets/big.bin`, Buffer.alloc(32 * 1024 * 1024));
    testHost = await startTestHost({ uiDir: ui });
    const abort = new AbortController();

    const response = await fetch(`${testHost.host.origin}/assets/big.bin`, { signal: abort.signal });
    const reader = response.body?.getReader();
    await reader?.read();
    abort.abort();

    expect((await fetch(`${testHost.host.origin}/assets/app.css`)).status).toBe(200);
  });

  it("answers 404 for missing files and for directories", async () => {
    testHost = await startTestHost({ uiDir: await uiFixture() });

    expect((await fetch(`${testHost.host.origin}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${testHost.host.origin}/assets.d`)).status).toBe(404);
  });

  it("serves the UI with the full content security policy and refuses paths outside it", async () => {
    const ui = await createTempDir("ui");
    onTestFinished(ui.cleanup);
    await writeFile(`${ui.path}/index.html`, "<!doctype html><title>Atrium</title>");
    testHost = await startTestHost({ uiDir: ui.path });

    const page = await fetch(`${testHost.host.origin}/`);
    const escape = await fetch(`${testHost.host.origin}/assets/..%2f..%2f..%2fpackage.json`);

    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<!doctype html><title>Atrium</title>");
    expect(page.headers.get("content-security-policy")).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; " +
        "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    expect(escape.status).toBe(404);
  });
});
