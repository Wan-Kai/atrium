import { useLayoutEffect, useRef, useState } from "react";
import { type Launch, type LaunchStep, baseName } from "../state/new-workspace";
import { Fold } from "./fold";
import { type RailNode, RailMarks } from "./steps";

/** Each step's words on the rail (SPEC-0001, "M1.11 的新建工作区"). */
const STEP_WORDS: Readonly<Record<LaunchStep, string>> = {
  name: "起名",
  worktree: "创建 worktree",
  session: "启动会话",
  message: "发出消息",
};

/** How long the steps take to fold into their summary, and to unfold (design-language, "新建工作区页"). */
const FOLD_MS = 280;

/** The height's curve as the steps fold (design-language, "新建工作区页"). */
const FOLD_EASING = "cubic-bezier(0.45, 0, 0.15, 1)";

/** The rows' curve: smooth, no bounce. */
const SMOOTH_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

/** A rail row's height, which the folded steps keep for their summary. */
const ROW_PX = 30;

/** What a turn shows of the launch that sent its message (SPEC-0001, "M1.11 的新建工作区"). */
export interface LaunchInTurn {
  readonly launch: Launch;
  /** Why its failed step failed, in Chinese; `null` while none has. */
  readonly reason: string | null;
  /** The name of the workspace it went into, for the summary of one already there. */
  readonly place: string | null;
  /** The failed step's "重试". */
  readonly onRetry: () => void;
}

/**
 * The rail's node for a step of a launch.
 *
 * @remarks
 * Done before the step going on, failed or going on at it; the steps after it are not drawn.
 *
 * @sideEffects none
 * @param launch - The launch.
 * @param at - The step's place.
 * @returns The node.
 */
function launchNode(launch: Launch, at: number): RailNode {
  if (at < launch.done) return "dot";
  return launch.failure === undefined ? "live" : "fail";
}

/**
 * The words after a step's name on the rail.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的新建工作区"): naming says what it goes by, then the name, or that it fell
 * back on a random one; creating the worktree says its branch, unless naming just said it, and its
 * base, once the branch is known.
 *
 * @sideEffects none
 * @param launch - The launch.
 * @param step - The step.
 * @returns The words, or `null` for none.
 */
function stepDetail(launch: Launch, step: LaunchStep): string | null {
  const { worktree, named } = launch;
  if (worktree === null) return null;
  const { branch } = worktree;
  if (step === "name") {
    if (named === null || branch === null) return "按第一条消息";
    return named === "model" ? branch : `没起成，用随机名 ${branch}`;
  }
  if (step !== "worktree" || branch === null) return null;
  return named === "model" ? `基于 ${baseName(worktree.base)}` : `${branch} · 基于 ${baseName(worktree.base)}`;
}

/**
 * The summary the steps fold into once the message has gone.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的新建工作区"): "在 atrium/fix-login 建好工作区 · 基于 origin/main · 用时 4 秒",
 * or "在 xxx 里开好会话" into a workspace already there. A launch quicker than a second says one.
 *
 * @sideEffects none
 * @param props - The launch, sent, and the name of the workspace it went into.
 * @returns The summary.
 */
function Summary({ launch, place }: { readonly launch: Launch; readonly place: string | null }) {
  const { worktree } = launch;
  if (worktree === null) {
    return (
      <>
        在 <span className="text-[var(--text-muted)]">{place}</span> 里开好会话
      </>
    );
  }
  const seconds = Math.max(1, Math.round(((launch.sentAt ?? launch.startedAt) - launch.startedAt) / 1000));
  return (
    <>
      在 <span className="text-[var(--text-muted)]">{worktree.branch}</span> 建好工作区 · 基于 {baseName(worktree.base)}{" "}
      · 用时 {seconds} 秒
    </>
  );
}

/**
 * One step of a launch on its turn's rail.
 *
 * @remarks
 * Styled as a process step (design-language, "新建工作区页"): going on, its name shimmers; failed,
 * the reason goes under it in red, with "重试" at the line's end. A step that has just started
 * plays the rail's entrance.
 *
 * @sideEffects Calls `onRetry` when "重试" is clicked.
 * @param props - The launch, the step and its place, why it failed, its place on the rail, whether
 * it enters, and what "重试" does.
 * @returns The row.
 */
function StepRow({
  launch,
  step,
  at,
  reason,
  first,
  last,
  enter,
  onRetry,
}: {
  readonly launch: Launch;
  readonly step: LaunchStep;
  readonly at: number;
  readonly reason: string | null;
  readonly first: boolean;
  readonly last: boolean;
  readonly enter: boolean;
  readonly onRetry: () => void;
}) {
  const node = launchNode(launch, at);
  const detail = stepDetail(launch, step);
  return (
    <div
      className={`relative min-w-0 pl-[30px] ${enter ? "atrium-step-enter" : ""}`}
      data-testid="launch-step"
      data-state={node}
      data-fold-row
    >
      <RailMarks node={node} first={first} last={last} />
      <div className="atrium-step-line flex min-h-[30px] min-w-0 items-center gap-1.5 text-[length:var(--fs-meta)]">
        <span className={`flex-none text-[var(--text-2)] ${node === "live" ? "atrium-shimmer" : ""}`}>
          {STEP_WORDS[step]}
        </span>
        {detail === null ? null : <span className="min-w-0 truncate text-[var(--text-dim)]">{detail}</span>}
      </div>
      {node === "fail" && reason !== null ? (
        <p
          className="flex items-center gap-2.5 pb-1.5 text-[length:var(--fs-meta)] text-[var(--danger)]"
          data-testid="launch-failure"
        >
          <span role="alert" className="min-w-0 truncate">
            {reason}
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="atrium-press -mx-1 flex-none rounded-[var(--r-sm)] px-1 text-[var(--tint)] hover:bg-[var(--hover)]"
          >
            重试
          </button>
        </p>
      ) : null}
    </div>
  );
}

/**
 * Whether the user asked for less motion.
 *
 * @remarks
 * The steps then fold into their summary at once (design-language, "新建工作区页").
 *
 * @sideEffects none
 * @returns Whether to skip the motion.
 */
function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Folds the steps' wrapper down to its summary's row, the rows fading out and rising, last first.
 *
 * @remarks
 * As a process folds (design-language, "动效 · 过程轨道"), but to one row rather than to nothing, as
 * the summary takes the first row's place: 0.28 s, `cubic-bezier(.45, 0, .15, 1)`.
 *
 * @sideEffects Starts Web Animations on the element and its `[data-fold-row]` rows.
 * @param element - The wrapper.
 * @returns The height's animation.
 */
function foldToSummary(element: HTMLElement): Animation {
  const rows = [...element.querySelectorAll<HTMLElement>("[data-fold-row]")].toReversed();
  for (const [index, row] of rows.entries()) {
    row.animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "translateY(-6px)" },
      ],
      { duration: 220, delay: Math.min(index * 14, 120), easing: SMOOTH_EASING, fill: "forwards" },
    );
  }
  return element.animate([{ height: `${element.getBoundingClientRect().height}px` }, { height: `${ROW_PX}px` }], {
    duration: FOLD_MS,
    easing: FOLD_EASING,
    fill: "forwards",
  });
}

/**
 * The launch's steps on its turn's rail, and once the message has gone, their summary.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的新建工作区"), design-language ("新建工作区页"). The steps grow one by one, the
 * ones not started not drawn; a step that has started since this was first shown plays the rail's
 * entrance, and so does the first, shown as the message is sent, but none shown already, as when
 * the session shows the launch again. Once the message has gone, the steps fold in place into one
 * grey row, "›" before it, which opens them again; the rail goes on below when the agent's steps
 * follow.
 *
 * @sideEffects Animates the steps as they fold into their summary, unless the user asked for less
 * motion; cancels that on unmount.
 * @param props - What the turn shows of the launch, and whether the agent's steps follow on the rail.
 * @returns The steps or their summary.
 */
export function LaunchSteps({ shown, continues }: { readonly shown: LaunchInTurn; readonly continues: boolean }) {
  const { launch, reason, place, onRetry } = shown;
  const sent = launch.sentAt !== null;
  // Shown as it is sent, the first step enters too; shown later, the steps there do not.
  const [there] = useState(
    () => new Set(launch.done === 0 && launch.failure === undefined ? [] : launch.steps.slice(0, launch.done + 1)),
  );
  const [phase, setPhase] = useState<"steps" | "folding" | "summary">(sent ? "summary" : "steps");
  const [wasSent, setWasSent] = useState(sent);
  if (sent !== wasSent) {
    setWasSent(sent);
    if (!sent) setPhase("steps");
    else setPhase(reducedMotion() ? "summary" : "folding");
  }
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = wrapper.current;
    if (phase !== "folding" || element === null) return undefined;
    const animation = foldToSummary(element);
    animation.onfinish = () => setPhase("summary");
    return () => {
      animation.onfinish = null;
      for (const one of element.getAnimations({ subtree: true })) one.cancel();
    };
  }, [phase]);
  const count = sent ? launch.steps.length : Math.min(launch.done + 1, launch.steps.length);
  /**
   * The steps' rows, from the first to the one going on or failed.
   *
   * @remarks
   * See `LaunchSteps`.
   *
   * @sideEffects none
   * @param under - Whether they hang under the summary, which the rail comes down from.
   * @returns The rows.
   */
  const rows = (under: boolean) =>
    launch.steps
      .slice(0, count)
      .map((step, at) => (
        <StepRow
          key={step}
          launch={launch}
          step={step}
          at={at}
          reason={reason}
          first={!under && at === 0}
          last={at === count - 1 && !continues}
          enter={!there.has(step)}
          onRetry={onRetry}
        />
      ));
  if (phase === "steps") return <div data-testid="launch-steps">{rows(false)}</div>;
  const summary = (
    <button
      type="button"
      aria-expanded={open}
      disabled={phase === "folding"}
      onClick={() => setOpen(!open)}
      data-testid="launch-summary"
      className={`atrium-press-row relative flex min-h-[30px] w-full min-w-0 items-center pl-[30px] text-left text-[length:var(--fs-meta)] text-[var(--text-dim)] enabled:hover:text-[var(--text-muted)] ${
        phase === "folding" ? "atrium-fold-summary absolute inset-x-0 top-0" : ""
      } ${open ? "[&_[data-node=more]_svg]:rotate-90" : ""}`}
    >
      <RailMarks node="more" first last={!continues && !open} />
      <span className="min-w-0 truncate">
        <Summary launch={launch} place={place} />
      </span>
    </button>
  );
  if (phase === "folding") {
    return (
      <div ref={wrapper} className="relative overflow-hidden">
        <div data-testid="launch-steps">{rows(false)}</div>
        {summary}
      </div>
    );
  }
  return (
    <>
      {summary}
      <Fold open={open} duration={FOLD_MS} testId="launch-steps">
        {rows(true)}
      </Fold>
    </>
  );
}
