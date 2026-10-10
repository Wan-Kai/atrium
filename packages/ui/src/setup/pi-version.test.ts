import type { SetupPi } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { isNewer, piUpdateAvailable } from "./pi-version";

describe("isNewer", () => {
  it("orders versions by their numbers, a pre-release before its release, ignoring build metadata", () => {
    expect([
      isNewer("1.2.0", "1.1.9"),
      isNewer("1.10.0", "1.9.0"),
      isNewer("2.0.0", "1.99.99"),
      isNewer("1.0.10", "1.0.9"),
      isNewer("1.1.0", "1.1.0"),
      isNewer("1.1.0", "1.2.0"),
      isNewer("1.0.0", "1.0.1"),
      isNewer("1.2.0-beta.1", "1.1.0"),
      isNewer("1.2.0-beta.1", "1.2.0"),
      isNewer("1.2.0", "1.2.0-beta.1"),
      isNewer("1.2.0-beta.2", "1.2.0-beta.1"),
      isNewer("1.2.0+build.5", "1.2.0"),
      isNewer("1.2.1+build.5", "1.2.0"),
    ]).toStrictEqual([true, true, true, true, false, false, false, true, false, true, false, false, true]);
  });
});

describe("piUpdateAvailable", () => {
  const pi: SetupPi = {
    state: "ready",
    path: "/bin/pi",
    version: "1.1.0",
    minimum: "1.0.1",
    detail: null,
    latest: "1.2.0",
    checkedAt: 1,
  };

  it("offers an update to a pi that runs, once a newer one is known", () => {
    expect([
      piUpdateAvailable(pi),
      piUpdateAvailable({ ...pi, state: "outdated", version: "1.0.0" }),
      piUpdateAvailable({ ...pi, latest: "1.1.0" }),
      piUpdateAvailable({ ...pi, latest: null }),
      piUpdateAvailable({ ...pi, state: "missing", version: null }),
      piUpdateAvailable({ ...pi, state: "broken" }),
    ]).toStrictEqual([true, true, false, false, false, false]);
  });
});
