import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** A level the log gate stops at (testing.md, "日志门禁"). */
export type GatedLevel = "warn" | "error" | "fatal";

/** A field value a declaration can match exactly. */
type FieldValue = string | number | boolean | null;

/** A log record a test declares its scenario writes on purpose. */
export type ExpectedLog = {
  readonly level: GatedLevel;
  /** The record's `msg`, matched exactly. */
  readonly msg: string;
  /** Fields the record must also have, each matched exactly. */
  readonly fields?: Readonly<Record<string, FieldValue>>;
} & (
  | {
      /** How many times exactly; without it, at least once. */
      readonly times?: number;
      readonly optional?: never;
    }
  | {
      /**
       * Any number of times, none included: only for a record whose appearing depends on timing
       * the test cannot control, such as background work racing the app's shutdown, with a comment
       * saying so where it is declared (testing.md, "日志门禁").
       */
      readonly optional: true;
      readonly times?: never;
    }
);

/** Declarations of the same record, added up, and how often it came. */
interface Declared {
  readonly level: GatedLevel;
  readonly msg: string;
  readonly fields: Readonly<Record<string, FieldValue>>;
  count: number;
  exact: boolean;
  optional: boolean;
  seen: number;
}

const GATED: ReadonlySet<unknown> = new Set<GatedLevel>(["warn", "error", "fatal"]);

/** Kinds of the UI's reported problems that are performance signals, which the gate leaves out. */
const PERFORMANCE_SIGNALS: ReadonlySet<unknown> = new Set(["long_task", "slow_frames"]);

/**
 * Whether the gate looks at a record at all.
 *
 * @remarks
 * Warnings and worse count, except the UI's reports of long tasks and slow frames: they depend on
 * how busy the machine is, so a functional test failing on them would fail now and then; the
 * performance budgets look after them (testing.md, "日志门禁"). Errors the UI reports still count.
 *
 * @sideEffects none
 * @param record - A parsed log record.
 * @returns Whether it is gated.
 */
function gated(record: Readonly<Record<string, unknown>>): boolean {
  if (!GATED.has(record["level"])) return false;
  return !(record["msg"] === "client issue" && PERFORMANCE_SIGNALS.has(record["kind"]));
}

/**
 * Describes a record by its level, msg and the error's type and code, and nothing else.
 *
 * @remarks
 * Other fields can carry paths or conversation text, which must not reach test output
 * (testing.md, "日志门禁"; security.md).
 *
 * @sideEffects none
 * @param record - A parsed log record.
 * @returns A short description that groups equal records.
 */
function describeRecord(record: Readonly<Record<string, unknown>>): string {
  const err = record["err"];
  const parts =
    typeof err === "object" && err !== null
      ? [Reflect.get(err, "type") as unknown, Reflect.get(err, "code") as unknown].filter(
          (part) => typeof part === "string" || typeof part === "number",
        )
      : [];
  const text = `${String(record["level"])} ${JSON.stringify(String(record["msg"]))}`;
  return parts.length === 0 ? text : `${text} (${parts.join(" ")})`;
}

/**
 * Names a declaration by its level, msg and fields, as one key.
 *
 * @remarks
 * Declarations of the same record add up; JSON keeps the parts apart whatever they contain.
 *
 * @sideEffects none
 * @param expected - The declaration.
 * @returns The key.
 */
function keyOf(expected: ExpectedLog): string {
  return JSON.stringify([expected.level, expected.msg, expected.fields ?? {}]);
}

/**
 * Whether a record is the one a declaration describes.
 *
 * @remarks
 * Level and msg, and every declared field, must be equal; other fields may be anything.
 *
 * @sideEffects none
 * @param record - A parsed log record.
 * @param declared - The declaration.
 * @returns Whether it matches.
 */
function matches(record: Readonly<Record<string, unknown>>, declared: Declared): boolean {
  return (
    record["level"] === declared.level &&
    record["msg"] === declared.msg &&
    Object.entries(declared.fields).every(([name, value]) => record[name] === value)
  );
}

/**
 * Words how many times a declared record had to appear.
 *
 * @remarks
 * The failure message is all a reader gets, so it says whether the count was exact or a minimum.
 *
 * @sideEffects none
 * @param count - The required count.
 * @param exact - Whether it is exact.
 * @returns Such as "2 times" or "at least once".
 */
function wordTimes(count: number, exact: boolean): string {
  if (!exact) return count === 1 ? "at least once" : `at least ${count} times`;
  return count === 1 ? "1 time" : `${count} times`;
}

/**
 * Lists what a test's host log has that the test did not declare, and declarations it did not meet.
 *
 * @remarks
 * A test can pass while the host logs warnings or errors; the gate makes that fail
 * (testing.md, "日志门禁"); the UI's performance signals are left out (`gated`). Records match a declaration by level, msg and the declared fields
 * exactly, the first declaration that fits taking them. A declaration without `times` needs the
 * record at least once; one that never appears is a problem too, so a stale declaration cannot let
 * a later problem of the same kind through. An optional one may appear any number of times.
 * Declarations of the same record add up; one that is optional stays optional only if every one of
 * them is. Problems name records only by level, msg, and the error's type and code.
 *
 * @sideEffects none
 * @param records - Every record the host wrote during the test.
 * @param expected - The records the test declared.
 * @returns One line per problem: unexpected records in order of first appearance, then unmet
 * declarations in order of declaration; empty when the log is as declared.
 */
export function findLogProblems(
  records: ReadonlyArray<Readonly<Record<string, unknown>>>,
  expected: readonly ExpectedLog[],
): string[] {
  const declared = new Map<string, Declared>();
  for (const declaration of expected) {
    const { level, msg, fields = {}, times, optional = false } = declaration;
    const known = declared.get(keyOf(declaration)) ?? { level, msg, fields, count: 0, exact: true, optional, seen: 0 };
    declared.set(keyOf(declaration), {
      ...known,
      count: known.count + (times ?? 1),
      exact: known.exact && times !== undefined,
      optional: known.optional && optional,
    });
  }
  const unexpected = new Map<string, number>();
  for (const record of records) {
    if (!gated(record)) continue;
    const declaration = [...declared.values()].find((candidate) => matches(record, candidate));
    if (declaration !== undefined) declaration.seen += 1;
    else unexpected.set(describeRecord(record), (unexpected.get(describeRecord(record)) ?? 0) + 1);
  }
  const problems = [...unexpected].map(([text, count]) => `unexpected ${text} × ${count}`);
  for (const { level, msg, fields, count, exact, optional, seen } of declared.values()) {
    if (optional || (exact ? seen === count : seen >= count)) continue;
    const named = Object.keys(fields).length === 0 ? "" : ` ${JSON.stringify(fields)}`;
    problems.push(`expected ${level} ${JSON.stringify(msg)}${named} ${wordTimes(count, exact)}, saw ${seen}`);
  }
  return problems;
}

/**
 * Reads every record in a log directory's `host.<n>.jsonl` files, file by file in number order.
 *
 * @remarks
 * The gate checks the whole log, not only the file being written, so a test that makes the log
 * rotate is checked in full. A partial last line, from a host killed mid-write, is skipped.
 *
 * @sideEffects Reads the directory.
 * @param logsDir - The host's log directory.
 * @returns The records; empty when the directory does not exist.
 */
export async function readLogRecords(logsDir: string): Promise<Array<Record<string, unknown>>> {
  const names = await readdir(logsDir).catch(() => []);
  const files = names
    .filter((name) => /^host\.\d+\.jsonl$/.test(name))
    .toSorted((a, b) => Number(a.split(".")[1]) - Number(b.split(".")[1]));
  const records: Array<Record<string, unknown>> = [];
  for (const file of files) {
    for (const line of (await readFile(join(logsDir, file), "utf8")).split("\n")) {
      try {
        const parsed: unknown = line.length > 0 ? JSON.parse(line) : null;
        if (typeof parsed === "object" && parsed !== null) records.push(Object.fromEntries(Object.entries(parsed)));
      } catch {
        // A partial line.
      }
    }
  }
  return records;
}
