import { FakeClock, createTempDir, present, writeFakePiPackage } from "@atrium/testkit";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { asks, loginUpdates, promptIdOf } from "../../test/login-updates";
import type { PiDeps } from "../deps";
import { findExecutable } from "../locate/locate";
import { LoginError, type LoginProgram, logout, piPackageEntry, readLogins, startLogin } from "./login";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const PATH = present(process.env["PATH"], "PATH");

/** The login program as the tests run it: the source file, which Node runs directly. */
const WORKER = fileURLToPath(new URL("login-worker.ts", import.meta.url));

/**
 * Writes a fake pi package and gives the login program for it.
 *
 * @remarks
 * The package has pi's name, so {@link piPackageEntry} finds it the way it finds the real one.
 *
 * @sideEffects Creates a temporary directory, removed after the test.
 * @param source - The entry module's source.
 * @returns The package directory, the temporary directory and the program.
 */
async function fakePi(source?: string) {
  const dir = await createTempDir("login-fake-pi");
  cleanups.push(dir.cleanup);
  const home = await realpath(dir.path);
  const fake = await writeFakePiPackage(home, source);
  const program: LoginProgram = {
    node: present(await findExecutable(PATH, "node"), "node on PATH"),
    worker: WORKER,
    piEntry: fake.entry,
  };
  return { root: fake.root, home, program };
}

/**
 * Host infrastructure for the fake pi.
 *
 * @remarks
 * Real timers unless a clock is given; resources are counted.
 *
 * @sideEffects none
 * @param scenario - What the fake pi does.
 * @param clock - The clock, for tests that step past the cancel grace.
 * @returns The deps and the open resource count.
 */
function deps(scenario: string, clock?: FakeClock) {
  let open = 0;
  const value: PiDeps = {
    clock: clock ?? {
      now: () => Date.now(),
      setTimeout(callback, ms) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
    track: (kind) => {
      expect(kind).toBe("pi-login");
      open += 1;
      return () => {
        open -= 1;
      };
    },
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    nextRequestId: () => "unused",
    env: { PATH, FAKE_PI: scenario },
  };
  return { deps: value, open: () => open };
}

/**
 * Waits until a condition holds, checking every few milliseconds.
 *
 * @remarks
 * For a child process to reach a state the test cannot be told about.
 *
 * @sideEffects none
 * @param condition - The condition.
 */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("piPackageEntry", () => {
  it("walks up from the command's real path to the package with pi's name", async () => {
    const { root, home, program } = await fakePi();
    const command = join(home, "pi");
    await symlink(join(root, "dist", "bundle", "cli.js"), command);

    expect(await piPackageEntry(command)).toBe(program.piEntry);
  });

  it("skips a package with another name and one without the entry", async () => {
    const { root, home } = await fakePi();
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "not-pi" }));
    const other = join(home, "other");
    await mkdir(join(other, "bin"), { recursive: true });
    await writeFile(join(other, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent" }));
    await writeFile(join(other, "bin", "pi"), "");

    expect(await piPackageEntry(join(root, "dist", "bundle", "cli.js"))).toBeNull();
    expect(await piPackageEntry(join(other, "bin", "pi"))).toBeNull();
  });

  it("finds nothing for a command that does not exist", async () => {
    const { home } = await fakePi();

    expect(await piPackageEntry(join(home, "missing"))).toBeNull();
  });

  it("reads past a manifest that is not JSON or not an object", async () => {
    const { root } = await fakePi();
    await writeFile(join(root, "dist", "package.json"), "not json");
    await writeFile(join(root, "dist", "bundle", "package.json"), "null");

    expect(await piPackageEntry(join(root, "dist", "bundle", "cli.js"))).toBe(
      pathToFileURL(join(root, "dist", "index.js")).href,
    );
  });
});

describe("the login program", () => {
  it("lists providers with how each signs in and is signed in", async () => {
    const { program } = await fakePi();
    const { deps: value, open } = deps("status");

    expect(await readLogins(program, value)).toStrictEqual([
      {
        id: "acme",
        name: "Acme",
        oauth: { name: "Acme (Pro)", label: "Sign in with Acme", subscription: true },
        apiKey: true,
        signedIn: { type: "oauth", stored: true, source: "OAuth" },
      },
      {
        id: "ambient",
        name: "Ambient",
        oauth: null,
        apiKey: false,
        signedIn: { type: "api_key", stored: false, source: null },
      },
      {
        id: "beta",
        name: "Beta",
        oauth: { name: "Beta OAuth", label: null, subscription: false },
        apiKey: false,
        signedIn: null,
      },
      {
        id: "openai-codex",
        name: "Codex",
        oauth: { name: "ChatGPT (Codex)", label: null, subscription: false },
        apiKey: false,
        signedIn: null,
      },
      { id: "radius", name: "Radius", oauth: null, apiKey: true, signedIn: null },
    ]);
    expect(open()).toBe(0);
  });

  it("passes on what pi tells and asks, and finishes when pi has the credential", async () => {
    const { program } = await fakePi();
    const seen = loginUpdates();

    const run = startLogin(program, deps("complete").deps, { providerId: "acme", method: "oauth" }, seen.listener);
    const pick = await seen.next((update) => update.kind === "prompt");
    run.answer(promptIdOf(pick), "b");
    const code = await seen.next(asks(2));
    run.answer(promptIdOf(code), "42");
    await run.finished;

    expect(seen.seen).toStrictEqual([
      {
        kind: "event",
        event: {
          kind: "device_code",
          userCode: "ABCD-EFGH",
          verificationUri: "https://acme.test/device",
          expiresInSeconds: 900,
        },
      },
      {
        kind: "event",
        event: {
          kind: "device_code",
          userCode: "WXYZ",
          verificationUri: "https://acme.test/d",
          expiresInSeconds: null,
        },
      },
      { kind: "event", event: { kind: "progress", message: "Waiting" } },
      { kind: "event", event: { kind: "info", message: "Read this", links: ["https://acme.test/help"] } },
      { kind: "event", event: { kind: "info", message: "No links", links: [] } },
      { kind: "event", event: { kind: "auth_url", url: "https://acme.test/authorize", instructions: null } },
      {
        kind: "prompt",
        promptId: 1,
        prompt: {
          kind: "select",
          message: "Which?",
          placeholder: null,
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
      },
      { kind: "prompt", promptId: 2, prompt: { kind: "text", message: "Code?", placeholder: "123", options: [] } },
    ]);
  });

  it("chooses the browser when pi asks how to sign in, without asking the user", async () => {
    const { program } = await fakePi();
    const seen = loginUpdates();

    await startLogin(program, deps("browser").deps, { providerId: "acme", method: "oauth" }, seen.listener).finished;

    expect(seen.seen).toStrictEqual([]);
  });

  it("gives the key to pi's first secret question and passes on the rest", async () => {
    const { program } = await fakePi();
    const seen = loginUpdates();

    const run = startLogin(
      program,
      deps("api-key").deps,
      { providerId: "acme", method: "api_key", key: "sk-1" },
      seen.listener,
    );
    run.answer(promptIdOf(await seen.next(asks(1))), "acct");
    run.answer(promptIdOf(await seen.next(asks(3))), "sk-1");
    await run.finished;

    expect(seen.seen).toStrictEqual([
      { kind: "prompt", promptId: 1, prompt: { kind: "text", message: "Account?", placeholder: null, options: [] } },
      { kind: "prompt", promptId: 3, prompt: { kind: "secret", message: "Again?", placeholder: null, options: [] } },
    ]);
  });

  it("passes on every secret question when no key was given", async () => {
    const { program } = await fakePi();
    const seen = loginUpdates();

    const run = startLogin(program, deps("api-key").deps, { providerId: "acme", method: "api_key" }, seen.listener);
    run.answer(promptIdOf(await seen.next(asks(1))), "acct");
    run.answer(promptIdOf(await seen.next(asks(2))), "sk-1");
    run.answer(promptIdOf(await seen.next(asks(3))), "sk-1");
    await run.finished;

    expect(seen.seen).toStrictEqual([
      { kind: "prompt", promptId: 1, prompt: { kind: "text", message: "Account?", placeholder: null, options: [] } },
      { kind: "prompt", promptId: 2, prompt: { kind: "secret", message: "Key?", placeholder: null, options: [] } },
      { kind: "prompt", promptId: 3, prompt: { kind: "secret", message: "Again?", placeholder: null, options: [] } },
    ]);
  });

  it("ignores what pi prints that is not the program's, and does not read pi's errors", async () => {
    const { program } = await fakePi();
    const seen = loginUpdates();

    await startLogin(program, deps("noisy").deps, { providerId: "acme", method: "oauth" }, seen.listener).finished;

    expect(seen.seen).toStrictEqual([]);
  });

  it("tells when pi withdraws a question, and drops a late answer to it", async () => {
    const { program } = await fakePi();
    const seen = loginUpdates();

    const run = startLogin(program, deps("withdrawn").deps, { providerId: "acme", method: "oauth" }, seen.listener);
    await seen.next((update) => update.kind === "prompt_closed");
    run.answer(1, "too late");
    await run.finished;

    expect(seen.seen).toStrictEqual([
      {
        kind: "prompt",
        promptId: 1,
        prompt: { kind: "manual_code", message: "Paste", placeholder: null, options: [] },
      },
      { kind: "prompt_closed", promptId: 1 },
    ]);
  });

  it.each([
    ["fail", "token exchange failed: 400"],
    ["fail-value", "plain failure"],
    ["create-fails", "auth.json is corrupt"],
  ])("fails with pi's words when %s", async (scenario, detail) => {
    const { program } = await fakePi();
    const { deps: value, open } = deps(scenario);

    const failure: unknown = await startLogin(
      program,
      value,
      { providerId: "acme", method: "oauth" },
      () => undefined,
    ).finished.catch((error: unknown) => error);

    expect(failure).toStrictEqual(new LoginError("failed", detail));
    expect(failure).toMatchObject({ name: "LoginError", reason: "failed", detail, message: "failed" });
    expect(open()).toBe(0);
  });

  it("fails when the program exits without saying how it went", async () => {
    const { program } = await fakePi();

    const failure: unknown = await startLogin(
      program,
      deps("exit").deps,
      { providerId: "acme", method: "oauth" },
      () => undefined,
    ).finished.catch((error: unknown) => error);

    expect(failure).toStrictEqual(new LoginError("failed", null));
  });

  it("reports pi unavailable when its package lacks what the program uses", async () => {
    const { program } = await fakePi("export const ModelRuntime = {};");

    const failure: unknown = await readLogins(program, deps("status").deps).catch((error: unknown) => error);

    expect(failure).toStrictEqual(new LoginError("unavailable", null));
  });

  it("fails with pi's words when pi refuses a logout", async () => {
    const { program } = await fakePi();

    const failure: unknown = await logout(program, deps("logout-fails").deps, "acme").catch((error: unknown) => error);

    expect(failure).toStrictEqual(new LoginError("failed", "locked acme"));
  });

  it("logs out through pi", async () => {
    const { program } = await fakePi();
    const { deps: value, open } = deps("logout");

    await logout(program, value, "acme");

    expect(open()).toBe(0);
  });

  it("kills a status check that outlives its deadline", async () => {
    const { program } = await fakePi();
    const { deps: value, open } = deps("status-hangs");

    const failure: unknown = await readLogins(program, value, { timeoutMs: 200 }).catch((error: unknown) => error);

    expect(failure).toStrictEqual(new LoginError("timed_out", null));
    expect(open()).toBe(0);
  });

  it("kills a logout that outlives its deadline", async () => {
    const { program } = await fakePi();
    const { deps: value, open } = deps("logout-hangs");

    const failure: unknown = await logout(program, value, "acme", { timeoutMs: 200 }).catch((error: unknown) => error);

    expect(failure).toStrictEqual(new LoginError("timed_out", null));
    expect(open()).toBe(0);
  });

  it("stays timed out when cancelled while being killed", async () => {
    const { program } = await fakePi();
    const clock = new FakeClock();
    const controller = new AbortController();
    const { deps: value, open } = deps("status-hangs", clock);
    const checking = readLogins(program, value, { signal: controller.signal, timeoutMs: 1_000 }).catch(
      (error: unknown) => error,
    );

    clock.advance(1_000);
    controller.abort();

    expect(await checking).toStrictEqual(new LoginError("timed_out", null));
    expect(open()).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("forgets its signal once finished", async () => {
    const { program } = await fakePi();
    const clock = new FakeClock();
    const controller = new AbortController();

    await readLogins(program, deps("status", clock).deps, { signal: controller.signal });
    controller.abort();

    expect(clock.pendingTimers()).toBe(0);
  });

  it("kills the program alone when its process tree cannot be read", async () => {
    const { program } = await fakePi();
    const clock = new FakeClock();
    const { deps: value, open } = deps("deaf", clock);
    const run = startLogin(program, value, { providerId: "acme", method: "oauth" }, () => undefined, {
      processSystem: {
        listProcesses: () => Promise.reject(new Error("ps is gone")),
        kill: () => undefined,
        ownPid: process.pid,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    run.cancel();
    clock.advance(3_000);

    expect(await run.finished.catch((error: unknown) => error)).toStrictEqual(new LoginError("aborted", null));
    expect(open()).toBe(0);
  });

  it("lets a cancelled login leave by itself, without waiting for the grace", async () => {
    const { program } = await fakePi();
    const clock = new FakeClock();
    const seen = loginUpdates();
    const { deps: value, open } = deps("patient", clock);
    const run = startLogin(program, value, { providerId: "acme", method: "oauth" }, seen.listener);
    await seen.next((update) => update.kind === "event");

    run.cancel();

    expect(await run.finished.catch((error: unknown) => error)).toStrictEqual(new LoginError("aborted", null));
    expect(open()).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("fails when Node cannot be started", async () => {
    const { home, program } = await fakePi();
    const { deps: value, open } = deps("status");

    const failure: unknown = await readLogins({ ...program, node: join(home, "no-node") }, value).catch(
      (error: unknown) => error,
    );

    expect(failure).toStrictEqual(new LoginError("failed", null));
    expect(open()).toBe(0);
  });

  it("kills a login that does not leave after being cancelled", async () => {
    const { program } = await fakePi();
    const clock = new FakeClock();
    const { deps: value, open } = deps("deaf", clock);
    const run = startLogin(program, value, { providerId: "acme", method: "oauth" }, () => undefined);
    let settled = false;
    const finished = run.finished.then(
      () => undefined,
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    run.cancel();
    run.cancel();
    run.answer(1, "ignored once cancelled");
    clock.advance(2_999);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const before = settled;
    clock.advance(1);

    expect(before).toBe(false);
    expect(await finished).toStrictEqual(new LoginError("aborted", null));
    expect(open()).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("starts nothing when its signal has already aborted", async () => {
    const { program } = await fakePi();
    const controller = new AbortController();
    controller.abort();

    const { deps: value } = deps("status");
    let started = 0;

    const failure: unknown = await readLogins(
      program,
      { ...value, track: () => ((started += 1), () => undefined) },
      { signal: controller.signal },
    ).catch((error: unknown) => error);

    expect(failure).toStrictEqual(new LoginError("aborted", null));
    expect(started).toBe(0);
  });

  it("cancels when its signal aborts mid-way", async () => {
    const { program } = await fakePi();
    const controller = new AbortController();
    const { deps: value, open } = deps("status-hangs");
    const checking = readLogins(program, value, { signal: controller.signal, timeoutMs: 60_000 }).catch(
      (error: unknown) => error,
    );
    await until(() => open() === 1);

    controller.abort();

    expect(await checking).toStrictEqual(new LoginError("aborted", null));
  });
});
