import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { agentDirectory } from "../env/agent-dir";

/**
 * Whether a path is an executable file.
 *
 * @remarks
 * Like a shell, a directory with the name does not count.
 *
 * @sideEffects Checks the file on disk.
 * @param path - The path.
 * @returns Whether it can run.
 */
async function runnable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
    // Stryker disable BlockStatement: an empty catch gives undefined, which counts as false too.
  } catch {
    return false;
  }
  // Stryker restore BlockStatement
}

/**
 * Finds the `fd` that `@` searches with, as pi's terminal finds it.
 *
 * @remarks
 * pi's order (`utils/tools-manager.ts`): the copy pi downloads into its agent directory's `bin`,
 * then `fd` and then `fdfind` (Debian's name) on PATH (SPEC-0001, "模型与输入框"). Only absolute
 * PATH entries count, as for pi itself (security.md, "子进程与文件"). Atrium never downloads it.
 *
 * @sideEffects Checks files on disk.
 * @param env - The environment pi runs with, PATH from the login shell.
 * @returns The executable's absolute path, or `null` when there is none.
 */
export async function findFd(env: Readonly<Record<string, string | undefined>>): Promise<string | null> {
  const own = join(agentDirectory(env), "bin", "fd");
  if (await runnable(own)) return own;
  // Stryker disable next-line StringLiteral: any text in place of a missing PATH is relative, and filtered out.
  const directories = (env["PATH"] ?? "").split(delimiter).filter((directory) => isAbsolute(directory));
  for (const name of ["fd", "fdfind"]) {
    for (const directory of directories) {
      const candidate = join(directory, name);
      if (await runnable(candidate)) return candidate;
    }
  }
  return null;
}
