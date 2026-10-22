import { describe, expect, it } from "vitest";
import {
  AgentEvent,
  AgentSelf,
  Delivery,
  ENVELOPE_LIMIT,
  FINAL_EVENTS,
  HANDLE,
  MessageDetails,
  ReportDetail,
  TEXT_LIMITS,
  readCancel,
  readReply,
  readRequest,
  writeRequest,
} from "./channel";

/** Every code the host answers a call with (SPEC-0002, "接口 · 通道的错误码"). */
const CODES = [
  "agent_limit",
  "agent_depth_limit",
  "agent_not_allowed",
  "agent_gone",
  "agent_handed_off",
  "agent_busy",
  "agent_name_taken",
  "agent_name_invalid",
  "agent_role_not_allowed",
  "agent_place_invalid",
  "agent_place_failed",
  "agent_model_unknown",
  "agent_thinking_invalid",
  "agent_context_unavailable",
  "agent_question_closed",
  "agent_question_open",
  "agent_text_too_long",
  "agent_bad_request",
  "agent_failed",
];

/** A finished task's event, with everything an event may carry. */
const EVENT = {
  name: "audit",
  title: "审查",
  sessionId: "s1",
  taskId: "t1",
  event: "finished",
  reply: { text: "done", totalChars: 4 },
  options: ["a"],
  changes: { files: 1, added: 2, removed: 3 },
};

describe("readRequest", () => {
  it("reads a call and a note the extension wrote, with their arguments", () => {
    const call = writeRequest({ kind: "call", id: "call-1", op: "send", args: { to: "audit", message: "go on" } });
    const note = writeRequest({ kind: "note", id: "n1", op: "progress", args: { message: "half done" } });

    expect(JSON.parse(call)).toStrictEqual({
      v: 1,
      kind: "call",
      id: "call-1",
      op: "send",
      args: { to: "audit", message: "go on" },
    });
    expect(readRequest(call)).toStrictEqual({
      request: { kind: "call", id: "call-1", op: "send", args: { to: "audit", message: "go on" } },
    });
    expect(readRequest(note)).toStrictEqual({
      request: { kind: "note", id: "n1", op: "progress", args: { message: "half done" } },
    });
  });

  it("reads each call's own arguments, and the longest text each takes", () => {
    const spawn = {
      name: "audit",
      task: "a".repeat(TEXT_LIMITS.task),
      role: "work",
      context: "fork",
      place: "worktree",
      model: "openai/gpt-6",
      thinking: "xhigh",
      branch: "/tmp/b.jsonl",
    };
    for (const [op, args] of [
      ["spawn", spawn],
      ["reply", { to: "id:s-1", questionId: "q", answer: "a".repeat(TEXT_LIMITS.answer) }],
      ["list", { includeEnded: true }],
      ["read", { to: "audit", taskId: "t-1", what: "reply", offset: 0, limit: 16_000 }],
      ["read", { to: "audit", what: "steps", limit: 50 }],
      ["read", { to: "audit", what: "steps" }],
      ["read", { to: "audit", limit: 16_000 }],
      ["stop", { to: "audit" }],
      ["models", {}],
      ["ask", { question: "a".repeat(TEXT_LIMITS.question), options: ["a", "b"], timeoutSeconds: 60 }],
      ["branch", {}],
    ] as const) {
      expect(readRequest(JSON.stringify({ v: 1, kind: "call", id: "c", op, args }))).toStrictEqual({
        request: { kind: "call", id: "c", op, args },
      });
    }
    for (const [op, args] of [
      ["cancel", { id: "c" }],
      ["answered", { id: "c" }],
      ["closed", { id: "c" }],
    ] as const) {
      expect(readRequest(JSON.stringify({ v: 1, kind: "note", id: "n", op, args }))).toStrictEqual({
        request: { kind: "note", id: "n", op, args },
      });
    }
  });

  it("answers a bad request with its id, when it has one, and its kind", () => {
    const call = { v: 1, kind: "call", id: "c", op: "stop", args: { to: "audit" } };
    for (const bad of [
      { ...call, v: 2 },
      { ...call, op: "fly" },
      { ...call, op: "toString" },
      { ...call, args: { to: "" } },
      { ...call, args: { to: "a", extra: 1 } },
      { ...call, op: "spawn", args: { name: "a", task: "a".repeat(TEXT_LIMITS.task + 1) } },
      { ...call, op: "spawn", args: { name: "a", task: "t", wait: true } },
      { ...call, op: "send", args: { to: "a", message: "m", waitSeconds: 30 } },
      { ...call, op: "ask", args: { question: "q", options: ["1", "2", "3", "4", "5", "6", "7"] } },
      { ...call, op: "read", args: { to: "a", what: "steps", limit: 51 } },
      { ...call, op: "read", args: { to: "a", what: "reply", limit: 16_001 } },
      { ...call, op: "progress" },
      { ...call, op: "wait", args: { tasks: ["t-1"], until: "all" } },
    ]) {
      expect(readRequest(JSON.stringify(bad))).toStrictEqual({ bad: "c", kind: "call" });
    }
    expect(readRequest(JSON.stringify({ v: 1, kind: "note", id: "n", op: "spawn", args: {} }))).toStrictEqual({
      bad: "n",
      kind: "note",
    });
  });

  it("reads an envelope as big as an envelope may be", () => {
    const text = writeRequest({ kind: "call", id: "c", op: "list", args: {} }).padEnd(ENVELOPE_LIMIT, " ");

    expect(readRequest(text)).toStrictEqual({ request: { kind: "call", id: "c", op: "list", args: {} } });
  });

  it("reads no id from what is not an envelope, or is bigger than an envelope may be", () => {
    for (const text of [
      "not json",
      "null",
      '{"v":1,"kind":"call","op":"stop","args":{}}',
      '{"v":1,"kind":"ask","id":"c","op":"stop","args":{}}',
      JSON.stringify({ v: 1, kind: "call", id: "c", op: "stop", args: { to: "a" }, extra: 1 }),
      JSON.stringify({ v: 1, kind: "call", id: "c", op: "stop", args: { to: "a".repeat(ENVELOPE_LIMIT) } }),
    ]) {
      expect(readRequest(text)).toStrictEqual({ bad: null, kind: null });
    }
  });
});

describe("readReply", () => {
  it("reads an answer and a failure, without the version", () => {
    expect(readReply({ v: 1, id: "c", ok: true, result: { delivered: true } })).toStrictEqual({
      id: "c",
      ok: true,
      result: { delivered: true },
    });
    expect(readReply({ v: 1, id: "c", ok: false, code: "agent_gone", params: { to: "a" } })).toStrictEqual({
      id: "c",
      ok: false,
      code: "agent_gone",
      params: { to: "a" },
    });
  });

  it("reads nothing from another version, an unknown code or another shape", () => {
    for (const value of [
      { v: 2, id: "c", ok: true, result: 1 },
      { v: 1, id: "c", ok: false, code: "nope" },
      { v: 1, id: "", ok: true, result: 1 },
      { v: 1, id: "c", ok: true, result: 1, extra: 1 },
      undefined,
    ]) {
      expect(readReply(value)).toBeNull();
    }
  });
});

describe("readReply's codes", () => {
  it("reads a failure with each code the host answers", () => {
    expect(CODES.map((code) => readReply({ v: 1, id: "c", ok: false, code })?.ok)).toStrictEqual(
      CODES.map(() => false),
    );
  });
});

describe("handles and events", () => {
  it("takes a handle of a lowercase letter and up to 39 more lowercase letters, digits or hyphens, whole", () => {
    expect(
      ["a", "auth-audit", `a${"b".repeat(39)}`, "Auth", "1a", `a${"b".repeat(40)}`, "ab!", "a b"].map((name) =>
        HANDLE.test(name),
      ),
    ).toStrictEqual([true, true, true, false, false, false, false, false]);
  });

  it("ends a task with these events only", () => {
    expect(FINAL_EVENTS).toStrictEqual(["finished", "failed", "stopped", "ended"]);
  });

  it("reads an event with its delivery's changes whole, and a report's details without its reply and choices", () => {
    expect(AgentEvent.safeParse(EVENT).success).toBe(true);
    expect(AgentEvent.safeParse({ ...EVENT, changes: { files: 1 } }).success).toBe(false);
    const { reply: _reply, options: _options, ...detail } = EVENT;
    expect([
      ReportDetail.safeParse(detail).success,
      ReportDetail.safeParse({ ...detail, reply: EVENT.reply }).success,
      ReportDetail.safeParse({ ...detail, options: EVENT.options }).success,
    ]).toStrictEqual([true, false, false]);
  });

  it("delivers several deliveries as one, and who a session is by either guard", () => {
    const report = { v: 1, kind: "report", deliveries: ["d1", "d2"], events: [EVENT], progress: [] };
    const self = { v: 1, child: true, role: "explore", depth: 1 };
    const task = {
      v: 1,
      kind: "task",
      deliveries: ["d1", "d2"],
      from: "main",
      fromTitle: "m",
      taskId: "t",
      text: "go",
    };

    const { v: _v, deliveries: _deliveries, ...rest } = task;
    expect([
      Delivery.safeParse(report).success,
      Delivery.safeParse({ ...report, deliveries: [] }).success,
      Delivery.safeParse(task).success,
      Delivery.safeParse({ ...task, steer: true }).success,
      MessageDetails.safeParse({ v: 1, deliveries: ["d1"], ...rest, steer: true }).success,
      AgentSelf.safeParse({ ...self, guard: "flags" }).success,
      AgentSelf.safeParse({ ...self, guard: "extension" }).success,
    ]).toStrictEqual([true, false, true, true, true, true, true]);
  });
});

describe("readCancel", () => {
  it("reads every reason the host closes a question for", () => {
    expect(
      ["detached", "archived", "handed_off", "reply_failed"].map(
        (reason) => readCancel({ v: 1, id: "q", reason })?.reason,
      ),
    ).toStrictEqual(["detached", "archived", "handed_off", "reply_failed"]);
  });

  it("reads the id and why, and nothing from another shape", () => {
    expect(readCancel({ v: 1, id: "q", reason: "archived" })).toStrictEqual({ id: "q", reason: "archived" });
    expect(readCancel({ v: 1, id: "q", reason: "bored" })).toBeNull();
    expect(readCancel({ v: 2, id: "q", reason: "archived" })).toBeNull();
  });
});
