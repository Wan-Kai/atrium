import { present } from "@atrium/testkit";
import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dirname, "..", "..", "..");
const entry = join(repo, "packages", "host", "dist", "entry.cjs");

/** Starts the built host as a plain Node process and collects its output. */
function runHost(env: Record<string, string>) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, ATRIUM_PI_LATEST_URL: "", ...env },
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
}

test("runs without Electron, serves the UI and stops cleanly on SIGTERM", async () => {
  const home = await mkdtemp(join(tmpdir(), "atrium-standalone-"));
  const host = runHost({ ATRIUM_HOME: home, ATRIUM_UI_DIR: join(repo, "packages", "ui", "dist") });

  await expect.poll(host.stdout).toContain('"type":"ready"');
  const ready = JSON.parse(present(host.stdout().split("\n")[0], "ready line")) as { url: string; token: string };
  const page = await fetch(`${ready.url}/`);
  host.child.kill("SIGTERM");

  expect([page.status, ready.token.length]).toStrictEqual([200, 43]);
  expect(await host.exited).toBe(0);
  expect(await readFile(join(home, "logs", "current.log"), "utf8")).toContain('"msg":"host stopped"');
  await rm(home, { recursive: true, force: true });
});

test("refuses a weak token from the environment", async () => {
  const home = await mkdtemp(join(tmpdir(), "atrium-standalone-"));
  const host = runHost({ ATRIUM_HOME: home, ATRIUM_TOKEN: "short" });

  expect(await host.exited).toBe(1);
  expect(host.stderr()).toContain("ATRIUM_TOKEN must be at least 32 random bytes in base64url");
  await rm(home, { recursive: true, force: true });
});
