import { type AtriumClient, CommandError, isDirectionId } from "@atrium/client";
import type { DiffFile, FileContent } from "@atrium/protocol";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type StoreApi, useStore } from "zustand";
import { splitPath } from "../chat/changes";
import { ArrowUpRight, Code, Eye, Info, TextWrap } from "../design/icons";
import { MarkdownFilePreview } from "./markdown-file-preview";
import { CodeLines } from "./code-lines";
import { DemoPreview } from "./demo-preview";
import { CenterNote, DiffCounts } from "./diff-parts";
import { formatSize, highlightable, linesOf } from "./file-facts";
import { FileIcon } from "./file-icon";
import { type TokenLines, highlight } from "./highlight";
import { type WorkspaceViews, fileRevealed, keepPlace, placeOf, viewOf } from "../state/workspace-views";
import { useRunEnds } from "./use-diff";
import { useViewerPlace } from "./viewer-place";

/** A file as last read: its size and content, gone, or not readable. */
type Reading =
  | { readonly kind: "read"; readonly size: number; readonly content: FileContent }
  | { readonly kind: "gone" }
  | { readonly kind: "failed" };

/** A button on a viewer's top row (design-language, "查看标签"): 26px, `--selected` while on. */
export const VIEWER_BUTTON =
  "inline-flex size-[26px] flex-none items-center justify-center rounded-[var(--r)] text-[var(--text-dim)] hover:bg-[var(--hover)] hover:text-[var(--text-muted)] aria-pressed:bg-[var(--selected)] aria-pressed:text-[var(--text-2)]";

/**
 * Reads a file, again at a run's end and when its diff changes, keeping the reading while the
 * file reads the same.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 查看标签"): read when the tab shows, which mounts this; the same
 * reading again leaves everything, the scroll too, as it was. A learning direction's file is read
 * again when the direction is somewhere else now: archiving or restoring moves it, and a read in
 * the middle fails (SPEC-0008, "ML4 定的细节 · `list_dir`、`read_file`、`resolve_visual` 认方向").
 *
 * @sideEffects Sends `read_file`; updates component state as answers come, until unmounted.
 * @param client - The client.
 * @param workspaceId - The workspace.
 * @param path - The file.
 * @param changed - The file's diff as text, if it has one, so a change reads it again.
 * @returns The reading, or `null` until the first comes.
 */
function useReading(client: AtriumClient, workspaceId: string, path: string, changed: string): Reading | null {
  const [reading, setReading] = useState<Reading | null>(null);
  const runEnds = useRunEnds(client, workspaceId);
  const directionDir = useStore(client.index, (state) =>
    isDirectionId(workspaceId) ? (state.directions.find((one) => one.id === workspaceId)?.dir ?? null) : null,
  );
  useEffect(() => {
    let live = true;
    /**
     * Keeps a reading, unless the file reads as before.
     *
     * @remarks
     * See `useReading`.
     *
     * @sideEffects Updates component state while mounted.
     * @param next - The reading.
     */
    const arrived = (next: Reading): void => {
      if (live) setReading((now) => (JSON.stringify(now) === JSON.stringify(next) ? now : next));
    };
    client.readFile(workspaceId, path).then(
      ({ size, content }) => arrived({ kind: "read", size, content }),
      (error: unknown) =>
        arrived(
          error instanceof CommandError && error.code === "path_not_found" ? { kind: "gone" } : { kind: "failed" },
        ),
    );
    return () => {
      live = false;
    };
    // Read again at a run's end and when the file's diff changes (SPEC-0001, "M1.12 的文件与更改"), and a
    // direction's file once the direction moved (ML4).
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- see above.
  }, [client, workspaceId, path, runEnds, changed, directionDir]);
  return reading;
}

/**
 * A text's tokens, coloured off the page's thread when the file is small enough.
 *
 * @remarks
 * Uncoloured until they come, and for good when the file is too large or its language unknown.
 *
 * @sideEffects Asks the highlighting worker.
 * @param path - The file, for its language.
 * @param text - The text, or `null` for none.
 * @param lines - Its lines.
 * @param bytes - Its size.
 * @returns The lines' tokens, or `null`.
 */
function useTokens(path: string, text: string | null, lines: readonly string[], bytes: number): TokenLines | null {
  const [tokens, setTokens] = useState<{ readonly text: string; readonly lines: TokenLines } | null>(null);
  const wanted = text !== null && highlightable(lines.length, bytes);
  useEffect(() => {
    if (!wanted) return undefined;
    let live = true;
    highlight(path, [lines.join("\n")]).then(
      (texts) => live && texts?.[0] !== undefined && setTokens({ text, lines: texts[0] }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [path, text, lines, wanted]);
  return tokens !== null && tokens.text === text ? tokens.lines : null;
}

/** A file the browser shows as a page. */
const HTML_FILE = /\.html?$/iu;

/**
 * Runs `open` on ⌘O.
 *
 * @remarks
 * Only while the tab that gives it shows (SPEC-0001, "查看标签"); the key does nothing else in the
 * page.
 *
 * @sideEffects Listens for keys on the window while `open` is given.
 * @param open - What ⌘O does, or null for nothing.
 */
function useOpenShortcut(open: (() => void) | null): void {
  useEffect(() => {
    if (open === null) return undefined;
    /**
     * Acts on ⌘O.
     *
     * @remarks
     * See `useOpenShortcut`.
     *
     * @sideEffects Runs `open`; stops the browser's own handling of the key.
     * @param event - The key event.
     */
    const onKey = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.code !== "KeyO") return;
      event.preventDefault();
      open();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
}

/**
 * A file tab: the file's name, facts and diff, then its content.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 查看标签"); design-language ("查看标签"). Text shows numbered and
 * coloured as the chat's code blocks, not wrapped until asked; an image shows itself, never past
 * its size; anything else says in a line why it does not show. While the file has a diff, the
 * top row has its counts and "查看改动", to the 改动 tab. Its scroll and wrapping are kept by tab
 * (`useViewerPlace`). An HTML file the host read has "在浏览器打开", also on ⌘O while the tab
 * shows, where the desktop shell can open it: the host's read keeps to the workspace and refuses a
 * way through a link, which the desktop shell cannot tell. Markdown files can switch to the
 * shared safe renderer. Source stays laid out but invisible and inert while previewing, so its
 * real scroll is preserved; the preview owns a separate position and unmounts on return.
 *
 * @sideEffects Reads the file; asks the highlighting worker; reads and writes the views; listens
 * for ⌘O while an HTML file shows; preview may load renderer plugins and approved images; the handlers act.
 * @param props - The client, the workspace, the views, the file, its diff if it has one, what
 * "查看改动" does, and how to open the file in the browser, where it can be.
 * @returns The tab's content.
 */
export function FileViewer({
  client,
  workspaceId,
  views,
  path,
  diff,
  onShowDiff,
  onOpenInBrowser,
  demo = false,
  previewFirst = false,
}: {
  readonly client: AtriumClient;
  readonly workspaceId: string;
  readonly views: StoreApi<WorkspaceViews>;
  readonly path: string;
  readonly diff: DiffFile | null;
  readonly onShowDiff: () => void;
  /** Opens the file in the default browser; left out where the desktop shell cannot. */
  readonly onOpenInBrowser?: (() => void) | undefined;
  /** A learning direction's demo, rendered in its sandbox until its source is asked for (ML4). */
  readonly demo?: boolean;
  /** Whether a preview shows first, as in a learning direction (ML4); else the source does. */
  readonly previewFirst?: boolean;
}) {
  // Turned to text only when another diff comes.
  const changed = useMemo(() => (diff === null ? "" : JSON.stringify(diff)), [diff]);
  const reading = useReading(client, workspaceId, path, changed);
  // Only a file the host read in the workspace, not through a link (SPEC-0001, "查看标签").
  const openInBrowser =
    onOpenInBrowser !== undefined && HTML_FILE.test(path) && reading?.kind === "read" && reading.content.kind !== "link"
      ? onOpenInBrowser
      : null;
  useOpenShortcut(openInBrowser);
  const { wrap, switchWrap, body: scrolled } = useViewerPlace(views, workspaceId, `file:${path}`, reading !== null);
  const text = reading?.kind === "read" && reading.content.kind === "text" ? reading.content.text : null;
  const preview = useStore(views, (state) => placeOf(viewOf(state, workspaceId), `file:${path}`).markdownPreview);
  const canPreview = (demo || /\.(?:md|markdown)$/iu.test(path)) && text !== null;
  const [lines, setLines] = useState<{ readonly text: string | null; readonly lines: readonly string[] }>({
    text: null,
    lines: [],
  });
  // Split once per text (adjusting state while rendering, as React advises).
  if (lines.text !== text) setLines({ text, lines: text === null ? [] : linesOf(text) });
  const size = reading?.kind === "read" ? reading.size : 0;
  const tokens = useTokens(path, text, lines.lines, size);
  const { name, dir } = splitPath(path);
  const request = useStore(views, (state) => viewOf(state, workspaceId).fileReveal);
  const range = request?.path === path ? request.range : null;
  // A line asked for shows in the source, unless the preview was chosen.
  const previewing = canPreview && (preview ?? (previewFirst && range === null));
  const lineCount = lines.lines.length;
  const highlighted =
    range === null || lineCount === 0
      ? undefined
      : { start: Math.min(range.start, lineCount), end: Math.min(range.end, lineCount) };
  const firstLine = highlighted?.start;
  useEffect(() => {
    if (request === null || request.path !== path || request.done || reading?.kind !== "read") return undefined;
    const frame = requestAnimationFrame(() => {
      if (viewOf(views.getState(), workspaceId).fileReveal !== request) return;
      const row = scrolled.current?.querySelector(`[data-line-number="${firstLine}"]`);
      row?.scrollIntoView({ block: "center", inline: "nearest" });
      fileRevealed(views, workspaceId, request);
    });
    return () => cancelAnimationFrame(frame);
  }, [request, path, reading, firstLine, views, workspaceId, scrolled]);

  let body: ReactNode = null;
  if (reading?.kind === "gone") body = <CenterNote>文件已经不在了</CenterNote>;
  else if (reading?.kind === "failed") body = <CenterNote>读不了这个文件</CenterNote>;
  else if (reading?.kind === "read") {
    const { content } = reading;
    if (content.kind === "text")
      body = (
        <CodeLines
          lines={lines.lines}
          tokens={tokens}
          wrap={wrap}
          {...(highlighted === undefined ? {} : { highlight: highlighted })}
        />
      );
    else if (content.kind === "image") {
      body = (
        <div className="flex justify-center p-6">
          {/* Never wider than the tab nor than itself: Tailwind's base styles keep images within their box. */}
          <img alt={name} src={`data:${content.mimeType};base64,${content.data}`} draggable={false} />
        </div>
      );
    } else if (content.kind === "binary") body = <CenterNote>二进制文件，不显示内容（{formatSize(size)}）</CenterNote>;
    else if (content.kind === "too_large")
      body = <CenterNote>文件太大（{(size / 1024 / 1024).toFixed(1)} MB），不在这里显示</CenterNote>;
    else body = <CenterNote>这是符号链接，不显示内容</CenterNote>;
  }

  return (
    <section aria-label={path} className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--main)]">
      <header className="flex h-10 flex-none items-center gap-2 border-b-[0.5px] border-[var(--line)] pr-2 pl-3.5 text-[length:var(--fs-meta)]">
        <FileIcon path={path} size={14} />
        <span className="flex-none font-medium text-[var(--text)]">{name}</span>
        <span className="min-w-0 truncate text-[var(--text-dim)]">{dir}</span>
        {reading?.kind === "read" ? (
          <span className="flex-none font-[family-name:var(--font-mono)] text-[length:var(--fs-sm)] text-[var(--text-dim)] tabular-nums">
            {formatSize(size)}
            {text === null ? null : ` · ${lines.lines.length} 行`}
          </span>
        ) : null}
        <span className="flex-1" />
        {diff === null ? null : (
          <>
            <DiffCounts added={diff.added} removed={diff.removed} />
            <button
              type="button"
              onClick={onShowDiff}
              className="flex-none text-[length:var(--fs-sm)] text-[var(--tint)] hover:underline"
            >
              查看改动
            </button>
          </>
        )}
        {openInBrowser === null ? null : (
          <button
            type="button"
            aria-label="在浏览器打开"
            title="在浏览器打开 (⌘O)"
            onClick={openInBrowser}
            className={`atrium-press ${VIEWER_BUTTON}`}
          >
            <ArrowUpRight size={14} />
          </button>
        )}
        {demo ? (
          <span className="inline-flex flex-none items-center gap-1 text-[length:var(--fs-sm)] text-[var(--text-dim)]">
            <Info size={13} aria-hidden />
            在这里点的不会发到对话
          </span>
        ) : null}
        {canPreview ? (
          <button
            type="button"
            aria-pressed={previewing}
            onClick={() => keepPlace(views, workspaceId, `file:${path}`, { markdownPreview: !previewing })}
            className="atrium-press inline-flex h-[26px] flex-none items-center gap-1.5 rounded-[var(--r)] px-2 text-[length:var(--fs-sm)] text-[var(--text-muted)] hover:bg-[var(--hover)] aria-pressed:bg-[var(--selected)]"
          >
            {previewing ? <Code size={14} /> : <Eye size={14} />}
            {previewing ? "查看源码" : "预览"}
          </button>
        ) : null}
        {previewing ? null : (
          <button
            type="button"
            aria-label="换行"
            title="换行"
            aria-pressed={wrap}
            onClick={switchWrap}
            className={VIEWER_BUTTON}
          >
            <TextWrap size={14} />
          </button>
        )}
      </header>
      {range !== null && reading !== null && !previewing ? (
        <div role="status" className="flex-none px-3.5 py-1 text-[length:var(--fs-sm)] text-[var(--text-muted)]">
          {highlighted === undefined
            ? "文件没有可定位的文本行"
            : `${highlighted.start === highlighted.end ? `第 ${highlighted.start} 行` : `第 ${highlighted.start}–${highlighted.end} 行`}${range.end > lineCount ? "（请求超出文件范围）" : ""}`}
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrolled}
          data-testid="viewer-body"
          inert={previewing}
          className={`absolute inset-0 overflow-auto [contain:strict]${previewing ? " invisible" : ""}`}
        >
          {body}
        </div>
        {previewing && demo ? (
          <DemoPreview client={client} views={views} directionId={workspaceId} path={path} />
        ) : previewing ? (
          <MarkdownFilePreview client={client} views={views} workspaceId={workspaceId} path={path} text={text} />
        ) : null}
      </div>
    </section>
  );
}
