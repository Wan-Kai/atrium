import { SLASH_COMMAND_LIMITS, type SlashCommand } from "@atrium/protocol";
import { AGENT_COMMAND } from "../agent/agent";
import { FAST_COMMAND } from "../fast/fast";
import { EDIT_COMMAND } from "../edit/edit";
import { isPlanQuery } from "../plan/plan";
import type { PiResponseData } from "../process/pi-process";

/** A command as pi's `get_commands` lists it. */
type PiSlashCommand = PiResponseData<"get_commands">["commands"][number];

/**
 * What `/` shows of a command.
 *
 * @remarks
 * Its name (skills as `skill:<name>`), its description and its kind (pi-internals.md §3); where it
 * came from on disk is pi's business. An empty description counts as none. A description too long
 * for the protocol is cut, so one extension cannot fail the whole list; a name too long is left
 * out with its command, which could not be run by a cut name. Atrium's own Fast switch and plan
 * query and child conversations' command are the host's, not yours, and are left out too
 * (SPEC-0001, "Fast"; ADR-0010; ADR-0013).
 *
 * @sideEffects none
 * @param command - The command as pi lists it.
 * @returns The command, or `null` for one left out.
 */
export function toSlashCommand(command: PiSlashCommand): SlashCommand | null {
  if (command.name.length > SLASH_COMMAND_LIMITS.name) return null;
  if (isFastSwitch(command) || isPlanQuery(command) || isAgentCommand(command) || isEditCommand(command)) return null;
  const description = (command.description ?? "").slice(0, SLASH_COMMAND_LIMITS.description);
  return { name: command.name, description: description === "" ? null : description, source: command.source };
}

/**
 * Whether a command is Atrium's Fast switch, which only its extension registers.
 *
 * @remarks
 * The host sends `/atrium-fast` only once pi lists it, or pi would pass the words to the model
 * (SPEC-0001, "Fast"); a prompt template or skill of that name is not it.
 *
 * @sideEffects none
 * @param command - The command as pi lists it.
 * @returns Whether it is.
 */
export function isFastSwitch(command: Pick<PiSlashCommand, "name" | "source">): boolean {
  return command.name === FAST_COMMAND && command.source === "extension";
}

/**
 * Whether a command is Atrium's command for child conversations, which only its extension registers.
 *
 * @remarks
 * The host sends `/atrium-agent` only once pi lists it, or pi would pass the words to the model
 * (ADR-0013, point 2); a prompt template or skill of that name is not it.
 *
 * @sideEffects none
 * @param command - The command as pi lists it.
 * @returns Whether it is.
 */
export function isAgentCommand(command: Pick<PiSlashCommand, "name" | "source">): boolean {
  return command.name === AGENT_COMMAND && command.source === "extension";
}

/**
 * Identifies the host's stopped-message editing command registered by its extension.
 * @remarks A template of this name cannot safely navigate the session tree.
 * @sideEffects none
 * @param command - A command from pi's catalog.
 * @returns Whether it is the editing extension command.
 */
export function isEditCommand(command: Pick<PiSlashCommand, "name" | "source">): boolean {
  return command.name === EDIT_COMMAND && command.source === "extension";
}
