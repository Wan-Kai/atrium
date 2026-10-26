import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const root = fileURLToPath(new URL("../../../", import.meta.url));
assert.ok(
  process.argv.slice(2).every((arg) => arg === "--negative-control"),
  "unknown argument",
);
const temporary = await mkdtemp(join(tmpdir(), "atrium-local-interop-"));
let fixture;
const interruption = new AbortController();

/**
 * Records interruption across compilation, fixture startup and the Swift run.
 *
 * @remarks Startup finishes its bounded wait before the common cleanup path runs.
 * @sideEffects Aborts the owned Swift run if it has started.
 */
function interrupt() {
  interruption.abort();
}

process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
try {
  const bundle = join(temporary, "fixture.mjs");
  await build({
    entryPoints: [join(root, "apps/ios/Integration/fixture.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    // ws has CommonJS built-in imports even inside an ESM bundle.
    banner: {
      js: 'import { createRequire as bundleRequire } from "node:module"; const require = bundleRequire(import.meta.url);',
    },
    // MP0's import.meta.main CLI must stay off when its module is folded into this bundle.
    define: { "import.meta.main": "false" },
    external: ["bufferutil", "utf-8-validate"],
    logLevel: "warning",
  });
  const { startFixture } = await import(pathToFileURL(bundle).href);
  fixture = await startFixture(process.argv.includes("--negative-control"));
  process.exitCode = await runSwift(fixture, interruption.signal);
} finally {
  try {
    await fixture?.close();
  } finally {
    await rm(temporary, { recursive: true, force: true });
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

/**
 * Runs just the opt-in Swift suite and owns its complete process group.
 *
 * @remarks The five-minute deadline includes compilation; interruption never kills unrelated Swift jobs.
 * @sideEffects Spawns Swift, forwards its output, installs temporary signal handlers and a deadline.
 * @param {{origin: string, token: string}} local - Loopback fixture configuration.
 * @param {AbortSignal} signal - Runner interruption, including before fixture startup finished.
 * @returns {Promise<number>} Swift's exit code, or 1 on interruption/deadline.
 */
async function runSwift(local, signal) {
  if (signal.aborted) return 1;
  const child = spawn(
    "swift",
    [
      "test",
      "--package-path",
      "apps/ios/AtriumKit",
      "--filter",
      "LocalRelayInteropTests",
      "-Xswiftc",
      "-warnings-as-errors",
    ],
    {
      cwd: root,
      detached: true,
      stdio: "inherit",
      env: {
        ...process.env,
        ATRIUM_LOCAL_INTEROP_CONTROL: local.origin,
        ATRIUM_LOCAL_INTEROP_TOKEN: local.token,
      },
    },
  );
  let interrupted = false;
  let escalation;

  /**
   * Signals only the process group this runner created.
   *
   * @remarks ESRCH means the owned group has already exited; all other failures remain errors.
   * @sideEffects Sends a Unix signal to the child process group.
   * @param {NodeJS.Signals} terminationSignal - Termination signal.
   */
  function signalGroup(terminationSignal) {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, terminationSignal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }

  /**
   * Stops a timed-out or interrupted Swift run, with a bounded escalation.
   *
   * @remarks The runner remains alive to close fixture listeners and remove its temporary bundle.
   * @sideEffects Signals owned processes and starts a two-second fallback timer.
   */
  function stop() {
    if (interrupted) return;
    interrupted = true;
    console.error("Local interop interrupted or timed out; stopping owned Swift process group");
    signalGroup("SIGTERM");
    escalation = setTimeout(() => signalGroup("SIGKILL"), 2000);
  }

  const deadline = setTimeout(stop, 300_000);
  signal.addEventListener("abort", stop, { once: true });
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => resolve(exitCode));
    });
    return interrupted ? 1 : (code ?? 1);
  } finally {
    clearTimeout(deadline);
    clearTimeout(escalation);
    signal.removeEventListener("abort", stop);
    signalGroup("SIGKILL");
  }
}
