import { describe, expect, it } from "vitest";
import type { ProxySetting } from "@atrium/protocol";
import { type HostTools, createToolbox, withProxySetting } from "./toolbox";

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

describe("withProxySetting", () => {
  it("puts the proxy set at each ask into the tools' environment, and leaves it out when none is", async () => {
    const detection = scriptedDetection();
    let setting: ProxySetting | null = { url: "http://127.0.0.1:7897", noProxy: [] };
    const proxied = withProxySetting(createToolbox(detection.detect), () => setting);
    proxied.start();
    detection.calls[0]?.resolve(tools("/bin"));

    const first = await proxied.current();
    setting = null;
    const second = await proxied.current();
    setting = { url: "http://proxy.test:8080", noProxy: [".example.com"] };
    const refreshed = proxied.refresh();
    await settle();
    detection.calls[1]?.resolve(tools("/usr/bin"));

    expect(first).toStrictEqual({
      ...tools("/bin"),
      env: { PATH: "/bin", ...proxyVariables("http://127.0.0.1:7897", "") },
    });
    expect(second).toStrictEqual(tools("/bin"));
    expect(await refreshed).toStrictEqual({
      ...tools("/usr/bin"),
      env: { PATH: "/usr/bin", ...proxyVariables("http://proxy.test:8080", ",.example.com") },
    });
  });

  it("finds no tools where the toolbox found none, and closes it", async () => {
    const detection = scriptedDetection();
    const proxied = withProxySetting(createToolbox(detection.detect), () => ({
      url: "http://127.0.0.1:7897",
      noProxy: [],
    }));
    proxied.start();
    detection.calls[0]?.resolve(null);

    expect(await proxied.current()).toBeNull();
    const closing = proxied.close();
    await closing;
    expect(detection.calls[0]?.signal.aborted).toBe(true);
  });
});

/**
 * The proxy variables a setting puts in the environment.
 *
 * @remarks
 * This machine's hosts always go direct.
 *
 * @sideEffects none
 * @param url - The proxy.
 * @param more - What follows this machine's hosts in `NO_PROXY`.
 * @returns The variables.
 */
function proxyVariables(url: string, more: string): Record<string, string> {
  const noProxy = `localhost,127.0.0.1,::1${more}`;
  return {
    HTTPS_PROXY: url,
    https_proxy: url,
    HTTP_PROXY: url,
    http_proxy: url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}
