import { SLASH_COMMAND_LIMITS, type SlashCommand } from "@atrium/protocol";
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
 * out with its command, which could not be run by a cut name.
 *
 * @sideEffects none
 * @param command - The command as pi lists it.
 * @returns The command, or `null` for one whose name is too long.
 */
export function toSlashCommand(command: PiSlashCommand): SlashCommand | null {
  if (command.name.length > SLASH_COMMAND_LIMITS.name) return null;
  const description = (command.description ?? "").slice(0, SLASH_COMMAND_LIMITS.description);
  return { name: command.name, description: description === "" ? null : description, source: command.source };
}
