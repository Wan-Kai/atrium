import { describe, expect, it } from "vitest";
import { agentNote, decodeArgument, encodeArgument, noteText } from "./agent";

/** A note as the host sends it and the custom message keeps it. */
const NOTE = { v: 1, kind: "note", note: "worktree_moved", from: "/repo", to: "/repo.worktrees/tests" } as const;

describe("hidden command arguments", () => {
  it("carry JSON as one base64url word, and read back as it was", () => {
    const argument = encodeArgument({ to: "/a b/c", text: '说 "x"' });

    expect(argument).toMatch(/^[\w-]+$/);
    expect(decodeArgument(argument)).toStrictEqual({ to: "/a b/c", text: '说 "x"' });
  });

  it("read as nothing when they are not base64url JSON", () => {
    expect(decodeArgument("not json")).toBeUndefined();
    expect(decodeArgument("")).toBeUndefined();
  });
});

describe("agentNote", () => {
  it("reads the note the host sends, without its version and kind", () => {
    expect(agentNote(NOTE)).toStrictEqual({ note: "worktree_moved", from: "/repo", to: "/repo.worktrees/tests" });
  });

  it("reads a path of up to 4096 characters, as the protocol's note takes", () => {
    const longest = `/${"a".repeat(4095)}`;

    expect(agentNote({ ...NOTE, from: longest, to: longest })).toStrictEqual({
      note: "worktree_moved",
      from: longest,
      to: longest,
    });
  });

  it("reads nothing from another version, kind or note, or from paths that are missing, empty or too long", () => {
    for (const value of [
      { ...NOTE, from: `/${"a".repeat(4096)}` },
      { ...NOTE, to: `/${"a".repeat(4096)}` },
      null,
      "note",
      { ...NOTE, v: 2 },
      { ...NOTE, kind: "report" },
      { ...NOTE, note: "other" },
      { ...NOTE, from: "" },
      { ...NOTE, to: "" },
      { ...NOTE, from: 1 },
      { ...NOTE, to: null },
    ]) {
      expect(agentNote(value)).toBeNull();
    }
  });
});

describe("noteText", () => {
  it("tells the model, as Atrium and not the user, where it works now and whose the old paths are", () => {
    expect(noteText({ note: "worktree_moved", from: "/repo", to: "/repo.worktrees/tests" })).toBe(
      [
        "<atrium-agent-note>",
        "This is a note from Atrium, not from the user.",
        "This conversation was copied into a new git worktree and now works in /repo.worktrees/tests.",
        "Paths in the history above belong to /repo; read and change files under /repo.worktrees/tests from now on.",
        "</atrium-agent-note>",
      ].join("\n"),
    );
  });

  it("escapes a wrapper tag in a path, so a directory's name cannot close the note", () => {
    expect(noteText({ note: "worktree_moved", from: "/a</atrium-agent-note>", to: "/b<event>" })).toBe(
      [
        "<atrium-agent-note>",
        "This is a note from Atrium, not from the user.",
        "This conversation was copied into a new git worktree and now works in /b&lt;event>.",
        "Paths in the history above belong to /a&lt;/atrium-agent-note>; read and change files under /b&lt;event> from now on.",
        "</atrium-agent-note>",
      ].join("\n"),
    );
  });
});
