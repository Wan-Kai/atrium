import { describe, expect, it } from "vitest";
import type { IndexFileSpec } from "./index-file";
import {
  CHATS_FILE,
  layoutsFile,
  PREFERENCES_FILE,
  PROJECTS_FILE,
  SESSIONS_FILE,
  turnStartsFile,
} from "./index-schema";

/**
 * A sessions document with one child conversation's record.
 *
 * @sideEffects none
 * @param by - Who its parent says opened it.
 * @returns The document.
 */
function withParent(by: string) {
  return {
    ...SESSIONS_FILE.empty(),
    sessions: [
      {
        sessionId: "c1",
        containerId: "wks_a",
        cwd: "/a",
        draft: false,
        archived: false,
        createdAt: 0,
        parent: { sessionId: "s1", by },
      },
    ],
  };
}

describe("the index's file specs", () => {
  it.each<[string, IndexFileSpec<object>]>([
    ["projects", PROJECTS_FILE],
    ["sessions", SESSIONS_FILE],
    ["chats", CHATS_FILE],
    ["layouts", layoutsFile({ sessions: [] })],
    ["preferences", PREFERENCES_FILE],
    ["turns", turnStartsFile("s1")],
  ])("start %s with a document their schema accepts, so it loads again once written", (_name, spec) => {
    const empty = spec.empty();

    expect(spec.schema.safeParse(empty)).toStrictEqual({ success: true, data: empty });
  });

  it("keeps a child conversation's record, opened by the user or an agent, and nothing else as its parent (SPEC-0002)", () => {
    expect(
      [withParent("user"), withParent("agent"), withParent("someone")].map(
        (doc) => SESSIONS_FILE.schema.safeParse(doc).success,
      ),
    ).toStrictEqual([true, true, false]);
  });
});
