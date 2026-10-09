import { createTempDir } from "@atrium/testkit";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findFd } from "./fd";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * A directory with executables, and files that are not, at the given paths.
 *
 * @remarks
 * Real files, since the lookup checks they are executable.
 *
 * @sideEffects Creates a temporary directory, removed after the test.
 * @param executables - Paths, relative to the directory, of executables to create.
 * @param plain - Paths of files to create without the execute bit.
 * @returns The directory.
 */
async function tree(executables: readonly string[], plain: readonly string[] = []): Promise<string> {
  const dir = await createTempDir("fd");
  cleanups.push(dir.cleanup);
  for (const path of [...executables, ...plain]) {
    await mkdir(join(dir.path, path, ".."), { recursive: true });
    await writeFile(join(dir.path, path), "#!/bin/sh\n");
    await chmod(join(dir.path, path), executables.includes(path) ? 0o755 : 0o644);
  }
  return dir.path;
}

describe("findFd", () => {
  it("takes the fd pi downloaded into its agent directory first", async () => {
    const root = await tree([".pi/agent/bin/fd", "usr/bin/fd"]);

    expect(await findFd({ HOME: root, PATH: join(root, "usr/bin") })).toBe(join(root, ".pi/agent/bin/fd"));
  });

  it("follows PI_CODING_AGENT_DIR, ~ included", async () => {
    const root = await tree(["custom/bin/fd", ".pi/agent/bin/fd"]);

    expect(await findFd({ HOME: root, PI_CODING_AGENT_DIR: join(root, "custom"), PATH: "" })).toBe(
      join(root, "custom/bin/fd"),
    );
    expect(await findFd({ HOME: root, PI_CODING_AGENT_DIR: "~/custom", PATH: "" })).toBe(join(root, "custom/bin/fd"));
  });

  it("falls back to fd, then fdfind, on the PATH's absolute directories", async () => {
    const root = await tree(["a/fdfind", "b/fd"]);

    expect(await findFd({ HOME: root, PATH: `relative:${join(root, "a")}:${join(root, "b")}` })).toBe(
      join(root, "b/fd"),
    );
    expect(await findFd({ HOME: root, PATH: join(root, "a") })).toBe(join(root, "a/fdfind"));
  });

  it("skips files that cannot run, and finds nothing when there is none", async () => {
    const root = await tree([], [".pi/agent/bin/fd", "bin/fd"]);

    expect(await findFd({ HOME: root, PATH: join(root, "bin") })).toBeNull();
  });
});
