import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newHost, onlineHost, openStream, Peer, slowPhone, startTestRelay, type TestRelay } from "../test/peers";
import { RelayClose, type RelayEvent } from "./relay";

const WebSocketOpen = 1;

let current: TestRelay | undefined;

afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

/**
 * Starts the relay for one test and registers it for cleanup.
 *
 * @remarks
 * `afterEach` closes it even when the test failed.
 *
 * @sideEffects Listens on a port.
 * @param options - As `startTestRelay`.
 * @returns The relay.
 */
async function relayFor(options: Parameters<typeof startTestRelay>[0] = {}): Promise<TestRelay> {
  current = await startTestRelay(options);
  return current;
}

/**
 * Plain HTTP request to the relay.
 *
 * @remarks
 * For `/healthz` and the 404s.
 *
 * @sideEffects Sends a request.
 * @param relay - The relay.
 * @param path - Path from the root.
 * @param method - HTTP method.
 * @returns Status and body.
 */
async function http(relay: TestRelay, path: string, method = "GET"): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${relay.port}${path}`, { method });
  return { status: response.status, body: await response.text() };
}

/**
 * Moves the fake clock forward in ping-sized steps, letting the host answer each ping.
 *
 * @remarks
 * One big jump would fire three pings with no chance to answer, and the relay would rightly drop
 * the host as unresponsive.
 *
 * @sideEffects Advances the clock; pings the relay.
 * @param relay - The relay.
 * @param control - The host's control connection.
 * @param ms - How far, a multiple of 20 seconds.
 * @returns Once done.
 */
async function advanceAlive(relay: TestRelay, control: Peer, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 20_000) {
    relay.clock.advance(20_000);
    await control.roundTrip();
    await control.roundTrip();
  }
}

/**
 * The address hashes of every `stream_opened` event so far.
 *
 * @remarks
 * To tell whether two phones counted as one address.
 *
 * @sideEffects none
 * @param relay - The relay.
 * @returns The hashes, in order.
 */
function openedHashes(relay: TestRelay): string[] {
  return relay.events.flatMap((event) => (event.event === "stream_opened" ? [event.ipHash] : []));
}

/**
 * The `host_online` and `host_offline` events so far.
 *
 * @remarks
 * The generations they carry show which control connection was which.
 *
 * @sideEffects none
 * @param relay - The relay.
 * @returns Those events, in order.
 */
function hostEvents(relay: TestRelay): RelayEvent[] {
  return relay.events.filter((event) => event.event === "host_online" || event.event === "host_offline");
}

/**
 * Sends `frame` on `slow` and one numbered byte on `fast`, round after round, until the relay closes
 * `slow` (at most 1000 rounds).
 *
 * @remarks
 * The round trip after each frame lets the relay read it, so its backlog check runs on every frame.
 *
 * @sideEffects Sends frames.
 * @param slow - The data connection of the phone that does not read.
 * @param fast - The data connection of a phone that reads.
 * @param frame - What to send to the slow one.
 * @returns How many rounds were sent.
 */
async function sendUntilClosed(slow: Peer, fast: Peer, frame: Buffer): Promise<number> {
  let sent = 0;
  while (slow.socket.readyState === WebSocketOpen && sent < 1_000) {
    slow.socket.send(frame);
    fast.socket.send(Buffer.from([sent % 256]));
    sent += 1;
    await slow.roundTrip();
  }
  return sent;
}

describe("relay entry points", () => {
  it("answers /healthz under the prefix and 404 everywhere else", async () => {
    const relay = await relayFor();

    expect(await http(relay, "/atrium/healthz")).toStrictEqual({ status: 200, body: "ok\n" });
    expect(await http(relay, "/healthz")).toStrictEqual({ status: 404, body: "" });
    expect(await http(relay, "/atrium/healthz", "POST")).toStrictEqual({ status: 404, body: "" });
    expect(await http(relay, "/atrium/v1/host")).toStrictEqual({ status: 404, body: "" });
    expect(await http(relay, "/atrium/other")).toStrictEqual({ status: 404, body: "" });
  });

  it("answers /healthz as uncached plain text, and still while it holds a keep-alive connection to close", async () => {
    const relay = await relayFor();

    const response = await fetch(`http://127.0.0.1:${relay.port}/atrium/healthz`);
    await response.text();
    await relay.relay.close();
    current = undefined;

    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not compress frames even when the client offers it", async () => {
    const relay = await relayFor();
    const control = relay.peer("/v1/host", { perMessageDeflate: true });

    await control.opened;

    expect(control.socket.extensions).toBe("");
  });

  it("refuses WebSocket upgrades outside the three entry points", async () => {
    const relay = await relayFor();
    const outside = new Peer(`ws://127.0.0.1:${relay.port}/v1/host`);
    const health = relay.peer("/healthz");
    const unknown = relay.peer("/v1/other");

    await expect(outside.opened).rejects.toThrow("upgrade refused: 404");
    await expect(health.opened).rejects.toThrow("upgrade refused: 404");
    await expect(unknown.opened).rejects.toThrow("upgrade refused: 404");
  });

  it("works at the root when there is no prefix", async () => {
    const relay = await relayFor({ config: { pathPrefix: "" } });
    const control = await onlineHost(relay);
    const { phone, data } = await openStream(relay, control);

    phone.socket.send(Buffer.from([1, 2, 3]));
    expect((await data.next()).data).toStrictEqual(Buffer.from([1, 2, 3]));
    expect(await http(relay, "/healthz")).toStrictEqual({ status: 200, body: "ok\n" });
  });
});

describe("relay pass-through", () => {
  it("sends the host ready, then open with a 128-bit stream id and an address hash", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const phone = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    await phone.opened;

    const open = await control.json();

    expect(Object.keys(open).toSorted()).toStrictEqual(["ipHash", "streamId", "type"]);
    expect(open["type"]).toBe("open");
    expect(open["streamId"]).toMatch(/^[0-9a-f]{32}$/);
    expect(open["ipHash"]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("passes binary frames both ways untouched and in order", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const { phone, data } = await openStream(relay, control);
    const up = [randomBytes(1), randomBytes(65_535), randomBytes(300)];
    const down = [randomBytes(70 * 1024), randomBytes(17)];

    for (const frame of up) phone.socket.send(frame);
    for (const frame of down) data.socket.send(frame);
    const received = {
      up: [await data.next(), await data.next(), await data.next()],
      down: [await phone.next(), await phone.next()],
    };

    expect(received.up.map((message) => message.data)).toStrictEqual(up);
    expect(received.down.map((message) => message.data)).toStrictEqual(down);
    expect([...received.up, ...received.down].every((message) => message.binary)).toBe(true);
  });

  it("holds what the phone sends before the data connection and delivers it first, in order", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const phone = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    await phone.opened;
    const { streamId } = await control.json();
    const early = Array.from({ length: 8 }, (_, index) => Buffer.from([index]));
    for (const frame of early) phone.socket.send(frame);
    await phone.roundTrip();

    const data = relay.peer("/v1/host/stream");
    await data.opened;
    data.sendJson({ v: 1, type: "hello", hostId: relay.host.hostId, token: relay.host.token, streamId });
    phone.socket.send(Buffer.from([99]));
    const received = await Promise.all(Array.from({ length: 9 }, () => data.next()));

    expect(received.map((message) => message.data)).toStrictEqual([...early, Buffer.from([99])]);
  });

  it("closes the other end with 1000 when either end of a pair closes", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const first = await openStream(relay, control);
    const second = await openStream(relay, control);

    first.phone.socket.close(1000);
    second.data.socket.close(1000);

    expect(await first.data.closed).toStrictEqual({ code: 1000, reason: "" });
    expect(await second.phone.closed).toStrictEqual({ code: 1000, reason: "" });
    expect(relay.resources.snapshot()["stream"]).toBe(0);
  });

  it("closes a pair with 4400 when the phone or the data connection sends text", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const first = await openStream(relay, control);
    const second = await openStream(relay, control);

    first.phone.socket.send("text");
    second.data.socket.send("text");

    expect(await first.phone.closed).toStrictEqual({ code: RelayClose.BadRequest, reason: "" });
    expect(await first.data.closed).toStrictEqual({ code: RelayClose.BadRequest, reason: "" });
    expect(await second.phone.closed).toStrictEqual({ code: RelayClose.BadRequest, reason: "" });
    expect(await second.data.closed).toStrictEqual({ code: RelayClose.BadRequest, reason: "" });
  });

  it("closes the phone with 4400 when it sends text before the data connection", async () => {
    const relay = await relayFor();
    await onlineHost(relay);
    const phone = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    await phone.opened;

    phone.socket.send("text");

    expect(await phone.closed).toStrictEqual({ code: RelayClose.BadRequest, reason: "" });
  });
});

describe("relay authentication", () => {
  it.each([
    ["a wrong token", (relay: TestRelay) => ({ v: 1, type: "hello", hostId: relay.host.hostId, token: "wrong" })],
    [
      "an unknown host",
      (relay: TestRelay) => ({ v: 1, type: "hello", hostId: newHost().hostId, token: relay.host.token }),
    ],
    [
      "another version",
      (relay: TestRelay) => ({ v: 2, type: "hello", hostId: relay.host.hostId, token: relay.host.token }),
    ],
    [
      "another type",
      (relay: TestRelay) => ({ v: 1, type: "open", hostId: relay.host.hostId, token: relay.host.token }),
    ],
    ["no token", (relay: TestRelay) => ({ v: 1, type: "hello", hostId: relay.host.hostId })],
  ])("closes the control connection with 4401 for %s", async (_name, hello) => {
    const relay = await relayFor();
    const control = relay.peer("/v1/host");
    await control.opened;

    control.sendJson(hello(relay));

    expect(await control.closed).toStrictEqual({ code: RelayClose.Unauthorized, reason: "" });
    expect(control.queued).toBe(0);
  });

  it("closes with 4401 for a binary or non-JSON hello", async () => {
    const relay = await relayFor();
    const binary = relay.peer("/v1/host");
    const garbage = relay.peer("/v1/host");
    await Promise.all([binary.opened, garbage.opened]);

    binary.socket.send(
      Buffer.from(JSON.stringify({ v: 1, type: "hello", hostId: relay.host.hostId, token: relay.host.token })),
    );
    garbage.socket.send("{not json");

    expect(await binary.closed).toStrictEqual({ code: RelayClose.Unauthorized, reason: "" });
    expect(await garbage.closed).toStrictEqual({ code: RelayClose.Unauthorized, reason: "" });
  });

  it("closes a data connection with 4401 for a wrong token or a missing stream id", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const phone = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    await phone.opened;
    const { streamId } = await control.json();
    const wrong = relay.peer("/v1/host/stream");
    const missing = relay.peer("/v1/host/stream");
    await Promise.all([wrong.opened, missing.opened]);

    wrong.sendJson({ v: 1, type: "hello", hostId: relay.host.hostId, token: "wrong", streamId });
    missing.sendJson({ v: 1, type: "hello", hostId: relay.host.hostId, token: relay.host.token });

    expect(await wrong.closed).toStrictEqual({ code: RelayClose.Unauthorized, reason: "" });
    expect(await missing.closed).toStrictEqual({ code: RelayClose.Unauthorized, reason: "" });
  });

  it.each([`x${"0".repeat(32)}`, `${"0".repeat(32)}x`, "0".repeat(31)])(
    "closes a data connection with 4401 for the stream id %j",
    async (streamId) => {
      const relay = await relayFor();
      await onlineHost(relay);
      const data = relay.peer("/v1/host/stream");
      await data.opened;

      data.sendJson({ v: 1, type: "hello", hostId: relay.host.hostId, token: relay.host.token, streamId });

      expect(await data.closed).toStrictEqual({ code: RelayClose.Unauthorized, reason: "" });
    },
  );

  it("logs a failed hello with the host id only when it looks like one, and never the token", async () => {
    const relay = await relayFor();
    const known = relay.peer("/v1/host");
    const odd = relay.peer("/v1/host");
    await Promise.all([known.opened, odd.opened]);

    known.sendJson({ v: 1, type: "hello", hostId: relay.host.hostId, token: "secret-guess" });
    await known.closed;
    odd.sendJson({ v: 1, type: "hello", hostId: "<script>", token: "secret-guess" });
    await odd.closed;

    expect(relay.events).toStrictEqual([
      { level: "warn", event: "auth_failed", route: "control", hostId: relay.host.hostId },
      { level: "warn", event: "auth_failed", route: "control" },
    ]);
  });

  it("gives a host 5 seconds for its hello, then closes with 4408", async () => {
    const relay = await relayFor();
    const slow = relay.peer("/v1/host");
    const late = relay.peer("/v1/host/stream");
    const inTime = relay.peer("/v1/host");
    await Promise.all([slow.opened, late.opened, inTime.opened]);

    relay.clock.advance(4_999);
    inTime.sendJson({ v: 1, type: "hello", hostId: relay.host.hostId, token: relay.host.token });
    expect(await inTime.json()).toStrictEqual({ type: "ready" });
    relay.clock.advance(1);

    expect(await slow.closed).toStrictEqual({ code: RelayClose.Timeout, reason: "" });
    expect(await late.closed).toStrictEqual({ code: RelayClose.Timeout, reason: "" });
    expect(inTime.socket.readyState).toBe(WebSocketOpen);
  });
});

describe("relay hello deadline", () => {
  it("does not accept a hello that arrives after its timer fired", async () => {
    const relay = await relayFor();
    const late = relay.peer("/v1/host");
    await late.opened;

    late.sendJson({ v: 1, type: "hello", hostId: relay.host.hostId, token: relay.host.token });
    relay.clock.advance(5_000);

    expect(await late.closed).toStrictEqual({ code: RelayClose.Timeout, reason: "" });
    expect(late.queued).toBe(0);
    expect(relay.events).toStrictEqual([]);
  });

  it("frees an unauthenticated slot once per connection, however it ends", async () => {
    const relay = await relayFor({ limits: { maxUnauthenticated: 2 } });
    for (let index = 0; index < 3; index += 1) {
      const control = await onlineHost(relay);
      control.socket.close();
      await control.closed;
    }
    await vi.waitFor(() => expect(relay.resources.snapshot()["ws.host"]).toBe(0));
    const pending = [relay.peer("/v1/host"), relay.peer("/v1/host")];
    await Promise.all(pending.map((peer) => peer.opened));

    const third = relay.peer("/v1/host");

    expect(await third.closed).toStrictEqual({ code: RelayClose.TooMany, reason: "" });
  });
});

describe("relay control generations", () => {
  it("lets a new control connection replace the old one and closes the old one's streams with 4409", async () => {
    const relay = await relayFor();
    const old = await onlineHost(relay);
    const oldStream = await openStream(relay, old);

    const fresh = await onlineHost(relay);

    expect(await old.closed).toStrictEqual({ code: RelayClose.Replaced, reason: "" });
    expect(await oldStream.phone.closed).toStrictEqual({ code: RelayClose.Replaced, reason: "" });
    expect(await oldStream.data.closed).toStrictEqual({ code: RelayClose.Replaced, reason: "" });
    const { phone, data } = await openStream(relay, fresh);
    phone.socket.send(Buffer.from("after"));
    expect((await data.next()).data).toStrictEqual(Buffer.from("after"));
  });

  it("does not let the old connection's close take the new one offline", async () => {
    const relay = await relayFor();
    const old = await onlineHost(relay);
    const fresh = await onlineHost(relay);
    await old.closed;
    await vi.waitFor(() => expect(relay.resources.snapshot()["ws.host"]).toBe(1));

    const { phone, data } = await openStream(relay, fresh);

    phone.socket.send(Buffer.from([7]));
    expect((await data.next()).data).toStrictEqual(Buffer.from([7]));
    expect(relay.events.filter((event) => event.event === "host_offline")).toStrictEqual([
      { level: "info", event: "host_offline", hostId: relay.host.hostId, generation: 1, reason: "replaced" },
    ]);
  });

  it("refuses a data connection for a stream announced on a replaced control connection with 4404", async () => {
    const relay = await relayFor();
    const old = await onlineHost(relay);
    const phone = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    await phone.opened;
    const { streamId } = await old.json();
    await onlineHost(relay);
    await phone.closed;

    const data = relay.peer("/v1/host/stream");
    await data.opened;
    data.sendJson({ v: 1, type: "hello", hostId: relay.host.hostId, token: relay.host.token, streamId });

    expect((await data.closed).code).toBe(RelayClose.Offline);
  });
});

describe("relay offline hosts", () => {
  it("closes a phone with 4404 offline:0 for a host never online, and 4400 for a malformed host id", async () => {
    const relay = await relayFor();
    const never = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    const unknown = relay.peer(`/v1/client?host=${newHost().hostId}`);
    const malformed = relay.peer("/v1/client?host=mac");
    const missing = relay.peer("/v1/client");

    expect(await never.closed).toStrictEqual({ code: RelayClose.Offline, reason: "offline:0" });
    expect(await unknown.closed).toStrictEqual({ code: RelayClose.Offline, reason: "offline:0" });
    expect(await malformed.closed).toStrictEqual({ code: RelayClose.BadRequest, reason: "" });
    expect(await missing.closed).toStrictEqual({ code: RelayClose.BadRequest, reason: "" });
  });

  it("closes the host's streams and later phones with offline:<when it went away>", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const { phone, data } = await openStream(relay, control);
    relay.clock.advance(12_345);
    const goneAt = Math.floor(relay.clock.now() / 1000);

    control.socket.close(1000);

    expect(await phone.closed).toStrictEqual({ code: RelayClose.Offline, reason: `offline:${goneAt}` });
    expect(await data.closed).toStrictEqual({ code: 1000, reason: "" });
    const later = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    expect(await later.closed).toStrictEqual({ code: RelayClose.Offline, reason: `offline:${goneAt}` });
  });

  it("pings the host every 20 seconds and keeps it while it answers", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    let pings = 0;
    control.socket.on("ping", () => (pings += 1));

    for (let round = 0; round < 5; round += 1) {
      relay.clock.advance(20_000);
      await control.roundTrip();
    }

    expect(pings).toBe(5);
    expect(control.socket.readyState).toBe(WebSocketOpen);
  });

  it("drops a host that has not answered pings for 60 seconds, with its streams", async () => {
    const relay = await relayFor();
    const control = relay.peer("/v1/host", { autoPong: false });
    await control.opened;
    control.sendJson({ v: 1, type: "hello", hostId: relay.host.hostId, token: relay.host.token });
    await control.json();
    const { phone } = await openStream(relay, control);

    relay.clock.advance(40_000);
    await control.roundTrip();
    expect(control.socket.readyState).toBe(WebSocketOpen);
    relay.clock.advance(20_000);

    expect((await control.closed).code).toBe(1006);
    expect((await phone.closed).code).toBe(RelayClose.Offline);
    expect(relay.events.at(-1)).toMatchObject({ event: "host_offline", reason: "unresponsive" });
  });
});

describe("relay wiring a stream", () => {
  it("closes the phone with 4408 when no data connection comes within 10 seconds", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const phone = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    await phone.opened;
    const { streamId } = await control.json();

    relay.clock.advance(9_999);
    await phone.roundTrip();
    expect(phone.socket.readyState).toBe(WebSocketOpen);
    relay.clock.advance(1);

    expect(await phone.closed).toStrictEqual({ code: RelayClose.Timeout, reason: "" });
    const data = relay.peer("/v1/host/stream");
    await data.opened;
    data.sendJson({ v: 1, type: "hello", hostId: relay.host.hostId, token: relay.host.token, streamId });
    expect((await data.closed).code).toBe(RelayClose.Offline);
  });

  it("does not time a stream out once its data connection joined", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const { phone, data } = await openStream(relay, control);

    await advanceAlive(relay, control, 60_000);
    phone.socket.send(Buffer.from([1]));

    expect((await data.next()).data).toStrictEqual(Buffer.from([1]));
  });

  it("refuses a second data connection for the same stream with 4404", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const { streamId } = await openStream(relay, control);

    const again = relay.peer("/v1/host/stream");
    await again.opened;
    again.sendJson({ v: 1, type: "hello", hostId: relay.host.hostId, token: relay.host.token, streamId });

    expect((await again.closed).code).toBe(RelayClose.Offline);
  });

  it("closes the phone with 4403 when the host refuses the stream", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const phone = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    await phone.opened;
    const { streamId } = await control.json();

    control.sendJson({ type: "refuse", streamId });

    expect(await phone.closed).toStrictEqual({ code: RelayClose.Refused, reason: "" });
  });

  it("ignores a refuse for a stream it does not know", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const { phone } = await openStream(relay, control);

    control.sendJson({ type: "refuse", streamId: "0".repeat(32) });
    await control.roundTrip();

    expect(control.socket.readyState).toBe(WebSocketOpen);
    expect(phone.socket.readyState).toBe(WebSocketOpen);
  });

  it("leaves no timer behind once a host and its streams are gone", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    relay.peer(`/v1/client?host=${relay.host.hostId}`);
    await control.json();

    control.socket.close();
    await control.closed;

    await vi.waitFor(() => expect(relay.resources.snapshot()["ws.host"]).toBe(0));
    expect(relay.clock.pendingTimers()).toBe(1);
    relay.clock.advance(60_000);
    expect(relay.clock.pendingTimers()).toBe(0);
  });

  it.each([
    ["binary", Buffer.from(JSON.stringify({ type: "refuse", streamId: "0".repeat(32) }))],
    ["not JSON", "nope"],
    ["an unknown type", JSON.stringify({ type: "hello" })],
  ])("closes a control connection that sends %s with 4400, taking its streams down", async (_name, frame) => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const { phone } = await openStream(relay, control);

    control.socket.send(frame);

    expect(await control.closed).toStrictEqual({ code: RelayClose.BadRequest, reason: "" });
    expect((await phone.closed).code).toBe(RelayClose.Offline);
  });

  it("closes the phone with 4507 after 8 frames held before the data connection", async () => {
    const relay = await relayFor();
    await onlineHost(relay);
    const phone = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    await phone.opened;

    for (let index = 0; index < 9; index += 1) phone.socket.send(Buffer.from([index]));

    expect(await phone.closed).toStrictEqual({ code: RelayClose.Overloaded, reason: "" });
  });

  it("closes the phone with 4507 after 256 KiB held before the data connection", async () => {
    const relay = await relayFor();
    await onlineHost(relay);
    const phone = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    await phone.opened;
    const almost = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    await almost.opened;

    for (let index = 0; index < 4; index += 1) almost.socket.send(randomBytes(64 * 1024));
    for (let index = 0; index < 4; index += 1) phone.socket.send(randomBytes(64 * 1024));
    phone.socket.send(randomBytes(1));
    await almost.roundTrip();

    expect(await phone.closed).toStrictEqual({ code: RelayClose.Overloaded, reason: "" });
    expect(almost.socket.readyState).toBe(WebSocketOpen);
  });
});

describe("relay limits", () => {
  it("passes a 70 KiB frame and closes the sender of a bigger one with 1009, the other end with 1000", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const { phone, data } = await openStream(relay, control);

    phone.socket.send(randomBytes(70 * 1024));
    expect((await data.next()).data).toHaveLength(70 * 1024);
    phone.socket.send(randomBytes(70 * 1024 + 1));

    expect((await phone.closed).code).toBe(1009);
    expect(await data.closed).toStrictEqual({ code: 1000, reason: "" });
  });

  it("allows 16 streams per host and closes the 17th phone with 4429", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const phones: Peer[] = [];
    for (let index = 0; index < 16; index += 1) {
      const phone = relay.peer(`/v1/client?host=${relay.host.hostId}`);
      await phone.opened;
      await control.json();
      phones.push(phone);
    }

    const extra = relay.peer(`/v1/client?host=${relay.host.hostId}`);

    expect(await extra.closed).toStrictEqual({ code: RelayClose.TooMany, reason: "" });
    phones[0]?.socket.close();
    await phones[0]?.closed;
    await control.roundTrip();
    const next = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    await next.opened;
    expect((await control.json())["type"]).toBe("open");
  });

  it("allows 64 unauthenticated host connections and closes the 65th with 4429", async () => {
    const relay = await relayFor();
    const pending: Peer[] = [];
    for (let index = 0; index < 32; index += 1) pending.push(relay.peer("/v1/host"), relay.peer("/v1/host/stream"));
    await Promise.all(pending.map((peer) => peer.opened));

    const extra = relay.peer("/v1/host");

    expect(await extra.closed).toStrictEqual({ code: RelayClose.TooMany, reason: "" });
    pending[0]?.sendJson({ v: 1, type: "hello", hostId: relay.host.hostId, token: relay.host.token });
    await pending[0]?.json();
    const control = await onlineHost(relay);
    expect(control.socket.readyState).toBe(WebSocketOpen);
  });

  it("allows 30 new streams per address per minute, counting only streams that were set up", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    relay.peer(`/v1/client?host=${newHost().hostId}`);
    for (let index = 0; index < 30; index += 1) {
      const phone = relay.peer(`/v1/client?host=${relay.host.hostId}`);
      await phone.opened;
      await control.json();
      phone.socket.close();
      await phone.closed;
    }

    const extra = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    expect(await extra.closed).toStrictEqual({ code: RelayClose.TooMany, reason: "" });
    await advanceAlive(relay, control, 60_000);
    const later = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    await later.opened;

    expect((await control.json())["type"]).toBe("open");
  });

  it("does not limit new streams per address when the setting is 0", async () => {
    const relay = await relayFor({ config: { newStreamsPerIpPerMinute: 0 } });
    const control = await onlineHost(relay);
    for (let index = 0; index < 35; index += 1) {
      const phone = relay.peer(`/v1/client?host=${relay.host.hostId}`);
      await phone.opened;
      await control.json();
      phone.socket.close();
      await phone.closed;
    }

    const last = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    await last.opened;

    expect((await control.json())["type"]).toBe("open");
  });

  it("takes the address from X-Forwarded-For only when the proxy is trusted", async () => {
    const trusting = await relayFor({ config: { trustedProxies: ["127.0.0.1"], newStreamsPerIpPerMinute: 1 } });
    const control = await onlineHost(trusting);
    const first = await openStream(trusting, control, trusting.host, { headers: { "x-forwarded-for": "203.0.113.1" } });
    const firstHash = trusting.events.find((event) => event.event === "stream_opened");

    const sameAddress = trusting.peer(`/v1/client?host=${trusting.host.hostId}`, {
      headers: { "x-forwarded-for": "203.0.113.1" },
    });
    expect(await sameAddress.closed).toStrictEqual({ code: RelayClose.TooMany, reason: "" });
    const other = await openStream(trusting, control, trusting.host, { headers: { "x-forwarded-for": "203.0.113.2" } });
    const hashes = openedHashes(trusting);

    expect(first.phone.socket.readyState).toBe(WebSocketOpen);
    expect(other.phone.socket.readyState).toBe(WebSocketOpen);
    expect(new Set(hashes).size).toBe(2);
    expect(firstHash).toMatchObject({ event: "stream_opened" });
  });

  it("ignores X-Forwarded-For from a proxy it does not trust", async () => {
    const relay = await relayFor({ config: { newStreamsPerIpPerMinute: 1 } });
    const control = await onlineHost(relay);
    await openStream(relay, control, relay.host, { headers: { "x-forwarded-for": "203.0.113.1" } });

    const other = relay.peer(`/v1/client?host=${relay.host.hostId}`, { headers: { "x-forwarded-for": "203.0.113.2" } });

    expect(await other.closed).toStrictEqual({ code: RelayClose.TooMany, reason: "" });
  });

  it("turns new phones away with 4507 while the relay holds more than its total buffer", async () => {
    const relay = await relayFor({ limits: { totalBufferBytes: 100_000 } });
    await onlineHost(relay);
    const holding = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    await holding.opened;
    holding.socket.send(randomBytes(60_000));
    holding.socket.send(randomBytes(60_000));
    await holding.roundTrip();

    const next = relay.peer(`/v1/client?host=${relay.host.hostId}`);

    expect(await next.closed).toStrictEqual({ code: RelayClose.Overloaded, reason: "" });
    holding.socket.close();
    await holding.closed;
    const after = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    await after.opened;
    expect(after.socket.readyState).toBe(WebSocketOpen);
  });

  it("closes a phone that reads too slowly with 4507 once 4 MiB pile up, without holding up another phone", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const slow = await slowPhone(relay.port, `/atrium/v1/client?host=${relay.host.hostId}`);
    const { streamId } = await control.json();
    const slowData = relay.peer("/v1/host/stream");
    await slowData.opened;
    slowData.sendJson({ v: 1, type: "hello", hostId: relay.host.hostId, token: relay.host.token, streamId });
    const fast = await openStream(relay, control);
    const frame = randomBytes(64 * 1024);

    const sent = await sendUntilClosed(slowData, fast.data, frame);
    const received = await Promise.all(Array.from({ length: sent }, () => fast.phone.next()));
    slow.destroy();

    expect(await slowData.closed).toStrictEqual({ code: RelayClose.Overloaded, reason: "" });
    expect(sent * frame.length).toBeGreaterThan(4 * 1024 * 1024);
    expect(received.map((message) => message.data[0])).toStrictEqual(
      Array.from({ length: sent }, (_, index) => index % 256),
    );
    expect(fast.phone.socket.readyState).toBe(WebSocketOpen);
  });
});

describe("relay host table", () => {
  it("cuts a removed host off: control 4401, its phones 4404, its data connections 4401", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const { phone, data } = await openStream(relay, control);
    const goneAt = Math.floor(relay.clock.now() / 1000);

    relay.relay.updateHosts([]);

    expect(await control.closed).toStrictEqual({ code: RelayClose.Unauthorized, reason: "" });
    expect(await phone.closed).toStrictEqual({ code: RelayClose.Offline, reason: `offline:${goneAt}` });
    expect(await data.closed).toStrictEqual({ code: RelayClose.Unauthorized, reason: "" });
    const again = relay.peer("/v1/host");
    await again.opened;
    again.sendJson({ v: 1, type: "hello", hostId: relay.host.hostId, token: relay.host.token });
    expect(await again.closed).toStrictEqual({ code: RelayClose.Unauthorized, reason: "" });
  });

  it("cuts a host off when its token changes and accepts only the new token", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const rotated = newHost();
    const record = { ...relay.host.record, tokenSha256: rotated.record.tokenSha256 };

    relay.relay.updateHosts([record]);

    expect(await control.closed).toStrictEqual({ code: RelayClose.Unauthorized, reason: "" });
    const old = relay.peer("/v1/host");
    await old.opened;
    old.sendJson({ v: 1, type: "hello", hostId: relay.host.hostId, token: relay.host.token });
    expect(await old.closed).toStrictEqual({ code: RelayClose.Unauthorized, reason: "" });
    const fresh = await onlineHost(relay, { hostId: relay.host.hostId, token: rotated.token });
    expect(fresh.socket.readyState).toBe(WebSocketOpen);
    expect(hostEvents(relay)).toStrictEqual([
      { level: "info", event: "host_online", hostId: relay.host.hostId, generation: 1 },
      { level: "info", event: "host_offline", hostId: relay.host.hostId, generation: 1, reason: "revoked" },
      { level: "info", event: "host_online", hostId: relay.host.hostId, generation: 3 },
    ]);
  });

  it("tells phones when a cut-off host was last online, and keeps offline:0 for one never online", async () => {
    const relay = await relayFor();
    const never = newHost("Never");
    relay.relay.updateHosts([relay.host.record, never.record]);
    const control = await onlineHost(relay);
    relay.clock.advance(7_000);
    const cutAt = Math.floor(relay.clock.now() / 1000);

    relay.relay.updateHosts([
      { ...relay.host.record, tokenSha256: newHost().record.tokenSha256 },
      { ...never.record, tokenSha256: newHost().record.tokenSha256 },
    ]);
    await control.closed;
    relay.clock.advance(3_000);
    const phone = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    const neverPhone = relay.peer(`/v1/client?host=${never.hostId}`);

    expect(await phone.closed).toStrictEqual({ code: RelayClose.Offline, reason: `offline:${cutAt}` });
    expect(await neverPhone.closed).toStrictEqual({ code: RelayClose.Offline, reason: "offline:0" });
    expect(relay.events.filter((event) => event.event === "host_offline")).toHaveLength(1);
  });

  it("keeps a host connected when only its name changes, and learns new hosts", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const added = newHost("Mini");

    relay.relay.updateHosts([{ ...relay.host.record, name: "Renamed" }, added.record]);
    const second = await onlineHost(relay, added);
    const { phone, data } = await openStream(relay, control);
    phone.socket.send(Buffer.from([5]));

    expect((await data.next()).data).toStrictEqual(Buffer.from([5]));
    expect(second.socket.readyState).toBe(WebSocketOpen);
  });
});

describe("relay log", () => {
  it("records metadata only: no payloads, hello frames, tokens or raw addresses", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const { phone, data, streamId } = await openStream(relay, control);
    const payload = Buffer.from("payload-marker-0123456789");
    phone.socket.send(payload);
    await data.next();
    data.socket.send(payload);
    await phone.next();
    phone.socket.close();
    await data.closed;
    const text = JSON.stringify(relay.events);

    expect(text).not.toContain(relay.host.token);
    expect(text).not.toContain("payload-marker");
    expect(text).not.toContain(payload.toString("hex"));
    expect(text).not.toContain(payload.toString("base64"));
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("hello");
    expect(relay.events.map((event) => event.event)).toStrictEqual([
      "host_online",
      "stream_opened",
      "stream_joined",
      "stream_closed",
    ]);
    expect(relay.events.at(-1)).toStrictEqual({
      level: "info",
      event: "stream_closed",
      hostId: relay.host.hostId,
      streamId,
      code: 1000,
      up: payload.length,
      down: payload.length,
      durationMs: 0,
    });
  });
});

describe("relay log events", () => {
  it("logs each event with exactly its fields", async () => {
    const relay = await relayFor({ limits: { maxUnauthenticated: 1 } });
    const control = await onlineHost(relay);
    const unknown = newHost();
    await relay.peer(`/v1/client?host=${unknown.hostId}`).closed;
    await relay.peer("/v1/client?host=mac").closed;
    const { phone, data, streamId } = await openStream(relay, control);
    phone.socket.close();
    await data.closed;
    const pending = relay.peer("/v1/host");
    await pending.opened;
    await relay.peer("/v1/host/stream").closed;
    pending.sendJson({ v: 1, type: "hello", hostId: relay.host.hostId, token: "wrong" });
    await pending.closed;
    control.socket.close();
    await vi.waitFor(() => expect(relay.events.at(-1)?.event).toBe("host_offline"));
    const ipHash = openedHashes(relay)[0];

    expect(relay.events).toStrictEqual([
      { level: "info", event: "host_online", hostId: relay.host.hostId, generation: 1 },
      { level: "info", event: "phone_rejected", hostId: unknown.hostId, ipHash, code: RelayClose.Offline },
      { level: "info", event: "phone_rejected", ipHash, code: RelayClose.BadRequest },
      { level: "info", event: "stream_opened", hostId: relay.host.hostId, streamId, ipHash },
      { level: "info", event: "stream_joined", hostId: relay.host.hostId, streamId },
      {
        level: "info",
        event: "stream_closed",
        hostId: relay.host.hostId,
        streamId,
        code: 1000,
        up: 0,
        down: 0,
        durationMs: 0,
      },
      { level: "warn", event: "connection_rejected", route: "data", code: RelayClose.TooMany },
      { level: "warn", event: "auth_failed", route: "control", hostId: relay.host.hostId },
      { level: "info", event: "host_offline", hostId: relay.host.hostId, generation: 1, reason: "closed" },
    ]);
  });
});

describe("relay shutdown", () => {
  it("closes every connection with 1001 and leaves no timers or counted resources", async () => {
    const relay = await relayFor();
    const control = await onlineHost(relay);
    const { phone, data } = await openStream(relay, control);
    const waiting = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    const pending = relay.peer("/v1/host");
    await Promise.all([waiting.opened, pending.opened]);
    await control.json();

    await relay.relay.close();
    current = undefined;

    expect(await control.closed).toStrictEqual({ code: 1001, reason: "" });
    expect(await phone.closed).toStrictEqual({ code: 1001, reason: "" });
    expect(await data.closed).toStrictEqual({ code: 1001, reason: "" });
    expect(await waiting.closed).toStrictEqual({ code: 1001, reason: "" });
    expect(await pending.closed).toStrictEqual({ code: 1001, reason: "" });
    expect(relay.clock.pendingTimers()).toBe(0);
    expect(relay.resources.snapshot()).toStrictEqual({
      stream: 0,
      timer: 0,
      "ws.host": 0,
      "ws.pending": 0,
      "ws.phone": 0,
    });
  });

  it("refuses new connections while closing and cuts off peers that do not answer within 2 seconds", async () => {
    const relay = await relayFor();
    await onlineHost(relay);
    const stuck = await slowPhone(relay.port, `/atrium/v1/client?host=${relay.host.hostId}`);
    let closed = false;
    const closing = relay.relay.close().then(() => (closed = true));
    current = undefined;

    const late = relay.peer("/v1/host");
    await expect(late.opened).rejects.toThrow("upgrade refused: 404");
    expect(closed).toBe(false);
    relay.clock.advance(2_000);
    await closing;
    stuck.destroy();

    expect(relay.clock.pendingTimers()).toBe(0);
  });
});
