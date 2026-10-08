import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { parseFixture, present } from "@atrium/testkit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES_DIR } from "../../test/contract";
import { type LogEntry, toLogEntry } from "./log-entry";

/**
 * The entries of the recorded history scenario, from the last `get_entries` pi answered.
 *
 * @remarks
 * The scenario (contract/history.pi.test.ts) holds every kind of entry the transcript rebuild
 * reads, written by real pi; times and token counts in it are normalized to 0.
 *
 * @sideEffects Reads the fixture file.
 * @returns pi's entries.
 */
function recordedEntries(): SessionEntry[] {
  const fixture = parseFixture(readFileSync(join(FIXTURES_DIR, "pi-1.0.2", "history.jsonl"), "utf8"));
  const answers = fixture.flatMap((record) =>
    record.kind === "stdout" && record.record["command"] === "get_entries" ? [record.record] : [],
  );
  const data = present(answers.at(-1), "the last get_entries answer")["data"] as unknown as { entries: SessionEntry[] };
  return data.entries;
}

/** An assistant message as pi stores it, with the fields a test varies. */
function assistantEntry(fields: Record<string, unknown>): SessionEntry {
  return {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2026-10-08T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [],
      api: "faux",
      provider: "faux",
      model: "faux-1",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
      stopReason: "stop",
      timestamp: 0,
      ...fields,
    },
  } as unknown as SessionEntry;
}

/** A user message as pi stores it, sent at 5 ms. */
function userEntry(content: unknown): SessionEntry {
  return {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-10-08T00:00:00.000Z",
    message: { role: "user", content, timestamp: 5 },
  } as SessionEntry;
}

const none = { input: 0, output: 0 };

describe("toLogEntry", () => {
  it("maps a recorded session with tools, a retry, a compaction and a branch", () => {
    expect(recordedEntries().map(toLogEntry)).toStrictEqual([
      { id: "e3", parentId: null, timestamp: 0, kind: "other" },
      { id: "e4", parentId: "e3", timestamp: 0, kind: "other" },
      { id: "e5", parentId: "e4", timestamp: 0, kind: "other" },
      { id: "e6", parentId: "e5", timestamp: 0, kind: "user", text: "one", images: 0 },
      {
        id: "e7",
        parentId: "e6",
        timestamp: 0,
        kind: "assistant",
        parts: [
          { type: "thinking", text: "Look first." },
          { type: "toolCall", callId: "call-1", tool: "bash", args: { command: "printf 'tool-%s' ok" } },
        ],
        stopReason: "toolUse",
        errorMessage: null,
        usage: none,
      },
      {
        id: "e8",
        parentId: "e7",
        timestamp: 0,
        kind: "toolResult",
        callId: "call-1",
        tool: "bash",
        text: "tool-ok",
        isError: false,
        details: undefined,
      },
      {
        id: "e9",
        parentId: "e8",
        timestamp: 0,
        kind: "assistant",
        parts: [{ type: "toolCall", callId: "call-2", tool: "write", args: { path: "notes.txt", content: "a\nb\n" } }],
        stopReason: "toolUse",
        errorMessage: null,
        usage: none,
      },
      {
        id: "e10",
        parentId: "e9",
        timestamp: 0,
        kind: "toolResult",
        callId: "call-2",
        tool: "write",
        text: "Successfully wrote to notes.txt",
        isError: false,
        details: undefined,
      },
      {
        id: "e11",
        parentId: "e10",
        timestamp: 0,
        kind: "assistant",
        parts: [
          {
            type: "toolCall",
            callId: "call-3",
            tool: "edit",
            args: { path: "notes.txt", edits: [{ oldText: "b", newText: "c\nd" }] },
          },
        ],
        stopReason: "toolUse",
        errorMessage: null,
        usage: none,
      },
      {
        id: "e12",
        parentId: "e11",
        timestamp: 0,
        kind: "toolResult",
        callId: "call-3",
        tool: "edit",
        text: "Successfully replaced 1 block(s) in notes.txt.",
        isError: false,
        details: {
          diff: " 1 a\n-2 b\n+2 c\n+3 d",
          patch: "--- notes.txt\n+++ notes.txt\n@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n",
          firstChangedLine: 2,
        },
      },
      {
        id: "e13",
        parentId: "e12",
        timestamp: 0,
        kind: "assistant",
        parts: [{ type: "toolCall", callId: "call-4", tool: "read", args: { path: "notes.txt", offset: 2, limit: 1 } }],
        stopReason: "toolUse",
        errorMessage: null,
        usage: none,
      },
      {
        id: "e14",
        parentId: "e13",
        timestamp: 0,
        kind: "toolResult",
        callId: "call-4",
        tool: "read",
        text: "c\n\n[2 more lines in file. Use offset=3 to continue.]",
        isError: false,
        details: undefined,
      },
      {
        id: "e15",
        parentId: "e14",
        timestamp: 0,
        kind: "assistant",
        parts: [{ type: "text", text: "first answer" }],
        stopReason: "stop",
        errorMessage: null,
        usage: none,
      },
      { id: "e16", parentId: "e15", timestamp: 0, kind: "user", text: "two", images: 0 },
      {
        id: "e2",
        parentId: "e16",
        timestamp: 0,
        kind: "assistant",
        parts: [],
        stopReason: "error",
        errorMessage: "upstream returned 503 service unavailable",
        usage: none,
      },
      { id: "e1", parentId: "e2", timestamp: 0, kind: "omission", targetId: "e2" },
      {
        id: "e17",
        parentId: "e1",
        timestamp: 0,
        kind: "assistant",
        parts: [{ type: "text", text: "second answer" }],
        stopReason: "stop",
        errorMessage: null,
        usage: none,
      },
      {
        id: "e18",
        parentId: "e17",
        timestamp: 0,
        kind: "compaction",
        summary:
          "A short summary.\n\n---\n\n**Turn Context (split turn):**\n\nThe turn so far.\n\n<modified-files>\nnotes.txt\n</modified-files>",
        tokensBefore: 0,
      },
      { id: "e19", parentId: "e18", timestamp: 0, kind: "user", text: "three", images: 0 },
      {
        id: "e20",
        parentId: "e19",
        timestamp: 0,
        kind: "assistant",
        parts: [{ type: "text", text: "third answer" }],
        stopReason: "stop",
        errorMessage: null,
        usage: none,
      },
      { id: "e21", parentId: "e15", timestamp: 0, kind: "user", text: "two, differently", images: 0 },
      {
        id: "e22",
        parentId: "e21",
        timestamp: 0,
        kind: "assistant",
        parts: [{ type: "text", text: "branch answer" }],
        stopReason: "stop",
        errorMessage: null,
        usage: none,
      },
      { id: "e23", parentId: "e20", timestamp: 0, kind: "user", text: "four", images: 0 },
      {
        id: "e24",
        parentId: "e23",
        timestamp: 0,
        kind: "assistant",
        parts: [{ type: "text", text: "fourth answer" }],
        stopReason: "stop",
        errorMessage: null,
        usage: none,
      },
    ] satisfies LogEntry[]);
  });

  it("dates a message by the message's own time and any other entry by the entry's", () => {
    expect(toLogEntry(assistantEntry({ timestamp: 1_234 })).timestamp).toBe(1_234);
    expect(
      toLogEntry({
        type: "label",
        id: "l1",
        parentId: "a1",
        timestamp: "2026-10-08T00:00:01.500Z",
        targetId: "a1",
        label: "x",
      }),
    ).toStrictEqual({ id: "l1", parentId: "a1", timestamp: Date.UTC(2026, 9, 8, 0, 0, 1, 500), kind: "other" });
  });

  it("dates a message without a time of its own by its entry", () => {
    expect(toLogEntry(assistantEntry({ timestamp: undefined })).timestamp).toBe(Date.UTC(2026, 9, 8));
  });

  it("dates an entry whose time cannot be read at 0", () => {
    expect(
      toLogEntry({ type: "label", id: "l1", parentId: null, timestamp: "yesterday", targetId: "a1", label: "x" })
        .timestamp,
    ).toBe(0);
  });

  it("reads streaming and deferred stop reasons as an ordinary stop", () => {
    expect(toLogEntry(assistantEntry({ stopReason: "pending" }))).toMatchObject({ stopReason: "stop" });
    expect(toLogEntry(assistantEntry({ stopReason: "deferred" }))).toMatchObject({ stopReason: "stop" });
    expect(toLogEntry(assistantEntry({ stopReason: "aborted" }))).toMatchObject({ stopReason: "aborted" });
  });

  it("keeps the input and output token counts of an assistant message", () => {
    expect(
      toLogEntry(
        assistantEntry({
          usage: { input: 120, output: 30, cacheRead: 5, cacheWrite: 0, totalTokens: 155, cost: {} },
        }),
      ),
    ).toMatchObject({ usage: { input: 120, output: 30 } });
  });

  it("counts the images of a user message and keeps a string message as its text", () => {
    expect(
      toLogEntry(
        userEntry([
          { type: "text", text: "look" },
          { type: "image", data: "", mimeType: "image/png" },
        ]),
      ),
    ).toStrictEqual({ id: "u1", parentId: null, timestamp: 5, kind: "user", text: "look", images: 1 });
    expect(toLogEntry(userEntry("plain"))).toStrictEqual({
      id: "u1",
      parentId: null,
      timestamp: 5,
      kind: "user",
      text: "plain",
      images: 0,
    });
  });

  it("treats a context edit that replaces its target, rather than removing it, as nothing to show", () => {
    expect(
      toLogEntry({
        type: "context_edit",
        id: "c1",
        parentId: "a1",
        timestamp: "1970-01-01T00:00:00.000Z",
        targetId: "a1",
        replacement: { role: "user", content: "edited", timestamp: 0 },
      } as SessionEntry),
    ).toStrictEqual({ id: "c1", parentId: "a1", timestamp: 0, kind: "other" });
  });

  it("treats a `!bash` message as nothing to show, keeping its place in the tree", () => {
    expect(
      toLogEntry({
        type: "message",
        id: "b1",
        parentId: "a1",
        timestamp: "1970-01-01T00:00:00.009Z",
        message: { role: "bashExecution", command: "ls", output: "", exitCode: 0, timestamp: 7 },
      } as SessionEntry),
    ).toStrictEqual({ id: "b1", parentId: "a1", timestamp: 9, kind: "other" });
  });
});
