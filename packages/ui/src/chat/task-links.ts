import { createContext } from "react";

/**
 * What a conversation needs to know about tasks to draw their lines (SPEC-0006, "界面").
 *
 * @remarks
 * The transcript is the same component for every conversation; the window that shows it says, through this,
 * which task a line is about and how to open it. The default knows no task, so a conversation shown anywhere else
 * writes ids where names are unknown.
 */
export interface TaskLinks {
  /** A task's name and how it stands, in words, by its id; `undefined` when it is not in the list (abandoned, or gone). */
  readonly task: (taskId: string) => { readonly name: string; readonly status: string } | undefined;
  /** Opens a task's tab in the task area. */
  readonly openTask: (taskId: string) => void;
  /** The name of a node of the task the conversation belongs to, by the node's id. */
  readonly nodeName: (node: string) => string | undefined;
}

/** The links a conversation has when nothing says otherwise: no names, nothing to open. */
export const TaskLinksContext = createContext<TaskLinks>({
  task: () => undefined,
  openTask: () => undefined,
  nodeName: () => undefined,
});
