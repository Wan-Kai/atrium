import { createConnection } from "@atrium/client";
import { CloseCode, PROTOCOL_VERSION } from "@atrium/protocol";
import { FakeClock, createTempDir } from "@atrium/testkit";
import { mkdir, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { type TestHost, startTestHost } from "../../test/harness";

const trace = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true };
const wrongToken = "wrong-token-0123456789abcdefghijklmnop";

let testHost: TestHost | undefined;

afterEach(async () => {
  await testHost?.dispose();
  testHost = undefined;
});

/** Opens a raw `ws` socket, optionally with an Origin header; records what it receives and how it ended. */
function openRaw(url: string, options: { origin?: string } = {}) {
  const socket = new WebSocket(url, options.origin === undefined ? {} : { origin: options.origin });
  const messages: string[] = [];
  socket.on("message", (data: Buffer) => messages.push(data.toString("utf8")));
  const ended = new Promise<{ status?: number; code?: number; reason?: string }>((done) => {
    socket.once("unexpected-response", (_request, response) => done({ status: response.statusCode ?? 0 }));
    socket.once("close", (code, reason) => done({ code, reason: reason.toString() }));
  });
  const opened = new Promise<void>((done) => socket.once("open", () => done()));
  return { socket, ended, opened, messages };
}

/** Writes a small UI build with one file per served content type. */
async function uiFixture(): Promise<string> {
  const ui = await createTempDir("ui");
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

describe("host connection handshake", () => {
  it("records the whole connection, from handshake to disconnect, under the client's trace", async () => {
    testHost = await startTestHost();
    const connection = createConnection({
      url: testHost.url,
      token: testHost.token,
      clientId: "traced-client",
      createTrace: () => trace,
    });

    const state = await connection.connect();

    expect(state).toStrictEqual({ status: "connected", traceId: trace.traceId, hostVersion: "0.0.0" });
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

  it("lets a page served by the host itself connect", async () => {
    testHost = await startTestHost();
    const { socket, opened, ended } = openRaw(testHost.url, { origin: testHost.host.origin });

    await opened;
    socket.close(1000);

    expect(await ended).toStrictEqual({ code: 1000, reason: "" });
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

    expect(await probeTcp("::1", testHost.host.port)).toBe("ECONNREFUSED");
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

  it("releases the handshake timer when a client leaves before saying hello", async () => {
    testHost = await startTestHost({ clock: new FakeClock() });
    const { socket, opened, ended } = openRaw(testHost.url);
    await opened;

    socket.close(1000);
    await ended;

    await vi.waitFor(() => expect(testHost?.host.resources.snapshot()).toMatchObject({ timer: 1, "ws.connection": 0 }));
  });

  it("releases the handshake timer as soon as the hello is accepted", async () => {
    testHost = await startTestHost({ clock: new FakeClock() });

    await testHost.connect().connect();

    expect(testHost.host.resources.snapshot()).toMatchObject({ timer: 1, "ws.connection": 1 });
  });

  it("answers only the first of two hellos and ignores later messages until commands exist", async () => {
    testHost = await startTestHost();
    const { socket, opened, messages } = openRaw(testHost.url);

    await opened;
    socket.send(hello({ token: testHost.token }));
    socket.send(hello({ token: testHost.token }));
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    socket.send("after welcome");

    await vi.waitFor(async () =>
      expect(await testHost?.readLog()).toContainEqual(
        expect.objectContaining({ msg: "message ignored: no command routing yet", bytes: 13 }),
      ),
    );
    expect(messages).toHaveLength(1);
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
    await writeFile(`${ui.path}/index.html`, "<!doctype html>");
    const own = await startTestHost({ uiDir: ui.path });
    await (await fetch(`${own.host.origin}/`)).text();

    const started = performance.now();
    await own.dispose();

    expect(performance.now() - started).toBeLessThan(1_000);
    await ui.cleanup();
  });

  it("fails to start when the port is already taken", async () => {
    testHost = await startTestHost();

    await expect(startTestHost({ port: testHost.host.port })).rejects.toThrow(/EADDRINUSE/);
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

  it("answers 404 for missing files and for directories", async () => {
    testHost = await startTestHost({ uiDir: await uiFixture() });

    expect((await fetch(`${testHost.host.origin}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${testHost.host.origin}/assets.d`)).status).toBe(404);
  });

  it("serves the UI with the full content security policy and refuses paths outside it", async () => {
    const ui = await createTempDir("ui");
    await writeFile(`${ui.path}/index.html`, "<!doctype html><title>Atrium</title>");
    testHost = await startTestHost({ uiDir: ui.path });

    const page = await fetch(`${testHost.host.origin}/`);
    const escape = await fetch(`${testHost.host.origin}/assets/..%2f..%2f..%2fpackage.json`);

    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<!doctype html><title>Atrium</title>");
    expect(page.headers.get("content-security-policy")).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
        "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    expect(escape.status).toBe(404);
    await ui.cleanup();
  });
});
