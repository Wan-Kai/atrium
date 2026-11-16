import { CommandError } from "@atrium/client";
import { FakeClock } from "@atrium/testkit/clock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ClockContext, type UiClock } from "../state/clock";
import { Markdown } from "./markdown";
import { type VisualRect, type VisualsAccess, VisualsContext } from "./visual-card";
import "../styles.css";

/**
 * A stand-in for the host's frame: it asks for the theme, reports a height that says which theme
 * it got, sends a message on its own at once, and again when its button is clicked.
 *
 * @remarks
 * The real frame is the host's `visualPage`; this one speaks the same JSON-RPC, so the card's side
 * is what is tested. Dark reports 222, light 111.
 */
const FRAME = `<!doctype html><html><body style="margin:0">
<button id="pick" style="width:200px;height:60px">选 B</button>
<script>
let id = 0;
const replies = [];
const send = (text) => parent.postMessage({ jsonrpc: "2.0", id: ++id, method: "ui/message", params: { role: "user", content: { type: "text", text } } }, "*");
const height = (context) => parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: context && context.theme === "dark" ? 222 : 111 } }, "*");
addEventListener("message", (event) => {
  const data = event.data;
  if (data.id === 1) height(data.result.hostContext);
  else if (data.method === "ui/notifications/host-context-changed") height(data.params);
  else if (data.id !== undefined) document.title = (data.error ? "refused " : "sent ") + data.id;
});
parent.postMessage({ jsonrpc: "2.0", id: ++id, method: "ui/initialize", params: {} }, "*");
send("自己发的");
document.getElementById("pick").addEventListener("click", () => send("选 B"));
</script></body></html>`;

/** The frame's address, as a `data:` page; the card's `?v=` lands in the page as text, harmlessly. */
const FRAME_URL = `data:text/html,${encodeURIComponent(FRAME)}`;

afterEach(() => {
  document.documentElement.classList.remove("dark");
});

/**
 * A session's visuals for one test, recording what the card asked.
 *
 * @remarks
 * The resolver answers from `answers` in order, the last one repeating.
 *
 * @sideEffects none
 * @param answers - What each resolve gives: an address and time, or a refusal's code.
 * @param capture - The page capture, if any.
 * @returns The access, what was sent, and a way to say the file changed.
 */
function visuals(
  answers: readonly ({ url: string; mtime: number } | Refusal)[],
  capture: ((rect: VisualRect) => Promise<string | null>) | null = null,
) {
  const sent: [string, string][] = [];
  const resolved: string[] = [];
  const listeners = new Set<(path: string) => void>();
  let next = 0;
  const access: VisualsAccess = {
    owner: "s1",
    hold: () => () => undefined,
    async resolve(path) {
      resolved.push(path);
      const answer = answers[Math.min(next, answers.length - 1)];
      next += 1;
      if (typeof answer === "string" || answer === undefined) throw new CommandError(answer ?? "visual_missing");
      return answer;
    },
    async send(path, text) {
      sent.push([path, text]);
      return { disposition: "started" };
    },
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    capture,
    presses: null,
    open: (path) => (path === "visuals/a.html" ? () => undefined : null),
  };
  return { access, sent, resolved, change: (path: string) => listeners.forEach((listener) => listener(path)) };
}

/** A code the host refuses a visual with. */
type Refusal = ConstructorParameters<typeof CommandError>[0];

/** A reply with one visual block. */
const REPLY = '先看这一步：\n\n```visual\n{"path":"visuals/a.html","title":"隔离级别"}\n```\n\n然后点一个答案。';

describe("an inline visual out of view", () => {
  it("unloads the frame out of view, showing its snapshot, taken once it was left alone a second", async () => {
    const time = new FakeClock();
    const clock: UiClock = {
      now: () => time.now(),
      every: () => {
        throw new Error("unused");
      },
      after: (ms, run) => time.setTimeout(run, ms),
    };
    const captured: VisualRect[] = [];
    const { access } = visuals([{ url: FRAME_URL, mtime: 1 }], async (rect) => {
      captured.push(rect);
      return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    });
    const screen = await render(
      <ClockContext value={clock}>
        <VisualsContext value={access}>
          <div style={{ height: 400, overflow: "auto" }} data-testid="scroller">
            <Markdown text={REPLY} streaming={false} />
            <div style={{ height: 3000 }} />
          </div>
        </VisualsContext>
      </ClockContext>,
    );
    window.scrollTo(0, 0);
    const body = screen.getByTestId("visual-body");
    await expect.element(screen.getByTestId("visual-frame")).toBeInTheDocument();
    await vi.waitFor(() => expect(body.element().getBoundingClientRect().height).toBe(111));
    time.advance(999);
    expect(captured).toStrictEqual([]);
    time.advance(1);
    await vi.waitFor(() => expect(captured).toHaveLength(1));
    const box = screen.getByTestId("visual-frame").element().getBoundingClientRect();
    expect(captured[0]).toStrictEqual({ x: box.x, y: box.y, width: box.width, height: box.height });

    screen.getByTestId("scroller").element().scrollTop = 2500;

    await expect.element(screen.getByTestId("visual-snapshot")).toBeInTheDocument();
    expect(screen.getByTestId("visual-frame").query()).toBeNull();
    expect(body.element().getBoundingClientRect().height).toBe(111);

    screen.getByTestId("scroller").element().scrollTop = 0;

    await expect.element(screen.getByTestId("visual-frame")).toBeInTheDocument();
  });

  it("shows a frame that never says it started as failed, after 10 s", async () => {
    const time = new FakeClock();
    const { access } = visuals([{ url: "data:text/html,<p>silent</p>", mtime: 1 }]);
    const screen = await render(
      <ClockContext value={clockOf(time)}>
        <VisualsContext value={access}>
          <Markdown text={replyOf("visuals/silent.html")} streaming={false} />
        </VisualsContext>
      </ClockContext>,
    );
    await expect.element(screen.getByTestId("visual-frame")).toBeInTheDocument();

    time.advance(9999);
    expect(screen.getByRole("status").query()).toBeNull();
    time.advance(1);

    await expect.element(screen.getByRole("status")).toHaveTextContent("演示加载失败");
    expect(screen.getByTestId("visual-frame").query()).toBeNull();
  });

  it("takes no snapshot while something lies over the frame", async () => {
    const time = new FakeClock();
    const captured: VisualRect[] = [];
    const { access } = visuals([{ url: FRAME_URL, mtime: 1 }], async (rect) => {
      captured.push(rect);
      return PIXEL;
    });
    const screen = await render(
      <ClockContext value={clockOf(time)}>
        <VisualsContext value={access}>
          <Markdown text={replyOf("visuals/covered.html")} streaming={false} />
          <div style={{ position: "fixed", inset: 0, zIndex: 10 }} data-testid="menu" />
        </VisualsContext>
      </ClockContext>,
    );
    await vi.waitFor(() =>
      expect(screen.getByTestId("visual-body").element().getBoundingClientRect().height).toBe(111),
    );

    time.advance(1000);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(captured).toStrictEqual([]);
  });

  it("shows a snapshot only in the appearance it was taken in, and watches the new frame after a failure", async () => {
    const time = new FakeClock();
    const { access, change } = visuals(
      [{ url: FRAME_URL, mtime: 1 }, "visual_too_large", { url: FRAME_URL, mtime: 2 }],
      async () => PIXEL,
    );
    const screen = await render(
      <ClockContext value={clockOf(time)}>
        <VisualsContext value={access}>
          <div style={{ height: 400, overflow: "auto" }} data-testid="scroller">
            <Markdown text={replyOf("visuals/themed.html")} streaming={false} />
            <div style={{ height: 3000 }} />
          </div>
        </VisualsContext>
      </ClockContext>,
    );
    const scroller = screen.getByTestId("scroller");
    await vi.waitFor(() =>
      expect(screen.getByTestId("visual-body").element().getBoundingClientRect().height).toBe(111),
    );
    time.advance(1000);
    scroller.element().scrollTop = 2500;
    await expect.element(screen.getByTestId("visual-snapshot")).toBeInTheDocument();

    document.documentElement.classList.add("dark");

    await expect.element(screen.getByTestId("visual-placeholder")).toBeInTheDocument();
    document.documentElement.classList.remove("dark");
    await expect.element(screen.getByTestId("visual-snapshot")).toBeInTheDocument();

    scroller.element().scrollTop = 0;
    change("visuals/themed.html");
    await expect.element(screen.getByRole("status")).toHaveTextContent("演示文件超过 1 MB，没有加载");
    change("visuals/themed.html");
    await expect.element(screen.getByTestId("visual-frame")).toBeInTheDocument();
    scroller.element().scrollTop = 2500;

    await vi.waitFor(() => expect(screen.getByTestId("visual-frame").query()).toBeNull());
  });
});

/** A one-pixel PNG, as a capture's image. */
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * A reply with one visual block of the given path, so each test has a snapshot of its own.
 *
 * @remarks
 * Snapshots are kept for the page, by session and path.
 *
 * @sideEffects none
 * @param path - The visual's path.
 * @returns The reply.
 */
function replyOf(path: string): string {
  return `\`\`\`visual\n{"path":"${path}"}\n\`\`\``;
}

/**
 * The UI's clock on a fake one.
 *
 * @remarks
 * Only `now` and `after` are used here.
 *
 * @sideEffects none
 * @param time - The fake clock.
 * @returns The UI clock.
 */
function clockOf(time: FakeClock): UiClock {
  return {
    now: () => time.now(),
    every: () => {
      throw new Error("unused");
    },
    after: (ms, run) => time.setTimeout(run, ms),
  };
}
