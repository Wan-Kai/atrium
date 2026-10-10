import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";
import { GIT_SCENE_ENV, createGitScene, gitSceneEnv } from "./git";
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

describe("createGitScene", () => {
  it("gives each scene a clone on main of its own origin, as if made afresh, though made from one template", async () => {
    const first = await createGitScene("scene-a");
    onTestFinished(first.cleanup);
    const second = await createGitScene("scene-b");
    onTestFinished(second.cleanup);

    await first.commit(first.repo, "only-first.txt", "x\n");
    await first.git(first.repo, "push", "--quiet", "origin", "main");

    expect(await second.git(second.repo, "remote", "get-url", "origin")).toBe(second.origin);
    expect(await second.git(second.repo, "log", "--format=%s", "main")).toBe("start");
    expect(await second.git(second.origin, "log", "--format=%s", "main")).toBe("start");
    expect(await second.git(second.repo, "symbolic-ref", "refs/remotes/origin/HEAD")).toBe("refs/remotes/origin/main");
    expect(await second.git(second.repo, "status", "--porcelain")).toBe("");
    expect(await first.git(first.origin, "log", "--format=%s", "main")).toBe("change only-first.txt\nstart");
    expect(await second.git(second.repo, "branch", "--show-current")).toBe("main");
  });
});
