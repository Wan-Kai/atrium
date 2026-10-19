import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./channel";
import { agentSource, agentToolDetails, noticeEvent } from "./details";

/** An event as a notice or a tool's result keeps it. */
const EVENT: AgentEvent = {
  name: "audit",
  title: "安全审查",
  sessionId: "s2",
  taskId: "t-1",
  event: "question",
  questionId: "call-1",
  question: "which?",
  elapsedMs: 9,
  reason: "x",
  reply: { text: "r", totalChars: 1 },
};

/** The same event as the transcript shows it. */
const SHOWN = {
  sessionId: "s2",
  name: "audit",
  title: "安全审查",
  taskId: "t-1",
  event: "question",
  reason: "x",
  elapsedMs: 9,
  question: "which?",
  branch: null,
  changes: null,
} as const;

describe("noticeEvent", () => {
  it("keeps who, which task, what, why, how long and the question, and leaves the rest", () => {
    expect(noticeEvent(EVENT)).toStrictEqual(SHOWN);
    expect(noticeEvent({ name: "a", title: "b", sessionId: "s", taskId: "t", event: "finished" })).toStrictEqual({
      sessionId: "s",
      name: "a",
      title: "b",
      taskId: "t",
      event: "finished",
      reason: null,
      elapsedMs: null,
      question: null,
      branch: null,
      changes: null,
    });
  });

  it("keeps a work child's branch and changes, cut to the protocol's limit, and no changes it cannot show", () => {
    const work = {
      ...EVENT,
      event: "finished",
      branch: "agent/audit",
      workspace: "/w",
      changes: { files: 2, added: 214, removed: 3 },
    } as const;

    expect(noticeEvent(work)).toStrictEqual({
      ...SHOWN,
      event: "finished",
      branch: "agent/audit",
      changes: { files: 2, added: 214, removed: 3 },
    });
    expect(noticeEvent({ ...work, branch: "b".repeat(257), changes: undefined })).toStrictEqual({
      ...SHOWN,
      event: "finished",
      branch: "b".repeat(256),
    });
    expect(
      [
        { files: -1, added: 0, removed: 0 },
        { files: 0, added: -1, removed: 0 },
        { files: 0, added: 0, removed: -1 },
        { files: 0, added: 0, removed: 0 },
      ].map((changes) => noticeEvent({ ...work, branch: undefined, changes })),
    ).toStrictEqual([
      { ...SHOWN, event: "finished" },
      { ...SHOWN, event: "finished" },
      { ...SHOWN, event: "finished" },
      { ...SHOWN, event: "finished", changes: { files: 0, added: 0, removed: 0 } },
    ]);
  });

  it("cuts text to the protocol's limits, and leaves out an event without a session or with ids too long", () => {
    const long = noticeEvent({
      ...EVENT,
      name: "n".repeat(65),
      title: "t".repeat(1025),
      reason: "r".repeat(65),
      question: "q".repeat(4001),
      sessionId: "s".repeat(128),
      taskId: "k".repeat(128),
    });

    expect([long?.name.length, long?.title.length, long?.reason?.length, long?.question?.length]).toStrictEqual([
      64, 1024, 64, 4000,
    ]);
    expect(noticeEvent({ ...EVENT, sessionId: "" })).toBeNull();
    expect(noticeEvent({ ...EVENT, sessionId: "s".repeat(129) })).toBeNull();
    expect(noticeEvent({ ...EVENT, taskId: "k".repeat(129) })).toBeNull();
  });
});

describe("agentSource", () => {
  it("opens with notices' events, or a task's text whole", () => {
    const { reply: _reply, ...detail } = EVENT;

    expect(agentSource({ v: 1, kind: "report", deliveries: ["d"], events: [detail] })).toStrictEqual({
      kind: "report",
      events: [SHOWN],
    });
    expect(
      agentSource({
        v: 1,
        kind: "task",
        deliveries: ["d"],
        from: "main",
        fromTitle: "f".repeat(1025),
        taskId: "t".repeat(129),
        text: "x".repeat(40_000),
      }),
    ).toStrictEqual({ kind: "task", fromTitle: "f".repeat(1024), taskId: "t".repeat(128), text: "x".repeat(40_000) });
  });

  it("is nothing for notices none of whose events can be shown", () => {
    expect(agentSource({ v: 1, kind: "report", deliveries: ["d"], events: [{ ...EVENT, sessionId: "" }] })).toBeNull();
  });
});

/** `agent_spawn`'s result, with a field the transcript does not need. */
const SPAWNED = { name: "audit", sessionId: "s2", taskId: "t-1", role: "work", branch: "agent/audit", extra: 1 };

describe("agentToolDetails", () => {
  it("gives agent_spawn's child, with what its wait came to", () => {
    const spawned = SPAWNED;

    expect(agentToolDetails("agent_spawn", { ...spawned, waited: { event: EVENT, timedOut: false } })).toStrictEqual({
      tool: "agent",
      spawned: { sessionId: "s2", name: "audit", taskId: "t-1", role: "work", branch: "agent/audit" },
      events: [SHOWN],
    });
    expect(agentToolDetails("agent_spawn", { ...spawned, branch: undefined, name: "n".repeat(70) })).toStrictEqual({
      tool: "agent",
      spawned: { sessionId: "s2", name: "n".repeat(64), taskId: "t-1", role: "work", branch: null },
      events: [],
    });
  });

  it("gives agent_send's and agent_wait's events, and nothing for a failed call or another tool", () => {
    expect(agentToolDetails("agent_send", { to: "audit", waited: { event: EVENT } })).toStrictEqual({
      tool: "agent",
      spawned: null,
      events: [SHOWN],
    });
    expect(agentToolDetails("agent_send", { to: "audit" })).toStrictEqual({ tool: "agent", spawned: null, events: [] });
    expect(agentToolDetails("agent_wait", { events: [EVENT, { ...EVENT, sessionId: "" }] })).toStrictEqual({
      tool: "agent",
      spawned: null,
      events: [SHOWN],
    });
    expect([
      agentToolDetails("agent_spawn", { error: "agent_limit" }),
      agentToolDetails("agent_send", null),
      agentToolDetails("agent_wait", { events: "none" }),
      agentToolDetails("agent_list", { children: [] }),
      agentToolDetails("agent_list", { events: [EVENT] }),
      agentToolDetails("agent_spawn", { ...SPAWNED, waited: { event: { name: 1 } } }),
      agentToolDetails("agent_send", { to: "audit", waited: { event: { name: 1 } } }),
    ]).toStrictEqual([null, null, null, null, null, null, null]);
  });
});
