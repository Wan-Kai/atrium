import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { TEST_BIN_DIR_ENV, sharedExecutable, warmExecutable } from "./shared-executable";
import { createTempDir } from "./temp-dir";

const run = promisify(execFile);

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Points shared executables at a fresh directory for this test. */
async function freshBinDir(): Promise<string> {
  const dir = await createTempDir("bin");
  onTestFinished(dir.cleanup);
  vi.stubEnv(TEST_BIN_DIR_ENV, `${dir.path}/bin`);
  return `${dir.path}/bin`;
}

describe("sharedExecutable", () => {
  it("writes an executable once per content, in the configured directory, named by its hash", async () => {
    const dir = await freshBinDir();
    const script = "#!/bin/sh\necho one\n";

    const [first, again, other] = await Promise.all([
      sharedExecutable("tool", script),
      sharedExecutable("tool", script),
      sharedExecutable("tool", "#!/bin/sh\necho two\n"),
    ]);
    const inode = (await stat(first)).ino;
    const later = await sharedExecutable("tool", script);

    expect(first).toBe(again);
    expect(later).toBe(first);
    expect((await stat(later)).ino).toBe(inode);
    expect(other).not.toBe(first);
    expect(first).toMatch(new RegExp(`^${dir}/[0-9a-f]{16}-tool$`));
    expect(await readFile(first, "utf8")).toBe(script);
    expect((await stat(first)).mode & 0o777).toBe(0o755);
    expect((await run(first)).stdout).toBe("one\n");
  });

  it("falls back to a directory under the system temp folder when none is configured", async () => {
    vi.stubEnv(TEST_BIN_DIR_ENV, undefined);

    const path = await sharedExecutable("fallback", "#!/bin/sh\ntrue\n");

    expect(path).toContain("/atrium-test-bin/");
  });
});

describe("warmExecutable", () => {
  it("runs the executable with the given arguments and environment, and fails when it fails", async () => {
    await freshBinDir();
    const echo = await sharedExecutable("echo", '#!/bin/sh\n[ "$1" = "--version" ] && [ "$GREETING" = hi ]\n');

    await expect(warmExecutable(echo, ["--version"], { GREETING: "hi" })).resolves.toBeUndefined();
    await expect(warmExecutable(echo, [], { GREETING: "hi" })).rejects.toThrow("Command failed");
  });
});
