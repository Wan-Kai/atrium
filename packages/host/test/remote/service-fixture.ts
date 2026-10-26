import type { RemoteUpdatedEvent } from "@atrium/protocol";
import { FakeClock } from "@atrium/testkit";
import pino from "pino";
import { expect, onTestFinished } from "vitest";
import { ResourceTracker } from "../../src/platform/resources";
import { parseVault, type RemoteDocument, type VaultContents } from "../../src/remote/devices";
import { RemoteService, type RemoteOptions } from "../../src/remote/remote-service";
import type { VaultPort, VaultRead, VaultWrite } from "../../src/remote/vault";
import type { ClientTransport, TransportOrigin } from "../../src/server/transport";
import { FakePhone, type PhoneSession } from "./fake-phone";
import { startTestRelay } from "./relay-process";

/** One scheduled persistence barrier, held until its test releases it. */
interface WriteGate {
  readonly entered: () => void;
  readonly wait: Promise<void>;
  readonly release: () => void;
}

/**
 * Stores the vault contract in memory with explicit write failure and release gates.
 * @remarks Crypto and sockets stay real; only Electron's persistence boundary is replaced.
 * @sideEffects Retains committed vault contents and outstanding write gates.
 */
export class MemoryVault implements VaultPort {
  #version = 0;
  #data: string | null = null;
  readonly #gates: WriteGate[] = [];
  #activeGate: WriteGate | null = null;
  failNext = false;

  /**
   * Reads the last durably committed value.
   * @remarks Pending writes are deliberately invisible.
   * @sideEffects none
   * @returns The current revision and text.
   */
  async read(): Promise<VaultRead> {
    return { ok: true, version: this.#version, data: this.#data };
  }

  /**
   * Commits only a newer version after its optional gate opens.
   * @remarks Matches the main-process version fence and permits deterministic failure races.
   * @sideEffects Waits at a gate and replaces committed state on success.
   * @param version - Proposed revision.
   * @param data - Complete vault text.
   * @returns The persistence result.
   */
  async write(version: number, data: string): Promise<VaultWrite> {
    const gate = this.#gates.shift();
    if (gate !== undefined) {
      this.#activeGate = gate;
      gate.entered();
      await gate.wait;
      this.#activeGate = null;
    }
    if (this.failNext) {
      this.failNext = false;
      return { ok: false, error: "io" };
    }
    if (version <= this.#version) return { ok: false, error: "stale" };
    this.#version = version;
    this.#data = data;
    return { ok: true };
  }

  /**
   * Pauses the next unclaimed write until the test releases it.
   * @remarks Gates are consumed FIFO, allowing a second write to wait after an earlier revocation commits.
   * @sideEffects Appends one pending write gate.
   * @returns Gate arrival and release controls.
   */
  pause(): { entered: Promise<void>; release: () => void } {
    const entered = Promise.withResolvers<void>();
    const wait = Promise.withResolvers<void>();
    this.#gates.push({ entered: entered.resolve, wait: wait.promise, release: wait.resolve });
    return { entered: entered.promise, release: wait.resolve };
  }

  /**
   * Releases a held write during failed-test teardown.
   * @remarks No gate may keep cleanup alive forever.
   * @sideEffects Resolves the held write gate.
   */
  release(): void {
    this.#activeGate?.release();
    for (const gate of this.#gates.splice(0)) gate.release();
  }

  /**
   * Reads parsed committed contents for persistence assertions.
   * @remarks A malformed write must fail the test rather than be coerced.
   * @sideEffects none
   * @returns Valid vault contents.
   */
  contents(): VaultContents {
    const parsed = this.#data === null ? null : parseVault(this.#data);
    if (parsed === null) throw new Error("vault not initialized");
    return parsed;
  }
}

/** One accepted transport, retaining close state independently of service views. */
export interface AcceptedPhone {
  readonly transport: ClientTransport;
  readonly origin: TransportOrigin;
  closed: boolean;
  readonly messages: Array<string | null>;
}

/**
 * Starts a service against a real local relay, with controlled time and persistence.
 * @remarks The accept adapter records the authorization boundary without simulating the server.
 * @sideEffects Spawns a relay, opens sockets and registers complete test teardown.
 * @param relayOptions - Optional production relay admission setting for rapid leak loops.
 * @returns Service controls and independently observed accepts and events.
 */
export async function serviceFixture(relayOptions: { readonly newStreamsPerIpPerMinute?: number } = {}) {
  const relay = await startTestRelay(relayOptions);
  const vault = new MemoryVault();
  const clock = new FakeClock(1_800_000_000_000);
  const resources = new ResourceTracker();
  let document: RemoteDocument = { enabled: false, lastSeen: {} };
  const accepted: AcceptedPhone[] = [];
  const events: Array<{ id: string; event: RemoteUpdatedEvent }> = [];
  const logs: Record<string, unknown>[] = [];
  const phones: FakePhone[] = [];
  const serviceOptions: RemoteOptions = {
    vault,
    clock,
    resources,
    hostName: "Test Mac",
    logger: pino(
      {},
      {
        write: (line: string) => {
          logs.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    ),
    index: {
      read: () => document,
      save: async (next) => {
        document = next;
      },
      flush: async () => {},
    },
    send: (id, event) => events.push({ id, event }),
    accept: (transport, origin) => {
      const item: AcceptedPhone = { transport, origin, closed: false, messages: [] };
      transport.onMessage((text) => item.messages.push(text));
      transport.onClose(() => {
        item.closed = true;
      });
      accepted.push(item);
    },
  };
  let service = new RemoteService(serviceOptions);
  onTestFinished(async () => {
    vault.release();
    await Promise.all(phones.map((phone) => phone.dispose()));
    await service.close();
    await relay.cleanup();
    expect(clock.pendingTimers()).toBe(0);
    expect(Object.values(resources.snapshot()).every((count) => count === 0)).toBe(true);
  });
  await service.set(true, relay.line);
  await expect.poll(() => service.get("observer", undefined).relay?.status).toBe("connected");
  return {
    /**
     * Returns the current service generation.
     * @remarks Restart tests retain the same public fixture handle and persisted stores.
     * @sideEffects none
     * @returns The currently running service.
     */
    get service(): RemoteService {
      return service;
    },
    /**
     * Recreates the service from its saved switch and vault.
     * @remarks Calls the production start path, never set(true), so lost persistence cannot be masked.
     * @sideEffects Closes existing channels and starts a fresh service over the same stores.
     * @returns Once the old service has drained and the new service has started loading.
     */
    async restart(): Promise<void> {
      await service.close();
      service = new RemoteService(serviceOptions);
      service.start();
    },
    relay,
    vault,
    clock,
    resources,
    accepted,
    events,
    logs,
    /**
     * Creates a phone owned by this fixture.
     * @remarks Cleanup also covers phones whose handshake never completed.
     * @sideEffects Allocates an identity and registers teardown ownership.
     * @param options - Optional phone identity and metadata.
     * @returns The fake phone.
     */
    phone(options: ConstructorParameters<typeof FakePhone>[0] = {}): FakePhone {
      const phone = new FakePhone(options);
      phones.push(phone);
      return phone;
    },
  };
}

export type ServiceFixture = Awaited<ReturnType<typeof serviceFixture>>;

/**
 * Issues a new QR link and returns the local pairing view.
 * @remarks The QR secret is obtained through the local-only state, never from the relay.
 * @sideEffects Starts pairing expiry.
 * @param fixture - Running service fixture.
 * @returns The non-null pairing record.
 */
export function newPairing(fixture: ServiceFixture) {
  fixture.service.startPairing();
  const pairing = fixture.service.get("observer", undefined).pairing;
  if (pairing === null) throw new Error("missing pairing");
  return pairing;
}

/**
 * Waits for the encrypted confirmation to claim the pairing.
 * @remarks A completed Noise handshake alone is not authorization to persist a device.
 * @sideEffects Waits for socket delivery.
 * @param fixture - Running service.
 * @returns Once desktop confirmation is available.
 */
export async function awaiting(fixture: ServiceFixture): Promise<void> {
  await expect.poll(() => fixture.service.get("observer", undefined).pairing?.state).toBe("awaiting_confirmation");
}

/**
 * Completes one pairing and returns its channel and stable device id.
 * @remarks Reused by daily-connection and lifecycle cases, not by pairing failure assertions.
 * @sideEffects Opens a channel and commits a vault write.
 * @param fixture - Running service.
 * @param phone - Phone to pair.
 * @returns Channel and authenticated device identity.
 */
export async function pairDevice(
  fixture: ServiceFixture,
  phone: FakePhone,
): Promise<{ session: PhoneSession; deviceId: string }> {
  const pairing = newPairing(fixture);
  const session = await phone.pair(pairing.qr);
  await awaiting(fixture);
  await fixture.service.confirmPairing(pairing.pairingId, true);
  const paired = await session.control(["paired"]);
  if (typeof paired.deviceId !== "string") throw new Error("missing device id");
  return { session, deviceId: paired.deviceId };
}
