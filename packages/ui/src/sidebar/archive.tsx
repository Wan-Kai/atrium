import { type AtriumClient, CommandError } from "@atrium/client";
import type { Workspace } from "@atrium/protocol";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MENU_ITEM } from "../chat/menu-button";
import { timeAgo, workspaceName } from "./names";

/**
 * Explains why archiving a workspace failed, in Chinese.
 *
 * @remarks
 * The host sends codes (AGENTS.md); the wording is SPEC-0001's ("M1.11 的工作区归档").
 *
 * @sideEffects none
 * @param error - What `archive_workspace` rejected with.
 * @returns The sentence.
 */
export function describeArchiveError(error: unknown): string {
  const code = error instanceof CommandError ? error.code : null;
  if (code === "workspace_dirty") return "有未提交的改动，先提交或丢弃再归档";
  if (code === "workspace_unsaved_commits") return "当前提交不在任何分支上，先建一个分支再归档";
  if (code === "worktree_remove_failed") return "git 没能删除这个 worktree";
  if (code === "workspace_not_found") return "这个工作区已经不在了";
  return "宿主出错了，没有完成";
}

/**
 * What archiving keeps, as the confirmation says it.
 *
 * @remarks
 * The branch, or the commit when the worktree is detached; a worktree whose directory has gone
 * has neither.
 *
 * @sideEffects none
 * @param workspace - The workspace.
 * @returns The clause, or an empty string.
 */
function kept(workspace: Pick<Workspace, "branch" | "head">): string {
  if (workspace.branch !== null) return `，分支 ${workspace.branch} 保留`;
  return workspace.head === null ? "" : `，提交 ${workspace.head} 保留`;
}

/**
 * Asks before archiving a worktree workspace, and archives it.
 *
 * @remarks
 * Always asked, as archiving removes the directory (SPEC-0001, "M1.11 的工作区归档"); laid out as
 * design-language says ("侧栏"). Put on the page's body, as the sidebar's blur would otherwise hold
 * it inside the sidebar. While archiving it waits for the answer: it closes on success and says
 * why on failure.
 *
 * @sideEffects Sends `archive_workspace`; listens for Escape while shown.
 * @param props - The client, the workspace, how many of its sessions run, and how to close.
 * @returns The dialog.
 */
export function ArchiveDialog({
  client,
  workspace,
  running,
  onClose,
}: {
  readonly client: AtriumClient;
  readonly workspace: Workspace;
  readonly running: number;
  readonly onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const name = workspaceName(workspace);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  useEffect(() => {
    if (busy) return undefined;
    /**
     * Cancels on Escape.
     *
     * @remarks
     * Not while archiving, whose answer the dialog waits for.
     *
     * @sideEffects Calls `onClose`.
     * @param event - The key event.
     */
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [busy, onClose]);

  /**
   * Archives the workspace, closing on success and saying why on failure.
   *
   * @remarks
   * See `ArchiveDialog`; it never rejects.
   *
   * @sideEffects Sends `archive_workspace`; sets component state; may call `onClose`.
   */
  const archive = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await client.archiveWorkspace(workspace.id);
      onClose();
    } catch (failure) {
      setBusy(false);
      setError(describeArchiveError(failure));
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center">
      <div
        data-testid="archive-scrim"
        className="absolute inset-0 bg-[var(--scrim)] backdrop-blur-[8px] backdrop-saturate-[1.1]"
        onClick={busy ? undefined : onClose}
      />
      <div
        role="alertdialog"
        aria-modal
        aria-labelledby="archive-title"
        aria-describedby="archive-body"
        className="relative w-[380px] rounded-[var(--r-card)] bg-[var(--main)] p-5 shadow-[var(--card-shadow)]"
      >
        <h2 id="archive-title" className="text-[15px] font-semibold">
          归档工作区「{name}」？
        </h2>
        <div id="archive-body" className="mt-2 text-[length:var(--fs-meta)] leading-[1.55] text-[var(--text-2)]">
          <p>
            会删除 worktree 目录（包括被 git 忽略的文件）{kept(workspace)}；之后可以在项目菜单的“已归档的工作区”里恢复
          </p>
          {running > 0 ? (
            <p className="mt-1.5 text-[var(--danger)]">其中 {running} 个会话正在运行，归档会停止它们</p>
          ) : null}
        </div>
        {error === null ? null : (
          <p role="alert" className="mt-2 text-[length:var(--fs-meta)] leading-[1.55] text-[var(--danger)]">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancel}
            type="button"
            disabled={busy}
            onClick={onClose}
            className="h-[30px] rounded-[var(--r-btn)] px-3 text-[length:var(--fs-meta)] text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] hover:bg-[var(--hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void archive()}
            className="h-[30px] rounded-[var(--r-btn)] bg-[var(--danger)] px-3 text-[length:var(--fs-meta)] text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "归档中…" : "归档"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The project menu's archived workspaces: an item that opens their list, each with "恢复".
 *
 * @remarks
 * Newest archived first, eight rows tall at most, scrolling past that (SPEC-0001, "M1.11 的工作区
 * 归档"; design-language, "侧栏"). Restoring closes the menu; a failure shows in the sidebar's
 * problem line.
 *
 * @sideEffects Sends `restore_workspace` when used.
 * @param props - The client, the project's archived workspaces, the time now, how to run a
 * sidebar command and how to close the menu.
 * @returns The item and, while open, the list.
 */
export function ArchivedWorkspaces({
  client,
  workspaces,
  now,
  run,
  close,
}: {
  readonly client: AtriumClient;
  readonly workspaces: readonly Workspace[];
  readonly now: number;
  readonly run: (command: () => Promise<unknown>) => void;
  readonly close: () => void;
}) {
  const [open, setOpen] = useState(false);
  const newest = workspaces.toSorted((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  return (
    <>
      <button type="button" role="menuitem" aria-expanded={open} className={MENU_ITEM} onClick={() => setOpen(!open)}>
        已归档的工作区
      </button>
      {open ? (
        <ul aria-label="已归档的工作区" className="max-h-64 overflow-y-auto" data-testid="archived-workspaces">
          {newest.map((workspace) => {
            const name = workspaceName(workspace);
            return (
              <li key={workspace.id} className="flex h-8 items-center gap-2 rounded-[var(--r)] pr-1 pl-2.5">
                <span className="min-w-0 truncate text-[length:var(--fs-meta)] text-[var(--text-2)]">{name}</span>
                <span className="shrink-0 text-[length:var(--fs-sm)] text-[var(--text-dim)]">
                  {timeAgo(workspace.archivedAt ?? now, now)}
                </span>
                <button
                  type="button"
                  role="menuitem"
                  aria-label={`恢复 ${name}`}
                  className="ml-auto shrink-0 rounded-[var(--r)] px-1.5 py-0.5 text-[length:var(--fs-meta)] text-[var(--tint)] hover:bg-[var(--hover)]"
                  onClick={() => {
                    close();
                    run(() => client.restoreWorkspace(workspace.id));
                  }}
                >
                  恢复
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}
