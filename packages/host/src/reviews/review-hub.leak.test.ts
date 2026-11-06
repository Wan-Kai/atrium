import { CommandError, type PendingReview } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { settledResources, startTestHost } from "../../test/harness";
import type { Logger } from "../platform/logger";
import { ResourceTracker } from "../platform/resources";
import { type ReviewProvider, createReviewHub } from "./review-hub";

const quiet = new Proxy({} as Logger, { get: () => () => quiet });

/** A review that can be passed. */
const waiting: PendingReview = {
  id: "r1",
  openedAt: 1,
  source: { kind: "gate", gate: "task_human" },
  subject: { code: "task_human_node", params: {} },
  evidence: [],
  problem: null,
  actions: [{ id: "pass", reason: "none", targets: [], recommended: true }],
};

describe("the review hub leaks nothing (ADR-0017)", () => {
  it("holds a count for each provider and listener it was given, and gives them all back, round after round", async () => {
    const resources = new ResourceTracker();
    const baseline = resources.snapshot();
    for (let round = 0; round < 25; round += 1) {
      const hub = createReviewHub({ logger: quiet, resources });
      const listeners = new Set<(sessionId: string) => void>();
      const open = [waiting];
      const provider: ReviewProvider = {
        pending: async () => [...open],
        decide: async () => {
          open.length = 0;
        },
        subscribe: (changed) => {
          listeners.add(changed);
          return () => listeners.delete(changed);
        },
      };
      hub.register(provider);
      hub.onChanged(() => undefined);
      hub.current("s1");
      await hub.idle();
      expect(resources.snapshot()).toMatchObject({ "review.provider": 1, "review.listener": 1 });
      await hub.answer("s1", "r1", { action: "pass" });
      await expect(hub.answer("s1", "r1", { action: "pass" })).rejects.toBeInstanceOf(CommandError);
      for (const changed of listeners) changed("s1");
      await hub.close();
      expect(listeners.size).toBe(0);
    }
    expect(resources.snapshot()).toMatchObject({ "review.provider": 0, "review.listener": 0 });
    expect({ ...resources.snapshot(), "review.provider": 0, "review.listener": 0 }).toStrictEqual({
      ...baseline,
      "review.provider": 0,
      "review.listener": 0,
    });
  });

  it("is one provider and one listener in a running host, and none once it has stopped", async () => {
    const host = await startTestHost();
    const settled = await settledResources(host.host);
    const resources = host.host.resources;

    expect(settled["review.provider"]).toBe(1);
    expect(settled["review.listener"]).toBe(1);
    await host.dispose();

    expect(resources.snapshot()["review.provider"]).toBe(0);
    expect(resources.snapshot()["review.listener"]).toBe(0);
    expect(resources.snapshot()["timer"]).toBe(0);
  });
});
