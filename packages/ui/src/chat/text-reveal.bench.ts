import { compareWithBaseline } from "@atrium/testkit";
import { expect, test } from "vitest";
import { REVEAL_FRAME_MS, advanceReveal, beginReveal, retargetReveal, revealSettled, visibleText } from "./text-reveal";

/** A long reply with Chinese, emoji and combined characters, as the reveal sees it while streaming. */
const LONG_REPLY = "流式输出 streaming 😀 👨‍👩‍👧 🇨🇳 ".repeat(2_000);

/**
 * Reveals the whole reply frame by frame, cutting the visible text every frame.
 *
 * @remarks
 * The visible text is cut at a grapheme boundary each frame, the costly part on long replies.
 */
function revealAll(): void {
  let state = retargetReveal(beginReveal(""), LONG_REPLY);
  while (!revealSettled(state)) {
    state = advanceReveal(state, REVEAL_FRAME_MS);
    visibleText(state, true);
  }
}

test("revealing a long reply frame by frame stays near its baseline speed", async ({ bench }) => {
  const ratio = await compareWithBaseline(bench, "reveal long reply", ".bench/ui/text-reveal.json", revealAll);

  expect(ratio).toBeLessThan(3);
});
