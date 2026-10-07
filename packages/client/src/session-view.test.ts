import type { SessionEvent, TranscriptMessage } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { type SessionView, applySessionEvent, loadingView } from "./session-view";

const envelope = { sessionId: "s1", epoch: 1, traceId: null };

/** A finished user message. */
function user(clientMessageId: string | null, text = "hi"): TranscriptMessage {
  return { id: `u-${clientMessageId}`, role: "user", text, clientMessageId, timestamp: 0 };
}

/** A finished assistant message. */
function assistant(id: string): TranscriptMessage {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    stopReason: "stop",
    errorMessage: null,
    timestamp: 0,
  };
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
      messages: [user("q1")],
      streaming: { messageId: "m2", content: [] },
      run: { runId: "r", startedAt: 1 },
      exited: false,
    });

    expect(before).toBe(loading);
    expect(after).toStrictEqual({
      sessionId: "s1",
      status: "ready",
      epoch: 1,
      seq: 4,
      messages: [user("q1")],
      streaming: { messageId: "m2", content: [] },
      run: { runId: "r", startedAt: 1 },
      pending: [{ clientMessageId: "q2", text: "b" }],
    });
  });

  it("follows a run: streaming text into blocks, then the finished message replaces it", () => {
    const view = applyAll(ready(0), [
      { type: "run_started", ...envelope, seq: 1, runId: "r1", startedAt: 5 },
      { type: "message_started", ...envelope, seq: 2, messageId: "m1" },
      { type: "reasoning_delta", ...envelope, seq: 3, messageId: "m1", contentIndex: 0, delta: "th" },
      { type: "text_delta", ...envelope, seq: 4, messageId: "m1", contentIndex: 1, delta: "o" },
      { type: "reasoning_delta", ...envelope, seq: 5, messageId: "m1", contentIndex: 0, delta: "ink" },
      { type: "text_delta", ...envelope, seq: 6, messageId: "m1", contentIndex: 1, delta: "k" },
    ]);

    expect(view).toStrictEqual(
      ready(6, {
        run: { runId: "r1", startedAt: 5 },
        streaming: {
          messageId: "m1",
          content: [
            { type: "reasoning", text: "think" },
            { type: "text", text: "ok" },
          ],
        },
      }),
    );
    expect(
      applyAll(view, [
        { type: "message_finished", ...envelope, seq: 7, message: assistant("m1") },
        { type: "run_settled", ...envelope, seq: 8, runId: "r1", outcome: "completed", settledAt: 6 },
      ]),
    ).toStrictEqual(ready(8, { messages: [assistant("m1")] }));
  });

  it("copies only the block that changed, keeping earlier messages and other blocks as they were", () => {
    const earlier = [user(null), assistant("m0")];
    const view = applyAll(ready(0, { messages: earlier }), [
      { type: "message_started", ...envelope, seq: 1, messageId: "m1" },
      { type: "text_delta", ...envelope, seq: 2, messageId: "m1", contentIndex: 0, delta: "a" },
      { type: "text_delta", ...envelope, seq: 3, messageId: "m1", contentIndex: 1, delta: "b" },
    ]);

    const next = applySessionEvent(view, {
      type: "text_delta",
      ...envelope,
      seq: 4,
      messageId: "m1",
      contentIndex: 1,
      delta: "c",
    });

    expect(next).not.toBe("resync");
    const updated = next as SessionView;
    expect(updated.messages).toBe(view.messages);
    expect(updated.messages).toBe(earlier);
    expect(updated.streaming?.content[0]).toBe(view.streaming?.content[0]);
    expect(updated.streaming?.content[1]).toStrictEqual({ type: "text", text: "bc" });
  });

  it("confirms a pending message with the user message that carries its id, and keeps streaming meanwhile", () => {
    const view = ready(1, {
      streaming: { messageId: "m1", content: [] },
      pending: [
        { clientMessageId: "q1", text: "a" },
        { clientMessageId: "q2", text: "b" },
      ],
    });

    expect(
      applySessionEvent(view, { type: "message_finished", ...envelope, seq: 2, message: user("q2", "b") }),
    ).toStrictEqual(
      ready(2, {
        streaming: { messageId: "m1", content: [] },
        messages: [user("q2", "b")],
        pending: [{ clientMessageId: "q1", text: "a" }],
      }),
    );
  });

  it("marks the session exited and clears what was in progress", () => {
    const view = ready(3, { streaming: { messageId: "m1", content: [] }, run: { runId: "r1", startedAt: 1 } });

    expect(
      applySessionEvent(view, {
        type: "session_exited",
        ...envelope,
        seq: 4,
        reason: "crashed",
        code: 1,
        signal: null,
      }),
    ).toStrictEqual({ ...ready(4), status: "exited" });
  });

  it.each([
    [
      "a gap in the sequence",
      { type: "run_settled", ...envelope, seq: 5, runId: "r", outcome: "completed", settledAt: 1 },
    ],
    [
      "a repeated sequence number",
      { type: "run_settled", ...envelope, seq: 3, runId: "r", outcome: "completed", settledAt: 1 },
    ],
    [
      "another epoch",
      { type: "run_settled", ...envelope, epoch: 2, seq: 4, runId: "r", outcome: "completed", settledAt: 1 },
    ],
    [
      "text for a message not streaming",
      { type: "text_delta", ...envelope, seq: 4, messageId: "m9", contentIndex: 0, delta: "x" },
    ],
  ] as const)("asks for a resync on %s", (_case, event) => {
    expect(applySessionEvent(ready(3, { streaming: { messageId: "m1", content: [] } }), event as SessionEvent)).toBe(
      "resync",
    );
  });

  it("asks for a resync on text when nothing is streaming", () => {
    expect(
      applySessionEvent(ready(3), {
        type: "text_delta",
        ...envelope,
        seq: 4,
        messageId: "m1",
        contentIndex: 0,
        delta: "x",
      }),
    ).toBe("resync");
  });

  it("starts a streaming message with no blocks", () => {
    expect(
      applySessionEvent(ready(0), { type: "message_started", ...envelope, seq: 1, messageId: "m1" }),
    ).toStrictEqual(ready(1, { streaming: { messageId: "m1", content: [] } }));
  });

  it("takes a snapshot of a session whose pi has exited as exited", () => {
    expect(
      applySessionEvent(loadingView("s1"), {
        type: "session_snapshot",
        ...envelope,
        seq: 2,
        messages: [],
        streaming: null,
        run: null,
        exited: true,
      }),
    ).toMatchObject({ status: "exited", seq: 2 });
  });
});
