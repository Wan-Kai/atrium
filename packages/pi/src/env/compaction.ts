import type { ModelRef } from "@atrium/protocol";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentDirectory } from "./agent-dir";

/** What pi keeps free when its settings say nothing (pi 1.1.0 `settings-manager.js`). */
const DEFAULT_RESERVE_TOKENS = 16_384;

/**
 * Reads a field of a value that may be an object.
 *
 * @remarks
 * pi's settings are whatever JSON the file holds.
 *
 * @sideEffects none
 * @param value - The value.
 * @param key - The field.
 * @returns The field's value, or `undefined`.
 */
function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Reflect.get(value, key) : undefined;
}

/**
 * Tells whether a setting is a count pi accepts: a non-negative safe integer.
 *
 * @remarks
 * pi refuses any other (pi 1.1.0 `settings-manager.js` `getCompactionTokenSetting`).
 *
 * @sideEffects none
 * @param value - The setting.
 * @returns Whether it is one.
 */
function isCount(value: unknown): value is number {
  // Stryker disable next-line ConditionalExpression: `Number.isSafeInteger` is false for anything but a number too; the check narrows the type.
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * How many tokens pi keeps free before it compacts a session on its own, for a model.
 *
 * @remarks
 * SPEC-0001 ("M1.13 的上下文细分与套餐用量"): pi compacts once the context passes the window less
 * `compaction.reserveTokens` (pi-internals.md §2). From pi's global `settings.json`: no reserve
 * when `compaction.enabled` is `false`; otherwise `modelOverrides["provider/model"].reserveTokens`,
 * then `reserveTokens`, then 16384, as pi resolves them. A missing or unreadable file counts as
 * none, as for pi. A setting pi would refuse leaves it unknown. Project settings, which apply only
 * once pi trusts the project, are not read (as for `sessionDir`).
 *
 * @sideEffects Reads pi's settings file.
 * @param env - pi's environment.
 * @param model - The session's model, or `null`.
 * @returns The reserve, or `null` when pi does not compact on its own or the settings are not ones pi takes.
 */
export async function compactionReserve(
  env: Readonly<Record<string, string>>,
  model: ModelRef | null,
): Promise<number | null> {
  let text: string | null;
  try {
    // Stryker disable next-line StringLiteral: without an encoding the bytes parse the same.
    text = await readFile(join(agentDirectory(env), "settings.json"), "utf8");
  } catch {
    text = null;
  }
  let settings: unknown;
  try {
    // No file reads as JSON `null`, which has no field.
    settings = JSON.parse(text ?? "null");
  } catch {
    return null;
  }
  const compaction = fieldOf(settings, "compaction");
  const set = fieldOf(compaction, "enabled");
  const enabled = set === undefined ? true : set;
  const override =
    model === null ? undefined : fieldOf(fieldOf(compaction, "modelOverrides"), `${model.providerId}/${model.modelId}`);
  // `undefined` alone means unset, as for pi: a `null` is a setting it refuses.
  const [fromModel, ordinary] = [fieldOf(override, "reserveTokens"), fieldOf(compaction, "reserveTokens")];
  const chosen = fromModel === undefined ? (ordinary === undefined ? DEFAULT_RESERVE_TOKENS : ordinary) : fromModel;
  return enabled === true && isCount(chosen) ? chosen : null;
}
