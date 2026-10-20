import type { PiConfigName } from "@atrium/protocol";

/** Checks ordinary config syntax using pi's file-specific parsing conventions.
 * @remarks Matches installed pi's utils/json.js for models, including line comments but not block comments.
 * Validation never executes providers or rewrites the original text; schema validation remains pi's job.
 * @sideEffects none
 * @param name - Allowlisted ordinary config filename.
 * @param text - Exact editor text, including any BOM.
 */
export function isPiConfigValid(name: PiConfigName, text: string): boolean {
  let input = text.replace(/^\uFEFF/, "");
  if (name === "settings.json" && text === "") return true;
  if (name === "models.json") {
    input = input
      .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
      .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => tail ?? match);
  }
  try {
    const value: unknown = JSON.parse(input);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}
