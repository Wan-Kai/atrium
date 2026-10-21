import { useEffect, useState, type RefObject } from "react";
import { MagnifyingGlassMinus, MagnifyingGlassPlus } from "../design/icons";

/** The locked Streamdown controls' localized native action labels. */
export const MERMAID_ZOOM_LABELS = { in: "拉近", out: "拉远", fit: "适应窗口" } as const;

/** A snapshot of the native viewport, not a second zoom state machine. */
interface ZoomView {
  readonly percent: number | null;
  readonly increase: boolean;
  readonly decrease: boolean;
}

/** The stable state before a native diagram has been drawn, or after it fails. */
const NOT_READY: ZoomView = { percent: null, increase: false, decrease: false };

/** Presents B's toolbar while leaving fit, scale, pan and fullscreen with Streamdown.
 * @remarks Streamdown exposes only a panZoom switch, not a controller or scale callback. This
 * narrow locked-version DOM adapter activates its native buttons and observes its viewport;
 * it never rewrites SVG or third-party React state. The real renderer integration tests guard it.
 * @sideEffects Observes the local diagram until unmounted; clicks activate native view actions.
 * @param props - The enclosing Mermaid block, excluding fullscreen portals.
 * @returns Native-backed controls in the chosen keyboard/visual order, or no controls until ready.
 */
export function MermaidZoom({ root }: { readonly root: RefObject<HTMLDivElement | null> }) {
  const [view, setView] = useState<ZoomView>(NOT_READY);
  useEffect(() => {
    const element = root.current;
    if (element === null) return undefined;
    /** Copies only the native viewport's displayed scale and native button bounds.
     * @remarks Loading, errors and theme remounts must not leave a stale percentage visible.
     * @sideEffects Updates React state only when the observable view has changed.
     */
    function sync() {
      const inline = element?.querySelector('[data-streamdown="mermaid"]');
      const canvas = inline?.querySelector<HTMLElement>('[role="application"]');
      const scale = Number(/scale\(([0-9.eE+-]+)\)/u.exec(canvas?.style.transform ?? "")?.[1]);
      const plus = inline?.querySelector<HTMLButtonElement>(`button[aria-label="${MERMAID_ZOOM_LABELS.in}"]`);
      const minus = inline?.querySelector<HTMLButtonElement>(`button[aria-label="${MERMAID_ZOOM_LABELS.out}"]`);
      const next =
        Number.isFinite(scale) && scale > 0
          ? {
              percent: Math.round(scale * 100),
              increase: plus !== null && plus !== undefined && !plus.disabled,
              decrease: minus !== null && minus !== undefined && !minus.disabled,
            }
          : NOT_READY;
      setView((current) =>
        current.percent === next.percent && current.increase === next.increase && current.decrease === next.decrease
          ? current
          : next,
      );
    }
    const observer = new MutationObserver(sync);
    observer.observe(element, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style", "disabled"],
    });
    sync();
    return () => observer.disconnect();
  }, [root]);

  /** Activates one existing native control, retaining its disabled/fit/pan semantics.
   * @remarks There is no public imperative zoom API in the pinned renderer. Keeping this bridge
   * local avoids copying its geometry or moving DOM nodes out of React's ownership.
   * @sideEffects Dispatches a native button activation inside this inline renderer only.
   * @param action - The native zoom or fit action.
   */
  function activate(action: keyof typeof MERMAID_ZOOM_LABELS) {
    root.current
      ?.querySelector<HTMLButtonElement>(
        `[data-streamdown="mermaid"] button[aria-label="${MERMAID_ZOOM_LABELS[action]}"]`,
      )
      ?.click();
  }

  if (view.percent === null) return null;
  return (
    <div className="atrium-mermaid-zoom" role="group" aria-label="图表缩放">
      <button
        type="button"
        aria-label={MERMAID_ZOOM_LABELS.out}
        title="缩小图表"
        disabled={!view.decrease}
        onClick={() => activate("out")}
      >
        <MagnifyingGlassMinus size={14} />
      </button>
      <output aria-label="图表缩放比例">{view.percent}%</output>
      <button
        type="button"
        aria-label={MERMAID_ZOOM_LABELS.in}
        title="放大图表"
        disabled={!view.increase}
        onClick={() => activate("in")}
      >
        <MagnifyingGlassPlus size={14} />
      </button>
      <button
        type="button"
        className="atrium-mermaid-fit"
        aria-label={MERMAID_ZOOM_LABELS.fit}
        title="适应窗口"
        onClick={() => activate("fit")}
      >
        适应
      </button>
    </div>
  );
}
