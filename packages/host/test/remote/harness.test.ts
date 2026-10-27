import { PROTOCOL_VERSION } from "@atrium/protocol";
import {
  generateKeyPair,
  HandshakeState,
  HOST_TO_PHONE_LIMIT,
  PHONE_TO_HOST_LIMIT,
  parseFirstFrame,
  prologue,
  SecureChannel,
  toBase64Url,
  utf8,
  fromUtf8,
  sas,
  type KeyPair,
  type Received,
} from "@atrium/remote-crypto";
import { FakeClock } from "@atrium/testkit";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { Peer } from "../../../../apps/relay/test/peers";
import { systemClock } from "../../src/platform/clock";
import { FakePhone } from "./fake-phone";
import { Inbox } from "./inbox";
import { startTestRelay, type TestRelay } from "./relay-process";

/**
 * Opens a disposable raw peer for the harness's independent responder.
 * @remarks This verifies phone behavior without importing the host remote service under test.
 * @sideEffects Opens a socket and registers its teardown.
 * @param url - Local relay route.
 * @returns The connected peer.
 */
async function peer(url: string): Promise<Peer> {
  const result = new Peer(url);
  onTestFinished(async () => {
    result.socket.terminate();
    await result.closed;
  });
  await result.opened;
  return result;
}

/**
 * Answers a single Noise handshake on a relay data connection.
 * @remarks Acts only as a wire-level test peer, not a fake host service implementation.
 * @sideEffects Opens a socket and sends handshake message two.
 * @param relay - Owned real relay child.
 * @param control - Authenticated host control connection.
 * @param key - Host Noise identity.
 * @param psk - Pairing secret.
 * @param answer - Authenticated handshake payload.
 * @returns The data peer, channel and received plaintext request.
 */
async function respond(
  relay: TestRelay,
  control: Peer,
  key: KeyPair,
  psk: Uint8Array,
  answer: object = { ok: true },
): Promise<{ channel: SecureChannel; data: Peer; payload: unknown; inbox: Inbox<Received> }> {
  const open = await control.json();
  expect(open.type).toBe("open");
  const data = await peer(`${relay.endpoint.url}/v1/host/stream`);
  data.sendJson({
    v: 1,
    type: "hello",
    hostId: relay.endpoint.hostId,
    token: relay.endpoint.token,
    streamId: open.streamId,
  });
  const frame = await data.next();
  const parsed = parseFirstFrame(frame.data);
  const handshake = HandshakeState.responder({
    pattern: parsed.pattern,
    prologue: prologue(relay.endpoint.hostId),
    staticKey: key,
    ...(parsed.pattern === "IKpsk2" ? { psk } : {}),
  });
  const payload: unknown = JSON.parse(fromUtf8(handshake.readMessage(parsed.message)));
  const message2 = handshake.writeMessage(utf8(JSON.stringify(answer)));
  const inbox = new Inbox<Received>(systemClock);
  const channel = new SecureChannel(handshake.finish(), {
    clock: systemClock,
    sendLimit: HOST_TO_PHONE_LIMIT,
    receiveLimit: PHONE_TO_HOST_LIMIT,
    write: (bytes) => data.socket.send(bytes),
    onReceive: (received) => inbox.push(received),
    onClose: (reason) => inbox.fail(new Error(reason)),
  });
  data.socket.on("message", (bytes) => channel.receive(bytes as Buffer));
  data.socket.once("close", () => channel.close("closed"));
  data.socket.send(message2);
  return { channel, data, payload, inbox };
}

/**
 * Builds a pairing link using only the disposable relay endpoint.
 * @remarks Keeps secrets within test-owned objects and the local encrypted connection.
 * @sideEffects none
 * @param relay - Owned relay.
 * @param key - Host identity.
 * @param psk - Pairing secret.
 * @returns QR payload.
 */
function linkFor(relay: TestRelay, key: KeyPair, psk: Uint8Array): string {
  return `atrium://pair?${new URLSearchParams({ v: "1", relay: relay.endpoint.url, host: relay.endpoint.hostId, key: toBase64Url(key.publicKey), pairing: "pairing-test", psk: toBase64Url(psk), name: "Test Mac" }).toString()}`;
}

/**
 * Decodes an expected message arrival.
 * @remarks Fails instead of silently substituting a different frame kind.
 * @sideEffects none
 * @param item - Channel arrival.
 * @returns Its JSON payload.
 */
function jsonMessage(item: Received): unknown {
  if (item.kind !== "message") throw new Error("expected message");
  return JSON.parse(item.text);
}

describe("remote harness inbox", () => {
  it("preserves unrelated arrivals and the final control after close", async () => {
    const clock = new FakeClock();
    const inbox = new Inbox<string>(clock);
    inbox.push("event");
    const waiting = inbox.next((value) => value === "paired");
    inbox.push("paired");
    expect(await waiting).toBe("paired");
    inbox.fail(new Error("closed"));
    expect(await inbox.next(() => true)).toBe("event");
    await expect(inbox.next(() => true)).rejects.toThrow("closed");
    expect(clock.pendingTimers()).toBe(0);
  });

  it("cancels independent waiters and releases deadlines on timeout and abort", async () => {
    const clock = new FakeClock();
    const inbox = new Inbox<string>(clock);
    const controller = new AbortController();
    const aborted = inbox.next(() => true, { signal: controller.signal }).catch((error: unknown) => error);
    controller.abort();
    expect(await aborted).toStrictEqual(new Error("aborted"));
    expect(clock.pendingTimers()).toBe(0);
    const timed = inbox.next(() => true, { timeoutMs: 10 }).catch((error: unknown) => error);
    clock.advance(10);
    expect(await timed).toStrictEqual(new Error("timeout"));
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe("local relay and fake phone harness", () => {
  it("spawns the real relay CLI, registers a host and cleans process and files idempotently", async () => {
    const relay = await startTestRelay();
    onTestFinished(relay.cleanup);
    expect(relay.pid).not.toBe(process.pid);
    expect(relay.line).toBe(
      `atrium-relay://${relay.endpoint.hostId}:${relay.endpoint.token}@${relay.endpoint.url.slice(5)}`,
    );
    const hosts = await readFile(join(relay.dataDir, "hosts.json"), "utf8");
    expect(hosts).toContain(relay.endpoint.hostId);
    expect(hosts).not.toContain(relay.endpoint.token);
    const response = await fetch(`${relay.endpoint.url.replace("ws:", "http:")}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok\n");
    await relay.cleanup();
    await relay.cleanup();
    expect(() => process.kill(relay.pid, 0)).toThrow("ESRCH");
    await expect(access(relay.dataDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pairs, exchanges controls and chunked messages, overrides hello and reconnects with IK", async () => {
    const relay = await startTestRelay();
    onTestFinished(relay.cleanup);
    const control = await peer(`${relay.endpoint.url}/v1/host`);
    control.sendJson({ v: 1, type: "hello", hostId: relay.endpoint.hostId, token: relay.endpoint.token });
    expect(await control.json()).toMatchObject({ type: "ready" });
    const phone = new FakePhone();
    onTestFinished(() => phone.dispose());
    const key = generateKeyPair();
    const psk = new Uint8Array(32).fill(7);
    const pairing = phone.pair(linkFor(relay, key, psk), { confirm: false, protocolVersion: PROTOCOL_VERSION + 1 });
    const host = await respond(relay, control, key, psk);
    const session = await pairing;
    expect(host.payload).toStrictEqual({
      kind: "pair",
      pairingId: "pairing-test",
      deviceName: "Fake iPhone",
      model: "test",
      appVersion: "0.0.0-test",
      protocolVersion: PROTOCOL_VERSION + 1,
    });
    expect(session.sas).toBe(sas(host.channel.handshakeHash));
    expect(phone.hosts[0]?.deviceId).toBeNull();
    session.channel.sendControl({ kind: "pair_confirm" });
    expect(await host.inbox.next(() => true)).toStrictEqual({ kind: "control", value: { kind: "pair_confirm" } });
    host.channel.sendControl({ kind: "paired", deviceId: "device-test", hostName: "Test Mac" });
    expect(await session.control(["paired"])).toStrictEqual({
      kind: "paired",
      deviceId: "device-test",
      hostName: "Test Mac",
    });
    expect(phone.hosts[0]?.deviceId).toBe("device-test");
    session.sendHello("wrong-device", { protocolVersion: 1 });
    const hello = await host.inbox.next((item) => item.kind === "message");
    expect(jsonMessage(hello)).toMatchObject({ type: "hello", clientId: "wrong-device", protocolVersion: 1 });
    host.channel.sendMessage(JSON.stringify({ type: "event", text: "x".repeat(80_000) }));
    expect(await session.message()).toStrictEqual({ type: "event", text: "x".repeat(80_000) });
    session.channel.ping();
    expect(await session.next((value) => value.kind === "pong")).toStrictEqual({ kind: "pong" });
    await session.close({ terminate: true });
    expect(phone.hosts).toHaveLength(1);
    const connecting = phone.connect();
    const daily = await respond(relay, control, key, psk, { ok: true, deviceId: "device-test" });
    const connected = await connecting;
    expect(daily.payload).toStrictEqual({
      kind: "connect",
      appVersion: "0.0.0-test",
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(connected.deviceId).toBe("device-test");
    const welcome = connected.hello("device-test");
    const dailyHello = await daily.inbox.next((item) => item.kind === "message");
    expect(jsonMessage(dailyHello)).toMatchObject({
      type: "hello",
      clientId: "device-test",
      protocolVersion: PROTOCOL_VERSION,
    });
    daily.channel.sendMessage(JSON.stringify({ type: "welcome", protocolVersion: PROTOCOL_VERSION }));
    expect(await welcome).toStrictEqual({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    const response = connected.request({ type: "ping", requestId: "req-test" });
    const command = await daily.inbox.next((item) => item.kind === "message");
    expect(jsonMessage(command)).toMatchObject({ type: "ping", requestId: "req-test" });
    daily.channel.sendMessage(JSON.stringify({ type: "response", requestId: "req-test", ok: true }));
    expect(await response).toStrictEqual({ type: "response", requestId: "req-test", ok: true });
    daily.channel.sendControl({ kind: "revoked" });
    await connected.control(["revoked"]);
    expect(phone.hosts).toStrictEqual([]);
    await connected.close({ code: 1000, reason: "test done" });
    expect(await connected.closed).toMatchObject({ code: 1000 });
  });

  it("retains pending pairing after socket loss, then forgets it on authenticated device_unknown", async () => {
    const relay = await startTestRelay();
    onTestFinished(relay.cleanup);
    const control = await peer(`${relay.endpoint.url}/v1/host`);
    control.sendJson({ v: 1, type: "hello", hostId: relay.endpoint.hostId, token: relay.endpoint.token });
    expect(await control.json()).toMatchObject({ type: "ready" });
    const phone = new FakePhone();
    onTestFinished(() => phone.dispose());
    const key = generateKeyPair();
    const psk = new Uint8Array(32).fill(8);
    const pairing = phone.pair(linkFor(relay, key, psk));
    const host = await respond(relay, control, key, psk);
    const session = await pairing;
    expect(await host.inbox.next(() => true)).toStrictEqual({ kind: "control", value: { kind: "pair_confirm" } });
    const waiting = session.control(["paired"]).catch((error: unknown) => error);
    await session.close({ terminate: true });
    expect(await waiting).toBeInstanceOf(Error);
    expect(phone.hosts[0]?.deviceId).toBeNull();
    const connecting = phone.connect().catch((error: unknown) => error);
    await respond(relay, control, key, psk, { ok: false, reason: "device_unknown" });
    expect(await connecting).toStrictEqual(new Error("device_unknown"));
    expect(phone.hosts).toStrictEqual([]);
  });

  it("keeps a control sent immediately after message two and forgets a rejected pending pairing", async () => {
    const relay = await startTestRelay();
    onTestFinished(relay.cleanup);
    const control = await peer(`${relay.endpoint.url}/v1/host`);
    control.sendJson({ v: 1, type: "hello", hostId: relay.endpoint.hostId, token: relay.endpoint.token });
    expect(await control.json()).toMatchObject({ type: "ready" });
    const phone = new FakePhone();
    onTestFinished(() => phone.dispose());
    const key = generateKeyPair();
    const psk = new Uint8Array(32).fill(9);
    const pairing = phone.pair(linkFor(relay, key, psk), { confirm: false });
    const host = await respond(relay, control, key, psk);
    host.channel.sendControl({ kind: "pair_rejected", reason: "pairing_busy" });
    const session = await pairing;
    expect(await session.control(["pair_rejected"])).toStrictEqual({ kind: "pair_rejected", reason: "pairing_busy" });
    expect(phone.hosts).toStrictEqual([]);
  });

  it("cancels a stalled handshake and releases its socket and clock deadline", async () => {
    const relay = await startTestRelay();
    onTestFinished(relay.cleanup);
    const control = await peer(`${relay.endpoint.url}/v1/host`);
    control.sendJson({ v: 1, type: "hello", hostId: relay.endpoint.hostId, token: relay.endpoint.token });
    expect(await control.json()).toMatchObject({ type: "ready" });
    const clock = new FakeClock();
    const phone = new FakePhone({ clock });
    onTestFinished(() => phone.dispose());
    const controller = new AbortController();
    const pairing = phone
      .pair(linkFor(relay, generateKeyPair(), new Uint8Array(32)), { signal: controller.signal })
      .catch((error: unknown) => error);
    expect(await control.json()).toMatchObject({ type: "open" });
    controller.abort();
    expect(await pairing).toStrictEqual(new Error("aborted"));
    expect(clock.pendingTimers()).toBe(0);
  });

  it("disposes a phone while its handshake is still pending", async () => {
    const relay = await startTestRelay();
    onTestFinished(relay.cleanup);
    const control = await peer(`${relay.endpoint.url}/v1/host`);
    control.sendJson({ v: 1, type: "hello", hostId: relay.endpoint.hostId, token: relay.endpoint.token });
    expect(await control.json()).toMatchObject({ type: "ready" });
    const clock = new FakeClock();
    const phone = new FakePhone({ clock });
    onTestFinished(() => phone.dispose());
    const pairing = phone.pair(linkFor(relay, generateKeyPair(), new Uint8Array(32))).catch((error: unknown) => error);
    expect(await control.json()).toMatchObject({ type: "open" });
    await phone.dispose();
    expect(await pairing).toStrictEqual(new Error("socket_closed:1006:"));
    expect(clock.pendingTimers()).toBe(0);
  });

  it("refuses a non-loopback pairing link before connecting", async () => {
    const phone = new FakePhone();
    await expect(
      phone.pair(
        `atrium://pair?${new URLSearchParams({ v: "1", relay: "wss://example.invalid/atrium", host: "hst_test", key: "unused" }).toString()}`,
      ),
    ).rejects.toThrow("loopback test relay");
    expect(phone.hosts).toStrictEqual([]);
    await phone.dispose();
  });
});
