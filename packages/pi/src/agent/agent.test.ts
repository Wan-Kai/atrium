import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, expectTypeOf, it } from "vitest";
import { agentNote, decodeArgument, encodeArgument, noteText } from "./agent";
import atriumAgent, { type AgentApi } from "./extension";

/** A note as the host sends it and the custom message keeps it. */
const NOTE = { v: 1, kind: "note", note: "worktree_moved", from: "/repo", to: "/repo.worktrees/tests" } as const;

/**
 * Registers the extension's part against a stand-in for pi.
 *
 * @remarks
 * Keeps the command it registered and the messages it sent, with their options.
 *
 * @sideEffects none
 * @returns The command's handler and what it sent.
 */
function registered(): { run: (args: string) => Promise<void>; names: string[]; sent: unknown[] } {
  const names: string[] = [];
  const sent: unknown[] = [];
  let handler: ((args: string) => Promise<void>) | null = null;
  atriumAgent({
    registerCommand: (name, options) => {
      names.push(`${name}: ${options.description}`);
      handler = options.handler;
    },
    sendMessage: (message, options) => sent.push([message, options]),
  });
  return {
    names,
    sent,
    run: (args) => {
      if (handler === null) throw new Error("no command registered");
      return handler(args);
    },
  };
}

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
});

describe("Atrium's extension: child conversations", () => {
  it("writes a note into the session as an atrium-agent custom message, without starting a run", async () => {
    const { run, names, sent } = registered();

    await run(`  note   ${encodeArgument(NOTE)}\n`);

    expectTypeOf<ExtensionAPI>().toExtend<AgentApi>();
    expect(names).toStrictEqual(["atrium-agent: Atrium's child conversations, sent by Atrium's host"]);
    expect(sent).toStrictEqual([
      [
        {
          customType: "atrium-agent",
          content: noteText({ note: "worktree_moved", from: "/repo", to: "/repo.worktrees/tests" }),
          display: true,
          details: NOTE,
        },
        { triggerTurn: false },
      ],
    ]);
  });

  it("does nothing for another action, a note it cannot read, or no argument", async () => {
    const { run, sent } = registered();

    await run(`deliver ${encodeArgument(NOTE)}`);
    await run(`note ${encodeArgument({ ...NOTE, v: 2 })}`);
    await run("note");
    await run("");

    expect(sent).toStrictEqual([]);
  });
});
