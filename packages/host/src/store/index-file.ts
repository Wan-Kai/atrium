import { randomBytes } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { z } from "zod";
import { errorCode } from "../platform/errors";

/** What a file of the index holds and how its older versions are upgraded. */
export interface IndexFileSpec<T extends object> {
  /** The file's name without `.json`, relative to the index directory, such as `projects` or `turns/<id>`. */
  readonly name: string;
  /** The current format version. */
  readonly version: number;
  /**
   * The document without its `version`.
   *
   * @remarks
   * Objects in it must be loose (`z.looseObject`), so fields a newer Atrium added survive a
   * rewrite by this one (domain-model §1, "索引的存储").
   */
  readonly schema: z.ZodType<T>;
  /** The document of a missing or reset file. */
  readonly empty: () => T;
  /** Upgrades a document of the version it is keyed by to the next one. */
  readonly migrations?: Readonly<Record<number, (document: Record<string, unknown>) => Record<string, unknown>>>;
}

/** One file of the index, loaded. */
export interface IndexFile<T extends object> {
  /** The document as last loaded or saved. */
  read(): T;
  /**
   * Keeps a new document and writes it.
   *
   * @remarks
   * Resolves once this document, or a later one, is on disk; rejects when that write fails.
   */
  save(document: T): Promise<void>;
  /** Waits for writes in progress; never rejects. */
  flush(): Promise<void>;
}

/** The result of loading a file of the index. */
export interface LoadedIndexFile<T extends object> {
  readonly file: IndexFile<T>;
  /** Where a damaged file was moved to, when it was; the document then starts empty. */
  readonly setAside: string | null;
}

/**
 * A file of the index was written by a newer Atrium; this one must not rewrite it.
 *
 * @remarks
 * See `loadIndexFile`.
 *
 * @sideEffects none
 */
export class IndexTooNewError extends Error {
  /**
   * Creates the error.
   *
   * @remarks
   * Carries the file and both versions, which the host logs and prints when it refuses to start.
   *
   * @sideEffects none
   * @param path - The file.
   * @param version - Its version.
   * @param supported - The newest version this Atrium knows.
   */
  constructor(
    readonly path: string,
    readonly version: number,
    readonly supported: number,
  ) {
    super(`${path} has format version ${version}; this Atrium supports up to ${supported}`);
    this.name = "IndexTooNewError";
  }
}

/**
 * Loads a file of the index, upgrading or setting it aside as needed.
 *
 * @remarks
 * Follows domain-model §1, "索引的存储":
 * - a missing file is an empty document, not damage;
 * - an older version is copied to `<name>.v<version>.bak`, upgraded step by step and written back;
 * - a newer version is refused, so this Atrium never drops what a newer one wrote;
 * - text that is not JSON, has no valid `version` or does not match the schema is renamed to
 *   `<name>.corrupt-<time>.json`, kept, and the document starts empty.
 *
 * Files are written with mode `0600` (security.md).
 *
 * @sideEffects Reads the file; may copy, rename or rewrite it; creates its directory.
 * @param directory - The index directory, normally `~/.atrium`.
 * @param spec - The file's name, version, schema and upgrades.
 * @param now - The time, for naming a damaged file's copy.
 * @param write - How content reaches the disk; tests pass one that fails on purpose.
 * @returns The loaded file, and where a damaged one went.
 * @throws {IndexTooNewError} When the file's version is newer than `spec.version`.
 * @throws Errors reading the file other than its absence, and errors writing it back.
 */
export async function loadIndexFile<T extends object>(
  directory: string,
  spec: IndexFileSpec<T>,
  now: number,
  write: (path: string, content: string) => Promise<void> = writeAtomically,
): Promise<LoadedIndexFile<T>> {
  const path = join(directory, `${spec.name}.json`);
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });
  if (text === null) return { file: indexFile(path, spec, spec.empty(), write), setAside: null };
  const stored = storedVersion(text);
  if (stored !== null && stored.version > spec.version) {
    throw new IndexTooNewError(path, stored.version, spec.version);
  }
  const upgraded = stored === null ? null : upgrade(stored.document, stored.version, spec);
  const parsed = upgraded === null ? null : spec.schema.safeParse(upgraded);
  if (parsed?.success !== true) {
    const aside = join(directory, `${spec.name}.corrupt-${new Date(now).toISOString().replaceAll(":", "-")}.json`);
    await rename(path, aside);
    return { file: indexFile(path, spec, spec.empty(), write), setAside: aside };
  }
  const file = indexFile(path, spec, parsed.data, write);
  if (stored !== null && stored.version < spec.version) {
    await copyFile(path, join(directory, `${spec.name}.v${stored.version}.bak`));
    await file.save(parsed.data);
  }
  return { file, setAside: null };
}

/**
 * Reads the version and the rest of a stored document.
 *
 * @remarks
 * A document is a JSON object whose `version` is a positive integer; anything else is damage.
 *
 * @sideEffects none
 * @param text - The file's text.
 * @returns The version and the document without it, or `null` for damage.
 */
function storedVersion(text: string): { version: number; document: Record<string, unknown> } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const version: unknown = Reflect.get(value, "version");
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  return { version, document: Object.fromEntries(Object.entries(value).filter(([key]) => key !== "version")) };
}

/**
 * Upgrades a document to the current version.
 *
 * @remarks
 * Each step takes one version to the next; a missing step leaves the document unreadable, which
 * then counts as damage rather than guessing.
 *
 * @sideEffects none
 * @param document - The document.
 * @param version - Its version.
 * @param spec - The file's spec.
 * @returns The upgraded document, or `null` when a step is missing.
 */
function upgrade<T extends object>(
  document: Record<string, unknown>,
  version: number,
  spec: IndexFileSpec<T>,
): Record<string, unknown> | null {
  let current = document;
  for (let from = version; from < spec.version; from += 1) {
    const step = spec.migrations?.[from];
    if (step === undefined) return null;
    current = step(current);
  }
  return current;
}

/**
 * Wraps a loaded document with its writer.
 *
 * @remarks
 * Writes to one file run one at a time; a document saved during a write is written once that
 * write ends, even when it failed, and documents saved in between are skipped, since only the
 * latest matters.
 *
 * @sideEffects none until `save`; then writes the file.
 * @param path - The file.
 * @param spec - The file's spec, for its version.
 * @param initial - The loaded document.
 * @param write - How content reaches the disk.
 * @returns The file.
 */
function indexFile<T extends object>(
  path: string,
  spec: IndexFileSpec<T>,
  initial: T,
  write: (path: string, content: string) => Promise<void>,
): IndexFile<T> {
  let latest = initial;
  let pending = false;
  let writing: Promise<void> | null = null;

  /**
   * Writes the latest document until no newer one is waiting.
   *
   * @remarks
   * See `indexFile`.
   *
   * @sideEffects Writes the file.
   */
  async function drain(): Promise<void> {
    try {
      while (pending) {
        pending = false;
        try {
          await write(path, `${JSON.stringify({ version: spec.version, ...latest }, null, 2)}\n`);
        } catch (error) {
          // A document saved while this write failed gets its own write, whose outcome counts.
          if (!pending) throw error;
        }
      }
    } finally {
      writing = null;
    }
  }

  return {
    read: () => latest,
    save(document) {
      latest = document;
      pending = true;
      writing ??= drain();
      return writing;
    },
    async flush() {
      await writing?.catch(() => undefined);
    },
  };
}

/**
 * Replaces a file's content so that readers see either the old or the new content whole.
 *
 * @remarks
 * The content goes to a temporary file in the same directory, is flushed to disk, and is renamed
 * over the file; the directory is then flushed so the rename survives a crash
 * (domain-model §1, "索引的存储"). A failed write removes its temporary file.
 *
 * @sideEffects Creates the directory if missing; writes, renames and may remove files.
 * @param path - The file.
 * @param content - The new content.
 */
export async function writeAtomically(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const folder = await open(directory, "r");
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}
