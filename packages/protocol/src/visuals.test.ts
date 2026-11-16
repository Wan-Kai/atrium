import { describe, expect, it } from "vitest";
import { CommandResult } from "./commands";
import { ErrorCode } from "./errors";
import { Turn } from "./transcript";
import { VISUAL_MESSAGE_MAX, VisualChangedEvent, VisualSource } from "./visuals";

/** A user message as the host sends it, before any source. */
const user = { text: "选 B", images: 0, clientMessageId: "r1", auto: false, command: null, timestamp: 1 };

/** A turn around `user`. */
const turn = {
  kind: "turn",
  id: "s1:e1",
  source: null,
  user,
  steps: [],
  outcome: "done",
  error: null,
  startedAt: 1,
  durationMs: 1,
  usage: null,
  changes: [],
};

describe("visual protocol", () => {
  it("limits a message from a visual to 4000 characters (SPEC-0007, 回传)", () => {
    expect(VISUAL_MESSAGE_MAX).toBe(4000);
  });

  it("only hands out addresses on the visual scheme", () => {
    expect(CommandResult.resolve_visual.safeParse({ url: "https://evil.test/a.html", size: 1, mtime: 1 }).success).toBe(
      false,
    );
    expect(
      CommandResult.resolve_visual.safeParse({ url: "atrium-visual://t/a.html", size: -1, mtime: 1 }).success,
    ).toBe(false);
    expect(
      CommandResult.resolve_visual.safeParse({ url: "atrium-visual://t/a.html", size: 1024 * 1024 + 1, mtime: 1 })
        .success,
    ).toBe(false);
  });

  it("knows the visual dispositions and nothing else", () => {
    expect(CommandResult.send_visual_message.safeParse({ disposition: "paused" }).success).toBe(false);
    expect(CommandResult.send_visual_message.parse({ disposition: "dropped" })).toStrictEqual({
      disposition: "dropped",
    });
  });

  it("marks a user message from a visual, and only that kind of source", () => {
    const marked = { ...turn, user: { ...user, source: { kind: "visual", path: "a.html" } } };
    expect(Turn.parse(marked)).toStrictEqual(marked);
    expect(Turn.parse(turn)).toStrictEqual(turn);
    expect(Turn.safeParse({ ...turn, user: { ...user, source: { kind: "task", path: "a.html" } } }).success).toBe(
      false,
    );
    expect(VisualSource.safeParse({ kind: "visual", path: "" }).success).toBe(false);
  });

  it("tells a changed file by its session and path", () => {
    expect(
      VisualChangedEvent.safeParse({ type: "visual_changed", sessionId: "s1", path: "a.html", mtime: -1 }).success,
    ).toBe(false);
  });

  it("tells a changed file by the session or the direction it was resolved for, exactly one (SPEC-0008, ML4)", () => {
    const at = { type: "visual_changed", path: "visuals/1-01-a.html", mtime: 1 };
    expect(VisualChangedEvent.parse({ ...at, directionId: "lrn_rust" })).toStrictEqual({
      ...at,
      directionId: "lrn_rust",
    });
    expect(VisualChangedEvent.safeParse(at).success).toBe(false);
    expect(VisualChangedEvent.safeParse({ ...at, sessionId: "s1", directionId: "lrn_rust" }).success).toBe(false);
    expect(VisualChangedEvent.safeParse({ ...at, directionId: "wks_0123456789abcdef" }).success).toBe(false);
  });

  it("has an error code for each refusal of a file", () => {
    for (const code of ["visual_outside", "visual_missing", "visual_too_large"]) {
      expect(ErrorCode.safeParse(code).success).toBe(true);
    }
  });
});
