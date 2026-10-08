import type { AssistantPart, LogEntry } from "@atrium/pi";
import type { TranscriptItem, Turn } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { fixtureEntries } from "../../test/pi-fixtures";
import { projectTranscript } from "./projection";
import { createSessionLog } from "./session-log";
import type { TurnFacts } from "./turn-draft";

const none: ReadonlyMap<string, TurnFacts> = new Map();

/** The recorded history session's branch ending at `leaf`. */
function recordedBranch(leaf: string): LogEntry[] {
  const log = createSessionLog();
  log.append(fixtureEntries("history").entries, leaf);
  return log.branch();
}

/** A user message entry. */
function user(id: string, text: string, timestamp = 0): LogEntry {
  return { id, parentId: null, kind: "user", text, images: 0, timestamp };
}

/** An assistant message entry. */
function reply(
  id: string,
  parts: AssistantPart[],
  fields: {
    stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
    error?: string;
    timestamp?: number;
    usage?: [number, number];
  } = {},
): LogEntry {
  const [input, output] = fields.usage ?? [0, 0];
  return {
    id,
    parentId: null,
    kind: "assistant",
    parts,
    stopReason: fields.stopReason ?? "stop",
    errorMessage: fields.error ?? null,
    usage: { input, output },
    timestamp: fields.timestamp ?? 0,
  };
}

/** A tool result entry. */
function result(id: string, callId: string, text: string, isError = false, timestamp = 0): LogEntry {
  return { id, parentId: null, kind: "toolResult", callId, tool: "bash", text, isError, details: undefined, timestamp };
}

/** A text block. */
function says(value: string): AssistantPart {
  return { type: "text", text: value };
}

/** An entry that takes a failed reply out of the context. */
function omit(id: string, targetId: string): LogEntry {
  return { id, parentId: null, timestamp: 0, kind: "omission", targetId };
}

/** A compaction entry, summarized as its own id. */
function compaction(id: string): LogEntry {
  return { id, parentId: null, timestamp: 4, kind: "compaction", summary: id, tokensBefore: 9 };
}

/** The kinds of each item's steps; a notice has none. */
function stepKinds(items: readonly TranscriptItem[]): string[][] {
  return items.map((item) => (item.kind === "turn" ? item.steps.map((step) => step.kind) : []));
}

/** A bash call block. */
function bash(callId: string, command = "ls"): AssistantPart {
  return { type: "toolCall", callId, tool: "bash", args: { command } };
}

/** A finished turn opened by `entryId` in session `s`, with the given fields. */
function turn(entryId: string, userText: string, fields: Partial<Turn>): Turn {
  return {
    kind: "turn",
    id: `s:${entryId}`,
    user: { text: userText, images: 0, clientMessageId: null, timestamp: 0 },
    steps: [],
    outcome: "done",
    error: null,
    startedAt: 0,
    durationMs: 0,
    usage: { input: 0, output: 0 },
    changes: [],
    ...fields,
  };
}

/** The first turn of the recorded history: thinking, four tools and the answer. */
const firstTurn = turn("e6", "one", {
  steps: [
    { kind: "thinking", id: "0", text: "Look first.", durationMs: null },
    {
      kind: "tool",
      id: "1",
      callId: "call-1",
      tool: "bash",
      args: { command: "printf 'tool-%s' ok" },
      status: "done",
      output: { text: "tool-ok", truncated: false },
      details: { tool: "bash", command: "printf 'tool-%s' ok" },
    },
    {
      kind: "tool",
      id: "2",
      callId: "call-2",
      tool: "write",
      args: { path: "notes.txt", content: "a\nb\n" },
      status: "done",
      output: { text: "Successfully wrote to notes.txt", truncated: false },
      details: { tool: "write", path: "notes.txt", content: "a\nb\n" },
    },
    {
      kind: "tool",
      id: "3",
      callId: "call-3",
      tool: "edit",
      args: { path: "notes.txt", edits: [{ oldText: "b", newText: "c\nd" }] },
      status: "done",
      output: { text: "Successfully replaced 1 block(s) in notes.txt.", truncated: false },
      details: { tool: "edit", path: "notes.txt", diff: " 1 a\n-2 b\n+2 c\n+3 d", added: 2, removed: 1 },
    },
    {
      kind: "tool",
      id: "4",
      callId: "call-4",
      tool: "read",
      args: { path: "notes.txt", offset: 2, limit: 1 },
      status: "done",
      output: { text: "c\n\n[2 more lines in file. Use offset=3 to continue.]", truncated: false },
      details: { tool: "read", path: "notes.txt", offset: 2, limit: 1 },
    },
    { kind: "text", id: "5", text: "first answer" },
  ],
  // Written first, so its line counts are unknown.
  changes: [{ path: "notes.txt", added: null, removed: null }],
});

describe("projectTranscript on a recorded session", () => {
  it("rebuilds the branch with a retry and a compaction between turns", () => {
    expect(projectTranscript(recordedBranch("e20"), "s", none)).toStrictEqual({
      items: [
        firstTurn,
        turn("e16", "two", {
          steps: [
            { kind: "retry", id: "0", attempt: 1, error: "upstream returned 503 service unavailable" },
            { kind: "text", id: "1", text: "second answer" },
          ],
        }),
        {
          kind: "notice",
          id: "s:e18",
          notice: "compacted",
          tokensBefore: 0,
          summary:
            "A short summary.\n\n---\n\n**Turn Context (split turn):**\n\nThe turn so far.\n\n<modified-files>\nnotes.txt\n</modified-files>",
          timestamp: 0,
        },
        turn("e19", "three", { steps: [{ kind: "text", id: "0", text: "third answer" }] }),
      ],
      turnEntryIds: ["e6", "e16", "e19"],
    });
  });

  it("rebuilds the branch pi navigated to, without the turns of the other one", () => {
    expect(projectTranscript(recordedBranch("e22"), "s", none)).toStrictEqual({
      items: [
        firstTurn,
        turn("e21", "two, differently", { steps: [{ kind: "text", id: "0", text: "branch answer" }] }),
      ],
      turnEntryIds: ["e6", "e21"],
    });
  });
});

describe("projectTranscript", () => {
  it("has no items for a session without messages", () => {
    expect(projectTranscript([{ id: "m", parentId: null, timestamp: 0, kind: "other" }], "s", none)).toStrictEqual({
      items: [],
      turnEntryIds: [],
    });
  });

  it("makes a user message right after a tool result a steer, and any other one a new turn", () => {
    const { items } = projectTranscript(
      [
        user("u1", "go"),
        reply("a1", [bash("c1")], { stopReason: "toolUse" }),
        result("r1", "c1", "out"),
        user("u2", "also check b"),
        reply("a2", [says("done")]),
        user("u3", "next"),
        reply("a3", [says("ok")]),
      ],
      "s",
      none,
    );

    expect(stepKinds(items)).toStrictEqual([["tool", "steer", "text"], ["text"]]);
    expect((items[0] as Turn).steps[1]).toStrictEqual({ kind: "steer", id: "1", text: "also check b" });
  });

  it("numbers retries as pi does: consecutive failures count up, a success resets", () => {
    const { items } = projectTranscript(
      [
        user("u1", "go"),
        reply("f1", [], { stopReason: "error", error: "503" }),
        omit("o1", "f1"),
        reply("f2", [says("par")], { stopReason: "error", error: "overloaded" }),
        omit("o2", "f2"),
        reply("a1", [bash("c1")], { stopReason: "toolUse" }),
        result("r1", "c1", "x"),
        reply("f3", [], { stopReason: "error", error: "503" }),
        omit("o3", "f3"),
        reply("a2", [says("done")]),
      ],
      "s",
      none,
    );

    expect((items[0] as Turn).steps).toStrictEqual([
      { kind: "retry", id: "0", attempt: 1, error: "503" },
      // What the failed reply had already said stays, and the retry follows it.
      { kind: "text", id: "1", text: "par" },
      { kind: "retry", id: "2", attempt: 2, error: "overloaded" },
      expect.objectContaining({ kind: "tool", id: "3", status: "done" }),
      { kind: "retry", id: "4", attempt: 1, error: "503" },
      { kind: "text", id: "5", text: "done" },
    ]);
  });

  it("starts counting retries again in every turn", () => {
    const { items } = projectTranscript(
      [
        user("u1", "one"),
        reply("f1", [], { stopReason: "error", error: "503" }),
        omit("o1", "f1"),
        reply("f2", [], { stopReason: "error", error: "503" }),
        user("u2", "two"),
        reply("f3", [], { stopReason: "error", error: "503" }),
        omit("o3", "f3"),
        reply("a1", [says("ok")]),
      ],
      "s",
      none,
    );

    expect(items.map((item) => (item as Turn).steps.filter((step) => step.kind === "retry"))).toStrictEqual([
      [{ kind: "retry", id: "0", attempt: 1, error: "503" }],
      [{ kind: "retry", id: "0", attempt: 1, error: "503" }],
    ]);
    expect(items[0]).toMatchObject({ outcome: "failed", error: "503" });
  });

  it("does not take a reply that was taken out of the context but had not failed for a retry", () => {
    const { items } = projectTranscript(
      [
        user("u1", "go"),
        reply("a1", [says("hi")]),
        { id: "o1", parentId: null, timestamp: 0, kind: "omission", targetId: "a1" },
      ],
      "s",
      none,
    );

    expect((items[0] as Turn).steps).toStrictEqual([{ kind: "text", id: "0", text: "hi" }]);
  });

  it("puts a compaction during a turn after it, and one before any turn in place", () => {
    const { items } = projectTranscript(
      [
        compaction("k0"),
        user("u1", "go"),
        reply("a1", [bash("c1")], { stopReason: "toolUse" }),
        compaction("k1"),
        result("r1", "c1", "x"),
        reply("a2", [says("done")]),
        user("u2", "next"),
      ],
      "s",
      none,
    );

    expect(items.map((item) => item.id)).toStrictEqual(["s:k0", "s:u1", "s:k1", "s:u2"]);
    expect(items[0]).toStrictEqual({
      kind: "notice",
      id: "s:k0",
      notice: "compacted",
      tokensBefore: 9,
      summary: "k0",
      timestamp: 4,
    });
    expect((items[1] as Turn).steps.map((step) => step.kind)).toStrictEqual(["tool", "text"]);
  });

  it("skips replies before any user message and results of calls it never saw", () => {
    const { items } = projectTranscript(
      [reply("a0", [says("orphan")]), user("u1", "go"), result("r0", "nope", "x"), reply("a1", [says("hi")])],
      "s",
      none,
    );

    expect(items).toStrictEqual([turn("u1", "go", { steps: [{ kind: "text", id: "0", text: "hi" }] })]);
  });

  it("ends a turn by its last reply: tools without a result unfinished, a stopped reply stopped", () => {
    const { items } = projectTranscript(
      [
        user("u1", "go"),
        reply("a1", [bash("c1"), bash("c2")], { stopReason: "toolUse" }),
        result("r1", "c2", "boom", true),
        reply("a2", [], { stopReason: "aborted", error: "Request was aborted" }),
        user("u2", "no reply"),
      ],
      "s",
      none,
    );

    expect(items).toStrictEqual([
      turn("u1", "go", {
        steps: [
          {
            kind: "tool",
            id: "0",
            callId: "c1",
            tool: "bash",
            args: { command: "ls" },
            status: "unfinished",
            output: null,
            details: { tool: "bash", command: "ls" },
          },
          {
            kind: "tool",
            id: "1",
            callId: "c2",
            tool: "bash",
            args: { command: "ls" },
            status: "failed",
            output: { text: "boom", truncated: false },
            details: { tool: "bash", command: "ls" },
          },
        ],
        outcome: "stopped",
      }),
      turn("u2", "no reply", { outcome: "stopped", usage: null }),
    ]);
  });

  it("works out duration from the messages' times and adds up every reply's tokens", () => {
    const { items } = projectTranscript(
      [
        user("u1", "go", 1_000),
        reply("a1", [bash("c1")], { stopReason: "toolUse", timestamp: 1_500, usage: [100, 10] }),
        result("r1", "c1", "x", false, 4_000),
        reply("a2", [says("done")], { timestamp: 6_250, usage: [200, 20] }),
      ],
      "s",
      none,
    );

    expect(items[0]).toMatchObject({ startedAt: 1_000, durationMs: 5_250, usage: { input: 300, output: 30 } });
  });

  it("gives a turn seen live its id, clientMessageId and the timings measured then", () => {
    const facts: TurnFacts = {
      turnId: "live-7",
      clientMessageId: "client-3",
      durationMs: 42,
      thinkingMs: new Map([["0", 1_200]]),
    };
    const { items, turnEntryIds } = projectTranscript(
      [
        user("u1", "go", 1_000),
        reply("a1", [{ type: "thinking", text: "hm" }, { type: "thinking", text: "more" }, says("done")], {
          timestamp: 9_000,
        }),
      ],
      "s",
      new Map([["u1", facts]]),
    );

    expect(items).toStrictEqual([
      {
        ...turn("u1", "go", {}),
        id: "live-7",
        user: { text: "go", images: 0, clientMessageId: "client-3", timestamp: 1_000 },
        startedAt: 1_000,
        durationMs: 42,
        steps: [
          { kind: "thinking", id: "0", text: "hm", durationMs: 1_200 },
          { kind: "thinking", id: "1", text: "more", durationMs: null },
          { kind: "text", id: "2", text: "done" },
        ],
      },
    ]);
    expect(turnEntryIds).toStrictEqual(["u1"]);
  });
});
