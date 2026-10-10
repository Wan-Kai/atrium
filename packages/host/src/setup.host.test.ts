import { type AtriumClient, createAtriumClient } from "@atrium/client";
import type { LoginUpdatedEvent } from "@atrium/protocol";
import { createTempDir, present, writeFakePiPackage } from "@atrium/testkit";
import { chmod, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { LOGIN_WORKER as WORKER } from "../test/fake-pi-tools";
import { type TestHost, startTestHost } from "../test/harness";
import { startHost } from "./main";

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
      pi: {
        state: "ready",
        path: join(bin, "pi"),
        version: "1.0.2",
        minimum: "1.0.1",
        detail: null,
        latest: null,
        checkedAt: null,
      },
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
      piLatestUrl: null,
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

/**
 * Waits until a window shows pi asking a question in the login under way.
 *
 * @remarks
 * The login program takes a moment to start and load pi.
 *
 * @sideEffects none
 * @param client - The window's client.
 * @param message - The question.
 * @returns The login's state then, and the question's id.
 */
async function question(
  client: AtriumClient,
  message: string,
): Promise<{ state: LoginUpdatedEvent; promptId: number }> {
  return vi.waitFor(
    () => {
      const state = present(client.loginState.getState(), "a login");
      const found = present(
        state.questions.find((asked) => asked.message === message),
        message,
      );
      return { state, promptId: found.promptId };
    },
    { timeout: 10_000 },
  );
}

describe("signing in and out over the WebSocket", () => {
  it("runs a login through the installed pi, showing it in every window, and logs out", async () => {
    const { bin, home } = await installedPi();
    testHost = await startTestHost({ toolEnv: { PATH: bin, HOME: home, FAKE_PI: "complete" }, loginWorker: WORKER });
    const starter = testHost.connect();
    const other = testHost.connect();
    onTestFinished(() => starter.disconnect());
    onTestFinished(() => other.disconnect());
    await starter.connect();
    await other.connect();

    const { loginId } = await starter.login("acme", "oauth");
    const asked = await question(other, "Which?");
    await starter.answerLogin(loginId, asked.promptId, "b");
    const code = await question(starter, "Code?");
    await other.answerLogin(loginId, code.promptId, "42");
    await vi.waitFor(() => expect(other.loginState.getState()?.state).toBe("ok"), { timeout: 10_000 });

    expect(asked.state).toMatchObject({
      type: "login_updated",
      loginId,
      providerId: "acme",
      method: "oauth",
      state: "running",
      authUrl: { url: "https://acme.test/authorize", instructions: null },
    });
    expect(starter.loginState.getState()).toStrictEqual(other.loginState.getState());
    await expect(starter.cancelLogin(loginId)).rejects.toMatchObject({ code: "login_not_found" });
    await expect(starter.logout("acme")).resolves.toStrictEqual({});
  });
});

describe("installing over the WebSocket", () => {
  it("installs Node with the Homebrew found, showing its output in every window", async () => {
    const { bin, home } = await installedPi();
    await writeFile(join(bin, "brew"), '#!/bin/sh\necho "brew $*"\n');
    await chmod(join(bin, "brew"), 0o755);
    testHost = await startTestHost({ toolEnv: { PATH: bin, HOME: home, FAKE_PI: "status" }, loginWorker: WORKER });
    const starter = testHost.connect();
    const other = testHost.connect();
    onTestFinished(() => starter.disconnect());
    onTestFinished(() => other.disconnect());
    await starter.connect();
    await other.connect();

    const { jobId } = await starter.installNode();
    await vi.waitFor(() => expect(other.installJob.getState()?.job.state).toBe("ok"), { timeout: 10_000 });

    expect(other.installJob.getState()).toStrictEqual({
      job: {
        type: "install_updated",
        jobId,
        kind: "install_node",
        state: "ok",
        running: null,
        exitCode: 0,
        reason: null,
      },
      output: "brew install node\n",
    });
    expect(starter.installJob.getState()).toStrictEqual(other.installJob.getState());
    await expect(starter.cancelInstall(jobId)).rejects.toMatchObject({ code: "install_not_found" });
  });

  it("updates pi, and has found the new version by the time the update shows done", async () => {
    const { bin, home } = await installedPi();
    const pi = await realpath(join(bin, "pi"));
    await writeFile(
      pi,
      `#!/bin/sh\nif [ "$1" = update ]; then printf '#!/bin/sh\\necho 1.0.3\\n' > "${pi}"; echo updated; else echo 1.0.2; fi\n`,
    );
    testHost = await startTestHost({ toolEnv: { PATH: bin, HOME: home, FAKE_PI: "status" }, loginWorker: WORKER });
    const client = testHost.connect();
    onTestFinished(() => client.disconnect());
    await client.connect();
    expect((await client.checkSetup()).pi.version).toBe("1.0.2");

    await client.updatePi();
    await vi.waitFor(() => expect(client.installJob.getState()?.job.state).toBe("ok"), { timeout: 10_000 });

    expect(present(client.installJob.getState(), "the update").output).toBe("updated\n");
    expect((await client.checkSetup()).pi).toMatchObject({ state: "ready", version: "1.0.3" });
  });
});

/**
 * A local stand-in for pi.dev's latest-version address, giving `versions` in order.
 *
 * @remarks
 * Keeps the host off the network while it looks up the latest pi as it would at pi.dev.
 *
 * @sideEffects Listens on a port of 127.0.0.1, closed after the test.
 * @param versions - The version each request gets; the last repeats.
 * @returns The address, and how many requests came.
 */
async function latestServer(versions: readonly string[]): Promise<{ url: string; requests: () => number }> {
  let requests = 0;
  const server = createServer((_request, response) => {
    const version = versions[Math.min(requests, versions.length - 1)];
    requests += 1;
    response.end(JSON.stringify({ version }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/api/latest-version`, requests: () => requests };
}

describe("the latest pi over the WebSocket", () => {
  it("looks once started and when asked, showing what it found in every window and in the checks", async () => {
    const { url, requests } = await latestServer(["1.1.0", "1.2.0"]);
    testHost = await startTestHost({ piLatestUrl: url });
    const asker = testHost.connect();
    const other = testHost.connect();
    onTestFinished(() => asker.disconnect());
    onTestFinished(() => other.disconnect());
    await asker.connect();
    await other.connect();
    await vi.waitFor(async () => expect((await asker.checkSetup()).pi.latest).toBe("1.1.0"));

    const checked = await asker.checkPiUpdate();

    expect(checked).toStrictEqual({ latest: "1.2.0", checkedAt: expect.any(Number) as number });
    await vi.waitFor(() => expect(other.piLatest.getState()).toStrictEqual(checked));
    expect((await other.checkSetup()).pi).toMatchObject(checked);
    expect(requests()).toBe(2);
  });

  it("looks nowhere while pi is told to stay offline", async () => {
    const { url, requests } = await latestServer(["1.1.0"]);
    testHost = await startTestHost({ piLatestUrl: url, toolEnv: { PATH: "", PI_OFFLINE: "1" } });
    const client = testHost.connect();
    onTestFinished(() => client.disconnect());
    await client.connect();

    const checked = await client.checkPiUpdate();

    expect(checked).toStrictEqual({ latest: null, checkedAt: null });
    expect((await client.checkSetup()).pi).toMatchObject(checked);
    expect(requests()).toBe(0);
  });
});
