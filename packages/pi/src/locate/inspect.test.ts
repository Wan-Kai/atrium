import { FakeClock, createTempDir, writeShellPi } from "@atrium/testkit";
import { execFileSync } from "node:child_process";
import { join, relative as relativePath } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { PiDeps } from "../deps";
import { inspectPi } from "./inspect";

const clock: PiDeps["clock"] = {
  now: () => Date.now(),
  setTimeout(callback, ms) {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

/** Running processes whose whole command line is `command`. */
function running(command: string): string[] {
  return execFileSync("ps", ["-A", "-o", "command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.trim() === command);
}

/** A directory holding a `pi` that runs this shell script body, or no `pi` at all, and the env it needs. */
async function binWith(body?: string): Promise<{ bin: string; env: Readonly<Record<string, string>> }> {
  const dir = await createTempDir("pi-bin");
  onTestFinished(dir.cleanup);
  if (body === undefined) return { bin: dir.path, env: {} };
  const { env } = await writeShellPi(dir.path, body);
  return { bin: dir.path, env };
}

describe("inspectPi", () => {
  it("reports pi as missing when no directory has it", async () => {
    expect(await inspectPi((await binWith()).bin, { env: {}, clock })).toStrictEqual({ status: "missing" });
  });

  it("never looks in relative PATH entries, including the empty one that means the current directory", async () => {
    const { bin, env } = await binWith("echo 1.0.2");
    const relative = relativePath(process.cwd(), bin);

    expect(await inspectPi(`${relative}::.`, { env, clock })).toStrictEqual({ status: "missing" });
    expect(await inspectPi(`${relative}:${bin}`, { env, clock })).toMatchObject({
      status: "ready",
      piPath: join(bin, "pi"),
    });
  });

  it("reports a supported pi as ready", async () => {
    const { bin, env } = await binWith("echo 1.0.2");

    expect(await inspectPi(bin, { env, clock })).toStrictEqual({
      status: "ready",
      piPath: join(bin, "pi"),
      version: [1, 0, 2],
    });
  });

  it("reports an older pi as outdated, with the minimum", async () => {
    const { bin, env } = await binWith("echo 0.9.5");

    expect(await inspectPi(bin, { env, clock })).toStrictEqual({
      status: "outdated",
      piPath: join(bin, "pi"),
      version: [0, 9, 5],
      minimum: [1, 0, 1],
    });
  });

  it("reports a pi that fails to run as unusable, with its own error output", async () => {
    const { bin, env } = await binWith('echo "pi requires Node.js >= 22.19.0" >&2; exit 1');

    expect(await inspectPi(bin, { env, clock })).toStrictEqual({
      status: "unusable",
      piPath: join(bin, "pi"),
      detail: "pi requires Node.js >= 22.19.0",
    });
  });

  it.each([
    ["exits silently", "exit 2", "pi --version exited with code 2"],
    ["is killed", "kill -TERM $$", "pi --version was stopped by SIGTERM"],
  ])("says how pi failed when it %s without explaining", async (_case, script, detail) => {
    const { bin, env } = await binWith(script);

    expect(await inspectPi(bin, { env, clock })).toStrictEqual({ status: "unusable", piPath: join(bin, "pi"), detail });
  });

  it("reports a pi whose output has no version as unusable", async () => {
    const { bin, env } = await binWith("echo hello");

    expect(await inspectPi(bin, { env, clock })).toStrictEqual({
      status: "unusable",
      piPath: join(bin, "pi"),
      detail: "pi --version printed no version",
    });
  });

  it("runs pi --version with the search path as PATH, keeping the rest of the environment", async () => {
    const { bin, env } = await binWith('echo "$PATH|$GREETING" >&2; exit 1');
    const searchPath = `${bin}:/usr/bin:/bin`;

    expect(await inspectPi(searchPath, { env: { ...env, PATH: "/elsewhere", GREETING: "hi" }, clock })).toMatchObject({
      status: "unusable",
      detail: `${searchPath}|hi`,
    });
  });

  it("gives up when aborted", async () => {
    const { bin, env } = await binWith("exec sleep 5");
    const controller = new AbortController();
    controller.abort();

    expect(await inspectPi(`${bin}:/bin:/usr/bin`, { env, clock, signal: controller.signal })).toStrictEqual({
      status: "unusable",
      piPath: join(bin, "pi"),
      detail: "pi --version was cancelled",
    });
  });

  it("kills a pi --version that hangs past its deadline on the injected clock, even if it ignores SIGTERM", async () => {
    // The shell itself hangs and ignores SIGTERM; the loop ends on its own after 20 s at most.
    const { bin, env } = await binWith("trap '' TERM; i=0; while [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done");
    const hang = `/bin/sh ${join(bin, "pi")} --version`;
    const fake = new FakeClock();

    const inspecting = inspectPi(`${bin}:/bin:/usr/bin`, { env, clock: fake, timeoutMs: 200 });
    await vi.waitFor(() => expect(fake.pendingTimers()).toBe(1));
    fake.advance(200);

    expect(await inspecting).toStrictEqual({
      status: "unusable",
      piPath: join(bin, "pi"),
      detail: "pi --version did not answer within 200 ms",
    });
    expect(fake.pendingTimers()).toBe(0);
    // Gone for real: an aborted execFile returns at once, so only SIGKILL guarantees it.
    await vi.waitFor(() => expect(running(hang)).toStrictEqual([]));
  });

  it("never gives pi --version a relative PATH entry, where a planted node could be found", async () => {
    const { bin, env } = await binWith('echo "$PATH" >&2; exit 1');

    expect(await inspectPi(`.::${bin}:bin:/usr/bin`, { env, clock })).toMatchObject({
      status: "unusable",
      detail: `${bin}:/usr/bin`,
    });
  });

  it("ignores stderr that is only whitespace", async () => {
    const { bin, env } = await binWith('echo "   " >&2; exit 2');

    expect(await inspectPi(bin, { env, clock })).toStrictEqual({
      status: "unusable",
      piPath: join(bin, "pi"),
      detail: "pi --version exited with code 2",
    });
  });
});
