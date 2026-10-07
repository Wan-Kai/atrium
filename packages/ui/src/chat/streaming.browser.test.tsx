import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import "../styles.css";
import { Markdown } from "./markdown";
import showcase from "./reply-showcase.md?raw";

/**
 * Splits text into pieces of 2 to 9 characters, like the deltas a model streams.
 *
 * @remarks
 * A fixed pattern rather than randomness, so every run cuts in the same places.
 */
function deltas(text: string): string[] {
  const pieces: string[] = [];
  for (let start = 0, step = 0; start < text.length; step += 1) {
    const size = 2 + ((step * 7) % 8);
    pieces.push(text.slice(start, start + size));
    start += size;
  }
  return pieces;
}

/**
 * Waits until the asynchronous parts have rendered: formulas, highlighted code and the diagram.
 *
 * @remarks
 * Streamdown draws a diagram only once it is on screen, so the block is scrolled into view.
 */
async function settled(root: HTMLElement): Promise<void> {
  await vi.waitFor(
    () => {
      root.querySelector('[data-streamdown="mermaid-block"]')?.scrollIntoView();
      expect(root.querySelectorAll(".katex")).toHaveLength(2);
      expect(root.querySelectorAll("pre span[style]").length).toBeGreaterThan(0);
      expect(root.querySelector("svg[id^='mermaid']")).not.toBeNull();
    },
    { timeout: 20_000 },
  );
}

/**
 * The rendered HTML, comparable across renders.
 *
 * @remarks
 * Mermaid's element ids are random, and an element that carried a style while streaming keeps an
 * empty `style=""`, which changes nothing on screen.
 */
function normalized(root: HTMLElement): string {
  return root.innerHTML.replaceAll(/mermaid-[0-9a-z-]+/g, "mermaid-id").replaceAll(' style=""', "");
}

describe("streaming the reply showcase", () => {
  it("renders every prefix without failing, and ends exactly as rendering it at once does", async () => {
    const once = await render(<Markdown text={showcase} streaming={false} />);
    await settled(once.container);
    const expected = normalized(once.container);
    await once.unmount();

    const streamed = await render(<Markdown text="" streaming />);
    let text = "";
    for (const delta of deltas(showcase)) {
      text += delta;
      await streamed.rerender(<Markdown text={text} streaming />);
    }
    await streamed.rerender(<Markdown text={showcase} streaming={false} />);
    await settled(streamed.container);

    expect(text).toBe(showcase);
    expect(normalized(streamed.container)).toBe(expected);
  }, 60_000);
});
