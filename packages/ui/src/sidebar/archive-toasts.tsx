import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle, WarningCircle, X } from "../design/icons";
import { useClock } from "../state/clock";
import { useFloatingLayer } from "../design/floating-layer";

/** How long a toast saying a worktree was archived stays. */
const DONE_MS = 3000;
/** How long a toast saying why archiving failed stays, there being a reason to read. */
const FAILED_MS = 6000;
/** The least a toast stays once the pointer leaves it. */
const RESUME_MS = 600;
/** How long a toast takes to leave. */
const LEAVE_MS = 200;
/** How many toasts show at once. */
const MOST = 3;

/** What one archive of a worktree came to: archived, or failed for `reason`. */
export interface ArchiveToast {
  readonly id: number;
  readonly name: string;
  readonly reason?: string;
}

/**
 * Adds a toast above the others, keeping the newest three.
 *
 * @remarks
 * design-language, "提示": newer on top, at most three, the oldest pushed out.
 *
 * @sideEffects none
 * @param toasts - The toasts shown.
 * @param toast - The new one.
 * @returns The toasts to show.
 */
export function pushToast(toasts: readonly ArchiveToast[], toast: ArchiveToast): readonly ArchiveToast[] {
  return [toast, ...toasts].slice(0, MOST);
}

/**
 * The toasts at the window's top right saying how archiving worktrees went.
 *
 * @remarks
 * design-language, "提示" (prototype `archive-toast-prototype.html`, A). Put on the page's body, as
 * the sidebar's blur would otherwise hold it inside the sidebar; it takes no room and no focus.
 *
 * @sideEffects Follows a bounded top-layer stack, keeping it above nonmodal popovers;
 * listens for other popovers opening until unmounted. Each toast keeps its own time (see `Toast`).
 * @param props - The toasts, newest first, and what to call once one has left.
 * @returns The toasts.
 */
export function ArchiveToasts({
  toasts,
  onGone,
}: {
  readonly toasts: readonly ArchiveToast[];
  readonly onGone: (id: number) => void;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const showing = toasts.length > 0;
  const [scrolling, setScrolling] = useState(false);
  useFloatingLayer(anchor, stack, { enabled: showing, side: "bottom", align: "end", gap: 0 });
  useLayoutEffect(() => {
    const element = stack.current;
    if (toasts.length === 0 || element === null) return undefined;
    /**
     * Clips only an actually overflowing stack, leaving normal shadows and motion intact.
     * @remarks The native layer's geometry supplies the height ceiling; scrollbar ownership
     * stays with the notifications, not with every floating consumer.
     * @sideEffects Updates whether this stack needs internal scrolling.
     */
    const measure = (): void => setScrolling(element.scrollHeight > element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [toasts.length]);
  useEffect(() => {
    if (!showing) return undefined;
    /**
     * Keeps archive results above a subsequently opened nonmodal surface.
     * @remarks Top-layer paint order ignores z-index. The shared geometry hook suspends this
     * stack under modals; an already focused close button retains its focus while raising.
     * @sideEffects Reorders the stack in the native top layer and may restore its focused control.
     * @param event - A native popover state change.
     */
    const raise = (event: Event): void => {
      const element = stack.current;
      if (
        !(event instanceof ToggleEvent) ||
        event.newState !== "open" ||
        element === null ||
        event.target === element ||
        !element.matches(":popover-open")
      )
        return;
      const focused = document.activeElement;
      element.hidePopover();
      element.showPopover();
      if (focused instanceof HTMLElement && element.contains(focused)) focused.focus({ preventScroll: true });
    };
    document.addEventListener("toggle", raise, true);
    return () => document.removeEventListener("toggle", raise, true);
  }, [showing]);
  return createPortal(
    <>
      <span
        ref={anchor}
        aria-hidden
        className="pointer-events-none fixed top-[min(56px,max(12px,calc(100dvh-46px)))] right-3 size-0"
      />
      <div
        ref={stack}
        className={`pointer-events-none fixed z-40 flex w-max flex-col items-end gap-2 ${scrolling ? "overflow-y-auto" : "overflow-visible"}`}
      >
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} onGone={onGone} />
        ))}
      </div>
    </>,
    document.body,
  );
}

/**
 * One toast: archived, or failed and why.
 *
 * @remarks
 * Stays 3 seconds, a failure 6; its time holds while the pointer is on it or its × has the focus,
 * and goes on with what was left, at least 0.6 seconds. It leaves in 0.2 seconds on its time or
 * its ×, and only then is gone.
 *
 * @sideEffects Sets timers through the clock; calls `onGone` once it has left.
 * @param props - The toast and what to call once it has left.
 * @returns The toast.
 */
function Toast({ toast, onGone }: { readonly toast: ArchiveToast; readonly onGone: (id: number) => void }) {
  const clock = useClock();
  const failed = toast.reason !== undefined;
  const left = useRef(failed ? FAILED_MS : DONE_MS);
  const [held, setHeld] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const { id } = toast;
  useEffect(() => {
    if (leaving) return clock.after(LEAVE_MS, () => onGone(id));
    if (held) return undefined;
    const started = clock.now();
    const cancel = clock.after(left.current, () => setLeaving(true));
    return () => {
      cancel();
      left.current = Math.max(left.current - (clock.now() - started), RESUME_MS);
    };
  }, [clock, held, leaving, id, onGone]);

  const Icon = failed ? WarningCircle : CheckCircle;
  return (
    <div
      role={failed ? "alert" : "status"}
      data-leaving={leaving}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
      className={`atrium-toast group pointer-events-auto flex h-[34px] shrink-0 max-w-[calc(100vw-24px)] items-center gap-[7px] rounded-[var(--r-pill)] pr-1.5 pl-2.5 text-[length:var(--fs-meta)] whitespace-nowrap text-[var(--text-2)] ${leaving ? "atrium-toast-leave" : ""}`}
    >
      <Icon size={15} className={`shrink-0 ${failed ? "text-[var(--danger)]" : "text-[var(--ok-text)]"}`} />
      <span className="min-w-0 truncate" title={toast.reason}>
        {failed ? "没能归档「" : "已归档「"}
        <span className="inline-block max-w-[180px] truncate align-bottom font-medium text-[var(--text)]">
          {toast.name}
        </span>
        」{failed ? <span className="text-[var(--text-muted)]">：{toast.reason}</span> : null}
      </span>
      <button
        type="button"
        aria-label="关闭提示"
        onClick={() => setLeaving(true)}
        className="grid size-5 shrink-0 place-items-center rounded-[var(--r-sm)] text-[var(--text-dim)] opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:bg-[var(--hover)] hover:text-[var(--text-2)] focus-visible:opacity-100"
      >
        <X size={11} />
      </button>
    </div>
  );
}
