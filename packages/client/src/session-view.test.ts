import { IDLE_CONTROL, type Notice, type SessionEvent, type Step, type Turn } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { type SessionView, applySessionEvent, loadingView, prependOlder, withWholeStep } from "./session-view";

const envelope = { sessionId: "s1", epoch: 1, traceId: null };

/** A turn with the given id, running and without steps unless `fields` say otherwise. */
function turn(id: string, fields: Partial<Turn> = {}): Turn {
  return {
    kind: "turn",
    id,
    user: { text: "hi", images: 0, clientMessageId: null, auto: false, timestamp: 0 },
    steps: [],
    outcome: "running",
    error: null,
    startedAt: 0,
    durationMs: null,
    usage: null,
    changes: [],
    ...fields,
  };
}

/** A turn opened by the pending message `clientMessageId`. */
function confirming(id: string, clientMessageId: string): Turn {
  return turn(id, { user: { text: "hi", images: 0, clientMessageId, auto: false, timestamp: 0 } });
}

/** A compaction notice. */
function notice(id: string): Notice {
  return { kind: "notice", id, notice: "compacted", tokensBefore: 1, summary: "", timestamp: 0 };
}

/** A text step. */
function text(id: string, value: string): Step {
  return { kind: "text", id, text: value };
}

/** The envelope of an event at `seq`. */
function at(seq: number) {
  return { ...envelope, seq };
}

/** A ready view at `seq`. */
function ready(seq: number, fields: Partial<SessionView> = {}): SessionView {
  return { ...loadingView("s1"), status: "ready", epoch: 1, seq, ...fields };
}

/** Applies events in order, failing on a resync. */
function applyAll(view: SessionView, events: SessionEvent[]): SessionView {
  return events.reduce((current, event) => {
    const next = applySessionEvent(current, event);
    if (next === "resync") throw new Error(`unexpected resync at ${event.seq}`);
    return next;
  }, view);
}

describe("loadingView", () => {
  it("has nothing yet, and no older items to ask for", () => {
    expect(loadingView("s7")).toStrictEqual({
      sessionId: "s7",
      status: "loading",
      epoch: 0,
      seq: 0,
      items: [],
      hasOlder: false,
      run: null,
      pending: [],
      control: IDLE_CONTROL,
      model: null,
    });
  });
});

describe("applySessionEvent", () => {
  it("ignores events before the snapshot, then takes the snapshot whole, keeping unconfirmed pending messages", () => {
    const loading = {
      ...loadingView("s1"),
      pending: [
        { clientMessageId: "q1", text: "a" },
        { clientMessageId: "q2", text: "b" },
      ],
    };

    const before = applySessionEvent(loading, {
      type: "run_settled",
      ...envelope,
      seq: 9,
      runId: "r",
      outcome: "completed",
      settledAt: 1,
    });
    const after = applySessionEvent(loading, {
      type: "session_snapshot",
      ...envelope,
      seq: 4,
      items: [notice("n1"), confirming("t1", "q1")],
      hasOlder: true,
      run: { runId: "r", startedAt: 1 },
      exited: false,
      control: { ...IDLE_CONTROL, paused: "stopped" },
      model: { providerId: "anthropic", modelId: "haiku", thinkingLevel: "low" },
    });

    expect(before).toBe(loading);
    expect(after).toStrictEqual({
      sessionId: "s1",
      status: "ready",
      epoch: 1,
      seq: 4,
      items: [notice("n1"), confirming("t1", "q1")],
      hasOlder: true,
      run: { runId: "r", startedAt: 1 },
      pending: [{ clientMessageId: "q2", text: "b" }],
      control: { ...IDLE_CONTROL, paused: "stopped" },
      model: { providerId: "anthropic", modelId: "haiku", thinkingLevel: "low" },
    });
  });

  it("follows a run: a turn opens, steps arrive and grow, a tool finishes, the turn ends, a notice follows", () => {
    const tool: Step = {
      kind: "tool",
      id: "1",
      callId: "c1",
      tool: "bash",
      args: { command: "ls" },
      status: "running",
      output: null,
      details: { tool: "bash", command: "ls" },
      partial: false,
    };
    const done: Step = { ...tool, status: "done", output: "a.ts" };

    const view = applyAll(ready(0, { pending: [{ clientMessageId: "q1", text: "hi" }] }), [
      { type: "run_started", ...at(1), runId: "r1", startedAt: 5 },
      { type: "turn_started", ...at(2), turn: confirming("t1", "q1") },
      { type: "step_added", ...at(3), turnId: "t1", step: { kind: "thinking", id: "0", text: "", durationMs: null } },
      { type: "step_delta", ...at(4), turnId: "t1", stepId: "0", delta: "hm" },
      { type: "step_added", ...at(5), turnId: "t1", step: tool },
      { type: "step_updated", ...at(6), turnId: "t1", step: done },
      { type: "step_added", ...at(7), turnId: "t1", step: text("2", "") },
      { type: "step_delta", ...at(8), turnId: "t1", stepId: "2", delta: "fin" },
      { type: "step_delta", ...at(9), turnId: "t1", stepId: "2", delta: "e" },
      {
        type: "turn_finished",
        ...at(10),
        turnId: "t1",
        outcome: "failed",
        error: "429",
        durationMs: 300,
        usage: { input: 4, output: 2 },
        changes: [{ path: "a.ts", added: 1, removed: 0 }],
      },
      { type: "run_settled", ...at(11), runId: "r1", outcome: "failed", settledAt: 9 },
      { type: "notice_added", ...at(12), notice: notice("n1"), before: null },
    ]);

    expect(view).toStrictEqual(
      ready(12, {
        items: [
          {
            ...confirming("t1", "q1"),
            steps: [{ kind: "thinking", id: "0", text: "hm", durationMs: null }, done, text("2", "fine")],
            outcome: "failed",
            error: "429",
            durationMs: 300,
            usage: { input: 4, output: 2 },
            changes: [{ path: "a.ts", added: 1, removed: 0 }],
          },
          notice("n1"),
        ],
        run: null,
        pending: [],
      }),
    );
  });

  it("copies only the turn and step that changed, keeping every other item and step as it was", () => {
    const first = turn("t1", { outcome: "done", steps: [text("0", "old")] });
    const kept = text("0", "a");
    const view = ready(1, { items: [first, notice("n1"), turn("t2", { steps: [kept, text("1", "b")] })] });

    const next = applyAll(view, [{ type: "step_delta", ...envelope, seq: 2, turnId: "t2", stepId: "1", delta: "c" }]);

    expect(next.items[0]).toBe(first);
    expect(next.items[1]).toBe(view.items[1]);
    expect((next.items[2] as Turn).steps[0]).toBe(kept);
    expect((next.items[2] as Turn).steps[1]).toStrictEqual(text("1", "bc"));
  });

  it("goes to the latest turn with the id, and keeps a pending message no turn confirms", () => {
    const view = ready(1, {
      items: [
        turn("t1"),
        turn("t1", { user: { text: "again", images: 0, clientMessageId: null, auto: false, timestamp: 0 } }),
      ],
      pending: [{ clientMessageId: "q9", text: "x" }],
    });

    const next = applyAll(view, [
      { type: "step_added", ...envelope, seq: 2, turnId: "t1", step: text("0", "") },
      { type: "turn_started", ...envelope, seq: 3, turn: confirming("t2", "q1") },
    ]);

    expect((next.items[0] as Turn).steps).toStrictEqual([]);
    expect((next.items[1] as Turn).steps).toStrictEqual([text("0", "")]);
    expect(next.pending).toStrictEqual([{ clientMessageId: "q9", text: "x" }]);
  });

  it("marks the session exited and drops the run", () => {
    const view = ready(1, { run: { runId: "r1", startedAt: 1 } });

    expect(
      applySessionEvent(view, {
        type: "session_exited",
        ...envelope,
        seq: 2,
        reason: "crashed",
        code: null,
        signal: "SIGKILL",
      }),
    ).toStrictEqual({ ...view, seq: 2, status: "exited", run: null });
  });

  it.each([
    ["a gap in the sequence", { type: "notice_added", ...envelope, seq: 3, notice: notice("n"), before: null }],
    ["a repeated event", { type: "notice_added", ...envelope, seq: 1, notice: notice("n"), before: null }],
    ["another epoch", { type: "notice_added", ...envelope, epoch: 2, seq: 2, notice: notice("n"), before: null }],
    [
      "a notice before an item it does not have",
      { type: "notice_added", ...envelope, seq: 2, notice: notice("n"), before: "nope" },
    ],
    [
      "a step for a turn it does not have",
      { type: "step_added", ...envelope, seq: 2, turnId: "nope", step: text("0", "") },
    ],
    ["a step for a notice", { type: "step_added", ...envelope, seq: 2, turnId: "n1", step: text("0", "") }],
    [
      "text for a step it does not have",
      { type: "step_delta", ...envelope, seq: 2, turnId: "t1", stepId: "9", delta: "x" },
    ],
    ["text for a tool step", { type: "step_delta", ...envelope, seq: 2, turnId: "t1", stepId: "1", delta: "x" }],
    [
      "an update of a step it does not have",
      { type: "step_updated", ...envelope, seq: 2, turnId: "t1", step: text("9", "") },
    ],
    [
      "the end of a turn it does not have",
      {
        type: "turn_finished",
        ...envelope,
        seq: 2,
        turnId: "nope",
        outcome: "done",
        error: null,
        durationMs: 1,
        usage: null,
        changes: [],
      },
    ],
  ] as [string, SessionEvent][])("asks for a resync on %s", (_case, event) => {
    const view = ready(1, {
      items: [
        notice("n1"),
        turn("t1", {
          steps: [
            text("0", ""),
            {
              kind: "tool",
              id: "1",
              callId: "c",
              tool: "x",
              args: {},
              status: "running",
              output: null,
              details: null,
              partial: false,
            },
          ],
        }),
      ],
    });

    expect(applySessionEvent(view, event)).toBe("resync");
  });

  it("takes a snapshot of a session whose pi has exited as exited, and a new epoch's snapshot whole", () => {
    const view = ready(7, { items: [turn("old")], hasOlder: false });

    expect(
      applySessionEvent(view, {
        type: "session_snapshot",
        ...envelope,
        epoch: 2,
        seq: 0,
        items: [turn("new")],
        hasOlder: true,
        run: null,
        exited: true,
        control: IDLE_CONTROL,
        model: null,
      }),
    ).toStrictEqual({ ...view, status: "exited", epoch: 2, seq: 0, items: [turn("new")], hasOlder: true });
  });

  it("takes the run control whole, and drops the pending copy of a message an extension handled", () => {
    const view = ready(3, {
      pending: [
        { clientMessageId: "q1", text: "/cmd" },
        { clientMessageId: "q2", text: "b" },
      ],
    });
    const control = { ...IDLE_CONTROL, queue: [{ id: "i1", text: "later", createdAt: 5, images: 0 }], stopping: true };

    expect(
      applyAll(view, [
        { type: "control_updated", ...envelope, seq: 4, control },
        { type: "prompt_handled", ...envelope, seq: 5, clientMessageId: "q1" },
      ]),
    ).toStrictEqual({ ...view, seq: 5, control, pending: [{ clientMessageId: "q2", text: "b" }] });
  });
});

describe("applySessionEvent following the model", () => {
  it("takes the model whole from model_updated", () => {
    const haiku = { providerId: "anthropic", modelId: "haiku", thinkingLevel: "low" } as const;
    const view = ready(3, { model: haiku });

    expect(
      applyAll(view, [
        { type: "model_updated", ...envelope, seq: 4, model: { ...haiku, thinkingLevel: "off" } },
        { type: "model_updated", ...envelope, seq: 5, model: null },
      ]),
    ).toStrictEqual({ ...view, seq: 5, model: null });
    expect(
      applyAll(view, [{ type: "model_updated", ...envelope, seq: 4, model: { ...haiku, thinkingLevel: "off" } }]).model,
    ).toStrictEqual({ ...haiku, thinkingLevel: "off" });
  });
});

describe("applySessionEvent placing notices", () => {
  it("puts a notice before the item it names", () => {
    const view = ready(1, { items: [turn("t1"), turn("t2")] });

    expect(
      applyAll(view, [
        { type: "notice_added", ...envelope, seq: 2, notice: notice("n1"), before: "t2" },
        { type: "notice_added", ...envelope, seq: 3, notice: notice("n2"), before: "t2" },
      ]).items.map((item) => item.id),
    ).toStrictEqual(["t1", "n1", "n2", "t2"]);
  });
});

describe("withWholeStep", () => {
  const preview: Step = {
    kind: "tool",
    id: "0",
    callId: "c",
    tool: "bash",
    args: {},
    status: "done",
    output: "end",
    details: null,
    partial: true,
  };
  const whole: Step = { ...preview, output: "start…end", partial: false };
  const view = ready(3, { items: [turn("t1", { steps: [preview, text("1", "x")] })] });

  it("puts the whole step in place of its preview", () => {
    expect(withWholeStep(view, "t1", whole, 1).items).toStrictEqual([turn("t1", { steps: [whole, text("1", "x")] })]);
  });

  it("drops a step from an epoch that has passed, or of a turn or step the view does not have", () => {
    expect(withWholeStep(view, "t1", whole, 2)).toBe(view);
    expect(withWholeStep(view, "t9", whole, 1)).toBe(view);
    expect(withWholeStep(view, "t1", { ...whole, id: "7" }, 1)).toBe(view);
  });
});

describe("prependOlder", () => {
  const view = ready(3, { items: [turn("t5"), turn("t6")], hasOlder: true });

  it("puts a page of older items in front and takes over whether there are more", () => {
    expect(prependOlder(view, { items: [turn("t3"), notice("n4")], hasOlder: false }, 1, "t5")).toStrictEqual({
      ...view,
      items: [turn("t3"), notice("n4"), turn("t5"), turn("t6")],
      hasOlder: false,
    });
  });

  it("drops a page for a view that has no items any more", () => {
    const empty = ready(3, { items: [] });

    expect(prependOlder(empty, { items: [turn("t3")], hasOlder: false }, 1, "t5")).toBe(empty);
  });

  it("drops a page from an epoch that has passed, or fetched before an item that is no longer first", () => {
    expect(prependOlder(view, { items: [turn("t3")], hasOlder: false }, 2, "t5")).toBe(view);
    expect(prependOlder(view, { items: [turn("t3")], hasOlder: false }, 1, "t6")).toBe(view);
  });
});
