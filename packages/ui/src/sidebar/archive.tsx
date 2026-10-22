import { type AtriumClient, CommandError } from "@atrium/client";
import type { Chat, SessionSummary, Workspace } from "@atrium/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MENU_ITEM } from "../chat/menu-button";
import { MORE_ROW } from "./more-row";
import { chatName, timeAgo, workspaceName } from "./names";

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
 * Explains why restoring an archived workspace failed, in Chinese.
 *
 * @remarks
 * By the host's `params.reason`, absent when git failed; the wording is SPEC-0001's ("M1.11 的工作区
 * 归档").
 *
 * @sideEffects none
 * @param error - A `worktree_restore_failed` error.
 * @returns The sentence.
 */
export function describeRestoreError(error: CommandError): string {
  const reason = error.params?.["reason"];
  if (reason === "no_branch") return "没能恢复：不知道它归档时的分支";
  if (reason === "dir_taken") return "没能恢复：目录已被占用";
  if (reason === "branch_gone") return "没能恢复：分支已删除";
  return "没能恢复：git 没能加回这个 worktree，分支可能正被别处检出";
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
 * The archive confirmation's card over its scrim: a title, what archiving does, and "取消"
 * "归档".
 *
 * @remarks
 * Laid out as design-language says ("侧栏"), for workspaces and chats alike. Put on the page's
 * body, as the sidebar's blur would otherwise hold it inside the sidebar. The focus starts on
 * "取消"; Escape and the scrim cancel too.
 *
 * @sideEffects Focuses "取消" when shown; listens for Escape.
 * @param props - The title, the body, and what "归档" and cancelling do.
 * @returns The dialog.
 */
function ArchiveConfirm({
  title,
  children,
  onConfirm,
  onClose,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  useEffect(() => {
    /**
     * Cancels on Escape.
     *
     * @remarks
     * Like the scrim and "取消".
     *
     * @sideEffects Calls `onClose`.
     * @param event - The key event.
     */
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center">
      <div
        data-testid="archive-scrim"
        className="absolute inset-0 bg-[var(--scrim)] backdrop-blur-[8px] backdrop-saturate-[1.1]"
        onClick={onClose}
      />
      <div
        role="alertdialog"
        aria-modal
        aria-labelledby="archive-title"
        aria-describedby="archive-body"
        className="relative w-[380px] rounded-[var(--r-card)] bg-[var(--main)] p-5 shadow-[var(--card-shadow)]"
      >
        <h2 id="archive-title" className="text-[15px] font-semibold">
          {title}
        </h2>
        <div id="archive-body" className="mt-2 text-[length:var(--fs-meta)] leading-[1.55] text-[var(--text-2)]">
          {children}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancel}
            type="button"
            onClick={onClose}
            className="h-[30px] rounded-[var(--r-btn)] px-3 text-[length:var(--fs-meta)] text-[var(--text-2)] shadow-[inset_0_0_0_0.5px_var(--line-strong)] hover:bg-[var(--hover)]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-[30px] rounded-[var(--r-btn)] bg-[var(--danger)] px-3 text-[length:var(--fs-meta)] text-white hover:brightness-110"
          >
            归档
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Asks before archiving a worktree workspace.
 *
 * @remarks
 * Always asked, as archiving removes the directory (SPEC-0001, "M1.11 的工作区归档"). It closes on
 * "归档" and the sidebar archives in the background, telling in a notice whether it worked.
 *
 * @sideEffects none; calls `onArchive` or `onClose` when answered.
 * @param props - The workspace, how many of its sessions run, what archiving does, and how to close.
 * @returns The dialog.
 */
export function ArchiveDialog({
  workspace,
  running,
  onArchive,
  onClose,
}: {
  readonly workspace: Workspace;
  readonly running: number;
  readonly onArchive: () => void;
  readonly onClose: () => void;
}) {
  return (
    <ArchiveConfirm
      title={`归档工作区「${workspaceName(workspace)}」？`}
      onConfirm={() => {
        onClose();
        onArchive();
      }}
      onClose={onClose}
    >
      <p>会删除 worktree 目录（包括被 git 忽略的文件）{kept(workspace)}；之后可以在项目菜单的“已归档的工作区”里恢复</p>
      {running > 0 ? (
        <p className="mt-1.5 text-[var(--danger)]">其中 {running} 个会话正在运行，归档会停止它们</p>
      ) : null}
    </ArchiveConfirm>
  );
}

/**
 * Asks before archiving a chat some of whose sessions run.
 *
 * @remarks
 * Only asked then, as archiving a chat removes nothing (SPEC-0001, "M1.11 的对话归档"); it
 * closes on "归档" and the sidebar archives, saying why in its problem line on failure.
 *
 * @sideEffects none; calls `onArchive` or `onClose` when answered.
 * @param props - The chat's name, how many of its sessions run, what archiving does, and how to
 * close.
 * @returns The dialog.
 */
export function ChatArchiveDialog({
  name,
  running,
  onArchive,
  onClose,
}: {
  readonly name: string;
  readonly running: number;
  readonly onArchive: () => void;
  readonly onClose: () => void;
}) {
  return (
    <ArchiveConfirm
      title={`归档对话「${name}」？`}
      onConfirm={() => {
        onClose();
        onArchive();
      }}
      onClose={onClose}
    >
      <p>其中 {running} 个会话正在运行，归档会停止它们；之后可以在“已归档的对话”里恢复</p>
    </ArchiveConfirm>
  );
}

/**
 * Explains why archiving or restoring a chat failed, in Chinese.
 *
 * @remarks
 * The wording is SPEC-0001's ("M1.11 的对话归档"): a chat that went says so, anything else says
 * what did not happen.
 *
 * @sideEffects none
 * @param error - What the command rejected with.
 * @param failed - What did not happen: "没能归档这个对话" or "没能恢复这个对话".
 * @returns The sentence.
 */
export function describeChatArchiveError(error: unknown, failed: string): string {
  return error instanceof CommandError && error.code === "chat_not_found" ? "这个对话已经不在了" : failed;
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

/**
 * The end of the "对话" section: "已归档的对话", which opens the archived chats' list in place, each
 * with "恢复".
 *
 * @remarks
 * Shown only with a chat archived; newest archived first, named as the sidebar names chats, eight
 * rows tall at most and scrolling past that (SPEC-0001, "M1.11 的对话归档"; design-language,
 * "侧栏"). Restoring goes nowhere; a failure shows in the sidebar's problem line.
 *
 * @sideEffects Sends `restore_chat` when used.
 * @param props - The client, the archived chats, the sessions to name them by, the time now, and
 * how to run a sidebar command.
 * @returns The row and, while open, the list; nothing without archived chats.
 */
export function ArchivedChats({
  client,
  chats,
  sessions,
  now,
  run,
}: {
  readonly client: AtriumClient;
  readonly chats: readonly Chat[];
  readonly sessions: readonly SessionSummary[];
  readonly now: number;
  readonly run: (command: () => Promise<unknown>, describe: (error: unknown) => string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (chats.length === 0) return null;
  const newest = chats.toSorted((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  return (
    <>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={MORE_ROW}>
        已归档的对话
      </button>
      {open ? (
        <ul aria-label="已归档的对话" className="max-h-64 overflow-y-auto" data-testid="archived-chats">
          {newest.map((chat) => {
            const name = chatName(chat, sessions);
            return (
              <li key={chat.id} className="flex h-8 items-center gap-2 rounded-[var(--r)] pr-1 pl-2.5">
                <span className="min-w-0 truncate text-[length:var(--fs-meta)] text-[var(--text-2)]">{name}</span>
                <span className="shrink-0 text-[length:var(--fs-sm)] text-[var(--text-dim)]">
                  {timeAgo(chat.archivedAt ?? now, now)}
                </span>
                <button
                  type="button"
                  aria-label={`恢复 ${name}`}
                  className="ml-auto shrink-0 rounded-[var(--r)] px-1.5 py-0.5 text-[length:var(--fs-meta)] text-[var(--tint)] hover:bg-[var(--hover)]"
                  onClick={() =>
                    run(
                      () => client.restoreChat(chat.id),
                      (error) => describeChatArchiveError(error, "没能恢复这个对话"),
                    )
                  }
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
