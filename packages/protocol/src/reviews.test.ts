import { describe, expect, it } from "vitest";
import { CommandResult, COMMAND_TYPES } from "./commands";
import { IDLE_CONTROL, Control } from "./control";
import { ErrorCode } from "./errors";
import {
  Evidence,
  GateKind,
  PendingReview,
  ReviewAction,
  ReviewRecord,
  ReviewSource,
  ReviewSubject,
  Verdict,
} from "./reviews";
import { Notice } from "./transcript";

/** A review of a human node. */
const review = {
  id: "tsk_a:human:H:1",
  openedAt: 5,
  source: { kind: "gate", gate: "task_human" },
  subject: { code: "task_human_node", params: { taskId: "tsk_a", node: "H", merge: false } },
  evidence: [],
  problem: null,
  actions: [{ id: "pass", reason: "none", targets: [], recommended: true }],
};

describe("the shape of a review (ADR-0017)", () => {
  it("names the gates of the host's flow, and takes an agent's request as a source too", () => {
    expect(GateKind.options).toStrictEqual(["task_graph", "task_human", "task_archive"]);
    expect(ReviewSource.safeParse({ kind: "gate", gate: "task_archive" }).success).toBe(true);
    expect(ReviewSource.safeParse({ kind: "agent", toolCallId: "call-1" }).success).toBe(true);
    expect(ReviewSource.safeParse({ kind: "gate", gate: "push" }).success).toBe(false);
    expect(ReviewSource.safeParse({ kind: "agent" }).success).toBe(false);
  });

  it("carries a code and parameters for a gate's subject and quoted text for an agent's, never both", () => {
    expect(ReviewSubject.safeParse({ code: "task_archive", params: { taskId: "tsk_a" } }).success).toBe(true);
    expect(ReviewSubject.safeParse({ text: "Push the branch?" }).success).toBe(true);
    expect(ReviewSubject.safeParse({ code: "task_archive", params: {}, text: "x" }).success).toBe(false);
    expect(ReviewSubject.safeParse({ code: "", params: {} }).success).toBe(false);
  });

  it("holds four kinds of evidence, and only the host's facts have a status", () => {
    const facts = { kind: "facts", facts: [{ code: "worktree_dirty", params: { name: "x" }, status: "warn" }] };
    const changes = { kind: "changes", workspaceId: "wks_0123456789abcdef", files: 1, added: 2, removed: 3 };
    const diff = { kind: "graph_diff", from: null, to: 1, added: ["N1"], removed: [], changed: [] };
    const summary = { kind: "summary", by: { kind: "agent" }, text: "Two commits." };

    for (const one of [facts, changes, diff, summary]) expect(Evidence.safeParse(one).success).toBe(true);
    expect(Evidence.safeParse({ kind: "facts", facts: [{ code: "x", params: {}, status: "great" }] }).success).toBe(
      false,
    );
    expect(Evidence.safeParse({ ...summary, status: "ok" }).success).toBe(false);
    expect(Evidence.safeParse({ ...changes, workspaceId: "nope" }).success).toBe(false);
    expect(Evidence.safeParse({ kind: "preview", text: "x" }).success).toBe(false);
  });

  it("holds a review, its buttons and a verdict, and refuses what has extra fields or no button", () => {
    expect(PendingReview.safeParse(review).success).toBe(true);
    expect(PendingReview.safeParse({ ...review, actions: [] }).success).toBe(false);
    expect(PendingReview.safeParse({ ...review, extra: 1 }).success).toBe(false);
    expect(
      PendingReview.safeParse({ ...review, problem: { code: "merge_conflict", params: {}, files: ["a.ts"] } }).success,
    ).toBe(true);
    expect(ReviewAction.safeParse({ id: "x", reason: "maybe", targets: [], recommended: false }).success).toBe(false);
    expect(
      ReviewAction.safeParse({
        id: "send_back",
        reason: "required",
        targets: [{ id: "N1", remaining: null }],
        recommended: false,
      }).success,
    ).toBe(true);
    expect(Verdict.safeParse({ action: "send_back", target: "N1", reason: "again" }).success).toBe(true);
    expect(Verdict.safeParse({ action: "" }).success).toBe(false);
    expect(Verdict.safeParse({ action: "pass", note: "x" }).success).toBe(false);
  });

  it("is part of a session's control, empty when idle, and of the notices the conversation keeps", () => {
    expect(IDLE_CONTROL.reviews).toStrictEqual([]);
    expect(Control.safeParse({ ...IDLE_CONTROL, reviews: [review] }).success).toBe(true);
    const { reviews: _reviews, ...without } = IDLE_CONTROL;
    expect(Control.safeParse(without).success).toBe(false);

    const record = { source: review.source, subject: review.subject, evidence: [], verdict: { action: "pass" } };
    expect(ReviewRecord.safeParse(record).success).toBe(true);
    expect(Notice.safeParse({ kind: "notice", id: "n", notice: "review", review: record, timestamp: 1 }).success).toBe(
      true,
    );
  });

  it("has its command and its two error codes", () => {
    expect(COMMAND_TYPES).toContain("answer_review");
    expect(CommandResult.answer_review.parse({})).toStrictEqual({});
    expect(ErrorCode.options).toContain("review_closed");
    expect(ErrorCode.options).toContain("review_invalid");
  });
});
