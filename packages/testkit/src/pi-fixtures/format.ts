import type { FauxScript } from "../faux/script";

/** One JSON value pi or the host wrote; kept as parsed. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** A JSON object pi or the host wrote. */
export type JsonObject = { readonly [key: string]: Json };

/** One line of a fixture file (testing.md, "pi 夹具"). */
export type FixtureRecord =
  | {
      readonly kind: "fixture";
      readonly scenario: string;
      /** pi version the fixture was recorded with. */
      readonly pi: string;
      readonly script: FauxScript;
      /** pi's arguments after `--mode rpc`, without the faux extension's own. */
      readonly args: readonly string[];
    }
  | { readonly kind: "send"; readonly record: JsonObject }
  | { readonly kind: "stdout"; readonly record: JsonObject }
  | {
      readonly kind: "exit";
      readonly code: number | null;
      readonly signal: string | null;
      /** Whether the host stopped pi; replay waits for `stop()` before such an exit. */
      readonly requested: boolean;
    }
  | { readonly kind: "session"; readonly lines: readonly JsonObject[] };

/**
 * Serializes fixture records as JSONL, one record per line.
 *
 * @remarks
 * One line per record keeps diffs readable when pi's output changes and fixtures are re-recorded.
 *
 * @sideEffects none
 * @param records - The records, header first.
 * @returns The file content, ending with a newline.
 */
export function serializeFixture(records: readonly FixtureRecord[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join("");
}

/**
 * Parses a fixture file.
 *
 * @remarks
 * Fixtures are written by `serializeFixture` and checked into git, so a malformed file is a broken
 * checkout rather than input to tolerate; the first line must be the header.
 *
 * @sideEffects none
 * @param text - The file content.
 * @returns The records, header first.
 * @throws {Error} When the first record is not a header.
 */
export function parseFixture(text: string): FixtureRecord[] {
  const records = text
    .split("\n")
    .filter((line) => line !== "")
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fixtures are written by serializeFixture.
    .map((line) => JSON.parse(line) as FixtureRecord);
  if (records[0]?.kind !== "fixture") throw new Error("a fixture must start with its header");
  return records;
}
