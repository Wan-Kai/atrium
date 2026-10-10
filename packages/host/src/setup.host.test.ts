import { createAtriumClient } from "@atrium/client";
import { createTempDir, writeFakePiPackage } from "@atrium/testkit";
import { chmod, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { type TestHost, startTestHost } from "../test/harness";
import { startHost } from "./main";

/** The login program as tests run it: the source file in `packages/pi`, which Node runs directly. */
const WORKER = fileURLToPath(new URL("../../pi/src/auth/login-worker.ts", import.meta.url));

const TOKEN = "test-token-0123456789abcdefghijklmnopqrstuvwxyz";
let testHost: TestHost | undefined;

afterEach(async () => {
  await testHost?.dispose();
  testHost = undefined;
  vi.unstubAllEnvs();
});

/**
 * A `bin` directory with a `pi` that links into a fake pi package and a `node` that is this Node.
 *
 * @remarks
 * The package's command prints a version, so the host finds a usable pi; its entry is the fake pi
 * the login program loads. HOME is a directory of its own, so no `fd` of this machine is found.
 *
 * @sideEffects Creates a temporary directory, removed after the test.
 * @returns The directory holding `bin` and the home.
 */
async function installedPi(): Promise<{ dir: string; bin: string; home: string }> {
  const temp = await createTempDir("setup-host");
  onTestFinished(temp.cleanup);
  const dir = await realpath(temp.path);
  const fake = await writeFakePiPackage(dir);
  await writeFile(fake.cli, "#!/bin/sh\necho 1.0.2\n");
  await chmod(fake.cli, 0o755);
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  await mkdir(bin);
  await mkdir(home);
  await symlink(fake.cli, join(bin, "pi"));
  await symlink(process.execPath, join(bin, "node"));
  return { dir, bin, home };
}

const LOGINS = {
  state: "ready",
  providers: [
    {
      providerId: "acme",
      name: "Acme",
      oauth: { label: "Sign in with Acme", subscription: true },
      apiKey: true,
      signedIn: { method: "oauth", stored: true },
    },
    {
      providerId: "beta",
      name: "Beta",
      oauth: { label: "Beta OAuth", subscription: false },
      apiKey: false,
      signedIn: null,
    },
  ],
};

describe("first launch's checks over the WebSocket", () => {
  it("reports pi, Node, Homebrew, fd, the logins through the installed pi, and the projects", async () => {
    const { bin, home } = await installedPi();
    testHost = await startTestHost({ toolEnv: { PATH: bin, HOME: home, FAKE_PI: "status" }, loginWorker: WORKER });
    const client = testHost.connect();
    onTestFinished(() => client.disconnect());
    await client.connect();

    expect(await client.checkSetup()).toStrictEqual({
      pi: { state: "ready", path: join(bin, "pi"), version: "1.0.2", minimum: "1.0.1", detail: null },
      node: { state: "ready", version: process.versions.node },
      homebrew: false,
      fd: false,
      login: LOGINS,
      projects: 0,
    });
  });

  it("reads the login shell again when asked to refresh, finding the pi installed meanwhile", async () => {
    const { bin, home } = await installedPi();
    const zdotdir = await createTempDir("setup-zdotdir");
    onTestFinished(zdotdir.cleanup);
    await writeFile(
      join(zdotdir.path, ".zshrc"),
      `export PATH=/usr/bin:/bin\nexport HOME=${home}\nexport FAKE_PI=status\n`,
    );
    vi.stubEnv("SHELL", "/bin/zsh");
    vi.stubEnv("ZDOTDIR", zdotdir.path);
    // No configured environment: the host reads it from zsh, as the app does.
    const host = await startHost({
      home: join(zdotdir.path, "atrium"),
      token: TOKEN,
      homebrewPlaces: [],
      loginWorker: WORKER,
    });
    onTestFinished(() => host.close());
    const client = createAtriumClient({
      url: `ws://127.0.0.1:${host.port}`,
      token: TOKEN,
      clientId: "test-client",
      reconnectDelaysMs: [],
    });
    onTestFinished(() => client.disconnect());
    await client.connect();
    const before = await client.checkSetup();
    await writeFile(
      join(zdotdir.path, ".zshrc"),
      `export PATH=${bin}:/usr/bin:/bin\nexport HOME=${home}\nexport FAKE_PI=status\n`,
    );

    const unchanged = await client.checkSetup();
    const refreshed = await client.checkSetup(true);

    expect(before).toMatchObject({ pi: { state: "missing" }, login: { state: "unavailable" } });
    expect(unchanged).toStrictEqual(before);
    expect(refreshed).toMatchObject({
      pi: { state: "ready", path: join(bin, "pi") },
      node: { state: "ready" },
      login: LOGINS,
    });
  });
});
