import { describe, expect, it } from "vitest";
import { ancestorsOf, defaultVisualsDir, visualPlaceOf } from "./visual-place";

describe("defaultVisualsDir", () => {
  it("keeps an ordinary session's visuals in Atrium's home, one folder per session", () => {
    expect(defaultVisualsDir("/Users/me/.atrium", "019a2b3c-4d5e.6f_7")).toBe(
      "/Users/me/.atrium/visuals/019a2b3c-4d5e.6f_7",
    );
  });

  it("gives no folder to a session id that could leave it", () => {
    for (const sessionId of ["", "..", "../x", "a/b", ".hidden", "a.", "a-", "a b", "-a"]) {
      expect([sessionId, defaultVisualsDir("/h", sessionId)]).toStrictEqual([sessionId, null]);
    }
  });
});

describe("ancestorsOf", () => {
  const records: Record<string, { parent: string | null; detachedFrom?: string }> = {
    root: { parent: null },
    child: { parent: "root" },
    grandchild: { parent: "child" },
    loose: { parent: null, detachedFrom: "child" },
    loop1: { parent: "loop2" },
    loop2: { parent: "loop1" },
    orphan: { parent: "gone" },
  };
  const find = (sessionId: string) => records[sessionId];

  it("walks a session's parents, or the one it was detached from, nearest first", () => {
    expect(
      ["root", "child", "grandchild", "loose", "orphan", "nobody"].map((sessionId) => ancestorsOf(sessionId, find)),
    ).toStrictEqual([[], ["root"], ["child", "root"], ["child", "root"], ["gone"], []]);
  });

  it("goes round a loop in the records once", () => {
    expect([ancestorsOf("loop1", find), ancestorsOf("loop2", find)]).toStrictEqual([["loop2"], ["loop1"]]);
  });
});

/**
 * A session's own directory for visuals in the home `/h`.
 *
 * @remarks
 * As the host's default.
 *
 * @sideEffects none
 * @param sessionId - The session.
 * @returns The directory, or `null`.
 */
function dirOf(sessionId: string): string | null {
  return defaultVisualsDir("/h", sessionId);
}

describe("visualPlaceOf", () => {
  it("gives a session its own directory to write and its ancestors' to read, and none when it is not recorded", () => {
    const records: Record<string, { cwd: string; parent: string | null; detachedFrom?: string }> = {
      root: { cwd: "/w", parent: null },
      fork: { cwd: "/w", parent: "root" },
      "bad id": { cwd: "/w", parent: null },
      child: { cwd: "/w2", parent: "bad id" },
    };
    const find = (sessionId: string) => records[sessionId];

    expect(
      ["fork", "child", "root", "bad id", "nobody"].map((sessionId) => visualPlaceOf(sessionId, find, dirOf)),
    ).toStrictEqual([
      { cwd: "/w", dir: "/h/visuals/fork", ancestors: ["/h/visuals/root"] },
      { cwd: "/w2", dir: "/h/visuals/child", ancestors: [] },
      { cwd: "/w", dir: "/h/visuals/root", ancestors: [] },
      undefined,
      undefined,
    ]);
  });
});
