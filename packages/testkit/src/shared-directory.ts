import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sharedDir } from "./shared-executable";

/** What the copies of a shared directory are, as listed now. */
interface Copies {
  /** The first complete copy, if any. */
  readonly complete: string | null;
  /** The first name no copy has. */
  readonly free: string;
}

/**
 * Looks through a shared directory's copies, `base`, `base-1`, `base-2` and on, to the first name
 * not there.
 *
 * @remarks
 * Nothing but `sharedDirectory` writes them, so a copy with too few entries is one the system has
 * partly purged; a name that cannot be listed for another reason counts as taken too.
 *
 * @sideEffects Reads the directories.
 * @param base - The first copy's path.
 * @param count - How many entries a complete copy has.
 * @returns The first complete copy and the first free name.
 */
async function copiesOf(base: string, count: number): Promise<Copies> {
  for (let generation = 0; ; generation += 1) {
    const path = generation === 0 ? base : `${base}-${generation}`;
    const listed = await readdir(path).then(
      (names) => names.length,
      (error: unknown) => (Reflect.get(Object(error), "code") === "ENOENT" ? null : -1),
    );
    if (listed === null) return { complete: null, free: path };
    if (listed === count) return { complete: path, free: path };
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
 * across runs, named by a hash of the names and built aside, then renamed into place.
 *
 * No copy is ever moved or removed, so a process reading one is never disturbed by another
 * arriving at once, and a process killed midway leaves nothing to undo; no lock is needed, which
 * a killed process could leave held. A copy the system has partly purged is left for the system to
 * finish, and a new one is published under the next free name. It is renamed only onto a name
 * that was not there when looked at: a copy only appears by such a rename, of a full directory,
 * which fails onto one already there; then the copies are looked at again, and one another
 * process published is taken instead of this one.
 *
 * @sideEffects Creates the directory and its files when no complete copy is there.
 * @param name - Readable suffix for the directory name.
 * @param files - The file names.
 * @returns The absolute path of a complete copy.
 * @throws {Error} When none could be published.
 */
async function sharedDirectory(name: string, files: readonly string[]): Promise<string> {
  const base = join(sharedDir(), `${createHash("sha256").update(files.join("\0")).digest("hex").slice(0, 16)}-${name}`);
  const found = await copiesOf(base, files.length);
  if (found.complete !== null) return found.complete;
  // Unique per call: two callers in one process may build the same directory at the same time.
  const temporary = `${base}.${randomBytes(6).toString("hex")}.tmp`;
  await mkdir(temporary, { recursive: true });
  for (const file of files) await writeFile(join(temporary, file), "");
  // Another process may publish meanwhile, or take the free name; a few rounds settle it.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const now = await copiesOf(base, files.length);
    if (now.complete !== null) {
      await rm(temporary, { recursive: true, force: true });
      return now.complete;
    }
    try {
      await rename(temporary, now.free);
      return now.free;
    } catch {
      // Taken since it was looked at.
    }
  }
  await rm(temporary, { recursive: true, force: true });
  throw new Error(`could not publish the shared directory ${name}`);
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
