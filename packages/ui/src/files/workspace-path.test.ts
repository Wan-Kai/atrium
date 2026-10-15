import { describe, expect, it } from "vitest";
import { workspacePath } from "./workspace-path";

describe("workspacePath", () => {
  it("takes a relative path from the workspace, without . and empty segments, .. going up", () => {
    expect(
      ["src/api.ts", "./src//api.ts", "src/old/../api.ts", "README.md", "a/./b/"].map((path) =>
        workspacePath(path, "/w"),
      ),
    ).toStrictEqual(["src/api.ts", "src/api.ts", "src/api.ts", "README.md", "a/b"]);
  });

  it("takes an absolute path inside the workspace, whatever its directory ends with", () => {
    expect(
      [
        ["/work/atrium/src/api.ts", "/work/atrium"],
        ["/work/atrium/src/api.ts", "/work/atrium/"],
        ["/work/atrium/src/api.ts", "/work/atrium//"],
        ["/work/atrium/a/../b.ts", "/work/atrium"],
      ].map(([path = "", dir = ""]) => workspacePath(path, dir)),
    ).toStrictEqual(["src/api.ts", "src/api.ts", "src/api.ts", "b.ts"]);
  });

  it("finds none outside the workspace, from home, or for the workspace itself", () => {
    expect(
      [
        "../other/a.ts",
        "src/../../a.ts",
        "/work/atrium-two/a.ts",
        "/etc/passwd",
        "/work/atrium/../x",
        "~/notes.md",
        "~",
        "",
        ".",
        "/work/atrium/",
        "/work/atrium",
      ].map((path) => workspacePath(path, "/work/atrium")),
    ).toStrictEqual([null, null, null, null, null, null, null, null, null, null, null]);
  });
});
