import { once } from "node:events";
import { FakeClock } from "@atrium/testkit";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { checkRelayPong } from "./relay-pong";
import { ResourceTracker } from "../platform/resources";
import { LINK_PING_MS, READY_TIMEOUT_MS, RelayLink, probeRelay, type LinkState } from "./relay-link";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/** Starts a controllable relay control endpoint. @remarks Used only for malformed and stalled relay behavior. @sideEffects Opens a loopback listener. */
async function fixture(autoPong = true, perMessageDeflate = false) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, autoPong, perMessageDeflate });
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("unexpected socket address");
  const endpoint = { url: `ws://127.0.0.1:${address.port}`, hostId: "hst_0123456789abcdef", token: "a".repeat(43) };
  const sockets: WebSocket[] = [];
  const messages: unknown[] = [];
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (raw) => messages.push(JSON.parse(Buffer.from(raw as Buffer).toString("utf8"))));
  });
  cleanup.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const clock = new FakeClock(100);
  const resources = new ResourceTracker();
  const states: LinkState[] = [];
  const streams: string[] = [];
  const logs: unknown[] = [];
  const logger = pino(
    { base: null, timestamp: false, formatters: { level: (label) => ({ level: label }) } },
    { write: (line) => logs.push(JSON.parse(line) as unknown) },
  );
  const link = new RelayLink({
    endpoint,
    clock,
    resources,
    logger,
    onState: (state) => states.push(state),
    onStream: (id) => streams.push(id),
  });
  cleanup.push(() => link.stop());
  return { server, endpoint, clock, resources, states, streams, link, sockets, messages, logs };
}

/** Creates an exact UTF-8 byte-sized control message. @remarks Payload limits apply to bytes, not the test's logical fields. @sideEffects none */
function paddedControl(type: string, bytes: number): string {
  const value = { type, streamId: "a".repeat(32), padding: "" };
  return JSON.stringify({ ...value, padding: "x".repeat(bytes - Buffer.byteLength(JSON.stringify(value))) });
}

describe("RelayLink", () => {
  it("accepts a 70 KiB control frame but rejects one extra byte on the same socket", async () => {
    const f = await fixture();
    f.link.start();
    await expect.poll(() => f.messages.length).toBe(1);
    const peer = f.sockets[0]!;
    const ready = paddedControl("ready", 70 * 1024);
    expect(Buffer.byteLength(ready)).toBe(70 * 1024);
    peer.send(ready);
    await expect.poll(() => f.link.state.status).toBe("connected");
    const oversized = paddedControl("open", 70 * 1024 + 1);
    expect(Buffer.byteLength(oversized)).toBe(70 * 1024 + 1);
    peer.send(oversized);
    await expect.poll(() => f.link.state.status).toBe("error");
    expect(f.streams).toStrictEqual([]);
    await f.link.stop();
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
  });

  it("does not negotiate compression with a control endpoint that supports it", async () => {
    const f = await fixture(true, true);
    f.link.start();
    await expect.poll(() => f.messages.length).toBe(1);
    expect(f.sockets[0]!.extensions).toBe("");
    f.sockets[0]!.send('{"type":"ready"}');
    await expect.poll(() => f.link.state.status).toBe("connected");
    await f.link.stop();
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
  });

  it("accepts only this check's pong and ignores empty, wrong, heartbeat and previous-check payloads", async () => {
    const f = await fixture(false);
    f.link.start();
    await expect.poll(() => f.sockets.length).toBe(1);
    const socket = f.sockets[0]!;
    socket.send('{"type":"ready"}');
    await expect.poll(() => f.link.state.status).toBe("connected");
    const heartbeat = once(socket, "ping");
    f.clock.advance(LINK_PING_MS);
    const [oldHeartbeat] = await heartbeat;
    let previous = Buffer.from("previous-check");
    for (let round = 0; round < 2; round++) {
      let settled = false;
      const ping = once(socket, "ping");
      const pending = f.link.retryNow();
      const result = pending.then((value) => {
        settled = true;
        return value;
      });
      expect(f.link.retryNow()).toBe(pending);
      const [payload] = await ping;
      expect(settled).toBe(false);
      socket.pong(oldHeartbeat);
      socket.pong();
      socket.pong(Buffer.from("wrong"));
      socket.pong(previous);
      const marker = String(round + 1).repeat(32);
      socket.send(JSON.stringify({ type: "open", streamId: marker }));
      await expect.poll(() => f.streams.includes(marker)).toBe(true);
      expect(settled).toBe(false);
      expect(Buffer.isBuffer(payload)).toBe(true);
      expect(payload).toHaveLength(16);
      expect(payload.equals(previous)).toBe(false);
      socket.pong(payload);
      expect(await result).toBeNull();
      previous = payload;
      expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 1, timer: 1 });
    }
    expect(f.sockets).toHaveLength(1);
  });

  it("publishes completed connection and live evidence without pretending to repeat authentication", async () => {
    const f = await fixture();
    expect(f.link.diagnostics).toBeNull();
    f.link.start();
    await expect.poll(() => f.sockets.length).toBe(1);
    f.sockets[0]!.send('{"type":"ready"}');
    await expect.poll(() => f.link.state.status).toBe("connected");
    expect(f.link.diagnostics).toStrictEqual({
      kind: "connect",
      checkedAt: 100,
      network: "passed",
      resolution: "not_applicable",
      tls: "not_applicable",
      token: "passed",
      failure: null,
    });
    f.clock.advance(1);
    expect(await f.link.retryNow()).toBeNull();
    expect(f.link.diagnostics).toStrictEqual({
      kind: "live",
      checkedAt: 101,
      network: "passed",
      resolution: "not_applicable",
      tls: "not_applicable",
      token: "unknown",
      failure: null,
    });
  });

  it("keeps completed diagnostics and notifications unchanged when stop settles a pending live check", async () => {
    const f = await fixture(false);
    f.link.start();
    await expect.poll(() => f.messages.length).toBe(1);
    const socket = f.sockets[0]!;
    socket.send('{"type":"ready"}');
    await expect.poll(() => f.link.state.status).toBe("connected");
    const evidence = {
      kind: "connect",
      checkedAt: 100,
      network: "passed",
      resolution: "not_applicable",
      tls: "not_applicable",
      token: "passed",
      failure: null,
    };
    const notifications = [
      { status: "connecting", error: null, lastConnectedAt: null },
      { status: "connected", error: null, lastConnectedAt: 100 },
    ];
    expect(f.link.diagnostics).toStrictEqual(evidence);
    expect(f.states).toStrictEqual(notifications);
    f.clock.advance(1);
    const ping = once(socket, "ping");
    const checking = f.link.retryNow();
    const [payload] = await ping;
    expect(payload).toHaveLength(16);
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 1, timer: 2 });
    await f.link.stop();
    expect(await checking).toBe("relay_unreachable");
    expect.soft(f.link.diagnostics).toStrictEqual(evidence);
    expect.soft(f.states).toStrictEqual(notifications);
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
    await expect.poll(() => f.server.clients.size).toBe(0);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    f.clock.advance(LINK_PING_MS + READY_TIMEOUT_MS);
    expect(f.link.diagnostics).toStrictEqual(evidence);
    expect(f.states).toStrictEqual(notifications);
    expect(f.sockets).toHaveLength(1);
    expect(f.clock.pendingTimers()).toBe(0);
  });

  it("tests an already connected relay with a fresh pong and times out silence without replacing healthy sockets", async () => {
    const f = await fixture(false);
    f.link.start();
    await expect.poll(() => f.sockets.length).toBe(1);
    const socket = f.sockets[0]!;
    socket.send('{"type":"ready"}');
    await expect.poll(() => f.link.state.status).toBe("connected");
    let checked = false;
    const ping = once(socket, "ping");
    const checking = f.link.retryNow();
    const check = checking.then((result) => {
      checked = true;
      return result;
    });
    expect(f.link.retryNow()).toBe(checking);
    expect(checked).toBe(false);
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 1, timer: 2 });
    const [payload] = await ping;
    expect(checked).toBe(false);
    socket.pong(payload);
    expect(await check).toBeNull();
    expect(f.states).toStrictEqual([
      { status: "connecting", error: null, lastConnectedAt: null },
      { status: "connected", error: null, lastConnectedAt: 100 },
      { status: "connected", error: null, lastConnectedAt: 100 },
    ]);
    expect(f.sockets).toHaveLength(1);
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 1, timer: 1 });
    const silentPing = once(socket, "ping");
    const silent = f.link.retryNow();
    const [silentPayload] = await silentPing;
    f.clock.advance(READY_TIMEOUT_MS);
    expect(await silent).toBe("relay_unreachable");
    expect(f.states).toHaveLength(4);
    expect(f.states[3]).toStrictEqual({ status: "connected", error: null, lastConnectedAt: 100 });
    expect(f.link.state).toStrictEqual({ status: "connected", error: null, lastConnectedAt: 100 });
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 1, timer: 1 });
    expect(f.link.diagnostics).toStrictEqual({
      kind: "live",
      checkedAt: 10100,
      network: "unknown",
      resolution: "not_applicable",
      tls: "not_applicable",
      token: "unknown",
      failure: "timeout",
    });
    socket.send(JSON.stringify({ type: "open", streamId: "d".repeat(32) }));
    await expect.poll(() => f.streams).toStrictEqual(["d".repeat(32)]);
    const heartbeat = once(socket, "ping");
    f.clock.advance(LINK_PING_MS - READY_TIMEOUT_MS);
    const [heartbeatPayload] = await heartbeat;
    expect(heartbeatPayload).toHaveLength(0);
    socket.pong(heartbeatPayload);
    const nextPing = once(socket, "ping");
    const next = f.link.retryNow();
    const [nextPayload] = await nextPing;
    expect(nextPayload.equals(silentPayload)).toBe(false);
    socket.pong(nextPayload);
    expect(await next).toBeNull();
    expect(f.link.diagnostics).toStrictEqual({
      kind: "live",
      checkedAt: 30100,
      network: "passed",
      resolution: "not_applicable",
      tls: "not_applicable",
      token: "unknown",
      failure: null,
    });
    expect(f.states).toHaveLength(5);
    expect(f.states[4]).toStrictEqual({ status: "connected", error: null, lastConnectedAt: 100 });
    expect(f.sockets).toHaveLength(1);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(f.link.state).toStrictEqual({ status: "connected", error: null, lastConnectedAt: 100 });
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 1, timer: 1 });
    await f.link.stop();
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
  });

  it("settles a live connection check on rejection and on host shutdown", async () => {
    const f = await fixture(false);
    f.link.start();
    await expect.poll(() => f.sockets.length).toBe(1);
    f.sockets[0]!.send('{"type":"ready"}');
    await expect.poll(() => f.link.state.status).toBe("connected");
    const rejected = f.link.retryNow();
    f.sockets[0]!.close(4401);
    expect(await rejected).toBe("relay_rejected");
    const rejectionEvidence = {
      kind: "live",
      checkedAt: 100,
      network: "unknown",
      resolution: "not_applicable",
      tls: "not_applicable",
      token: "unknown",
      failure: "token_rejected",
    };
    expect(f.link.diagnostics).toStrictEqual(rejectionEvidence);
    const connecting = f.link.retryNow();
    expect(f.link.diagnostics).toStrictEqual(rejectionEvidence);
    await expect.poll(() => f.sockets.length).toBe(2);
    f.sockets[1]!.send('{"type":"ready"}');
    expect(await connecting).toBeNull();
    expect(f.link.diagnostics).toStrictEqual({
      kind: "connect",
      checkedAt: 100,
      network: "passed",
      resolution: "not_applicable",
      tls: "not_applicable",
      token: "passed",
      failure: null,
    });
    const stopped = f.link.retryNow();
    await f.link.stop();
    expect(await stopped).toBe("relay_unreachable");
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
  });

  it("keeps a valid control upgrade distinct from a close before relay authentication", async () => {
    const f = await fixture();
    f.link.start();
    await expect.poll(() => f.messages.length).toBe(1);
    f.sockets[0]!.close(1000);
    await expect.poll(() => f.link.state.status).toBe("error");
    expect(f.link.diagnostics).toStrictEqual({
      kind: "connect",
      checkedAt: 100,
      network: "passed",
      resolution: "not_applicable",
      tls: "not_applicable",
      token: "unknown",
      failure: "connection_closed",
    });
  });

  it("ignores binary and non-object control frames without refreshing ready state", async () => {
    const f = await fixture();
    f.link.start();
    await expect.poll(() => f.sockets.length).toBe(1);
    const socket = f.sockets[0]!;
    for (const frame of ["null", "42", '"ready"', "[]", "{broken", '{"type":"unknown"}']) socket.send(frame);
    socket.send(Buffer.from('{"type":"ready"}'));
    socket.send(JSON.stringify({ type: "open", streamId: "b".repeat(32) }));
    socket.send('{"type":"ready"}');
    socket.send(JSON.stringify({ type: "open", streamId: "c".repeat(32) }));
    await expect.poll(() => f.streams).toStrictEqual(["c".repeat(32)]);
    expect(f.link.state).toStrictEqual({ status: "connected", error: null, lastConnectedAt: 100 });
    f.clock.advance(1);
    socket.send('{"type":"ready"}');
    socket.send(JSON.stringify({ type: "open", streamId: "d".repeat(32) }));
    await expect.poll(() => f.streams.length).toBe(2);
    expect(f.link.state.lastConnectedAt).toBe(100);
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 1, timer: 1 });
  });

  it("does not coerce non-string stream ids into valid announcements", async () => {
    const f = await fixture();
    f.link.start();
    await expect.poll(() => f.sockets.length).toBe(1);
    const socket = f.sockets[0]!;
    socket.send('{"type":"ready"}');
    for (const streamId of [["a".repeat(32)], null, 123, {}, "A".repeat(32), "b".repeat(33)])
      socket.send(JSON.stringify({ type: "open", streamId }));
    socket.send(JSON.stringify({ type: "open", streamId: "c".repeat(32) }));
    await expect.poll(() => f.streams.includes("c".repeat(32))).toBe(true);
    expect(f.streams).toStrictEqual(["c".repeat(32)]);
  });

  it("drops an unanswered ping and preserves the last successful connection time", async () => {
    const f = await fixture(false);
    f.link.start();
    await expect.poll(() => f.sockets.length).toBe(1);
    const socket = f.sockets[0]!;
    socket.send('{"type":"ready"}');
    await expect.poll(() => f.link.state.status).toBe("connected");
    const ping = once(socket, "ping");
    f.clock.advance(LINK_PING_MS);
    await ping;
    expect(f.link.state.status).toBe("connected");
    f.clock.advance(LINK_PING_MS - 1);
    expect(f.link.state.status).toBe("connected");
    f.clock.advance(1);
    await expect
      .poll(() => f.link.state)
      .toStrictEqual({
        status: "error",
        error: "relay_unreachable",
        lastConnectedAt: 100,
      });
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 1 });
    expect(f.logs).toStrictEqual([
      { level: "info", host_id: f.endpoint.hostId, msg: "relay connected" },
      { level: "warn", host_id: f.endpoint.hostId, msg: "relay did not answer a ping" },
      { level: "info", host_id: f.endpoint.hostId, code: 1006, ready: true, msg: "relay connection closed" },
    ]);
    f.clock.advance(999);
    expect(f.sockets).toHaveLength(1);
    f.clock.advance(1);
    await expect.poll(() => f.sockets.length).toBe(2);
    f.sockets[1]!.send('{"type":"ready"}');
    await expect
      .poll(() => f.link.state)
      .toStrictEqual({
        status: "connected",
        error: null,
        lastConnectedAt: 61_100,
      });
  });

  it("keeps a connection alive when each ping is answered before the next deadline", async () => {
    const f = await fixture(false);
    f.link.start();
    await expect.poll(() => f.sockets.length).toBe(1);
    const socket = f.sockets[0]!;
    socket.send('{"type":"ready"}');
    await expect.poll(() => f.link.state.status).toBe("connected");
    for (const id of ["a", "b", "c"]) {
      const ping = once(socket, "ping");
      f.clock.advance(LINK_PING_MS);
      await ping;
      socket.pong();
      socket.send(JSON.stringify({ type: "open", streamId: id.repeat(32) }));
      await expect.poll(() => f.streams.at(-1)).toBe(id.repeat(32));
      expect(f.link.state).toStrictEqual({ status: "connected", error: null, lastConnectedAt: 100 });
      expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 1, timer: 1 });
    }
    expect(f.sockets).toHaveLength(1);
  });

  it("authenticates then admits only valid ready-bound stream announcements", async () => {
    const f = await fixture();
    f.link.start();
    f.link.start();
    await expect.poll(() => f.messages.length).toBe(1);
    expect(f.messages).toStrictEqual([{ v: 1, type: "hello", hostId: f.endpoint.hostId, token: f.endpoint.token }]);
    const socket = f.sockets[0]!;
    socket.send(JSON.stringify({ type: "open", streamId: "b".repeat(32) }));
    const privatePayload = "private-relay-response-with-device-name-and-SAS";
    socket.send(`not json: ${privatePayload}`);
    socket.send(JSON.stringify({ type: "ready", detail: privatePayload }));
    await expect.poll(() => f.link.state.status).toBe("connected");
    expect(f.streams).toStrictEqual([]);
    socket.send(JSON.stringify({ type: "open", streamId: "bad" }));
    socket.send(JSON.stringify({ type: "open", streamId: "c".repeat(32) }));
    await expect.poll(() => f.streams).toStrictEqual(["c".repeat(32)]);
    expect(await f.link.retryNow()).toBeNull();
    f.link.refuse("c".repeat(32));
    await expect.poll(() => f.messages.length).toBe(2);
    expect(f.messages[1]).toStrictEqual({ type: "refuse", streamId: "c".repeat(32) });
    expect(f.link.state).toStrictEqual({ status: "connected", error: null, lastConnectedAt: 100 });
    f.clock.advance(LINK_PING_MS);
    await f.link.stop();
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
    expect(await f.link.retryNow()).toBe("relay_unreachable");
    expect(f.logs).toStrictEqual([
      { level: "info", host_id: f.endpoint.hostId, msg: "relay connected" },
      { level: "info", host_id: f.endpoint.hostId, code: 1006, ready: true, msg: "relay connection closed" },
    ]);
    const serialized = JSON.stringify(f.logs);
    expect(serialized).not.toContain(f.endpoint.token);
    expect(serialized).not.toContain(f.endpoint.url);
    expect(serialized).not.toContain(privatePayload);
  });

  it("classifies rejection, retries with backoff, and manual retry resets it", async () => {
    const f = await fixture();
    f.link.start();
    const retry = f.link.retryNow();
    await expect.poll(() => f.messages.length).toBe(1);
    f.sockets[0]!.close(4401, "private-relay-rejection-detail");
    expect(await retry).toBe("relay_rejected");
    expect(f.link.state).toStrictEqual({ status: "error", error: "relay_rejected", lastConnectedAt: null });
    f.clock.advance(999);
    expect(f.sockets).toHaveLength(1);
    f.clock.advance(1);
    await expect.poll(() => f.sockets.length).toBe(2);
    f.sockets[1]!.terminate();
    await expect.poll(() => f.link.state.status).toBe("error");
    f.clock.advance(1999);
    expect(f.sockets).toHaveLength(2);
    const manual = f.link.retryNow();
    await expect.poll(() => f.sockets.length).toBe(3);
    f.sockets[2]!.send(JSON.stringify({ type: "ready" }));
    expect(await manual).toBeNull();
    await f.link.stop();
    f.clock.advance(60_000);
    expect(f.sockets).toHaveLength(3);
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
    expect(f.logs).toStrictEqual([
      { level: "info", host_id: f.endpoint.hostId, code: 4401, ready: false, msg: "relay connection closed" },
      { level: "info", host_id: f.endpoint.hostId, code: 1006, ready: false, msg: "relay connection closed" },
      { level: "info", host_id: f.endpoint.hostId, msg: "relay connected" },
      { level: "info", host_id: f.endpoint.hostId, code: 1006, ready: true, msg: "relay connection closed" },
    ]);
    const serialized = JSON.stringify(f.logs);
    expect(serialized).not.toContain("private-relay-rejection-detail");
    expect(serialized).not.toContain(f.endpoint.token);
    expect(serialized).not.toContain(f.endpoint.url);
  });

  it("caps automatic backoff at one minute and resets it after ready", async () => {
    const f = await fixture();
    f.link.start();
    await expect.poll(() => f.sockets.length).toBe(1);
    for (const delay of [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]) {
      f.sockets.at(-1)!.terminate();
      await expect.poll(() => f.link.state.status).toBe("error");
      const count = f.sockets.length;
      f.clock.advance(delay - 1);
      expect(f.link.state.status).toBe("error");
      expect(f.sockets).toHaveLength(count);
      f.clock.advance(1);
      await expect.poll(() => f.sockets.length).toBe(count + 1);
    }
    const socket = f.sockets.at(-1)!;
    socket.send('{"type":"ready"}');
    await expect.poll(() => f.link.state.status).toBe("connected");
    socket.terminate();
    await expect.poll(() => f.link.state.status).toBe("error");
    const count = f.sockets.length;
    f.clock.advance(999);
    expect(f.link.state.status).toBe("error");
    f.clock.advance(1);
    await expect.poll(() => f.sockets.length).toBe(count + 1);
  });

  it("times out a silent relay and settles pending callers on shutdown", async () => {
    const f = await fixture();
    f.link.start();
    await expect.poll(() => f.messages.length).toBe(1);
    const attempt = f.link.retryNow();
    f.clock.advance(READY_TIMEOUT_MS);
    expect(await attempt).toBe("relay_unreachable");
    expect(f.link.diagnostics).toStrictEqual({
      kind: "connect",
      checkedAt: 10100,
      network: "passed",
      resolution: "not_applicable",
      tls: "not_applicable",
      token: "unknown",
      failure: "timeout",
    });
    expect(f.logs).toStrictEqual([
      { level: "warn", host_id: f.endpoint.hostId, msg: "relay did not say ready in time" },
      { level: "info", host_id: f.endpoint.hostId, code: 1006, ready: false, msg: "relay connection closed" },
    ]);
    const pending = f.link.retryNow();
    await f.link.stop();
    expect(await pending).toBe("relay_unreachable");
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
  });
});

/** Opens a real client for listener accounting. @remarks The link's shared-check integration is tested separately. @sideEffects Opens and registers cleanup for one socket. */
async function pongFixture() {
  const f = await fixture(false);
  const client = new WebSocket(`${f.endpoint.url}/v1/host`);
  client.on("error", () => {});
  cleanup.push(async () => {
    if (client.readyState === WebSocket.CLOSED) return;
    const closed = once(client, "close");
    client.terminate();
    await closed;
  });
  await once(client, "open");
  return { ...f, client, peer: f.sockets[0]! };
}

/** Applies a table case's physical ending. @remarks Expected outcomes remain explicit test data. @sideEffects Pongs, closes, or advances the injected deadline. */
function endPong(ending: string, peer: WebSocket, clock: FakeClock, payload: Buffer): void {
  if (ending === "success") peer.pong(payload);
  else if (ending === "timeout") clock.advance(READY_TIMEOUT_MS);
  else peer.close(ending === "reject" ? 4401 : 1000);
}

describe("the correlated pong's resources", () => {
  it.each([
    { ending: "success", rounds: 12, error: null, failure: null, expectedState: WebSocket.OPEN },
    {
      ending: "close",
      rounds: 1,
      error: "relay_unreachable",
      failure: "connection_closed",
      expectedState: WebSocket.CLOSED,
    },
    {
      ending: "reject",
      rounds: 1,
      error: "relay_rejected",
      failure: "token_rejected",
      expectedState: WebSocket.CLOSED,
    },
    { ending: "timeout", rounds: 1, error: "relay_unreachable", failure: "timeout", expectedState: WebSocket.OPEN },
  ])("releases listeners and deadlines after $ending", async ({ ending, rounds, error, failure, expectedState }) => {
    const f = await pongFixture();
    const { client, peer } = f;
    const before = { pong: client.listenerCount("pong"), close: client.listenerCount("close") };
    for (let round = 0; round < rounds; round++) {
      const ping = once(peer, "ping");
      const result = checkRelayPong(client, f, READY_TIMEOUT_MS);
      expect({ pong: client.listenerCount("pong"), close: client.listenerCount("close") }).toStrictEqual({
        pong: before.pong + 1,
        close: before.close + 1,
      });
      const [payload] = await ping;
      endPong(ending, peer, f.clock, payload);
      expect(await result).toStrictEqual({ error, failure });
      await expect.poll(() => client.readyState).toBe(expectedState);
      expect({ pong: client.listenerCount("pong"), close: client.listenerCount("close") }).toStrictEqual(before);
      expect(f.resources.snapshot()).toStrictEqual({ timer: 0 });
    }
  });
});

describe("probeRelay", () => {
  it.each([
    { bytes: 70 * 1024, result: null },
    { bytes: 70 * 1024 + 1, result: "relay_unreachable" },
  ])("enforces the probe's 70 KiB limit at $bytes bytes", async ({ bytes, result }) => {
    const f = await fixture();
    const pending = probeRelay(f.endpoint, { ...f, signal: new AbortController().signal });
    await expect.poll(() => f.messages.length).toBe(1);
    const frame = paddedControl("ready", bytes);
    expect(Buffer.byteLength(frame)).toBe(bytes);
    f.sockets[0]!.send(frame);
    expect(await pending).toBe(result);
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
  });

  it("does not negotiate compression for an independent probe", async () => {
    const f = await fixture(true, true);
    const pending = probeRelay(f.endpoint, { ...f, signal: new AbortController().signal });
    await expect.poll(() => f.messages.length).toBe(1);
    expect(f.sockets[0]!.extensions).toBe("");
    f.sockets[0]!.send('{"type":"ready"}');
    expect(await pending).toBeNull();
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
  });

  it("handles abort before the HTTP upgrade without an uncaught socket error", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const probe = probeRelay(f.endpoint, { ...f, signal: controller.signal });
    controller.abort();
    expect(await probe).toBe("relay_unreachable");
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
    expect(f.sockets).toStrictEqual([]);
  });

  it("ignores binary ready rather than treating it as successful authentication", async () => {
    const f = await fixture();
    const probe = probeRelay(f.endpoint, { ...f, signal: new AbortController().signal });
    await expect.poll(() => f.messages.length).toBe(1);
    f.sockets[0]!.send(Buffer.from('{"type":"ready"}'));
    f.sockets[0]!.close(4401);
    expect(await probe).toBe("relay_rejected");
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
  });

  it("times out malformed and irrelevant replies exactly at the ready deadline", async () => {
    const f = await fixture();
    const probe = probeRelay(f.endpoint, { ...f, signal: new AbortController().signal });
    await expect.poll(() => f.messages.length).toBe(1);
    for (const frame of ["null", "42", '"ready"', "[]", "{broken", '{"type":"open"}']) f.sockets[0]!.send(frame);
    f.clock.advance(READY_TIMEOUT_MS - 1);
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 1, timer: 1 });
    f.clock.advance(1);
    expect(await probe).toBe("relay_unreachable");
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
    f.clock.advance(60_000);
    expect(f.sockets).toHaveLength(1);
  });

  it("closes and releases resources before returning success", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const probe = probeRelay(f.endpoint, { ...f, signal: controller.signal });
    await expect.poll(() => f.messages.length).toBe(1);
    f.sockets[0]!.send(JSON.stringify({ type: "ready" }));
    expect(await probe).toBeNull();
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
  });

  it("cancels a pending probe without waiting for its deadline", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const probe = probeRelay(f.endpoint, { ...f, signal: controller.signal });
    await expect.poll(() => f.sockets.length).toBe(1);
    controller.abort();
    expect(await probe).toBe("relay_unreachable");
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
    expect(await probeRelay(f.endpoint, { ...f, signal: controller.signal })).toBe("relay_unreachable");
    expect(f.sockets).toHaveLength(1);
  });

  it("reports a rejected probe rather than unreachable", async () => {
    const f = await fixture();
    const probe = probeRelay(f.endpoint, { ...f, signal: new AbortController().signal });
    await expect.poll(() => f.sockets.length).toBe(1);
    f.sockets[0]!.close(4401);
    expect(await probe).toBe("relay_rejected");
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
  });
});
