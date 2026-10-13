import { useEffect } from "react";
import { useStore } from "zustand";
import { useClock } from "../state/clock";
import { pageNotices } from "../state/session-notices";

/** How long a notice stays. */
const NOTICE_MS = 3000;

/**
 * The line beside the tab bar's "···" saying what a command did for the session shown.
 *
 * @remarks
 * SPEC-0001 ("M1.11 的 `/` 命令"): "已复制最后一条回复" after `/copy`, gone after 3 seconds. A
 * failure, such as a fork's, is in the danger colour and stays, as the "···" menu's do. Only the
 * session shown has its notice shown; a newer notice takes the place of an older one and restarts
 * the time.
 *
 * @sideEffects Subscribes to the page's notice; clears it after 3 seconds through the clock.
 * @param props - The session shown.
 * @returns The line, or nothing.
 */
export function SessionNoticeLine({ sessionId }: { readonly sessionId: string }) {
  const notices = pageNotices();
  const notice = useStore(notices);
  const clock = useClock();
  useEffect(() => {
    if (notice === null || notice.problem) return undefined;
    return clock.after(NOTICE_MS, () => {
      if (notices.getState() === notice) notices.setState(null, true);
    });
  }, [clock, notice, notices]);
  if (notice === null || notice.sessionId !== sessionId) return null;
  return (
    <span
      role="status"
      className={`text-[length:var(--fs-sm)] ${notice.problem ? "text-[var(--danger)]" : "text-[var(--text-muted)]"}`}
    >
      {notice.text}
    </span>
  );
}
