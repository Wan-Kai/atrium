import type { AssistantPart, LogEntry } from "@atrium/pi";
import type { Step, TranscriptItem, Turn } from "@atrium/protocol";
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
function user(id: string, text: string, timestamp = 0, skill: string | null = null): LogEntry {
  return { id, parentId: null, kind: "user", text, images: 0, skill, timestamp };
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
    /** Tokens read from and written to the cache. */
    cache?: [number, number];
  } = {},
): LogEntry {
  const [input, output] = fields.usage ?? [0, 0];
  const [cacheRead, cacheWrite] = fields.cache ?? [0, 0];
  return {
    id,
    parentId: null,
    kind: "assistant",
    parts,
    stopReason: fields.stopReason ?? "stop",
    errorMessage: fields.error ?? null,
    usage: { input, output, cacheRead, cacheWrite, reasoning: null },
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
function compaction(id: string, tokensBefore = 9): LogEntry {
  return {
    id,
    parentId: null,
    timestamp: 4,
    kind: "compaction",
    summary: id,
    firstKeptEntryId: "a0",
    tokensBefore,
    system: null,
  };
}

/**
 * A compaction step at `id`, summarized as its entry's id, as `compaction` makes the entry.
 *
 * @remarks
 * Steps compare whole, so a test names only where it is and what it knows.
 *
 * @sideEffects none
 * @param id - The step's id.
 * @param entryId - The compaction entry it came from.
 * @param tokensAfter - The context after it, if known.
 * @param reason - What set it off, as the host saw it.
 * @returns The step.
 */
function compacted(
  id: string,
  entryId: string,
  tokensAfter: number | null,
  reason: "overflow" | "threshold" | null = null,
): Step {
  return { kind: "compaction", id, tokensBefore: 9, tokensAfter, summary: entryId, reason };
}

/**
 * Compactions the host saw during a run, none of them with a reason.
 *
 * @remarks
 * For tests where only whether the host saw them matters.
 *
 * @sideEffects none
 * @param ids - The compaction entries.
 * @returns The record.
 */
const seenLive = (...ids: string[]): ReadonlyMap<string, "overflow" | "threshold" | null> =>
  new Map(ids.map((id) => [id, null]));

/**
 * Each item as its id, a turn with what opened it and its text, a notice as its kind.
 *
 * @sideEffects none
 * @param items - The items.
 * @returns One each.
 */
function openings(items: readonly TranscriptItem[]): unknown[] {
  return items.map((item) => (item.kind === "turn" ? [item.id, item.source?.kind, item.user.text] : item.kind));
}

/**
 * Each item as its id, a notice as its kind.
 *
 * @sideEffects none
 * @param items - The items.
 * @returns One each.
 */
function itemIds(items: readonly TranscriptItem[]): string[] {
  return items.map((item) => (item.kind === "turn" ? item.id : item.kind));
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
    source: null,
    user: { text: userText, images: 0, clientMessageId: null, auto: false, command: null, timestamp: 0 },
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
      output: "tool-ok",
      details: { tool: "bash", command: "printf 'tool-%s' ok" },
      partial: false,
    },
    {
      kind: "tool",
      id: "2",
      callId: "call-2",
      tool: "write",
      args: { path: "notes.txt" },
      status: "done",
      output: "Successfully wrote to notes.txt",
      details: { tool: "write", path: "notes.txt", content: "a\nb\n" },
      partial: false,
    },
    {
      kind: "tool",
      id: "3",
      callId: "call-3",
      tool: "edit",
      args: { path: "notes.txt", edits: [{ oldText: "b", newText: "c\nd" }] },
      status: "done",
      output: "Successfully replaced 1 block(s) in notes.txt.",
      details: { tool: "edit", path: "notes.txt", diff: " 1 a\n-2 b\n+2 c\n+3 d", added: 2, removed: 1 },
      partial: false,
    },
    {
      kind: "tool",
      id: "4",
      callId: "call-4",
      tool: "read",
      args: { path: "notes.txt", offset: 2, limit: 1 },
      status: "done",
      output: "c\n\n[2 more lines in file. Use offset=3 to continue.]",
      details: { tool: "read", path: "notes.txt", offset: 2, limit: 1 },
      partial: false,
    },
    { kind: "text", id: "5", text: "first answer" },
  ],
  // Written first, so its line counts are unknown.
  changes: [{ path: "notes.txt", added: null, removed: null }],
});

describe("projectTranscript on a recorded session", () => {
  it("rebuilds the branch the file ends on, with a retry and a compaction between turns", () => {
    expect(projectTranscript(recordedBranch("e24"), "s", none)).toStrictEqual({
      items: [
        firstTurn,
        turn("e16", "two", {
          steps: [
            {
              kind: "retry",
              id: "0",
              attempt: 1,
              maxAttempts: null,
              error: "upstream returned 503 service unavailable",
            },
            { kind: "text", id: "1", text: "second answer" },
          ],
        }),
        {
          kind: "notice",
          id: "s:e18",
          notice: "compacted",
          tokensBefore: 0,
          // The next reply's tokens were recorded as 0, which says nothing.
          tokensAfter: null,
          summary:
            "A short summary.\n\n---\n\n**Turn Context (split turn):**\n\nThe turn so far.\n\n<modified-files>\nnotes.txt\n</modified-files>",
          timestamp: 0,
        },
        turn("e19", "three", { steps: [{ kind: "text", id: "0", text: "third answer" }] }),
        turn("e23", "four", { steps: [{ kind: "text", id: "0", text: "fourth answer" }] }),
      ],
      turnEntryIds: ["e6", "e16", "e19", "e23"],
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

  it("tags a turn that started with a skill, and writes a steer that did as it was typed", () => {
    const { items } = projectTranscript(
      [
        user("u1", "the tests", 0, "review"),
        reply("a1", [bash("c1")], { stopReason: "toolUse" }),
        result("r1", "c1", "out"),
        user("u2", "", 0, "lint"),
        reply("a2", [bash("c2")], { stopReason: "toolUse" }),
        result("r2", "c2", "out"),
        user("u3", "only src", 0, "lint"),
        reply("a3", [says("done")]),
        user("u4", "next"),
        reply("a4", [says("ok")]),
      ],
      "s",
      none,
    );

    const turns = items as Turn[];
    expect(turns.map((item) => [item.user.text, item.user.command])).toStrictEqual([
      ["the tests", { kind: "skill", name: "review" }],
      ["next", null],
    ]);
    expect(turns[0]?.steps.filter((step) => step.kind === "steer")).toStrictEqual([
      { kind: "steer", id: "1", text: "/skill:lint" },
      { kind: "steer", id: "3", text: "/skill:lint only src" },
    ]);
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
      { kind: "retry", id: "0", attempt: 1, maxAttempts: null, error: "503" },
      // What the failed reply had already said stays, and the retry follows it.
      { kind: "text", id: "1", text: "par" },
      { kind: "retry", id: "2", attempt: 2, maxAttempts: null, error: "overloaded" },
      expect.objectContaining({ kind: "tool", id: "3", status: "done" }),
      { kind: "retry", id: "4", attempt: 1, maxAttempts: null, error: "503" },
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
      [{ kind: "retry", id: "0", attempt: 1, maxAttempts: null, error: "503" }],
      [{ kind: "retry", id: "0", attempt: 1, maxAttempts: null, error: "503" }],
    ]);
    expect(items[0]).toMatchObject({ outcome: "failed", error: "503" });
  });

  it("follows what the host saw live: a turn stays a turn after a tool result", () => {
    const branch = [
      user("u1", "go"),
      reply("a1", [bash("c1")], { stopReason: "toolUse" }),
      result("r1", "c1", "ended by the tool"),
      user("u2", "next"),
      reply("a2", [bash("c2")], { stopReason: "toolUse" }),
      result("r2", "c2", "x"),
      user("u3", "also"),
      reply("a3", [says("done")]),
    ];
    const facts: TurnFacts = {
      turnId: "live",
      clientMessageId: null,
      retryLimit: null,
      auto: false,
      durationMs: 1,
      thinkingMs: new Map(),
    };

    expect(stepKinds(projectTranscript(branch, "s", none).items)).toStrictEqual([
      ["tool", "steer", "tool", "steer", "text"],
    ]);
    expect(stepKinds(projectTranscript(branch, "s", new Map([["u2", facts]])).items)).toStrictEqual([
      ["tool"],
      ["tool", "steer", "text"],
    ]);
  });

  it("follows what an earlier host saw: an entry it recorded as opening a turn opens one, without its timings", () => {
    const branch = [
      user("u1", "go"),
      reply("a1", [bash("c1")], { stopReason: "toolUse" }),
      result("r1", "c1", "ended by the tool"),
      user("u2", "next"),
      reply("a2", [says("done")]),
    ];

    const { items } = projectTranscript(branch, "s", none, new Set(["u2"]));

    expect(stepKinds(items)).toStrictEqual([["tool"], ["text"]]);
    expect(items[1]).toMatchObject({ id: "s:u2", user: { clientMessageId: null }, durationMs: 0 });
  });

  it("takes a reply pi omitted to recover from a context overflow for no retry, and an empty error as Unknown error", () => {
    const { items } = projectTranscript(
      [
        user("u1", "go"),
        reply("f1", [bash("c1")], { stopReason: "error", error: "context overflow" }),
        result("r1", "c1", "x"),
        omit("o1", "f1"),
        omit("o2", "r1"),
        { id: "m1", parentId: null, timestamp: 0, kind: "other" },
        compaction("k1"),
        reply("f2", [], { stopReason: "error", error: "" }),
        omit("o3", "f2"),
        reply("f3", [], { stopReason: "error" }),
        omit("o4", "f3"),
        reply("a1", [says("done")]),
      ],
      "s",
      none,
    );

    expect((items[0] as Turn).steps.map((step) => step.kind)).toStrictEqual([
      "tool",
      "compaction",
      "retry",
      "retry",
      "text",
    ]);
    expect((items[0] as Turn).steps.slice(2, 4)).toStrictEqual([
      { kind: "retry", id: "2", attempt: 1, maxAttempts: null, error: "Unknown error" },
      { kind: "retry", id: "3", attempt: 2, maxAttempts: null, error: "Unknown error" },
    ]);
    expect(items.map((item) => item.kind)).toStrictEqual(["turn"]);
  });

  it("still counts a retry whose omission is followed by a message before any compaction", () => {
    const { items } = projectTranscript(
      [
        user("u1", "go"),
        reply("f1", [], { stopReason: "error", error: "503" }),
        omit("o1", "f1"),
        reply("a1", [says("ok")]),
        compaction("k1"),
      ],
      "s",
      none,
    );

    expect((items[0] as Turn).steps[0]).toStrictEqual({
      kind: "retry",
      id: "0",
      attempt: 1,
      maxAttempts: null,
      error: "503",
    });
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

  it("puts a compaction before any turn in place, as a notice with the next reply's input after it", () => {
    const { items } = projectTranscript(
      [compaction("k0"), user("u1", "go"), reply("a1", [says("done")], { usage: [1200, 30], cache: [40_000, 800] })],
      "s",
      none,
      new Set(),
      new Set(),
      // Even one the host saw: there is no turn for it to be a step of.
      seenLive("k0"),
    );

    expect(items.map((item) => item.id)).toStrictEqual(["s:k0", "s:u1"]);
    expect(items[0]).toStrictEqual({
      kind: "notice",
      id: "s:k0",
      notice: "compacted",
      tokensBefore: 9,
      tokensAfter: 42_000,
      summary: "k0",
      timestamp: 4,
    });
  });

  it("makes a compaction a step where it happened when the turn goes on after it (SPEC-0001, `compaction`)", () => {
    const { items } = projectTranscript(
      [
        user("u1", "go"),
        reply("a1", [bash("c1")], { stopReason: "toolUse" }),
        result("r1", "c1", "x"),
        compaction("k1"),
        reply("a2", [says("done")], { usage: [500, 5], cache: [40_000, 1000] }),
        user("u2", "next"),
        reply("a3", [says("ok")]),
      ],
      "s",
      none,
    );

    expect(items.map((item) => item.id)).toStrictEqual(["s:u1", "s:u2"]);
    expect((items[0] as Turn).steps.map((step) => step.kind)).toStrictEqual(["tool", "compaction", "text"]);
    expect((items[0] as Turn).steps[1]).toStrictEqual(compacted("1", "k1", 41_500));
    expect((items[0] as Turn).steps[2]).toStrictEqual({ kind: "text", id: "2", text: "done" });
  });

  it("makes a compaction right after the user message the turn's first step", () => {
    const { items } = projectTranscript(
      [user("u1", "go"), compaction("k1"), reply("a1", [says("done")], { usage: [700, 1] })],
      "s",
      none,
    );

    expect((items[0] as Turn).steps).toStrictEqual([
      compacted("0", "k1", 700),
      { kind: "text", id: "1", text: "done" },
    ]);
  });

  it("makes a compaction right before the next user message a notice between the turns, unless the host saw it in the run", () => {
    const branch = [
      user("u1", "go"),
      reply("a1", [says("done")], { usage: [100, 1] }),
      compaction("k1"),
      user("u2", "next"),
      reply("a2", [says("ok")], { usage: [300, 1] }),
      compaction("k2"),
    ];

    const unseen = projectTranscript(branch, "s", none).items;
    const seen = projectTranscript(
      branch,
      "s",
      none,
      new Set(),
      new Set(),
      new Map([
        ["k1", "threshold"],
        ["k2", null],
      ]),
    ).items;

    expect(unseen.map((item) => item.id)).toStrictEqual(["s:u1", "s:k1", "s:u2", "s:k2"]);
    expect(unseen[1]).toStrictEqual({
      kind: "notice",
      id: "s:k1",
      notice: "compacted",
      tokensBefore: 9,
      tokensAfter: 300,
      summary: "k1",
      timestamp: 4,
    });
    expect(unseen[3]).toMatchObject({ notice: "compacted", tokensAfter: null });
    expect(seen.map((item) => item.id)).toStrictEqual(["s:u1", "s:u2"]);
    expect((seen[0] as Turn).steps).toStrictEqual([
      { kind: "text", id: "0", text: "done" },
      compacted("1", "k1", 300, "threshold"),
    ]);
    expect((seen[1] as Turn).steps).toStrictEqual([{ kind: "text", id: "0", text: "ok" }, compacted("1", "k2", null)]);
  });

  it("shows pi recovering from an overflow as the failed reply, the compaction, then the retried reply", () => {
    const { items } = projectTranscript(
      [
        user("u1", "go"),
        reply("f1", [says("half")], { stopReason: "error", error: "prompt is too long" }),
        omit("o1", "f1"),
        compaction("k1"),
        reply("a1", [says("done")], { usage: [900, 1] }),
      ],
      "s",
      none,
      new Set(),
      new Set(),
      new Map([["k1", "overflow"]]),
    );

    expect(items).toStrictEqual([
      turn("u1", "go", {
        steps: [
          { kind: "text", id: "0", text: "half" },
          compacted("1", "k1", 900, "overflow"),
          { kind: "text", id: "2", text: "done" },
        ],
        usage: { input: 900, output: 1 },
      }),
    ]);
  });

  it("gives each compaction in a turn its own step, its input after it from the first later reply that says one", () => {
    const { items } = projectTranscript(
      [
        user("u1", "go"),
        reply("a1", [bash("c1")], { stopReason: "toolUse" }),
        result("r1", "c1", "x"),
        compaction("k1"),
        reply("a2", [], { stopReason: "aborted" }),
        reply("a3", [bash("c2")], { stopReason: "toolUse", usage: [2000, 1] }),
        result("r2", "c2", "y"),
        compaction("k2"),
        reply("a4", [says("done")], { cache: [3000, 0] }),
      ],
      "s",
      none,
      new Set(),
      new Set(),
      seenLive("k1"),
    );

    expect((items[0] as Turn).steps.map((step) => step.kind)).toStrictEqual([
      "tool",
      "compaction",
      "tool",
      "compaction",
      "text",
    ]);
    expect((items[0] as Turn).steps.filter((step) => step.kind === "compaction")).toStrictEqual([
      compacted("1", "k1", 2000),
      compacted("3", "k2", 3000),
    ]);
  });

  it("still takes a message, or notices that came in, after a tool result and a compaction for a step", () => {
    const { items } = projectTranscript(
      [
        user("u1", "go"),
        reply("a1", [bash("c1")], { stopReason: "toolUse" }),
        result("r1", "c1", "x"),
        compaction("k1"),
        user("u2", "also b"),
        reply("a2", [bash("c2")], { stopReason: "toolUse" }),
        result("r2", "c2", "y"),
        compaction("k2"),
        task("n1", "look"),
        reply("a3", [says("done")]),
      ],
      "s",
      none,
    );

    expect(stepKinds(items)).toStrictEqual([["tool", "compaction", "steer", "tool", "compaction", "agent", "text"]]);
  });

  it("skips replies and results before any user message and results of calls it never saw", () => {
    const { items } = projectTranscript(
      [
        reply("a0", [says("orphan")]),
        result("r9", "c9", "orphan"),
        user("u1", "go"),
        result("r0", "nope", "x"),
        reply("a1", [says("hi")]),
      ],
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
            partial: false,
          },
          {
            kind: "tool",
            id: "1",
            callId: "c2",
            tool: "bash",
            args: { command: "ls" },
            status: "failed",
            output: "boom",
            details: { tool: "bash", command: "ls" },
            partial: false,
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
      auto: false,
      retryLimit: null,
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
        user: { text: "go", images: 0, clientMessageId: "client-3", auto: false, command: null, timestamp: 1_000 },
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

  it("puts Atrium's note to the model after the turn it follows, as a line of its own", () => {
    const { items } = projectTranscript(
      [
        user("u1", "go"),
        reply("a1", [says("done")]),
        {
          id: "n1",
          parentId: "a1",
          timestamp: 7,
          kind: "note",
          note: { note: "worktree_moved", from: "/repo", to: "/repo.worktrees/tests" },
        },
        user("u2", "next"),
      ],
      "s",
      none,
    );

    expect(items.map((item) => item.kind)).toStrictEqual(["turn", "notice", "turn"]);
    expect(items[1]).toStrictEqual({
      kind: "notice",
      id: "s:n1",
      notice: "note",
      note: "worktree_moved",
      from: "/repo",
      to: "/repo.worktrees/tests",
      timestamp: 7,
    });
  });

  it("opens a turn with notices or a task, and makes them a step where a steer would be (SPEC-0002)", () => {
    const { items, turnEntryIds } = projectTranscript(
      [
        task("k1", "look at auth", 3),
        reply("a1", [bash("c1")], { stopReason: "toolUse", timestamp: 4 }),
        result("r1", "c1", "out"),
        report("n1", "question"),
        reply("a2", [says("done")], { timestamp: 6 }),
        report("n2", "finished"),
        reply("a3", [says("summed up")]),
      ],
      "s",
      none,
    );

    expect(openings(items)).toStrictEqual([
      ["s:k1", "task", ""],
      ["s:n2", "report", ""],
    ]);
    expect(turnEntryIds).toStrictEqual(["k1", "n2"]);
    expect(items[0]).toMatchObject({
      source: { kind: "task", fromTitle: "修复", taskId: "t-1", text: "look at auth" },
      user: { text: "", images: 0, clientMessageId: null, auto: false, command: null, timestamp: 3 },
      startedAt: 3,
      durationMs: 3,
    });
    expect(stepKinds(items)).toStrictEqual([["tool", "agent", "text"], ["text"]]);
    expect((items[0] as Turn).steps[1]).toStrictEqual({
      kind: "agent",
      id: "1",
      source: {
        kind: "report",
        events: [
          {
            sessionId: "s2",
            name: "tests",
            title: "补测试",
            taskId: "t-2",
            event: "question",
            reason: null,
            elapsedMs: null,
            question: "vitest?",
            branch: null,
            changes: null,
          },
        ],
      },
    });
  });

  it("gives a turn notices opened, seen live, pi's limit on retries as measured then", () => {
    const facts = new Map<string, TurnFacts>([
      [
        "n1",
        { turnId: "live-3", clientMessageId: null, auto: false, durationMs: 5, thinkingMs: new Map(), retryLimit: 3 },
      ],
    ]);
    const { items } = projectTranscript(
      [
        report("n1", "finished"),
        reply("f1", [], { stopReason: "error", error: "503" }),
        omit("o1", "f1"),
        reply("a1", [says("ok")]),
      ],
      "s",
      facts,
    );

    expect((items[0] as Turn).steps).toStrictEqual([
      { kind: "retry", id: "0", attempt: 1, maxAttempts: 3, error: "503" },
      { kind: "text", id: "1", text: "ok" },
    ]);
  });

  it("follows what the host saw: notices it saw open a turn open one, and notices none can show are skipped", () => {
    const facts = new Map<string, TurnFacts>([
      [
        "n1",
        {
          turnId: "live-2",
          clientMessageId: null,
          auto: false,
          durationMs: 5,
          thinkingMs: new Map(),
          retryLimit: null,
        },
      ],
    ]);
    const { items } = projectTranscript(
      [
        user("u1", "go"),
        reply("a1", [bash("c1")], { stopReason: "toolUse" }),
        result("r1", "c1", "out"),
        report("n1", "finished"),
        reply("a2", [says("ok")]),
        {
          id: "n2",
          parentId: null,
          timestamp: 0,
          kind: "agent",
          details: { v: 1, kind: "report", deliveries: ["d"], events: [] },
        },
        reply("a3", [says("still the same turn")]),
      ],
      "s",
      facts,
    );

    expect(itemIds(items)).toStrictEqual(["s:u1", "live-2"]);
    expect(stepKinds(items)).toStrictEqual([["tool"], ["text", "text"]]);
  });
});

/**
 * A task's custom message entry, from the main conversation's agent.
 *
 * @remarks
 * As pi keeps what Atrium's extension wrote (ADR-0013, point 10).
 *
 * @sideEffects none
 * @param id - The entry's id.
 * @param text - The task.
 * @param timestamp - When it was written.
 * @returns The entry.
 */
function task(id: string, text: string, timestamp = 0): LogEntry {
  return {
    id,
    parentId: null,
    timestamp,
    kind: "agent",
    details: { v: 1, kind: "task", deliveries: ["d1"], from: "main", fromTitle: "修复", taskId: "t-1", text },
  };
}

/**
 * A notice's custom message entry, from the child `tests`.
 *
 * @remarks
 * See `task`.
 *
 * @sideEffects none
 * @param id - The entry's id.
 * @param event - What happened.
 * @returns The entry.
 */
function report(id: string, event: "finished" | "question"): LogEntry {
  return {
    id,
    parentId: null,
    timestamp: 0,
    kind: "agent",
    details: {
      v: 1,
      kind: "report",
      deliveries: ["d2"],
      events: [
        {
          name: "tests",
          title: "补测试",
          sessionId: "s2",
          taskId: "t-2",
          event,
          ...(event === "question" ? { questionId: "q1", question: "vitest?" } : {}),
        },
      ],
    },
  };
}
