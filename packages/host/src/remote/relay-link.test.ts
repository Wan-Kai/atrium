import { once } from "node:events";
import { FakeClock } from "@atrium/testkit";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { ResourceTracker } from "../platform/resources";
import { LINK_PING_MS, READY_TIMEOUT_MS, RelayLink, probeRelay, type LinkState } from "./relay-link";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/** Starts a controllable relay control endpoint. @remarks Used only for malformed and stalled relay behavior. @sideEffects Opens a loopback listener. */
async function fixture(autoPong = true) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, autoPong });
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
  const link = new RelayLink({
    endpoint,
    clock,
    resources,
    logger: pino({ enabled: false }),
    onState: (state) => states.push(state),
    onStream: (id) => streams.push(id),
  });
  cleanup.push(() => link.stop());
  return { server, endpoint, clock, resources, states, streams, link, sockets, messages };
}

describe("RelayLink", () => {
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
    socket.send("not json");
    socket.send(JSON.stringify({ type: "ready" }));
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
  });

  it("classifies rejection, retries with backoff, and manual retry resets it", async () => {
    const f = await fixture();
    f.link.start();
    const retry = f.link.retryNow();
    await expect.poll(() => f.messages.length).toBe(1);
    f.sockets[0]!.close(4401);
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
    await expect.poll(() => f.sockets.length).toBe(1);
    const attempt = f.link.retryNow();
    f.clock.advance(READY_TIMEOUT_MS);
    expect(await attempt).toBe("relay_unreachable");
    const pending = f.link.retryNow();
    await f.link.stop();
    expect(await pending).toBe("relay_unreachable");
    expect(f.resources.snapshot()).toStrictEqual({ "remote.control": 0, timer: 0 });
  });
});

describe("probeRelay", () => {
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
