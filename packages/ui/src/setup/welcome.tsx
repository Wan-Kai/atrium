import { ArrowUpRight, Eye, GitBranch, TerminalWindow } from "../design/icons";
import { type ReactNode, useContext, useEffect, useRef } from "react";
import {
  BAND_HOVER_MS,
  BAND_MS,
  type BandSweep,
  DotSeedContext,
  easeBand,
  nextBandSweep,
  paintBand,
  reducedMotion,
} from "../design/dots";
import atriumLogo from "../design/brand/atrium.svg";

/**
 * The welcome page: a first screen worth a screenshot.
 *
 * @remarks
 * SPEC-0001 ("首次启动 · 欢迎页"): Atrium's cat in the logo slot, the "由 pi 驱动" capsule linking to pi.dev,
 * the title, two lines on what Atrium is, "开始设置 →" with the hint under it, and a glass window
 * leaning back with a miniature of the real interface and three notes floating beside it. No
 * footer. The preview is decoration, hidden from assistive technology.
 *
 * @sideEffects Draws the button's dots; opens pi.dev when the capsule is pressed.
 * @param props - What starting does, and how to open an address.
 * @returns The page, as the window's middle row.
 */
export function Welcome({
  onStart,
  openUrl,
}: {
  readonly onStart: () => void;
  readonly openUrl: (url: string) => void;
}) {
  return (
    <div className="relative grid min-h-0 place-items-start justify-center overflow-hidden px-8 pt-[clamp(0px,2vh,28px)]">
      <section aria-labelledby="first-launch-title" className="atrium-onboard-screen relative w-[980px] text-center">
        <div aria-hidden className="atrium-aurora">
          <i />
          <i />
          <i />
        </div>
        <div aria-hidden className="atrium-gmark">
          <img src={atriumLogo} alt="" />
        </div>
        <button
          type="button"
          className="atrium-glass mb-4 inline-flex h-[34px] items-center gap-2 rounded-[var(--r-pill)] pr-3 pl-[7px] text-[13px] text-[var(--text-muted)] transition-transform duration-200 hover:-translate-y-px [&:hover_.go]:translate-x-px [&:hover_.go]:-translate-y-px [&:hover_.go]:text-[var(--text-2)]"
          aria-label="由 pi 驱动，开放的 agent 内核，打开 pi.dev"
          onClick={() => openUrl("https://pi.dev")}
        >
          <span className="grid size-[22px] place-items-center rounded-[7px] bg-white shadow-[0_0_0_0.5px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.06)]">
            <svg viewBox="150 150 500 500" aria-hidden className="size-4">
              <path fill="#F09082" d="M165.29 165.29H517.36V400H400V282.65H165.29Z" />
              <path fill="#4D9ABF" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z" />
              <path fill="#F1BE58" d="M517.36 400H634.72V634.72H517.36Z" />
            </svg>
          </span>
          <span>
            由 <b className="atrium-title mx-px text-[13.5px] font-bold tracking-[0.01em] text-[var(--text)]">pi</b>{" "}
            驱动
          </span>
          <span className="h-3 w-px bg-[var(--line)]" />
          <span>开放的 agent 内核</span>
          <ArrowUpRight size={12} weight="bold" className="go text-[var(--text-dim)] transition-[color,transform]" />
        </button>
        <h1 id="first-launch-title" className="atrium-hero m-0">
          看得见内部的
          <br />
          coding agent
        </h1>
        <p className="mx-auto mt-3.5 mb-[22px] max-w-[520px] text-base leading-[1.6] text-[var(--text-muted)]">
          每一步读了什么、改了什么、花了多少 token，都摆在你眼前。
          <br />
          多个任务各占一个 worktree，并行推进。
        </p>
        <div className="flex flex-col items-center gap-3">
          <StartButton onStart={onStart} />
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--text-dim)]">
            按
            <kbd className="rounded-[5px] px-1.5 py-px font-sans text-[11px] font-semibold shadow-[inset_0_0_0_1px_var(--line)]">
              ⏎
            </kbd>
            开始 · 大约 1 分钟，三步完成
          </span>
        </div>
        <Preview />
      </section>
    </div>
  );
}

/**
 * "开始设置 →": a near-black capsule with a slow glow inside, crossed by a band of dots.
 *
 * @remarks
 * SPEC-0001 ("首次启动 · 欢迎页", the "内光" scheme). The band crosses once every 6 s, taking
 * about 1.1 s, and at once on hover, taking about 0.85 s; its pattern is the install's
 * (`DotSeedContext`). Frames are drawn only while it crosses. With reduced motion there is no
 * band. Enter presses it.
 *
 * @sideEffects Observes the button's size and draws on its canvas while mounted.
 * @param props - What pressing does.
 * @returns The button.
 */
function StartButton({ onStart }: { readonly onStart: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const seed = useContext(DotSeedContext);
  useEffect(() => {
    const element = button.current;
    const surface = canvas.current;
    if (element === null || surface === null || reducedMotion()) return undefined;
    const band = createBandPainter(surface, seed);
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect();
      band.resize(rect.width, rect.height);
    });
    observer.observe(element);
    /**
     * Sweeps the band at once.
     *
     * @remarks
     * Hovering the button sweeps it (SPEC-0001, "欢迎页").
     *
     * @sideEffects Starts a sweep.
     */
    const onEnter = (): void => band.hover();
    element.addEventListener("pointerenter", onEnter);
    return () => {
      element.removeEventListener("pointerenter", onEnter);
      observer.disconnect();
      band.stop();
    };
  }, [seed]);
  return (
    <button ref={button} type="button" data-enter className="atrium-start" onClick={onStart}>
      <canvas ref={canvas} aria-hidden />
      <span className="atrium-start-label">
        开始设置
        <span aria-hidden className="atrium-start-arrow">
          →
        </span>
      </span>
    </button>
  );
}

/** The start button's band, drawn while it crosses. */
interface BandPainter {
  /** Takes the button's size in CSS pixels. */
  resize(width: number, height: number): void;
  /** Sweeps at once, the quicker way. */
  hover(): void;
  /** Stops drawing. */
  stop(): void;
}

/**
 * Draws the start button's band: every 6 s, and at once when asked.
 *
 * @remarks
 * See `StartButton`. The first sweep comes 0.7 s after the page shows, as in the prototype. A
 * timer waits between sweeps, so nothing draws while the band is away.
 *
 * @sideEffects Draws on the canvas; schedules animation frames and a timer until stopped.
 * @param surface - The canvas.
 * @param seed - The pattern's seed.
 * @returns The painter.
 */
function createBandPainter(surface: HTMLCanvasElement, seed: number): BandPainter {
  let size = { width: 0, height: 0 };
  let sweep: BandSweep = { start: performance.now() + 700, duration: BAND_MS };
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Draws the band where it is, and asks for the next frame or waits for the next sweep.
   *
   * @remarks
   * See `nextBandSweep`.
   *
   * @sideEffects Draws; schedules a frame or a timer.
   * @param now - The frame's time.
   */
  function step(now: number): void {
    frame = 0;
    const context = surface.getContext("2d");
    if (context === null || size.width === 0) return;
    sweep = nextBandSweep(now, sweep);
    const into = (now - sweep.start) / sweep.duration;
    paintBand(context, size, into < 0 ? -1 : easeBand(into), seed);
    if (into < 0) timer = setTimeout(kick, sweep.start - now);
    else frame = requestAnimationFrame(step);
  }

  /**
   * Draws the next frame unless one is asked for already.
   *
   * @remarks
   * The loop pauses between sweeps.
   *
   * @sideEffects Schedules a frame.
   */
  function kick(): void {
    clearTimeout(timer);
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
    hover() {
      sweep = { start: performance.now(), duration: BAND_HOVER_MS };
      kick();
    },
    stop() {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      frame = 0;
    },
  };
}

/**
 * The miniature of the real interface on the welcome page, with its three notes.
 *
 * @remarks
 * SPEC-0001 ("首次启动 · 欢迎页"): the sidebar, a process summary, a reply and the status bar, in a
 * glass window leaning back and fading out at the bottom.
 *
 * @sideEffects none
 * @returns The preview.
 */
function Preview() {
  return (
    <div aria-hidden className="atrium-stage3d">
      <span className="atrium-callout atrium-glass">
        <Eye size={16} className="text-[var(--tint)]" />
        每一步都看得见
      </span>
      <span className="atrium-callout atrium-glass">
        <GitBranch size={16} className="text-[var(--tint)]" />
        worktree 合没合并，一眼看出
      </span>
      <span className="atrium-callout atrium-glass">
        <TerminalWindow size={16} className="text-[var(--tint)]" />
        和终端里的 pi 共用会话
      </span>
      <div className="atrium-preview atrium-glass">
        <div className="absolute top-3.5 left-4 flex gap-1.5">
          <i className="size-[9px] rounded-full bg-[#ff5f57]" />
          <i className="size-[9px] rounded-full bg-[#febc2e]" />
          <i className="size-[9px] rounded-full bg-[#28c840]" />
        </div>
        <div className="atrium-preview-side">
          <div className="mx-2 mt-2.5 mb-1 text-[11px] text-[var(--text-dim)]">等你处理</div>
          <PreviewRow
            name="重构宿主进程管理"
            mark={<span className="text-[11.5px] font-semibold text-[var(--attn-text)]">?</span>}
          />
          <div className="mx-2 mt-2.5 mb-1 text-[11px] text-[var(--text-dim)]">项目</div>
          <PreviewRow name="main" selected />
          <PreviewRow
            name="feat/sidebar"
            mark={
              <>
                <span className="text-[11.5px] font-semibold text-[var(--attn-text)]">↑3</span>
                <span className="size-1.5 rounded-full bg-[var(--attn)]" />
              </>
            }
          />
          <PreviewRow
            name="fix/reconnect"
            mark={<span className="text-[11.5px] font-semibold text-[var(--attn-text)]">↑1</span>}
          />
          <PreviewRow
            name="fix/typo"
            faded
            mark={<span className="text-[11.5px] text-[var(--ok-text)]">✓ 已合并</span>}
          />
        </div>
        <div className="px-[34px] pt-10 text-[13px]">
          <div className="ml-auto w-fit max-w-[70%] rounded-2xl bg-[var(--selected)] px-3.5 py-[9px] text-[var(--text-2)]">
            把侧栏改成收件箱的结构
          </div>
          <div className="mt-[18px] mb-2.5 text-[12.5px] text-[var(--text-muted)]">
            已完成，用时 2 分 13 秒 · <span className="text-[var(--text-3)]">读了 3 个文件</span> ·{" "}
            <span className="text-[var(--text-3)]">改了 2 个文件</span> · 跑了 2 条命令
          </div>
          <div className="leading-[1.65] text-[var(--text-2)]">
            改好了。收件箱是会话列表的派生视图：<PreviewCode>Inbox.tsx</PreviewCode> 筛出等你处理的会话，
            <PreviewCode>Sidebar.tsx</PreviewCode> 把它挂在项目列表上方。6 条测试全部通过。
          </div>
          <div className="mt-[22px] flex justify-center gap-[18px] text-[length:var(--fs-sm)] text-[var(--text-dim)]">
            <span>1 轮 7 步 · 48 tok/s</span>
            <span>1.3M tok · 缓存命中 73%</span>
            <span>上下文 42%</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * A row of the preview's sidebar.
 *
 * @remarks
 * See `Preview`.
 *
 * @sideEffects none
 * @param props - Its name, what it shows on the right, and whether it is selected or faded.
 * @returns The row.
 */
function PreviewRow({
  name,
  mark,
  selected = false,
  faded = false,
}: {
  readonly name: string;
  readonly mark?: ReactNode;
  readonly selected?: boolean;
  readonly faded?: boolean;
}) {
  return (
    <div
      className={`flex h-7 items-center gap-1.5 rounded-[var(--r)] px-2 whitespace-nowrap text-[var(--text-2)] ${selected ? "bg-[var(--selected)]" : ""}`}
    >
      <span className={`flex-1 truncate ${faded ? "opacity-55" : ""}`}>{name}</span>
      {mark}
    </div>
  );
}

/**
 * A file name in the preview's reply.
 *
 * @remarks
 * See `Preview`.
 *
 * @sideEffects none
 * @param props - The name.
 * @returns The code.
 */
function PreviewCode({ children }: { readonly children: string }) {
  return (
    <code className="rounded-[var(--r-sm)] bg-[var(--selected)] px-1.5 py-px font-mono text-[12px]">{children}</code>
  );
}
