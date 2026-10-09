import type { FileChange, TranscriptItem } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { sessionChanges } from "./session-changes";

/** A finished turn with these changes. */
function turn(id: string, changes: FileChange[]): TranscriptItem {
  return {
    kind: "turn",
    id,
    user: { text: id, images: 0, clientMessageId: null, auto: false, timestamp: 0 },
    steps: [],
    outcome: "done",
    error: null,
    startedAt: 0,
    durationMs: 1,
    usage: null,
    changes,
  };
}

describe("sessionChanges", () => {
  it("adds up each file's edits across turns, keeping the last turn that touched it", () => {
    const changes = sessionChanges([
      turn("t1", [
        { path: "a.ts", added: 3, removed: 1 },
        { path: "b.ts", added: null, removed: null },
      ]),
      { kind: "notice", id: "n1", notice: "restarted", attempt: 1, timestamp: 0 },
      turn("t2", [{ path: "a.ts", added: 2, removed: 4 }]),
      turn("t3", []),
    ]);

    expect(changes).toStrictEqual({
      added: 5,
      removed: 5,
      files: [
        { path: "a.ts", added: 5, removed: 5, written: false, turnId: "t2" },
        { path: "b.ts", added: 0, removed: 0, written: true, turnId: "t1" },
      ],
    });
  });

  it("counts a file edited after it was written as written and edited", () => {
    expect(
      sessionChanges([
        turn("t1", [{ path: "a.ts", added: null, removed: null }]),
        turn("t2", [{ path: "a.ts", added: 1, removed: 0 }]),
      ]).files,
    ).toStrictEqual([{ path: "a.ts", added: 1, removed: 0, written: true, turnId: "t2" }]);
  });

  it("is empty for a session that changed nothing", () => {
    expect(sessionChanges([turn("t1", [])])).toStrictEqual({ added: 0, removed: 0, files: [] });
  });
});
