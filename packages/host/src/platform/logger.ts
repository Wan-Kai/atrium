import { context, trace } from "@opentelemetry/api";
import pino, { type DestinationStream, type Level, type Logger } from "pino";
import build, { type RollStream } from "pino-roll";
import { join } from "node:path";
import type { Redactor } from "./redact";

export type { Logger };

/** Options for {@link createLogger}. */
export interface LoggerOptions {
  /** Where log lines go. */
  readonly destination: DestinationStream;
  /** Lowest level that is written. */
  readonly level: Level;
  /** Scrubs secrets from every record. */
  readonly redact: Redactor;
  /** Value of the `service` field. */
  readonly service: "host" | "desktop";
}

/**
 * Opens the rotating JSONL log file under the logs directory.
 *
 * @remarks
 * Logs rotate at 10MB and keep 5 files (`host.<n>.jsonl`) so a host running for weeks cannot
 * fill the disk; `current.log` always links to the file being written (observability.md,
 * "日志格式"). The stream is created in-process rather than as a pino transport so the bundled
 * host does not need worker-thread entry files.
 *
 * @sideEffects Creates the logs directory if missing, opens a file for appending with mode
 * `0600` (security.md, "凭据与日志"), and maintains the `current.log` symlink.
 * @param logsDir - Directory that holds the log files.
 * @returns The open stream and the path that always points at the current file.
 */
export async function openLogFile(logsDir: string): Promise<{ stream: RollStream; currentPath: string }> {
  const stream = await build({
    // pino-roll 4.0 ignores its `extension` option and takes the extension from the file name.
    file: join(logsDir, "host.jsonl"),
    size: "10m",
    limit: { count: 5 },
    mkdir: true,
    symlink: true,
    mode: 0o600,
  });
  // The file opens asynchronously; flushing before it is open throws, so wait for it here.
  if (stream.fd < 0) await new Promise<void>((done) => stream.once("ready", () => done()));
  return { stream, currentPath: join(logsDir, "current.log") };
}

/**
 * Creates the structured logger used across the host.
 *
 * @remarks
 * Every record carries the active span's `trace_id` and `span_id`, so one id finds all records
 * of an operation (observability.md, "方案"). Every record is passed through the redactor before
 * it is written (security.md, "凭据与日志").
 *
 * @sideEffects Writes to `destination` whenever a record at or above `level` is logged.
 * @param options - Destination, level, redactor and service name.
 * @returns The pino logger.
 */
export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      base: { service: options.service },
      timestamp: pino.stdTimeFunctions.isoTime,
      mixin: activeTraceFields,
      formatters: {
        level: (label) => ({ level: label }),
        log: (record) => toRecord(options.redact(record)),
      },
    },
    options.destination,
  );
}

/**
 * Narrows the redactor's output back to a log record.
 *
 * @remarks
 * Redacting an object always yields an object; the guard keeps the types honest without a cast.
 *
 * @sideEffects none
 * @param value - Redacted record.
 * @returns The record, or the value wrapped under `value` if it is somehow not an object.
 */
function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : { value };
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
