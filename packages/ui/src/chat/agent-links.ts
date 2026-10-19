import type { SessionSummary } from "@atrium/protocol";
import { createContext, useContext } from "react";

/**
 * What the transcript can do with the conversations it names: open one, and read one as the list
 * has it (SPEC-0002, "显示").
 */
export interface AgentLinks {
  /** Opens a session: a child from a source line or a lane, the parent from a task. */
  readonly open: (sessionId: string) => void;
  /** A session as the list has it now; `undefined` for one it does not list. */
  readonly session: (sessionId: string) => SessionSummary | undefined;
  /** The conversation's own parent, for "主对话"; `null` for none. */
  readonly parentId: string | null;
}

/** The links of the conversation the transcript shows; none outside a session, where names are only words. */
export const AgentLinksContext = createContext<AgentLinks | null>(null);

/**
 * The links of the conversation the transcript shows.
 *
 * @remarks
 * See `AgentLinksContext`.
 *
 * @sideEffects none
 * @returns The links, or `null`.
 */
export function useAgentLinks(): AgentLinks | null {
  return useContext(AgentLinksContext);
}
