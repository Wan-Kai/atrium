import { type RefObject, useLayoutEffect, useRef } from "react";

/** Geometry preferences owned by a floating surface's caller. */
export interface FloatingLayerOptions {
  readonly enabled?: boolean;
  readonly side?: "top" | "bottom" | "left" | "right";
  readonly align?: "start" | "center" | "end";
  readonly gap?: number;
  readonly flip?: boolean;
  readonly maxHeight?: string;
  readonly maxWidth?: string;
  readonly matchWidth?: boolean;
}

/** The window's clear space around every floating surface. */
const EDGE = 12;

/** Active top-layer resets, shared while a document has at least one floating surface. */
const resets = new WeakMap<Document, { readonly style: HTMLStyleElement; users: number }>();

/**
 * Removes popover user-agent decoration without outranking the caller's utility classes.
 * @remarks Popover's defaults add padding, a border, a background and canvas text colour to an
 * ordinary div. A base-layer reset preserves the caller's existing theme and geometry instead.
 * @sideEffects Adds a shared stylesheet to the document until the last floating surface releases it.
 * @param document - The surface's document.
 * @returns The release function.
 */
function keepReset(document: Document): () => void {
  let reset = resets.get(document);
  if (reset === undefined) {
    const style = document.createElement("style");
    style.dataset["atriumFloatingReset"] = "";
    style.textContent =
      "@layer base { :where([data-atrium-floating-layer]) { margin: 0; border: 0; padding: 0; color: inherit; background-color: transparent; overflow: visible; -webkit-app-region: no-drag; } }";
    document.head.append(style);
    reset = { style, users: 0 };
    resets.set(document, reset);
  }
  reset.users++;
  const kept = reset;
  /**
   * Releases one use of the document's floating reset.
   * @remarks No stylesheet is retained after the last surface is removed.
   * @sideEffects May remove the stylesheet from the document.
   */
  return function release(): void {
    kept.users--;
    if (kept.users === 0) {
      kept.style.remove();
      resets.delete(document);
    }
  };
}

/**
 * Keeps a coordinate between the viewport's clear edges, even when it has no remaining room.
 * @remarks Empty room is possible while a window is being resized below a surface's ideal size.
 * @sideEffects none
 * @param value - The preferred coordinate.
 * @param start - The clear leading edge.
 * @param end - The last allowed coordinate.
 * @returns The bounded coordinate.
 */
function clamp(value: number, start: number, end: number): number {
  return Math.max(start, Math.min(value, Math.max(start, end)));
}

/**
 * Combines a viewport limit with a caller's existing CSS limit.
 * @remarks CSS keeps viewport-relative limits live across window resizing.
 * @sideEffects none
 * @param available - The actual remaining size.
 * @param limit - The caller's optional limit.
 * @returns A CSS maximum size.
 */
function maximum(available: number, limit: string | undefined): string {
  const pixels = `${Math.max(0, available)}px`;
  return limit === undefined || limit === "none" ? pixels : `min(${pixels}, ${limit})`;
}

/** Modal candidates whose presence or visibility can suspend background floating surfaces. */
const MODAL_CANDIDATES = "[aria-modal], dialog";

/**
 * Finds whether a visible modal owns interaction somewhere other than the anchor's subtree.
 * @remarks A native modal outranks regular aria-modal overlays; among regular overlays the last
 * visible one owns interaction, matching the application's sibling modal stacking order.
 * @sideEffects none
 * @param anchor - The anchor whose interaction ownership is being checked.
 * @returns Whether the anchor's floating surface must remain suspended.
 */
function blockedByModal(anchor: Element): boolean {
  if (anchor.closest("[inert]") !== null) return true;
  const document = anchor.ownerDocument;
  const native = [...document.querySelectorAll<HTMLDialogElement>("dialog:modal")].findLast((modal) =>
    modal.checkVisibility({ visibilityProperty: true }),
  );
  const modal =
    native ??
    [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].findLast((candidate) =>
      candidate.checkVisibility({ visibilityProperty: true }),
    );
  return modal !== undefined && !modal.contains(anchor);
}

/**
 * Detects a subtree containing a modal candidate without measuring layout.
 * @remarks Streaming text and ordinary response elements cannot change modal ownership.
 * @sideEffects none
 * @param node - A changed DOM subtree.
 * @returns Whether it contains a modal candidate.
 */
function containsModal(node: Node): boolean {
  return node instanceof Element && (node.matches(MODAL_CANDIDATES) || node.querySelector(MODAL_CANDIDATES) !== null);
}

/**
 * Selects mutations that can change modal or inert interaction ownership.
 * @remarks Attribute changes on modal ancestors cover display, visibility and hidden states;
 * unrelated streaming changes never request floating geometry work.
 * @sideEffects none
 * @param mutation - The observed DOM change.
 * @param anchor - The surface's interaction anchor.
 * @returns Whether its suspension state needs checking.
 */
function changesModalOwnership(mutation: MutationRecord, anchor: Element): boolean {
  if (mutation.type === "attributes") {
    if (mutation.attributeName === "aria-modal") return true;
    if (mutation.attributeName === "inert") return mutation.target.contains(anchor);
    return containsModal(mutation.target);
  }
  return [...mutation.addedNodes, ...mutation.removedNodes].some(
    (node) => containsModal(node) || node.contains(anchor),
  );
}

/** An installed floating surface and the resources tied to its actual DOM nodes. */
interface FloatingRuntime {
  readonly anchor: Element;
  readonly layer: HTMLElement;
  readonly update: (options: FloatingLayerOptions) => void;
  readonly dispose: () => void;
}

/**
 * Installs one top-layer surface while retaining its place in the DOM tree.
 * @remarks Native manual popovers escape clipping and transformed containing blocks without
 * portals, so the existing parent panels' contains checks and event propagation still work.
 * @sideEffects Shows a manual popover, changes its geometry, observes sizes, and listens for
 * scrolling and resizing until disposed.
 * @param anchor - The element the layer follows.
 * @param layer - The floating surface.
 * @param given - The caller's preferred geometry.
 * @returns The installed surface's update and release operations.
 */
function install(anchor: Element, layer: HTMLElement, given: FloatingLayerOptions): FloatingRuntime {
  let options = given;
  const document = layer.ownerDocument;
  const window = document.defaultView;
  if (window === null) throw new Error("Floating surface has no window");
  const initial = window.getComputedStyle(layer);
  let requestedHeight = layer.style.maxHeight || initial.maxHeight;
  let requestedWidth = layer.style.maxWidth || initial.maxWidth;
  let requestedMinimum = layer.style.minWidth || initial.minWidth;
  let requestedMatchWidth = layer.style.width;
  let writtenHeight: string | null = null;
  let writtenWidth: string | null = null;
  let writtenMinimum: string | null = null;
  let matchedWidth: string | null = null;
  const originalPopover = layer.getAttribute("popover");
  const originalMarker = layer.getAttribute("data-atrium-floating-layer");
  const changed = [
    "position",
    "inset",
    "margin",
    "border",
    "translate",
    "left",
    "top",
    "max-height",
    "max-width",
    "min-width",
    "width",
  ];
  const styles = changed.map(
    (property) =>
      [property, layer.style.getPropertyValue(property), layer.style.getPropertyPriority(property)] as const,
  );
  const releaseReset = keepReset(document);
  layer.setAttribute("data-atrium-floating-layer", "");
  layer.setAttribute("popover", "manual");
  layer.style.position = "fixed";
  layer.style.inset = "auto";
  layer.style.margin = "0";
  layer.style.border = "0";
  layer.style.translate = "none";

  /**
   * Fits the surface to its anchor's actual remaining space.
   * @remarks Geometry is written directly, avoiding React state or ResizeObserver render loops.
   * @sideEffects Suspends or restores the native popover and updates its inline geometry.
   */
  const measure = (): void => {
    if (!anchor.isConnected || !layer.isConnected) return;
    if (blockedByModal(anchor)) {
      if (layer.matches(":popover-open")) layer.hidePopover();
      return;
    }
    if (!layer.matches(":popover-open")) layer.showPopover();
    // A render can supply measured sizing after this layer opened. Keep those caller values,
    // rather than replacing them with the defaults captured before its first layout effect.
    if (writtenHeight !== null && layer.style.maxHeight !== writtenHeight)
      requestedHeight = layer.style.maxHeight || window.getComputedStyle(layer).maxHeight;
    if (writtenWidth !== null && layer.style.maxWidth !== writtenWidth)
      requestedWidth = layer.style.maxWidth || window.getComputedStyle(layer).maxWidth;
    if (writtenMinimum !== null && layer.style.minWidth !== writtenMinimum)
      requestedMinimum = layer.style.minWidth || window.getComputedStyle(layer).minWidth;
    if (matchedWidth === null || layer.style.width !== matchedWidth) requestedMatchWidth = layer.style.width;
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + EDGE;
    const top = (viewport?.offsetTop ?? 0) + EDGE;
    const right = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - EDGE;
    const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - EDGE;
    const rect = anchor.getBoundingClientRect();
    const gap = options.gap ?? 8;
    const room = {
      top: Math.max(0, rect.top - gap - top),
      bottom: Math.max(0, bottom - rect.bottom - gap),
      left: Math.max(0, rect.left - gap - left),
      right: Math.max(0, right - rect.right - gap),
    };
    let side = options.side ?? "top";
    const opposite = { top: "bottom", bottom: "top", left: "right", right: "left" } as const;
    const vertical = side === "top" || side === "bottom";
    const globalWidth = Math.max(0, right - left);
    const scroll = options.flip === true ? { top: layer.scrollTop, left: layer.scrollLeft } : null;
    layer.style.maxWidth = maximum(globalWidth, options.maxWidth ?? requestedWidth);
    layer.style.minWidth = `min(${requestedMinimum === "auto" ? "0px" : requestedMinimum}, ${layer.style.maxWidth})`;
    if (options.matchWidth === true) {
      layer.style.width = `${rect.width}px`;
      matchedWidth = layer.style.width;
    } else if (matchedWidth !== null) {
      layer.style.width = requestedMatchWidth;
      matchedWidth = null;
    }
    if (options.flip === true) {
      // Only menus that may change sides need a full-frame probe. Expanding a scrolled panel's
      // scrollport can clamp its offset during layout, so preserve it until final limits return.
      layer.style.maxHeight = maximum(Math.max(0, bottom - top), options.maxHeight ?? requestedHeight);
      const frame = layer.getBoundingClientRect();
      const bounded = vertical ? frame.height : frame.width;
      if (bounded > room[side] && room[opposite[side]] > room[side]) side = opposite[side];
    }
    layer.style.maxHeight = maximum(vertical ? room[side] : bottom - top, options.maxHeight ?? requestedHeight);
    layer.style.maxWidth = maximum(vertical ? globalWidth : room[side], options.maxWidth ?? requestedWidth);
    layer.style.minWidth = `min(${requestedMinimum === "auto" ? "0px" : requestedMinimum}, ${layer.style.maxWidth})`;
    writtenHeight = layer.style.maxHeight;
    writtenWidth = layer.style.maxWidth;
    writtenMinimum = layer.style.minWidth;
    const size = layer.getBoundingClientRect();
    if (scroll !== null) {
      layer.scrollTop = scroll.top;
      layer.scrollLeft = scroll.left;
    }
    const alignment = options.align ?? "start";
    const cross = vertical
      ? alignment === "center"
        ? rect.left + (rect.width - size.width) / 2
        : alignment === "end"
          ? rect.right - size.width
          : rect.left
      : alignment === "center"
        ? rect.top + (rect.height - size.height) / 2
        : alignment === "end"
          ? rect.bottom - size.height
          : rect.top;
    const x = vertical ? cross : side === "left" ? rect.left - gap - size.width : rect.right + gap;
    const y = vertical ? (side === "top" ? rect.top - gap - size.height : rect.bottom + gap) : cross;
    layer.style.left = `${clamp(x, left, right - size.width)}px`;
    layer.style.top = `${clamp(y, top, bottom - size.height)}px`;
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(layer);
  let ancestor: Element | null = anchor;
  while (ancestor !== null) {
    observer.observe(ancestor);
    ancestor = ancestor.parentElement;
  }
  const modalObserver = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => changesModalOwnership(mutation, anchor))) measure();
  });
  modalObserver.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-modal", "inert", "open", "hidden", "style", "class"],
  });
  /**
   * Follows scrolling that can move the anchor, not scrolling inside this surface itself.
   * @remarks Internal scrolling does not move its own anchor. Ignoring it also prevents the
   * flip probe's restored scroll offset from scheduling another identical probe every frame;
   * nested menus still follow scrolling in their parent surface through their own listener.
   * @sideEffects May reconcile suspension and update the floating geometry.
   * @param event - The captured scroll event.
   */
  const followScroll = (event: Event): void => {
    if (event.target instanceof Node && layer.contains(event.target)) return;
    measure();
  };
  window.addEventListener("resize", measure);
  window.addEventListener("scroll", followScroll, true);
  window.visualViewport?.addEventListener("resize", measure);
  window.visualViewport?.addEventListener("scroll", measure);
  return {
    anchor,
    layer,
    /**
     * Applies the caller's latest geometry without replacing the installed surface.
     * @remarks Renders can supply measured dimensions after the initial layout effect.
     * @sideEffects Reconciles modal suspension and updates the surface's inline geometry.
     * @param next - The latest sizing and placement preferences.
     */
    update: (next) => {
      options = next;
      measure();
    },
    /**
     * Releases every observer, listener and native state owned by this installation.
     * @remarks Disabled or replaced surfaces must not retain global observers or styling.
     * @sideEffects Hides the popover, restores its original attributes and inline properties,
     * disconnects observers and listeners, and releases the shared user-agent reset.
     */
    dispose: () => {
      observer.disconnect();
      modalObserver.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", followScroll, true);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
      if (layer.matches(":popover-open")) layer.hidePopover();
      for (const [property, value, priority] of styles) {
        if (value === "") layer.style.removeProperty(property);
        else layer.style.setProperty(property, value, priority);
      }
      if (originalPopover === null) layer.removeAttribute("popover");
      else layer.setAttribute("popover", originalPopover);
      if (originalMarker === null) layer.removeAttribute("data-atrium-floating-layer");
      else layer.setAttribute("data-atrium-floating-layer", originalMarker);
      releaseReset();
    },
  };
}

/**
 * Keeps an anchored floating surface within the window without changing its DOM ownership.
 *
 * @remarks
 * SPEC-0001, "桌面浮层的窗口边界": surfaces retain their preferred direction and sizing;
 * short menus and hints may ask to flip when their preferred side cannot fit them. The caller
 * still owns visibility, focus, scrolling and dismissal. Manual popovers add no light-dismiss.
 * Background layers are suspended while their anchor is inert or belongs outside the active modal;
 * their caller's open state is retained, so removing the modal restores the layer.
 *
 * @sideEffects Installs a top-layer surface, size/modal observers and window listeners while enabled;
 * updates its geometry after renders and releases every resource when disabled or unmounted.
 * @param anchor - The element the layer follows.
 * @param layer - The surface whose caller owns visibility, content and scrolling.
 * @param options - The preferred geometry and existing CSS size limits.
 */
export function useFloatingLayer(
  anchor: RefObject<Element | null>,
  layer: RefObject<HTMLElement | null>,
  options: FloatingLayerOptions = {},
): void {
  const runtime = useRef<FloatingRuntime | null>(null);
  useLayoutEffect(() => {
    const target = anchor.current;
    const surface = layer.current;
    const enabled = options.enabled !== false && target !== null && surface !== null;
    const previous = runtime.current;
    if (previous !== null && (!enabled || previous.anchor !== target || previous.layer !== surface)) {
      previous.dispose();
      runtime.current = null;
    }
    if (!enabled) return;
    if (runtime.current === null) runtime.current = install(target, surface, options);
    else runtime.current.update(options);
  });
  useLayoutEffect(
    () => () => {
      runtime.current?.dispose();
      runtime.current = null;
    },
    [],
  );
}
