import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sharedDir } from "./shared-executable";

/**
 * Whether a directory is there with as many entries as it should have.
 *
 * @remarks
 * Nothing but `sharedDirectory` writes in it, so a short count means the system purged some old
 * temporary files.
 *
 * @sideEffects Reads the directory.
 * @param path - The directory.
 * @param count - How many entries it should have.
 * @returns Whether it is complete.
 */
async function complete(path: string, count: number): Promise<boolean> {
  try {
    return (await readdir(path)).length === count;
  } catch {
    return false;
  }
}

/**
 * Renames a path, saying whether it could.
 *
 * @remarks
 * A directory cannot be renamed onto one that has entries.
 *
 * @sideEffects Renames.
 * @param from - The path now.
 * @param to - The new path.
 * @returns Whether it was renamed.
 */
async function moveInto(from: string, to: string): Promise<boolean> {
  try {
    await rename(from, to);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the path of a directory of empty files with these names, writing it the first time any
 * process asks. Only for reading.
 *
 * @remarks
 * Creating thousands of files is slow when other processes create files too: thirteen processes
 * each creating 5000 took about 6.5 s apiece, against 0.35 s alone (2026-10-23), past a test's
 * five. So, like `sharedExecutable`, there is one copy per content, kept in the same directory
 * across runs, named by a hash of the names and built aside, then renamed into place. A complete
 * copy is never removed, so a process reading it is not disturbed by another arriving at once;
 * one the system has partly purged is moved aside and built again.
 *
 * @sideEffects Creates the directory and its files when missing or incomplete.
 * @param name - Readable suffix for the directory name.
 * @param files - The file names.
 * @returns The absolute path of the directory.
 */
async function sharedDirectory(name: string, files: readonly string[]): Promise<string> {
  const path = join(sharedDir(), `${createHash("sha256").update(files.join("\0")).digest("hex").slice(0, 16)}-${name}`);
  if (await complete(path, files.length)) return path;
  // Unique per call: two callers in one process may build the same directory at the same time.
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await mkdir(temporary, { recursive: true });
  for (const file of files) await writeFile(join(temporary, file), "");
  if (await moveInto(temporary, path)) return path;
  // Another process put one there first, or a purged one is in the way.
  if (!(await complete(path, files.length))) {
    const stale = `${path}.${randomBytes(6).toString("hex")}.stale`;
    // Another process may have moved it aside already.
    if (await moveInto(path, stale)) await rm(stale, { recursive: true, force: true });
    if (await moveInto(temporary, path)) return path;
  }
  await rm(temporary, { recursive: true, force: true });
  if (!(await complete(path, files.length))) throw new Error(`could not build the shared directory ${name}`);
  return path;
}

/**
 * Returns the path of a shared directory of `count` empty files, named `f0000`, `f0001` and on.
 *
 * @remarks
 * For tests of listing a directory at the 5000-entry limit; see `sharedDirectory`. The names sort
 * in the order they count. Only for reading.
 *
 * @sideEffects Creates the directory and its files when missing or incomplete.
 * @param count - How many files.
 * @returns The absolute path of the directory.
 */
export function numberedFiles(count: number): Promise<string> {
  return sharedDirectory(
    `files-${count}`,
    Array.from({ length: count }, (_, index) => `f${String(index).padStart(4, "0")}`),
  );
}
