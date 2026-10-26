import { PROTOCOL_VERSION } from "@atrium/protocol";
import { createHash } from "node:crypto";
import {
  firstFrame,
  fromBase64Url,
  fromUtf8,
  generateKeyPair,
  HandshakeState,
  keyPairFrom,
  prologue,
  utf8,
  type KeyPair,
} from "@atrium/remote-crypto";
import { WebSocket } from "ws";
import { systemClock } from "../../src/platform/clock";
import { Inbox } from "./inbox";
import { describe, expect, it, onTestFinished } from "vitest";
import { awaiting, newPairing, pairDevice, serviceFixture, type ServiceFixture } from "./service-fixture";

/**
 * Observes a rejected IK handshake without closing the phone's socket in response.
 * @remarks FakePhone intentionally cleans up on rejection; this lower-level peer independently
 * verifies that the host closes unauthorized streams rather than waiting for client cleanup.
 * @sideEffects Opens a test relay socket and registers teardown plus bounded receives.
 * @param fixture - Real relay and host identity.
 * @param key - Phone static key.
 * @param version - Requested Noise payload protocol version.
 * @returns The authenticated rejection and a bounded close observer.
 */
async function rejectedPeer(fixture: ServiceFixture, key: KeyPair, version: number) {
  const handshake = HandshakeState.initiator({
    pattern: "IK",
    prologue: prologue(fixture.relay.endpoint.hostId),
    staticKey: key,
    remoteStatic: keyPairFrom(fromBase64Url(fixture.vault.contents().hostKey, 32)).publicKey,
  });
  const socket = new WebSocket(`${fixture.relay.endpoint.url}/v1/client?host=${fixture.relay.endpoint.hostId}`);
  const answers = new Inbox<Record<string, unknown>>(systemClock);
  const closes = new Inbox<number>(systemClock);
  const closed = new Promise<void>((resolve) =>
    socket.once("close", (code) => {
      closes.push(code);
      resolve();
    }),
  );
  onTestFinished(async () => {
    socket.terminate();
    await closed;
  });
  socket.once("open", () =>
    socket.send(
      firstFrame(
        "IK",
        handshake.writeMessage(utf8(JSON.stringify({ kind: "connect", appVersion: "test", protocolVersion: version }))),
      ),
    ),
  );
  socket.on("error", (error) => answers.fail(error));
  socket.once("message", (data) => {
    try {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      answers.push(JSON.parse(fromUtf8(handshake.readMessage(bytes))) as Record<string, unknown>);
    } catch (error) {
      answers.fail(error instanceof Error ? error : new Error("invalid rejection"));
      socket.terminate();
    }
  });
  return { answer: await answers.next(() => true), closes };
}

describe("remote service authorization and persisted state", () => {
  it("rejects an unknown phone key even when another device is already trusted", async () => {
    const f = await serviceFixture();
    const known = await pairDevice(f, f.phone({ deviceName: "Known" }));
    const stranger = f.phone({ deviceName: "Unknown" });
    const pairing = newPairing(f);
    const unconfirmed = await stranger.pair(pairing.qr, { confirm: false });
    await unconfirmed.close();
    await expect(stranger.connect()).rejects.toThrow("device_unknown");
    await expect.poll(() => f.resources.snapshot()["remote.data"]).toBe(1);
    expect(f.accepted.map((item) => item.origin)).toStrictEqual([{ origin: "remote", deviceId: known.deviceId }]);
    expect(f.vault.contents().devices.map((device) => device.deviceId)).toStrictEqual([known.deviceId]);
    expect(stranger.hosts).toStrictEqual([]);
    expect(known.session.channel.closed).toBe(false);
  });

  it("does not authorize a known device with an incompatible Noise protocol version", async () => {
    const f = await serviceFixture();
    const phone = f.phone();
    const original = await pairDevice(f, phone);
    await expect(phone.connect(undefined, { protocolVersion: PROTOCOL_VERSION + 1 })).rejects.toThrow(
      "version_mismatch",
    );
    await expect.poll(() => f.resources.snapshot()["remote.data"]).toBe(1);
    expect(f.accepted.map((item) => item.origin)).toStrictEqual([{ origin: "remote", deviceId: original.deviceId }]);
    expect(phone.hosts[0]?.deviceId).toBe(original.deviceId);
    expect(f.logs.filter((entry) => entry.msg === "remote stream closed").map((entry) => entry.reason)).toStrictEqual([
      "handshake_rejected",
    ]);
  });

  it("closes a rejected known-device handshake even when the raw phone does not close itself", async () => {
    const f = await serviceFixture();
    const key = generateKeyPair();
    const original = await pairDevice(f, f.phone({ staticKey: key }));
    const rejected = await rejectedPeer(f, key, PROTOCOL_VERSION + 1);
    expect(rejected.answer).toStrictEqual({ ok: false, reason: "version_mismatch", hostProtocol: PROTOCOL_VERSION });
    await rejected.closes.next(() => true, { timeoutMs: 1_000 });
    await expect.poll(() => f.resources.snapshot()["remote.data"]).toBe(1);
    expect(f.accepted.map((item) => item.origin)).toStrictEqual([{ origin: "remote", deviceId: original.deviceId }]);
    expect(original.session.channel.closed).toBe(false);
  });

  it("closes an authenticated pairing channel that sends a control other than pair_confirm", async () => {
    const f = await serviceFixture();
    const pairing = newPairing(f);
    const session = await f.phone().pair(pairing.qr, { confirm: false });
    session.channel.sendControl({ kind: "paired", deviceId: "dev_1111111111111111" });
    await session.closed;
    expect(f.accepted).toStrictEqual([]);
    expect(f.vault.contents().devices).toStrictEqual([]);
    expect(f.service.get("observer", undefined).pairing).toMatchObject({ state: "available", request: null });
    expect(f.logs.filter((entry) => entry.msg === "remote stream closed").map((entry) => entry.reason)).toStrictEqual([
      "unexpected_control",
    ]);
    const valid = await f.phone().pair(pairing.qr);
    await awaiting(f);
    expect(f.service.get("observer", undefined).pairing?.request?.sas).toBe(valid.sas);
  });

  it("closes a daily channel that replays pair_confirm without a pairing claim", async () => {
    const f = await serviceFixture();
    const phone = f.phone();
    const paired = await pairDevice(f, phone);
    const daily = await phone.connect();
    daily.channel.sendControl({ kind: "pair_confirm" });
    await daily.closed;
    await expect.poll(() => f.accepted[1]?.closed).toBe(true);
    expect(f.service.get("observer", undefined).pairing?.state).toBe("committed");
    expect(f.vault.contents().devices.map((device) => device.deviceId)).toStrictEqual([paired.deviceId]);
    expect(paired.session.channel.closed).toBe(false);
  });

  it("renames and revokes only the selected device while another remains persisted and connectable", async () => {
    const f = await serviceFixture();
    const phoneA = f.phone({ deviceName: "A" });
    const phoneB = f.phone({ deviceName: "B" });
    const a = await pairDevice(f, phoneA);
    const b = await pairDevice(f, phoneB);
    await f.service.renameDevice(a.deviceId, "Custom A");
    expect(
      f.service.get("observer", undefined).devices.map(({ deviceId, name }) => ({ deviceId, name })),
    ).toStrictEqual([
      { deviceId: a.deviceId, name: "Custom A" },
      { deviceId: b.deviceId, name: "B" },
    ]);
    await f.service.revokeDevice(a.deviceId);
    expect(await a.session.control(["revoked"])).toStrictEqual({ kind: "revoked" });
    await a.session.closed;
    expect(f.vault.contents().devices.map(({ deviceId, reportedName }) => ({ deviceId, reportedName }))).toStrictEqual([
      { deviceId: b.deviceId, reportedName: "B" },
    ]);
    const dailyB = await phoneB.connect();
    expect(dailyB.deviceId).toBe(b.deviceId);
    expect(b.session.channel.closed).toBe(false);
    expect(
      f.service.get("observer", undefined).devices.map(({ deviceId, online }) => ({ deviceId, online })),
    ).toStrictEqual([{ deviceId: b.deviceId, online: true }]);
  });

  it("re-pairs the matching key rather than the first device and preserves the unrelated record", async () => {
    const f = await serviceFixture();
    const a = await pairDevice(f, f.phone({ deviceName: "First device" }));
    const phoneB = f.phone({ deviceName: "Second device" });
    const b = await pairDevice(f, phoneB);
    await f.service.renameDevice(b.deviceId, "Custom second");
    const before = f.vault.contents().devices;
    const again = await pairDevice(f, phoneB);
    expect(again.deviceId).toBe(b.deviceId);
    expect(f.vault.contents().devices).toStrictEqual(before);
    expect(
      f.service.get("observer", undefined).devices.map(({ deviceId, name }) => ({ deviceId, name })),
    ).toStrictEqual([
      { deviceId: a.deviceId, name: "First device" },
      { deviceId: b.deviceId, name: "Custom second" },
    ]);
    expect(a.session.channel.closed).toBe(false);
  });

  it("rejects rename of an unknown or blocked device without changing persisted records", async () => {
    const f = await serviceFixture();
    const device = await pairDevice(f, f.phone());
    const before = f.vault.contents();
    await expect(f.service.renameDevice("unknown", "Wrong")).rejects.toMatchObject({ code: "device_not_found" });
    expect(f.vault.contents()).toStrictEqual(before);
    f.vault.failNext = true;
    await expect(f.service.revokeDevice(device.deviceId)).rejects.toMatchObject({ code: "keychain_unavailable" });
    await expect(f.service.renameDevice(device.deviceId, "Blocked")).rejects.toMatchObject({
      code: "device_not_found",
    });
    expect(f.vault.contents()).toStrictEqual(before);
  });

  it("leaves live channels and the original pairing unchanged when remote enable is repeated", async () => {
    const f = await serviceFixture();
    const paired = await pairDevice(f, f.phone());
    const view = f.service.get("observer", undefined);
    await f.service.set(true, undefined);
    expect(f.service.get("observer", undefined)).toStrictEqual(view);
    await f.service.testRelay();
    expect(f.service.get("observer", undefined)).toStrictEqual({
      ...view,
      relay: {
        ...view.relay,
        diagnostics: {
          kind: "live",
          checkedAt: f.clock.now(),
          network: "passed",
          resolution: "not_applicable",
          tls: "not_applicable",
          token: "unknown",
          failure: null,
        },
      },
    });
    paired.session.channel.ping();
    expect(await paired.session.next((item) => item.kind === "pong")).toStrictEqual({ kind: "pong" });
    expect(f.accepted[0]?.closed).toBe(false);
  });

  it("successfully re-pairs an in-memory blocked device and permits its next daily connection", async () => {
    const f = await serviceFixture();
    const phone = f.phone();
    const first = await pairDevice(f, phone);
    f.vault.failNext = true;
    await expect(f.service.revokeDevice(first.deviceId)).rejects.toMatchObject({ code: "keychain_unavailable" });
    await first.session.control(["revoked"]);
    await first.session.closed;
    expect(f.service.get("observer", undefined).devices).toStrictEqual([]);
    const restored = await pairDevice(f, phone);
    expect(restored.deviceId).toBe(first.deviceId);
    expect(f.service.get("observer", undefined).devices.map((device) => device.deviceId)).toStrictEqual([
      first.deviceId,
    ]);
    const daily = await phone.connect();
    expect(daily.deviceId).toBe(first.deviceId);
    expect(f.accepted.map((item) => item.origin)).toStrictEqual([
      { origin: "remote", deviceId: first.deviceId },
      { origin: "remote", deviceId: first.deviceId },
      { origin: "remote", deviceId: first.deviceId },
    ]);
  });

  it("restores the enabled switch, identity and devices through the real service startup path", async () => {
    const f = await serviceFixture();
    const phone = f.phone();
    const original = await pairDevice(f, phone);
    const fingerprint = f.service.get("observer", undefined).hostFingerprint;
    await f.service.renameDevice(original.deviceId, "Persistent name");
    await f.restart();
    await original.session.closed;
    await expect.poll(() => f.service.get("observer", undefined).relay?.status).toBe("connected");
    expect(f.service.get("observer", undefined)).toStrictEqual({
      enabled: true,
      vault: "ok",
      relay: {
        url: f.relay.endpoint.url,
        hostId: f.relay.endpoint.hostId,
        status: "connected",
        error: null,
        lastConnectedAt: f.clock.now(),
        diagnostics: {
          kind: "connect",
          checkedAt: f.clock.now(),
          network: "passed",
          resolution: "not_applicable",
          tls: "not_applicable",
          token: "passed",
          failure: null,
        },
      },
      hostFingerprint: fingerprint,
      devices: [
        {
          deviceId: original.deviceId,
          name: "Persistent name",
          model: "test",
          pairedAt: f.clock.now(),
          lastSeenAt: f.clock.now(),
          online: false,
          traffic: { down: 0, up: 0 },
        },
      ],
      pairing: null,
    });
    const daily = await phone.connect();
    expect(daily.deviceId).toBe(original.deviceId);
  });

  it("persists disabled state without loading keys on restart and reconnects only when enabled again", async () => {
    const f = await serviceFixture();
    const contents = f.vault.contents();
    await f.service.set(false, undefined);
    await f.restart();
    expect(f.service.get("observer", undefined)).toStrictEqual({
      enabled: false,
      vault: "unread",
      relay: null,
      hostFingerprint: null,
      devices: [],
      pairing: null,
    });
    expect(f.clock.pendingTimers()).toBe(0);
    expect(Object.values(f.resources.snapshot()).every((count) => count === 0)).toBe(true);
    expect(f.vault.contents()).toStrictEqual(contents);
    await f.service.set(true, undefined);
    await expect.poll(() => f.service.get("observer", undefined).relay?.status).toBe("connected");
    expect(f.vault.contents()).toStrictEqual(contents);
  });

  it("projects the exact initial state and refuses invalid relay changes without modifying it", async () => {
    const f = await serviceFixture();
    const fingerprint = createHash("sha256")
      .update(keyPairFrom(fromBase64Url(f.vault.contents().hostKey, 32)).publicKey)
      .digest("hex")
      .slice(0, 16);
    const initial = {
      enabled: true,
      vault: "ok",
      relay: {
        url: f.relay.endpoint.url,
        hostId: f.relay.endpoint.hostId,
        status: "connected",
        error: null,
        lastConnectedAt: f.clock.now(),
        diagnostics: {
          kind: "connect",
          checkedAt: f.clock.now(),
          network: "passed",
          resolution: "not_applicable",
          tls: "not_applicable",
          token: "passed",
          failure: null,
        },
      },
      hostFingerprint: fingerprint,
      devices: [],
      pairing: null,
    };
    expect(f.service.get("observer", undefined)).toStrictEqual(initial);
    await expect(f.service.set(false, "not-a-relay-line")).rejects.toMatchObject({ code: "relay_unreachable" });
    expect(f.service.get("observer", undefined)).toStrictEqual(initial);
    await f.service.set(false, undefined);
    expect(f.service.get("observer", undefined)).toStrictEqual({
      ...initial,
      enabled: false,
      relay: { ...initial.relay, status: "off", lastConnectedAt: null, diagnostics: null },
    });
    expect(() => f.service.startPairing()).toThrow("remote_unavailable");
  });

  it("probes configured relay credentials while disabled without enabling or retaining a connection", async () => {
    const f = await serviceFixture();
    await f.service.set(false, undefined);
    const before = f.service.get("observer", undefined);
    expect(await f.service.testRelay()).toStrictEqual({});
    expect(f.service.get("observer", undefined)).toStrictEqual({
      ...before,
      relay: {
        ...before.relay,
        diagnostics: {
          kind: "connect",
          checkedAt: f.clock.now(),
          network: "passed",
          resolution: "not_applicable",
          tls: "not_applicable",
          token: "passed",
          failure: null,
        },
      },
    });
    expect(f.clock.pendingTimers()).toBe(0);
    expect(Object.values(f.resources.snapshot()).every((count) => count === 0)).toBe(true);
    await f.service.set(true, undefined);
    await expect.poll(() => f.service.get("observer", undefined).relay?.status).toBe("connected");
    const paired = await pairDevice(f, f.phone());
    expect(paired.deviceId).toBe(f.vault.contents().devices[0]?.deviceId);
  });

  it("reports the complete relay error state and device offline state when its owned child stops", async () => {
    const f = await serviceFixture();
    const paired = await pairDevice(f, f.phone());
    const connected = f.service.get("observer", undefined);
    f.service.get("watcher", true);
    await f.relay.cleanup();
    await paired.session.closed;
    await expect.poll(() => f.service.get("observer", undefined).relay?.status).toBe("error");
    const expected = {
      ...connected,
      relay: {
        url: f.relay.endpoint.url,
        hostId: f.relay.endpoint.hostId,
        status: "error",
        error: "relay_unreachable",
        lastConnectedAt: f.clock.now(),
        diagnostics: connected.relay!.diagnostics,
      },
      devices: connected.devices.map((device) => ({ ...device, online: false })),
    };
    expect(f.service.get("observer", undefined)).toStrictEqual(expected);
    expect(f.events.at(-1)).toStrictEqual({ id: "watcher", event: { type: "remote_updated", remote: expected } });
  });

  it("refuses commands after close without writing, creating keys or connecting again", async () => {
    const f = await serviceFixture();
    const contents = f.vault.contents();
    await f.service.close();
    await expect(f.service.set(true, f.relay.line)).rejects.toMatchObject({ code: "remote_unavailable" });
    await expect(f.service.resetIdentity()).rejects.toMatchObject({ code: "remote_unavailable" });
    await expect(f.service.testRelay()).rejects.toMatchObject({ code: "remote_unavailable" });
    expect(() => f.service.startPairing()).toThrow("remote_unavailable");
    f.service.start();
    expect(f.vault.contents()).toStrictEqual(contents);
    expect(f.clock.pendingTimers()).toBe(0);
    expect(Object.values(f.resources.snapshot()).every((count) => count === 0)).toBe(true);
  });

  it("keeps traffic subscriptions until the last watcher leaves and clears sampled rates on unwatch", async () => {
    const f = await serviceFixture();
    const first = await pairDevice(f, f.phone());
    f.service.get("one", true);
    f.service.get("two", true);
    const timers = f.clock.pendingTimers();
    f.service.get("one", true);
    expect(f.clock.pendingTimers()).toBe(timers);
    f.service.get("one", undefined);
    first.session.send({ type: "sample" });
    await expect.poll(() => f.accepted[0]?.messages.length).toBe(1);
    f.clock.advance(1_000);
    expect(f.service.get("observer", undefined).devices[0]!.traffic.up).toBeGreaterThan(0);
    f.service.get("one", false);
    expect(f.clock.pendingTimers()).toBe(timers);
    const before = f.events.length;
    f.clock.advance(1_000);
    expect(f.events.slice(before).map((entry) => entry.id)).toStrictEqual(["two"]);
    f.service.get("two", false);
    expect(f.clock.pendingTimers()).toBe(timers - 1);
    expect(f.service.get("observer", undefined).devices[0]?.traffic).toStrictEqual({ down: 0, up: 0 });
    const stopped = f.events.length;
    f.clock.advance(1_000);
    expect(f.events).toHaveLength(stopped);
    f.service.get("fresh", true);
    expect(f.service.get("observer", undefined).devices[0]?.traffic).toStrictEqual({ down: 0, up: 0 });
  });

  it("records last-seen and online state independently for disconnected and still-live devices", async () => {
    const f = await serviceFixture();
    const a = await pairDevice(f, f.phone({ deviceName: "A" }));
    const b = await pairDevice(f, f.phone({ deviceName: "B" }));
    const pairedAt = f.clock.now();
    expect(f.service.get("observer", undefined).devices.map((device) => device.online)).toStrictEqual([true, true]);
    f.clock.advance(1_000);
    await a.session.close();
    await expect.poll(() => f.service.get("observer", undefined).devices[0]?.online).toBe(false);
    expect(f.service.get("observer", undefined).devices).toStrictEqual([
      {
        deviceId: a.deviceId,
        name: "A",
        model: "test",
        pairedAt,
        lastSeenAt: pairedAt + 1_000,
        online: false,
        traffic: { down: 0, up: 0 },
      },
      {
        deviceId: b.deviceId,
        name: "B",
        model: "test",
        pairedAt,
        lastSeenAt: pairedAt,
        online: true,
        traffic: { down: 0, up: 0 },
      },
    ]);
  });
});
