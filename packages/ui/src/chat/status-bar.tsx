import type { SessionMetrics, StatusBarChoices } from "@atrium/protocol";
import { Coins, Database, Gauge, GearSix } from "../design/icons";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  STATUS_GROUPS,
  cacheHit,
  contextLevel,
  contextPercent,
  contextSegments,
  formatCost,
  formatSeconds,
  formatSpeed,
  formatTokens,
  formatWhole,
  shownGroups,
  totalTokens,
  withChoice,
} from "./status-figures";

/** What stands for a figure not known yet (SPEC-0001, "状态栏"). */
const UNKNOWN = "—";

/**
 * The dot between two parts of a summary.
 *
 * @remarks
 * Dimmer than the figures, as in the prototype.
 *
 * @sideEffects none
 * @returns The dot.
 */
function Sep() {
  return <span className="text-[var(--text-dim)]">·</span>;
}

/**
 * A card's title row: an icon, the title and, at the right, a total.
 *
 * @remarks
 * As the prototype's detail cards (design-language, "状态栏").
 *
 * @sideEffects none
 * @param props - The icon, title and total.
 * @returns The row.
 */
function CardHead({
  icon,
  title,
  total,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly total?: string;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-2 pb-2.5 font-medium text-[var(--text)] shadow-[inset_0_-0.5px_0_var(--line)]">
      {icon}
      {title}
      {total === undefined ? null : <span className="ml-auto">{total}</span>}
    </div>
  );
}

/**
 * A card's line: a name at the left and its value at the right.
 *
 * @remarks
 * A `sub` line is indented and dimmer, as part of the line above.
 *
 * @sideEffects none
 * @param props - The name, value and whether it is a part.
 * @returns The line.
 */
function Line({
  name,
  value,
  sub = false,
}: {
  readonly name: ReactNode;
  readonly value: string;
  readonly sub?: boolean;
}) {
  return (
    <div className={`flex h-[26px] items-center justify-between ${sub ? "pl-3 text-[var(--text-dim)]" : ""}`}>
      <span>{name}</span>
      <b className={`font-normal ${sub ? "text-[var(--text-muted)]" : "text-[var(--text-2)]"}`}>{value}</b>
    </div>
  );
}

/**
 * A card's footnote.
 *
 * @remarks
 * Says where the figures come from, below a hairline.
 *
 * @sideEffects none
 * @param props - The note.
 * @returns The footnote.
 */
function Foot({ children }: { readonly children: ReactNode }) {
  return (
    <div className="mt-2 pt-2 text-[length:var(--fs-xs)] text-[var(--text-dim)] shadow-[inset_0_0.5px_0_var(--line)]">
      {children}
    </div>
  );
}

/**
 * The context's ring: a circle that fills as the window does.
 *
 * @remarks
 * Empty while the figure is unknown.
 *
 * @sideEffects none
 * @param props - The percentage used.
 * @returns The ring.
 */
function Ring({ percent }: { readonly percent: number | null }) {
  const radius = 6.5;
  const around = 2 * Math.PI * radius;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className="-rotate-90" aria-hidden="true">
      <circle cx="8" cy="8" r={radius} fill="none" strokeWidth="2" className="stroke-[var(--line-strong)]" />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        stroke="currentColor"
        strokeDasharray={around.toFixed(2)}
        strokeDashoffset={(around * (1 - (percent ?? 0) / 100)).toFixed(2)}
        className="transition-[stroke-dashoffset] duration-300"
      />
    </svg>
  );
}

/**
 * A colour swatch before a context segment's name.
 *
 * @remarks
 * The same colour as the segment's part of the bar above.
 *
 * @sideEffects none
 * @param props - The colour.
 * @returns The swatch.
 */
function Swatch({ color }: { readonly color: string }) {
  return <span className="mr-2 inline-block size-2.5 rounded-[3px] align-[-1px]" style={{ background: color }} />;
}

/**
 * Tokens written whole, or a dash while unknown.
 *
 * @remarks
 * As the token card lists them.
 *
 * @sideEffects none
 * @param count - The tokens, if known.
 * @returns The text.
 */
function wholeTokens(count: number | undefined): string {
  return count === undefined ? UNKNOWN : `${formatWhole(count)} tok`;
}

/**
 * A part of the context window as a CSS width.
 *
 * @remarks
 * The context card's bar draws each segment this wide.
 *
 * @sideEffects none
 * @param tokens - The segment's tokens.
 * @param window - The window's tokens.
 * @returns The width, in percent.
 */
function share(tokens: number, window: number): string {
  return `${((tokens / window) * 100).toFixed(2)}%`;
}

/** How each group draws its summary and card. */
interface GroupDrawing {
  readonly summary: (metrics: SessionMetrics) => ReactNode;
  readonly card: (metrics: SessionMetrics) => ReactNode;
  /** The summary's colour, as the context's past 70% and 85%. */
  readonly tone?: (metrics: SessionMetrics) => string;
}

/** The context's segments' colours (design-language, "颜色"). */
const SEGMENT_COLORS = { system: "var(--ctx-sys)", tools: "var(--ctx-tools)", messages: "var(--ctx-msgs)" } as const;

/**
 * Each group's summary and card, by id (SPEC-0001, "状态栏").
 *
 * @remarks
 * The registry's names, descriptions and defaults are in `status-figures.ts`; written as the prototype
 * writes them.
 */
const DRAWINGS: Readonly<Record<string, GroupDrawing>> = {
  session: {
    summary: ({ turns, steps, timing }) => (
      <>
        <Gauge size={14} />
        {turns ?? UNKNOWN} 轮 {steps ?? UNKNOWN} 步<Sep />
        {timing?.tps == null ? UNKNOWN : formatSpeed(timing.tps)} tok/s
      </>
    ),
    card: ({ timing }) => (
      <>
        <CardHead icon={<Gauge size={15} />} title="会话统计" />
        <Line name="模型用时" value={timing === null ? UNKNOWN : formatSeconds(timing.modelMs)} />
        <Line name="首 token 平均（TTFT）" value={timing?.ttftMs == null ? UNKNOWN : formatSeconds(timing.ttftMs)} />
        <Line name="输出速度（TPS）" value={timing?.tps == null ? UNKNOWN : `${formatSpeed(timing.tps)} tok/s`} />
        <Foot>轮和步数整个会话文件，含其他分支；用时和速度是 Atrium 这次运行时测的</Foot>
      </>
    ),
  },
  tokens: {
    summary: ({ tokens }) => {
      const hit = tokens === null ? null : cacheHit(tokens);
      return (
        <>
          <Database size={14} />
          {tokens === null ? UNKNOWN : formatTokens(totalTokens(tokens))} tok
          <Sep />
          缓存命中 {hit === null ? UNKNOWN : `${hit}%`}
        </>
      );
    },
    card: ({ tokens, reasoning, branchTokens }) => {
      const hit = tokens === null ? null : cacheHit(tokens);
      return (
        <>
          <CardHead
            icon={<Database size={15} />}
            title="Token 用量"
            total={tokens === null ? UNKNOWN : `${formatWhole(totalTokens(tokens))} tok`}
          />
          <Line name="缓存命中" value={hit === null ? UNKNOWN : `${hit}%`} />
          <Line name="未缓存输入" value={wholeTokens(tokens?.input)} />
          <Line name="缓存读取" value={wholeTokens(tokens?.cacheRead)} />
          <Line name="缓存写入" value={wholeTokens(tokens?.cacheWrite)} />
          <Line name="输出" value={wholeTokens(tokens?.output)} />
          {reasoning === null ? null : <Line name="其中推理" value={wholeTokens(reasoning)} sub />}
          <Line name="当前分支" value={wholeTokens(branchTokens)} />
          <Foot>本会话累计：整个会话文件，含其他分支和压缩消耗</Foot>
        </>
      );
    },
  },
  context: {
    tone: ({ context }) => {
      const level = contextLevel(context === null ? null : contextPercent(context));
      return level === "danger" ? "text-[var(--danger)]" : level === "warn" ? "text-[var(--attn-text)]" : "";
    },
    summary: ({ context }) => {
      const percent = context === null ? null : contextPercent(context);
      return (
        <>
          <Ring percent={percent} />
          {percent === null ? UNKNOWN : `${percent}%`}
        </>
      );
    },
    card: ({ context }) => {
      if (context === null) {
        return (
          <>
            <CardHead icon={null} title={`上下文已用 ${UNKNOWN}`} />
            <Line name="当前模型没有给出上下文窗口" value="" />
          </>
        );
      }
      const percent = contextPercent(context);
      if (percent === null || context.tokens === null) {
        return (
          <>
            <CardHead icon={null} title={`上下文已用 ${UNKNOWN}`} />
            <Line name="刚压缩过，下一次回复后更新" value="" />
          </>
        );
      }
      const parts = contextSegments(context);
      return (
        <>
          <CardHead
            icon={null}
            title={`上下文已用 ${percent}%`}
            total={`~${formatTokens(context.tokens)} / ${formatTokens(context.window)}`}
          />
          {parts === null ? null : (
            <>
              <div className="mt-1 mb-3 flex h-1.5 gap-0.5 overflow-hidden rounded-[var(--r-pill)] bg-[var(--line)]">
                <i
                  className="h-full"
                  style={{ width: share(parts.system, context.window), background: SEGMENT_COLORS.system }}
                />
                <i
                  className="h-full"
                  style={{ width: share(parts.tools, context.window), background: SEGMENT_COLORS.tools }}
                />
                <i
                  className="h-full"
                  style={{ width: share(parts.messages, context.window), background: SEGMENT_COLORS.messages }}
                />
              </div>
              <Line
                name={
                  <>
                    <Swatch color={SEGMENT_COLORS.system} />
                    系统提示词
                  </>
                }
                value={`~${formatTokens(parts.system)}`}
              />
              <Line
                name={
                  <>
                    <Swatch color={SEGMENT_COLORS.tools} />
                    工具定义
                  </>
                }
                value={`~${formatTokens(parts.tools)}`}
              />
              <Line
                name={
                  <>
                    <Swatch color={SEGMENT_COLORS.messages} />
                    对话消息
                  </>
                }
                value={`~${formatTokens(parts.messages)}`}
              />
            </>
          )}
          <Foot>接近上限时 pi 会自动压缩</Foot>
        </>
      );
    },
  },
  cost: {
    summary: ({ cost }) => (
      <>
        <Coins size={14} />
        {cost === null ? UNKNOWN : formatCost(cost)}
      </>
    ),
    card: ({ cost }) => (
      <>
        <CardHead icon={<Coins size={15} />} title="费用" total={cost === null ? UNKNOWN : formatCost(cost)} />
        <Line name="计算方式" value="按 API 价格折算" />
        <Foot>订阅用户不实际付费</Foot>
      </>
    ),
  },
};

/**
 * One group of the status bar, with its card on hover.
 *
 * @remarks
 * The card shows 120 ms after the pointer comes, stays while it is on the group or the card, and
 * goes 100 ms after it leaves, as in the prototype; CSS times it, and keyboard focus shows it too.
 *
 * @sideEffects none
 * @param props - The group's drawing and the figures.
 * @returns The group.
 */
function Group({ drawing, metrics }: { readonly drawing: GroupDrawing; readonly metrics: SessionMetrics }) {
  const cardId = useId();
  // A warning colour stays on hover; only the plain grey brightens.
  const tone = drawing.tone?.(metrics) || "text-[var(--text-muted)] group-hover/item:text-[var(--text-2)]";
  return (
    <div className="group/item relative">
      <button
        type="button"
        aria-describedby={cardId}
        className={`inline-flex h-[26px] items-center gap-1.5 rounded-[var(--r-pill)] px-2.5 whitespace-nowrap group-has-[:focus-visible]/item:bg-[var(--hover)] group-hover/item:bg-[var(--hover)] ${tone}`}
      >
        {drawing.summary(metrics)}
      </button>
      <div
        role="tooltip"
        id={cardId}
        className="invisible absolute bottom-full left-1/2 z-30 mb-2 w-[300px] -translate-x-1/2 rounded-[14px] bg-[var(--surface-1)] px-4 pt-3.5 pb-3 text-[length:var(--fs-meta)] text-[var(--text-muted)] opacity-0 shadow-[var(--float-shadow)] transition-[opacity,visibility] delay-100 duration-150 group-has-[:focus-visible]/item:visible group-has-[:focus-visible]/item:opacity-100 group-hover/item:visible group-hover/item:opacity-100 group-hover/item:delay-[120ms] dark:bg-[var(--surface-2)]"
      >
        {drawing.card(metrics)}
      </div>
    </div>
  );
}

/**
 * The panel that switches the status bar's groups on and off.
 *
 * @remarks
 * Each row is the group's name and what it shows, how it looks now, faded while off, and a switch;
 * "恢复默认" goes back to the defaults. The choice is global (SPEC-0001, "状态栏").
 *
 * @sideEffects none
 * @param props - The figures, the choices and where a change goes.
 * @returns The panel.
 */
function Customizer({
  metrics,
  choices,
  onChoose,
}: {
  readonly metrics: SessionMetrics;
  readonly choices: StatusBarChoices;
  readonly onChoose: (choices: StatusBarChoices) => void;
}) {
  const shown = shownGroups(choices);
  return (
    <div
      role="dialog"
      aria-label="状态栏"
      className="absolute right-0 bottom-full z-30 mb-2 w-[380px] rounded-[var(--r-card)] bg-[var(--surface-1)] p-2 text-[var(--text-2)] shadow-[var(--float-shadow)] dark:bg-[var(--surface-2)]"
    >
      <div className="px-2 pt-1.5 pb-2.5">
        <b className="block text-[length:var(--fs-meta)] font-semibold text-[var(--text)]">状态栏</b>
        <span className="text-[length:var(--fs-xs)] text-[var(--text-dim)]">
          选择在输入框下方显示哪些指标，对所有会话生效
        </span>
      </div>
      {STATUS_GROUPS.map((group) => {
        const on = shown.includes(group.id);
        const drawing = DRAWINGS[group.id];
        return (
          <button
            key={group.id}
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={group.name}
            onClick={() => onChoose(withChoice(choices, group.id, !on))}
            className="flex w-full items-center gap-3 rounded-[var(--r-md)] p-2 text-left hover:bg-[var(--hover)]"
          >
            <span className="min-w-0 flex-1">
              <span className="mb-1.5 flex items-baseline gap-2">
                <b className="text-[length:var(--fs-meta)] font-medium whitespace-nowrap text-[var(--text)]">
                  {group.name}
                </b>
                <small className="truncate text-[length:var(--fs-xs)] text-[var(--text-dim)]">
                  {group.description}
                </small>
              </span>
              <span
                className={`inline-flex h-6 items-center gap-1.5 rounded-[var(--r)] bg-[var(--hover)] px-2 text-[length:var(--fs-sm)] whitespace-nowrap text-[var(--text-muted)] tabular-nums transition-opacity ${on ? "" : "opacity-40"}`}
              >
                {drawing?.summary(metrics)}
              </span>
            </span>
            <span
              aria-hidden="true"
              className={`relative h-5 w-[34px] flex-none rounded-full transition-colors after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-white after:shadow after:transition-transform ${on ? "bg-[var(--tint)] after:translate-x-3.5" : "bg-[var(--line-strong)]"}`}
            />
          </button>
        );
      })}
      <div className="mt-1.5 flex items-center justify-between px-2 pt-2 pb-0.5 text-[length:var(--fs-xs)] text-[var(--text-dim)] shadow-[inset_0_0.5px_0_var(--line)]">
        <span>悬停任一指标可看详情</span>
        <button type="button" className="text-[var(--tint)]" onClick={() => onChoose({})}>
          恢复默认
        </button>
      </div>
    </div>
  );
}

/**
 * The status bar under the input box (SPEC-0001, "状态栏").
 *
 * @remarks
 * Centred groups, each an icon and a line, with a card on hover; at the end the one way to choose
 * the groups, a button faint until the bar is hovered. Escape or a click outside closes its panel.
 *
 * @sideEffects While the panel is open, listens for clicks and Escape on the document.
 * @param props - The session's figures, the groups chosen, and where a new choice goes.
 * @returns The bar.
 */
export function StatusBar({
  metrics,
  choices,
  onChoose,
}: {
  readonly metrics: SessionMetrics;
  readonly choices: StatusBarChoices;
  readonly onChoose: (choices: StatusBarChoices) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    /**
     * Closes the panel on a click outside the bar.
     *
     * @remarks
     * See `StatusBar`.
     *
     * @sideEffects May close the panel.
     * @param event - The pointer event.
     */
    const close = (event: Event): void => {
      if (!(event.target instanceof Node && root.current?.contains(event.target) === true)) setOpen(false);
    };
    /**
     * Closes the panel on Escape, and keeps the Escape from the input box, which would stop a run.
     *
     * @remarks
     * See `StatusBar`.
     *
     * @sideEffects May close the panel; stops the event.
     * @param event - The key event.
     */
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  return (
    <div
      ref={root}
      role="group"
      aria-label="状态栏"
      className="group/bar mx-auto mb-2 flex h-7 items-center justify-center gap-1.5 text-[length:var(--fs-sm)] tabular-nums"
    >
      {shownGroups(choices).map((id) => {
        const drawing = DRAWINGS[id];
        return drawing === undefined ? null : <Group key={id} drawing={drawing} metrics={metrics} />;
      })}
      <div className="relative">
        <button
          type="button"
          aria-label="自定义状态栏"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={`ml-0.5 inline-flex size-[26px] items-center justify-center rounded-[var(--r)] text-[var(--text-dim)] transition-opacity hover:bg-[var(--hover)] hover:text-[var(--text-2)] group-hover/bar:opacity-100 ${open ? "bg-[var(--hover)] opacity-100" : "opacity-50"}`}
        >
          <GearSix size={14} />
        </button>
        {open ? <Customizer metrics={metrics} choices={choices} onChoose={onChoose} /> : null}
      </div>
    </div>
  );
}
