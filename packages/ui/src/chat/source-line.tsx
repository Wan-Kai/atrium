import type { AgentNoticeEvent, AgentSource } from "@atrium/protocol";
import { ArrowTurnBack, Question, Robot } from "../design/icons";
import { useAgentLinks } from "./agent-links";
import { EVENT_WORDS, tookWords } from "./agent-words";

/**
 * What a `work` child changed: "+A −D", as the changes capsule says it.
 *
 * @remarks
 * SPEC-0002 ("交付", "显示 · 过程轨道"); design-language: added in `--ok-text`, removed in `--danger`.
 *
 * @sideEffects none
 * @param props - The changes.
 * @returns The figures.
 */
export function ChangeStat({ changes }: { readonly changes: NonNullable<AgentNoticeEvent["changes"]> }) {
  return (
    <span className="tabular-nums" data-testid="change-stat">
      {" "}
      <span className="text-[var(--ok-text)]">+{changes.added}</span>{" "}
      <span className="text-[var(--danger)]">−{changes.removed}</span>
    </span>
  );
}

/** A link at a source line's right: "打开", "主对话". */
const LINK = "atrium-press-sm ml-auto flex-none pl-3 text-[length:var(--fs-sm)] text-[var(--tint)] hover:underline";

/**
 * One notice's line: where it came from and what happened, with "打开" at its right.
 *
 * @remarks
 * SPEC-0002 ("显示 · 由通知开头的轮", prototype 甲): no bubble, a small line, "来自子对话「安全审查」·
 * 完成 · 用时 3 分 12 秒"; a question is the parent agent's, in the question's colour, with its
 * first line; a `work` child's delivery with what it changed. "打开" opens the child, when the
 * transcript can.
 *
 * @sideEffects Opens the child when "打开" is clicked.
 * @param props - The event.
 * @returns The line.
 */
export function NoticeLine({ event }: { readonly event: AgentNoticeEvent }) {
  const links = useAgentLinks();
  const asking = event.event === "question" || event.event === "needs_you";
  const tail =
    event.event === "question" && event.question !== null
      ? event.question.split("\n")[0]
      : event.elapsedMs !== null && !asking
        ? tookWords(event.elapsedMs)
        : null;
  return (
    <div
      className={`flex min-w-0 items-center gap-1.5 text-[length:var(--fs-meta)] ${
        asking ? "text-[var(--attn-text)]" : "text-[var(--text-muted)]"
      }`}
      data-testid="source-line"
      data-event={event.event}
    >
      <span className="flex flex-none items-center">
        {asking ? <Question size={13} /> : <ArrowTurnBack size={13} />}
      </span>
      <span className="min-w-0 truncate">
        来自子对话「<b className="font-medium text-[var(--text-2)]">{event.title}</b>」· {EVENT_WORDS[event.event]}
        {tail === null || tail === undefined || tail === "" ? null : ` · ${tail}`}
        {event.changes === null ? null : <ChangeStat changes={event.changes} />}
      </span>
      {links === null ? null : (
        <button
          type="button"
          className={LINK}
          aria-label={`打开子对话「${event.title}」`}
          onClick={() => links.open(event.sessionId)}
        >
          打开
        </button>
      )}
    </div>
  );
}

/**
 * What opened a turn, or came in during one, when it was not you.
 *
 * @remarks
 * SPEC-0002 ("显示 · 由通知开头的轮"): notices one line each; a task as "来自主对话的 agent · 交代的
 * 事", "主对话" at its right, and below it the task whole as a quote. What Atrium wrapped it in for
 * the model is not shown.
 *
 * @sideEffects Opens a session when a link is clicked.
 * @param props - The source.
 * @returns The lines.
 */
export function SourceLines({ source }: { readonly source: AgentSource }) {
  const links = useAgentLinks();
  if (source.kind === "report") {
    return (
      <div className="flex flex-col gap-1" data-testid="source">
        {source.events.map((event) => (
          <NoticeLine key={`${event.sessionId}:${event.taskId}:${event.event}`} event={event} />
        ))}
      </div>
    );
  }
  const parentId = links?.parentId ?? null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="source">
      <div
        className="flex min-w-0 items-center gap-1.5 text-[length:var(--fs-meta)] text-[var(--text-muted)]"
        data-testid="source-line"
        data-event="task"
      >
        <span className="flex flex-none items-center">
          <Robot size={13} />
        </span>
        <span className="min-w-0 truncate">来自主对话的 agent · 交代的事</span>
        {links === null || parentId === null ? null : (
          <button type="button" className={LINK} onClick={() => links.open(parentId)}>
            主对话
          </button>
        )}
      </div>
      <div
        className="border-l-2 border-[var(--line)] pl-3 break-words whitespace-pre-wrap text-[var(--text-2)]"
        data-testid="task-text"
      >
        {source.text}
      </div>
    </div>
  );
}
