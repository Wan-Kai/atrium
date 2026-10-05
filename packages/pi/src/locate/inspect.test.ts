import { createTempDir } from "@atrium/testkit";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { inspectPi } from "./inspect";

/** A directory holding a fake `pi` with this shell script body, or no `pi` at all. */
async function binWith(script?: string): Promise<string> {
  const dir = await createTempDir("pi-bin");
  onTestFinished(dir.cleanup);
  if (script !== undefined) {
    await writeFile(join(dir.path, "pi"), `#!/bin/sh\n${script}\n`);
    await chmod(join(dir.path, "pi"), 0o755);
  }
  return dir.path;
}

describe("inspectPi", () => {
  it("reports pi as missing when no directory has it", async () => {
    expect(await inspectPi(await binWith(), { env: {} })).toStrictEqual({ status: "missing" });
  });

  it("reports a supported pi as ready", async () => {
    const bin = await binWith("echo 1.0.2");

    expect(await inspectPi(bin, { env: {} })).toStrictEqual({
      status: "ready",
      piPath: join(bin, "pi"),
      version: [1, 0, 2],
    });
  });

  it("reports an older pi as outdated, with the minimum", async () => {
    const bin = await binWith("echo 0.9.5");

    expect(await inspectPi(bin, { env: {} })).toStrictEqual({
      status: "outdated",
      piPath: join(bin, "pi"),
      version: [0, 9, 5],
      minimum: [1, 0, 1],
    });
  });

  it("reports a pi that fails to run as unusable, with its own error output", async () => {
    const bin = await binWith('echo "pi requires Node.js >= 22.19.0" >&2; exit 1');

    expect(await inspectPi(bin, { env: {} })).toStrictEqual({
      status: "unusable",
      piPath: join(bin, "pi"),
      detail: "pi requires Node.js >= 22.19.0",
    });
  });

  it("describes the failure itself when pi fails without saying why", async () => {
    const bin = await binWith("exit 2");

    expect(await inspectPi(bin, { env: {} })).toMatchObject({
      status: "unusable",
      detail: expect.stringContaining("Command failed"),
    });
  });

  it("reports a pi whose output has no version as unusable", async () => {
    const bin = await binWith("echo hello");

    expect(await inspectPi(bin, { env: {} })).toStrictEqual({
      status: "unusable",
      piPath: join(bin, "pi"),
      detail: "pi --version printed no version",
    });
  });

  it("runs pi --version with the search path as PATH, keeping the rest of the environment", async () => {
    const bin = await binWith('echo "$PATH|$GREETING" >&2; exit 1');
    const searchPath = `${bin}:/usr/bin:/bin`;

    expect(await inspectPi(searchPath, { env: { PATH: "/elsewhere", GREETING: "hi" } })).toMatchObject({
      status: "unusable",
      detail: `${searchPath}|hi`,
    });
  });

  it("gives up when aborted", async () => {
    const bin = await binWith("sleep 5; echo 1.0.2");
    const controller = new AbortController();
    controller.abort();

    expect(await inspectPi(bin, { env: {}, signal: controller.signal })).toMatchObject({
      status: "unusable",
      detail: expect.stringContaining("abort"),
    });
  });
});
