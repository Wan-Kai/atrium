import { FakeClock, createTempDir } from "@atrium/testkit";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { systemClock } from "./clock";
import { GIT_CONCURRENCY, GitError, createGitRunner } from "./git";
import { ResourceTracker } from "./resources";

/** The environment the tests give git: the test process's own PATH and HOME. */
const env = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" };

/**
 * A temporary directory removed after the test.
 *
 * @remarks
 * Commands run in it as their working directory.
 *
 * @sideEffects Creates the directory.
 * @returns Its path.
 */
async function tempDir(): Promise<string> {
  const dir = await createTempDir("git");
  onTestFinished(dir.cleanup);
  return dir.path;
}

describe("GitRunner.run", () => {
  it("returns what git printed and its exit code, success or not", async () => {
    const cwd = await tempDir();
    const git = createGitRunner({ env, clock: systemClock, resources: new ResourceTracker() });
    await git.run(["init", "--quiet"], { cwd });

    expect(await git.run(["rev-parse", "--is-inside-work-tree"], { cwd })).toStrictEqual({ code: 0, stdout: "true\n" });
    expect(await git.run(["rev-parse", "--verify", "--quiet", "nothing"], { cwd })).toStrictEqual({
      code: 1,
      stdout: "",
    });
  });

  it("runs git with the tool environment, without optional locks, prompts or translations", async () => {
    const cwd = await tempDir();
    const git = createGitRunner({
      env: { ...env, ATRIUM_MARK: "x", LC_ALL: "fr_FR" },
      clock: systemClock,
      resources: new ResourceTracker(),
    });

    const { stdout } = await git.run(["-c", "alias.env=!env", "env"], { cwd });

    expect(stdout.split("\n")).toStrictEqual(
      expect.arrayContaining(["ATRIUM_MARK=x", "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "LC_ALL=C"]),
    );
  });

  it(`runs at most ${GIT_CONCURRENCY} commands at once, the rest waiting in order`, async () => {
    const cwd = await tempDir();
    const resources = new ResourceTracker();
    const git = createGitRunner({ env, clock: systemClock, resources });
    const stop = new AbortController();

    // Each waits for input that never comes, until the signal stops it.
    const runs = Array.from({ length: GIT_CONCURRENCY + 2 }, () =>
      git.run(["hash-object", "--stdin"], { cwd, signal: stop.signal }).catch((error: unknown) => error),
    );
    await vi.waitFor(() => expect(resources.snapshot()["git.process"]).toBe(GIT_CONCURRENCY));
    await new Promise((done) => setTimeout(done, 50));
    expect(resources.snapshot()["git.process"]).toBe(GIT_CONCURRENCY);
    stop.abort();

    expect(await Promise.all(runs)).toStrictEqual(Array.from(runs, () => new GitError("hash-object", "aborted")));
    expect(resources.snapshot()["git.process"]).toBe(0);
  });

  it("stops a command that outlives its deadline on the clock", async () => {
    const cwd = await tempDir();
    const clock = new FakeClock();
    const resources = new ResourceTracker();
    const git = createGitRunner({ env, clock, resources });

    const run = git.run(["hash-object", "--stdin"], { cwd, timeoutMs: 1_000 }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(resources.snapshot()["git.process"]).toBe(1));
    clock.advance(999);
    await new Promise((done) => setTimeout(done, 50));
    expect(resources.snapshot()["git.process"]).toBe(1);
    clock.advance(1);

    expect(await run).toStrictEqual(new GitError("hash-object", "timeout"));
    expect(clock.pendingTimers()).toBe(0);
  });

  it("waits 30 seconds by default", async () => {
    const cwd = await tempDir();
    const clock = new FakeClock();
    const git = createGitRunner({ env, clock, resources: new ResourceTracker() });

    const run = git.run(["hash-object", "--stdin"], { cwd }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(clock.pendingTimers()).toBe(1));
    clock.advance(29_999);
    await new Promise((done) => setTimeout(done, 50));
    clock.advance(1);

    expect(await run).toStrictEqual(new GitError("hash-object", "timeout"));
  });

  it("fails to spawn without git on the PATH or in a missing directory, and frees its slot", async () => {
    const cwd = await tempDir();
    const resources = new ResourceTracker();
    const missing = createGitRunner({ env: { PATH: "" }, clock: systemClock, resources });
    const git = createGitRunner({ env, clock: systemClock, resources });

    await expect(missing.run(["status"], { cwd })).rejects.toStrictEqual(new GitError("status", "spawn"));
    await expect(git.run(["status"], { cwd: join(cwd, "gone") })).rejects.toStrictEqual(
      new GitError("status", "spawn"),
    );
    for (let index = 0; index < GIT_CONCURRENCY + 1; index += 1) {
      await expect(missing.run([], { cwd })).rejects.toStrictEqual(new GitError("", "spawn"));
    }
    expect(resources.snapshot()["git.process"]).toBe(0);
  });
});

describe("GitError", () => {
  it("names the command and the reason only", () => {
    const error = new GitError("fetch", "timeout");

    expect(error.message).toBe("git fetch timeout");
    expect(error.name).toBe("GitError");
    expect([error.command, error.reason]).toStrictEqual(["fetch", "timeout"]);
  });
});
