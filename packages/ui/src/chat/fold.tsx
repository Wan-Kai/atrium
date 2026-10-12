import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

/** Where a fold is: still, or on its way. */
type Phase = "open" | "opening" | "closing" | "closed";

/** The height's curve: slow to start, quick through the middle, landing softly (design-language, "动效"). */
const FOLD_EASING = "cubic-bezier(0.45, 0, 0.15, 1)";

/** The rows' curve: smooth, no bounce. */
const SMOOTH_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

/** How long the height takes to fold or unfold, unless said otherwise. */
const FOLD_MS = 400;

/** How much later each row starts than the one before, and the most any row waits. */
const ROW_STAGGER_MS = 14;
const ROW_STAGGER_MAX_MS = 120;

/**
 * Whether the user asked for less motion.
 *
 * @remarks
 * Folding then switches at once (design-language, "减弱动态效果").
 *
 * @sideEffects none
 * @returns Whether to skip the motion.
 */
function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Plays a fold or an unfold on the element and its rows.
 *
 * @remarks
 * Folding: the height goes from where it is now to 0 while the rows, last first, fade out and
 * rise 6px. Unfolding is the reverse, first row first (design-language, "动效 · 过程轨道"). A fold
 * turned back halfway starts from the height it has reached, so it does not jump; an unfold from
 * folded starts from nothing, the element having just been put back at its full height.
 *
 * @sideEffects Starts Web Animations on the element and on its `[data-fold-row]` children.
 * @param element - The folding element.
 * @param closing - Whether it folds or unfolds.
 * @param duration - How long the height takes, in milliseconds.
 * @returns The height's animation, whose end settles the fold.
 */
function play(element: HTMLElement, closing: boolean, duration: number): Animation {
  const midway = element.getAnimations().length > 0;
  const from = closing || midway ? element.getBoundingClientRect().height : 0;
  for (const animation of element.getAnimations({ subtree: true })) animation.cancel();
  const rows = [...element.querySelectorAll<HTMLElement>(":scope > [data-fold-row]")];
  const ordered = closing ? rows.toReversed() : rows;
  for (const [index, row] of ordered.entries()) {
    const delay = Math.min(index * ROW_STAGGER_MS, ROW_STAGGER_MAX_MS);
    const away = { opacity: 0, transform: "translateY(-6px)" };
    const here = { opacity: 1, transform: "none" };
    row.animate(closing ? [here, away] : [away, here], {
      duration: closing ? 220 : 260,
      delay: closing ? delay : 40 + delay,
      easing: SMOOTH_EASING,
      fill: closing ? "forwards" : "backwards",
    });
  }
  const to = closing ? 0 : element.scrollHeight;
  return element.animate([{ height: `${from}px` }, { height: `${to}px` }], {
    duration,
    delay: closing ? 40 : 0,
    easing: FOLD_EASING,
    fill: "forwards",
  });
}

/**
 * Shows its children while open and `folded` while closed, moving between them visibly.
 *
 * @remarks
 * A finished turn's process folds into its header rather than vanishing (SPEC-0001, "过程的
 * 呈现": "跑完后的折叠"), and a project's workspaces into its row (SPEC-0001, "侧栏"). The
 * children stay mounted until the fold has played, then give way to `folded`; opening mounts them
 * at once and unfolds. Nothing plays on the first render, so a turn opened from history is simply
 * folded, and nothing plays when the user asked for less motion. The wrapper clips while it moves;
 * still, it keeps `className`, so a fold whose rows hold menus need not clip them.
 *
 * @sideEffects Animates the wrapper and its rows when `open` changes; cancels them on unmount.
 * @param props - Whether it is open, what it holds, what shows while folded, its test id, how
 * long the height takes, and the wrapper's class.
 * @returns The fold.
 */
export function Fold({
  open,
  children,
  folded = null,
  testId = "process",
  duration = FOLD_MS,
  className = "overflow-hidden",
}: {
  readonly open: boolean;
  readonly children: ReactNode;
  readonly folded?: ReactNode;
  readonly testId?: string;
  readonly duration?: number;
  readonly className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>(open ? "open" : "closed");
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    const still = reducedMotion();
    setPhase(open ? (still ? "open" : "opening") : still ? "closed" : "closing");
  }
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || (phase !== "opening" && phase !== "closing")) return undefined;
    const closing = phase === "closing";
    const animation = play(element, closing, duration);
    animation.onfinish = () => {
      // Open, the height goes back to following the content: a step's detail can still open.
      if (!closing) animation.cancel();
      setPhase(closing ? "closed" : "open");
    };
    return () => {
      animation.onfinish = null;
    };
  }, [phase, duration]);
  useLayoutEffect(
    () => () => {
      for (const animation of ref.current?.getAnimations({ subtree: true }) ?? []) animation.cancel();
    },
    [],
  );
  if (phase === "closed") return folded;
  return (
    <div
      ref={ref}
      className={className}
      style={phase === "open" ? undefined : { overflow: "hidden" }}
      data-testid={testId}
      data-fold={phase}
    >
      {children}
    </div>
  );
}
