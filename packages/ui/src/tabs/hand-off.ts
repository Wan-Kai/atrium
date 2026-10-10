/**
 * The command that goes on with a session in a terminal.
 *
 * @remarks
 * SPEC-0001 ("交给终端"): the file goes in single quotes, a quote in it closed, escaped and
 * opened again, so the shell takes the path as it is.
 *
 * @sideEffects none
 * @param file - The session's file.
 * @returns The command.
 */
export function terminalCommand(file: string): string {
  return `pi --session '${file.replaceAll("'", String.raw`'\''`)}'`;
}
