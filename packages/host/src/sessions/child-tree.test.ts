import { describe, expect, it } from "vitest";
import { type TreeEntry, ancestorsOf, archivePlan, childrenOf, descendantsOf } from "./child-tree";

/**
 * A session in a container, with its parent if it has one.
 *
 * @sideEffects none
 * @param sessionId - Its id.
 * @param containerId - Its container.
 * @param parent - Its parent's id, opened by the user; `null` for none.
 * @param archived - Whether it is archived.
 * @returns The entry.
 */
function at(sessionId: string, containerId: string, parent: string | null, archived = false): TreeEntry {
  return { sessionId, containerId, parent: parent === null ? null : { sessionId: parent, by: "user" }, archived };
}

/** main → a, b; a → a1 (another workspace) → a2; b → b1 (archived) → b2. */
const TREE = [
  at("main", "w1", null),
  at("a", "w1", "main"),
  at("b", "w1", "main"),
  at("a1", "w2", "a"),
  at("a2", "w2", "a1"),
  at("b1", "w1", "b", true),
  at("b2", "w1", "b1"),
  at("other", "w1", null),
];

/**
 * The ids of entries.
 *
 * @sideEffects none
 * @param entries - The entries.
 * @returns Their ids.
 */
const ids = (entries: readonly TreeEntry[]) => entries.map((entry) => entry.sessionId);

describe("childrenOf and descendantsOf", () => {
  it("list a session's children, and all below it parents first, archived ones too", () => {
    expect(ids(childrenOf(TREE, "main"))).toStrictEqual(["a", "b"]);
    expect(ids(descendantsOf(TREE, "main"))).toStrictEqual(["a", "b", "a1", "b1", "a2", "b2"]);
    expect(ids(descendantsOf(TREE, "a2"))).toStrictEqual([]);
  });

  it("stop where a chain of parents loops back, and never list the session itself", () => {
    const loop = [at("x", "w1", "z"), at("y", "w1", "x"), at("z", "w1", "y")];

    expect(ids(descendantsOf(loop, "x"))).toStrictEqual(["y", "z"]);
  });
});

describe("ancestorsOf", () => {
  it("lists the parents up to the top, nearest first", () => {
    expect(ancestorsOf(TREE, "a2")).toStrictEqual(["a1", "a", "main"]);
    expect(ancestorsOf(TREE, "main")).toStrictEqual([]);
    expect(ancestorsOf(TREE, "nobody")).toStrictEqual([]);
  });

  it("breaks a loop where it closes, and a chain at a parent not listed", () => {
    const loop = [at("x", "w1", "z"), at("y", "w1", "x"), at("z", "w1", "y"), at("lost", "w1", "gone")];

    expect(ancestorsOf(loop, "x")).toStrictEqual(["z", "y"]);
    // Below a loop, the loop is walked round once.
    expect(ancestorsOf([...loop, at("below", "w1", "x")], "below")).toStrictEqual(["x", "z", "y"]);
    expect(ancestorsOf(loop, "lost")).toStrictEqual([]);
  });
});

describe("archivePlan", () => {
  it("archives the descendants in the same container and detaches a branch in another, leaving what is below it", () => {
    expect(archivePlan(TREE, ["main"], "w1")).toStrictEqual({ archive: ["a", "b"], detach: ["a1"] });
  });

  it("passes over sessions archived already and those being archived, so what is below an archived one stays", () => {
    expect(archivePlan(TREE, ["b"], "w1")).toStrictEqual({ archive: [], detach: [] });
    expect(archivePlan(TREE, ["main", "a", "b", "other"], "w1")).toStrictEqual({ archive: [], detach: ["a1"] });
  });

  it("archives a child that has children of its own in the same container down to the end", () => {
    const deep = [at("p", "c", null), at("q", "c", "p"), at("r", "c", "q"), at("s", "d", "r"), at("t", "c", "s")];

    expect(archivePlan(deep, ["p"], "c")).toStrictEqual({ archive: ["q", "r"], detach: ["s"] });
  });
});
