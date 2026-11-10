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
function dirOf(sessionId: string): { dir: string } | null {
  const dir = defaultVisualsDir("/h", sessionId);
  return dir === null ? null : { dir };
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

/**
 * A direction's check of its place, which passes.
 *
 * @remarks
 * The place itself is not checked here; `visual-file` does.
 *
 * @sideEffects none
 * @returns `true`.
 */
async function owned(): Promise<boolean> {
  return true;
}

/** The direction's sessions, as recorded where they ran. */
const RECORDS: Record<string, { cwd: string; parent: string | null }> = {
  lesson: { cwd: "/L/rust", parent: null },
  quiz: { cwd: "/L/rust", parent: "lesson" },
};

/**
 * Every session's visuals, of the direction archived.
 *
 * @remarks
 * Its directory is under `Archive/` now; the records keep the old place.
 *
 * @sideEffects none
 * @returns The directory.
 */
function archived(): { dir: string; base: string; owned: () => Promise<boolean> } {
  return { dir: "/L/Archive/rust/visuals", base: "/L/Archive/rust", owned };
}

/**
 * Every session's visuals, of the direction where it was made.
 *
 * @remarks
 * As before it was archived, or once restored.
 *
 * @sideEffects none
 * @returns The directory.
 */
function home(): { dir: string; base: string; owned: () => Promise<boolean> } {
  return { dir: "/L/rust/visuals", base: "/L/rust", owned };
}

describe("visualPlaceOf, in a direction (SPEC-0008, ML4)", () => {
  it("counts paths from where the direction is now, and maps the recorded place onto it once it moved", () => {
    const records = RECORDS;

    expect(visualPlaceOf("quiz", (id) => records[id], archived)).toStrictEqual({
      cwd: "/L/Archive/rust",
      dir: "/L/Archive/rust/visuals",
      ancestors: ["/L/Archive/rust/visuals"],
      movedFrom: "/L/rust",
      owned,
    });
    expect(visualPlaceOf("lesson", (id) => records[id], home)).toStrictEqual({
      cwd: "/L/rust",
      dir: "/L/rust/visuals",
      ancestors: [],
      owned,
    });
  });
});
