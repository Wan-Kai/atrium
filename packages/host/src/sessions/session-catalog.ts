import { type SessionFileReader, type SessionFileSummary, type SessionsLocation, sessionFolder } from "@atrium/pi";
import { CHATS, type SessionSummary } from "@atrium/protocol";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "../platform/clock";
import type { Logger } from "../platform/logger";
import type { IndexFile } from "../store/index-file";
import type { SessionRecord, SessionsDocument } from "../store/index-schema";
import { promptLine } from "./prompt-line";

/** A directory sessions are filed under: a workspace's, or one chat's. */
export interface ContainerDir {
  readonly id: string;
  readonly dir: string;
}

/** What the catalog knows of one session; the manager adds whether it runs. */
export type CatalogEntry = Omit<SessionSummary, "running"> & {
  /** The working directory pi starts in. */
  readonly cwd: string;
};

/** Finds the sessions of the registered containers and keeps Atrium's records of them. */
export interface SessionCatalog {
  /** Every session of a registered container. */
  list(): CatalogEntry[];
  find(sessionId: string): CatalogEntry | undefined;
  /** Records a new draft session. */
  record(session: { readonly sessionId: string; readonly containerId: string; readonly cwd: string }): Promise<void>;
  /** Forgets a draft that was discarded. */
  forget(sessionId: string): Promise<void>;
  /** Hides a session in Atrium; pi's file stays. */
  archive(sessionId: string): Promise<void>;
  /** Scans the containers' session folders again; scans asked for during one run once after it. */
  scan(): Promise<void>;
  /** Calls `listener` after the list changed; returns a function that stops it. */
  onChange(listener: () => void): () => void;
  /** Stops scanning. */
  close(): Promise<void>;
}

/**
 * Creates the session catalog.
 *
 * @remarks
 * Follows domain-model §1 and SPEC-0001 ("项目、工作区与会话"):
 * - only the pi session folders of registered containers are read, each file checked against
 *   the directory it records, since different directories can share a folder;
 * - a session Atrium created belongs to the container it was created in while that container
 *   exists; any other session to the container whose directory is its working directory;
 * - a session found in more than one file is the newest file's; the conflict is logged;
 * - a draft becomes a session once its file is found; a recorded session whose file is gone is
 *   `missing`;
 * - every chat has its own directory under the chats root, and all of them are the chats'
 *   container.
 *
 * Reading is incremental (the pi package's `SessionFileReader`).
 *
 * @sideEffects none until a call; then reads pi's session folders and the chats root, and writes
 * `sessions.json`.
 * @param options - The loaded file, where pi keeps sessions (`null` when unknown), the chats
 * root, the workspaces' directories, the reader, the clock and the logger.
 * @returns The catalog.
 */
export function createSessionCatalog(options: {
  readonly file: IndexFile<SessionsDocument>;
  readonly location: Promise<SessionsLocation | null>;
  readonly chatsRoot: string;
  readonly workspaces: () => readonly ContainerDir[];
  readonly reader: SessionFileReader;
  readonly clock: Clock;
  readonly logger: Logger;
}): SessionCatalog {
  const listeners = new Set<() => void>();
  const stop = new AbortController();
  let found = new Map<string, SessionFileSummary>();
  let chatDirs: readonly string[] = [];
  let scanning: Promise<void> | null = null;
  let again = false;

  /**
   * Every container directory, workspaces first.
   *
   * @remarks
   * Chats come from the last listing of the chats root.
   *
   * @sideEffects none
   * @returns The directories.
   */
  function containers(): ContainerDir[] {
    return [...options.workspaces(), ...chatDirs.map((dir) => ({ id: CHATS, dir }))];
  }

  /**
   * Builds the list from the records and what the last scan found.
   *
   * @remarks
   * See `createSessionCatalog`.
   *
   * @sideEffects none
   * @returns The entries.
   */
  function list(): CatalogEntry[] {
    const all = containers();
    const byDir = new Map(all.map((container) => [container.dir, container.id]));
    const ids = new Set(all.map((container) => container.id));
    const records = new Map(options.file.read().sessions.map((record) => [record.sessionId, record]));
    /**
     * Where a session goes.
     *
     * @remarks
     * Where it was created while that container exists, else where it runs (domain-model,
     * "已决定 5").
     *
     * @sideEffects none
     * @param record - Its record, if Atrium has one.
     * @param cwd - Its working directory.
     * @returns The container, or `undefined` for none registered.
     */
    const containerOf = (record: SessionRecord | undefined, cwd: string) =>
      record !== undefined && ids.has(record.containerId) && record.containerId !== CHATS
        ? record.containerId
        : byDir.get(cwd);
    const entries: CatalogEntry[] = [];
    for (const file of found.values()) {
      const record = records.get(file.sessionId);
      const containerId = containerOf(record, file.cwd);
      if (containerId === undefined) continue;
      entries.push({
        sessionId: file.sessionId,
        containerId,
        cwd: file.cwd,
        name: file.name,
        prompt: promptLine(file.firstPrompt),
        file: file.path,
        state: "persisted",
        updatedAt: file.modifiedAt,
        archived: record?.archived ?? false,
      });
    }
    for (const record of records.values()) {
      if (found.has(record.sessionId)) continue;
      const containerId = containerOf(record, record.cwd);
      if (containerId === undefined) continue;
      entries.push({
        sessionId: record.sessionId,
        containerId,
        cwd: record.cwd,
        name: null,
        prompt: null,
        file: null,
        state: record.draft ? "draft" : "missing",
        updatedAt: record.createdAt,
        archived: record.archived,
      });
    }
    return entries;
  }

  /**
   * Reads every container's session folder once.
   *
   * @remarks
   * See `createSessionCatalog`.
   *
   * @sideEffects Reads the chats root and pi's session folders; may write `sessions.json`; calls
   * listeners when the list changed.
   */
  async function scanOnce(): Promise<void> {
    const before = JSON.stringify(list());
    const location = await options.location;
    chatDirs = (await readdir(options.chatsRoot, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(options.chatsRoot, entry.name));
    const next = new Map<string, SessionFileSummary>();
    if (location !== null) {
      const dirs = new Set(containers().map((container) => container.dir));
      const folders = new Set([...dirs].map((dir) => sessionFolder(location, dir)));
      for (const folder of folders) {
        for (const file of await options.reader.scanFolder(folder, stop.signal)) {
          if (!dirs.has(file.cwd)) continue;
          const other = next.get(file.sessionId);
          if (other !== undefined) {
            options.logger.warn({ sessionId: file.sessionId }, "session found in more than one file");
            if (other.modifiedAt >= file.modifiedAt) continue;
          }
          next.set(file.sessionId, file);
        }
      }
    }
    found = next;
    const document = options.file.read();
    if (document.sessions.some((record) => record.draft && found.has(record.sessionId))) {
      await options.file.save({
        ...document,
        sessions: document.sessions.map((record) =>
          record.draft && found.has(record.sessionId) ? { ...record, draft: false } : record,
        ),
      });
    }
    if (JSON.stringify(list()) !== before) changed();
  }

  /**
   * Tells the listeners the list changed.
   *
   * @remarks
   * Listeners merge changes themselves.
   *
   * @sideEffects Calls the listeners.
   */
  function changed(): void {
    for (const listener of listeners) listener();
  }

  /**
   * Writes the records and tells the listeners.
   *
   * @remarks
   * Every change to the records goes through here.
   *
   * @sideEffects Writes `sessions.json`; calls the listeners.
   * @param sessions - The new records.
   */
  async function save(sessions: SessionRecord[]): Promise<void> {
    const saving = options.file.save({ ...options.file.read(), sessions });
    changed();
    await saving;
  }

  return {
    list,
    find: (sessionId) => list().find((entry) => entry.sessionId === sessionId),
    record(session) {
      // A new chat's directory was just made; it is listed without waiting for a scan.
      if (session.containerId === CHATS && !chatDirs.includes(session.cwd)) chatDirs = [...chatDirs, session.cwd];
      return save([
        ...options.file.read().sessions,
        { ...session, draft: true, archived: false, createdAt: options.clock.now() },
      ]);
    },
    forget: (sessionId) => save(options.file.read().sessions.filter((record) => record.sessionId !== sessionId)),
    async archive(sessionId) {
      const entry = list().find((candidate) => candidate.sessionId === sessionId);
      if (entry === undefined) return;
      const sessions = options.file.read().sessions;
      const recorded = sessions.some((record) => record.sessionId === sessionId);
      await save(
        recorded
          ? sessions.map((record) => (record.sessionId === sessionId ? { ...record, archived: true } : record))
          : [
              ...sessions,
              {
                sessionId,
                containerId: entry.containerId,
                cwd: entry.cwd,
                draft: false,
                archived: true,
                createdAt: options.clock.now(),
              },
            ],
      );
    },
    scan() {
      if (scanning !== null) {
        again = true;
        return scanning;
      }
      scanning = (async () => {
        try {
          do {
            again = false;
            await scanOnce();
          } while (again && !stop.signal.aborted);
        } finally {
          scanning = null;
        }
      })();
      return scanning;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      stop.abort();
      await scanning?.catch(() => undefined);
    },
  };
}
