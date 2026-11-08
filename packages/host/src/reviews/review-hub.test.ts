import { CommandError, type PendingReview, type ReviewAction, type Verdict } from "@atrium/protocol";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../platform/logger";
import { ResourceTracker } from "../platform/resources";
import { type ReviewProvider, createReviewHub } from "./review-hub";

/** A logger that keeps what it is told to warn about. */
function quietLogger(warnings: string[] = []): Logger {
  const log = (level: string) => (_fields: unknown, message?: string) => {
    if (level === "warn") warnings.push(message ?? "");
  };
  return {
    trace: log("trace"),
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    fatal: log("fatal"),
    child: () => quietLogger(warnings),
  } as unknown as Logger;
}

/** A review with the actions given. */
function review(id: string, openedAt: number, actions: PendingReview["actions"]): PendingReview {
  return {
    id,
    openedAt,
    source: { kind: "gate", gate: "task_human" },
    subject: { code: "task_human_node", params: { node: id } },
    evidence: [],
    problem: null,
    actions,
  };
}

const PASS: ReviewAction = { id: "pass", reason: "none", targets: [], recommended: true };
const BACK: ReviewAction = {
  id: "send_back",
  reason: "required",
  targets: [{ id: "N1", remaining: 2 }],
  recommended: false,
};
const NOTE: ReviewAction = { id: "note", reason: "optional", targets: [], recommended: false };

/**
 * A provider whose reviews a test sets, and which records what it was told to decide.
 *
 * @remarks
 * A deciding provider in these tests is whatever the hub is given; the hub is the unit, so the provider is a
 * plain object the test controls.
 */
function fakeProvider(initial: Record<string, PendingReview[]> = {}) {
  const reviews = new Map(Object.entries(initial));
  const listeners = new Set<(sessionId: string) => void>();
  const decided: string[] = [];
  let asked = 0;
  const provider: ReviewProvider & {
    set(sessionId: string, list: PendingReview[]): void;
    decided: string[];
    asks(): number;
    fail: Error | null;
    onDecide: (() => Promise<void>) | null;
    listenerCount(): number;
  } = {
    pending: (sessionId) => {
      asked += 1;
      if (provider.fail !== null) return Promise.reject(provider.fail);
      return Promise.resolve(reviews.get(sessionId) ?? []);
    },
    decide: async (sessionId, one, verdict) => {
      decided.push(`${sessionId} ${one.id} ${JSON.stringify(verdict)}`);
      await provider.onDecide?.();
      reviews.set(
        sessionId,
        (reviews.get(sessionId) ?? []).filter((candidate) => candidate.id !== one.id),
      );
    },
    subscribe: (changed) => {
      listeners.add(changed);
      return () => listeners.delete(changed);
    },
    set(sessionId, list) {
      reviews.set(sessionId, list);
      for (const listener of listeners) listener(sessionId);
    },
    decided,
    asks: () => asked,
    fail: null,
    onDecide: null,
    listenerCount: () => listeners.size,
  };
  return provider;
}

/**
 * Makes the provider's decisions wait until `release` is called.
 *
 * @remarks
 * Test support: holds a verdict half way, so a second one can arrive while the first is carried out.
 *
 * @sideEffects Sets the provider's `onDecide`.
 * @param provider - The provider.
 * @returns The gate whose `release` lets the decisions go.
 */
function holdDecisions(provider: { onDecide: (() => Promise<void>) | null }): { release: () => void } {
  const open = Promise.withResolvers<void>();
  provider.onDecide = () => open.promise;
  return { release: () => open.resolve() };
}

/** The hub with a recording listener. */
function hubWith(provider: ReviewProvider, warnings: string[] = []) {
  const resources = new ResourceTracker();
  const hub = createReviewHub({ logger: quietLogger(warnings), resources });
  hub.register(provider);
  const heard: string[] = [];
  hub.onChanged((sessionId) => heard.push(sessionId));
  return { hub, resources, heard };
}

/** The failure of a verdict that does not fit, naming the field. */
const invalid = (field: string) => ({ code: "review_invalid", params: { field } });

/** What a rejected promise was rejected with. */
async function failure(work: Promise<unknown>): Promise<{ code: string; params: unknown }> {
  const error: unknown = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof CommandError)) throw new Error(`expected a CommandError, got ${String(error)}`);
  return { code: error.code, params: error.params };
}

describe("the review hub (ADR-0017, decision 2)", () => {
  it("counts a session's reviews oldest first and tells its listeners only when they changed", async () => {
    const provider = fakeProvider({ s1: [review("b", 20, [PASS]), review("a", 10, [PASS])] });
    const { hub, heard } = hubWith(provider);

    expect(hub.current("s1")).toStrictEqual([]);
    await hub.idle();
    expect(hub.current("s1").map((one) => one.id)).toStrictEqual(["a", "b"]);
    expect(heard).toStrictEqual(["s1"]);

    // The same reviews again are no change.
    provider.set("s1", [review("a", 10, [PASS]), review("b", 20, [PASS])]);
    await hub.idle();
    expect(heard).toStrictEqual(["s1"]);

    provider.set("s1", [review("b", 20, [PASS])]);
    await hub.idle();
    expect(heard).toStrictEqual(["s1", "s1"]);
    expect(hub.current("s1").map((one) => one.id)).toStrictEqual(["b"]);
  });

  it("says nothing about a session that has no reviews, and asks the providers once for it", async () => {
    const provider = fakeProvider();
    const { hub, heard } = hubWith(provider);

    hub.read("s9");
    expect(hub.current("s9")).toStrictEqual([]);
    await hub.idle();
    expect(hub.current("s9")).toStrictEqual([]);
    await hub.idle();

    expect(heard).toStrictEqual([]);
    expect(provider.asks()).toBe(1);
  });

  it("counts a burst of changes once after the last", async () => {
    const provider = fakeProvider({ s1: [review("a", 1, [PASS])] });
    const { hub } = hubWith(provider);

    for (let i = 0; i < 20; i += 1) provider.set("s1", [review("a", 1, [PASS])]);
    await hub.idle();

    // One count for the first change that started it, at most one more for the one that queued behind it.
    expect(provider.asks()).toBeLessThanOrEqual(2);
    expect(hub.current("s1")).toHaveLength(1);
  });

  it("lets a verdict through when it fits and hands it to the provider", async () => {
    const provider = fakeProvider({ s1: [review("a", 1, [PASS, BACK, NOTE])] });
    const { hub, heard } = hubWith(provider);
    hub.current("s1");
    await hub.idle();
    expect(heard).toStrictEqual(["s1"]);

    await hub.answer("s1", "a", { action: "send_back", target: "N1", reason: "again" });

    expect(provider.decided).toStrictEqual(['s1 a {"action":"send_back","target":"N1","reason":"again"}']);
    // The listeners hear that it is gone without waiting for the provider to say.
    expect(heard).toStrictEqual(["s1", "s1"]);
    expect(hub.current("s1")).toStrictEqual([]);
  });

  it("refuses a verdict that does not fit, naming the field, and carries out nothing", async () => {
    const provider = fakeProvider({ s1: [review("a", 1, [PASS, BACK, NOTE])] });
    const { hub } = hubWith(provider);
    const bad = async (verdict: Verdict) => failure(hub.answer("s1", "a", verdict));

    expect(await bad({ action: "nope" })).toStrictEqual(invalid("action"));
    // A target is needed when the action has targets, and is one of them.
    expect(await bad({ action: "send_back", reason: "r" })).toStrictEqual(invalid("target"));
    expect(await bad({ action: "send_back", target: "N9", reason: "r" })).toStrictEqual(invalid("target"));
    // And is not given when it has none.
    expect(await bad({ action: "pass", target: "N1" })).toStrictEqual(invalid("target"));
    // A required reason has to be written, and blanks are not writing.
    expect(await bad({ action: "send_back", target: "N1" })).toStrictEqual(invalid("reason"));
    expect(await bad({ action: "send_back", target: "N1", reason: " \n " })).toStrictEqual(invalid("reason"));
    // A reason is not taken where the action takes none, and may be left out or given where it is optional.
    expect(await bad({ action: "pass", reason: "why" })).toStrictEqual(invalid("reason"));
    await hub.answer("s1", "a", { action: "note" });
    expect(provider.decided).toStrictEqual(['s1 a {"action":"note"}']);
  });

  it("takes an optional reason, and a required one with writing around its blanks", async () => {
    const provider = fakeProvider({
      s1: [review("a", 1, [NOTE, BACK]), review("b", 2, [NOTE])],
    });
    const { hub } = hubWith(provider);

    await hub.answer("s1", "b", { action: "note", reason: "fine" });
    await hub.answer("s1", "a", { action: "send_back", target: "N1", reason: " fix it " });

    expect(provider.decided).toStrictEqual([
      's1 b {"action":"note","reason":"fine"}',
      's1 a {"action":"send_back","target":"N1","reason":" fix it "}',
    ]);
  });

  it("answers review_closed for a review that is not there, and to the second of two verdicts on one", async () => {
    const provider = fakeProvider({ s1: [review("a", 1, [PASS])] });
    const gate = holdDecisions(provider);
    const { hub } = hubWith(provider);

    expect(await failure(hub.answer("s1", "zzz", { action: "pass" }))).toStrictEqual({
      code: "review_closed",
      params: { reviewId: "zzz" },
    });
    expect(await failure(hub.answer("s2", "a", { action: "pass" }))).toMatchObject({ code: "review_closed" });

    const first = hub.answer("s1", "a", { action: "pass" });
    const second = failure(hub.answer("s1", "a", { action: "pass" }));
    await vi.waitFor(() => expect(provider.decided).toHaveLength(1));
    gate.release();
    await first;

    expect(await second).toStrictEqual({ code: "review_closed", params: { reviewId: "a" } });
    expect(provider.decided).toHaveLength(1);
  });

  it("lets two sessions go on at the same time", async () => {
    const provider = fakeProvider({ s1: [review("a", 1, [PASS])], s2: [review("b", 1, [PASS])] });
    const gate = holdDecisions(provider);
    const { hub } = hubWith(provider);

    const one = hub.answer("s1", "a", { action: "pass" });
    await vi.waitFor(() => expect(provider.decided).toHaveLength(1));
    provider.onDecide = null;
    await hub.answer("s2", "b", { action: "pass" });
    expect(provider.decided).toHaveLength(2);
    gate.release();
    await one;
  });

  it("passes the provider's failure on and still counts again, since the state may have moved", async () => {
    const provider = fakeProvider({ s1: [review("a", 1, [PASS])] });
    provider.onDecide = () => {
      provider.set("s1", []);
      return Promise.reject(new CommandError("task_state_invalid"));
    };
    const { hub } = hubWith(provider);

    expect(await failure(hub.answer("s1", "a", { action: "pass" }))).toStrictEqual({
      code: "task_state_invalid",
      params: undefined,
    });
    expect(hub.current("s1")).toStrictEqual([]);
  });

  it("keeps the last count when a provider fails to count, and says so in the log", async () => {
    const provider = fakeProvider({ s1: [review("a", 1, [PASS])] });
    const warnings: string[] = [];
    const { hub } = hubWith(provider, warnings);
    hub.current("s1");
    await hub.idle();
    expect(hub.current("s1")).toHaveLength(1);

    provider.fail = new Error("git is gone");
    provider.set("s1", []);
    await hub.idle();

    expect(hub.current("s1")).toHaveLength(1);
    expect(warnings).toStrictEqual(["reviews not counted"]);
  });

  it("keeps a failing listener from stopping the others", async () => {
    const provider = fakeProvider({ s1: [review("a", 1, [PASS])] });
    const warnings: string[] = [];
    const { hub } = hubWith(provider, warnings);
    const heard: string[] = [];
    hub.onChanged(() => {
      throw new Error("a bad listener");
    });
    hub.onChanged((sessionId) => heard.push(sessionId));

    hub.current("s1");
    await hub.idle();

    expect(heard).toStrictEqual(["s1"]);
    expect(warnings).toStrictEqual(["review listener failed"]);
  });

  it("gathers the reviews of every provider and gives a verdict to the one that raised it", async () => {
    const gates = fakeProvider({ s1: [review("a", 10, [PASS])] });
    const asks = fakeProvider({ s1: [review("b", 5, [PASS])] });
    const resources = new ResourceTracker();
    const hub = createReviewHub({ logger: quietLogger(), resources });
    hub.register(gates);
    const unregister = hub.register(asks);

    hub.current("s1");
    await hub.idle();
    expect(hub.current("s1").map((one) => one.id)).toStrictEqual(["b", "a"]);
    await hub.answer("s1", "b", { action: "pass" });
    expect(asks.decided).toHaveLength(1);
    expect(gates.decided).toHaveLength(0);

    unregister();
    expect(asks.listenerCount()).toBe(0);
    expect(resources.snapshot()["review.provider"]).toBe(1);
  });

  it("holds a count for each provider and listener and gives them all back when it closes", async () => {
    const provider = fakeProvider({ s1: [review("a", 1, [PASS])] });
    const { hub, resources } = hubWith(provider);
    const stop = hub.onChanged(() => undefined);
    expect(resources.snapshot()).toMatchObject({ "review.provider": 1, "review.listener": 2 });
    stop();
    expect(resources.snapshot()["review.listener"]).toBe(1);
    hub.current("s1");

    await hub.close();

    expect(resources.snapshot()).toMatchObject({ "review.provider": 0, "review.listener": 0 });
    expect(provider.listenerCount()).toBe(0);
    // A closed hub counts nothing more.
    provider.set("s1", []);
    await hub.idle();
    expect(provider.asks()).toBeLessThanOrEqual(2);
  });
});

/** How many sessions the hub holds a count for. */
function sessionsHeld(resources: ResourceTracker): number {
  return resources.snapshot()["review.session"] ?? 0;
}

describe("the review hub keeps nothing about a session that no longer needs it (T8 review fix 13)", () => {
  it("holds a count for a session only while it has reviews, a controller reading it, or work under way", async () => {
    const provider = fakeProvider({ idle: [], busy: [review("a", 1, [PASS])] });
    const { hub, resources } = hubWith(provider);
    const held = () => sessionsHeld(resources);

    // A change for a session nobody reads and that has nothing waiting leaves nothing behind.
    provider.set("idle", []);
    await hub.idle();
    expect(held()).toBe(0);

    // One with reviews is remembered, and forgotten once they are gone.
    provider.set("busy", [review("a", 1, [PASS])]);
    await hub.idle();
    expect(held()).toBe(1);
    await hub.answer("busy", "a", { action: "pass" });
    await hub.idle();
    expect(held()).toBe(0);

    // A controller reading a session keeps its count until the session says it is gone.
    hub.read("watched");
    expect(hub.current("watched")).toStrictEqual([]);
    await hub.idle();
    expect(held()).toBe(1);
    hub.forget("watched");
    expect(held()).toBe(0);
  });

  it("keeps a forgotten session's reviews while they wait, and counts a quiet one again when it is read once more", async () => {
    const provider = fakeProvider({ s1: [review("a", 1, [PASS])] });
    const { hub } = hubWith(provider);
    hub.read("s1");
    hub.read("quiet");
    hub.current("s1");
    hub.current("quiet");
    await hub.idle();
    hub.forget("s1");
    hub.forget("quiet");
    const asked = provider.asks();

    expect(hub.current("s1").map((one) => one.id)).toStrictEqual(["a"]);
    expect(hub.current("quiet")).toStrictEqual([]);
    await hub.idle();

    // Only the quiet one was looked at again: the other still had a count.
    expect(provider.asks()).toBe(asked + 1);
  });

  it("gives back what it held for every session when it closes", async () => {
    const provider = fakeProvider({ s1: [review("a", 1, [PASS])] });
    const { hub, resources } = hubWith(provider);
    hub.read("s1");
    hub.read("s2");
    hub.current("s1");
    hub.current("s2");
    await hub.idle();
    expect(sessionsHeld(resources)).toBe(2);

    await hub.close();

    expect(sessionsHeld(resources)).toBe(0);
  });
});

describe("the review hub keeps to what the protocol takes (T8 review fix 4)", () => {
  it("counts at most sixteen reviews for a session, oldest first, and answers only those", async () => {
    const many = Array.from({ length: 20 }, (_, index) => review(`r${String(index + 1)}`, index + 1, [PASS]));
    const provider = fakeProvider({ s1: many });
    const { hub } = hubWith(provider);

    hub.current("s1");
    await hub.idle();

    expect(hub.current("s1").map((one) => one.id)).toStrictEqual(many.slice(0, 16).map((one) => one.id));
    expect(await failure(hub.answer("s1", "r17", { action: "pass" }))).toMatchObject({ code: "review_closed" });
    await hub.answer("s1", "r1", { action: "pass" });
    expect(provider.decided).toHaveLength(1);
  });
});
