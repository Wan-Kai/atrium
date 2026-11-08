import type { PendingReview, ReviewAction } from "@atrium/protocol";
import { describe, expect, it } from "vitest";
import {
  NO_DRAFT,
  forgetReviewDrafts,
  needsForm,
  orderedActions,
  readReviewDraft,
  verdictOf,
  writeReviewDraft,
} from "./review-state";

const pass: ReviewAction = { id: "pass", reason: "none", targets: [], recommended: true };
const back = (targets: ReviewAction["targets"], reason: ReviewAction["reason"] = "required"): ReviewAction => ({
  id: "send_back",
  reason,
  targets,
  recommended: false,
});

describe("needsForm", () => {
  it("is true for a button that takes a reason or a target and false for one that takes neither", () => {
    expect(needsForm(pass)).toBe(false);
    expect(needsForm({ ...pass, reason: "optional" })).toBe(true);
    expect(needsForm(back([{ id: "N2", remaining: 1 }], "none"))).toBe(true);
  });
});

describe("verdictOf", () => {
  it("is the bare verdict for a button that takes nothing, even with text lying in the draft", () => {
    expect(verdictOf(pass, { open: null, target: "N2", reason: "ignored" })).toStrictEqual({ action: "pass" });
  });

  it("needs a required reason with a word in it, and trims it", () => {
    const action = back([{ id: "N2", remaining: 2 }]);
    expect(verdictOf(action, { ...NO_DRAFT, reason: "   " })).toBeNull();
    expect(verdictOf(action, { ...NO_DRAFT, reason: " 补测试 " })).toStrictEqual({
      action: "send_back",
      target: "N2",
      reason: "补测试",
    });
  });

  it("takes the one target left by itself but makes you choose among several", () => {
    const action = back([
      { id: "N1", remaining: 0 },
      { id: "N2", remaining: 1 },
    ]);
    expect(verdictOf(action, { ...NO_DRAFT, reason: "x" })).toMatchObject({ target: "N2" });
    const several = back([
      { id: "N2", remaining: 1 },
      { id: "N3", remaining: 2 },
    ]);
    expect(verdictOf(several, { ...NO_DRAFT, reason: "x" })).toBeNull();
    expect(verdictOf(several, { open: null, target: "N3", reason: "x" })).toMatchObject({ target: "N3" });
  });

  it("refuses a target with nothing left and a target that is not listed", () => {
    const action = back([
      { id: "N1", remaining: 0 },
      { id: "N2", remaining: 1 },
      { id: "N3", remaining: 1 },
    ]);
    expect(verdictOf(action, { open: null, target: "N1", reason: "x" })).toBeNull();
    expect(verdictOf(action, { open: null, target: "N9", reason: "x" })).toBeNull();
  });

  it("sends an optional reason only when written", () => {
    const action: ReviewAction = { id: "reject", reason: "optional", targets: [], recommended: false };
    expect(verdictOf(action, NO_DRAFT)).toStrictEqual({ action: "reject" });
    expect(verdictOf(action, { ...NO_DRAFT, reason: "不要" })).toStrictEqual({ action: "reject", reason: "不要" });
  });

  it("sends a target that has no limit (remaining null)", () => {
    const action = back([{ id: "N2", remaining: null }], "none");
    expect(verdictOf(action, NO_DRAFT)).toStrictEqual({ action: "send_back", target: "N2" });
  });
});

const review = (actions: ReviewAction[]): PendingReview => ({
  id: "r",
  openedAt: 0,
  source: { kind: "gate", gate: "task_archive" },
  subject: { code: "task_archive", params: {} },
  evidence: [],
  problem: null,
  actions,
});

describe("orderedActions", () => {
  it("puts the recommended buttons first and keeps the host's order among the rest, and among all when none is", () => {
    const keep: ReviewAction = { id: "keep", reason: "none", targets: [], recommended: true };
    const archive: ReviewAction = { id: "archive", reason: "none", targets: [], recommended: false };
    const other: ReviewAction = { id: "other", reason: "none", targets: [], recommended: false };
    expect(orderedActions(review([archive, other, keep])).map((action) => action.id)).toStrictEqual([
      "keep",
      "archive",
      "other",
    ]);
    // The first is not the host's advice for being first (T8 review fix 10).
    expect(
      orderedActions(review([archive, other, { ...keep, recommended: false }])).map((action) => action.id),
    ).toStrictEqual(["archive", "other", "keep"]);
  });
});

describe("the drafts kept for cards not answered yet", () => {
  it("keeps one per session and review, forgets an emptied one, and forgets those whose review is gone", () => {
    writeReviewDraft("s9", "r1", { open: "send_back", target: null, reason: "半句" });
    writeReviewDraft("s9", "r2", { open: null, target: null, reason: "另一张" });
    expect(readReviewDraft("s9", "r1").reason).toBe("半句");
    expect(readReviewDraft("s8", "r1")).toBe(NO_DRAFT);

    forgetReviewDrafts("s9", ["r2"]);
    expect(readReviewDraft("s9", "r1")).toBe(NO_DRAFT);
    expect(readReviewDraft("s9", "r2").reason).toBe("另一张");

    writeReviewDraft("s9", "r2", NO_DRAFT);
    expect(readReviewDraft("s9", "r2")).toBe(NO_DRAFT);
  });
});
