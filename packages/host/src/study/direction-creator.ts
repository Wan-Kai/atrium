import { CommandError } from "@atrium/protocol";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "../platform/clock";
import type { GitRunner } from "../platform/git";
import type { Logger } from "../platform/logger";
import { cleanDirectionName, type DirectionNames } from "./direction-namer";
import { ARCHIVE, type FoundDirection, MARKER, directionIdOf, realDir } from "./directions";

/**
 * The method's rules every session of a direction reads, for the model (SPEC-0008, "方向目录").
 *
 * @remarks
 * English, as the model reads it; the user may edit it, the agent does not (its prompt says so),
 * and the learner's profile lives in `.atrium-study.json` (SPEC-0008, "真实模型检查后改"). pi reads `AGENTS.md` from the working directory up without trusting it (pi-internals).
 */
export const AGENTS_TEMPLATE = `# Learning direction

This directory is one learning direction in Atrium's study mode. Every session here is one task
in it: a discussion, a lesson, a quiz, a Feynman session, a cheat sheet, a project or an exam.

## How to teach here

- Teach one idea at a time. Stop after each and let the learner try it before going on.
- Make the learner do things: small exercises in \`lab/\`, predictions before you explain.
- Do not write the learner's code in \`lab/\` for them. Read it, point at what is wrong, give hints.
- In a quiz ask one question at a time, judge each answer at once, and explain what was missed.
- Pick the form that fits the content: prose, a table, a diagram, code, or an interactive visual
  when something moves or changes over time.
- At the start of every session read the progress in \`.atrium-study.json\`, the notes of the last
  lesson in \`notes/\` and the gaps not yet fixed, so the learner does not have to repeat themselves.
- Keep content in Markdown: \`resources.md\` for the chosen resources, \`cheatsheet.md\` with one
  section per level, \`notes/\` for each lesson. Progress lives only in \`.atrium-study.json\`;
  do not edit that file yourself.
- The learner's profile (goal, background, time per week, language or environment) is in
  \`.atrium-study.json\`.
`;

/** How many numbered names are tried for a directory name already used: `-2` up to it. */
const LAST_SUFFIX = 9;

/** How many random names are tried once the numbered ones are used. */
const RANDOM_TRIES = 3;

/** Makes a new direction's directory. */
export interface DirectionCreator {
  /** Makes the directory, its files and `lab/`, the marker last; returns the direction. */
  make(names: DirectionNames, text: string): Promise<FoundDirection>;
}

/**
 * The display name of a direction the model did not name: the message's first line, shortened.
 *
 * @remarks
 * SPEC-0008 ("ML1 定的细节"): the user's own words, tidied as a model's name is; `null` for a
 * message without text.
 *
 * @sideEffects none
 * @param text - The first message.
 * @returns The name, or `null`.
 */
export function fallbackName(text: string): string | null {
  // Stryker disable next-line StringLiteral: splitting always gives at least one part.
  return cleanDirectionName(text.trimStart().split(/\r?\n/u, 1)[0] ?? "");
}

/**
 * Whether a path holds nothing, not even a dangling link.
 *
 * @remarks
 * `lstat`, so a link counts as something there.
 *
 * @sideEffects Looks at the path.
 * @param path - The path.
 * @returns Whether it is free.
 */
async function free(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) === null;
}

/**
 * Creates the maker of new directions' directories.
 *
 * @remarks
 * SPEC-0008 ("新建方向", "ML1 定的细节"): a name is used only when neither the learning directory
 * nor its `Archive/` has it, and no id is refused for it (`Archive` is reserved); a used name gets
 * `-2` to `-9`, then a random `study-<hex>`. The directory is made on its own, not recursively, so
 * another making the same name at once moves on to the next. In it go `AGENTS.md`, `lab/` with
 * `git init`, and last the marker, so a directory left half made is no direction; nothing is
 * removed after a failure (security.md, "学习方向"). A learning directory that is a link is
 * refused (`learning_dir_unsafe`). git missing or failing leaves `lab/` a plain
 * directory and is logged. Failures are logged by category only, without paths or names.
 *
 * @sideEffects none until a call; then makes directories and files and runs git.
 * @param options - The learning directory, git, the clock, random hex digits and the logger.
 * @returns The creator.
 */
export function createDirectionCreator(options: {
  readonly root: string;
  readonly git: Promise<GitRunner | null>;
  readonly clock: Pick<Clock, "now">;
  /** Six random hex digits for a random directory name. */
  readonly random: () => string;
  readonly logger: Logger;
}): DirectionCreator {
  /**
   * The directory names to try, in order; the random ones are made only once reached.
   *
   * @remarks
   * See `createDirectionCreator`.
   *
   * @sideEffects Calls `random` as each random name is reached.
   * @param dir - The model's name, or `null`.
   * @yields Each name to try.
   */
  function* candidates(dir: string | null): Generator<string> {
    if (dir !== null) {
      for (let suffix = 1; suffix <= LAST_SUFFIX; suffix += 1) yield suffix === 1 ? dir : `${dir}-${String(suffix)}`;
    }
    for (let tries = 0; tries < RANDOM_TRIES; tries += 1) yield `study-${options.random()}`;
  }

  /**
   * Makes the first free directory of the candidates.
   *
   * @remarks
   * See `createDirectionCreator`.
   *
   * @sideEffects Makes the learning directory and one directory in it.
   * @param names - The candidates.
   * @returns The name made.
   * @throws {CommandError} `learning_dir_unsafe` when the learning directory is a link;
   * `direction_create_failed` when none could be made.
   */
  async function makeDir(names: Iterable<string>): Promise<string> {
    await mkdir(options.root, { recursive: true });
    // Through a link, the direction would be made outside the learning directory.
    if (!(await realDir(options.root))) throw new CommandError("learning_dir_unsafe");
    for (const name of names) {
      if (directionIdOf(name) === null || !(await free(join(options.root, ARCHIVE, name)))) continue;
      try {
        await mkdir(join(options.root, name));
        return name;
      } catch (error) {
        // Stryker disable next-line ConditionalExpression,BlockStatement,StringLiteral,EqualityOperator: another failure on every name ends in the same refusal.
        if (Reflect.get(Object(error), "code") !== "EEXIST") throw error;
      }
    }
    throw new CommandError("direction_create_failed");
  }

  /**
   * Makes `lab/` a git repository.
   *
   * @remarks
   * See `createDirectionCreator`.
   *
   * @sideEffects Runs git; may log.
   * @param directionId - The direction, for the log.
   * @param lab - The directory.
   */
  async function initLab(directionId: string, lab: string): Promise<void> {
    const git = await options.git;
    if (git === null) {
      options.logger.warn({ directionId, reason: "no_git" }, "direction lab not a repository");
      return;
    }
    const result = await git.run(["init", "--quiet"], { cwd: lab }).catch(() => null);
    if (result?.code !== 0) {
      options.logger.warn({ directionId, reason: "git_failed" }, "direction lab not a repository");
    }
  }

  return {
    async make(names, text) {
      let dirName: string;
      try {
        dirName = await makeDir(candidates(names.dir));
      } catch (error) {
        options.logger.warn({ reason: "dir" }, "direction not created");
        if (error instanceof CommandError) throw error;
        throw new CommandError("direction_create_failed");
      }
      // Stryker disable next-line StringLiteral: `directionIdOf` refused no candidate made.
      const id = directionIdOf(dirName) ?? "";
      const dir = join(options.root, dirName);
      const name = names.name ?? fallbackName(text) ?? dirName;
      const createdAt = options.clock.now();
      try {
        // Stryker disable next-line ObjectLiteral,StringLiteral: the directory was just made, so nothing is there to keep.
        await writeFile(join(dir, "AGENTS.md"), AGENTS_TEMPLATE, { flag: "wx" });
        const lab = join(dir, "lab");
        await mkdir(lab);
        await initLab(id, lab);
        const marker = { version: 1, name, createdAt: new Date(createdAt).toISOString() };
        // Not over a marker put there meanwhile.
        await writeFile(join(dir, MARKER), `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx" });
      } catch {
        options.logger.warn({ directionId: id, reason: "files" }, "direction not created");
        throw new CommandError("direction_create_failed");
      }
      return {
        id,
        dirName,
        dir,
        home: dir,
        archived: false,
        name,
        createdAt,
        broken: false,
        newer: false,
        discussing: true,
        progress: null,
      };
    },
  };
}
