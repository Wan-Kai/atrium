import { describe, expect, it } from "vitest";
import { afterGrowth, afterScroll, atBottom } from "./follow-bottom";

describe("follow bottom", () => {
  it("counts the last 24 pixels as the bottom", () => {
    expect(atBottom({ scrollTop: 476, scrollHeight: 1000, clientHeight: 500 })).toBe(true);
    expect(atBottom({ scrollTop: 475, scrollHeight: 1000, clientHeight: 500 })).toBe(false);
    expect(atBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 500 })).toBe(true);
  });

  it("stops following when scrolled up, keeping the dot, and resumes at the bottom, clearing it", () => {
    const up = { scrollTop: 0, scrollHeight: 1000, clientHeight: 500 };
    const bottom = { scrollTop: 500, scrollHeight: 1000, clientHeight: 500 };

    expect(afterScroll({ following: true, unseen: false }, up)).toStrictEqual({ following: false, unseen: false });
    expect(afterScroll({ following: false, unseen: true }, up)).toStrictEqual({ following: false, unseen: true });
    expect(afterScroll({ following: false, unseen: true }, bottom)).toStrictEqual({ following: true, unseen: false });
  });

  it("keeps following when content grows, and marks it unseen otherwise", () => {
    const following = { following: true, unseen: false };

    expect(afterGrowth(following)).toBe(following);
    expect(afterGrowth({ following: false, unseen: false })).toStrictEqual({ following: false, unseen: true });
  });
});
