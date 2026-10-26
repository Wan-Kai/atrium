import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { systemClock } from "../../relay/src/clock";
import { hashToken } from "../../relay/src/hosts";
import { type Relay, startRelay } from "../../relay/src/relay";
import { ResourceTracker } from "../../relay/src/resources";
import { FakeHost, type PairingRequest } from "../../../spikes/mobile-mp0/ts/fake-host";

/** A disposable fixture, owned by the integration runner. */
export interface LocalFixture {
  readonly origin: string;
  readonly token: string;
  /**
   * Releases every fixture socket and verifies the relay's resource counters.
   *
   * @remarks The runner calls this on success, failure and interruption.
   * @sideEffects Closes host, relay and control connections and cancels timers.
   * @returns When all resources are released.
   */
  close(): Promise<void>;
}

/**
 * Starts the actual relay and the unchanged MP0 host on loopback with in-memory state.
 *
 * @remarks The HTTP side channel only drives explicit host decisions, never substitutes wire traffic.
 * @sideEffects Opens two loopback listeners, host sockets and timers; creates ephemeral credentials.
 * @param negativeControl - Deliberately return the wrong SAS to prove the Swift assertion fails.
 * @returns The test control origin, credential and cleanup operation.
 */
export async function startFixture(negativeControl: boolean): Promise<LocalFixture> {
  const resources = new ResourceTracker();
  const hostId = `hst_${randomBytes(8).toString("hex")}`;
  const relayToken = randomBytes(32).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  const online = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<PairingRequest>();
  let host: FakeHost | undefined;
  let relay: Relay | undefined;
  let server: Server | undefined;
  let helloCount = 0;

  /**
   * Closes listeners and peers, then verifies the real relay released its tracked resources.
   *
   * @remarks Closing the host and relay together bounds host closure even if a peer stops responding.
   * @sideEffects Closes sockets and cancels relay/host timers.
   * @returns When cleanup and resource assertions finish.
   */
  async function close(): Promise<void> {
    const controlClosed = server
      ? new Promise<void>((resolve, reject) => {
          server?.close((error) => (error ? reject(error) : resolve()));
          server?.closeAllConnections();
        })
      : Promise.resolve();
    await Promise.all([host?.close(), relay?.close(), controlClosed]);
    assert.ok(
      Object.values(resources.snapshot()).every((count) => count === 0),
      "relay leaked resources",
    );
    console.log("Local interop cleanup: relay resources zero; listeners closed");
  }

  try {
    relay = await startRelay({
      config: {
        publicHost: "127.0.0.1",
        pathPrefix: "/atrium",
        trustedProxies: [],
        newStreamsPerIpPerMinute: 30,
      },
      hosts: [
        { hostId, name: "Local MP0 host", tokenSha256: hashToken(relayToken), createdAt: "2026-10-26T00:00:00Z" },
      ],
      clock: systemClock,
      resources,
      log: (event) => {
        if (event.event === "host_online") online.resolve();
      },
      listen: { host: "127.0.0.1", port: 0 },
    });
    host = new FakeHost({
      relayUrl: `ws://127.0.0.1:${relay.port}/atrium`,
      hostId,
      token: relayToken,
      hostName: "Local MP0 host",
      statePath: null,
      log: () => {},
    });
    const activeHost = host;
    host.on("pairing_request", (request) => requested.resolve(request));
    host.on("device_hello", () => helloCount++);
    await host.start();
    // start() resolves on WebSocket open, before the real relay authenticates its hello.
    await bounded(online.promise);
    const pairing = host.startPairing();

    /**
     * Handles a single bounded, authenticated fixture command.
     *
     * @remarks Responses expose only test state; a failure never logs request bodies or credentials.
     * @sideEffects Reads HTTP input and may confirm pairing or revoke the ephemeral device.
     * @param request - Loopback HTTP request.
     * @param response - HTTP response.
     * @returns Once the response is written.
     */
    async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
      if (request.method !== "POST" || request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(403).end();
        return;
      }
      let text = "";
      for await (const chunk of request) {
        text += String(chunk);
        assert.ok(text.length <= 4096, "control request too large");
      }
      const body: unknown = JSON.parse(text);
      assert.ok(typeof body === "object" && body !== null && !Array.isArray(body));
      let result: Record<string, unknown>;
      switch (request.url ?? "") {
        case "/setup":
          result = { link: pairing.link };
          break;
        case "/confirm": {
          const confirmation = await bounded(requested.promise);
          assert.ok("sas" in body);
          assert.equal(confirmation.sas, body.sas, "Swift and TS SAS differ");
          assert.equal(confirmation.deviceName, "Local Swift interop");
          assert.equal(confirmation.model, "macOS test");
          assert.equal(activeHost.confirmPairing(confirmation.pairingId, true), true);
          const wrongSas = confirmation.sas === "000000" ? "111111" : "000000";
          result = { sas: negativeControl ? wrongSas : confirmation.sas };
          break;
        }
        case "/revoke":
          assert.ok("deviceId" in body && typeof body.deviceId === "string");
          assert.equal(activeHost.revoke(body.deviceId), true);
          result = { revoked: true };
          break;
        case "/status":
          result = { helloCount, deviceCount: activeHost.devices.length };
          break;
        default:
          response.writeHead(404).end();
          return;
      }
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    }

    server = createServer((request, response) => {
      void handle(request, response).catch(() => {
        response.writeHead(500).end();
      });
    });
    server.requestTimeout = 10_000;
    const controlServer = server;
    await new Promise<void>((resolve, reject) => {
      controlServer.once("error", reject);
      controlServer.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    const port = address.port;
    console.log("Local interop fixture: real relay + TS MP0 host, loopback only, prefix /atrium");
    return { origin: `http://127.0.0.1:${port}`, token, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Bounds a fixture event wait without leaving its timeout behind.
 *
 * @remarks Host authentication and pair_confirm must arrive before the Swift control timeout.
 * @sideEffects Registers and clears a five-second timer.
 * @param promise - The event to await.
 * @returns The event value.
 */
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("local fixture event timed out")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
