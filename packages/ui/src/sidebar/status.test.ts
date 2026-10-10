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
    containerId: "chats",
    name: null,
    prompt: sessionId,
    file: `/pi/${sessionId}.jsonl`,
    state: "persisted",
    updatedAt: 1,
    archived: false,
    running: false,
    attention: null,
    asking: null,
    handedOff: false,
    ...fields,
  };
}

/** An error set at `at`, seen or not. */
const error = (at: number, cleared = false) => ({ attention: { reason: "error", at, cleared } as const });
/** A sign-in problem set at `at`; a look does not clear it, but the list may say so. */
const auth = (at: number, cleared = false) => ({ attention: { reason: "auth", at, cleared } as const });

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
});

describe("topStatus", () => {
  it("takes the highest", () => {
    expect(topStatus(["running", "error", null])).toBe("error");
    expect(topStatus(["running", "auth", "error"])).toBe("auth");
    expect(topStatus(["auth", "asking", "running"])).toBe("asking");
    expect(topStatus([null, "running"])).toBe("running");
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
    ]);

    expect(inbox.map((entry) => [entry.session.sessionId, entry.status, entry.at])).toStrictEqual([
      ["question", "asking", 1],
      ["signin", "auth", 5],
      ["signin-seen", "auth", 3],
      ["new-error", "error", 40],
      ["old-error", "error", 10],
    ]);
    expect(INBOX_SHOWN).toBe(5);
  });
});
