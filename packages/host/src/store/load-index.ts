import type { IndexFileName } from "@atrium/protocol";
import { basename } from "node:path";
import type { Logger } from "../platform/logger";
import { type IndexFile, loadIndexFile } from "./index-file";
import {
  LAYOUTS_FILE,
  type LayoutsDocument,
  PREFERENCES_FILE,
  PROJECTS_FILE,
  type PreferencesDocument,
  type ProjectsDocument,
  SESSIONS_FILE,
  type SessionsDocument,
} from "./index-schema";

/** The index's files, loaded. */
export interface LoadedIndex {
  readonly projects: IndexFile<ProjectsDocument>;
  readonly sessions: IndexFile<SessionsDocument>;
  readonly layouts: IndexFile<LayoutsDocument>;
  readonly preferences: IndexFile<PreferencesDocument>;
  /** Files that were damaged and started empty, for the UI to mention once. */
  readonly resets: readonly IndexFileName[];
  /** Waits for every write in progress. */
  flush(): Promise<void>;
}

/**
 * Loads the index's files from Atrium's home.
 *
 * @remarks
 * Each file is loaded on its own, so one damaged file is reset without touching the others
 * (domain-model §1, "索引的存储"); a reset is logged by the file's name and where its copy went.
 * The per-session turn records are loaded with their sessions, not here.
 *
 * @sideEffects Reads, and may upgrade, set aside or rewrite, the index's files; logs resets.
 * @param home - Atrium's home directory.
 * @param now - The time, for naming a damaged file's copy.
 * @param logger - Where resets are logged.
 * @returns The loaded files.
 * @throws {IndexTooNewError} When a file was written by a newer Atrium.
 */
export async function loadIndex(home: string, now: number, logger: Logger): Promise<LoadedIndex> {
  const resets: IndexFileName[] = [];

  /**
   * Loads one file, noting a reset.
   *
   * @remarks
   * See `loadIndex`.
   *
   * @sideEffects Reads the file; may log.
   * @param name - The file.
   * @param spec - Its spec.
   * @returns The file.
   */
  async function load<T extends object>(
    name: IndexFileName,
    spec: Parameters<typeof loadIndexFile<T>>[1],
  ): Promise<IndexFile<T>> {
    const { file, setAside } = await loadIndexFile(home, spec, now);
    if (setAside !== null) {
      resets.push(name);
      logger.warn({ file: name, copy: basename(setAside) }, "index file was damaged and has been reset");
    }
    return file;
  }

  const projects = await load("projects", PROJECTS_FILE);
  const sessions = await load("sessions", SESSIONS_FILE);
  const layouts = await load("layouts", LAYOUTS_FILE);
  const preferences = await load("preferences", PREFERENCES_FILE);
  return {
    projects,
    sessions,
    layouts,
    preferences,
    resets,
    async flush() {
      await Promise.all([projects.flush(), sessions.flush(), layouts.flush(), preferences.flush()]);
    },
  };
}
