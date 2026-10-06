import type { FixtureRecord, Json } from "./format";

/**
 * Blanks one value of a fixture for the drift check.
 *
 * @remarks
 * Only the strings inside a system message, apart from its role, are blanked; its keys and the
 * shape of `sections` stay, so a change in how pi structures the system prompt still shows up.
 *
 * @sideEffects none
 * @param value - Any JSON value.
 * @param inSystem - Whether the value sits inside a system message.
 * @returns The blanked value.
 */
function blank(value: Json, inSystem: boolean): Json {
  if (inSystem && typeof value === "string") return "<system>";
  if (Array.isArray(value)) return value.map((item: Json) => blank(item, inSystem));
  if (value !== null && typeof value === "object") {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- arrays were handled above.
    const object = value as { readonly [name: string]: Json };
    const system = object["role"] === "system";
    return Object.fromEntries(
      Object.entries(object).map(([name, item]) => [name, blank(item, inSystem || (system && name !== "role"))]),
    );
  }
  return value;
}

/**
 * Blanks the parts of a fixture that differ between machines, for the drift check.
 *
 * @remarks
 * The system prompt names the machine's paths, such as where pi is installed, so its text differs
 * per machine; everything else must match (testing.md, "pi 夹具"). Measurements such as token
 * counts are already fixed when recording (`createNormalizer`). The fixture file keeps the text.
 *
 * @sideEffects none
 * @param records - A fixture.
 * @returns A copy with those parts replaced by placeholders.
 */
export function comparable(records: readonly FixtureRecord[]): Json {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fixture records are JSON.
  return blank(records as unknown as Json, false);
}
