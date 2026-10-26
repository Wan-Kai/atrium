import { createTempDir } from "@atrium/testkit";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { systemClock } from "../../src/platform/clock";
import { parseRelayLine, type RelayEndpoint } from "../../src/remote/relay-line";
import { Inbox, type WaitOptions } from "./inbox";

/** An isolated, real relay process; never a connection to the user's relay. */
export interface TestRelay {
  readonly endpoint: RelayEndpoint;
  readonly line: string;
  readonly pid: number;
  readonly dataDir: string;
  readonly cleanup: () => Promise<void>;
}

/**
 * Finds a loopback port for the CLI's advertised address.
 * @remarks The CLI must print the final address before serve loads its host table. A competing
 * bind between release and serve is reported as startup failure, never redirected elsewhere.
 * @sideEffects Briefly listens on an OS-assigned loopback port.
 * @returns The available port.
 */
async function localPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (address === null || typeof address === "string") throw new Error("no loopback port");
  return address.port;
}

/**
 * Stops one owned process and waits until its pipes close.
 * @remarks SIGKILL bounds cleanup if graceful shutdown cannot finish.
 * @sideEffects Signals only the supplied child and schedules a kill deadline.
 * @param child - A process created by this harness.
 * @returns When no child resources remain.
 */
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  await new Promise<void>((resolve) => {
    const cancel = systemClock.setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("close", () => {
      cancel();
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/**
 * Starts the actual relay CLI against temporary files on loopback.
 * @remarks SPEC-0005 host integration requires a real relay child, not the MP0 in-process relay.
 * The production entry is bundled into the temp directory so stale dist output cannot be used.
 * This process boundary necessarily uses the real clock; phone and host clocks remain injectable.
 * @sideEffects Builds a temporary bundle, runs add-host and serve children, opens a local port.
 * @param options - Startup deadline, cancellation, and optional relay admission budget for leak loops.
 * @returns Credentials, the real CLI line and idempotent cleanup.
 */
export async function startTestRelay(
  options: WaitOptions & { readonly newStreamsPerIpPerMinute?: number } = {},
): Promise<TestRelay> {
  options.signal?.throwIfAborted();
  const dir = await createTempDir("remote-relay");
  let child: ChildProcess | undefined;
  let disposed: Promise<void> | undefined;
  /**
   * Releases this relay and its files once.
   * @remarks Both startup failures and test teardown share the same ownership path.
   * @sideEffects Stops the relay child and removes its temporary directory.
   * @returns When cleanup completes.
   */
  const cleanup = (): Promise<void> =>
    (disposed ??= (async () => {
      if (child !== undefined) await stop(child);
      await dir.cleanup();
    })());
  try {
    const bundle = join(dir.path, "relay.cjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../../../../apps/relay/src/entry.ts", import.meta.url))],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["bufferutil", "utf-8-validate"],
      logLevel: "silent",
    });
    const port = await localPort();
    await writeFile(
      join(dir.path, "relay.json"),
      JSON.stringify({
        publicHost: `127.0.0.1:${port}`,
        pathPrefix: "/atrium",
        ...(options.newStreamsPerIpPerMinute === undefined
          ? {}
          : { newStreamsPerIpPerMinute: options.newStreamsPerIpPerMinute }),
      }),
    );
    const registration = spawn(process.execPath, [bundle, "add-host", "Test Mac", "--dir", dir.path], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = registration;
    const result = new Inbox<number | null>(systemClock);
    let output = "";
    registration.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    registration.stderr.resume();
    registration.once("error", (error) => result.fail(error));
    registration.once("close", (code) => result.push(code));
    if ((await result.next(() => true, options)) !== 0) throw new Error("relay add-host failed");
    const line = output.trim();
    const endpoint = parseRelayLine(line);
    if (endpoint === null || endpoint.url !== `ws://127.0.0.1:${port}/atrium`)
      throw new Error("invalid local relay line");
    const serving = spawn(process.execPath, [bundle, "serve", "--dir", dir.path, "--listen", `127.0.0.1:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = serving;
    const ready = new Inbox<string>(systemClock);
    let stdout = "";
    serving.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (stdout.includes(`atrium-relay listening on 127.0.0.1:${port}/atrium\n`)) ready.push("ready");
    });
    serving.stderr.resume();
    serving.once("error", (error) => ready.fail(error));
    serving.once("close", () => ready.fail(new Error("relay exited")));
    await ready.next(() => true, options);
    if (serving.pid === undefined) throw new Error("relay has no pid");
    return { endpoint, line, pid: serving.pid, dataDir: dir.path, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
