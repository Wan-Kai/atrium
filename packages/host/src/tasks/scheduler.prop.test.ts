import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { anyGraphArb, resetSeen, reviewGraphArb, seen, stepsAreDeterministic, walk, walkArb } from "./scheduler-model";

describe("step: properties over random graphs and event sequences", () => {
  it("keeps every invariant on any valid graph, whatever is sent, sent twice or sent late, and can be driven to the end", () => {
    fc.assert(fc.property(anyGraphArb, walkArb, walk), { numRuns: 400 });
  });

  it("keeps them on graphs with a closing human node that can send back, where the send-back rules are exercised", () => {
    fc.assert(fc.property(reviewGraphArb, walkArb, walk), { numRuns: 500 });
  });

  it("reaches the rules it is meant to test (the walks are not idle)", () => {
    // Its own seeded walks, so the answer does not depend on the random ones above or on their order.
    resetSeen();
    fc.assert(fc.property(reviewGraphArb, walkArb, walk), { seed: 20_261_104, numRuns: 300 });
    fc.assert(fc.property(anyGraphArb, walkArb, walk), { seed: 20_261_104, numRuns: 200 });
    const need = [
      "action:start_node",
      "action:stop_node",
      "action:resume_node",
      "action:commit_node",
      "action:ensure_workspace",
      "action:merge",
      "action:nudge_node",
      "action:wake_task_conversation",
      "event:human_sent_back",
      "event:node_held",
      "event:node_stopped",
      "event:workspace_failed",
      "event:graph_approved",
    ];
    expect(need.filter((key) => seen(key) === 0)).toStrictEqual([]);
    expect(seen("send-backs")).toBeGreaterThan(100);
  });

  it("gives the same result when the same event is applied to the same task again", () => {
    fc.assert(fc.property(anyGraphArb, fc.array(fc.nat(), { maxLength: 40 }), stepsAreDeterministic), { numRuns: 150 });
  });
});
