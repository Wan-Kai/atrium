/**
 * One word of a shell command, in single quotes.
 *
 * @remarks
 * A quote in it is closed, escaped and opened again, so the shell takes the word as it is.
 *
 * @sideEffects none
 * @param word - The word.
 * @returns It, quoted.
 */
function quoted(word: string): string {
  return `'${word.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * The command that goes on with a session in a terminal.
 *
 * @remarks
 * SPEC-0001 ("交给终端"): the file quoted, so the shell takes the path as it is; a child the agent
 * opened adds its tool limits, which are only advice there (SPEC-0002, "交接").
 *
 * @sideEffects none
 * @param file - The session's file.
 * @param args - The flags the host gave with it.
 * @returns The command.
 */
export function terminalCommand(file: string, args: readonly string[] = []): string {
  return ["pi --session", quoted(file), ...args.map((arg) => (/^[\w,./=:-]+$/u.test(arg) ? arg : quoted(arg)))].join(
    " ",
  );
}
