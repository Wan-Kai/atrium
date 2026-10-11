import { describe, expect, it } from "vitest";
import { type HostTools, createToolbox } from "./toolbox";

/**
 * Tools that differ only in their PATH.
 *
 * @remarks
 * Enough to tell one detection from another.
 *
 * @sideEffects none
 * @param path - The PATH.
 * @returns The tools.
 */
function tools(path: string): HostTools {
  return {
    env: { PATH: path },
    envSource: "configured",
    pi: { status: "missing" },
    node: { status: "missing" },
    homebrew: null,
    fd: null,
  };
}

/**
 * A detection the test settles by hand.
 *
 * @remarks
 * Each call waits until the test answers it, so the test sees which calls overlap.
 *
 * @sideEffects none
 * @returns The detection, its calls so far with their signals, and the answer to the oldest open call.
 */
function scriptedDetection() {
  const calls: { signal: AbortSignal; resolve: (found: HostTools | null) => void }[] = [];
  return {
    calls,
    detect: (signal: AbortSignal) => {
      const { promise, resolve } = Promise.withResolvers<HostTools | null>();
      calls.push({ signal, resolve });
      return promise;
    },
  };
}

/**
 * Lets pending promise callbacks run.
 *
 * @remarks
 * The toolbox chains a few promises before calling the detection again.
 *
 * @sideEffects none
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe("Toolbox", () => {
  it("detects nothing until started, and gives the first detection to those who asked before", async () => {
    const detection = scriptedDetection();
    const toolbox = createToolbox(detection.detect);
    const asked = toolbox.current();
    await settle();
    const before = detection.calls.length;

    toolbox.start();
    detection.calls[0]?.resolve(tools("/first"));

    expect(before).toBe(0);
    expect(await asked).toStrictEqual(tools("/first"));
    expect(await toolbox.current()).toStrictEqual(tools("/first"));
  });

  it("detects again on refresh, after the detection under way, and gives what it found from then on", async () => {
    const detection = scriptedDetection();
    const toolbox = createToolbox(detection.detect);
    toolbox.start();

    const refreshed = toolbox.refresh();
    await settle();
    const whileFirstRuns = detection.calls.length;
    detection.calls[0]?.resolve(tools("/first"));
    await settle();
    const current = toolbox.current();
    detection.calls[1]?.resolve(tools("/second"));

    expect(whileFirstRuns).toBe(1);
    expect(await refreshed).toStrictEqual(tools("/second"));
    expect(await current).toStrictEqual(tools("/second"));
    expect(await toolbox.current()).toStrictEqual(tools("/second"));
  });

  it("shares one detection among refreshes asked while it runs, and runs a new one afterwards", async () => {
    const detection = scriptedDetection();
    const toolbox = createToolbox(detection.detect);
    toolbox.start();
    detection.calls[0]?.resolve(tools("/first"));

    const one = toolbox.refresh();
    const two = toolbox.refresh();
    await settle();
    detection.calls[1]?.resolve(tools("/second"));
    await one;
    const three = toolbox.refresh();
    await settle();
    detection.calls[2]?.resolve(tools("/third"));

    expect(two).toBe(one);
    expect(await one).toStrictEqual(tools("/second"));
    expect(await three).toStrictEqual(tools("/third"));
    expect(detection.calls).toHaveLength(3);
  });

  it("keeps what it found when a refresh finds nothing", async () => {
    const detection = scriptedDetection();
    const toolbox = createToolbox(detection.detect);
    toolbox.start();
    detection.calls[0]?.resolve(tools("/first"));

    const refreshed = toolbox.refresh();
    await settle();
    detection.calls[1]?.resolve(null);

    expect(await refreshed).toStrictEqual(tools("/first"));
    expect(await toolbox.current()).toStrictEqual(tools("/first"));
  });

  it("stops the detection under way on close and waits for it, and detects no more", async () => {
    const detection = scriptedDetection();
    const toolbox = createToolbox(detection.detect);
    toolbox.start();
    detection.calls[0]?.resolve(tools("/first"));
    const refreshed = toolbox.refresh();
    await settle();
    const closing = toolbox.close();
    const closedEarly = await Promise.race([closing.then(() => true), settle().then(() => false)]);

    detection.calls[1]?.resolve(null);
    await closing;

    expect(detection.calls.map((call) => call.signal.aborted)).toStrictEqual([true, true]);
    expect(closedEarly).toBe(false);
    expect(await refreshed).toStrictEqual(tools("/first"));
    expect(await toolbox.refresh()).toStrictEqual(tools("/first"));
    expect(detection.calls).toHaveLength(2);
  });

  it("finds nothing when closed before it started", async () => {
    const detection = scriptedDetection();
    const toolbox = createToolbox(detection.detect);

    await toolbox.close();

    expect(await toolbox.current()).toBeNull();
    expect(detection.calls).toHaveLength(0);
  });
});
