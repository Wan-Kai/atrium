import { describe, expect, it } from "vitest";
import { type AgentRecord, type DeliveryRecord, agentFieldsOf } from "./agent-records";

/**
 * A delivery waiting for a session, in the given state.
 *
 * @remarks
 * A notice up from the child `c1`.
 *
 * @sideEffects none
 * @param id - Its id.
 * @param state - Its state.
 * @returns The delivery.
 */
function delivery(id: string, state: DeliveryRecord["state"]): DeliveryRecord {
  return { id, kind: "report", from: "c1", taskId: "t-1", event: "finished", at: 1, state };
}

describe("agentFieldsOf", () => {
  it("reads every state a task, a tool guard and a delivery can be in", () => {
    const agent: AgentRecord = {
      handle: "audit",
      role: "work",
      toolGuard: "extension",
      startOn: null,
      worktree: true,
      tasks: [
        { taskId: "t-1", state: "done", at: 1, replyEntry: "a1" },
        { taskId: "t-2", state: "open", at: 2 },
      ],
    };
    const deliveries = [
      delivery("d1", "waiting"),
      { ...delivery("d2", "claimed"), claimedBy: "call-1" },
      delivery("d3", "sending"),
      delivery("d4", "deleted"),
    ];

    expect(agentFieldsOf({ agent, usedHandles: ["audit"], deliveries })).toStrictEqual({
      agent,
      usedHandles: ["audit"],
      deliveries,
    });
  });

  it("reads fields that are missing or not lists as none", () => {
    expect([agentFieldsOf({}), agentFieldsOf({ usedHandles: "audit", deliveries: { id: "d1" } })]).toStrictEqual([
      { agent: null, usedHandles: [], deliveries: [] },
      { agent: null, usedHandles: [], deliveries: [] },
    ]);
  });
});
