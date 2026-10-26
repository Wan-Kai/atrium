import { afterEach, describe, expect, it } from "vitest";
import { newHost, onlineHost, openStream, type Peer, startTestRelay, type TestRelay } from "../test/peers";

const ROUNDS = 200;

let current: TestRelay | undefined;

afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

/**
 * Node's live sockets and timers, apart from the relay's own counts.
 *
 * @remarks
 * A count released without `clearTimeout`, or a socket left open, shows up only here (testing.md,
 * "泄漏测试").
 *
 * @sideEffects none
 * @returns The counts by kind.
 */
function liveHandles(): Record<"TCPSocketWrap" | "TCPServerWrap" | "Timeout", number> {
  const resources = process.getActiveResourcesInfo();
  const count = (kind: string): number => resources.filter((resource) => resource === kind).length;
  return { TCPSocketWrap: count("TCPSocketWrap"), TCPServerWrap: count("TCPServerWrap"), Timeout: count("Timeout") };
}

/**
 * Closes the given peers and waits until they and the relay's ends are gone.
 *
 * @remarks
 * The relay sees a close a moment after the peer, so the handles are compared only once both
 * sides are done.
 *
 * @sideEffects Closes sockets.
 * @param peers - The peers.
 * @returns Once all are closed.
 */
async function closeAll(peers: readonly Peer[]): Promise<void> {
  for (const peer of peers) peer.socket.close();
  await Promise.all(peers.map((peer) => peer.closed));
}

/**
 * One round of everything a relay goes through in a day: a host coming online (replacing the
 * last control connection), a phone talking to it and leaving, a phone whose stream times out, a
 * bad hello, a hello that never comes, a phone for an offline host and a refused stream.
 *
 * @remarks
 * Each path holds timers and sockets of its own; all of them must be released.
 *
 * @sideEffects Opens and closes connections; advances the fake clock.
 * @param relay - The relay.
 * @returns The peers it opened.
 */
async function round(relay: TestRelay): Promise<Peer[]> {
  const control = await onlineHost(relay);
  const { phone, data } = await openStream(relay, control);
  phone.socket.send(Buffer.from([1, 2, 3]));
  await data.next();
  data.socket.send(Buffer.from([4, 5, 6]));
  await phone.next();
  phone.socket.close();
  await data.closed;

  const waiting = relay.peer(`/v1/client?host=${relay.host.hostId}`);
  await waiting.opened;
  await control.json();
  relay.clock.advance(10_000);
  await waiting.closed;

  const refused = relay.peer(`/v1/client?host=${relay.host.hostId}`);
  await refused.opened;
  const { streamId } = await control.json();
  control.sendJson({ type: "refuse", streamId });
  await refused.closed;

  const bad = relay.peer("/v1/host");
  await bad.opened;
  bad.sendJson({ v: 1, type: "hello", hostId: relay.host.hostId, token: "wrong" });
  await bad.closed;

  const silent = relay.peer("/v1/host/stream");
  await silent.opened;
  relay.clock.advance(5_000);
  await silent.closed;

  const offline = relay.peer(`/v1/client?host=${newHost().hostId}`);
  await offline.closed;
  await control.roundTrip();
  return [control, phone, data, waiting, refused, bad, silent, offline];
}

/**
 * Waits until `read` returns `expected`, yielding with `setImmediate` in between.
 *
 * @remarks
 * `vi.waitFor` keeps a timer of its own while it checks, which `liveHandles` would count; an
 * immediate is not a `Timeout`. Closes finish within a few turns of the event loop.
 *
 * @sideEffects Schedules immediates.
 * @param read - What to read.
 * @param expected - What it should become.
 * @returns The last value read, for the assertion.
 */
async function settle<T>(read: () => T, expected: T): Promise<T> {
  let value = read();
  for (let turn = 0; turn < 20_000 && JSON.stringify(value) !== JSON.stringify(expected); turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    value = read();
  }
  return value;
}

describe("relay leaks", () => {
  it(`returns counts, timers and sockets to their baseline after ${ROUNDS} rounds`, async () => {
    const relay = await startTestRelay({ config: { newStreamsPerIpPerMinute: 0 } });
    current = relay;
    const warm = await round(relay);
    await closeAll(warm);
    const zero = { "ws.host": 0, "ws.pending": 0, "ws.phone": 0, stream: 0, timer: 0 };
    expect(await settle(() => relay.resources.snapshot(), zero)).toStrictEqual(zero);
    const counts = relay.resources.snapshot();
    const timers = relay.clock.pendingTimers();
    const handles = liveHandles();

    const peers: Peer[] = [];
    for (let index = 0; index < ROUNDS; index += 1) {
      peers.push(...(await round(relay)));
      relay.peers.length = 0;
    }
    await closeAll(peers);

    expect(await settle(() => relay.resources.snapshot(), counts)).toStrictEqual(counts);
    expect(relay.clock.pendingTimers()).toBe(timers);
    expect(await settle(liveHandles, handles)).toStrictEqual(handles);
  });

  it("releases everything when it closes with connections still open", async () => {
    const relay = await startTestRelay();
    const handles = liveHandles();
    const control = await onlineHost(relay);
    await openStream(relay, control);
    const waiting = relay.peer(`/v1/client?host=${relay.host.hostId}`);
    const pending = relay.peer("/v1/host");
    await Promise.all([waiting.opened, pending.opened]);

    await relay.relay.close();
    await Promise.all(relay.peers.map((peer) => peer.closed));

    expect(Object.values(relay.resources.snapshot()).every((count) => count === 0)).toBe(true);
    expect(relay.clock.pendingTimers()).toBe(0);
    const after = { ...handles, TCPServerWrap: handles.TCPServerWrap - 1 };
    expect(await settle(liveHandles, after)).toStrictEqual(after);
  });
});
