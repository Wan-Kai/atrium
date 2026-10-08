import { FakeClock, GIT_SCENE_ENV, createTempDir } from "@atrium/testkit";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { systemClock } from "./clock";
import { GIT_CONCURRENCY, GitError, createGitRunner } from "./git";
import { ResourceTracker } from "./resources";

/**
 * Whether a process exists.
 *
 * @remarks
 * Signal 0 checks without sending anything.
 *
 * @sideEffects none
 * @param pid - The process.
 * @returns Whether it exists.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kills a process the test started, if it is still there.
 *
 * @remarks
 * By its own id, never by name.
 *
 * @sideEffects May kill the process.
 * @param pid - The process.
 */
function killIfAlive(pid: number): void {
  if (alive(pid)) process.kill(pid, "SIGKILL");
}

/**
 * The environment the tests give git: the test process's own PATH and HOME, and the scenes'
 * ceiling, so git never works on a repository around the temporary folder.
 */
const env = {
  PATH: process.env["PATH"] ?? "",
  HOME: process.env["HOME"] ?? "",
  GIT_CEILING_DIRECTORIES: GIT_SCENE_ENV["GIT_CEILING_DIRECTORIES"] ?? "",
};

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

  it("never runs a git found through a relative or empty PATH entry, as one placed in the repository", async () => {
    const cwd = await tempDir();
    const fake = join(cwd, "git");
    await writeFile(fake, "#!/bin/sh\necho planted\n");
    await chmod(fake, 0o755);
    const git = createGitRunner({
      env: { ...env, PATH: [".", "", env.PATH].join(delimiter) },
      clock: systemClock,
      resources: new ResourceTracker(),
    });

    const { stdout } = await git.run(["--version"], { cwd });

    expect(stdout).toMatch(/^git version /);
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

  it("ends what git started along with it, such as ssh for a fetch, before freeing its slot", async () => {
    const cwd = await tempDir();
    const bin = join(cwd, "bin");
    await mkdir(bin);
    const pidFile = join(cwd, "child.pid");
    // A git that starts a long-lived helper, as fetch starts ssh, and then waits.
    await writeFile(join(bin, "git"), `#!/bin/sh\nsleep 60 &\necho $! > ${pidFile}\nwait\n`);
    await chmod(join(bin, "git"), 0o755);
    const clock = new FakeClock();
    const resources = new ResourceTracker();
    const git = createGitRunner({
      env: { ...env, PATH: `${bin}${delimiter}/bin${delimiter}/usr/bin` },
      clock,
      resources,
    });

    const run = git.run(["fetch"], { cwd, timeoutMs: 1_000 }).catch((error: unknown) => error);
    // Starting the shell and its helper can take a few seconds on a loaded machine.
    await vi.waitFor(async () => expect(await readFile(pidFile, "utf8")).toMatch(/^\d+\n$/), { timeout: 10_000 });
    const helper = Number((await readFile(pidFile, "utf8")).trim());
    onTestFinished(() => killIfAlive(helper));
    clock.advance(1_000);

    expect(await run).toStrictEqual(new GitError("fetch", "timeout"));
    expect(resources.snapshot()["git.process"]).toBe(0);
    expect(alive(helper)).toBe(false);
  });

  it("gives up on output past 16 MiB", async () => {
    const cwd = await tempDir();
    const bin = join(cwd, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "git"), "#!/bin/sh\nhead -c 17000000 /dev/zero\n");
    await chmod(join(bin, "git"), 0o755);
    const git = createGitRunner({
      env: { ...env, PATH: `${bin}${delimiter}/bin${delimiter}/usr/bin` },
      clock: systemClock,
      resources: new ResourceTracker(),
    });

    await expect(git.run(["log"], { cwd })).rejects.toStrictEqual(new GitError("log", "spawn"));
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
