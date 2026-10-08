import type { AtriumClient } from "@atrium/client";
import type { TranscriptItem } from "@atrium/protocol";
import { CaretDown, CaretLeft, Check, DotsThree, Eye } from "@phosphor-icons/react";
import { useState } from "react";
import { DISPLAY_MODES, useDisplayMode } from "../state/display-mode";
import { MENU_ITEM, MenuButton } from "./menu-button";
import { transcriptMarkdown } from "./turn-layout";

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
 * The display mode and session menus above the transcript.
 *
 * @remarks
 * Their place is the tab bar's right end (SPEC-0001, "标签栏"), which comes with M1.5; until then
 * they sit at the top of the conversation area, with a way back to M1.4's recent sessions. The
 * mode menu shows the three modes with their hints (Ctrl+O cycles them); "···" exports the whole
 * session as Markdown (SPEC-0001, "对话记录的其他设计").
 *
 * @sideEffects Exporting fetches the whole transcript and downloads a file, or says it failed.
 * @param props - The client, the session, and how to go back to the recent sessions.
 * @returns The toolbar.
 */
export function SessionToolbar({
  client,
  sessionId,
  onClose,
}: {
  readonly client: AtriumClient;
  readonly sessionId: string;
  readonly onClose: () => void;
}) {
  const { mode, set } = useDisplayMode();
  const [exportFailed, setExportFailed] = useState(false);
  const current = DISPLAY_MODES.find((entry) => entry.mode === mode);
  return (
    <div className="flex items-center justify-end gap-1 px-4 pt-2" data-testid="session-toolbar">
      <button
        type="button"
        onClick={onClose}
        className="mr-auto flex h-7 items-center gap-1.5 rounded-[var(--r)] px-2 text-[length:var(--fs-meta)] text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-2)]"
      >
        <CaretLeft size={12} />
        最近会话
      </button>
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
      {exportFailed ? (
        <span role="status" className="text-[length:var(--fs-sm)] text-[var(--danger)]">
          导出时对话记录刚好更新了，请再试一次
        </span>
      ) : null}
      <MenuButton label="当前会话" content={<DotsThree size={16} weight="bold" />}>
        {(close) => (
          <button
            type="button"
            role="menuitem"
            className={MENU_ITEM}
            onClick={() => {
              close();
              setExportFailed(false);
              // Fire and forget: a failed export says so next to the menu.
              void wholeTranscript(client, sessionId)
                .then((items) => download(`atrium-${sessionId}.md`, transcriptMarkdown(items)))
                .catch(() => setExportFailed(true));
            }}
          >
            导出为 Markdown
          </button>
        )}
      </MenuButton>
    </div>
  );
}
