import type { SessionSummary } from "@atrium/protocol";
import { CircleNotch, WarningCircle } from "@phosphor-icons/react";

/** The status a row shows; `null` for idle, which shows nothing. */
export type RowStatus = "error" | "running" | null;

/**
 * A session's status for its row.
 *
 * @remarks
 * Highest first, as domain-model §4 orders them: a failed session stays "出错" until its next run
 * starts, even while it runs again; M1.6 knows these two, waiting states come with M1.9.
 *
 * @sideEffects none
 * @param session - The session.
 * @returns Its status.
 */
export function sessionStatus(session: Pick<SessionSummary, "failed" | "running">): RowStatus {
  if (session.failed) return "error";
  return session.running ? "running" : null;
}

/**
 * The highest of several statuses, for a workspace or project row.
 *
 * @remarks
 * See `sessionStatus`.
 *
 * @sideEffects none
 * @param statuses - Its sessions' statuses.
 * @returns The highest.
 */
export function topStatus(statuses: readonly RowStatus[]): RowStatus {
  if (statuses.includes("error")) return "error";
  return statuses.includes("running") ? "running" : null;
}

/**
 * A session's or workspace's status icon; nothing when idle.
 *
 * @remarks
 * Running is a turning arc in the tint color, error an exclamation circle in the danger color
 * (design-language, "会话状态"). A plain line icon, colored, with no background; the label says
 * the state for screen readers and on hover.
 *
 * @sideEffects none
 * @param props - The status.
 * @returns The icon, or nothing.
 */
export function StatusIcon({ status }: { readonly status: RowStatus }) {
  if (status === null) return null;
  const label = status === "error" ? "出错" : "运行中";
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-flex size-4 shrink-0 items-center justify-center ${
        status === "error" ? "text-[var(--danger)]" : "text-[var(--tint)]"
      }`}
    >
      {status === "error" ? (
        <WarningCircle size={14} />
      ) : (
        <CircleNotch size={14} className="animate-spin [animation-duration:900ms] motion-reduce:animate-none" />
      )}
    </span>
  );
}
