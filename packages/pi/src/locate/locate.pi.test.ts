import { present } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { findPi, readPiVersion } from "./locate";
import { MIN_PI_VERSION, isAtLeast } from "./version";

describe("installed pi", () => {
  it("is found on PATH and reports a supported version", async () => {
    const piPath = present(await findPi(present(process.env["PATH"], "PATH")), "pi on PATH");

    const version = present(await readPiVersion(piPath, { env: process.env }), "pi version");

    expect(piPath).toMatch(/\/pi$/);
    expect(isAtLeast(version, MIN_PI_VERSION)).toBe(true);
  });

  it("reports nothing when the directory has no pi", async () => {
    expect(await findPi("/nonexistent-directory-for-atrium-tests")).toBeNull();
  });
});
