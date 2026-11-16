import type { SessionSummary } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import { INBOX_SHOWN, inboxOf, sessionStatus, topStatus } from "./status";

/**
 * An idle session on file with `fields` changed.
 *
 * @remarks
 * Only the fields the status reads matter.
 *
 * @sideEffects none
 * @param sessionId - Its id.
 * @param fields - Fields to set.
 * @returns The session.
 */
function session(sessionId: string, fields: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId,
    containerId: "cht_a",
    name: null,
    prompt: sessionId,
    file: `/pi/${sessionId}.jsonl`,
    state: "persisted",
    updatedAt: 1,
    archived: false,
    running: false,
    attention: null,
    asking: null,
    question: null,
    model: null,
    parent: null,
    agent: null,
    heldDeliveries: 0,
    kickoff: null,
    study: null,
    ...fields,
  };
}

/** An error set at `at`, seen or not. */
const error = (at: number, cleared = false) => ({ attention: { reason: "error", at, cleared, text: null } as const });
/** A sign-in problem set at `at`; a look does not clear it, but the list may say so. */
const auth = (at: number, cleared = false) => ({ attention: { reason: "auth", at, cleared, text: null } as const });
/** A run finished at `at`; a look clears it, at once. */
const finished = (at: number, cleared = false) => ({
  attention: { reason: "finished", at, cleared, text: null } as const,
});

describe("sessionStatus", () => {
  it("puts a question above sign-in, sign-in above an error seen or not, and an error above running", () => {
    expect(
      [
        session("a", { asking: 5, ...auth(1), running: true }),
        session("b", { ...auth(1), running: true }),
        session("c", { ...error(1), running: true }),
        session("d", { ...error(1, true), running: true }),
        session("e", { running: true }),
        session("f"),
      ].map(sessionStatus),
    ).toStrictEqual(["asking", "auth", "error", "error", "running", null]);
  });

  it("shows a finished run below a run going on, until a look clears it", () => {
    expect(
      [
        session("a", { ...finished(1) }),
        session("b", { ...finished(1), running: true }),
        session("c", { ...finished(1, true) }),
        session("d", { ...finished(1, true), running: true }),
        session("e", { ...finished(1), asking: 2 }),
      ].map(sessionStatus),
    ).toStrictEqual(["finished", "running", null, "running", "asking"]);
  });
});

describe("topStatus", () => {
  it("takes the highest", () => {
    expect(topStatus(["running", "error", null])).toBe("error");
    expect(topStatus(["running", "auth", "error"])).toBe("auth");
    expect(topStatus(["auth", "asking", "running"])).toBe("asking");
    expect(topStatus([null, "running"])).toBe("running");
    expect(topStatus(["finished", null])).toBe("finished");
    expect(topStatus(["running", "finished"])).toBe("running");
    expect(topStatus([null])).toBeNull();
    expect(topStatus([])).toBeNull();
  });
});

describe("inboxOf", () => {
  it("collects sessions waiting for an answer, a sign-in (seen or not) or a look at an error, by priority then newest", () => {
    const inbox = inboxOf([
      session("old-error", error(10)),
      session("seen", error(50, true)),
      session("running", { running: true }),
      session("new-error", error(40)),
      session("archived", { ...error(60), archived: true }),
      session("signin", auth(5)),
      session("signin-seen", auth(3, true)),
      session("question", { asking: 1, ...error(70) }),
      // A finished run waits for nothing: it shows a dot in the list, never here (SPEC-0005, 协议 40).
      session("finished", finished(80)),
      session("finished-seen", finished(90, true)),
    ]);

    expect(inbox.map((entry) => [entry.session.sessionId, entry.status, entry.at])).toStrictEqual([
      ["question", "asking", 1],
      ["signin", "auth", 5],
      ["signin-seen", "auth", 3],
      ["new-error", "error", 40],
      ["old-error", "error", 10],
    ]);
    expect(INBOX_SHOWN).toBe(3);
  });
});
