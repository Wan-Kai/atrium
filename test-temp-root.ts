import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_BIN_DIR_ENV, warmScriptedPi, warmShellPi } from "./packages/testkit/src/index";

/**
 * Points every test in this run at a fresh temporary root and deletes it when the run ends.
 *
 * @remarks
 * Used as the global setup of Vitest and Playwright. Tests clean up their own temporary
 * directories, but a test that fails before its cleanup, times out, or whose worker is killed skips
 * it. Mutation testing does this hundreds of times per run, which once
 * filled the disk with tens of gigabytes of leftovers (testing.md, "临时文件"). Setting `TMPDIR`
 * here, before any worker starts, sends everything `os.tmpdir()` hands out into one directory
 * that is removed in one go. Child processes started by tests (pi, the host, Electron) inherit it.
 *
 * Shared test executables are written and run once here, before any worker starts, so tests never
 * wait for macOS to check a new executable (testing.md, "测试里的可执行文件").
 *
 * @sideEffects Creates a directory; sets `process.env.TMPDIR` and the shared executable directory
 * for this run; writes and runs the shared test executables.
 * @returns A teardown that deletes the directory and restores `TMPDIR`.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const previous = process.env["TMPDIR"];
  // Shared test executables outlive the run, so macOS checks each one once, not once per run.
  process.env[TEST_BIN_DIR_ENV] ??= join(tmpdir(), "atrium-test-bin");
  await Promise.all([warmScriptedPi(), warmShellPi()]);
  const root = await mkdtemp(join(tmpdir(), "atrium-run-"));
  process.env["TMPDIR"] = root;
  return async () => {
    await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = previous;
  };
}
