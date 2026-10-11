import { present } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { inspectPi } from "./inspect";
import { findPi, readVersion } from "./locate";
import { MIN_PI_VERSION, isAtLeast } from "./version";

describe("installed pi", () => {
  it("is found on PATH and reports a supported version", async () => {
    const piPath = present(await findPi(present(process.env["PATH"], "PATH")), "pi on PATH");

    const version = present(await readVersion(piPath, { env: process.env }), "pi version");

    expect(piPath).toMatch(/\/pi$/);
    expect(isAtLeast(version, MIN_PI_VERSION)).toBe(true);
  });

  it("is ready when inspected through the test process's PATH", async () => {
    const path = present(process.env["PATH"], "PATH");

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
