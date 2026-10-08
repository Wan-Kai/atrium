import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";
import { GIT_SCENE_ENV, gitSceneEnv } from "./git";
import { createTempDir } from "./temp-dir";

const run = promisify(execFile);

describe("gitSceneEnv", () => {
  it("keeps git in a folder without a repository from reaching one above the temporary root", async () => {
    const outer = await createTempDir("outer-repo");
    onTestFinished(outer.cleanup);
    await run("git", ["init", "--quiet", outer.path], { env: gitSceneEnv(outer.path) });
    const root = join(outer.path, "tmp");
    // As a scene whose repository a cleanup has just removed.
    const scene = join(root, "atrium-scene", "repo");
    await mkdir(scene, { recursive: true });

    await expect(
      run("git", ["rev-parse", "--show-toplevel"], { cwd: scene, env: gitSceneEnv(root) }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("not a git repository") });
  });

  it("is what scenes use, for the system's temporary folder", () => {
    expect(GIT_SCENE_ENV).toStrictEqual(gitSceneEnv(tmpdir()));
  });
});
