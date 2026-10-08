import type { SessionView } from "@atrium/client";
import type { TranscriptItem } from "@atrium/protocol";
import { ArrowDown } from "@phosphor-icons/react";
import { type RefObject, useEffect, useEffectEvent, useRef, useState } from "react";
import { useFollowBottom } from "./follow-bottom";
import { UserBubble } from "./messages";
import { RunStatus } from "./run-status";
import { NoticeView, TurnView } from "./turn-view";

/**
 * Asks for older items when the top of the transcript comes into view.
 *
 * @remarks
 * "往上翻到顶时按游标加载更早的" (SPEC-0001, "滚动与长会话"); the client fetches one page at a
 * time and joins asks while one is on its way.
 *
 * @sideEffects Observes the sentinel's visibility while mounted and there is more to load.
 * @param scroller - The scrolling element.
 * @param sentinel - An element at the top of the content.
 * @param hasOlder - Whether there is more to load.
 * @param onLoadOlder - Loads the next page.
 */
function useLoadOlder(
  scroller: RefObject<HTMLDivElement | null>,
  sentinel: RefObject<HTMLDivElement | null>,
  hasOlder: boolean,
  onLoadOlder: () => void,
): void {
  const load = useEffectEvent(onLoadOlder);
  useEffect(() => {
    const target = sentinel.current;
    if (!hasOlder || target === null) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load();
      },
      { root: scroller.current, rootMargin: "400px 0px 0px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [scroller, sentinel, hasOlder]);
}

/**
 * The id of the first item shown.
 *
 * @remarks
 * Items carry `data-item-id`; a different first item means older ones were put in front.
 *
 * @sideEffects none
 * @param content - The content element.
 * @returns The id, or `undefined` when there are no items.
 */
function firstItemId(content: HTMLElement): string | undefined {
  return content.querySelector<HTMLElement>("[data-item-id]")?.dataset["itemId"];
}

/**
 * Keeps what the user is reading in place when older items are put in front of it.
 *
 * @remarks
 * Prepending grows the content above the view; without this the view would jump. The distance
 * from the bottom is remembered on every scroll and restored when the content grows with a new
 * first item, before the frame is painted.
 *
 * @sideEffects Listens for scrolling and observes the content's size; scrolls after older items arrive.
 * @param scroller - The scrolling element.
 * @param content - The element holding the items.
 */
function useKeepPlaceOnPrepend(
  scroller: RefObject<HTMLDivElement | null>,
  content: RefObject<HTMLDivElement | null>,
): void {
  useEffect(() => {
    const element = scroller.current;
    const inner = content.current;
    if (element === null || inner === null) return undefined;
    let fromBottom = element.scrollHeight - element.scrollTop;
    let first = firstItemId(inner);
    /**
     * Remembers where the view is, counted from the bottom.
     *
     * @remarks
     * See `useKeepPlaceOnPrepend`.
     *
     * @sideEffects none beyond the closure's state.
     */
    const remember = (): void => {
      fromBottom = element.scrollHeight - element.scrollTop;
    };
    const observer = new ResizeObserver(() => {
      const now = firstItemId(inner);
      if (first !== undefined && now !== first) element.scrollTop = element.scrollHeight - fromBottom;
      first = now;
      remember();
    });
    observer.observe(inner);
    element.addEventListener("scroll", remember, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", remember);
    };
  }, [scroller, content]);
}

/**
 * The bar of questions along the right edge, for jumping between turns.
 *
 * @remarks
 * One short line per question, the one in view longer; hovering one previews the question,
 * clicking it scrolls there (SPEC-0001, "提问导航条"). Hidden when the window is narrow.
 *
 * @sideEffects Listens for scrolling and observes the content's size to know which turn is in
 * view; scrolls on click.
 * @param props - The items, the scrolling element and the content element.
 * @returns The bar, or nothing for fewer than two questions.
 */
function QuestionNav({
  items,
  scroller,
  content,
}: {
  readonly items: readonly TranscriptItem[];
  readonly scroller: RefObject<HTMLDivElement | null>;
  readonly content: RefObject<HTMLDivElement | null>;
}) {
  const turns = items.flatMap((item) => (item.kind === "turn" ? [item] : []));
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    const element = scroller.current;
    const inner = content.current;
    if (element === null || inner === null) return undefined;
    /**
     * Finds the turn in view: the last one starting within the top third of the view.
     *
     * @remarks
     * See `QuestionNav`.
     *
     * @sideEffects Sets component state.
     */
    const update = (): void => {
      const top = element.getBoundingClientRect().top;
      let inView: string | null = null;
      for (const turn of element.querySelectorAll<HTMLElement>("[data-turn-id]")) {
        if (turn.getBoundingClientRect().top - top > element.clientHeight / 3) break;
        inView = turn.dataset["turnId"] ?? null;
      }
      setCurrent(inView);
    };
    const observer = new ResizeObserver(update);
    observer.observe(inner);
    element.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", update);
    };
  }, [scroller, content]);
  if (turns.length < 2) return null;
  return (
    <nav
      aria-label="提问导航"
      className="absolute top-1/2 right-3 z-[3] hidden -translate-y-1/2 flex-col items-end py-1.5 lg:flex"
    >
      {turns.map((turn) => (
        <button
          key={turn.id}
          type="button"
          aria-label={turn.user.text}
          aria-current={turn.id === current}
          onClick={() =>
            scroller.current
              ?.querySelector(`[data-turn-id="${CSS.escape(turn.id)}"]`)
              ?.scrollIntoView({ block: "start", behavior: "smooth" })
          }
          className="group relative flex h-3 w-[34px] items-center justify-end"
        >
          <i
            className={`block h-0.5 rounded-sm transition-all group-hover:h-[3px] group-hover:w-[26px] group-hover:bg-[var(--text)] ${
              turn.id === current ? "w-[18px] bg-[var(--text-3)]" : "w-2.5 bg-[var(--line-strong)]"
            }`}
          />
          <span className="pointer-events-none absolute top-1/2 right-10 w-60 -translate-y-1/2 rounded-[var(--r-md)] bg-[var(--surface-1)] px-3 py-2 text-left text-[length:var(--fs-sm)] leading-snug text-[var(--text-2)] opacity-0 shadow-[var(--float-shadow)] transition-opacity group-hover:opacity-100">
            <span className="line-clamp-3">{turn.user.text}</span>
          </span>
        </button>
      ))}
    </nav>
  );
}

/** Props of {@link Transcript}. */
export interface TranscriptProps {
  readonly view: SessionView;
  /** Loads the page before the first item. */
  readonly onLoadOlder: () => void;
}

/**
 * A session's conversation: its turns and notices, pending sends, and the run in progress.
 *
 * @remarks
 * Content is at most 720 px wide (design-language, "圆角、尺寸与间距"). The view follows new
 * content while scrolled to the bottom; scrolling up stops that and shows "↓ 回到底部", with a dot
 * once something new arrived (SPEC-0001, "滚动与长会话"); reaching the top loads older items.
 * Pending messages are the ones sent but not yet confirmed by the host (domain-model §7); until
 * the run's turn arrives the run shows on its own line.
 *
 * @sideEffects Observes the content's size and scrolling while mounted; asks for older items.
 * @param props - The session's view and how to load older items.
 * @returns The scrollable conversation.
 */
export function Transcript({ view, onLoadOlder }: TranscriptProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const follow = useFollowBottom(scroller, content);
  useLoadOlder(scroller, top, view.hasOlder, onLoadOlder);
  useKeepPlaceOnPrepend(scroller, content);
  const last = view.items.at(-1);
  const turnRunning = last?.kind === "turn" && last.outcome === "running";
  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} className="h-full overflow-y-auto" data-testid="transcript">
        <div ref={content} className="mx-auto flex max-w-[720px] flex-col gap-6 px-6 py-8">
          <div ref={top} data-testid="transcript-top">
            {view.hasOlder ? (
              <p className="text-center text-[length:var(--fs-sm)] text-[var(--text-dim)]">正在加载更早的记录…</p>
            ) : null}
          </div>
          {view.items.map((item) =>
            item.kind === "turn" ? (
              <TurnView key={item.id} turn={item} runStartedAt={view.run?.startedAt ?? null} />
            ) : (
              <NoticeView key={item.id} notice={item} />
            ),
          )}
          {view.pending.map((message) => (
            <UserBubble key={message.clientMessageId} text={message.text} />
          ))}
          {view.run === null || turnRunning ? null : <RunStatus startedAt={view.run.startedAt} />}
        </div>
      </div>
      <QuestionNav items={view.items} scroller={scroller} content={content} />
      {follow.following ? null : (
        <button
          type="button"
          onClick={follow.jumpToBottom}
          className="absolute right-6 bottom-4 flex items-center gap-1.5 rounded-[var(--r-pill)] bg-[var(--surface-1)] px-3 py-1.5 text-[length:var(--fs-sm)] text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line),0_9px_27px_rgba(41,70,122,0.08)]"
        >
          <ArrowDown size={13} weight="bold" />
          回到底部
          {follow.unseen ? <span className="size-1.5 rounded-full bg-[var(--tint)]" data-testid="unseen-dot" /> : null}
        </button>
      )}
    </div>
  );
}
