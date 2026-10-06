import { describe, expect, it } from "vitest";
import { absolutePathEntries, piEnvironment } from "./pi-env";

describe("absolutePathEntries", () => {
  it("keeps absolute directories in order and drops relative and empty entries", () => {
    expect(absolutePathEntries(":.:/usr/local/bin:bin:/usr/bin::./tools:/bin:")).toBe("/usr/local/bin:/usr/bin:/bin");
  });
});

describe("piEnvironment", () => {
  it("merges the parts, later ones winning, without Atrium's and Electron's variables or unset values", () => {
    expect(
      piEnvironment(
        { PATH: ".:/usr/bin", HOME: "/home/a", ATRIUM_TOKEN: "secret", ELECTRON_RUN_AS_NODE: "1", UNSET: undefined },
        { HOME: "/home/b", FAUX: "x", ATRIUM_FAUX: "y" },
      ),
    ).toStrictEqual({ PATH: "/usr/bin", HOME: "/home/b", FAUX: "x" });
  });

  it("leaves PATH out when no part has one", () => {
    expect(piEnvironment({ HOME: "/h" })).toStrictEqual({ HOME: "/h" });
  });
});
