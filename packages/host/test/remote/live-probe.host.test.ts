import { describe, expect, it, onTestFinished } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { systemClock } from "../../src/platform/clock";
import { LINK_PING_MS, READY_TIMEOUT_MS } from "../../src/remote/relay-link";
import type { PhoneSession } from "./fake-phone";
import { Inbox } from "./inbox";
import { pairDevice, serviceFixture, type AcceptedPhone, type ServiceFixture } from "./service-fixture";

/** One actual proxied connection, retained so reconnects cannot masquerade as survival. */
interface ForwardedSocket {
  readonly path: string;
  readonly downstream: WebSocket;
  readonly upstream: WebSocket;
}

/**
 * Forwards every relay path while selectively withholding diagnostic pongs.
 * @remarks JSON authentication and binary Noise frames still cross the actual relay subprocess;
 * only WebSocket ping responses are controlled through public ws APIs.
 * @sideEffects Opens a loopback server and owned upstream sockets; registers terminating cleanup.
 * @param fixture - The real relay and service whose address will be replaced before pairing.
 * @returns Public socket observations and fault controls.
 */
async function forwardingProxy(fixture: ServiceFixture) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, autoPong: false });
  const connections: ForwardedSocket[] = [];
  const sockets = new Map<WebSocket, Promise<void>>();
  const probes: Buffer[] = [];
  const controls = { answerProbes: false, normalPongs: 0 };
  /**
   * Owns a socket until its real close event.
   * @remarks Explicit error handling covers termination while an upstream is still connecting.
   * @sideEffects Registers close and error listeners for bounded cleanup.
   * @param socket - A socket created or accepted by this proxy.
   */
  const own = (socket: WebSocket): void => {
    sockets.set(socket, new Promise<void>((resolve) => socket.once("close", resolve)));
    socket.on("error", () => socket.terminate());
  };
  onTestFinished(async () => {
    for (const socket of sockets.keys()) socket.terminate();
    await Promise.all(sockets.values());
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  server.on("connection", (downstream, request) => {
    const path = request.url ?? "/";
    const upstream = new WebSocket(new URL(path, fixture.relay.endpoint.url));
    own(downstream);
    own(upstream);
    connections.push({ path, downstream, upstream });
    const queued: Array<{ data: RawData; binary: boolean }> = [];
    downstream.on("message", (data, binary) => {
      if (upstream.readyState === WebSocket.CONNECTING) queued.push({ data, binary });
      else if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
    });
    upstream.once("open", () => {
      for (const { data, binary } of queued.splice(0)) upstream.send(data, { binary });
    });
    upstream.on("message", (data, binary) => {
      if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary });
    });
    downstream.on("ping", (payload: Buffer) => {
      if (payload.length === 16) {
        probes.push(Buffer.from(payload));
        if (controls.answerProbes) downstream.pong(payload);
      } else {
        downstream.pong(payload);
        if (payload.length === 0) controls.normalPongs++;
      }
    });
    downstream.once("close", () => upstream.terminate());
    upstream.once("close", (code, reason) => {
      if (code === 1006) downstream.terminate();
      else downstream.close(code, reason);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing proxy address");
  const { hostId, token } = fixture.relay.endpoint;
  await fixture.service.set(true, `atrium-relay://${hostId}:${token}@127.0.0.1:${address.port}/atrium`);
  await expect.poll(() => fixture.service.get("observer", undefined).relay?.status).toBe("connected");
  const control = connections.find((connection) => connection.path === "/atrium/v1/host");
  if (control === undefined) throw new Error("missing control socket");
  return {
    connections,
    probes,
    controls,
    control,
    /**
     * Waits until the host has processed all prior control-socket frames.
     * @remarks A public ping/pong barrier avoids advancing fake time before the ordinary pong arrives.
     * @sideEffects Sends a WebSocket ping and temporarily listens for its pong.
     * @returns Once the peer has responded, bounded by the inbox's real deadline.
     */
    async barrier(): Promise<void> {
      const arrivals = new Inbox<Buffer>(systemClock);
      const payload = Buffer.from("socket-barrier");
      /** Receives the public pong. @remarks Matching happens in the inbox. @sideEffects Enqueues a wire arrival. */
      const receive = (data: Buffer): void => arrivals.push(data);
      control.downstream.on("pong", receive);
      try {
        control.downstream.ping(payload);
        await arrivals.next((data) => data.equals(payload));
      } finally {
        control.downstream.off("pong", receive);
      }
    },
  };
}

/**
 * Exchanges distinct application messages over the already accepted Noise channel.
 * @remarks This is a real socket barrier and refreshes data-channel activity before virtual time advances.
 * @sideEffects Sends and receives encrypted frames in both directions.
 * @param session - The original phone session.
 * @param accepted - The original accepted host transport.
 * @param sequence - Distinguishes this exchange from previously buffered messages.
 */
async function exchange(session: PhoneSession, accepted: AcceptedPhone, sequence: number): Promise<void> {
  const request = { type: "probe_regression_request", sequence };
  const response = { type: "probe_regression_response", sequence };
  session.send(request);
  await expect.poll(() => accepted.messages.at(-1)).toBe(JSON.stringify(request));
  accepted.transport.send(JSON.stringify(response));
  expect(await session.message((value) => value.sequence === sequence)).toStrictEqual(response);
}

describe("live relay diagnostics do not own the phone lifecycle", () => {
  it("keeps the same authenticated phone after a probe timeout and succeeds on a fresh probe", async () => {
    const f = await serviceFixture();
    const proxy = await forwardingProxy(f);
    const { session, deviceId } = await pairDevice(f, f.phone());
    const accepted = f.accepted[0]!;
    const connections = [...proxy.connections];
    expect(connections.map(({ path }) => path.split("?")[0]!).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
      "/atrium/v1/client",
      "/atrium/v1/host",
      "/atrium/v1/host/stream",
    ]);
    expect(accepted.origin).toStrictEqual({ origin: "remote", deviceId });
    await exchange(session, accepted, 0);
    // Start just before the regular heartbeat so its empty pong cannot satisfy this check.
    f.clock.advance(LINK_PING_MS - READY_TIMEOUT_MS / 2);
    await exchange(session, accepted, 1);
    const failed = f.service.testRelay().catch((error: unknown) => error);
    await expect.poll(() => proxy.probes.length).toBe(1);
    f.clock.advance(READY_TIMEOUT_MS / 2);
    await expect.poll(() => proxy.controls.normalPongs).toBe(1);
    await proxy.barrier();
    await exchange(session, accepted, 2);
    f.clock.advance(READY_TIMEOUT_MS / 2);
    expect(await failed).toMatchObject({ code: "relay_unreachable" });
    expect(f.service.get("observer", undefined).relay).toMatchObject({
      status: "connected",
      error: null,
      diagnostics: { kind: "live", checkedAt: f.clock.now(), failure: "timeout", token: "unknown" },
    });
    expect(f.service.get("observer", undefined).devices).toMatchObject([{ deviceId, online: true }]);
    expect(f.accepted).toStrictEqual([accepted]);
    expect(accepted.closed).toBe(false);
    for (const { downstream, upstream } of connections) {
      expect(downstream.readyState).toBe(WebSocket.OPEN);
      expect(upstream.readyState).toBe(WebSocket.OPEN);
    }
    await exchange(session, accepted, 3);
    proxy.controls.answerProbes = true;
    expect(await f.service.testRelay()).toStrictEqual({});
    expect(proxy.probes).toHaveLength(2);
    expect(proxy.probes[1]).not.toStrictEqual(proxy.probes[0]);
    expect(f.service.get("observer", undefined).relay).toMatchObject({
      status: "connected",
      diagnostics: { kind: "live", failure: null, network: "passed", token: "unknown" },
    });
    // Pass the next ordinary heartbeat too; its previous empty pong really kept this socket alive.
    f.clock.advance(15_000);
    await exchange(session, accepted, 4);
    f.clock.advance(10_000);
    await expect.poll(() => proxy.controls.normalPongs).toBe(2);
    await proxy.barrier();
    await exchange(session, accepted, 5);
    expect(proxy.connections).toStrictEqual(connections);
    expect(f.accepted).toStrictEqual([accepted]);
    expect(accepted.closed).toBe(false);
    expect(f.service.get("observer", undefined).devices).toMatchObject([{ deviceId, online: true }]);
  });

  it.each([
    { code: 1000, error: "relay_unreachable", failure: "connection_closed" },
    { code: 4401, error: "relay_rejected", failure: "token_rejected" },
  ])(
    "still drops the authenticated phone when the control socket really closes with $code",
    async ({ code, error, failure }) => {
      const f = await serviceFixture();
      const proxy = await forwardingProxy(f);
      const { session, deviceId } = await pairDevice(f, f.phone());
      const accepted = f.accepted[0]!;
      await exchange(session, accepted, 0);
      const failed = f.service.testRelay().catch((reason: unknown) => reason);
      await expect.poll(() => proxy.probes.length).toBe(1);
      proxy.control.downstream.close(code);
      expect(await failed).toMatchObject({ code: error });
      await session.closed;
      await expect.poll(() => accepted.closed).toBe(true);
      expect(f.service.get("observer", undefined).relay).toMatchObject({
        status: "error",
        error,
        diagnostics: { kind: "live", failure, token: "unknown" },
      });
      expect(f.service.get("observer", undefined).devices).toMatchObject([{ deviceId, online: false }]);
      expect(f.accepted).toStrictEqual([accepted]);
    },
  );
});
