import type { PiEvent } from "@atrium/pi";
import { CommandError, type SessionEvent } from "@atrium/protocol";
import { ReplayRequestError } from "@atrium/testkit";
import { parseFixture, replayPi } from "@atrium/testkit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type SessionPi, createSessionController } from "./session-controller";

/** The recorded pi fixtures, which belong to the pi package. */
const FIXTURES_DIR = join(import.meta.dirname, "..", "..", "..", "pi", "fixtures");

const traceIds = ["4bf92f3577b34da6a3ce929d0e0e4736", "5bf92f3577b34da6a3ce929d0e0e4737"] as const;

/** A `prompt` command in the given trace. */
function prompt(requestId: string, text: string, trace: string = traceIds[0]) {
  return { type: "prompt", requestId, traceparent: `00-${trace}-00f067aa0ba902b7-01`, sessionId: "s1", text } as const;
}

/** A controller over `pi` whose events are recorded, with ids id1, id2, … and a clock at 1000. */
function control(pi: SessionPi) {
  const events: SessionEvent[] = [];
  let next = 0;
  const controller = createSessionController({
    sessionId: "s1",
    pi,
    publish: (event) => events.push(event),
    clock: { now: () => 1000 },
    newId: () => `id${++next}`,
  });
  return { controller, events };
}

/** A recorded scenario played back as the session's pi. */
function replayed(scenario: string): SessionPi {
  const pi = replayPi(parseFixture(readFileSync(join(FIXTURES_DIR, "pi-1.0.2", `${scenario}.jsonl`), "utf8")));
  return {
    onEvent: (listener) => pi.onEvent((event) => listener(event as unknown as PiEvent)),
    exited: pi.exited,
    prompt: (message) => pi.request({ type: "prompt", message } as { type: string }) as never,
    stop: () => pi.stop(),
  };
}

/** A pi the test drives by hand. */
function manualPi() {
  const listeners = new Set<(event: PiEvent) => void>();
  const exit = Promise.withResolvers<{ code: number | null; signal: string | null; requested: boolean }>();
  const answers: Array<() => Promise<{ disposition: "started" | "queued" | "handled" }>> = [];
  const pi: SessionPi = {
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exited: exit.promise,
    prompt: () => (answers.shift() ?? (async () => ({ disposition: "started" as const })))(),
    stop: async () => exit.resolve({ code: 0, signal: null, requested: true }),
  };
  return {
    pi,
    answers,
    emit: (...events: unknown[]) => {
      for (const event of events) for (const listener of listeners) listener(event as PiEvent);
    },
    crash: () => exit.resolve({ code: null, signal: "SIGKILL", requested: false }),
  };
}

/** The `clientMessageId` of every user message among the events. */
function clientMessageIds(events: readonly SessionEvent[]): (string | null)[] {
  return events.flatMap((event) =>
    event.type === "message_finished" && event.message.role === "user" ? [event.message.clientMessageId] : [],
  );
}

/** pi echoing a user message. */
function userEnd(text: string) {
  return { type: "message_end", message: { role: "user", content: text, timestamp: 0 } };
}

/** Lets queued microtasks and the replay's deliveries run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The envelope every event of the first run carries, at sequence number `seq`. */
function at(seq: number, traceId: string | null = traceIds[0]) {
  return { sessionId: "s1", epoch: 1, seq, traceId };
}

describe("createSessionController on recorded pi output", () => {
  it("runs one prompt: run, the user's message with its request id, the streamed reply, then the settled run", async () => {
    const { controller, events } = control(replayed("prompt-started"));

    expect(await controller.prompt(prompt("q1", "hi"))).toStrictEqual({ disposition: "started" });
    await settle();

    const reply = {
      id: "id3",
      role: "assistant",
      content: [
        { type: "reasoning", text: "Plan first." },
        { type: "text", text: "Hello from faux." },
      ],
      stopReason: "stop",
      errorMessage: null,
      timestamp: 0,
    } as const;
    const userMessage = { id: "id2", role: "user", text: "hi", clientMessageId: "q1", timestamp: 0 } as const;
    expect(events).toStrictEqual([
      { type: "run_started", ...at(1), runId: "id1", startedAt: 1000 },
      { type: "message_finished", ...at(2), message: userMessage },
      { type: "message_started", ...at(3), messageId: "id3" },
      { type: "reasoning_delta", ...at(4), messageId: "id3", contentIndex: 0, delta: "Plan fir" },
      { type: "reasoning_delta", ...at(5), messageId: "id3", contentIndex: 0, delta: "st." },
      { type: "text_delta", ...at(6), messageId: "id3", contentIndex: 1, delta: "Hello fr" },
      { type: "text_delta", ...at(7), messageId: "id3", contentIndex: 1, delta: "om faux." },
      { type: "message_finished", ...at(8), message: reply },
      { type: "run_settled", ...at(9), runId: "id1", outcome: "completed", settledAt: 1000 },
    ]);
    expect(controller.snapshot()).toStrictEqual({
      type: "session_snapshot",
      ...at(9, null),
      messages: [userMessage, reply],
      streaming: null,
      run: null,
      exited: false,
    });
  });

  it("keeps an automatic retry within one run, and ends a run whose last reply failed as failed", async () => {
    const { controller, events } = control(replayed("error-retry"));

    await controller.prompt(prompt("q1", "one"));
    await settle();
    await controller.prompt(prompt("q2", "two", traceIds[1]));
    await settle();

    expect(events.map((event) => [event.type, event.seq, event.traceId])).toStrictEqual([
      ["run_started", 1, traceIds[0]],
      ["message_finished", 2, traceIds[0]],
      ["message_started", 3, traceIds[0]],
      ["message_finished", 4, traceIds[0]],
      ["message_started", 5, traceIds[0]],
      ["text_delta", 6, traceIds[0]],
      ["text_delta", 7, traceIds[0]],
      ["message_finished", 8, traceIds[0]],
      ["run_settled", 9, traceIds[0]],
      ["run_started", 10, traceIds[1]],
      ["message_finished", 11, traceIds[1]],
      ["message_started", 12, traceIds[1]],
      ["message_finished", 13, traceIds[1]],
      ["run_settled", 14, traceIds[1]],
    ]);
    expect(events.filter((event) => event.type === "run_settled").map((event) => event.outcome)).toStrictEqual([
      "completed",
      "failed",
    ]);
    expect(clientMessageIds(events)).toStrictEqual(["q1", "q2"]);
  });
});

describe("createSessionController on cases the fixtures do not show", () => {
  it("snapshots the message streaming and the run in progress, with the latest sequence number", async () => {
    const { pi, emit } = manualPi();
    const { controller } = control(pi);

    await controller.prompt(prompt("q1", "hi"));
    emit(
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending", timestamp: 0 } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "hm" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } },
    );

    expect(controller.snapshot()).toStrictEqual({
      type: "session_snapshot",
      ...at(5),
      messages: [],
      streaming: {
        messageId: "id2",
        content: [
          { type: "text", text: "Hello" },
          { type: "reasoning", text: "hm" },
        ],
      },
      run: { runId: "id1", startedAt: 1000 },
      exited: false,
    });
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

    expect(events.map((event) => event.type)).toStrictEqual([
      "message_finished",
      "message_finished",
      "message_finished",
    ]);
    expect(clientMessageIds(events)).toStrictEqual(["q2", "q3", null]);
  });

  it("forgets a prompt pi rejected, and passes the failure on", async () => {
    const { pi, emit, answers } = manualPi();
    const { controller, events } = control(pi);
    const failure = new Error("rejected");
    answers.push(() => Promise.reject(failure));

    await expect(controller.prompt(prompt("q1", "x"))).rejects.toBe(failure);
    await controller.prompt(prompt("q2", "y"));
    emit({ type: "message_end", message: { role: "user", content: "y", timestamp: 0 } });

    expect(events).toMatchObject([{ type: "message_finished", message: { clientMessageId: "q2" } }]);
  });

  it("ends a stopped reply's run as stopped, and ignores pi settling outside a run", async () => {
    const { pi, emit } = manualPi();
    const { controller, events } = control(pi);

    emit({ type: "agent_settled" });
    await controller.prompt(prompt("q1", "x"));
    emit(
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [], stopReason: "aborted", timestamp: 0 } },
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted", timestamp: 0 } },
      { type: "agent_settled" },
    );

    expect(events.map((event) => event.type)).toStrictEqual([
      "run_started",
      "message_started",
      "message_finished",
      "run_settled",
    ]);
    expect(events.at(-1)).toMatchObject({ outcome: "stopped" });
  });

  it.each(["length", "toolUse"])("ends a run whose last reply stopped with %s as completed", async (stopReason) => {
    const { pi, emit } = manualPi();
    const { controller, events } = control(pi);

    await controller.prompt(prompt("q1", "x"));
    emit(
      { type: "agent_start" },
      { type: "message_end", message: { role: "assistant", content: [], stopReason, timestamp: 0 } },
      { type: "agent_settled" },
    );

    expect(events.at(-1)).toMatchObject({ type: "run_settled", outcome: "completed" });
  });

  it("starts a run pi begins on its own without a trace", () => {
    const { pi, emit } = manualPi();
    const { events } = control(pi);

    emit({ type: "agent_start" });

    expect(events).toStrictEqual([{ type: "run_started", ...at(1, null), runId: "id1", startedAt: 1000 }]);
  });

  it("keeps the reply streaming when a user message arrives in the middle of it", async () => {
    const { pi, emit } = manualPi();
    const { controller } = control(pi);
    await controller.prompt(prompt("q1", "x"));

    emit(
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending", timestamp: 0 } },
    );
    expect(controller.snapshot().streaming).toStrictEqual({ messageId: "id2", content: [] });
    emit(
      { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a" } },
      userEnd("steered"),
    );

    expect(controller.snapshot().streaming).toStrictEqual({ messageId: "id2", content: [{ type: "text", text: "a" }] });
    expect(controller.snapshot().messages.map((message) => message.role)).toStrictEqual(["user"]);
  });

  it("ends a run with no reply as completed", async () => {
    const { pi, emit } = manualPi();
    const { controller, events } = control(pi);

    await controller.prompt(prompt("q1", "x"));
    emit({ type: "agent_start" }, { type: "agent_settled" });

    expect(events.at(-1)).toMatchObject({ type: "run_settled", outcome: "completed" });
  });

  it("fails the run in progress when pi crashes, reports the exit, and refuses prompts afterwards", async () => {
    const { pi, emit, crash } = manualPi();
    const { controller, events } = control(pi);
    await controller.prompt(prompt("q1", "x"));
    emit(
      { type: "agent_start" },
      { type: "message_start", message: { role: "assistant", content: [], stopReason: "pending", timestamp: 0 } },
    );

    crash();
    await settle();

    expect(events.slice(-2)).toStrictEqual([
      { type: "run_settled", ...at(3), runId: "id1", outcome: "failed", settledAt: 1000 },
      { type: "session_exited", ...at(4, null), reason: "crashed", code: null, signal: "SIGKILL" },
    ]);
    expect(controller.snapshot()).toMatchObject({ streaming: null, run: null, seq: 4, exited: true });
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
