import { type AtriumClient } from "@atrium/client";
import type { SessionSummary, TranscriptItem } from "@atrium/protocol";
import { DotsThree } from "../design/icons";
import { useState } from "react";
import { useStore } from "zustand";
import { desktopBridge } from "../app/bootstrap";
import { MENU_ITEM, MenuButton } from "../chat/menu-button";
import { download } from "../chat/download";
import { transcriptMarkdown } from "../chat/turn-layout";

/** The most pages an export fetches, so a host that keeps saying "more" cannot loop it forever. */
const MAX_EXPORT_PAGES = 10_000;

/**
 * Fetches a session's whole transcript, page by page.
 *
 * @remarks
 * The view only holds what was scrolled to; an export needs everything. If the host rebuilds
 * the transcript meanwhile, the view starts over from its latest turns, so the export fails
 * rather than saving part of the session; so does a page that brought nothing new.
 *
 * @sideEffects Fetches older pages into the session's view.
 * @param client - The client.
 * @param sessionId - The session.
 * @returns Every item, oldest first.
 * @throws {Error} When the transcript changed or stopped growing before it was complete.
 */
export async function wholeTranscript(client: AtriumClient, sessionId: string): Promise<readonly TranscriptItem[]> {
  const start = client.session(sessionId)?.getState();
  if (start === undefined) return [];
  for (let page = 0; page < MAX_EXPORT_PAGES; page += 1) {
    const before = client.session(sessionId)?.getState();
    if (before === undefined || before.epoch !== start.epoch || before.status === "loading") break;
    if (!before.hasOlder) return before.items;
    await client.loadOlder(sessionId);
    const after = client.session(sessionId)?.getState();
    if (after === undefined || after.items.length <= before.items.length) break;
  }
  throw new Error("the transcript changed while it was being exported");
}

/**
 * The "···" menu of the active session: rename, archive, copy the file's path, open a terminal
 * in its workspace, export.
 *
 * @remarks
 * SPEC-0001 ("标签栏", "在终端中打开"). Renaming happens on the session's tab, which the tab bar
 * holds, so it says here whether the last rename failed; renaming and copying need the session's
 * file, which a draft does not have yet, though a draft child conversation can be renamed
 * (SPEC-0002, "概念 · 名字"). Opening a terminal only opens one, in the session's workspace or in
 * the home folder for a chat, and leaves the session as it is; the desktop shell does it, so a
 * browser has no such item. Failures are shown next to the menu, until the next action.
 *
 * @sideEffects Sends commands; writes the clipboard; downloads an export; asks the desktop shell
 * to open a terminal.
 * @param props - The client, the session, whether its last rename failed, how to start renaming
 * it, and what to do as another action starts.
 * @returns The menu.
 */
export function SessionMenu({
  client,
  session,
  renameFailed,
  onRename,
  onAction,
}: {
  readonly client: AtriumClient;
  readonly session: SessionSummary;
  readonly renameFailed: boolean;
  readonly onRename: () => void;
  /** Called as an action other than renaming starts, which clears a rename's failure. */
  readonly onAction: () => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const shown = problem ?? (renameFailed ? "改名失败" : null);
  // A chat has no workspace: the desktop shell opens a terminal in the home folder instead.
  const workspaceDir = useStore(
    client.index,
    (index) => index.workspaces.find((workspace) => workspace.id === session.containerId)?.dir ?? null,
  );
  const desktop = desktopBridge();
  // A child's name waits in its record until pi writes its file (SPEC-0002, "概念 · 名字").
  const unnamable = session.state === "draft" && session.parent === null;

  /**
   * Runs a menu action, showing a failure next to the menu.
   *
   * @remarks
   * See `SessionMenu`.
   *
   * @sideEffects Runs the action; may set the problem line.
   * @param action - The action.
   * @param failure - What to say when it fails, or how to tell it from the error.
   */
  const run = (action: () => Promise<unknown>, failure: string | ((error: unknown) => string)): void => {
    setProblem(null);
    onAction();
    // Fire and forget: a failure is shown.
    void action().catch((error: unknown) => setProblem(typeof failure === "string" ? failure : failure(error)));
  };

  return (
    <>
      {shown === null ? null : (
        <span role="status" className="text-[length:var(--fs-sm)] text-[var(--danger)]">
          {shown}
        </span>
      )}
      <MenuButton label="当前会话" content={<DotsThree size={16} weight="bold" />}>
        {(close) => {
          return (
            <>
              <button
                type="button"
                role="menuitem"
                className={`${MENU_ITEM} disabled:cursor-not-allowed disabled:text-[var(--text-dim)] disabled:hover:bg-transparent`}
                disabled={unnamable}
                title={unnamable ? "发出第一条消息后才能改名" : undefined}
                onClick={() => {
                  close();
                  setProblem(null);
                  onRename();
                }}
              >
                重命名
              </button>
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                onClick={() => {
                  close();
                  run(() => client.archiveSession(session.sessionId), "归档失败");
                }}
              >
                归档
              </button>
              <button
                type="button"
                role="menuitem"
                className={`${MENU_ITEM} disabled:cursor-not-allowed disabled:text-[var(--text-dim)] disabled:hover:bg-transparent`}
                disabled={session.file === null}
                title={session.file === null ? "发出第一条消息后才有会话文件" : session.file}
                onClick={() => {
                  close();
                  const file = session.file ?? "";
                  run(() => navigator.clipboard.writeText(file), "复制失败");
                }}
              >
                复制会话文件路径
              </button>
              <button
                type="button"
                role="menuitem"
                className={`${MENU_ITEM} disabled:cursor-not-allowed disabled:text-[var(--text-dim)] disabled:hover:bg-transparent`}
                disabled={desktop?.openTerminal === undefined}
                title={desktop?.openTerminal === undefined ? "只在桌面 App 里可用" : "在会话的目录里打开终端"}
                onClick={() => {
                  close();
                  run(async () => {
                    await desktop?.openTerminal?.(workspaceDir);
                  }, "打开终端失败");
                }}
              >
                在终端中打开
              </button>
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                onClick={() => {
                  close();
                  run(
                    async () =>
                      download(
                        `atrium-${session.sessionId}.md`,
                        transcriptMarkdown(await wholeTranscript(client, session.sessionId)),
                        "text/markdown;charset=utf-8",
                      ),
                    "导出时对话记录刚好更新了，请再试一次",
                  );
                }}
              >
                导出为 Markdown
              </button>
            </>
          );
        }}
      </MenuButton>
    </>
  );
}
