import { type SessionFileReader, type SessionFileSummary, type SessionsLocation, sessionFolder } from "@atrium/pi";
import { type Attention, isChatId, type SessionSummary } from "@atrium/protocol";
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

/** A chat: its directory, and the session it is named after unless the user named it. */
export interface CatalogChat extends ContainerDir {
  /** Its session created first, not archived; `null` for none. */
  readonly firstSessionId: string | null;
}

/** What the catalog knows of one session; the manager adds whether it runs or asks. */
export type CatalogEntry = Omit<SessionSummary, "running" | "asking"> & {
  /** The working directory pi starts in. */
  readonly cwd: string;
  /** Fast as last switched in it; `null` while it never was (SPEC-0001, "Fast"). */
  readonly fast: boolean | null;
  /** A child's usage baseline; `null` to count all of it (SPEC-0002, "用量合计"). */
  readonly usageAfter: string | null;
};

/** A new session's record: where it is, and for a child conversation its parent, name and baseline. */
export interface NewRecord {
  readonly sessionId: string;
  readonly containerId: string;
  readonly cwd: string;
  readonly parent?: SessionSummary["parent"];
  readonly name?: string;
  readonly usageAfter?: string | null;
  /** Its file is written already, as a fork's is; a draft otherwise. */
  readonly persisted?: boolean;
}

/** Finds the sessions of the registered containers and keeps Atrium's records of them. */
export interface SessionCatalog {
  /** Every session of a registered container. */
  list(): CatalogEntry[];
  /** Every chat, as the chats root last listed them and as created since. */
  chats(): CatalogChat[];
  find(sessionId: string): CatalogEntry | undefined;
  /** Records a new draft session, a child conversation with its parent and name. */
  record(session: NewRecord): Promise<void>;
  /** Makes a child conversation an ordinary session (SPEC-0002, "脱离"); nothing for one without a parent. */
  detach(sessionId: string): Promise<void>;
  /** Names a recorded session in its record, as a draft child's name waits there (SPEC-0002, "概念 · 名字"). */
  name(sessionId: string, name: string): Promise<void>;
  /** Forgets a draft that was discarded. */
  forget(sessionId: string): Promise<void>;
  /** Hides a session in Atrium; pi's file stays. */
  archive(sessionId: string): Promise<void>;
  /** Shows a session hidden by `archive` again. */
  unarchive(sessionId: string): Promise<void>;
  /** Sets a session's attention, hand-off or Fast, as given. */
  mark(sessionId: string, change: SessionMarks): Promise<void>;
  /**
   * Resolves once the first scan has ended, starting one if none has.
   *
   * @remarks
   * Until then a recorded session whose file was not seen yet is not known to be missing, nor a
   * draft known to have no file (domain-model §1, "第一次扫描之前").
   */
  ready(): Promise<void>;
  /** Scans the containers' session folders again; scans asked for during one run once after it. */
  scan(): Promise<void>;
  /** Calls `listener` after the list changed; returns a function that stops it. */
  onChange(listener: () => void): () => void;
  /** Stops scanning. */
  close(): Promise<void>;
}

/** The marks Atrium keeps on a session besides archiving it. */
interface SessionMarks {
  readonly attention?: Attention | null;
  readonly handedOff?: boolean;
  readonly fast?: boolean;
}

/**
 * A record's parent, as the summary has it.
 *
 * @remarks
 * Only `sessionId` and `by`; the record keeps unknown fields a later version wrote.
 *
 * @sideEffects none
 * @param record - The record, if Atrium has one.
 * @returns The parent, or `null` for an ordinary session.
 */
function parentOf(record: SessionRecord | undefined): SessionSummary["parent"] {
  return record?.parent === undefined ? null : { sessionId: record.parent.sessionId, by: record.parent.by };
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
 *   `missing`, but only once a scan has looked (`ready`);
 * - every directory under the chats root is a chat, `cht_<its name>`, and the container of the
 *   sessions in it (ADR-0007); a name no chat id could have is passed over. A chat's first session
 *   is the one created first, by Atrium's record, else when its file last changed.
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
  let chatDirs: readonly ContainerDir[] = [];
  let scanning: Promise<void> | null = null;
  let again = false;
  /** Settles once the first scan has ended, however it ended. */
  const firstScan = Promise.withResolvers<void>();
  let scanned = false;

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
    return [...options.workspaces(), ...chatDirs];
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
      record !== undefined && ids.has(record.containerId) ? record.containerId : byDir.get(cwd);
    const entries: CatalogEntry[] = [];
    for (const file of found.values()) {
      const record = records.get(file.sessionId);
      const containerId = containerOf(record, file.cwd);
      if (containerId === undefined) continue;
      entries.push({
        sessionId: file.sessionId,
        containerId,
        cwd: file.cwd,
        name: file.name ?? record?.name ?? null,
        prompt: promptLine(file.firstPrompt),
        file: file.path,
        state: "persisted",
        updatedAt: file.modifiedAt,
        archived: record?.archived ?? false,
        attention: record?.attention ?? null,
        handedOff: record?.handedOff ?? false,
        fast: record?.fast ?? null,
        parent: parentOf(record),
        usageAfter: record?.usageAfter ?? null,
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
        name: record.name ?? null,
        prompt: null,
        file: null,
        // Before the first scan, a file not found yet may well be there (domain-model §1).
        state: record.draft ? "draft" : scanned ? "missing" : "persisted",
        updatedAt: record.createdAt,
        archived: record.archived,
        attention: record.attention ?? null,
        handedOff: record.handedOff ?? false,
        fast: record.fast ?? null,
        parent: parentOf(record),
        usageAfter: record.usageAfter ?? null,
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
    const before = JSON.stringify([list(), chatDirs]);
    const location = await options.location;
    chatDirs = (await readdir(options.chatsRoot, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory() && isChatId(chatIdOf(entry.name)))
      .map((entry) => ({ id: chatIdOf(entry.name), dir: join(options.chatsRoot, entry.name) }));
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
    if (JSON.stringify([list(), chatDirs]) !== before) changed();
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

  /**
   * Changes a listed session's record, adding one for a session from the terminal.
   *
   * @remarks
   * Atrium keeps records only of the sessions it created or marked (domain-model §1), so a change
   * the session already has writes nothing; a session not listed is ignored.
   *
   * @sideEffects May write `sessions.json` and call the listeners.
   * @param sessionId - The session.
   * @param change - The fields to set.
   */
  async function update(sessionId: string, change: SessionMarks & { readonly archived?: boolean }): Promise<void> {
    const entry = list().find((candidate) => candidate.sessionId === sessionId);
    if (entry === undefined) return;
    const marks = {
      archived: entry.archived,
      attention: entry.attention,
      handedOff: entry.handedOff,
      fast: entry.fast,
    };
    if (JSON.stringify({ ...marks, ...change }) === JSON.stringify(marks)) return;
    const sessions = options.file.read().sessions;
    const recorded = sessions.some((record) => record.sessionId === sessionId);
    await save(
      recorded
        ? sessions.map((record) => (record.sessionId === sessionId ? { ...record, ...change } : record))
        : [
            ...sessions,
            {
              sessionId,
              containerId: entry.containerId,
              cwd: entry.cwd,
              draft: false,
              archived: false,
              createdAt: options.clock.now(),
              ...change,
            },
          ],
    );
  }

  /**
   * The chats, each with its first session.
   *
   * @remarks
   * See `createSessionCatalog`.
   *
   * @sideEffects none
   * @returns The chats.
   */
  function chats(): CatalogChat[] {
    const records = new Map(options.file.read().sessions.map((record) => [record.sessionId, record]));
    const live = list().filter((entry) => !entry.archived);
    return chatDirs.map((chat) => {
      const first = live
        .filter((entry) => entry.containerId === chat.id)
        .map((entry) => ({
          sessionId: entry.sessionId,
          at: records.get(entry.sessionId)?.createdAt ?? entry.updatedAt,
        }))
        .toSorted((a, b) => a.at - b.at)[0];
      return { ...chat, firstSessionId: first?.sessionId ?? null };
    });
  }

  return {
    list,
    chats,
    find: (sessionId) => list().find((entry) => entry.sessionId === sessionId),
    record(session) {
      // A new chat's directory was just made; it is listed without waiting for a scan.
      if (isChatId(session.containerId) && !chatDirs.some((chat) => chat.id === session.containerId)) {
        chatDirs = [...chatDirs, { id: session.containerId, dir: session.cwd }];
      }
      return save([
        ...options.file.read().sessions,
        {
          sessionId: session.sessionId,
          containerId: session.containerId,
          cwd: session.cwd,
          draft: session.persisted !== true,
          archived: false,
          createdAt: options.clock.now(),
          ...(session.parent ? { parent: session.parent } : {}),
          ...(session.name === undefined ? {} : { name: session.name }),
          ...(session.usageAfter === undefined ? {} : { usageAfter: session.usageAfter }),
        },
      ]);
    },
    forget: (sessionId) => save(options.file.read().sessions.filter((record) => record.sessionId !== sessionId)),
    async detach(sessionId) {
      const sessions = options.file.read().sessions;
      if (!sessions.some((record) => record.sessionId === sessionId && record.parent !== undefined)) return;
      await save(
        sessions.map((record) => {
          if (record.sessionId !== sessionId) return record;
          const { parent: _parent, ...rest } = record;
          return rest;
        }),
      );
    },
    async name(sessionId, name) {
      const sessions = options.file.read().sessions;
      if (!sessions.some((record) => record.sessionId === sessionId && record.name !== name)) return;
      await save(sessions.map((record) => (record.sessionId === sessionId ? { ...record, name } : record)));
    },
    archive: (sessionId) => update(sessionId, { archived: true }),
    unarchive: (sessionId) => update(sessionId, { archived: false }),
    mark: (sessionId, change) => update(sessionId, change),
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
          scanned = true;
          firstScan.resolve();
        }
      })();
      return scanning;
    },
    ready() {
      // Fire and forget: a failed scan still ends the wait; the scan's caller reports the failure.
      if (!scanned && scanning === null) void this.scan().catch(() => undefined);
      return firstScan.promise;
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

/**
 * The id of the chat in a directory under the chats root.
 *
 * @remarks
 * A chat is named after its directory, which Atrium named at random (ADR-0007).
 *
 * @sideEffects none
 * @param name - The directory's name.
 * @returns The chat's id.
 */
export function chatIdOf(name: string): string {
  return `cht_${name}`;
}
