import { describe, expect, it } from "vitest";
import {
  REVEAL_FRAME_MS,
  REVEAL_HORIZON_MS,
  advanceReveal,
  beginReveal,
  retargetReveal,
  revealSettled,
  visibleText,
} from "./text-reveal";

describe("text reveal", () => {
  it("shows text it first sees whole, and paces only what arrives afterwards", () => {
    const started = beginReveal("Hello");

    const grown = retargetReveal(started, "Hello, world");

    expect(visibleText(started, true)).toBe("Hello");
    expect(grown).toStrictEqual({ target: "Hello, world", revealed: 5 });
    expect(visibleText(grown, true)).toBe("Hello");
    expect(revealSettled(grown)).toBe(false);
    expect(retargetReveal(grown, "Hello, world")).toBe(grown);
  });

  it("reveals in proportion to the backlog: about two thirds per horizon, then the tail", () => {
    let state = retargetReveal(beginReveal(""), "x".repeat(90));
    const shown: number[] = [];
    while (!revealSettled(state)) {
      state = advanceReveal(state, REVEAL_FRAME_MS);
      shown.push(state.revealed);
    }

    expect(shown.slice(0, 3)).toStrictEqual([10, 19, 27]);
    // Nine frames make one horizon of 150 ms.
    expect(shown[Math.round(REVEAL_HORIZON_MS / REVEAL_FRAME_MS) - 1]).toBe(61);
    expect(shown).toHaveLength(25);
    expect(state.revealed).toBe(90);
  });

  it("reveals at least one unit per frame, everything after a long stall, and nothing without time", () => {
    const state = retargetReveal(beginReveal(""), "abc");

    expect(advanceReveal(state, 1).revealed).toBe(1);
    expect(advanceReveal(state, REVEAL_HORIZON_MS).revealed).toBe(3);
    expect(advanceReveal(state, 10_000).revealed).toBe(3);
    expect(advanceReveal(state, 0)).toBe(state);
    const done = beginReveal("done");
    expect(advanceReveal(done, 16)).toBe(done);
  });

  it("caps a stalled frame, so a long pause reveals no more than a 250 ms frame would", () => {
    const state = retargetReveal(beginReveal(""), "x".repeat(10_000));

    expect(advanceReveal(state, 5_000).revealed).toBe(10_000);
    expect(advanceReveal({ target: "x".repeat(1000), revealed: 0 }, 100).revealed).toBe(667);
  });

  it("keeps the shown part when another message takes the place", () => {
    const state = { target: "a long first message", revealed: 12 };

    expect(retargetReveal(state, "short")).toStrictEqual({ target: "short", revealed: 5 });
  });

  it("never cuts a character in half, moving the cut back to where it starts", () => {
    const family = "👨‍👩‍👧";
    const text = `ab${family}cd`;

    expect(visibleText({ target: text, revealed: 3 }, true)).toBe("ab");
    expect(visibleText({ target: text, revealed: 2 + family.length }, true)).toBe(`ab${family}`);
    expect(visibleText({ target: text, revealed: 0 }, true)).toBe("");
  });

  it("holds back exactly the unfinished character, at the edges of the surrogate range too", () => {
    expect(visibleText(beginReveal("abc\ud800"), true)).toBe("abc");
    expect(visibleText(beginReveal("abc\udbff"), true)).toBe("abc");
    expect(visibleText(beginReveal("abc\udc00"), true)).toBe("abc\udc00");
    expect(visibleText(beginReveal("abc\u200d"), true)).toBe("abc");
    expect(visibleText(beginReveal("🇨"), true)).toBe("");
    expect(visibleText(beginReveal("abc🇨"), true)).toBe("abc");
    expect(visibleText(beginReveal("🇨🇳🇯"), true)).toBe("🇨🇳");
    expect(visibleText(beginReveal("plain text"), true)).toBe("plain text");
    expect(visibleText(beginReveal("abc🇦"), true)).toBe("abc");
    expect(visibleText(beginReveal("abc🇿"), true)).toBe("abc");
    expect(visibleText(beginReveal("abc😀"), true)).toBe("abc😀");
    expect(visibleText(beginReveal("ab"), true)).toBe("ab");
  });

  it("holds back a character that is still arriving, until streaming ends", () => {
    const highSurrogate = "😀".slice(0, 1);
    const halfFlag = "🇨🇳".slice(0, 2);

    expect(visibleText(beginReveal(`a${highSurrogate}`), true)).toBe("a");
    expect(visibleText(beginReveal("a‍"), true)).toBe("a");
    expect(visibleText(beginReveal(`a${halfFlag}`), true)).toBe("a");
    expect(visibleText(beginReveal("a🇨🇳"), true)).toBe("a🇨🇳");
    expect(visibleText(beginReveal(`a${highSurrogate}`), false)).toBe(`a${highSurrogate}`);
    expect(visibleText(beginReveal(""), true)).toBe("");
  });
});
