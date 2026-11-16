import { describe, expect, it } from "vitest";
import { StudyLevel } from "./study";
import { seenLength, seenText, splitSeen } from "./text";

/** A family emoji: seven UTF-16 units joined by zero-width joiners, one character as seen. */
const FAMILY = "👨‍👩‍👧";

describe("characters as seen (SPEC-0008, ML2)", () => {
  it("counts a joined emoji, a flag and a combining accent as one each", () => {
    expect([FAMILY, "🇨🇳", "é", "所有权", ""].map(seenLength)).toStrictEqual([1, 1, 1, 3, 0]);
    expect(splitSeen(`a${FAMILY}b`)).toStrictEqual(["a", FAMILY, "b"]);
  });

  it("bounds a text by what a reader sees, not by UTF-16 units", () => {
    const three = seenText(3);

    expect(three.safeParse(FAMILY.repeat(3)).success).toBe(true);
    expect(three.safeParse(FAMILY.repeat(4)).success).toBe(false);
    expect(three.safeParse("").success).toBe(true);
    expect(seenText(3, 1).safeParse("").success).toBe(false);
    expect(seenText(3, 1).safeParse(1).success).toBe(false);
  });
});

describe("the progress the list carries", () => {
  it("takes a level's name of 60 characters as seen, however many units", () => {
    const level = { id: "l1", topics: "", pass: "", state: "current" } as const;

    expect(StudyLevel.safeParse({ ...level, name: FAMILY.repeat(60) }).success).toBe(true);
    expect(StudyLevel.safeParse({ ...level, name: FAMILY.repeat(61) }).success).toBe(false);
  });
});
