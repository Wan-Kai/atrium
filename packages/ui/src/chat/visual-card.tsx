import { CommandError } from "@atrium/client";
import { type ReactNode, createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CodeBlock, CodeBlockCopyButton, type CustomRendererProps } from "streamdown";
import { ArrowUpRight, PlayCircle } from "../design/icons";
import { useDarkMode } from "../design/use-dark-mode";
import { useClock } from "../state/clock";
import { parseVisualReference } from "./visual-reference";
import { VisualSnapshots } from "./visual-snapshots";

/** A rectangle of the page, in CSS pixels. */
export interface VisualRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What a session's reply, or a direction's viewer tab (ML4), may do with its visuals. */
export interface VisualsAccess {
  /** The session the reply belongs to, or the direction, which the snapshots are kept by. */
  readonly owner: string;
  /** Checks the visual a reply names and gets its address. */
  resolve(path: string): Promise<{ readonly url: string; readonly mtime: number }>;
  /** Holds the visual while its card is shown, so a new connection resolves it again; returns how to let go. */
  hold(path: string): () => void;
  /**
   * Sends what the user picked in it as their message; `dropped` when the host did not send it.
   * `null` in a direction's viewer tab, which belongs to no session: nothing is sent (SPEC-0008, ML4).
   */
  readonly send: ((path: string, text: string) => Promise<{ readonly disposition: string }>) | null;
  /** Hears the paths of this session's visuals that changed; returns how to stop. */
  onChanged(listener: (path: string) => void): () => void;
  /** Captures a rectangle of the page; `null` outside the desktop app, which alone can. */
  readonly capture: ((rect: VisualRect) => Promise<string | null>) | null;
  /**
   * The window's latest mouse press, by the element it landed on: whether it is a fresh one on a
   * frame, and spending it; `null` outside the desktop app, which alone sees presses inside frames.
   */
  readonly presses: { has(frame: Element): boolean; spend(frame: Element): boolean } | null;
  /** How to open a path of the workspace in a viewer tab, if it is one; `null` without a workspace. */
  readonly open: ((path: string) => (() => void) | null) | null;
}

/** The current session's visuals; without it a `visual` block shows as code, as in a file's preview. */
export const VisualsContext = createContext<VisualsAccess | null>(null);

/**
 * The CSS variables a visual's frame is given, read from the page's tokens (SPEC-0007, MV1 details).
 *
 * @remarks
 * The same list the extension tells the model (`packages/pi/src/visuals`), which the UI cannot import.
 */
const VISUAL_VARIABLES = [
  "--surface-1",
  "--surface-2",
  "--surface-3",
  "--code",
  "--text",
  "--text-2",
  "--text-3",
  "--text-muted",
  "--text-dim",
  "--line",
  "--line-soft",
  "--line-strong",
  "--hover",
  "--selected",
  "--tint",
  "--on-tint",
  "--attn",
  "--danger",
  "--ok",
  "--diff-add-bg",
  "--diff-del-bg",
  "--font-sans",
  "--font-mono",
  "--fs",
  "--fs-sm",
  "--fs-xs",
  "--r-sm",
  "--r",
  "--r-md",
] as const;

/** The tallest a visual is shown; a taller one scrolls inside its frame (SPEC-0007, "高度"). */
export const VISUAL_MAX_HEIGHT = 10_000;

/** The height a visual has before it reports its own. */
const FIRST_HEIGHT = 160;

/** How long a fully shown visual must be left alone before its snapshot is taken (SPEC-0007, "截图怎么截"). */
const QUIET_MS = 1000;

/**
 * How long a user's click or key in Atrium's own page keeps the page activated: Chromium's
 * transient activation lasts 5 seconds.
 */
const PAGE_ACTIVATION_MS = 5000;

/** The longest message a visual may send (SPEC-0007, "回传"). */
const MESSAGE_MAX = 4000;

/**
 * How long a message waits for its press to be heard: the press comes from the main process and
 * the message from the frame, in either order (SPEC-0007, MV1 details).
 */
const PRESS_WAIT_MS = 300;

/** How long a loaded frame has to say it started, before the card shows it failed (SPEC-0007, MV1 details). */
const LOAD_MS = 10_000;

/** Every visual's latest snapshot, for the cards of this page. */
const snapshots = new VisualSnapshots();

/** Why a visual is not shown, in the card's words (design-language, "消息流 · 交互演示"). */
const FAILURES: Readonly<Record<string, string>> = {
  visual_outside: "这个演示不在演示目录里，没有加载",
  visual_missing: "找不到这个演示文件",
  visual_too_large: "演示文件超过 1 MB，没有加载",
  session_not_found: "这个会话已经不在了，演示没有加载",
  reference: "演示的引用写错了，没有加载",
};

/**
 * What the frame is told of the page: light or dark, and the tokens' values now.
 *
 * @remarks
 * MCP Apps' `hostContext`, as the frame's `ui/initialize` answer and each change carry it.
 *
 * @sideEffects Reads the computed style of `<html>`.
 * @param dark - Whether the page is dark.
 * @returns The context.
 */
function hostContext(dark: boolean): { theme: "light" | "dark"; styles: { variables: Record<string, string> } } {
  const tokens = getComputedStyle(document.documentElement);
  const variables: Record<string, string> = {};
  for (const name of VISUAL_VARIABLES) {
    const value = tokens.getPropertyValue(name).trim();
    if (value !== "") variables[name] = value;
  }
  return { theme: dark ? "dark" : "light", styles: { variables } };
}

/**
 * Posts a JSON-RPC message into a frame.
 *
 * @remarks
 * The frame's origin is opaque, so no target origin can name it; what goes in is the theme and
 * answers, nothing private.
 *
 * @sideEffects Posts a message.
 * @param frame - The frame.
 * @param message - The message, without `jsonrpc`.
 */
function post(frame: HTMLIFrameElement | null, message: Record<string, unknown>): void {
  frame?.contentWindow?.postMessage({ jsonrpc: "2.0", ...message }, "*");
}

/** A JSON-RPC message from a frame, as far as the card reads it. */
interface FrameMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

/**
 * The text of a `ui/message`, if it is a text message of the allowed length.
 *
 * @remarks
 * MCP Apps' shape: `{ role: "user", content: { type: "text", text } }`.
 *
 * @sideEffects none
 * @param params - The message's params.
 * @returns The text, or `null`.
 */
function messageText(params: unknown): string | null {
  if (typeof params !== "object" || params === null) return null;
  const role: unknown = Reflect.get(params, "role");
  const content: unknown = Reflect.get(params, "content");
  if (role !== "user" || typeof content !== "object" || content === null) return null;
  const type: unknown = Reflect.get(content, "type");
  const text: unknown = Reflect.get(content, "text");
  if (type !== "text" || typeof text !== "string" || text === "" || text.length > MESSAGE_MAX) return null;
  return text;
}

/**
 * The card's title row: the mark, the path, "沙箱", and the open button when the path can open.
 *
 * @remarks
 * design-language ("消息流 · 交互演示"): 36px, a 14px play mark in the tint, the path small and
 * monospaced, a 0.5px line below.
 *
 * @sideEffects none
 * @param props - The path, and how to open it if it can be.
 * @returns The row.
 */
function VisualHeader({ path, open }: { readonly path: string; readonly open: (() => void) | null }) {
  return (
    <div className="flex h-9 items-center gap-2 pr-1.5 pl-3 font-[family-name:var(--font-mono)] text-[length:var(--fs-sm)] text-[var(--text-muted)] shadow-[inset_0_-0.5px_0_var(--line)]">
      <PlayCircle size={14} className="shrink-0 text-[var(--tint)]" aria-hidden />
      <span className="truncate" data-testid="visual-path">
        {path}
      </span>
      <span className="shrink-0 font-[family-name:var(--font-sans)]">沙箱</span>
      <span className="flex-1" />
      {open === null ? null : (
        <button
          type="button"
          aria-label="在查看标签里打开"
          title="在查看标签里打开"
          onClick={open}
          className="atrium-press-sm rounded-[var(--r)] p-1 text-[var(--text-dim)] hover:bg-[var(--hover)] hover:text-[var(--text-muted)]"
        >
          <ArrowUpRight size={14} />
        </button>
      )}
    </div>
  );
}

/**
 * The card around a visual: the title row and, below it, the frame, its snapshot or a line on why not.
 *
 * @remarks
 * design-language ("消息流 · 交互演示"): as wide as the text, `--surface-1`, radius 14, the card
 * shadow and no border.
 *
 * @sideEffects none
 * @param props - The path, how to open it, whether it has no title row, and what goes below it.
 * @returns The card.
 */
function VisualFrame({
  path,
  open,
  headless = false,
  children,
}: {
  readonly path: string;
  readonly open: (() => void) | null;
  readonly headless?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <figure
      className="m-0 overflow-hidden rounded-[14px] bg-[var(--surface-1)] shadow-[var(--card-shadow)]"
      data-testid="visual-card"
    >
      {headless ? null : <VisualHeader path={path} open={open} />}
      {children}
    </figure>
  );
}

/**
 * Whether nothing lies over a frame: near its corners and at its middle, the frame itself is on top.
 *
 * @remarks
 * A snapshot taken under a menu or a dialog would show it (SPEC-0007, MV1 details); then none is taken.
 *
 * @sideEffects Reads the layout.
 * @param element - The frame.
 * @returns Whether it is uncovered.
 */
function uncovered(element: HTMLIFrameElement): boolean {
  const box = element.getBoundingClientRect();
  // Past the card's 14px rounded corners, which clip the frame's own.
  const inset = Math.min(16, box.width / 2, box.height / 2);
  const points = [
    [box.left + inset, box.top + inset],
    [box.right - inset, box.top + inset],
    [box.left + inset, box.bottom - inset],
    [box.right - inset, box.bottom - inset],
    [box.left + box.width / 2, box.top + box.height / 2],
  ] as const;
  return points.every(([x, y]) => document.elementFromPoint(x, y) === element);
}

/**
 * A line saying why a visual is not shown.
 *
 * @remarks
 * One `--fs-meta` line in `--text-muted` inside the card, never a dialog (design-language).
 *
 * @sideEffects none
 * @param props - The reason's code.
 * @returns The line.
 */
function VisualFailure({ code }: { readonly code: string }) {
  return (
    <p className="m-0 px-3 py-2.5 text-[length:var(--fs-meta)] text-[var(--text-muted)]" role="status">
      {FAILURES[code] ?? "演示加载失败"}
    </p>
  );
}

/**
 * A `visual` code block of a reply: the visual's card, or the block as code where there are no visuals.
 *
 * @remarks
 * SPEC-0007: the block's JSON names the file; while the block is still being written the card
 * waits with no path; a reply without a session (a file's preview) shows the block as code.
 *
 * @sideEffects As `VisualCard`.
 * @param props - The block's code and whether it is complete.
 * @returns The card or the code.
 */
export function VisualBlock({ code, isIncomplete }: CustomRendererProps) {
  const access = useContext(VisualsContext);
  if (access === null) {
    return (
      <CodeBlock code={code} language="visual" lineNumbers={false}>
        <CodeBlockCopyButton />
      </CodeBlock>
    );
  }
  if (isIncomplete) {
    return (
      <VisualFrame path="" open={null}>
        <div style={{ height: FIRST_HEIGHT }} />
      </VisualFrame>
    );
  }
  const reference = parseVisualReference(code);
  if (reference === null) {
    return (
      <VisualFrame path="visual" open={null}>
        <VisualFailure code="reference" />
      </VisualFrame>
    );
  }
  return <VisualCard key={reference.path} access={access} path={reference.path} title={reference.title} />;
}

/** Where a visual's file stands. */
type Resolved =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly src: string }
  | { readonly kind: "failed"; readonly code: string };

/**
 * A visual inline in the message flow: its sandboxed frame while in view, its snapshot otherwise.
 *
 * @remarks
 * SPEC-0007 ("沙箱", "运行环境", "回传") with its MV1 details. The file is held while the card is
 * shown and resolved, and again each time it changes; the frame is loaded with `?v=<mtime>`, so a
 * change reloads it, and a frame that does not say it started within 10 s shows as failed. Only
 * `sandbox="allow-scripts"`, no referrer, no permissions. The frame says how tall it is, up to
 * 10 000px; it gets the page's theme when it starts and whenever light and dark change. A
 * `ui/message` goes out only when the frame is the focused element and the page has the user's
 * activation, which a click inside the frame gives it; then, in the app, a fresh press that landed
 * on this very frame is spent for it (waiting up to 300 ms for the press to be heard), and outside
 * it the page itself must have had no click or key in the 5 s an activation lasts: a fragment can
 * focus itself, and would otherwise borrow the activation of typing in Atrium or of a click in
 * another visual. The frame's own check shares a realm with the fragment and is not enough. A
 * message the host dropped is told to the frame as not sent. Out of view the frame is unloaded and
 * its last snapshot in this appearance shown in its place, at the same height, or a placeholder
 * with its title; the snapshot is taken when the frame has been fully in view, uncovered, and left
 * alone, with no activity or height change, for a second, and again after light and dark change.
 *
 * @sideEffects Resolves the file and listens for its changes; listens for the frame's messages
 * and answers them; may send a message; observes where the card is; captures snapshots; starts
 * timers.
 * A direction's viewer tab draws the same card without its title row, and with no way to send.
 *
 * @param props - The session's visuals, the path, its title, and whether it has no title row.
 * @returns The card.
 */
export function VisualCard({
  access,
  path,
  title,
  headless = false,
}: {
  readonly access: VisualsAccess;
  readonly path: string;
  readonly title: string | null;
  /** Without the title row, as a direction's viewer tab shows it (ML4). */
  readonly headless?: boolean;
}) {
  const clock = useClock();
  const dark = useDarkMode();
  const key = `${access.owner}\u0000${path}`;
  const [resolved, setResolved] = useState<Resolved>({ kind: "loading" });
  const [height, setHeight] = useState(FIRST_HEIGHT);
  const [inView, setInView] = useState(false);
  const snapshot = useSyncExternalStore(snapshots.subscribe, () => snapshots.get(key, dark));
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  /** Whether the frame is loaded and wholly in view, and the pending snapshot's timer. */
  const quiet = useRef<{ whole: boolean; cancel: (() => void) | null }>({ whole: false, cancel: null });
  const darkNow = useRef(dark);
  useEffect(() => {
    darkNow.current = dark;
  }, [dark]);
  /** When the user last clicked or pressed a key in Atrium's own page, not in a frame. */
  const pageInput = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    /**
     * Notes the user's input in the page itself.
     *
     * @remarks
     * Input inside a frame never reaches the page's listeners.
     *
     * @sideEffects Updates the time.
     */
    const noted = (): void => {
      pageInput.current = clock.now();
    };
    window.addEventListener("pointerdown", noted, true);
    window.addEventListener("keydown", noted, true);
    return () => {
      window.removeEventListener("pointerdown", noted, true);
      window.removeEventListener("keydown", noted, true);
    };
  }, [clock]);

  useEffect(() => {
    let live = true;
    /**
     * Resolves the file, now and each time it changed, and shows where it stands.
     *
     * @remarks
     * A card gone meanwhile shows nothing.
     *
     * @sideEffects Sends `resolve_visual`; sets the state.
     */
    const load = async (): Promise<void> => {
      try {
        const { url, mtime } = await access.resolve(path);
        if (live) setResolved({ kind: "ready", src: `${url}?v=${mtime}` });
      } catch (error) {
        if (live) setResolved({ kind: "failed", code: error instanceof CommandError ? error.code : "load" });
      }
    };
    const release = access.hold(path);
    // Fire and forget: `load` catches its own failure.
    void load();
    const stop = access.onChanged((which) => {
      // Fire and forget: as above.
      if (which === path) void load();
    });
    return () => {
      live = false;
      stop();
      release();
    };
  }, [access, path]);

  const loaded = inView && resolved.kind === "ready";

  /**
   * Starts the second of quiet again, after which a snapshot is taken.
   *
   * @remarks
   * Any activity or height change starts it over; a frame not wholly in view takes none.
   *
   * @sideEffects Cancels and may start a timer.
   */
  const poke = (): void => {
    quiet.current.cancel?.();
    quiet.current.cancel = null;
    if (!quiet.current.whole || access.capture === null) return;
    const capture = access.capture;
    /**
     * Captures the frame where it is and keeps the image.
     *
     * @remarks
     * A snapshot that fails leaves the last one.
     *
     * @sideEffects Captures the page; updates the snapshots.
     */
    const take = async (): Promise<void> => {
      const element = frame.current;
      if (element === null || !uncovered(element)) return;
      const box = element.getBoundingClientRect();
      const wasDark = darkNow.current;
      const image = await capture({ x: box.x, y: box.y, width: box.width, height: box.height }).catch(() => null);
      if (image === null || darkNow.current !== wasDark) return;
      snapshots.set(key, image, wasDark);
    };
    quiet.current.cancel = clock.after(QUIET_MS, () => {
      quiet.current.cancel = null;
      // Fire and forget: `take` catches its own failure.
      void take();
    });
  };
  const pokeNow = useRef(poke);
  useEffect(() => {
    pokeNow.current = poke;
  });

  useEffect(() => {
    const element = body;
    if (element === null) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry === undefined) return;
        setInView(entry.isIntersecting);
        quiet.current.whole = entry.isIntersecting && entry.intersectionRatio >= 0.99;
        pokeNow.current();
      },
      { threshold: [0, 0.99] },
    );
    observer.observe(element);
    const state = quiet.current;
    return () => {
      observer.disconnect();
      state.cancel?.();
      state.cancel = null;
    };
  }, [body]);

  /** Whether the loaded frame said it started; until it does, the load may yet fail. */
  const started = useRef(false);
  const src = resolved.kind === "ready" ? resolved.src : null;
  useEffect(() => {
    if (!loaded || src === null) return undefined;
    started.current = false;
    return clock.after(LOAD_MS, () => {
      if (!started.current) setResolved({ kind: "failed", code: "load" });
    });
  }, [loaded, src, clock]);

  useEffect(() => {
    if (!loaded) return undefined;
    /** Timers of messages waiting for their press, stopped with the frame. */
    const waiting = new Set<() => void>();
    /**
     * Sends a message the user clicked for, and tells the frame how it went.
     *
     * @remarks
     * A message the host dropped, a second within a second, was not sent (SPEC-0007, MV1 details).
     *
     * @sideEffects Sends `send_visual_message`; posts into the frame.
     * @param element - The frame.
     * @param id - The request's id.
     * @param text - The message.
     */
    const answer = async (element: HTMLIFrameElement, id: unknown, text: string): Promise<void> => {
      try {
        const { disposition } = await (access.send?.(path, text) ?? Promise.resolve({ disposition: "dropped" }));
        post(
          element,
          disposition === "dropped" ? { id, error: { code: -32_000, message: "dropped" } } : { id, result: {} },
        );
      } catch {
        post(element, { id, error: { code: -32_000, message: "failed" } });
      }
    };
    /**
     * Answers one message of this card's frame.
     *
     * @remarks
     * See `VisualCard`. Messages of any other window are not this card's.
     *
     * @sideEffects May post into the frame, send a message, set the height and start a timer.
     * @param event - The message.
     */
    const onMessage = (event: MessageEvent): void => {
      const element = frame.current;
      if (element === null || event.source !== element.contentWindow) return;
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) return;
      const { id, method, params } = data as FrameMessage;
      if (method === "ui/initialize") {
        started.current = true;
        post(element, { id, result: { hostContext: hostContext(darkNow.current) } });
      } else if (method === "ui/notifications/size-changed") {
        const reported: unknown = typeof params === "object" && params !== null ? Reflect.get(params, "height") : null;
        if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
          setHeight(Math.min(Math.ceil(reported), VISUAL_MAX_HEIGHT));
        }
        pokeNow.current();
      } else if (method === "atrium/notifications/activity") {
        pokeNow.current();
      } else if (method === "ui/message") {
        const text = messageText(params);
        /**
         * Refuses the message.
         *
         * @remarks
         * The frame's `sendMessage` then says it was not sent.
         *
         * @sideEffects Posts into the frame.
         */
        const refuse = (): void => post(element, { id, error: { code: -32_000, message: "refused" } });
        // The user clicked in this frame just now: it has the focus and the page the activation.
        // Only once that holds is a press spent, so a message that fails here burns none.
        // A direction's viewer tab sends nothing, whatever was clicked (SPEC-0008, ML4).
        if (
          access.send === null ||
          text === null ||
          document.activeElement !== element ||
          !navigator.userActivation.isActive
        ) {
          refuse();
          return;
        }
        const presses = access.presses;
        if (presses === null) {
          // Outside the app: no click or key in Atrium's own page in the last 5 s.
          if (clock.now() - pageInput.current < PAGE_ACTIVATION_MS) refuse();
          // Fire and forget: `answer` catches its own failure.
          else void answer(element, id, text);
          return;
        }
        // In the app, a press that landed on this frame, and spends itself; it may come a little later.
        // Fire and forget: as above.
        if (presses.spend(element)) void answer(element, id, text);
        else {
          const cancel = clock.after(PRESS_WAIT_MS, () => {
            waiting.delete(cancel);
            // Fire and forget: as above.
            if (presses.spend(element)) void answer(element, id, text);
            else refuse();
          });
          waiting.add(cancel);
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      for (const cancel of waiting) cancel();
    };
  }, [loaded, access, path, clock]);

  useEffect(() => {
    if (!loaded) return;
    post(frame.current, { method: "ui/notifications/host-context-changed", params: hostContext(dark) });
    // The snapshot in the other appearance no longer shows; take one in this one.
    pokeNow.current();
  }, [dark, loaded]);

  const opener = headless ? null : (access.open?.(path) ?? null);
  if (resolved.kind === "failed") {
    return (
      <VisualFrame path={path} open={opener} headless={headless}>
        <VisualFailure code={resolved.code} />
      </VisualFrame>
    );
  }
  return (
    <VisualFrame path={path} open={opener} headless={headless}>
      <div ref={setBody} style={{ height }} className="relative" data-testid="visual-body">
        {loaded ? (
          <iframe
            ref={frame}
            key={resolved.src}
            src={resolved.src}
            title={title ?? path}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            allow=""
            className="block h-full w-full border-0"
            data-testid="visual-frame"
          />
        ) : snapshot === null ? (
          <div
            className="flex h-full items-center justify-center text-[length:var(--fs-meta)] text-[var(--text-dim)]"
            data-testid="visual-placeholder"
          >
            {title ?? path}
          </div>
        ) : (
          <img src={snapshot} alt={title ?? path} className="block h-full w-full" data-testid="visual-snapshot" />
        )}
      </div>
    </VisualFrame>
  );
}
