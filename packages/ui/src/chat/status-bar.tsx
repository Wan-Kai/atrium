import type { SessionMetrics, StatusBarChoices } from "@atrium/protocol";
import { Coins, Database, Gauge, GearSix } from "../design/icons";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  STATUS_GROUPS,
  cacheHit,
  contextLevel,
  type ContextRow,
  type ContextRowKey,
  contextPercent,
  contextRows,
  formatCost,
  formatSeconds,
  formatSpeed,
  formatTokens,
  formatWhole,
  foundAgo,
  planNearLimit,
  planPercent,
  planTitle,
  resetText,
  shownGroups,
  totalTokens,
  windowName,
  windowShare,
  withChoice,
} from "./status-figures";
import { useClock } from "../state/clock";

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
 * As the prototype's detail cards, without a line under it (design-language, "状态栏").
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
    <div className="mb-2.5 flex items-center gap-2 font-medium text-[var(--text)]">
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
 * Empty while the figure is unknown. The used part is the text's colour unless given another, as
 * the plan's is (design-language, "状态栏").
 *
 * @sideEffects none
 * @param props - The percentage used, and the used part's colour.
 * @returns The ring.
 */
function Ring({ percent, color = "currentColor" }: { readonly percent: number | null; readonly color?: string }) {
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
        stroke={color}
        strokeDasharray={around.toFixed(2)}
        strokeDashoffset={(around * (1 - (percent ?? 0) / 100)).toFixed(2)}
        className="transition-[stroke-dashoffset] duration-300"
      />
    </svg>
  );
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

/** What a card can do to the session: compact it, when it can be. */
interface CardActions {
  readonly onCompact: (() => void) | undefined;
  readonly compactable: boolean;
}

/** How each group draws its summary and card. */
interface GroupDrawing {
  readonly summary: (metrics: SessionMetrics) => ReactNode;
  readonly card: (metrics: SessionMetrics, actions: CardActions) => ReactNode;
  /** The summary's colour, as the context's past 70% and 85%. */
  readonly tone?: (metrics: SessionMetrics) => string;
  /** A card wider than the rest, 340px (design-language, "状态栏"). */
  readonly wide?: boolean;
  /** Whether the group shows for these figures; always when left out. */
  readonly shown?: (metrics: SessionMetrics) => boolean;
}

/**
 * The plan's card: each window's name, when it resets, and how much of it is used.
 *
 * @remarks
 * SPEC-0001 ("M1.13 的上下文细分与套餐用量"): titled by the provider and plan, with how long ago
 * the usage was found; a window at 80% or more is orange. The times go on with the clock, drawn
 * again each minute while the card is there, though no new usage comes.
 *
 * @sideEffects Draws itself again every minute while mounted.
 * @param props - The usage.
 * @returns The card.
 */
function PlanCard({ plan }: { readonly plan: NonNullable<SessionMetrics["plan"]> }) {
  const clock = useClock();
  const [, setMinutes] = useState(0);
  useEffect(() => clock.every(60_000, () => setMinutes((minutes) => minutes + 1)), [clock]);
  const now = clock.now();
  return (
    <>
      <div className="mb-2.5 flex items-center gap-2 font-medium text-[var(--text)]">
        {planTitle(plan)}
        <span className="ml-auto text-[length:var(--fs-sm)] font-normal text-[var(--text-dim)]">
          {foundAgo(plan.at, now)}
        </span>
      </div>
      {plan.windows.map((window, at) => {
        const used = Math.round(window.usedPercent);
        const near = planNearLimit(used);
        return (
          <div
            // By place too: two windows may be as long and of one model.
            key={`${String(at)}\n${String(window.seconds)}`}
            className="mb-2.5 last:mb-0"
            data-testid="plan-window"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-[var(--text-2)]">{windowName(window)}</span>
              <span className="flex-1" />
              <span className="text-[length:var(--fs-sm)] text-[var(--text-dim)]">
                {resetText(window.resetsAt, now)}
              </span>
              <span className="w-[34px] text-right text-[length:var(--fs-sm)] text-[var(--text-2)]">{used}%</span>
            </div>
            <div className="mt-1.5 h-[5px] overflow-hidden rounded-[var(--r-pill)] bg-[var(--line)]">
              <i
                className="block h-full rounded-[var(--r-pill)]"
                style={{ width: `${String(used)}%`, background: near ? "var(--attn)" : "var(--tint)" }}
              />
            </div>
          </div>
        );
      })}
    </>
  );
}

/** The context's rows' colours (design-language, "颜色"). */
const ROW_COLORS: Readonly<Record<ContextRowKey, string>> = {
  messages: "var(--ctx-msgs)",
  system: "var(--ctx-sys)",
  memory: "var(--ctx-memory)",
  skills: "var(--ctx-skills)",
  builtin: "var(--ctx-tools)",
  mcp: "var(--ctx-mcp)",
  extensions: "var(--ctx-ext)",
};

/** The compaction reserve's stripes, in the bar and its swatch. */
const RESERVE_STRIPES = "repeating-linear-gradient(135deg, var(--ctx-reserve) 0 2px, transparent 2px 4px)";

/**
 * One of the context card's rows, opening to what it counts when it has any.
 *
 * @remarks
 * SPEC-0001 ("M1.13 的上下文细分与套餐用量"): a colour, the name, how many things, "~N" and the
 * share of the window; memory files are written in a monospace face (design-language, "状态栏").
 *
 * @sideEffects none
 * @param props - The row, the window, whether it is open and how to open or close it.
 * @returns The row and, when open, its things.
 */
function ContextLine({
  row,
  window,
  open,
  onToggle,
}: {
  readonly row: ContextRow;
  readonly window: number;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const opens = row.items.length > 0;
  const inside = (
    <>
      <span
        aria-hidden="true"
        className={`inline-flex w-2.5 flex-none text-[var(--text-dim)] transition-transform duration-200 ${open ? "rotate-90" : ""}`}
      >
        {opens ? "›" : ""}
      </span>
      <span className="size-2.5 flex-none rounded-[3px]" style={{ background: ROW_COLORS[row.key] }} />
      <span className="min-w-0 flex-1 truncate text-left text-[var(--text-2)]">
        {row.name}
        {row.count === null ? null : (
          <span className="ml-1 text-[length:var(--fs-sm)] text-[var(--text-dim)]">{row.count}</span>
        )}
      </span>
      <span className="w-12 text-right text-[var(--text-muted)]">~{formatTokens(row.tokens)}</span>
      <span className="w-10 text-right text-[length:var(--fs-sm)] text-[var(--text-dim)]">
        {windowShare(row.tokens, window)}
      </span>
    </>
  );
  return (
    <>
      {opens ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="-mx-1.5 flex h-[26px] w-[calc(100%+12px)] items-center gap-2 rounded-[6px] px-1.5 hover:bg-[var(--hover)]"
        >
          {inside}
        </button>
      ) : (
        <div className="flex h-[26px] items-center gap-2">{inside}</div>
      )}
      {open ? (
        <ul aria-label={row.name} className="mb-1 ml-[18px]">
          {/* By place too: an extension's tool and its prompt part may share a name. */}
          {row.items.map((item, at) => (
            <li
              key={`${String(at)}\n${item.name}`}
              className="flex h-[22px] items-center gap-2 text-[length:var(--fs-sm)]"
            >
              <span
                title={item.name}
                className={`min-w-0 flex-1 truncate text-[var(--text-muted)] ${row.key === "memory" ? "font-mono text-[11.5px]" : ""}`}
              >
                {item.name}
              </span>
              <span className="text-[var(--text-dim)]">~{formatTokens(item.tokens)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/**
 * The context's card: what fills the window, what pi keeps free, and a way to compact.
 *
 * @remarks
 * SPEC-0001 ("M1.13 的上下文细分与套餐用量"). Without a model's window, or right after a
 * compaction, it says so; without the parts, only the total and that pi compacts near the limit.
 * Rows open and close in place, not remembered. "压缩会话" does what `/compact` does, unless the
 * session cannot be compacted now.
 *
 * @sideEffects none
 * @param props - The context and what the card can do.
 * @returns The card.
 */
function ContextCard({
  context,
  actions,
}: {
  readonly context: SessionMetrics["context"];
  readonly actions: CardActions;
}) {
  const [opened, setOpened] = useState<ReadonlySet<ContextRowKey>>(new Set());
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
  const head = (
    <CardHead
      icon={null}
      title={`上下文已用 ${percent}%`}
      total={`~${formatTokens(context.tokens)} / ${formatTokens(context.window)}`}
    />
  );
  const split = contextRows(context);
  if (split === null) {
    return (
      <>
        {head}
        <Foot>接近上限时 pi 会自动压缩</Foot>
      </>
    );
  }
  const { rows, reserve, compaction, free } = split;
  /**
   * Opens a row, or closes it.
   *
   * @remarks
   * See `ContextCard`.
   *
   * @sideEffects Updates component state.
   * @param key - The row.
   */
  const toggle = (key: ContextRowKey): void =>
    setOpened((now) => {
      const next = new Set(now);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <>
      {head}
      <div className="mt-1 mb-3 flex h-1.5 gap-0.5 overflow-hidden rounded-[var(--r-pill)] bg-[var(--line)]">
        {rows.map((row) => (
          <i
            key={row.key}
            className="h-full"
            style={{ width: share(row.tokens, context.window), background: ROW_COLORS[row.key] }}
          />
        ))}
        {reserve === null ? null : (
          <i
            className="ml-auto h-full"
            style={{ width: share(reserve, context.window), background: RESERVE_STRIPES }}
          />
        )}
      </div>
      {rows.map((row) => (
        <ContextLine
          key={row.key}
          row={row}
          window={context.window}
          open={opened.has(row.key)}
          onToggle={() => toggle(row.key)}
        />
      ))}
      {reserve === null ? null : (
        <div className="flex h-[26px] items-center gap-2">
          <span className="w-2.5 flex-none" />
          <span
            className="size-2.5 flex-none rounded-[3px] shadow-[inset_0_0_0_0.5px_var(--line-strong)]"
            style={{ background: RESERVE_STRIPES }}
          />
          <span className="flex-1 text-[var(--text-2)]">自动压缩预留</span>
          <span className="w-12 text-right text-[var(--text-muted)]">{formatTokens(reserve)}</span>
          <span className="w-10 text-right text-[length:var(--fs-sm)] text-[var(--text-dim)]">
            {windowShare(reserve, context.window)}
          </span>
        </div>
      )}
      <div className="flex h-[26px] items-center gap-2">
        <span className="w-2.5 flex-none" />
        <span className="size-2.5 flex-none rounded-[3px] bg-[var(--line)]" />
        <span className="flex-1 text-[var(--text-2)]">剩余空间</span>
        <span className="w-12 text-right text-[var(--text-muted)]">~{formatTokens(free)}</span>
        <span className="w-10 text-right text-[length:var(--fs-sm)] text-[var(--text-dim)]">
          {windowShare(free, context.window)}
        </span>
      </div>
      <div className="mt-2 flex min-h-[26px] items-center gap-2 pt-2 text-[length:var(--fs-sm)] text-[var(--text-dim)] shadow-[inset_0_0.5px_0_var(--line)]">
        <span className="flex-1">
          {compaction === "off"
            ? "自动压缩已关"
            : compaction === "unknown"
              ? "距自动压缩还剩 —"
              : `距自动压缩还剩 ~${formatTokens(free)}`}
        </span>
        <button
          type="button"
          disabled={!actions.compactable || actions.onCompact === undefined}
          onClick={actions.onCompact}
          className="inline-flex h-6 items-center rounded-[var(--r-pill)] bg-[var(--surface-1)] px-2.5 text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] hover:bg-[var(--hover)] disabled:opacity-40 disabled:hover:bg-[var(--surface-1)] dark:bg-[var(--surface-2)]"
        >
          压缩会话
        </button>
      </div>
      <div className="mt-0.5 text-[length:var(--fs-xs)] text-[var(--text-dim)]">各段按字数估算</div>
    </>
  );
}

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
    card: ({ context }, actions) => <ContextCard context={context} actions={actions} />,
    wide: true,
  },
  plan: {
    shown: ({ plan }) => plan !== null && plan.windows.length > 0,
    tone: ({ plan }) => {
      const percent = plan === null ? null : planPercent(plan);
      return percent !== null && planNearLimit(percent) ? "text-[var(--attn-text)]" : "";
    },
    summary: ({ plan }) => {
      const percent = plan === null ? null : planPercent(plan);
      const near = percent !== null && planNearLimit(percent);
      return (
        <>
          <Ring percent={percent} color={near ? "var(--attn)" : "var(--tint)"} />
          套餐 {percent === null ? UNKNOWN : `${String(percent)}%`}
        </>
      );
    },
    card: ({ plan }) => (plan === null ? null : <PlanCard plan={plan} />),
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
 * The 8px between the group and the card belong to the card, so the pointer can cross to it and
 * use what is in it (SPEC-0001, "状态栏").
 *
 * @sideEffects none
 * @param props - The group's drawing, the figures and what its card can do.
 * @returns The group.
 */
function Group({
  drawing,
  metrics,
  actions,
}: {
  readonly drawing: GroupDrawing;
  readonly metrics: SessionMetrics;
  readonly actions: CardActions;
}) {
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
        className={`invisible absolute bottom-full left-1/2 z-30 -translate-x-1/2 pb-2 opacity-0 transition-[opacity,visibility] delay-100 duration-150 group-has-[:focus-visible]/item:visible group-has-[:focus-visible]/item:opacity-100 group-hover/item:visible group-hover/item:opacity-100 group-hover/item:delay-[120ms] ${drawing.wide === true ? "w-[340px]" : "w-[300px]"}`}
      >
        {/* Never past the window: a long list opened in it scrolls (design-language, "状态栏"). */}
        <div className="max-h-[calc(100vh-140px)] overflow-y-auto rounded-[14px] bg-[var(--surface-1)] px-4 pt-3.5 pb-3 text-[length:var(--fs-meta)] text-[var(--text-muted)] shadow-[var(--float-shadow)] dark:bg-[var(--surface-2)]">
          {drawing.card(metrics, actions)}
        </div>
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
 * @param props - The session's figures, the groups chosen, where a new choice goes, and how and
 * whether the session can be compacted from the context's card.
 * @returns The bar.
 */
export function StatusBar({
  metrics,
  choices,
  onChoose,
  onCompact,
  compactable = false,
}: {
  readonly metrics: SessionMetrics;
  readonly choices: StatusBarChoices;
  readonly onChoose: (choices: StatusBarChoices) => void;
  readonly onCompact?: () => void;
  readonly compactable?: boolean;
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
        return drawing === undefined || drawing.shown?.(metrics) === false ? null : (
          <Group key={id} drawing={drawing} metrics={metrics} actions={{ onCompact, compactable }} />
        );
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
