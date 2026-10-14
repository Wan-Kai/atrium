import type { ChangesView, DiffView } from "@atrium/client";
import type { DiffFile, DiffMode } from "@atrium/protocol";
import type { ReactNode } from "react";
import { formatDiffCount } from "../chat/changes";
import { MENU_ITEM, MenuButton } from "../chat/menu-button";
import { ArrowRight, CaretDown, CircleNotch, DotOutline, MinusSquare, PlusSquare } from "../design/icons";

/** How each mode is named in the mode menu and the 改动 tab. */
export const MODE_NAMES: Readonly<Record<DiffMode, string>> = { uncommitted: "未提交", base: "已提交" };

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
export function StatusIcon({ status }: { readonly status: DiffFile["status"] }) {
  const label = STATUS_NAMES[status];
  if (status === "added") return <PlusSquare size={14} aria-label={label} className="flex-none text-[var(--ok)]" />;
  if (status === "deleted")
    return <MinusSquare size={14} aria-label={label} className="flex-none text-[var(--danger)]" />;
  if (status === "renamed") return <ArrowRight size={14} aria-label={label} className="flex-none text-[var(--tint)]" />;
  return <DotOutline size={14} weight="fill" aria-label={label} className="flex-none text-[var(--attn)]" />;
}

/**
 * A line in the middle of a pane saying why there is nothing to show.
 *
 * @remarks
 * Centred, 64px down, as Paseo's empty and error states (design-language, "查看标签").
 *
 * @sideEffects none
 * @param props - What to say, and an action under it.
 * @returns The note.
 */
export function CenterNote({ children, action }: { readonly children: ReactNode; readonly action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center text-[length:var(--fs-meta)] text-[var(--text-muted)]">
      <p className="flex flex-col items-center gap-2">{children}</p>
      {action}
    </div>
  );
}

/**
 * The menu choosing what the diff compares.
 *
 * @remarks
 * SPEC-0001 ("工作区改动"): "已提交" names the branch and its base when they differ.
 *
 * @sideEffects none; choosing calls `onChoose`.
 * @param props - The mode shown, the workspace's changes, and what choosing does.
 * @returns The menu's button.
 */
export function ModeMenu({
  mode,
  changes,
  onChoose,
}: {
  readonly mode: DiffMode;
  readonly changes: ChangesView;
  readonly onChoose: (mode: DiffMode) => void;
}) {
  const described =
    changes !== null && changes.branch !== null && changes.base !== null && changes.branch !== changes.base
      ? `${changes.branch} → ${changes.base}`
      : null;
  return (
    <MenuButton
      label="比较"
      align="start"
      content={
        <>
          {MODE_NAMES[mode]}
          <CaretDown size={12} />
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
              onChoose(option);
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
  );
}

/**
 * What a diff's pane says instead of its files, if anything.
 *
 * @remarks
 * SPEC-0001 ("工作区改动"), for the 更改 tree and the 改动 tab alike: in order, that it is loading,
 * that the directory is not a repository, that git failed, that the diff is too large, or that
 * there are no changes, with a way to the other mode when it has some.
 *
 * @sideEffects none; the way to the other mode calls `onChoose`.
 * @param shown - The diff shown, or `null` until it comes.
 * @param mode - The mode shown.
 * @param changes - The workspace's changes.
 * @param onChoose - What choosing the other mode does.
 * @returns The note, or `null` when there are files to show.
 */
export function diffNote(
  shown: DiffView | null,
  mode: DiffMode,
  changes: ChangesView,
  onChoose: (mode: DiffMode) => void,
): ReactNode {
  if (shown === null || shown.status !== "ready") {
    return (
      <CenterNote>
        <CircleNotch size={20} className="animate-spin text-[var(--text-dim)]" />
        正在检查仓库…
      </CenterNote>
    );
  }
  if (shown.error === "not_git") return <CenterNote>不是 git 仓库</CenterNote>;
  if (shown.error === "failed") return <CenterNote>读不到改动，稍后再试</CenterNote>;
  if (shown.tooLarge) {
    return (
      <CenterNote action={<span className="text-[var(--text-dim)]">缩小比较范围再看</span>}>
        改动太大，无法在这里预览
      </CenterNote>
    );
  }
  if (shown.files.length > 0) return null;
  const dirty = changes?.dirty ?? false;
  const other =
    mode === "base" && dirty ? "uncommitted" : mode === "uncommitted" && (changes?.ahead ?? 0) > 0 ? "base" : null;
  return (
    <CenterNote
      action={
        other === null ? null : (
          <button type="button" className="text-[var(--tint)]" onClick={() => onChoose(other)}>
            {other === "uncommitted" ? "看未提交的改动" : "看已提交的改动"}
          </button>
        )
      }
    >
      没有改动
    </CenterNote>
  );
}
