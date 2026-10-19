import { describe, expect, it } from "vitest";
import { AgentEventKind, AgentNoticeEvent, AgentRole, AgentSource, AgentStatus, SessionAgent } from "./agent";

/** A child's finished task, as a notice brings it. */
const EVENT = {
  sessionId: "s1",
  name: "audit",
  title: "审查",
  taskId: "t1",
  event: "finished",
  reason: null,
  elapsedMs: 1000,
  question: null,
  branch: null,
  changes: null,
};

describe("the agent's words in the protocol", () => {
  it("names every role, event and status SPEC-0002 gives", () => {
    expect([AgentRole.options, AgentEventKind.options, AgentStatus.options]).toStrictEqual([
      ["explore", "work", "advise"],
      ["finished", "failed", "question", "needs_you", "stopped", "ended"],
      [
        "creating",
        "running",
        "queued",
        "waiting_for_you",
        "waiting_for_parent",
        "idle",
        "stopped",
        "failed",
        "handed_off",
        "ended",
      ],
    ]);
  });

  it("reads a notice's reason up to 64 characters, and a report only with an event", () => {
    expect([
      AgentNoticeEvent.safeParse({ ...EVENT, reason: "host_exit" }).success,
      AgentNoticeEvent.safeParse({ ...EVENT, reason: "r".repeat(64) }).success,
      AgentNoticeEvent.safeParse({ ...EVENT, reason: "r".repeat(65) }).success,
      AgentSource.safeParse({ kind: "report", events: [EVENT] }).success,
      AgentSource.safeParse({ kind: "report", events: [] }).success,
    ]).toStrictEqual([true, true, false, true, false]);
  });

  it("reads a work child's branch up to 256 characters, and its changes only as whole counts not below 0", () => {
    const changes = { files: 2, added: 10, removed: 0 };
    expect([
      AgentNoticeEvent.safeParse({ ...EVENT, branch: "b".repeat(256), changes }).success,
      AgentNoticeEvent.safeParse({ ...EVENT, branch: "b".repeat(257) }).success,
      AgentNoticeEvent.safeParse({ ...EVENT, changes: { ...changes, files: -1 } }).success,
      AgentNoticeEvent.safeParse({ ...EVENT, changes: { ...changes, added: 1.5 } }).success,
      AgentNoticeEvent.safeParse({ ...EVENT, changes: { ...changes, removed: -1 } }).success,
      AgentNoticeEvent.safeParse({ ...EVENT, changes: { ...changes, extra: 1 } }).success,
      AgentNoticeEvent.safeParse({ ...EVENT, branch: undefined }).success,
    ]).toStrictEqual([true, false, false, false, false, false, false]);
  });

  it("reads when a child's open task was handed down only as a whole time not below 0, or null without one", () => {
    const agent = { handle: "audit", role: "explore", status: "running", progress: null, question: null, taskId: "t1" };
    expect([
      SessionAgent.safeParse({ ...agent, taskStartedAt: 1000 }).success,
      SessionAgent.safeParse({ ...agent, taskStartedAt: null }).success,
      SessionAgent.safeParse({ ...agent, taskStartedAt: -1 }).success,
      SessionAgent.safeParse({ ...agent, taskStartedAt: 1.5 }).success,
      SessionAgent.safeParse(agent).success,
    ]).toStrictEqual([true, true, false, false, false]);
  });

  it("reads which task a child has open by its id up to 128 characters, or null without one", () => {
    const agent = {
      handle: "audit",
      role: "explore",
      status: "running",
      progress: null,
      question: null,
      taskStartedAt: 1,
    };
    expect([
      SessionAgent.safeParse({ ...agent, taskId: "t".repeat(128) }).success,
      SessionAgent.safeParse({ ...agent, taskId: null }).success,
      SessionAgent.safeParse({ ...agent, taskId: "t".repeat(129) }).success,
      SessionAgent.safeParse(agent).success,
    ]).toStrictEqual([true, true, false, false]);
  });
});
