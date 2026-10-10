import { type AtriumClient, CommandError } from "@atrium/client";
import type { SessionSummary, TranscriptItem } from "@atrium/protocol";
import { CaretDown, Check, DotsThree, Eye } from "@phosphor-icons/react";
import { useState } from "react";
import { MENU_ITEM, MenuButton } from "../chat/menu-button";
import { transcriptMarkdown } from "../chat/turn-layout";
import { sessionTitle } from "../sidebar/names";
import { RenameField } from "../sidebar/rename-field";
import { DISPLAY_MODES, useDisplayMode } from "../state/display-mode";
import { terminalCommand } from "./hand-off";

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
 * Saves text as a file through the browser's download.
 *
 * @remarks
 * In the app, Electron asks where to save it.
 *
 * @sideEffects Creates and revokes an object URL; clicks a temporary link.
 * @param name - The file's name.
 * @param text - Its content.
 */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * The display mode menu at the tab bar's right end.
 *
 * @remarks
 * Shows the three modes with their hints; Ctrl+O cycles them (SPEC-0001, "显示模式").
 *
 * @sideEffects Changing the mode saves it with the preferences.
 * @returns The menu.
 */
export function DisplayModeMenu() {
  const { mode, set } = useDisplayMode();
  const current = DISPLAY_MODES.find((entry) => entry.mode === mode);
  return (
    <MenuButton
      label="显示模式（Ctrl+O 切换）"
      content={
        <>
          <Eye size={14} />
          {current?.label}模式
          <CaretDown size={10} />
        </>
      }
    >
      {(close) =>
        DISPLAY_MODES.map((entry) => (
          <button
            key={entry.mode}
            type="button"
            role="menuitemradio"
            aria-checked={entry.mode === mode}
            className={MENU_ITEM}
            onClick={() => {
              set(entry.mode);
              close();
            }}
          >
            <span className="w-3.5">{entry.mode === mode ? <Check size={13} /> : null}</span>
            <span>{entry.label}</span>
            <span className="ml-auto pl-3 text-[length:var(--fs-sm)] text-[var(--text-dim)]">{entry.hint}</span>
          </button>
        ))
      }
    </MenuButton>
  );
}

/**
 * Why a hand-off to the terminal failed, in words.
 *
 * @remarks
 * The host refuses a session with a run or messages queued (SPEC-0001, "交给终端").
 *
 * @sideEffects none
 * @param error - What the hand-off threw.
 * @returns The words.
 */
function describeHandOffError(error: unknown): string {
  return error instanceof CommandError && error.code === "session_busy"
    ? "先停止运行或清空排队，再交给终端"
    : "交给终端失败";
}

/**
 * Why the hand-off item is greyed, if it is.
 *
 * @remarks
 * pi in a terminal goes on from the session's file, which a draft does not have yet; a running
 * session must be stopped first (SPEC-0001, "交给终端").
 *
 * @sideEffects none
 * @param session - The session.
 * @returns The reason, or `null` when it can be handed off.
 */
function handOffBlocked(session: Pick<SessionSummary, "file" | "running">): string | null {
  if (session.file === null) return "发出第一条消息后才能交给终端";
  return session.running ? "先停止运行再交给终端" : null;
}

/**
 * The "···" menu of the active session: rename, archive, copy the file's path, go on in a
 * terminal, export.
 *
 * @remarks
 * SPEC-0001 ("标签栏", "交给终端"). Renaming asks for the name in place of the menu; renaming,
 * copying and the terminal need the session's file, which a draft does not have yet. Going on in
 * a terminal copies the command that does it. Failures are shown next to the menu.
 *
 * @sideEffects Sends commands; writes the clipboard; downloads an export.
 * @param props - The client and the session.
 * @returns The menu.
 */
export function SessionMenu({ client, session }: { readonly client: AtriumClient; readonly session: SessionSummary }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

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
    // Fire and forget: a failure is shown.
    void action().catch((error: unknown) => setProblem(typeof failure === "string" ? failure : failure(error)));
  };
  const blocked = handOffBlocked(session);

  return (
    <>
      {problem === null ? null : (
        <span role="status" className="text-[length:var(--fs-sm)] text-[var(--danger)]">
          {problem}
        </span>
      )}
      {renaming ? (
        <span className="flex w-56">
          <RenameField
            initial={sessionTitle(session)}
            label="会话名称"
            onDone={(name) => {
              setRenaming(false);
              if (typeof name === "string") run(() => client.renameSession(session.sessionId, name), "改名失败");
            }}
          />
        </span>
      ) : null}
      <MenuButton label="当前会话" content={<DotsThree size={16} weight="bold" />}>
        {(close) => (
          <>
            <button
              type="button"
              role="menuitem"
              className={`${MENU_ITEM} disabled:cursor-not-allowed disabled:text-[var(--text-dim)] disabled:hover:bg-transparent`}
              disabled={session.state === "draft"}
              title={session.state === "draft" ? "发出第一条消息后才能改名" : undefined}
              onClick={() => {
                close();
                setRenaming(true);
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
              disabled={blocked !== null}
              title={blocked ?? "复制在终端里接着做的命令"}
              onClick={() => {
                close();
                run(async () => {
                  const { file } = await client.handOff(session.sessionId);
                  await navigator.clipboard.writeText(terminalCommand(file)).catch(() => undefined);
                }, describeHandOffError);
              }}
            >
              在终端中继续
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
                    ),
                  "导出时对话记录刚好更新了，请再试一次",
                );
              }}
            >
              导出为 Markdown
            </button>
          </>
        )}
      </MenuButton>
    </>
  );
}
