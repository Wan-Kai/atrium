import { runCli } from "./cli";
import { systemClock } from "./clock";

/**
 * The `relay.cjs` process: runs one command with the real clock, output and signals.
 *
 * @remarks
 * Only assembly, so it is left out of mutation testing (testing.md, "每个变异只跑本组的测试");
 * `runCli` holds the behaviour and is tested in process. SIGTERM (`docker stop`) and SIGINT
 * stop `serve` cleanly: connections get 1001 and the log is flushed.
 *
 * @sideEffects Installs SIGTERM and SIGINT handlers; sets the exit code; writes to stdout/stderr.
 * @returns Once the command is done.
 */
async function main(): Promise<void> {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  process.exitCode = await runCli(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    cwd: process.cwd(),
    clock: systemClock,
    signal: controller.signal,
  });
  // The handlers would keep a finished command from exiting on a second signal.
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
}

main().catch((error: unknown) => {
  process.stderr.write(`atrium-relay: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
