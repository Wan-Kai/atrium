import { createTempDir, writeShellPi } from "@atrium/testkit";
import { getEventListeners } from "node:events";
import { describe, expect, it, onTestFinished } from "vitest";
import { readPiVersion } from "./locate";

/** A `pi` that runs this shell script body, and the env it needs. */
async function shellPi(body: string): Promise<{ piPath: string; env: Readonly<Record<string, string>> }> {
  const dir = await createTempDir("pi-bin");
  onTestFinished(dir.cleanup);
  return writeShellPi(dir.path, body);
}

describe("readPiVersion", () => {
  it("reads the version without an abort signal", async () => {
    const { piPath, env } = await shellPi("echo 1.0.2");

    expect(await readPiVersion(piPath, { env: { ...env, PATH: "/usr/bin:/bin" } })).toStrictEqual([1, 0, 2]);
  });

  it("removes its abort listener once pi has answered or failed", async () => {
    const ok = await shellPi("echo 1.0.2");
    const failing = await shellPi("exit 2");
    const controller = new AbortController();

    await readPiVersion(ok.piPath, { env: { ...ok.env, PATH: "/usr/bin:/bin" }, signal: controller.signal });
    await expect(
      readPiVersion(failing.piPath, { env: { ...failing.env, PATH: "/usr/bin:/bin" }, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 2 });

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
