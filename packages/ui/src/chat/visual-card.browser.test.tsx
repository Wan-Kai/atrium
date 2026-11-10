import { CommandError } from "@atrium/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Markdown } from "./markdown";
import { VISUAL_MAX_HEIGHT, VisualCard, type VisualRect, type VisualsAccess, VisualsContext } from "./visual-card";
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
  else if (data.id !== undefined) parent.postMessage({ method: "test/answer", params: { id: data.id, error: data.error ? data.error.message : null } }, "*");
});
parent.postMessage({ jsonrpc: "2.0", id: ++id, method: "ui/initialize", params: {} }, "*");
send("自己发的");
document.getElementById("pick").addEventListener("click", () => send("选 B"));
</script></body></html>`;

/** The frame's address, as a `data:` page; the card's `?v=` lands in the page as text, harmlessly. */
const FRAME_URL = `data:text/html,${encodeURIComponent(FRAME)}`;

/**
 * A frame that fills its card and, on any click, first sends an empty message, then a real one.
 *
 * @remarks
 * The empty one must be refused without spending the click's press; the card's answers are posted
 * back as `test/answer`.
 */
const CLICKED = `<!doctype html><html><body style="margin:0;height:100vh">
<script>
let id = 0;
const send = (text) => parent.postMessage({ jsonrpc: "2.0", id: ++id, method: "ui/message", params: { role: "user", content: { type: "text", text } } }, "*");
addEventListener("message", (event) => {
  const data = event.data;
  if (data.id === 1) parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 120 } }, "*");
  else if (data.id !== undefined) parent.postMessage({ method: "test/answer", params: { id: data.id, error: data.error ? data.error.message : null } }, "*");
});
parent.postMessage({ jsonrpc: "2.0", id: ++id, method: "ui/initialize", params: {} }, "*");
document.addEventListener("click", () => { send(""); send("选 B"); });
</script></body></html>`;

/** A frame that says it is taller than any card may be. */
const TALL = `<!doctype html><script>
addEventListener("message", (event) => { if (event.data.id === 1) parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 20000 } }, "*"); });
parent.postMessage({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} }, "*");
</script>`;

/**
 * The card's answers a frame posted back, by request id, as the frames here do.
 *
 * @remarks
 * Listens from the call on; the test stops it.
 *
 * @sideEffects Listens to the window's messages until stopped.
 * @returns The answers so far, and how to stop.
 */
function answersHeard(): { answers: [unknown, unknown][]; stop: () => void } {
  const answers: [unknown, unknown][] = [];
  const heard = (event: MessageEvent): void => {
    const data: unknown = event.data;
    if (Reflect.get(Object(data), "method") !== "test/answer") return;
    const params: unknown = Reflect.get(Object(data), "params");
    answers.push([Reflect.get(Object(params), "id"), Reflect.get(Object(params), "error")]);
  };
  window.addEventListener("message", heard);
  return { answers, stop: () => window.removeEventListener("message", heard) };
}

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
  options: { presses?: VisualsAccess["presses"]; disposition?: string } = {},
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
      return { disposition: options.disposition ?? "started" };
    },
    onChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    capture,
    presses: options.presses ?? null,
    open: (path) => (path === "visuals/a.html" ? () => undefined : null),
  };
  return { access, sent, resolved, change: (path: string) => listeners.forEach((listener) => listener(path)) };
}

/** A code the host refuses a visual with. */
type Refusal = ConstructorParameters<typeof CommandError>[0];

/** A reply with one visual block. */
const REPLY = '先看这一步：\n\n```visual\n{"path":"visuals/a.html","title":"隔离级别"}\n```\n\n然后点一个答案。';

/**
 * Presses heard only on the second look: none when the message comes, one a moment later.
 *
 * @remarks
 * The press comes from the main process, the message from the frame, in either order.
 *
 * @sideEffects none
 * @returns The presses, and what each spend gave.
 */
function latePresses(): { presses: NonNullable<VisualsAccess["presses"]>; spends: boolean[] } {
  const spends: boolean[] = [];
  const late = [false, true];
  return {
    spends,
    presses: {
      has: () => true,
      spend: () => {
        const spent = late.shift() ?? false;
        spends.push(spent);
        return spent;
      },
    },
  };
}

describe("an inline visual", () => {
  it("shows the card with the path, 沙箱, and a frame of the resolved address with only allow-scripts", async () => {
    const { access, resolved } = visuals([{ url: FRAME_URL, mtime: 5 }]);
    const screen = await render(
      <VisualsContext value={access}>
        <Markdown text={REPLY} streaming={false} />
      </VisualsContext>,
    );

    const card = screen.getByTestId("visual-card");
    await expect.element(card.getByTestId("visual-path")).toHaveTextContent("visuals/a.html");
    await expect.element(card).toHaveTextContent("visuals/a.html沙箱");
    await expect.element(card.getByRole("button", { name: "在查看标签里打开" })).toBeVisible();
    const frame = card.getByTestId("visual-frame");
    await expect.element(frame).toHaveAttribute("sandbox", "allow-scripts");
    await expect.element(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect.element(frame).toHaveAttribute("src", `${FRAME_URL}?v=5`);
    await expect.element(frame).toHaveAttribute("title", "隔离级别");
    // The frame got the light theme and reported its height.
    await vi.waitFor(() => expect(card.getByTestId("visual-body").element().getBoundingClientRect().height).toBe(111));
    expect(resolved).toStrictEqual(["visuals/a.html"]);
  });

  it("follows light and dark: the frame is told when the page switches", async () => {
    const { access } = visuals([{ url: FRAME_URL, mtime: 1 }]);
    const screen = await render(
      <VisualsContext value={access}>
        <Markdown text={REPLY} streaming={false} />
      </VisualsContext>,
    );
    const body = screen.getByTestId("visual-body");
    await vi.waitFor(() => expect(body.element().getBoundingClientRect().height).toBe(111));

    document.documentElement.classList.add("dark");

    await vi.waitFor(() => expect(body.element().getBoundingClientRect().height).toBe(222));
  });

  it("drops a message the frame's script sends without the user's click, and answers it refused", async () => {
    const heard = answersHeard();
    const { access, sent } = visuals([{ url: FRAME_URL, mtime: 1 }]);
    const screen = await render(
      <VisualsContext value={access}>
        <Markdown text={REPLY} streaming={false} />
      </VisualsContext>,
    );

    // Its height came after the theme the card sent, so the card was listening when it started.
    await vi.waitFor(() =>
      expect(screen.getByTestId("visual-body").element().getBoundingClientRect().height).toBe(111),
    );
    await vi.waitFor(() => expect(heard.answers).toStrictEqual([[2, "refused"]]));
    heard.stop();
    expect(sent).toStrictEqual([]);
  });

  it("sends a clicked message once a press on its own frame is heard, even a little after it, refusing a bad one first without spending it", async () => {
    const heard = answersHeard();
    const { presses, spends } = latePresses();
    const { access, sent } = visuals(
      [{ url: `data:text/html;charset=utf-8,${encodeURIComponent(CLICKED)}`, mtime: 1 }],
      null,
      {
        presses,
      },
    );
    const screen = await render(
      <VisualsContext value={access}>
        <Markdown text={REPLY} streaming={false} />
      </VisualsContext>,
    );
    const frame = screen.getByTestId("visual-frame");
    await vi.waitFor(() =>
      expect(screen.getByTestId("visual-body").element().getBoundingClientRect().height).toBe(120),
    );

    await userEvent.click(frame.element());

    await vi.waitFor(() =>
      expect(heard.answers).toStrictEqual([
        [2, "refused"],
        [3, null],
      ]),
    );
    heard.stop();
    expect(spends).toStrictEqual([false, true]);
    expect(sent).toStrictEqual([["visuals/a.html", "选 B"]]);
  });

  it("refuses a clicked message with no press on its frame, and tells the frame a dropped one was not sent", async () => {
    const heard = answersHeard();
    const nowhere = visuals([{ url: `data:text/html;charset=utf-8,${encodeURIComponent(CLICKED)}`, mtime: 1 }], null, {
      presses: { has: () => false, spend: () => false },
    });
    const first = await render(
      <VisualsContext value={nowhere.access}>
        <Markdown text={REPLY} streaming={false} />
      </VisualsContext>,
    );
    await vi.waitFor(() => expect(first.getByTestId("visual-body").element().getBoundingClientRect().height).toBe(120));
    await userEvent.click(first.getByTestId("visual-frame").element());
    await vi.waitFor(() =>
      expect(heard.answers).toStrictEqual([
        [2, "refused"],
        [3, "refused"],
      ]),
    );
    expect(nowhere.sent).toStrictEqual([]);
    await first.unmount();
    heard.answers.length = 0;

    const dropped = visuals([{ url: `data:text/html;charset=utf-8,${encodeURIComponent(CLICKED)}`, mtime: 1 }], null, {
      presses: { has: () => true, spend: () => true },
      disposition: "dropped",
    });
    const second = await render(
      <VisualsContext value={dropped.access}>
        <Markdown text={REPLY} streaming={false} />
      </VisualsContext>,
    );
    await vi.waitFor(() =>
      expect(second.getByTestId("visual-body").element().getBoundingClientRect().height).toBe(120),
    );
    await userEvent.click(second.getByTestId("visual-frame").element());

    await vi.waitFor(() =>
      expect(heard.answers).toStrictEqual([
        [2, "refused"],
        [3, "dropped"],
      ]),
    );
    heard.stop();
    expect(dropped.sent).toStrictEqual([["visuals/a.html", "选 B"]]);
  });

  it("refuses every clicked message of a direction's demo in its viewer tab, which has no title row (SPEC-0008, ML4)", async () => {
    const heard = answersHeard();
    const { access } = visuals(
      [{ url: `data:text/html;charset=utf-8,${encodeURIComponent(CLICKED)}`, mtime: 1 }],
      null,
      {
        presses: { has: () => true, spend: () => true },
      },
    );
    const screen = await render(
      <VisualCard access={{ ...access, owner: "lrn_rust", send: null }} path="visuals/a.html" title={null} headless />,
    );
    await vi.waitFor(() =>
      expect(screen.getByTestId("visual-body").element().getBoundingClientRect().height).toBe(120),
    );

    await userEvent.click(screen.getByTestId("visual-frame").element());

    await vi.waitFor(() =>
      expect(heard.answers).toStrictEqual([
        [2, "refused"],
        [3, "refused"],
      ]),
    );
    heard.stop();
    expect(screen.getByTestId("visual-path").query()).toBeNull();
  });

  it("loads the file again when it changed", async () => {
    const { access, change, resolved } = visuals([
      { url: FRAME_URL, mtime: 1 },
      { url: FRAME_URL, mtime: 2 },
    ]);
    const screen = await render(
      <VisualsContext value={access}>
        <Markdown text={REPLY} streaming={false} />
      </VisualsContext>,
    );
    const frame = screen.getByTestId("visual-frame");
    await expect.element(frame).toHaveAttribute("src", `${FRAME_URL}?v=1`);

    change("visuals/other.html");
    change("visuals/a.html");

    await expect.element(frame).toHaveAttribute("src", `${FRAME_URL}?v=2`);
    expect(resolved).toStrictEqual(["visuals/a.html", "visuals/a.html"]);
  });

  it.each([
    ["visual_outside", "这个演示不在演示目录里，没有加载"],
    ["visual_missing", "找不到这个演示文件"],
    ["visual_too_large", "演示文件超过 1 MB，没有加载"],
    ["internal_error", "演示加载失败"],
  ] as const)("says why it is not shown when the host refuses it with %s", async (code, words) => {
    const { access } = visuals([code]);
    const screen = await render(
      <VisualsContext value={access}>
        <Markdown text={REPLY} streaming={false} />
      </VisualsContext>,
    );

    await expect.element(screen.getByRole("status")).toHaveTextContent(words);
    expect(screen.getByTestId("visual-frame").query()).toBeNull();
  });

  it("says a reference written wrong is not loaded, and shows a block as code where there are no visuals", async () => {
    const { access, resolved } = visuals([{ url: FRAME_URL, mtime: 1 }]);
    const wrong = await render(
      <VisualsContext value={access}>
        <Markdown text={"```visual\nvisuals/a.html\n```"} streaming={false} />
      </VisualsContext>,
    );
    await expect.element(wrong.getByRole("status")).toHaveTextContent("演示的引用写错了，没有加载");
    await wrong.unmount();

    const plain = await render(<Markdown text={REPLY} streaming={false} />);

    await expect.element(plain.getByText('{"path":"visuals/a.html","title":"隔离级别"}')).toBeVisible();
    expect(plain.getByTestId("visual-card").query()).toBeNull();
    expect(resolved).toStrictEqual([]);
  });

  it("offers to open only a path of the workspace, relative to its directory", async () => {
    const { access } = visuals([{ url: FRAME_URL, mtime: 1 }]);
    const screen = await render(
      <VisualsContext value={access}>
        <Markdown text={'```visual\n{"path":"/Users/me/.atrium/visuals/s1/a.html"}\n```'} streaming={false} />
      </VisualsContext>,
    );

    await expect.element(screen.getByTestId("visual-frame")).toBeVisible();
    expect(screen.getByRole("button", { name: "在查看标签里打开" }).query()).toBeNull();
  });

  it("keeps a reported height within 10 000px", async () => {
    const { access } = visuals([{ url: `data:text/html,${encodeURIComponent(TALL)}`, mtime: 1 }]);
    const screen = await render(
      <VisualsContext value={access}>
        <Markdown text={REPLY} streaming={false} />
      </VisualsContext>,
    );

    await vi.waitFor(() =>
      expect(screen.getByTestId("visual-body").element().getBoundingClientRect().height).toBe(VISUAL_MAX_HEIGHT),
    );
    expect(VISUAL_MAX_HEIGHT).toBe(10_000);
  });

  it("holds the visual while its card is shown, and lets go when it goes", async () => {
    const held: string[] = [];
    const { access } = visuals([{ url: FRAME_URL, mtime: 1 }]);
    const holding: VisualsAccess = {
      ...access,
      hold: (path) => {
        held.push(`hold ${path}`);
        return () => held.push(`release ${path}`);
      },
    };
    const screen = await render(
      <VisualsContext value={holding}>
        <Markdown text={REPLY} streaming={false} />
      </VisualsContext>,
    );
    await expect.element(screen.getByTestId("visual-frame")).toBeInTheDocument();
    expect(held).toStrictEqual(["hold visuals/a.html"]);

    await screen.unmount();

    expect(held).toStrictEqual(["hold visuals/a.html", "release visuals/a.html"]);
  });
});
