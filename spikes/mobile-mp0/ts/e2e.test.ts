import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeHost, type PairingRequest, PROTOCOL_VERSION } from "./fake-host.ts";
import { FakePhone, PhoneRejected, type PhoneSession } from "./fake-phone.ts";
import { generateKeyPair } from "./noise.ts";
import { type Relay, type RelayLog, startRelay } from "./relay.ts";

const HOST_ID = "hst_00112233445566aa";
const TOKEN = "spike-token";

let relay: Relay;
let host: FakeHost;
let dir: string;
let relayLog: RelayLog[];

/**
 * Waits until a condition holds, polling every 5 ms.
 *
 * @sideEffects Waits.
 * @param condition - What to wait for.
 * @param what - For the failure message.
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * The reason a promise was rejected with.
 *
 * @sideEffects Waits for the promise.
 * @param promise - Expected to reject with PhoneRejected.
 * @returns Its reason.
 */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PhoneRejected);
    return (error as PhoneRejected).reason;
  }
  throw new Error("expected a rejection");
}

/**
 * Starts the fake host against the relay and waits until the relay has it online.
 *
 * @sideEffects Connects.
 * @returns The host.
 */
async function startHost(): Promise<FakeHost> {
  const online = relayLog.filter((entry) => entry.event === "host_online").length;
  const started = new FakeHost({
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    hostId: HOST_ID,
    token: TOKEN,
    hostName: "Test Mac",
    statePath: join(dir, "host.json"),
    log: () => {},
  });
  await started.start();
  await until(() => relayLog.filter((entry) => entry.event === "host_online").length > online, "host online");
  return started;
}

/**
 * Pairs a phone all the way: link, handshake, SAS on both sides, confirm on the Mac.
 *
 * @sideEffects Connects; writes state files.
 * @param phone - The phone.
 * @returns The session (already paired), its deviceId and the SAS the Mac showed.
 */
async function pairPhone(
  phone: FakePhone,
): Promise<{ session: PhoneSession; deviceId: string; request: PairingRequest }> {
  const { link, pairingId } = host.startPairing();
  const requested = new Promise<PairingRequest>((resolve) => host.once("pairing_request", resolve));
  const session = await phone.pair(link);
  const request = await requested;
  expect(request.pairingId).toBe(pairingId);
  expect(host.pairingState).toBe("awaiting_confirmation");
  expect(host.confirmPairing(pairingId, true)).toBe(true);
  const paired = await session.control(["paired", "pair_rejected"]);
  expect(paired).toStrictEqual({
    kind: "paired",
    deviceId: expect.stringMatching(/^dev_[0-9a-f]{16}$/),
    hostName: "Test Mac",
  });
  return { session, deviceId: paired.deviceId as string, request };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "atrium-mp0-"));
  relayLog = [];
  relay = await startRelay({
    port: 0,
    listen: "127.0.0.1",
    hosts: new Map([[HOST_ID, TOKEN]]),
    log: (entry) => relayLog.push(entry),
  });
  host = await startHost();
});

afterEach(async () => {
  await host.close();
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("pairing and daily connection through the relay", () => {
  it("pairs → confirms → disconnects → reconnects over IK → hello/welcome → is refused after revocation", async () => {
    const phone = new FakePhone({ statePath: join(dir, "phone.json"), deviceName: "Test iPhone", model: "iPhone17,1" });
    const { session, deviceId, request } = await pairPhone(phone);

    // Both sides show the same six digits, computed independently from their own h.
    expect(request.sas).toBe(session.sas);
    expect(request.sas).toMatch(/^\d{6}$/);
    expect(request).toMatchObject({ deviceName: "Test iPhone", model: "iPhone17,1" });
    expect(host.pairingState).toBe("committed");
    expect(host.devices).toStrictEqual([
      expect.objectContaining({ deviceId, name: "Test iPhone", model: "iPhone17,1" }),
    ]);
    expect(phone.hosts).toStrictEqual([expect.objectContaining({ hostId: HOST_ID, hostName: "Test Mac", deviceId })]);

    // The pairing channel goes straight on to the Atrium handshake.
    expect(await session.hello(deviceId)).toMatchObject({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    await session.close();

    const daily = await phone.connect();
    expect(daily.deviceId).toBe(deviceId);
    expect(await daily.hello(deviceId)).toMatchObject({ type: "welcome", heartbeatMs: 10_000 });
    expect(await daily.request({ type: "ping" })).toMatchObject({ type: "response", ok: true });
    await daily.heartbeat();

    // A copy of the phone that is offline when revoked: it learns on its next handshake.
    copyFileSync(join(dir, "phone.json"), join(dir, "offline-phone.json"));
    expect(host.revoke(deviceId)).toBe(true);
    expect(await daily.control(["revoked"])).toStrictEqual({ kind: "revoked" });
    await daily.closed;
    expect(phone.hosts).toStrictEqual([]);

    const offline = new FakePhone({ statePath: join(dir, "offline-phone.json") });
    expect(offline.hosts).toHaveLength(1);
    expect(await rejection(offline.connect())).toBe("device_unknown");
    expect(offline.hosts).toStrictEqual([]);
  });

  it("refuses an unknown device's IK handshake and keeps working for the known one", async () => {
    const phone = new FakePhone({ statePath: join(dir, "phone.json") });
    const { session, deviceId } = await pairPhone(phone);
    await session.close();
    copyFileSync(join(dir, "phone.json"), join(dir, "stranger.json"));
    const stranger = new FakePhone({ statePath: join(dir, "stranger.json"), staticKey: generateKeyPair() });
    expect(await rejection(stranger.connect())).toBe("device_unknown");
    const again = await phone.connect();
    expect(again.deviceId).toBe(deviceId);
    await again.close();
  });

  it("remembers devices across a host restart", async () => {
    const phone = new FakePhone({ statePath: join(dir, "phone.json") });
    const { session, deviceId } = await pairPhone(phone);
    await session.close();
    await host.close();
    host = await startHost();
    const daily = await phone.connect();
    expect(daily.deviceId).toBe(deviceId);
    expect(await daily.hello(deviceId)).toMatchObject({ type: "welcome" });
    await daily.close();
  });

  it("closes the channel when hello's clientId is not the deviceId", async () => {
    const phone = new FakePhone({ statePath: join(dir, "phone.json") });
    const { session } = await pairPhone(phone);
    expect(await rejection(session.hello("dev_somebody_else"))).toMatch(/^socket_closed/);
  });

  it("sends pair_rejected when the Mac says no, and the phone forgets the host", async () => {
    const phone = new FakePhone({ statePath: join(dir, "phone.json") });
    const { link, pairingId } = host.startPairing();
    const requested = new Promise<PairingRequest>((resolve) => host.once("pairing_request", resolve));
    const session = await phone.pair(link);
    await requested;
    expect(phone.hosts).toStrictEqual([expect.objectContaining({ deviceId: null })]);
    host.confirmPairing(pairingId, false);
    expect(await session.control(["paired", "pair_rejected"])).toStrictEqual({
      kind: "pair_rejected",
      reason: "rejected",
    });
    expect(host.pairingState).toBe("rejected");
    expect(host.devices).toStrictEqual([]);
    expect(phone.hosts).toStrictEqual([]);
  });

  it("accepts only one phone at a time: a second one is told pairing_busy", async () => {
    const first = new FakePhone({ statePath: null, deviceName: "First" });
    const second = new FakePhone({ statePath: null, deviceName: "Second" });
    const { link, pairingId } = host.startPairing();
    const requested = new Promise<PairingRequest>((resolve) => host.once("pairing_request", resolve));
    const session = await first.pair(link);
    await requested;
    expect(await rejection(second.pair(link))).toBe("pairing_busy");
    // The first one is unaffected and can still be confirmed.
    host.confirmPairing(pairingId, true);
    expect(await session.control(["paired"])).toMatchObject({ kind: "paired" });
    // A used code cannot pair again.
    expect(await rejection(second.pair(link))).toBe("pairing_busy");
    await session.close();
  });

  it("lets only the first key confirmation through when two phones finished the handshake", async () => {
    const first = new FakePhone({ statePath: null, deviceName: "First" });
    const second = new FakePhone({ statePath: null, deviceName: "Second" });
    const { link } = host.startPairing();
    // Both pass step 2 (the state is still `available`); only the confirmation moves it.
    const a = await first.pair(link, { confirm: false });
    const b = await second.pair(link, { confirm: false });
    expect(host.pairingState).toBe("available");
    const requested = new Promise<PairingRequest>((resolve) => host.once("pairing_request", resolve));
    b.channel.sendControl({ kind: "pair_confirm" });
    expect(await requested).toMatchObject({ deviceName: "Second", sas: b.sas });
    a.channel.sendControl({ kind: "pair_confirm" });
    expect(await a.control(["pair_rejected"])).toStrictEqual({ kind: "pair_rejected", reason: "pairing_busy" });
    expect(host.refusedCount).toBe(1);
    expect(host.pairingState).toBe("awaiting_confirmation");
    await b.close();
  });

  it("closes a pairing channel that sends anything but pair_confirm first", async () => {
    const phone = new FakePhone({ statePath: null });
    const { link } = host.startPairing();
    const session = await phone.pair(link, { confirm: false });
    session.channel.sendMessage('{"type":"hello"}');
    expect(await session.closed).toMatch(/^socket_closed/);
    expect(host.pairingState).toBe("available");
  });

  it("rejects the pairing when the phone disconnects before the Mac confirms", async () => {
    const phone = new FakePhone({ statePath: null });
    const { link, pairingId } = host.startPairing();
    const requested = new Promise<PairingRequest>((resolve) => host.once("pairing_request", resolve));
    const session = await phone.pair(link);
    await requested;
    await session.close();
    await until(() => host.pairingState === "rejected", "rejected");
    expect(host.confirmPairing(pairingId, true)).toBe(false);
    expect(host.devices).toStrictEqual([]);
  });

  it("refuses a cancelled code: the host closes without an answer it could not encrypt", async () => {
    const phone = new FakePhone({ statePath: null });
    const { link } = host.startPairing();
    host.cancelPairing();
    expect(await rejection(phone.pair(link))).toMatch(/^socket_closed/);
  });

  it("refuses a code from an earlier pairing once a new one was started", async () => {
    const phone = new FakePhone({ statePath: null });
    const { link: old } = host.startPairing();
    host.startPairing();
    expect(await rejection(phone.pair(old))).toMatch(/^socket_closed/);
  });

  it("is told by the relay that the host is offline, without losing the host record", async () => {
    const phone = new FakePhone({ statePath: join(dir, "phone.json") });
    const { session } = await pairPhone(phone);
    await session.close();
    await host.close();
    await until(() => relayLog.some((entry) => entry.event === "host_offline"), "host offline");
    expect(await rejection(phone.connect())).toMatch(/^socket_closed:4404:offline:\d+$/);
    expect(phone.hosts).toHaveLength(1);
    host = await startHost();
  });

  it("carries a phone message bigger than one Noise message (chunks through the relay)", async () => {
    const phone = new FakePhone({ statePath: null });
    const { session, deviceId } = await pairPhone(phone);
    await session.hello(deviceId);
    // The fake host echoes unknown commands with an error; make the command itself large.
    const response = await session.request({ type: "big", padding: "x".repeat(200_000) });
    expect(response).toMatchObject({ ok: false, error: { code: "unknown_command" } });
    await session.close();
  });
});
