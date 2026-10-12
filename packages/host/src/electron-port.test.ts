import { describe, expect, it, vi } from "vitest";
import {
  type AppProcessMetrics,
  type ElectronRuntime,
  type HostStartRequest,
  type ParentPort,
  runUnderElectron,
} from "./electron-port";

const TOKEN = "a".repeat(43);

/** A parent port the test can send through, recording what the host posts back. */
function fakePort() {
  let listener: ((event: { data: unknown }) => void) | undefined;
  const posted: unknown[] = [];
  const port: ParentPort = {
    on: (event, handler) => {
      // Like Electron, deliver only to `message` listeners.
      if (event === "message") listener = handler;
    },
    postMessage: (message) => posted.push(message),
  };
  return { port, posted, send: (data: unknown) => listener?.({ data }) };
}

/** A runtime whose host start the test finishes by hand. */
function controlledRuntime() {
  const started: HostStartRequest[] = [];
  const exits: number[] = [];
  const closes: string[] = [];
  const metrics: (readonly AppProcessMetrics[])[] = [];
  const pending = Promise.withResolvers<Awaited<ReturnType<ElectronRuntime["start"]>>>();
  const runtime: ElectronRuntime = {
    start: (request) => {
      started.push(request);
      return pending.promise;
    },
    exit: (code) => exits.push(code),
  };
  const host = {
    port: 4321,
    close: () => Promise.resolve(void closes.push("closed")),
    recordAppMetrics: (processes: readonly AppProcessMetrics[]) => void metrics.push(processes),
  };
  return {
    runtime,
    started,
    exits,
    closes,
    metrics,
    finishStart: () => pending.resolve(host),
    failStart: pending.reject,
  };
}

/** Lets queued promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("runUnderElectron", () => {
  it("starts the host from a valid config and reports the port", async () => {
    const { port, posted, send } = fakePort();
    const { runtime, started, finishStart, exits } = controlledRuntime();
    runUnderElectron(port, runtime);

    send({ type: "config", token: TOKEN, uiDir: "/ui", extraOrigins: ["http://localhost:5791"] });
    finishStart();
    await settle();

    expect(started).toStrictEqual([
      { type: "config", token: TOKEN, uiDir: "/ui", extraOrigins: ["http://localhost:5791"] },
    ]);
    expect(posted).toStrictEqual([{ type: "ready", port: 4321 }]);
    expect(exits).toStrictEqual([]);
  });

  it("does not report ready or take app metrics, and closes the host, when shutdown arrives while it is still starting", async () => {
    const { port, posted, send } = fakePort();
    const { runtime, finishStart, exits, closes, metrics } = controlledRuntime();
    runUnderElectron(port, runtime);

    send({ type: "config", token: TOKEN });
    send({ type: "shutdown" });
    await settle();
    expect(exits).toStrictEqual([]);
    finishStart();
    await vi.waitFor(() => expect(exits).toStrictEqual([0]));
    send({ type: "app_metrics", processes: [] });

    expect(posted).toStrictEqual([]);
    expect(closes).toStrictEqual(["closed"]);
    expect(metrics).toStrictEqual([]);
  });

  it("closes a running host on shutdown and exits with 0, once", async () => {
    const { port, send } = fakePort();
    const { runtime, finishStart, exits, closes } = controlledRuntime();
    runUnderElectron(port, runtime);

    send({ type: "config", token: TOKEN });
    finishStart();
    await settle();
    send({ type: "shutdown" });
    send({ type: "shutdown" });
    await vi.waitFor(() => expect(exits).toStrictEqual([0]));

    expect(closes).toStrictEqual(["closed"]);
  });

  it("exits with 0 on a shutdown before any config", async () => {
    const { port, send } = fakePort();
    const { runtime, exits, started } = controlledRuntime();
    runUnderElectron(port, runtime);

    send({ type: "shutdown" });
    await vi.waitFor(() => expect(exits).toStrictEqual([0]));

    expect(started).toStrictEqual([]);
  });

  it("reports a failed start and exits with 1", async () => {
    const { port, posted, send } = fakePort();
    const { runtime, failStart, exits } = controlledRuntime();
    runUnderElectron(port, runtime);

    send({ type: "config", token: TOKEN });
    failStart(new Error("port taken"));
    await vi.waitFor(() => expect(exits).toStrictEqual([1]));

    expect(posted).toStrictEqual([{ type: "failed", message: "port taken" }]);
  });

  it("reports a non-Error failure as text", async () => {
    const { port, posted, send } = fakePort();
    const { runtime, failStart, exits } = controlledRuntime();
    runUnderElectron(port, runtime);

    send({ type: "config", token: TOKEN });
    failStart("boom");
    await vi.waitFor(() => expect(exits).toStrictEqual([1]));

    expect(posted).toStrictEqual([{ type: "failed", message: "boom" }]);
  });

  it("refuses a config with a weak token without starting anything", () => {
    const { port, posted, send } = fakePort();
    const { runtime, started, exits } = controlledRuntime();
    runUnderElectron(port, runtime);

    send({ type: "config", token: "short" });

    expect(started).toStrictEqual([]);
    expect(posted).toStrictEqual([{ type: "failed", message: "invalid config message" }]);
    expect(exits).toStrictEqual([1]);
  });

  it("starts only once and ignores unrelated messages", async () => {
    const { port, posted, send } = fakePort();
    const { runtime, started, finishStart, exits } = controlledRuntime();
    runUnderElectron(port, runtime);

    send({ type: "config", token: TOKEN });
    send({ type: "config", token: TOKEN });
    send({ type: "hello" });
    send("not an object");
    finishStart();
    await settle();

    expect(started).toHaveLength(1);
    expect(posted).toStrictEqual([{ type: "ready", port: 4321 }]);
    expect(exits).toStrictEqual([]);
  });

  it("hands app metrics to the running host", async () => {
    const { port, send } = fakePort();
    const { runtime, finishStart, metrics } = controlledRuntime();
    runUnderElectron(port, runtime);
    send({ type: "config", token: TOKEN });
    finishStart();
    await settle();

    send({
      type: "app_metrics",
      processes: [
        { type: "Browser", memoryKb: 120_000, cpuPercent: 1.5 },
        { type: "Utility", memoryKb: 80_000, cpuPercent: 0 },
      ],
    });

    expect(metrics).toStrictEqual([
      [
        { type: "Browser", memoryKb: 120_000, cpuPercent: 1.5 },
        { type: "Utility", memoryKb: 80_000, cpuPercent: 0 },
      ],
    ]);
  });

  it("drops app metrics that arrive before the host is ready or after shutdown", async () => {
    const { port, send } = fakePort();
    const { runtime, finishStart, metrics, exits } = controlledRuntime();
    runUnderElectron(port, runtime);
    const sample = { type: "app_metrics", processes: [{ type: "GPU", memoryKb: 1, cpuPercent: 0 }] };

    send(sample);
    send({ type: "config", token: TOKEN });
    send(sample);
    finishStart();
    await settle();
    send({ type: "shutdown" });
    send(sample);
    await vi.waitFor(() => expect(exits).toStrictEqual([0]));

    expect(metrics).toStrictEqual([]);
  });

  it("drops malformed app metrics without stopping", async () => {
    const { port, posted, send } = fakePort();
    const { runtime, finishStart, metrics, exits } = controlledRuntime();
    runUnderElectron(port, runtime);
    send({ type: "config", token: TOKEN });
    finishStart();
    await settle();

    send({ type: "app_metrics", processes: [{ type: "GPU", memoryKb: -1, cpuPercent: 0 }] });
    send({ type: "app_metrics", processes: [{ type: "GPU", memoryKb: 1.5, cpuPercent: 0 }] });
    send({ type: "app_metrics", processes: [{ type: "GPU", memoryKb: 1, cpuPercent: -0.1 }] });
    send({ type: "app_metrics", processes: [{ type: "x".repeat(65), memoryKb: 1, cpuPercent: 0 }] });
    send({
      type: "app_metrics",
      processes: Array.from({ length: 257 }, () => ({ type: "Tab", memoryKb: 1, cpuPercent: 0 })),
    });
    send({ type: "app_metrics" });

    expect(metrics).toStrictEqual([]);
    expect(posted).toStrictEqual([{ type: "ready", port: 4321 }]);
    expect(exits).toStrictEqual([]);
  });

  it("accepts app metrics at the limits", async () => {
    const { port, send } = fakePort();
    const { runtime, finishStart, metrics } = controlledRuntime();
    runUnderElectron(port, runtime);
    send({ type: "config", token: TOKEN });
    finishStart();
    await settle();
    const processes = Array.from({ length: 256 }, () => ({ type: "x".repeat(64), memoryKb: 0, cpuPercent: 0 }));

    send({ type: "app_metrics", processes });
    send({ type: "app_metrics", processes: [] });

    expect(metrics).toStrictEqual([processes, []]);
  });
});
