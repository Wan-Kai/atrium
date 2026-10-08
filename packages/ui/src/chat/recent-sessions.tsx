import type { AtriumClient } from "@atrium/client";
import type { RecentSession } from "@atrium/protocol";
import { ChatCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useClock } from "../state/clock";
import { useConnectionState } from "../state/use-connection-state";

/** How many sessions the list shows. */
const SHOWN = 20;

/**
 * When a session last changed, in words.
 *
 * @remarks
 * "今天 14:31", "昨天 09:02", otherwise the date; the list is sorted, so this only orients.
 *
 * @sideEffects none
 * @param modifiedAt - Milliseconds since the epoch.
 * @param now - The time now.
 * @returns The time.
 */
export function formatWhen(modifiedAt: number, now: number): string {
  const when = new Date(modifiedAt);
  const time = when.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = 24 * 60 * 60 * 1000;
  if (modifiedAt >= today.getTime()) return `今天 ${time}`;
  if (modifiedAt >= today.getTime() - day) return `昨天 ${time}`;
  return `${when.getMonth() + 1}月${when.getDate()}日`;
}

/**
 * The sessions in pi's session directory, newest first, to open one.
 *
 * @remarks
 * M1.4's temporary entry to history (SPEC-0001, "打开历史会话"): shown while no session is open,
 * replaced by M1.5's sidebar and "历史". Read once the connection is up, and again after a
 * reconnect. A session without a question in it shows as such.
 *
 * @sideEffects Asks the host for the list whenever the connection becomes ready.
 * @param props - The client, and what to do with a chosen session.
 * @returns The list, or nothing while there is none.
 */
export function RecentSessions({
  client,
  onOpen,
}: {
  readonly client: AtriumClient;
  readonly onOpen: (sessionId: string) => void;
}) {
  const connection = useConnectionState(client);
  const clock = useClock();
  const [listed, setListed] = useState<{ readonly sessions: readonly RecentSession[]; readonly at: number }>({
    sessions: [],
    at: 0,
  });
  const ready = connection.status === "connected";
  useEffect(() => {
    if (!ready) return undefined;
    let current = true;
    /**
     * Reads the list and keeps it, unless the component moved on meanwhile.
     *
     * @remarks
     * A failed read leaves the list empty; the input box still starts a new chat.
     *
     * @sideEffects Asks the host; sets component state.
     */
    const read = async (): Promise<void> => {
      const result = await client.listRecentSessions(SHOWN).catch(() => null);
      if (current && result !== null) setListed({ sessions: result.sessions, at: clock.now() });
    };
    // Fire and forget: `read` handles its own failure.
    void read();
    return () => {
      current = false;
    };
  }, [client, ready, clock]);
  const { sessions, at: now } = listed;
  if (sessions.length === 0) return null;
  return (
    <section aria-label="最近的会话" className="mx-auto w-full max-w-[720px] px-6 py-8">
      <h2 className="mb-2 px-2 text-[length:var(--fs-sm)] text-[var(--text-dim)]">最近的会话</h2>
      <ul className="flex flex-col">
        {sessions.map((session) => (
          <li key={session.sessionId}>
            <button
              type="button"
              onClick={() => onOpen(session.sessionId)}
              className="flex h-9 w-full items-center gap-2.5 rounded-[var(--r)] px-2 text-left text-[length:var(--fs-meta)] text-[var(--text-2)] hover:bg-[var(--hover)]"
            >
              <ChatCircle size={15} className="flex-none text-[var(--text-muted)]" />
              <span className="min-w-0 flex-1 truncate">{session.firstPrompt ?? "（没有提问）"}</span>
              <span className="flex-none text-[length:var(--fs-sm)] text-[var(--text-dim)] tabular-nums">
                {formatWhen(session.modifiedAt, now)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
