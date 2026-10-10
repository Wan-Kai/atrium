import type { AtriumClient } from "@atrium/client";
import type { TranscriptItem } from "@atrium/protocol";
import { createTempDir, fauxPi, present } from "@atrium/testkit";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type TestHost, startTestHost } from "../harness";

const minutes = Number(process.env["SOAK_MINUTES"] ?? 30);
const durationMs = minutes * 60_000;
/**
 * Rounds before the three chats are archived and three new ones take over; a sample follows each
 * change, so every sample is taken with transcripts just as long (none), about sixty in thirty
 * minutes.
 */
const ROUNDS_PER_CHATS = 30;
/** Long enough that a stop or a kill lands mid-stream: 60 tokens of two characters at 50 a second. */
const REPLY = "浸泡测试的回答，".repeat(15);

interface Sample {
  readonly elapsedMs: number;
  readonly cycles: number;
  readonly rss: number;
  readonly heapUsed: number;
  readonly children: number;
  readonly resources: Record<string, number>;
}

/** The three chats of a stretch of rounds, by what each round does to them. */
interface Chats {
  /** Stopped mid-run every round. */
  readonly stopped: string;
  /** Its pi is killed mid-run every round; the host restarts it and the run goes on. */
  readonly crashed: string;
  /** Runs to the end every round. */
  readonly finished: string;
}

/** Least-squares slope of `y` over `x`. */
function slope(points: ReadonlyArray<readonly [number, number]>): number {
  const n = points.length;
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / n;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / n;
  const covariance = points.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0);
  const variance = points.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
  return variance === 0 ? 0 : covariance / variance;
}

/**
 * The pids of the processes this test process started that still run, `ps` itself aside.
 *
 * @remarks
 * pi leads its own process group but stays this process's child until it exits.
 *
 * @sideEffects Runs `ps`.
 * @returns The pids, sorted.
 */
function children(): number[] {
  return execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([, ppid, comm]) => Number(ppid) === process.pid && comm !== "ps")
    .map(([pid]) => Number(pid))
    .toSorted((a, b) => a - b);
}

/**
 * Finds the real pi on this process's PATH.
 *
 * @remarks
 * The soak runs the pi that is installed, as the host would, only answering from the faux model.
 *
 * @sideEffects Checks files on disk.
 * @returns The path of `pi`.
 * @throws {Error} When pi is not installed.
 */
async function realPi(): Promise<string> {
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    const candidate = join(directory, "pi");
    if (
      directory !== "" &&
      (await access(candidate).then(
        () => true,
        () => false,
      ))
    )
      return candidate;
  }
  throw new Error("pi is not on PATH; the sessions soak needs it installed");
}

/**
 * Starts a host whose pi answers from the faux model, and a file listing the pis it started.
 *
 * @remarks
 * A `pi` wrapper first on PATH runs the real pi with the faux extension and passes `--version`
 * straight through, as in the end-to-end tests. Before it becomes the session's pi it appends its
 * process id to the list, so the soak can kill that very process; the one-shot title calls (`-p`)
 * stay off the list. Each pi answers the replies from the start, more than one stretch of rounds
 * asks of it.
 *
 * @sideEffects Creates a temporary directory with the script, the wrapper and pi's own config;
 * starts a host.
 * @returns The host and a function reading the listed pids, oldest first.
 */
async function fauxHost(): Promise<{ readonly testHost: TestHost; readonly pids: () => Promise<number[]> }> {
  const dir = await createTempDir("soak-pi");
  const launch = await fauxPi(
    {
      tokensPerSecond: 50,
      replies: Array.from({ length: ROUNDS_PER_CHATS * 3 }, () => ({ blocks: [{ type: "text", text: REPLY }] })),
      title: "浸泡",
    },
    dir.path,
  );
  const bin = join(dir.path, "bin");
  await mkdir(bin);
  const list = join(dir.path, "pids");
  await writeFile(list, "");
  const quoted = launch.args.map((arg) => `'${arg.replaceAll("'", String.raw`'\''`)}'`).join(" ");
  const wrapper = join(bin, "pi");
  await writeFile(
    wrapper,
    [
      "#!/bin/sh",
      `if [ "$1" = "--version" ]; then exec "$SOAK_REAL_PI" --version; fi`,
      `for arg in "$@"; do if [ "$arg" = "-p" ]; then exec "$SOAK_REAL_PI" "$@" ${quoted}; fi; done`,
      `echo $$ >> "$SOAK_PIDS"`,
      `exec "$SOAK_REAL_PI" "$@" ${quoted}`,
      "",
    ].join("\n"),
  );
  await chmod(wrapper, 0o755);
  const testHost = await startTestHost({
    logLevel: "warn",
    toolEnv: {
      ...launch.env,
      PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
      HOME: dir.path,
      SOAK_REAL_PI: await realPi(),
      SOAK_PIDS: list,
    },
  });
  await testHost.host.tools;
  const dispose = testHost.dispose;
  return {
    testHost: {
      ...testHost,
      dispose: async () => {
        await dispose();
        await dir.cleanup();
      },
    },
    pids: async () =>
      (await readFile(list, "utf8"))
        .split("\n")
        .filter((line) => line !== "")
        .map(Number),
  };
}

/**
 * Connects a new client that watches the chats.
 *
 * @remarks
 * Every round drops its client mid-run and comes back with a new one, as after a network drop.
 *
 * @sideEffects Opens a connection; subscribes to the list and the sessions.
 * @param testHost - The host.
 * @param chats - The chats to watch.
 * @returns The client.
 */
async function reconnect(testHost: TestHost, chats: Chats): Promise<AtriumClient> {
  const client = testHost.connect();
  expect(await client.connect()).toMatchObject({ status: "connected" });
  await client.watch([chats.stopped, chats.crashed, chats.finished]);
  return client;
}

/**
 * Waits until a chat's run of this round has ended, crash and restart included, and answers how.
 *
 * @remarks
 * After a crash the host notes the restart and sends a message of its own to go on; the round is
 * over only once a turn after that has ended.
 *
 * @sideEffects Waits.
 * @param client - A client watching the chat.
 * @param sessionId - The chat.
 * @param text - What the round sent.
 * @returns The outcome of the round's last turn.
 */
async function settled(client: AtriumClient, sessionId: string, text: string): Promise<string> {
  return vi.waitFor(
    () => {
      const view = present(client.session(sessionId), "view").getState();
      const last: TranscriptItem | undefined = view.items.at(-1);
      expect(view.run).toBeNull();
      expect([view.control.restarting, view.control.stopping]).toStrictEqual([false, false]);
      if (last?.kind !== "turn" || last.outcome === "running") throw new Error("the round has not ended");
      if (last.user.text !== text && !last.user.auto) throw new Error("the round has not started");
      return last.outcome;
    },
    { timeout: 30_000, interval: 20 },
  );
}

/**
 * Creates the three chats for a stretch of rounds, one after another.
 *
 * @remarks
 * A new chat starts its pi at once; waiting for each pi to be listed before the next chat tells
 * which pid is the crashing chat's.
 *
 * @sideEffects Creates chats; starts their pis.
 * @param client - A connected client.
 * @param pids - Reads the listed pids.
 * @returns The chats, and the pid of the crashing chat's pi.
 */
async function newChats(
  client: AtriumClient,
  pids: () => Promise<number[]>,
): Promise<{ readonly chats: Chats; readonly crashingPid: number }> {
  const created: Array<{ readonly sessionId: string; readonly pid: number }> = [];
  for (let chat = 0; chat < 3; chat++) {
    const listed = (await pids()).length;
    const { sessionId } = await client.createChat();
    const pid = await vi.waitFor(async () => present((await pids())[listed], "pid"));
    created.push({ sessionId, pid });
  }
  const [stopped, crashed, finished] = created.map((chat) => chat.sessionId);
  return {
    chats: {
      stopped: present(stopped, "chat"),
      crashed: present(crashed, "chat"),
      finished: present(finished, "chat"),
    },
    crashingPid: present(created[1], "chat").pid,
  };
}

/**
 * What the chats look like to a client, item by item for the last few.
 *
 * @remarks
 * Only the round's own words and the host's notices appear, never other conversation text.
 *
 * @sideEffects none
 * @param client - A client watching the chats.
 * @param chats - The chats.
 * @returns Each chat's status, run, control, pending messages and last items.
 */
function described(client: AtriumClient, chats: Chats): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(chats).map(([role, sessionId]) => {
      const view = client.session(sessionId)?.getState();
      return [
        role,
        view && {
          status: view.status,
          seq: view.seq,
          run: view.run,
          control: view.control,
          pending: view.pending.length,
          items: view.items
            .slice(-3)
            .map((item) =>
              item.kind === "turn"
                ? { turn: item.user.text, auto: item.user.auto, outcome: item.outcome, error: item.error }
                : { notice: item.notice },
            ),
        },
      ];
    }),
  );
}

/**
 * What to look at when a round goes wrong.
 *
 * @remarks
 * A round that goes wrong once in hundreds is hard to make happen again, so the failure carries
 * what the round's client sees, what a client connecting now sees (the host's own account), and
 * the host's warnings.
 *
 * @sideEffects Connects a client for a moment; reads the host's log.
 * @param testHost - The host.
 * @param client - The round's client.
 * @param chats - The chats.
 * @returns The account, as JSON.
 */
async function diagnose(testHost: TestHost, client: AtriumClient, chats: Chats): Promise<string> {
  const fresh = await reconnect(testHost, chats);
  await vi.waitFor(() =>
    expect(Object.values(chats).map((sessionId) => fresh.session(sessionId)?.getState().status)).not.toContain(
      "loading",
    ),
  );
  const seen = { client: described(client, chats), fresh: described(fresh, chats) };
  fresh.disconnect();
  const warnings = (await testHost.readLog())
    .filter((record) => record["level"] === "warn" || record["level"] === "error")
    .slice(-10)
    .map(({ time: _time, pid: _pid, hostname: _hostname, ...record }) => record);
  return JSON.stringify({ ...seen, warnings }, null, 1);
}

/**
 * Waits until the stopped and the crashing chat both run, so the round can stop and kill them.
 *
 * @sideEffects Waits; reads the host's log when they do not.
 * @param testHost - The host.
 * @param client - A client watching the chats.
 * @param chats - The chats.
 * @returns What went wrong, or nothing.
 */
async function runsStarted(testHost: TestHost, client: AtriumClient, chats: Chats): Promise<string> {
  const view = (sessionId: string) => present(client.session(sessionId), "view").getState();
  try {
    await vi.waitFor(() => expect([view(chats.stopped).run, view(chats.crashed).run]).not.toContain(null), {
      timeout: 30_000,
      interval: 20,
    });
    return "";
  } catch {
    return diagnose(testHost, client, chats);
  }
}

/**
 * How a round ended for each chat, and what to look at when that is not as expected.
 *
 * @sideEffects Waits; reads the host's log when a round went wrong.
 * @param testHost - The host.
 * @param client - A client watching the chats.
 * @param chats - The chats.
 * @param text - What the round sent.
 * @returns The outcomes, stopped, crashed and finished, and what went wrong if anything.
 */
async function roundOutcomes(
  testHost: TestHost,
  client: AtriumClient,
  chats: Chats,
  text: string,
): Promise<{ readonly outcomes: string[]; readonly diagnosis: string }> {
  const outcomes = [
    await settled(client, chats.stopped, text),
    await settled(client, chats.crashed, text),
    await settled(client, chats.finished, text),
  ];
  if (outcomes.join() === "stopped,done,done") return { outcomes, diagnosis: "" };
  return { outcomes, diagnosis: await diagnose(testHost, client, chats) };
}

describe("host soak", () => {
  it(
    `keeps resources flat while three chats run, stop, crash and reconnect for ${minutes} minutes`,
    async () => {
      const { testHost, pids } = await fauxHost();
      const host = testHost.host;
      await vi.waitFor(() =>
        expect([host.resources.snapshot()["span"] ?? 0, host.resources.snapshot()["git.process"] ?? 0]).toStrictEqual([
          0, 0,
        ]),
      );
      const baseline = host.resources.snapshot();
      const samples: Sample[] = [];
      const started = Date.now();
      let cycles = 0;
      let client = testHost.connect();
      await client.connect();
      let { chats, crashingPid } = await newChats(client, pids);

      while (Date.now() - started < durationMs) {
        await client.watch([chats.stopped, chats.crashed, chats.finished]);
        const text = `第 ${cycles} 轮`;
        await Promise.all([
          client.prompt(chats.stopped, text),
          client.prompt(chats.crashed, text),
          client.prompt(chats.finished, text),
        ]);
        expect(await runsStarted(testHost, client, chats)).toBe("");

        // Killed first, so it lands mid-run rather than as the run ends.
        const listed = (await pids()).length;
        // Only a pi this soak started and that still runs: never a reused pid.
        expect(children()).toContain(crashingPid);
        process.kill(crashingPid, "SIGKILL");
        expect(await client.stop(chats.stopped)).toStrictEqual({ confirmed: true });
        client.disconnect();
        client = await reconnect(testHost, chats);

        const round = await roundOutcomes(testHost, client, chats, text);
        expect(round).toStrictEqual({ outcomes: ["stopped", "done", "done"], diagnosis: "" });
        // The host started a new pi for the crashed chat, and only for it.
        const now = await pids();
        expect([now.length, children()]).toStrictEqual([listed + 1, expect.not.arrayContaining([crashingPid])]);
        crashingPid = present(now.at(-1), "pid");
        cycles += 1;

        if (cycles % ROUNDS_PER_CHATS === 0) {
          for (const sessionId of [chats.stopped, chats.crashed, chats.finished])
            await client.archiveSession(sessionId);
          ({ chats, crashingPid } = await newChats(client, pids));
          globalThis.gc?.();
          const memory = process.memoryUsage();
          samples.push({
            elapsedMs: Date.now() - started,
            cycles,
            rss: memory.rss,
            heapUsed: memory.heapUsed,
            children: children().length,
            resources: host.resources.snapshot(),
          });
        }
      }

      for (const sessionId of [chats.stopped, chats.crashed, chats.finished]) await client.archiveSession(sessionId);
      client.disconnect();
      const appeared = Object.keys(host.resources.snapshot()).filter((kind) => !(kind in baseline));
      const expected = { ...baseline, ...Object.fromEntries(appeared.map((kind) => [kind, 0])) };
      await vi.waitFor(() => expect(host.resources.snapshot()).toStrictEqual(expected), { timeout: 10_000 });
      await vi.waitFor(() => expect(children()).toStrictEqual([]), { timeout: 10_000 });
      const report = join(process.cwd(), "reports", "soak");
      await mkdir(report, { recursive: true });
      await writeFile(
        join(report, `sessions-${new Date().toISOString().replaceAll(":", "-")}.csv`),
        [
          "elapsed_ms,cycles,rss,heap_used,children,resources",
          ...samples.map(
            (s) =>
              `${s.elapsedMs},${s.cycles},${s.rss},${s.heapUsed},${s.children},"${JSON.stringify(s.resources).replaceAll('"', "'")}"`,
          ),
        ].join("\n"),
      );
      const afterWarmup = samples.slice(Math.floor(samples.length / 3));
      const bytesPerCycle = slope(afterWarmup.map((s) => [s.cycles, s.heapUsed] as const));
      await testHost.dispose();
      expect(afterWarmup.length).toBeGreaterThanOrEqual(10);
      expect(bytesPerCycle).toBeLessThan(1024);
    },
    durationMs + 180_000,
  );
});
