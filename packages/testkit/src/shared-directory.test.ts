import { AsyncLocalStorage } from "node:async_hooks";
import filesystem, { chmod, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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

/**
 * Holds back one caller of `numberedFiles` at a chosen step, once it has built its own copy.
 *
 * @remarks
 * The real filesystem does the work; only when the held caller goes on is controlled. Callers
 * are told apart by the name they run under (`run`).
 *
 * @sideEffects Wraps `readdir`, `rename` and `writeFile` until the test ends.
 * @param step - Hold after a listing that found a directory not complete (or not there), or just
 * before a rename.
 * @returns How to run a caller under a name, when the caller named "held" is held, and how to let it go.
 */
function holdOnce(step: "after an incomplete listing" | "before a rename") {
  const callers = new AsyncLocalStorage<string>();
  const held = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  onTestFinished(() => gate.resolve());
  let built = false;
  let holding = true;
  /** Whether the held caller is at the step to hold at. */
  const due = (): boolean => holding && built && callers.getStore() === "held";
  /** Holds the caller there, once. */
  const hold = async (): Promise<void> => {
    holding = false;
    held.resolve();
    await gate.promise;
  };
  const real = { readdir: filesystem.readdir, rename: filesystem.rename, writeFile: filesystem.writeFile };
  const spies = [
    vi.spyOn(filesystem, "writeFile").mockImplementation(async (...args: Parameters<typeof real.writeFile>) => {
      await real.writeFile(...args);
      built ||= callers.getStore() === "held";
    }),
    vi.spyOn(filesystem, "readdir").mockImplementation((async (path: string) => {
      const listed = await real.readdir(path).then(
        (names) => ({ names }),
        (error: unknown) => ({ error }),
      );
      if ("names" in listed && listed.names.length === 3) return listed.names;
      if (step === "after an incomplete listing" && due()) await hold();
      if ("names" in listed) return listed.names;
      throw listed.error;
    }) as typeof real.readdir),
    vi.spyOn(filesystem, "rename").mockImplementation(async (...args: Parameters<typeof real.rename>) => {
      if (step === "before a rename" && due()) await hold();
      await real.rename(...args);
    }),
  ];
  syncBuiltinESMExports();
  onTestFinished(() => {
    for (const spy of spies) spy.mockRestore();
    syncBuiltinESMExports();
  });
  return {
    run: <T>(name: string, call: () => Promise<T>) => callers.run(name, call),
    held: held.promise,
    release: () => gate.resolve(),
  };
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

  it("passes over a name something else holds", async () => {
    const dir = await freshSharedDir();
    const first = await numberedFiles(3);
    await rm(first, { recursive: true });
    await writeFile(first, "");

    expect(await numberedFiles(3)).toBe(`${first}-1`);
    expect((await readdir(dir)).toSorted()).toStrictEqual(
      [first, `${first}-1`].map((path) => path.slice(dir.length + 1)),
    );
  });

  it("never moves or removes a complete directory another caller published while it was rebuilding a purged one", async () => {
    await freshSharedDir();
    await unlink(join(await numberedFiles(3), "f0001"));
    const callers = holdOnce("after an incomplete listing");
    // The held caller has built its copy and seen the purged one; another publishes meanwhile.
    const late = callers.run("held", () => numberedFiles(3));
    await callers.held;
    const published = await callers.run("other", () => numberedFiles(3));
    const inode = (await stat(published)).ino;
    callers.release();
    const got = await late;

    expect([(await stat(published)).ino, await readdir(published), await readdir(got)]).toStrictEqual([
      inode,
      ["f0000", "f0001", "f0002"],
      ["f0000", "f0001", "f0002"],
    ]);
  });

  it("takes the copy another caller published just before its own, leaving nothing of its own behind", async () => {
    const dir = await freshSharedDir();
    const purged = await numberedFiles(3);
    await unlink(join(purged, "f0001"));
    const callers = holdOnce("before a rename");
    const late = callers.run("held", () => numberedFiles(3));
    await callers.held;
    const published = await callers.run("other", () => numberedFiles(3));
    callers.release();

    expect(await late).toBe(published);
    expect((await readdir(dir)).toSorted()).toStrictEqual(
      [purged, published].map((path) => path.slice(dir.length + 1)).toSorted(),
    );
  });

  it("builds the directory again under the next free name when some of its files were purged, leaving the purged one be", async () => {
    const dir = await freshSharedDir();
    const first = await numberedFiles(3);
    await unlink(join(first, "f0001"));
    const second = await numberedFiles(3);
    await unlink(join(second, "f0002"));

    const third = await numberedFiles(3);

    expect([second, third]).toStrictEqual([`${first}-1`, `${first}-2`]);
    expect(await numberedFiles(3)).toBe(third);
    expect((await readdir(third)).toSorted()).toStrictEqual(["f0000", "f0001", "f0002"]);
    expect((await readdir(first)).toSorted()).toStrictEqual(["f0000", "f0002"]);
    expect((await readdir(dir)).toSorted()).toStrictEqual(
      [first, second, third].map((path) => path.slice(dir.length + 1)).toSorted(),
    );
  });
});
