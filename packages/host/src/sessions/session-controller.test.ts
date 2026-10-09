import type { LogEntry, PiEvent } from "@atrium/pi";
import { CommandError, IDLE_CONTROL, type SessionEvent } from "@atrium/protocol";
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
  extra: Pick<Parameters<typeof createSessionController>[0], "respawn" | "turnStarts"> = {},
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
  /** What pi was sent, in order: `prompt <text>`, `steer <text>`, `clear_queue`, `abort`. */
  const sent: string[] = [];
  const responses: unknown[] = [];
  let held: string[] = [];
  const abortGate = Promise.withResolvers<void>();
  let abortWaits = false;
  const pi: SessionPi = {
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exited: exit.promise,
    prompt: (message) => {
      sent.push(`prompt ${message}`);
      return (answers.shift() ?? (async () => ({ disposition: "started" as const })))();
    },
    steer: (message) => {
      sent.push(`steer ${message}`);
      return (steerAnswers.shift() ?? (async () => ({ disposition: "queued" as const })))();
    },
    clearQueue: async () => {
      sent.push("clear_queue");
      const steering = held;
      held = [];
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
    emit: (...events: unknown[]) => {
      for (const event of events) for (const listener of listeners) listener(event as PiEvent);
    },
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
    message: { role: "assistant", content, stopReason, usage: { input: 1, output: 1 }, timestamp: 0 },
  };
}

/** A user entry. */
function userEntry(id: string, parentId: string | null, text: string): LogEntry {
  return { id, parentId, kind: "user", text, images: 0, timestamp: 0 };
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
    await raw.request({ type: "compact" });
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
          user: { text: "hi", images: 0, clientMessageId: "q1", auto: false, timestamp: 0 },
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
    expect(controller.snapshot().control.queue).toStrictEqual([{ id: "id1", text: "x", createdAt: 1000 }]);
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
        { id: "id3", text: "two", createdAt: 1000 },
        { id: "id4", text: "three", createdAt: 1000 },
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

  it("tells pi's steers apart by text, one held text keeping one steer", async () => {
    const { pi, emit } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    await controller.steer(steer("s1", "same"));
    await controller.steer(steer("s2", "same"));
    await controller.steer(steer("s3", "other"));
    emit({ type: "queue_update", steering: ["same", "same", "other"], followUp: [] });

    emit({ type: "queue_update", steering: ["same", "unknown"], followUp: [] });

    expect(controller.snapshot().control.steers).toStrictEqual([{ id: "s1", text: "same" }]);
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

  it("passes a steer pi refuses on as an error code", async () => {
    const { pi, emit, steerAnswers } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" });
    steerAnswers.push(() => Promise.reject(new ReplayRequestError("steer", "rejected", "extension command")));

    await expect(controller.steer(steer("s1", "/x"))).rejects.toStrictEqual(
      new CommandError("pi_rejected", { detail: "extension command" }),
    );
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
      usage: { input: 1, output: 1 },
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
    const { pi, emit, sent, pages } = manualPi();
    const { controller } = control(pi);
    const failed: LogEntry = {
      id: "a1",
      parentId: "u1",
      kind: "assistant",
      parts: [],
      stopReason: "error",
      errorMessage: "overloaded",
      usage: { input: 0, output: 0 },
      timestamp: 0,
    };
    pages.push(async () => ({ entries: [userEntry("u1", null, "one"), failed], leafId: "a1" }));
    await controller.prompt(prompt("q1", "one"));
    emit({ type: "agent_start" }, userEnd("one"), replyEnd("error"), { type: "agent_settled" });
    await settle();

    expect(await controller.retryRun()).toStrictEqual({});

    expect(sent).toStrictEqual(["prompt one", `prompt ${CONTINUE_TEXT}`]);
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
