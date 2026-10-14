import type { AtriumClient } from "@atrium/client";
import type { DiffFile, DiffHunk, DiffMode } from "@atrium/protocol";
import { memo, useEffect, useRef, useState } from "react";
import { type StoreApi, useStore } from "zustand";
import { diffTotals, splitPath } from "../chat/changes";
import { ArrowsInLineVertical, ArrowsOutLineVertical, CaretDown, TextWrap } from "../design/icons";
import {
  type WorkspaceViews,
  chooseDiff,
  keepPaths,
  keptPaths,
  keptPathsKey,
  revealed,
  viewOf,
} from "../state/workspace-views";
import { LineChunks, LineText } from "./code-lines";
import { DiffCounts, MODE_NAMES, StatusIcon, diffNote } from "./diff-parts";
import { colourable, hunkSides, hunkTokens } from "./diff-sides";
import { FileIcon } from "./file-icon";
import { VIEWER_BUTTON } from "./file-viewer";
import { type Token, type TokenLines, highlight } from "./highlight";
import { changeTree, treeOrder } from "./trees";
import { useShownDiff } from "./use-diff";

/** A file's hunks coloured, each line's tokens in the hunk's order. */
type Coloured = readonly (readonly (readonly Token[] | undefined)[])[];

/**
 * One hunk's lines, numbered, with add and remove bars.
 *
 * @remarks
 * design-language ("查看标签"): the `@@` header a grey line; a 44px column of numbers with a 2px
 * bar on its left; a removed line's own text `--text-3`, its colours as they are. Drawn in
 * groups (`LineChunks`).
 *
 * @sideEffects none
 * @param props - The hunk, its lines' tokens if coloured, and whether to wrap.
 * @returns The lines.
 */
function HunkLines({
  hunk,
  tokens,
  wrap,
}: {
  readonly hunk: DiffHunk;
  readonly tokens: readonly (readonly Token[] | undefined)[] | undefined;
  readonly wrap: boolean;
}) {
  const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
  return (
    <>
      <div className="bg-[var(--hover)] px-3 text-[var(--text-dim)] select-none">{header}</div>
      <LineChunks
        count={hunk.lines.length}
        renderLine={(index) => {
          const line = hunk.lines[index];
          return line === undefined ? null : (
            <div
              // Lines never move within a hunk.
              key={index}
              data-kind={line.kind}
              className={`flex ${
                line.kind === "add"
                  ? "bg-[var(--diff-add-bg)] shadow-[inset_2px_0_0_var(--ok)]"
                  : line.kind === "del"
                    ? "bg-[var(--diff-del-bg)] shadow-[inset_2px_0_0_var(--danger)]"
                    : ""
              }`}
            >
              <span className="w-11 flex-none pr-3 text-right text-[var(--text-dim)] select-none">
                {line.newNumber ?? line.oldNumber}
              </span>
              <span
                className={`flex-1 ${wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre"} ${line.kind === "del" ? "text-[var(--text-3)]" : "text-[var(--text)]"}`}
              >
                <LineText text={line.text} tokens={tokens?.[index]} />
              </span>
            </div>
          );
        }}
      />
    </>
  );
}

/**
 * One file in the 改动 tab: a header that sticks and folds it, then its diff.
 *
 * @remarks
 * design-language ("查看标签"): the header 32px, sticking until the next one pushes it away; a
 * binary file, or one too large, shows one line instead of its lines. Drawn again only when its
 * own props change, so colouring one file leaves the others be.
 *
 * @sideEffects none; the handlers act.
 * @param props - The file, its tokens if coloured, whether it is folded or wrapped, what folding
 * does, and how to know its element.
 * @returns The file's section.
 */
const FileDiff = memo(function FileDiff({
  file,
  coloured,
  folded,
  wrap,
  onFold,
  anchor,
}: {
  readonly file: DiffFile;
  readonly coloured: Coloured | undefined;
  readonly folded: boolean;
  readonly wrap: boolean;
  readonly onFold: (path: string) => void;
  readonly anchor: (path: string, element: HTMLElement | null) => void;
}) {
  const { name, dir } = splitPath(file.path);
  return (
    <section ref={(element) => anchor(file.path, element)} aria-label={file.path} data-path={file.path}>
      <button
        type="button"
        aria-expanded={!folded}
        onClick={() => onFold(file.path)}
        title={file.oldPath === null ? file.path : `${file.oldPath} → ${file.path}`}
        className="sticky top-0 z-[1] flex h-8 w-full items-center gap-2 border-y-[0.5px] border-[var(--line)] bg-[var(--main)] px-3 text-left text-[length:var(--fs-meta)] hover:bg-[var(--surface-2)]"
      >
        <CaretDown size={10} className={`flex-none text-[var(--text-dim)] ${folded ? "-rotate-90" : ""}`} />
        <FileIcon path={file.path} size={14} />
        <span className="min-w-0 flex-1 truncate">
          {file.oldPath === null ? null : <span className="text-[var(--text-dim)]">{file.oldPath} → </span>}
          <span className="text-[var(--text)]">{name}</span>
          <span className="ml-1.5 text-[var(--text-dim)]">{dir}</span>
        </span>
        <DiffCounts added={file.added} removed={file.removed} />
        <StatusIcon status={file.status} />
      </button>
      {folded ? null : (
        <div
          className={`code-tokens pb-1 font-[family-name:var(--font-mono)] text-[length:var(--fs-sm)] leading-[1.7] ${wrap ? "" : "min-w-max"}`}
        >
          {file.content === "binary" ? (
            <p className="px-3 py-2 text-[var(--text-dim)]">二进制文件</p>
          ) : file.content === "too_large" ? (
            <p className="px-3 py-2 text-[var(--text-dim)]">改动太大，不显示</p>
          ) : (
            file.hunks.map((hunk, index) => (
              <HunkLines key={`${hunk.oldStart},${hunk.newStart}`} hunk={hunk} tokens={coloured?.[index]} wrap={wrap} />
            ))
          )}
        </div>
      )}
    </section>
  );
});

/** Each diff's hunks as text, worked out once (see `hunksKey`). */
const HUNK_KEYS = new WeakMap<readonly DiffHunk[], string>();

/**
 * What a file's hunks hold, as text, to tell whether a diff sent again changed it.
 *
 * @remarks
 * Kept by the hunks themselves: the tab draws again as the panes beside it move, and writing out
 * some 20,000 lines each time would take most of a frame (design-language, "查看标签").
 *
 * @sideEffects Remembers the text for the hunks.
 * @param file - The file.
 * @returns The text.
 */
function hunksKey(file: DiffFile): string {
  const known = HUNK_KEYS.get(file.hunks);
  if (known !== undefined) return known;
  const key = JSON.stringify(file.hunks);
  HUNK_KEYS.set(file.hunks, key);
  return key;
}

/** A file's diff coloured, and what it held then. */
interface Done {
  readonly key: string;
  readonly coloured: Coloured;
}

/**
 * The next file to colour: the first in view not coloured as it is now, else the first anywhere.
 *
 * @remarks
 * See `useColoured`.
 *
 * @sideEffects none
 * @param files - The files.
 * @param inView - The paths of those in view.
 * @param done - What is coloured so far.
 * @returns The file, or `undefined` when all are done.
 */
function nextToColour(
  files: readonly DiffFile[],
  inView: ReadonlySet<string>,
  done: ReadonlyMap<string, Done>,
): DiffFile | undefined {
  const waiting = files.filter((file) => colourable(file) && done.get(file.path)?.key !== hunksKey(file));
  return waiting.find((file) => inView.has(file.path)) ?? waiting[0];
}

/**
 * The files' diffs coloured, a file at a time in the background, those in view first.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 查看标签"): uncoloured until they come; a file kept by what it
 * holds, so a diff sent again colours only what changed. Files past `colourable` stay uncoloured.
 * One file is asked at a time; each answer asks for the next, reading what is wanted then.
 *
 * @sideEffects Asks the highlighting worker, one file at a time, until unmounted.
 * @param files - The files.
 * @param inView - The paths of the files in view now.
 * @returns Each file's tokens by path, those coloured so far.
 */
function useColoured(files: readonly DiffFile[], inView: ReadonlySet<string>): ReadonlyMap<string, Coloured> {
  const [done, setDone] = useState<ReadonlyMap<string, Done>>(new Map());
  const latest = useRef({ files, inView, done });
  const flying = useRef(false);
  const mounted = useRef(true);
  const [pump] = useState(() => {
    /**
     * Asks for the next file, unless one is being coloured or none is left.
     *
     * @remarks
     * See `useColoured`.
     *
     * @sideEffects Asks the highlighting worker; its answer updates state and asks again.
     */
    const ask = (): void => {
      const file = nextToColour(latest.current.files, latest.current.inView, latest.current.done);
      if (flying.current || !mounted.current || file === undefined) return;
      flying.current = true;
      const key = hunksKey(file);
      /**
       * Keeps a file's tokens, and goes on to the next.
       *
       * @remarks
       * A file that could not be coloured is kept without tokens, so it is not asked again.
       *
       * @sideEffects Updates state while mounted; asks for the next.
       * @param texts - The hunk sides' lines of tokens, or `null`.
       */
      const arrived = (texts: readonly TokenLines[] | null): void => {
        flying.current = false;
        if (!mounted.current) return;
        const coloured = file.hunks.map((hunk, index) =>
          hunkTokens(hunk, texts?.[index * 2] ?? [], texts?.[index * 2 + 1] ?? []),
        );
        const next = new Map([...latest.current.done, [file.path, { key, coloured }]]);
        latest.current = { ...latest.current, done: next };
        setDone(next);
        ask();
      };
      highlight(file.path, file.hunks.flatMap(hunkSides)).then(arrived, () => arrived(null));
    };
    return ask;
  });
  useEffect(() => {
    latest.current = { files, inView, done };
    pump();
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return new Map(
    [...done].flatMap(([path, { key, coloured }]) =>
      files.some((file) => file.path === path && hunksKey(file) === key) ? [[path, coloured] as const] : [],
    ),
  );
}

/**
 * The 改动 tab: every changed file's diff, in the 更改 tree's order.
 *
 * @remarks
 * SPEC-0001 ("M1.12 的文件与更改 · 查看标签"); design-language ("查看标签"). The diff and its mode
 * are the right panel's. The top row says the mode, the files and their totals, with "全部折叠 /
 * 展开" and wrapping; what is folded is kept by workspace and mode. Opened from a file in the tree,
 * it goes to that file's header, unfolding it, and the header's background fades from
 * `--selected` in 1s. Below the last file there is room to bring it to the top. The scroll area is
 * contained, so a move of the panes beside it does not walk its lines (design-language, "右栏").
 *
 * @sideEffects Subscribes to the client and the views; reads and writes the views' storage; asks
 * the highlighting worker; scrolls and animates its files' headers.
 * @param props - The client, the workspace, the views, and the mode.
 * @returns The tab's content.
 */
export function DiffViewer({
  client,
  workspaceId,
  views,
  mode,
}: {
  readonly client: AtriumClient;
  readonly workspaceId: string;
  readonly views: StoreApi<WorkspaceViews>;
  readonly mode: DiffMode;
}) {
  const shown = useShownDiff(client, workspaceId, mode);
  const changes = useStore(client.changes(workspaceId));
  const reveal = useStore(views, (state) => viewOf(state, workspaceId).reveal);
  const storage = useStore(views, (state) => state.storage);
  const key = keptPathsKey("foldedFiles", workspaceId, mode);
  const [folds, setFolds] = useState(() => ({ key, folded: keptPaths(storage, key) }));
  // The folds of another mode are its own (adjusting state while rendering, as React advises).
  if (folds.key !== key) setFolds({ key, folded: keptPaths(storage, key) });
  const { folded } = folds;
  const [wrap, setWrap] = useState(false);
  const [inView, setInView] = useState<ReadonlySet<string>>(new Set());
  const anchors = useRef(new Map<string, HTMLElement>());
  const body = useRef<HTMLDivElement>(null);
  // The header's flash, cancelled when the tab goes: a running animation keeps its element, and
  // with it the whole tab, alive until it ends.
  const flash = useRef<Animation | null>(null);
  useEffect(() => () => flash.current?.cancel(), []);
  const note = diffNote(shown, mode, changes, (next) =>
    chooseDiff(views, workspaceId, { mode: next, dirty: changes?.dirty ?? false }),
  );
  const [ordered, setOrdered] = useState<{ readonly from: unknown; readonly files: readonly DiffFile[] }>({
    from: null,
    files: [],
  });
  const files = note === null && shown !== null ? shown.files : null;
  // Ordered once per diff (adjusting state while rendering, as React advises).
  if (ordered.from !== files) setOrdered({ from: files, files: files === null ? [] : treeOrder(changeTree(files)) });
  const coloured = useColoured(ordered.files, inView);

  /**
   * Folds or unfolds files, and keeps what is folded.
   *
   * @remarks
   * See `DiffViewer`.
   *
   * @sideEffects Updates state; writes the storage.
   * @param next - What is folded now.
   */
  const keep = (next: ReadonlySet<string>): void => {
    keepPaths(storage, key, next);
    setFolds({ key, folded: next });
  };
  // What is folded and where it is kept, for the folding below, which stays the same function.
  const latest = useRef({ folded, key });
  useEffect(() => {
    latest.current = { folded, key };
  });
  const [onFold] = useState(() => (path: string): void => {
    const next = new Set(latest.current.folded);
    if (!next.delete(path)) next.add(path);
    keepPaths(storage, latest.current.key, next);
    setFolds({ key: latest.current.key, folded: next });
  });
  const [anchor] = useState(() => (path: string, element: HTMLElement | null) => {
    if (element === null) anchors.current.delete(path);
    else anchors.current.set(path, element);
  });

  useEffect(() => {
    const root = body.current;
    if (root === null) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        setInView((now) => {
          const next = new Set(now);
          for (const entry of entries) {
            const path = entry.target.getAttribute("data-path") ?? "";
            if (entry.isIntersecting) next.add(path);
            else next.delete(path);
          }
          return next;
        });
      },
      { root },
    );
    for (const element of anchors.current.values()) observer.observe(element);
    return () => observer.disconnect();
    // Observes the files' sections again whenever they may be others.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- see above.
  }, [ordered.files, folded]);

  useEffect(() => {
    // Going to a file is done once (`revealed`); a folded file unfolds first.
    if (reveal === null || reveal.done) return;
    if (folded.has(reveal.path)) {
      keepPaths(storage, key, new Set([...folded].filter((path) => path !== reveal.path)));
      // oxlint-disable-next-line react/set-state-in-effect -- follows the views' asking to go to the file.
      setFolds({ key, folded: new Set([...folded].filter((path) => path !== reveal.path)) });
      return;
    }
    const element = anchors.current.get(reveal.path);
    if (element === undefined) return;
    revealed(views, workspaceId);
    element.scrollIntoView({ block: "start" });
    flash.current?.cancel();
    flash.current =
      element
        .querySelector("button")
        ?.animate([{ backgroundColor: "var(--selected)" }, { backgroundColor: "var(--main)" }], { duration: 1000 }) ??
      null;
    // Tried again once the files show, as the file's section comes with them.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- see above.
  }, [reveal, folded, key, storage, views, workspaceId, ordered.files]);

  const allFolded = ordered.files.length > 0 && ordered.files.every((file) => folded.has(file.path));
  return (
    <section aria-label="改动" className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--main)]">
      <header className="flex h-10 flex-none items-center gap-2 border-b-[0.5px] border-[var(--line)] pr-2 pl-3.5 text-[length:var(--fs-meta)]">
        <span className="font-medium text-[var(--text)]">{MODE_NAMES[mode]}</span>
        {ordered.files.length === 0 ? null : (
          <>
            <span className="text-[var(--text-dim)] tabular-nums">{ordered.files.length} 个文件</span>
            <DiffCounts {...diffTotals(ordered.files)} />
          </>
        )}
        <span className="flex-1" />
        <button
          type="button"
          aria-label={allFolded ? "全部展开" : "全部折叠"}
          title={allFolded ? "全部展开" : "全部折叠"}
          onClick={() => keep(allFolded ? new Set() : new Set(ordered.files.map((file) => file.path)))}
          className={VIEWER_BUTTON}
        >
          {allFolded ? <ArrowsOutLineVertical size={14} /> : <ArrowsInLineVertical size={14} />}
        </button>
        <button
          type="button"
          aria-label="换行"
          title="换行"
          aria-pressed={wrap}
          onClick={() => setWrap(!wrap)}
          className={VIEWER_BUTTON}
        >
          <TextWrap size={14} />
        </button>
      </header>
      <div ref={body} data-testid="viewer-body" className="min-h-0 flex-1 overflow-auto [contain:strict]">
        {note ?? (
          <>
            {ordered.files.map((file) => (
              <FileDiff
                key={file.path}
                file={file}
                coloured={coloured.get(file.path)}
                folded={folded.has(file.path)}
                wrap={wrap}
                onFold={onFold}
                anchor={anchor}
              />
            ))}
            <div aria-hidden="true" className="h-[calc(100%-32px)]" />
          </>
        )}
      </div>
    </section>
  );
}
