import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Reads every host log record that belongs to one trace.
 *
 * @remarks
 * Spans and logs share one JSONL log (observability.md, "日志格式"), so a trace is rebuilt by
 * filtering on `trace_id` across all rotated files.
 *
 * @sideEffects Reads the log directory.
 * @param {string} logsDir - Directory with `host.<n>.jsonl` files.
 * @param {string} traceId - Trace to collect.
 * @returns {Promise<Array<Record<string, any>>>} Matching records in time order.
 */
async function readTrace(logsDir, traceId) {
  const files = (await readdir(logsDir)).filter((name) => /^host\.\d+\.jsonl$/.test(name));
  const records = [];
  for (const file of files) {
    for (const line of (await readFile(join(logsDir, file), "utf8")).split("\n")) {
      if (line.length === 0) continue;
      const record = JSON.parse(line);
      if (record.trace_id === traceId) records.push(record);
    }
  }
  return records.toSorted((a, b) => String(a.start ?? a.time).localeCompare(String(b.start ?? b.time)));
}

/**
 * Prints a trace as a span tree with each span's log records beneath it.
 *
 * @remarks
 * Spans whose parent is not in the log (for example the client's own span) are shown as roots.
 *
 * @sideEffects Writes to stdout.
 * @param {Array<Record<string, any>>} records - Records of one trace.
 */
function printTree(records) {
  const spans = records.filter((record) => record.kind === "span");
  const logs = records.filter((record) => record.kind !== "span");
  const known = new Set(spans.map((span) => span.span_id));
  /**
   * Prints one span and, recursively, its children.
   *
   * @remarks
   * Indentation shows nesting.
   *
   * @sideEffects Writes to stdout.
   * @param {Record<string, any>} span - Span record.
   * @param {number} depth - Nesting level.
   */
  const print = (span, depth) => {
    const pad = "  ".repeat(depth);
    console.log(`${pad}${span.name}  ${span.duration_ms.toFixed(1)}ms  ${span.status}`);
    for (const log of logs.filter((record) => record.span_id === span.span_id)) {
      console.log(`${pad}  · [${log.level}] ${log.msg}`);
    }
    for (const child of spans.filter((candidate) => candidate.parent_span_id === span.span_id)) print(child, depth + 1);
  };
  for (const root of spans.filter((span) => !known.has(span.parent_span_id))) print(root, 0);
  for (const log of logs.filter((record) => !known.has(record.span_id))) console.log(`· [${log.level}] ${log.msg}`);
}

const traceId = process.argv[2];
if (traceId === undefined || !/^[0-9a-f]{32}$/.test(traceId)) {
  console.error("usage: pnpm trace <32-hex trace id> [logs dir]");
  process.exit(1);
}
const logsDir = process.argv[3] ?? join(process.env.ATRIUM_HOME ?? join(homedir(), ".atrium"), "logs");
const records = await readTrace(logsDir, traceId);
if (records.length === 0) console.log(`no records for trace ${traceId} in ${logsDir}`);
else printTree(records);
