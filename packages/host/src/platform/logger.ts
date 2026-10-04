import { context, trace } from "@opentelemetry/api";
import pino, { type DestinationStream, type Level, type Logger } from "pino";
import build, { type RollStream } from "pino-roll";
import { lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createRedactor } from "./redact";

export type { Logger };

/** Options for {@link createLogger}. */
export interface LoggerOptions {
  /** Where log lines go. */
  readonly destination: DestinationStream;
  /** Lowest level that is written. */
  readonly level: Level;
  /** Secret values that must never reach the log, such as the session token. */
  readonly secrets: () => Iterable<string>;
  /** Value of the `service` field. */
  readonly service: "host" | "desktop";
}

/** An open log file. */
export interface LogFile {
  readonly stream: RollStream;
  /** Path that always points at the file being written. */
  readonly currentPath: string;
}

/**
 * Opens the rotating JSONL log file under the logs directory.
 *
 * @remarks
 * Logs rotate at `maxSize` and keep at most five files (`host.<n>.jsonl`), counting files left
 * by earlier runs, so a host restarted for weeks cannot fill the disk; `current.log` always links
 * to the file being written (observability.md, "日志格式"). The stream is created in-process
 * rather than as a pino transport so the bundled host needs no worker-thread entry files. A
 * stream error, such as a full disk during rotation, is reported on stderr instead of crashing
 * the host. A plain file named `current.log` would make pino-roll fail to create the link, so it
 * is removed first.
 *
 * @sideEffects Creates the logs directory if missing; may delete a non-link `current.log`; opens
 * a file for appending with mode `0600` (security.md, "凭据与日志"); keeps the `current.log` link
 * up to date; deletes the oldest log files when rotating; writes stream errors to stderr.
 * @param logsDir - Directory that holds the log files.
 * @param options - Rotation size; tests pass a small one to force rotation.
 * @returns The open stream and the path that always points at the current file.
 */
export async function openLogFile(logsDir: string, options: { maxSize?: string } = {}): Promise<LogFile> {
  const currentPath = join(logsDir, "current.log");
  const existing = await lstat(currentPath).catch(() => null);
  if (existing !== null && !existing.isSymbolicLink()) await unlink(currentPath);
  const stream = await build({
    // pino-roll 4.0 ignores its `extension` option and takes the extension from the file name.
    file: join(logsDir, "host.jsonl"),
    size: options.maxSize ?? "10m",
    // Measured with pino-roll 4.0.0: with removeOtherLogFiles, `count: 4` leaves four or five
    // files on disk (it depends on whether the new file exists when old ones are listed), the one
    // being written included, and also deletes files left by earlier runs.
    limit: { count: 4, removeOtherLogFiles: true },
    mkdir: true,
    symlink: true,
    mode: 0o600,
  });
  stream.on("error", (error) => {
    process.stderr.write(`atrium: log stream error: ${error.message}\n`);
  });
  // The file opens asynchronously; flushing before it is open throws, so wait for it here.
  if (stream.fd < 0) await new Promise<void>((done) => stream.once("ready", () => done()));
  return { stream, currentPath };
}

/**
 * Creates the structured logger used across the host.
 *
 * @remarks
 * Every record carries the active span's `trace_id` and `span_id`, so one id finds all records
 * of an operation (observability.md, "方案"). Secrets are removed from the finished line, just
 * before it is written (security.md, "凭据与日志"): pino assembles `msg`, `err` and child
 * bindings outside its formatter hooks, so only the final JSON sees everything. The line is
 * parsed, credential-like keys are replaced at any depth and every known secret value is scrubbed
 * from strings, then it is serialized again; a line that does not parse is scrubbed as a string.
 * Parsing first also means a secret is matched as written, not in its JSON-escaped form.
 *
 * @sideEffects Writes to `destination` whenever a record at or above `level` is logged.
 * @param options - Destination, level, secrets and service name.
 * @returns The pino logger.
 */
export function createLogger(options: LoggerOptions): Logger {
  const redact = createRedactor(options.secrets);

  /**
   * Redacts one finished log line.
   *
   * @remarks
   * Pino writes one JSON object per line; parsing it is the only way to reach every field.
   *
   * @sideEffects none
   * @param line - The line pino produced, ending in a newline.
   * @returns The line to write.
   */
  function redactLine(line: string): string {
    try {
      return `${JSON.stringify(redact(JSON.parse(line)))}\n`;
    } catch {
      // Stryker disable next-line all: pino only writes valid JSON lines; redacting the raw string is the fallback for a future change.
      return String(redact(line));
    }
  }

  return pino(
    {
      level: options.level,
      base: { service: options.service },
      timestamp: pino.stdTimeFunctions.isoTime,
      mixin: activeTraceFields,
      formatters: {
        level: (label) => ({ level: label }),
      },
    },
    { write: (line: string) => options.destination.write(redactLine(line)) },
  );
}

/**
 * Reads the ids of the span that is active in the current async context.
 *
 * @remarks
 * Used as pino's `mixin`, so callers never pass trace ids by hand and cannot forget them.
 *
 * @sideEffects none
 * @returns `trace_id` and `span_id`, or an empty object outside any span.
 */
function activeTraceFields(): Record<string, string> {
  const span = trace.getSpan(context.active());
  if (span === undefined) return {};
  const { traceId, spanId } = span.spanContext();
  return { trace_id: traceId, span_id: spanId };
}
