import type { AgentNoticeEvent, AgentRole, AgentStatus, SessionSummary, Step } from "@atrium/protocol";
import { useEffect, useState } from "react";
import { Check, CircleNotch, Question, X } from "../design/icons";
import { useClock } from "../state/clock";
import { useAgentLinks } from "./agent-links";
import { EVENT_WORDS, ROLE_WORDS, tookWords } from "./agent-words";
import { ChangeStat, NoticeLine } from "./source-line";
import type { LaneRow } from "./turn-layout";

/**
 * Where a lane runs, in the row's rail coordinates.
 *
 * @remarks
 * Prototype A: 22.5, 33.5, …, 11px apart, the first 12px right of the main line at 10.5.
 *
 * @sideEffects none
 * @param lane - The lane, from 0.
 * @returns Its x.
 */
function laneX(lane: number): number {
  return 22.5 + lane * 11;
}

/**
 * How far a row's words start, past the main line and its lanes.
 *
 * @remarks
 * The rail's 30px without lanes; with them, past the last one (prototype A: 46px with two).
 *
 * @sideEffects none
 * @param width - How many lanes the turn has.
 * @returns The indent, in pixels.
 */
export function laneIndent(width: number): number {
  return width === 0 ? 30 : 24 + width * 11;
}

/** A row's place among the turn's lanes. */
export interface LanePlace {
  readonly row: LaneRow;
  readonly width: number;
}

/**
 * The lanes' part of a row: lines running past, a lane opening from the main line, one merging
 * back into it, or one touching it.
 *
 * @remarks
 * SPEC-0002 ("显示 · 过程轨道"; prototype A): a child's lane leaves the main line under the step
 * that started it and runs beside it; where its task ends, a hollow node on the lane curves back
 * into the main line; where it asks, an orange one does, and the lane goes on. A lane whose task
 * does not end in this turn is dashed: the child goes on after it.
 *
 * @sideEffects none
 * @param props - The row's place among the lanes, and whether a touch is a question.
 * @returns The marks, over the row's left part.
 */
export function LaneMarks({ place, asks }: { readonly place: LanePlace; readonly asks: boolean }) {
  const { row } = place;
  /**
   * A lane's dashes: none where its task ends in the turn.
   *
   * @remarks
   * A dashed lane goes on after the turn; a freed lane's next child is told apart from the one before.
   *
   * @sideEffects none
   * @param lane - The lane.
   * @returns The dash array, or `undefined`.
   */
  const dash = (lane: number): string | undefined => (row.goesOn.includes(lane) ? "2 3" : undefined);
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute top-0 left-0 h-full overflow-visible"
      style={{ width: laneIndent(place.width) }}
      data-testid="lanes"
    >
      {row.through.map((lane) => {
        const x = laneX(lane);
        if (lane === row.closes) {
          return (
            <g key={lane} data-lane={lane} data-mark="merge">
              <line x1={x} x2={x} y1={0} y2={11} stroke="var(--tint)" strokeOpacity={0.7} />
              <circle cx={x} cy={15} r={4} fill="var(--main)" stroke="var(--tint)" strokeWidth={1.5} />
              <path d={`M${x} 19 C${x} 27 10.5 24 10.5 30`} fill="none" stroke="var(--tint)" />
            </g>
          );
        }
        if (lane === row.touches) {
          const tone = asks ? "var(--attn)" : "var(--tint)";
          return (
            <g key={lane} data-lane={lane} data-mark="touch">
              <line
                x1={x}
                x2={x}
                y1={0}
                y2={11}
                stroke="var(--tint)"
                strokeOpacity={0.7}
                strokeDasharray={dash(lane)}
              />
              <circle cx={x} cy={15} r={4} fill="var(--main)" stroke={tone} strokeWidth={1.5} />
              <path d={`M${x} 19 C${x} 27 10.5 24 10.5 30`} fill="none" stroke={tone} />
              <line
                x1={x}
                x2={x}
                y1={19}
                y2="100%"
                stroke="var(--tint)"
                strokeOpacity={0.7}
                strokeDasharray={dash(lane)}
              />
            </g>
          );
        }
        return (
          <line
            key={lane}
            data-lane={lane}
            data-mark="through"
            x1={x}
            x2={x}
            y1={0}
            y2="100%"
            stroke="var(--tint)"
            strokeOpacity={0.7}
            strokeDasharray={dash(lane)}
          />
        );
      })}
      {row.opens === null ? null : (
        <g data-lane={row.opens} data-mark="open">
          <path
            d={`M10.5 21 C10.5 27 ${laneX(row.opens)} 24 ${laneX(row.opens)} 30`}
            fill="none"
            stroke="var(--tint)"
          />
          <line
            x1={laneX(row.opens)}
            x2={laneX(row.opens)}
            y1={30}
            y2="100%"
            stroke="var(--tint)"
            strokeOpacity={0.7}
            strokeDasharray={dash(row.opens)}
          />
        </g>
      )}
    </svg>
  );
}

/**
 * A child's role beside its name.
 *
 * @remarks
 * SPEC-0002 ("显示"): "可写" stands out as an orange tag; "只读" and "顾问" are quiet words.
 *
 * @sideEffects none
 * @param props - The role.
 * @returns The tag.
 */
export function RoleTag({ role }: { readonly role: AgentRole }) {
  return role === "work" ? (
    <span className="flex-none rounded-[4px] bg-[var(--attn-soft)] px-1.5 text-[length:var(--fs-xs)] leading-[18px] text-[var(--attn-text)]">
      {ROLE_WORDS[role]}
    </span>
  ) : (
    <span className="flex-none text-[length:var(--fs-xs)] text-[var(--text-dim)]">{ROLE_WORDS[role]}</span>
  );
}

/** What a child's status says at the end of the row that started it. */
const STATUS_WORDS: Readonly<Record<AgentStatus, string>> = {
  creating: "开始",
  running: "运行中",
  queued: "排队",
  waiting_for_you: "在等你",
  waiting_for_parent: "在问",
  idle: "完成",
  stopped: "已停下",
  failed: "出错",
  handed_off: "已在终端中继续",
  ended: "已结束",
};

/**
 * How long a child's task has gone on so far, as "用时 1 分 12 秒", ticking once a second.
 *
 * @remarks
 * SPEC-0002 ("显示 · 过程轨道"): the row that started a child says its live time while it is on
 * the task. It counts from when the host handed the task down, on the UI's clock; a host clock a
 * little ahead reads as no time rather than less than none.
 *
 * @sideEffects Ticks the clock once a second while mounted.
 * @param props - When the task was handed down.
 * @returns The time.
 */
function TaskElapsed({ since }: { readonly since: number }) {
  const clock = useClock();
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => clock.every(1000, () => setNow(clock.now())), [clock]);
  return <>{tookWords(Math.max(0, now - since))}</>;
}

/**
 * A child's status now, at the end of the row that started it, and how long its task took.
 *
 * @remarks
 * As its row in the child list shows it (SPEC-0002, "显示"): turning while it works, a question
 * mark while it asks, a tick once done; then "用时 3 分 12 秒" once the task ended in the turn.
 * While the task goes on, working or asking, the time counts live from `since`; the summary does
 * not say which task the child has open, so one started on another task later counts too.
 *
 * @sideEffects none
 * @param props - The status, if the list has the child; the task's time; when its open task was handed down.
 * @returns The status.
 */
function ChildStatus({
  status,
  took,
  since,
}: {
  readonly status: AgentStatus | null;
  readonly took: number | null;
  readonly since: number | null;
}) {
  const working = status === "creating" || status === "running" || status === "queued";
  const asking = status === "waiting_for_parent" || status === "waiting_for_you";
  const live = took === null && (working || asking) ? since : null;
  if (status === null && took === null) return null;
  return (
    <span
      className={`ml-auto flex flex-none items-center gap-1 pl-3 text-[length:var(--fs-sm)] tabular-nums ${
        asking ? "text-[var(--attn-text)]" : working ? "text-[var(--tint)]" : "text-[var(--text-dim)]"
      }`}
      data-testid="child-status"
    >
      {working ? (
        <CircleNotch size={12} className="animate-spin" />
      ) : asking ? (
        <Question size={12} />
      ) : status === "idle" ? (
        <Check size={12} />
      ) : status === "failed" ? (
        <X size={11} />
      ) : null}
      {status === null ? null : STATUS_WORDS[status]}
      {live === null ? null : (
        <span className="text-[var(--text-dim)]">
          · <TaskElapsed since={live} />
        </span>
      )}
      {took === null ? null : (
        <span className="text-[var(--text-dim)]">
          {status === null ? "" : "· "}
          {tookWords(took)}
        </span>
      )}
    </span>
  );
}

/**
 * When the task a row started was handed down, while the child still has it open.
 *
 * @remarks
 * The child's open task may be a later one `agent_send` gave it, whose time is not this row's.
 *
 * @sideEffects none
 * @param session - The child, as the list has it.
 * @param taskId - The task the row started it on.
 * @returns The time, or `null`.
 */
function liveSince(session: SessionSummary | undefined, taskId: string): number | null {
  const agent = session?.agent;
  return agent?.taskId === taskId ? agent.taskStartedAt : null;
}

/**
 * The words of the row that started a child: "开子对话 补测试 可写 · agent/tests", and its status.
 *
 * @remarks
 * SPEC-0002 ("显示 · 过程轨道"): the child's name as the list has it now, its role, its branch in
 * a worktree of its own; at the right its live status and time, from when the host handed its
 * open task down, and its task's time once it ended in the turn. The row opens the child.
 *
 * @sideEffects Opens the child when clicked.
 * @param props - The step, which started the child, and its task's time.
 * @returns The words.
 */
export function SpawnWords({
  step,
  took = null,
}: {
  readonly step: Extract<Step, { kind: "tool" }>;
  /** How long the child's task took, once it ended in this turn. */
  readonly took?: number | null;
}) {
  const links = useAgentLinks();
  const spawned = step.details?.tool === "agent" ? step.details.spawned : null;
  if (spawned === null) return null;
  const session = links?.session(spawned.sessionId);
  const name = session?.name ?? spawned.name;
  return (
    <button
      type="button"
      className="atrium-press-row -mx-1.5 flex min-h-[30px] w-[calc(100%+12px)] min-w-0 items-center gap-1.5 rounded-[var(--r)] px-1.5 text-left text-[length:var(--fs-meta)] hover:bg-[var(--hover)]"
      aria-label={`打开子对话「${name}」`}
      onClick={() => links?.open(spawned.sessionId)}
    >
      <span className="flex-none text-[var(--text-2)]">开子对话</span>
      <span className="min-w-0 truncate text-[var(--text-muted)]">{name}</span>
      <RoleTag role={spawned.role} />
      {spawned.branch === null ? null : (
        <span className="min-w-0 truncate text-[length:var(--fs-sm)] text-[var(--text-dim)]">· {spawned.branch}</span>
      )}
      <ChildStatus status={session?.agent?.status ?? null} took={took} since={liveSince(session, spawned.taskId)} />
    </button>
  );
}

/**
 * The words of a row a child's event makes: its lane merging back, its question, or a notice.
 *
 * @remarks
 * SPEC-0002 ("显示 · 过程轨道"): where a lane merges, "安全审查 完成 · 用时 3 分 12 秒" with "打开",
 * and what a `work` child changed, "+A −D";
 * where it is touched, "子对话「补测试」在问 · 用 vitest 还是 jest？" in the question's colour; an
 * event of a child started in another turn has no lane and shows as a notice does.
 *
 * @sideEffects Opens the child when "打开" is clicked.
 * @param props - The event, and whether it has a lane in this turn.
 * @returns The words.
 */
export function EventWords({ event, laned }: { readonly event: AgentNoticeEvent; readonly laned: boolean }) {
  const links = useAgentLinks();
  if (!laned) {
    return (
      <div className="flex min-h-[30px] items-center">
        <NoticeLine event={event} />
      </div>
    );
  }
  const asking = event.event === "question" || event.event === "needs_you";
  const detail =
    event.event === "question" && event.question !== null
      ? (event.question.split("\n")[0] ?? "")
      : event.elapsedMs !== null && !asking
        ? tookWords(event.elapsedMs)
        : "";
  return (
    <div
      className={`flex min-h-[30px] min-w-0 items-center gap-1.5 text-[length:var(--fs-meta)] ${
        asking ? "text-[var(--attn-text)]" : ""
      }`}
    >
      {asking ? (
        <span className="min-w-0 truncate">
          子对话「{event.title}」{EVENT_WORDS[event.event]}
          {detail === "" ? null : <span className="opacity-80"> · {detail}</span>}
        </span>
      ) : (
        <span className="min-w-0 truncate">
          <span className="text-[var(--text-2)]">{event.title}</span>{" "}
          <span className="text-[var(--text-muted)]">
            {EVENT_WORDS[event.event]}
            {detail === "" ? null : ` · ${detail}`}
          </span>
          {event.changes === null ? null : <ChangeStat changes={event.changes} />}
        </span>
      )}
      {links === null ? null : (
        <button
          type="button"
          className="atrium-press-sm flex-none pl-1 text-[length:var(--fs-sm)] text-[var(--tint)] hover:underline"
          aria-label={`打开子对话「${event.title}」`}
          onClick={() => links.open(event.sessionId)}
        >
          打开
        </button>
      )}
    </div>
  );
}
