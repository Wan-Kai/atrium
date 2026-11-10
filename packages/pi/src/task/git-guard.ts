import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { type PathGuardApi, type WriteVerdict, realLocation } from "./path-guard";

/** The most scripts inside scripts (`sh -c`, `eval`, `$(…)`) the guard reads before it gives up and refuses. */
const MAX_DEPTH = 4;

/** Stands for `$PWD` / `$(pwd)` in a word, until the directory at that point is known. */
const PWD = "\u0001";

/** Stands for the home directory (`~`, `$HOME`) in a word. */
const HOME = "\u0002";

/** The shells whose `-c` script the guard reads too. */
const SHELLS: readonly string[] = ["sh", "bash", "zsh", "dash", "ksh"];

/** The git options before the subcommand that take their value as the next word. */
const VALUE_OPTIONS: readonly string[] = ["-c", "--namespace", "--super-prefix", "--config-env", "--attr-source"];

/** A `-c` setting, or a name among a `git config` command's words, that moves git's work tree (any case). */
const MOVES_TREE = /^core\.worktree=/iu;

/** The git options and variables that point git at other files than the working directory's. */
const GIT_PLACE = /^(?:GIT_DIR|GIT_WORK_TREE)=/u;

/**
 * What the model is told when a command is blocked.
 *
 * @remarks
 * One reason for every refusal, as the path guard has (SPEC-0006, "路径隔离"), so the model does not
 * learn which step caught it.
 *
 * @sideEffects none
 * @param cwd - The working directory.
 * @returns The reason.
 */
export function gitReason(cwd: string): string {
  return `git can only act on files inside ${cwd}: do not point it elsewhere with -C, --git-dir, --work-tree, GIT_DIR or GIT_WORK_TREE, do not change core.worktree, and do not run it from another directory.`;
}

/** One word of a command, with whether the shell would expand it into something the guard cannot know. */
interface Word {
  readonly text: string;
  readonly unknown: boolean;
  /**
   * Set on the one word of a marker statement: where a subshell opens or closes, or that the next command may
   * not run (it follows `&&`, `||`, `|` or `&`).
   */
  readonly marker?: "open" | "close" | "cond";
}

/** The words that begin a compound command or wrap another command; they are not the command itself. */
const KEYWORDS: readonly string[] = [
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "while",
  "until",
  "do",
  "done",
  "for",
  "case",
  "esac",
  "select",
  "{",
  "}",
  "!",
  "time",
  "function",
  "builtin",
  "command",
  "exec",
  "nohup",
  "env",
  "sudo",
  "nice",
];

/** The keywords after which a command runs only under a condition or a loop, so a `cd` there may not happen. */
const COMPOUND: readonly string[] = [
  "if",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "do",
  "for",
  "case",
  "select",
  "{",
];

/**
 * Splits a shell command into simple commands made of words.
 *
 * @remarks
 * Not a full shell: it reads quotes, backslashes, comments, `;`, `&`, `|`, parentheses and
 * newlines as the shell does, resolves `~` (at the start of a word, or after `NAME=`), `$HOME`, `$PWD`, `$(pwd)` and backquoted `pwd` to
 * placeholders, and marks any other expansion (`$VAR`, `$(…)`, `` `…` ``) as unknown. The commands
 * inside `$(…)` and backquotes are read too, as simple commands of their own, ahead of the one
 * that holds them.
 *
 * @sideEffects none
 * @param command - The command text.
 * @returns The simple commands, in order.
 */
export function splitCommand(command: string): Word[][] {
  return parse(command).filter((words) => words[0]?.marker === undefined);
}

/**
 * A marker statement: not a command, but where scopes and conditions begin and end.
 *
 * @remarks
 * `parse` puts one between the commands where a subshell opens or closes or a command may not run.
 *
 * @sideEffects none
 * @param marker - Which marker.
 * @returns The statement.
 */
function marked(marker: "open" | "close" | "cond"): Word[] {
  return [{ text: "", unknown: false, marker }];
}

/**
 * Reads a shell command into its simple commands and the markers between them.
 *
 * @remarks
 * What `splitCommand` does, with a marker statement where a `(` or `)` opens or closes a scope (a `$(…)` or a
 * backquoted command is one too) and one after each `&&`, `||`, `|` and `&`, which the walk over the commands
 * needs to follow `cd` as the shell would (or, where it cannot tell, as it might).
 *
 * @sideEffects none
 * @param command - The command text.
 * @returns The statements, in order.
 */
function parse(command: string): Word[][] {
  const statements: Word[][] = [];
  let words: Word[] = [];
  let text = "";
  let started = false;
  let unknown = false;
  let i = 0;
  /**
   * Ends the word in progress.
   *
   * @remarks
   * A quoted empty string is a word too, hence `started`.
   *
   * @sideEffects Appends to the statement in progress.
   */
  const endWord = (): void => {
    if (started) words.push({ text, unknown });
    text = "";
    started = false;
    unknown = false;
  };
  /**
   * Ends the simple command in progress.
   *
   * @remarks
   * Empty ones (`&&` is two separators) are dropped.
   *
   * @sideEffects Appends to the statements.
   */
  const endStatement = (): void => {
    endWord();
    if (words.length > 0) statements.push(words);
    words = [];
  };
  /**
   * Reads the command inside `$(` … `)` or backquotes, which the shell runs first.
   *
   * @remarks
   * Plain `pwd` is the current directory; anything else is another simple command and makes the
   * word unknown.
   *
   * @sideEffects Appends to the statements the inner command splits into.
   * @param inner - The text between the delimiters.
   */
  const substitute = (inner: string): void => {
    started = true;
    if (inner.trim() === "pwd") {
      text += PWD;
      return;
    }
    unknown = true;
    statements.push(marked("open"), ...parse(inner), marked("close"));
  };
  /**
   * Reads a `$` expansion that begins at `i`.
   *
   * @remarks
   * `$(…)`, `${NAME}` and `$NAME`; a lone `$` is itself.
   *
   * @sideEffects Moves `i`; appends to the word in progress.
   */
  const dollar = (): void => {
    const next = command[i + 1];
    if (next === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < command.length; j++) {
        if (command[j] === "(") depth++;
        else if (command[j] === ")" && --depth === 0) break;
      }
      substitute(command.slice(i + 2, j));
      i = j + 1;
      return;
    }
    if (next === "{") {
      // `${NAME}` is a plain variable; `${NAME:-/x}`, `${#NAME}` and the rest compute something.
      const close = command.indexOf("}", i + 2);
      const inner = command.slice(i + 2, close === -1 ? command.length : close);
      started = true;
      if (/^(?:PWD|HOME)$/u.test(inner)) text += inner === "PWD" ? PWD : HOME;
      else unknown = true;
      i = close === -1 ? command.length : close + 1;
      return;
    }
    const name = /^\$(\w+)/u.exec(command.slice(i));
    if (name === null) {
      started = true;
      // A lone `$` is itself; `$'…'` and `$"…"` (quoting that decodes escapes) and `$@`, `$?`, `$$` and the
      // like are not.
      if (next !== undefined && !" \t\n;|&()<>".includes(next)) unknown = true;
      else text += "$";
      i += 1;
      return;
    }
    const variable = name[1];
    started = true;
    if (variable === "PWD") text += PWD;
    else if (variable === "HOME") text += HOME;
    else unknown = true;
    i += name[0].length;
  };
  while (i < command.length) {
    const char = command.charAt(i);
    if (char === " " || char === "\t") {
      endWord();
      i += 1;
    } else if (char === "\n" || char === ";") {
      endStatement();
      i += 1;
    } else if (char === "&" || char === "|") {
      endStatement();
      statements.push(marked("cond"));
      i += 1;
    } else if (char === "(" || char === ")") {
      endStatement();
      statements.push(marked(char === "(" ? "open" : "close"));
      i += 1;
    } else if (char === "#" && !started) {
      while (i < command.length && command[i] !== "\n") i += 1;
    } else if (char === "\\") {
      if (command[i + 1] !== "\n") {
        started = true;
        text += command.charAt(i + 1);
      }
      i += 2;
    } else if (char === "'") {
      const end = command.indexOf("'", i + 1);
      started = true;
      text += command.slice(i + 1, end === -1 ? command.length : end);
      i = end === -1 ? command.length : end + 1;
    } else if (char === '"') {
      started = true;
      i += 1;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length) {
          const escaped = command.charAt(i + 1);
          text += '$`"\\'.includes(escaped) ? escaped : `\\${escaped}`;
          i += 2;
        } else if (command[i] === "$") dollar();
        else if (command[i] === "`") {
          const end = command.indexOf("`", i + 1);
          substitute(command.slice(i + 1, end === -1 ? command.length : end));
          i = end === -1 ? command.length : end + 1;
        } else {
          text += command.charAt(i);
          i += 1;
        }
      }
      i += 1;
    } else if (char === "`") {
      const end = command.indexOf("`", i + 1);
      substitute(command.slice(i + 1, end === -1 ? command.length : end));
      i = end === -1 ? command.length : end + 1;
    } else if (char === "$") {
      dollar();
    } else if (char === "~" && (!started || /^[A-Za-z_]\w*=$/u.test(text))) {
      const after = command[i + 1];
      started = true;
      if (after === undefined || after === "/" || " \t\n;&|()".includes(after)) text += HOME;
      else unknown = true;
      i += 1;
    } else {
      started = true;
      text += char;
      i += 1;
    }
  }
  endStatement();
  return statements;
}

/** What the guard knows while it reads: the real working directory and the home directory. */
interface Reading {
  /** `realpath` of the working directory; `null` when it cannot be worked out, so everything is outside. */
  readonly root: string | null;
  readonly home: string;
}

/**
 * Whether a directory lies inside the working directory, links followed.
 *
 * @remarks
 * Same test as the path guard's `edit` and `write`, through `realLocation`; one that cannot be
 * worked out counts as outside.
 *
 * @sideEffects Reads the file system.
 * @param path - An absolute path.
 * @param reading - What the guard knows.
 * @returns Whether it is inside.
 */
function inside(path: string, reading: Reading): boolean {
  const real = realLocation(path);
  if (real === null || reading.root === null) return false;
  const below = relative(reading.root, real);
  return below !== ".." && !below.startsWith(`..${sep}`) && !isAbsolute(below);
}

/**
 * The absolute path a word names, from the directory the shell is in.
 *
 * @remarks
 * `null` when it depends on something the guard cannot know: an expansion, or `$PWD` after a `cd`
 * it could not follow.
 *
 * @sideEffects none
 * @param word - The word.
 * @param dir - The directory the shell is in, or `null` when unknown.
 * @param reading - What the guard knows.
 * @returns The path, or `null`.
 */
function placed(word: Word, dir: string | null, reading: Reading): string | null {
  if (word.unknown || (dir === null && word.text.includes(PWD))) return null;
  const text = word.text.replaceAll(PWD, dir ?? "").replaceAll(HOME, reading.home);
  if (isAbsolute(text)) return resolve(text);
  return dir === null ? null : resolve(dir, text);
}

/**
 * The directory after a `cd`, `pushd` or `popd`.
 *
 * @remarks
 * Options are skipped; no operand is home; `-`, `popd` and anything unknown leave the directory
 * unknown (`null`), where any `git` that follows is refused.
 *
 * @sideEffects none
 * @param words - The simple command, starting at the builtin.
 * @param dir - The directory before.
 * @param reading - What the guard knows.
 * @returns The directory after.
 */
function changed(words: readonly Word[], dir: string | null, reading: Reading): string | null {
  if (words[0]?.text === "popd") return null;
  const operand = words.slice(1).find((word) => word.unknown || !word.text.startsWith("-") || word.text === "-");
  if (operand === undefined) return reading.home;
  if (operand.text === "-" && !operand.unknown) return null;
  return placed(operand, dir, reading);
}

/**
 * Whether a simple command starts a shell that reads its script from input.
 *
 * @remarks
 * `bash <<< '…'` and `echo '…' | sh` hand the shell a script the guard does not read. A shell with a script
 * file or `-c` text is the other cases (the file is not seen, as documented; the text is read). A shell with
 * neither, or with `-s`, reads its input: refused, since the guard cannot tell what it holds.
 *
 * @sideEffects none
 * @param words - The simple command.
 * @returns Whether it is such a shell.
 */
function stdinShell(words: readonly Word[]): boolean {
  const first = commandStart(words);
  const name = words[first]?.text;
  if (name === undefined || !SHELLS.includes(basename(name))) return false;
  const rest = words.slice(first + 1);
  if (scriptOf(rest, false) !== null) return false;
  // A redirection (`<<<`, `<`, `>`, `2>`) and its target are no script file.
  const operands = rest.filter(
    (word, at) =>
      !word.text.startsWith("-") &&
      !/^\d*[<>]/u.test(word.text) &&
      !/^\d*(?:<{1,3}|>{1,2}|>&|<&)$/u.test(rest[at - 1]?.text ?? ""),
  );
  return operands.length === 0 || rest.some((word) => /^-[A-Za-z]*s[A-Za-z]*$/u.test(word.text));
}

/**
 * Reads one simple command and says whether it points git outside.
 *
 * @remarks
 * Three things count (SPEC-0006, "路径隔离", bash): `GIT_DIR=` and `GIT_WORK_TREE=` anywhere in the
 * command (including after `export` and `env`); git's global options `-C <path>`, `--git-dir` and
 * `--work-tree` before its subcommand, each in both the `=` and the space form, `-C` stepping from
 * the one before; and git itself while the shell is in a directory outside, since it then acts
 * there. A path that depends on an expansion cannot be judged and is refused. `sh -c` scripts and
 * `eval` text are read as commands. `-C` after the subcommand (`git commit -C HEAD`) is the
 * subcommand's own option and is left alone.
 *
 * @sideEffects Reads the file system.
 * @param words - The simple command.
 * @param dir - The directory the shell is in, or `null` when unknown.
 * @param reading - What the guard knows.
 * @param depth - How deep in scripts the reading is.
 * @returns Whether it points outside.
 */
function pointsOutside(words: readonly Word[], dir: string | null, reading: Reading, depth: number): boolean {
  for (const [index, word] of words.entries()) {
    if (GIT_PLACE.test(word.text)) {
      if (escapes({ text: word.text.slice(word.text.indexOf("=") + 1), unknown: word.unknown }, dir, reading)) {
        return true;
      }
      continue;
    }
    // `GIT_CONFIG_KEY_0=core.worktree` and `GIT_CONFIG_PARAMETERS=…` are `-c` by environment.
    if (
      /^GIT_CONFIG_(?:KEY_\d+|PARAMETERS)=/u.test(word.text) &&
      (word.unknown || /core\.worktree/iu.test(word.text))
    ) {
      return true;
    }
    if (word.unknown) continue;
    const name = basename(word.text);
    if (SHELLS.includes(name) || word.text === "eval") {
      const script = scriptOf(words.slice(index + 1), word.text === "eval");
      if (script === null) continue;
      if (depth >= MAX_DEPTH || script.unknown) return true;
      const text = script.text.replaceAll(PWD, dir ?? "").replaceAll(HOME, reading.home);
      if (scan(text, dir, reading, depth + 1)) return true;
    } else if (name === "git" && gitPointsOutside(words.slice(index + 1), dir, reading)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether one `git` command acts outside, by where the shell is and git's global options.
 *
 * @remarks
 * Reads the options before the subcommand: `-C <path>` (each from the one before), `--git-dir` and
 * `--work-tree` in both forms; the options that take a value are stepped over so that, say, the
 * value of `-c` is not taken for the subcommand. A word it cannot know there is refused, since it
 * could be any of them.
 *
 * @sideEffects Reads the file system.
 * @param rest - The words after `git`.
 * @param dir - The directory the shell is in, or `null` when unknown.
 * @param reading - What the guard knows.
 * @returns Whether it acts outside.
 */
function gitPointsOutside(rest: readonly Word[], dir: string | null, reading: Reading): boolean {
  if (dir === null || !inside(dir, reading)) return true;
  let at: string | null = dir;
  let sub = rest.length;
  for (let j = 0; j < rest.length; j++) {
    const option = rest[j];
    if (option === undefined || !option.text.startsWith("-")) {
      if (option?.unknown === true) return true;
      sub = j;
      break;
    }
    if (option.unknown) return true;
    const [flag = "", glued] = option.text.startsWith("--") ? option.text.split(/=(.*)/su) : [option.text];
    if (flag === "-C" || flag === "--git-dir" || flag === "--work-tree") {
      const value: Word | undefined = glued === undefined ? rest[++j] : { text: glued, unknown: false };
      if (value === undefined) break;
      if (escapes(value, at, reading)) return true;
      if (flag === "-C") at = placed(value, at, reading);
    } else if (flag === "-c" || flag === "--config-env") {
      // `-c core.worktree=/x` moves git's tree; so does `--config-env=core.worktree=NAME`.
      const value: Word | undefined = glued === undefined ? rest[++j] : { text: glued, unknown: false };
      if (value === undefined) break;
      if (value.unknown || MOVES_TREE.test(value.text)) return true;
    } else if (glued === undefined && VALUE_OPTIONS.includes(flag)) {
      j += 1;
    }
  }
  return rest[sub]?.text === "config" && configMovesTree(rest.slice(sub + 1), at, reading);
}

/**
 * Whether a `git config` command could move git's tree or write a file outside.
 *
 * @remarks
 * `core.worktree` and `extensions.worktreeConfig` (which lets a worktree's own configuration set it) are
 * refused wherever they appear among the words, read or written, since the guard does not tell the two apart
 * by their options; `--file` / `-f` must name a file inside the working directory, and `--blob` and
 * `--global` and `--system` are refused (they write beyond the repository).
 *
 * @sideEffects Reads the file system.
 * @param words - The words after `config`.
 * @param dir - The directory the command runs in.
 * @param reading - What the guard knows.
 * @returns Whether to refuse.
 */
function configMovesTree(words: readonly Word[], dir: string | null, reading: Reading): boolean {
  for (const [j, word] of words.entries()) {
    if (word.unknown || MOVES_TREE.test(`${word.text}=`) || /^extensions\.worktreeconfig$/iu.test(word.text))
      return true;
    if (word.text === "--global" || word.text === "--system" || word.text.startsWith("--blob")) return true;
    if (word.text === "--file" || word.text === "-f" || word.text.startsWith("--file=")) {
      const value = word.text.startsWith("--file=")
        ? { text: word.text.slice("--file=".length), unknown: false }
        : words[j + 1];
      if (value === undefined || escapes(value, dir, reading)) return true;
    }
  }
  return false;
}

/**
 * Whether a path word leads outside the working directory, or cannot be told.
 *
 * @remarks
 * See `placed` and `inside`.
 *
 * @sideEffects Reads the file system.
 * @param word - The word.
 * @param from - The directory a relative path is taken from, or `null` when unknown.
 * @param reading - What the guard knows.
 * @returns Whether it leads outside.
 */
function escapes(word: Word, from: string | null, reading: Reading): boolean {
  const path = placed(word, from, reading);
  return path === null || !inside(path, reading);
}

/**
 * The script a shell or `eval` runs, from the words after it.
 *
 * @remarks
 * A shell's script is the word after its `-c` option (alone or among others, as in `-lc`); `eval`
 * runs its words joined. `null` when there is none.
 *
 * @sideEffects none
 * @param rest - The words after the shell's or `eval`'s name.
 * @param isEval - Whether this is `eval`.
 * @returns The script and whether it holds an expansion the guard cannot know, or `null`.
 */
function scriptOf(rest: readonly Word[], isEval: boolean): Word | null {
  if (isEval) {
    return rest.length === 0
      ? null
      : { text: rest.map((word) => word.text).join(" "), unknown: rest.some((word) => word.unknown) };
  }
  const at = rest.findIndex((word) => /^-[A-Za-z]*c[A-Za-z]*$/u.test(word.text));
  return at === -1 ? null : (rest[at + 1] ?? null);
}

/** Where the shell may be, as far as the guard can tell; `null` is somewhere it cannot work out. */
type Places = readonly (string | null)[];

/**
 * Joins two sets of places the shell may be in.
 *
 * @remarks
 * A `cd` that may not happen leaves the shell in the old place or the new, so git must be safe in both.
 *
 * @sideEffects none
 * @param a - One set.
 * @param b - The other.
 * @returns Both, without repeats.
 */
function joined(a: Places, b: Places): Places {
  return [...new Set([...a, ...b])];
}

/**
 * Where the command proper begins in a simple command's words: past assignments, keywords and wrappers.
 *
 * @remarks
 * `if`, `then`, `{`, `builtin`, `command`, `env` and the like come before the command that runs; so do
 * `NAME=value` and, after a wrapper, its options.
 *
 * @sideEffects none
 * @param words - The simple command.
 * @returns The index of the command's own word, or the length when there is none.
 */
function commandStart(words: readonly Word[]): number {
  let at = 0;
  let wrapped = false;
  for (; at < words.length; at++) {
    const text = words[at]?.text ?? "";
    if (KEYWORDS.includes(text)) wrapped = true;
    else if (/^\w+=/u.test(text) || (wrapped && text.startsWith("-"))) continue;
    else break;
  }
  return at;
}

/**
 * Reads a command, simple command by simple command, and says whether it points git outside.
 *
 * @remarks
 * Follows `cd`, `pushd` and `popd` through the command, keeping every directory the shell may be in. A `cd`
 * that may not happen (after `&&`, `||`, `|` or `&`, or anywhere in an `if`, loop, `case` or `{ }`) adds to
 * those places instead of replacing them; a `cd` in a subshell (`( )`, `$( )`, backquotes) is forgotten when
 * it closes. `builtin cd`, `command cd` and `if cd …` are `cd`. Git is refused if it could run in any place
 * outside. When the guard cannot be sure it blocks.
 *
 * @sideEffects Reads the file system.
 * @param command - The command text.
 * @param start - The directory the shell starts in.
 * @param reading - What the guard knows.
 * @param depth - How deep in scripts the reading is.
 * @returns Whether it points outside.
 */
function scan(command: string, start: string | null, reading: Reading, depth: number): boolean {
  let places: Places = [start];
  const saved: Places[] = [];
  let conditional = false;
  let compound = false;
  for (const words of parse(command)) {
    const marker = words[0]?.marker;
    if (marker === "open") saved.push(places);
    else if (marker === "close") places = saved.pop() ?? places;
    else if (marker === "cond") conditional = true;
    else {
      if (words.some((word) => COMPOUND.includes(word.text))) compound = true;
      for (const dir of places) if (pointsOutside(words, dir, reading, depth)) return true;
      if (stdinShell(words)) return true;
      const first = commandStart(words);
      const builtin = words[first]?.text;
      if (builtin === "cd" || builtin === "pushd" || builtin === "popd") {
        const moved = places.map((dir) => changed(words.slice(first), dir, reading));
        places = conditional || compound ? joined(places, moved) : joined([], moved);
      }
      conditional = false;
    }
  }
  return false;
}

/**
 * Whether a `bash` command may run: it must not point git outside the working directory.
 *
 * @remarks
 * SPEC-0006, "路径隔离": `git -C`, `--git-dir`, `--work-tree`, `GIT_DIR=` and `GIT_WORK_TREE=` that
 * lead outside the working directory (or the shell `cd`ed there before running git) are refused,
 * since the same repository's other worktrees, or any repository, could then be committed to. It
 * reads the text of the command only; it is not a sandbox: git started from a script file, a
 * variable built from pieces, an alias, `env -C` or `xargs` is not seen (security.md).
 *
 * @sideEffects Reads the file system.
 * @param command - The command text.
 * @param cwd - The working directory.
 * @param home - The home directory `~` stands for; defaults to the process's.
 * @returns The verdict.
 */
export function checkGit(command: string, cwd: string, home: string = homedir()): WriteVerdict {
  const reading: Reading = { root: realLocation(resolve(cwd)), home };
  return scan(command, resolve(cwd), reading, 0) ? { allowed: false, reason: gitReason(cwd) } : { allowed: true };
}

/**
 * Registers the `tool_call` hook that keeps `bash` from pointing git outside the working directory.
 *
 * @remarks
 * Same switch as the path guard's (`isolated`, asked at every call because pi hands the extension
 * its flags only after loading); off, everything goes through.
 *
 * @sideEffects Registers a `tool_call` hook with pi.
 * @param pi - pi's extension API.
 * @param isOn - Whether this session is isolated.
 */
export function guardGit(pi: PathGuardApi, isOn: () => boolean): void {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "bash" || !isOn()) return undefined;
    const command: unknown =
      typeof event.input === "object" && event.input !== null ? Reflect.get(event.input, "command") : undefined;
    if (typeof command !== "string") return undefined;
    const verdict = checkGit(command, ctx.cwd);
    return verdict.allowed ? undefined : { block: true, reason: verdict.reason };
  });
}
