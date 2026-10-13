import { CommandError } from "@atrium/protocol";
import { type ScriptedPiBehavior, FakeClock, createTempDir, writeScriptedPi } from "@atrium/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import { createPiDeps } from "../platform/pi-deps";
import { forkWithPi } from "./session-forker";
import { type TracedPi, startTracedPi } from "./traced-pi";

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Starts a scripted pi through `startTracedPi`. */
async function start(behavior: ScriptedPiBehavior): Promise<TracedPi> {
  const dir = await createTempDir("forker");
  const scripted = await writeScriptedPi(dir.path, behavior);
  const recording = recordingTracing();
  const traced = startTracedPi({
    launch: { piPath: scripted.piPath, args: [], cwd: dir.path, env: scripted.env },
    deps: createPiDeps({
      clock: systemClock,
      resources: recording.resources,
      logger: recording.logger,
      env: { PATH: process.env["PATH"] ?? "" },
    }),
    tracer: recording.tracer,
  });
  cleanups.push(dir.cleanup, recording.shutdown, () => traced.process.stop());
  return traced;
}

/** Forks with `pi` after the turn before `u2`, recording why it failed. */
function fork(pi: TracedPi, clock: FakeClock, signal = new AbortController().signal) {
  const failures: string[] = [];
  let settled = false;
  const forked = forkWithPi({ pi, at: "u2", name: "n", clock, signal, onFailed: (reason) => failures.push(reason) });
  const outcome = forked.then(
    (value) => value,
    (error: unknown) => error,
  );
  // Fire and forget: only records that it settled.
  void outcome.finally(() => (settled = true));
  return { outcome, failures, settled: () => settled };
}

describe("forkWithPi", () => {
  it("gives up once the fork has taken 30 s, and stops its pi", async () => {
    const pi = await start({ rules: { fork: { silent: true } } });
    const clock = new FakeClock(0);
    const { outcome, failures, settled } = fork(pi, clock);

    clock.advance(29_999);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled()).toBe(false);
    clock.advance(1);

    expect(await outcome).toStrictEqual(new CommandError("fork_failed"));
    expect(failures).toStrictEqual(["timeout"]);
    expect(await pi.process.exited).toMatchObject({ requested: true });
  });

  it("counts the deadline over the whole fork, not each request", async () => {
    const pi = await start({
      rules: { fork: { data: { text: "two", cancelled: false } }, get_state: { silent: true } },
    });
    const clock = new FakeClock(0);
    const { outcome, failures } = fork(pi, clock);
    // Before pi answers the fork; by the next step it has, and is asked for its state.
    clock.advance(20_000);
    await new Promise((resolve) => setTimeout(resolve, 200));

    clock.advance(10_000);

    expect(await outcome).toStrictEqual(new CommandError("fork_failed"));
    expect(failures).toStrictEqual(["timeout"]);
  });

  it("passes on what is not pi's failing, still stopping its pi", async () => {
    const pi = await start({});
    const bug = new Error("not pi's");
    const broken: TracedPi = { process: pi.process, request: () => Promise.reject(bug) };
    const { outcome, failures } = fork(broken, new FakeClock(0));

    expect(await outcome).toBe(bug);
    expect(failures).toStrictEqual([]);
    expect(await pi.process.exited).toMatchObject({ requested: true });
  });
});
