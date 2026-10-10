import type { LogEntry, LogUsage, PiStats, TranslatedEvent } from "@atrium/pi";
import { type SessionMetrics, UNKNOWN_METRICS } from "@atrium/protocol";
import { FakeClock } from "@atrium/testkit";
import { describe, expect, it } from "vitest";
import { createMetricsTracker } from "./session-metrics";

/** Lets queued promises run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** pi's statistics with the fields a test gives. */
function stats(fields: Partial<PiStats> = {}): PiStats {
  return {
    turns: 2,
    steps: 3,
    tokens: { input: 100, output: 20, cacheRead: 900, cacheWrite: 50 },
    cost: 0.12,
    context: { tokens: 4000, window: 200_000 },
    ...fields,
  };
}

/** Token counts with the fields a test gives. */
function usage(fields: Partial<LogUsage> = {}): LogUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null, ...fields };
}

/** A finished assistant message that used `tokens`. */
function reply(tokens: Partial<LogUsage> = {}): TranslatedEvent {
  return {
    kind: "message_finished",
    message: {
      kind: "assistant",
      parts: [],
      stopReason: "stop",
      errorMessage: null,
      usage: usage(tokens),
      timestamp: 0,
    },
  };
}

/** An assistant entry that used `tokens`. */
function assistantEntry(id: string, tokens: Partial<LogUsage>): LogEntry {
  return {
    id,
    parentId: null,
    kind: "assistant",
    parts: [],
    stopReason: "stop",
    errorMessage: null,
    usage: usage(tokens),
    timestamp: 0,
  };
}

/** A system message entry stating a prompt of `chars` characters and one tool of `toolChars`. */
function systemEntry(id: string, chars: number, toolChars: number): LogEntry {
  return {
    id,
    parentId: null,
    kind: "system",
    timestamp: 0,
    system: { textChars: chars, sections: {}, toolsAdded: { read: toolChars }, toolsRemoved: [] },
  };
}

const request = { kind: "request_started" } as const;
const output = { kind: "output_started" } as const;

/**
 * A tracker over a fake clock and a `get_session_stats` the test answers.
 *
 * @remarks
 * Each read waits until the test answers it with `answer` or `fail`.
 *
 * @sideEffects none
 * @returns The tracker and what a test drives and checks.
 */
function harness() {
  const clock = new FakeClock(1000);
  const reads: PromiseWithResolvers<PiStats>[] = [];
  const published: SessionMetrics[] = [];
  const failures: unknown[] = [];
  const tracker = createMetricsTracker({
    clock,
    readStats: () => {
      const read = Promise.withResolvers<PiStats>();
      reads.push(read);
      return read.promise;
    },
    onChange: (metrics) => published.push(metrics),
    onReadFailed: (error) => failures.push(error),
  });
  /** Answers the oldest read waiting. */
  const answer = async (value: PiStats) => {
    reads.shift()?.resolve(value);
    await settle();
  };
  /** Fails the oldest read waiting. */
  const fail = async (error: unknown) => {
    reads.shift()?.reject(error);
    await settle();
  };
  /** Feeds events, moving the clock on by each delay first. */
  const feed = (...steps: readonly (TranslatedEvent | number)[]) => {
    for (const step of steps) {
      if (typeof step === "number") clock.advance(step);
      else tracker.observe(step);
    }
  };
  return { tracker, clock, reads, published, failures, answer, fail, feed };
}

describe("createMetricsTracker: pi's statistics", () => {
  it("knows nothing until it has read pi's statistics, then publishes them", async () => {
    const { tracker, reads, published, answer } = harness();
    expect(tracker.current()).toStrictEqual(UNKNOWN_METRICS);

    tracker.refresh();
    expect(reads).toHaveLength(1);
    await answer(stats());

    const expected: SessionMetrics = {
      ...UNKNOWN_METRICS,
      turns: 2,
      steps: 3,
      tokens: { input: 100, output: 20, cacheRead: 900, cacheWrite: 50 },
      cost: 0.12,
      context: { tokens: 4000, window: 200_000, system: null, tools: null },
    };
    expect(tracker.current()).toStrictEqual(expected);
    expect(published).toStrictEqual([expected]);
  });

  it("reads after each reply, compaction and run, one read at a time, reading once more for asks meanwhile", async () => {
    const { tracker, reads, answer, feed } = harness();

    feed(reply());
    feed({ kind: "compaction_finished" }, { kind: "agent_settled" });
    tracker.refresh();
    expect(reads).toHaveLength(1);
    await answer(stats());
    expect(reads).toHaveLength(1);
    await answer(stats({ turns: 3 }));

    expect(reads).toHaveLength(0);
    expect(tracker.current().turns).toBe(3);
  });

  it("reads after a compaction alone, and after a run alone", async () => {
    const { reads, answer, feed } = harness();

    feed({ kind: "compaction_finished" });
    expect(reads).toHaveLength(1);
    await answer(stats());
    feed({ kind: "agent_settled" });

    expect(reads).toHaveLength(1);
  });

  it("reads nothing for a user's message, a tool's result or a stream", () => {
    const { reads, feed } = harness();

    feed(
      { kind: "agent_started" },
      request,
      { kind: "message_finished", message: { kind: "user", text: "hi", images: 0, timestamp: 0 } },
      { kind: "assistant_started" },
      output,
      { kind: "part_delta", index: 0, delta: "x" },
      {
        kind: "message_finished",
        message: {
          kind: "toolResult",
          callId: "c",
          tool: "bash",
          text: "",
          isError: false,
          details: null,
          timestamp: 0,
        },
      },
    );

    expect(reads).toHaveLength(0);
  });

  it("keeps what it knew when a read fails, telling where failures go, and publishes nothing unchanged", async () => {
    const { tracker, published, failures, answer, fail } = harness();
    tracker.refresh();
    await answer(stats());

    tracker.refresh();
    await fail(new Error("pi exited"));
    tracker.refresh();
    await answer(stats());

    expect(failures).toStrictEqual([new Error("pi exited")]);
    expect(published).toHaveLength(1);
    expect(tracker.current().turns).toBe(2);
  });

  it("knows no context without a model, and no context tokens after a compaction", async () => {
    const { tracker, answer } = harness();
    tracker.refresh();
    await answer(stats({ context: null }));
    expect(tracker.current().context).toBeNull();

    tracker.refresh();
    await answer(stats({ context: { tokens: null, window: 1000 } }));

    expect(tracker.current().context).toStrictEqual({ tokens: null, window: 1000, system: null, tools: null });
  });

  it("reads nothing more and publishes nothing once closed, dropping what the read under way brings", async () => {
    const { tracker, reads, published, answer, feed } = harness();
    tracker.refresh();
    feed(reply());

    tracker.close();
    await answer(stats());
    feed(request, 100, output, 100, reply({ output: 1 }));
    tracker.refresh();

    expect(reads).toHaveLength(0);
    expect(published).toStrictEqual([]);
  });
});

describe("createMetricsTracker: the entries", () => {
  it("adds up the whole file's reasoning and the branch's tokens, and splits the context by the branch's system prompt", async () => {
    const { tracker, published, answer } = harness();
    tracker.refresh();
    await answer(stats());
    const kept = assistantEntry("a2", { input: 10, output: 5, cacheRead: 100, cacheWrite: 1, reasoning: 2 });

    tracker.entriesChanged(
      [
        systemEntry("s1", 400, 200),
        assistantEntry("a1", { input: 1000, output: 7, reasoning: 3 }),
        kept,
        assistantEntry("a3", { output: 1 }),
      ],
      [systemEntry("s1", 400, 200), kept],
    );

    expect(tracker.current()).toMatchObject({
      reasoning: 5,
      branchTokens: 116,
      context: { tokens: 4000, window: 200_000, system: 100, tools: 51 },
    });
    expect(published).toHaveLength(2);
  });

  it("takes the entries it starts with in without publishing them", () => {
    const clock = new FakeClock();
    const published: SessionMetrics[] = [];
    const entries = [assistantEntry("a1", { output: 4, reasoning: 1 })];

    const tracker = createMetricsTracker({
      clock,
      entries: { all: entries, branch: entries },
      readStats: () => new Promise(() => undefined),
      onChange: (metrics) => published.push(metrics),
      onReadFailed: () => undefined,
    });
    tracker.entriesChanged(entries, entries);

    expect(tracker.current()).toMatchObject({ reasoning: 1, branchTokens: 4 });
    expect(published).toStrictEqual([]);
  });

  it("knows no reasoning when no reply reported any, and no split without a system prompt", () => {
    const { tracker } = harness();

    tracker.entriesChanged([assistantEntry("a1", { output: 4 })], [assistantEntry("a1", { output: 4 })]);

    expect(tracker.current()).toMatchObject({ reasoning: null, branchTokens: 4, context: null });
  });

  it("counts reasoning a provider reported as none", () => {
    const { tracker } = harness();

    tracker.entriesChanged([assistantEntry("a1", { output: 4, reasoning: 0 })], []);

    expect(tracker.current()).toMatchObject({ reasoning: 0, branchTokens: 0 });
  });
});

describe("createMetricsTracker: timing", () => {
  it("knows no timing before a request was timed", () => {
    expect(harness().tracker.current().timing).toBeNull();
  });

  it("times a request from pi's turn start: first output, the whole reply, and the reply's speed", () => {
    const { tracker, published, feed } = harness();

    feed(request, 300, { kind: "assistant_started" }, 200, output, 2000, reply({ output: 100 }));

    expect(tracker.current().timing).toStrictEqual({ modelMs: 2500, ttftMs: 500, tps: 50 });
    expect(published.at(-1)?.timing).toStrictEqual({ modelMs: 2500, ttftMs: 500, tps: 50 });
  });

  it("averages the first output over requests, adds up their time, and keeps the last reply's speed", () => {
    const { tracker, feed } = harness();

    feed(request, 400, output, 1000, reply({ output: 10 }));
    feed(request, 800, output, 4000, reply({ output: 100 }));

    expect(tracker.current().timing).toStrictEqual({ modelMs: 6200, ttftMs: 600, tps: 25 });
  });

  it("leaves a compaction within a request out of its time", () => {
    const { tracker, feed } = harness();

    feed(request, 100, { kind: "compaction_started" }, 5000, { kind: "compaction_finished" }, 200, output);
    feed(1000, reply({ output: 30 }));

    expect(tracker.current().timing).toStrictEqual({ modelMs: 1300, ttftMs: 300, tps: 30 });
  });

  it("counts a reply that failed before any output in the model's time but not in the average or the speed", () => {
    const { tracker, feed } = harness();
    feed(request, 100, output, 1000, reply({ output: 20 }));

    feed(request, 3000, reply());

    expect(tracker.current().timing).toStrictEqual({ modelMs: 4100, ttftMs: 100, tps: 20 });
  });

  it("knows no first output or speed while no request had output, and times a compaction outside requests not at all", () => {
    const { tracker, feed } = harness();

    feed({ kind: "compaction_started" }, 500, { kind: "compaction_finished" });
    feed(request, 700, reply({ output: 10 }));

    expect(tracker.current().timing).toStrictEqual({ modelMs: 700, ttftMs: null, tps: null });
  });

  it("keeps the last speed when a reply had no output tokens or took no time to stream", () => {
    const { tracker, feed } = harness();
    feed(request, 100, output, 1000, reply({ output: 20 }));

    feed(request, 100, output, 1000, reply({ output: 0 }));
    feed(request, 100, output, reply({ output: 9 }));

    expect(tracker.current().timing).toStrictEqual({ modelMs: 2300, ttftMs: 100, tps: 20 });
  });

  it("times only the first output of a request, and nothing for output or a reply outside one", () => {
    const { tracker, feed } = harness();

    feed(output, 100, reply({ output: 5 }));
    expect(tracker.current().timing).toBeNull();
    feed(request, 100, output, 100, output, 800, reply({ output: 90 }));

    expect(tracker.current().timing).toStrictEqual({ modelMs: 1000, ttftMs: 100, tps: 100 });
  });

  it("forgets a request a pi took with it when it exited", () => {
    const { tracker, feed } = harness();
    feed(request, 100, output);

    tracker.piChanged();
    feed(1000, reply({ output: 10 }));

    expect(tracker.current().timing).toBeNull();
  });
});
