import type { TranscriptItem, Turn } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import {
  droppedReference,
  commandArguments,
  composeMessage,
  enterDirectory,
  filterCommands,
  groupCommands,
  historyOf,
  isLongPaste,
  lineCount,
  mentionAt,
  removeMention,
  slashQuery,
  tagCommand,
  typedMessage,
  untagCommand,
  writtenCommand,
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

describe("tagCommand and untagCommand", () => {
  it("takes the first word and one space after it out, leaving what follows for the tag's arguments", () => {
    expect(tagCommand("/rev")).toBe("");
    expect(tagCommand("/re src/a.ts")).toBe("src/a.ts");
    expect(tagCommand("/re  two spaces")).toBe(" two spaces");
  });

  it("writes the tag back as /name, a space before what followed, the caret after the name", () => {
    const tag = { source: "prompt", name: "review" } as const;

    expect(untagCommand(tag, "src/a.ts")).toStrictEqual({ text: "/review src/a.ts", caret: 7 });
    expect(untagCommand(tag, "")).toStrictEqual({ text: "/review", caret: 7 });
  });
});

describe("groupCommands", () => {
  it("puts the commands under their kinds, built-in, extension, template, skill, keeping each one's order", () => {
    const listed = [
      { name: "b", source: "skill" },
      { name: "c", source: "extension" },
      { name: "a", source: "prompt" },
      { name: "d", source: "extension" },
    ] as const;

    expect(groupCommands(listed)).toStrictEqual([
      { source: "extension", commands: [listed[1], listed[3]] },
      { source: "prompt", commands: [listed[2]] },
      { source: "skill", commands: [listed[0]] },
    ]);
    expect(groupCommands([{ name: "x", source: "builtin" }, ...listed]).map((group) => group.source)).toStrictEqual([
      "builtin",
      "extension",
      "prompt",
      "skill",
    ]);
  });
});

describe("writtenCommand and commandArguments", () => {
  it("writes a tag and its arguments as typed, and reads the arguments back", () => {
    const tag = { source: "skill", name: "skill:tdd" } as const;

    expect(writtenCommand(tag, "go on")).toBe("/skill:tdd go on");
    expect(writtenCommand(tag, "")).toBe("/skill:tdd");
    expect(writtenCommand(null, "plain")).toBe("plain");
    expect(commandArguments(tag, "/skill:tdd go on\n\nmore")).toBe("go on\n\nmore");
    expect(commandArguments(tag, "/skill:tdd")).toBe("");
    expect(commandArguments(tag, "something else")).toBe("something else");
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

  it("puts the commands that start with the query first even when pi lists them later", () => {
    const later = [
      { name: "preview", description: null, source: "prompt" as const },
      { name: "Review", description: null, source: "prompt" as const },
      { name: "skill:review-pr", description: null, source: "skill" as const },
    ];

    expect(filterCommands(later, "rev").map((command) => command.name)).toStrictEqual([
      "Review",
      "skill:review-pr",
      "preview",
    ]);
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

  it("runs a quoted @ word to its closing quote, spaces and all", () => {
    expect(mentionAt('看 @"my docs/re', 14)).toStrictEqual({ start: 2, end: 14, query: "my docs/re" });
    expect(mentionAt('x @"a b/c" y', 9)).toStrictEqual({ start: 2, end: 10, query: "a b/c" });
    expect(mentionAt('x @"a b" y', 10)).toBeNull();
  });

  it("ends a quoted @ word at the caret when its closing quote is past other words", () => {
    expect(mentionAt('看 @"my dir/ 然后说 "好"', 11)).toStrictEqual({ start: 2, end: 11, query: "my dir/" });
    expect(mentionAt('@"a b/c\n"', 7)).toStrictEqual({ start: 0, end: 7, query: "a b/c" });
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

  it("goes into a directory with a space in its name by quoting the @ word", () => {
    expect(enterDirectory("see @my now", { start: 4, end: 7, query: "my" }, "my docs/")).toStrictEqual({
      text: 'see @"my docs/ now',
      caret: 14,
    });
  });
});

describe("droppedReference", () => {
  it("is a path from the session's directory when inside it, a directory's ending in /", () => {
    expect(droppedReference("/w/src/a.ts", "/w", false)).toBe("src/a.ts");
    expect(droppedReference("/w/src", "/w", true)).toBe("src/");
    expect(droppedReference("/elsewhere/x", "/w", true)).toBe("/elsewhere/x/");
    expect(droppedReference("/w2/x", "/w", false)).toBe("/w2/x");
    expect(droppedReference("/w/x", null, false)).toBe("/w/x");
    expect(droppedReference("null/x", null, false)).toBe("null/x");
  });
});

describe("composeMessage", () => {
  it("is the text, then each pasted text, then the referenced files, a blank line apart", () => {
    expect(
      composeMessage({
        text: "Fix it  ",
        pastes: [{ id: "p1", text: "line 1\nline 2" }],
        files: ["src/a.ts", "docs/", "My Notes.md"],
        command: null,
      }),
    ).toBe('Fix it\n\nline 1\nline 2\n\n@src/a.ts @docs/ @"My Notes.md"');
  });

  it("leaves out a paste of nothing but white space", () => {
    expect(composeMessage({ text: "hi", pastes: [{ id: "p1", text: " \n " }], files: [], command: null })).toBe("hi");
  });

  it("leaves out what is empty", () => {
    expect(composeMessage({ text: "hi", pastes: [], files: [], command: null })).toBe("hi");
    expect(composeMessage({ text: " ", pastes: [], files: ["a.ts"], command: null })).toBe("@a.ts");
    expect(composeMessage({ text: "", pastes: [], files: [], command: null })).toBe("");
  });

  it("starts with the chosen command, its arguments after it", () => {
    const command = { source: "prompt", name: "review" } as const;

    expect(composeMessage({ text: "src  ", pastes: [{ id: "p1", text: "pasted" }], files: [], command })).toBe(
      "/review src\n\npasted",
    );
    expect(composeMessage({ text: " ", pastes: [], files: [], command })).toBe("/review");
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
    expect(lineCount("\na")).toBe(2);
    expect(lineCount("")).toBe(1);
  });
});

/** A turn opened by `text`. */
function turn(id: string, text: string, auto = false): Turn {
  return {
    kind: "turn",
    id,
    user: { text, images: 0, clientMessageId: null, auto, command: null, timestamp: 0 },
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
    expect(historyOf([turn("t1", "same"), turn("t2", "same"), turn("t3", "same")])).toStrictEqual(["same"]);
  });

  it("has the steers too, in the order sent", () => {
    const steered: TranscriptItem = {
      ...turn("t1", "one"),
      steps: [
        { kind: "steer", id: "s1", text: "also" },
        { kind: "text", id: "r1", text: "a reply is not sent by you" },
        { kind: "steer", id: "s2", text: "and" },
      ],
    };

    expect(historyOf([steered, turn("t2", "two")])).toStrictEqual(["two", "and", "also", "one"]);
  });

  it("has a message that started with a skill as it was typed", () => {
    const skilled: TranscriptItem = {
      ...turn("t1", "look at it"),
      user: { ...turn("t1", "look at it").user, command: { kind: "skill", name: "review" } },
    };

    expect(historyOf([turn("t0", "one"), skilled])).toStrictEqual(["/skill:review look at it", "one"]);
  });
});

describe("typedMessage", () => {
  it("is the text, or the skill it started with written as a command before it", () => {
    const skill = { kind: "skill", name: "tdd" } as const;

    expect(typedMessage({ text: "a\nb", command: null })).toBe("a\nb");
    expect(typedMessage({ text: "go on", command: skill })).toBe("/skill:tdd go on");
    expect(typedMessage({ text: "", command: skill })).toBe("/skill:tdd");
  });
});
