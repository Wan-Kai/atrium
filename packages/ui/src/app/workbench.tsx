import type { AtriumClient, IndexView } from "@atrium/client";
import type { Appearance, IndexFileName } from "@atrium/protocol";
import { X } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { dropDrafts } from "../state/drafts";
import { useStore } from "zustand";
import { ConversationArea, useDisplayModeShortcut } from "../chat/conversation-area";
import { applyAppearance } from "../design/appearance";
import { Sidebar } from "../sidebar/sidebar";
import { TabBar } from "../tabs/tab-bar";

/** What the user calls each index file in the reset notice. */
const FILE_NAMES: Readonly<Record<IndexFileName, string>> = {
  projects: "项目列表",
  sessions: "会话记录",
  layouts: "标签页",
  preferences: "偏好设置",
};

/**
 * The open session of the client's current container.
 *
 * @remarks
 * `null` when the client is nowhere or the container has no open tab.
 *
 * @sideEffects none
 * @param index - The list.
 * @returns The active session's id.
 */
function activeSession(index: IndexView): string | null {
  const container = index.layout.container;
  return container === null ? null : (index.layout.tabs[container]?.active ?? null);
}

/**
 * Creates a session where the client is, or a chat when it is in the chats or nowhere.
 *
 * @remarks
 * The host opens it as the active tab. Reads where the client is at the moment it is called.
 *
 * @sideEffects Sends `create_session` or `create_chat`.
 * @param client - The client.
 * @returns The new session's id.
 */
async function createHere(client: AtriumClient): Promise<string> {
  const where = client.index.getState().layout.container;
  const created = where === null || where === "chats" ? await client.createChat() : await client.createSession(where);
  return created.sessionId;
}

/**
 * Starts a command without waiting for it.
 *
 * @remarks
 * Its failure shows where it matters: an empty area explains on the next send.
 *
 * @sideEffects Runs the command.
 * @param command - The command.
 */
function fireAndForget(command: Promise<unknown>): void {
  // Fire and forget: see above.
  void command.catch(() => undefined);
}

/**
 * Handles the app's keyboard shortcuts.
 *
 * @remarks
 * SPEC-0001 ("标签栏", roadmap M1.5): ⌘N new chat, ⌘T new session where the client is, ⌘W close
 * the tab, ⌘1–9 go to a tab, ⌘⇧[ and ⌘⇧] the previous and next tab. Brackets are matched by
 * key position, since Shift changes the character. The keys read the list at the moment they
 * are pressed.
 *
 * @sideEffects Listens for keys on the window while mounted; sends commands.
 * @param client - The client.
 */
function useTabShortcuts(client: AtriumClient): void {
  useEffect(() => {
    /**
     * Acts on a ⌘ shortcut.
     *
     * @remarks
     * See `useTabShortcuts`.
     *
     * @sideEffects May send commands; stops the browser's own handling of the key.
     * @param event - The key event.
     */
    const onKey = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.ctrlKey || event.altKey) return;
      const index = client.index.getState();
      const container = index.layout.container;
      const tabs = container === null ? undefined : index.layout.tabs[container];
      const open = tabs?.open ?? [];
      const at = open.indexOf(tabs?.active ?? "");
      const key = event.key.toLowerCase();
      let target: string | undefined;
      if (!event.shiftKey && key === "n") fireAndForget(client.createChat());
      else if (!event.shiftKey && key === "t") fireAndForget(createHere(client));
      else if (!event.shiftKey && key === "w" && tabs?.active != null) fireAndForget(client.closeTab(tabs.active));
      else if (!event.shiftKey && /^[1-9]$/.test(event.key)) target = open[Number(event.key) - 1];
      else if (event.shiftKey && event.code === "BracketLeft") target = open[at - 1];
      else if (event.shiftKey && event.code === "BracketRight") target = open[at + 1];
      else return;
      if (target !== undefined) fireAndForget(client.openSession(target));
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [client]);
}

/**
 * Drops the drafts of sessions that went away.
 *
 * @remarks
 * An archived session's draft goes at once; a session gone from the list goes once it leaves
 * a list it was in, within one host run. A new host's first list may not hold every session yet,
 * so nothing is dropped for being missing from it (SPEC-0001, "模型与输入框").
 *
 * @sideEffects Removes drafts from the page's storage.
 * @param index - The list.
 */
function useDraftCleanup(index: IndexView): void {
  const seen = useRef<{ readonly generation: string; readonly sessions: ReadonlySet<string> } | null>(null);
  useEffect(() => {
    if (!index.ready) return;
    const live = new Set(index.sessions.filter((one) => !one.archived).map((one) => one.sessionId));
    const before = seen.current?.generation === index.generation ? seen.current.sessions : new Set<string>();
    const gone = [...before].filter((id) => !live.has(id));
    const archived = index.sessions.filter((one) => one.archived).map((one) => one.sessionId);
    dropDrafts([...gone, ...archived]);
    seen.current = { generation: index.generation, sessions: live };
  }, [index.ready, index.generation, index.sessions]);
}

/**
 * The main window once connected: sidebar, tab bar and conversation area.
 *
 * @remarks
 * SPEC-0001 ("界面"). Focusing the window asks the host to look at workspaces and sessions again
 * (domain-model, "已决定 12"). The appearance follows the user's choice, also in the window's
 * own parts through `setNativeAppearance`. Index files reset at the host's start are mentioned
 * once per host run, until dismissed. Starting a session when the client is nowhere starts a
 * chat.
 *
 * @sideEffects Subscribes to the client's list; listens for focus and keys; sets the page's
 * appearance; sends commands.
 * @param props - The client, the connection status line, how to choose a folder and how to set
 * the window's own appearance.
 * @returns The workbench.
 */
export function Workbench({
  client,
  status,
  pickDirectory,
  setNativeAppearance,
}: {
  readonly client: AtriumClient;
  readonly status: ReactNode;
  readonly pickDirectory: (() => Promise<string | null>) | undefined;
  readonly setNativeAppearance: ((appearance: Appearance) => void) | undefined;
}) {
  const index = useStore(client.index);
  const container = index.layout.container;
  const sessionId = activeSession(index);
  const appearance = index.preferences.appearance;
  const [dismissed, setDismissed] = useState<string | null>(null);
  useDisplayModeShortcut();
  useDraftCleanup(index);

  useEffect(() => {
    setNativeAppearance?.(appearance);
    return applyAppearance(document.documentElement, window.matchMedia("(prefers-color-scheme: dark)"), appearance);
  }, [appearance, setNativeAppearance]);

  useEffect(() => {
    /**
     * Tells the host the window has focus again.
     *
     * @remarks
     * See `Workbench`.
     *
     * @sideEffects Sends `window_focused`.
     */
    const onFocus = (): void => {
      // Fire and forget: nothing waits for the rescan; its results arrive with the list.
      void client.windowFocused().catch(() => undefined);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [client]);

  useTabShortcuts(client);

  const resets = index.resets.length > 0 && dismissed !== index.generation ? index.resets : [];
  return (
    <div className="flex h-full">
      <Sidebar client={client} onNewChat={() => fireAndForget(client.createChat())} pickDirectory={pickDirectory} />
      <main className="flex min-w-0 flex-1 flex-col bg-[var(--main)]">
        {container === null ? (
          <div className="h-12 shrink-0 [-webkit-app-region:drag]" />
        ) : (
          <TabBar client={client} containerId={container} onNew={() => fireAndForget(createHere(client))} />
        )}
        {resets.length > 0 ? (
          <div
            role="status"
            className="mx-auto mt-3 flex w-full max-w-[720px] items-center gap-2 px-6 text-[length:var(--fs-meta)] text-[var(--attn-text)]"
          >
            <span className="flex-1">
              {resets.map((name) => FILE_NAMES[name]).join("、")}的文件损坏了，已经重置；原文件留在 ~/.atrium 里
            </span>
            <button type="button" aria-label="知道了" onClick={() => setDismissed(index.generation)}>
              <X size={12} />
            </button>
          </div>
        ) : null}
        <ConversationArea
          client={client}
          containerId={container}
          sessionId={sessionId}
          create={() => createHere(client)}
        />
        <footer className="flex h-6 shrink-0 items-center justify-center text-[length:var(--fs-xs)]">{status}</footer>
      </main>
    </div>
  );
}
