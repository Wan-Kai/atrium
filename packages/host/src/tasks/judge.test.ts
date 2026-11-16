import type { PiEvent } from "@atrium/pi";
import { describe, expect, it } from "vitest";
import { JUDGE_START, type JudgeInput, type JudgeState, type Verdict, judge } from "./judge";

/** A pi event of a type, with the fields a test names. */
function pi(type: string, fields: Record<string, unknown> = {}): JudgeInput {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the judge reads only `type` and the fields the test gives.
  return { kind: "pi", event: { type, ...fields } as unknown as PiEvent };
}

/** An assistant message that ended as given. */
const assistant = (stopReason: string) => ({ role: "assistant", stopReason });

/**
 * Feeds inputs in turn.
 *
 * @remarks
 * The state and every verdict, in order.
 *
 * @sideEffects none
 * @param inputs - The inputs.
 * @returns The final state and the verdicts.
 */
function feed(...inputs: JudgeInput[]): { state: JudgeState; verdicts: Verdict[] } {
  let state = JUDGE_START;
  const verdicts: Verdict[] = [];
  for (const input of inputs) {
    const step = judge(state, input);
    state = step.state;
    verdicts.push(...step.verdicts);
  }
  return { state, verdicts };
}

const accepted = (call: "done" | "graph_change"): JudgeInput => ({ kind: "accepted", call });
const ended = (kind: string): Verdict => ({ kind: "ended", ending: { kind } as never });

describe("judge (SPEC-0006, T4a's details)", () => {
  it("lets an accepted node_done stand when the turn settles", () => {
    const { verdicts, state } = feed(
      pi("agent_start"),
      accepted("done"),
      pi("agent_end", { messages: [assistant("toolUse")] }),
      pi("agent_settled"),
    );

    expect(verdicts).toStrictEqual([ended("done")]);
    expect(state).toStrictEqual(JUDGE_START);
  });

  it("lets an accepted graph-change request stand", () => {
    expect(feed(accepted("graph_change"), pi("agent_settled")).verdicts).toStrictEqual([ended("graph_change")]);
  });

  it("voids a node_done when a graph change is accepted after it in the same turn", () => {
    const { verdicts } = feed(accepted("done"), accepted("graph_change"), pi("agent_settled"));

    expect(verdicts).toStrictEqual([{ kind: "void" }, ended("graph_change")]);
    expect(feed(accepted("graph_change"), accepted("done")).verdicts).toStrictEqual([]);
  });

  it("takes the last accepted call", () => {
    expect(feed(accepted("graph_change"), accepted("done"), pi("agent_settled")).verdicts).toStrictEqual([
      ended("done"),
    ]);
  });

  it("voids a waiting call when pi starts another request, and then nothing stands", () => {
    expect(feed(accepted("done"), pi("turn_start"), pi("agent_settled")).verdicts).toStrictEqual([
      { kind: "void" },
      ended("none"),
    ]);
  });

  it("says nothing when a request begins and no call waits", () => {
    expect(feed(pi("turn_start")).verdicts).toStrictEqual([]);
  });

  it("voids a waiting call when the last message is an error", () => {
    expect(
      feed(accepted("done"), pi("agent_end", { messages: [assistant("error")] }), pi("agent_settled")).verdicts,
    ).toStrictEqual([{ kind: "void" }, ended("error")]);
  });

  it("looks at the last assistant message only: an earlier error pi got over does not count", () => {
    expect(
      feed(
        pi("agent_end", { messages: [assistant("error")] }),
        pi("agent_end", { messages: [assistant("error"), { role: "user" }, assistant("stop")] }),
        pi("agent_settled"),
      ).verdicts,
    ).toStrictEqual([ended("none")]);
  });

  it("ends in an error when pi gave up retrying, whatever the last message says", () => {
    expect(feed(pi("auto_retry_end", { success: false }), pi("agent_settled")).verdicts).toStrictEqual([
      ended("error"),
    ]);
    expect(feed(pi("auto_retry_end", { success: true }), pi("agent_settled")).verdicts).toStrictEqual([ended("none")]);
  });

  it("looks at aborted before the error a stop also prints, and voids what waited", () => {
    expect(
      feed(
        accepted("done"),
        pi("turn_start"),
        accepted("done"),
        pi("agent_end", { messages: [assistant("error")] }),
        pi("agent_settled", { aborted: true }),
      ).verdicts,
    ).toStrictEqual([{ kind: "void" }, { kind: "void" }, ended("stopped")]);
  });

  it("is stopped, not failed, when an aborted run printed an error with nothing waiting", () => {
    expect(
      feed(pi("agent_end", { messages: [assistant("error")] }), pi("agent_settled", { aborted: true })).verdicts,
    ).toStrictEqual([ended("stopped")]);
  });

  it("ends with none when the turn ends normally and nothing waits", () => {
    expect(feed(pi("agent_settled")).verdicts).toStrictEqual([ended("none")]);
  });

  it("tracks whether a run is going, and forgets everything when it settles", () => {
    expect(feed(pi("agent_start")).state.running).toBe(true);
    expect(feed(pi("agent_start"), pi("agent_settled")).state).toStrictEqual(JUDGE_START);
    expect(feed(pi("turn_start")).state.running).toBe(true);
  });

  it("ignores other events", () => {
    const { state, verdicts } = feed(accepted("done"), pi("message_update"), pi("tool_execution_end"));

    expect(verdicts).toStrictEqual([]);
    expect(state.pending).toBe("done");
  });
});
