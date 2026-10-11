import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const HOUR_MS = 3_600_000;
const MB = 1024 * 1024;
/** How much a memory floor may grow before it is marked (testing.md, "运行时监控"). */
const MEMORY_GROWTH = 1.5;

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
 * Reads the records that start a host run or report usage, across all rotated files.
 *
 * @remarks
 * Files rotate by size, so a run can span several of them; sorting by time puts them back in
 * order whatever the file numbers are.
 *
 * @sideEffects Reads the log directory.
 * @param {string} logsDir - Directory with `host.<n>.jsonl` files.
 * @returns {Promise<Array<Record<string, any>>>} Matching records in time order.
 */
async function readUsage(logsDir) {
  const files = (await readdir(logsDir)).filter((name) => /^host\.\d+\.jsonl$/.test(name));
  const wanted = new Set(["host listening", "resource usage", "app metrics"]);
  const records = [];
  for (const file of files) {
    for (const line of (await readFile(join(logsDir, file), "utf8")).split("\n")) {
      const record = parseLine(line);
      if (wanted.has(record?.msg)) records.push({ ...record, at: Date.parse(record.time) });
    }
  }
  return records.toSorted((a, b) => a.at - b.at);
}

/**
 * Splits the records into host runs, each starting where a host started listening.
 *
 * @remarks
 * Records before the first start belong to a run whose start has rotated out of the log; it is
 * counted from its first record.
 *
 * @sideEffects none
 * @param {Array<Record<string, any>>} records - Records in time order.
 * @returns {Array<{ start: number, reports: Array<Record<string, any>>, apps: Array<Record<string, any>> }>} The runs.
 */
function splitRuns(records) {
  const runs = [];
  for (const record of records) {
    if (record.msg === "host listening" || runs.length === 0) runs.push({ start: record.at, reports: [], apps: [] });
    const current = runs.at(-1);
    if (record.msg === "resource usage") current.reports.push(record);
    else if (record.msg === "app metrics") current.apps.push(record);
  }
  return runs;
}

/**
 * Sums one app sample's memory by process type.
 *
 * @remarks
 * The app has several processes of some types (one per tab, say); a leak shows in their total.
 *
 * @sideEffects none
 * @param {Record<string, any>} sample - An `app metrics` record.
 * @returns {Map<string, number>} Memory in MB by type, types in name order.
 */
function appMemory(sample) {
  const byType = new Map();
  for (const process of sample.processes)
    byType.set(process.type, (byType.get(process.type) ?? 0) + process.memoryKb / 1024);
  return new Map([...byType].toSorted(([a], [b]) => a.localeCompare(b)));
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
 * Local time, since the reader compares it with when they used the app.
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
 * Names the local clock hour of a record.
 *
 * @remarks
 * Rows are listed one per clock hour, so neighbouring reports are compared by it.
 *
 * @sideEffects none
 * @param {Record<string, any>} record - A record with its time in `at`.
 * @returns {string} `YYYY-MM-DD HH`.
 */
function clockHour(record) {
  return formatTime(record.at, true).slice(0, -3);
}

/**
 * Picks the reports to list: the first of each clock hour, and the last one.
 *
 * @remarks
 * One row an hour is enough to see a trend over a day; the last row shows where it stands now.
 *
 * @sideEffects none
 * @param {Array<Record<string, any>>} reports - A run's reports in time order.
 * @returns {Array<Record<string, any>>} The reports to list.
 */
function hourlyRows(reports) {
  const rows = reports.filter((report, index) => index === 0 || clockHour(reports[index - 1]) !== clockHour(report));
  const last = reports.at(-1);
  return rows.at(-1) === last ? rows : [...rows, last];
}

/**
 * Formats one report as a row, with the app sample nearest to it.
 *
 * @remarks
 * The host and the app sample on separate timers, so the two are paired by time. Only non-zero
 * resource counts are shown, to keep a row on one line.
 *
 * @sideEffects none
 * @param {Record<string, any>} report - A `resource usage` record.
 * @param {Array<Record<string, any>>} apps - The run's app samples.
 * @returns {string} The row.
 */
function formatRow(report, apps) {
  const parts = [
    formatTime(report.at, false),
    `rss ${(report.memory.rss / MB).toFixed(1)} MB`,
    `heap ${(report.memory.heapUsed / MB).toFixed(1)} MB`,
  ];
  const counts = Object.entries(report.resources)
    .filter(([, count]) => count !== 0)
    .toSorted(([a], [b]) => a.localeCompare(b));
  if (counts.length > 0) parts.push(counts.map(([name, count]) => `${name}=${count}`).join(" "));
  const nearest = apps.toSorted((a, b) => Math.abs(a.at - report.at) - Math.abs(b.at - report.at))[0];
  if (nearest !== undefined) {
    parts.push(`app ${[...appMemory(nearest)].map(([type, mb]) => `${type} ${mb.toFixed(1)} MB`).join(", ")}`);
  }
  return `  ${parts.join("  ")}`;
}

/**
 * Finds the lowest of some values.
 *
 * @remarks
 * A leak lifts the floor, while normal work only moves the peaks.
 *
 * @sideEffects none
 * @param {number[]} values - Non-empty values.
 * @returns {number} The lowest.
 */
function floor(values) {
  return Math.min(...values);
}

/**
 * Finds the lowest memory of each app process type over some samples.
 *
 * @remarks
 * Types are summed within a sample first (appMemory), so a type's floor is that of its total.
 *
 * @sideEffects none
 * @param {Array<Record<string, any>>} samples - `app metrics` records.
 * @returns {Map<string, number>} The floor in MB by type.
 */
function typeFloors(samples) {
  const floors = new Map();
  for (const sample of samples) {
    for (const [type, mb] of appMemory(sample)) floors.set(type, Math.min(floors.get(type) ?? Infinity, mb));
  }
  return floors;
}

/**
 * Formats the floors of one memory value, marked if the later one grew too much.
 *
 * @remarks
 * Memory moves with caches and garbage collection, so only growth above 1.5 times is marked
 * (testing.md, "运行时监控").
 *
 * @sideEffects none
 * @param {string} label - What the memory is of.
 * @param {number} before - The first hour's floor in MB.
 * @param {number} after - The last hour's floor in MB.
 * @returns {string} The line.
 */
function memoryLine(label, before, after) {
  return `    ${label} ${before.toFixed(1)} → ${after.toFixed(1)} MB${after > before * MEMORY_GROWTH ? " ↑" : ""}`;
}

/**
 * Compares the lowest values of a run's first and last hour.
 *
 * @remarks
 * Usage swings with work, but a leak lifts the floor (testing.md, "运行时监控"): a resource count
 * is marked when its floor rises at all, memory when its floor grows above 1.5 times. A count
 * missing from a report is zero; an app process type is compared only if both hours have it.
 * Counts that stay at zero are left out.
 *
 * @sideEffects none
 * @param {{ start: number, reports: Array<Record<string, any>>, apps: Array<Record<string, any>> }} run - The run.
 * @param {number} end - Time of the run's last usage record.
 * @returns {string[]} One line per value.
 */
function compareFloors(run, end) {
  /**
   * Whether a record falls in the run's first hour.
   *
   * @remarks
   * Counted from the start, so the floor is that of a fresh host.
   *
   * @sideEffects none
   * @param {Record<string, any>} record - A usage record.
   * @returns {boolean} Whether it does.
   */
  const firstHour = (record) => record.at < run.start + HOUR_MS;
  /**
   * Whether a record falls in the run's last hour.
   *
   * @remarks
   * Counted back from the last record, so the floor is where the host stands now.
   *
   * @sideEffects none
   * @param {Record<string, any>} record - A usage record.
   * @returns {boolean} Whether it does.
   */
  const lastHour = (record) => record.at >= end - HOUR_MS;
  const [firstReports, lastReports] = [run.reports.filter(firstHour), run.reports.filter(lastHour)];
  // A run whose first report came over an hour after it started has nothing to compare.
  if (firstReports.length === 0) return ["    no report in the first hour"];
  const lines = [
    memoryLine(
      "rss",
      floor(firstReports.map((r) => r.memory.rss / MB)),
      floor(lastReports.map((r) => r.memory.rss / MB)),
    ),
    memoryLine(
      "heap",
      floor(firstReports.map((r) => r.memory.heapUsed / MB)),
      floor(lastReports.map((r) => r.memory.heapUsed / MB)),
    ),
  ];
  const names = [...new Set(run.reports.flatMap((report) => Object.keys(report.resources)))].toSorted((a, b) =>
    a.localeCompare(b),
  );
  for (const name of names) {
    const before = floor(firstReports.map((report) => report.resources[name] ?? 0));
    const after = floor(lastReports.map((report) => report.resources[name] ?? 0));
    if (before !== 0 || after !== 0) lines.push(`    ${name} ${before} → ${after}${after > before ? " ↑" : ""}`);
  }
  const before = typeFloors(run.apps.filter(firstHour));
  const after = typeFloors(run.apps.filter(lastHour));
  // Already in name order (appMemory).
  for (const [type, mb] of before) {
    if (after.has(type)) lines.push(memoryLine(`app ${type}`, mb, after.get(type)));
  }
  return lines;
}

/**
 * Prints each host run's hourly usage and whether its floors rose.
 *
 * @remarks
 * Runs shorter than two hours are listed without a comparison: their first and last hour would
 * overlap.
 *
 * @sideEffects Writes to stdout.
 * @param {ReturnType<typeof splitRuns>} runs - The runs.
 */
function printRuns(runs) {
  for (const run of runs) {
    const end = Math.max(run.start, ...[...run.reports, ...run.apps].map((record) => record.at));
    const count = run.reports.length;
    console.log(
      `run ${formatTime(run.start, true)} · ${((end - run.start) / HOUR_MS).toFixed(1)} h · ${count} ${count === 1 ? "sample" : "samples"}`,
    );
    for (const report of hourlyRows(run.reports)) console.log(formatRow(report, run.apps));
    if (end - run.start < 2 * HOUR_MS) {
      console.log("  shorter than two hours, no comparison");
    } else {
      console.log("  floors, first hour → last hour:");
      for (const line of compareFloors(run, end)) console.log(line);
    }
  }
}

const logsDir = process.argv[2] ?? join(process.env.ATRIUM_HOME ?? join(homedir(), ".atrium"), "logs");
const runs = splitRuns(await readUsage(logsDir)).filter((run) => run.reports.length > 0);
if (runs.length === 0) console.log(`no usage records in ${logsDir}`);
else printRuns(runs);
