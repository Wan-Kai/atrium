import { describe, expect, it } from "vitest";
import { type Caller, type TaskCall, checkCall, checkConversationCall, replyText } from "./channel";
import { Sim, agent, edges, need, newTask } from "./test-support";
import type { Task } from "./types";

/** A task whose N1 is running in session `s1`. */
function running(): Task {
  const sim = new Sim(newTask([agent("N1"), agent("N2")], edges(["N1", "N2"])));
  sim.send({ type: "started" });
  sim.send({ type: "node_started", node: "N1", attempt: 1, sessionId: "s1", startCommit: null });
  return sim.task;
}

const caller: Caller = { sessionId: "s1", node: "N1", attempt: 1 };
const done = (ok: boolean, summary: string, reason?: string): TaskCall => ({
  kind: "call",
  id: "c1",
  op: "node_done",
  args: { ok, summary, ...(reason === undefined ? {} : { reason }) },
});
const change = (reason: string, suggestion: string): TaskCall => ({
  kind: "call",
  id: "c2",
  op: "request_graph_change",
  args: { reason, suggestion },
});

describe('checkCall: who may call (SPEC-0006, "调用方由宿主认定")', () => {
  it("takes the session of the node's latest run while the node is running", () => {
    expect(checkCall(running(), caller, done(true, "ok"))).toStrictEqual({ ok: true });
  });

  it.each([
    ["another session", { ...caller, sessionId: "other" }],
    ["an older attempt", { ...caller, attempt: 2 }],
    ["a node that has no run", { ...caller, node: "N2" }],
  ])("refuses %s", (_name, who) => {
    expect(checkCall(running(), who, done(true, "ok"))).toStrictEqual({ ok: false, code: "task_caller_invalid" });
  });

  it("refuses when the node is not running", () => {
    const task = running();
    const run = need(task.runs[0]);
    for (const state of ["waiting", "held", "stopped", "passed", "failed"] as const) {
      const other: Task = { ...task, runs: [{ ...run, state }] };
      expect(checkCall(other, caller, done(true, "ok"))).toStrictEqual({ ok: false, code: "task_caller_invalid" });
    }
  });

  it("refuses a node that waits for its commit", () => {
    const task = running();
    const run = need(task.runs[0]);

    expect(checkCall({ ...task, runs: [{ ...run, commitPending: true }] }, caller, done(true, "ok"))).toStrictEqual({
      ok: false,
      code: "task_caller_invalid",
    });
  });

  it("refuses a voided run, a cancelled task and an ended one", () => {
    const task = running();
    const run = need(task.runs[0]);
    expect(checkCall({ ...task, runs: [{ ...run, void: true }] }, caller, done(true, "ok")).ok).toBe(false);
    expect(checkCall({ ...task, cancelled: true }, caller, done(true, "ok")).ok).toBe(false);
    expect(checkCall({ ...task, endedAt: 5 }, caller, done(true, "ok")).ok).toBe(false);
  });

  it("does not know a task that is gone", () => {
    expect(checkCall(undefined, caller, done(true, "ok"))).toStrictEqual({ ok: false, code: "task_not_found" });
  });
});

describe("checkCall: the arguments", () => {
  it.each([
    ["ok:true with an empty summary", done(true, ""), "summary"],
    ["ok:true with a blank summary", done(true, "  \n"), "summary"],
    ["ok:false with no reason", done(false, ""), "reason"],
    ["ok:false with a blank reason", done(false, "", "   "), "reason"],
    ["a graph change with a blank reason", change(" ", "do x"), "reason"],
    ["a graph change with a blank suggestion", change("why", "\n"), "suggestion"],
  ])("refuses %s", (_name, call, field) => {
    expect(checkCall(running(), caller, call)).toStrictEqual({
      ok: false,
      code: "task_args_invalid",
      params: { field },
    });
  });

  it("takes ok:false with a reason and no summary, and a graph change with both fields", () => {
    expect(checkCall(running(), caller, done(false, "", "cannot go on")).ok).toBe(true);
    expect(checkCall(running(), caller, change("why", "do x")).ok).toBe(true);
  });
});

/**
 * The JSON a reply command carries.
 *
 * @remarks
 * Decodes the base64url argument, as the extension does.
 *
 * @sideEffects none
 * @param text - The command.
 * @returns The decoded argument.
 */
function body(text: string): unknown {
  return JSON.parse(Buffer.from(text.split(" ")[2] ?? "", "base64url").toString());
}

describe("replyText", () => {
  it("answers an accepted call as recorded", () => {
    const text = replyText("c1", { ok: true });

    expect(text.startsWith("/atrium-task reply ")).toBe(true);
    expect(body(text)).toStrictEqual({ v: 1, id: "c1", ok: true, result: { recorded: true } });
  });

  it("answers a refused call with its code and parameters", () => {
    expect(body(replyText("c1", { ok: false, code: "task_args_invalid", params: { field: "summary" } }))).toStrictEqual(
      {
        v: 1,
        id: "c1",
        ok: false,
        code: "task_args_invalid",
        params: { field: "summary" },
      },
    );
    expect(body(replyText("c1", { ok: false, code: "task_caller_invalid" }))).toStrictEqual({
      v: 1,
      id: "c1",
      ok: false,
      code: "task_caller_invalid",
    });
  });
});

/** A task whose conversation is `ses_task`. */
const task = (): Task => newTask([agent("N1")], []);

describe('checkConversationCall: who may call the task conversation\'s tools (SPEC-0006, "调用方由宿主认定")', () => {
  const conversation = { sessionId: "ses_task", taskId: "tsk_1", role: "conversation" as const };

  it("takes the session whose record says conversation and that is this task's taskSessionId", () => {
    expect(checkConversationCall(task(), conversation)).toStrictEqual({ ok: true });
  });

  it.each([
    ["a node's session", { ...conversation, role: "node" as const }],
    ["a conversation that is another session of the task", { ...conversation, sessionId: "ses_other" }],
    ["a conversation of another task", { ...conversation, taskId: "tsk_2" }],
  ])("refuses %s with task_caller_invalid", (_name, who) => {
    expect(checkConversationCall(task(), who)).toStrictEqual({ ok: false, code: "task_caller_invalid" });
  });

  it("does not know a task that is gone", () => {
    expect(checkConversationCall(undefined, conversation)).toStrictEqual({ ok: false, code: "task_not_found" });
  });

  it("answers a call with a result the tool reads, and a refusal with its code and parameters", () => {
    const answered = body(replyText("c1", { ok: true }, { text: "t", page: 1, pages: 1 }));
    const refused = body(replyText("c2", { ok: false, code: "task_graph_invalid", params: { code: "seq_cycle" } }));

    expect(answered).toStrictEqual({ v: 1, id: "c1", ok: true, result: { text: "t", page: 1, pages: 1 } });
    expect(refused).toStrictEqual({
      v: 1,
      id: "c2",
      ok: false,
      code: "task_graph_invalid",
      params: { code: "seq_cycle" },
    });
  });
});
