import { describe, expect, it } from "vitest";
import {
  type TreeSession,
  chainOf,
  childrenOf,
  crumbsOf,
  descendantsOf,
  heldIn,
  rowStatus,
  tabStatus,
} from "./children";

/**
 * A session with its parent, if it has one, and what it is doing.
 *
 * @sideEffects none
 * @param sessionId - Its id.
 * @param parent - Its parent's id; `null` for none.
 * @param fields - Its other fields: updated when, archived, running, asking, attention, what the
 * agent says of it, deliveries held.
 * @returns The session.
 */
function at(sessionId: string, parent: string | null, fields: Partial<TreeSession> = {}): TreeSession {
  return {
    sessionId,
    parent: parent === null ? null : { sessionId: parent, by: "user" },
    archived: false,
    updatedAt: 0,
    asking: null,
    attention: null,
    running: false,
    agent: null,
    heldDeliveries: 0,
    ...fields,
  };
}

/**
 * The ids of sessions.
 *
 * @sideEffects none
 * @param sessions - The sessions.
 * @returns Their ids.
 */
const ids = (sessions: readonly TreeSession[]) => sessions.map((session) => session.sessionId);

describe("childrenOf and descendantsOf", () => {
  it("list a session's children not archived, the latest updated first, and all below it", () => {
    const sessions = [
      at("main", null),
      at("a", "main", { updatedAt: 1 }),
      at("b", "main", { updatedAt: 3 }),
      at("gone", "main", { archived: true }),
      at("a1", "a"),
      at("under-gone", "gone"),
    ];

    expect(ids(childrenOf(sessions, "main"))).toStrictEqual(["b", "a"]);
    expect(ids(descendantsOf(sessions, "main"))).toStrictEqual(["b", "a", "a1"]);
  });

  it("never list a session named its own parent as its own child", () => {
    expect(ids(childrenOf([at("x", "x"), at("y", "x")], "x"))).toStrictEqual(["y"]);
  });

  it("stop where a chain of parents loops back", () => {
    const loop = [at("x", "z"), at("y", "x"), at("z", "y")];

    expect(ids(descendantsOf(loop, "x"))).toStrictEqual(["y", "z"]);
  });
});

describe("rowStatus and tabStatus", () => {
  const asking = at("asking", "a", { asking: 5 });
  const running = at("running", "main", { running: true });
  const sessions = [at("main", null), at("a", "main"), asking, running];

  it("give a row the highest status of its subtree, running included", () => {
    expect([rowStatus(sessions, at("a", "main")), rowStatus(sessions, running)]).toStrictEqual(["asking", "running"]);
    expect(rowStatus([at("quiet", null)], at("quiet", null))).toBeNull();
  });

  it("raise a tab by a descendant asking, waiting for a sign-in or failed, never by one running", () => {
    expect(tabStatus(sessions, at("main", null))).toBe("asking");
    expect(tabStatus([at("main", null), running], at("main", null))).toBeNull();
    expect(
      tabStatus(
        [at("main", null), at("e", "main", { attention: { reason: "auth", at: 1, cleared: false } })],
        at("main", null, { running: true }),
      ),
    ).toBe("auth");
  });
});

describe("a child asking its parent's agent", () => {
  /** A child the agent opened, in a run, waiting for its parent's agent to answer. */
  const waiting = at("w", "main", {
    running: true,
    agent: {
      handle: "w",
      role: "work",
      status: "waiting_for_parent",
      progress: null,
      question: "vitest?",
      taskId: null,
      taskStartedAt: null,
    },
  });

  it("shows in its row as a question, below an error, and does not raise the tab", () => {
    const failed = at("w", "main", { ...waiting, attention: { reason: "error", at: 1, cleared: false } });

    expect([
      rowStatus([at("main", null), waiting], waiting),
      rowStatus(
        [at("main", null), at("a", "main"), { ...waiting, parent: { sessionId: "a", by: "agent" } }],
        at("a", "main"),
      ),
      rowStatus([at("main", null), failed], failed),
      rowStatus([at("main", null), { ...waiting, running: false }], { ...waiting, running: false }),
      tabStatus([at("main", null), waiting], at("main", null)),
    ]).toStrictEqual(["asking", "asking", "error", "asking", null]);
  });
});

describe("heldIn", () => {
  it("adds the deliveries held in a session and all below it, and none elsewhere", () => {
    const sessions = [
      at("main", null, { heldDeliveries: 1 }),
      at("a", "main", { heldDeliveries: 2 }),
      at("b", "a", { heldDeliveries: 4 }),
      at("other", null, { heldDeliveries: 8 }),
    ];

    expect([heldIn(sessions, "main"), heldIn(sessions, "a"), heldIn(sessions, "gone")]).toStrictEqual([7, 6, 0]);
  });
});

describe("chainOf and crumbsOf", () => {
  it("chain a session up to its top ancestor, breaking a loop and stopping at a parent not listed", () => {
    const sessions = [at("root", null), at("a", "root"), at("b", "a"), at("c", "b"), at("lost", "gone")];
    const loop = [at("x", "z"), at("y", "x"), at("z", "y")];

    expect(ids(chainOf(sessions, "c"))).toStrictEqual(["root", "a", "b", "c"]);
    expect(ids(chainOf(sessions, "lost"))).toStrictEqual(["lost"]);
    expect(ids(chainOf(sessions, "nobody"))).toStrictEqual([]);
    expect(ids(chainOf(loop, "x"))).toStrictEqual(["y", "z", "x"]);
  });

  it("fold the middle levels of a chain over three into one part", () => {
    expect(crumbsOf(["root", "a", "b"])).toStrictEqual([{ session: "root" }, { session: "a" }, { session: "b" }]);
    expect(crumbsOf(["root", "a", "b", "c"])).toStrictEqual([
      { session: "root" },
      { folded: ["a"] },
      { session: "b" },
      { session: "c" },
    ]);
    expect(crumbsOf(["root", "a", "b", "c", "d"])).toStrictEqual([
      { session: "root" },
      { folded: ["a", "b"] },
      { session: "c" },
      { session: "d" },
    ]);
  });
});
