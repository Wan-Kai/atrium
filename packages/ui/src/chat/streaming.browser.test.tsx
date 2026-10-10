import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import "../styles.css";
import type { SessionView } from "@atrium/client";
import { type Turn, IDLE_CONTROL, UNKNOWN_METRICS } from "@atrium/protocol";
import { Markdown } from "./markdown";
import { Transcript } from "./transcript";
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

/** The transcript of session s1 at one moment, in a 600 px box. */
function transcriptAt(fields: Partial<SessionView>) {
  return (
    <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
      <Transcript
        view={{
          sessionId: "s1",
          status: "ready",
          control: IDLE_CONTROL,
          model: null,
          metrics: UNKNOWN_METRICS,
          epoch: 1,
          seq: 0,
          items: [],
          hasOlder: false,
          run: null,
          pending: [],
          ...fields,
        }}
        onLoadOlder={() => undefined}
        onLoadStep={() => undefined}
      />
    </div>
  );
}

/** How many characters of the reply are on screen. */
function replyTextLength(root: HTMLElement): number {
  return root.querySelector('[data-testid="reply"]')?.textContent?.length ?? 0;
}

/** The reply's HTML, comparable across renders. */
function replyHtml(root: HTMLElement): string {
  const reply = root.querySelector<HTMLElement>('[data-testid="reply"]');
  return normalized(reply ?? root).replace(' data-streaming="false"', "");
}

/** A turn answered with `text`, running or done. */
function answered(text: string, outcome: Turn["outcome"]): Turn {
  return {
    kind: "turn",
    id: "t1",
    user: { text: "展示一下", images: 0, clientMessageId: null, auto: false, timestamp: 0 },
    steps: text === "" ? [] : [{ kind: "text", id: "0", text }],
    outcome,
    error: null,
    startedAt: 0,
    durationMs: outcome === "running" ? null : 1000,
    usage: null,
    changes: [],
  };
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

  it("streams through the transcript as the app does, never losing text, and ends as the finished reply renders", async () => {
    const finished = answered(showcase, "done");
    const run = { runId: "r1", startedAt: Date.now() };
    // The same layout both times, since the diagram scales to the width it gets.
    const once = await render(transcriptAt({ items: [finished] }));
    await settled(once.container);
    const expected = replyHtml(once.container);
    await once.unmount();

    const screen = await render(transcriptAt({ run, items: [answered("", "running")] }));
    const lengths: number[] = [];
    let text = "";
    for (const delta of deltas(showcase)) {
      text += delta;
      await screen.rerender(transcriptAt({ run, items: [answered(text, "running")] }));
      lengths.push(replyTextLength(screen.container));
    }
    await screen.rerender(transcriptAt({ items: [finished] }));
    await settled(screen.container);

    expect(lengths).toStrictEqual(lengths.toSorted((a, b) => a - b));
    expect(replyHtml(screen.container)).toBe(expected);
  }, 60_000);
});
