import { type AtriumClient, createAtriumClient } from "@atrium/client";
import { type ExpectedLog, createTempDir, findLogProblems, readLogRecords } from "@atrium/testkit";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getHeapSpaceStatistics } from "node:v8";
import { expect, vi } from "vitest";
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
  /** Declares a warn, error or fatal record the test's scenario writes on purpose. */
  readonly expectLog: (expected: ExpectedLog) => void;
  /**
   * Stops the host, deletes its home directory, and fails when the log has a warn, error or fatal
   * record the test did not declare. Calling it again returns the same promise.
   */
  readonly dispose: () => Promise<void>;
}

/**
 * Starts a real host with its own temporary home directory.
 *
 * @remarks
 * Layer 4 tests drive the host through the real `client` package and a real socket
 * (testing.md, "分层"). The harness lives in the host package, not in testkit, so testkit does
 * not depend on the host (overview.md, "包之间的依赖"). Disposing it checks the log against what the
 * test declared with `expectLog` (testing.md, "日志门禁"), after the home is gone, so a failing
 * check leaves nothing behind.
 *
 * @sideEffects Creates a temp directory; starts a host listening on a free port. Disposing stops
 * the host, reads its log and deletes the directory.
 * @param overrides - Config fields to change, such as a fake clock.
 * @returns The running host and helpers.
 */
export async function startTestHost(overrides: Partial<HostConfig> = {}): Promise<TestHost> {
  const home = await createTempDir("host");
  const token = "test-token-0123456789abcdefghijklmnopqrstuvwxyz";
  // An empty PATH finds no pi, so no shell or `pi --version` runs unless a test asks for it.
  const host = await startHost({
    home: home.path,
    token,
    logLevel: "debug",
    toolEnv: { PATH: "" },
    homebrewPlaces: [],
    // Tests never reach pi.dev.
    piLatestUrl: null,
    ...overrides,
  });
  const url = `ws://127.0.0.1:${host.port}`;
  let clientCount = 0;
  const expected: ExpectedLog[] = [];
  let disposed: Promise<void> | undefined;
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
    expectLog: (log) => {
      expected.push(log);
    },
    dispose: () => {
      disposed ??= (async () => {
        await host.close();
        const records = await readLogRecords(dirname(host.logFile));
        await home.cleanup();
        const problems = findLogProblems(records, expected);
        if (problems.length > 0) {
          throw new Error(`the host log has records the test did not declare:\n  ${problems.join("\n  ")}`);
        }
      })();
      return disposed;
    },
  };
}

/**
 * Waits for what a host does on its own once it is up, and gives its resource counts then.
 *
 * @remarks
 * The host finds the tools, then runs git's version check for merge states (`main.ts`), each
 * counted while it runs, and the counts it comes back to once idle are those after both. A
 * baseline taken sooner holds `tools.detect: 1` and fails a soak that ends idle (self-use.md,
 * "问题", 2026-10-23). git's count shows only once git has run, so its 0 means the check is over.
 *
 * @sideEffects Waits.
 * @param host - The host.
 * @returns The resource counts.
 */
export async function settledResources(host: RunningHost): Promise<Record<string, number>> {
  await host.tools;
  await vi.waitFor(() => {
    const now = host.resources.snapshot();
    expect([now["tools.detect"], now["git.process"], now["span"] ?? 0]).toStrictEqual([0, 0, 0]);
  });
  return host.resources.snapshot();
}

/** V8's heap spaces that hold compiled code: bytecode, optimized code and what they carry. */
const CODE_SPACES: ReadonlySet<string> = new Set([
  "code_space",
  "code_large_object_space",
  "trusted_space",
  "trusted_large_object_space",
]);

/**
 * How much of the heap is used, leaving out V8's compiled code.
 *
 * @remarks
 * The soaks judge growth by this: V8 goes on compiling hot functions long into a run, which no
 * release of Atrium's own objects undoes (testing.md, "长时间运行", 2026-10-24). A leak that shows
 * only as code goes unseen here.
 *
 * @sideEffects none
 * @returns The bytes.
 */
export function heapWithoutCode(): number {
  return getHeapSpaceStatistics()
    .filter((space) => !CODE_SPACES.has(space.space_name))
    .reduce((sum, space) => sum + space.space_used_size, 0);
}
