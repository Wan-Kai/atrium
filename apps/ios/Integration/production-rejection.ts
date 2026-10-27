import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PROTOCOL_VERSION } from "../../../packages/protocol/src/version";
import type { RemotePairing } from "../../../packages/protocol/src/remote";
import { systemClock as hostClock } from "../../../packages/host/src/platform/clock";
import { createLogger } from "../../../packages/host/src/platform/logger";
import { ResourceTracker as HostResources } from "../../../packages/host/src/platform/resources";
import { parseVault, type RemoteDocument } from "../../../packages/host/src/remote/devices";
import { RemoteService } from "../../../packages/host/src/remote/remote-service";
import type { VaultPort } from "../../../packages/host/src/remote/vault";
import { systemClock } from "../../relay/src/clock";
import { hashToken } from "../../relay/src/hosts";
import { startRelay, type Relay } from "../../relay/src/relay";
import { ResourceTracker as RelayResources } from "../../relay/src/resources";
import { bounded, startControl, type ControlServer } from "./control";
import type { LocalFixture } from "./fixture";

/**
 * Starts the production rejection boundary, without startHost or Electron.
 * @remarks Only vault/index persistence is replaced; relay, service, crypto and sockets are real.
 * @sideEffects Opens loopback listeners and service sockets with ephemeral in-memory credentials.
 * @param signal - Runner interruption, including during startup.
 * @param holdConfirmation - Bounded pause after real SAS matching, solely for the SIGTERM check.
 * @returns The shared runner's control and cleanup interface.
 */
export async function startFixture(signal: AbortSignal, holdConfirmation: boolean): Promise<LocalFixture> {
  signal.throwIfAborted();
  const hostResources = new HostResources();
  const relayResources = new RelayResources();
  const hostId = `hst_${randomBytes(8).toString("hex")}`;
  const relayToken = randomBytes(32).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  const online = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<RemotePairing>();
  let document: RemoteDocument = { enabled: false, lastSeen: {} };
  let version = 0;
  let data: string | null = null;
  let acceptCount = 0;
  let service: RemoteService | undefined;
  let relay: Relay | undefined;
  let control: ControlServer | undefined;
  let closing: Promise<void> | undefined;
  const vault: VaultPort = {
    /** Reads committed memory. @remarks No Electron access. @sideEffects none */
    async read() {
      return { ok: true, version, data };
    },
    /**
     * Commits a newer version.
     * @remarks Keeps the real vault fence.
     * @sideEffects Replaces memory state.
     * @param nextVersion - Proposed monotonic revision.
     * @param nextData - Complete opaque vault text.
     */
    async write(nextVersion, nextData) {
      if (nextVersion <= version) return { ok: false, error: "stale" };
      version = nextVersion;
      data = nextData;
      return { ok: true };
    },
  };

  /**
   * Closes every resource even when startup, Swift assertions or cancellation fail.
   * @remarks A cleanup failure must not prevent the remaining owners from being closed.
   * @sideEffects Closes control requests, service streams, relay sockets and all tracked timers.
   * @returns When all teardown attempts and zero-resource assertions finish.
   */
  function close(): Promise<void> {
    return (closing ??= (async () => {
      const results = await Promise.allSettled([control?.close(), service?.close(), relay?.close()]);
      assert.ok(
        Object.values(hostResources.snapshot()).every((count) => count === 0),
        "host resources leaked",
      );
      assert.ok(
        Object.values(relayResources.snapshot()).every((count) => count === 0),
        "relay resources leaked",
      );
      for (const result of results) if (result.status === "rejected") throw result.reason;
      assert.equal(acceptCount, 0, "rejection fixture granted application access");
      if (data !== null) assert.deepEqual(parseVault(data)?.devices, [], "rejection fixture added a device");
      console.log(
        "Production interop cleanup: host/relay resources zero; control handlers/listeners closed; no grants",
      );
    })());
  }

  try {
    relay = await startRelay({
      config: { publicHost: "127.0.0.1", pathPrefix: "/atrium", trustedProxies: [], newStreamsPerIpPerMinute: 30 },
      hosts: [
        {
          hostId,
          name: "Production rejection host",
          tokenSha256: hashToken(relayToken),
          createdAt: "2026-10-26T00:00:00Z",
        },
      ],
      clock: systemClock,
      resources: relayResources,
      log: () => {},
      listen: { host: "127.0.0.1", port: 0 },
    });
    service = new RemoteService({
      vault,
      index: {
        /** Reads the index. @remarks Memory-only fixture. @sideEffects none */
        read: () => document,
        /**
         * Saves the index.
         * @remarks No user paths.
         * @sideEffects Replaces memory state.
         * @param next - New index document.
         */
        save: async (next) => {
          document = next;
        },
        /** Completes a memory write. @remarks No buffered IO. @sideEffects none */
        flush: async () => {},
      },
      clock: hostClock,
      resources: hostResources,
      logger: createLogger({
        destination: { write: () => {} },
        level: "fatal",
        secrets: () => [relayToken, token],
        service: "host",
      }),
      hostName: "Production rejection host",
      send: () => {
        const state = service?.get("swift-fixture", undefined);
        if (state?.relay?.status === "connected") online.resolve();
        if (state?.pairing?.state === "awaiting_confirmation") requested.resolve(state.pairing);
      },
      accept: () => {
        acceptCount++;
      },
    });
    const activeService = service;
    activeService.get("swift-fixture", true);
    await activeService.set(true, `atrium-relay://${hostId}:${relayToken}@127.0.0.1:${relay.port}/atrium`);
    await bounded(online.promise, signal);
    activeService.startPairing();
    const pairing = activeService.get("swift-fixture", undefined).pairing;
    assert.ok(pairing !== null);
    assert.equal(activeService.get("swift-fixture", undefined).devices.length, 0);
    const initialVault = data;
    let answered = false;
    control = await startControl(token, async (action, body, requestSignal) => {
      switch (action) {
        case "/setup":
          return { link: pairing.qr, protocolVersion: PROTOCOL_VERSION };
        case "/reject": {
          assert.equal(answered, false, "duplicate rejection command");
          const confirmation = await bounded(requested.promise, requestSignal);
          assert.equal(confirmation.pairingId, pairing.pairingId);
          assert.equal(activeService.get("swift-fixture", undefined).pairing?.state, "awaiting_confirmation");
          assert.ok(confirmation.request !== null);
          assert.ok("sas" in body);
          assert.ok(confirmation.request.sas === body.sas, "Swift and production TS SAS differ");
          assert.equal(confirmation.request.deviceName, "Local Swift rejection");
          if (holdConfirmation) {
            console.log("Production interop held before rejection: real awaiting_confirmation and matching SAS");
            await bounded(new Promise<never>(() => {}), requestSignal);
          }
          answered = true;
          await activeService.confirmPairing(pairing.pairingId, false);
          const state = activeService.get("swift-fixture", undefined);
          assert.equal(state.pairing?.reason, "declined");
          assert.equal(acceptCount, 0);
          assert.deepEqual(state.devices, []);
          assert.ok(data === initialVault, "refusal wrote the vault");
          console.log("Production interop rejected: local reason=declined; devices/accepts zero; vault unchanged");
          return { reason: state.pairing?.reason, acceptCount, deviceCount: state.devices.length };
        }
        case "/status": {
          const state = activeService.get("swift-fixture", undefined);
          assert.ok(data === initialVault, "refusal wrote the vault");
          return { reason: state.pairing?.reason, acceptCount, deviceCount: state.devices.length };
        }
        default:
          return undefined;
      }
    });
    console.log(
      `Production interop fixture: RemoteService + real relay, protocol ${PROTOCOL_VERSION}, loopback /atrium`,
    );
    return { origin: control.origin, token, close };
  } catch (error) {
    await close();
    throw error;
  }
}
