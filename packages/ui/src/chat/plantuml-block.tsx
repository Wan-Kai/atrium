import { useEffect, useState } from "react";
import { CodeBlock, CodeBlockCopyButton, type CustomRendererProps } from "streamdown";
import { ArrowsOutSimple, Code, Flowchart } from "../design/icons";
import { useDarkMode } from "../design/use-dark-mode";
import { useClock } from "../state/clock";
import { ImagePreview } from "./image-preview";
import { PlantumlError, renderPlantuml, type PlantumlFailure } from "./plantuml";

/** Explanations contain no raw engine diagnostics or file contents. */
const FAILURES: Record<PlantumlFailure, string> = {
  failed: "图未能画出来（语法或外部资源不受支持）",
  too_large: "图太大，无法显示",
  timeout: "画图超时了",
  busy: "等待画图的内容太多",
  aborted: "画图已取消",
};

/** A rendered diagram's current outcome. */
type Drawing =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly url: string }
  | { readonly kind: "failed"; readonly reason: PlantumlFailure };

/** Keeps incomplete PlantUML blocks as code and renders only complete ones.
 * @remarks Streaming fences must not start an engine for each partial token.
 * @sideEffects Draws through the child only after the block is complete.
 * @param props - Streamdown's source and incomplete flag.
 * @returns Code or a local diagram.
 */
export function PlantumlBlock({ code: source, isIncomplete }: CustomRendererProps) {
  if (isIncomplete)
    return (
      <CodeBlock code={source} language="plantuml" isIncomplete lineNumbers={false}>
        <CodeBlockCopyButton />
      </CodeBlock>
    );
  return <FinishedPlantuml key={source} source={source} />;
}

/** Restarts the diagram when appearance or the user's retry changes.
 * @remarks Keyed attempts make source, preview and worker lifetime agree without effect-driven resets.
 * @sideEffects Replaces the current drawing attempt.
 * @param props - The original code.
 * @returns The current attempt.
 */
function FinishedPlantuml({ source }: { readonly source: string }) {
  const dark = useDarkMode();
  const [attempt, retry] = useState(0);
  return (
    <DrawingAttempt key={`${String(dark)}:${attempt}`} source={source} dark={dark} onRetry={() => retry(attempt + 1)} />
  );
}

/** Owns one complete diagram, its source switch and the full-window preview.
 * @remarks Generated SVG is untrusted image data, never live DOM. Every Blob URL and worker
 * request belongs to this effect, so changing appearance or unmounting releases it.
 * @sideEffects Starts a bounded local worker; creates and revokes an image URL; opens a modal.
 * @param props - The complete, original code.
 * @returns The diagram, source or retryable failure.
 */
function DrawingAttempt({
  source,
  dark,
  onRetry,
}: {
  readonly source: string;
  readonly dark: boolean;
  readonly onRetry: () => void;
}) {
  const clock = useClock();
  const [drawing, setDrawing] = useState<Drawing>({ kind: "loading" });
  const [showingSource, showSource] = useState(false);
  const [preview, showPreview] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let imageUrl: string | null = null;
    renderPlantuml(source, dark, controller.signal, clock).then(
      (svg) => {
        if (!controller.signal.aborted) {
          imageUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
          setDrawing({ kind: "ready", url: imageUrl });
        }
        return undefined;
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setDrawing({ kind: "failed", reason: error instanceof PlantumlError ? error.reason : "failed" });
      },
    );
    return () => {
      controller.abort();
      if (imageUrl !== null) URL.revokeObjectURL(imageUrl);
    };
  }, [source, dark, clock]);
  const label = showingSource ? "看图" : "看源码";
  return (
    <div className="atrium-mermaid atrium-plantuml" data-testid="plantuml">
      <span className="atrium-plantuml-label">plantuml</span>
      <div className="atrium-block-actions">
        <button type="button" aria-label={label} title={label} onClick={() => showSource(!showingSource)}>
          {showingSource ? <Flowchart size={14} aria-hidden /> : <Code size={14} aria-hidden />}
        </button>
        <CodeBlockCopyButton code={source} />
        {drawing.kind === "ready" && !showingSource ? (
          <button type="button" aria-label="放大" title="放大" onClick={() => showPreview(true)}>
            <ArrowsOutSimple size={14} aria-hidden />
          </button>
        ) : null}
      </div>
      {showingSource ? (
        <CodeBlock code={source} language="plantuml" lineNumbers={false} />
      ) : drawing.kind === "ready" ? (
        <img
          src={drawing.url}
          alt="PlantUML 图表"
          className="mx-auto max-w-full"
          onError={() => {
            setDrawing({ kind: "failed", reason: "failed" });
            showPreview(false);
          }}
        />
      ) : (
        <div className="text-[length:var(--fs-sm)] text-[var(--text-muted)]" role="status">
          {drawing.kind === "loading" ? (
            "正在画图…"
          ) : (
            <>
              {FAILURES[drawing.reason]}{" "}
              <button type="button" className="atrium-press text-[var(--tint)]" onClick={onRetry}>
                重试
              </button>
              <CodeBlock code={source} language="plantuml" lineNumbers={false} />
            </>
          )}
        </div>
      )}
      {preview && drawing.kind === "ready" ? (
        <ImagePreview src={drawing.url} alt="PlantUML 图表" onClose={() => showPreview(false)} />
      ) : null}
    </div>
  );
}
