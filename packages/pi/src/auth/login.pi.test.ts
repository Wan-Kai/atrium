import { createTempDir, present } from "@atrium/testkit";
import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { authUrlOf, loginUpdates, outputLines, promptIdOf } from "../../test/login-updates";
import type { PiDeps } from "../deps";
import { findExecutable, findPi } from "../locate/locate";
import { LoginError, type LoginProgram, logout, piPackageEntry, readLogins, startLogin } from "./login";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const PATH = present(process.env["PATH"], "PATH");

/** The login program as the tests run it: the source file, which Node runs directly. */
const WORKER = fileURLToPath(new URL("login-worker.ts", import.meta.url));

/**
 * Host infrastructure for a login against the real pi, in a home of its own.
 *
 * @remarks
 * Only `PATH` comes from the machine, so neither the user's credentials in the environment nor their
 * `~/.pi` reach pi: `PI_CODING_AGENT_DIR` points pi at an empty directory. Resources are counted so
 * a test can see the program released.
 *
 * @sideEffects Creates a temporary directory, removed after the test.
 * @returns The deps, pi's directory and the open resource count.
 */
async function piHome() {
  const dir = await createTempDir("login-pi");
  cleanups.push(dir.cleanup);
  const home = await realpath(dir.path);
  const agentDir = join(home, "agent");
  let open = 0;
  const deps: PiDeps = {
    clock: {
      now: () => Date.now(),
      setTimeout(callback, ms) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
    track: () => {
      open += 1;
      return () => {
        open -= 1;
      };
    },
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    nextRequestId: () => "unused",
    env: { PATH, HOME: home, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir },
  };
  return { deps, agentDir, open: () => open };
}

/**
 * The login program for the pi on PATH.
 *
 * @remarks
 * Node and pi come from the test's PATH, as the host takes them from the login shell's.
 *
 * @sideEffects Reads the file system.
 * @returns The program.
 */
async function program(): Promise<LoginProgram> {
  const pi = present(await findPi(PATH), "pi on PATH");
  return {
    node: present(await findExecutable(PATH, "node"), "node on PATH"),
    worker: WORKER,
    piEntry: present(await piPackageEntry(pi), "pi's package"),
  };
}

/**
 * Whether a local port can be listened on.
 *
 * @remarks
 * pi's OAuth callback servers use fixed ports.
 *
 * @sideEffects Briefly listens on the port.
 * @param port - The port.
 * @returns Whether it is free.
 */
async function portFree(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const server = createServer();
  server.once("error", () => resolve(false));
  server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  return promise;
}

describe("signing in through the installed pi", () => {
  it("finds the entry of the package pi's command belongs to, and none for a command that is not pi", async () => {
    const pi = present(await findPi(PATH), "pi on PATH");

    expect(await piPackageEntry(pi)).toMatch(/^file:\/\/.*\/@earendil-works\/pi-coding-agent\/dist\/index\.js$/);
    expect(await piPackageEntry(present(await findExecutable(PATH, "sh"), "sh"))).toBeNull();
    expect(await piPackageEntry("/nonexistent-pi-for-atrium-tests")).toBeNull();
  });

  it("lists pi's providers with their OAuth logins, none signed in in an empty home", async () => {
    const { deps, open } = await piHome();

    const providers = await readLogins(await program(), deps);

    expect(providers.find(({ id }) => id === "anthropic")).toStrictEqual({
      id: "anthropic",
      name: "Anthropic",
      oauth: { name: "Anthropic (Claude Pro/Max)", label: null, subscription: true },
      apiKey: true,
      signedIn: null,
    });
    expect(providers.find(({ id }) => id === "openai")).toMatchObject({
      oauth: { label: "Sign in with ChatGPT", subscription: true },
      apiKey: true,
      signedIn: null,
    });
    expect(providers.find(({ id }) => id === "openrouter")?.oauth).toStrictEqual({
      name: "OpenRouter OAuth",
      label: "Sign in with OpenRouter",
      subscription: false,
    });
    expect(providers.filter(({ signedIn }) => signedIn !== null)).toStrictEqual([]);
    expect(open()).toBe(0);
  });

  it("tells a key in the environment from one pi stored", async () => {
    const { deps } = await piHome();

    const providers = await readLogins(await program(), {
      ...deps,
      env: { ...deps.env, DEEPSEEK_API_KEY: "sk-atrium-test-0004" },
    });

    expect(providers.find(({ id }) => id === "deepseek")?.signedIn).toStrictEqual({
      type: "api_key",
      stored: false,
      source: "DEEPSEEK_API_KEY",
    });
  });

  it("gives up the login and its callback port when the host goes away", async () => {
    const { deps } = await piHome();
    const login = await program();
    const child = spawn(login.node, [login.worker, login.piEntry, "login", "anthropic", "oauth"], {
      env: deps.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    // A program that failed to leave must not keep the callback port for the next test.
    cleanups.push(async () => {
      child.kill("SIGKILL");
    });
    const { lines, seen: asked } = outputLines(child, '"manual_code"');
    const { promise: exited, resolve: exit } = Promise.withResolvers<number | null>();
    child.on("exit", exit);
    child.stdin.write(`${JSON.stringify({ type: "answer", promptId: 1, value: "browser" })}\n`);
    await asked;

    child.stdin.end();

    expect(await exited).toBe(0);
    expect(JSON.parse(present(lines.at(-1), "last line"))).toStrictEqual({
      type: "failed",
      reason: "aborted",
      message: null,
    });
    expect(await portFree(53_692)).toBe(true);
  });

  it("saves an API key in pi's auth.json, readable only by the user, and removes it on logout", async () => {
    const { deps, agentDir } = await piHome();
    const login = await program();
    const seen = loginUpdates();

    await startLogin(
      login,
      deps,
      { providerId: "deepseek", method: "api_key", key: "sk-atrium-test-0001" },
      seen.listener,
    ).finished;
    const signedIn = (await readLogins(login, deps)).find(({ id }) => id === "deepseek")?.signedIn;
    const file = join(agentDir, "auth.json");
    const saved: unknown = JSON.parse(await readFile(file, "utf8"));
    const mode = (await stat(file)).mode & 0o777;
    await logout(login, deps, "deepseek");
    const afterLogout = (await readLogins(login, deps)).find(({ id }) => id === "deepseek")?.signedIn;

    expect(seen.seen).toStrictEqual([]);
    expect(signedIn).toStrictEqual({ type: "api_key", stored: true, source: "stored credential" });
    expect(saved).toStrictEqual({ deepseek: { type: "api_key", key: "sk-atrium-test-0001" } });
    expect(mode).toBe(0o600);
    expect(afterLogout).toBeNull();
  });

  it("passes on what else pi asks for an API key, and saves the answer with it", async () => {
    const { deps, agentDir } = await piHome();
    const login = await program();
    const seen = loginUpdates();

    const run = startLogin(
      login,
      deps,
      { providerId: "cloudflare-workers-ai", method: "api_key", key: "cf-atrium-test-0002" },
      seen.listener,
    );
    const question = await seen.next((update) => update.kind === "prompt");
    run.answer(promptIdOf(question), "account-0003");
    await run.finished;

    expect(question).toStrictEqual({
      kind: "prompt",
      promptId: 2,
      prompt: { kind: "text", message: "Enter Cloudflare account ID", placeholder: null, options: [] },
    });
    expect(JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8"))).toStrictEqual({
      "cloudflare-workers-ai": {
        type: "api_key",
        key: "cf-atrium-test-0002",
        env: { CLOUDFLARE_ACCOUNT_ID: "account-0003" },
      },
    });
  });

  it("chooses the browser login, gives the authorization address and the paste-back question, and frees the callback port when cancelled", async () => {
    const { deps, agentDir, open } = await piHome();
    const seen = loginUpdates();

    const run = startLogin(await program(), deps, { providerId: "anthropic", method: "oauth" }, seen.listener);
    const address = await seen.next((update) => update.kind === "event");
    const paste = await seen.next((update) => update.kind === "prompt");
    const busy = !(await portFree(53_692));
    run.cancel();
    const failure: unknown = await run.finished.catch((error: unknown) => error);

    expect(authUrlOf(address).origin).toBe("https://claude.ai");
    expect(paste).toStrictEqual({
      kind: "prompt",
      promptId: 2,
      prompt: {
        kind: "manual_code",
        message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
        placeholder: "http://localhost:53692/callback",
        options: [],
      },
    });
    expect(busy).toBe(true);
    expect(failure).toStrictEqual(new LoginError("aborted", null));
    expect(seen.seen.slice(1)).toStrictEqual([paste, { kind: "prompt_closed", promptId: 2 }]);
    expect(seen.seen[0]).toBe(address);
    expect(await portFree(53_692)).toBe(true);
    expect(open()).toBe(0);
    expect(JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8"))).toStrictEqual({});
  });

  it("gives ChatGPT's login the device id pi keeps for the terminal", async () => {
    const { deps, agentDir } = await piHome();
    const seen = loginUpdates();
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ deviceId: "6f1c1e9a-1f7e-4a7e-9a59-2f2f6c1d0b11" }),
    );

    const run = startLogin(await program(), deps, { providerId: "openai", method: "oauth" }, seen.listener);
    const first = await seen.next(() => true);
    run.cancel();
    await run.finished.catch(() => undefined);
    const address = authUrlOf(first);

    expect(address.origin).toBe("https://auth.openai.com");
    expect(address.searchParams.get("ext_agent_host_id")).toBe("urn:uuid:6f1c1e9a-1f7e-4a7e-9a59-2f2f6c1d0b11");
  });

  it("reports pi unavailable when its package cannot be loaded", async () => {
    const { deps } = await piHome();
    const login = { ...(await program()), piEntry: "file:///nonexistent-pi-for-atrium-tests/dist/index.js" };

    const failure: unknown = await readLogins(login, deps).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LoginError);
    expect(failure).toMatchObject({ reason: "unavailable" });
  });
});
