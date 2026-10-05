import { createTempDir, present } from "@atrium/testkit";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { type TestHost, startTestHost } from "../test/harness";
import { type RunningHost, startHost } from "./main";

const TOKEN = "test-token-0123456789abcdefghijklmnopqrstuvwxyz";
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
  const host = await startHost({ home: join(dir.path, "home"), token: TOKEN });
  onTestFinished(() => host.close());
  return host;
}

/** A directory with a fake `pi` that reports `version`. */
async function fakePiBin(version: string): Promise<string> {
  const dir = await createTempDir("tools-bin");
  onTestFinished(dir.cleanup);
  await mkdir(dir.path, { recursive: true });
  await writeFile(join(dir.path, "pi"), `#!/bin/sh\necho ${version}\n`);
  await chmod(join(dir.path, "pi"), 0o755);
  return dir.path;
}

describe("tool detection at startup", () => {
  it("finds no pi on an empty PATH and logs that", async () => {
    testHost = await startTestHost();

    expect(await testHost.host.tools).toStrictEqual({
      env: { PATH: "" },
      envSource: "configured",
      pi: { status: "missing" },
    });
    expect(await testHost.readLog()).toContainEqual(
      expect.objectContaining({ level: "warn", msg: "pi inspected", status: "missing" }),
    );
  });

  it("finds the installed pi with a configured environment", async () => {
    const env = { PATH: present(process.env["PATH"], "PATH"), HOME: present(process.env["HOME"], "HOME") };
    testHost = await startTestHost({ toolEnv: env });

    expect(await testHost.host.tools).toMatchObject({ env, envSource: "configured", pi: { status: "ready" } });
  });

  it("takes the login shell environment when none is configured, finds pi on it, and keeps it out of the log", async () => {
    const bin = await fakePiBin("1.0.2");
    const host = await hostWithShell({ ".zshrc": `export PATH=${bin}:$PATH\nexport OPENAI_API_KEY=sk-from-zshrc\n` });

    const tools = present(await host.tools, "tools");

    expect(tools.envSource).toBe("login-shell");
    expect(tools.env["PATH"]?.split(":")[0]).toBe(bin);
    expect(tools.env["OPENAI_API_KEY"]).toBe("sk-from-zshrc");
    expect(tools.pi).toStrictEqual({ status: "ready", piPath: join(bin, "pi"), version: [1, 0, 2] });
    host.flushLog();
    expect(await readFile(host.logFile, "utf8")).not.toContain("sk-from-zshrc");
  });

  it("stops looking when the host closes, leaving no shell behind, and closes only once", async () => {
    const host = await hostWithShell({ ".zprofile": "sleep 4324\n", ".zshrc": "sleep 4324\n" });
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
      .filter((line) => line.trim() === "sleep 4324");
    expect(sleeping).toStrictEqual([]);
  });
});
