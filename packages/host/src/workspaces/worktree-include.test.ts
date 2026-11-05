import { GIT_SCENE_ENV, type GitScene, createGitScene } from "@atrium/testkit";
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { recordingTracing } from "../../test/recording-tracing";
import { systemClock } from "../platform/clock";
import { createGitRunner } from "../platform/git";
import { ResourceTracker } from "../platform/resources";
import {
  INCLUDE_COUNT_LIMIT,
  INCLUDE_FILE_LIMIT,
  INCLUDE_TOTAL_LIMIT,
  WORKTREE_INCLUDE_FILE,
  copyWorktreeInclude,
} from "./worktree-include";

// Real repositories and files up to the limits; see worktree-creator.test.ts.
vi.setConfig({ testTimeout: 60_000 });

/**
 * A scene with a worktree to copy into, and what to copy with.
 *
 * @sideEffects Creates the repositories, removed when the test ends.
 * @returns The scene, the new worktree and a function copying from the repository into it.
 */
async function setup() {
  const scene: GitScene = await createGitScene("include");
  onTestFinished(scene.cleanup);
  const dest = await scene.worktree("copy");
  const { logger, records } = recordingTracing();
  const git = createGitRunner({ env: GIT_SCENE_ENV, clock: systemClock, resources: new ResourceTracker() });
  const copy = () => copyWorktreeInclude({ git, sourceDir: scene.repo, destDir: dest, logger });
  /**
   * Writes the files that list and ignore, in the repository.
   *
   * @sideEffects Writes `.gitignore` and `.worktreeinclude` there.
   * @param ignore - The lines of `.gitignore`.
   * @param include - The lines of `.worktreeinclude`.
   */
  const rules = async (ignore: string[], include: string[]) => {
    await writeFile(join(scene.repo, ".gitignore"), `${ignore.join("\n")}\n`);
    await writeFile(join(scene.repo, WORKTREE_INCLUDE_FILE), `${include.join("\n")}\n`);
  };
  return { scene, dest, copy, rules, records };
}

describe("copyWorktreeInclude", () => {
  it("copies only the files that the include file matches and git ignores, with their folders, as copies", async () => {
    const { scene, dest, copy, rules } = await setup();
    await rules(
      [".env", "*.key", "build/", "other.log", "tracked.env"],
      [".env", "*.key", "build/", "plain.txt", "tracked.env"],
    );
    await writeFile(join(scene.repo, ".env"), "SECRET=1\n");
    await mkdir(join(scene.repo, "config"), { recursive: true });
    await writeFile(join(scene.repo, "config", "local.key"), "key\n");
    await mkdir(join(scene.repo, "build"), { recursive: true });
    await writeFile(join(scene.repo, "build", "out.js"), "out\n");
    // Listed but nothing ignores it.
    await writeFile(join(scene.repo, "plain.txt"), "plain\n");
    // Ignored but not listed.
    await writeFile(join(scene.repo, "other.log"), "log\n");
    // Ignored and listed, but tracked: the worktree gets it from the commit.
    await writeFile(join(scene.repo, "tracked.env"), "tracked\n");
    await scene.git(scene.repo, "add", "-f", "tracked.env");

    const result = await copy();

    expect(result).toStrictEqual({ copied: 3, skipped: 0 });
    expect(await readFile(join(dest, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(await readFile(join(dest, "config", "local.key"), "utf8")).toBe("key\n");
    expect(await readFile(join(dest, "build", "out.js"), "utf8")).toBe("out\n");
    await expect(stat(join(dest, "plain.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(dest, "other.log"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(dest, "tracked.env"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(join(dest, ".env"))).ino).not.toBe((await stat(join(scene.repo, ".env"))).ino);
  });

  it("copies nothing without a .worktreeinclude, or with one that is a link", async () => {
    const { scene, dest, copy, rules } = await setup();
    await writeFile(join(scene.repo, ".gitignore"), ".env\n");
    await writeFile(join(scene.repo, ".env"), "SECRET=1\n");
    expect(await copy()).toStrictEqual({ copied: 0, skipped: 0 });

    await rules([".env"], []);
    await rm(join(scene.repo, WORKTREE_INCLUDE_FILE));
    await writeFile(join(scene.root, "patterns"), ".env\n");
    await symlink(join(scene.root, "patterns"), join(scene.repo, WORKTREE_INCLUDE_FILE));
    expect(await copy()).toStrictEqual({ copied: 0, skipped: 0 });
    expect(await readdir(dest)).not.toContain(".env");
  });

  it("does not follow a link, copies nothing from node_modules, and never overwrites a file", async () => {
    const { scene, dest, copy, rules, records } = await setup();
    await rules(["*.env", "node_modules/"], ["*.env"]);
    await writeFile(join(scene.root, "outside-secret"), "outside\n");
    await symlink(join(scene.root, "outside-secret"), join(scene.repo, "link.env"));
    await mkdir(join(scene.repo, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(scene.repo, "node_modules", "pkg", "x.env"), "dep\n");
    await writeFile(join(scene.repo, "taken.env"), "from source\n");
    await writeFile(join(dest, "taken.env"), "already there\n");

    const result = await copy();

    expect(result).toStrictEqual({ copied: 0, skipped: 2 });
    await expect(stat(join(dest, "link.env"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(dest, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(dest, "taken.env"), "utf8")).toBe("already there\n");
    expect(records.filter((record) => record["msg"] === "worktree include left files out")).toMatchObject([
      { copied: 0, skipped: 2 },
    ]);
    expect(JSON.stringify(records)).not.toContain("link.env");
  });

  it("does not write through a link in the new worktree that leads out of it", async () => {
    const { scene, dest, copy, rules } = await setup();
    await rules(["*.env"], ["*.env"]);
    await mkdir(join(scene.repo, "sub"), { recursive: true });
    await writeFile(join(scene.repo, "sub", "a.env"), "a\n");
    const outside = join(scene.root, "outside-dir");
    await mkdir(outside);
    await symlink(outside, join(dest, "sub"));

    const result = await copy();

    expect(result).toStrictEqual({ copied: 0, skipped: 1 });
    expect(await readdir(outside)).toStrictEqual([]);
  });

  it("leaves out a file over 10 MiB and takes one of exactly 10 MiB", async () => {
    const { scene, dest, copy, rules } = await setup();
    await rules(["*.bin"], ["*.bin"]);
    await writeFile(join(scene.repo, "exact.bin"), Buffer.alloc(INCLUDE_FILE_LIMIT));
    await writeFile(join(scene.repo, "over.bin"), Buffer.alloc(INCLUDE_FILE_LIMIT + 1));
    await writeFile(join(scene.repo, "small.bin"), "s");

    const result = await copy();

    expect(result).toStrictEqual({ copied: 2, skipped: 1 });
    expect((await stat(join(dest, "exact.bin"))).size).toBe(INCLUDE_FILE_LIMIT);
    await expect(stat(join(dest, "over.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops taking files into 64 MiB: the one that would pass it is left out, a smaller one after it still fits", async () => {
    const { scene, dest, copy, rules } = await setup();
    await rules(["*.bin"], ["*.bin"]);
    const mebibyte = 1024 * 1024;
    for (let n = 1; n <= 6; n += 1) await writeFile(join(scene.repo, `a${String(n)}.bin`), Buffer.alloc(10 * mebibyte));
    await writeFile(join(scene.repo, "b-big.bin"), Buffer.alloc(10 * mebibyte));
    await writeFile(join(scene.repo, "c-fits.bin"), Buffer.alloc(4 * mebibyte));
    await writeFile(join(scene.repo, "d-over.bin"), Buffer.alloc(1));

    const result = await copy();

    expect(INCLUDE_TOTAL_LIMIT).toBe(64 * mebibyte);
    expect(result).toStrictEqual({ copied: 7, skipped: 1 + 1 });
    await expect(stat(join(dest, "b-big.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(dest, "d-over.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(join(dest, "c-fits.bin"))).size).toBe(4 * mebibyte);
  });

  it("stops at 500 files", async () => {
    const { scene, dest, copy, rules } = await setup();
    await rules(["many/"], ["many/"]);
    await mkdir(join(scene.repo, "many"));
    for (let n = 0; n <= INCLUDE_COUNT_LIMIT; n += 1) {
      await writeFile(join(scene.repo, "many", `f${String(n).padStart(4, "0")}`), "x");
    }

    const result = await copy();

    expect(result).toStrictEqual({ copied: INCLUDE_COUNT_LIMIT, skipped: 1 });
    expect(await readdir(join(dest, "many"))).toHaveLength(INCLUDE_COUNT_LIMIT);
  });
});
