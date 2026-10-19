import { type AgentNoticeEvent, AgentRole, type AgentSource, type ToolDetails } from "@atrium/protocol";
import { z } from "zod";
import { AgentEvent, type MessageDetails, type ReportDetail } from "./channel";

/** The protocol's limits on what a notice event carries (`AgentNoticeEvent`). */
const LIMITS = { id: 128, name: 64, title: 1024, reason: 64, question: 4000, branch: 256 } as const;

/**
 * One event as the transcript shows it.
 *
 * @remarks
 * SPEC-0002, "显示": who, which task, what, why, how long, a question's text, and a `work` child's
 * branch and changes (SPEC-0002, "交付"). What a file or a host wrote past the protocol's limits is
 * cut to them; an event without a session or with ids too long to be real is left out.
 *
 * @sideEffects none
 * @param event - The event, as a message or a tool's result keeps it.
 * @returns The event, or `null`.
 */
export function noticeEvent(event: ReportDetail): AgentNoticeEvent | null {
  if (event.sessionId === "" || event.sessionId.length > LIMITS.id || event.taskId.length > LIMITS.id) return null;
  return {
    sessionId: event.sessionId,
    name: event.name.slice(0, LIMITS.name),
    title: event.title.slice(0, LIMITS.title),
    taskId: event.taskId,
    event: event.event,
    reason: event.reason?.slice(0, LIMITS.reason) ?? null,
    elapsedMs: event.elapsedMs ?? null,
    question: event.question?.slice(0, LIMITS.question) ?? null,
    branch: event.branch?.slice(0, LIMITS.branch) ?? null,
    changes: changesOf(event.changes),
  };
}

/**
 * A work child's changes as the transcript shows them.
 *
 * @remarks
 * The protocol takes only counts of zero or more; others are not shown.
 *
 * @sideEffects none
 * @param changes - The changes the event carried.
 * @returns The changes, or `null`.
 */
function changesOf(changes: ReportDetail["changes"]): AgentNoticeEvent["changes"] {
  if (changes === undefined || changes.files < 0 || changes.added < 0 || changes.removed < 0) return null;
  return { files: changes.files, added: changes.added, removed: changes.removed };
}

/**
 * What a delivered message opens a turn with, or brings as a step.
 *
 * @remarks
 * SPEC-0002, "对话记录里的自定义消息": notices with their events, or a task with its text whole. A
 * notice none of whose events can be shown is nothing.
 *
 * @sideEffects none
 * @param details - The message's details.
 * @returns The source, or `null`.
 */
export function agentSource(details: MessageDetails): AgentSource | null {
  if (details.kind === "task") {
    return {
      kind: "task",
      fromTitle: details.fromTitle.slice(0, LIMITS.title),
      taskId: details.taskId.slice(0, LIMITS.id),
      text: details.text,
    };
  }
  const read = events(details.events);
  return read.length === 0 ? null : { kind: "report", events: read };
}

/** What a waited-for task came to, inside `agent_spawn`'s and `agent_send`'s results. */
const Waited = z.looseObject({ event: AgentEvent.optional() }).optional();

/** The part of `agent_spawn`'s result a lane needs. */
const Spawned = z.looseObject({
  name: z.string(),
  sessionId: z.string().min(1).max(LIMITS.id),
  taskId: z.string().max(LIMITS.id),
  role: AgentRole,
  branch: z.string().max(256).optional(),
  waited: Waited,
});

/** The part of `agent_send`'s result a merge needs. */
const Sent = z.looseObject({ waited: Waited });

/** The part of `agent_wait`'s result a merge needs. */
const Waits = z.looseObject({ events: z.array(AgentEvent) });

/**
 * The events a result carried, as the transcript shows them.
 *
 * @remarks
 * An event `noticeEvent` cannot read is left out.
 *
 * @sideEffects none
 * @param list - The events.
 * @returns The ones read.
 */
function events(list: readonly AgentEvent[]): AgentNoticeEvent[] {
  return list.flatMap((event) => noticeEvent(event) ?? []);
}

/**
 * What a main-agent tool's step shows: the child it started, and the events it brought back.
 *
 * @remarks
 * SPEC-0002, "显示 · 过程轨道": `agent_spawn` opens a lane; its own wait, `agent_send`'s and
 * `agent_wait`'s events merge lanes. A failed call's result has none of this, and nothing shows.
 *
 * @sideEffects none
 * @param tool - The tool.
 * @param details - Its result's details.
 * @returns The details, or `null`.
 */
export function agentToolDetails(tool: string, details: unknown): ToolDetails | null {
  if (tool === "agent_spawn") {
    const spawned = Spawned.safeParse(details);
    if (!spawned.success) return null;
    const { name, sessionId, taskId, role, branch, waited } = spawned.data;
    return {
      tool: "agent",
      spawned: { sessionId, name: name.slice(0, LIMITS.name), taskId, role, branch: branch ?? null },
      events: events(waited?.event === undefined ? [] : [waited.event]),
    };
  }
  if (tool === "agent_send") {
    const sent = Sent.safeParse(details);
    const event = sent.success ? sent.data.waited?.event : undefined;
    return sent.success ? { tool: "agent", spawned: null, events: events(event === undefined ? [] : [event]) } : null;
  }
  if (tool === "agent_wait") {
    const waited = Waits.safeParse(details);
    return waited.success ? { tool: "agent", spawned: null, events: events(waited.data.events) } : null;
  }
  return null;
}
