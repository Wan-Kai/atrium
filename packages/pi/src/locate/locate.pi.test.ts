import { installedPi, present } from "@atrium/testkit";
import { delimiter, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectPi } from "./inspect";
import { findPi, readVersion } from "./locate";
import { MIN_PI_VERSION, isAtLeast } from "./version";

/**
 * The test process's PATH with the installed pi's folder first.
 *
 * @remarks
 * The app reads PATH from the login shell; the test process's may have a shim before pi, such as
 * cmux's in its terminals, which the login shell's does not (testing.md, "端到端测试找 pi").
 *
 * @sideEffects Checks files on disk.
 * @returns The PATH.
 */
async function pathToInstalledPi(): Promise<string> {
  return [dirname(await installedPi()), present(process.env["PATH"], "PATH")].join(delimiter);
}

describe("installed pi", () => {
  it("is found on PATH and reports a supported version", async () => {
    const piPath = present(await findPi(await pathToInstalledPi()), "pi on PATH");

    const version = present(await readVersion(piPath, { env: process.env }), "pi version");

    expect(piPath).toMatch(/\/pi$/);
    expect(isAtLeast(version, MIN_PI_VERSION)).toBe(true);
  });

  it("is ready when inspected through the test process's PATH", async () => {
    const path = await pathToInstalledPi();

    const clock = {
      now: () => Date.now(),
      setTimeout: (callback: () => void, ms: number) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    };
    expect(await inspectPi(path, { env: { HOME: present(process.env["HOME"], "HOME") }, clock })).toMatchObject({
      status: "ready",
      piPath: present(await findPi(path), "pi on PATH"),
    });
  });

  it("reports nothing when the directory has no pi", async () => {
    expect(await findPi("/nonexistent-directory-for-atrium-tests")).toBeNull();
  });
});
