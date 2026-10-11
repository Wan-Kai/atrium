import type { PiLatestEvent } from "@atrium/protocol";
import { FakeClock } from "@atrium/testkit";
import { type IncomingHttpHeaders, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import { LatestError, type PiLatestService, createPiLatest, fetchLatestPi } from "./pi-latest";

const DAY = 24 * 60 * 60 * 1000;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * A local server answering every request the same way, recording the request headers.
 *
 * @remarks
 * Stands in for `https://pi.dev/api/latest-version`.
 *
 * @sideEffects Listens on a port of 127.0.0.1, closed after the test.
 * @param answer - Writes the response.
 * @returns The server's address and the headers of each request.
 */
async function versionServer(
  answer: (response: ServerResponse) => void,
): Promise<{ url: string; headers: IncomingHttpHeaders[] }> {
  const headers: IncomingHttpHeaders[] = [];
  const server: Server = createServer((request, response) => {
    headers.push(request.headers);
    answer(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/api/latest-version`, headers };
}

/**
 * Looks up the latest pi at a test server, with a short time limit.
 *
 * @remarks
 * See {@link versionServer}.
 *
 * @sideEffects Makes an HTTP request.
 * @param url - The address.
 * @param signal - Cancels the request.
 * @returns The version.
 */
function lookUp(url: string, signal = new AbortController().signal): Promise<string> {
  return fetchLatestPi(url, { signal, clock: systemClock, timeoutMs: 500 });
}

describe("fetchLatestPi", () => {
  it("reads the version pi.dev gives, asking for JSON", async () => {
    const { url, headers } = await versionServer((response) =>
      response.end(JSON.stringify({ ok: true, version: " 1.12.10 ", packageName: "@earendil-works/pi-coding-agent" })),
    );

    expect(await lookUp(url)).toBe("1.12.10");
    expect(headers[0]?.accept).toBe("application/json");
  });

  it.each([
    ["not JSON", "<html>", "invalid"],
    ["without a version", JSON.stringify({ ok: true }), "invalid"],
    ["with an empty version", JSON.stringify({ version: " " }), "invalid"],
    ["with something else than a version", JSON.stringify({ version: "v1.1.0" }), "invalid"],
    ["not an object", JSON.stringify("1.1.0"), "invalid"],
    ["over 64 KiB", JSON.stringify({ version: "1.1.0", note: "x".repeat(65_536) }), "too_large"],
  ])("fails when the answer is %s", async (_case, body, reason) => {
    const { url } = await versionServer((response) => response.end(body));

    const failing = lookUp(url);

    await expect(failing).rejects.toBeInstanceOf(LatestError);
    await expect(failing).rejects.toMatchObject({ reason });
  });

  it.each([
    ["fails", (response: ServerResponse) => response.writeHead(500).end(), "status"],
    ["moves", (response: ServerResponse) => response.writeHead(302, { location: "/elsewhere" }).end(), "status"],
    ["takes too long", () => undefined, "timeout"],
  ])("fails when the server %s", async (_case, answer, reason) => {
    const { url } = await versionServer(answer);

    await expect(lookUp(url)).rejects.toMatchObject({ reason });
  });

  it("fails when nothing answers, and stops when cancelled", async () => {
    const { url } = await versionServer(() => undefined);
    const stop = new AbortController();

    const cancelled = lookUp(url, stop.signal);
    stop.abort();

    await expect(cancelled).rejects.toMatchObject({ reason: "aborted" });
    await expect(lookUp("http://127.0.0.1:1/api/latest-version")).rejects.toMatchObject({ reason: "network" });
  });
});

/**
 * A latest-pi service over looked-up versions a test gives in order, on a fake clock.
 *
 * @remarks
 * Each look-up takes the next of `answers`: a version, or an error to throw. One that is `null`
 * waits until the check is cancelled.
 *
 * @sideEffects Closes the service after the test.
 * @param answers - What each look-up finds.
 * @param offline - Whether `PI_OFFLINE` is set in pi's environment, or the error reading it gives.
 * @returns The service, the clock, its events, the log records, and how many look-ups ran.
 */
function service(
  answers: (string | LatestError | null)[],
  offline: boolean | Error = false,
): {
  latest: PiLatestService;
  clock: FakeClock;
  events: PiLatestEvent[];
  records: Record<string, unknown>[];
  lookups: () => number;
  aborted: () => boolean;
} {
  const clock = new FakeClock(1000);
  const recording = recordingTracing();
  cleanups.push(recording.shutdown);
  const events: PiLatestEvent[] = [];
  let lookups = 0;
  let aborted = false;
  const latest = createPiLatest({
    lookup: async (signal) => {
      const answer = answers[lookups];
      lookups += 1;
      if (answer === null || answer === undefined) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        aborted = true;
        throw new LatestError("aborted");
      }
      if (answer instanceof LatestError) throw answer;
      return answer;
    },
    offline: async () => {
      if (offline instanceof Error) throw offline;
      return offline;
    },
    clock,
    resources: recording.resources,
    broadcast: (event) => events.push(event),
    logger: recording.logger,
  });
  cleanups.push(() => latest.close());
  return { latest, clock, events, records: recording.records, lookups: () => lookups, aborted: () => aborted };
}

describe("PiLatestService", () => {
  it("checks once started and then every day, sending what it finds to every connection", async () => {
    const { latest, clock, events, records } = service(["1.1.0", "1.2.0"]);
    const before = latest.current();

    latest.start();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    clock.advance(DAY - 1);
    expect(events).toHaveLength(1);
    clock.advance(1);
    await vi.waitFor(() => expect(events).toHaveLength(2));

    expect(before).toStrictEqual({ latest: null, checkedAt: null });
    expect(events).toStrictEqual([
      { type: "pi_latest", latest: "1.1.0", checkedAt: 1000 },
      { type: "pi_latest", latest: "1.2.0", checkedAt: 1000 + DAY },
    ]);
    expect(latest.current()).toStrictEqual({ latest: "1.2.0", checkedAt: 1000 + DAY });
    expect(records).toContainEqual(expect.objectContaining({ msg: "pi update checked", latest: "1.2.0" }));
  });

  it("checks now when asked, sharing a check under way", async () => {
    const { latest, lookups } = service(["1.1.0"]);

    const both = await Promise.all([latest.check(), latest.check()]);

    expect(both).toStrictEqual([
      { latest: "1.1.0", checkedAt: 1000 },
      { latest: "1.1.0", checkedAt: 1000 },
    ]);
    expect(lookups()).toBe(1);
  });

  it("keeps what it found when a later check finds nothing, and logs only why", async () => {
    const { latest, clock, events, records } = service(["1.1.0", new LatestError("network")]);
    await latest.check();
    clock.advance(5);

    const after = await latest.check();

    expect(after).toStrictEqual({ latest: "1.1.0", checkedAt: 1000 });
    expect(events).toHaveLength(1);
    expect(records).toContainEqual(expect.objectContaining({ msg: "pi update check failed", reason: "network" }));
  });

  it("does not check when pi is told to stay offline, but keeps its schedule", async () => {
    const { latest, clock, events, lookups } = service(["1.1.0"], true);

    latest.start();
    await expect(latest.check()).resolves.toStrictEqual({ latest: null, checkedAt: null });
    await vi.waitFor(() => expect(clock.pendingTimers()).toBe(1));

    expect(lookups()).toBe(0);
    expect(events).toStrictEqual([]);
  });

  it("logs a check as failed when pi's environment cannot be read, and keeps its schedule", async () => {
    const { latest, clock, lookups, records } = service(["1.1.0"], new Error("no shell"));

    latest.start();
    await vi.waitFor(() => expect(clock.pendingTimers()).toBe(1));

    expect(latest.current()).toStrictEqual({ latest: null, checkedAt: null });
    expect(lookups()).toBe(0);
    expect(records).toContainEqual(expect.objectContaining({ msg: "pi update check failed", reason: "unknown" }));
  });

  it("stops a check under way and checks no more once closed", async () => {
    const { latest, clock, lookups, aborted, records } = service([null]);
    latest.start();
    await vi.waitFor(() => expect(lookups()).toBe(1));

    await latest.close();
    clock.advance(DAY);

    expect(aborted()).toBe(true);
    expect(clock.pendingTimers()).toBe(0);
    expect(lookups()).toBe(1);
    expect(records.filter((record) => record["msg"] === "pi update check failed")).toStrictEqual([]);
  });
});
