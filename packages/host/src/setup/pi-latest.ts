import type { PiLatest, PiLatestEvent } from "@atrium/protocol";
import { type Clock, trackedTimeout } from "../platform/clock";
import type { Logger } from "../platform/logger";
import type { ResourceTracker } from "../platform/resources";
import { readLimited } from "./install-script";

/** Where pi itself looks for its latest version (pi-internals §4, "新版本检查"). */
export const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";

/** How long a look-up may take, as pi allows. */
const TIMEOUT_MS = 10_000;

/** The largest answer accepted; pi.dev's is under 100 bytes. */
const MAX_BYTES = 64 * 1024;

/** How often the host looks (SPEC-0001, "设置 · 接口"). */
const INTERVAL_MS = 24 * 60 * 60 * 1000;

/** A released version, as pi accepts it. */
const RELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Why the latest pi could not be found.
 *
 * @remarks
 * Only the reason is logged; the last version found stays (SPEC-0001, "设置 · 接口").
 *
 * @sideEffects none
 */
export class LatestError extends Error {
  /**
   * Creates the error.
   *
   * @remarks
   * See {@link LatestError}.
   *
   * @sideEffects none
   * @param reason - What went wrong.
   */
  constructor(readonly reason: "network" | "status" | "invalid" | "too_large" | "timeout" | "aborted") {
    super(`latest pi not found: ${reason}`);
    this.name = "LatestError";
  }
}

/**
 * Looks up the latest pi, as pi itself does.
 *
 * @remarks
 * The answer is JSON with a `version`, trimmed; anything else counts as not found (pi-internals
 * §4, "新版本检查"). Moves are not followed. Limited to 10 seconds and 64 KiB.
 *
 * @sideEffects Makes an HTTP request.
 * @param url - Where, normally {@link LATEST_VERSION_URL}.
 * @param options - The signal that cancels, the clock, and the time limit.
 * @returns The version.
 * @throws {LatestError} When it cannot be found, or the signal aborts.
 */
export async function fetchLatestPi(
  url: string,
  options: { readonly signal: AbortSignal; readonly clock: Clock; readonly timeoutMs?: number },
): Promise<string> {
  const deadline = new AbortController();
  const stopTimer = options.clock.setTimeout(() => deadline.abort(), options.timeoutMs ?? TIMEOUT_MS);
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  try {
    let response: Response;
    let body: string | null;
    try {
      response = await fetch(url, { headers: { accept: "application/json" }, redirect: "manual", signal });
      body = response.ok ? await readLimited(response, MAX_BYTES) : null;
    } catch {
      if (options.signal.aborted) throw new LatestError("aborted");
      throw new LatestError(deadline.signal.aborted ? "timeout" : "network");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new LatestError("status");
    }
    if (body === null) throw new LatestError("too_large");
    return versionIn(body);
  } finally {
    stopTimer();
  }
}

/**
 * The version in pi.dev's answer.
 *
 * @remarks
 * See {@link fetchLatestPi}.
 *
 * @sideEffects none
 * @param body - The answer.
 * @returns The version.
 * @throws {LatestError} `invalid` when there is none.
 */
function versionIn(body: string): string {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new LatestError("invalid");
  }
  const version: unknown = typeof data === "object" && data !== null ? Reflect.get(data, "version") : undefined;
  const trimmed = typeof version === "string" ? version.trim() : "";
  if (!RELEASE.test(trimmed)) throw new LatestError("invalid");
  return trimmed;
}

/** The latest pi, looked up once started and then every day. */
export interface PiLatestService {
  /** Looks now and then every day; call once. */
  start(): void;
  /** The latest pi found so far. */
  current(): PiLatest;
  /** Looks now, sharing a look under way; resolves with what is known after it. */
  check(): Promise<PiLatest>;
  /** Stops a look under way and looks no more. */
  close(): Promise<void>;
}

/**
 * Creates the latest-pi service.
 *
 * @remarks
 * The settings show the latest pi and when it was found, and a blue dot when it is newer
 * (SPEC-0001, "设置 · 接口"). Each look that finds it goes to every connection; one that finds
 * nothing keeps the last found and logs only why. Nothing is looked up while pi's environment has
 * `PI_OFFLINE`, as pi does.
 *
 * @sideEffects none until started; then looks up the latest pi on a timer, broadcasts and logs.
 * @param options - How to look up, whether pi is to stay offline, the clock, the resource counts,
 * how to reach every connection, and the logger.
 * @returns The service.
 */
export function createPiLatest(options: {
  readonly lookup: (signal: AbortSignal) => Promise<string>;
  readonly offline: () => Promise<boolean>;
  readonly clock: Clock;
  readonly resources: ResourceTracker;
  readonly broadcast: (event: PiLatestEvent) => void;
  readonly logger: Logger;
}): PiLatestService {
  let found: PiLatest = { latest: null, checkedAt: null };
  let checking: Promise<PiLatest> | null = null;
  let closed = false;
  let stopTimer: (() => void) | null = null;
  const stop = new AbortController();

  /**
   * Looks up the latest pi once.
   *
   * @remarks
   * See {@link createPiLatest}.
   *
   * @sideEffects Makes a request; broadcasts and logs.
   * @returns What is known after it.
   */
  async function look(): Promise<PiLatest> {
    try {
      if (await options.offline()) return found;
      const latest = await options.lookup(stop.signal);
      found = { latest, checkedAt: options.clock.now() };
      options.logger.info({ latest }, "pi update checked");
      options.broadcast({ type: "pi_latest", ...found });
    } catch (error) {
      if (!stop.signal.aborted) {
        const reason = error instanceof LatestError ? error.reason : "unknown";
        options.logger.info({ reason }, "pi update check failed");
      }
    }
    return found;
  }

  /**
   * Looks up the latest pi, sharing a look under way.
   *
   * @remarks
   * See {@link PiLatestService.check}.
   *
   * @sideEffects As {@link look}.
   * @returns What is known after it.
   */
  function check(): Promise<PiLatest> {
    if (checking !== null) return checking;
    const looking = look().finally(() => {
      checking = null;
    });
    checking = looking;
    return looking;
  }

  /**
   * Looks, then schedules the next look a day later.
   *
   * @remarks
   * See {@link createPiLatest}. Never rejects: a look that fails only logs.
   *
   * @sideEffects As {@link look}; sets a timer.
   */
  async function every(): Promise<void> {
    await check();
    if (!closed) stopTimer = trackedTimeout(options.clock, options.resources, () => void every(), INTERVAL_MS);
  }

  return {
    start: () => void every(),
    current: () => found,
    check,
    async close() {
      closed = true;
      stopTimer?.();
      stop.abort();
      await checking;
    },
  };
}
