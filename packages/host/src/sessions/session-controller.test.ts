import type { LogEntry, PiEvent, PiStats } from "@atrium/pi";
import {
  CommandError,
  IDLE_CONTROL,
  type ModelRef,
  SNAPSHOT_TURNS,
  type SessionEvent,
  type SessionModel,
  UNKNOWN_METRICS,
} from "@atrium/protocol";
import { FakeClock, ReplayRequestError, present, replayPi } from "@atrium/testkit";
import { describe, expect, it, vi } from "vitest";
import { fixtureEntries, readPiFixture } from "../../test/pi-fixtures";
import type { EntriesPage } from "../transcript/session-transcript";
import { CONTINUE_TEXT, type SessionPi, createSessionController } from "./session-controller";

const traceIds = ["4bf92f3577b34da6a3ce929d0e0e4736", "5bf92f3577b34da6a3ce929d0e0e4737"] as const;

/** A `prompt` command in the given trace. */
function prompt(requestId: string, text: string, trace: string = traceIds[0]) {
  return { type: "prompt", requestId, traceparent: `00-${trace}-00f067aa0ba902b7-01`, sessionId: "s1", text } as const;
}

/** A `steer` command. */
function steer(requestId: string, text: string) {
  return { ...prompt(requestId, text), type: "steer" } as const;
}

/** A `fetch_transcript` command. */
function fetch(epoch: number, before: string, limit = 10) {
  return {
    type: "fetch_transcript",
    requestId: "f1",
    traceparent: `00-${traceIds[0]}-00f067aa0ba902b7-01`,
    sessionId: "s1",
    epoch,
    before,
    limit,
  } as const;
}

const empty: EntriesPage = { entries: [], leafId: null };

/**
 * A controller over `pi` whose events and refresh failures are recorded, with ids id1, id2, … and
 * a clock at 1000.
 */
function control(
  pi: SessionPi,
  entries: EntriesPage = empty,
  extra: Pick<
    Parameters<typeof createSessionController>[0],
    "respawn" | "turnStarts" | "model" | "onModelChosen" | "fast" | "onFastChosen" | "readReserve" | "home" | "plan"
  > = {},
) {
  const events: SessionEvent[] = [];
  const failures: unknown[] = [];
  const logged: unknown[][] = [];
  let next = 0;
  const clock = new FakeClock(1000);
  const controller = createSessionController({
    sessionId: "s1",
    pi,
    entries,
    publish: (event) => events.push(event),
    clock,
    newId: () => `id${++next}`,
    onRefreshFailed: (error) => failures.push(error),
    log: (level, message, fields) => logged.push([level, message, fields]),
    ...extra,
  });
  return { controller, events, failures, clock, logged };
}

/**
 * The recorded history scenario played back as the session's pi.
 *
 * @remarks
 * `get_entries` from the controller is answered from the recorded file, cut where pi's file had
 * got to at each read; the scenario's own reads go through `raw`.
 */
function replayedHistory() {
  const raw = replayPi(readPiFixture("history"));
  const { entries } = fixtureEntries("history");
  const upTo = (id: string) => entries.findIndex((entry) => entry.id === id) + 1;
  const ends: [number, string][] = [
    [upTo("e4"), "e4"],
    [upTo("e15"), "e15"],
    [upTo("e17"), "e17"],
    [upTo("e18"), "e18"],
    [upTo("e20"), "e20"],
    [upTo("e22"), "e22"],
    [entries.length, "e24"],
  ];
  const since: (string | undefined)[] = [];
  /** The entries from one cut to the next. */
  const page = (index: number): EntriesPage => {
    const [start] = present(ends[index - 1] ?? [0, ""], "the previous cut");
    const [end, leafId] = present(ends[index], "a planned read");
    return { entries: entries.slice(start, end), leafId };
  };
  const pi: SessionPi = {
    onEvent: (listener) => raw.onEvent((event) => listener(event as unknown as PiEvent)),
    exited: raw.exited,
    prompt: (message) => raw.request({ type: "prompt", message } as { type: string }) as never,
    steer: (message) => raw.request({ type: "steer", message } as { type: string }) as never,
    clearQueue: () => raw.request({ type: "clear_queue" }) as never,
    abort: async () => {
      await raw.request({ type: "abort" });
    },
    respond: () => undefined,
    getEntries: async (cursor) => {
      since.push(cursor);
      return page(since.length);
    },
    model: async () => null,
    setModel: async () => undefined,
    setThinkingLevel: async () => undefined,
    setFast: async () => undefined,
    compact: async (instructions) => {
      await raw.request({
        type: "compact",
        ...(instructions === undefined ? {} : { customInstructions: instructions }),
      });
    },
    exportHtml: async () => undefined,
    commands: async () => [],
    stats: () => new Promise(() => undefined),
    stop: () => raw.stop(),
  };
  return { pi, raw, since, initial: page(0) };
}

/** A pi the test drives by hand; `get_entries` answers come from `pages`, in order. */
function manualPi() {
  const listeners = new Set<(event: PiEvent) => void>();
  const exit = Promise.withResolvers<{ code: number | null; signal: string | null; requested: boolean }>();
  const answers: Array<() => Promise<{ disposition: "started" | "queued" | "handled" }>> = [];
  const pages: Array<() => Promise<EntriesPage>> = [];
  const since: (string | undefined)[] = [];
  const steerAnswers: Array<() => Promise<{ disposition: "queued" | "handled" }>> = [];
  /** What pi was sent, in order: `prompt <text>`, `steer <text>`, `clear_queue`, `abort`, `fast on`… */
  const sent: string[] = [];
  const responses: unknown[] = [];
  let held: string[] = [];
  /** What `get_state` reports as the model, in order; the last one repeats. */
  const states: (SessionModel | null)[] = [];
  /** Failures for the next `set_model`, `set_thinking_level` or Fast switch, in order. */
  const settingFailures: unknown[] = [];
  /** Failures for the next `export_html`, in order. */
  const exportFailures: unknown[] = [];
  /** Answers to `compact`, in order; with none left, pi compacts at once. */
  const compactAnswers: Array<() => Promise<void>> = [];
  /** Failures for the next `get_commands`, in order. */
  const commandFailures: unknown[] = [];
  /** Failures for the next `get_state`, in order. */
  const stateFailures: unknown[] = [];
  /** Each message and steer sent, with the data of its images. */
  const withImages: [string, string[]][] = [];
  /** Answers to `get_session_stats`, in order; with none left, a read waits until pi exits, as pi's would. */
  const statsAnswers: Array<() => Promise<PiStats>> = [];
  /** A read nobody answers: it fails once pi exits. */
  const unanswered = async (): Promise<PiStats> => {
    await exit.promise;
    throw new ReplayRequestError("get_session_stats", "exited", "");
  };
  let statsReads = 0;
  const abortGate = Promise.withResolvers<void>();
  let abortWaits = false;
  /**
   * Hands pi's events to the controller.
   *
   * @sideEffects Calls the listeners.
   * @param events - The events, in order.
   */
  const emit = (...events: unknown[]): void => {
    for (const event of events) for (const listener of listeners) listener(event as PiEvent);
  };
  const pi: SessionPi = {
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exited: exit.promise,
    prompt: (message, images) => {
      sent.push(`prompt ${message}`);
      withImages.push([message, images.map((one) => one.data)]);
      return (answers.shift() ?? (async () => ({ disposition: "started" as const })))();
    },
    steer: (message, images) => {
      sent.push(`steer ${message}`);
      withImages.push([message, images.map((one) => one.data)]);
      return (steerAnswers.shift() ?? (async () => ({ disposition: "queued" as const })))();
    },
    clearQueue: async () => {
      sent.push("clear_queue");
      const steering = held;
      held = [];
      // As pi does: the emptied queue's update comes before the answer (fixtures/pi-1.1.0/abort.jsonl).
      emit({ type: "queue_update", steering: [], followUp: [] });
      return { steering };
    },
    abort: async () => {
      sent.push("abort");
      if (abortWaits) await abortGate.promise;
    },
    respond: (response) => responses.push(response),
    getEntries: (cursor) => {
      since.push(cursor);
      return (pages.shift() ?? (async () => empty))();
    },
    model: async () => {
      sent.push("get_state");
      if (stateFailures.length > 0) throw stateFailures.shift();
      return states.length > 1 ? (states.shift() ?? null) : (states[0] ?? null);
    },
    setModel: async ({ providerId, modelId }) => {
      sent.push(`set_model ${providerId}/${modelId}`);
      if (settingFailures.length > 0) throw settingFailures.shift();
    },
    setThinkingLevel: async (level) => {
      sent.push(`set_thinking_level ${level}`);
      if (settingFailures.length > 0) throw settingFailures.shift();
    },
    setFast: async (enabled) => {
      sent.push(`fast ${enabled ? "on" : "off"}`);
      if (settingFailures.length > 0) throw settingFailures.shift();
    },
    compact: (instructions) => {
      sent.push(["compact", instructions].filter((part) => part !== undefined).join(" "));
      return (compactAnswers.shift() ?? (async () => undefined))();
    },
    exportHtml: async (outputPath) => {
      sent.push(`export_html ${outputPath}`);
      if (exportFailures.length > 0) throw exportFailures.shift();
    },
    commands: async () => {
      sent.push("get_commands");
      if (commandFailures.length > 0) throw commandFailures.shift();
      return [{ name: "review", description: null, source: "prompt" as const }];
    },
    stats: () => {
      statsReads += 1;
      return (statsAnswers.shift() ?? unanswered)();
    },
    stop: async () => exit.resolve({ code: 0, signal: null, requested: true }),
  };
  return {
    pi,
    answers,
    steerAnswers,
    sent,
    responses,
    /** Sets the steers pi holds for `clear_queue` to return. */
    hold: (texts: string[]) => {
      held = texts;
    },
    /** Keeps `abort` from answering until the returned function is called. */
    holdAbort: () => {
      abortWaits = true;
      return () => abortGate.resolve();
    },
    pages,
    since,
    states,
    settingFailures,
    compactAnswers,
    exportFailures,
    commandFailures,
    stateFailures,
    withImages,
    statsAnswers,
    /** How many times `get_session_stats` was read. */
    statsReads: () => statsReads,
    emit,
    crash: () => exit.resolve({ code: null, signal: "SIGKILL", requested: false }),
  };
}

/** The `clientMessageId` of every turn started among the events. */
function clientMessageIds(events: readonly SessionEvent[]): (string | null)[] {
  return events.flatMap((event) => (event.type === "turn_started" ? [event.turn.user.clientMessageId] : []));
}

/** pi echoing a user message. */
function userEnd(text: string) {
  return { type: "message_end", message: { role: "user", content: text, timestamp: 0 } };
}

/** pi finishing an assistant message. */
function replyEnd(stopReason: string, content: unknown[] = []) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content,
      stopReason,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      timestamp: 0,
    },
  };
}

/** A user entry. */
function userEntry(id: string, parentId: string | null, text: string): LogEntry {
  return { id, parentId, kind: "user", text, images: 0, skill: null, timestamp: 0 };
}

/** Lets queued microtasks and the replay's deliveries run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Where the snapshots are among the events. */
function snapshotIndexes(events: readonly SessionEvent[]): number[] {
  return events.flatMap((event, index) => (event.type === "session_snapshot" ? [index] : []));
}

/** The envelope every event of the first run carries, at sequence number `seq`. */
function at(seq: number, traceId: string | null = traceIds[0]) {
  return { sessionId: "s1", epoch: 1, seq, traceId };
}

describe("createSessionController on a recorded session", () => {
  it("streams turns live, reads pi's entries after each run and the compaction, and starts a new epoch when the branch changes", async () => {
    const { pi, raw, since, initial } = replayedHistory();
    const { controller, events, failures } = control(pi, initial);

    await controller.prompt(prompt("q1", "one"));
    await vi.waitFor(() => expect(since).toHaveLength(1));
    await controller.prompt(prompt("q2", "two", traceIds[1]));
    await vi.waitFor(() => expect(since).toHaveLength(2));
    expect(await controller.compact(undefined)).toStrictEqual({});
    await vi.waitFor(() => expect(since).toHaveLength(3));
    await controller.prompt(prompt("q3", "three"));
    await vi.waitFor(() => expect(since).toHaveLength(4));
    await raw.request({ type: "get_entries" });
    expect(await controller.prompt(prompt("q4", "/faux-navigate e16"))).toStrictEqual({ disposition: "handled" });
    await controller.prompt(prompt("q5", "two, differently"));
    await vi.waitFor(() => expect(since).toHaveLength(5));
    await raw.request({ type: "get_entries" });
    expect(await controller.prompt(prompt("q6", "/faux-navigate e20"))).toStrictEqual({ disposition: "handled" });
    await controller.prompt(prompt("q7", "four"));
    await vi.waitFor(() => expect(since).toHaveLength(6));
    await settle();

    expect(since).toStrictEqual(["e4", "e15", "e17", "e18", "e20", "e22"]);
    expect(failures).toStrictEqual([]);
    expect(events.filter((event) => event.type === "run_settled").map((event) => event.outcome)).toStrictEqual(
      Array.from({ length: 5 }, () => "completed"),
    );
    expect(clientMessageIds(events)).toStrictEqual(["q1", "q2", "q3", "q5", "q7"]);
    // Every run rebuilt as it was sent, so an epoch holds every event until pi changed branch.
    const snapshots = snapshotIndexes(events);
    expect(snapshots).toHaveLength(2);
    const [toBranch, back] = snapshots as [number, number];
    expect(events.slice(0, toBranch).map((event) => [event.epoch, event.seq])).toStrictEqual(
      Array.from({ length: toBranch }, (_, index) => [1, index + 1]),
    );
    expect(events.slice(toBranch + 1, back).map((event) => [event.epoch, event.seq])).toStrictEqual(
      Array.from({ length: back - toBranch - 1 }, (_, index) => [2, index + 1]),
    );
    expect(back).toBe(events.length - 1);
    expect(events.filter((event) => event.type === "notice_added")).toStrictEqual([
      expect.objectContaining({ notice: expect.objectContaining({ id: "s1:e18" }), epoch: 1, traceId: null }),
    ]);
    expect(events[toBranch]).toMatchObject({ type: "session_snapshot", epoch: 2, seq: 0, run: null });
    expect(events[back]).toMatchObject({ type: "session_snapshot", epoch: 3, seq: 0, hasOlder: false, run: null });
    // Back on the first branch, its turns have the ids they had live.
    expect(controller.snapshot().items.map((item) => item.id)).toStrictEqual(["id2", "id4", "s1:e18", "id6", "id10"]);
  });

  it("pages back through the transcript, and refuses a page from an epoch that has passed", async () => {
    const { pi, raw, since, initial } = replayedHistory();
    const { controller } = control(pi, initial);
    await controller.prompt(prompt("q1", "one"));
    await vi.waitFor(() => expect(since).toHaveLength(1));
    await controller.prompt(prompt("q2", "two"));
    await vi.waitFor(() => expect(since).toHaveLength(2));
    await raw.request({ type: "compact" });
    await vi.waitFor(() => expect(since).toHaveLength(3));
    const items = controller.snapshot().items;

    expect(items.map((item) => item.kind)).toStrictEqual(["turn", "turn", "notice"]);
    expect(controller.fetchTranscript(fetch(1, "s1:e18"))).toStrictEqual({ items: items.slice(0, 2), hasOlder: false });
    expect(controller.fetchTranscript(fetch(1, "s1:e18", 1))).toStrictEqual({
      items: items.slice(1, 2),
      hasOlder: true,
    });
    expect(() => controller.fetchTranscript(fetch(2, "s1:e18"))).toThrow(new CommandError("transcript_changed"));
    expect(() => controller.fetchTranscript(fetch(1, "nope"))).toThrow(new CommandError("transcript_changed"));

    const step = {
      type: "fetch_step",
      requestId: "f2",
      traceparent: fetch(1, "x").traceparent,
      sessionId: "s1",
    } as const;
    expect(controller.fetchStep({ ...step, epoch: 1, turnId: "id2", stepId: "1" })).toStrictEqual({
      step: expect.objectContaining({ kind: "tool", callId: "call-1", output: "tool-ok" }),
    });
    expect(() => controller.fetchStep({ ...step, epoch: 2, turnId: "id2", stepId: "1" })).toThrow(
      new CommandError("transcript_changed"),
    );
    expect(() => controller.fetchStep({ ...step, epoch: 1, turnId: "id2", stepId: "99" })).toThrow(
      new CommandError("transcript_changed"),
    );
  });
});

describe("createSessionController on cases the fixtures do not show", () => {
  it("snapshots the turn running and the run in progress, with the latest sequence number", async () => {
    const { pi, emit } = manualPi();
    const { controller } = control(pi);

    await controller.prompt(prompt("q1", "hi"));
    emit(
      { type: "agent_start" },
      userEnd("hi"),
      { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending", timestamp: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } },
    );

    expect(controller.snapshot()).toStrictEqual({
      type: "session_snapshot",
      ...at(5),
      items: [
        {
          kind: "turn",
          id: "id2",
          user: { text: "hi", images: 0, clientMessageId: "q1", auto: false, command: null, timestamp: 0 },
          steps: [{ kind: "text", id: "0", text: "Hello" }],
          outcome: "running",
          error: null,
          startedAt: 0,
          durationMs: null,
          usage: null,
          changes: [],
        },
      ],
      hasOlder: false,
      run: { runId: "id1", startedAt: 1000 },
      exited: false,
      control: IDLE_CONTROL,
      model: null,
      fast: false,
      metrics: UNKNOWN_METRICS,
    });
  });

  it("starts in the epoch it was given", () => {
    const { pi, emit } = manualPi();
    const events: SessionEvent[] = [];
    const controller = createSessionController({
      sessionId: "s1",
      pi,
      entries: empty,
      publish: (event) => events.push(event),
      clock: new FakeClock(1000),
      newId: () => "id1",
      onRefreshFailed: () => undefined,
      epoch: 4,
    });

    emit({ type: "agent_start" });

    expect(controller.snapshot()).toMatchObject({ epoch: 4, seq: 1 });
    expect(events).toMatchObject([{ type: "run_started", epoch: 4, seq: 1 }]);
  });

  it("starts with the transcript of the entries it was given", () => {
    const { pi } = manualPi();
    const { controller } = control(pi, { entries: [userEntry("u1", null, "earlier")], leafId: "u1" });

    expect(controller.snapshot()).toMatchObject({ seq: 0, items: [{ id: "s1:u1", user: { text: "earlier" } }] });
  });

  it("gives every item from the session's start, beyond what a snapshot holds", () => {
    const { pi } = manualPi();
    const entries = [
      userEntry("u0", null, "message 0"),
      ...Array.from({ length: SNAPSHOT_TURNS }, (_, n) => userEntry(`u${n + 1}`, `u${n}`, `message ${n + 1}`)),
    ];
    const { controller } = control(pi, { entries, leafId: `u${SNAPSHOT_TURNS}` });

    expect(controller.snapshot().items).toHaveLength(SNAPSHOT_TURNS);
    expect(controller.items()).toMatchObject(entries.map((_, n) => ({ kind: "turn", user: { text: `message ${n}` } })));
  });

  it("marks the turns an earlier host sent on its own", () => {
    const { pi } = manualPi();
    const { controller } = control(
      pi,
      { entries: [userEntry("u1", null, "one"), userEntry("u2", "u1", CONTINUE_TEXT)], leafId: "u2" },
      { turnStarts: { opened: new Set(["u1", "u2"]), auto: new Set(["u2"]), record: () => undefined } },
    );

    expect(controller.snapshot().items).toMatchObject([
      { user: { text: "one", auto: false } },
      { user: { text: CONTINUE_TEXT, auto: true } },
    ]);
  });

  it("matches echoed user messages to waiting prompts in order, skipping a prompt pi handled itself", async () => {
    const { pi, emit, answers } = manualPi();
    const { controller, events } = control(pi);
    answers.push(async () => ({ disposition: "handled" }));

    expect(await controller.prompt(prompt("q1", "/faux-noop"))).toStrictEqual({ disposition: "handled" });
    await controller.prompt(prompt("q2", "a"));
    expect(await controller.prompt(prompt("q3", "b"))).toStrictEqual({ disposition: "queued", itemId: "id1" });
    emit({ type: "agent_start" }, userEnd("a"), { type: "agent_settled" });
    await settle();
    emit({ type: "agent_start" }, userEnd("b"), userEnd("echoed by an extension"));

    expect(clientMessageIds(events)).toStrictEqual(["q2", "q3", null]);
  });

  it("forgets a prompt pi rejected, and passes the failure on", async () => {
    const { pi, emit, answers } = manualPi();
    const { controller, events } = control(pi);
    const failure = new Error("rejected");
    answers.push(() => Promise.reject(failure));

    await expect(controller.prompt(prompt("q1", "x"))).rejects.toBe(failure);
    await controller.prompt(prompt("q2", "y"));
    emit(userEnd("y"));

    expect(clientMessageIds(events)).toStrictEqual(["q2"]);
  });

  it.each([
    ["stop", "completed"],
    ["length", "completed"],
    ["aborted", "stopped"],
    ["toolUse", "stopped"],
    ["error", "failed"],
  ])("ends a run whose last reply stopped with %s as %s, after its turn", async (stopReason, outcome) => {
    const { pi, emit } = manualPi();
    const { controller, events } = control(pi);

    emit({ type: "agent_settled" });
    await controller.prompt(prompt("q1", "x"));
    emit({ type: "agent_start" }, userEnd("x"), replyEnd(stopReason), { type: "agent_settled" });

    expect(events.map((event) => event.type).slice(-2)).toStrictEqual(["turn_finished", "run_settled"]);
    expect(events.at(-1)).toMatchObject({ type: "run_settled", outcome, traceId: traceIds[0] });
  });

  it("ends a run without a turn as completed, and starts a run pi begins on its own without a trace", () => {
    const { pi, emit } = manualPi();
    const { events } = control(pi);

    emit({ type: "agent_start" }, { type: "agent_start" }, { type: "agent_settled" });

    expect(events).toStrictEqual([
      { type: "run_started", ...at(1, null), runId: "id1", startedAt: 1000 },
      { type: "run_settled", ...at(2, null), runId: "id1", outcome: "completed", settledAt: 1000 },
    ]);
  });

  it("fails the run in progress when pi crashes, ends its turn, reports the exit, and refuses prompts afterwards", async () => {
    const { pi, emit, crash, since } = manualPi();
    const { controller, events } = control(pi);
    await controller.prompt(prompt("q1", "x"));
    emit({ type: "agent_start" }, userEnd("x"));

    crash();
    await settle();

    expect(events.slice(-3)).toStrictEqual([
      {
        type: "turn_finished",
        ...at(3),
        turnId: "id2",
        outcome: "failed",
        error: null,
        durationMs: 0,
        usage: null,
        changes: [],
      },
      { type: "run_settled", ...at(4), runId: "id1", outcome: "failed", settledAt: 1000 },
      { type: "session_exited", ...at(5, null), reason: "crashed", code: null, signal: "SIGKILL" },
    ]);
    expect(controller.snapshot()).toMatchObject({ run: null, seq: 5, exited: true });
    expect(since).toStrictEqual([]);
    await expect(controller.prompt(prompt("q2", "y"))).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "exited" }),
    );
  });

  it("reports a stop the host asked for as requested", async () => {
    const { pi } = manualPi();
    const { controller, events } = control(pi);

    await controller.shutdown();
    await settle();

    expect(events).toStrictEqual([
      { type: "session_exited", ...at(1, null), reason: "requested", code: 0, signal: null },
    ]);
  });

  it("reads one page at a time, reading again once more if asked meanwhile", async () => {
    const { pi, emit, pages, since } = manualPi();
    const { events, failures } = control(pi);
    const first = Promise.withResolvers<EntriesPage>();
    pages.push(
      () => first.promise,
      async () => ({ entries: [], leafId: "u1" }),
    );

    emit({ type: "compaction_end" }, { type: "compaction_end" }, { type: "compaction_end" });
    await settle();
    expect(since).toStrictEqual([undefined]);
    first.resolve({ entries: [userEntry("u1", null, "a")], leafId: "u1" });
    await vi.waitFor(() => expect(since).toStrictEqual([undefined, "u1"]));
    await settle();

    expect(failures).toStrictEqual([]);
    expect(events).toStrictEqual([
      expect.objectContaining({
        type: "session_snapshot",
        epoch: 2,
        seq: 0,
        items: [expect.objectContaining({ id: "s1:u1" })],
      }),
    ]);
  });

  it("leaves the rebuild to the end of a run that started while it read", async () => {
    const { pi, emit, pages, since } = manualPi();
    const { controller, events } = control(pi);
    const first = Promise.withResolvers<EntriesPage>();
    pages.push(() => first.promise);

    emit({ type: "compaction_end" });
    await controller.prompt(prompt("q1", "a"));
    emit({ type: "agent_start" }, userEnd("a"));
    first.resolve({ entries: [userEntry("u1", null, "a")], leafId: "u1" });
    await settle();
    expect(events.map((event) => event.type)).toStrictEqual(["run_started", "turn_started"]);

    pages.push(async () => ({ entries: [userEntry("u1", null, "a")], leafId: "u1" }));
    emit(replyEnd("stop", [{ type: "text", text: "b" }]), { type: "agent_settled" });
    await vi.waitFor(() => expect(since).toHaveLength(2));
    await settle();

    expect(since).toStrictEqual([undefined, undefined]);
    expect(events.at(-1)).toMatchObject({ type: "session_snapshot", epoch: 2 });
  });

  it("waits for the read under way, which ties a turn just ended to its entry, and for nothing without one", async () => {
    const { pi, emit, pages } = manualPi();
    const { controller } = control(pi);
    const read = Promise.withResolvers<EntriesPage>();
    pages.push(() => read.promise);
    await controller.entriesRead();
    await controller.prompt(prompt("q1", "a"));
    emit({ type: "agent_start" }, userEnd("a"), replyEnd("stop", [{ type: "text", text: "b" }]), {
      type: "agent_settled",
    });
    const turnId = present(controller.snapshot().items[0], "the turn").id;

    const waited = controller.entriesRead();
    const before = controller.entryOfTurn(turnId);
    read.resolve({ entries: [userEntry("u1", null, "a")], leafId: "u1" });
    await waited;

    expect([before, controller.entryOfTurn(turnId)]).toStrictEqual([null, "u1"]);
  });

  it("does not read while a run goes on, or once pi has exited", async () => {
    const { pi, emit, since, crash } = manualPi();
    control(pi);

    emit({ type: "agent_start" }, { type: "compaction_end" });
    await settle();
    expect(since).toStrictEqual([]);
    crash();
    await settle();
    emit({ type: "compaction_end" });
    await settle();

    expect(since).toStrictEqual([]);
  });

  it("reads the whole session again when pi does not know the cursor, forgetting the old file's entries", async () => {
    const { pi, emit, pages, since } = manualPi();
    const { events } = control(pi, { entries: [userEntry("u1", null, "a")], leafId: "u1" });
    pages.push(
      () => Promise.reject(new ReplayRequestError("get_entries", "rejected", "Entry not found: u1")),
      async () => ({ entries: [userEntry("v1", "u1", "b")], leafId: "v1" }),
    );

    emit({ type: "compaction_end" });
    await vi.waitFor(() => expect(since).toStrictEqual(["u1", undefined]));
    await settle();

    expect(events).toMatchObject([{ type: "session_snapshot", epoch: 2, items: [{ id: "s1:v1" }] }]);
  });

  it("reads the whole session again only when pi says it does not know the cursor", async () => {
    const { pi, emit, pages, since } = manualPi();
    const { failures } = control(pi);
    const exited = new ReplayRequestError("get_entries", "exited", "Entry not found: in stderr");
    const notPi = Object.assign(new Error("other"), { detail: "Entry not found: x" });
    pages.push(
      () => Promise.reject(exited),
      () => Promise.reject(notPi),
    );

    emit({ type: "compaction_end" });
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    emit({ type: "compaction_end" });
    await vi.waitFor(() => expect(failures).toHaveLength(2));

    expect(failures).toStrictEqual([exited, notPi]);
    expect(since).toStrictEqual([undefined, undefined]);
  });

  it("dates a message pi sent without a time by the host's clock", async () => {
    const { pi, emit } = manualPi();
    const { controller } = control(pi);

    emit({ type: "agent_start" }, { type: "message_end", message: { role: "user", content: "x" } });

    expect(controller.snapshot().items).toMatchObject([{ startedAt: 1000, user: { timestamp: 1000 } }]);
  });

  it("settles a run whose turn ended with a tool still running, its turn first", async () => {
    const { pi, emit } = manualPi();
    const { events } = control(pi);

    emit(
      { type: "agent_start" },
      userEnd("x"),
      replyEnd("toolUse", [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "sleep" } }]),
      { type: "agent_settled" },
    );

    expect(events.map((event) => event.type).slice(-3)).toStrictEqual(["step_updated", "turn_finished", "run_settled"]);
    expect(events.at(-1)).toMatchObject({ outcome: "stopped" });
  });

  it("reports any other failure to read, and reads again next time", async () => {
    const { pi, emit, pages, since } = manualPi();
    const { events, failures } = control(pi);
    const refused = new ReplayRequestError("get_entries", "rejected", "busy");
    const gone = new ReplayRequestError("get_entries", "exited", "");
    pages.push(
      () => Promise.reject(refused),
      () => Promise.reject(gone),
      async () => ({ entries: [userEntry("u1", null, "a")], leafId: "u1" }),
    );

    emit({ type: "compaction_end" });
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    emit({ type: "compaction_end" });
    await vi.waitFor(() => expect(failures).toHaveLength(2));
    emit({ type: "compaction_end" });
    await vi.waitFor(() => expect(since).toHaveLength(3));
    await settle();

    expect(failures).toStrictEqual([refused, gone]);
    expect(events).toMatchObject([{ type: "session_snapshot", epoch: 2 }]);
  });

  it("sends nothing when a read finds the transcript as it was", async () => {
    const { pi, emit, since } = manualPi();
    const { events } = control(pi);

    emit({ type: "compaction_end" });
    await vi.waitFor(() => expect(since).toHaveLength(1));
    await settle();

    expect(events).toStrictEqual([]);
  });

  it.each([
    ["with a run", "Agent is already processing. Specify streamingBehavior."],
    ["compacting", "Cannot submit a prompt while compaction is in progress."],
  ])("queues a message pi refuses as busy %s, and sends it once the run ends", async (_case, text) => {
    const { pi, answers, emit, sent } = manualPi();
    const { controller } = control(pi);
    answers.push(() => Promise.reject(new ReplayRequestError("prompt", "rejected", text)));

    expect(await controller.prompt(prompt("q1", "x"))).toStrictEqual({ disposition: "queued", itemId: "id1" });
    expect(controller.snapshot().control.queue).toStrictEqual([{ id: "id1", text: "x", createdAt: 1000, images: 0 }]);
    emit({ type: "agent_start" }, { type: "agent_settled" });

    expect(sent).toStrictEqual(["prompt x", "prompt x"]);
    expect(controller.snapshot().control.queue).toStrictEqual([]);
  });

  it.each([
    [
      "refusing for another reason",
      new ReplayRequestError("prompt", "rejected", "No model"),
      new CommandError("pi_rejected", { detail: "No model" }),
    ],
    [
      "refusing without text",
      new ReplayRequestError("prompt", "rejected"),
      new CommandError("pi_rejected", { detail: "" }),
    ],
    [
      "exiting",
      new ReplayRequestError("prompt", "exited", ""),
      new CommandError("pi_unavailable", { status: "exited" }),
    ],
    [
      "being stopped",
      new ReplayRequestError("prompt", "stopped"),
      new CommandError("pi_unavailable", { status: "exited" }),
    ],
  ])("turns pi %s into an error code, not a host failure", async (_case, failure, expected) => {
    const { pi, answers } = manualPi();
    const { controller } = control(pi);
    answers.push(() => Promise.reject(failure));

    await expect(controller.prompt(prompt("q1", "x"))).rejects.toStrictEqual(expected);
  });

  it("reports a pi that does not answer in time as unresponsive, and passes other errors on", async () => {
    const { pi, answers } = manualPi();
    const { controller } = control(pi);
    const other = new Error("not from pi");
    const withReason = Object.assign(new Error("has a reason"), { reason: "rejected" });
    const notAnError = { name: "PiRequestError", reason: "rejected" };
    const timeout = Object.assign(new Error("pi prompt timeout"), { name: "PiRequestError", reason: "timeout" });
    answers.push(
      () => Promise.reject(timeout),
      () => Promise.reject(other),
      () => Promise.reject(withReason),
      // oxlint-disable-next-line prefer-promise-reject-errors -- testing what is not an Error.
      () => Promise.reject(notAnError),
    );

    await expect(controller.prompt(prompt("q1", "x"))).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "unresponsive" }),
    );
    await expect(controller.prompt(prompt("q2", "y"))).rejects.toBe(other);
    await expect(controller.prompt(prompt("q3", "z"))).rejects.toBe(withReason);
    await expect(controller.prompt(prompt("q4", "w"))).rejects.toBe(notAnError);
  });

  it("does not drop another prompt's place when a failed one was already echoed", async () => {
    const { pi, emit, answers } = manualPi();
    const { controller, events } = control(pi);
    const first = Promise.withResolvers<{ disposition: "started" }>();
    const second = Promise.withResolvers<{ disposition: "started" }>();
    answers.push(
      () => first.promise,
      () => second.promise,
    );

    const failing = controller.prompt(prompt("q1", "a"));
    const later = controller.prompt(prompt("q2", "b"));
    emit(userEnd("a"));
    first.reject(new ReplayRequestError("prompt", "exited", ""));
    await expect(failing).rejects.toBeInstanceOf(CommandError);
    emit(userEnd("b"));
    second.resolve({ disposition: "started" });
    await later;

    expect(clientMessageIds(events)).toStrictEqual(["q1", "q2"]);
  });
});

/** The control published last, or the snapshot's when none was. */
function lastControl(events: readonly SessionEvent[], controller: { snapshot(): { control: unknown } }) {
  return controller.snapshot().control;
}

/** pi starting and ending a run around an echoed message. */
function runOf(text: string) {
  return [{ type: "agent_start" }, userEnd(text), replyEnd("stop"), { type: "agent_settled" }];
}

describe("createSessionController queueing messages", () => {
  it("queues messages sent during a run and sends them one at a time as runs end, in order", async () => {
    const { pi, emit, sent } = manualPi();
    const { controller, events } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" }, userEnd("one"));

    expect(await controller.prompt(prompt("q2", "two"))).toStrictEqual({ disposition: "queued", itemId: "id3" });
    expect(await controller.prompt(prompt("q3", "three"))).toStrictEqual({ disposition: "queued", itemId: "id4" });
    expect(lastControl(events, controller)).toMatchObject({
      queue: [
        { id: "id3", text: "two", createdAt: 1000, images: 0 },
        { id: "id4", text: "three", createdAt: 1000, images: 0 },
      ],
    });
    emit(replyEnd("stop"), { type: "agent_settled" });
    await settle();
    expect(sent).toStrictEqual(["prompt one", "prompt two"]);
    emit(...runOf("two"));
    await settle();

    expect(sent).toStrictEqual(["prompt one", "prompt two", "prompt three"]);
    expect(clientMessageIds(events)).toStrictEqual(["q1", "q2"]);
    expect(
      events.filter((event) => event.type === "control_updated").map((event) => event.control.queue.length),
    ).toStrictEqual([1, 2, 1, 0]);
  });

  it("moves on after a message pi handled, telling its client", async () => {
    const { pi, emit, sent, answers } = manualPi();
    const { controller, events } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" }, userEnd("one"));
    await controller.prompt(prompt("q2", "/noop"));
    await controller.prompt(prompt("q3", "three"));
    answers.push(
      async () => ({ disposition: "started" }),
      async () => ({ disposition: "handled" }),
    );
    answers.shift();

    emit(replyEnd("stop"), { type: "agent_settled" });
    await settle();

    expect(sent).toStrictEqual(["prompt one", "prompt /noop", "prompt three"]);
    expect(events.filter((event) => event.type === "prompt_handled")).toMatchObject([{ clientMessageId: "q2" }]);
  });

  it("holds the queue while pi compacts and sends once the compaction ends", async () => {
    const { pi, emit, sent } = manualPi();
    const { controller } = control(pi);
    emit({ type: "compaction_start", reason: "manual" });

    expect(await controller.prompt(prompt("q1", "one"))).toMatchObject({ disposition: "queued" });
    expect(sent).toStrictEqual([]);
    emit({ type: "compaction_end" });
    await settle();

    expect(sent).toStrictEqual(["prompt one"]);
  });

  it("edits, removes and clears queued messages, and refuses an item it does not have", async () => {
    const { pi, emit } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    await controller.prompt(prompt("q2", "two"));
    await controller.prompt(prompt("q3", "three"));
    await controller.prompt(prompt("q4", "four"));

    controller.updateQueued("id2", "TWO");
    controller.removeQueued("id3");
    expect(controller.snapshot().control.queue.map((item) => item.text)).toStrictEqual(["TWO", "four"]);
    expect(() => controller.updateQueued("nope", "x")).toThrow(
      new CommandError("queue_item_not_found", { itemId: "nope" }),
    );
    expect(() => controller.removeQueued("nope")).toThrow(new CommandError("queue_item_not_found", { itemId: "nope" }));
    controller.clearQueue();

    expect(controller.snapshot().control.queue).toStrictEqual([]);
  });

  it("puts a queued message pi refuses back at the front and pauses the queue", async () => {
    const { pi, emit, answers } = manualPi();
    const { controller, logged } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    await controller.prompt(prompt("q2", "two"));
    answers.push(() => Promise.reject(new ReplayRequestError("prompt", "rejected", "No model")));

    emit({ type: "agent_settled" });
    await settle();

    expect(controller.snapshot().control).toMatchObject({ queue: [{ text: "two" }], paused: "stopped" });
    expect(logged).toStrictEqual([["warn", "queued message refused", { sessionId: "s1", code: "pi_rejected" }]]);
  });

  it("keeps the queue in order when pi refuses a queued message as busy, sending it first after pi's own run", async () => {
    const { pi, emit, sent, answers } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    await controller.prompt(prompt("q2", "two"));
    await controller.prompt(prompt("q3", "three"));
    answers.push(() => Promise.reject(new ReplayRequestError("prompt", "rejected", "Agent is already processing")));

    emit({ type: "agent_settled" });
    await settle();
    expect(sent).toStrictEqual(["prompt one", "prompt two"]);
    expect(controller.snapshot().control).toMatchObject({ queue: [{ text: "two" }, { text: "three" }], paused: null });
    emit({ type: "agent_start" }, { type: "agent_settled" });
    await settle();

    expect(sent).toStrictEqual(["prompt one", "prompt two", "prompt two"]);
    expect(controller.snapshot().control.queue.map((item) => item.text)).toStrictEqual(["three"]);
  });

  it("takes back a queued message pi did not take because it exited, and sends it once, after the restart", async () => {
    const { first, next, controller } = crashing(1);
    await controller.prompt(prompt("q1", "one"));
    first.emit({ type: "agent_start" }, userEnd("one"));
    await controller.prompt(prompt("q2", "two"));
    first.answers.push(() => Promise.reject(new ReplayRequestError("prompt", "exited")));
    first.emit(replyEnd("stop"), { type: "agent_settled" });
    await settle();
    expect(controller.snapshot().control).toMatchObject({ queue: [{ text: "two" }], paused: null });

    first.crash();
    await settle();
    const second = present(next[0], "the second pi");
    second.emit(...runOf("two"));
    await settle();

    expect(second.sent).toStrictEqual(["prompt two"]);
    expect(controller.snapshot().control.queue).toStrictEqual([]);
  });
});

describe("createSessionController steering", () => {
  it("steers pi during a run and lists the steer until pi delivers it", async () => {
    const { pi, emit, sent } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });

    expect(await controller.steer(steer("s1", "also"))).toStrictEqual({ disposition: "queued" });
    expect(controller.snapshot().control.steers).toStrictEqual([{ id: "s1", text: "also" }]);
    emit({ type: "queue_update", steering: ["also"], followUp: [] });
    expect(controller.snapshot().control.steers).toStrictEqual([{ id: "s1", text: "also" }]);
    emit({ type: "queue_update", steering: [], followUp: [] });

    expect(controller.snapshot().control.steers).toStrictEqual([]);
    expect(sent).toStrictEqual(["prompt one", "steer also"]);
  });

  it("keeps a steer through a queue update pi sent before it took the steer", async () => {
    const { pi, emit } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    await controller.steer(steer("s1", "also"));

    emit({ type: "queue_update", steering: [], followUp: [] });

    expect(controller.snapshot().control.steers).toStrictEqual([{ id: "s1", text: "also" }]);
  });

  it("counts pi's steers by its queue growing and shrinking from the front, not by their texts", async () => {
    const { pi, emit } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    await controller.steer(steer("s1", "same"));
    emit({ type: "queue_update", steering: ["same"], followUp: [] });
    await controller.steer(steer("s2", "same"));
    emit({ type: "queue_update", steering: ["same", "same"], followUp: [] });
    await controller.steer(steer("s3", "other"));
    emit({ type: "queue_update", steering: ["same", "same", "other"], followUp: [] });

    emit({ type: "queue_update", steering: ["same", "other"], followUp: [] });

    expect(controller.snapshot().control.steers).toStrictEqual([
      { id: "s2", text: "same" },
      { id: "s3", text: "other" },
    ]);
  });

  it("follows a steer pi listed by another text, as a skill it expanded, and those after it", async () => {
    const { pi, emit, hold } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    await controller.steer(steer("s1", "/skill:review"));
    emit({ type: "queue_update", steering: ["<skill review>…"], followUp: [] });
    await controller.steer(steer("s2", "and this"));
    emit({ type: "queue_update", steering: ["<skill review>…", "and this"], followUp: [] });

    emit({ type: "queue_update", steering: ["and this"], followUp: [] });
    expect(controller.snapshot().control.steers).toStrictEqual([{ id: "s2", text: "and this" }]);
    await controller.steer(steer("s3", "/skill:review"));
    emit({ type: "queue_update", steering: ["and this", "<skill review>…"], followUp: [] });
    hold(["and this", "<skill review>…"]);
    await controller.stop();

    // Given back as they were sent, so sending them again expands the skill again.
    expect(controller.snapshot().control.queue.map((item) => item.text)).toStrictEqual(["and this", "/skill:review"]);
    expect(controller.snapshot().control.steers).toStrictEqual([]);
  });

  it("sends a steer only once pi has answered the one before, as pi may take steers sent together out of order", async () => {
    const { pi, emit, sent, steerAnswers } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    const first = Promise.withResolvers<{ disposition: "queued" }>();
    steerAnswers.push(() => first.promise);

    const steering = [controller.steer(steer("s1", "a")), controller.steer(steer("s2", "b"))];
    await settle();
    expect(sent).toStrictEqual(["prompt one", "steer a"]);
    expect(controller.snapshot().control.steers).toStrictEqual([
      { id: "s1", text: "a" },
      { id: "s2", text: "b" },
    ]);
    // pi takes the first; the second, still waiting its turn, is not listed, so stays once the first is delivered.
    emit({ type: "queue_update", steering: ["a"], followUp: [] });
    emit({ type: "queue_update", steering: [], followUp: [] });
    expect(controller.snapshot().control.steers).toStrictEqual([{ id: "s2", text: "b" }]);
    first.resolve({ disposition: "queued" });

    expect(await Promise.all(steering)).toStrictEqual([{ disposition: "queued" }, { disposition: "queued" }]);
    expect(sent).toStrictEqual(["prompt one", "steer a", "steer b"]);
  });

  it("lists only as many steers as pi's queue grew by, leaving the one still waiting its turn", async () => {
    const { pi, emit, steerAnswers } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    await controller.steer(steer("s1", "a"));
    emit({ type: "queue_update", steering: ["a"], followUp: [] });
    const second = Promise.withResolvers<{ disposition: "queued" }>();
    steerAnswers.push(() => second.promise);
    const steering = [controller.steer(steer("s2", "b")), controller.steer(steer("s3", "c"))];
    await settle();

    emit({ type: "queue_update", steering: ["a", "b"], followUp: [] });
    emit({ type: "queue_update", steering: [], followUp: [] });

    expect(controller.snapshot().control.steers).toStrictEqual([{ id: "s3", text: "c" }]);
    second.resolve({ disposition: "queued" });
    expect(await Promise.all(steering)).toStrictEqual([{ disposition: "queued" }, { disposition: "queued" }]);
  });

  it("sends a steer whose turn comes after the run ended as a message", async () => {
    const { pi, emit, sent, steerAnswers } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    const first = Promise.withResolvers<{ disposition: "queued" }>();
    steerAnswers.push(() => first.promise);
    const earlier = controller.steer(steer("s1", "a"));
    const later = controller.steer(steer("s2", "b"));
    await settle();

    emit({ type: "agent_settled" });
    await settle();
    first.resolve({ disposition: "queued" });

    expect(await earlier).toStrictEqual({ disposition: "queued" });
    expect(await later).toStrictEqual({ disposition: "started" });
    expect(sent).toStrictEqual(["prompt one", "steer a", "prompt b"]);
    expect(controller.snapshot().control.steers).toStrictEqual([{ id: "s1", text: "a" }]);
  });

  it("follows pi's queue again after a stop took the steers back", async () => {
    const { pi, emit, hold } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    await controller.steer(steer("s1", "a"));
    emit({ type: "queue_update", steering: ["a"], followUp: [] });
    hold(["a"]);
    await controller.stop();
    emit({ type: "agent_settled" });
    await settle();
    controller.resumeQueue();
    emit({ type: "agent_start" });

    await controller.steer(steer("s2", "b"));
    emit({ type: "queue_update", steering: ["b"], followUp: [] });
    emit({ type: "queue_update", steering: [], followUp: [] });

    expect(controller.snapshot().control.steers).toStrictEqual([]);
  });

  it("gives a text pi had from elsewhere back as pi gave it, without images", async () => {
    const { pi, emit, hold, withImages } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    await controller.steer(steer("s1", "ours"), [image("x")]);
    emit({ type: "queue_update", steering: ["ours"], followUp: [] });
    hold(["an extension's", "ours"]);

    await controller.stop();
    emit({ type: "agent_settled" });
    await settle();
    controller.resumeQueue();

    expect(controller.snapshot().control.queue.map((item) => [item.text, item.images])).toStrictEqual([["ours", 1]]);
    expect(withImages.at(-1)).toStrictEqual(["an extension's", []]);
  });

  it("sends a steer as a message when idle, and tells the client when pi handled a steer", async () => {
    const { pi, emit, sent, steerAnswers } = manualPi();
    const { controller, events } = control(pi);

    expect(await controller.steer(steer("s1", "go"))).toStrictEqual({ disposition: "started" });
    emit({ type: "agent_start" });
    steerAnswers.push(async () => ({ disposition: "handled" }));
    expect(await controller.steer(steer("s2", "/cmd"))).toStrictEqual({ disposition: "handled" });

    expect(sent).toStrictEqual(["prompt go", "steer /cmd"]);
    expect(events.filter((event) => event.type === "prompt_handled")).toMatchObject([{ clientMessageId: "s2" }]);
    expect(controller.snapshot().control.steers).toStrictEqual([]);
  });

  it("passes a steer pi refuses on as an error code, telling viewers it is gone", async () => {
    const { pi, emit, steerAnswers, withImages } = manualPi();
    const { controller, events } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    steerAnswers.push(() => Promise.reject(new ReplayRequestError("steer", "rejected", "extension command")));

    await expect(controller.steer(steer("s1", "/x"))).rejects.toStrictEqual(
      new CommandError("pi_rejected", { detail: "extension command" }),
    );
    expect(withImages.at(-1)).toStrictEqual(["/x", []]);
    expect(events.filter((event) => event.type === "control_updated").at(-1)).toMatchObject({
      control: { steers: [] },
    });
  });

  it("steers a queued message, putting it back where it was when pi refuses", async () => {
    const { pi, emit, sent, steerAnswers } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    await controller.prompt(prompt("q2", "two"));
    await controller.prompt(prompt("q3", "three"));

    expect(await controller.steerQueued("id2")).toStrictEqual({ disposition: "queued" });
    steerAnswers.push(() => Promise.reject(new ReplayRequestError("steer", "exited")));
    await expect(controller.steerQueued("id3")).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "exited" }),
    );

    expect(sent).toStrictEqual(["prompt one", "steer two", "steer three"]);
    expect(controller.snapshot().control).toMatchObject({ queue: [{ id: "id3" }], steers: [{ text: "two" }] });
  });

  it("lists a steer pi delivered before it answered only until then", async () => {
    const { pi, emit, steerAnswers } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    const answer = Promise.withResolvers<{ disposition: "queued" }>();
    steerAnswers.push(() => answer.promise);

    const steering = controller.steer(steer("s1", "also"));
    emit(
      { type: "queue_update", steering: ["also"], followUp: [] },
      { type: "queue_update", steering: [], followUp: [] },
    );
    answer.resolve({ disposition: "queued" });

    expect(await steering).toStrictEqual({ disposition: "queued" });
    expect(controller.snapshot().control.steers).toStrictEqual([]);
  });

  it("queues a steer sent while a message is on its way, since pi only delivers steers into a run", async () => {
    const { pi, sent, answers } = manualPi();
    const { controller } = control(pi);
    const answer = Promise.withResolvers<{ disposition: "started" }>();
    answers.push(() => answer.promise);
    const sending = controller.prompt(prompt("q1", "one"));

    expect(await controller.steer(steer("s1", "also"))).toStrictEqual({ disposition: "queued" });
    answer.resolve({ disposition: "started" });
    await sending;

    expect(sent).toStrictEqual(["prompt one"]);
    expect(controller.snapshot().control).toMatchObject({ queue: [{ text: "also" }], steers: [] });
  });
});

/**
 * The same exit, counting how many times something started waiting on it.
 *
 * @remarks
 * Whatever waits on a promise asks it for `then`; a wait left behind on a pi that lives on holds
 * its command's context and trace until pi exits.
 *
 * @sideEffects none
 * @param exited - pi's exit.
 * @returns The counting exit, and the count so far.
 */
function countingWaits<T>(exited: Promise<T>): { readonly exited: Promise<T>; readonly waits: () => number } {
  let waits = 0;
  return {
    exited: new Proxy(exited, {
      get: (target, key) => {
        if (key !== "then") return Reflect.get(target, key);
        waits += 1;
        return target.then.bind(target);
      },
    }),
    waits: () => waits,
  };
}

describe("createSessionController stopping", () => {
  it("pauses the queue, puts pi's steers back at its front, aborts, and confirms", async () => {
    const { pi, emit, sent, hold } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    await controller.prompt(prompt("q2", "two"));
    await controller.steer(steer("s1", "also"));
    hold(["also"]);

    expect(await controller.stop()).toStrictEqual({ confirmed: true });

    expect(sent).toStrictEqual(["prompt one", "steer also", "clear_queue", "abort"]);
    expect(controller.snapshot().control).toMatchObject({
      queue: [{ text: "also" }, { text: "two" }],
      paused: "stopped",
      steers: [],
      stopping: false,
    });
    emit({ type: "agent_settled" });
    await settle();
    expect(sent).toHaveLength(4);
  });

  it("leaves nothing waiting on pi's exit after a stop, however many runs a long-lived pi stops", async () => {
    const { pi, emit } = manualPi();
    const { exited, waits } = countingWaits(pi.exited);
    const { controller } = control({ ...pi, exited });
    /** Starts a run and stops it. */
    const stopRun = async (requestId: string) => {
      await controller.prompt(prompt(requestId, "go"));
      emit({ type: "agent_start" });
      expect(await controller.stop()).toStrictEqual({ confirmed: true });
      emit({ type: "agent_settled" });
      await settle();
    };

    await stopRun("q1");
    const afterOne = waits();
    await stopRun("q2");
    await stopRun("q3");

    expect(waits()).toBe(afterOne);
  });

  it("ends a stop once pi exits, when pi confirmed but never answers the clear", async () => {
    const { pi, emit, crash } = manualPi();
    const { controller } = control({ ...pi, clearQueue: () => new Promise(() => undefined) });
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });

    const stopping = controller.stop();
    await settle();
    expect(controller.snapshot().control.stopping).toBe(true);
    crash();

    expect(await stopping).toStrictEqual({ confirmed: true });
    expect(controller.snapshot().control.stopping).toBe(false);
  });

  it("ends a stop once pi exits, when pi neither confirms nor answers the clear", async () => {
    const { pi, emit, crash, holdAbort } = manualPi();
    const { controller, clock } = control({ ...pi, clearQueue: () => new Promise(() => undefined) });
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    holdAbort();

    const stopping = controller.stop();
    await settle();
    clock.advance(2000);
    await settle();
    expect(controller.snapshot().control.stopping).toBe(true);
    crash();

    expect(await stopping).toStrictEqual({ confirmed: false });
    await settle();
    expect(controller.snapshot().control.stopping).toBe(false);
  });

  it("stays stopping while pi takes over two seconds, refusing messages, until pi confirms", async () => {
    const { pi, emit, holdAbort } = manualPi();
    const { controller, clock } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    const confirm = holdAbort();

    const stopping = controller.stop();
    await settle();
    expect(controller.snapshot().control.stopping).toBe(true);
    clock.advance(1999);
    await settle();
    expect(controller.snapshot().control.stopping).toBe(true);
    clock.advance(1);
    expect(await stopping).toStrictEqual({ confirmed: false });
    expect(controller.stop()).toBe(stopping);
    await expect(controller.prompt(prompt("q2", "two"))).rejects.toStrictEqual(new CommandError("session_stopping"));
    await expect(controller.steer(steer("s1", "x"))).rejects.toStrictEqual(new CommandError("session_stopping"));
    expect(() => controller.resumeQueue()).toThrow(new CommandError("session_stopping"));
    confirm();
    await settle();

    expect(controller.snapshot().control.stopping).toBe(false);
  });

  it("ends a stop pi never confirms when pi exits", async () => {
    const { pi, emit, holdAbort, crash } = manualPi();
    const { controller, clock } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    holdAbort();
    const stopping = controller.stop();
    await settle();
    clock.advance(2000);
    await stopping;

    crash();
    await settle();

    expect(controller.snapshot().control.stopping).toBe(false);
  });

  it("confirms a stop with nothing running at once, changing nothing", async () => {
    const { pi, sent } = manualPi();
    const { controller, events } = control(pi);

    expect(await controller.stop()).toStrictEqual({ confirmed: true });

    expect(sent).toStrictEqual([]);
    expect(events).toStrictEqual([]);
  });

  it("sends a message at once after a stop, keeping the queue paused until resumed", async () => {
    const { pi, emit, sent } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    await controller.prompt(prompt("q2", "two"));
    await controller.stop();
    emit({ type: "agent_settled" });
    await settle();

    expect(await controller.prompt(prompt("q3", "three"))).toStrictEqual({ disposition: "started" });
    emit(...runOf("three"));
    await settle();
    expect(sent).toStrictEqual(["prompt one", "clear_queue", "abort", "prompt three"]);
    controller.resumeQueue();

    expect(sent.at(-1)).toBe("prompt two");
    expect(controller.snapshot().control).toMatchObject({ queue: [], paused: null });
  });

  it("aborts a run pi said it started before its start arrives", async () => {
    const { pi, sent } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));

    expect(await controller.stop()).toStrictEqual({ confirmed: true });

    expect(sent).toStrictEqual(["prompt one", "clear_queue", "abort"]);
    expect(controller.snapshot().control).toMatchObject({ paused: "stopped", stopping: false });
  });

  it("stays stopping after an abort pi fails, until pi exits", async () => {
    const manual = manualPi();
    const { controller, clock } = control({ ...manual.pi, abort: () => Promise.reject(new Error("broken pipe")) });
    await controller.prompt(prompt("q1", "one"));
    manual.emit({ type: "agent_start" });

    expect(await controller.stop()).toStrictEqual({ confirmed: false });
    clock.advance(10_000);
    await settle();
    expect(controller.snapshot().control.stopping).toBe(true);
    manual.crash();
    await settle();

    expect(controller.snapshot().control.stopping).toBe(false);
  });
});

/** The notice of an extension's question that ended so. */
function ended(
  id: string,
  title: string,
  outcome: string,
  value: string | null,
  confirmed: boolean | null,
  timestamp: number,
) {
  return { kind: "notice", id, notice: "interaction", title, outcome, value, confirmed, timestamp };
}

describe("createSessionController answering dialogs", () => {
  /** An extension's selection with a timeout. */
  const select = {
    type: "extension_ui_request",
    id: "d1",
    method: "select",
    title: "Pick",
    options: ["a", "b"],
    timeout: 5000,
  };

  it("keeps a dialog until it is answered, passes the answer on, and refuses another", () => {
    const { pi, emit, responses } = manualPi();
    const { controller } = control(pi);

    emit(select);
    expect(controller.snapshot().control.interactions).toStrictEqual([
      {
        id: "d1",
        kind: "select",
        title: "Pick",
        message: null,
        options: ["a", "b"],
        placeholder: null,
        prefill: null,
        deadline: 6000,
      },
    ]);
    expect(() => controller.answerInteraction("d1", { confirmed: true })).toThrow(new CommandError("invalid_message"));
    controller.answerInteraction("d1", { value: "b" });

    expect(responses).toStrictEqual([{ id: "d1", value: "b" }]);
    expect(controller.snapshot().control.interactions).toStrictEqual([]);
    expect(() => controller.answerInteraction("d1", { value: "a" })).toThrow(
      new CommandError("interaction_closed", { interactionId: "d1" }),
    );
  });

  it("takes a confirmation's yes or no, and a cancel for any dialog", () => {
    const { pi, emit, responses } = manualPi();
    const { controller } = control(pi);
    emit(
      { type: "extension_ui_request", id: "c1", method: "confirm", title: "Sure?", message: "It deletes" },
      { type: "extension_ui_request", id: "e1", method: "editor", title: "Edit" },
    );

    expect(() => controller.answerInteraction("c1", { value: "yes" })).toThrow(new CommandError("invalid_message"));
    controller.answerInteraction("c1", { confirmed: false });
    controller.answerInteraction("e1", { cancelled: true });

    expect(responses).toStrictEqual([
      { id: "c1", confirmed: false },
      { id: "e1", cancelled: true },
    ]);
  });

  it("keeps a dialog without a deadline however long it waits", () => {
    const { pi, emit } = manualPi();
    const { controller, clock } = control(pi);
    emit({ type: "extension_ui_request", id: "c1", method: "confirm", title: "Sure?" });

    clock.advance(24 * 60 * 60 * 1000);

    expect(controller.snapshot().control.interactions).toMatchObject([{ id: "c1", deadline: null }]);
  });

  it("takes a dialog away at its deadline", () => {
    const { pi, emit } = manualPi();
    const { controller, clock } = control(pi);
    emit(select);

    clock.advance(4999);
    expect(controller.snapshot().control.interactions).toHaveLength(1);
    clock.advance(1);

    expect(controller.snapshot().control.interactions).toStrictEqual([]);
  });

  it("drops open dialogs when pi exits, and logs an extension's notifications", async () => {
    const { pi, emit, crash } = manualPi();
    const { controller, logged, clock } = control(pi);
    emit(select, {
      type: "extension_ui_request",
      id: "n1",
      method: "notify",
      message: "careful",
      notifyType: "warning",
    });

    crash();
    await settle();
    clock.advance(5000);

    expect(controller.snapshot().control.interactions).toStrictEqual([]);
    expect(logged).toStrictEqual([["warn", "extension notified", { sessionId: "s1", text: "careful", length: 7 }]]);
  });

  it("notes in the transcript how each question ended", async () => {
    const { pi, emit, crash } = manualPi();
    const { controller, events, clock } = control(pi);
    emit(
      select,
      { type: "extension_ui_request", id: "c1", method: "confirm", title: "Sure?" },
      { type: "extension_ui_request", id: "i1", method: "input", title: "Name" },
      { type: "extension_ui_request", id: "e1", method: "editor", title: "Edit" },
    );
    controller.answerInteraction("c1", { confirmed: true });
    controller.answerInteraction("i1", { value: "atrium" });
    controller.answerInteraction("e1", { cancelled: true });
    clock.advance(5000);
    emit({ type: "extension_ui_request", id: "c2", method: "confirm", title: "Again?" });

    crash();
    await settle();

    expect(events.filter((event) => event.type === "notice_added").map((event) => event.notice)).toStrictEqual([
      ended("id1", "Sure?", "answered", null, true, 1000),
      ended("id2", "Name", "answered", "atrium", null, 1000),
      ended("id3", "Edit", "cancelled", null, null, 1000),
      ended("id4", "Pick", "timed_out", null, null, 6000),
      ended("id5", "Again?", "stale", null, null, 6000),
    ]);
    expect(controller.snapshot().items.map((item) => item.id)).toStrictEqual(["id1", "id2", "id3", "id4", "id5"]);
  });

  it("places questions answered during a run after that run's turn in order, also once the transcript is read again", async () => {
    const { pi, emit, pages } = manualPi();
    const { controller } = control(pi);
    const reply: LogEntry = {
      id: "a1",
      parentId: "u1",
      kind: "assistant",
      parts: [],
      stopReason: "stop",
      errorMessage: null,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: null },
      timestamp: 0,
    };
    pages.push(async () => ({ entries: [userEntry("u1", null, "one"), reply], leafId: "a1" }));
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" }, userEnd("one"), select, {
      type: "extension_ui_request",
      id: "c1",
      method: "confirm",
      title: "Sure?",
    });

    controller.answerInteraction("d1", { value: "a" });
    controller.answerInteraction("c1", { confirmed: true });
    expect(controller.snapshot().items.map((item) => item.kind)).toStrictEqual(["turn", "notice", "notice"]);
    emit(replyEnd("stop"), { type: "agent_settled" });
    expect(controller.snapshot().items.map((item) => item.kind)).toStrictEqual(["turn", "notice", "notice"]);
    await settle();

    expect(controller.snapshot().items).toMatchObject([
      { kind: "turn", user: { text: "one" } },
      { kind: "notice", notice: "interaction", title: "Pick", value: "a" },
      { kind: "notice", notice: "interaction", title: "Sure?", confirmed: true },
    ]);
  });

  it("logs at most 4 KB of an extension's notification, with its full length", () => {
    const { pi, emit } = manualPi();
    const { logged } = control(pi);

    emit({ type: "extension_ui_request", id: "n1", method: "notify", message: "x".repeat(5000) });

    expect(logged).toStrictEqual([
      ["info", "extension notified", { sessionId: "s1", text: "x".repeat(4096), length: 5000 }],
    ]);
  });
});

/**
 * A controller whose pi is started again with pis the test drives, in order.
 *
 * @remarks
 * A start fails once the given pis are used up.
 *
 * @sideEffects none
 * @param count - How many replacement pis to have.
 * @returns The first pi, the replacements, how often pi was started again and the controller.
 */
function crashing(count: number) {
  const first = manualPi();
  const next = Array.from({ length: count }, () => manualPi());
  let starts = 0;
  const respawn = async () => {
    const pi = next[starts];
    starts += 1;
    if (pi === undefined) throw new Error("pi did not start");
    return { pi: pi.pi, entries: empty };
  };
  return { first, next, starts: () => starts, ...control(first.pi, empty, { respawn }) };
}

describe("createSessionController after pi crashes", () => {
  it("starts pi again, notes it, and sends again the message pi had not taken", async () => {
    const { first, next, controller, events } = crashing(1);
    await controller.prompt(prompt("q1", "one"));
    first.emit({ type: "agent_start" });

    first.crash();
    await settle();

    const second = present(next[0], "the second pi");
    expect(second.sent).toStrictEqual(["prompt one"]);
    expect(events.map((event) => event.type)).toStrictEqual([
      "run_started",
      "run_settled",
      // Restarting, then back.
      "control_updated",
      "session_exited",
      "session_snapshot",
      "notice_added",
      "control_updated",
    ]);
    expect(events.at(-2)).toMatchObject({ epoch: 2, notice: { notice: "restarted", attempt: 1 } });
    expect(controller.exited).toBe(false);
    second.emit({ type: "agent_start" }, userEnd("one"));
    expect(clientMessageIds(events)).toStrictEqual(["q1"]);
  });

  it("asks the agent to go on, as the host, when pi had taken the message, and remembers it sent that", async () => {
    const recorded: string[][] = [];
    const first = manualPi();
    const second = manualPi();
    const { controller, events } = control(first.pi, empty, {
      respawn: async () => ({ pi: second.pi, entries: { entries: [userEntry("u1", null, "one")], leafId: "u1" } }),
      turnStarts: { opened: new Set(), record: (ids, auto) => recorded.push([...ids, ...auto]) },
    });
    await controller.prompt(prompt("q1", "one"));
    first.emit({ type: "agent_start" }, userEnd("one"));

    first.crash();
    await settle();
    second.emit({ type: "agent_start" }, userEnd(CONTINUE_TEXT));

    expect(second.sent).toStrictEqual([`prompt ${CONTINUE_TEXT}`]);
    const started = events.filter((event) => event.type === "turn_started");
    expect(started.map((event) => [event.turn.user.text, event.turn.user.auto])).toStrictEqual([
      ["one", false],
      [CONTINUE_TEXT, true],
    ]);
    second.pages.push(async () => ({ entries: [userEntry("u2", "u1", CONTINUE_TEXT)], leafId: "u2" }));
    second.emit(replyEnd("stop"), { type: "agent_settled" });
    await settle();
    // The restart's read remembers the turn the user's message opened; the next one the turn the
    // host's message opened, and that the host sent it.
    expect(recorded).toStrictEqual([["u1"], ["u2", "u2"]]);
  });

  it("sends steers pi had not delivered back to the queue, paused until pi is back", async () => {
    const { first, next, controller } = crashing(1);
    await controller.prompt(prompt("q1", "one"));
    first.emit({ type: "agent_start" }, userEnd("one"));
    await controller.steer(steer("s1", "also"));

    first.crash();
    await settle();

    const second = present(next[0], "the second pi");
    expect(second.sent).toStrictEqual([`prompt ${CONTINUE_TEXT}`]);
    expect(controller.snapshot().control).toMatchObject({ queue: [{ text: "also" }], paused: null, steers: [] });
  });

  it("gives up after three restarts in a row, failing the session until a run starts", async () => {
    const { first, next, controller, starts } = crashing(2);
    for (const pi of [first, ...next]) {
      pi.crash();
      await settle();
    }

    expect(starts()).toBe(3);
    expect(controller.exited).toBe(true);
    expect(controller.snapshot().control.failure).toStrictEqual({ reason: "crashed", attempts: 3 });
    await expect(controller.prompt(prompt("q1", "x"))).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "exited" }),
    );
  });

  it("counts restarts again from zero once a run completes", async () => {
    const { first, next, controller, starts } = crashing(4);
    first.crash();
    await settle();
    const [second, third, fourth] = next;
    present(second, "the second pi").crash();
    await settle();
    present(third, "the third pi").emit(...runOf("x"));
    await settle();
    present(third, "the third pi").crash();
    await settle();
    present(fourth, "the fourth pi").crash();
    await settle();

    expect(starts()).toBe(4);
    expect(controller.snapshot().control.failure).toBeNull();
  });

  it("does not start pi again after a stop the host asked for", async () => {
    const { controller, starts } = crashing(1);

    await controller.shutdown();
    await settle();

    expect(starts()).toBe(0);
  });

  it("sends again a message pi answered but had not started on when it crashed", async () => {
    const { first, next, controller } = crashing(1);
    await controller.prompt(prompt("q1", "one"));

    first.crash();
    await settle();

    expect(present(next[0], "the second pi").sent).toStrictEqual(["prompt one"]);
  });

  it.each([
    ["handled", async () => ({ disposition: "handled" as const })],
    ["refused", () => Promise.reject(new ReplayRequestError("prompt", "rejected", "No model"))],
  ])("sends nothing again after a crash for a message pi %s", async (_how, answer) => {
    const { first, next, controller } = crashing(1);
    first.answers.push(answer);
    await controller.prompt(prompt("q1", "/noop")).catch(() => undefined);

    first.crash();
    await settle();

    expect(present(next[0], "the second pi").sent).toStrictEqual([]);
  });

  it("sends nothing again after a crash for a message pi handled, then one it refused", async () => {
    const { first, next, controller } = crashing(1);
    first.answers.push(
      async () => ({ disposition: "handled" }),
      () => Promise.reject(new ReplayRequestError("prompt", "rejected", "No model")),
    );
    await controller.prompt(prompt("q1", "/noop"));
    await expect(controller.prompt(prompt("q2", "two"))).rejects.toStrictEqual(
      new CommandError("pi_rejected", { detail: "No model" }),
    );

    first.crash();
    await settle();

    expect(present(next[0], "the second pi").sent).toStrictEqual([]);
  });

  it("keeps the message a restart sent again when the gone pi refuses its first copy afterwards", async () => {
    const { first, next, controller } = crashing(2);
    const [second, third] = next as [ReturnType<typeof manualPi>, ReturnType<typeof manualPi>];
    const answer = Promise.withResolvers<{ disposition: "started" }>();
    first.answers.push(() => answer.promise);
    const sending = controller.prompt(prompt("q1", "one"));
    first.crash();
    await settle();
    expect(second.sent).toStrictEqual(["prompt one"]);

    answer.reject(new ReplayRequestError("prompt", "rejected", "No model"));
    await expect(sending).rejects.toStrictEqual(new CommandError("pi_rejected", { detail: "No model" }));
    second.crash();
    await settle();

    expect(third.sent).toStrictEqual(["prompt one"]);
  });

  it("keeps the interrupted message when pi goes away again as it is sent after a restart", async () => {
    const { first, next, controller, logged } = crashing(2);
    const [second, third] = next as [ReturnType<typeof manualPi>, ReturnType<typeof manualPi>];
    second.answers.push(() => Promise.reject(new ReplayRequestError("prompt", "exited")));
    await controller.prompt(prompt("q1", "one"));
    first.emit({ type: "agent_start" });
    first.crash();
    await settle();

    second.crash();
    await settle();

    expect(second.sent).toStrictEqual(["prompt one"]);
    expect(third.sent).toStrictEqual(["prompt one"]);
    expect(logged).toStrictEqual([
      ["warn", "resending after a restart failed", { sessionId: "s1", code: "pi_unavailable" }],
    ]);
  });

  it("sends nothing after a crash that follows a stop, the message pi had not taken waiting in the paused queue", async () => {
    const { first, next, controller } = crashing(1);
    await controller.prompt(prompt("q1", "one"));
    first.emit({ type: "agent_start" });
    await controller.stop();

    first.crash();
    await settle();

    expect(present(next[0], "the second pi").sent).toStrictEqual([]);
    expect(controller.snapshot().control).toMatchObject({ queue: [{ text: "one" }], paused: "stopped" });
  });

  it("queues messages while pi starts again, and a stop meanwhile keeps them and the interrupted one paused", async () => {
    const first = manualPi();
    const second = manualPi();
    const gate = Promise.withResolvers<void>();
    const { controller, events } = control(first.pi, empty, {
      respawn: async () => {
        await gate.promise;
        return { pi: second.pi, entries: empty };
      },
    });
    await controller.prompt(prompt("q1", "one"));
    first.emit({ type: "agent_start" });
    first.crash();
    await settle();
    expect(controller.restarting).toBe(true);

    expect(await controller.prompt(prompt("q2", "two"))).toMatchObject({ disposition: "queued" });
    expect(await controller.stop()).toStrictEqual({ confirmed: true });
    expect(events.at(-1)).toMatchObject({ type: "control_updated", control: { paused: "stopped", restarting: true } });
    gate.resolve();
    await settle();

    expect(second.sent).toStrictEqual([]);
    expect(controller.snapshot().control).toMatchObject({
      queue: [{ text: "one" }, { text: "two" }],
      paused: "stopped",
      restarting: false,
    });
  });

  it("takes the pi another start hands the session instead of starting one", async () => {
    const first = manualPi();
    const second = manualPi();
    const { controller, events } = control(first.pi, empty, {
      respawn: async () => {
        controller.attach({ pi: second.pi, entries: empty });
        return null;
      },
    });
    await controller.prompt(prompt("q1", "one"));
    first.emit({ type: "agent_start" });

    first.crash();
    await settle();

    expect(second.sent).toStrictEqual(["prompt one"]);
    expect(events.filter((event) => event.type === "notice_added")).toMatchObject([
      { notice: { notice: "restarted", attempt: 1 } },
    ]);
  });

  it("counts restarts again from zero once a run is stopped", async () => {
    const { first, next, controller, starts } = crashing(4);
    first.crash();
    await settle();
    const [second, third, fourth] = next;
    present(second, "the second pi").crash();
    await settle();
    present(third, "the third pi").emit({ type: "agent_start" }, userEnd("x"), replyEnd("aborted"), {
      type: "agent_settled",
    });
    await settle();
    present(third, "the third pi").crash();
    await settle();
    present(fourth, "the fourth pi").crash();
    await settle();

    expect(starts()).toBe(4);
    expect(controller.snapshot().control.failure).toBeNull();
  });
});

/** A start of pi that fails. */
const failing = () => Promise.reject(new Error("pi did not start"));

describe("createSessionController retrying", () => {
  it("asks the agent to go on after a failed turn", async () => {
    const { pi, emit, sent, pages, withImages } = manualPi();
    const { controller } = control(pi);
    const failed: LogEntry = {
      id: "a1",
      parentId: "u1",
      kind: "assistant",
      parts: [],
      stopReason: "error",
      errorMessage: "overloaded",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null },
      timestamp: 0,
    };
    pages.push(async () => ({ entries: [userEntry("u1", null, "one"), failed], leafId: "a1" }));
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" }, userEnd("one"), replyEnd("error"), { type: "agent_settled" });
    await settle();

    expect(await controller.retryRun()).toStrictEqual({});

    expect(sent).toStrictEqual(["prompt one", `prompt ${CONTINUE_TEXT}`]);
    expect(withImages.at(-1)).toStrictEqual([CONTINUE_TEXT, []]);
  });

  it("starts pi again after the restarts were used up and sends the message it lost", async () => {
    const first = manualPi();
    const spare = manualPi();
    const starts = [failing, failing, failing, async () => ({ pi: spare.pi, entries: empty })];
    const { controller } = control(first.pi, empty, {
      respawn: () => present(starts.shift(), "a planned start")(),
    });
    await controller.prompt(prompt("q1", "one"));
    first.emit({ type: "agent_start" });
    first.crash();
    await settle();
    expect(controller.snapshot().control.failure).toMatchObject({ attempts: 3 });

    await controller.retryRun();

    expect(spare.sent).toStrictEqual(["prompt one"]);
    expect(controller.snapshot().control.failure).toBeNull();
  });

  it("asks the agent to go on after the restarts were used up when pi had taken the message", async () => {
    const first = manualPi();
    const spare = manualPi();
    const starts = [failing, failing, failing, async () => ({ pi: spare.pi, entries: empty })];
    const { controller } = control(first.pi, empty, {
      respawn: () => present(starts.shift(), "a planned start")(),
    });
    await controller.prompt(prompt("q1", "one"));
    first.emit({ type: "agent_start" }, userEnd("one"));
    first.crash();
    await settle();

    await controller.retryRun();

    expect(spare.sent).toStrictEqual([`prompt ${CONTINUE_TEXT}`]);
  });

  it("keeps the failure when pi does not start for a retry", async () => {
    const first = manualPi();
    const { controller, logged } = control(first.pi, empty, { respawn: failing });
    first.crash();
    await settle();

    await expect(controller.retryRun()).rejects.toStrictEqual(new Error("pi did not start"));
    expect(logged).toStrictEqual(
      [1, 2, 3].map((attempt) => [
        "warn",
        "pi restart failed",
        { sessionId: "s1", attempt, error: "Error: pi did not start" },
      ]),
    );

    expect(controller.snapshot().control).toMatchObject({
      failure: { reason: "crashed", attempts: 3 },
      restarting: false,
    });
  });

  it("counts a retry's start as a restart: messages queue, another retry does nothing, and a shutdown stops the new pi", async () => {
    const first = manualPi();
    const spare = manualPi();
    const gate = Promise.withResolvers<void>();
    const starts = [
      failing,
      failing,
      failing,
      async () => {
        await gate.promise;
        return { pi: spare.pi, entries: empty };
      },
    ];
    const { controller } = control(first.pi, empty, {
      respawn: () => present(starts.shift(), "a planned start")(),
    });
    first.crash();
    await settle();

    const retrying = controller.retryRun();
    expect(controller.snapshot().control.restarting).toBe(true);
    expect(await controller.retryRun()).toStrictEqual({});
    expect(await controller.prompt(prompt("q1", "one"))).toMatchObject({ disposition: "queued" });
    const closing = controller.shutdown();
    gate.resolve();

    expect(await retrying).toStrictEqual({});
    await closing;
    expect(await spare.pi.exited).toStrictEqual({ code: 0, signal: null, requested: true });
    expect(spare.sent).toStrictEqual([]);
    expect(controller.exited).toBe(true);
  });

  it("does nothing while a run goes on, and needs a way to start pi once it has exited", async () => {
    const { pi, emit, sent, crash } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });

    await controller.retryRun();
    expect(sent).toStrictEqual(["prompt one"]);
    crash();
    await settle();

    await expect(controller.retryRun()).rejects.toStrictEqual(new CommandError("pi_unavailable", { status: "exited" }));
  });
});

describe("createSessionController's Fast", () => {
  it("carries the session's Fast, off when left out", () => {
    expect(control(manualPi().pi, empty, { fast: true }).controller.snapshot().fast).toBe(true);
    expect(control(manualPi().pi).controller.snapshot().fast).toBe(false);
  });

  it("switches Fast in pi, publishes it and reports the choice; the same again publishes nothing", async () => {
    const { pi, sent } = manualPi();
    const chosen: boolean[] = [];
    const { controller, events } = control(pi, empty, { onFastChosen: (enabled) => chosen.push(enabled) });

    expect(await controller.setFast(true)).toStrictEqual({});
    expect(await controller.setFast(true)).toStrictEqual({});
    expect(await controller.setFast(false)).toStrictEqual({});

    expect(sent).toStrictEqual(["fast on", "fast on", "fast off"]);
    expect(events).toStrictEqual([
      { type: "fast_updated", ...at(1, null), fast: true },
      { type: "fast_updated", ...at(2, null), fast: false },
    ]);
    expect(chosen).toStrictEqual([true, true, false]);
    expect(controller.snapshot().fast).toBe(false);
  });

  it("switches Fast with no one to tell of the choice", async () => {
    const { controller } = control(manualPi().pi);

    await controller.setFast(true);

    expect(controller.snapshot().fast).toBe(true);
  });

  it("passes on a pi without Fast, and pi going away, changing nothing", async () => {
    const { pi, settingFailures } = manualPi();
    const chosen: boolean[] = [];
    const { controller, events } = control(pi, empty, { onFastChosen: (enabled) => chosen.push(enabled) });
    settingFailures.push(new CommandError("fast_unavailable"), new ReplayRequestError("prompt", "exited"));

    await expect(controller.setFast(true)).rejects.toStrictEqual(new CommandError("fast_unavailable"));
    await expect(controller.setFast(true)).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "exited" }),
    );
    expect(events).toStrictEqual([]);
    expect(chosen).toStrictEqual([]);
    expect(controller.snapshot().fast).toBe(false);
  });

  it("refuses while a stop waits for pi, and once pi has exited", async () => {
    const { pi, emit, crash, holdAbort, sent } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    holdAbort();
    // Fire and forget: the stop stays pending while abort is held.
    void controller.stop();

    await expect(controller.setFast(true)).rejects.toStrictEqual(new CommandError("session_stopping"));
    crash();
    await settle();
    await expect(controller.setFast(true)).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "exited" }),
    );
    expect(sent.filter((command) => command.startsWith("fast"))).toStrictEqual([]);
  });

  it("keeps the session's Fast for the pi started after a crash", async () => {
    const first = manualPi();
    const second = manualPi();
    const { controller, events } = control(first.pi, empty, { fast: true });
    first.crash();
    await settle();

    controller.attach({ pi: second.pi, entries: empty });

    expect(events.at(-1)).toMatchObject({ type: "session_snapshot", epoch: 2, fast: true });
  });
});

/** A model pi may report. */
const opus: SessionModel = { providerId: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high" };

/** pi's default prompt as its system message states it: an opening of 40 characters, tools, rules and docs. */
const defaultPrompt: LogEntry = {
  id: "s1",
  parentId: null,
  kind: "system",
  timestamp: 0,
  system: {
    textChars: 0,
    sections: { preamble: 40, tools: 8, rules: 12, docs: 20 },
    pieces: {},
    toolsAdded: {},
    toolsRemoved: [],
  },
};

/** The control of each `control_updated` among the events. */
function compactingUpdates(events: readonly SessionEvent[]) {
  return events.flatMap((event) => (event.type === "control_updated" ? [event.control] : []));
}

describe("createSessionController compacting on request", () => {
  it("compacts an idle session, the queue waiting until pi answers", async () => {
    const { pi, emit, sent, compactAnswers } = manualPi();
    const { controller, events } = control(pi);
    const answer = Promise.withResolvers<void>();
    compactAnswers.push(() => answer.promise);

    const compacted = controller.compact("keep the API");
    expect(controller.snapshot().control.compacting).toBe(true);
    expect(await controller.prompt(prompt("q1", "one"))).toMatchObject({ disposition: "queued" });
    answer.resolve();

    expect(await compacted).toStrictEqual({});
    emit({ type: "agent_start" }, { type: "agent_settled" });
    expect(await controller.compact(undefined)).toStrictEqual({});
    expect(sent).toStrictEqual(["compact keep the API", "prompt one", "compact"]);
    expect(compactingUpdates(events).map(({ compacting, queue }) => [compacting, queue.length])).toStrictEqual([
      [true, 0],
      [true, 1],
      [false, 1],
      [false, 0],
      [true, 0],
      [false, 0],
    ]);
  });

  it("shows pi compacting on its own", () => {
    const { pi, emit } = manualPi();
    const { controller, events } = control(pi);

    emit({ type: "compaction_start", reason: "threshold" });
    expect(controller.snapshot().control.compacting).toBe(true);
    emit({ type: "compaction_end" });

    expect(controller.snapshot().control.compacting).toBe(false);
    expect(events).toHaveLength(2);
    expect(compactingUpdates(events).map(({ compacting }) => compacting)).toStrictEqual([true, false]);
  });

  it("refuses during a run, while pi compacts, while a stop waits for pi, and once pi has exited", async () => {
    const { pi, emit, crash, holdAbort, sent } = manualPi();
    const { controller } = control(pi);
    emit({ type: "compaction_start", reason: "threshold" });
    await expect(controller.compact(undefined)).rejects.toStrictEqual(new CommandError("session_busy"));
    emit({ type: "compaction_end" });
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    await expect(controller.compact(undefined)).rejects.toStrictEqual(new CommandError("session_busy"));
    holdAbort();
    // Fire and forget: the stop stays pending while abort is held.
    void controller.stop();
    emit({ type: "agent_settled" });

    await expect(controller.compact(undefined)).rejects.toStrictEqual(new CommandError("session_busy"));
    crash();
    await settle();
    await expect(controller.compact(undefined)).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "exited" }),
    );
    expect(sent.filter((command) => command.startsWith("compact"))).toStrictEqual([]);
  });

  it("answers pi having nothing to compact, and fails otherwise without pi's words, logging only why", async () => {
    const { pi, compactAnswers } = manualPi();
    const { controller, logged } = control(pi);
    const bug = new Error("not pi's");
    compactAnswers.push(
      () => Promise.reject(new ReplayRequestError("compact", "rejected", "Nothing to compact (session too small)")),
      () => Promise.reject(new ReplayRequestError("compact", "rejected", "Already compacted")),
      () => Promise.reject(new ReplayRequestError("compact", "rejected", "Compaction cancelled")),
      () => Promise.reject(new ReplayRequestError("compact", "exited")),
      () => Promise.reject(bug),
    );

    await expect(controller.compact(undefined)).rejects.toStrictEqual(new CommandError("nothing_to_compact"));
    await expect(controller.compact(undefined)).rejects.toStrictEqual(new CommandError("already_compacted"));
    await expect(controller.compact(undefined)).rejects.toStrictEqual(new CommandError("compact_failed"));
    await expect(controller.compact(undefined)).rejects.toStrictEqual(new CommandError("compact_failed"));
    await expect(controller.compact(undefined)).rejects.toBe(bug);

    expect(controller.snapshot().control.compacting).toBe(false);
    expect(logged).toStrictEqual([
      ["warn", "compaction failed", { sessionId: "s1", reason: "rejected" }],
      ["warn", "compaction failed", { sessionId: "s1", reason: "exited" }],
    ]);
  });
});

describe("createSessionController exporting", () => {
  it("has pi write the page where asked, during a run too", async () => {
    const { pi, emit, sent } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });

    await controller.exportHtml("/tmp/x/session.html");

    expect(sent).toStrictEqual(["prompt one", "export_html /tmp/x/session.html"]);
  });

  it("fails without pi's words, logging only why, and passes on what is not pi's", async () => {
    const { pi, exportFailures } = manualPi();
    const { controller, logged } = control(pi);
    const bug = new Error("not pi's");
    exportFailures.push(new ReplayRequestError("export_html", "rejected", "EACCES /secret/path"), bug);

    await expect(controller.exportHtml("/tmp/x/session.html")).rejects.toStrictEqual(
      new CommandError("export_failed", { reason: "failed" }),
    );
    await expect(controller.exportHtml("/tmp/x/session.html")).rejects.toBe(bug);
    expect(logged).toStrictEqual([["warn", "export failed", { sessionId: "s1", reason: "rejected" }]]);
  });

  it("refuses once pi has exited", async () => {
    const { pi, crash, sent } = manualPi();
    const { controller } = control(pi);
    crash();
    await settle();

    await expect(controller.exportHtml("/tmp/x/session.html")).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "exited" }),
    );
    expect(sent.filter((command) => command.startsWith("export_html"))).toStrictEqual([]);
  });
});

/** Three turns read from pi, each a user message alone. */
const THREE_TURNS: EntriesPage = {
  entries: [userEntry("u1", null, "one"), userEntry("u2", "u1", "two"), userEntry("u3", "u2", "three")],
  leafId: "u3",
};

describe("createSessionController's fork point", () => {
  it("is the user message opening the next turn, none after the last turn, and refuses a turn it does not know", () => {
    const { pi } = manualPi();
    const { controller } = control(pi, THREE_TURNS);

    expect(["s1:u1", "s1:u2", "s1:u3"].map((turnId) => controller.forkPoint(turnId))).toStrictEqual(["u2", "u3", null]);
    expect(() => controller.forkPoint("s1:u9")).toThrow(new CommandError("turn_not_found"));
  });

  it("passes over what is not a turn, such as a compaction, to the next turn", () => {
    const compacted: LogEntry = {
      id: "c1",
      parentId: "u1",
      kind: "compaction",
      summary: "s",
      tokensBefore: 10,
      system: null,
      timestamp: 0,
    };
    const { controller } = control(manualPi().pi, {
      entries: [userEntry("u1", null, "one"), compacted, userEntry("u2", "c1", "two")],
      leafId: "u2",
    });

    expect(controller.snapshot().items.map((item) => item.kind)).toStrictEqual(["turn", "notice", "turn"]);
    expect(controller.forkPoint("s1:u1")).toBe("u2");
  });

  it("refuses a next turn not tied to its entry yet", async () => {
    const { pi, emit, pages } = manualPi();
    const { controller } = control(pi, { entries: [userEntry("u1", null, "one")], leafId: "u1" });
    pages.push(() => new Promise(() => undefined));
    await controller.prompt(prompt("q1", "two"));
    emit({ type: "agent_start" }, userEnd("two"), replyEnd("stop"), { type: "agent_settled" });

    expect(() => controller.forkPoint("s1:u1")).toThrow(new CommandError("turn_not_found"));
  });

  it("refuses while a message is on its way, a run is about to start or goes on, a stop waits for pi or pi compacts", async () => {
    const { pi, emit, holdAbort } = manualPi();
    const { controller } = control(pi, THREE_TURNS);
    const busy = () => controller.forkPoint("s1:u3");
    emit({ type: "compaction_start", reason: "threshold" });
    expect(busy).toThrow(new CommandError("session_busy"));
    emit({ type: "compaction_end" });
    const sending = controller.prompt(prompt("q1", "four"));
    expect(busy).toThrow(new CommandError("session_busy"));
    await sending;
    expect(busy).toThrow(new CommandError("session_busy"));
    emit({ type: "agent_start" });
    expect(busy).toThrow(new CommandError("session_busy"));
    holdAbort();
    // Fire and forget: the stop stays pending while abort is held.
    void controller.stop();
    emit({ type: "agent_settled" });

    expect(busy).toThrow(new CommandError("session_busy"));
  });

  it("holds the session busy for a fork until released: messages queue, compacting and forking again are refused", async () => {
    const { pi, sent } = manualPi();
    const { controller } = control(pi, THREE_TURNS);

    const release = controller.holdForFork();
    const held = [
      controller.forking,
      await controller.prompt(prompt("q1", "four")),
      await controller.compact(undefined).catch((error: unknown) => error),
    ];
    expect(() => controller.forkPoint("s1:u3")).toThrow(new CommandError("session_busy"));
    const before = [...sent];
    release();

    expect(held).toMatchObject([true, { disposition: "queued" }, new CommandError("session_busy")]);
    expect([before, sent, controller.forking]).toStrictEqual([[], ["prompt four"], false]);
  });

  it("refuses while pi restarts, but not once pi has exited", async () => {
    const restarting = manualPi();
    const { controller } = control(restarting.pi, THREE_TURNS, { respawn: () => new Promise(() => undefined) });
    const exited = manualPi();
    const after = control(exited.pi, THREE_TURNS).controller;
    restarting.crash();
    exited.crash();
    await settle();

    expect(() => controller.forkPoint("s1:u3")).toThrow(new CommandError("session_busy"));
    expect(after.exited).toBe(true);
    expect(after.forkPoint("s1:u3")).toBeNull();
  });
});

describe("createSessionController's model", () => {
  it("carries the model pi started with, or none", () => {
    expect(control(manualPi().pi, empty, { model: opus }).controller.snapshot().model).toStrictEqual(opus);
    expect(control(manualPi().pi).controller.snapshot().model).toBeNull();
  });

  it("switches the model, reads back what pi uses, publishes it, reports the choice and reads pi's entries", async () => {
    const { pi, sent, states, since } = manualPi();
    const chosen: SessionModel[] = [];
    const { controller, events } = control(pi, empty, { model: opus, onModelChosen: (model) => chosen.push(model) });
    const haiku: SessionModel = { providerId: "anthropic", modelId: "haiku", thinkingLevel: "off" };
    states.push(haiku);

    expect(await controller.setModel({ providerId: "anthropic", modelId: "haiku" })).toStrictEqual({});
    await settle();

    expect(sent).toStrictEqual(["set_model anthropic/haiku", "get_state"]);
    expect(events).toStrictEqual([{ type: "model_updated", ...at(1, null), model: haiku }]);
    expect(controller.snapshot().model).toStrictEqual(haiku);
    expect(chosen).toStrictEqual([haiku]);
    expect(since).toStrictEqual([undefined]);
  });

  it("sets the thinking level the same way", async () => {
    const { pi, sent, states } = manualPi();
    const chosen: SessionModel[] = [];
    const { controller, events } = control(pi, empty, { model: opus, onModelChosen: (model) => chosen.push(model) });
    states.push({ ...opus, thinkingLevel: "low" });

    expect(await controller.setThinkingLevel("low")).toStrictEqual({});

    expect(sent).toStrictEqual(["set_thinking_level low", "get_state"]);
    expect(events).toStrictEqual([{ type: "model_updated", ...at(1, null), model: { ...opus, thinkingLevel: "low" } }]);
    expect(chosen).toStrictEqual([{ ...opus, thinkingLevel: "low" }]);
  });

  it("publishes nothing when pi's model stays the same, yet still reports the choice", async () => {
    const { pi, states } = manualPi();
    const chosen: SessionModel[] = [];
    const { controller, events } = control(pi, empty, { model: opus, onModelChosen: (model) => chosen.push(model) });
    states.push(opus);

    await controller.setModel({ providerId: "anthropic", modelId: "claude-opus-5-5" });

    expect(events).toStrictEqual([]);
    expect(chosen).toStrictEqual([opus]);
  });

  it("switches the model with no one to tell of the choice", async () => {
    const { pi, states } = manualPi();
    const { controller } = control(pi, empty, { model: opus });
    states.push({ ...opus, modelId: "haiku" });

    expect(await controller.setModel({ providerId: "anthropic", modelId: "haiku" })).toStrictEqual({});
    expect(controller.snapshot().model).toStrictEqual({ ...opus, modelId: "haiku" });
  });

  it("passes pi's refusal on, changing nothing", async () => {
    const { pi, sent, settingFailures } = manualPi();
    const chosen: SessionModel[] = [];
    const { controller, events } = control(pi, empty, { model: opus, onModelChosen: (model) => chosen.push(model) });
    settingFailures.push(new ReplayRequestError("set_model", "rejected", "Model not found: x/y"));

    await expect(controller.setModel({ providerId: "x", modelId: "y" })).rejects.toStrictEqual(
      new CommandError("pi_rejected", { detail: "Model not found: x/y" }),
    );
    expect(sent).toStrictEqual(["set_model x/y"]);
    expect(events).toStrictEqual([]);
    expect(chosen).toStrictEqual([]);
    expect(controller.snapshot().model).toStrictEqual(opus);
  });

  it("answers a switch pi took though the model could not be read back, reading it after the entries", async () => {
    const { pi, sent, states, stateFailures } = manualPi();
    const chosen: SessionModel[] = [];
    const { controller, events } = control(pi, empty, { model: opus, onModelChosen: (model) => chosen.push(model) });
    stateFailures.push(new ReplayRequestError("get_state", "exited"));
    states.push({ ...opus, modelId: "haiku" });

    expect(await controller.setModel({ providerId: "anthropic", modelId: "haiku" })).toStrictEqual({});
    await settle();

    expect(sent).toStrictEqual(["set_model anthropic/haiku", "get_state", "get_state"]);
    expect(controller.snapshot().model).toStrictEqual({ ...opus, modelId: "haiku" });
    expect(events.filter((event) => event.type === "model_updated")).toMatchObject([
      { model: { ...opus, modelId: "haiku" } },
    ]);
    expect(chosen).toStrictEqual([{ ...opus, modelId: "haiku" }]);
  });

  it("switches the model with nobody listening for choices, reading it back once", async () => {
    const { pi, sent, states } = manualPi();
    const { controller, failures } = control(pi, empty, { model: opus });
    states.push({ ...opus, modelId: "haiku" });

    await controller.setModel({ providerId: "anthropic", modelId: "haiku" });
    await settle();

    expect(sent.filter((command) => command === "get_state")).toHaveLength(1);
    expect(failures).toStrictEqual([]);
  });

  it("reports no choice when pi has no model to report", async () => {
    const { pi } = manualPi();
    const chosen: SessionModel[] = [];
    const { controller } = control(pi, empty, { model: opus, onModelChosen: (model) => chosen.push(model) });

    await controller.setThinkingLevel("low");

    expect(controller.snapshot().model).toBeNull();
    expect(chosen).toStrictEqual([]);
  });

  it("refuses while a stop waits for pi, and once pi has exited", async () => {
    const { pi, emit, crash, holdAbort } = manualPi();
    const { controller } = control(pi, empty, { model: opus });
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    holdAbort();
    // Fire and forget: the stop stays pending while abort is held.
    void controller.stop();

    await expect(controller.setModel({ providerId: "a", modelId: "b" })).rejects.toStrictEqual(
      new CommandError("session_stopping"),
    );
    await expect(controller.setThinkingLevel("low")).rejects.toStrictEqual(new CommandError("session_stopping"));
    crash();
    await settle();
    await expect(controller.setModel({ providerId: "a", modelId: "b" })).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "exited" }),
    );
    await expect(controller.setThinkingLevel("low")).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "exited" }),
    );
  });

  it("follows pi changing the thinking level by itself", () => {
    const { pi, emit } = manualPi();
    const { controller, events } = control(pi, empty, { model: opus });

    emit({ type: "thinking_level_changed", level: "high" }, { type: "thinking_level_changed", level: "minimal" });

    expect(events).toStrictEqual([
      { type: "model_updated", ...at(1, null), model: { ...opus, thinkingLevel: "minimal" } },
    ]);
    expect(controller.snapshot().model).toStrictEqual({ ...opus, thinkingLevel: "minimal" });
  });

  it("ignores a thinking level change while it knows no model", () => {
    const { pi, emit } = manualPi();
    const { controller, events } = control(pi);

    emit({ type: "thinking_level_changed", level: "high" });

    expect(events).toStrictEqual([]);
    expect(controller.snapshot().model).toBeNull();
  });

  it("takes the model of the pi started after a crash", async () => {
    const first = manualPi();
    const second = manualPi();
    const haiku: SessionModel = { providerId: "anthropic", modelId: "haiku", thinkingLevel: "off" };
    const { controller, events } = control(first.pi, empty, {
      model: opus,
      respawn: async () => ({ pi: second.pi, entries: empty, model: haiku }),
    });

    first.crash();
    await settle();

    expect(events.find((event) => event.type === "session_snapshot")).toMatchObject({ epoch: 2, model: haiku });
    expect(controller.snapshot().model).toStrictEqual(haiku);
  });
});

describe("createSessionController's commands", () => {
  it("lists pi's slash commands", async () => {
    const { pi, sent } = manualPi();
    const { controller } = control(pi);

    expect(await controller.listCommands()).toStrictEqual({
      commands: [{ name: "review", description: null, source: "prompt" }],
    });
    expect(sent).toStrictEqual(["get_commands"]);
  });

  it("passes pi going away on as pi_unavailable, and refuses once it has exited", async () => {
    const { pi, commandFailures, crash } = manualPi();
    const { controller } = control(pi);
    commandFailures.push(new ReplayRequestError("get_commands", "exited", ""));

    await expect(controller.listCommands()).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "exited" }),
    );
    crash();
    await settle();
    await expect(controller.listCommands()).rejects.toStrictEqual(
      new CommandError("pi_unavailable", { status: "exited" }),
    );
  });
});

/** An image as pi takes it, named by its data. */
function image(data: string) {
  return { data, mimeType: "image/webp" };
}

describe("createSessionController's images", () => {
  it("sends a message's images with it, and lists how many a queued one has", async () => {
    const { pi, emit, withImages } = manualPi();
    const { controller } = control(pi);

    await controller.prompt(prompt("q1", "看图"), [image("a")]);
    emit({ type: "agent_start" });
    await controller.prompt(prompt("q2", ""), [image("b"), image("c")]);

    expect(withImages).toStrictEqual([["看图", ["a"]]]);
    expect(controller.snapshot().control.queue).toStrictEqual([{ id: "id2", text: "", createdAt: 1000, images: 2 }]);
    emit({ type: "agent_settled" });
    await settle();
    expect(withImages).toStrictEqual([
      ["看图", ["a"]],
      ["", ["b", "c"]],
    ]);
  });

  it("steers with images, and keeps them with a steer pi gives back on stop", async () => {
    const { pi, emit, hold, withImages } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "一"));
    emit({ type: "agent_start" });
    await controller.steer(steer("s1", "这张"), [image("x")]);
    emit({ type: "queue_update", steering: ["这张"], followUp: [] });
    hold(["这张"]);

    await controller.stop();

    expect(withImages.at(-1)).toStrictEqual(["这张", ["x"]]);
    expect(controller.snapshot().control.queue).toMatchObject([{ text: "这张", images: 1 }]);
    controller.resumeQueue();
    expect(withImages.at(-1)).toStrictEqual(["这张", ["x"]]);
  });

  it("sends a steer of images alone with a placeholder text, which pi can take off its queue once delivered", async () => {
    const { pi, emit, withImages } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "一"));
    emit({ type: "agent_start" });

    await controller.steer(steer("s1", ""), [image("x")]);
    emit({ type: "queue_update", steering: ["（见图片）"], followUp: [] });
    expect(controller.snapshot().control.steers).toStrictEqual([{ id: "s1", text: "" }]);
    emit({ type: "queue_update", steering: [], followUp: [] });

    expect(withImages.at(-1)).toStrictEqual(["（见图片）", ["x"]]);
    expect(controller.snapshot().control.steers).toStrictEqual([]);
  });

  it("gives back the images of the steers pi still holds when two share a text", async () => {
    const { pi, emit, hold, withImages } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "一"));
    emit({ type: "agent_start" });
    await controller.steer(steer("s1", ""), [image("a")]);
    emit({ type: "queue_update", steering: ["（见图片）"], followUp: [] });
    await controller.steer(steer("s2", ""), [image("b")]);
    emit({ type: "queue_update", steering: ["（见图片）", "（见图片）"], followUp: [] });
    emit({ type: "queue_update", steering: ["（见图片）"], followUp: [] });
    hold(["（见图片）"]);

    await controller.stop();
    expect(controller.snapshot().control.queue).toMatchObject([{ text: "", images: 1 }]);
    emit({ type: "agent_settled" });
    await settle();
    controller.resumeQueue();

    expect(withImages.at(-1)).toStrictEqual(["", ["b"]]);
  });

  it("takes back a steer still on its way to pi when stopped, with its images", async () => {
    const { pi, emit, hold, sent, steerAnswers } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "一"));
    emit({ type: "agent_start" });
    const answer = Promise.withResolvers<{ disposition: "queued" }>();
    steerAnswers.push(() => answer.promise);
    const steering = controller.steer(steer("s1", "晚"), [image("x")]);
    await settle();

    const stopping = controller.stop();
    await settle();
    expect(sent).toStrictEqual(["prompt 一", "steer 晚", "abort"]);
    emit({ type: "queue_update", steering: ["晚"], followUp: [] });
    hold(["晚"]);
    answer.resolve({ disposition: "queued" });

    expect(await stopping).toStrictEqual({ confirmed: true });
    expect(await steering).toStrictEqual({ disposition: "queued" });
    expect(sent).toStrictEqual(["prompt 一", "steer 晚", "abort", "clear_queue"]);
    expect(controller.snapshot().control).toMatchObject({ queue: [{ text: "晚", images: 1 }], steers: [] });
  });

  it("sends no steer whose turn comes once a stop began, refusing it so it can go again", async () => {
    const { pi, emit, sent, steerAnswers } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "一"));
    emit({ type: "agent_start" });
    const first = Promise.withResolvers<{ disposition: "queued" }>();
    steerAnswers.push(() => first.promise);
    const earlier = controller.steer(steer("s1", "先"));
    const later = controller.steer(steer("s2", "后"), [image("y")]);
    await settle();

    const stopping = controller.stop();
    emit({ type: "queue_update", steering: ["先"], followUp: [] });
    first.resolve({ disposition: "queued" });

    await expect(later).rejects.toStrictEqual(new CommandError("session_stopping"));
    expect(await earlier).toStrictEqual({ disposition: "queued" });
    await stopping;
    expect(sent).toStrictEqual(["prompt 一", "steer 先", "abort", "clear_queue"]);
    expect(controller.snapshot().control.steers).toStrictEqual([]);
  });

  it("sends a message with its images again after a crash, when pi had not taken it", async () => {
    const { first, next, controller } = crashing(1);
    await controller.prompt(prompt("q1", "看图"), [image("a")]);
    first.emit({ type: "agent_start" });

    first.crash();
    await settle();

    expect(present(next[0], "the second pi").withImages).toStrictEqual([["看图", ["a"]]]);
  });

  it("keeps the images of a steer a crash sends back to the queue", async () => {
    const { first, next, controller } = crashing(1);
    await controller.prompt(prompt("q1", "一"));
    first.emit({ type: "agent_start" }, userEnd("一"));
    await controller.steer(steer("s1", "这张"), [image("x")]);

    first.crash();
    await settle();
    const second = present(next[0], "the second pi");
    second.emit({ type: "agent_start" }, { type: "agent_settled" });
    await settle();

    expect(second.withImages).toContainEqual(["这张", ["x"]]);
  });
});

/** pi's statistics, as `get_session_stats` gives them. */
const piStats: PiStats = {
  turns: 1,
  steps: 2,
  tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 1 },
  cost: 0.01,
  context: { tokens: 300, window: 1000 },
};

/** The status bar figures `piStats` makes, before anything else is known. */
const fromStats = {
  ...UNKNOWN_METRICS,
  turns: 1,
  steps: 2,
  tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 1 },
  cost: 0.01,
  context: { tokens: 300, window: 1000, parts: null, reserve: null },
};

/**
 * pi's compaction reserve, 8000 for Haiku and 16384 otherwise, noting each model it was read for.
 *
 * @remarks
 * For the test of which model the controller reads the reserve for.
 *
 * @sideEffects Adds to `asked` as it reads.
 * @param asked - Where the models go, as `provider/model`, or `null`.
 * @returns The read.
 */
function reserveByModel(asked: (string | null)[]): (model: ModelRef | null) => Promise<number | null> {
  return async (model) => {
    asked.push(model === null ? null : `${model.providerId}/${model.modelId}`);
    return model?.modelId === "haiku" ? 8000 : 16_384;
  };
}

/** The figures of every `metrics_updated` among the events. */
function published(events: readonly SessionEvent[]) {
  return events.flatMap((event) => (event.type === "metrics_updated" ? [event.metrics] : []));
}

/**
 * A stand-in for the service of subscriptions' usage, and what was asked of it.
 *
 * @remarks
 * Asks at once whenever asked, unlike the real one, so a test sees each time the controller asks.
 *
 * @sideEffects none until used; then calls the asks given.
 * @returns The service, the providers asked, and the usage replies brought.
 */
function plans() {
  const asked: string[] = [];
  const replied: unknown[] = [];
  const service: NonNullable<Parameters<typeof createSessionController>[0]["plan"]>["service"] = {
    wanted(provider, ask) {
      asked.push(provider);
      void ask();
    },
    replied: (report) => replied.push(report),
  };
  return { service, asked, replied };
}

/** The extension's report of the usage a reply brought (ADR-0012). */
const REPLY_USAGE = {
  provider: "anthropic",
  plan: null,
  windows: [{ seconds: 18_000, model: null, usedPercent: 5, resetsAt: 9, parts: [] }],
};

/** pi's event setting a status of Atrium's extension. */
function statusEvent(statusKey: string, statusText: string): PiEvent {
  return { type: "extension_ui_request", id: "u1", method: "setStatus", statusKey, statusText };
}

/** Every subscription, in the order the controller asks them. */
const EVERY_PLAN = ["openai-codex", "anthropic", "xai"];

describe("createSessionController's plan usage", () => {
  it("asks for every subscription through its pi after pi starts and each run, whatever the model", async () => {
    const { pi, emit } = manualPi();
    const { service, asked } = plans();
    const queried: string[] = [];
    const { controller } = control(pi, empty, {
      model: opus,
      plan: {
        service,
        ask: async (provider) => {
          queried.push(provider);
          return null;
        },
      },
    });
    await settle();
    const started = [...asked];

    emit({ type: "agent_start" }, userEnd("a"), { type: "agent_settled" });
    await settle();

    expect(started).toStrictEqual(EVERY_PLAN);
    expect(asked).toStrictEqual([...EVERY_PLAN, ...EVERY_PLAN]);
    expect(queried).toStrictEqual([...EVERY_PLAN, ...EVERY_PLAN]);
    expect(Object.keys(controller.snapshot().metrics)).not.toContain("plan");
  });

  it("asks nothing on a model change, nor without a model's mattering", async () => {
    const { pi, states } = manualPi();
    const { service, asked } = plans();
    const { controller } = control(pi, empty, { plan: { service, ask: async () => null } });
    await settle();

    // What pi reports from now on.
    states.splice(0, states.length, { providerId: "xai", modelId: "grok-4.3", thinkingLevel: "high" });
    await controller.setModel({ providerId: "xai", modelId: "grok-4.3" });
    await settle();

    expect(asked).toStrictEqual(EVERY_PLAN);
  });

  it("asks again once started anew after the host stopped it", async () => {
    const first = manualPi();
    const second = manualPi();
    const { service, asked } = plans();
    const { controller } = control(first.pi, empty, { model: opus, plan: { service, ask: async () => null } });
    await settle();

    await controller.shutdown();
    controller.attach({ pi: second.pi, entries: empty, model: opus });
    await settle();

    expect(asked).toStrictEqual([...EVERY_PLAN, ...EVERY_PLAN]);
  });

  it("hands the service the usage replies bring, from this pi and the next, and nothing else pi sets", async () => {
    const first = manualPi();
    const second = manualPi();
    const { service, replied } = plans();
    const { controller } = control(first.pi, empty, { model: opus, plan: { service, ask: async () => null } });
    await settle();

    first.emit(
      statusEvent("atrium-plan-reply", JSON.stringify(REPLY_USAGE)),
      statusEvent("atrium-plan", JSON.stringify(REPLY_USAGE)),
      statusEvent("atrium-plan-reply", "not json"),
    );
    await controller.shutdown();
    controller.attach({ pi: second.pi, entries: empty, model: opus });
    second.emit(statusEvent("atrium-plan-reply", JSON.stringify(REPLY_USAGE)));

    expect(replied).toStrictEqual([REPLY_USAGE, REPLY_USAGE]);
  });

  it("takes a reply's usage as nothing without the service", async () => {
    const { pi, emit } = manualPi();
    const { controller, events } = control(pi, empty, { model: opus });
    await settle();
    const before = events.length;

    emit(statusEvent("atrium-plan-reply", JSON.stringify(REPLY_USAGE)));

    expect(events.slice(before)).toStrictEqual([]);
    expect(controller.snapshot().exited).toBe(false);
  });

  it("asks nothing when pi settles while it is being stopped for good", async () => {
    const { pi, emit } = manualPi();
    const { service, asked } = plans();
    const { controller } = control(pi, empty, { model: opus, plan: { service, ask: async () => null } });
    await settle();
    const stop = pi.stop.bind(pi);
    // pi's last run settles as it goes.
    Object.assign(pi, {
      stop: async () => {
        emit({ type: "agent_start" }, userEnd("a"), { type: "agent_settled" });
        await settle();
        await stop();
      },
    });

    await controller.shutdown();

    expect(asked).toStrictEqual(EVERY_PLAN);
  });
});

describe("createSessionController's status bar figures", () => {
  it("reads pi's statistics once pi has started, publishing them and carrying them in snapshots", async () => {
    const { pi, statsAnswers, statsReads } = manualPi();
    statsAnswers.push(async () => piStats);
    const { controller, events } = control(pi);
    expect(controller.snapshot().metrics).toStrictEqual(UNKNOWN_METRICS);

    await settle();

    expect(statsReads()).toBe(1);
    expect(events).toStrictEqual([{ type: "metrics_updated", ...at(1, null), metrics: fromStats }]);
    expect(controller.snapshot().metrics).toStrictEqual(fromStats);
  });

  it("reads and publishes the figures again once started anew after the host stopped it", async () => {
    const first = manualPi();
    const second = manualPi();
    second.statsAnswers.push(async () => piStats);
    const { controller, events } = control(first.pi);
    await settle();
    await controller.shutdown();

    controller.attach({ pi: second.pi, entries: empty });
    await settle();

    expect([second.statsReads(), published(events).at(-1)]).toStrictEqual([1, fromStats]);
  });

  it("reads pi's compaction reserve for the model pi uses now, with each read of its statistics", async () => {
    const { pi, states, statsAnswers } = manualPi();
    statsAnswers.push(
      async () => piStats,
      async () => piStats,
    );
    const asked: (string | null)[] = [];
    const { controller } = control(pi, empty, {
      model: opus,
      readReserve: reserveByModel(asked),
    });
    await settle();
    expect(controller.snapshot().metrics.context?.reserve).toBe(16_384);

    states.push({ providerId: "anthropic", modelId: "haiku", thinkingLevel: "off" });
    await controller.setModel({ providerId: "anthropic", modelId: "haiku" });
    await settle();

    expect(asked).toStrictEqual(["anthropic/claude-opus-5-5", "anthropic/haiku"]);
    expect(controller.snapshot().metrics.context?.reserve).toBe(8000);
  });

  it("splits the context for the model pi uses now, counting Claude Code's prompt once it goes through Claude Code", async () => {
    const { pi, pages, states, statsAnswers } = manualPi();
    statsAnswers.push(
      async () => piStats,
      async () => piStats,
    );
    // The entries read again after the change never come: the new model alone splits the context again.
    pages.push(() => new Promise<EntriesPage>(() => undefined));
    const { controller } = control(pi, { entries: [defaultPrompt], leafId: "s1" }, { model: opus });
    await settle();
    expect(controller.snapshot().metrics.context?.parts?.system).toBe(20);

    states.push({ providerId: "claude-bridge", modelId: "claude-opus-5-5", thinkingLevel: "off" });
    await controller.setModel({ providerId: "claude-bridge", modelId: "claude-opus-5-5" });
    await settle();

    expect(controller.snapshot().metrics.context?.parts?.system).toBe(3825);
  });

  it("splits the context for the model a new pi brings, in the snapshot it starts with", async () => {
    const first = manualPi();
    first.statsAnswers.push(async () => piStats);
    const { controller, events } = control(first.pi, { entries: [defaultPrompt], leafId: "s1" }, { model: opus });
    await settle();
    await controller.shutdown();
    const second = manualPi();
    const before = events.length;

    controller.attach({
      pi: second.pi,
      entries: { entries: [defaultPrompt], leafId: "s1" },
      model: { ...opus, providerId: "claude-bridge" },
    });
    await settle();

    const started = events.slice(before).find((event) => event.type === "session_snapshot");
    expect(started).toMatchObject({ metrics: { context: { parts: { system: 3825 } } } });
  });

  it("starts from the entries it was given, publishing nothing for them", () => {
    const { pi } = manualPi();
    const assistant: LogEntry = {
      id: "a1",
      parentId: "u1",
      kind: "assistant",
      parts: [],
      stopReason: "stop",
      errorMessage: null,
      usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 2 },
      timestamp: 0,
    };

    const { controller, events } = control(pi, { entries: [userEntry("u1", null, "one"), assistant], leafId: "a1" });

    expect(controller.snapshot().metrics).toStrictEqual({ ...UNKNOWN_METRICS, reasoning: 2, branchTokens: 7 });
    expect(events).toStrictEqual([]);
  });

  it("times a request from pi's turn start to its reply, and reads pi's statistics after it", async () => {
    const { pi, emit, statsAnswers, statsReads } = manualPi();
    statsAnswers.push(
      async () => piStats,
      async () => ({ ...piStats, turns: 2 }),
    );
    const { controller, events, clock } = control(pi);
    await settle();
    await controller.prompt(prompt("q1", "hi"));

    emit({ type: "agent_start" }, { type: "turn_start" }, userEnd("hi"));
    clock.advance(400);
    emit(
      { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending", timestamp: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } },
    );
    clock.advance(1000);
    emit(replyEnd("stop", [{ type: "text", text: "Hel" }]));
    await settle();

    expect(statsReads()).toBe(2);
    expect(published(events)).toStrictEqual([
      fromStats,
      { ...fromStats, timing: { modelMs: 1400, ttftMs: 400, tps: 1 } },
      { ...fromStats, turns: 2, timing: { modelMs: 1400, ttftMs: 400, tps: 1 } },
    ]);
  });

  it("adds up the tokens of the entries read after a run", async () => {
    const { pi, emit, pages } = manualPi();
    const { controller, events } = control(pi);
    await controller.prompt(prompt("q1", "hi"));
    emit({ type: "agent_start" }, userEnd("hi"));
    pages.push(async () => ({
      entries: [
        userEntry("u1", null, "hi"),
        {
          id: "a1",
          parentId: "u1",
          kind: "assistant",
          parts: [],
          stopReason: "stop",
          errorMessage: null,
          usage: { input: 1, output: 2, cacheRead: 30, cacheWrite: 4, reasoning: null },
          timestamp: 0,
        },
      ],
      leafId: "a1",
    }));

    emit(replyEnd("stop"), { type: "agent_settled" });
    await settle();

    expect(published(events)).toStrictEqual([{ ...UNKNOWN_METRICS, branchTokens: 37 }]);
  });

  it("reads pi's statistics again after the model changes, as the context window may", async () => {
    const { pi, statsAnswers, statsReads } = manualPi();
    statsAnswers.push(
      async () => piStats,
      async () => piStats,
    );
    const { controller } = control(pi, empty, { model: opus });
    await settle();

    await controller.setModel({ providerId: "anthropic", modelId: "haiku" });
    await settle();

    expect(statsReads()).toBe(2);
  });

  it("logs a read pi failed by its reason only, keeping the figures, but not one that failed as pi went away", async () => {
    const { pi, emit, statsAnswers } = manualPi();
    statsAnswers.push(
      async () => {
        throw new ReplayRequestError("get_session_stats", "rejected", "secret in pi's text");
      },
      async () => {
        throw new Error("odd");
      },
      async () => {
        throw new ReplayRequestError("get_session_stats", "stopped", "");
      },
    );
    const { controller, logged } = control(pi);
    await settle();

    emit(replyEnd("stop"));
    await settle();
    emit(replyEnd("stop"));
    await settle();

    expect(logged).toStrictEqual([
      ["warn", "session stats not read", { sessionId: "s1", reason: "rejected" }],
      ["warn", "session stats not read", { sessionId: "s1", reason: "unknown" }],
    ]);
    expect(controller.snapshot().metrics).toStrictEqual(UNKNOWN_METRICS);
  });

  it("reads the statistics of the pi that took over after a crash, timing nothing the crashed one began", async () => {
    const first = manualPi();
    const second = manualPi();
    second.statsAnswers.push(async () => piStats);
    const reply: LogEntry = {
      id: "a1",
      parentId: "u1",
      kind: "assistant",
      parts: [],
      stopReason: "stop",
      errorMessage: null,
      usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: null },
      timestamp: 0,
    };
    const { controller, events } = control(first.pi, empty, {
      respawn: async () => ({
        pi: second.pi,
        entries: { entries: [userEntry("u1", null, "one"), reply], leafId: "a1" },
      }),
    });
    await controller.prompt(prompt("q1", "one"));
    first.emit({ type: "agent_start" }, { type: "turn_start" }, userEnd("one"));

    first.crash();
    await settle();
    second.emit(replyEnd("stop"));
    await settle();

    // Once as it took over, once after its reply; its entries come with its snapshot.
    expect(second.statsReads()).toBe(2);
    expect(published(events)).toStrictEqual([
      { ...UNKNOWN_METRICS, branchTokens: 5 },
      { ...fromStats, branchTokens: 5 },
    ]);
    const types = events.map((event) => event.type);
    expect(types.indexOf("metrics_updated")).toBeGreaterThan(types.lastIndexOf("session_snapshot"));
    expect(published(events).length).toBe(2);
    expect(events.filter((event) => event.type === "metrics_updated").map((event) => event.epoch)).toStrictEqual([
      2, 2,
    ]);
    expect(controller.snapshot().metrics).toStrictEqual({ ...fromStats, branchTokens: 5 });
  });

  it("publishes nothing a read brings once shut down", async () => {
    const { pi, statsAnswers } = manualPi();
    const read = Promise.withResolvers<PiStats>();
    statsAnswers.push(() => read.promise);
    const { controller, events } = control(pi);

    await controller.shutdown();
    read.resolve(piStats);
    await settle();

    expect(published(events)).toStrictEqual([]);
  });
});
