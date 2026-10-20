import { type LogEntry, createEventTranslator } from "@atrium/pi";
import { STEP_TEXT_LIMIT, type TranscriptItem, type Turn } from "@atrium/protocol";
import { present } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { fixtureEntries, fixtureEvents } from "../../test/pi-fixtures";
import { PAGE_BYTES, type RebuildResult, type TranscriptEvent, createSessionTranscript } from "./session-transcript";

/** A transcript for session `s` whose clock the test sets, with turn ids live-1, live-2, … */
function transcript() {
  const clock = { time: 0 };
  let next = 0;
  const value = createSessionTranscript({ sessionId: "s", newId: () => `live-${++next}`, now: () => clock.time });
  return { transcript: value, clock };
}

/** A user message event. */
function userMessage(text: string, timestamp = 0, skill: string | null = null) {
  return { kind: "message_finished", message: { kind: "user", text, images: 0, skill, timestamp } } as const;
}

/** The users of the turns `events` started. */
function startedUsers(events: readonly TranscriptEvent[]): Turn["user"][] {
  return events.flatMap((event) => (event.type === "turn_started" ? [event.turn.user] : []));
}

/** A finished assistant message event. */
function assistantMessage(
  parts: Extract<LogEntry, { kind: "assistant" }>["parts"],
  stopReason: "stop" | "toolUse" = "stop",
) {
  return {
    kind: "message_finished",
    message: {
      kind: "assistant",
      parts,
      stopReason,
      errorMessage: null,
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: null },
      timestamp: 0,
    },
  } as const;
}

/** A finished tool result event. */
function toolResult(callId: string, text: string) {
  return {
    kind: "message_finished",
    message: { kind: "toolResult", callId, tool: "bash", text, isError: false, details: undefined, timestamp: 0 },
  } as const;
}

const noClient = () => ({ clientMessageId: null, auto: false });

/** What one of Atrium's notices or tasks keeps in pi's file. */
type Delivered = Extract<LogEntry, { kind: "agent" }>["details"];

/** A message sent from the page as `client-1`. */
const fromPage = () => ({ clientMessageId: "client-1", auto: false });

/** A message the host sent on its own. */
const sentByHost = () => ({ clientMessageId: null, auto: true });

/** A user entry. */
function userEntry(id: string, parentId: string | null, text: string): LogEntry {
  return { id, parentId, kind: "user", text, images: 0, skill: null, timestamp: 0 };
}

/** A session of `turns` user messages, each followed by a compaction. */
function longSession(turns: number) {
  const { transcript: session } = transcript();
  const entries: LogEntry[] = [];
  for (let index = 0; index < turns; index += 1) {
    const parentId = entries.at(-1)?.id ?? null;
    entries.push({ id: `u${index}`, parentId, kind: "user", text: `${index}`, images: 0, skill: null, timestamp: 0 });
    entries.push({
      id: `k${index}`,
      parentId: `u${index}`,
      kind: "compaction",
      summary: "",
      firstKeptEntryId: `u${index}`,
      tokensBefore: 0,
      system: null,
      timestamp: 0,
    });
  }
  session.rebuild({ entries, leafId: entries.at(-1)?.id ?? null }, false);
  return session;
}

/** The ids of items. */
function ids(items: readonly TranscriptItem[]): string[] {
  return items.map((item) => item.id);
}

/**
 * Plays the recorded history scenario into a transcript, as the controller would.
 *
 * @remarks
 * pi's clock moves 100 ms per event. After every settled run and after the compaction, the host
 * reads what pi wrote since its last read: the recorded file up to that point, and its leaf then.
 *
 * @sideEffects Updates the transcript.
 * @returns The events published, the rebuild results, and the transcript.
 */
function playHistory() {
  const { transcript: session, clock } = transcript();
  const translate = createEventTranslator(() => 0);
  const { entries } = fixtureEntries("history");
  const upTo = (id: string) => entries.findIndex((entry) => entry.id === id) + 1;
  const reads: [number, string][] = [
    [0, ""],
    [upTo("e15"), "e15"],
    [upTo("e17"), "e17"],
    [upTo("e18"), "e18"],
    [upTo("e20"), "e20"],
    [upTo("e22"), "e22"],
    [entries.length, "e24"],
  ];
  let read = 0;
  const results: RebuildResult[] = [];
  const published: TranscriptEvent[] = [];
  let prompts = 0;

  /** Reads what pi wrote since the last read. */
  const reread = () => {
    const [start] = present(reads[read], "the previous read");
    read += 1;
    const [end, leafId] = present(reads[read], "a planned read");
    results.push(session.rebuild({ entries: entries.slice(start, end), leafId }, false));
  };

  for (const event of fixtureEvents("history")) {
    clock.time += 100;
    for (const translated of translate(event)) {
      if (translated.kind === "agent_settled") {
        published.push(...session.settle());
        reread();
      } else if (translated.kind === "compaction_finished") reread();
      else
        published.push(...session.apply(translated, () => ({ clientMessageId: `client-${++prompts}`, auto: false })));
    }
  }
  return { session, results, published };
}

/**
 * Plays the recorded scenario of compactions during runs into a transcript, as the controller would.
 *
 * @remarks
 * After each settled run the host reads what pi wrote since its last read; the compactions are
 * during runs, so their ends read nothing (the controller never rebuilds during a run).
 *
 * @sideEffects Updates the transcript.
 * @param onTurnsSeen - Told what the rebuilds tie to entries.
 * @returns The events published, the rebuild results, and the transcript.
 */
function playCompactions(onTurnsSeen?: (...seen: unknown[]) => void) {
  let next = 0;
  const session = createSessionTranscript({
    sessionId: "s",
    newId: () => `live-${++next}`,
    now: () => 0,
    ...(onTurnsSeen === undefined ? {} : { onTurnsSeen }),
  });
  const translate = createEventTranslator(() => 0);
  const { entries } = fixtureEntries("compaction-run", "1.1.0");
  const reads = [entries.slice(0, 6), entries.slice(6)];
  const results: RebuildResult[] = [];
  const published: TranscriptEvent[] = [];
  for (const event of fixtureEvents("compaction-run", "1.1.0")) {
    for (const translated of translate(event)) {
      if (translated.kind === "agent_settled") {
        published.push(...session.settle());
        const read = present(reads[results.length], "a planned read");
        results.push(session.rebuild({ entries: read, leafId: present(read.at(-1), "the leaf").id }, false));
      } else published.push(...session.apply(translated, noClient));
    }
  }
  return { session, results, published };
}

/**
 * A compaction pi finished, with what it wrote.
 *
 * @remarks
 * As the translator reports pi's `compaction_end`; an overflow is retried.
 *
 * @sideEffects none
 * @param reason - What set it off.
 * @param result - What it wrote; `null` when it was stopped or failed.
 * @returns The event.
 */
function compactionDone(
  reason: "manual" | "threshold" | "overflow",
  result: { summary: string; firstKeptEntryId: string; tokensBefore: number } | null = {
    summary: "So far.",
    firstKeptEntryId: "a0",
    tokensBefore: 152_000,
  },
) {
  return {
    kind: "compaction_finished",
    reason,
    aborted: false,
    willRetry: reason === "overflow",
    error: null,
    result,
  } as const;
}

/**
 * A finished assistant message that read `input` tokens, a third of them from the cache.
 *
 * @remarks
 * The context after a compaction counts cached input too (SPEC-0001, `compaction`).
 *
 * @sideEffects none
 * @param input - The tokens it read, all told.
 * @returns The event.
 */
function replyReading(input: number) {
  const read = Math.floor(input / 3);
  const message = assistantMessage([{ type: "text", text: "done" }]).message;
  return {
    kind: "message_finished",
    message: { ...message, usage: { ...message.usage, input: input - read - 1, cacheRead: read, cacheWrite: 1 } },
  } as const;
}

/** An event's type, and for a step event the step's id and kind. */
function outline(event: TranscriptEvent): [string, string] {
  return [event.type, "step" in event ? `${event.step.id}:${event.step.kind}` : ""];
}

describe("createSessionTranscript following a recorded session", () => {
  it("builds live exactly what a rebuild from pi's entries gives, run after run", () => {
    const { session, results, published } = playHistory();

    expect(results).toStrictEqual([
      { kind: "same" },
      { kind: "same" },
      {
        kind: "notices",
        events: [{ type: "notice_added", notice: expect.objectContaining({ id: "s:e18" }), before: null }],
      },
      { kind: "same" },
      // pi went back to the first turn and branched from there, then back to the first branch.
      { kind: "changed" },
      { kind: "changed" },
    ]);
    // Turns seen live keep their ids across both changes of branch.
    expect(session.items().map((item) => item.id)).toStrictEqual(["live-1", "live-2", "s:e18", "live-3", "live-5"]);
    expect(session.items()[4]).toMatchObject({ user: { text: "four", clientMessageId: "client-5" } });
    expect(published.map((event) => event.type).filter((type) => type.startsWith("turn_"))).toStrictEqual(
      Array.from({ length: 5 }, () => ["turn_started", "turn_finished"]).flat(),
    );
  });

  it("publishes the first turn step by step: blocks as they start, tools as they run and finish", () => {
    const { published: all } = playHistory();
    const published = all.slice(0, all.findIndex((event) => event.type === "turn_finished") + 1);

    expect(published.map(outline)).toStrictEqual([
      ["turn_started", ""],
      ["step_added", "0:thinking"],
      ["step_delta", ""],
      ["step_delta", ""],
      // Thinking ends when the next block arrives.
      ["step_updated", "0:thinking"],
      ["step_added", "1:tool"],
      // The command's output so far, twice, then its result.
      ["step_updated", "1:tool"],
      ["step_updated", "1:tool"],
      ["step_updated", "1:tool"],
      ["step_added", "2:tool"],
      ["step_updated", "2:tool"],
      ["step_added", "3:tool"],
      ["step_updated", "3:tool"],
      ["step_added", "4:tool"],
      ["step_updated", "4:tool"],
      ["step_added", "5:text"],
      ["step_delta", ""],
      ["step_delta", ""],
      ["turn_finished", ""],
    ]);
    expect(published[0]).toStrictEqual({
      type: "turn_started",
      turn: {
        kind: "turn",
        id: "live-1",
        source: null,
        user: { text: "one", images: 0, clientMessageId: "client-1", auto: false, command: null, timestamp: 0 },
        steps: [],
        outcome: "running",
        error: null,
        startedAt: 0,
        durationMs: null,
        usage: null,
        changes: [],
      },
    });
    expect(published.filter((event) => event.type === "step_updated").slice(1, 3)).toStrictEqual([
      {
        type: "step_updated",
        turnId: "live-1",
        step: expect.objectContaining({ status: "running", output: "" }),
      },
      {
        type: "step_updated",
        turnId: "live-1",
        step: expect.objectContaining({ status: "running", output: "tool-ok" }),
      },
    ]);
    const thinking = present(published[4], "the timed thinking step");
    expect(thinking).toMatchObject({ step: { kind: "thinking", text: "Look first." } });
    expect((thinking as { step: { durationMs: number } }).step.durationMs).toBeGreaterThan(0);
    expect(published.at(-1)).toStrictEqual({
      type: "turn_finished",
      turnId: "live-1",
      outcome: "done",
      error: null,
      durationMs: expect.any(Number) as number,
      usage: { input: 0, output: 0 },
      changes: [{ path: "notes.txt", added: null, removed: null }],
    });
  });
});

describe("createSessionTranscript following recorded compactions during runs", () => {
  it("adds each compaction live where it happened, and a rebuild that knows the host saw them agrees", () => {
    const seen: unknown[][] = [];
    const { session, results, published } = playCompactions((...args) => seen.push(args));

    expect(results).toStrictEqual([{ kind: "same" }, { kind: "same" }]);
    expect(published.filter((event) => event.type.startsWith("step_")).map(outline)).toStrictEqual([
      ["step_added", "0:text"],
      ["step_delta", ""],
      ["step_added", "1:compaction"],
      ["step_added", "0:tool"],
      ["step_updated", "0:tool"],
      ["step_updated", "0:tool"],
      ["step_updated", "0:tool"],
      ["step_added", "1:compaction"],
      ["step_added", "2:text"],
      ["step_delta", ""],
    ]);
    expect(session.items().map((item) => (item as Turn).steps.map((step) => step.kind))).toStrictEqual([
      ["text", "compaction"],
      ["tool", "compaction", "text"],
    ]);
    // The fixture's token counts are recorded as 0, which says nothing of the context after.
    expect((session.items()[0] as Turn).steps[1]).toStrictEqual({
      kind: "compaction",
      id: "1",
      tokensBefore: 0,
      tokensAfter: null,
      summary: "No prior history.\n\n---\n\n**Turn Context (split turn):**\n\nSummary one.",
      reason: "threshold",
    });
    expect(seen).toStrictEqual([
      [["e6"], [], new Map([["e7", "threshold"]])],
      [["e8"], [], new Map([["e10", "threshold"]])],
    ]);
  });
});

describe("createSessionTranscript compacting live", () => {
  it("adds a finished compaction as a step, and gives it the next reply's input when that comes", () => {
    const { transcript: session } = transcript();
    session.apply(userMessage("go"), noClient);

    expect(session.apply(compactionDone("overflow"), noClient)).toStrictEqual([
      {
        type: "step_added",
        turnId: "live-1",
        step: {
          kind: "compaction",
          id: "0",
          tokensBefore: 152_000,
          tokensAfter: null,
          summary: "So far.",
          reason: "overflow",
        },
      },
    ]);
    session.apply({ kind: "assistant_started" }, noClient);
    expect(session.apply(replyReading(41_000), noClient)).toStrictEqual([
      { type: "step_added", turnId: "live-1", step: { kind: "text", id: "1", text: "done" } },
      {
        type: "step_updated",
        turnId: "live-1",
        step: {
          kind: "compaction",
          id: "0",
          tokensBefore: 152_000,
          tokensAfter: 41_000,
          summary: "So far.",
          reason: "overflow",
        },
      },
    ]);
    // Known once, it stays.
    session.apply({ kind: "assistant_started" }, noClient);
    expect(session.apply(replyReading(50_000), noClient)).toStrictEqual([
      { type: "step_added", turnId: "live-1", step: { kind: "text", id: "2", text: "done" } },
    ]);
  });

  it("adds no step for a compaction that was stopped or failed, or with no turn running, and gives /compact no reason", () => {
    const { transcript: session } = transcript();

    expect(session.apply(compactionDone("threshold"), noClient)).toStrictEqual([]);
    session.apply(userMessage("go"), noClient);
    expect(session.apply(compactionDone("threshold", null), noClient)).toStrictEqual([]);
    expect(session.apply(compactionDone("manual"), noClient)).toStrictEqual([
      {
        type: "step_added",
        turnId: "live-1",
        step: {
          kind: "compaction",
          id: "0",
          tokensBefore: 152_000,
          tokensAfter: null,
          summary: "So far.",
          reason: null,
        },
      },
    ]);
  });

  it("still takes a message after a tool result and a compaction for a steer, as a rebuild does", () => {
    const { transcript: session } = transcript();
    session.apply(userMessage("go"), noClient);
    session.apply(
      assistantMessage([{ type: "toolCall", callId: "c1", tool: "bash", args: { command: "ls" } }], "toolUse"),
      noClient,
    );
    session.apply(toolResult("c1", "x"), noClient);
    session.apply(compactionDone("threshold"), noClient);

    expect(session.apply(userMessage("also b"), noClient)).toStrictEqual([
      { type: "step_added", turnId: "live-1", step: { kind: "steer", id: "2", text: "also b" } },
    ]);
  });

  it("waits for a reply that says its input, and gives it to a compaction that ended the turn before", () => {
    const { transcript: session } = transcript();
    session.apply(userMessage("go"), noClient);
    session.apply(assistantMessage([{ type: "text", text: "one" }]), noClient);
    session.apply(compactionDone("threshold"), noClient);
    session.settle();
    session.apply(userMessage("next"), noClient);
    const silent = assistantMessage([]);

    expect(
      session.apply(
        {
          ...silent,
          message: {
            ...silent.message,
            stopReason: "aborted",
            usage: { ...silent.message.usage, input: 0, output: 0 },
          },
        },
        noClient,
      ),
    ).toStrictEqual([]);
    expect(session.apply(replyReading(900), noClient)).toStrictEqual([
      { type: "step_added", turnId: "live-2", step: { kind: "text", id: "0", text: "done" } },
      {
        type: "step_updated",
        turnId: "live-1",
        step: {
          kind: "compaction",
          id: "1",
          tokensBefore: 152_000,
          tokensAfter: 900,
          summary: "So far.",
          reason: "threshold",
        },
      },
    ]);
    expect(session.items().map((item) => (item as Turn).steps.at(-1))).toMatchObject([
      { kind: "compaction", tokensAfter: 900 },
      { kind: "text" },
    ]);
  });

  it("keeps a compaction at the end of a run a step through rebuilds, by an earlier host's record too", () => {
    const entries = [
      userEntry("u1", null, "go"),
      { ...callEntry("a1", "u1", "c1"), parts: [{ type: "text", text: "one" }], stopReason: "stop" } as LogEntry,
      { ...compactionEntry("k1", "a1"), summary: "So far.", tokensBefore: 152_000 },
    ];
    const { transcript: live } = transcript();
    live.apply(userMessage("go"), noClient);
    live.apply(assistantMessage([{ type: "text", text: "one" }]), noClient);
    live.apply(compactionDone("threshold"), noClient);
    live.settle();
    const later = createSessionTranscript({
      sessionId: "s",
      newId: () => "x",
      now: () => 0,
      opened: new Set(["u1"]),
      compactions: new Map([["k1", "threshold"]]),
    });
    const { transcript: unrecorded } = transcript();

    expect(live.rebuild({ entries, leafId: "k1" }, false)).toStrictEqual({ kind: "same" });
    later.rebuild({ entries, leafId: "k1" }, false);
    unrecorded.rebuild({ entries, leafId: "k1" }, false);
    expect(later.items().map((item) => item.kind)).toStrictEqual(["turn"]);
    expect((later.items()[0] as Turn).steps.at(-1)).toStrictEqual({
      kind: "compaction",
      id: "1",
      tokensBefore: 152_000,
      tokensAfter: null,
      summary: "So far.",
      reason: "threshold",
    });
    expect(unrecorded.items().map((item) => item.kind)).toStrictEqual(["turn", "notice"]);
    later.apply(userMessage("next"), noClient);
    later.apply({ kind: "assistant_started" }, noClient);
    expect(later.apply(replyReading(900), noClient)).toMatchObject([
      { type: "step_added", turnId: "x" },
      { type: "step_updated", turnId: "s:u1", step: { kind: "compaction", tokensAfter: 900 } },
    ]);
  });

  it.each([
    ["summary", { summary: "Other." }],
    ["first entry kept", { firstKeptEntryId: "a9" }],
    ["tokens before", { tokensBefore: 1 }],
  ])(
    "ties a compaction seen live to its own entry, not one before the turn that differs in its %s",
    (_field, other) => {
      const seen: unknown[] = [];
      const recorded = createSessionTranscript({
        sessionId: "s",
        newId: () => "live",
        now: () => 0,
        onTurnsSeen: (...args) => seen.push(args[2]),
      });
      const kept = { summary: "So far.", firstKeptEntryId: "a0", tokensBefore: 152_000 };
      recorded.apply(userMessage("next"), noClient);
      recorded.apply(assistantMessage([{ type: "text", text: "two" }]), noClient);
      recorded.apply(compactionDone("threshold", kept), noClient);
      recorded.settle();
      const entries: LogEntry[] = [
        userEntry("u1", null, "go"),
        { ...compactionEntry("k0", "u1"), ...kept, ...other },
        userEntry("u2", "k0", "next"),
        { ...callEntry("a2", "u2", "c1"), parts: [{ type: "text", text: "two" }], stopReason: "stop" } as LogEntry,
        { ...compactionEntry("k1", "a2"), ...kept },
      ];

      recorded.rebuild({ entries, leafId: "k1" }, false);

      expect(seen).toStrictEqual([new Map([["k1", "threshold"]])]);
      expect(recorded.items().map((item) => [item.id, item.kind])).toStrictEqual([
        ["s:u1", "turn"],
        ["s:k0", "notice"],
        ["live", "turn"],
      ]);
    },
  );
});

describe("createSessionTranscript live", () => {
  it("times a turn and its thinking by the host's clock", () => {
    const { transcript: session, clock } = transcript();
    clock.time = 1_000;
    session.apply(userMessage("go", 7), noClient);
    session.apply({ kind: "assistant_started" }, noClient);
    clock.time = 1_100;
    session.apply({ kind: "part_started", index: 0, part: { type: "thinking", text: "" } }, noClient);
    clock.time = 1_600;
    const ended = session.apply(assistantMessage([{ type: "thinking", text: "hm" }]), noClient);
    clock.time = 3_000;

    expect(ended).toStrictEqual([
      { type: "step_updated", turnId: "live-1", step: { kind: "thinking", id: "0", text: "", durationMs: 500 } },
      { type: "step_updated", turnId: "live-1", step: { kind: "thinking", id: "0", text: "hm", durationMs: 500 } },
    ]);
    expect(session.settle()).toStrictEqual([
      {
        type: "turn_finished",
        turnId: "live-1",
        outcome: "done",
        error: null,
        durationMs: 2_000,
        usage: { input: 1, output: 2 },
        changes: [],
      },
    ]);
    expect(session.items()).toStrictEqual([
      expect.objectContaining({
        startedAt: 7,
        durationMs: 2_000,
        steps: [{ kind: "thinking", id: "0", text: "hm", durationMs: 500 }],
      }),
    ]);
  });

  it("adds a user message right after a tool result as a steer, without taking a prompt's id", () => {
    const { transcript: session } = transcript();
    let asked = 0;
    const client = () => ({ clientMessageId: `client-${++asked}`, auto: false });
    session.apply(userMessage("go"), client);
    session.apply({ kind: "assistant_started" }, client);
    session.apply(
      assistantMessage([{ type: "toolCall", callId: "c1", tool: "bash", args: { command: "ls" } }], "toolUse"),
      client,
    );
    session.apply(toolResult("c1", "a.ts"), client);

    expect(session.apply(userMessage("also b"), client)).toStrictEqual([
      { type: "step_added", turnId: "live-1", step: { kind: "steer", id: "1", text: "also b" } },
    ]);
    expect(asked).toBe(1);
  });

  it("tags a live turn that started with a skill, and writes a steer that did as it was typed", () => {
    const { transcript: session } = transcript();

    const started = session.apply(userMessage("the tests", 0, "review"), fromPage);
    session.apply({ kind: "assistant_started" }, fromPage);
    session.apply(
      assistantMessage([{ type: "toolCall", callId: "c1", tool: "bash", args: { command: "ls" } }], "toolUse"),
      fromPage,
    );
    session.apply(toolResult("c1", "a.ts"), fromPage);

    expect(started.map((event) => event.type)).toStrictEqual(["turn_started"]);
    expect(startedUsers(started)).toStrictEqual([
      {
        text: "the tests",
        images: 0,
        clientMessageId: "client-1",
        auto: false,
        command: { kind: "skill", name: "review" },
        timestamp: 0,
      },
    ]);
    expect(session.apply(userMessage("only src", 0, "lint"), fromPage)).toStrictEqual([
      { type: "step_added", turnId: "live-1", step: { kind: "steer", id: "1", text: "/skill:lint only src" } },
    ]);
  });

  it("ends the running turn when a user message that is not a steer starts another", () => {
    const { transcript: session } = transcript();
    session.apply(userMessage("one"), noClient);
    session.apply(assistantMessage([{ type: "text", text: "a" }]), noClient);

    expect(session.apply(userMessage("two"), noClient).map((event) => event.type)).toStrictEqual([
      "turn_finished",
      "turn_started",
    ]);
    expect(session.items().map((item) => [item.id, (item as Turn).outcome])).toStrictEqual([
      ["live-1", "done"],
      ["live-2", "running"],
    ]);
  });

  it("marks a tool still running at the end unfinished, and the turn stopped", () => {
    const { transcript: session } = transcript();
    session.apply(userMessage("go"), noClient);
    session.apply({ kind: "assistant_started" }, noClient);
    session.apply(
      {
        kind: "part_started",
        index: 0,
        part: { type: "toolCall", callId: "c1", tool: "bash", args: { command: "sleep 9" } },
      },
      noClient,
    );

    expect(session.settle()).toStrictEqual([
      {
        type: "step_updated",
        turnId: "live-1",
        step: {
          kind: "tool",
          id: "0",
          callId: "c1",
          tool: "bash",
          args: { command: "sleep 9" },
          status: "unfinished",
          output: null,
          details: { tool: "bash", command: "sleep 9" },
          partial: false,
        },
      },
      expect.objectContaining({ type: "turn_finished", outcome: "stopped", usage: null }),
    ]);
  });

  it("ignores events with no turn to go into, and updates for steps or tools it does not have", () => {
    const { transcript: session } = transcript();

    expect(session.apply({ kind: "part_started", index: 0, part: { type: "text", text: "" } }, noClient)).toStrictEqual(
      [],
    );
    expect(session.apply(assistantMessage([{ type: "text", text: "orphan" }]), noClient)).toStrictEqual([]);
    expect(session.settle()).toStrictEqual([]);
    session.apply(userMessage("go"), noClient);
    expect(session.apply({ kind: "part_delta", index: 3, delta: "x" }, noClient)).toStrictEqual([]);
    expect(session.apply({ kind: "tool_output", callId: "nope", text: "x" }, noClient)).toStrictEqual([]);
    expect(session.apply(toolResult("nope", "x"), noClient)).toStrictEqual([]);
    expect(session.apply({ kind: "agent_started" }, noClient)).toStrictEqual([]);
    expect(session.live).toBe(true);
  });

  it("adds a retry step where pi reports one, with pi's limit, and keeps the limit through a rebuild", () => {
    const { transcript: session } = transcript();
    session.apply(userMessage("go"), noClient);

    expect(session.apply({ kind: "retry_started", attempt: 2, maxAttempts: 5, error: "503" }, noClient)).toStrictEqual([
      {
        type: "step_added",
        turnId: "live-1",
        step: { kind: "retry", id: "0", attempt: 2, maxAttempts: 5, error: "503" },
      },
    ]);
  });
});

/** A tool result entry. */
function resultEntry(id: string, parentId: string, callId: string): LogEntry {
  return {
    id,
    parentId,
    kind: "toolResult",
    callId,
    tool: "bash",
    text: "x",
    isError: false,
    details: undefined,
    timestamp: 0,
  };
}

/** An assistant entry calling bash as `callId`. */
function callEntry(id: string, parentId: string, callId: string): LogEntry {
  return {
    id,
    parentId,
    kind: "assistant",
    parts: [{ type: "toolCall", callId, tool: "bash", args: { command: "ls" } }],
    stopReason: "toolUse",
    errorMessage: null,
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: null },
    timestamp: 0,
  };
}

/** A compaction entry. */
function compactionEntry(id: string, parentId: string): LogEntry {
  return {
    id,
    parentId,
    kind: "compaction",
    summary: "",
    firstKeptEntryId: "a0",
    tokensBefore: 0,
    system: null,
    timestamp: 0,
  };
}

/** User entries u0, u1, … each under the one before, with these texts. */
function userChain(texts: readonly string[]): LogEntry[] {
  return texts.map((text, index) => userEntry(`u${index}`, index === 0 ? null : `u${index - 1}`, text));
}

describe("createSessionTranscript keeping live and rebuilt alike", () => {
  it("keeps a turn after a run that ended on a tool result a turn, and a steer a steer", () => {
    const { transcript: session } = transcript();
    session.apply(userMessage("go"), noClient);
    session.apply({ kind: "assistant_started" }, noClient);
    session.apply(
      assistantMessage([{ type: "toolCall", callId: "c1", tool: "bash", args: { command: "ls" } }], "toolUse"),
      noClient,
    );
    session.apply(toolResult("c1", "x"), noClient);
    session.apply(userMessage("also"), noClient);
    session.settle();
    // A tool ended the run; the next prompt is a new turn.
    session.apply(userMessage("next"), noClient);
    session.settle();

    expect(
      session.rebuild(
        {
          entries: [
            userEntry("u1", null, "go"),
            callEntry("a1", "u1", "c1"),
            resultEntry("r1", "a1", "c1"),
            userEntry("u2", "r1", "also"),
            userEntry("u3", "u2", "next"),
          ],
          leafId: "u3",
        },
        false,
      ),
    ).toStrictEqual({ kind: "same" });
    expect(session.items().map((item) => [item.id, (item as Turn).steps.map((step) => step.kind)])).toStrictEqual([
      ["live-1", ["tool", "steer"]],
      ["live-2", []],
    ]);
  });

  it("opens a turn with a task and adds notices mid-run as a step, as a rebuild does, not asking whose message (SPEC-0002)", () => {
    const { transcript: session } = transcript();
    let asked = 0;
    const client = () => {
      asked += 1;
      return { clientMessageId: "client-1", auto: false };
    };
    const task: Delivered = {
      v: 1,
      kind: "task",
      deliveries: ["d1"],
      from: "main",
      fromTitle: "修复",
      taskId: "t-1",
      text: "go",
    };
    const notice: Delivered = {
      v: 1,
      kind: "report",
      deliveries: ["d2"],
      events: [{ name: "x", title: "X", sessionId: "s2", taskId: "t-9", event: "failed" }],
    };

    const opened = session.apply({ kind: "agent_message", details: task, timestamp: 0 }, client);
    session.apply({ kind: "assistant_started" }, client);
    session.apply(
      assistantMessage([{ type: "toolCall", callId: "c1", tool: "bash", args: { command: "ls" } }], "toolUse"),
      client,
    );
    session.apply(toolResult("c1", "x"), client);
    const step = session.apply({ kind: "agent_message", details: notice, timestamp: 0 }, client);
    const nothing = session.apply({ kind: "agent_message", details: { ...notice, events: [] }, timestamp: 0 }, client);
    session.settle();

    expect(opened).toMatchObject([
      { type: "turn_started", turn: { id: "live-1", source: { kind: "task", text: "go" }, user: { text: "" } } },
    ]);
    expect(step).toMatchObject([{ type: "step_added", turnId: "live-1", step: { kind: "agent", id: "1" } }]);
    expect(nothing).toStrictEqual([]);
    expect(asked).toBe(0);
    expect(
      session.rebuild(
        {
          entries: [
            { id: "k1", parentId: null, kind: "agent", details: task, timestamp: 0 },
            callEntry("a1", "k1", "c1"),
            resultEntry("r1", "a1", "c1"),
            { id: "n1", parentId: "r1", kind: "agent", details: notice, timestamp: 0 },
            { id: "n2", parentId: "n1", kind: "agent", details: { ...notice, events: [] }, timestamp: 0 },
          ],
          leafId: "n2",
        },
        false,
      ),
    ).toStrictEqual({ kind: "same" });
    expect(session.entryOfTurn("live-1")).toBe("k1");
  });

  it("ends the turn before as it ended when notices open a turn of their own, not as one pi went away in", () => {
    const { transcript: session } = transcript();
    const notice: Delivered = {
      v: 1,
      kind: "report",
      deliveries: ["d1"],
      events: [{ name: "x", title: "X", sessionId: "s2", taskId: "t-9", event: "finished" }],
    };
    session.apply(userMessage("go"), noClient);
    session.apply(assistantMessage([{ type: "text", text: "done" }]), noClient);

    expect(session.apply({ kind: "agent_message", details: notice, timestamp: 0 }, noClient)).toMatchObject([
      { type: "turn_finished", turnId: "live-1", outcome: "done", error: null },
      { type: "turn_started", turn: { id: "live-2", source: { kind: "report" } } },
    ]);
  });

  it("ties the newest records to the newest entries when there are more records than entries", () => {
    const { transcript: session } = transcript();
    session.apply(userMessage("lost"), noClient);
    session.settle();
    session.apply(userMessage("kept"), noClient);
    session.settle();

    session.rebuild({ entries: [userEntry("u1", null, "kept")], leafId: "u1" }, false);

    expect(session.items().map((item) => item.id)).toStrictEqual(["live-2"]);
  });

  it("is live only while a turn is being built", () => {
    const { transcript: session } = transcript();
    expect(session.live).toBe(false);
    session.apply(userMessage("go"), noClient);
    expect(session.live).toBe(true);
    session.settle();
    expect(session.live).toBe(false);
  });

  it("fails a turn pi went away in, whatever its last reply", () => {
    const { transcript: session } = transcript();
    session.apply(userMessage("go"), noClient);
    session.apply(assistantMessage([{ type: "text", text: "half" }]), noClient);

    expect(session.settle(true)).toMatchObject([{ type: "turn_finished", outcome: "failed", error: null }]);
  });

  it("reports notices that appeared anywhere, each with the item it goes before", () => {
    const { transcript: session } = transcript();
    session.rebuild({ entries: [userEntry("u1", null, "a"), userEntry("u2", "u1", "b")], leafId: "u2" }, false);

    expect(
      session.rebuild(
        {
          entries: [
            userEntry("u1", null, "a"),
            compactionEntry("k1", "u1"),
            compactionEntry("k2", "k1"),
            userEntry("u2", "k2", "b"),
            compactionEntry("k3", "u2"),
          ],
          leafId: "k3",
        },
        true,
      ),
    ).toStrictEqual({
      kind: "notices",
      events: [
        { type: "notice_added", notice: expect.objectContaining({ id: "s:k1" }), before: "s:u2" },
        { type: "notice_added", notice: expect.objectContaining({ id: "s:k2" }), before: "s:u2" },
        { type: "notice_added", notice: expect.objectContaining({ id: "s:k3" }), before: null },
      ],
    });
  });
});

describe("createSessionTranscript remembering turn starts", () => {
  /** pi's entries for a run a tool ended, then a new prompt: "next" follows the tool result. */
  const entries = [
    userEntry("u1", null, "go"),
    callEntry("a1", "u1", "c1"),
    resultEntry("r1", "a1", "c1"),
    userEntry("u2", "r1", "next"),
  ];

  it("tells which entries opened the turns it saw live, and which of those the host sent", () => {
    const seen: string[][][] = [];
    let turns = 0;
    const session = createSessionTranscript({
      sessionId: "s",
      newId: () => `live-${++turns}`,
      now: () => 0,
      onTurnsSeen: (entryIds, autoIds) => seen.push([[...entryIds], [...autoIds]]),
    });
    session.apply(userMessage("go"), noClient);
    session.apply(
      assistantMessage([{ type: "toolCall", callId: "c1", tool: "bash", args: { command: "ls" } }], "toolUse"),
      noClient,
    );
    session.apply(toolResult("c1", "x"), noClient);
    session.settle();
    const started = session.apply(userMessage("next"), sentByHost);
    session.settle();

    session.rebuild({ entries, leafId: "u2" }, false);
    session.rebuild({ entries: [], leafId: "u2" }, false);

    expect(started).toMatchObject([{ type: "turn_started", turn: { user: { text: "next", auto: true } } }]);
    expect(seen).toStrictEqual([[["u1", "u2"], ["u2"]]]);
    expect(session.items().map((item) => (item as Turn).user.auto)).toStrictEqual([false, true]);
  });

  it("marks the turns an earlier host sent on its own", () => {
    const recorded = createSessionTranscript({
      sessionId: "s",
      newId: () => "x",
      now: () => 0,
      opened: new Set(["u2"]),
      auto: new Set(["u2"]),
    });

    recorded.rebuild({ entries, leafId: "u2" }, false);

    expect(recorded.items().map((item) => [item.id, (item as Turn).user.auto])).toStrictEqual([
      ["s:u1", false],
      ["s:u2", true],
    ]);
  });

  it("follows the turn starts an earlier host recorded, and tells steers by position without them", () => {
    const recorded = createSessionTranscript({
      sessionId: "s",
      newId: () => "x",
      now: () => 0,
      opened: new Set(["u2"]),
    });
    const { transcript: unrecorded } = transcript();

    recorded.rebuild({ entries, leafId: "u2" }, false);
    unrecorded.rebuild({ entries, leafId: "u2" }, false);

    expect(recorded.items().map((item) => [item.id, (item as Turn).steps.map((step) => step.kind)])).toStrictEqual([
      ["s:u1", ["tool"]],
      ["s:u2", []],
    ]);
    expect(unrecorded.items().map((item) => [item.id, (item as Turn).steps.map((step) => step.kind)])).toStrictEqual([
      ["s:u1", ["tool", "steer"]],
    ]);
  });
});

describe("createSessionTranscript comparing a rebuild", () => {
  it("reports items that went away as changed, and turns added with notices too", () => {
    const { transcript: session } = transcript();
    session.rebuild({ entries: [userEntry("u1", null, "a"), userEntry("u2", "u1", "b")], leafId: "u2" }, false);

    expect(session.rebuild({ entries: [], leafId: "u1" }, false)).toStrictEqual({ kind: "changed" });
    expect(
      session.rebuild({ entries: [compactionEntry("k1", "u1"), userEntry("u3", "k1", "c")], leafId: "u3" }, false),
    ).toStrictEqual({ kind: "changed" });
  });

  it("forgets the old file's entries when it reads the whole session again", () => {
    const { transcript: session } = transcript();
    session.rebuild({ entries: [userEntry("old", null, "gone")], leafId: "old" }, false);

    session.rebuild({ entries: [userEntry("u1", "old", "new")], leafId: "u1" }, true);

    expect(session.items().map((item) => item.id)).toStrictEqual(["s:u1"]);
  });
});

describe("createSessionTranscript rebuilding", () => {
  it("reports a rebuild that differs from what was built live as changed", () => {
    const { transcript: session } = transcript();
    session.apply(userMessage("go"), noClient);
    session.settle();

    expect(session.rebuild({ entries: [userEntry("u1", null, "went")], leafId: "u1" }, false)).toStrictEqual({
      kind: "changed",
    });
    expect(session.items()).toStrictEqual([
      expect.objectContaining({ id: "live-1", user: expect.objectContaining({ text: "went" }) }),
    ]);
  });

  it("ties live turns to the newest turns of the read, from the end", () => {
    const { transcript: session } = transcript();
    session.apply(userMessage("b"), noClient);
    session.settle();

    session.rebuild({ entries: [userEntry("u1", null, "a"), userEntry("u2", "u1", "b")], leafId: "u2" }, false);

    expect(session.items().map((item) => item.id)).toStrictEqual(["s:u1", "live-1"]);
  });

  it("finds the entry that opened a turn, read or seen live once tied, and none for a turn not tied or no turn", () => {
    const { transcript: session } = transcript();
    session.rebuild({ entries: [userEntry("u1", null, "a")], leafId: "u1" }, false);
    session.apply(userMessage("b"), noClient);
    const running = session.entryOfTurn("live-1");
    session.settle();

    session.rebuild({ entries: [userEntry("u2", "u1", "b")], leafId: "u2" }, false);

    expect([
      session.entryOfTurn("s:u1"),
      running,
      session.entryOfTurn("live-1"),
      session.entryOfTurn("s:u2"),
      session.entryOfTurn("s:u9"),
    ]).toStrictEqual(["u1", null, "u2", null, null]);
  });

  it("reads the whole session again on reset, keeping the timings of turns seen live", () => {
    const { transcript: session } = transcript();
    session.apply(userMessage("a"), noClient);
    session.settle();
    session.rebuild({ entries: [userEntry("u1", null, "a")], leafId: "u1" }, false);

    expect(session.rebuild({ entries: [userEntry("u1", null, "a")], leafId: "u1" }, true)).toStrictEqual({
      kind: "same",
    });
    expect(session.cursor).toBe("u1");
    expect(session.rebuild({ entries: [userEntry("v1", null, "x")], leafId: "v1" }, true)).toStrictEqual({
      kind: "changed",
    });
    expect(session.items().map((item) => item.id)).toStrictEqual(["s:v1"]);
  });
});

describe("createSessionTranscript pages", () => {
  it("shows the latest 20 turns with the notices after them, and says older ones exist", () => {
    const page = longSession(25).latest();

    expect(page.hasOlder).toBe(true);
    expect(ids(page.items).slice(0, 3)).toStrictEqual(["s:u5", "s:k5", "s:u6"]);
    expect(page.items.filter((item) => item.kind === "turn")).toHaveLength(20);
    expect(ids(page.items).at(-1)).toBe("s:k24");
  });

  it("shows everything when there are 20 turns or fewer", () => {
    expect(longSession(20).latest()).toMatchObject({ hasOlder: false, items: { length: 40 } });
    expect(longSession(0).latest()).toStrictEqual({ items: [], hasOlder: false });
  });

  it("sends long text as a preview, keeps it whole, and gives a step back whole", () => {
    const { transcript: session } = transcript();
    const long = "x".repeat(STEP_TEXT_LIMIT + 1);
    session.apply(userMessage("go"), noClient);
    session.apply({ kind: "assistant_started" }, noClient);
    session.apply(
      assistantMessage([{ type: "toolCall", callId: "c1", tool: "read", args: { path: "a" } }], "toolUse"),
      noClient,
    );

    const [event] = session.apply({ kind: "tool_output", callId: "c1", text: long }, noClient);

    expect(event).toMatchObject({ type: "step_updated", step: { output: "x".repeat(STEP_TEXT_LIMIT), partial: true } });
    expect(session.latest().items[0]).toMatchObject({ steps: [{ partial: true }] });
    expect(session.step("live-1", "0")).toMatchObject({ output: long, partial: false });
    expect(session.step("live-1", "9")).toBeNull();
    expect(session.step("nope", "0")).toBeNull();
  });

  it("fits snapshots and pages within the size limit, always taking at least one item", () => {
    const { transcript: session } = transcript();
    const big = "y".repeat(PAGE_BYTES / 4);
    session.rebuild({ entries: userChain([big, big, big, big, big]), leafId: "u4" }, false);

    expect(ids(session.latest().items)).toStrictEqual(["s:u2", "s:u3", "s:u4"]);
    expect(session.latest().hasOlder).toBe(true);
    expect(ids(present(session.before("s:u2", 10), "a page").items)).toStrictEqual(["s:u0", "s:u1"]);

    const huge = transcript().transcript;
    huge.rebuild({ entries: [userEntry("h1", null, "z".repeat(PAGE_BYTES * 2))], leafId: "h1" }, false);
    expect(ids(huge.latest().items)).toStrictEqual(["s:h1"]);
  });

  it("pages back from an item, and knows no item it does not have", () => {
    const session = longSession(5);

    expect(session.before("s:u3", 2)).toStrictEqual({ items: session.items().slice(4, 6), hasOlder: true });
    expect(session.before("s:u1", 10)).toStrictEqual({ items: session.items().slice(0, 2), hasOlder: false });
    expect(session.before("s:u0", 10)).toStrictEqual({ items: [], hasOlder: false });
    expect(session.before("nope", 10)).toBeNull();
  });
});

describe("createSessionTranscript noting a restart", () => {
  const first = [userEntry("u1", null, "one")];
  const both = [...first, userEntry("u2", "u1", "two")];

  it("adds the notice after the items so far and keeps it there through rebuilds", () => {
    const { transcript: session, clock } = transcript();
    session.rebuild({ entries: first, leafId: "u1" }, false);
    clock.time = 7;

    const added = session.noteRestart(2);

    const notice = { kind: "notice", id: "live-1", notice: "restarted", attempt: 2, timestamp: 7 };
    expect(added).toStrictEqual({ type: "notice_added", notice, before: null });
    expect(ids(session.items())).toStrictEqual(["s:u1", "live-1"]);
    expect(session.rebuild({ entries: both.slice(1), leafId: "u2" }, false)).toStrictEqual({ kind: "changed" });
    expect(ids(session.items())).toStrictEqual(["s:u1", "live-1", "s:u2"]);
    expect(session.rebuild({ entries: both, leafId: "u2" }, true)).toStrictEqual({ kind: "same" });
  });

  it("keeps notices after the same item in order, and moves one whose item went away to the end", () => {
    const { transcript: session } = transcript();
    const start = session.noteRestart(1);
    session.rebuild({ entries: first, leafId: "u1" }, false);
    session.noteRestart(1);
    session.noteRestart(2);

    session.rebuild({ entries: [userEntry("x1", null, "other")], leafId: "x1" }, true);

    expect(start).toMatchObject({ notice: { id: "live-1" } });
    expect(ids(session.items())).toStrictEqual(["live-1", "s:x1", "live-2", "live-3"]);
  });
});

describe("createSessionTranscript's entries", () => {
  it("gives every entry it read and the current branch's, as the status bar adds them up", () => {
    const { transcript: session } = transcript();
    const entries = [userEntry("u1", null, "one"), userEntry("u2", "u1", "two"), userEntry("u3", "u1", "three")];

    session.rebuild({ entries, leafId: "u3" }, false);

    expect(session.entries()).toStrictEqual({ all: entries, branch: [entries[0], entries[2]] });
  });
});
