import type { TaskNodeState } from "@atrium/protocol";
import type { ReactNode } from "react";
import { CheckCircle, Clock, Flowchart, Stop, WarningCircle } from "../design/icons";
import { RunningDots } from "../design/running-dots";
import { NODE_STATE_WORDS } from "./task-words";

/**
 * A node's state as an icon (设计稿第 5 屏 的图例).
 *
 * @remarks
 * Each state has its own shape, not only its own colour (design-language, "原则" 3): a hollow ring for a node that has
 * not begun, the dot matrix for one running, an orange ringed dot for one that waits for you, a green check for
 * a pass, a dashed ring for a node held back, a stop mark for one you stopped, a red exclamation for one that
 * failed. The label says the state for screen readers and on hover.
 *
 * @sideEffects none
 * @param props - The state, and the icon's size.
 * @returns The icon.
 */
export function NodeStateIcon({ state, size = 14 }: { readonly state: TaskNodeState; readonly size?: number }) {
  const label = NODE_STATE_WORDS[state];
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-state={state}
      className={`inline-flex shrink-0 items-center justify-center ${GLYPH_COLOR[state]}`}
      style={{ width: size, height: size }}
    >
      {glyphOf(state, size)}
    </span>
  );
}

/** The colour a state's glyph takes where it has no colours of its own. */
const GLYPH_COLOR: Readonly<Record<TaskNodeState, string>> = {
  pending: "",
  running: "text-[var(--tint)]",
  waiting: "",
  passed: "text-[var(--ok-text)]",
  held: "",
  stopped: "text-[var(--text-muted)]",
  failed: "text-[var(--danger)]",
};

/**
 * The drawing of a state's icon.
 *
 * @remarks
 * See `NodeStateIcon`: each state its own shape.
 *
 * @sideEffects none
 * @param state - The state.
 * @param size - The icon's size.
 * @returns The glyph.
 */
function glyphOf(state: TaskNodeState, size: number): ReactNode {
  const glyphs: Readonly<Record<TaskNodeState, ReactNode>> = {
    pending: <span className="size-[9px] rounded-full shadow-[inset_0_0_0_1.5px_var(--text-dim)]" />,
    running: <RunningDots size={size} />,
    waiting: (
      <span className="grid size-[12px] place-items-center rounded-full shadow-[inset_0_0_0_1.5px_var(--attn)]">
        <span className="size-[4px] rounded-full bg-[var(--attn)]" />
      </span>
    ),
    passed: <CheckCircle size={size} />,
    held: <span className="size-[11px] rounded-full border-[1.5px] border-dashed border-[var(--text-dim)]" />,
    stopped: <Stop size={size} />,
    failed: <WarningCircle size={size} />,
  };
  return glyphs[state];
}

/**
 * The icon in front of a task's name: what kind it is, not how it goes.
 *
 * @remarks
 * The graph icon for a task made in a conversation, the clock for one a schedule made (SPEC-0006, "界面 · 任务列表").
 *
 * @sideEffects none
 * @param props - Whether a schedule made the task, and the size.
 * @returns The icon.
 */
export function TaskKindIcon({ scheduled, size = 14 }: { readonly scheduled: boolean; readonly size?: number }) {
  return scheduled ? (
    <Clock size={size} aria-label="定时触发的任务" className="shrink-0 text-[var(--text-dim)]" />
  ) : (
    <Flowchart size={size} aria-hidden className="shrink-0 text-[var(--text-dim)]" />
  );
}
