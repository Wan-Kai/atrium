import type { LogEntry, LogUsage, PiStats, TranslatedEvent } from "@atrium/pi";
import { type ContextReserve, type SessionMetrics, UNKNOWN_METRICS } from "@atrium/protocol";
import { FakeClock } from "@atrium/testkit";
import { describe, expect, it, vi } from "vitest";
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
    system: { textChars: chars, sections: {}, pieces: {}, toolsAdded: { read: toolChars }, toolsRemoved: [] },
  };
}

/**
 * Reads of pi's compaction reserve that answer in turn.
 *
 * @remarks
 * An error fails its read; with none left, the reserve is unknown.
 *
 * @sideEffects Takes from `answers` as it reads.
 * @param answers - The reserves, or errors.
 * @returns The read.
 */
function inTurn(answers: (number | "off" | Error)[]): () => Promise<ContextReserve> {
  return async () => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next ?? null;
  };
}

/** A memory file's block, as pi writes it. */
function memory(path: string): string {
  return `<project_instructions path="${path}">\nx\n</project_instructions>`;
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
 * @param readReserve - How pi's compaction reserve is read, if at all.
 * @param provider - The provider of the session's model, if known.
 * @returns The tracker and what a test drives and checks.
 */
function harness(readReserve?: () => Promise<ContextReserve>, provider?: () => string | null) {
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
    ...(readReserve === undefined ? {} : { readReserve }),
    ...(provider === undefined ? {} : { provider }),
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

/** pi starting a compaction of its own. */
const compactionStart = { kind: "compaction_started", reason: "threshold" } as const;

/** pi ending a compaction. */
const compactionEnd = {
  kind: "compaction_finished",
  reason: "threshold",
  aborted: false,
  willRetry: false,
  error: null,
  result: { summary: "", firstKeptEntryId: "e1", tokensBefore: 0 },
} as const;

describe("createMetricsTracker: child conversations", () => {
  it("publishes what the children produced when it changes, and keeps it in the figures once closed", () => {
    const { tracker, published } = harness();

    tracker.childrenChanged({ tokens: 120, cost: 0.75 });
    tracker.childrenChanged({ tokens: 120, cost: 0.75 });
    tracker.close();
    tracker.childrenChanged(null);

    expect(published).toStrictEqual([{ ...UNKNOWN_METRICS, children: { tokens: 120, cost: 0.75 } }]);
    expect(tracker.current()).toStrictEqual(UNKNOWN_METRICS);
  });
});

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
      context: { tokens: 4000, window: 200_000, parts: null, reserve: null },
    };
    expect(tracker.current()).toStrictEqual(expected);
    expect(published).toStrictEqual([expected]);
  });

  it("reads after each reply, compaction and run, one read at a time, reading once more for asks meanwhile", async () => {
    const { tracker, reads, answer, feed } = harness();

    feed(reply());
    feed(compactionEnd, { kind: "agent_settled" });
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

    feed(compactionEnd);
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
      { kind: "message_finished", message: { kind: "user", text: "hi", images: 0, skill: null, timestamp: 0 } },
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

  it("reads pi's compaction reserve with each read, off when pi does not compact, unknown when that fails", async () => {
    const { tracker, answer } = harness(inTurn([16_384, new Error("unreadable"), "off", 9000]));

    const seen: (ContextReserve | undefined)[] = [];
    for (let read = 0; read < 4; read += 1) {
      tracker.refresh();
      await settle();
      await answer(stats());
      seen.push(tracker.current().context?.reserve);
    }

    expect(seen).toStrictEqual([16_384, null, "off", 9000]);
  });

  it("knows no context without a model, and no context tokens after a compaction", async () => {
    const { tracker, answer } = harness();
    tracker.refresh();
    await answer(stats({ context: null }));
    expect(tracker.current().context).toBeNull();

    tracker.refresh();
    await answer(stats({ context: { tokens: null, window: 1000 } }));

    expect(tracker.current().context).toStrictEqual({ tokens: null, window: 1000, parts: null, reserve: null });
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
      context: {
        tokens: 4000,
        window: 200_000,
        parts: {
          system: 100,
          memory: { tokens: 0, files: [] },
          skills: { tokens: 0, items: [] },
          builtin: { tokens: 50, items: [{ name: "read", tokens: 50 }] },
          mcp: { tokens: 0, servers: [] },
          extensions: { tokens: 0, items: [] },
        },
        reserve: null,
      },
    });
    expect(published).toHaveLength(2);
  });

  it("splits the context by the provider of the session's model now, publishing it when the model changed", async () => {
    let provider: string | null = "anthropic";
    const { tracker, published, answer } = harness(undefined, () => provider);
    tracker.refresh();
    await answer(stats());
    const branch = [systemEntry("s1", 400, 200)];
    tracker.entriesChanged(branch, branch);
    provider = "claude-bridge";

    const asked = tracker.current().context?.parts?.system;
    const publishedBefore = published.length;
    tracker.modelChanged();
    provider = null;
    tracker.modelChanged();

    expect([asked, publishedBefore, tracker.current().context?.parts?.system]).toStrictEqual([3925, 2, 100]);
    expect(published.map((metrics) => metrics.context?.parts?.system)).toStrictEqual([undefined, 100, 3925, 100]);
  });

  it("splits the entries it starts with by the provider of the session's model", () => {
    const branch = [systemEntry("s1", 400, 200)];

    const tracker = createMetricsTracker({
      clock: new FakeClock(),
      entries: { all: branch, branch },
      readStats: () => Promise.resolve(stats()),
      provider: () => "claude-bridge",
      onChange: () => undefined,
      onReadFailed: () => undefined,
    });
    tracker.refresh();

    return vi.waitFor(() => expect(tracker.current().context?.parts?.system).toBe(3925));
  });

  it("publishes nothing for a new model before any entries, or when the split stays the same", async () => {
    const { tracker, published, answer } = harness(undefined, () => "openai-codex");
    tracker.refresh();
    await answer(stats());

    tracker.modelChanged();
    tracker.entriesChanged([systemEntry("s1", 400, 200)], [systemEntry("s1", 400, 200)]);
    tracker.modelChanged();

    expect(published).toHaveLength(2);
  });

  it("writes memory files under the home directory from ~, and leaves others as pi named them", () => {
    const clock = new FakeClock();
    const files = [memory("/home/me/.pi/agent/AGENTS.md"), memory("/home/meow/AGENTS.md"), memory("/work/AGENTS.md")];
    const section = files.join("\n\n");
    const entry: LogEntry = {
      id: "s1",
      parentId: null,
      kind: "system",
      timestamp: 0,
      system: {
        textChars: 0,
        sections: { project_context: section.length },
        pieces: {
          project_context: [
            { name: "/home/me/.pi/agent/AGENTS.md", chars: 400 },
            { name: "/home/meow/AGENTS.md", chars: 200 },
            { name: "/work/AGENTS.md", chars: 100 },
          ],
        },
        toolsAdded: {},
        toolsRemoved: [],
      },
    };
    const tracker = createMetricsTracker({
      clock,
      entries: { all: [entry], branch: [entry] },
      home: "/home/me",
      readStats: () => Promise.resolve(stats()),
      onChange: () => undefined,
      onReadFailed: () => undefined,
    });
    tracker.refresh();

    return vi.waitFor(() =>
      expect(tracker.current().context?.parts?.memory.files.map(({ path }) => path)).toStrictEqual([
        "~/.pi/agent/AGENTS.md",
        "/home/meow/AGENTS.md",
        "/work/AGENTS.md",
      ]),
    );
  });

  it("keeps memory files' paths without a home directory, or with an empty one", async () => {
    const clock = new FakeClock();
    const entry: LogEntry = {
      id: "s1",
      parentId: null,
      kind: "system",
      timestamp: 0,
      system: {
        textChars: 0,
        sections: { project_context: 100 },
        pieces: { project_context: [{ name: "/work/AGENTS.md", chars: 100 }] },
        toolsAdded: {},
        toolsRemoved: [],
      },
    };
    const paths = await Promise.all(
      [undefined, ""].map(async (home) => {
        const tracker = createMetricsTracker({
          clock,
          entries: { all: [entry], branch: [entry] },
          home,
          readStats: () => Promise.resolve(stats()),
          onChange: () => undefined,
          onReadFailed: () => undefined,
        });
        tracker.refresh();
        await settle();
        return tracker.current().context?.parts?.memory.files.map(({ path }) => path);
      }),
    );

    expect(paths).toStrictEqual([["/work/AGENTS.md"], ["/work/AGENTS.md"]]);
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

  it("takes the end of a compaction whose start it did not see as no pause", () => {
    const { tracker, feed } = harness();

    feed(request, 100, compactionEnd, 100, output, 1000, reply({ output: 10 }));

    expect(tracker.current().timing).toStrictEqual({ modelMs: 1200, ttftMs: 200, tps: 10 });
  });

  it("leaves a compaction within a request out of its time", () => {
    const { tracker, feed } = harness();

    feed(request, 100, compactionStart, 5000, compactionEnd, 200, output);
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

    feed(compactionStart, 500, compactionEnd);
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
