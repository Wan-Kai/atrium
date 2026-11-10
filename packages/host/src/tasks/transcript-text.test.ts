import type { LogEntry } from "@atrium/pi";
import { describe, expect, it } from "vitest";
import { PAGE_CHARS, pageOf, renderTranscript } from "./transcript-text";

/** The entries the tests build. */
type Assistant = Extract<LogEntry, { kind: "assistant" }>;
type ToolResult = Extract<LogEntry, { kind: "toolResult" }>;

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null };

/** A user entry. */
const user = (id: string, parentId: string | null, text: string): LogEntry => ({
  id,
  parentId,
  kind: "user",
  text,
  images: 0,
  skill: null,
  timestamp: 1,
});

/** An assistant entry with text and a tool call. */
const assistant = (id: string, parentId: string | null, text: string, tool?: string): Assistant => ({
  id,
  parentId,
  kind: "assistant",
  parts: [
    { type: "thinking", text: "secret thoughts" },
    { type: "text", text },
    ...(tool === undefined ? [] : [{ type: "toolCall" as const, callId: "c", tool, args: { path: "a.txt" } }]),
  ],
  stopReason: "stop",
  errorMessage: null,
  usage,
  timestamp: 2,
});

/** A tool result entry. */
const result = (id: string, parentId: string, text: string): ToolResult => ({
  id,
  parentId,
  kind: "toolResult",
  callId: "c",
  tool: "read",
  text,
  isError: false,
  details: null,
  timestamp: 3,
});

describe("renderTranscript", () => {
  const entries = [user("1", null, "build it"), assistant("2", "1", "ok", "read"), result("3", "2", "file text")];

  it("shows the words of both sides and leaves thinking out", () => {
    const text = renderTranscript(entries, false);

    expect(text).toBe("[user]\nbuild it\n\n[assistant]\nok");
    expect(text).not.toContain("secret thoughts");
  });

  it("shows the tool calls and their results short when asked for the steps", () => {
    const text = renderTranscript(entries, true);

    expect(text).toContain('[call read {"path":"a.txt"}]');
    expect(text).toContain("[result read]\nfile text");
    expect(renderTranscript([...entries, result("4", "3", "x".repeat(2000))], true)).toContain(`${"x".repeat(800)}…`);
  });

  it("follows the branch the last entry is on, not an abandoned one", () => {
    const branched = [user("1", null, "first"), assistant("2", "1", "old answer"), assistant("3", "1", "new answer")];

    expect(renderTranscript(branched, false)).toBe("[user]\nfirst\n\n[assistant]\nnew answer");
  });

  it("notes a compaction and an image, and is empty for a conversation without words", () => {
    const compacted: LogEntry = {
      id: "1",
      parentId: null,
      kind: "compaction",
      summary: "we did x",
      firstKeptEntryId: "1",
      tokensBefore: 10,
      system: null,
      timestamp: 1,
    };

    expect(renderTranscript([compacted], false)).toContain("we did x");
    expect(renderTranscript([{ ...user("1", null, "see"), images: 2 } as LogEntry], false)).toContain(
      "(2 image(s) attached)",
    );
    expect(renderTranscript([], false)).toBe("");
  });

  it("does not loop on a file whose entries point at each other", () => {
    const loop = [user("1", "2", "a"), assistant("2", "1", "b")];

    expect(renderTranscript(loop, false)).toBe("[user]\na\n\n[assistant]\nb");
  });
});

/** A tool call's arguments as they are written, of a given length. */
const argsOf = (length: number) => `{"v":"${"a".repeat(length - 8)}"}`;

/** An assistant entry that calls `read` with an argument of the given text. */
const call = (text: string): Assistant => ({
  ...assistant("2", "1", "", "read"),
  parts: [{ type: "toolCall", callId: "c", tool: "read", args: { v: text } }],
});

describe("renderTranscript: what it leaves out and where it cuts", () => {
  it("cuts a tool call's arguments at 300 characters and a result at 800, and no sooner", () => {
    expect(renderTranscript([user("1", null, "go"), call("a".repeat(292))], true)).toContain(
      `[call read ${argsOf(300)}]`,
    );
    expect(renderTranscript([user("1", null, "go"), call("a".repeat(293))], true)).toContain(
      `${argsOf(301).slice(0, 300)}…]`,
    );
    expect(renderTranscript([user("1", null, "go"), result("2", "1", "r".repeat(800))], true)).toContain(
      `]\n${"r".repeat(800)}`,
    );
    expect(renderTranscript([user("1", null, "go"), result("2", "1", "r".repeat(800))], true)).not.toContain("…");
    expect(renderTranscript([user("1", null, "go"), result("2", "1", "r".repeat(801))], true)).toContain(
      `${"r".repeat(800)}…`,
    );
  });

  it("marks a result that failed, and shows no assistant block for a reply of thinking and nothing else", () => {
    const failed: LogEntry = { ...result("3", "2", "boom"), isError: true };
    const silent: LogEntry = { ...assistant("2", "1", ""), parts: [{ type: "thinking", text: "hmm" }] };

    expect(renderTranscript([user("1", null, "go"), assistant("2", "1", "", "read"), failed], true)).toContain(
      "[result read (error)]\nboom",
    );
    expect(renderTranscript([user("1", null, "go"), silent], true)).toBe("[user]\ngo");
  });

  it("shows a compaction with the steps too, and joins the pieces with a blank line", () => {
    const compacted: LogEntry = {
      id: "1",
      parentId: null,
      kind: "compaction",
      summary: "we did x",
      firstKeptEntryId: "1",
      tokensBefore: 10,
      system: null,
      timestamp: 1,
    };

    expect(renderTranscript([compacted, user("2", "1", "next")], true)).toBe(
      "[earlier part of the conversation, compacted]\nwe did x\n\n[user]\nnext",
    );
  });
});

describe("pageOf", () => {
  it("cuts a long text into pages of PAGE_CHARS, counting from 1", () => {
    const text = "a".repeat(PAGE_CHARS) + "b".repeat(5);

    expect(pageOf(text, 1)).toStrictEqual({ text: "a".repeat(PAGE_CHARS), page: 1, pages: 2 });
    expect(pageOf(text, 2)).toStrictEqual({ text: "bbbbb", page: 2, pages: 2 });
    expect(pageOf(text, 3)).toBeNull();
  });

  it("makes an empty text one empty page", () => {
    expect(pageOf("", 1)).toStrictEqual({ text: "", page: 1, pages: 1 });
    expect(pageOf("", 2)).toBeNull();
  });
});
