import type { TranscriptItem } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import {
  acceptCommand,
  composeMessage,
  enterDirectory,
  filterCommands,
  historyOf,
  isLongPaste,
  lineCount,
  mentionAt,
  removeMention,
  slashQuery,
} from "./composer-text";

describe("slashQuery", () => {
  it("is what follows a / at the start, while the caret is still in that first word", () => {
    expect(slashQuery("/", 1)).toBe("");
    expect(slashQuery("/rev", 4)).toBe("rev");
    expect(slashQuery("/rev", 2)).toBe("r");
  });

  it("is nothing once past the first word, or without a / at the start", () => {
    expect(slashQuery("/review src", 11)).toBeNull();
    expect(slashQuery("a /rev", 6)).toBeNull();
    expect(slashQuery("", 0)).toBeNull();
  });
});

describe("acceptCommand", () => {
  it("puts the command in place of the first word, keeping what follows, the caret after it", () => {
    expect(acceptCommand("/rev", "review")).toStrictEqual({ text: "/review ", caret: 8 });
    expect(acceptCommand("/re src/a.ts", "review")).toStrictEqual({ text: "/review src/a.ts", caret: 8 });
  });
});

describe("filterCommands", () => {
  const commands = [
    { name: "mcp", description: "MCP servers", source: "extension" as const },
    { name: "review", description: "Reviews", source: "prompt" as const },
    { name: "skill:review-pr", description: null, source: "skill" as const },
    { name: "preview", description: null, source: "prompt" as const },
  ];

  it("keeps the commands whose name has the query, those starting with it first, ignoring case", () => {
    expect(filterCommands(commands, "REV").map((command) => command.name)).toStrictEqual([
      "review",
      "skill:review-pr",
      "preview",
    ]);
  });

  it("keeps every command, in pi's order, for an empty query", () => {
    expect(filterCommands(commands, "")).toStrictEqual(commands);
  });

  it("matches a skill by its name after skill:", () => {
    expect(filterCommands(commands, "review-").map((command) => command.name)).toStrictEqual(["skill:review-pr"]);
  });
});

describe("mentionAt", () => {
  it("is the @ word the caret is in, at the start or after a space", () => {
    expect(mentionAt("@sr", 3)).toStrictEqual({ start: 0, end: 3, query: "sr" });
    expect(mentionAt("look at @src/a and", 14)).toStrictEqual({ start: 8, end: 14, query: "src/a" });
    expect(mentionAt("look at @src/a and", 11)).toStrictEqual({ start: 8, end: 14, query: "sr" });
    expect(mentionAt("x\n@", 3)).toStrictEqual({ start: 2, end: 3, query: "" });
    // Chinese has no spaces between words: an @ right after a character starts a reference too.
    expect(mentionAt("半句话@ses", 7)).toStrictEqual({ start: 3, end: 7, query: "ses" });
    expect(mentionAt("看（@a", 4)).toStrictEqual({ start: 2, end: 4, query: "a" });
  });

  it("is nothing in a mail address, before the @, or after a space", () => {
    expect(mentionAt("me@host", 7)).toBeNull();
    expect(mentionAt("a.b@host", 8)).toBeNull();
    expect(mentionAt("x_1@host", 8)).toBeNull();
    expect(mentionAt("@src", 0)).toBeNull();
    expect(mentionAt("@src and", 8)).toBeNull();
  });
});

describe("removeMention and enterDirectory", () => {
  it("takes the @ word out, leaving the caret where it was", () => {
    expect(removeMention("see @sr now", { start: 4, end: 7, query: "sr" })).toStrictEqual({
      text: "see  now",
      caret: 4,
    });
  });

  it("goes into a directory by putting its path in the @ word", () => {
    expect(enterDirectory("see @sr now", { start: 4, end: 7, query: "sr" }, "src/")).toStrictEqual({
      text: "see @src/ now",
      caret: 9,
    });
  });
});

describe("composeMessage", () => {
  it("is the text, then each pasted text, then the referenced files, a blank line apart", () => {
    expect(
      composeMessage({
        text: "Fix it  ",
        pastes: [{ id: "p1", text: "line 1\nline 2" }],
        files: ["src/a.ts", "docs/", "My Notes.md"],
      }),
    ).toBe('Fix it\n\nline 1\nline 2\n\n@src/a.ts @docs/ @"My Notes.md"');
  });

  it("leaves out what is empty", () => {
    expect(composeMessage({ text: "hi", pastes: [], files: [] })).toBe("hi");
    expect(composeMessage({ text: " ", pastes: [], files: ["a.ts"] })).toBe("@a.ts");
    expect(composeMessage({ text: "", pastes: [], files: [] })).toBe("");
  });
});

describe("isLongPaste and lineCount", () => {
  it("collects more than 8 lines or 800 characters into a capsule", () => {
    expect(isLongPaste(Array.from({ length: 9 }, () => "x").join("\n"))).toBe(true);
    expect(isLongPaste(Array.from({ length: 8 }, () => "x").join("\n"))).toBe(false);
    expect(isLongPaste("x".repeat(801))).toBe(true);
    expect(isLongPaste("x".repeat(800))).toBe(false);
  });

  it("counts lines, a trailing line break making none", () => {
    expect(lineCount("a\nb\nc")).toBe(3);
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("a")).toBe(1);
  });
});

/** A turn opened by `text`. */
function turn(id: string, text: string, auto = false): TranscriptItem {
  return {
    kind: "turn",
    id,
    user: { text, images: 0, clientMessageId: null, auto, timestamp: 0 },
    steps: [],
    outcome: "done",
    error: null,
    startedAt: 0,
    durationMs: 1,
    usage: null,
    changes: [],
  };
}

describe("historyOf", () => {
  it("is what you sent, newest first, without the host's own messages or a repeat in a row", () => {
    const items: TranscriptItem[] = [
      turn("t1", "one"),
      { kind: "notice", id: "n1", notice: "restarted", attempt: 1, timestamp: 0 },
      turn("t2", "continue", true),
      turn("t3", "two"),
      turn("t4", "two"),
      turn("t5", "one"),
    ];

    expect(historyOf(items)).toStrictEqual(["one", "two", "one"]);
  });
});
