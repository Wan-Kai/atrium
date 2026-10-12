import { CommandError, type ModelListView } from "@atrium/client";
import type { ModelRef, ThinkingLevel } from "@atrium/protocol";
import { ArrowClockwise, CaretDown, Check, Lightning } from "../design/icons";
import { type RefObject, useContext, useEffect, useRef, useState } from "react";
import { DotSeedContext, paintDots, reducedMotion, sweepProgress } from "../design/dots";
import { useDarkMode } from "../design/use-dark-mode";
import { EffortBox } from "./effort-box";
import {
  LEVEL_NAMES,
  type ShownModel,
  coverageOf,
  formatTokens,
  groupByProvider,
  levelHint,
  providerOf,
} from "./model-choice";

/** How long the button's dots take to reach a new level. */
const DOTS_EASE_MS = 380;

/** Which parts of the panel are open: both, or one from its shortcut. */
type PanelMode = "all" | "model" | "effort";

/** Props of {@link ModelPicker}. */
export interface ModelPickerProps {
  /** The model to show; `null` when there is none yet. */
  readonly shown: ShownModel | null;
  /** The container's models. */
  readonly list: ModelListView;
  /** While a stop waits for pi, nothing can change. */
  readonly disabled: boolean;
  /** The panel opened: the list should be asked for. */
  readonly onOpen: () => void;
  /** "刷新": pi should look again. */
  readonly onRefresh: () => void;
  readonly onChooseModel: (model: ModelRef) => void;
  readonly onChooseLevel: (level: ThinkingLevel) => void;
}

/**
 * The model button beside the send button, and the panel it opens.
 *
 * @remarks
 * SPEC-0001 ("输入框", "模型与输入框"), prototyped in `app-prototype.html`: a pill with the
 * provider's official icon, the model's name and the level; a layer of dots fills it from the left
 * as the level rises, and at the model's top level the dots turn to brand colours with a sweep
 * and a pale blue glow. It opens a panel above it: the models grouped by logged-in provider, each
 * row with its name and basics (context, longest output, whether it takes images) and a check on
 * the current one, a click switching and closing; below, the thinking level box, which does not
 * close the panel. ⌘⇧I opens only the models, ⌘⇧E only the thinking level with the box focused.
 * Opening asks for the list, which the host answers from its cache; "刷新" makes pi look again,
 * with the old list shown meanwhile. Escape and a click outside close it.
 *
 * @sideEffects Listens for ⌘⇧I and ⌘⇧E on the window; while open, for clicks and Escape on the
 * document; draws the dots on a canvas; calls the handlers.
 * @param props - The model, the list, whether it is disabled, and what to do.
 * @returns The button and, when open, the panel.
 */
export function ModelPicker({
  shown,
  list,
  disabled,
  onOpen,
  onRefresh,
  onChooseModel,
  onChooseLevel,
}: ModelPickerProps) {
  const [mode, setMode] = useState<PanelMode | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const level = shown?.level ?? null;
  const levels = shown?.levels ?? [];
  const full = level !== null && levels.length > 1 && levels.at(-1) === level;
  useChipDots(chip, canvas, coverageOf(level, levels), full);

  // The latest handlers for the window's key listener, which is added once.
  const opening = useRef({ disabled, onOpen });
  useEffect(() => {
    opening.current = { disabled, onOpen };
  });
  useEffect(() => {
    /**
     * Opens the panel on ⌘⇧I or ⌘⇧E.
     *
     * @remarks
     * Shift changes the letter's case, so it is compared in lower case.
     *
     * @sideEffects May open the panel and ask for the list.
     * @param event - The key.
     */
    const onKey = (event: KeyboardEvent): void => {
      if (!event.metaKey || !event.shiftKey || opening.current.disabled) return;
      const key = event.key.toLowerCase();
      if (key !== "i" && key !== "e") return;
      event.preventDefault();
      setMode(key === "i" ? "model" : "effort");
      opening.current.onOpen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (mode === null) return undefined;
    /**
     * Closes the panel on a click outside it.
     *
     * @remarks
     * See `ModelPicker`.
     *
     * @sideEffects May close the panel.
     * @param event - The pointer event.
     */
    const close = (event: Event): void => {
      if (!(event.target instanceof Node && root.current?.contains(event.target) === true)) setMode(null);
    };
    /**
     * Closes the panel on Escape, and keeps the Escape from anything else.
     *
     * @remarks
     * ⌘⇧I opens the panel with the focus left in the input box, whose Escape stops a run; caught
     * before it reaches the box, the Escape only closes the panel.
     *
     * @sideEffects May close the panel; stops the event.
     * @param event - The key event.
     */
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMode(null);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape, true);
    };
  }, [mode]);

  const levelName = level === null ? null : LEVEL_NAMES[level];
  const shortcut = "（⌘⇧I / ⌘⇧E）";
  return (
    <div ref={root} className="relative">
      <button
        ref={chip}
        type="button"
        disabled={disabled}
        aria-label={`模型与推理强度：${shown?.name ?? "未选择"}${levelName === null ? "" : `，${levelName}`}`}
        aria-haspopup="dialog"
        aria-expanded={mode !== null}
        title={levelName === null ? `模型与推理强度${shortcut}` : `模型与推理强度：${levelName}${shortcut}`}
        data-full={full ? "" : undefined}
        onClick={() => {
          if (mode !== null) {
            setMode(null);
            return;
          }
          setMode("all");
          onOpen();
        }}
        className="atrium-model-chip relative isolate inline-flex h-8 items-center gap-2 overflow-hidden rounded-[var(--r-pill)] pr-3 pl-1.5 text-[length:var(--fs-meta)] text-[var(--text-2)] shadow-[inset_0_0_0_1px_var(--line)] transition-[background,box-shadow] duration-150 hover:bg-[var(--hover)] hover:text-[var(--text)] disabled:opacity-50 aria-expanded:bg-[var(--hover)]"
      >
        <canvas ref={canvas} aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 size-full" />
        {shown === null ? (
          <span className="atrium-model-text pl-1.5">选择模型</span>
        ) : (
          <>
            <ProviderIcon providerId={shown.providerId} size={20} />
            <span className="atrium-model-text max-w-[180px] truncate font-medium">{shown.name}</span>
            {levelName === null ? null : (
              <span className="atrium-model-text atrium-model-level text-[length:var(--fs-sm)] text-[var(--text-muted)]">
                {levelName}
              </span>
            )}
          </>
        )}
        <CaretDown size={10} className="text-[var(--text-dim)]" />
      </button>
      {mode === null ? null : (
        <ModelPanel
          mode={mode}
          shown={shown}
          list={list}
          onRefresh={onRefresh}
          onChooseModel={(model) => {
            setMode(null);
            onChooseModel(model);
          }}
          onChooseLevel={onChooseLevel}
        />
      )}
    </div>
  );
}

/**
 * The panel above the model button.
 *
 * @remarks
 * See `ModelPicker`.
 *
 * @sideEffects Calls the handlers.
 * @param props - Which parts to show, the model, the list and what to do.
 * @returns The panel.
 */
function ModelPanel({
  mode,
  shown,
  list,
  onRefresh,
  onChooseModel,
  onChooseLevel,
}: {
  readonly mode: PanelMode;
  readonly shown: ShownModel | null;
  readonly list: ModelListView;
  readonly onRefresh: () => void;
  readonly onChooseModel: (model: ModelRef) => void;
  readonly onChooseLevel: (level: ThinkingLevel) => void;
}) {
  const levels = shown?.levels ?? [];
  return (
    <div
      role="dialog"
      aria-label="模型与推理强度"
      className="absolute right-0 bottom-full z-30 mb-2 w-[340px] rounded-[var(--r-card)] bg-[var(--popover)] p-2 text-[var(--text-2)] shadow-[var(--float-shadow)]"
    >
      {mode === "effort" ? null : (
        <ModelList shown={shown} list={list} onRefresh={onRefresh} onChoose={onChooseModel} />
      )}
      {mode === "all" ? <div className="mx-1.5 mt-2 mb-0.5 h-px bg-[var(--line-soft)]" /> : null}
      {mode === "model" || shown === null || levels.length === 0 ? null : (
        <>
          <div className="flex items-center justify-between px-2 pt-1.5 pb-1.5 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
            <span>推理强度{levels.length > 1 ? " · 按住左右拖动" : ""}</span>
            <span>⌘⇧E · ←→</span>
          </div>
          {levels.length > 1 ? (
            <EffortBox
              levels={levels}
              level={shown.level ?? defaultLevel(levels)}
              onChange={onChooseLevel}
              autoFocus={mode === "effort"}
            />
          ) : (
            <p className="px-2.5 pt-1 pb-2 text-center text-[length:var(--fs-xs)] text-[var(--text-dim)]">
              {levelHint("off", levels)}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The level pi starts a model on when none was chosen: medium, kept within what it supports.
 *
 * @remarks
 * pi's own default (pi-internals.md §4); shown until the session reports its level.
 *
 * @sideEffects none
 * @param levels - The model's levels.
 * @returns The level.
 */
function defaultLevel(levels: readonly ThinkingLevel[]): ThinkingLevel {
  if (levels.includes("medium")) return "medium";
  return levels.find((level) => level === "high" || level === "xhigh" || level === "max") ?? levels.at(-1) ?? "off";
}

/**
 * The models, grouped by provider, or why there are none.
 *
 * @remarks
 * See `ModelPicker`. A failed list shows pi's own words behind a fold (SPEC-0001, "模型与输入框").
 * A model with Fast has a small bolt after its name (SPEC-0001, "Fast").
 *
 * @sideEffects Calls the handlers.
 * @param props - The model, the list and what to do.
 * @returns The list.
 */
function ModelList({
  shown,
  list,
  onRefresh,
  onChoose,
}: {
  readonly shown: ShownModel | null;
  readonly list: ModelListView;
  readonly onRefresh: () => void;
  readonly onChoose: (model: ModelRef) => void;
}) {
  const loading = list.status === "loading" || list.status === "idle";
  const detail = list.error instanceof CommandError ? list.error.params?.["detail"] : undefined;
  let body;
  if (list.models.length > 0) {
    body = groupByProvider(list.models).map(({ providerId, models }) => {
      const provider = providerOf(providerId);
      return (
        <div key={providerId} role="group" aria-label={provider.name}>
          <div className="flex items-center gap-1.5 px-2 pt-1 pb-1 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
            <ProviderIcon providerId={providerId} size={14} />
            {provider.name}
          </div>
          {models.map((model) => {
            const current = shown?.providerId === model.providerId && shown.modelId === model.modelId;
            const basics = [
              `上下文 ${formatTokens(model.contextWindow)}`,
              `输出 ${formatTokens(model.maxOutput)}`,
              ...(model.supportsImage ? ["支持图片"] : []),
            ].join(" · ");
            return (
              <button
                key={model.modelId}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                onClick={() => onChoose({ providerId: model.providerId, modelId: model.modelId })}
                className="flex w-full items-center gap-3 rounded-[var(--r-md)] px-2.5 py-2 text-left hover:bg-[var(--hover)] aria-checked:bg-[var(--selected)]"
              >
                <span className="min-w-0 flex-1">
                  <b className="block truncate text-[length:var(--fs-meta)] font-medium text-[var(--text)]">
                    {model.name}
                    {model.fast === null ? null : (
                      <Lightning
                        size={11}
                        weight="fill"
                        role="img"
                        aria-label="支持 Fast"
                        className="ml-1 inline align-[-1px] text-[var(--tint)]"
                      />
                    )}
                  </b>
                  <small className="mt-px block text-[length:var(--fs-xs)] text-[var(--text-dim)]">{basics}</small>
                </span>
                <span className="inline-flex w-4 text-[var(--accent)]">
                  {current ? <Check size={13} weight="bold" /> : null}
                </span>
              </button>
            );
          })}
        </div>
      );
    });
  } else if (list.status === "failed") {
    body = (
      <div className="px-2.5 py-2 text-[length:var(--fs-meta)]">
        <p className="text-[var(--danger)]">读不到模型列表</p>
        {typeof detail === "string" && detail !== "" ? (
          <details className="mt-1 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
            <summary className="cursor-pointer">展开看原始报错</summary>
            <pre className="mt-1 max-h-40 overflow-auto font-mono whitespace-pre-wrap">{detail}</pre>
          </details>
        ) : null}
        <button
          type="button"
          onClick={onRefresh}
          className="mt-2 rounded-[var(--r-btn)] px-2 py-1 text-[var(--text-2)] shadow-[inset_0_0_0_1px_var(--line)] hover:bg-[var(--hover)]"
        >
          重试
        </button>
      </div>
    );
  } else {
    body = (
      <p className="px-2.5 py-2 text-[length:var(--fs-meta)] text-[var(--text-dim)]">
        {loading ? "正在读取模型…" : "没有可用的模型，先在 pi 里登录一个服务商"}
      </p>
    );
  }
  return (
    <>
      <div className="flex items-center justify-between px-2 pt-1 pb-1.5 text-[length:var(--fs-xs)] text-[var(--text-dim)]">
        <span>模型</span>
        <span className="flex items-center gap-2">
          ⌘⇧I
          <button
            type="button"
            aria-label="刷新模型列表"
            aria-busy={loading}
            title="让 pi 重新读取模型列表"
            onClick={onRefresh}
            className="inline-flex size-5 items-center justify-center rounded-[var(--r-sm)] hover:bg-[var(--hover)] hover:text-[var(--text)] aria-busy:animate-spin"
          >
            <ArrowClockwise size={12} />
          </button>
        </span>
      </div>
      <div className="max-h-[320px] overflow-y-auto">{body}</div>
    </>
  );
}

/**
 * A provider's official icon, or its first letter when Atrium has none.
 *
 * @remarks
 * Icons come from each provider's own site (design/brand/SOURCES.md).
 *
 * @sideEffects none
 * @param props - The provider and the icon's size.
 * @returns The icon.
 */
function ProviderIcon({ providerId, size }: { readonly providerId: string; readonly size: number }) {
  const { logo } = providerOf(providerId);
  const style = { width: size, height: size };
  if (logo !== null) {
    return (
      <img
        src={logo}
        alt=""
        style={style}
        className="shrink-0 rounded-[6px] shadow-[0_0_0_0.5px_var(--line)]"
        draggable={false}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      style={style}
      className="inline-flex shrink-0 items-center justify-center rounded-[6px] bg-[var(--surface-3)] text-[10px] font-semibold text-[var(--text-2)]"
    >
      {providerId.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** The button's dots, painted frame by frame while they move. */
interface ChipPainter {
  /** Takes the button's size in CSS pixels. */
  resize(width: number, height: number): void;
  /** Eases to a coverage; full turns on the colours, twinkle and sweeps. */
  show(coverage: number, full: boolean, dark: boolean): void;
  /** Paints the pattern of another seed. */
  reseed(seed: number): void;
  /** Stops drawing. */
  stop(): void;
}

/**
 * Paints the model button's dots, easing to a new level and moving while full.
 *
 * @remarks
 * The dots fill from the left as the level rises; at the top level they twinkle and sweep
 * (design-language, "点阵"). Frames are drawn only while easing or full; with reduced motion the
 * new level shows at once and the dots stay still. The seed is 1 until given.
 *
 * @sideEffects Draws on the canvas and schedules animation frames until settled or stopped.
 * @param surface - The canvas.
 * @returns The painter.
 */
function createChipPainter(surface: HTMLCanvasElement): ChipPainter {
  let seed = 1;
  let size = { width: 0, height: 0 };
  let shown = 0;
  let from = 0;
  let to = 0;
  let started = 0;
  let sweepStart = 0;
  let full = false;
  let dark = false;
  let frame = 0;

  /**
   * Draws a frame and asks for the next while easing or full.
   *
   * @remarks
   * Eases out over `DOTS_EASE_MS`, cubic.
   *
   * @sideEffects Draws; may schedule a frame.
   * @param now - The frame's time.
   */
  function step(now: number): void {
    frame = 0;
    const context = surface.getContext("2d");
    if (context === null || size.width === 0) return;
    const reduced = reducedMotion();
    const progress = reduced ? 1 : Math.min(1, (now - started) / DOTS_EASE_MS);
    shown = from + (to - from) * (1 - (1 - progress) ** 3);
    const moving = full && !reduced;
    paintDots(
      context,
      {
        ...size,
        coverage: shown,
        full,
        dark,
        now: reduced ? 0 : now,
        sweep: moving ? sweepProgress(now, sweepStart) : null,
        variant: "chip",
      },
      seed,
    );
    if (progress < 1 || moving) frame = requestAnimationFrame(step);
  }

  /**
   * Starts drawing unless a frame is already asked for.
   *
   * @remarks
   * The loop stops by itself once settled.
   *
   * @sideEffects Schedules a frame.
   */
  function kick(): void {
    if (frame === 0) frame = requestAnimationFrame(step);
  }

  return {
    resize(width, height) {
      const ratio = devicePixelRatio || 1;
      size = { width, height };
      surface.width = Math.round(width * ratio);
      surface.height = Math.round(height * ratio);
      surface.getContext("2d")?.setTransform(ratio, 0, 0, ratio, 0, 0);
      kick();
    },
    show(coverage, isFull, isDark) {
      const now = performance.now();
      if (isFull && !full) sweepStart = now + 300;
      from = shown;
      to = coverage;
      started = now;
      full = isFull;
      dark = isDark;
      kick();
    },
    reseed(next) {
      seed = next;
      kick();
    },
    stop() {
      cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}

/**
 * Draws the model button's dots.
 *
 * @remarks
 * See `createChipPainter`; the painter lives as long as the button and follows its size.
 *
 * @sideEffects Observes the button's size; draws on the canvas.
 * @param chip - The button.
 * @param canvas - The canvas inside it.
 * @param coverage - How far the dots reach.
 * @param full - Whether the level is the top one.
 */
function useChipDots(
  chip: RefObject<HTMLButtonElement | null>,
  canvas: RefObject<HTMLCanvasElement | null>,
  coverage: number,
  full: boolean,
): void {
  const dark = useDarkMode();
  const seed = useContext(DotSeedContext);
  const painter = useRef<ChipPainter | null>(null);
  useEffect(() => {
    const element = chip.current;
    const surface = canvas.current;
    if (element === null || surface === null) return undefined;
    const created = createChipPainter(surface);
    painter.current = created;
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect();
      created.resize(rect.width, rect.height);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      created.stop();
      painter.current = null;
    };
  }, [chip, canvas]);
  useEffect(() => {
    painter.current?.reseed(seed);
  }, [seed]);
  useEffect(() => {
    painter.current?.show(coverage, full, dark);
  }, [coverage, full, dark]);
}
