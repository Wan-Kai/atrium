import type { AtriumClient } from "@atrium/client";
import type { TranscriptItem } from "@atrium/protocol";
import { CaretDown, Check, DotsThree, Eye } from "@phosphor-icons/react";
import { DISPLAY_MODES, useDisplayMode } from "../state/display-mode";
import { MENU_ITEM, MenuButton } from "./menu-button";
import { transcriptMarkdown } from "./turn-layout";

/** The most pages an export fetches, so a host that keeps saying "more" cannot loop it forever. */
const MAX_EXPORT_PAGES = 10_000;

/**
 * Fetches a session's whole transcript, page by page.
 *
 * @remarks
 * The view only holds what was scrolled to; an export needs everything. It stops when there is
 * nothing older, or when a page brought nothing new, as when the host rebuilt the transcript and
 * the view went back to loading.
 *
 * @sideEffects Fetches older pages into the session's view.
 * @param client - The client.
 * @param sessionId - The session.
 * @returns Every item, oldest first.
 */
export async function wholeTranscript(client: AtriumClient, sessionId: string): Promise<readonly TranscriptItem[]> {
  for (let page = 0; page < MAX_EXPORT_PAGES; page += 1) {
    const before = client.session(sessionId)?.getState();
    if (before === undefined || !before.hasOlder) break;
    await client.loadOlder(sessionId);
    const after = client.session(sessionId)?.getState();
    if (after === undefined || after.items.length <= before.items.length) break;
  }
  return client.session(sessionId)?.getState().items ?? [];
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
 * they sit at the top of the conversation area. The mode menu shows the three modes with their
 * hints (Ctrl+O cycles them); "···" exports the whole session as Markdown (SPEC-0001,
 * "对话记录的其他设计").
 *
 * @sideEffects Exporting fetches the whole transcript and downloads a file.
 * @param props - The client and the session.
 * @returns The toolbar.
 */
export function SessionToolbar({ client, sessionId }: { readonly client: AtriumClient; readonly sessionId: string }) {
  const { mode, set } = useDisplayMode();
  const current = DISPLAY_MODES.find((entry) => entry.mode === mode);
  return (
    <div className="flex items-center justify-end gap-1 px-4 pt-2" data-testid="session-toolbar">
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
      <MenuButton label="当前会话" content={<DotsThree size={16} weight="bold" />}>
        {(close) => (
          <button
            type="button"
            role="menuitem"
            className={MENU_ITEM}
            onClick={() => {
              close();
              // Fire and forget: an export that fails to fetch saves nothing.
              void wholeTranscript(client, sessionId)
                .then((items) => download(`atrium-${sessionId}.md`, transcriptMarkdown(items)))
                .catch(() => undefined);
            }}
          >
            导出为 Markdown
          </button>
        )}
      </MenuButton>
    </div>
  );
}
