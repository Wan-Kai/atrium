import { FakeClock, type ScriptedPiBehavior, createTempDir, present, writeScriptedPi } from "@atrium/testkit";
import { getEventListeners } from "node:events";
import { realpath } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiDeps } from "../deps";
import type { ProcessSystem } from "./kill-tree";
import { DROPPED_REQUESTS_KEPT, type PiEvent, PiRequestError, type PiTap, startPiProcess } from "./pi-process";

/** One log call. */
interface LogRecord {
  readonly level: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly message: string;
}

const realClock: PiDeps["clock"] = {
  now: () => Date.now(),
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

const cleanups: (() => Promise<void>)[] = [];

/** Generous waits: these tests also run under heavy parallel load (mutation testing, stress runs). */
const WAIT = { timeout: 15_000, interval: 10 };

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Dependencies that record logs and open resources. */
function recordingDeps(clock: PiDeps["clock"]) {
  const logs: LogRecord[] = [];
  const open = new Map<string, number>();
  let nextId = 0;
  const record =
    (level: string) =>
    (fields: object, message: string): void => {
      logs.push({ level, fields: fields as Record<string, unknown>, message });
    };
  const deps: PiDeps = {
    clock,
    track(kind) {
      open.set(kind, (open.get(kind) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        open.set(kind, (open.get(kind) ?? 0) - 1);
      };
    },
    log: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") },
    nextRequestId: () => `req-${++nextId}`,
    env: { PATH: process.env["PATH"] ?? "" },
  };
  return { deps, logs, open };
}

/** Starts a fake pi with recording dependencies. */
async function start(
  behavior: ScriptedPiBehavior,
  options: {
    clock?: PiDeps["clock"];
    stopGraceMs?: number;
    args?: readonly string[];
    processSystem?: ProcessSystem;
    tap?: PiTap;
    /** Added to the scripted pi's own environment variables. */
    extraEnv?: Readonly<Record<string, string>>;
  } = {},
) {
  const dir = await createTempDir("pi-process");
  const fake = await writeScriptedPi(dir.path, behavior);
  const { deps, logs, open } = recordingDeps(options.clock ?? realClock);
  const pi = startPiProcess(
    { piPath: fake.piPath, args: options.args ?? [], cwd: dir.path, env: { ...options.extraEnv, ...fake.env } },
    deps,
    {
      stopGraceMs: options.stopGraceMs ?? 2_000,
      ...(options.processSystem === undefined ? {} : { processSystem: options.processSystem }),
      ...(options.tap === undefined ? {} : { tap: options.tap }),
    },
  );
  const events: PiEvent[] = [];
  pi.onEvent((event) => events.push(event));
  cleanups.push(async () => {
    await pi.stop();
    await dir.cleanup();
  });
  return { pi, logs, open, events, dir: dir.path };
}

/** Waits until an event of `type` has arrived and returns it. */
async function eventOf(events: readonly PiEvent[], type: string): Promise<Record<string, unknown>> {
  return vi.waitFor(
    () => present(events.find((event) => event.type === type) as Record<string, unknown> | undefined, type),
    WAIT,
  );
}

/** Whether a process with this pid exists. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pids of the grandchildren the fake pi announced. */
async function grandchildPids(events: readonly PiEvent[], count: number): Promise<number[]> {
  return vi.waitFor(() => {
    const pids = events
      .filter((event) => event.type === ("grandchild" as string))
      .map((event) => (event as unknown as { pid: number }).pid);
    if (pids.length < count) throw new Error("grandchildren not announced yet");
    return pids;
  }, WAIT);
}

/** The log entries with this message. */
function logsWith(logs: readonly LogRecord[], message: string): LogRecord[] {
  return logs.filter((log) => log.message === message);
}

/** The types of the events, in order. */
function typesOf(events: readonly PiEvent[]): string[] {
  return events.map((event) => event.type);
}

/** Records the order in which promises settle. */
function settleOrder(promises: Record<string, Promise<unknown>>): Promise<string[]> {
  const order: string[] = [];
  return Promise.allSettled(
    Object.entries(promises).map(([name, promise]) => promise.finally(() => order.push(name))),
  ).then(() => order);
}

describe("requests", () => {
  it("matches responses to requests by id when pi answers out of order", async () => {
    const { pi } = await start({
      rules: {
        get_state: { after: "get_available_models", data: { which: "state" } },
        get_available_models: { data: { models: [] } },
      },
    });

    const state = pi.request({ type: "get_state" });
    const models = pi.request({ type: "get_available_models" });

    expect(await settleOrder({ state, models })).toStrictEqual(["models", "state"]);
    expect(await state).toStrictEqual({ which: "state" });
    expect(await models).toStrictEqual({ models: [] });
  });

  it("starts pi in RPC mode with the launch arguments and logs the start", async () => {
    const { pi, events, logs, dir } = await start({ announceArgv: true }, { args: ["--no-session"] });

    expect(await eventOf(events, "argv")).toStrictEqual({
      type: "argv",
      argv: ["--mode", "rpc", "--no-session"],
      cwd: await realpath(dir),
    });
    expect(logs[0]).toStrictEqual({ level: "info", fields: { pid: pi.pid, cwd: dir }, message: "pi started" });
  });

  it("sends each command with the id from nextRequestId and logs it", async () => {
    const { pi, events, logs } = await start({ rules: { get_state: { data: {} } } });

    await pi.request({ type: "get_state" });

    expect(await eventOf(events, "received")).toStrictEqual({
      type: "received",
      record: { type: "get_state", id: "req-1" },
    });
    expect(logsWith(logs, "pi request")).toStrictEqual([
      { level: "debug", fields: { pid: pi.pid, id: "req-1", command: "get_state" }, message: "pi request" },
    ]);
  });

  it("settles a request once and logs a second response for the same id", async () => {
    const { pi, logs } = await start({ rules: { get_state: { data: { n: 1 }, twice: true } } });

    expect(await pi.request({ type: "get_state" })).toStrictEqual({ n: 1 });
    await vi.waitFor(
      () =>
        expect(logsWith(logs, "pi response matches no waiting request")).toStrictEqual([
          {
            level: "warn",
            fields: { pid: pi.pid, id: "req-1", command: "get_state" },
            message: "pi response matches no waiting request",
          },
        ]),
      WAIT,
    );
  });

  it("releases its deadline and abort listener once a request settles, whichever way", async () => {
    const clock = new FakeClock();
    const { pi } = await start({ rules: { get_state: { data: {} }, get_session_stats: { silent: true } } }, { clock });
    const answered = new AbortController();
    const timedOut = new AbortController();

    await pi.request({ type: "get_state" }, { signal: answered.signal });
    const late = pi
      .request({ type: "get_session_stats" }, { signal: timedOut.signal })
      .catch((error: unknown) => error);
    clock.advance(30_000);

    expect(await late).toStrictEqual(new PiRequestError("get_session_stats", "timeout"));
    expect(clock.pendingTimers()).toBe(0);
    expect(getEventListeners(answered.signal, "abort")).toStrictEqual([]);
    expect(getEventListeners(timedOut.signal, "abort")).toStrictEqual([]);
  });

  it("resolves with undefined for a response without data", async () => {
    const { pi } = await start({});

    expect(await pi.request({ type: "abort" })).toBeUndefined();
  });

  it("rejects with pi's error text when a command fails", async () => {
    const { pi } = await start({ rules: { set_model: { fail: "Model not found: x/y" } } });

    const error = await pi
      .request({ type: "set_model", provider: "x", modelId: "y" })
      .catch((caught: unknown) => caught);

    expect(error).toStrictEqual(new PiRequestError("set_model", "rejected", "Model not found: x/y"));
    // pi's own text stays in `detail`, out of the message that logs and spans record.
    expect(error).toMatchObject({ name: "PiRequestError", message: "pi set_model rejected" });
    expect(new PiRequestError("get_state", "timeout", "x").message).toBe("pi get_state timeout");
  });

  it("gives up at the deadline on the injected clock and drops the late response", async () => {
    const clock = new FakeClock();
    const { pi, logs } = await start(
      { rules: { get_state: { after: "get_session_stats", data: {} }, get_session_stats: { data: {} } } },
      { clock },
    );

    const state = pi.request({ type: "get_state" }).catch((error: unknown) => error);
    clock.advance(29_999);
    const early = await Promise.race([state.then(() => "settled"), Promise.resolve("waiting")]);
    clock.advance(1);
    await pi.request({ type: "get_session_stats" });

    expect(early).toBe("waiting");
    expect(await state).toStrictEqual(new PiRequestError("get_state", "timeout"));
    await vi.waitFor(
      () =>
        expect(logs).toContainEqual({
          level: "warn",
          fields: { pid: pi.pid, id: "req-1", command: "get_state" },
          message: "pi response matches no waiting request",
        }),
      WAIT,
    );
  });

  it.each([{ type: "compact" }, { type: "bash", command: "true" }] as const)(
    "waits for $type without a deadline",
    async (command) => {
      const clock = new FakeClock();
      const { pi } = await start({ rules: { [command.type]: { silent: true } } }, { clock });

      const result = pi.request(command).catch((error: unknown) => error);
      clock.advance(24 * 60 * 60 * 1000);
      await pi.stop();

      expect(await result).toStrictEqual(new PiRequestError(command.type, "stopped"));
    },
  );

  it("lets the caller lift or shorten a deadline", async () => {
    const clock = new FakeClock();
    const { pi } = await start({ rules: { get_state: { silent: true }, compact: { silent: true } } }, { clock });

    const untimed = pi.request({ type: "get_state" }, { timeoutMs: null }).catch((error: unknown) => error);
    const timed = pi.request({ type: "compact" }, { timeoutMs: 50 }).catch((error: unknown) => error);
    clock.advance(60_000);
    await pi.stop();

    expect(await timed).toStrictEqual(new PiRequestError("compact", "timeout"));
    expect(await untimed).toStrictEqual(new PiRequestError("get_state", "stopped"));
  });

  it("aborts a request through its signal, and refuses one whose signal already aborted without sending it", async () => {
    const { pi, events } = await start({ rules: { get_state: { silent: true } } });
    const controller = new AbortController();

    const state = pi.request({ type: "get_state" }, { signal: controller.signal }).catch((error: unknown) => error);
    controller.abort();
    const refused = pi
      .request({ type: "get_session_stats" }, { signal: controller.signal })
      .catch((error: unknown) => error);

    await pi.request({ type: "get_available_models" });

    expect(await state).toStrictEqual(new PiRequestError("get_state", "aborted"));
    expect(await refused).toStrictEqual(new PiRequestError("get_session_stats", "aborted"));
    expect(
      events
        .filter((event) => event.type === ("received" as string))
        .map((event) => (event as unknown as { record: { type: string } }).record.type),
    ).toStrictEqual(["get_state", "get_available_models"]);
  });

  it("notes a response to a request its caller aborted at debug level", async () => {
    const { pi, logs } = await start({
      rules: { get_state: { after: "get_session_stats", data: {} }, get_session_stats: { data: {} } },
    });
    const controller = new AbortController();
    const state = pi.request({ type: "get_state" }, { signal: controller.signal }).catch((error: unknown) => error);
    controller.abort();

    await pi.request({ type: "get_session_stats" });

    expect(await state).toStrictEqual(new PiRequestError("get_state", "aborted"));
    await vi.waitFor(
      () =>
        expect(logsWith(logs, "pi response matches no waiting request")).toStrictEqual([
          {
            level: "debug",
            fields: { pid: pi.pid, id: "req-1", command: "get_state" },
            message: "pi response matches no waiting request",
          },
        ]),
      WAIT,
    );
  });

  it(`remembers only the last ${DROPPED_REQUESTS_KEPT} requests given up on, and warns about a response to an older one`, async () => {
    const { pi, logs } = await start({
      rules: { get_state: { after: "get_session_stats", data: {} }, get_session_stats: { data: {} } },
    });
    const controller = new AbortController();
    const states = Array.from({ length: DROPPED_REQUESTS_KEPT + 1 }, () =>
      pi.request({ type: "get_state" }, { signal: controller.signal }).catch((error: unknown) => error),
    );
    controller.abort();
    await Promise.all(states);

    await pi.request({ type: "get_session_stats" });

    await vi.waitFor(
      () => expect(logsWith(logs, "pi response matches no waiting request")).toHaveLength(DROPPED_REQUESTS_KEPT + 1),
      WAIT,
    );
    const unmatched = logsWith(logs, "pi response matches no waiting request");
    expect(unmatched.filter((log) => log.level === "warn")).toStrictEqual([
      {
        level: "warn",
        fields: { pid: pi.pid, id: "req-1", command: "get_state" },
        message: "pi response matches no waiting request",
      },
    ]);
    expect(unmatched.filter((log) => log.level === "debug")).toHaveLength(DROPPED_REQUESTS_KEPT);
  });

  it("logs a response without an id and leaves waiting requests to their deadline", async () => {
    const clock = new FakeClock();
    const { pi, logs } = await start({ rules: { get_state: { noId: true, data: {} } } }, { clock });

    const state = pi.request({ type: "get_state" }).catch((error: unknown) => error);
    await vi.waitFor(
      () =>
        expect(logs).toContainEqual({
          level: "warn",
          fields: { pid: pi.pid, id: undefined, command: "get_state" },
          message: "pi response matches no waiting request",
        }),
      WAIT,
    );
    clock.advance(30_000);

    expect(await state).toStrictEqual(new PiRequestError("get_state", "timeout"));
  });
});

describe("events", () => {
  it("passes events to every listener in order, even when one listener throws", async () => {
    const started = { type: "agent_start" };
    const settled = { type: "agent_settled" };
    const { pi, events, logs } = await start({
      rules: { prompt: { events: [started, settled], data: { disposition: "started" } } },
    });
    pi.onEvent(() => {
      throw new Error("listener bug");
    });
    const late: PiEvent[] = [];
    pi.onEvent((event) => late.push(event));

    await pi.request({ type: "prompt", message: "hi" });

    expect(typesOf(events)).toStrictEqual(["received", "agent_start", "agent_settled"]);
    expect(typesOf(late)).toStrictEqual(["received", "agent_start", "agent_settled"]);
    expect(logsWith(logs, "pi event listener threw")).toStrictEqual(
      ["received", "agent_start", "agent_settled"].map((type) => ({
        level: "error",
        fields: { pid: pi.pid, err: new Error("listener bug"), type },
        message: "pi event listener threw",
      })),
    );
  });

  it("stops calling a listener once it unsubscribes", async () => {
    const { pi } = await start({ rules: { get_state: { data: {} } } });
    const seen: PiEvent[] = [];
    const unsubscribe = pi.onEvent((event) => seen.push(event));

    unsubscribe();
    await pi.request({ type: "get_state" });

    expect(seen).toStrictEqual([]);
  });

  it("skips lines that are not JSON records, logging only their length", async () => {
    const { pi, logs } = await start({
      stdout: ["not json", "[1,2]", '{"no":"type"}', "", "null", "42", '{"type":5}'],
      rules: { get_state: { data: { ok: true } } },
    });

    expect(await pi.request({ type: "get_state" })).toStrictEqual({ ok: true });
    expect(logs.filter((log) => log.level === "warn")).toStrictEqual([
      { level: "warn", fields: { pid: pi.pid, length: 8 }, message: "pi printed a line that is not JSON" },
      { level: "warn", fields: { pid: pi.pid, length: 5 }, message: "pi printed a record without a type" },
      { level: "warn", fields: { pid: pi.pid, length: 13 }, message: "pi printed a record without a type" },
      { level: "warn", fields: { pid: pi.pid, length: 4 }, message: "pi printed a record without a type" },
      { level: "warn", fields: { pid: pi.pid, length: 2 }, message: "pi printed a record without a type" },
      { level: "warn", fields: { pid: pi.pid, length: 10 }, message: "pi printed a record without a type" },
    ]);
  });

  it("reads a last record that pi printed without a line break before exiting", async () => {
    const { pi, events } = await start({ stdoutUnterminated: '{"type":"agent_settled"}', exitCode: 0 });

    await pi.exited;

    expect(typesOf(events)).toStrictEqual(["agent_settled"]);
  });

  it("sends extension dialog answers to pi", async () => {
    const { pi, events } = await start({});

    pi.respond({ type: "extension_ui_response", id: "ui-1", confirmed: true });

    expect(await eventOf(events, "received")).toStrictEqual({
      type: "received",
      record: { type: "extension_ui_response", id: "ui-1", confirmed: true },
    });
  });
});

describe("tap", () => {
  it("sees every record written and every record printed, responses included, in order", async () => {
    const seen: [string, object][] = [];
    const tap: PiTap = {
      sent: (record) => seen.push(["sent", record]),
      received: (record) => seen.push(["received", record]),
    };
    const { pi } = await start(
      {
        stdout: ["not json"],
        rules: { prompt: { events: [{ type: "agent_settled" }], data: { disposition: "started" } } },
      },
      { tap },
    );

    await pi.request({ type: "prompt", message: "hi" });
    pi.respond({ type: "extension_ui_response", id: "ui-1", cancelled: true });
    await vi.waitFor(() => expect(seen).toHaveLength(6), WAIT);

    expect(seen).toStrictEqual([
      ["sent", { type: "prompt", message: "hi", id: "req-1" }],
      ["received", { type: "received", record: { type: "prompt", message: "hi", id: "req-1" } }],
      ["received", { type: "agent_settled" }],
      [
        "received",
        { type: "response", command: "prompt", id: "req-1", success: true, data: { disposition: "started" } },
      ],
      ["sent", { type: "extension_ui_response", id: "ui-1", cancelled: true }],
      ["received", { type: "received", record: { type: "extension_ui_response", id: "ui-1", cancelled: true } }],
    ]);
  });
});

describe("stderr", () => {
  it("logs stderr line by line and keeps only its last 8 KiB", async () => {
    const filler = `${"x".repeat(99)}\n`.repeat(100);
    const { pi, logs } = await start({ stderr: `first\n\nsecond\n${filler}last`, exitCode: 0 });

    const exit = await pi.exited;

    const lines = logs.filter((log) => log.message === "pi stderr").map((log) => log.fields["line"]);
    expect(logsWith(logs, "pi stderr")[0]).toStrictEqual({
      level: "info",
      fields: { pid: pi.pid, stream: "stderr", line: "first" },
      message: "pi stderr",
    });
    expect(lines.slice(0, 2)).toStrictEqual(["first", "second"]);
    expect(lines.at(-1)).toBe("last");
    expect(lines).toHaveLength(103);
    expect(exit.stderrTail).toHaveLength(8 * 1024);
    expect(exit.stderrTail.endsWith("x\nlast")).toBe(true);
  });
});

describe("stderr limits", () => {
  it("logs output without line breaks in bounded pieces and keeps multibyte text intact in the tail", async () => {
    // 60 small chunks, 180 KB in all: a piece is logged once 16 Ki characters have built up, not
    // per chunk. A read takes at most 64 KB, so even chunks merged under load make several pieces.
    const { pi, logs } = await start({
      stderrChunks: Array.from({ length: 60 }, () => "中".repeat(1000)),
      exitCode: 0,
    });

    const exit = await pi.exited;

    const pieces = logsWith(logs, "pi stderr").map((log) => String(log.fields["line"]));
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    expect(pieces.length).toBeLessThanOrEqual(4);
    expect(pieces.slice(0, -1).map((piece) => piece.length >= 16 * 1024)).toStrictEqual(
      pieces.slice(0, -1).map(() => true),
    );
    expect(pieces.join("")).toBe("中".repeat(60_000));
    expect(exit.stderrTail).toBe("中".repeat(8 * 1024));
  });
});

describe("environment", () => {
  it("never passes Atrium's or Electron's variables or relative PATH entries to pi", async () => {
    const { pi, events } = await start(
      { announceEnv: ["PATH", "ATRIUM_TOKEN", "ELECTRON_RUN_AS_NODE", "KEEP"] },
      { extraEnv: { PATH: ".::/usr/bin:bin:/bin", ATRIUM_TOKEN: "secret", ELECTRON_RUN_AS_NODE: "1", KEEP: "yes" } },
    );

    expect(await eventOf(events, "env")).toStrictEqual({
      type: "env",
      values: { PATH: "/usr/bin:/bin", ATRIUM_TOKEN: null, ELECTRON_RUN_AS_NODE: null, KEEP: "yes" },
    });
    void pi;
  });
});

describe("exit", () => {
  it("reports a crash with its code and stderr, and fails the requests still waiting", async () => {
    const { pi, open, logs } = await start({
      stderr: "boom\n",
      rules: { get_state: { silent: true }, abort: { exit: 3 } },
    });

    const state = pi.request({ type: "get_state" });
    const crash = pi.request({ type: "abort" });

    await expect(state).rejects.toStrictEqual(new PiRequestError("get_state", "exited", "boom\n"));
    await expect(crash).rejects.toStrictEqual(new PiRequestError("abort", "exited", "boom\n"));
    expect(await pi.exited).toStrictEqual({ code: 3, signal: null, requested: false, stderrTail: "boom\n" });
    await expect(pi.request({ type: "get_state" })).rejects.toStrictEqual(
      new PiRequestError("get_state", "exited", "boom\n"),
    );
    expect(open.get("pi-process")).toBe(0);
    expect(logsWith(logs, "pi exited")).toStrictEqual([
      { level: "warn", fields: { pid: pi.pid, code: 3, signal: null, requested: false }, message: "pi exited" },
    ]);
  });

  it("writes to a pi that already died without crashing the host, logging the broken pipe", async () => {
    const { pi, logs } = await start({ exitCode: 0 });

    const prompt = pi.request({ type: "prompt", message: "x".repeat(1024 * 1024) }).catch((error: unknown) => error);

    expect(await prompt).toMatchObject({ reason: "exited" });
    await vi.waitFor(
      () =>
        expect(logsWith(logs, "pi stdin failed")).toStrictEqual([
          {
            level: "warn",
            fields: { pid: pi.pid, err: expect.objectContaining({ code: "EPIPE" }) },
            message: "pi stdin failed",
          },
        ]),
      WAIT,
    );
  });

  it("fails waiting requests, untimed ones included, and stops pi when it stops reading stdin", async () => {
    const { pi, events, logs } = await start({ closeStdin: true, rules: { compact: { silent: true } } });
    await eventOf(events, "stdin-closed");

    const compact = await pi.request({ type: "compact" }).catch((error: unknown) => error);

    expect(compact).toMatchObject({ reason: "exited", detail: expect.stringContaining("EPIPE") });
    expect(await pi.exited).toMatchObject({ requested: true });
    expect(logsWith(logs, "pi stdin failed")).toHaveLength(1);
  });

  it.each([
    ["is missing", (dir: string) => ({ piPath: `${dir}/no-such-pi`, cwd: dir })],
    ["would work in a directory that is gone", (dir: string) => ({ piPath: process.execPath, cwd: `${dir}/gone` })],
  ])("reports a pi that cannot be started because it %s, logging no start or exit", async (_, where) => {
    const dir = await createTempDir("pi-missing");
    cleanups.push(dir.cleanup);
    const { deps, logs, open } = recordingDeps(realClock);
    const { piPath, cwd } = where(dir.path);
    const pi = startPiProcess({ piPath, args: [], cwd }, deps);
    const early = pi.request({ type: "get_state" }).catch((error: unknown) => error);

    const exit = await pi.exited;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(exit).toMatchObject({ code: null, signal: null, requested: false });
    expect(exit.spawnError).toContain("ENOENT");
    expect(await early).toMatchObject({ reason: "exited", detail: expect.stringContaining("ENOENT") });
    await expect(pi.request({ type: "get_state" })).rejects.toMatchObject({ reason: "exited" });
    expect(open.get("pi-process")).toBe(0);
    // Not run at all is not a crash (observability.md, "pi 进程").
    expect(logs.filter((log) => log.message !== "pi request")).toStrictEqual([
      {
        level: "warn",
        fields: { cwd, err: expect.objectContaining({ code: "ENOENT" }) },
        message: "pi did not start",
      },
    ]);
  });
});

describe("stop", () => {
  it("closes stdin when pi cooperates, failing waiting requests and refusing new ones", async () => {
    const { pi, open, events, logs } = await start({ rules: { get_state: { silent: true } } });
    const state = pi.request({ type: "get_state" }).catch((error: unknown) => error);
    await eventOf(events, "received");

    const stopping = pi.stop();
    const refused = pi.request({ type: "get_state" }).catch((error: unknown) => error);

    expect(pi.stop()).toBe(stopping);
    expect(await stopping).toStrictEqual({ code: 0, signal: null, requested: true, stderrTail: "" });
    expect(await state).toStrictEqual(new PiRequestError("get_state", "stopped"));
    expect(await refused).toStrictEqual(new PiRequestError("get_state", "stopped"));
    expect(open.get("pi-process")).toBe(0);
    expect(logs.filter((log) => log.level === "warn")).toStrictEqual([]);
    expect(logsWith(logs, "pi exited")).toStrictEqual([
      { level: "info", fields: { pid: pi.pid, code: 0, signal: null, requested: true }, message: "pi exited" },
    ]);
  });

  it("drops responses that arrive after stop was called, noting them only at debug level", async () => {
    const { pi, logs, events } = await start({
      rules: { get_state: { atStdinEnd: true, data: {} }, get_session_stats: { atStdinEnd: true, data: {} } },
    });
    const state = pi.request({ type: "get_state" }).catch((error: unknown) => error);
    const stats = pi.request({ type: "get_session_stats" }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(typesOf(events)).toStrictEqual(["received", "received"]), WAIT);

    await pi.stop();

    expect(await state).toStrictEqual(new PiRequestError("get_state", "stopped"));
    expect(await stats).toStrictEqual(new PiRequestError("get_session_stats", "stopped"));
    expect(logsWith(logs, "pi response matches no waiting request")).toStrictEqual([
      {
        level: "debug",
        fields: { pid: pi.pid, id: "req-1", command: "get_state" },
        message: "pi response matches no waiting request",
      },
      {
        level: "debug",
        fields: { pid: pi.pid, id: "req-2", command: "get_session_stats" },
        message: "pi response matches no waiting request",
      },
    ]);
  });

  it("still warns after stop about a response to a request given up before it, or without an id", async () => {
    const clock = new FakeClock();
    const { pi, logs, events } = await start(
      {
        rules: {
          get_state: { atStdinEnd: true, data: {} },
          get_session_stats: { atStdinEnd: true, data: {} },
          get_available_models: { atStdinEnd: true, noId: true, data: {} },
        },
      },
      { clock },
    );
    const state = pi.request({ type: "get_state" }).catch((error: unknown) => error);
    clock.advance(30_000);
    const stats = pi.request({ type: "get_session_stats" }).catch((error: unknown) => error);
    const models = pi.request({ type: "get_available_models" }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(typesOf(events)).toStrictEqual(["received", "received", "received"]), WAIT);

    await pi.stop();

    expect([await state, await stats, await models]).toStrictEqual([
      new PiRequestError("get_state", "timeout"),
      new PiRequestError("get_session_stats", "stopped"),
      new PiRequestError("get_available_models", "stopped"),
    ]);
    expect(logsWith(logs, "pi response matches no waiting request")).toStrictEqual([
      {
        level: "warn",
        fields: { pid: pi.pid, id: "req-1", command: "get_state" },
        message: "pi response matches no waiting request",
      },
      {
        level: "debug",
        fields: { pid: pi.pid, id: "req-2", command: "get_session_stats" },
        message: "pi response matches no waiting request",
      },
      {
        level: "warn",
        fields: { pid: pi.pid, id: undefined, command: "get_available_models" },
        message: "pi response matches no waiting request",
      },
    ]);
  });

  it("leaves no timer behind once pi has exited", async () => {
    const clock = new FakeClock();
    const { pi, events } = await start({ rules: { get_state: { silent: true } } }, { clock });
    const state = pi.request({ type: "get_state" }).catch((error: unknown) => error);
    await eventOf(events, "received");

    await pi.stop();

    expect(await state).toStrictEqual(new PiRequestError("get_state", "stopped"));
    expect(clock.pendingTimers()).toBe(0);
  });

  it("sends SIGTERM when pi ignores stdin closing", async () => {
    const { pi, logs } = await start({ ignoreStdinEnd: true }, { stopGraceMs: 200 });

    expect(await pi.stop()).toMatchObject({ code: null, signal: "SIGTERM", requested: true });
    expect(logs.filter((log) => log.level === "warn")).toStrictEqual([
      { level: "warn", fields: { pid: pi.pid }, message: "pi did not exit after stdin closed; sending SIGTERM" },
    ]);
  });

  it("kills the whole tree, detached grandchildren included, when pi ignores SIGTERM too", async () => {
    const { pi, events, logs } = await start(
      { ignoreStdinEnd: true, ignoreSigterm: true, grandchildren: ["detached", "attached"] },
      { stopGraceMs: 200 },
    );
    const [detached, attached] = await grandchildPids(events, 2);

    expect(await pi.stop()).toMatchObject({ code: null, signal: "SIGKILL", requested: true });
    expect(logs.filter((log) => log.level === "warn").map((log) => [log.fields, log.message])).toStrictEqual([
      [{ pid: pi.pid }, "pi did not exit after stdin closed; sending SIGTERM"],
      [{ pid: pi.pid }, "pi did not exit after SIGTERM; killing its process tree"],
    ]);
    await vi.waitFor(() => {
      expect(isAlive(present(detached, "detached"))).toBe(false);
      expect(isAlive(present(attached, "attached"))).toBe(false);
    }, WAIT);
  });

  it("kills pi alone and still resolves when killing the tree fails", async () => {
    const processSystem: ProcessSystem = {
      listProcesses: () => Promise.reject(new Error("ps is missing")),
      kill: () => undefined,
      ownPid: process.pid,
    };
    const { pi, logs, events } = await start(
      { ignoreStdinEnd: true, ignoreSigterm: true, announceArgv: true },
      { stopGraceMs: 200, processSystem },
    );
    await eventOf(events, "argv");

    expect(await pi.stop()).toMatchObject({ code: null, signal: "SIGKILL", requested: true });
    expect(logsWith(logs, "killing pi's process tree failed; killing pi alone")).toStrictEqual([
      {
        level: "error",
        fields: { pid: pi.pid, err: new Error("ps is missing") },
        message: "killing pi's process tree failed; killing pi alone",
      },
    ]);
  });

  it("resolves even when a grandchild keeps pi's pipes open after pi exits", async () => {
    const { pi, events } = await start({ grandchildren: ["holds-pipes"] });
    const [holder] = await grandchildPids(events, 1);
    cleanups.push(async () => {
      process.kill(present(holder, "holder"), "SIGKILL");
    });

    expect(await pi.stop()).toStrictEqual({ code: 0, signal: null, requested: true, stderrTail: "" });
    expect(isAlive(present(holder, "holder"))).toBe(true);
  });

  it("ignores dialog answers once stopped and stops counting the process", async () => {
    const { pi, open, logs } = await start({});
    const seen: PiEvent[] = [];

    const stopping = pi.stop();
    pi.respond({ type: "extension_ui_response", id: "ui-1", cancelled: true });
    await stopping;
    pi.onEvent((event) => seen.push(event));
    pi.respond({ type: "extension_ui_response", id: "ui-2", cancelled: true });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(seen).toStrictEqual([]);
    expect(open.get("pi-process")).toBe(0);
    expect(logsWith(logs, "pi stdin failed")).toStrictEqual([]);
  });
});
