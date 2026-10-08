import type { LogEntry, PiEvent } from "@atrium/pi";
import { CommandError, type SessionEvent } from "@atrium/protocol";
import { ReplayRequestError, present, replayPi } from "@atrium/testkit";
import { describe, expect, it, vi } from "vitest";
import { fixtureEntries, readPiFixture } from "../../test/pi-fixtures";
import type { EntriesPage } from "../transcript/session-transcript";
import { type SessionPi, createSessionController } from "./session-controller";

const traceIds = ["4bf92f3577b34da6a3ce929d0e0e4736", "5bf92f3577b34da6a3ce929d0e0e4737"] as const;

/** A `prompt` command in the given trace. */
function prompt(requestId: string, text: string, trace: string = traceIds[0]) {
  return { type: "prompt", requestId, traceparent: `00-${trace}-00f067aa0ba902b7-01`, sessionId: "s1", text } as const;
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
function control(pi: SessionPi, entries: EntriesPage = empty) {
  const events: SessionEvent[] = [];
  const failures: unknown[] = [];
  let next = 0;
  const controller = createSessionController({
    sessionId: "s1",
    pi,
    entries,
    publish: (event) => events.push(event),
    clock: { now: () => 1000 },
    newId: () => `id${++next}`,
    onRefreshFailed: (error) => failures.push(error),
  });
  return { controller, events, failures };
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
    [entries.length, "e22"],
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
  const pi: SessionPi = {
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exited: exit.promise,
    prompt: () => (answers.shift() ?? (async () => ({ disposition: "started" as const })))(),
    getEntries: (cursor) => {
      since.push(cursor);
      return (pages.shift() ?? (async () => empty))();
    },
    stop: async () => exit.resolve({ code: 0, signal: null, requested: true }),
  };
  return {
    pi,
    answers,
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

/** The envelope every event of the first run carries, at sequence number `seq`. */
function at(seq: number, traceId: string | null = traceIds[0]) {
  return { sessionId: "s1", epoch: 1, seq, traceId };
}

/** How many runs have settled among the events. */
function settledRuns(events: readonly SessionEvent[]): number {
  return events.filter((event) => event.type === "run_settled").length;
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
    await settle();

    expect(since).toStrictEqual(["e4", "e15", "e17", "e18", "e20"]);
    expect(failures).toStrictEqual([]);
    expect(settledRuns(events)).toBe(4);
    expect(clientMessageIds(events)).toStrictEqual(["q1", "q2", "q3", "q5"]);
    expect(events.filter((event) => event.type === "run_settled").map((event) => event.outcome)).toStrictEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    // Every run rebuilt as it was sent, so one epoch holds every event until pi changed branch.
    const last = present(events.at(-1), "the last event");
    expect(events.slice(0, -1).every((event) => event.epoch === 1)).toBe(true);
    expect(events.map((event) => event.seq).slice(0, -1)).toStrictEqual(
      Array.from({ length: events.length - 1 }, (_, index) => index + 1),
    );
    expect(events.filter((event) => event.type === "notice_added")).toStrictEqual([
      expect.objectContaining({ notice: expect.objectContaining({ id: "s1:e18" }), epoch: 1, traceId: null }),
    ]);
    expect(last).toMatchObject({ type: "session_snapshot", epoch: 2, seq: 0, hasOlder: false, run: null });
    expect(controller.snapshot().items.map((item) => item.id)).toStrictEqual(["id2", "id8"]);
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
          user: { text: "hi", images: 0, clientMessageId: "q1", timestamp: 0 },
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
    });
  });

  it("starts with the transcript of the entries it was given", () => {
    const { pi } = manualPi();
    const { controller } = control(pi, { entries: [userEntry("u1", null, "earlier")], leafId: "u1" });

    expect(controller.snapshot()).toMatchObject({ seq: 0, items: [{ id: "s1:u1", user: { text: "earlier" } }] });
  });

  it("matches echoed user messages to waiting prompts in order, skipping a prompt pi handled itself", async () => {
    const { pi, emit, answers } = manualPi();
    const { controller, events } = control(pi);
    answers.push(async () => ({ disposition: "handled" }));

    expect(await controller.prompt(prompt("q1", "/faux-noop"))).toStrictEqual({ disposition: "handled" });
    await controller.prompt(prompt("q2", "a"));
    answers.push(async () => ({ disposition: "queued" }));
    expect(await controller.prompt(prompt("q3", "b"))).toStrictEqual({ disposition: "queued" });
    emit(userEnd("a"), userEnd("b"), userEnd("echoed by an extension"));

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
        outcome: "stopped",
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

    await controller.stop();
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

  it("reads the whole session again when pi does not know the cursor", async () => {
    const { pi, emit, pages, since } = manualPi();
    const { events } = control(pi, { entries: [userEntry("u1", null, "a")], leafId: "u1" });
    pages.push(
      () => Promise.reject(new ReplayRequestError("get_entries", "rejected", "Entry not found: u1")),
      async () => ({ entries: [userEntry("v1", null, "b")], leafId: "v1" }),
    );

    emit({ type: "compaction_end" });
    await vi.waitFor(() => expect(since).toStrictEqual(["u1", undefined]));
    await settle();

    expect(events).toMatchObject([{ type: "session_snapshot", epoch: 2, items: [{ id: "s1:v1" }] }]);
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
    [
      "busy with a run",
      new ReplayRequestError("prompt", "rejected", "Agent is already processing. Specify streamingBehavior."),
      new CommandError("session_busy"),
    ],
    [
      "busy compacting",
      new ReplayRequestError("prompt", "rejected", "Cannot submit a prompt while compaction is in progress."),
      new CommandError("session_busy"),
    ],
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
