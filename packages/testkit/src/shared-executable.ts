import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Environment variable naming the directory shared executables live in. */
export const TEST_BIN_DIR_ENV = "ATRIUM_TEST_BIN_DIR";

/**
 * Returns the path of an executable with this content, writing it the first time any process asks.
 *
 * @remarks
 * macOS checks every newly created executable before its first run, and the checks queue up: 100
 * fresh scripts started together took 7 s at the median and 14 s at worst, against 37 ms through
 * symlinks to one already-checked file (testing.md, "测试里的可执行文件"). So tests link to one
 * copy per content, shared by every process: the file is named by a hash of its content and
 * written atomically, so parallel test processes agree on it without locking. It lives in the
 * directory the global test setup names, outside the per-run temporary root, so the check happens
 * once rather than once per run.
 *
 * @sideEffects Creates the directory and the file when missing.
 * @param name - Readable suffix for the file name.
 * @param content - Full file content, including the `#!` line.
 * @returns The absolute path of the shared executable.
 */
export async function sharedExecutable(name: string, content: string): Promise<string> {
  const dir = process.env[TEST_BIN_DIR_ENV] ?? join(tmpdir(), "atrium-test-bin");
  const file = join(dir, `${createHash("sha256").update(content).digest("hex").slice(0, 16)}-${name}`);
  const exists = await access(file).then(
    () => true,
    () => false,
  );
  if (!exists) {
    await mkdir(dir, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, content, { mode: 0o755 });
    await chmod(temporary, 0o755);
    await rename(temporary, file);
  }
  return file;
}

/**
 * Runs an executable once so macOS has checked it before tests start in parallel.
 *
 * @remarks
 * Called from the global test setup for every shared executable, while only one process runs.
 *
 * @sideEffects Runs the executable with `args`.
 * @param path - The executable.
 * @param args - Arguments that make it exit at once.
 * @param env - Environment for the run.
 */
export async function warmExecutable(
  path: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<void> {
  await run(path, [...args], { env: { ...process.env, ...env }, timeout: 60_000 });
}
