import { PROTOCOL_VERSION, RemoteState } from "@atrium/protocol";
import { FakeClock } from "@atrium/testkit";
import { describe, expect, it, onTestFinished } from "vitest";
import { startTestHost } from "../harness";
import { FakePhone } from "./fake-phone";
import { LocalClient } from "./local-client";
import { startTestRelay } from "./relay-process";
import { MemoryVault } from "./service-fixture";

/**
 * Reads a successful local remote-management response.
 * @remarks The protocol schema checks the entire state instead of trusting a type cast.
 * @sideEffects Sends a local command.
 * @param client - Connected desktop client.
 * @param watch - Whether to change its subscription.
 * @returns The validated state.
 */
async function remoteState(client: LocalClient, watch?: boolean) {
  const response = await client.request({ type: "get_remote", ...(watch === undefined ? {} : { watch }) });
  expect(response.ok).toBe(true);
  return RemoteState.parse(response.result);
}

/**
 * Selects the complete local event containing the renamed device.
 * @remarks Separates unrelated pairing and traffic events from the expected update.
 * @sideEffects none
 * @param value - Received local envelope.
 * @returns Whether the expected rename is present.
 */
function renamedEvent(value: Record<string, unknown>): boolean {
  return (
    value.type === "remote_updated" &&
    RemoteState.parse(value.remote).devices.some((device) => device.name === "Renamed phone")
  );
}

describe("remote channels through the common host server", () => {
  it("routes daily Noise and hello, isolates local watchers, forbids management and removes all subscriptions on revoke", async () => {
    const relay = await startTestRelay();
    onTestFinished(relay.cleanup);
    const host = await startTestHost({ vault: new MemoryVault() });
    onTestFinished(host.dispose);
    const watcher = new LocalClient(host.url, host.token);
    const bystander = new LocalClient(host.url, host.token);
    onTestFinished(async () => {
      await Promise.all([watcher.close(), bystander.close()]);
    });
    await Promise.all([
      watcher.next((value) => value.type === "welcome"),
      bystander.next((value) => value.type === "welcome"),
    ]);
    await remoteState(watcher, true);
    await remoteState(bystander, false);
    expect(await watcher.request({ type: "set_remote", enabled: true, relay: relay.line })).toMatchObject({
      ok: true,
      result: {},
    });
    await expect.poll(async () => (await remoteState(watcher)).relay?.status).toBe("connected");
    expect(await watcher.request({ type: "start_pairing" })).toMatchObject({ ok: true });
    const pairing = (await remoteState(watcher)).pairing;
    expect(pairing).not.toBeNull();
    const phoneClock = new FakeClock();
    const phone = new FakePhone({ clock: phoneClock });
    onTestFinished(() => phone.dispose());
    const session = await phone.pair(pairing!.qr);
    await expect.poll(async () => (await remoteState(watcher)).pairing?.state).toBe("awaiting_confirmation");
    expect((await remoteState(watcher)).pairing?.request?.sas).toBe(session.sas);
    expect(
      await watcher.request({ type: "confirm_pairing", pairingId: pairing!.pairingId, accept: true }),
    ).toMatchObject({ ok: true });
    const paired = await session.control(["paired"]);
    const deviceId = String(paired.deviceId);
    expect(await session.hello(deviceId)).toMatchObject({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
    expect(await session.request({ type: "ping" })).toMatchObject({ ok: true, result: {} });
    expect(await session.request({ type: "get_remote", watch: true })).toMatchObject({
      ok: false,
      error: { code: "local_only" },
    });
    expect(await session.request({ type: "set_remote", enabled: false })).toMatchObject({
      ok: false,
      error: { code: "local_only" },
    });
    expect(await session.request({ type: "subscribe_index" })).toMatchObject({ ok: true });
    await session.close({ terminate: true });
    const daily = await phone.connect();
    expect(daily.deviceId).toBe(deviceId);
    expect(await daily.hello(deviceId)).toMatchObject({ type: "welcome" });
    expect(await daily.request({ type: "subscribe_index" })).toMatchObject({ ok: true });
    expect(await watcher.request({ type: "rename_device", deviceId, name: "Renamed phone" })).toMatchObject({
      ok: true,
    });
    const renamed = await watcher.next(renamedEvent);
    expect(RemoteState.parse(renamed.remote).devices[0]?.deviceId).toBe(deviceId);
    await bystander.request({ type: "ping" });
    expect(bystander.received.filter((value) => value.type === "remote_updated")).toStrictEqual([]);
    // A round-trip orders all prior phone events before this negative receive.
    await daily.request({ type: "ping" });
    const leaked = daily
      .message((value) => value.type === "remote_updated", { timeoutMs: 1 })
      .catch((error: unknown) => error);
    phoneClock.advance(1);
    expect(await leaked).toStrictEqual(new Error("timeout"));
    expect(await watcher.request({ type: "revoke_device", deviceId })).toMatchObject({ ok: true });
    expect(await daily.control(["revoked"])).toStrictEqual({ kind: "revoked" });
    await daily.closed;
    await expect.poll(() => host.host.resources.snapshot()["remote.data"]).toBe(0);
    expect((await remoteState(watcher)).devices).toStrictEqual([]);
    expect(JSON.stringify(watcher.received)).not.toContain(relay.endpoint.token);
    await watcher.close();
    await bystander.close();
    await expect.poll(() => host.host.resources.snapshot()["sync.connection"]).toBe(0);
  });

  it("rejects wrong device identity, forbidden token and incompatible common hello after successful Noise", async () => {
    const relay = await startTestRelay();
    onTestFinished(relay.cleanup);
    const host = await startTestHost({ vault: new MemoryVault() });
    host.expectLog({ level: "warn", msg: "client rejected: malformed hello", times: 2 });
    host.expectLog({ level: "warn", msg: "client rejected: protocol version mismatch", times: 1 });
    onTestFinished(host.dispose);
    const local = new LocalClient(host.url, host.token);
    onTestFinished(() => local.close());
    await local.next((value) => value.type === "welcome");
    await local.request({ type: "set_remote", enabled: true, relay: relay.line });
    await expect.poll(async () => (await remoteState(local)).relay?.status).toBe("connected");
    await local.request({ type: "start_pairing" });
    const pairing = (await remoteState(local)).pairing;
    const phone = new FakePhone();
    onTestFinished(() => phone.dispose());
    const pair = await phone.pair(pairing!.qr);
    await expect.poll(async () => (await remoteState(local)).pairing?.state).toBe("awaiting_confirmation");
    await local.request({ type: "confirm_pairing", pairingId: pairing!.pairingId, accept: true });
    const deviceId = String((await pair.control(["paired"])).deviceId);
    pair.sendHello("wrong-device");
    await pair.closed;
    const token = await phone.connect();
    token.sendHello(deviceId, { token: host.token });
    await token.closed;
    const version = await phone.connect();
    version.sendHello(deviceId, { protocolVersion: PROTOCOL_VERSION + 1 });
    await version.closed;
    expect(phone.hosts[0]?.deviceId).toBe(deviceId);
    const good = await phone.connect();
    expect(await good.hello(deviceId)).toMatchObject({ type: "welcome", protocolVersion: PROTOCOL_VERSION });
  });
});
