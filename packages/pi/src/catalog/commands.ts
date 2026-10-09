import type { SlashCommand } from "@atrium/protocol";
import type { PiResponseData } from "../process/pi-process";

/** A command as pi's `get_commands` lists it. */
type PiSlashCommand = PiResponseData<"get_commands">["commands"][number];

/**
 * What `/` shows of a command.
 *
 * @remarks
 * Its name (skills as `skill:<name>`), its description and its kind (pi-internals.md §3); where it
 * came from on disk is pi's business. An empty description counts as none.
 *
 * @sideEffects none
 * @param command - The command as pi lists it.
 * @returns The command.
 */
export function toSlashCommand(command: PiSlashCommand): SlashCommand {
  const description = command.description ?? "";
  return { name: command.name, description: description === "" ? null : description, source: command.source };
}
