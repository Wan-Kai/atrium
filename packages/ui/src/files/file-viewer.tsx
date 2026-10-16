import { type AtriumClient, CommandError } from "@atrium/client";
import type { DiffFile, FileContent } from "@atrium/protocol";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { StoreApi } from "zustand";
import { splitPath } from "../chat/changes";
import { ArrowUpRight, TextWrap } from "../design/icons";
import { CodeLines } from "./code-lines";
import { CenterNote, DiffCounts } from "./diff-parts";
import { formatSize, highlightable, linesOf } from "./file-facts";
import { FileIcon } from "./file-icon";
import { type TokenLines, highlight } from "./highlight";
import type { WorkspaceViews } from "../state/workspace-views";
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
 * reading again leaves everything, the scroll too, as it was.
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
    // Read again at a run's end and when the file's diff changes (SPEC-0001, "M1.12 的文件与更改").
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- see above.
  }, [client, workspaceId, path, runEnds, changed]);
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
 * way through a link, which the desktop shell cannot tell.
 *
 * @sideEffects Reads the file; asks the highlighting worker; reads and writes the views; listens
 * for ⌘O while an HTML file shows; the handlers act.
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
}: {
  readonly client: AtriumClient;
  readonly workspaceId: string;
  readonly views: StoreApi<WorkspaceViews>;
  readonly path: string;
  readonly diff: DiffFile | null;
  readonly onShowDiff: () => void;
  /** Opens the file in the default browser; left out where the desktop shell cannot. */
  readonly onOpenInBrowser?: (() => void) | undefined;
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
  const [lines, setLines] = useState<{ readonly text: string | null; readonly lines: readonly string[] }>({
    text: null,
    lines: [],
  });
  // Split once per text (adjusting state while rendering, as React advises).
  if (lines.text !== text) setLines({ text, lines: text === null ? [] : linesOf(text) });
  const size = reading?.kind === "read" ? reading.size : 0;
  const tokens = useTokens(path, text, lines.lines, size);
  const { name, dir } = splitPath(path);

  let body: ReactNode = null;
  if (reading?.kind === "gone") body = <CenterNote>文件已经不在了</CenterNote>;
  else if (reading?.kind === "failed") body = <CenterNote>读不了这个文件</CenterNote>;
  else if (reading?.kind === "read") {
    const { content } = reading;
    if (content.kind === "text") body = <CodeLines lines={lines.lines} tokens={tokens} wrap={wrap} />;
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
      </header>
      <div ref={scrolled} data-testid="viewer-body" className="min-h-0 flex-1 overflow-auto [contain:strict]">
        {body}
      </div>
    </section>
  );
}
