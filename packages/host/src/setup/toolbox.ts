import type { NodeInspection, PiInspection } from "@atrium/pi";
import type { ToolEnv } from "../platform/login-shell";

/** The tools the host found. */
export interface HostTools {
  /** Environment for pi and the tools it runs; its PATH is where pi was looked for. */
  readonly env: Readonly<Record<string, string>>;
  /** Where `env` came from: the login shell, the host's own environment, or `HostConfig.toolEnv`. */
  readonly envSource: ToolEnv["source"] | "configured";
  readonly pi: PiInspection;
  /** The Node pi and the login program run on. */
  readonly node: NodeInspection;
  /** Homebrew, which installs Node; `null` when there is none. */
  readonly homebrew: string | null;
  /** The `fd` that `@` searches with; `null` when there is none. */
  readonly fd: string | null;
}

/** The host's tools: found once after starting, and again on request. */
export interface Toolbox {
  /** Starts the first detection; call once, after the server listens. */
  start(): void;
  /** The latest detection, settled or under way; `null` when it failed or the host closed first. */
  current(): Promise<HostTools | null>;
  /** Detects again, after any detection under way; calls while one runs share it. */
  refresh(): Promise<HostTools | null>;
  /** Stops detecting and waits for any detection under way. */
  close(): Promise<void>;
}

/**
 * Creates the toolbox around a detection.
 *
 * @remarks
 * Installing pi or Node may change the shell's configuration, so first launch asks to read the
 * login shell again (`check_setup(refresh)`, SPEC-0001, "首次启动 · 接口"). Everything that needs
 * the tools asks for the current ones each time, so a pi started after a refresh uses what the
 * refresh found; while one runs, they wait for it. A refresh that finds nothing (it was stopped
 * or failed unexpectedly) keeps what was found before. `detect` must not reject. Closing before
 * starting settles the first detection with `null`.
 *
 * @sideEffects none until started; then runs `detect`.
 * @param detect - Finds the tools; stops early when its signal aborts.
 * @returns The toolbox.
 */
export function createToolbox(detect: (signal: AbortSignal) => Promise<HostTools | null>): Toolbox {
  const stop = new AbortController();
  const first = Promise.withResolvers<HostTools | null>();
  let latest = first.promise;
  let refreshing: Promise<HostTools | null> | undefined;
  return {
    start: () => first.resolve(detect(stop.signal)),
    current: () => latest,
    refresh: () => {
      if (refreshing !== undefined) return refreshing;
      const previous = latest;
      const running = (async () => {
        const before = await previous;
        if (stop.signal.aborted) return before;
        return (await detect(stop.signal)) ?? before;
      })();
      refreshing = running;
      latest = running;
      void running.finally(() => {
        refreshing = undefined;
      });
      return running;
    },
    close: async () => {
      stop.abort();
      // Never started: nothing was found.
      first.resolve(null);
      await latest;
    },
  };
}
