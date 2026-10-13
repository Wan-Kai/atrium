import type { LogMessage } from "@atrium/pi";
import { describe, expect, it } from "vitest";
import { TurnDraft } from "./turn-draft";

/** A draft of a turn opened at 0. */
function draft(): TurnDraft {
  return new TurnDraft(
    "t1",
    { text: "go", images: 0, clientMessageId: null, auto: false, command: null, timestamp: 0 },
    null,
  );
}

/** A finished assistant message with these parts. */
function reply(
  parts: Extract<LogMessage, { kind: "assistant" }>["parts"],
  stopReason: "stop" | "toolUse" = "stop",
): Extract<LogMessage, { kind: "assistant" }> {
  return {
    kind: "assistant",
    parts,
    stopReason,
    errorMessage: null,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: null },
    timestamp: 0,
  };
}

/** A bash call with this id. */
function call(callId: string) {
  return { type: "toolCall", callId, tool: "bash", args: { command: callId } } as const;
}

/** A successful result. */
const ok = { text: "ok", isError: false, details: undefined };

describe("TurnDraft", () => {
  it("grows the block of the current message at its index, after the steps of earlier messages", () => {
    const turn = draft();
    turn.startAssistant();
    turn.setPart(0, { type: "text", text: "first" });
    turn.finishAssistant(reply([{ type: "text", text: "first" }]));
    turn.startAssistant();
    turn.setPart(0, { type: "thinking", text: "" });
    turn.setPart(1, { type: "text", text: "" });

    expect(turn.appendText(1, "more")).toBe("2");
    expect(turn.appendText(0, "hm")).toBe("1");
    expect(turn.appendText(5, "x")).toBeNull();
    expect(turn.running().steps).toStrictEqual([
      { kind: "text", id: "0", text: "first" },
      { kind: "thinking", id: "1", text: "hm", durationMs: null },
      { kind: "text", id: "2", text: "more" },
    ]);
  });

  it("times only thinking steps it has", () => {
    const turn = draft();
    turn.startAssistant();
    turn.setPart(0, { type: "text", text: "a" });

    expect(turn.timeThinking("0", 5)).toBeNull();
    expect(turn.timeThinking("9", 5)).toBeNull();
    expect(turn.running().steps).toStrictEqual([{ kind: "text", id: "0", text: "a" }]);
  });

  it("keeps a thinking step's duration through its message's end, in a later message too", () => {
    const turn = draft();
    turn.startAssistant();
    turn.finishAssistant(reply([{ type: "text", text: "first" }]));
    turn.startAssistant();
    turn.setPart(0, { type: "thinking", text: "" });
    turn.timeThinking("1", 700);
    turn.setPart(1, { type: "thinking", text: "" });

    expect(
      turn.finishAssistant(
        reply([
          { type: "thinking", text: "hm" },
          { type: "text", text: "b" },
        ]),
      ),
    ).toStrictEqual([
      { step: { kind: "thinking", id: "1", text: "hm", durationMs: 700 }, added: false },
      { step: { kind: "text", id: "2", text: "b" }, added: false },
    ]);
  });

  it("keeps the duration of a later block of a later message in its own place", () => {
    const turn = draft();
    turn.startAssistant();
    turn.finishAssistant(
      reply([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    );
    turn.startAssistant();
    turn.setPart(0, { type: "text", text: "" });
    turn.setPart(1, { type: "thinking", text: "" });
    turn.timeThinking("3", 900);

    turn.finishAssistant(
      reply([
        { type: "text", text: "a" },
        { type: "thinking", text: "hm" },
      ]),
    );

    expect(turn.running().steps).toStrictEqual([
      { kind: "text", id: "0", text: "first" },
      { kind: "text", id: "1", text: "second" },
      { kind: "text", id: "2", text: "a" },
      { kind: "thinking", id: "3", text: "hm", durationMs: 900 },
    ]);
  });

  it("gives a block that finished as something else than it started no duration", () => {
    const turn = draft();
    turn.startAssistant();
    turn.setPart(0, { type: "thinking", text: "" });
    turn.timeThinking("0", 700);

    turn.finishAssistant(reply([{ type: "text", text: "plain" }]));

    expect(turn.running().steps).toStrictEqual([{ kind: "text", id: "0", text: "plain" }]);
  });

  it("pairs results with their calls by id, even with text after the calls", () => {
    const turn = draft();
    turn.startAssistant();
    turn.finishAssistant(reply([call("c1"), call("c2"), { type: "text", text: "after" }], "toolUse"));

    turn.toolResult("c1", ok, 1);

    expect(turn.running().steps).toMatchObject([
      { kind: "tool", callId: "c1", status: "done" },
      { kind: "tool", callId: "c2", status: "running" },
      { kind: "text" },
    ]);
  });

  it("takes no output for a tool that has finished", () => {
    const turn = draft();
    turn.startAssistant();
    turn.finishAssistant(reply([call("c1")], "toolUse"));
    turn.toolResult("c1", ok, 1);

    expect(turn.toolOutput("c1", "late")).toBeNull();
    expect(turn.running().steps[0]).toMatchObject({ output: "ok" });
  });

  it("takes a user message after a steer or a retry for a new turn, not another steer", () => {
    const steered = draft();
    steered.startAssistant();
    steered.finishAssistant(reply([call("c1")], "toolUse"));
    steered.toolResult("c1", ok, 1);
    expect(steered.takesSteer).toBe(true);
    steered.steer("also", 2);
    expect(steered.takesSteer).toBe(false);

    const retried = draft();
    retried.startAssistant();
    retried.finishAssistant(reply([call("c1")], "toolUse"));
    retried.toolResult("c1", ok, 1);
    retried.retry(1, "503");
    expect(retried.takesSteer).toBe(false);
  });
});
