import { describe, expect, it } from "vitest";
import type { PhoneSession } from "./fake-phone";
import { pairDevice, serviceFixture, type ServiceFixture } from "./service-fixture";

/** Sends one fixed-size phone payload. @remarks ASCII JSON plus frame byte and Poly1305 tag is exactly 30 ciphertext bytes. @sideEffects Sends a socket message and waits for host receipt.
 * @param f - Running service fixture.
 * @param session - Authenticated first phone.
 */
async function transferUp(f: ServiceFixture, session: PhoneSession): Promise<void> {
  const count = f.accepted[0]!.messages.length;
  session.send({ type: "up" });
  await expect.poll(() => f.accepted[0]!.messages.length).toBe(count + 1);
}

/** Sends one fixed-size host payload. @remarks ASCII JSON plus frame byte and Poly1305 tag is exactly 32 ciphertext bytes. @sideEffects Sends a socket message and waits for phone receipt.
 * @param f - Running service fixture.
 * @param session - Authenticated first phone.
 */
async function transferDown(f: ServiceFixture, session: PhoneSession): Promise<void> {
  f.accepted[0]!.transport.send('{"type":"down"}');
  expect(await session.message()).toStrictEqual({ type: "down" });
}

/** Exchanges both known ciphertext sizes. @remarks Equal batches make stable-rate expectations independent of sampler implementation. @sideEffects Sends and receives two socket messages.
 * @param f - Running service fixture.
 * @param session - Authenticated first phone.
 */
async function transfer(f: ServiceFixture, session: PhoneSession): Promise<void> {
  await transferUp(f, session);
  await transferDown(f, session);
}

describe("remote traffic notifications reflect visible rate changes", () => {
  it.each([
    { state: "unpaired", prepare: async (_f: ServiceFixture) => {}, deviceCount: 0 },
    { state: "off", prepare: (f: ServiceFixture) => f.service.set(false, undefined), deviceCount: 0 },
    { state: "paired", prepare: (f: ServiceFixture) => pairDevice(f, f.phone()), deviceCount: 1 },
  ])("does not publish unchanged $state state on sampling ticks", async ({ prepare, deviceCount }) => {
    const f = await serviceFixture();
    await prepare(f);
    const beforeTimers = f.clock.pendingTimers();
    const initial = f.service.get("settings", true);
    expect(initial.devices).toHaveLength(deviceCount);
    expect(f.clock.pendingTimers()).toBe(beforeTimers + 1);
    const events = f.events.length;
    f.clock.advance(3_000);
    expect(f.service.get("observer", undefined)).toStrictEqual(initial);
    expect(f.events).toHaveLength(events);
    f.service.unwatch("settings");
    expect(f.clock.pendingTimers()).toBe(beforeTimers);
  });

  it("publishes rate changes and offline decay but not an unchanged steady rate", async () => {
    const f = await serviceFixture();
    const { session } = await pairDevice(f, f.phone());
    f.service.get("settings", true);
    const before = f.events.length;
    for (let tick = 0; tick < 3; tick++) {
      await transfer(f, session);
      f.clock.advance(1_000);
      expect(f.service.get("observer", undefined).devices[0]!.traffic).toStrictEqual({ up: 30, down: 32 });
      expect(f.events).toHaveLength(before + 1);
    }
    expect(f.events.at(-1)?.id).toBe("settings");
    expect(f.events.at(-1)?.event.remote.devices[0]!.traffic).toStrictEqual({ up: 30, down: 32 });
    const at = f.clock.now();
    await session.close();
    await expect.poll(() => f.service.get("observer", undefined).devices[0]!.online).toBe(false);
    expect(f.clock.now()).toBe(at);
    expect(f.events).toHaveLength(before + 2);
    expect(f.events.at(-1)?.event.remote.devices[0]).toMatchObject({ online: false, traffic: { up: 30, down: 32 } });
    f.clock.advance(1_000);
    expect(f.events).toHaveLength(before + 3);
    expect(f.events.at(-1)?.event.remote.devices[0]).toMatchObject({ online: false, traffic: { up: 15, down: 16 } });
    f.clock.advance(1_000);
    expect(f.events).toHaveLength(before + 4);
    expect(f.events.at(-1)?.event.remote.devices[0]).toMatchObject({ online: false, traffic: { up: 0, down: 0 } });
    f.clock.advance(2_000);
    expect(f.events).toHaveLength(before + 4);
  });

  it.each([
    { direction: "up", send: transferUp, rate: { up: 30, down: 0 } },
    { direction: "down", send: transferDown, rate: { up: 0, down: 32 } },
  ])("publishes when only the $direction rate changes", async ({ send, rate }) => {
    const f = await serviceFixture();
    const { session } = await pairDevice(f, f.phone());
    f.service.get("settings", true);
    await send(f, session);
    f.clock.advance(1_000);
    expect(f.events).toHaveLength(1);
    expect(f.events[0]?.event.remote.devices[0]!.traffic).toStrictEqual(rate);
  });

  it("shares sampling across watchers and starts a fresh window after the last unwatch", async () => {
    const f = await serviceFixture();
    const { session } = await pairDevice(f, f.phone());
    const baselineTimers = f.clock.pendingTimers();
    const initial = f.service.get("first", true);
    expect(initial.devices[0]!.traffic).toStrictEqual({ up: 0, down: 0 });
    expect(f.service.get("first", true)).toStrictEqual(initial);
    expect(f.service.get("second", true)).toStrictEqual(initial);
    expect(f.events).toStrictEqual([]);
    expect(f.clock.pendingTimers()).toBe(baselineTimers + 1);
    await transfer(f, session);
    f.clock.advance(1_000);
    expect(f.events.map((item) => item.id)).toStrictEqual(["first", "second"]);
    expect(f.events[0]?.event).toStrictEqual(f.events[1]?.event);
    expect(f.events[0]?.event.remote.devices[0]!.traffic).toStrictEqual({ up: 30, down: 32 });
    f.service.unwatch("first");
    expect(f.clock.pendingTimers()).toBe(baselineTimers + 1);
    await transfer(f, session);
    f.clock.advance(1_000);
    expect(f.events).toHaveLength(2);
    expect(f.service.get("first", true).devices[0]!.traffic).toStrictEqual({ up: 30, down: 32 });
    expect(f.events).toHaveLength(2);
    expect(f.clock.pendingTimers()).toBe(baselineTimers + 1);
    f.service.unwatch("first");
    f.clock.advance(1_000);
    expect(f.events).toHaveLength(3);
    expect(f.events.at(-1)?.id).toBe("second");
    expect(f.events.at(-1)?.event.remote.devices[0]!.traffic).toStrictEqual({ up: 15, down: 16 });
    f.service.unwatch("second");
    expect(f.clock.pendingTimers()).toBe(baselineTimers);
    expect(f.service.get("observer", undefined).devices[0]!.traffic).toStrictEqual({ up: 0, down: 0 });
    // Same clock instant: stale samples cannot expire naturally and hide a missed reset.
    await transfer(f, session);
    expect(f.service.get("resumed", true).devices[0]!.traffic).toStrictEqual({ up: 0, down: 0 });
    expect(f.events).toHaveLength(3);
    await transfer(f, session);
    f.clock.advance(1_000);
    expect(f.events).toHaveLength(4);
    expect(f.events.at(-1)?.id).toBe("resumed");
    expect(f.events.at(-1)?.event.remote.devices[0]!.traffic).toStrictEqual({ up: 30, down: 32 });
    f.service.unwatch("resumed");
    expect(f.clock.pendingTimers()).toBe(baselineTimers);
    f.clock.advance(3_000);
    expect(f.events).toHaveLength(4);
  });

  it.each([
    {
      action: "blocked",
      deviceCount: 1,
      remove: async (f: ServiceFixture, deviceId: string) => {
        f.vault.failNext = true;
        await expect(f.service.revokeDevice(deviceId)).rejects.toMatchObject({ code: "keychain_unavailable" });
      },
    },
    {
      action: "revoked",
      deviceCount: 0,
      remove: (f: ServiceFixture, deviceId: string) => f.service.revokeDevice(deviceId),
    },
    {
      action: "reset",
      deviceCount: 0,
      remove: async (f: ServiceFixture, _deviceId: string) => {
        await f.service.resetIdentity();
        await expect.poll(() => f.service.get("observer", undefined).relay?.status).toBe("connected");
      },
    },
  ])("does not publish residual rates for a $action device", async ({ remove, deviceCount }) => {
    const f = await serviceFixture();
    const { session, deviceId } = await pairDevice(f, f.phone());
    f.service.get("settings", true);
    await transfer(f, session);
    f.clock.advance(1_000);
    expect(f.service.get("observer", undefined).devices[0]!.traffic).toStrictEqual({ up: 30, down: 32 });
    const beforeRemoval = f.events.length;
    const at = f.clock.now();
    await remove(f, deviceId);
    expect(await session.control(["revoked"])).toStrictEqual({ kind: "revoked" });
    await expect.poll(() => f.accepted[0]!.closed).toBe(true);
    expect(f.clock.now()).toBe(at);
    expect(f.events.length).toBeGreaterThan(beforeRemoval);
    expect(f.events.at(-1)?.event.remote.devices).toStrictEqual([]);
    expect(f.vault.contents().devices).toHaveLength(deviceCount);
    const initial = f.service.get("observer", undefined);
    const events = f.events.length;
    f.clock.advance(3_000);
    expect(f.service.get("observer", undefined)).toStrictEqual(initial);
    expect(f.events).toHaveLength(events);
  });
});
