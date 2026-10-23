import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Levels worth a look (testing.md, "运行时监控"). */
const LEVELS = new Set(["warn", "error", "fatal"]);
/** How much of a reported problem's normalized text goes into its signature. */
const ISSUE_LENGTH = 120;

/**
 * Parses one log line, skipping lines that are not complete JSON.
 *
 * @remarks
 * The last line can be cut short when the host is still writing or was killed mid-write.
 *
 * @sideEffects none
 * @param {string} line - One line of a log file.
 * @returns {Record<string, any> | null} The record, or `null` for an empty or partial line.
 */
function parseLine(line) {
  try {
    return line.length === 0 ? null : JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Reads the records that start a host run or are warnings or worse, across all rotated files.
 *
 * @remarks
 * Files rotate by size, so a run can span several of them; sorting by time puts them back in
 * order whatever the file numbers are. Only reads: the directory is the live app's.
 *
 * @sideEffects Reads the log directory.
 * @param {string} logsDir - Directory with `host.<n>.jsonl` files.
 * @returns {Promise<{ records: Array<Record<string, any>>, first: number, last: number } | null>}
 * Matching records in time order and the times of the first and last record of any kind; `null`
 * when the directory cannot be read.
 */
async function readRecords(logsDir) {
  const names = await readdir(logsDir).catch(() => null);
  if (names === null) return null;
  const records = [];
  let [first, last] = [Infinity, -Infinity];
  for (const file of names.filter((name) => /^host\.\d+\.jsonl$/.test(name))) {
    for (const line of (await readFile(join(logsDir, file), "utf8")).split("\n")) {
      const record = parseLine(line);
      const at = Date.parse(record?.time);
      if (Number.isNaN(at)) continue;
      [first, last] = [Math.min(first, at), Math.max(last, at)];
      if (record.msg === "host listening" || LEVELS.has(record.level)) records.push({ ...record, at });
    }
  }
  return { records: records.toSorted((a, b) => a.at - b.at), first, last };
}

/**
 * Reduces a problem the UI reported to what stays the same each time it happens.
 *
 * @remarks
 * React's production build replaces its messages with a number and a link, and the same error
 * comes as an uncaught error or as an unhandled rejection; the number is what tells errors apart.
 * Other texts lose links, paths, ids and numbers, which differ every time.
 *
 * @sideEffects none
 * @param {string} text - The reported problem.
 * @returns {string} The normalized text.
 */
function normalizeIssue(text) {
  const react = /Minified React error #(\d+)/.exec(text);
  if (react !== null) return `React #${react[1]}`;
  return text
    .replaceAll(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replaceAll(/(?:~|\.{0,2})?\/[^\s/]+(?:\/[^\s/]+)+/g, "<path>")
    .replaceAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replaceAll(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, "<id>")
    .replaceAll(/\d+(?:\.\d+)?/g, "<n>")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, ISSUE_LENGTH);
}

/**
 * Names the kind of record: where from, how bad, what happened, and how it failed.
 *
 * @remarks
 * `msg` is a fixed sentence and the rest goes in fields (observability.md, "日志格式"), so the
 * signature takes `msg` and the error's type and code, never its message. Problems the UI reports
 * all share one `msg`, so their kind and normalized text join the signature.
 *
 * @sideEffects none
 * @param {Record<string, any>} record - A warn, error or fatal record.
 * @returns {string} The signature.
 */
function signatureOf(record) {
  let text = `${record.level} ${record.service ?? "?"} ${JSON.stringify(String(record.msg))}`;
  const failure = [record.err?.type, record.err?.code].filter((part) => part !== undefined && part !== null);
  if (failure.length > 0) text += ` (${failure.join(" ")})`;
  if (record.msg === "client issue") text += ` ${record.kind}: ${normalizeIssue(String(record.issue ?? ""))}`;
  return text;
}

/**
 * Groups the records by signature, numbering the host runs on the way.
 *
 * @remarks
 * A run starts where a host started listening; records before the first start belong to a run
 * whose start has rotated out of the log.
 *
 * @sideEffects none
 * @param {Array<Record<string, any>>} records - Records in time order.
 * @returns {{ groups: Map<string, { count: number, first: number, last: number, runs: Set<number> }>, runs: number, starts: number[] }}
 * The groups, how many runs the log has, and when each host start was.
 */
function group(records) {
  const groups = new Map();
  const starts = [];
  let beforeFirstStart = false;
  for (const record of records) {
    if (record.msg === "host listening") {
      starts.push(record.at);
      continue;
    }
    if (starts.length === 0) beforeFirstStart = true;
    const signature = signatureOf(record);
    const known = groups.get(signature) ?? { count: 0, first: record.at, last: record.at, runs: new Set() };
    known.count += 1;
    known.last = record.at;
    known.runs.add(starts.length);
    groups.set(signature, known);
  }
  return { groups, runs: starts.length + (beforeFirstStart ? 1 : 0), starts };
}

/**
 * Pads a number to two digits.
 *
 * @remarks
 * Times read in columns only when every part has the same width.
 *
 * @sideEffects none
 * @param {number} value - A month, day, hour or minute.
 * @returns {string} The padded number.
 */
function pad(value) {
  return String(value).padStart(2, "0");
}

/**
 * Formats a time as local `MM-DD HH:MM`, or `YYYY-MM-DD HH:MM` with the year.
 *
 * @remarks
 * Local time, since the reader compares it with when they used the app; the same format as
 * `pnpm usage`.
 *
 * @sideEffects none
 * @param {number} at - Epoch milliseconds.
 * @param {boolean} withYear - Whether to lead with the year.
 * @returns {string} The formatted time.
 */
function formatTime(at, withYear) {
  const date = new Date(at);
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return withYear ? `${date.getFullYear()}-${day}` : day;
}

/**
 * Words a count of something, in the singular for one.
 *
 * @remarks
 * Reads as a sentence in the summary lines.
 *
 * @sideEffects none
 * @param {number} count - How many.
 * @param {string} noun - The singular noun.
 * @returns {string} Such as "1 run" or "2 runs".
 */
function counted(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Formats one signature's line.
 *
 * @remarks
 * New signatures are marked at the start, where the eye lands first.
 *
 * @sideEffects none
 * @param {string} signature - The signature.
 * @param {{ count: number, first: number, last: number, runs: Set<number> }} found - Its group.
 * @param {boolean} isNew - Whether it is new.
 * @returns {string} The line.
 */
function formatRow(signature, found, isNew) {
  const times = `first ${formatTime(found.first, false)} · last ${formatTime(found.last, false)}`;
  return `  ${isNew ? "new" : "   "}  ${found.count}×  ${signature} · ${times} · ${counted(found.runs.size, "run")}`;
}

/**
 * Reads the command line: the log directory and the cutoff.
 *
 * @remarks
 * The directory defaults to the one the installed app writes (observability.md, "日志格式").
 *
 * @sideEffects Reads environment variables.
 * @param {string[]} args - The arguments after the script.
 * @returns {{ logsDir: string, since: string | undefined }} What was asked for.
 */
function parseArgs(args) {
  const sinceAt = args.indexOf("--since");
  const since = sinceAt === -1 ? undefined : (args[sinceAt + 1] ?? "");
  const rest = sinceAt === -1 ? args : args.filter((_, index) => index !== sinceAt && index !== sinceAt + 1);
  const logsDir = rest[0] ?? join(process.env.ATRIUM_HOME ?? join(homedir(), ".atrium"), "logs");
  return { logsDir, since };
}

/**
 * Prints the signatures, new ones first, then the rest.
 *
 * @remarks
 * A signature is new when it first appears at or after the cutoff: the log kept before it has
 * none of it. The cutoff is the latest host start unless `--since` says otherwise, since the
 * host's start records nothing that changes with each build (testing.md, "运行时监控"). Within
 * each part, the most frequent come first, then the earliest.
 *
 * @sideEffects Writes to stdout and stderr; sets the exit code.
 * @param {string[]} args - The arguments after the script.
 */
async function main(args) {
  const { logsDir, since } = parseArgs(args);
  const sinceAt = since === undefined ? undefined : Date.parse(since);
  if (Number.isNaN(sinceAt)) {
    process.stderr.write(`--since needs an ISO time, got ${since}\n`);
    process.exitCode = 1;
    return;
  }
  const read = await readRecords(logsDir);
  if (read === null) {
    process.stderr.write(`no log directory at ${logsDir}\n`);
    process.exitCode = 1;
    return;
  }
  const { groups, runs, starts } = group(read.records);
  if (groups.size === 0) {
    console.log(`no warn, error or fatal records in ${logsDir}`);
    return;
  }
  const cutoff = sinceAt ?? starts.at(-1) ?? Infinity;
  const sorted = [...groups].toSorted(([, a], [, b]) => b.count - a.count || a.first - b.first);
  const fresh = sorted.filter(([, found]) => found.first >= cutoff);
  const earlier = sorted.filter(([, found]) => found.first < cutoff);
  console.log(
    `${counted(groups.size, "signature")} in ${logsDir} · ${counted(runs, "host run")} · ${formatTime(read.first, true)} → ${formatTime(read.last, true)}`,
  );
  const source = sinceAt === undefined ? "latest host start" : "--since";
  if (cutoff === Infinity) console.log("no host start in the log, nothing marked new; use --since");
  else if (fresh.length === 0) console.log(`new since ${formatTime(cutoff, true)} (${source}): none`);
  else {
    console.log(`new since ${formatTime(cutoff, true)} (${source}):`);
    for (const [signature, found] of fresh) console.log(formatRow(signature, found, true));
  }
  if (earlier.length > 0) {
    console.log("earlier:");
    for (const [signature, found] of earlier) console.log(formatRow(signature, found, false));
  }
}

await main(process.argv.slice(2));
