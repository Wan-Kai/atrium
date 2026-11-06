import type { AtriumClient, SessionView } from "@atrium/client";
import { loadingView } from "@atrium/client";
import type { TranscriptItem } from "@atrium/protocol";
import { useEffect, useMemo, useState } from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { Transcript } from "../chat/transcript";

/** The marker the host's first message to a task conversation starts with (SPEC-0006, "任务对话"). */
const DESIGN_MARK = "<atrium-task-design>";

/** What the host's long instruction for designing the task is shown as: it is the host's, not the user's words. */
const DESIGN_STAND_IN = "（设计任务的指示：整理需求摘要，选引导词，画初始图）";

/** The view of a conversation not watched yet. */
const NOT_WATCHED = createStore<SessionView>(() => loadingView(""));

/**
 * The items with the host's instruction for designing the task shortened to one line.
 *
 * @remarks
 * The first turn of a task conversation opens with the host's whole instruction, the four guides in full
 * (SPEC-0006, "附录：引导词"); shown as the user's message it would fill the first screen. The turn and what the agent
 * did in it stay.
 *
 * @sideEffects none
 * @param items - The conversation's items.
 * @returns The items.
 */
function withoutDesignPrompt(items: readonly TranscriptItem[]): readonly TranscriptItem[] {
  if (!items.some((item) => item.kind === "turn" && item.user.text.startsWith(DESIGN_MARK))) return items;
  return items.map((item) =>
    item.kind === "turn" && item.user.text.startsWith(DESIGN_MARK)
      ? { ...item, user: { ...item.user, text: DESIGN_STAND_IN } }
      : item,
  );
}

/**
 * The task conversation, shown for reading (SPEC-0006, "界面 · 任务标签"; T7).
 *
 * @remarks
 * Task conversations are left out of the list and the sidebar, so it is watched by its id through the same session
 * subscription any conversation uses, and not opened as a tab: opening would put it among the conversations' tabs.
 * It shows what the host sent: turns, and the progress lines as groups on the rail. There is no input box in
 * T7; talking to the task conversation arrives with T8. Until the host sends the first snapshot the pane says it is
 * reading; a conversation whose process is not running (a finished task) may never get one, which the pane says too.
 *
 * @sideEffects Watches the session while mounted (this replaces the sessions watched before, which is why the task
 * area and the conversations are never mounted together); loads older items and whole steps on request.
 * @param props - The client, and the task conversation's session id.
 * @returns The conversation.
 */
export function TaskConversation({ client, sessionId }: { readonly client: AtriumClient; readonly sessionId: string }) {
  const [store, setStore] = useState(() => client.session(sessionId));
  useEffect(() => {
    // Fire and forget: a lost connection subscribes again when it is back.
    client.watch([sessionId]).catch(() => undefined);
    // `watch` makes the view at once, and this has to render again to subscribe to it.
    // oxlint-disable-next-line react/set-state-in-effect -- the client is the external system here.
    setStore(client.session(sessionId));
  }, [client, sessionId]);
  const view = useStore(store ?? NOT_WATCHED);
  const shown = useMemo(() => ({ ...view, items: withoutDesignPrompt(view.items) }), [view]);
  return (
    <section aria-label="任务对话" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <h2 className="flex h-9 shrink-0 items-center px-4 text-[length:var(--fs-meta)] font-medium text-[var(--text-2)]">
        任务对话
      </h2>
      {view.status === "loading" ? (
        <p role="status" className="px-6 py-6 text-[length:var(--fs-meta)] text-[var(--text-dim)]">
          正在读取任务对话…
        </p>
      ) : (
        <Transcript
          view={shown}
          onLoadOlder={() => void client.loadOlder(sessionId).catch(() => undefined)}
          onLoadStep={(turnId, stepId) => void client.loadStep(sessionId, turnId, stepId).catch(() => undefined)}
        />
      )}
    </section>
  );
}
