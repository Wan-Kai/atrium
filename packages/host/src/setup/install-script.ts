import type { Clock } from "../platform/clock";

/** pi's official install script (SPEC-0001, "首次启动 · 第 1 步"). */
export const INSTALL_SCRIPT_URL = "https://pi.dev/install.sh";

/** How long the download may take. */
const TIMEOUT_MS = 30_000;

/** The largest script accepted; the official one is about 30 KiB. */
const MAX_BYTES = 1024 * 1024;

/** How many moves on the same server are followed. */
const MAX_REDIRECTS = 5;

/**
 * Why the install script could not be downloaded.
 *
 * @remarks
 * Only the reason is logged; the job fails with `download_failed` (SPEC-0001, "首次启动 · 接口").
 *
 * @sideEffects none
 */
export class DownloadError extends Error {
  /**
   * Creates the error.
   *
   * @remarks
   * The address stays out of the message, like everything a job does.
   *
   * @sideEffects none
   * @param reason - What went wrong.
   */
  constructor(readonly reason: "network" | "status" | "redirect" | "too_large" | "timeout" | "aborted") {
    super(`install script download failed: ${reason}`);
    this.name = "DownloadError";
  }
}

/**
 * Downloads the install script.
 *
 * @remarks
 * The address is fixed, so the script only comes from there: a move to another server, or more
 * than five moves, fails, and since the origin includes the scheme the script stays on `https`
 * (SPEC-0001, "首次启动 · 接口"). The download is limited to 30 seconds and 1 MiB.
 *
 * @sideEffects Makes HTTP requests.
 * @param url - The script's address, normally {@link INSTALL_SCRIPT_URL}.
 * @param options - The signal that cancels, the clock, and the time limit.
 * @returns The script.
 * @throws {DownloadError} When the script cannot be downloaded, or the signal aborts.
 */
export async function downloadScript(
  url: string,
  options: { readonly signal: AbortSignal; readonly clock: Clock; readonly timeoutMs?: number },
): Promise<string> {
  const deadline = new AbortController();
  const stopTimer = options.clock.setTimeout(() => deadline.abort(), options.timeoutMs ?? TIMEOUT_MS);
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  try {
    return await follow(new URL(url), signal);
  } catch (error) {
    if (options.signal.aborted) throw new DownloadError("aborted");
    if (deadline.signal.aborted) throw new DownloadError("timeout");
    throw error;
  } finally {
    stopTimer();
  }
}

/**
 * Fetches the script, following moves that stay on the same origin.
 *
 * @remarks
 * See {@link downloadScript}.
 *
 * @sideEffects Makes HTTP requests.
 * @param start - The first address.
 * @param signal - Aborts the requests.
 * @returns The script.
 * @throws {DownloadError} When the script cannot be downloaded; an abort is passed on as it is.
 */
async function follow(start: URL, signal: AbortSignal): Promise<string> {
  let url = start;
  for (let moves = 0; moves <= MAX_REDIRECTS; moves += 1) {
    let response: Response;
    try {
      response = await fetch(url, { redirect: "manual", signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new DownloadError("network");
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel();
      url = new URL(location, url);
      if (url.origin !== start.origin) throw new DownloadError("redirect");
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new DownloadError("status");
    }
    return readLimited(response);
  }
  throw new DownloadError("redirect");
}

/**
 * Reads a response's body as UTF-8, up to the size limit.
 *
 * @remarks
 * Reads as it arrives, so a huge body is cut off rather than held in memory.
 *
 * @sideEffects Reads the body.
 * @param response - The response.
 * @returns The body.
 * @throws {DownloadError} `too_large` past the limit.
 */
async function readLimited(response: Response): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body !== null) {
    // Leaving the loop early cancels the body.
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      // Stryker disable next-line ConditionalExpression,EqualityOperator: stopping early only saves reading the rest; the size is checked after the loop.
      if (size > MAX_BYTES) break;
      chunks.push(chunk);
    }
  }
  if (size > MAX_BYTES) throw new DownloadError("too_large");
  return Buffer.concat(chunks).toString("utf8");
}
