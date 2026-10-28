import { CommandError, type PromptCommand, type SteerCommand } from "@atrium/protocol";
import { FakeClock, createTempDir } from "@atrium/testkit";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { RECEIPT_TTL_MS, RECEIPTS_PER_DEVICE, openReceipts } from "./receipts";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const DEVICE = "dev_0123456789abcdef";
const STARTED = { disposition: "started" } as const;

/** A phone's prompt. */
function prompt(requestId: string, text = "hi", attachmentIds?: string[]): PromptCommand {
  return {
    type: "prompt",
    requestId,
    traceparent,
    sessionId: "s1",
    text,
    ...(attachmentIds === undefined ? {} : { attachmentIds }),
  };
}

/** A phone's steer. */
function steer(requestId: string, text = "hi"): SteerCommand {
  return { type: "steer", requestId, traceparent, sessionId: "s1", text };
}

/** A receipts directory, removed after the test, and a clock. */
async function setUp() {
  const dir = await createTempDir("receipts");
  onTestFinished(dir.cleanup);
  return { dir: dir.path, clock: new FakeClock(1_000) };
}

/** Counts executions and answers `result`. */
function counting<T>(result: T) {
  let count = 0;
  return {
    get count() {
      return count;
    },
    run: async () => {
      count += 1;
      return result;
    },
  };
}

describe("openReceipts", () => {
  it("runs a request once, and answers the same request again from its receipt without running it", async () => {
    const { dir, clock } = await setUp();
    const receipts = await openReceipts(dir, clock);
    const execute = counting({ disposition: "started" as const });

    expect(await receipts.run(DEVICE, prompt("r1"), execute.run)).toStrictEqual({ disposition: "started" });
    expect(await receipts.run(DEVICE, prompt("r1"), execute.run)).toStrictEqual({ disposition: "started" });
    expect(execute.count).toBe(1);
    // Another device's same request id is another request.
    await receipts.run("dev_ffffffffffffffff", prompt("r1"), execute.run);
    expect(execute.count).toBe(2);
  });

  it("refuses the same request id with other content, without running it", async () => {
    const { dir, clock } = await setUp();
    const receipts = await openReceipts(dir, clock);
    const execute = counting(STARTED);
    await receipts.run(DEVICE, prompt("r1", "one"), execute.run);

    await expect(receipts.run(DEVICE, prompt("r1", "two"), execute.run)).rejects.toStrictEqual(
      new CommandError("request_conflict"),
    );
    await expect(receipts.run(DEVICE, steer("r1", "one"), execute.run)).rejects.toStrictEqual(
      new CommandError("request_conflict"),
    );
    await expect(receipts.run(DEVICE, prompt("r1", "one", ["a1"]), execute.run)).rejects.toStrictEqual(
      new CommandError("request_conflict"),
    );
    expect(execute.count).toBe(1);
  });

  it("counts attachments but not their ids, which change when the phone uploads them again", async () => {
    const { dir, clock } = await setUp();
    const receipts = await openReceipts(dir, clock);
    const execute = counting(STARTED);
    await receipts.run(DEVICE, prompt("r1", "look", ["a1", "a2"]), execute.run);

    expect(await receipts.run(DEVICE, prompt("r1", "look", ["b1", "b2"]), execute.run)).toStrictEqual(STARTED);
    await expect(receipts.run(DEVICE, prompt("r1", "look", ["c1"]), execute.run)).rejects.toStrictEqual(
      new CommandError("request_conflict"),
    );
    expect(execute.count).toBe(1);
  });

  it("joins a request on its way instead of running it twice", async () => {
    const { dir, clock } = await setUp();
    const receipts = await openReceipts(dir, clock);
    const gate = Promise.withResolvers<void>();
    let count = 0;
    const execute = async () => {
      count += 1;
      await gate.promise;
      return { disposition: "started" as const };
    };

    const first = receipts.run(DEVICE, prompt("r1"), execute);
    const second = receipts.run(DEVICE, prompt("r1"), execute);
    gate.resolve();

    expect(await Promise.all([first, second])).toStrictEqual([{ disposition: "started" }, { disposition: "started" }]);
    expect(count).toBe(1);
  });

  it("answers the same failure again for a request that failed", async () => {
    const { dir, clock } = await setUp();
    const receipts = await openReceipts(dir, clock);
    let count = 0;
    const execute = async () => {
      count += 1;
      throw new CommandError("session_busy", { sessionId: "s1" });
    };

    for (let round = 0; round < 2; round += 1) {
      await expect(receipts.run(DEVICE, prompt("r1"), execute)).rejects.toStrictEqual(
        new CommandError("session_busy", { sessionId: "s1" }),
      );
    }
    expect(count).toBe(1);
  });

  it("cannot tell the outcome of a request that threw something else, says so at once and after, and logs it", async () => {
    const { dir, clock } = await setUp();
    const logged: unknown[][] = [];
    const receipts = await openReceipts(dir, clock, {
      log: (level, message, fields) => logged.push([level, message, fields]),
    });
    const bug = new Error("host bug");
    const execute = counting(STARTED);

    await expect(
      receipts.run(DEVICE, prompt("r1"), async () => {
        throw bug;
      }),
    ).rejects.toStrictEqual(new CommandError("outcome_unknown"));
    expect(logged).toStrictEqual([["error", "remote command crashed", { err: bug, command: "prompt" }]]);
    await expect(receipts.run(DEVICE, prompt("r1"), execute.run)).rejects.toStrictEqual(
      new CommandError("outcome_unknown"),
    );
    expect(execute.count).toBe(0);
  });

  it("writes the request down before running it, and a restart turns one under way into unknown", async () => {
    const { dir, clock } = await setUp();
    const receipts = await openReceipts(dir, clock);
    let seen = "";
    const never = Promise.withResolvers<never>();
    void receipts.run(DEVICE, prompt("r1"), async () => {
      seen = await readFile(join(dir, "receipts.json"), "utf8");
      return never.promise;
    });
    await expect.poll(() => seen).toContain('"processing"');

    const restarted = await openReceipts(dir, clock);
    const execute = counting(STARTED);
    await expect(restarted.run(DEVICE, prompt("r1"), execute.run)).rejects.toStrictEqual(
      new CommandError("outcome_unknown"),
    );
    expect(execute.count).toBe(0);
    await receipts.flush();
  });

  it("keeps a finished request's answer across a restart", async () => {
    const { dir, clock } = await setUp();
    const receipts = await openReceipts(dir, clock);
    await receipts.run(DEVICE, prompt("r1"), async () => ({ disposition: "queued", itemId: "q1" }));
    await receipts.flush();

    const restarted = await openReceipts(dir, clock);
    const execute = counting(STARTED);
    expect(await restarted.run(DEVICE, prompt("r1"), execute.run)).toStrictEqual({
      disposition: "queued",
      itemId: "q1",
    });
    expect(execute.count).toBe(0);
  });

  it("cannot tell the outcome of a finished request whose kept answer no longer reads, and does not run it", async () => {
    const { dir, clock } = await setUp();
    const receipts = await openReceipts(dir, clock);
    await receipts.run(DEVICE, prompt("r1"), async () => STARTED);
    await receipts.flush();
    const file = join(dir, "receipts.json");
    await writeFile(file, (await readFile(file, "utf8")).replace('"disposition": "started"', '"disposition": "gone"'));

    const restarted = await openReceipts(dir, clock);
    const execute = counting(STARTED);
    await expect(restarted.run(DEVICE, prompt("r1"), execute.run)).rejects.toStrictEqual(
      new CommandError("outcome_unknown"),
    );
    expect(execute.count).toBe(0);
  });

  it("does not run a request it could not write down first", async () => {
    const unwritable = await setUp();
    const book = await openReceipts(unwritable.dir, unwritable.clock, {
      write: async () => {
        throw new Error("disk full");
      },
    });
    const execute = counting(STARTED);
    await expect(book.run(DEVICE, prompt("r1"), execute.run)).rejects.toStrictEqual(new CommandError("internal_error"));
    expect(execute.count).toBe(0);
  });

  it("warns when it cannot write down how a request ended, and still answers", async () => {
    const { dir, clock } = await setUp();
    const logged: unknown[][] = [];
    const failure = new Error("disk full");
    const receipts = await openReceipts(dir, clock, {
      // The request is written down; how it ended is not.
      write: vi
        .fn<(path: string, content: string) => Promise<void>>()
        .mockResolvedValueOnce()
        .mockRejectedValue(failure),
      log: (level, message, fields) => logged.push([level, message, fields]),
    });
    expect(await receipts.run(DEVICE, prompt("r1"), counting(STARTED).run)).toStrictEqual(STARTED);
    expect(logged).toStrictEqual([["warn", "receipt not written", { err: failure }]]);
  });

  it("joins a request on its way even after newer requests pushed its receipt past the limit", async () => {
    const { dir, clock } = await setUp();
    let written = "";
    const receipts = await openReceipts(dir, clock, {
      write: async (_path, content) => {
        written = content;
      },
    });
    const gate = Promise.withResolvers<void>();
    let count = 0;
    const slow = async () => {
      count += 1;
      await gate.promise;
      return STARTED;
    };
    const first = receipts.run(DEVICE, prompt("slow"), slow);
    for (let index = 0; index < RECEIPTS_PER_DEVICE; index += 1) {
      clock.advance(1);
      await receipts.run(DEVICE, prompt(`n${index}`), counting(STARTED).run);
    }
    // Still written down, so a restart now would not run it again.
    expect(written).toContain('"requestId": "slow"');

    await expect(receipts.run(DEVICE, prompt("slow", "changed"), slow)).rejects.toStrictEqual(
      new CommandError("request_conflict"),
    );
    const again = receipts.run(DEVICE, prompt("slow"), slow);
    gate.resolve();
    expect(await Promise.all([first, again])).toStrictEqual([STARTED, STARTED]);
    expect(count).toBe(1);
  });

  it("keeps a receipt for exactly a day", async () => {
    const { dir, clock } = await setUp();
    const receipts = await openReceipts(dir, clock, { write: async () => undefined });
    const execute = counting(STARTED);
    expect(RECEIPT_TTL_MS).toBe(24 * 60 * 60 * 1000);
    await receipts.run(DEVICE, prompt("r1"), execute.run);
    clock.advance(RECEIPT_TTL_MS);
    await receipts.run(DEVICE, prompt("r1"), execute.run);
    expect(execute.count).toBe(1);
  });

  it("forgets receipts after a day, and keeps at most so many per device, dropping the oldest", async () => {
    const { dir, clock } = await setUp();
    // Hundreds of writes: kept in memory, the last one checked.
    let written = "";
    const receipts = await openReceipts(dir, clock, {
      write: async (_path, content) => {
        written = content;
      },
    });
    const execute = counting(STARTED);
    await receipts.run(DEVICE, prompt("old"), execute.run);
    clock.advance(RECEIPT_TTL_MS + 1);
    await receipts.run(DEVICE, prompt("old"), execute.run);
    expect(execute.count).toBe(2);

    for (let index = 0; index < RECEIPTS_PER_DEVICE; index += 1) {
      clock.advance(1);
      await receipts.run(DEVICE, prompt(`n${index}`), execute.run);
    }
    expect(execute.count).toBe(2 + RECEIPTS_PER_DEVICE);
    // "old" was the oldest and went; the last one is still answered from its receipt.
    await receipts.run(DEVICE, prompt("old"), execute.run);
    await receipts.run(DEVICE, prompt(`n${RECEIPTS_PER_DEVICE - 1}`), execute.run);
    expect(execute.count).toBe(3 + RECEIPTS_PER_DEVICE);
    await receipts.flush();
    const stored = JSON.parse(written) as { receipts: unknown[] };
    expect(stored.receipts).toHaveLength(RECEIPTS_PER_DEVICE);
  });

  it("leaves expired receipts out of the file at the next write", async () => {
    const { dir, clock } = await setUp();
    let written = "";
    const receipts = await openReceipts(dir, clock, {
      write: async (_path, content) => {
        written = content;
      },
    });
    const execute = counting(STARTED);
    await receipts.run(DEVICE, prompt("old"), execute.run);
    clock.advance(RECEIPT_TTL_MS + 1);
    await receipts.run(DEVICE, prompt("new"), execute.run);
    await receipts.flush();

    const stored = JSON.parse(written) as { receipts: { requestId: string }[] };
    expect(stored.receipts.map((receipt) => receipt.requestId)).toStrictEqual(["new"]);
  });

  it("starts empty from a damaged file, setting it aside", async () => {
    const { dir, clock } = await setUp();
    await writeFile(join(dir, "receipts.json"), "{ not json");
    const receipts = await openReceipts(dir, clock);
    const execute = counting(STARTED);

    await receipts.run(DEVICE, prompt("r1"), execute.run);
    expect(execute.count).toBe(1);
  });
});
