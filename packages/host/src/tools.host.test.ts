import { createTempDir, present, writeShellPi } from "@atrium/testkit";
import { execFileSync } from "node:child_process";
import { chmod, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { type TestHost, startTestHost } from "../test/harness";
import { type RunningHost, startHost } from "./main";

const TOKEN = "test-token-0123456789abcdefghijklmnopqrstuvwxyz";
/** A `sleep` unique to this test process and short-lived, so a leftover never matches or lingers. */
const HANGING = `sleep 25.${String(process.pid % 10_000).padStart(4, "0")}3`;
let testHost: TestHost | undefined;

afterEach(async () => {
  await testHost?.dispose();
  testHost = undefined;
  vi.unstubAllEnvs();
});

/** Starts a host that reads PATH from zsh, with rc files in a temporary ZDOTDIR. */
async function hostWithShell(rcFiles: Readonly<Record<string, string>>): Promise<RunningHost> {
  const dir = await createTempDir("tools");
  onTestFinished(dir.cleanup);
  for (const [name, content] of Object.entries(rcFiles)) await writeFile(join(dir.path, name), content);
  vi.stubEnv("SHELL", "/bin/zsh");
  vi.stubEnv("ZDOTDIR", dir.path);
  const host = await startHost({ home: join(dir.path, "home"), token: TOKEN, piLatestUrl: null });
  onTestFinished(() => host.close());
  return host;
}

/** A directory with a `pi` that reports `version`, and the environment that `pi` needs. */
async function fakePiBin(version: string): Promise<{ bin: string; env: Readonly<Record<string, string>> }> {
  const dir = await createTempDir("tools-bin");
  onTestFinished(dir.cleanup);
  const { env } = await writeShellPi(dir.path, `echo ${version}`);
  return { bin: dir.path, env };
}

describe("tool detection at startup", () => {
  it("scrubs credentials from the tool environment out of the host's log", async () => {
    // The PATH carries the key only so that a log line written during detection contains it.
    testHost = await startTestHost({
      toolEnv: { PATH: "/opt/sk-host-0123456789/bin", OPENAI_API_KEY: "sk-host-0123456789" },
    });

    await testHost.host.tools;
    const resolved = (await testHost.readLog()).find((record) => record["msg"] === "tool environment resolved");

    expect(resolved).toMatchObject({ path: "/opt/[redacted]/bin" });
  });

  it("logs where the proxy comes from, never its address", async () => {
    testHost = await startTestHost({ toolEnv: { PATH: "", HTTPS_PROXY: "http://127.0.0.1:7897" } });
    await testHost.host.tools;
    const client = testHost.connect();
    onTestFinished(() => client.disconnect());
    await client.connect();
    await client.setPreferences({ proxy: { url: "http://127.0.0.1:7890", noProxy: [] } });
    await client.loadSetup(true);
    await client.setPreferences({ proxy: null });
    await client.loadSetup(true);
    const quiet = await startTestHost({ toolEnv: { PATH: "" } });
    onTestFinished(() => quiet.dispose());
    await quiet.host.tools;

    const log = await testHost.readLog();
    const resolved = log.filter((record) => record["msg"] === "tool environment resolved");
    const elsewhere = (await quiet.readLog()).filter((record) => record["msg"] === "tool environment resolved");

    expect(resolved.map((record) => record["proxy"])).toStrictEqual(["shell", "setting", "shell"]);
    expect(elsewhere.map((record) => record["proxy"])).toStrictEqual(["none"]);
    expect(JSON.stringify(log)).not.toMatch(/127\.0\.0\.1:789[07]/u);
  });

  it("keeps scrubbing the credentials of an earlier environment after detecting again", async () => {
    // Read anew on each detection, as the login shell is: the user changed the key meanwhile.
    const env: Record<string, string> = { PATH: "/opt/sk-old-0123456789/bin", OPENAI_API_KEY: "sk-old-0123456789" };
    testHost = await startTestHost({ toolEnv: env });
    await testHost.host.tools;
    env["PATH"] = "/opt/sk-old-0123456789/bin:/opt/sk-new-0123456789/bin";
    env["OPENAI_API_KEY"] = "sk-new-0123456789";
    const client = testHost.connect();
    onTestFinished(() => client.disconnect());
    await client.connect();

    // A pi started before still holds the old key.
    await client.loadSetup(true);
    const resolved = (await testHost.readLog()).filter((record) => record["msg"] === "tool environment resolved");

    expect(resolved.map((record) => record["path"])).toStrictEqual([
      "/opt/[redacted]/bin",
      "/opt/[redacted]/bin:/opt/[redacted]/bin",
    ]);
  });

  it("keeps running, without pi, when detection fails unexpectedly", async () => {
    const broken: Record<string, string> = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("environment unreadable");
        },
      },
    );
    testHost = await startTestHost({ toolEnv: broken });

    expect(await testHost.host.tools).toBeNull();
    expect(await testHost.readLog()).toContainEqual(
      expect.objectContaining({ level: "error", msg: "tool detection failed" }),
    );
  });

  it("finds no pi, Node, Homebrew or fd on an empty PATH and logs that", async () => {
    const home = await createTempDir("tools-home");
    onTestFinished(home.cleanup);
    testHost = await startTestHost({ toolEnv: { PATH: "", HOME: home.path } });

    expect(await testHost.host.tools).toStrictEqual({
      env: { PATH: "", HOME: home.path },
      envSource: "configured",
      pi: { status: "missing" },
      node: { status: "missing" },
      homebrew: null,
      fd: null,
    });
    expect(await testHost.readLog()).toContainEqual(
      expect.objectContaining({ level: "warn", msg: "pi inspected", status: "missing" }),
    );
  });

  it("puts a Homebrew found outside PATH at its end, and finds the Node it installed there", async () => {
    const place = await createTempDir("tools-homebrew");
    onTestFinished(place.cleanup);
    await writeFile(join(place.path, "brew"), "#!/bin/sh\n");
    await chmod(join(place.path, "brew"), 0o755);
    await symlink(process.execPath, join(place.path, "node"));
    testHost = await startTestHost({ toolEnv: { PATH: "/nowhere" }, homebrewPlaces: [place.path] });

    const tools = present(await testHost.host.tools, "tools");

    expect(tools.env).toStrictEqual({ PATH: `/nowhere:${place.path}` });
    expect(tools.homebrew).toBe(join(place.path, "brew"));
    expect(tools.node).toMatchObject({ status: "ready", nodePath: join(place.path, "node") });
  });

  it("finds the installed pi with a configured environment", async () => {
    const env = { PATH: present(process.env["PATH"], "PATH"), HOME: present(process.env["HOME"], "HOME") };
    testHost = await startTestHost({ toolEnv: env });

    expect(await testHost.host.tools).toMatchObject({ env, envSource: "configured", pi: { status: "ready" } });
  });

  it("takes the login shell environment when none is configured, finds pi on it, and keeps it out of the log", async () => {
    const { bin, env } = await fakePiBin("1.0.2");
    const exports = Object.entries(env).map(([name, value]) => `export ${name}='${value}'\n`);
    const host = await hostWithShell({
      ".zshrc": `export PATH=${bin}:$PATH\nexport OPENAI_API_KEY=sk-from-zshrc\n${exports.join("")}`,
    });

    const tools = present(await host.tools, "tools");

    expect(tools.envSource).toBe("login-shell");
    expect(tools.env["PATH"]?.split(":")[0]).toBe(bin);
    expect(tools.env["OPENAI_API_KEY"]).toBe("sk-from-zshrc");
    expect(tools.pi).toStrictEqual({ status: "ready", piPath: join(bin, "pi"), version: [1, 0, 2] });
    await host.flushLog();
    expect(await readFile(host.logFile, "utf8")).not.toContain("sk-from-zshrc");
  });

  it("stops looking when the host closes, leaving no shell behind, and closes only once", async () => {
    const host = await hostWithShell({ ".zprofile": `${HANGING}\n`, ".zshrc": `${HANGING}\n` });
    await vi.waitFor(() => expect(host.resources.snapshot()["tools.detect"]).toBe(1));

    const started = performance.now();
    const closing = host.close();
    expect(host.close()).toBe(closing);
    await closing;

    expect(performance.now() - started).toBeLessThan(2_000);
    expect(await host.tools).toBeNull();
    expect(host.resources.snapshot()["tools.detect"]).toBe(0);
    const sleeping = execFileSync("ps", ["-A", "-o", "command="], { encoding: "utf8" })
      .split("\n")
      .filter((line) => line.trim() === HANGING);
    expect(sleeping).toStrictEqual([]);
  });
});
