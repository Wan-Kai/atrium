import { createTempDir, writeShellPi } from "@atrium/testkit";
import { join, relative as relativePath } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { inspectPi } from "./inspect";

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
    expect(await inspectPi((await binWith()).bin, { env: {} })).toStrictEqual({ status: "missing" });
  });

  it("never looks in relative PATH entries, including the empty one that means the current directory", async () => {
    const { bin, env } = await binWith("echo 1.0.2");
    const relative = relativePath(process.cwd(), bin);

    expect(await inspectPi(`${relative}::.`, { env })).toStrictEqual({ status: "missing" });
    expect(await inspectPi(`${relative}:${bin}`, { env })).toMatchObject({ status: "ready", piPath: join(bin, "pi") });
  });

  it("reports a supported pi as ready", async () => {
    const { bin, env } = await binWith("echo 1.0.2");

    expect(await inspectPi(bin, { env })).toStrictEqual({
      status: "ready",
      piPath: join(bin, "pi"),
      version: [1, 0, 2],
    });
  });

  it("reports an older pi as outdated, with the minimum", async () => {
    const { bin, env } = await binWith("echo 0.9.5");

    expect(await inspectPi(bin, { env })).toStrictEqual({
      status: "outdated",
      piPath: join(bin, "pi"),
      version: [0, 9, 5],
      minimum: [1, 0, 1],
    });
  });

  it("reports a pi that fails to run as unusable, with its own error output", async () => {
    const { bin, env } = await binWith('echo "pi requires Node.js >= 22.19.0" >&2; exit 1');

    expect(await inspectPi(bin, { env })).toStrictEqual({
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

    expect(await inspectPi(bin, { env })).toStrictEqual({ status: "unusable", piPath: join(bin, "pi"), detail });
  });

  it("reports a pi whose output has no version as unusable", async () => {
    const { bin, env } = await binWith("echo hello");

    expect(await inspectPi(bin, { env })).toStrictEqual({
      status: "unusable",
      piPath: join(bin, "pi"),
      detail: "pi --version printed no version",
    });
  });

  it("runs pi --version with the search path as PATH, keeping the rest of the environment", async () => {
    const { bin, env } = await binWith('echo "$PATH|$GREETING" >&2; exit 1');
    const searchPath = `${bin}:/usr/bin:/bin`;

    expect(await inspectPi(searchPath, { env: { ...env, PATH: "/elsewhere", GREETING: "hi" } })).toMatchObject({
      status: "unusable",
      detail: `${searchPath}|hi`,
    });
  });

  it("gives up when aborted", async () => {
    const { bin, env } = await binWith("exec sleep 5");
    const controller = new AbortController();
    controller.abort();

    expect(await inspectPi(`${bin}:/bin:/usr/bin`, { env, signal: controller.signal })).toStrictEqual({
      status: "unusable",
      piPath: join(bin, "pi"),
      detail: "The operation was aborted",
    });
  });

  it("says when pi --version hangs past its deadline", async () => {
    const { bin, env } = await binWith("exec sleep 5");

    expect(await inspectPi(`${bin}:/bin:/usr/bin`, { env, timeoutMs: 200 })).toStrictEqual({
      status: "unusable",
      piPath: join(bin, "pi"),
      detail: "pi --version did not answer within 200 ms",
    });
  });

  it("ignores stderr that is only whitespace", async () => {
    const { bin, env } = await binWith('echo "   " >&2; exit 2');

    expect(await inspectPi(bin, { env })).toStrictEqual({
      status: "unusable",
      piPath: join(bin, "pi"),
      detail: "pi --version exited with code 2",
    });
  });
});
