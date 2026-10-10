import { createTempDir } from "@atrium/testkit";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchDirectory } from "./changes-service";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** How many file system watches the process holds. */
function watches(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "FSEventWrap").length;
}

describe("watchDirectory", () => {
  it("tells of a change deep below the directory, by its path within, and lets the watch go when stopped", async () => {
    const dir = await createTempDir("watch-directory");
    cleanups.push(dir.cleanup);
    const root = await realpath(dir.path);
    await mkdir(join(root, "sub"));
    const before = watches();
    const paths: (string | null)[] = [];
    const errors: string[] = [];

    const stop = watchDirectory(
      root,
      (path) => paths.push(path),
      () => errors.push("error"),
    );
    expect(watches()).toBe(before + 1);
    // fs.watch may miss what happens before its stream is up, so write until it is seen.
    await vi.waitFor(async () => {
      await writeFile(join(root, "sub", "a.txt"), "x");
      expect(paths).toContain("sub/a.txt");
    });
    stop();

    await vi.waitFor(() => expect(watches()).toBe(before));
    expect(errors).toStrictEqual([]);
  });

  it("reports a directory it cannot watch as an error, after returning", async () => {
    const dir = await createTempDir("watch-directory");
    cleanups.push(dir.cleanup);
    const errors: string[] = [];

    const stop = watchDirectory(
      join(dir.path, "missing"),
      () => undefined,
      () => errors.push("error"),
    );
    expect(errors).toStrictEqual([]);
    await Promise.resolve();

    expect(errors).toStrictEqual(["error"]);
    expect(stop()).toBeUndefined();
  });
});
