import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type TestHost, startTestHost } from "./harness";

const ORIGIN_REJECTED = "websocket upgrade rejected: origin not allowed";

/**
 * Makes the host write one warn: a browser from a foreign origin knocks.
 *
 * @remarks
 * A real path to a real warn (ws-server.ts), so the gate is tested on what the host writes.
 *
 * @sideEffects Opens a socket to the host, which refuses it and logs a warn.
 * @param testHost - The host.
 */
async function knockFromForeignOrigin(testHost: TestHost): Promise<void> {
  const socket = new WebSocket(testHost.url, { origin: "https://evil.example" });
  await new Promise<void>((done) => socket.once("unexpected-response", () => done()));
}

/**
 * Whether a path still exists.
 *
 * @remarks
 * The gate must not keep a test's home behind when it fails.
 *
 * @sideEffects Reads the file system.
 * @param path - The path.
 * @returns Whether it exists.
 */
async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

describe("the test host's log gate", () => {
  it("fails dispose on a warn the test did not declare, naming only its level and msg, and still deletes the home", async () => {
    const testHost = await startTestHost();
    const home = dirname(dirname(testHost.host.logFile));
    await knockFromForeignOrigin(testHost);

    const failure = await testHost.dispose().then(
      () => null,
      (error: unknown) => String(error),
    );

    expect(failure).toBe(
      `Error: the host log has records the test did not declare:\n  unexpected warn "${ORIGIN_REJECTED}" × 1`,
    );
    expect(await exists(home)).toBe(false);
  });

  it("passes dispose when the test declared the warn", async () => {
    const testHost = await startTestHost();
    testHost.expectLog({ level: "warn", msg: ORIGIN_REJECTED, times: 1 });
    await knockFromForeignOrigin(testHost);

    await expect(testHost.dispose()).resolves.toBeUndefined();
  });

  it("fails dispose when a declared record never came", async () => {
    const testHost = await startTestHost();
    testHost.expectLog({ level: "warn", msg: ORIGIN_REJECTED });

    await expect(testHost.dispose()).rejects.toThrow(
      `the host log has records the test did not declare:\n  expected warn "${ORIGIN_REJECTED}" at least once, saw 0`,
    );
  });

  it("checks once however often it is disposed", async () => {
    const testHost = await startTestHost();
    await knockFromForeignOrigin(testHost);
    const first = testHost.dispose();

    expect(testHost.dispose()).toBe(first);
    await expect(first).rejects.toThrow(ORIGIN_REJECTED);
  });
});
