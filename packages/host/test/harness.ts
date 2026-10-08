import { type AtriumClient, createAtriumClient } from "@atrium/client";
import { createTempDir } from "@atrium/testkit";
import { readFile } from "node:fs/promises";
import { type HostConfig, type RunningHost, startHost } from "../src/main";

/** A real host started in this process for one test. */
export interface TestHost {
  readonly host: RunningHost;
  readonly token: string;
  /** WebSocket URL of the host. */
  readonly url: string;
  /** Creates a client connection, optionally with a different token. */
  readonly connect: (options?: { token?: string }) => AtriumClient;
  /** Reads every record written to the host log so far. */
  readonly readLog: () => Promise<Array<Record<string, unknown>>>;
  /** Stops the host and deletes its home directory. */
  readonly dispose: () => Promise<void>;
}

/**
 * Starts a real host with its own temporary home directory.
 *
 * @remarks
 * Layer 4 tests drive the host through the real `client` package and a real socket
 * (testing.md, "分层"). The harness lives in the host package, not in testkit, so testkit does
 * not depend on the host (overview.md, "包之间的依赖").
 *
 * @sideEffects Creates a temp directory; starts a host listening on a free port.
 * @param overrides - Config fields to change, such as a fake clock.
 * @returns The running host and helpers.
 */
export async function startTestHost(overrides: Partial<HostConfig> = {}): Promise<TestHost> {
  const home = await createTempDir("host");
  const token = "test-token-0123456789abcdefghijklmnopqrstuvwxyz";
  // An empty PATH finds no pi, so no shell or `pi --version` runs unless a test asks for it.
  const host = await startHost({ home: home.path, token, logLevel: "debug", toolEnv: { PATH: "" }, ...overrides });
  const url = `ws://127.0.0.1:${host.port}`;
  let clientCount = 0;
  return {
    host,
    token,
    url,
    connect: (options = {}) =>
      // No reconnecting: a test decides itself when a client comes back.
      createAtriumClient({
        url,
        token: options.token ?? token,
        clientId: `test-client-${++clientCount}`,
        reconnectDelaysMs: [],
      }),
    readLog: async () => {
      await host.flushLog();
      return (await readFile(host.logFile, "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    dispose: async () => {
      await host.close();
      await home.cleanup();
    },
  };
}
