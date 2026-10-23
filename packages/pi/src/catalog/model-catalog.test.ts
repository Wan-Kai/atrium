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

/** A log that keeps its warnings, as the catalog writes them. */
function recordingLog() {
  const warnings: { readonly fields: object; readonly message: string }[] = [];
  return { warnings, log: { warn: (fields: object, message: string) => warnings.push({ fields, message }) } };
}

/** Lets pending promise callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/**
 * A query that answers `/done` at once and takes its time to end any other once aborted, as
 * stopping pi does.
 *
 * @remarks
 * For `close`, which must wait for the queries it aborted.
 *
 * @sideEffects none
 * @returns The query, the signals of the slow calls, and what lets them end.
 */
function slowToStop() {
  const calls: AbortSignal[] = [];
  const ended = Promise.withResolvers<void>();
  const query = (dir: string, signal: AbortSignal): Promise<ModelList> => {
    if (dir === "/done") return Promise.resolve(listFor(dir, 1));
    return new Promise<ModelList>((_resolve, reject) => {
      calls.push(signal);
      signal.addEventListener("abort", () => {
        void ended.promise.then(() => reject(new PiRequestError("get_available_models", "aborted")));
      });
    });
  };
  return { query, calls, ended };
}

describe("createModelCatalog", () => {
  it("asks pi once per directory and keeps the answer", async () => {
    const { query, calls, answers } = scriptedQuery();
    const catalog = createModelCatalog({ query, log: recordingLog().log, clock: new FakeClock() });

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
    const catalog = createModelCatalog({ query, log: recordingLog().log, clock: new FakeClock() });
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

  it("asks pi again for every directory once told to forget, keeping no answer of a query under way", async () => {
    const { query, calls, answers } = scriptedQuery();
    const catalog = createModelCatalog({ query, log: recordingLog().log, clock: new FakeClock() });
    const kept = catalog.list("/a", false);
    answers[0]?.resolve(listFor("/a", 1));
    await kept;
    const underWay = catalog.list("/b", false);

    catalog.forget();
    answers[1]?.resolve(listFor("/b", 1));
    const afterA = catalog.list("/a", false);
    answers[2]?.resolve(listFor("/a", 2));
    const afterB = catalog.list("/b", false);
    answers[3]?.resolve(listFor("/b", 2));

    expect(await underWay).toStrictEqual(listFor("/b", 1));
    expect(await afterA).toStrictEqual(listFor("/a", 2));
    expect(await afterB).toStrictEqual(listFor("/b", 2));
    expect(calls.map(({ dir }) => dir)).toStrictEqual(["/a", "/b", "/a", "/b"]);
  });

  it("forgets the old answer when asking again fails, and asks once more next time", async () => {
    const { query, calls, answers } = scriptedQuery();
    const catalog = createModelCatalog({ query, log: recordingLog().log, clock: new FakeClock() });
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

  it("gives up after 120 seconds, aborting the query, and warns that it timed out", async () => {
    const { query, calls } = scriptedQuery();
    const clock = new FakeClock();
    const { log, warnings } = recordingLog();
    const catalog = createModelCatalog({ query, log, clock });

    const listing = catalog.list("/a", false);
    clock.advance(119_999);
    await flush();
    expect(calls[0]?.signal.aborted).toBe(false);
    clock.advance(1);

    await expect(listing).rejects.toMatchObject({ reason: "aborted" });
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(clock.pendingTimers()).toBe(0);
    expect(warnings).toStrictEqual([{ fields: { timeoutMs: 120_000 }, message: "model list timed out" }]);
  });

  it("clears the deadline once pi answers", async () => {
    const { query, answers } = scriptedQuery();
    const clock = new FakeClock();
    const catalog = createModelCatalog({ query, log: recordingLog().log, clock });

    const listing = catalog.list("/a", false);
    expect(clock.pendingTimers()).toBe(1);
    answers[0]?.resolve(listFor("/a", 1));
    await listing;

    expect(clock.pendingTimers()).toBe(0);
  });

  it("aborts the queries under way on close and waits for them to end, without a warning", async () => {
    const { query, calls, ended } = slowToStop();
    const clock = new FakeClock();
    const { log, warnings } = recordingLog();
    const catalog = createModelCatalog({ query, log, clock });
    await catalog.list("/done", false);
    const failed = catalog.list("/a", false).catch((error: unknown) => error);
    let closed = false;

    const closing = catalog.close();
    void closing.then(() => (closed = true));
    await flush();
    expect(calls[0]?.aborted).toBe(true);
    expect(closed).toBe(false);
    ended.resolve();
    await closing;

    expect(await failed).toMatchObject({ reason: "aborted" });
    expect(clock.pendingTimers()).toBe(0);
    await expect(catalog.list("/b", false)).rejects.toMatchObject({
      name: "PiRequestError",
      command: "get_available_models",
      reason: "aborted",
    });
    expect(calls).toHaveLength(1);
    expect(warnings).toStrictEqual([]);
  });

  it("waits on close for a query that was under way when told to forget", async () => {
    const { query, calls, ended } = slowToStop();
    const catalog = createModelCatalog({ query, log: recordingLog().log, clock: new FakeClock() });
    const failed = catalog.list("/a", false).catch((error: unknown) => error);
    catalog.forget();
    let closed = false;

    const closing = catalog.close();
    void closing.then(() => (closed = true));
    await flush();
    expect(calls[0]?.aborted).toBe(true);
    expect(closed).toBe(false);
    ended.resolve();
    await closing;

    expect(await failed).toMatchObject({ reason: "aborted" });
  });
});
