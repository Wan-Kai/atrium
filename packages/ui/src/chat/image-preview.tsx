import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowClockwise, ArrowsOutSimple, MagnifyingGlassMinus, MagnifyingGlassPlus, X } from "../design/icons";
import { imagePreviewLayout } from "./image-preview-layout";
import "./image-preview.css";

/** Props of a controlled preview for a previously approved image address. */
interface ImagePreviewProps {
  /** An already approved data, blob, or HTTPS image address; no local file loading occurs here. */
  readonly src: string;
  /** The image's descriptive name. */
  readonly alt: string;
  /** Requests removal of the preview by its owner. */
  readonly onClose: () => void;
}

/** The image decoder's current result. */
type ImageState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | {
      readonly kind: "ready";
      readonly width: number;
      readonly height: number;
    };

/** An active pointer drag, measured from the last bounded image position. */
interface Drag {
  /** The captured pointer. */
  readonly id: number;
  /** Pointer origin. */
  readonly clientX: number;
  /** Pointer origin. */
  readonly clientY: number;
  /** Image origin. */
  readonly x: number;
  /** Image origin. */
  readonly y: number;
}

/**
 * Displays an image in an application-window modal canvas.
 * @remarks The owner approves the source and controls lifetime; changing it starts a fresh preview.
 * @sideEffects Mounts a modal dialog that isolates background interaction until removed.
 * @param props - Image address, description, and close callback.
 * @returns The preview.
 */
export function ImagePreview(props: ImagePreviewProps) {
  return createPortal(<ImagePreviewCanvas key={props.src} {...props} />, document.body);
}

/**
 * Owns one image's decoder, fit mode, drag and native modal lifetime.
 * @remarks A native top-layer dialog makes the whole background inert without altering app state.
 * @sideEffects Shows and closes a dialog, observes its canvas, captures pointers and restores focus.
 * @param props - The approved image and close request callback.
 * @returns The full-window canvas.
 */
function ImagePreviewCanvas({ src, alt, onClose }: ImagePreviewProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const drag = useRef<Drag | null>(null);
  const [image, setImage] = useState<ImageState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [viewport, setViewport] = useState({ width: 1, height: 1 });
  const [view, setView] = useState<{ scale: number | null; x: number; y: number }>({ scale: null, x: 0, y: 0 });
  const ready = image.kind === "ready";
  const layout = imagePreviewLayout(ready ? image : { width: 1, height: 1 }, viewport, view.scale, view);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const canvas = canvasRef.current;
    if (dialog === null || canvas === null) return undefined;
    const trigger = document.activeElement;
    dialog.showModal();
    closeRef.current?.focus({ preventScroll: true });
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      const activeDrag = drag.current;
      if (activeDrag !== null && canvas.hasPointerCapture(activeDrag.id)) canvas.releasePointerCapture(activeDrag.id);
      drag.current = null;
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);

  /**
   * Changes original-relative zoom while keeping the image inside its pan bounds.
   * @remarks Fit may be below 25 percent; the first manual step then enters the manual range.
   * @sideEffects Updates component state.
   * @param delta - Scale change, in original-image units.
   */
  function zoom(delta: number) {
    if (!ready || (delta < 0 && layout.scale <= 0.25)) return;
    const next = imagePreviewLayout(image, viewport, layout.scale < 0.25 ? 0.25 : layout.scale + delta, layout);
    setView(next);
  }

  /**
   * Releases an active pointer drag.
   * @remarks Cancel and unmount must not leave a captured pointer or continue moving the image.
   * @sideEffects Releases pointer capture and clears the drag reference.
   */
  function stopDrag() {
    const activeDrag = drag.current;
    const canvas = canvasRef.current;
    drag.current = null;
    if (activeDrag !== null && canvas?.hasPointerCapture(activeDrag.id)) canvas.releasePointerCapture(activeDrag.id);
  }

  /**
   * Returns to the complete, centered image.
   * @remarks Fit remains responsive to subsequent window resizing.
   * @sideEffects Releases capture and updates component state.
   */
  function fit() {
    stopDrag();
    setView({ scale: null, x: 0, y: 0 });
  }

  /**
   * Keeps preview keyboard input inside the modal and exposes zoom and pan without a pointer.
   * @remarks Escape never reaches the conversation's run controls or window shortcuts.
   * @sideEffects Prevents handled key defaults, changes view state or requests closure.
   * @param event - A keyboard event bubbling within the dialog.
   */
  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Tab") {
      const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex='0']")];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || !ready) return;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoom(0.25);
    } else if (event.key === "-") {
      event.preventDefault();
      zoom(-0.25);
    } else if (event.key === "0") {
      event.preventDefault();
      fit();
    } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      if (view.scale === null) return;
      setView(
        imagePreviewLayout(image, viewport, layout.scale, {
          x: layout.x + (event.key === "ArrowLeft" ? -40 : event.key === "ArrowRight" ? 40 : 0),
          y: layout.y + (event.key === "ArrowUp" ? -40 : event.key === "ArrowDown" ? 40 : 0),
        }),
      );
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="atrium-image-preview"
      aria-label="图片预览"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="atrium-image-preview-toolbar">
        <span className="atrium-image-preview-name" title={alt || "图片"}>
          {alt || "图片"}
        </span>
        <div className="atrium-image-preview-controls">
          <button
            type="button"
            aria-label="缩小"
            title="缩小（−）"
            disabled={!ready || layout.scale <= 0.25}
            onClick={() => zoom(-0.25)}
          >
            <MagnifyingGlassMinus size={14} />
          </button>
          <output aria-label="缩放比例">{ready ? `${Math.round(layout.scale * 100)}%` : "—"}</output>
          <button
            type="button"
            aria-label="放大"
            title="放大（+）"
            disabled={!ready || layout.scale >= 4}
            onClick={() => zoom(0.25)}
          >
            <MagnifyingGlassPlus size={14} />
          </button>
          <button
            type="button"
            className="atrium-image-preview-fit"
            aria-label="适应窗口"
            disabled={!ready}
            onClick={fit}
            title="适应窗口（0）"
          >
            <ArrowsOutSimple size={14} />
            <span>适应窗口</span>
          </button>
          <button type="button" ref={closeRef} aria-label="关闭预览" title="关闭（Esc）" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </header>
      <div
        ref={canvasRef}
        className="atrium-image-preview-canvas"
        role="region"
        aria-label="图片画布"
        tabIndex={0}
        onPointerDown={(event) => {
          if (!ready || !event.isPrimary || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            id: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            x: layout.x,
            y: layout.y,
          };
        }}
        onPointerMove={(event) => {
          const activeDrag = drag.current;
          if (!ready || view.scale === null || activeDrag === null || event.pointerId !== activeDrag.id) return;
          setView(
            imagePreviewLayout(image, viewport, layout.scale, {
              x: activeDrag.x + event.clientX - activeDrag.clientX,
              y: activeDrag.y + event.clientY - activeDrag.clientY,
            }),
          );
        }}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      >
        {image.kind !== "failed" && (
          <img
            key={attempt}
            src={src}
            alt={alt}
            draggable={false}
            style={{
              width: ready ? image.width * layout.scale : 0,
              height: ready ? image.height * layout.scale : 0,
              transform: `translate(${layout.x}px, ${layout.y}px)`,
              visibility: ready ? "visible" : "hidden",
            }}
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
              setImage(width > 0 && height > 0 ? { kind: "ready", width, height } : { kind: "failed" });
            }}
            onError={() => {
              stopDrag();
              setImage({ kind: "failed" });
            }}
          />
        )}
        {image.kind === "loading" && (
          <p className="atrium-image-preview-status" role="status">
            正在读取图片…
          </p>
        )}
        {image.kind === "failed" && (
          <div className="atrium-image-preview-status" role="status">
            <p>读不了这张图片，请重试。</p>
            <button
              type="button"
              onClick={() => {
                closeRef.current?.focus({ preventScroll: true });
                setImage({ kind: "loading" });
                setAttempt((value) => value + 1);
                fit();
              }}
            >
              <ArrowClockwise size={14} />
              重试
            </button>
          </div>
        )}
      </div>
      <footer className="atrium-image-preview-footer">
        <span>{ready ? `${image.width} × ${image.height}` : "原始尺寸未知"}</span>
        <span>拖动平移 · Esc 返回对话</span>
      </footer>
    </dialog>
  );
}
