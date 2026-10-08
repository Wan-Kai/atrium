import { type LogEntry, type PiEvent, toLogEntry } from "@atrium/pi";
import { type FixtureRecord, parseFixture, present } from "@atrium/testkit";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The recorded pi fixtures, which belong to the pi package. */
export const FIXTURES_DIR = join(import.meta.dirname, "..", "..", "pi", "fixtures");

/** pi's session entry, as the pi package takes it; only the pi package imports pi's types. */
type SessionEntry = Parameters<typeof toLogEntry>[0];

/**
 * Reads a recorded pi scenario.
 *
 * @remarks
 * Fixtures are recorded per pi version (testing.md, "pi 夹具"); the host tests read the current one.
 *
 * @sideEffects Reads the fixture file.
 * @param scenario - The scenario's name.
 * @returns Its records.
 */
export function readPiFixture(scenario: string): FixtureRecord[] {
  return parseFixture(readFileSync(join(FIXTURES_DIR, "pi-1.0.2", `${scenario}.jsonl`), "utf8"));
}

/**
 * The events pi printed in a recorded scenario, in order, responses left out.
 *
 * @remarks
 * What a live session would have seen, to drive host components with real pi output.
 *
 * @sideEffects Reads the fixture file.
 * @param scenario - The scenario's name.
 * @returns The events.
 */
export function fixtureEvents(scenario: string): PiEvent[] {
  return readPiFixture(scenario).flatMap((record) =>
    record.kind === "stdout" && record.record["type"] !== "response" ? [record.record as unknown as PiEvent] : [],
  );
}

/**
 * The entries of the last `get_entries` answer in a recorded scenario, converted.
 *
 * @remarks
 * The last answer holds the whole file, every branch included.
 *
 * @sideEffects Reads the fixture file.
 * @param scenario - The scenario's name.
 * @returns The entries and the leaf pi reported.
 */
export function fixtureEntries(scenario: string): { entries: LogEntry[]; leafId: string } {
  const answers = readPiFixture(scenario).flatMap((record) =>
    record.kind === "stdout" && record.record["command"] === "get_entries" ? [record.record] : [],
  );
  const data = present(answers.at(-1), "a get_entries answer")["data"] as unknown as {
    entries: SessionEntry[];
    leafId: string;
  };
  return { entries: data.entries.map(toLogEntry), leafId: data.leafId };
}
