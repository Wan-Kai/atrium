import { chmod, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { numberedFiles } from "./shared-directory";
import { TEST_BIN_DIR_ENV } from "./shared-executable";
import { createTempDir } from "./temp-dir";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Points shared directories at a fresh directory for this test. */
async function freshSharedDir(): Promise<string> {
  const dir = await createTempDir("shared");
  onTestFinished(dir.cleanup);
  vi.stubEnv(TEST_BIN_DIR_ENV, `${dir.path}/bin`);
  return `${dir.path}/bin`;
}

describe("numberedFiles", () => {
  it("builds one directory of numbered empty files per count, shared by every caller", async () => {
    const dir = await freshSharedDir();

    const [first, again, other] = await Promise.all([numberedFiles(3), numberedFiles(3), numberedFiles(2)]);
    const inode = (await stat(first)).ino;
    const later = await numberedFiles(3);

    expect([again, later]).toStrictEqual([first, first]);
    expect((await stat(later)).ino).toBe(inode);
    expect(first).toMatch(new RegExp(`^${dir}/[0-9a-f]{16}-files-3$`));
    expect((await readdir(first)).toSorted()).toStrictEqual(["f0000", "f0001", "f0002"]);
    expect((await stat(join(first, "f0001"))).size).toBe(0);
    expect((await readdir(other)).toSorted()).toStrictEqual(["f0000", "f0001"]);
    expect((await readdir(dir)).toSorted()).toStrictEqual(
      [first, other].map((path) => path.slice(dir.length + 1)).toSorted(),
    );
  });

  it("uses a complete directory as it is, without writing anything", async () => {
    const dir = await freshSharedDir();
    const first = await numberedFiles(3);
    await chmod(dir, 0o555);
    onTestFinished(() => chmod(dir, 0o755));

    expect(await numberedFiles(3)).toBe(first);
  });

  it("builds the directory again when some of its files were purged", async () => {
    const dir = await freshSharedDir();
    const first = await numberedFiles(3);
    await unlink(join(first, "f0001"));

    const again = await numberedFiles(3);

    expect(again).toBe(first);
    expect((await readdir(again)).toSorted()).toStrictEqual(["f0000", "f0001", "f0002"]);
    expect(await readdir(dir)).toStrictEqual([first.slice(dir.length + 1)]);
  });
});
