import { describe, expect, it } from "vitest";
import { decodeArgument } from "../agent/agent";
import {
  GraphChangeArgs,
  NodeDoneArgs,
  NudgeCommand,
  ProgressCommand,
  ReplyCommand,
  ResumeCommand,
  TASK_COMMANDS,
  TASK_TEXT_LIMITS,
  TaskMessageDetails,
  commandText,
  readRequest,
  readSelf,
  writeRequest,
} from "./schema";

/** A flag value as the host writes it. */
const flag = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("readSelf: what the --atrium-task flag says", () => {
  it("reads a node with its role, and the task conversation", () => {
    expect(readSelf(flag({ v: 1, kind: "node", role: "work" }))).toStrictEqual({ v: 1, kind: "node", role: "work" });
    expect(readSelf(flag({ v: 1, kind: "node", role: "check", isolated: false }))).toStrictEqual({
      v: 1,
      kind: "node",
      role: "check",
      isolated: false,
    });
    expect(readSelf(flag({ v: 1, kind: "conversation" }))).toStrictEqual({ v: 1, kind: "conversation" });
  });

  it.each([
    ["no flag", undefined],
    ["not base64url JSON", "%%%"],
    ["an unknown kind", flag({ v: 1, kind: "other" })],
    ["a node without a role", flag({ v: 1, kind: "node" })],
    ["an unknown role", flag({ v: 1, kind: "node", role: "admin" })],
    ["another version", flag({ v: 2, kind: "node", role: "work" })],
    ["an identity the flag must not carry", flag({ v: 1, kind: "node", role: "work", sessionId: "s-1" })],
    ["extra fields on a conversation", flag({ v: 1, kind: "conversation", role: "work" })],
  ])("is neither for %s", (_name, value) => {
    expect(readSelf(value)).toBeNull();
  });
});

describe("requests on the status line", () => {
  it("round-trips a call of each tool", () => {
    const done = { kind: "call", id: "call-1", op: "node_done", args: { ok: true, summary: "did it" } } as const;
    const change = {
      kind: "call",
      id: "call-2",
      op: "request_graph_change",
      args: { reason: "why", suggestion: "how" },
    } as const;

    expect(readRequest(writeRequest(done))).toStrictEqual({ request: done });
    expect(readRequest(writeRequest(change))).toStrictEqual({ request: change });
    expect(JSON.parse(writeRequest(done))).toStrictEqual({ v: 1, ...done });
  });

  it("round-trips the cancel note", () => {
    const note = { kind: "note", id: "n1", op: "cancel", args: { id: "call-1" } } as const;

    expect(readRequest(writeRequest(note))).toStrictEqual({ request: note });
  });

  it("reads a request padded past the envelope limit as a bad request", () => {
    const text = writeRequest({ kind: "note", id: "n1", op: "cancel", args: { id: "call-1" } });

    expect(readRequest(text + " ".repeat(1024 * 1024))).toStrictEqual({ bad: null, kind: null });
    expect(readRequest(text + " ".repeat(1024))).toStrictEqual({ request: expect.anything() });
  });

  it.each([
    ["text that is not JSON", "{", null, null],
    ["JSON that is not an envelope", "[]", null, null],
    ["a longer-than-limit envelope", " ".repeat(1024 * 1024 + 1), null, null],
    [
      "another version",
      JSON.stringify({ v: 2, id: "a", kind: "call", op: "node_done", args: { ok: true, summary: "" } }),
      "a",
      "call",
    ],
    ["an unknown call", JSON.stringify({ v: 1, id: "a", kind: "call", op: "task_status", args: {} }), "a", "call"],
    [
      "a note named as a call",
      JSON.stringify({ v: 1, id: "a", kind: "call", op: "cancel", args: { id: "x" } }),
      "a",
      "call",
    ],
    ["a call named as a note", JSON.stringify({ v: 1, id: "a", kind: "note", op: "node_done", args: {} }), "a", "note"],
    [
      "bad arguments",
      JSON.stringify({ v: 1, id: "a", kind: "call", op: "node_done", args: { ok: "yes", summary: "" } }),
      "a",
      "call",
    ],
    [
      "extra arguments",
      JSON.stringify({ v: 1, id: "a", kind: "call", op: "node_done", args: { ok: true, summary: "", who: "me" } }),
      "a",
      "call",
    ],
    [
      "an extra envelope field",
      JSON.stringify({ v: 1, id: "a", kind: "call", op: "node_done", args: { ok: true, summary: "" }, session: "s" }),
      null,
      null,
    ],
  ])("reads %s as a bad request", (_name, text, bad, kind) => {
    expect(readRequest(text)).toStrictEqual({ bad, kind });
  });
});

describe("the arguments' limits", () => {
  it("takes a summary and a reason up to their limits and no more", () => {
    expect(NodeDoneArgs.safeParse({ ok: true, summary: "x".repeat(TASK_TEXT_LIMITS.summary) }).success).toBe(true);
    expect(NodeDoneArgs.safeParse({ ok: true, summary: "x".repeat(TASK_TEXT_LIMITS.summary + 1) }).success).toBe(false);
    expect(
      NodeDoneArgs.safeParse({ ok: false, summary: "", reason: "r".repeat(TASK_TEXT_LIMITS.reason) }).success,
    ).toBe(true);
    expect(
      NodeDoneArgs.safeParse({ ok: false, summary: "", reason: "r".repeat(TASK_TEXT_LIMITS.reason + 1) }).success,
    ).toBe(false);
  });

  it("leaves empty summaries and reasons to the host to refuse", () => {
    expect(NodeDoneArgs.safeParse({ ok: true, summary: "" }).success).toBe(true);
    expect(NodeDoneArgs.safeParse({ ok: false, summary: "", reason: "" }).success).toBe(true);
  });

  it("needs both texts of a graph change, up to their limits", () => {
    expect(GraphChangeArgs.safeParse({ reason: "r", suggestion: "s" }).success).toBe(true);
    expect(GraphChangeArgs.safeParse({ reason: "", suggestion: "s" }).success).toBe(false);
    expect(GraphChangeArgs.safeParse({ reason: "r", suggestion: "" }).success).toBe(false);
    expect(
      GraphChangeArgs.safeParse({ reason: "r".repeat(TASK_TEXT_LIMITS.reason + 1), suggestion: "s" }).success,
    ).toBe(false);
    expect(
      GraphChangeArgs.safeParse({ reason: "r", suggestion: "s".repeat(TASK_TEXT_LIMITS.suggestion + 1) }).success,
    ).toBe(false);
  });
});

describe("the host's commands", () => {
  it("reads a reply of either kind, and refuses a code the extension has no words for", () => {
    expect(ReplyCommand.safeParse({ v: 1, id: "a", ok: true, result: { recorded: true } }).success).toBe(true);
    expect(ReplyCommand.safeParse({ v: 1, id: "a", ok: false, code: "task_caller_invalid" }).success).toBe(true);
    expect(
      ReplyCommand.safeParse({ v: 1, id: "a", ok: false, code: "task_args_invalid", params: { field: "summary" } })
        .success,
    ).toBe(true);
    expect(ReplyCommand.safeParse({ v: 1, id: "a", ok: false, code: "nope" }).success).toBe(false);
    expect(ReplyCommand.safeParse({ v: 2, id: "a", ok: true, result: {} }).success).toBe(false);
  });

  it("reads nudge, resume and progress, with their limits", () => {
    expect(NudgeCommand.safeParse({ v: 1, id: "n-1" }).success).toBe(true);
    expect(NudgeCommand.safeParse({ v: 1, id: "" }).success).toBe(false);
    expect(ResumeCommand.safeParse({ v: 1, id: "r", kind: "graph_changed", text: "new contract" }).success).toBe(true);
    expect(ResumeCommand.safeParse({ v: 1, id: "r", kind: "later", text: "x" }).success).toBe(false);
    expect(ResumeCommand.safeParse({ v: 1, id: "r", kind: "continue", text: "" }).success).toBe(false);
    expect(
      ResumeCommand.safeParse({ v: 1, id: "r", kind: "continue", text: "x".repeat(TASK_TEXT_LIMITS.resume + 1) })
        .success,
    ).toBe(false);
    expect(ProgressCommand.safeParse({ v: 1, id: "p", at: 1, text: "x" }).success).toBe(true);
    expect(ProgressCommand.safeParse({ v: 1, id: "p", at: -1, text: "x" }).success).toBe(false);
    expect(
      ProgressCommand.safeParse({ v: 1, id: "p", at: 1, text: "x".repeat(TASK_TEXT_LIMITS.progress + 1) }).success,
    ).toBe(false);
  });

  it("writes a command the extension's decoder reads back", () => {
    const text = commandText("nudge", { v: 1, id: "n-1" });
    const [slash, action, argument] = text.split(" ");

    expect(slash).toBe("/atrium-task");
    expect(action).toBe("nudge");
    expect(decodeArgument(String(argument))).toStrictEqual({ v: 1, id: "n-1" });
    expect(Object.keys(TASK_COMMANDS).toSorted()).toStrictEqual(["nudge", "progress", "reply", "resume"]);
  });

  it("describes the custom messages the extension writes", () => {
    expect(TaskMessageDetails.safeParse({ v: 1, kind: "nudge", id: "a" }).success).toBe(true);
    expect(TaskMessageDetails.safeParse({ v: 1, kind: "resume", id: "a", reason: "wake" }).success).toBe(true);
    expect(TaskMessageDetails.safeParse({ v: 1, kind: "progress", id: "a", at: 1, text: "t" }).success).toBe(true);
    expect(TaskMessageDetails.safeParse({ v: 1, kind: "other", id: "a" }).success).toBe(false);
  });
});
