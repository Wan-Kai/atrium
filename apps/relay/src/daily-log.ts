import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "./clock";
import type { ResourceTracker } from "./resources";

/** Days of log files kept, today's included (SPEC-0005, "可观测性"). */
const LOG_RETENTION_DAYS = 14;

const FILE_NAME = /^relay-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;

/**
 * Appends JSON lines to one file per UTC day under a directory and deletes files past retention.
 *
 * @remarks
 * SPEC-0005 asks for daily rotation; the host's pino-roll rotates by size and is driven by its own
 * timers, while this one takes the injected clock, so tests step across midnight. Writes are
 * fire-and-forget like a logger's: a failing disk must not take the relay down, so the first error
 * of a file goes to `onError` and later lines of that file are dropped until the next day's file. Files are
 * created 0600 (security.md, "relay").
 *
 * @sideEffects Opens, appends to and deletes files under `dir`; counts the open file as
 * `log.file`.
 */
export class DailyLog {
  readonly #dir: string;
  readonly #clock: Clock;
  readonly #resources: ResourceTracker;
  readonly #onError: (error: Error) => void;
  #day = "";
  #stream: WriteStream | null = null;
  #release: () => void = () => {};
  #broken = false;
  #closed = false;
  #pruning: Promise<void> = Promise.resolve();

  /**
   * Creates the log; call `open` before writing.
   *
   * @remarks
   * Split from `open` so construction does no I/O.
   *
   * @sideEffects none
   * @param dir - The directory for the files, created if missing.
   * @param clock - Decides the day and stamps lines.
   * @param resources - Counts the open file.
   * @param onError - Told once per file about a write or open error.
   */
  constructor(dir: string, clock: Clock, resources: ResourceTracker, onError: (error: Error) => void) {
    this.#dir = dir;
    this.#clock = clock;
    this.#resources = resources;
    this.#onError = onError;
  }

  /**
   * Creates the directory (0700) and opens today's file.
   *
   * @remarks
   * Done before the relay starts, so a data directory it cannot write fails the start.
   *
   * @sideEffects Creates the directory; opens a file; starts deleting old files.
   * @returns Once the directory exists.
   */
  async open(): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    this.#roll();
  }

  /**
   * Appends one record with the current time as `time`.
   *
   * @remarks
   * `time` comes first so the files read in order with plain tools.
   *
   * @sideEffects Writes to the file; may roll to a new day's file.
   * @param record - Fields of the line; never payloads or secrets (the relay's events are typed so).
   */
  write(record: Readonly<Record<string, unknown>>): void {
    if (this.#closed) return;
    this.#roll();
    if (this.#broken || this.#stream === null) return;
    this.#stream.write(`${JSON.stringify({ time: new Date(this.#clock.now()).toISOString(), ...record })}\n`);
  }

  /**
   * Finishes writing and closes the file.
   *
   * @remarks
   * `end` flushes what is queued, so the last lines of a shutdown are on disk. Later writes are
   * dropped.
   *
   * @sideEffects Closes the file.
   * @returns Once it is closed and the pending deletion of old files is done.
   */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#endStream();
    await this.#pruning;
  }

  /**
   * Opens the file of the current UTC day if it is not the one open.
   *
   * @remarks
   * Checked on every write, so the first line after midnight starts the new file.
   *
   * @sideEffects Ends the old file; opens the new one; starts deleting old files.
   */
  #roll(): void {
    const day = new Date(this.#clock.now()).toISOString().slice(0, 10);
    if (day === this.#day) return;
    // Fire and forget: the old file's last lines are already queued on its stream.
    void this.#endStream();
    this.#day = day;
    this.#broken = false;
    const stream = createWriteStream(join(this.#dir, `relay-${day}.jsonl`), { flags: "a", mode: 0o600 });
    let reported = false;
    stream.on("error", (error) => {
      if (this.#stream === stream) this.#broken = true;
      if (reported) return;
      reported = true;
      this.#onError(error);
    });
    this.#stream = stream;
    this.#release = this.#resources.acquire("log.file");
    const prune = this.#prune(day);
    this.#pruning = this.#pruning.then(() => prune);
  }

  /**
   * Ends the open file's stream.
   *
   * @remarks
   * Resolves on `close`, which comes after an error too, or at once when the stream already
   * closed after one, so shutdown never waits forever.
   *
   * @sideEffects Closes the stream; releases its count.
   * @returns Once the stream has closed.
   */
  async #endStream(): Promise<void> {
    const stream = this.#stream;
    const release = this.#release;
    this.#stream = null;
    this.#release = () => {};
    if (stream === null) return;
    await new Promise<void>((resolve) => {
      if (stream.closed) {
        resolve();
        return;
      }
      stream.once("close", resolve);
      stream.end();
    });
    release();
  }

  /**
   * Deletes the relay's log files older than the retention window.
   *
   * @remarks
   * Only names this log writes are touched. A file that cannot be listed or deleted is reported
   * once through `onError` and kept.
   *
   * @sideEffects Deletes files.
   * @param today - The current day, `YYYY-MM-DD`.
   * @returns Once done; never rejects.
   */
  async #prune(today: string): Promise<void> {
    const oldestKept = new Date(Date.parse(today) - (LOG_RETENTION_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
    try {
      const names = await readdir(this.#dir);
      for (const name of names) {
        const day = FILE_NAME.exec(name)?.[1];
        if (day !== undefined && day < oldestKept) await unlink(join(this.#dir, name));
      }
    } catch (error) {
      this.#onError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
