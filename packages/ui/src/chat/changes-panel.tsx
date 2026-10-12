import type { AtriumClient, DiffView } from "@atrium/client";
import type { DiffFile, DiffHunk, DiffMode } from "@atrium/protocol";
import {
  ArrowClockwise,
  ArrowRight,
  CaretDown,
  CircleNotch,
  DotOutline,
  MinusSquare,
  PlusSquare,
  X,
} from "../design/icons";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { type DiffChoice, diffModeOf, diffTotals, formatDiffCount, splitPath } from "./changes";
import { MENU_ITEM, MenuButton } from "./menu-button";

/** How each mode is named in the panel's menu. */
const MODE_NAMES: Readonly<Record<DiffMode, string>> = { uncommitted: "未提交", base: "已提交" };

/** How each status is named, for the icon's label. */
const STATUS_NAMES: Readonly<Record<DiffFile["status"], string>> = {
  added: "新增",
  deleted: "删除",
  modified: "修改",
  renamed: "重命名",
};

/**
 * Lines added and removed, in green and red.
 *
 * @remarks
 * As every turn's change summary writes them, with `−`; counts past 999 compactly (SPEC-0001,
 * "工作区改动").
 *
 * @sideEffects none
 * @param props - The counts.
 * @returns The counts.
 */
export function DiffCounts({ added, removed }: { readonly added: number; readonly removed: number }) {
  return (
    <span className="flex gap-1 font-[family-name:var(--font-mono)] text-[length:var(--fs-sm)] tabular-nums">
      <span className="text-[var(--ok-text)]">+{formatDiffCount(added)}</span>
      <span className="text-[var(--danger)]">−{formatDiffCount(removed)}</span>
    </span>
  );
}

/**
 * A file's status as a small coloured icon.
 *
 * @remarks
 * As Paseo's: a plus for a new file, a minus for a deleted one, a dot for a modified one; Atrium
 * adds an arrow for a rename, which Paseo does not mark.
 *
 * @sideEffects none
 * @param props - The status.
 * @returns The icon.
 */
function StatusIcon({ status }: { readonly status: DiffFile["status"] }) {
  const label = STATUS_NAMES[status];
  if (status === "added") return <PlusSquare size={14} aria-label={label} className="flex-none text-[var(--ok)]" />;
  if (status === "deleted")
    return <MinusSquare size={14} aria-label={label} className="flex-none text-[var(--danger)]" />;
  if (status === "renamed") return <ArrowRight size={14} aria-label={label} className="flex-none text-[var(--tint)]" />;
  return <DotOutline size={14} weight="fill" aria-label={label} className="flex-none text-[var(--attn)]" />;
}

/**
 * One hunk's lines, numbered, with add and remove bars.
 *
 * @remarks
 * As the tools' diffs in the transcript; the `@@` header is a grey line (SPEC-0001, "工作区改动").
 *
 * @sideEffects none
 * @param props - The hunk.
 * @returns The lines.
 */
function HunkLines({ hunk }: { readonly hunk: DiffHunk }) {
  const header = `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`;
  return (
    <>
      <div className="bg-[var(--hover)] px-2 text-[var(--text-dim)] select-none">{header}</div>
      {hunk.lines.map((line, index) => (
        <div
          // Lines never move within a hunk.
          // oxlint-disable-next-line react/no-array-index-key -- see above.
          key={index}
          data-kind={line.kind}
          className={`flex whitespace-pre ${
            line.kind === "add"
              ? "bg-[var(--diff-add-bg)] shadow-[inset_2px_0_0_var(--ok)]"
              : line.kind === "del"
                ? "bg-[var(--diff-del-bg)] shadow-[inset_2px_0_0_var(--danger)]"
                : ""
          }`}
        >
          <span className="w-[40px] flex-none pr-2.5 text-right text-[var(--text-dim)] select-none">
            {line.newNumber ?? line.oldNumber}
          </span>
          <span className={`flex-1 pl-2 ${line.kind === "add" ? "text-[var(--text)]" : "text-[var(--text-3)]"}`}>
            {line.text}
          </span>
        </div>
      ))}
    </>
  );
}

/**
 * One file's diff, with a header that folds it.
 *
 * @remarks
 * The header has the name, the directory in grey, the counts and the status; a rename names the
 * old path too. A binary file, or one too large, shows one line instead of its lines.
 *
 * @sideEffects none
 * @param props - The file, whether it is folded, and how to fold it.
 * @returns The file's section.
 */
function FileDiff({
  file,
  folded,
  onFold,
  anchor,
}: {
  readonly file: DiffFile;
  readonly folded: boolean;
  readonly onFold: () => void;
  readonly anchor: (element: HTMLElement | null) => void;
}) {
  const { name, dir } = splitPath(file.path);
  return (
    <section ref={anchor} aria-label={file.path} className="border-b-[0.5px] border-[var(--line)]">
      <button
        type="button"
        aria-expanded={!folded}
        onClick={onFold}
        title={file.oldPath === null ? file.path : `${file.oldPath} → ${file.path}`}
        className="sticky top-0 z-[1] flex h-[30px] w-full items-center gap-2 bg-[var(--surface-1)] px-3 text-left text-[length:var(--fs-meta)] hover:bg-[var(--hover)]"
      >
        <CaretDown size={10} className={`flex-none text-[var(--text-dim)] ${folded ? "-rotate-90" : ""}`} />
        <span className="min-w-0 flex-1 truncate">
          {file.oldPath === null ? null : <span className="text-[var(--text-dim)]">{file.oldPath} → </span>}
          <span className="text-[var(--text)]">{name}</span>
          <span className="ml-1.5 text-[var(--text-dim)]">{dir}</span>
        </span>
        <DiffCounts added={file.added} removed={file.removed} />
        <StatusIcon status={file.status} />
      </button>
      {folded ? null : (
        <div className="overflow-x-auto pb-1 font-[family-name:var(--font-mono)] text-[length:var(--fs-sm)] leading-[1.7]">
          {file.content === "binary" ? (
            <p className="px-3 py-2 text-[var(--text-dim)]">二进制文件</p>
          ) : file.content === "too_large" ? (
            <p className="px-3 py-2 text-[var(--text-dim)]">改动太大，不显示</p>
          ) : (
            file.hunks.map((hunk) => <HunkLines key={`${hunk.oldStart},${hunk.newStart}`} hunk={hunk} />)
          )}
        </div>
      )}
    </section>
  );
}

/**
 * A line in the middle of the panel saying why there is nothing to show.
 *
 * @remarks
 * Centred, as Paseo's empty and error states.
 *
 * @sideEffects none
 * @param props - What to say, and an action under it.
 * @returns The note.
 */
function PanelNote({ children, action }: { readonly children: ReactNode; readonly action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center text-[length:var(--fs-meta)] text-[var(--text-muted)]">
      <p className="flex flex-col items-center gap-2">{children}</p>
      {action}
    </div>
  );
}

/**
 * The changes panel: a workspace's git changes, file by file.
 *
 * @remarks
 * SPEC-0001 ("工作区改动"), copied from Paseo: "未提交" compares the working tree with HEAD,
 * "已提交" the branch's commits with the merge base; the mode follows `diffModeOf`. It asks the
 * host for its target while shown and closes it when it goes. The body says, in order, that it is
 * loading, that the directory is not a repository, that git failed, that the diff is too large,
 * or that there are no changes, with a way to the other mode when it has some; else it lists the
 * files, a click going to one, then each file's diff. The refresh button asks for the same target
 * again; Esc inside the panel or the close button closes it.
 *
 * @sideEffects Asks the host for the panel's target while shown, and to close it when gone.
 * @param props - The client, the workspace, and how to close.
 * @returns The panel.
 */
export function ChangesPanel({
  client,
  workspaceId,
  onClose,
}: {
  readonly client: AtriumClient;
  readonly workspaceId: string;
  readonly onClose: () => void;
}) {
  const changes = useStore(client.changes(workspaceId));
  const dirty = changes?.dirty ?? false;
  const [choice, setChoice] = useState<DiffChoice | null>(null);
  const mode = diffModeOf(choice, dirty);
  useEffect(() => {
    // A choice made while the tree was otherwise is gone for good once it changes, as in Paseo.
    // oxlint-disable-next-line react-hooks-js/set-state-in-effect -- follows the host's report.
    if (choice !== null && choice.dirty !== dirty) setChoice(null);
  }, [choice, dirty]);
  useEffect(() => {
    // Fire and forget: a failure leaves the panel loading until the next connection asks again.
    client.watchDiff({ workspaceId, mode }).catch(() => undefined);
  }, [client, workspaceId, mode]);
  useEffect(
    () => () => {
      // Fire and forget: see above.
      client.watchDiff(null).catch(() => undefined);
    },
    [client],
  );
  const view = useStore(client.diff);
  const shown: DiffView | null = view.target?.workspaceId === workspaceId && view.target.mode === mode ? view : null;
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const anchors = useRef(new Map<string, HTMLElement>());

  /**
   * Shows a mode, remembering how dirty the tree was.
   *
   * @remarks
   * See `diffModeOf`.
   *
   * @sideEffects Updates the panel's state.
   * @param next - The mode.
   */
  const choose = (next: DiffMode): void => setChoice({ mode: next, dirty });

  /**
   * Closes the panel on Esc while the focus is in it.
   *
   * @remarks
   * Esc in the input box still stops a run.
   *
   * @sideEffects May close the panel.
   * @param event - The key.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onClose();
  };

  const totals = shown === null ? null : diffTotals(shown.files);
  const described =
    changes !== null && changes.branch !== null && changes.base !== null && changes.branch !== changes.base
      ? `${changes.branch} → ${changes.base}`
      : null;
  let body: ReactNode;
  if (shown === null || shown.status === "loading") {
    body = (
      <PanelNote>
        <CircleNotch size={20} className="animate-spin text-[var(--text-dim)]" />
        正在检查仓库…
      </PanelNote>
    );
  } else if (shown.error === "not_git") {
    body = <PanelNote>不是 git 仓库</PanelNote>;
  } else if (shown.error === "failed") {
    body = <PanelNote>读不到改动，稍后再试</PanelNote>;
  } else if (shown.tooLarge) {
    body = (
      <PanelNote action={<span className="text-[var(--text-dim)]">缩小比较范围再看</span>}>
        改动太大，无法在这里预览
      </PanelNote>
    );
  } else if (shown.files.length === 0) {
    const other =
      mode === "base" && dirty ? "uncommitted" : mode === "uncommitted" && (changes?.ahead ?? 0) > 0 ? "base" : null;
    body = (
      <PanelNote
        action={
          other === null ? null : (
            <button type="button" className="text-[var(--tint)]" onClick={() => choose(other)}>
              {other === "uncommitted" ? "看未提交的改动" : "看已提交的改动"}
            </button>
          )
        }
      >
        没有改动
      </PanelNote>
    );
  } else {
    body = (
      <>
        <ul aria-label="改动的文件" className="border-b-[0.5px] border-[var(--line)] p-1">
          {shown.files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                onClick={() => {
                  setFolded((all) => new Set([...all].filter((path) => path !== file.path)));
                  anchors.current.get(file.path)?.scrollIntoView({ block: "start" });
                }}
                className="flex h-7 w-full items-center gap-2 rounded-[var(--r)] px-2 text-left text-[length:var(--fs-meta)] text-[var(--text-2)] hover:bg-[var(--hover)]"
              >
                <StatusIcon status={file.status} />
                <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-[length:var(--fs-sm)]">
                  {file.path}
                </span>
                <DiffCounts added={file.added} removed={file.removed} />
              </button>
            </li>
          ))}
        </ul>
        {shown.files.map((file) => (
          <FileDiff
            key={file.path}
            file={file}
            folded={folded.has(file.path)}
            onFold={() =>
              setFolded((all) =>
                all.has(file.path)
                  ? new Set([...all].filter((path) => path !== file.path))
                  : new Set([...all, file.path]),
              )
            }
            anchor={(element) => {
              if (element === null) anchors.current.delete(file.path);
              else anchors.current.set(file.path, element);
            }}
          />
        ))}
      </>
    );
  }

  return (
    <aside
      aria-label="改动"
      onKeyDown={onKeyDown}
      className="flex w-[560px] max-w-[50%] flex-none flex-col border-l-[0.5px] border-[var(--line)] bg-[var(--surface-1)]"
    >
      <header className="flex h-11 flex-none items-center gap-2 border-b-[0.5px] border-[var(--line)] px-3">
        <h2 className="text-[length:var(--fs-meta)] font-medium text-[var(--text)]">改动</h2>
        <MenuButton
          label="比较"
          align="start"
          content={
            <>
              {MODE_NAMES[mode]}
              <CaretDown size={10} />
            </>
          }
        >
          {(close) =>
            (["uncommitted", "base"] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={option === mode}
                className={`${MENU_ITEM} flex-col items-start gap-0`}
                onClick={() => {
                  choose(option);
                  close();
                }}
              >
                {MODE_NAMES[option]}
                {option === "base" && described !== null ? (
                  <span className="text-[length:var(--fs-xs)] text-[var(--text-dim)]">{described}</span>
                ) : null}
              </button>
            ))
          }
        </MenuButton>
        {totals === null || shown?.files.length === 0 ? null : <DiffCounts {...totals} />}
        <span className="flex-1" />
        <button
          type="button"
          aria-label="刷新"
          title="刷新"
          onClick={() => {
            // Fire and forget: see the effect above.
            client.watchDiff({ workspaceId, mode }).catch(() => undefined);
          }}
          className="rounded-[var(--r)] p-1.5 text-[var(--text-dim)] hover:bg-[var(--hover)] hover:text-[var(--text-muted)]"
        >
          <ArrowClockwise size={14} />
        </button>
        <button
          type="button"
          aria-label="关闭改动"
          title="关闭"
          onClick={onClose}
          className="rounded-[var(--r)] p-1.5 text-[var(--text-dim)] hover:bg-[var(--hover)] hover:text-[var(--text-muted)]"
        >
          <X size={14} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto" data-testid="changes-body">
        {body}
      </div>
    </aside>
  );
}
