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

/**
 * What waits in a session, as a copy.
 *
 * @remarks
 * Test support: keeps the optional lookup out of the test bodies, which hold no conditionals.
 *
 * @sideEffects none
 * @param open - The reviews by session.
 * @param sessionId - The session.
 * @returns The reviews, none for a session that has none.
 */
function waitingIn(open: ReadonlyMap<string, readonly PendingReview[]>, sessionId: string): PendingReview[] {
  return [...(open.get(sessionId) ?? [])];
}

/**
 * The review ids to act on: the one given, or none.
 *
 * @remarks
 * Test support, as `waitingIn`.
 *
 * @sideEffects none
 * @param id - The id, or `null`.
 * @returns A list of one or none.
 */
function only(id: string | null): string[] {
  return id === null ? [] : [id];
}

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
    expect(resources.snapshot()).toStrictEqual({
      ...baseline,
      "review.provider": 0,
      "review.listener": 0,
      "review.session": 0,
    });
  });

  it("keeps no count for sessions that came and went, in one hub that lives on (T8 review fix 13)", async () => {
    const resources = new ResourceTracker();
    const hub = createReviewHub({ logger: quiet, resources });
    const open = new Map<string, PendingReview[]>();
    const listeners = new Set<(sessionId: string) => void>();
    hub.register({
      pending: async (sessionId) => waitingIn(open, sessionId),
      decide: async (sessionId) => {
        open.delete(sessionId);
      },
      subscribe: (changed) => {
        listeners.add(changed);
        return () => listeners.delete(changed);
      },
    });
    hub.onChanged(() => undefined);
    const baseline = resources.snapshot();

    /**
     * One session's life: a controller reads it, a task event concerns it, and it goes.
     *
     * @remarks
     * With `reviewId`, a review waits in it and is answered before it goes.
     *
     * @sideEffects Drives the hub.
     * @param sessionId - The session.
     * @param reviewId - The review that waits in it, if one does.
     */
    const live = async (sessionId: string, reviewId: string | null): Promise<void> => {
      hub.read(sessionId);
      hub.current(sessionId);
      for (const id of only(reviewId)) open.set(sessionId, [{ ...waiting, id }]);
      for (const changed of listeners) changed(sessionId);
      await hub.idle();
      for (const id of only(reviewId)) await hub.answer(sessionId, id, { action: "pass" });
      hub.forget(sessionId);
      await hub.idle();
    };
    for (let round = 0; round < 100; round += 1) {
      await live(`quiet${String(round)}`, null);
      await live(`busy${String(round)}`, `r${String(round)}`);
    }

    expect(resources.snapshot()).toStrictEqual({ ...baseline, "review.session": 0 });
    await hub.close();
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
