import { Key, Question, WarningCircle } from "../design/icons";
import { RunningDots } from "../design/running-dots";
import type { RowStatus } from "./status";

/** Each status's label, icon and color (design-language, "会话状态"). */
const LOOKS = {
  asking: { label: "待回答", color: "text-[var(--attn)]", icon: <Question size={14} /> },
  auth: { label: "待授权", color: "text-[var(--attn)]", icon: <Key size={14} /> },
  error: { label: "出错", color: "text-[var(--danger)]", icon: <WarningCircle size={14} /> },
  running: {
    label: "运行中",
    color: "text-[var(--tint)]",
    icon: <RunningDots size={14} />,
  },
} as const;

/**
 * A session's or workspace's status icon; nothing when idle.
 *
 * @remarks
 * A question circle or a key in the attention color, an exclamation circle in the danger color,
 * the dot matrix with its turning arm in the tint color (design-language, "会话状态"). Colored, with
 * no background; the label says the state for screen readers and on hover.
 *
 * @sideEffects none
 * @param props - The status.
 * @returns The icon, or nothing.
 */
export function StatusIcon({ status }: { readonly status: RowStatus }) {
  if (status === null) return null;
  const { label, color, icon } = LOOKS[status];
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-flex size-4 shrink-0 items-center justify-center ${color}`}
    >
      {icon}
    </span>
  );
}
