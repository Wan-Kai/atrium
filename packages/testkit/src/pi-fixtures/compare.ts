import type { FixtureRecord, Json } from "./format";

/**
 * Blanks one value of a fixture for the drift check.
 *
 * @remarks
 * A system message is reduced to its role; `usage` and `cost` objects to a placeholder.
 *
 * @sideEffects none
 * @param value - Any JSON value.
 * @param key - The key it sits under, if any.
 * @returns The blanked value.
 */
function blank(value: Json, key?: string): Json {
  if (key === "usage" || key === "cost") return `<${key}>`;
  if (Array.isArray(value)) return value.map((item: Json) => blank(item));
  if (value !== null && typeof value === "object") {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- arrays were handled above.
    const object = value as { readonly [name: string]: Json };
    if (object["role"] === "system") return { role: "system" };
    return Object.fromEntries(Object.entries(object).map(([name, item]) => [name, blank(item, name)]));
  }
  return value;
}

/**
 * Blanks the parts of a fixture that differ between machines, for the drift check.
 *
 * @remarks
 * Token estimates in `usage` and `cost` depend on the system prompt, which contains the working
 * directory's path, and the system prompt itself also differs per machine; everything else must
 * match (testing.md, "pi 夹具"). The fixture file keeps the real values.
 *
 * @sideEffects none
 * @param records - A fixture.
 * @returns A copy with those parts replaced by placeholders.
 */
export function comparable(records: readonly FixtureRecord[]): Json {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fixture records are JSON.
  return blank(records as unknown as Json);
}
