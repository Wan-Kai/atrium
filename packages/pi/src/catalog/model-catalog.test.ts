import { FakeClock } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { PiRequestError } from "../process/pi-process";
import { createModelCatalog } from "./model-catalog";
import type { ModelList } from "./query";

/** A list naming its directory and which query it came from. */
function listFor(dir: string, round: number): ModelList {
  return { models: [], defaultModel: { providerId: dir, modelId: `round-${round}` } };
}

/** A query whose answers the test gives, one per call, with the calls it got. */
function scriptedQuery() {
  const calls: { readonly dir: string; readonly signal: AbortSignal }[] = [];
  const answers: { resolve(list: ModelList): void; reject(error: unknown): void }[] = [];
  const query = (dir: string, signal: AbortSignal) =>
    new Promise<ModelList>((resolve, reject) => {
      calls.push({ dir, signal });
      answers.push({ resolve, reject });
      signal.addEventListener("abort", () => reject(new PiRequestError("get_available_models", "aborted")));
    });
  return { query, calls, answers };
}

/** Lets pending promise callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("createModelCatalog", () => {
  it("asks pi once per directory and keeps the answer", async () => {
    const { query, calls, answers } = scriptedQuery();
    const catalog = createModelCatalog({ query, clock: new FakeClock() });

    const first = catalog.list("/a", false);
    const same = catalog.list("/a", false);
    const other = catalog.list("/b", false);
    answers[0]?.resolve(listFor("/a", 1));
    answers[1]?.resolve(listFor("/b", 1));

    expect(await first).toStrictEqual(listFor("/a", 1));
    expect(await same).toStrictEqual(listFor("/a", 1));
    expect(await other).toStrictEqual(listFor("/b", 1));
    expect(await catalog.list("/a", false)).toStrictEqual(listFor("/a", 1));
    expect(calls.map(({ dir }) => dir)).toStrictEqual(["/a", "/b"]);
  });

  it("asks again on refresh, and a refresh while one runs shares it", async () => {
    const { query, calls, answers } = scriptedQuery();
    const catalog = createModelCatalog({ query, clock: new FakeClock() });
    const first = catalog.list("/a", false);
    answers[0]?.resolve(listFor("/a", 1));
    await first;

    const refreshed = catalog.list("/a", true);
    const again = catalog.list("/a", true);
    const plain = catalog.list("/a", false);
    answers[1]?.resolve(listFor("/a", 2));

    expect(await refreshed).toStrictEqual(listFor("/a", 2));
    expect(await again).toStrictEqual(listFor("/a", 2));
    expect(await plain).toStrictEqual(listFor("/a", 2));
    expect(calls).toHaveLength(2);
  });

  it("forgets the old answer when asking again fails, and asks once more next time", async () => {
    const { query, calls, answers } = scriptedQuery();
    const catalog = createModelCatalog({ query, clock: new FakeClock() });
    const first = catalog.list("/a", false);
    answers[0]?.resolve(listFor("/a", 1));
    await first;
    const failing = catalog.list("/a", true);
    const error = new PiRequestError("get_available_models", "exited", "No models available.");
    answers[1]?.reject(error);

    await expect(failing).rejects.toBe(error);
    const next = catalog.list("/a", false);
    answers[2]?.resolve(listFor("/a", 3));

    expect(await next).toStrictEqual(listFor("/a", 3));
    expect(calls).toHaveLength(3);
  });

  it("gives up after the deadline, aborting the query", async () => {
    const { query, calls } = scriptedQuery();
    const clock = new FakeClock();
    const catalog = createModelCatalog({ query, clock, timeoutMs: 120_000 });

    const listing = catalog.list("/a", false);
    clock.advance(119_999);
    await flush();
    expect(calls[0]?.signal.aborted).toBe(false);
    clock.advance(1);

    await expect(listing).rejects.toMatchObject({ reason: "aborted" });
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("clears the deadline once pi answers", async () => {
    const { query, answers } = scriptedQuery();
    const clock = new FakeClock();
    const catalog = createModelCatalog({ query, clock });

    const listing = catalog.list("/a", false);
    expect(clock.pendingTimers()).toBe(1);
    answers[0]?.resolve(listFor("/a", 1));
    await listing;

    expect(clock.pendingTimers()).toBe(0);
  });

  it("aborts the queries under way on close and waits for them", async () => {
    const { query, calls } = scriptedQuery();
    const clock = new FakeClock();
    const catalog = createModelCatalog({ query, clock });
    const listing = catalog.list("/a", false);
    const failed = listing.catch((error: unknown) => error);

    await catalog.close();

    expect(calls[0]?.signal.aborted).toBe(true);
    expect(await failed).toMatchObject({ reason: "aborted" });
    expect(clock.pendingTimers()).toBe(0);
    await expect(catalog.list("/b", false)).rejects.toMatchObject({ reason: "aborted" });
    expect(calls).toHaveLength(1);
  });
});
