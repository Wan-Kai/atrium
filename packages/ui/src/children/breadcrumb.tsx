import type { AtriumClient } from "@atrium/client";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { MENU_ITEM, MenuButton } from "../chat/menu-button";
import { CaretRight } from "../design/icons";
import { sessionTitle } from "../sidebar/names";
import { showNotice } from "../state/session-notices";
import { type WorkspaceViews, showViewer } from "../state/workspace-views";
import { chainOf, crumbsOf } from "./children";

/** A crumb's look; the current session's is the text's own colour and does nothing. */
const CRUMB =
  "max-w-[220px] truncate rounded-[var(--r-sm)] px-1.5 py-0.5 text-[var(--text-muted)] hover:bg-[var(--hover)] hover:text-[var(--text-2)]";

/**
 * The thin breadcrumb under the tab bar while a child conversation is shown.
 *
 * @remarks
 * SPEC-0002 ("显示 · 子对话的标签"; prototype A): "主对话名 › 子对话名", a name before the last
 * going back to that session; over three levels the middle ones fold into "…", which lists them.
 * Nothing for a session without a parent. The session chosen shows, though its workspace showed a
 * viewer tab, as one chosen in the sidebar does.
 *
 * @sideEffects Opens a session when a crumb is chosen; writes the views.
 * @param props - The client, the session shown and the workspace views.
 * @returns The breadcrumb, or nothing.
 */
export function Breadcrumb({
  client,
  sessionId,
  views,
}: {
  readonly client: AtriumClient;
  readonly sessionId: string;
  readonly views?: StoreApi<WorkspaceViews>;
}) {
  const sessions = useStore(client.index, (index) => index.sessions);
  const chain = chainOf(sessions, sessionId);
  if (chain.length < 2) return null;

  /**
   * Opens a session of the chain, saying beside the tab bar when it could not.
   *
   * @remarks
   * See `Breadcrumb`.
   *
   * @sideEffects Sends `open_session`; writes the views; may show a notice.
   * @param target - The session.
   */
  const open = (target: string): void => {
    const containerId = sessions.find((one) => one.sessionId === target)?.containerId;
    if (views !== undefined && containerId !== undefined) showViewer(views, containerId, null);
    // Fire and forget: a failure is shown.
    void client.openSession(target).catch(() => showNotice(sessionId, "没能打开那个对话", true));
  };

  return (
    <nav
      aria-label="子对话的位置"
      className="flex h-[30px] shrink-0 items-center gap-0.5 px-4 text-[length:var(--fs-sm)] shadow-[inset_0_-0.5px_0_var(--line-soft)]"
    >
      {crumbsOf(chain).map((crumb, at) => (
        <span
          key={"session" in crumb ? crumb.session.sessionId : "folded"}
          className="flex min-w-0 items-center gap-0.5"
        >
          {at === 0 ? null : <CaretRight size={10} className="shrink-0 text-[var(--text-dim)]" />}
          {"folded" in crumb ? (
            <MenuButton label="中间的对话" align="start" compact content="…">
              {(close) =>
                crumb.folded.map((session) => (
                  <button
                    key={session.sessionId}
                    type="button"
                    role="menuitem"
                    className={MENU_ITEM}
                    onClick={() => {
                      close();
                      open(session.sessionId);
                    }}
                  >
                    {sessionTitle(session)}
                  </button>
                ))
              }
            </MenuButton>
          ) : crumb.session.sessionId === sessionId ? (
            <span aria-current="page" className="max-w-[220px] truncate px-1.5 font-medium text-[var(--text)]">
              {sessionTitle(crumb.session)}
            </span>
          ) : (
            <button type="button" className={CRUMB} onClick={() => open(crumb.session.sessionId)}>
              {sessionTitle(crumb.session)}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}
